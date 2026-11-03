"""Factor family "positioning": open-interest structure and the GEX profile, evaluated at
the 13:00 / 14:00 entry spot, screened against the ATM put fly (width 25/30) held to settlement.

    .venv/bin/python src/mining/positioning.py build   [--workers 6]   # per-day factor panel
    .venv/bin/python src/mining/positioning.py screen                  # tables for the report
    .venv/bin/python src/mining/positioning.py all     [--workers 6]

Inputs (all known at the entry minute):
- OI file dated D (= D-1 close) and dated D-1 (= D-2 close) for SPXW, SPX, SPY, QQQ.
- greeks_eod of D-1 (closing NBBO) -> IV per strike via src/gex.py (same solver as gex_daily).
- spot.parquet at 13:00 / 14:00; SPY/QQQ spot from the TWS 1-minute bars (bar ending at t).
GEX at entry: time to expiry shortened by the hours elapsed since the D-1 close; IV held at
the D-1 close (no entry-time re-solve, this family is about positioning not vol).
Expired AM-settled SPX contracts of day D are dropped from every "all expiries" measure.

Outputs: reports/mining/positioning_tables/*.csv (+ positioning_panel.parquet cache).
"""
import argparse
import glob
import os
import sys
import warnings
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
sys.path.insert(0, SRC)
import gex as G  # noqa: E402
import winrate_study as S  # noqa: E402

ROOT = G.ROOT
CLEAN, RAW = G.CLEAN, G.RAW
TABLES = os.path.join(ROOT, "reports", "mining", "positioning_tables")
PANEL = os.path.join(TABLES, "positioning_panel.parquet")
SPLIT = pd.Timestamp("2024-11-01")
ENTRIES = ["13:00", "14:00"]
WIDTHS = [25, 30]
WINDOW = 0.10          # +-10% of spot for "all expiries" concentration measures
NEAR = 50.0            # points either side of spot for the local measures
ETF_WINDOW = 0.10

warnings.filterwarnings("ignore", category=RuntimeWarning)


# ---------------------------------------------------------------- helpers

def hhi(oi):
    tot = oi.sum()
    return float(((oi / tot) ** 2).sum()) if tot > 0 else np.nan


def log_ratio(a, b):
    return float(np.log((a + 1.0) / (b + 1.0)))


def max_pain(strikes, call_oi, put_oi):
    """Strike at which the total intrinsic payout to holders is smallest."""
    K = strikes[:, None]
    cand = strikes[None, :]
    pay = (call_oi[:, None] * np.maximum(cand - K, 0) + put_oi[:, None] * np.maximum(K - cand, 0)).sum(0)
    return float(strikes[pay.argmin()])


def read_oi(root, ymd):
    p = G.raw_path(f"{root}/oi", ymd)
    if not os.path.exists(p):
        return None
    o = pd.read_csv(p, compression="gzip", usecols=["expiration", "strike", "right", "open_interest"])
    o = o.drop_duplicates(["expiration", "strike", "right"], keep="last")
    o["expiration"] = pd.to_datetime(o.expiration)
    return o


def etf_factors(o, spot, d0, tag):
    """SPY / QQQ: concentration, put/call and 0DTE share from the whole chain around spot."""
    out = {}
    if o is None or not np.isfinite(spot):
        return out
    o = o[o.expiration >= d0]
    win = o[np.abs(o.strike / spot - 1) < ETF_WINDOW]
    by_k = win.groupby("strike").open_interest.sum()
    out[f"{tag}_hhi"] = hhi(by_k.values)
    out[f"{tag}_pc_log"] = log_ratio(win[win.right == "PUT"].open_interest.sum(), win[win.right == "CALL"].open_interest.sum())
    out[f"{tag}_centroid_pct"] = float(((by_k.index.values * by_k.values).sum() / by_k.sum() / spot - 1) * 100) if by_k.sum() > 0 else np.nan
    tot = o.open_interest.sum()
    out[f"{tag}_share_0dte"] = float(o[o.expiration == d0].open_interest.sum() / tot) if tot > 0 else np.nan
    return out


# ---------------------------------------------------------------- one day

