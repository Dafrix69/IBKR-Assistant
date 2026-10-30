"""Option walls as win-rate factors for the ATM 0DTE fly (13:00 / 14:00, 25 and 30 wide).

    .venv/bin/python src/wall_factors.py spx [--workers 6]    # SPXW 0DTE OI walls + same-day volume/flow walls
    .venv/bin/python src/wall_factors.py qqq                  # QQQ 0DTE OI walls (needs data/raw/QQQ/oi, data/tws/qqq_1m)
    .venv/bin/python src/wall_factors.py spy                  # same for SPY
    .venv/bin/python src/wall_factors.py screen

Walls:
- OI walls: from the OI file dated D (D-1 close) for contracts expiring D. Call wall = strike above
  spot with the most call OI (within +150), put wall = strike below with the most put OI.
- Volume walls (SPXW only, 2024-10-30 on): cumulative 0DTE volume by strike from the open to the
  entry minute, from trade_quote. Flow = signed single-leg volume (at/above ask = bought, at/below
  bid = sold; multi-leg conditions 130/131/134/137/144 dropped) near ATM.
Distances are in units of the ATM straddle at entry so days with different vol compare.
Alternative structures priced from the same chain: 25-wide put fly centered on the nearest OI wall.
"""
import argparse
import glob
import gzip
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402
import winrate_study as S  # noqa: E402

CLEAN, RAW, F = S.CLEAN, os.path.join(S.ROOT, S.CFG["paths"]["raw"]), S.F
ENTRIES = ["13:00", "14:00"]
ML = {130, 131, 134, 137, 144}


def oi_0dte(sym, date):
    f = os.path.join(RAW, sym, "oi", date.strftime("%Y"), date.strftime("%Y%m%d") + ".csv.gz")
    if not os.path.exists(f):
        return None
    o = pd.read_csv(f, compression="gzip", usecols=["expiration", "strike", "right", "open_interest"])
    o = o[pd.to_datetime(o.expiration) == date]
    if o.empty:
        return None
    return o.pivot_table(index="strike", columns="right", values="open_interest", aggfunc="sum").fillna(0)


def walls(tbl, s0, span, ccol="CALL", pcol="PUT"):
    """(call wall, put wall, max-OI strike) or NaNs."""
    cw = pw = mx = np.nan
    if tbl is None or len(tbl) == 0:
        return cw, pw, mx
    up = tbl[(tbl.index >= s0) & (tbl.index <= s0 + span)]
    dn = tbl[(tbl.index <= s0) & (tbl.index >= s0 - span)]
    if ccol in tbl and len(up) and up[ccol].max() > 0:
        cw = float(up[ccol].idxmax())
    if pcol in tbl and len(dn) and dn[pcol].max() > 0:
        pw = float(dn[pcol].idxmax())
    near = tbl[(tbl.index >= s0 - span) & (tbl.index <= s0 + span)]
    if len(near):
        mx = float(near.sum(axis=1).idxmax())
    return cw, pw, mx


def trades_until(date):
    f = os.path.join(RAW, "SPXW", "trade_quote_dte0", date.strftime("%Y"), date.strftime("%Y%m%d") + ".csv.gz")
    if not os.path.exists(f):
        return None
    t = pd.read_csv(f, compression="gzip", usecols=["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"])
    t["ts"] = pd.to_datetime(t.trade_timestamp)
    t["side"] = np.where(t.price >= t.ask, 1, np.where(t.price <= t.bid, -1, 0))
    t.loc[t.condition.isin(ML), "side"] = 0
    return t


def fly_price(q, K, w):
    try:
        r = q.loc[[(K - w, "P"), (K, "P"), (K + w, "P")]]
    except KeyError:
        return None
    sign, qty = np.array([1, -1, 1.0]), np.array([1, 2, 1.0])
    mid = float((sign * qty * r.mid.values).sum())
    H = float((qty * (r.ask.values - r.bid.values) / 2).sum())
    fee = float((qty * fills.leg_fee(r.mid.values, F)).sum())
    return mid, H, fee


