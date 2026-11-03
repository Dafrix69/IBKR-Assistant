"""Screen more entry-time factors for the win rate of a 25/30-wide ATM put fly held to
settlement, entries 13:00 and 14:00.

    .venv/bin/python src/factor_screen.py [--workers 6]

Every factor is known at the entry minute. Quintile cut points come from the training
period (< 2024-11-01) and are applied unchanged to the test period, so a factor only
counts if the Q5-Q1 gap keeps its sign and size out of sample.
Writes data/clean/factor_panel.parquet and reports/winrate_tables/factor_screen.csv.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import winrate_study as S  # noqa: E402

CLEAN, RAW = S.CLEAN, os.path.join(S.ROOT, S.CFG["paths"]["raw"])
ENTRIES = ["13:00", "14:00"]
WIDTHS = [25, 30]


def day_features(args):
    path, spot_day, oi_path, date = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    s = spot_day
    out = []
    open_ = float(s.iloc[0])
    oi = None
    if oi_path and os.path.exists(oi_path):
        o = pd.read_csv(oi_path, compression="gzip", usecols=["expiration", "strike", "open_interest"])
        oi = o[pd.to_datetime(o.expiration) == date].groupby("strike").open_interest.sum()
    for e in ENTRIES:
        t = pd.Timestamp(f"{date.date()} {e}")
        if t not in s.index:
            continue
        sofar = s[s.index <= t]
        s0 = float(s.loc[t])
        q = S.snap_mids(df, t)
        if q.empty:
            continue
        strikes = q.index.get_level_values(0).unique().values
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            c, p = q.loc[(Kc, "C")], q.loc[(Kc, "P")]
            implied = float(c.mid + p.mid)
            spread_pct = float((c.ask - c.bid + p.ask - p.bid) / implied) if implied else np.nan
            skew = float(q.loc[(Kc - 25, "P"), "mid"] / q.loc[(Kc + 25, "C"), "mid"])
        except KeyError:
            continue
        r = np.log(sofar).diff().dropna()
        last60 = sofar[sofar.index > t - pd.Timedelta(minutes=60)]
        last30 = sofar[sofar.index > t - pd.Timedelta(minutes=30)]
        bars5 = sofar.resample("5min").last().dropna().diff().dropna().iloc[-12:]       # last hour in 5-min steps
        day_hi, day_lo = sofar.max(), sofar.min()
        rec = {"date": date, "entry": e,
               "ret_60m": (s0 - float(last60.iloc[0])) / implied, "abs_ret_60m": abs(s0 - float(last60.iloc[0])) / implied,
               "ret_30m": (s0 - float(last30.iloc[0])) / implied,
               "trend_consistency": float((np.sign(bars5) == np.sign(bars5.sum())).mean()) if len(bars5) and bars5.sum() != 0 else 0.5,
               "at_day_extreme": float(min(day_hi - s0, s0 - day_lo) <= 0.1 * implied),
               "dist_from_day_mean": (s0 - float(sofar.mean())) / implied, "abs_dist_from_day_mean": abs(s0 - float(sofar.mean())) / implied,
               "pct_time_above_open": float((sofar > open_).mean()),
               "move_from_open": (s0 - open_) / implied, "abs_move_from_open": abs(s0 - open_) / implied,
               "pos_in_range": (s0 - sofar.min()) / (sofar.max() - sofar.min()) if sofar.max() > sofar.min() else 0.5,
               "range_sofar": (sofar.max() - sofar.min()) / implied,
               "rv_sofar_vs_iv": float(r.std() * np.sqrt(390 * 252)) / (implied / s0 / 0.8 * np.sqrt(390 * 252 / max(1, 390 - len(sofar)))) if len(r) > 10 else np.nan,
               "last30_range": (sofar.iloc[-31:].max() - sofar.iloc[-31:].min()) / implied,
               "skew_p25_c25": skew, "straddle_spread_pct": spread_pct, "implied_pts": implied, "implied_pct": implied / s0}
        if oi is not None and len(oi):
            near = oi[(oi.index >= s0 - 100) & (oi.index <= s0 + 100)]
            rec["oi_pin_dist"] = abs(float(near.idxmax()) - s0) if len(near) else np.nan
            rec["oi_pin_dist_signed"] = (float(near.idxmax()) - s0) if len(near) else np.nan
            rec["oi_near_share"] = float(oi[(oi.index >= Kc - 25) & (oi.index <= Kc + 25)].sum() / oi.sum()) if oi.sum() else np.nan
        out.append(rec)
    return out


def build(workers):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if cal.loc[d, "half_day"]:
            continue
        jobs.append((f, spot[spot.index.normalize() == d], os.path.join(RAW, "SPXW/oi", d.strftime("%Y"), d.strftime("%Y%m%d") + ".csv.gz"), d))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(day_features, jobs, chunksize=8) for r in day]
    f = pd.DataFrame(rows)

    # daily context
    cal = cal.copy()
    cal["gap_pct"] = np.nan
    opens = spot.groupby(spot.index.normalize()).first()
    cal["gap_pct"] = (opens.reindex(cal.index) / cal.settle.shift(1) - 1) * 100
    cal["ret_5d"] = cal.settle.pct_change(5).shift(1) * 100
    cal["dist_ma20"] = (cal.settle.shift(1) / cal.settle.rolling(20).mean().shift(1) - 1) * 100
    cal["vix_chg"] = cal.vix_prev_close.pct_change() * 100
    cal["rv20"] = np.log(cal.settle).diff().rolling(20).std().shift(1) * np.sqrt(252) * 100
    cal["vix_minus_rv20"] = cal.vix_prev_close - cal.rv20
    nxt = cal[["fomc", "cpi", "nfp"]].shift(-1).fillna(False)
    cal["event_tomorrow"] = (nxt.fomc | nxt.cpi | nxt.nfp).astype(int)
    cal["month_end"] = (cal.groupby([cal.index.year, cal.index.month]).cumcount(ascending=False) < 3).astype(int)
    cal["dom"] = cal.index.day
    cal["month"] = cal.index.month
    cal["friday"] = (cal.index.weekday == 4).astype(int)
    gx = pd.read_parquet(os.path.join(CLEAN, "gex_daily.parquet"))
    cal = cal.join(gx[["gex_total", "gex_0dte", "zero_gamma", "call_wall", "put_wall", "oi_0dte"]])
    cal["zg_dist_pct"] = (cal.settle.shift(1) / cal.zero_gamma - 1) * 100
    cal["gex_0dte_sign"] = np.sign(cal.gex_0dte)
    cols = ["gap_pct", "ret_5d", "dist_ma20", "vix_chg", "vix_prev_close", "rv20", "vix_minus_rv20", "event_tomorrow", "month_end", "dom",
            "month", "friday", "gex_total", "gex_0dte", "gex_0dte_sign", "zg_dist_pct", "oi_0dte"]
    f = f.merge(cal[cols], left_on="date", right_index=True, how="left")
    f["abs_gap"] = f.gap_pct.abs()
    f["iv_premium"] = f.implied_pct * 100 / (f.vix_prev_close / 100 * np.sqrt(1 / 252) * 0.8 * 100)   # 0DTE straddle vs VIX-implied daily move
    f.to_parquet(os.path.join(CLEAN, "factor_panel.parquet"), index=False)
    return f


def screen(f):
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[(p.structure == "put_fly") & p.width.isin(WIDTHS) & p.entry.isin(ENTRIES)]
    d = p.merge(f, on=["date", "entry"], how="inner")
    d["test"] = d.date >= S.SPLIT
    skip = {"date", "entry", "width", "structure", "K", "spot", "dist", "implied", "w_over_implied", "range60_over_implied", "cost",
            "payoff", "pnl", "pnl_k0", "pnl_k05", "win", "test"}
    rows = []
    for col in [c for c in d.columns if c not in skip and d[c].dtype != object]:
        x = d[[col, "win", "pnl", "test", "entry", "width"]].dropna()
        tr, te = x[~x.test], x[x.test]
        if x[col].nunique() < 2 or len(tr) < 200 or len(te) < 200:
            continue
        if x[col].nunique() <= 5:
            tr_g = tr.groupby(col).win.mean()
            te_g = te.groupby(col).win.mean()
            lo_tr, hi_tr = tr_g.iloc[0], tr_g.iloc[-1]
            lo_te, hi_te = te_g.get(tr_g.index[0], np.nan), te_g.get(tr_g.index[-1], np.nan)
            n_te = te.groupby(col).size().min()
            kind = f"levels {list(tr_g.index)}"
        else:
            cuts = np.unique(np.quantile(tr[col], [0, .2, .4, .6, .8, 1]))
            if len(cuts) < 4:
                continue
            tb = pd.cut(tr[col], cuts, include_lowest=True)
            eb = pd.cut(te[col], cuts, include_lowest=True)
            tr_g = tr.groupby(tb, observed=True).win.mean()
            te_g = te.groupby(eb, observed=True).win.mean()
            lo_tr, hi_tr = tr_g.iloc[0], tr_g.iloc[-1]
            lo_te, hi_te = te_g.iloc[0], te_g.iloc[-1]
            n_te = te.groupby(eb, observed=True).size().min()
            kind = "quintiles"
        rho_tr = spearmanr(tr[col], tr.win).statistic
        rho_te = spearmanr(te[col], te.win).statistic
        rows.append({"factor": col, "kind": kind, "train_Q1": lo_tr, "train_Q5": hi_tr, "train_gap": hi_tr - lo_tr,
                     "test_Q1": lo_te, "test_Q5": hi_te, "test_gap": hi_te - lo_te, "test_min_n": n_te,
                     "rho_train": rho_tr, "rho_test": rho_te,
                     "holds": bool(np.sign(hi_tr - lo_tr) == np.sign(hi_te - lo_te) and abs(hi_te - lo_te) >= 0.05 and abs(hi_tr - lo_tr) >= 0.05)})
    out = pd.DataFrame(rows).sort_values("test_gap", key=abs, ascending=False).round(3)
    out.to_csv(os.path.join(S.TABLES, "factor_screen.csv"), index=False)
    return out, d


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    f = build(x.workers)
    out, d = screen(f)
    pd.set_option("display.width", 220)
    print(out.to_string())