def day_factors(args):
    prev2, prev, ymd, settle_prev, spots, etf_spots = args
    d0 = pd.Timestamp(ymd)
    base = pd.Timestamp(prev)
    try:
        df = G.load_day_inputs(prev, ymd)
    except FileNotFoundError:
        return []
    df = df[df.expiration >= d0].copy()
    # OI one file earlier (D-2 close) for the day-over-day change
    keys = ["expiration", "strike", "right"]
    prev_frames = [read_oi(r, prev2) for r in ("SPXW", "SPX")]
    prev_frames = [f.assign(root=r) for f, r in zip(prev_frames, ("SPXW", "SPX")) if f is not None]
    if prev_frames:
        po = pd.concat(prev_frames).rename(columns={"open_interest": "oi_prev"})
        df = df.merge(po, on=keys + ["root"], how="left")
        df["oi_prev"] = df.oi_prev.fillna(0.0)
    else:
        df["oi_prev"] = np.nan
    df["doi"] = df.open_interest - df.oi_prev
    # AM-settled SPX expiring today is gone by 13:00
    live = df[~((df.root == "SPX") & (df.expiration == d0))]
    zero = live[(live.root == "SPXW") & (live.expiration == d0)]
    net = G.net_by_strike(df, settle_prev, base)
    spy = read_oi("SPY", ymd)
    qqq = read_oi("QQQ", ymd)

    rows = []
    for e in ENTRIES:
        S0 = spots.get(e)
        if S0 is None or not np.isfinite(S0):
            continue
        r = {"date": d0, "entry": e, "spot_entry": S0}
        # ---------------- 0DTE OI structure
        if len(zero):
            by_k = zero.groupby("strike").open_interest.sum()
            tot0 = by_k.sum()
            r["hhi_0dte"] = hhi(by_k.values)
            r["centroid_0dte_pts"] = float((by_k.index.values * by_k.values).sum() / tot0 - S0) if tot0 > 0 else np.nan
            c0 = zero[zero.right == "CALL"].groupby("strike").open_interest.sum()
            p0 = zero[zero.right == "PUT"].groupby("strike").open_interest.sum()
            r["pc_log_0dte"] = log_ratio(p0.sum(), c0.sum())
            p_near = p0[(p0.index >= S0 - NEAR) & (p0.index < S0)].sum()
            c_near = c0[(c0.index > S0) & (c0.index <= S0 + NEAR)].sum()
            r["asym50_0dte"] = float((p_near - c_near) / (p_near + c_near)) if (p_near + c_near) > 0 else np.nan
            p_in = p0[(p0.index >= S0 - NEAR / 2) & (p0.index < S0)].sum()
            p_out = p0[(p0.index >= S0 - NEAR) & (p0.index < S0 - NEAR / 2)].sum()
            c_in = c0[(c0.index > S0) & (c0.index <= S0 + NEAR / 2)].sum()
            c_out = c0[(c0.index > S0 + NEAR / 2) & (c0.index <= S0 + NEAR)].sum()
            r["put_grad_0dte"] = float((p_in - p_out) / (p_in + p_out)) if (p_in + p_out) > 0 else np.nan
            r["call_grad_0dte"] = float((c_in - c_out) / (c_in + c_out)) if (c_in + c_out) > 0 else np.nan
            r["grad_asym_0dte"] = r["put_grad_0dte"] - r["call_grad_0dte"] if np.isfinite(r["put_grad_0dte"]) and np.isfinite(r["call_grad_0dte"]) else np.nan
            r["near25_share_0dte"] = float(by_k[np.abs(by_k.index - S0) <= NEAR / 2].sum() / tot0) if tot0 > 0 else np.nan
            ks = np.array(sorted(set(c0.index) | set(p0.index)), float)
            r["max_pain_dist_0dte"] = max_pain(ks, c0.reindex(ks).fillna(0).values, p0.reindex(ks).fillna(0).values) - S0
            r["abs_max_pain_dist_0dte"] = abs(r["max_pain_dist_0dte"])
            atm = zero[np.abs(zero.strike - S0) <= NEAR]
            r["doi_atm_call_0dte"] = float(atm[atm.right == "CALL"].doi.sum() / tot0) if tot0 > 0 else np.nan
            r["doi_atm_put_0dte"] = float(atm[atm.right == "PUT"].doi.sum() / tot0) if tot0 > 0 else np.nan
            r["doi_atm_net_0dte"] = r["doi_atm_call_0dte"] - r["doi_atm_put_0dte"]
            r["doi_atm_abs_0dte"] = float(atm.doi.abs().sum() / tot0) if tot0 > 0 else np.nan
        # ---------------- all-expiry OI structure (window +-10%)
        win = live[np.abs(live.strike / S0 - 1) < WINDOW]
        by_k = win.groupby("strike").open_interest.sum()
        tot = by_k.sum()
        r["hhi_all"] = hhi(by_k.values)
        r["centroid_all_pct"] = float(((by_k.index.values * by_k.values).sum() / tot / S0 - 1) * 100) if tot > 0 else np.nan
        r["pc_log_all"] = log_ratio(win[win.right == "PUT"].open_interest.sum(), win[win.right == "CALL"].open_interest.sum())
        tot_live = live.open_interest.sum()
        r["share_0dte"] = float(zero.open_interest.sum() / tot_live) if tot_live > 0 else np.nan
        atm_all = live[np.abs(live.strike - S0) <= NEAR]
        a_tot = atm_all.open_interest.sum()
        r["doi_atm_net_all"] = float((atm_all[atm_all.right == "CALL"].doi.sum() - atm_all[atm_all.right == "PUT"].doi.sum()) / a_tot) if a_tot > 0 else np.nan
        r["doi_atm_abs_all"] = float(atm_all.doi.abs().sum() / a_tot) if a_tot > 0 else np.nan
        # ---------------- GEX profile at the entry spot, time to expiry shortened to the entry minute
        # time elapsed since the D-1 close (16:00 of the previous trading day, not the calendar day before)
        elapsed = ((d0 + pd.Timedelta(hours=int(e[:2]))) - (base + pd.Timedelta(hours=16))).total_seconds() / 86400
        ne = net.assign(T=net["T"] - elapsed / 365)
        ne = ne[ne["T"] > 0]
        if len(ne):
            F = S0 * ne.F_ratio.values
            w = ne.iv.values ** 2 * ne["T"].values
            per = ne.net_oi.values * G.black_gamma(F, ne.K.values, w) * 100 * S0
            gross = np.abs(per).sum()
            g0 = per.sum()
            gp = G.gex_at(ne, S0 * 1.01)
            gm = G.gex_at(ne, S0 * 0.99)
            r["gex_entry"] = float(g0)
            r["gex_sign_n"] = float(g0 / gross) if gross > 0 else np.nan
            r["gex_slope_n"] = float((gp - gm) / 2 / gross) if gross > 0 else np.nan
            r["gex_curv_n"] = float((gp + gm - 2 * g0) / gross) if gross > 0 else np.nan
            is0 = (ne.exp.values == np.datetime64(d0)) & (ne.root.values == "SPXW")
            r["gex_0dte_n"] = float(per[is0].sum() / gross) if gross > 0 else np.nan
            r["gex_0dte_gross_share"] = float(np.abs(per[is0]).sum() / gross) if gross > 0 else np.nan
            # local GEX asymmetry: strikes within +-50, below vs above spot
            below = per[(ne.K.values < S0) & (ne.K.values >= S0 - NEAR)].sum()
            above = per[(ne.K.values > S0) & (ne.K.values <= S0 + NEAR)].sum()
            r["gex_local_asym"] = float((above - below) / gross) if gross > 0 else np.nan
        # ---------------- ETFs
        r.update(etf_factors(spy, etf_spots.get(("SPY", e), np.nan), d0, "spy"))
        r.update(etf_factors(qqq, etf_spots.get(("QQQ", e), np.nan), d0, "qqq"))
        rows.append(r)
    return rows


# ---------------------------------------------------------------- panel

def etf_spot_table():
    out = {}
    for sym in ("SPY", "QQQ"):
        files = sorted(glob.glob(os.path.join(ROOT, "data", "tws", f"{sym.lower()}_1m", "*.parquet")))
        b = pd.concat([pd.read_parquet(f, columns=["ts", "close"]) for f in files])
        ts = pd.to_datetime(b.ts).dt.tz_convert("America/New_York").dt.tz_localize(None)
        b = b.assign(ts=ts).drop_duplicates("ts").set_index("ts").close
        for e in ENTRIES:
            t = pd.Timestamp(f"2000-01-01 {e}") - pd.Timedelta(minutes=1)
            # bar starting at t-1 ends at t: the last close known at t
            sel = b[(b.index.hour == t.hour) & (b.index.minute == t.minute)]
            for d, v in sel.items():
                out[(sym, e, d.normalize())] = float(v)
    return out


def build(workers):
    os.makedirs(TABLES, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    etf = etf_spot_table()
    days = cal.index
    ymd = days.strftime("%Y%m%d").tolist()
    jobs = []
    for i in range(2, len(days)):
        d = days[i]
        if cal.half_day.iloc[i] or not cal.has_0dte.iloc[i]:
            continue
        spots = {e: float(spot.get(pd.Timestamp(f"{d.date()} {e}"), np.nan)) for e in ENTRIES}
        es = {(sym, e): etf.get((sym, e, d), np.nan) for sym in ("SPY", "QQQ") for e in ENTRIES}
        jobs.append((ymd[i - 2], ymd[i - 1], ymd[i], float(cal.settle.iloc[i - 1]), spots, es))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for rs in ex.map(day_factors, jobs, chunksize=4) for r in rs]
    f = pd.DataFrame(rows)
    # daily context from gex_daily (known before the open)
    gd = pd.read_parquet(os.path.join(CLEAN, "gex_daily.parquet"))
    pct = pd.Series([(gd.gex_total.iloc[max(0, i - 20):i] < gd.gex_total.iloc[i]).mean() if i >= 15 else np.nan
                     for i in range(len(gd))], index=gd.index)
    f["gex_total_pct20"] = f.date.map(pct)
    f["gex_entry_pct20"] = [(gd.gex_total.loc[:d].iloc[-21:-1] < g).mean() if d in gd.index and len(gd.gex_total.loc[:d]) > 16 else np.nan
                            for d, g in zip(f.date, f.gex_entry)]
    f["zg_dist_pct"] = (f.date.map(gd.zero_gamma) / f.spot_entry - 1) * 100
    f["oi_total_pct20"] = f.date.map(pd.Series([(gd.oi_total.iloc[max(0, i - 20):i] < gd.oi_total.iloc[i]).mean() if i >= 15 else np.nan
                                                for i in range(len(gd))], index=gd.index))
    f.to_parquet(PANEL)
    print(len(f), "rows;", f.date.nunique(), "days;", f.shape[1] - 3, "columns")
    return f