def spx_day(args):
    path, spot_day, settle, date = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    oi = oi_0dte("SPXW", date)
    tr = trades_until(date)
    out = []
    for e in ENTRIES:
        t = pd.Timestamp(f"{date.date()} {e}")
        if t not in spot_day.index:
            continue
        s0 = float(spot_day.loc[t])
        q = S.snap_mids(df, t)
        if q.empty:
            continue
        strikes = q.index.get_level_values(0).unique().values
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            imp = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        rec = {"date": date, "entry": e, "spot": s0, "implied": imp}
        cw, pw, mx = walls(oi, s0, 150)
        rec.update({"oi_cw_dist": (cw - s0) / imp, "oi_pw_dist": (s0 - pw) / imp, "oi_span": (cw - pw) / imp,
                    "oi_between": float(not np.isnan(cw) and not np.isnan(pw)), "oi_max_dist": abs(mx - s0) / imp,
                    "oi_nearest_dist": np.nanmin([abs(cw - s0), abs(s0 - pw)]) / imp if not (np.isnan(cw) and np.isnan(pw)) else np.nan})
        if oi is not None and len(oi):
            band = oi[(oi.index >= Kc - 25) & (oi.index <= Kc + 25)]
            rec["oi_pc_ratio_atm"] = float(band.get("PUT", pd.Series(dtype=float)).sum() / max(1.0, band.get("CALL", pd.Series(dtype=float)).sum()))
        # fly centered on the nearest OI wall (if within 50 points), else NaN
        wall_c = None
        cands = [k for k in (cw, pw) if not np.isnan(k) and abs(k - s0) <= 50]
        if cands:
            wall_c = min(cands, key=lambda k: abs(k - s0))
        for name, K in (("atm", Kc), ("wall", wall_c), ("maxoi", mx if not np.isnan(mx) and abs(mx - s0) <= 50 else None)):
            if K is None:
                rec[f"pnl_{name}25"] = np.nan
                continue
            pr = fly_price(q, K, 25)
            if pr is None or pr[0] <= 0:
                rec[f"pnl_{name}25"] = np.nan
                continue
            mid, H, fee = pr
            rec[f"pnl_{name}25"] = (fills.fly_settle_value(settle, K, 25) - mid - S.K * H) * F["multiplier"] - fee
            rec[f"center_{name}"] = K
        if tr is not None:
            u = tr[tr.ts < t]
            vol = u.groupby(["strike", "right"]).size().unstack(fill_value=0)
            vtab = pd.DataFrame({"CALL": u[u.right == "CALL"].groupby("strike")["size"].sum(),
                                 "PUT": u[u.right == "PUT"].groupby("strike")["size"].sum()}).fillna(0)
            vcw, vpw, vmx = walls(vtab, s0, 150)
            rec.update({"vol_cw_dist": (vcw - s0) / imp, "vol_pw_dist": (s0 - vpw) / imp, "vol_max_dist": abs(vmx - s0) / imp,
                        "vol_nearest_dist": np.nanmin([abs(vcw - s0), abs(s0 - vpw)]) / imp if not (np.isnan(vcw) and np.isnan(vpw)) else np.nan})
            near = u[(u.strike >= Kc - 25) & (u.strike <= Kc + 25)]
            sgl = near[near.side != 0]
            rec["flow_net_atm"] = float((sgl.side * sgl["size"]).sum() / max(1.0, sgl["size"].sum()))        # +1 all bought
            rec["flow_vol_atm_share"] = float(near["size"].sum() / max(1.0, u["size"].sum()))
            pc = near.groupby("right")["size"].sum()
            rec["flow_pc_ratio_atm"] = float(pc.get("PUT", 0) / max(1.0, pc.get("CALL", 0)))
            rec["vol_total_k"] = float(u["size"].sum() / 1000)
        out.append(rec)
    return out


