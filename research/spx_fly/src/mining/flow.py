"""Factor family `flow`: microstructure of 0DTE SPXW option trades before a 13:00 / 14:00 fly entry.

    .venv/bin/python src/mining/flow.py build  [--workers 6]   # reads data/raw/SPXW/trade_quote_dte0 -> reports/mining/flow_tables/features.parquet
    .venv/bin/python src/mining/flow.py screen                  # tables -> reports/mining/flow_tables/*.csv, summary -> flow_tables/summary.md
    .venv/bin/python src/mining/flow.py all

Data: ThetaData trade+NBBO for same-day-expiry SPXW, 2024-10-30 onwards (501 files). Only the ten columns
needed are read. Aggressor side: a trade is a BUY if price >= ask, a SELL if price <= bid, else unclassified;
rows with ask <= 0 or bid >= ask (empty / locked / crossed NBBO) are never classified; condition codes
130/131/134/137/144 (legs of a complex order) are dropped before everything (they carry no aggressor
information for a single line). All features at entry t use trades with trade_timestamp < t only.

Targets: win / pnl of the ATM put fly (width 25 and 30, from winrate_panel.parquet) and the spot move in the
60 minutes after entry (signed points, and |move| / implied). Split: train date < 2025-11-01, test after.
Quintile cuts and medians are fitted per entry on the training period only.
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
R = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(R, "src"))
from winrate_study import stats, wilson  # noqa: E402

CLEAN = os.path.join(R, "data", "clean")
RAW = os.path.join(R, "data", "raw", "SPXW", "trade_quote_dte0")
TABLES = os.path.join(R, "reports", "mining", "flow_tables")
FEAT = os.path.join(TABLES, "features.parquet")   # own output dir; data/clean is read-only
SPLIT = pd.Timestamp("2025-11-01")
ENTRIES = ["13:00", "14:00"]
WIDTHS = [25, 30]
COMBO = {130, 131, 134, 137, 144}
USECOLS = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask", "bid_size", "ask_size"]
BASE_WIDTHS = [20, 25, 30, 50, 75]
MIN_Q_N = 30       # a factor whose test rows leave a train quintile with fewer rows than this is flagged as drifted
MIN_INC_N = 50     # minimum days in each period for an incremental overlay to count

# name -> (definition, why)
FACTORS = {
    "nf_call_25_day": ("自开盘至 t，|K−spot|≤25 的 call 主动净量 (买−卖)/(买+卖)", "近月 ATM call 的方向性需求"),
    "nf_put_25_day": ("同上，put", "ATM put 的方向性需求（对冲 / 投机）"),
    "nf_call_50_day": ("自开盘至 t，|K−spot|≤50 的 call 净主动量比", "带宽放宽到 ±50"),
    "nf_put_50_day": ("同上，put", "同上"),
    "nf_call_25_60": ("t 前 60 分钟，±25 call 净主动量比", "近期而非全天的需求"),
    "nf_put_25_60": ("t 前 60 分钟，±25 put 净主动量比", "同上"),
    "nf_all_60": ("t 前 60 分钟，全部行权价两侧合计净主动量比", "整体买压 / 卖压"),
    "accel30": ("(净主动量[t−30,t) − 净主动量[t−60,t−30)) / 成交量[t−60,t)", "净主动量在最近 30 分钟的加速度"),
    "accel60": ("(净主动量[t−60,t) − 净主动量[t−120,t−60)) / 成交量[t−120,t)", "60 分钟尺度的加速度"),
    "big50_share_day": ("自开盘至 t，单笔 size≥50 的成交张数占比", "机构大单活跃度"),
    "big100_share_day": ("自开盘至 t，size≥100 的张数占比", "同上，更大阈值"),
    "big50_net_day": ("自开盘至 t，size≥50 成交的净主动量比", "大单的净方向"),
    "big50_net_60": ("t 前 60 分钟，size≥50 成交的净主动量比", "近期大单净方向"),
    "frag_day": ("自开盘至 t，成交笔数 / 成交张数", "碎单程度（算法拆单、散户）"),
    "frag_60": ("t 前 60 分钟，笔数 / 张数", "同上，近期"),
    "hhi_day": ("自开盘至 t，成交张数按行权价的 Herfindahl 指数", "成交是否集中在少数行权价（钉住）"),
    "hhi_60": ("t 前 60 分钟，按行权价的 Herfindahl", "同上，近期"),
    "centroid_day": ("自开盘至 t，|K−spot|≤100 内成交量加权平均行权价 − spot（点）", "成交重心相对现货的偏移"),
    "centroid_60": ("t 前 60 分钟，同上", "近期成交重心"),
    "pc_ratio_60": ("t 前 60 分钟 put 张数 / call 张数", "恐慌 / 对冲需求"),
    "pc_ratio_chg": ("pc_ratio_60 / 自开盘至 t 的 put/call 比", "put/call 比相对当日均值的变化"),
    "eff_60": ("t 前 60 分钟，可分类成交的 (price−mid)/(半点差) 张数加权均值（买方付出为正）", "买方急迫度"),
    "eff_call_60": ("同上，仅 call", "call 买方急迫度"),
    "eff_put_60": ("同上，仅 put", "put 买方急迫度"),
    "eff_abs_60": ("t 前 60 分钟，2·|price−mid| 张数加权均值（点）", "实际付出的有效点差（流动性成本）"),
    "nprem_put_50_60": ("t 前 60 分钟，±50 put 净主动成交额 (买−卖)/(买+卖)，按 price×size", "按金额而非张数的 put 需求"),
    "nprem_call_50_60": ("同上，call", "同上"),
    "vol_accel": ("t 前 60 分钟每分钟张数 / 开盘至 t 每分钟张数", "成交活跃度的加速"),
    "straddle_imb": ("t 时刻 ATM call 与 put 的 (bid_size−ask_size)/(bid_size+ask_size) 之和 / 2（chain 快照）", "ATM 跨式报价簿失衡"),
    "straddle_spread_rel": ("t 时刻 ATM call+put 点差之和 / 中间价之和（chain 快照）", "ATM 跨式相对点差（流动性）"),
}


def _net(df):
    b, s = df.loc[df.side == 1, "size"].sum(), df.loc[df.side == -1, "size"].sum()
    return (b - s) / (b + s) if b + s > 0 else np.nan


def _net_signed(df):
    return (df["size"] * df.side).sum()


def _hhi(df):
    v = df.groupby("strike")["size"].sum()
    tot = v.sum()
    return float(((v / tot) ** 2).sum()) if tot > 0 else np.nan


def _eff(df):
    if len(df) == 0 or df["size"].sum() == 0:
        return np.nan
    return float(np.average(df.eff, weights=df["size"]))


def _nprem(df):
    prem = df.price * df["size"]
    b, s = prem[df.side == 1].sum(), prem[df.side == -1].sum()
    return (b - s) / (b + s) if b + s > 0 else np.nan


def _features(x, t, spot):
    """x: all non-combo trades of the day (ts < t applied here). t: entry Timestamp, spot: spot at t."""
    d = x[x.ts < t]
    out = {}
    if len(d) < 100:
        return out
    dist = (d.strike - spot).abs()
    w60, w30 = d[d.ts >= t - pd.Timedelta(minutes=60)], d[d.ts >= t - pd.Timedelta(minutes=30)]
    p30 = d[(d.ts >= t - pd.Timedelta(minutes=60)) & (d.ts < t - pd.Timedelta(minutes=30))]
    w120 = d[d.ts >= t - pd.Timedelta(minutes=120)]
    p60 = d[(d.ts >= t - pd.Timedelta(minutes=120)) & (d.ts < t - pd.Timedelta(minutes=60))]
    call, put = d.right == "CALL", d.right == "PUT"
    out["nf_call_25_day"] = _net(d[call & (dist <= 25)])
    out["nf_put_25_day"] = _net(d[put & (dist <= 25)])
    out["nf_call_50_day"] = _net(d[call & (dist <= 50)])
    out["nf_put_50_day"] = _net(d[put & (dist <= 50)])
    d60 = (w60.strike - spot).abs()
    out["nf_call_25_60"] = _net(w60[(w60.right == "CALL") & (d60 <= 25)])
    out["nf_put_25_60"] = _net(w60[(w60.right == "PUT") & (d60 <= 25)])
    out["nf_all_60"] = _net(w60)
    v60, v120 = w60["size"].sum(), w120["size"].sum()
    out["accel30"] = (_net_signed(w30) - _net_signed(p30)) / v60 if v60 > 0 else np.nan
    out["accel60"] = (_net_signed(w60) - _net_signed(p60)) / v120 if v120 > 0 else np.nan
    vol = d["size"].sum()
    big50, big100 = d[d["size"] >= 50], d[d["size"] >= 100]
    out["big50_share_day"] = big50["size"].sum() / vol
    out["big100_share_day"] = big100["size"].sum() / vol
    out["big50_net_day"] = _net(big50)
    out["big50_net_60"] = _net(w60[w60["size"] >= 50])
    out["frag_day"] = len(d) / vol
    out["frag_60"] = len(w60) / v60 if v60 > 0 else np.nan
    out["hhi_day"] = _hhi(d)
    out["hhi_60"] = _hhi(w60)
    near, near60 = d[dist <= 100], w60[d60 <= 100]
    out["centroid_day"] = np.average(near.strike, weights=near["size"]) - spot if near["size"].sum() > 0 else np.nan
    out["centroid_60"] = np.average(near60.strike, weights=near60["size"]) - spot if near60["size"].sum() > 0 else np.nan
    pc60 = w60.loc[w60.right == "PUT", "size"].sum() / max(w60.loc[w60.right == "CALL", "size"].sum(), 1)
    pcday = d.loc[put, "size"].sum() / max(d.loc[call, "size"].sum(), 1)
    out["pc_ratio_60"] = pc60
    out["pc_ratio_chg"] = pc60 / pcday if pcday > 0 else np.nan
    c60 = w60[w60.side != 0]
    out["eff_60"] = _eff(c60)
    out["eff_call_60"] = _eff(c60[c60.right == "CALL"])
    out["eff_put_60"] = _eff(c60[c60.right == "PUT"])
    q = w60[w60.qok]
    out["eff_abs_60"] = float(np.average(2 * (q.price - q.mid).abs(), weights=q["size"])) if q["size"].sum() > 0 else np.nan
    out["nprem_put_50_60"] = _nprem(w60[(w60.right == "PUT") & (d60 <= 50)])
    out["nprem_call_50_60"] = _nprem(w60[(w60.right == "CALL") & (d60 <= 50)])
    mins_open = (t - t.normalize() - pd.Timedelta(hours=9, minutes=30)).total_seconds() / 60
    out["vol_accel"] = (v60 / 60) / (vol / mins_open) if vol > 0 else np.nan
    out["n_trades_day"] = len(d)
    out["vol_day"] = vol
    return out


def _straddle(date, t, K):
    f = os.path.join(CLEAN, f"chain_{date:%Y%m%d}.parquet")
    if not os.path.exists(f):
        return {}
    c = pd.read_parquet(f, filters=[("ts", "==", t), ("strike", "==", float(K))])
    c = c[~c.flag_bad]
    if len(c) < 2 or (c.bid_size + c.ask_size).min() <= 0 or c.mid.sum() <= 0:
        return {}
    imb = ((c.bid_size - c.ask_size) / (c.bid_size + c.ask_size)).mean()
    return {"straddle_imb": float(imb), "straddle_spread_rel": float(c.spread.sum() / c.mid.sum())}


def day_features(job):
    date, spots, Ks = job
    f = os.path.join(RAW, f"{date:%Y}", f"{date:%Y%m%d}.csv.gz")
    if not os.path.exists(f):
        return None
    try:
        x = pd.read_csv(f, usecols=USECOLS, dtype={"right": "str"})
    except Exception as e:  # noqa: BLE001
        return {"date": date, "error": repr(e)}
    n_all = len(x)
    combo = x.condition.isin(COMBO)
    x = x[~combo].copy()
    x["ts"] = pd.to_datetime(x.trade_timestamp, format="%Y-%m-%dT%H:%M:%S.%f")
    x["qok"] = (x.ask > 0) & (x.bid < x.ask)
    x["side"] = np.select([x.qok & (x.price >= x.ask), x.qok & (x.price <= x.bid)], [1, -1], 0)
    x["mid"] = (x.bid + x.ask) / 2
    half = (x.ask - x.bid) / 2
    x["eff"] = np.where(half > 0, (x.price - x.mid) / half, np.nan)
    rows = []
    for e in ENTRIES:
        t = pd.Timestamp(f"{date:%Y-%m-%d} {e}")
        spot = spots.get(e)
        if spot is None or np.isnan(spot):
            continue
        feats = _features(x, t, spot)
        if not feats:
            continue
        feats.update(_straddle(date, t, Ks.get(e)))
        feats.update({"date": date, "entry": e, "spot_t": spot, "n_raw": n_all, "share_combo": combo.mean(),
                      "share_buy": (x.side == 1).mean(), "share_sell": (x.side == -1).mean(),
                      "share_noquote": (~x.qok).mean()})
        rows.append(feats)
    return rows


def build(workers):
    os.makedirs(TABLES, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    panel = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    kmap = panel[(panel.structure == "put_fly") & (panel.width == 25)].set_index(["date", "entry"]).K
    files = sorted(glob.glob(os.path.join(RAW, "*", "*.csv.gz")))
    dates = [pd.Timestamp(os.path.basename(f)[:8]) for f in files]
    jobs = []
    skipped = []
    for d in dates:
        if d not in cal.index or cal.loc[d, "half_day"]:
            skipped.append((d, "half_day/not in calendar"))
            continue
        spots = {e: spot.get(pd.Timestamp(f"{d:%Y-%m-%d} {e}"), np.nan) for e in ENTRIES}
        Ks = {e: kmap.get((d, e), np.nan) for e in ENTRIES}
        jobs.append((d, spots, Ks))
    rows, errors = [], []
    with ProcessPoolExecutor(workers) as ex:
        for res in ex.map(day_features, jobs, chunksize=4):
            if res is None:
                continue
            if isinstance(res, dict):
                errors.append(res)
                continue
            rows.extend(res)
    f = pd.DataFrame(rows)
    # +60 min spot move (signed points); known only after entry -> target, not a factor
    f["spot_t60"] = [spot.get(pd.Timestamp(f"{d:%Y-%m-%d} {e}") + pd.Timedelta(minutes=60), np.nan) for d, e in zip(f.date, f.entry)]
    f["ret60"] = f.spot_t60 - f.spot_t
    f.to_parquet(FEAT, index=False)
    meta = pd.DataFrame({"n_files": [len(files)], "n_days_used": [f.date.nunique()], "n_rows": [len(f)],
                         "skipped_half_or_missing": [len(skipped)], "read_errors": [len(errors)],
                         "first": [f.date.min()], "last": [f.date.max()]})
    os.makedirs(TABLES, exist_ok=True)
    meta.to_csv(os.path.join(TABLES, "build_meta.csv"), index=False)
    pd.DataFrame(skipped, columns=["date", "why"]).to_csv(os.path.join(TABLES, "build_skipped.csv"), index=False)
    print(meta.to_string(index=False))
    if errors:
        print("errors:", errors[:5])
    return f


# ----------------------------------------------------------------------------------------------------- screen
def load():
    f = pd.read_parquet(FEAT)
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[(p.structure == "put_fly") & p.width.isin(WIDTHS) & p.entry.isin(ENTRIES)]
    d = p.merge(f, on=["date", "entry"], how="inner")
    d["test"] = d.date >= SPLIT
    d["year"] = d.date.dt.year
    d["absret60_over_implied"] = d.ret60.abs() / d.implied
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    d["spx_ret_prev"] = d.date.map(cal.spx_ret_prev)
    return d, f


def _cuts(tr, col):
    c = np.unique(np.quantile(tr[col], [0, .2, .4, .6, .8, 1]))
    c[0], c[-1] = -np.inf, np.inf
    return c


def quintile_screen(d, target, cont=False):
    """Per-entry train quintile cuts; Q1 / Q5 mean of target in train and test. cont=True -> target is continuous
    (mean reported, 'holds' = same sign and |rho_test| >= 0.1 with p < 0.05)."""
    rows = []
    for col in FACTORS:
        x = d[[col, target, "test", "entry"]].dropna()
        tr, te = x[~x.test], x[x.test]
        if len(tr) < 100 or len(te) < 100 or x[col].nunique() < 10:
            continue
        qtr, qte = [], []
        for e in ENTRIES:
            a, b = tr[tr.entry == e], te[te.entry == e]
            if len(a) < 20:
                continue
            c = _cuts(a, col)
            qtr.append(pd.Series(pd.cut(a[col], c, labels=False, include_lowest=True), index=a.index))
            qte.append(pd.Series(pd.cut(b[col], c, labels=False, include_lowest=True), index=b.index))
        qtr, qte = pd.concat(qtr), pd.concat(qte)
        g_tr = tr[target].groupby(qtr).mean()
        g_te = te[target].groupby(qte).mean()
        n_te = te.groupby(qte).size()
        drift = n_te.max() / n_te.sum()          # share of test rows falling in a single train quintile (0.2 = no drift)
        r_imp = spearmanr(tr[col], d.loc[tr.index, "implied"]).statistic
        r_tr = spearmanr(tr[col], tr[target])
        r_te = spearmanr(te[col], te[target])
        gap_tr, gap_te = g_tr.get(4, np.nan) - g_tr.get(0, np.nan), g_te.get(4, np.nan) - g_te.get(0, np.nan)
        if cont:
            holds = bool(np.sign(r_tr.statistic) == np.sign(r_te.statistic) and abs(r_te.statistic) >= 0.1 and r_te.pvalue < 0.05
                         and r_tr.pvalue < 0.05)
        else:
            holds = bool(np.sign(gap_tr) == np.sign(gap_te) and abs(gap_tr) >= 0.05 and abs(gap_te) >= 0.05)
        holds = holds and n_te.min() >= MIN_Q_N   # a quintile that is nearly empty in test means the factor's level drifted, not a signal
        rows.append({"factor": col, "n_train": len(tr), "n_test": len(te), "train_Q1": g_tr.get(0), "train_Q5": g_tr.get(4),
                     "train_gap": gap_tr, "test_Q1": g_te.get(0), "test_Q5": g_te.get(4), "test_gap": gap_te,
                     "test_min_n": n_te.min(), "drift": drift, "rho_implied_train": r_imp, "rho_train": r_tr.statistic, "p_train": r_tr.pvalue,
                     "rho_test": r_te.statistic, "p_test": r_te.pvalue, "holds": holds})
    return pd.DataFrame(rows).sort_values("test_gap", key=abs, ascending=False)


def _median_split(d, col):
    """High/low by train median within each entry (train only)."""
    med = d[~d.test].groupby("entry")[col].median()
    return np.where(d[col] >= d.entry.map(med), "high", "low")


def control_implied(d, cols):
    """w_over_implied train tertiles; within each, win rate of high vs low factor (train median) in both periods."""
    rows = []
    tert = np.quantile(d.loc[~d.test, "w_over_implied"], [1 / 3, 2 / 3])
    d = d.assign(w_t=pd.cut(d.w_over_implied, [-np.inf, *tert, np.inf], labels=["窄", "中", "宽"]))
    for col in cols:
        x = d.dropna(subset=[col]).copy()
        x["hl"] = _median_split(x, col)
        for per, sub in [("train", x[~x.test]), ("test", x[x.test])]:
            for wt, g in sub.groupby("w_t", observed=True):
                hi, lo = g[g.hl == "high"], g[g.hl == "low"]
                rows.append({"factor": col, "period": per, "w_over_implied": wt, "n_low": len(lo), "n_high": len(hi),
                             "win_low": lo.win.mean(), "win_high": hi.win.mean(), "gap": hi.win.mean() - lo.win.mean(),
                             "ev_low": lo.pnl.mean(), "ev_high": hi.pnl.mean()})
    return pd.DataFrame(rows)


def by_year(d, cols):
    rows = []
    for col in cols:
        x = d.dropna(subset=[col]).copy()
        x["hl"] = _median_split(x, col)
        for y, g in x.groupby("year"):
            hi, lo = g[g.hl == "high"], g[g.hl == "low"]
            rows.append({"factor": col, "year": y, "n_low": len(lo), "n_high": len(hi), "win_low": lo.win.mean(),
                         "win_high": hi.win.mean(), "gap": hi.win.mean() - lo.win.mean(), "ev_low": lo.pnl.mean(), "ev_high": hi.pnl.mean()})
    return pd.DataFrame(rows)


def baseline(f):
    """BRIEF rule: 14:00 entry, width whose w_over_implied is closest to 2 (one per day), skip spx_ret_prev <= -1%."""
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[(p.structure == "put_fly") & (p.entry == "14:00") & p.width.isin(BASE_WIDTHS)].copy()
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    p["half"] = p.date.map(cal.half_day)
    p["spx_ret_prev"] = p.date.map(cal.spx_ret_prev)
    p = p[~p.half & (p.spx_ret_prev > -0.01)]
    p["d2"] = (p.w_over_implied - 2).abs()
    p = p.sort_values("d2").groupby("date").head(1)
    b = p.merge(f[f.entry == "14:00"], on=["date", "entry"], how="inner")
    b["test"] = b.date >= SPLIT
    return b


def incremental(b, screen_rows):
    """Overlay: keep days whose factor is NOT in the two unfavourable training quintiles (favourable side = sign of the
    training gap in the quintile screen). Thresholds from the 14:00 training rows of the baseline set."""
    rows = []
    for per, sub in [("train", b[~b.test]), ("test", b[b.test])]:
        s = stats(sub)
        rows.append({"factor": "基准", "period": per, "rule": "baseline", **s.to_dict()})
    for _, r in screen_rows.iterrows():
        col = r.factor
        x = b.dropna(subset=[col])
        tr = x[~x.test]
        q = np.quantile(tr[col], [.2, .4, .6, .8])
        if r.train_gap > 0:
            keep = x[col] > q[1]      # drop Q1, Q2
            rule = f"{col} > train 40% 分位 ({q[1]:.4g})"
        else:
            keep = x[col] < q[2]      # drop Q4, Q5
            rule = f"{col} < train 60% 分位 ({q[2]:.4g})"
        for per, sub in [("train", x[~x.test & keep]), ("test", x[x.test & keep])]:
            s = stats(sub)
            rows.append({"factor": col, "period": per, "rule": rule, **s.to_dict()})
    out = pd.DataFrame(rows)
    base = out[out.factor == "基准"].set_index("period")
    out["d_win_vs_base"] = out.win.values - base.loc[out.period, "win"].values
    out["d_ev_vs_base"] = out.ev.values - base.loc[out.period, "ev"].values
    return out


def quintile_curves(d, cols):
    """Per-entry, per-period win / ev / ret60 by train quintile, for the factors that pass the win screen."""
    rows = []
    for col in cols:
        for e in ENTRIES:
            a = d[d.entry == e].dropna(subset=[col])
            c = _cuts(a[~a.test], col)
            a = a.assign(q=pd.cut(a[col], c, labels=False, include_lowest=True))
            for per, sub in [("train", a[~a.test]), ("test", a[a.test])]:
                g = sub.groupby("q").agg(n=("win", "size"), win=("win", "mean"), ev=("pnl", "mean"), ret60=("ret60", "mean"),
                                         absret60_over_implied=("absret60_over_implied", "mean"))
                for q, r in g.iterrows():
                    rows.append({"factor": col, "entry": e, "period": per, "quintile": int(q) + 1, **r.to_dict()})
    return pd.DataFrame(rows)


def screen():
    os.makedirs(TABLES, exist_ok=True)
    d, f = load()
    pd.set_option("display.width", 250)
    lines = []
    tr_days, te_days = d[~d.test].date.nunique(), d[d.test].date.nunique()
    lines.append(f"样本：{d.date.min():%Y-%m-%d} → {d.date.max():%Y-%m-%d}，训练 {tr_days} 天 / 测试 {te_days} 天，"
                 f"面板行数（日×入场×翅宽）训练 {int((~d.test).sum())} / 测试 {int(d.test.sum())}")
    q = f[["share_combo", "share_buy", "share_sell", "share_noquote", "n_raw"]].describe().T
    q.to_csv(os.path.join(TABLES, "data_quality.csv"))
    lines.append("数据质量（每日×入场一行，描述统计）：\n" + q.round(4).to_string())

    sc_win = quintile_screen(d, "win")
    sc_pnl = quintile_screen(d, "pnl", cont=True)
    sc_ret = quintile_screen(d, "ret60", cont=True)
    sc_abs = quintile_screen(d, "absret60_over_implied", cont=True)
    for name, t in [("screen_win", sc_win), ("screen_pnl", sc_pnl), ("screen_ret60", sc_ret), ("screen_absret60", sc_abs)]:
        t.round(4).to_csv(os.path.join(TABLES, f"{name}.csv"), index=False)
    lines.append("\n## 单变量筛查：目标 win（五分位，训练切点按入场分别定）\n" + sc_win.round(3).to_string(index=False))
    lines.append("\n## 单变量筛查：目标 pnl（美元均值）\n" + sc_pnl.round(3).to_string(index=False))
    lines.append("\n## 单变量筛查：目标 入场后 60 分钟现货变动（点，带方向）\n" + sc_ret.round(3).to_string(index=False))
    lines.append("\n## 单变量筛查：目标 |60 分钟变动| / implied\n" + sc_abs.round(3).to_string(index=False))

    holds_win = sc_win[sc_win.holds].factor.tolist()
    # also take the win-screen factors that pass a looser bar for the extra checks, so the report can show why they fail
    near = sc_win[(np.sign(sc_win.train_gap) == np.sign(sc_win.test_gap)) & (sc_win.test_gap.abs() >= 0.03) & (sc_win.train_gap.abs() >= 0.03)].factor.tolist()
    cand = list(dict.fromkeys(holds_win + near))
    lines.append(f"\nwin 成立（两期同号且 |gap|≥5pp）：{holds_win}\n放宽到 3pp 的候选：{near}")

    b = baseline(f)
    lines.append(f"\n基准集合：训练 {int((~b.test).sum())} 天 / 测试 {int(b.test.sum())} 天")
    inc = incremental(b, sc_win[sc_win.factor.isin(cand)]) if cand else incremental(b, sc_win.iloc[0:0])
    inc.round(4).to_csv(os.path.join(TABLES, "incremental.csv"), index=False)
    lines.append("\n## 增量检验（基准 + 因子，训练期阈值）\n" + inc[["factor", "period", "rule", "n", "win", "win_lo", "win_hi", "ev", "ev_k05", "d_win_vs_base", "d_ev_vs_base"]].round(3).to_string(index=False))
    # incremental for ALL factors too (counted in the multiple-comparison account, filed as a table)
    inc_all = incremental(b, sc_win)
    inc_all.round(4).to_csv(os.path.join(TABLES, "incremental_all.csv"), index=False)
    ok = inc_all[(inc_all.factor != "基准")].pivot(index="factor", columns="period", values="d_win_vs_base")
    nn = inc_all[(inc_all.factor != "基准")].pivot(index="factor", columns="period", values="n")
    ok["n_train"], ok["n_test"] = nn.train, nn.test
    dev = inc_all[(inc_all.factor != "基准")].pivot(index="factor", columns="period", values="d_ev_vs_base")
    ok["d_ev_train"], ok["d_ev_test"] = dev.train, dev.test
    ok["passes"] = (ok.train > 0) & (ok.test >= 0.03) & (ok.n_train >= MIN_INC_N) & (ok.n_test >= MIN_INC_N)
    lines.append("\n## 增量检验：全部因子（Δ胜率 / Δ期望 vs 基准）\n" + ok.round(3).sort_values("test", ascending=False).to_string())

    if cand:
        ci = control_implied(d, cand)
        ci.round(4).to_csv(os.path.join(TABLES, "control_implied.csv"), index=False)
        lines.append("\n## 控制隐含（w_over_implied 训练三分位 × 因子高低，训练中位数）\n" + ci.round(3).to_string(index=False))
        yy = by_year(d, cand)
        yy.round(4).to_csv(os.path.join(TABLES, "by_year.csv"), index=False)
        lines.append("\n## 分年\n" + yy.round(3).to_string(index=False))
        qc = quintile_curves(d, holds_win)
        qc.round(3).to_csv(os.path.join(TABLES, "quintile_curves.csv"), index=False)
        lines.append("\n## 成立因子的五分位曲线（按入场）\n" + qc.pivot_table(index=["factor", "entry", "quintile"], columns="period", values=["n", "win", "ev"]).round(3).to_string())

    n_fac = len(FACTORS)
    n_tests = len(sc_win) + len(sc_pnl) + len(sc_ret) + len(sc_abs) + (len(inc_all) // 2 - 1)
    lines.append(f"\n## 多重比较\n因子 {n_fac} 个，目标 4 个（win, pnl, ret60, |ret60|/implied），单变量检验 {len(sc_win)+len(sc_pnl)+len(sc_ret)+len(sc_abs)} 次，"
                 f"增量检验 {len(inc_all)//2-1} 次，合计 {n_tests} 次；5% 水平下预期假阳性约 {n_tests*0.05:.1f} 个。"
                 f"\n单变量 win 成立 {len(holds_win)} 个；pnl 成立 {int(sc_pnl.holds.sum())}；ret60 成立 {int(sc_ret.holds.sum())}；|ret60|/implied 成立 {int(sc_abs.holds.sum())}；"
                 f"增量通过（两期同号、测试 ≥ +3pp、两期各 ≥ {MIN_INC_N} 天）{int(ok.passes.sum())} 个：{ok[ok.passes].index.tolist()}")
    txt = "\n".join(lines)
    open(os.path.join(TABLES, "summary.md"), "w").write(txt)
    print(txt)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["build", "screen", "all"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    if x.cmd in ("build", "all"):
        build(x.workers)
    if x.cmd in ("screen", "all"):
        screen()