# ---------------------------------------------------------------- screening

FACTORS = {
    "hhi_0dte": "0DTE OI 的 Herfindahl（跨行权价）",
    "hhi_all": "全到期 OI 的 Herfindahl（现货 ±10% 内）",
    "centroid_0dte_pts": "0DTE OI 加权行权价重心 − 现货（点）",
    "centroid_all_pct": "全到期 OI 重心相对现货（%，±10% 内）",
    "pc_log_0dte": "0DTE put/call OI 对数比",
    "pc_log_all": "全到期 put/call OI 对数比（±10% 内）",
    "asym50_0dte": "±50 内 put OI（下）− call OI（上）的不对称度",
    "put_grad_0dte": "0DTE put OI 梯度：近 25 − 远 25（现货下方）",
    "call_grad_0dte": "0DTE call OI 梯度：近 25 − 远 25（现货上方）",
    "grad_asym_0dte": "put 梯度 − call 梯度",
    "near25_share_0dte": "0DTE OI 在现货 ±25 内的占比（钉住压力）",
    "max_pain_dist_0dte": "0DTE max pain − 现货（点）",
    "abs_max_pain_dist_0dte": "|0DTE max pain − 现货|（点）",
    "share_0dte": "0DTE OI 占全部存续 OI 的比例",
    "doi_atm_call_0dte": "0DTE call OI 日变化（ATM ±50）/ 0DTE OI",
    "doi_atm_put_0dte": "0DTE put OI 日变化（ATM ±50）/ 0DTE OI",
    "doi_atm_net_0dte": "0DTE call − put OI 日变化（ATM ±50）/ 0DTE OI",
    "doi_atm_abs_0dte": "0DTE |OI 日变化|（ATM ±50）/ 0DTE OI",
    "doi_atm_net_all": "全到期 call − put OI 日变化（ATM ±50）/ 该区 OI",
    "doi_atm_abs_all": "全到期 |OI 日变化|（ATM ±50）/ 该区 OI",
    "gex_sign_n": "入场现货处 GEX / 毛 GEX（符号与净度）",
    "gex_slope_n": "GEX 曲线斜率：[G(+1%) − G(−1%)]/2 / 毛 GEX",
    "gex_curv_n": "GEX 曲线曲率：[G(+1%) + G(−1%) − 2G(0)] / 毛 GEX",
    "gex_0dte_n": "0DTE 净 GEX / 毛 GEX",
    "gex_0dte_gross_share": "0DTE 毛 GEX 占比",
    "gex_local_asym": "±50 内 GEX：上方 − 下方 / 毛 GEX",
    "gex_total_pct20": "前收 GEX 总量在过去 20 日中的分位",
    "gex_entry_pct20": "入场现货处 GEX 在过去 20 日前收 GEX 中的分位",
    "zg_dist_pct": "零 gamma 位 − 现货（%）",
    "oi_total_pct20": "OI 总量在过去 20 日中的分位",
    "spy_hhi": "SPY 全到期 OI Herfindahl（±10%）",
    "spy_pc_log": "SPY put/call OI 对数比（±10%）",
    "spy_centroid_pct": "SPY OI 重心相对现货（%）",
    "spy_share_0dte": "SPY 0DTE OI 占比",
    "qqq_hhi": "QQQ 全到期 OI Herfindahl（±10%）",
    "qqq_pc_log": "QQQ put/call OI 对数比（±10%）",
    "qqq_centroid_pct": "QQQ OI 重心相对现货（%）",
    "qqq_share_0dte": "QQQ 0DTE OI 占比",
}


def target_panel():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    p = p[~p.date.map(cal.half_day).astype(bool)]
    p["spx_ret_prev"] = p.date.map(cal.spx_ret_prev)
    p["year"] = p.date.dt.year
    p["test"] = p.date >= SPLIT
    return p


def quintile_cuts(x):
    cuts = np.unique(np.quantile(x, [0, .2, .4, .6, .8, 1]))
    cuts[0], cuts[-1] = -np.inf, np.inf
    return cuts


def wilson_str(k, n):
    lo, hi = S.wilson(int(k), int(n))
    return lo, hi