def build_spx(workers):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if cal.loc[d, "half_day"]:
            continue
        jobs.append((f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(spx_day, jobs, chunksize=4) for r in day]
    out = pd.DataFrame(rows)
    out.to_parquet(os.path.join(CLEAN, "wall_panel_spx.parquet"), index=False)
    print(len(out), "rows")


def build_etf(sym):
    """ETF 0DTE OI walls at the entry minute; distances in % of the ETF price."""
    tag = sym.lower()
    fs = sorted(glob.glob(os.path.join(S.ROOT, "data", "tws", f"{tag}_1m", "*.parquet")))
    bars = pd.concat(pd.read_parquet(f) for f in fs).drop_duplicates("ts").sort_values("ts")
    bars["ts"] = bars.ts.dt.tz_localize(None)
    q = bars.set_index("ts").close
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    rows = []
    for d in cal.index[~cal.half_day]:
        oi = oi_0dte(sym, d)
        if oi is None:
            continue
        for e in ENTRIES:
            t = pd.Timestamp(f"{d.date()} {e}") - pd.Timedelta(minutes=1)      # bar that closed at e
            if t not in q.index:
                continue
            s0 = float(q.loc[t])
            cw, pw, mx = walls(oi, s0, s0 * 0.03)
            rows.append({"date": d, "entry": e, f"{tag}_spot": s0, f"{tag}_cw_pct": (cw - s0) / s0 * 100, f"{tag}_pw_pct": (s0 - pw) / s0 * 100,
                         f"{tag}_span_pct": (cw - pw) / s0 * 100, f"{tag}_max_pct": abs(mx - s0) / s0 * 100,
                         f"{tag}_nearest_pct": np.nanmin([abs(cw - s0), abs(s0 - pw)]) / s0 * 100 if not (np.isnan(cw) and np.isnan(pw)) else np.nan,
                         f"{tag}_oi_0dte_k": float(oi.values.sum() / 1000),
                         f"{tag}_pc_ratio": float(oi.get("PUT", pd.Series(dtype=float)).sum() / max(1.0, oi.get("CALL", pd.Series(dtype=float)).sum()))})
    out = pd.DataFrame(rows)
    out.to_parquet(os.path.join(CLEAN, f"wall_panel_{tag}.parquet"), index=False)
    print(len(out), "rows", out.date.nunique(), "days")


def screen():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[(p.structure == "put_fly") & p.width.isin([25, 30]) & p.entry.isin(ENTRIES)]
    w = pd.read_parquet(os.path.join(CLEAN, "wall_panel_spx.parquet"))
    for tag in ("qqq", "spy"):
        qf = os.path.join(CLEAN, f"wall_panel_{tag}.parquet")
        if os.path.exists(qf):
            w = w.merge(pd.read_parquet(qf), on=["date", "entry"], how="left")
    d = p.merge(w.drop(columns=["spot", "implied"]), on=["date", "entry"], how="inner")
    rows = []
    for col in [c for c in w.columns if c.startswith(("oi_", "vol_", "flow_", "qqq_", "spy_")) and not c.endswith("_spot")]:
        x = d[[col, "win", "date"]].dropna()
        if len(x) < 300 or x[col].nunique() < 3:
            continue
        split = S.SPLIT if x.date.min() < pd.Timestamp("2023-06-01") else pd.Timestamp("2026-01-01")
        tr, te = x[x.date < split], x[x.date >= split]
        cuts = np.unique(np.quantile(tr[col], [0, .2, .4, .6, .8, 1]))
        if len(cuts) < 4:
            continue
        tg = tr.groupby(pd.cut(tr[col], cuts, include_lowest=True), observed=True).win.mean()
        eg = te.groupby(pd.cut(te[col], cuts, include_lowest=True), observed=True).win.mean()
        rows.append({"factor": col, "n": len(x), "split": split.date(), "train_Q1": tg.iloc[0], "train_Q5": tg.iloc[-1], "train_gap": tg.iloc[-1] - tg.iloc[0],
                     "test_Q1": eg.iloc[0], "test_Q5": eg.iloc[-1], "test_gap": eg.iloc[-1] - eg.iloc[0],
                     "rho_train": spearmanr(tr[col], tr.win).statistic, "rho_test": spearmanr(te[col], te.win).statistic,
                     "holds": bool(np.sign(tg.iloc[-1] - tg.iloc[0]) == np.sign(eg.iloc[-1] - eg.iloc[0]) and min(abs(tg.iloc[-1] - tg.iloc[0]), abs(eg.iloc[-1] - eg.iloc[0])) >= 0.05)})
    out = pd.DataFrame(rows).sort_values("test_gap", key=abs, ascending=False).round(3)
    out.to_csv(os.path.join(S.TABLES, "wall_factor_screen.csv"), index=False)
    pd.set_option("display.width", 220)
    print(out.to_string())
    # alternative centers
    alt = w.dropna(subset=["pnl_atm25"])
    rows = []
    for name in ("atm", "wall", "maxoi"):
        g = alt.dropna(subset=[f"pnl_{name}25"])
        both = alt.dropna(subset=["pnl_atm25", f"pnl_{name}25"])
        rows.append({"center": name, "n": len(g), "win": (g[f"pnl_{name}25"] > 0).mean(), "ev": g[f"pnl_{name}25"].mean(),
                     "n_paired": len(both), "win_atm_same_days": (both.pnl_atm25 > 0).mean(), "ev_atm_same_days": both.pnl_atm25.mean()})
    alt_t = pd.DataFrame(rows).round(3)
    alt_t.to_csv(os.path.join(S.TABLES, "wall_center_vs_atm.csv"), index=False)
    print(alt_t.to_string())


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["spx", "qqq", "spy", "screen"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    {"spx": lambda: build_spx(x.workers), "qqq": lambda: build_etf("QQQ"), "spy": lambda: build_etf("SPY"), "screen": screen}[x.cmd]()