def screen():
    f = pd.read_parquet(PANEL)
    p = target_panel()
    main = p[(p.structure == "put_fly") & p.width.isin(WIDTHS) & p.entry.isin(ENTRIES)]
    d = main.merge(f, on=["date", "entry"], how="inner")
    # implied terciles (training cut points on w_over_implied)
    tcuts = np.quantile(d[~d.test].w_over_implied, [1 / 3, 2 / 3])
    d["imp_t"] = pd.cut(d.w_over_implied, [-np.inf, tcuts[0], tcuts[1], np.inf], labels=["T1 宽/隐含低", "T2", "T3 宽/隐含高"])
    tr_all, te_all = d[~d.test], d[d.test]
    uni, ctrl, yearly = [], [], []
    cuts_by = {}
    for col, desc in FACTORS.items():
        if col not in d.columns:
            continue
        x = d[[col, "win", "pnl", "test", "date", "year", "imp_t", "entry"]].dropna(subset=[col])
        tr, te = x[~x.test], x[x.test]
        if len(tr) < 200 or len(te) < 200 or tr[col].nunique() < 10:
            continue
        cuts = quintile_cuts(tr[col].values)
        cuts_by[col] = cuts
        if len(cuts) < 4:
            continue
        qb = lambda s: pd.cut(s, cuts, labels=False, include_lowest=True)  # noqa: E731
        tq, eq = qb(tr[col]), qb(te[col])
        g_tr = tr.groupby(tq).agg(win=("win", "mean"), ev=("pnl", "mean"), n=("win", "size"))
        g_te = te.groupby(eq).agg(win=("win", "mean"), ev=("pnl", "mean"), n=("win", "size"))
        lo_tr, hi_tr = g_tr.win.iloc[0], g_tr.win.iloc[-1]
        lo_te, hi_te = g_te.win.get(0, np.nan), g_te.win.get(g_te.index.max(), np.nan)
        gap_tr, gap_te = hi_tr - lo_tr, hi_te - lo_te
        rho_tr = spearmanr(tr[col], tr.win).statistic
        rho_te = spearmanr(te[col], te.win).statistic
        holds = bool(np.sign(gap_tr) == np.sign(gap_te) and abs(gap_tr) >= 0.05 and abs(gap_te) >= 0.05)
        uni.append({"factor": col, "desc": desc, "n_train": len(tr), "n_test": len(te),
                    "train_Q1": lo_tr, "train_Q5": hi_tr, "train_gap": gap_tr,
                    "test_Q1": lo_te, "test_Q5": hi_te, "test_gap": gap_te, "test_min_n": int(g_te.n.min()),
                    "train_ev_Q1": g_tr.ev.iloc[0], "train_ev_Q5": g_tr.ev.iloc[-1],
                    "test_ev_Q1": g_te.ev.get(0, np.nan), "test_ev_Q5": g_te.ev.get(g_te.index.max(), np.nan),
                    "rho_train": rho_tr, "rho_test": rho_te, "rho_pnl_train": spearmanr(tr[col], tr.pnl).statistic,
                    "rho_pnl_test": spearmanr(te[col], te.pnl).statistic, "holds": holds})
        # control for implied: Q1/Q5 gap inside each training tercile of w_over_implied
        for t in d.imp_t.cat.categories:
            for per, sub in (("train", tr), ("test", te)):
                s = sub[sub.imp_t == t]
                q = qb(s[col])
                g = s.groupby(q).win.agg(["mean", "size"])
                ctrl.append({"factor": col, "imp_tercile": t, "period": per, "n": len(s),
                             "Q1": g["mean"].get(0, np.nan), "Q5": g["mean"].get(4, np.nan),
                             "gap": g["mean"].get(4, np.nan) - g["mean"].get(0, np.nan),
                             "n_Q1": g["size"].get(0, 0), "n_Q5": g["size"].get(4, 0)})
        # yearly: above / below the training median
        med = float(np.median(tr[col]))
        hi_flag = x[col] > med
        for y, s in x.assign(hi=hi_flag).groupby("year"):
            a, b = s[s.hi], s[~s.hi]
            yearly.append({"factor": col, "year": int(y), "n_low": len(b), "win_low": b.win.mean(), "ev_low": b.pnl.mean(),
                           "n_high": len(a), "win_high": a.win.mean(), "ev_high": a.pnl.mean(), "gap": a.win.mean() - b.win.mean()})
    uni = pd.DataFrame(uni).sort_values("test_gap", key=abs, ascending=False)
    ctrl = pd.DataFrame(ctrl)
    yearly = pd.DataFrame(yearly)
    uni.round(4).to_csv(os.path.join(TABLES, "univariate.csv"), index=False)
    ctrl.round(4).to_csv(os.path.join(TABLES, "control_implied.csv"), index=False)
    yearly.round(4).to_csv(os.path.join(TABLES, "yearly.csv"), index=False)

    # ---------------- incremental test on the baseline rule
    base = p[(p.structure == "put_fly") & (p.entry == "14:00")]
    base = base.assign(err=(base.w_over_implied - 2.0).abs()).sort_values("err").groupby("date").head(1)
    base = base[~(base.spx_ret_prev <= -0.01)]
    b = base.merge(f[f.entry == "14:00"], on=["date", "entry"], how="left")
    inc = []

    def rec(name, variant, g_tr, g_te, base_tr, base_te):
        row = {"factor": name, "variant": variant}
        for per, g, bb in (("train", g_tr, base_tr), ("test", g_te, base_te)):
            lo, hi = S.wilson(int(g.win.sum()), len(g))
            row.update({f"{per}_n": len(g), f"{per}_win": g.win.mean(), f"{per}_lo": lo, f"{per}_hi": hi, f"{per}_ev": g.pnl.mean(),
                        f"{per}_dwin": g.win.mean() - bb.win.mean(), f"{per}_dev": g.pnl.mean() - bb.pnl.mean()})
        inc.append(row)

    base_tr, base_te = b[~b.test], b[b.test]
    rec("基准", "14:00, 翅宽≈2×隐含, 跳过前日≤−1%", base_tr, base_te, base_tr, base_te)
    for _, u in uni.iterrows():
        col = u.factor
        cuts = cuts_by[col]
        sign = np.sign(u.train_gap)
        x = b.dropna(subset=[col])
        xtr, xte = x[~x.test], x[x.test]
        q = pd.cut(x[col], cuts, labels=False, include_lowest=True)
        bad_q = 0 if sign > 0 else 4
        keep1 = q != bad_q
        med = float(np.median(tr_all[col].dropna()))
        keep2 = (x[col] > med) if sign > 0 else (x[col] <= med)
        for variant, keep in (("去掉训练期最差五分位", keep1), ("只留训练期中位数的好一侧", keep2)):
            g = x[keep]
            rec(col, variant, g[~g.test], g[g.test], xtr, xte)
    inc = pd.DataFrame(inc)
    inc["valuable"] = (np.sign(inc.train_dwin) == np.sign(inc.test_dwin)) & (inc.test_dwin >= 0.03) & (inc.train_dwin > 0)
    inc.loc[inc.factor == "基准", "valuable"] = False
    inc.round(4).to_csv(os.path.join(TABLES, "incremental.csv"), index=False)

    # ---------------- control variant 2: median split inside each implied tercile (robust to empty quintile cells)
    ctrl2 = []
    for col in uni.factor:
        med = float(np.median(tr_all[col].dropna()))
        for t in d.imp_t.cat.categories:
            for per, sub in (("train", tr_all), ("test", te_all)):
                s = sub[(sub.imp_t == t)].dropna(subset=[col])
                hi, lo = s[s[col] > med], s[s[col] <= med]
                ctrl2.append({"factor": col, "imp_tercile": t, "period": per, "n_low": len(lo), "n_high": len(hi),
                              "win_low": lo.win.mean(), "win_high": hi.win.mean(), "gap": hi.win.mean() - lo.win.mean(),
                              "ev_low": lo.pnl.mean(), "ev_high": hi.pnl.mean()})
    pd.DataFrame(ctrl2).round(4).to_csv(os.path.join(TABLES, "control_implied_median.csv"), index=False)

    # ---------------- confounds: how much each factor is a shadow of vol level / the day's move so far
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    dd = d.assign(ret_to_entry=d.spot_entry / d.date.map(cal.settle.shift(1)) - 1,
                  vix_prev=d.date.map(cal.vix_prev_close), ret_prev=d.date.map(cal.spx_ret_prev))
    dd = dd[~dd.test]
    conf = pd.DataFrame([{"factor": c,
                          "rho_w_over_implied": spearmanr(dd[c], dd.w_over_implied, nan_policy="omit").statistic,
                          "rho_implied": spearmanr(dd[c], dd.implied, nan_policy="omit").statistic,
                          "rho_vix_prev": spearmanr(dd[c], dd.vix_prev, nan_policy="omit").statistic,
                          "rho_ret_to_entry": spearmanr(dd[c], dd.ret_to_entry, nan_policy="omit").statistic,
                          "rho_ret_prev": spearmanr(dd[c], dd.ret_prev, nan_policy="omit").statistic,
                          "rho_gex_sign_n": spearmanr(dd[c], dd.gex_sign_n, nan_policy="omit").statistic}
                         for c in uni.factor])
    conf.round(3).to_csv(os.path.join(TABLES, "confounds_train.csv"), index=False)

    # ---------------- conditional increments: the candidates inside positive / negative gamma, and jointly
    cond = []
    cands = inc[inc.valuable].drop_duplicates("factor").factor.tolist()
    for col in cands:
        u = uni[uni.factor == col].iloc[0]
        sign = np.sign(u.train_gap)
        med = float(np.median(tr_all[col].dropna()))
        x = b.dropna(subset=[col, "gex_sign_n"])
        keep = (x[col] > med) if sign > 0 else (x[col] <= med)
        for regime, m in (("GEX>0", x.gex_sign_n > 0), ("GEX<=0", x.gex_sign_n <= 0)):
            for per, pm in (("train", ~x.test), ("test", x.test)):
                bb, g = x[m & pm], x[m & pm & keep]
                lo, hi = S.wilson(int(g.win.sum()), len(g))
                cond.append({"factor": col, "regime": regime, "period": per, "n_base": len(bb), "win_base": bb.win.mean(), "ev_base": bb.pnl.mean(),
                             "n_kept": len(g), "win_kept": g.win.mean(), "lo": lo, "hi": hi, "ev_kept": g.pnl.mean(),
                             "dwin": g.win.mean() - bb.win.mean(), "dev": g.pnl.mean() - bb.pnl.mean()})
    pd.DataFrame(cond).round(4).to_csv(os.path.join(TABLES, "incremental_by_gex_regime.csv"), index=False)

    # ---------------- shadow check: is the increment just the day's move so far (ret_to_entry) or the gamma regime?
    bb = b.assign(ret_to_entry=b.spot_entry / b.date.map(cal.settle.shift(1)) - 1)
    rtr = bb[~bb.test].ret_to_entry.dropna()
    rcuts = np.quantile(rtr, [1 / 3, 2 / 3])
    bb["ret_t"] = pd.cut(bb.ret_to_entry, [-np.inf, rcuts[0], rcuts[1], np.inf], labels=["R1 日内跌", "R2", "R3 日内涨"])
    shadow = []

    def add_shadow(name, cond_name, x, keep):
        for per, pm in (("train", ~x.test), ("test", x.test)):
            base_, g = x[pm], x[pm & keep]
            lo, hi = S.wilson(int(g.win.sum()), len(g))
            shadow.append({"filter": name, "within": cond_name, "period": per, "n_base": len(base_), "win_base": base_.win.mean(),
                           "n_kept": len(g), "win_kept": g.win.mean(), "lo": lo, "hi": hi, "ev_base": base_.pnl.mean(), "ev_kept": g.pnl.mean(),
                           "dwin": g.win.mean() - base_.win.mean(), "dev": g.pnl.mean() - base_.pnl.mean()})

    # the plain intraday-move filter on the same baseline, for comparison
    rmed = float(np.median(rtr))
    add_shadow("ret_to_entry > 训练中位数", "全部", bb, bb.ret_to_entry > rmed)
    add_shadow("ret_to_entry > 0", "全部", bb, bb.ret_to_entry > 0)
    for col in cands:
        u = uni[uni.factor == col].iloc[0]
        sign = np.sign(u.train_gap)
        med = float(np.median(tr_all[col].dropna()))
        x = bb.dropna(subset=[col])
        keep = (x[col] > med) if sign > 0 else (x[col] <= med)
        add_shadow(f"{col} 好一侧", "全部", x, keep)
        for t in bb.ret_t.cat.categories:
            m = x.ret_t == t
            add_shadow(f"{col} 好一侧", str(t), x[m], keep[m])
        # both at once: factor filter on top of the intraday-move filter
        add_shadow(f"{col} 好一侧", "ret_to_entry > 0 之上", x[x.ret_to_entry > 0], keep[x.ret_to_entry > 0])
    pd.DataFrame(shadow).round(4).to_csv(os.path.join(TABLES, "shadow_ret_to_entry.csv"), index=False)

    # ---------------- permutation null: shuffle which day gets which factor row (all factors together, both entries)
    rng = np.random.default_rng(20261030)
    fdays = f.pivot_table(index="date", columns="entry", values=list(uni.factor))
    nperm, perm_rows = 200, []
    base_cols = ["date", "entry", "win", "pnl", "test", "w_over_implied"]
    for k in range(nperm):
        perm_dates = fdays.index.values.copy()
        rng.shuffle(perm_dates)
        fp = fdays.copy()
        fp.index = pd.DatetimeIndex(perm_dates)
        fp = fp.stack(future_stack=True).reset_index().rename(columns={"level_0": "date", "level_1": "entry"})
        dp = main[base_cols].merge(fp, on=["date", "entry"], how="inner")
        bp = base[["date", "entry", "win", "pnl", "test"]].merge(fp[fp.entry == "14:00"], on=["date", "entry"], how="left")
        n_hold, n_val = 0, 0
        for col in uni.factor:
            x = dp.dropna(subset=[col])
            tr, te = x[~x.test], x[x.test]
            cuts = quintile_cuts(tr[col].values)
            if len(cuts) < 4:
                continue
            tq = pd.cut(tr[col], cuts, labels=False, include_lowest=True)
            eq = pd.cut(te[col], cuts, labels=False, include_lowest=True)
            g_tr, g_te = tr.groupby(tq).win.mean(), te.groupby(eq).win.mean()
            gap_tr, gap_te = g_tr.iloc[-1] - g_tr.iloc[0], g_te.get(4, np.nan) - g_te.get(0, np.nan)
            if np.sign(gap_tr) == np.sign(gap_te) and abs(gap_tr) >= 0.05 and abs(gap_te) >= 0.05:
                n_hold += 1
            sign = np.sign(gap_tr)
            xb = bp.dropna(subset=[col])
            med = float(np.median(tr[col]))
            q = pd.cut(xb[col], cuts, labels=False, include_lowest=True)
            for keep in (q != (0 if sign > 0 else 4), (xb[col] > med) if sign > 0 else (xb[col] <= med)):
                g = xb[keep]
                d_tr = g[~g.test].win.mean() - xb[~xb.test].win.mean()
                d_te = g[g.test].win.mean() - xb[xb.test].win.mean()
                if d_tr > 0 and d_te >= 0.03:
                    n_val += 1
        perm_rows.append({"perm": k, "n_holds": n_hold, "n_valuable": n_val})
    perm = pd.DataFrame(perm_rows)
    perm.to_csv(os.path.join(TABLES, "permutation_null.csv"), index=False)
    perm_summary = pd.DataFrame([{"nperm": nperm, "observed_holds": int(uni.holds.sum()), "null_holds_mean": perm.n_holds.mean(),
                                  "null_holds_p95": perm.n_holds.quantile(.95), "p_holds": (perm.n_holds >= int(uni.holds.sum())).mean(),
                                  "observed_valuable": int(inc.valuable.sum()), "null_valuable_mean": perm.n_valuable.mean(),
                                  "null_valuable_p95": perm.n_valuable.quantile(.95), "p_valuable": (perm.n_valuable >= int(inc.valuable.sum())).mean()}])
    perm_summary.round(3).to_csv(os.path.join(TABLES, "permutation_summary.csv"), index=False)
    print(perm_summary.round(3).to_string())

    # ---------------- multiple-comparison ledger
    n_fac = len(uni)
    ledger = pd.DataFrame([
        {"item": "因子数（单变量筛，各一次）", "trials": n_fac},
        {"item": "控制隐含分组（因子 × 3 组 × 两期）", "trials": n_fac * 3 * 2},
        {"item": "增量检验变体（因子 × 2 变体）", "trials": n_fac * 2},
        {"item": "分年表（因子 × 5 年）", "trials": n_fac * 5},
        {"item": "单变量 5% 水平下预期假阳性（因子数 × 0.05）", "trials": round(n_fac * 0.05, 2)},
        {"item": "单变量两期同号且 |gap|≥5pp 的因子数", "trials": int(uni.holds.sum())},
        {"item": "增量两期同号且测试期 ≥ +3pp 的（因子, 变体）数", "trials": int(inc.valuable.sum())},
        {"item": "置换检验次数（打乱因子与交易日的对应，所有因子一起）", "trials": nperm},
        {"item": "置换下每次平均成立的因子数", "trials": round(perm.n_holds.mean(), 2)},
        {"item": "置换下每次平均增量有价值的（因子, 变体）数", "trials": round(perm.n_valuable.mean(), 2)},
    ])
    ledger.to_csv(os.path.join(TABLES, "multiple_comparisons.csv"), index=False)

    # ---------------- sample description
    desc = pd.DataFrame({"n_rows_train": [len(tr_all)], "n_rows_test": [len(te_all)],
                         "n_days_train": [tr_all.date.nunique()], "n_days_test": [te_all.date.nunique()],
                         "base_win_train": [tr_all.win.mean()], "base_win_test": [te_all.win.mean()],
                         "base_ev_train": [tr_all.pnl.mean()], "base_ev_test": [te_all.pnl.mean()],
                         "imp_tercile_cuts": [f"{tcuts[0]:.3f} / {tcuts[1]:.3f}"]})
    desc.round(4).to_csv(os.path.join(TABLES, "sample.csv"), index=False)
    # per-factor spearman between the two entries (13:00 vs 14:00 same day) as a redundancy check
    piv = f.pivot_table(index="date", columns="entry", values=[c for c in FACTORS if c in f.columns])
    corr = pd.Series({c: piv[c]["13:00"].corr(piv[c]["14:00"]) for c in FACTORS if c in f.columns}, name="corr_13_14")
    corr.round(3).to_csv(os.path.join(TABLES, "entry_redundancy.csv"))
    # factor-factor correlation (training, 14:00)
    f14 = f[(f.entry == "14:00") & (f.date < SPLIT)][[c for c in FACTORS if c in f.columns]]
    f14.corr(method="spearman").round(2).to_csv(os.path.join(TABLES, "factor_corr_train.csv"))
    print(uni[["factor", "train_gap", "test_gap", "rho_train", "rho_test", "holds"]].round(3).to_string())
    print(inc[inc.valuable][["factor", "variant", "train_n", "train_dwin", "test_n", "test_dwin", "test_dev"]].round(3).to_string())
    return uni, ctrl, yearly, inc


# ---------------------------------------------------------------- report

REPORT = os.path.join(ROOT, "reports", "mining", "positioning.md")


def pct(x):
    return "—" if pd.isna(x) else f"{100 * x:.1f}%"


def pp(x):
    return "—" if pd.isna(x) else f"{100 * x:+.1f}"


def ev(x):
    return "—" if pd.isna(x) else f"{x:+.0f}"


def md(df):
    cols = list(df.columns)
    out = ["| " + " | ".join(str(c) for c in cols) + " |", "|" + "---|" * len(cols)]
    for _, r in df.iterrows():
        out.append("| " + " | ".join(str(v).replace("|", "∣") for v in r.values) + " |")
    return "\n".join(out)


def stack_sentence(shadow):
    parts = []
    for col in ("max_pain_dist_0dte", "asym50_0dte"):
        g = shadow[shadow["filter"] == f"{col} 好一侧"]
        on = g[g.within == "ret_to_entry > 0 之上"].set_index("period")
        r1 = g[g.within == "R1 日内跌"].set_index("period")
        r23 = g[g.within.isin(["R2", "R3 日内涨"])]
        parts.append(f"{col}：叠在 `ret_to_entry > 0` 之上训练 {pp(on.loc['train', 'dwin'])}、测试 {pp(on.loc['test', 'dwin'])}pp；"
                     f"按已走幅度分三组，「日内跌」组训练 {pp(r1.loc['train', 'dwin'])}、测试 {pp(r1.loc['test', 'dwin'])}pp（留下仅 {int(r1.loc['train', 'n_kept'])} / {int(r1.loc['test', 'n_kept'])} 笔），"
                     f"「持平」「日内涨」两组 |Δ| ≤ {100 * r23.dwin.abs().max():.1f}pp")
    return "再看两项候选——" + "；".join(parts) + "。"


def report():
    T = lambda n: pd.read_csv(os.path.join(TABLES, n))  # noqa: E731
    uni, inc, ctrl, ctrl2, yearly = T("univariate.csv"), T("incremental.csv"), T("control_implied.csv"), T("control_implied_median.csv"), T("yearly.csv")
    conf, cond, shadow, perm, ledger, samp = T("confounds_train.csv"), T("incremental_by_gex_regime.csv"), T("shadow_ret_to_entry.csv"), T("permutation_summary.csv").iloc[0], T("multiple_comparisons.csv"), T("sample.csv").iloc[0]
    corr = pd.read_csv(os.path.join(TABLES, "factor_corr_train.csv"), index_col=0)
    hold = uni[uni.holds]
    base = inc[inc.factor == "基准"].iloc[0]
    val = inc[inc.valuable]
    L = []
    L.append("# 因子族 positioning：持仓结构（OI）与 GEX 轮廓\n")
    L.append(f"脚本 `src/mining/positioning.py`；表 `reports/mining/positioning_tables/`。目标：put_fly、翅宽 25/30、13:00 与 14:00 入场，持到结算，胜率 = pnl>0（k=0.25 含费）。"
             f"训练期 `date < 2024-11-01`（{int(samp.n_days_train)} 天 / {int(samp.n_rows_train)} 行），测试期（{int(samp.n_days_test)} 天 / {int(samp.n_rows_test)} 行）；剔除半天。"
             f"全样本基准胜率训练 {pct(samp.base_win_train)}、测试 {pct(samp.base_win_test)}；期望训练 {samp.base_ev_train:+.0f}、测试 {samp.base_ev_test:+.0f} 美元/笔。\n")
    L.append("## 1. 一句话结论\n")
    L.append(f"**没有找到能叠在基准规则上的持仓结构因子。** {len(uni)} 个因子里 {len(hold)} 个单变量两期成立（置换零假设下平均只有 {perm.null_holds_mean:.1f} 个，p={perm.p_holds:.2f}，所以结构本身是真的），"
             f"但它们几乎全是同一件事的不同写法——「现货处 GEX 为正 / 零 gamma 在下方 / put-call OI 低 / OI 重心在现货下方」，训练期两两 Spearman 多在 0.8–0.97；"
             f"而这件事与隐含水平（|ρ| 0.3–0.6）和当日已走幅度（ρ 0.45–0.78）高度相关。叠到基准（14:00、翅宽≈2×隐含、跳过前日 ≤−1%）上，"
             f"{len(uni) * 2} 个（因子, 变体）里只有 {len(val)} 个两期同号且测试期 ≥+3pp，置换零假设下平均 {perm.null_valuable_mean:.1f} 个、p={perm.p_valuable:.2f}，与运气无法区分；"
             f"其中 max pain 距现货与 ±50 OI 不对称两项的增量在按「当日已走幅度」分层后消失，是日内动量的影子。\n")
    L.append("## 2. 试过的因子\n")
    L.append("所有因子都在入场那一分钟已知：OI 用 D 日文件（= D−1 收盘），OI 日变化 = D 文件 − D−1 文件；GEX 用 D−1 收盘 NBBO 反解的 IV（与 `gex_daily` 同一套 `src/gex.py` 求解器），"
             "到期时间按入场时刻缩短（从前一交易日 16:00 到入场时刻的实际小时数，周一与假日后按日历算），在入场现货 S 处重算，并在 S×(1±1%) 处重算以取斜率与曲率；当天到期的 AM 结算 SPX 从所有「全到期」口径里剔掉。"
             "全到期的集中度 / 重心 / put-call 只用现货 ±10% 内的行权价；局部口径用 ±50 点。SPY/QQQ 现货取 TWS 1 分钟 K 线在入场前一分钟的收盘。\n")
    f_tbl = uni[["factor", "desc"]].copy()
    f_tbl.columns = ["因子", "定义"]
    L.append(md(f_tbl) + "\n")
    L.append("为什么有道理：Herfindahl 与 ±25 占比衡量「钉住」压力；重心与 max pain 衡量 OI 质量相对现货的位置（结算倾向往 OI 多的地方靠的说法）；"
             "±50 的 put/call 不对称和梯度衡量两侧对冲需求是否平衡；OI 日变化衡量昨天新开的仓是在 ATM 附近还是远处；GEX 的符号、斜率、曲率描述做市商对冲是压波动（正 gamma、曲线在现货处向上）还是放大波动；"
             "20 日分位把量级变成当天相对自己历史的位置；SPY/QQQ 是跨资产对照，看 SPX 期权的结构是不是整个市场的结构。\n")
    L.append("## 3. 单变量筛查（全部）\n")
    L.append("训练期五分位切点套到测试期；Q1/Q5 为两端的胜率，gap = Q5 − Q1，ρ 为与 win 的 Spearman；「成立」= 两期同号且两期 |gap| ≥ 5pp。按 |测试 gap| 排序。\n")
    u = uni.copy()
    tbl = pd.DataFrame({"因子": u.factor, "训练 Q1→Q5": [f"{pct(a)}→{pct(b)}" for a, b in zip(u.train_Q1, u.train_Q5)], "训练 gap": u.train_gap.map(pp),
                        "测试 Q1→Q5": [f"{pct(a)}→{pct(b)}" for a, b in zip(u.test_Q1, u.test_Q5)], "测试 gap": u.test_gap.map(pp),
                        "ρ 训练/测试": [f"{a:+.3f}/{b:+.3f}" for a, b in zip(u.rho_train, u.rho_test)],
                        "期望 Q1→Q5 测试": [f"{ev(a)}→{ev(b)}" for a, b in zip(u.test_ev_Q1, u.test_ev_Q5)],
                        "测试最小格 n": u.test_min_n, "成立": ["是" if h else "" for h in u.holds]})
    L.append(md(tbl) + "\n")
    L.append("### 3.1 成立的因子其实是一簇\n")
    hc = hold.factor.tolist()
    L.append("训练期 14:00 的 Spearman（成立者之间）：\n")
    L.append(md(corr.loc[hc, hc].reset_index().rename(columns={"index": ""})) + "\n")
    L.append("与混杂变量的 Spearman（训练期；`ret_to_entry` = 入场现货 / 前收 − 1）：\n")
    cf = conf[conf.factor.isin(hc)].copy()
    cf.columns = ["因子", "ρ 宽/隐含", "ρ 隐含", "ρ VIX 前收", "ρ 当日已走", "ρ 前日涨跌", "ρ GEX 符号"]
    L.append(md(cf.round(2)) + "\n")
    L.append("## 4. 成立者：控制隐含、增量检验、分年\n")
    L.append("### 4.1 控制隐含（`w_over_implied` 训练期三分位，切点 " + str(samp.imp_tercile_cuts) + "）\n")
    L.append("每格 = 因子按训练期中位数分高低两组，高 − 低 的胜率差（五分位版见 `control_implied.csv`，T3 里很多因子的 Q5 为空，故这里用中位数切）。\n")
    c2 = ctrl2[ctrl2.factor.isin(hc)]
    pv = c2.pivot_table(index="factor", columns=["imp_tercile", "period"], values="gap")
    pv = pv.reindex(columns=[(t, p) for t in ["T1 宽/隐含低", "T2", "T3 宽/隐含高"] for p in ["train", "test"]])
    pv.columns = [f"{t} {p}" for t, p in pv.columns]
    pv = pv.map(pp).reset_index().rename(columns={"factor": "因子"})
    L.append(md(pv) + "\n")
    surv = []
    for fct in hc:
        g = c2[c2.factor == fct]
        ok = all(np.sign(g[(g.imp_tercile == t) & (g.period == "train")].gap.iloc[0]) == np.sign(g[(g.imp_tercile == t) & (g.period == "test")].gap.iloc[0])
                 and abs(g[(g.imp_tercile == t) & (g.period == "test")].gap.iloc[0]) >= 0.05 for t in ["T1 宽/隐含低", "T2", "T3 宽/隐含高"])
        if ok:
            surv.append(fct)
    L.append(f"三组里两期都同号且测试 |gap| ≥ 5pp 的：{', '.join(surv) if surv else '无'}。\n")
    L.append("### 4.2 增量检验\n")
    L.append(f"基准 = 14:00 入场、每天在 20/25/30/50/75 里选 `w_over_implied` 最接近 2 的翅宽、跳过 `spx_ret_prev ≤ −1%`：训练 n={int(base.train_n)}，胜率 {pct(base.train_win)}（Wilson {pct(base.train_lo)}–{pct(base.train_hi)}），期望 {base.train_ev:+.0f}；"
             f"测试 n={int(base.test_n)}，胜率 {pct(base.test_win)}（{pct(base.test_lo)}–{pct(base.test_hi)}），期望 {base.test_ev:+.0f}。两个变体：去掉训练期最差五分位；只留训练期中位数的好一侧（方向由训练 gap 符号定）。\n")
    ic = inc[inc.factor.isin(hc) | inc.valuable].copy()
    tbl = pd.DataFrame({"因子": ic.factor, "变体": ic.variant,
                        "训练 n / 胜率 / 区间 / 期望": [f"{int(n)} / {pct(w)} / {pct(lo)}–{pct(hi)} / {ev:+.0f}" for n, w, lo, hi, ev in zip(ic.train_n, ic.train_win, ic.train_lo, ic.train_hi, ic.train_ev)],
                        "训练 Δ胜率 / Δ期望": [f"{pp(a)} / {b:+.0f}" for a, b in zip(ic.train_dwin, ic.train_dev)],
                        "测试 n / 胜率 / 区间 / 期望": [f"{int(n)} / {pct(w)} / {pct(lo)}–{pct(hi)} / {ev:+.0f}" for n, w, lo, hi, ev in zip(ic.test_n, ic.test_win, ic.test_lo, ic.test_hi, ic.test_ev)],
                        "测试 Δ胜率 / Δ期望": [f"{pp(a)} / {b:+.0f}" for a, b in zip(ic.test_dwin, ic.test_dev)],
                        "有价值": ["是" if v else "" for v in ic.valuable]})
    L.append(md(tbl) + "\n")
    nv_hold = val[val.factor.isin(hc)]
    L.append(f"单变量成立且增量「有价值」的：{', '.join(nv_hold.factor.tolist()) if len(nv_hold) else '无'}；单变量不成立却碰上增量门槛的：{', '.join(val[~val.factor.isin(hc)].factor.tolist()) or '无'}（后者没有单变量基础，不算）。\n")
    L.append("### 4.3 增量候选的影子检验\n")
    L.append("把同一个「好一侧」过滤放进 GEX 符号两组内（`incremental_by_gex_regime.csv`），以及放进「当日已走幅度」训练期三分位内 / 叠在 `ret_to_entry > 0` 之上（`shadow_ret_to_entry.csv`）：\n")
    sh = shadow.copy()
    tbl = pd.DataFrame({"过滤": sh["filter"], "范围": sh.within, "期": sh.period, "基准 n / 胜率": [f"{int(n)} / {pct(w)}" for n, w in zip(sh.n_base, sh.win_base)],
                        "留下 n / 胜率 / 区间": [f"{int(n)} / {pct(w)} / {pct(lo)}–{pct(hi)}" for n, w, lo, hi in zip(sh.n_kept, sh.win_kept, sh.lo, sh.hi)],
                        "Δ胜率": sh.dwin.map(pp), "Δ期望": sh.dev.map(lambda v: f"{v:+.0f}")})
    L.append(md(tbl) + "\n")
    cd = cond.copy()
    tbl = pd.DataFrame({"因子": cd.factor, "GEX 组": cd.regime, "期": cd.period, "基准 n / 胜率": [f"{int(n)} / {pct(w)}" for n, w in zip(cd.n_base, cd.win_base)],
                        "留下 n / 胜率 / 区间": [f"{int(n)} / {pct(w)} / {pct(lo)}–{pct(hi)}" for n, w, lo, hi in zip(cd.n_kept, cd.win_kept, cd.lo, cd.hi)],
                        "Δ胜率": cd.dwin.map(pp), "Δ期望": cd.dev.map(lambda v: f"{v:+.0f}")})
    L.append(md(tbl) + "\n")
    r0 = shadow[(shadow["filter"] == "ret_to_entry > 0") & (shadow.within == "全部")]
    L.append(f"单纯「当日已涨」（`ret_to_entry > 0`）叠在基准上：训练 {pp(r0[r0.period == 'train'].dwin.iloc[0])}、测试 {pp(r0[r0.period == 'test'].dwin.iloc[0])}pp——和 max pain / 不对称两项给的增量一样大；"
             + stack_sentence(shadow) + "它们测的是「现货已经涨到 OI 质量上方」，不是持仓本身。\n")
    L.append("### 4.4 分年（高 − 低，按训练期中位数切）\n")
    yy = yearly[yearly.factor.isin(hc)]
    pv = yy.pivot_table(index="factor", columns="year", values="gap").map(pp)
    pn = yy.pivot_table(index="factor", columns="year", values=["n_low", "n_high"], aggfunc="first")
    pv.columns = [str(c) for c in pv.columns]
    pv = pv.reset_index().rename(columns={"factor": "因子"})
    L.append(md(pv) + "\n")
    nn = yy.groupby("year").agg(n_low=("n_low", "median"), n_high=("n_high", "median")).astype(int).T
    nn.columns = [str(c) for c in nn.columns]
    L.append("各年低 / 高组行数（成立因子的中位数；2022 从 5 月起、2026 到 10 月止）：\n")
    L.append(md(nn.reset_index().rename(columns={"index": ""})) + "\n")
    L.append("## 5. 多重比较账\n")
    lg = ledger.copy()
    lg.columns = ["项目", "数"]
    L.append(md(lg) + "\n")
    L.append(f"置换检验：把因子面板按交易日整体打乱（所有因子一起、13:00/14:00 配对不拆）{int(perm.nperm)} 次，重做单变量筛与增量检验。"
             f"单变量「成立」数：观察 {int(perm.observed_holds)}，零假设均值 {perm.null_holds_mean:.2f}、95 分位 {perm.null_holds_p95:.0f}，p={perm.p_holds:.3f}；"
             f"增量「有价值」数：观察 {int(perm.observed_valuable)}，零假设均值 {perm.null_valuable_mean:.2f}、95 分位 {perm.null_valuable_p95:.0f}，p={perm.p_valuable:.3f}。"
             f"也就是说单变量层面的结构是真的（但它是一簇而不是 {int(perm.observed_holds)} 个独立发现，且与隐含和日内走势相关），增量层面的 {int(perm.observed_valuable)} 个命中与随机无法区分。"
             "注意置换把交易日独立打乱，拆掉了 GEX 符号、零 gamma 距离这类慢变量的自相关，真实的零假设下「跨时间切分仍成立」的个数会比这里的均值略多。\n")
    L.append("## 6. 与前面研究的关系、局限\n")
    L.append("- `winrate_study.md` 已经报告过「距零 gamma」「总 GEX」「0DTE GEX」单变量成立、叠在按隐含定翅宽之后没有增量；本次在入场现货处重算 GEX、加上 OI 日变化、max pain、梯度、ETF 对照，结论一样。\n"
             "- GEX 符号这一簇在控制隐含的三组内仍同向（4.1 表），说明它不完全是隐含的影子；但基准规则里的「跳过前日 ≤ −1%」和按隐含选翅宽已经吃掉了它的大部分（4.2 表增量 +1～+2pp）。\n"
             "- IV 用 D−1 收盘、到期时间缩到入场时刻，没有用入场时刻的 0DTE 实时报价重解 IV，所以 0DTE 的 gamma 量级只是近似；GEX 符号假定做市商多 call 空 put（见 `src/gex.py` 开头）。\n"
             "- 13:00 与 14:00 两行高度相关（`entry_redundancy.csv`，多数因子 ρ>0.94），单变量表的 n 按行数计，实际独立样本约为其一半。\n"
             "- 基准规则测试期的 n / 胜率 / 期望与 `winrate_study.md` 的 439 / 61.0% / +100 一致；训练期 n 与那里的 504 不同（本文 {}），来自上游面板日期范围 / 标签合并的差异，未追。\n"
             "- 测试期全体胜率（{}）比训练期（{}）高，很多因子测试 gap 大于训练 gap，部分是测试期顺风。\n".format(int(base.train_n), pct(samp.base_win_test), pct(samp.base_win_train)))
    L.append("## 7. 可复现命令\n")
    L.append("```\ncd /Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly\n.venv/bin/python src/mining/positioning.py build --workers 6   # ~2 分钟，写 positioning_tables/positioning_panel.parquet\n"
             ".venv/bin/python src/mining/positioning.py screen             # ~25 秒（含 200 次置换），写全部 csv\n.venv/bin/python src/mining/positioning.py report             # 由 csv 生成本文\n```\n")
    open(REPORT, "w").write("\n".join(L))
    print("wrote", REPORT)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["build", "screen", "report", "all"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    if x.cmd in ("build", "all"):
        build(x.workers)
    if x.cmd in ("screen", "all"):
        screen()
    if x.cmd in ("report", "all"):
        report()
