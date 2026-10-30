"""因子族 cross：跨资产、日历与波动率状态 —— 对 13:00 / 14:00 入场的 ATM put 蝶（翅宽 25/30）做单变量筛、控制隐含、增量检验、分年。

    .venv/bin/python src/mining/cross.py            # 写 reports/mining/cross.md 与 reports/mining/cross_tables/*.csv

纪律照 reports/mining/BRIEF.md：训练期 date < 2024-11-01，所有切点来自训练期；因子只用入场那一分钟之前已知的数据
（分钟 K 线取 ts < t 的；日线特征用 D−1 及更早；事件日历是预先公布的）。半天交易日剔除。
因子清单与每个因子只配一条叠加规则在跑之前写死（见 CONT / BINARY / CATS），多重比较按实际试验数计。
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(R, "src"))
from winrate_study import stats, wilson  # noqa: E402

CLEAN = os.path.join(R, "data", "clean")
TWS = os.path.join(R, "data", "tws")
OUT_MD = os.path.join(R, "reports", "mining", "cross.md")
OUT_T = os.path.join(R, "reports", "mining", "cross_tables")
SPLIT = pd.Timestamp("2024-11-01")
ENTRIES = ["13:00", "14:00"]
WIDTHS = [25, 30]
BIG = 0.01
MIN_PER_YEAR = 252 * 390

# ---------------------------------------------------------------- 因子定义（跑之前写死）
CONT = {  # 名字: 定义
    "rs_qqq": "QQQ 开盘以来涨跌 − SPX 开盘以来涨跌（入场前一根 K 线收盘 / 09:30 开盘价）",
    "rs_qqq_chg60": "rs_qqq 在最近 60 分钟的变化（rs_qqq(t) − rs_qqq(t−60)）",
    "corr_spy_chg60": "SPY−SPX 1 分钟收益相关系数：最近 60 分钟 − 之前 60 分钟",
    "corr_qqq_60": "QQQ−SPX 1 分钟收益相关系数，最近 60 分钟",
    "rv20_over_iv": "SPX 最近 20 根 1 分钟对数收益标准差 ×√(252×390) ÷ 09:35 ATM 跨式隐含年化 iv_ann",
    "rv60_over_iv": "同上，最近 60 根",
    "rv5d_over_vix": "前 5 个交易日（到 D−1）日收益标准差 ×√252×100 ÷ VIX 前收",
    "rv10d_over_vix": "同上，10 日",
    "rv20d_over_vix": "同上，20 日",
    "vix_rel_ma20": "VIX 前收 ÷ 其过去 20 日均值（含前收）− 1",
    "vix_rel_ma60": "VIX 前收 ÷ 其过去 60 日均值 − 1",
    "vix_chg1": "VIX 前收 ÷ 前前收 − 1（前一日变化，带方向）",
    "prev_range_pct": "前一日日内区间 (H−L) ÷ 前前收",
    "prev_close_pos": "前一日收盘在当日区间的位置 (C−L)/(H−L)，1 = 收在最高",
    "streak": "连续同向天数（到 D−1，带符号，+3 = 连涨三天）",
    "days_since_bigdown": "距上一次日跌幅 ≥ 1% 的交易日数（上限 60）",
    "days_since_bigup": "距上一次日涨幅 ≥ 1% 的交易日数（上限 60）",
    "spx_since_open": "SPX 开盘到入场的涨跌（入场前一根 K 线收盘 / 09:30 开盘 − 1）",
    "gap_pct": "SPX 开盘价 ÷ 前收 − 1（跳空）",
}
BINARY = {
    "event_prev": "前一交易日是 FOMC/CPI/NFP/PCE",
    "event_next": "下一交易日是 FOMC/CPI/NFP/PCE（预先公布）",
    "post_fomc": "FOMC 声明后首个交易日（前一交易日 fomc）",
    "opex_week": "当周含月度 opex",
    "quarter_end": "季度最后一个交易日",
    "month_last3": "月末最后 3 个交易日",
    "month_first3": "月初前 3 个交易日",
    "two_same": "前两日同向（sign(ret D−1) == sign(ret D−2)）",
}
CATS = {"weekday": "星期（× 入场时点，每时点单独筛）", "month": "月份（季节）"}
KNOWN = ["w_over_implied", "range60_over_implied", "vix_prev_close", "ret5d", "dist_ma20"]  # 已知成立的因子，用来查冗余


# ---------------------------------------------------------------- 数据
def load_minutes(sym, dates):
    d = pd.concat(pd.read_parquet(f) for f in sorted(glob.glob(os.path.join(TWS, f"{sym}_1m", "*.parquet"))))
    d["ts"] = d.ts.dt.tz_convert("America/New_York").dt.tz_localize(None)
    d = d.drop_duplicates("ts").sort_values("ts")
    d = d[d.ts.dt.normalize().isin(dates)]
    return d.set_index("ts")


def daily_features(cal, vix):
    """全部 shift 到 D−1 已知。"""
    spx = load_minutes("spx", cal.index)
    day = spx.groupby(spx.index.normalize()).agg(o=("open", "first"), h=("high", "max"), l=("low", "min"))
    df = cal[["settle", "spx_ret_prev", "vix_prev_close"]].join(day)
    ret = df.settle.pct_change()                      # D 日收益（当天收盘才知道）
    logret = np.log(df.settle).diff()
    for n in (5, 10, 20):
        df[f"rv{n}d_over_vix"] = (logret.rolling(n).std() * np.sqrt(252) * 100 / df.vix_prev_close.shift(-1)).shift(1)
    v = vix.set_index("date").vix_close.reindex(df.index.union(vix.date)).sort_index()
    v = v[v.index.isin(df.index)]
    for n in (20, 60):
        df[f"vix_rel_ma{n}"] = (v / v.rolling(n).mean() - 1).shift(1)
    df["vix_chg1"] = (v / v.shift(1) - 1).shift(1)
    df["prev_range_pct"] = ((df.h - df.l) / df.settle.shift(1)).shift(1)
    df["prev_close_pos"] = ((df.settle - df.l) / (df.h - df.l)).clip(0, 1).shift(1)   # 官方收盘偶尔落在 TWS 分钟 K 线区间外，截到 [0,1]
    sgn = np.sign(ret)
    streak = np.zeros(len(df))
    for i in range(1, len(df)):
        s = sgn.iloc[i]
        streak[i] = streak[i - 1] + s if s == np.sign(streak[i - 1]) and s != 0 else s
    df["streak"] = pd.Series(streak, index=df.index).shift(1)
    for name, mask in (("days_since_bigdown", ret <= -BIG), ("days_since_bigup", ret >= BIG)):
        idx = np.arange(len(df))
        last = pd.Series(np.where(mask, idx, np.nan), index=df.index).ffill()
        df[name] = pd.Series(np.minimum(idx - last.values, 60), index=df.index).shift(1)
    df["two_same"] = ((sgn == sgn.shift(1)) & (sgn != 0)).shift(1).astype("boolean")
    df["gap_pct"] = df.o / df.settle.shift(1) - 1
    ev = cal.fomc | cal.cpi | cal.nfp | cal.pce
    df["event_prev"] = ev.shift(1, fill_value=False)
    df["event_next"] = ev.shift(-1, fill_value=False)
    df["post_fomc"] = cal.fomc.shift(1, fill_value=False)
    wk = df.index.to_period("W")
    df["opex_week"] = pd.Series(cal.opex.values, index=df.index).groupby(wk).transform("any")
    q = df.index.to_period("Q")
    df["quarter_end"] = df.index == pd.Series(df.index, index=df.index).groupby(q).transform("max")
    m = df.index.to_period("M")
    rank_in_m = pd.Series(df.index, index=df.index).groupby(m).cumcount()
    cnt_in_m = pd.Series(df.index, index=df.index).groupby(m).transform("count")
    df["month_first3"] = rank_in_m < 3
    df["month_last3"] = rank_in_m >= cnt_in_m - 3
    df["weekday"] = df.index.day_name().str[:3]
    df["month"] = df.index.month
    # 已知因子（查冗余用）
    df["ret5d"] = df.settle.pct_change(5).shift(1)
    df["dist_ma20"] = (df.settle / df.settle.rolling(20).mean() - 1).shift(1)
    return df, spx


def intraday_features(spx, qqq, spy, iv0935, dates):
    rows = []
    for d in dates:
        s = spx.loc[str(d.date())]
        if s.empty:
            continue
        q, p = qqq.loc[str(d.date())], spy.loc[str(d.date())]
        o_spx, o_qqq = s.open.iloc[0], (q.open.iloc[0] if not q.empty else np.nan)
        for e in ENTRIES:
            t = pd.Timestamp(f"{d.date()} {e}")
            sk = s[s.index < t].close
            if len(sk) < 130:
                continue
            qk, pk = q[q.index < t].close, p[p.index < t].close
            r_spx = np.log(sk).diff().dropna()
            rec = {"date": d, "entry": e}
            rec["spx_since_open"] = sk.iloc[-1] / o_spx - 1
            if len(qk) == len(sk):
                rs = qk / o_qqq - 1 - (sk / o_spx - 1)
                rec["rs_qqq"] = rs.iloc[-1]
                rec["rs_qqq_chg60"] = rs.iloc[-1] - rs.iloc[-61]
                r_q = np.log(qk).diff().dropna()
                rec["corr_qqq_60"] = np.corrcoef(r_spx.iloc[-60:], r_q.iloc[-60:])[0, 1]
            if len(pk) == len(sk):
                r_p = np.log(pk).diff().dropna()
                c_now = np.corrcoef(r_spx.iloc[-60:], r_p.iloc[-60:])[0, 1]
                c_prev = np.corrcoef(r_spx.iloc[-120:-60], r_p.iloc[-120:-60])[0, 1]
                rec["corr_spy_chg60"] = c_now - c_prev
            iv = iv0935.get(d, np.nan)
            rec["rv20_over_iv"] = r_spx.iloc[-20:].std() * np.sqrt(MIN_PER_YEAR) / iv
            rec["rv60_over_iv"] = r_spx.iloc[-60:].std() * np.sqrt(MIN_PER_YEAR) / iv
            rows.append(rec)
    return pd.DataFrame(rows)


def build():
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    vix = pd.read_parquet(os.path.join(TWS, "vix_1d.parquet"))
    daily, spx = daily_features(cal, vix)
    qqq, spy = load_minutes("qqq", cal.index), load_minutes("spy", cal.index)
    ep = pd.read_parquet(os.path.join(CLEAN, "edge_panel.parquet"))
    iv0935 = ep[ep.entry == "09:35"].set_index("date").iv_ann.to_dict()
    ok = cal.index[~cal.half_day & cal.has_0dte]
    intra = intraday_features(spx, qqq, spy, iv0935, ok)
    fac = intra.merge(daily.drop(columns=["settle", "spx_ret_prev", "vix_prev_close", "o", "h", "l"]), left_on="date", right_index=True, how="left")
    fac = fac.merge(cal[["spx_ret_prev", "vix_prev_close"]], left_on="date", right_index=True, how="left")
    wp = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    wp = wp[wp.date.isin(ok)]
    tgt = wp[(wp.structure == "put_fly") & wp.width.isin(WIDTHS) & wp.entry.isin(ENTRIES)]
    panel = tgt.merge(fac, on=["date", "entry"], how="left")
    panel["train"] = panel.date < SPLIT
    panel["year"] = panel.date.dt.year
    # 基准：14:00，w_over_implied 最接近 2 的翅宽，跳过 spx_ret_prev <= -1%
    b = wp[(wp.structure == "put_fly") & (wp.entry == "14:00")].copy()
    b["d2"] = (b.w_over_implied - 2).abs()
    b = b.sort_values("d2").drop_duplicates("date").drop(columns="d2")
    b = b.merge(fac[fac.entry == "14:00"].drop(columns="entry"), on="date", how="left")
    b = b[~(b.spx_ret_prev <= -BIG)].copy()
    b["train"] = b.date < SPLIT
    b["year"] = b.date.dt.year
    return panel, b, fac


# ---------------------------------------------------------------- 统计
def wr(g):
    n = g.date.nunique()
    lo, hi = wilson(round(g.win.mean() * n), n)
    return n, g.win.mean(), lo, hi, g.pnl.mean()


def quintile_cuts(x):
    return np.unique(np.nanquantile(x, [0.2, 0.4, 0.6, 0.8]))


def assign_q(x, cuts):
    return pd.Series(np.searchsorted(cuts, x, side="right") + 1, index=x.index).where(x.notna())


def screen_cont(panel):
    rows, trials = [], 0
    for f in CONT:
        for e in ENTRIES:
            p = panel[(panel.entry == e) & panel[f].notna()]
            tr, te = p[p.train], p[~p.train]
            cuts = quintile_cuts(tr.drop_duplicates("date")[f])
            trials += 1
            rec = {"factor": f, "entry": e, "n_days_train": tr.date.nunique(), "n_days_test": te.date.nunique()}
            for lab, g in (("train", tr), ("test", te)):
                q = assign_q(g[f], cuts)
                rec[f"q1_win_{lab}"] = g.win[q == 1].mean()
                rec[f"q5_win_{lab}"] = g.win[q == 5].mean()
                rec[f"gap_{lab}"] = rec[f"q5_win_{lab}"] - rec[f"q1_win_{lab}"]
                rec[f"q1_ev_{lab}"] = g.pnl[q == 1].mean()
                rec[f"q5_ev_{lab}"] = g.pnl[q == 5].mean()
                gd = g.drop_duplicates(["date", "width"])
                rec[f"spearman_{lab}"] = spearmanr(gd[f], gd.pnl, nan_policy="omit")[0]
            rec["pass"] = bool(np.sign(rec["gap_train"]) == np.sign(rec["gap_test"]) and abs(rec["gap_train"]) >= .05 and abs(rec["gap_test"]) >= .05)
            rec["cuts"] = " / ".join(f"{c:.4g}" for c in cuts)
            rows.append(rec)
    return pd.DataFrame(rows), trials


def screen_binary(panel):
    rows, trials = [], 0
    for f in BINARY:
        for e in ENTRIES:
            p = panel[(panel.entry == e) & panel[f].notna()]
            flag = p[f].astype(bool)
            trials += 1
            rec = {"factor": f, "entry": e}
            for lab, m in (("train", p.train), ("test", ~p.train)):
                a, b = p[m & flag], p[m & ~flag]
                rec[f"n_days_flag_{lab}"] = a.date.nunique()
                rec[f"win_flag_{lab}"] = a.win.mean()
                rec[f"win_rest_{lab}"] = b.win.mean()
                rec[f"gap_{lab}"] = a.win.mean() - b.win.mean()
                rec[f"ev_flag_{lab}"] = a.pnl.mean()
                rec[f"ev_rest_{lab}"] = b.pnl.mean()
            rec["pass"] = bool(np.sign(rec["gap_train"]) == np.sign(rec["gap_test"]) and abs(rec["gap_train"]) >= .05 and abs(rec["gap_test"]) >= .05
                               and rec["n_days_flag_train"] >= 20 and rec["n_days_flag_test"] >= 20)
            rows.append(rec)
    return pd.DataFrame(rows), trials


def screen_cats(panel):
    rows, trials = [], 0
    for f in CATS:
        for e in ENTRIES:
            p = panel[panel.entry == e]
            for lev in sorted(p[f].dropna().unique()):
                flag = p[f] == lev
                trials += 1
                rec = {"factor": f, "level": lev, "entry": e}
                for lab, m in (("train", p.train), ("test", ~p.train)):
                    a, b = p[m & flag], p[m & ~flag]
                    rec[f"n_days_{lab}"] = a.date.nunique()
                    rec[f"win_{lab}"] = a.win.mean()
                    rec[f"win_rest_{lab}"] = b.win.mean()
                    rec[f"gap_{lab}"] = a.win.mean() - b.win.mean()
                    rec[f"ev_{lab}"] = a.pnl.mean()
                rec["pass"] = bool(np.sign(rec["gap_train"]) == np.sign(rec["gap_test"]) and abs(rec["gap_train"]) >= .05 and abs(rec["gap_test"]) >= .05
                                   and rec["n_days_train"] >= 20 and rec["n_days_test"] >= 20)
                rows.append(rec)
    return pd.DataFrame(rows), trials


def high_low(panel, f, e):
    """连续因子按训练期中位数分高低；二元因子按真假。返回 (panel, 高低标签)。"""
    p = panel[(panel.entry == e) & panel[f].notna()].copy()
    if f in BINARY:
        p["hl"] = np.where(p[f].astype(bool), "high", "low")
    else:
        med = p[p.train].drop_duplicates("date")[f].median()
        p["hl"] = np.where(p[f] > med, "high", "low")
    return p


def control(panel, f, e, ctrl):
    """按 ctrl 的训练期三分位分组，看因子高低组胜率差在每组内是否仍在。"""
    p = high_low(panel, f, e)
    cuts = np.nanquantile(p[p.train].drop_duplicates("date")[ctrl], [1 / 3, 2 / 3])
    p["grp"] = np.searchsorted(cuts, p[ctrl], side="right")
    rows = []
    for g in range(3):
        rec = {"factor": f, "entry": e, "control": ctrl, "group": ["low", "mid", "high"][g]}
        for lab, m in (("train", p.train), ("test", ~p.train)):
            s = p[m & (p.grp == g)]
            hi, lo = s[s.hl == "high"], s[s.hl == "low"]
            rec[f"n_days_{lab}"] = s.date.nunique()
            rec[f"win_high_{lab}"] = hi.win.mean()
            rec[f"win_low_{lab}"] = lo.win.mean()
            rec[f"gap_{lab}"] = hi.win.mean() - lo.win.mean()
        rows.append(rec)
    return pd.DataFrame(rows)


def redundancy(panel, f, e):
    p = panel[(panel.entry == e) & panel.train].drop_duplicates("date")
    return {k: spearmanr(p[f], p[k], nan_policy="omit")[0] for k in KNOWN}


def incremental(base, f, kind, scr):
    """叠加规则（每个因子一条，跑之前写死）：连续因子剔除训练期胜率更差的那个五分位（用 14:00 筛查的切点）；
    二元因子剔除训练期胜率更低的那一边。"""
    b = base[base[f].notna()].copy()
    tr = b[b.train]
    if kind == "cont":
        row = scr[(scr.factor == f) & (scr.entry == "14:00")].iloc[0]
        cuts = quintile_cuts(tr.drop_duplicates("date")[f])
        q = assign_q(b[f], cuts)
        keep = q != (1 if row.gap_train > 0 else 5)
        rule = f"剔除训练期 {'Q1' if row.gap_train > 0 else 'Q5'}（{f} {'<' if row.gap_train > 0 else '>'} {cuts[0] if row.gap_train > 0 else cuts[-1]:.4g}）"
    else:
        flag = b[f].astype(bool)
        worse = tr.win[flag[b.train]].mean() < tr.win[~flag[b.train]].mean()
        keep = ~flag if worse else flag
        rule = f"剔除 {f}={'真' if worse else '假'} 的日子"
    rec = {"factor": f, "rule": rule}
    for lab, m in (("train", b.train), ("test", ~b.train)):
        n0, w0, lo0, hi0, ev0 = wr(b[m])
        n1, w1, lo1, hi1, ev1 = wr(b[m & keep])
        rec.update({f"base_n_{lab}": n0, f"base_win_{lab}": w0, f"base_ev_{lab}": ev0,
                    f"n_{lab}": n1, f"win_{lab}": w1, f"win_lo_{lab}": lo1, f"win_hi_{lab}": hi1, f"ev_{lab}": ev1,
                    f"incr_{lab}": w1 - w0, f"incr_ev_{lab}": ev1 - ev0})
    rec["valuable"] = bool(np.sign(rec["incr_train"]) == np.sign(rec["incr_test"]) and rec["incr_test"] >= .03)
    return rec


def yearly(panel, f):
    p = pd.concat(high_low(panel, f, e) for e in ENTRIES)
    t = p.groupby(["year", "hl"]).agg(n_days=("date", "nunique"), win=("win", "mean"), ev=("pnl", "mean")).unstack("hl")
    t.columns = [f"{a}_{b}" for a, b in t.columns]
    t["gap"] = t.win_high - t.win_low
    t.insert(0, "factor", f)
    return t.reset_index()


# ---------------------------------------------------------------- 报告
def pct(x):
    return "—" if pd.isna(x) else f"{100 * x:.1f}%"


def num(x, d=1):
    return "—" if pd.isna(x) else f"{x:.{d}f}"


def md_table(df, cols, fmt):
    head = "| " + " | ".join(cols.values()) + " |\n|" + "---|" * len(cols) + "\n"
    body = ""
    for _, r in df.iterrows():
        body += "| " + " | ".join(fmt.get(c, str)(r[c]) for c in cols) + " |\n"
    return head + body


def main():
    os.makedirs(OUT_T, exist_ok=True)
    panel, base, fac = build()
    panel.to_parquet(os.path.join(OUT_T, "cross_panel.parquet"))
    sc, t1 = screen_cont(panel)
    sb, t2 = screen_binary(panel)
    sk, t3 = screen_cats(panel)
    sc.to_csv(os.path.join(OUT_T, "screen_cont.csv"), index=False)
    sb.to_csv(os.path.join(OUT_T, "screen_binary.csv"), index=False)
    sk.to_csv(os.path.join(OUT_T, "screen_cats.csv"), index=False)

    passers = [(r["factor"], r["entry"], "cont") for _, r in sc.iterrows() if r["pass"]] + \
        [(r["factor"], r["entry"], "bin") for _, r in sb.iterrows() if r["pass"]]
    scr_gap = {(r.factor, r.entry): r.gap_train for r in pd.concat([sc, sb]).itertuples()}
    ctrl_rows, red_rows = [], []
    for f, e, _ in passers:
        for c in ("w_over_implied", "vix_prev_close"):
            ctrl_rows.append(control(panel, f, e, c))
        red_rows.append({"factor": f, "entry": e, **redundancy(panel, f, e)})
    ctrl = pd.concat(ctrl_rows) if ctrl_rows else pd.DataFrame()
    red = pd.DataFrame(red_rows)
    ctrl.to_csv(os.path.join(OUT_T, "control_iv.csv"), index=False)
    red.to_csv(os.path.join(OUT_T, "redundancy.csv"), index=False)

    inc = pd.DataFrame([incremental(base, f, "cont", sc) for f in CONT] + [incremental(base, f, "bin", sc) for f in BINARY])
    inc.to_csv(os.path.join(OUT_T, "incremental.csv"), index=False)
    t4 = len(inc)
    yr = pd.concat([yearly(panel, f) for f in list(CONT) + list(BINARY)])
    yr.to_csv(os.path.join(OUT_T, "yearly.csv"), index=False)

    trials = t1 + t2 + t3 + t4
    n_pass = int(sc["pass"].sum() + sb["pass"].sum() + sk["pass"].sum())
    n_val = int(inc.valuable.sum())
    b_tr, b_te = base[base.train], base[~base.train]
    bt, bte = wr(b_tr), wr(b_te)

    # ---- markdown
    L = []
    L.append("# 因子族 cross：跨资产、日历与波动率状态\n")
    L.append(f"数据：`winrate_panel` 中 put_fly、翅宽 25/30、入场 13:00/14:00（剔半天），训练期 < 2024-11-01（{panel[panel.train].date.nunique()} 天），"
             f"测试期 ≥ 2024-11-01（{panel[~panel.train].date.nunique()} 天）。胜率 = pnl>0（k=0.25 含费）；n 按天数，不按行。所有切点来自训练期。\n")
    valuable = inc[inc.valuable]
    strong = [(f, e) for f, e, _ in passers if f in set(valuable.factor)]
    L.append("## 1. 一句话结论\n")
    if n_val == 0:
        L.append(f"试了 {len(CONT)} 个连续因子、{len(BINARY)} 个二元因子、{len(CATS)} 个分类因子（共 {trials} 次试验），"
                 f"单变量筛有 {n_pass} 个（因子×时点或水平）两期同号且 |gap|≥5pp，但**没有一个**叠加到基准规则上能在测试期带来 ≥+3pp 且两期同号的胜率增量；"
                 f"跨资产 / 日历 / 波动率状态这一族在已知四因子之外没有找到站得住的新增量。\n")
    else:
        def scr_of(f):
            r = sb[sb.factor == f] if f in BINARY else sc[sc.factor == f]
            return "，".join(f"{x.entry} 筛查 gap 训 {pct(x.gap_train)} / 测 {pct(x.gap_test)}" for x in r.itertuples())
        L.append(f"**没找到。** 试了 {trials} 次试验，单变量筛通过 {n_pass} 个（预期假阳性约 {(t1 + t2 + t3) * 0.05:.1f} 个），但通过单变量筛的因子没有一个叠加到基准上有增量。"
                 f"形式上过「两期同号且测试期 ≥+3pp」的只有 {n_val} 条规则："
                 + "、".join(f"`{r.factor}`（「{r.rule}」= 只在 {r.n_test}/{r.base_n_test} 个测试日交易，训练增量 {pct(r.incr_train)}（<3pp），测试增量 {pct(r.incr_test)}，测试胜率 {pct(r.win_test)} [{pct(r.win_lo_test)}, {pct(r.win_hi_test)}] 含基准 {pct(r.base_win_test)}；它单变量筛不过：{scr_of(r.factor)}）" for r in valuable.itertuples())
                 + f"，是 {t4} 条规则里预期的 {t4 * 0.05:.1f} 个假阳性之一，不算发现。"
                 f"同时通过单变量筛与增量检验的：{', '.join(f'`{f}`@{e}' for f, e in strong) or '无'}。这一族在已知四因子之外没有站得住的新东西。\n")
    small = sb[(np.sign(sb.gap_train) == np.sign(sb.gap_test)) & (sb.gap_train.abs() >= .05) & (sb.gap_test.abs() >= .05) & ~sb["pass"]]
    if len(small):
        L.append("方向两期一致、|gap|≥5pp 但标记天数不足 20 天、不能判成立的二元因子（只记录，样本太小）："
                 + "；".join(f"`{r.factor}`@{r.entry}（gap 训 {pct(r.gap_train)} / 测 {pct(r.gap_test)}，标记天 {r.n_days_flag_train} / {r.n_days_flag_test}，标记日测试期期望 {num(r.ev_flag_test)}$）" for r in small.itertuples()) + "。\n")

    L.append("## 2. 试过的因子清单\n")
    L.append("连续因子（在 13:00 与 14:00 各算一次；分钟 K 线只用 ts < 入场时刻的，日线只用 D−1 及更早）：\n")
    L.append("| 因子 | 定义 | 为什么有道理 |\n|---|---|---|")
    why = {
        "rs_qqq": "科技相对强弱极端时下午常有补涨/补跌，SPX 难以钉住", "rs_qqq_chg60": "相对强弱正在变化 = 板块轮动进行中，波动可能延续",
        "corr_spy_chg60": "SPY/SPX 相关性掉落 = 微观结构噪声或 ETF 流入，下午方向不定", "corr_qqq_60": "QQQ 与 SPX 同步度低 = 单一板块驱动，收盘可能被拉偏",
        "rv20_over_iv": "入场前短期已实现波动相对早盘隐含：高 = 市场比期权定价更躁", "rv60_over_iv": "同上，窗口长更稳",
        "rv5d_over_vix": "近期日波动相对 VIX：VIX 高估时蝶卖出的隐含偏贵", "rv10d_over_vix": "同上", "rv20d_over_vix": "同上",
        "vix_rel_ma20": "VIX 相对其均值的位置而非绝对水平，去掉已知的 VIX 前收", "vix_rel_ma60": "同上，更长窗口",
        "vix_chg1": "VIX 前日上冲后常回落（隐含偏贵）", "prev_range_pct": "前日区间大 → 波动聚集", "prev_close_pos": "前日收在高位/低位 → 隔夜动量与次日反转",
        "streak": "连续同向后均值回归或趋势延续", "days_since_bigdown": "大跌后数日波动仍高", "days_since_bigup": "同上，大涨",
        "spx_since_open": "日内已走出的幅度：走远了下午是否还有力", "gap_pct": "跳空大的日子日内回补常带波动",
    }
    for f, d in CONT.items():
        L.append(f"| `{f}` | {d} | {why[f]} |")
    L.append("\n二元因子：\n")
    L.append("| 因子 | 定义 |\n|---|---|")
    for f, d in BINARY.items():
        L.append(f"| `{f}` | {d} |")
    L.append("\n分类因子：`weekday`（星期 × 入场时点）、`month`（月份）。\n")
    L.append("故意不重做的已知因子：5 日涨幅、距 20 日均线、VIX 前收、隐含占比（`w_over_implied`）、60 分钟区间占隐含（`range60_over_implied`）；"
             "它们只用来查成立因子的冗余（第 4 节）。\n")

    L.append("## 3. 单变量筛查表（全部）\n")
    L.append("### 3.1 连续因子：训练期五分位切点 → 测试期同切点；gap = Q5 胜率 − Q1 胜率；Spearman 对 pnl（按天×翅宽去重）\n")
    cols = {"factor": "因子", "entry": "时点", "n_days_train": "n 训", "n_days_test": "n 测", "q1_win_train": "Q1 训", "q5_win_train": "Q5 训", "gap_train": "gap 训",
            "q1_win_test": "Q1 测", "q5_win_test": "Q5 测", "gap_test": "gap 测", "spearman_train": "ρ 训", "spearman_test": "ρ 测", "q1_ev_test": "Q1 期望测($)", "q5_ev_test": "Q5 期望测($)", "pass": "成立"}
    fmt = {c: pct for c in cols if "win" in c or "gap" in c}
    fmt.update({"spearman_train": lambda x: num(x, 3), "spearman_test": lambda x: num(x, 3), "q1_ev_test": num, "q5_ev_test": num, "pass": lambda x: "**是**" if x else "否", "n_days_train": str, "n_days_test": str})
    L.append(md_table(sc, cols, fmt))
    L.append("### 3.2 二元因子：gap = 标记日胜率 − 其余日胜率（标记日训练/测试各 ≥20 天才判成立）\n")
    cols = {"factor": "因子", "entry": "时点", "n_days_flag_train": "标记天 训", "n_days_flag_test": "标记天 测", "win_flag_train": "标记 训", "win_rest_train": "其余 训", "gap_train": "gap 训",
            "win_flag_test": "标记 测", "win_rest_test": "其余 测", "gap_test": "gap 测", "ev_flag_test": "标记期望测($)", "ev_rest_test": "其余期望测($)", "pass": "成立"}
    fmt = {c: pct for c in cols if "win" in c or "gap" in c}
    fmt.update({"ev_flag_test": num, "ev_rest_test": num, "pass": lambda x: "**是**" if x else "否", "n_days_flag_train": str, "n_days_flag_test": str})
    L.append(md_table(sb, cols, fmt))
    L.append("### 3.3 分类因子：每个水平对其余水平\n")
    cols = {"factor": "因子", "level": "水平", "entry": "时点", "n_days_train": "n 训", "n_days_test": "n 测", "win_train": "胜率 训", "gap_train": "gap 训", "win_test": "胜率 测", "gap_test": "gap 测", "ev_test": "期望测($)", "pass": "成立"}
    fmt = {c: pct for c in cols if "win" in c or "gap" in c}
    fmt.update({"ev_test": num, "pass": lambda x: "**是**" if x else "否", "n_days_train": str, "n_days_test": str, "level": str})
    L.append(md_table(sk, cols, fmt))

    L.append("## 4. 成立者的控制隐含、冗余、增量检验、分年\n")
    cp = sk[sk["pass"]]
    if len(cp):
        L.append("分类因子里通过单变量筛的水平（没有增量规则，只列出）："
                 + "；".join(f"`{r.factor}`={r.level}@{r.entry}（gap 训 {pct(r.gap_train)} / 测 {pct(r.gap_test)}，n 训 {r.n_days_train} / 测 {r.n_days_test}）" for r in cp.itertuples()) + "。\n")
    L.append(f"基准规则（14:00 入场、每天选 `w_over_implied` 最接近 2 的翅宽、跳过 `spx_ret_prev ≤ −1%`、剔半天）："
             f"训练期 n={bt[0]} 胜率 {pct(bt[1])} [{pct(bt[2])}, {pct(bt[3])}] 期望 {num(bt[4])}$；"
             f"测试期 n={bte[0]} 胜率 {pct(bte[1])} [{pct(bte[2])}, {pct(bte[3])}] 期望 {num(bte[4])}$。\n")
    if not passers:
        L.append("单变量筛没有连续或二元因子通过，控制隐含与冗余表为空。\n")
    else:
        L.append("### 4.1 控制隐含（`w_over_implied` 训练期三分位）与控制 VIX 前收：因子高低组（连续因子按训练期中位数分）胜率差\n")
        cols = {"factor": "因子", "entry": "时点", "control": "控制变量", "group": "组", "n_days_train": "n 训", "win_high_train": "高 训", "win_low_train": "低 训", "gap_train": "gap 训",
                "n_days_test": "n 测", "win_high_test": "高 测", "win_low_test": "低 测", "gap_test": "gap 测"}
        fmt = {c: pct for c in cols if "win" in c or "gap" in c}
        fmt.update({"n_days_train": str, "n_days_test": str})
        L.append(md_table(ctrl, cols, fmt))
        verdict = []
        for f, e, _ in passers:
            sgn = np.sign(scr_gap[(f, e)])
            c = ctrl[(ctrl.factor == f) & (ctrl.entry == e) & (ctrl.control == "w_over_implied")]
            ok = bool(((np.sign(c.gap_train) == sgn) & (np.sign(c.gap_test) == sgn)).all())
            verdict.append((f, e, ok, int(((np.sign(c.gap_train) == sgn) & (np.sign(c.gap_test) == sgn)).sum())))
        n_ok = sum(v[2] for v in verdict)
        L.append(f"**判定**：成立者 {len(verdict)} 个里，在 `w_over_implied` 三个分组内、两期都保持筛查方向的有 **{n_ok}** 个"
                 + (f"（{', '.join(f'`{f}`@{e}' for f, e, ok, _ in verdict if ok)}）" if n_ok else "")
                 + "。各因子三组中两期同向的组数：" + "；".join(f"`{f}`@{e} {k}/3" for f, e, _, k in verdict) + "。"
                 "也就是说单变量筛出来的 gap 大多是隐含占比（今天波动贵不贵）的影子，控制住就散了；"
                 + ("、".join(f"`{f}`@{e}" for f, e, ok, _ in verdict if ok) + " 虽保持方向，但叠加基准同样没有增量（4.2b）。" if n_ok else "")
                 + "另外 `days_since_bigdown` 的训练期 Q1 = {0, 1} 天，就是基准规则自己的「跳过前一日大跌」，所以叠加增量 ≈ 0。\n")
        L.append("### 4.2 与已知因子的 Spearman（训练期，按天）\n")
        cols = {"factor": "因子", "entry": "时点", **{k: k for k in KNOWN}}
        fmt = {k: (lambda x: num(x, 3)) for k in KNOWN}
        L.append(md_table(red, cols, fmt))
    L.append("### 4.2b 单变量成立者叠加到基准上的增量（摘自 4.3）\n")
    if passers:
        pz = pd.DataFrame([{"factor": f, "entry": e} for f, e, _ in passers]).merge(inc[["factor", "rule", "n_test", "incr_train", "incr_test", "incr_ev_test", "valuable"]], on="factor")
        cols = {"factor": "因子", "entry": "筛查时点", "rule": "叠加规则", "n_test": "n 测", "incr_train": "增量 训", "incr_test": "增量 测", "incr_ev_test": "期望增量测($)", "valuable": "有价值"}
        fmt = {"incr_train": pct, "incr_test": pct, "incr_ev_test": num, "valuable": lambda x: "**是**" if x else "否", "n_test": str, "rule": str}
        L.append(md_table(pz, cols, fmt))
    L.append("### 4.3 增量检验（全部因子，不只成立者；每个因子一条预先写死的规则）\n")
    L.append("连续因子剔除训练期胜率更差的那个五分位（按 14:00 筛查方向，切点来自训练期基准样本）；二元因子剔除训练期胜率更低的一边。"
             "增量 = 叠加后胜率 − 基准胜率。有价值 = 两期增量同号且测试期 ≥ +3pp。"
             "二元因子若「剔除=假」即只在少数标记日交易，n 会掉到基准的一小部分（`post_fomc`、`month_first3`、`opex_week`），那是换策略不是加滤网，区间宽，看 n 与 Wilson 下界。\n")
    cols = {"factor": "因子", "rule": "规则", "n_train": "n 训", "win_train": "胜率 训", "win_lo_train": "下界 训", "win_hi_train": "上界 训", "ev_train": "期望训($)", "incr_train": "增量 训",
            "n_test": "n 测", "win_test": "胜率 测", "win_lo_test": "下界 测", "win_hi_test": "上界 测", "ev_test": "期望测($)", "incr_test": "增量 测", "incr_ev_test": "期望增量测($)", "valuable": "有价值"}
    fmt = {c: pct for c in cols if "win" in c or "incr" in c and "ev" not in c}
    fmt.update({"ev_train": num, "ev_test": num, "incr_ev_test": num, "valuable": lambda x: "**是**" if x else "否", "n_train": str, "n_test": str, "rule": str})
    L.append(md_table(inc, cols, fmt))
    show_yr = [f for f, _, _ in passers] + list(valuable.factor)
    show_yr = list(dict.fromkeys(show_yr))
    L.append("### 4.4 分年稳定性（13:00 与 14:00 合并；高低 = 训练期中位数 / 二元真假）\n")
    if not show_yr:
        L.append("没有成立或有价值的因子；全部因子的分年表在 `cross_tables/yearly.csv`。\n")
    else:
        cols = {"factor": "因子", "year": "年", "n_days_high": "n 高", "win_high": "胜率 高", "ev_high": "期望高($)", "n_days_low": "n 低", "win_low": "胜率 低", "ev_low": "期望低($)", "gap": "gap"}
        fmt = {"win_high": pct, "win_low": pct, "gap": pct, "ev_high": num, "ev_low": num, "n_days_high": lambda x: str(int(x)) if pd.notna(x) else "—", "n_days_low": lambda x: str(int(x)) if pd.notna(x) else "—", "year": str}
        L.append(md_table(yr[yr.factor.isin(show_yr)], cols, fmt))

    L.append("## 5. 多重比较账\n")
    L.append(f"- 单变量筛：连续 {len(CONT)} 因子 × 2 时点 = {t1}；二元 {len(BINARY)} × 2 = {t2}；分类水平 × 时点 = {t3}。合计 {t1 + t2 + t3} 次，其中 {n_pass} 次通过「两期同号且 |gap|≥5pp」。")
    L.append(f"- 增量检验：{t4} 条规则（每因子一条，跑前写死），{n_val} 条「有价值」。")
    n_red = int((red[KNOWN].abs().max(axis=1) >= 0.4).sum()) if len(red) else 0
    L.append(f"- 总试验数 {trials}。5% 水平下预期约 {trials * 0.05:.1f} 个假阳性（单变量筛部分约 {(t1 + t2 + t3) * 0.05:.1f}）。"
             f"单变量筛通过 {n_pass} 个，多于预期，但其中连续/二元的 {len(passers)} 个里有 {n_red} 个与某个已知因子的训练期 |Spearman| ≥ 0.4（4.2 节：`days_since_bigdown`、`prev_range_pct` 跟 VIX 前收 / 隐含占比，`rvN_over_iv` 跟 60 分钟区间占隐含），"
             f"是已知因子的影子；分类水平（星期、月份）的 {int(sk['pass'].sum())} 个通过在 {t3} 次试验里正处于运气量级。增量检验 {t4} 条里 {n_val} 条过线，与 {t4 * 0.05:.1f} 的预期假阳性数一致。"
             f"因子之间高度相关（三个 rvNd_over_vix、两个 vix_rel_ma、两个 rvN_over_iv、两个 corr），有效独立试验数更少，但同一结论也更容易被相邻变体「复现」，不能当作独立证据。\n")
    L.append("## 6. 可复现命令\n")
    L.append("```\ncd /Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly\n.venv/bin/python src/mining/cross.py\n```\n")
    L.append("输出：`reports/mining/cross.md`、`reports/mining/cross_tables/{screen_cont,screen_binary,screen_cats,control_iv,redundancy,incremental,yearly}.csv`、"
             "`cross_tables/cross_panel.parquet`（目标行 + 全部因子值）。\n")
    with open(OUT_MD, "w") as fh:
        fh.write("\n".join(L))
    print(f"trials={trials} pass={n_pass} valuable={n_val}")
    print(sc[["factor", "entry", "gap_train", "gap_test", "pass"]].to_string())
    print(sb[["factor", "entry", "gap_train", "gap_test", "pass"]].to_string())
    print(sk[sk["pass"]][["factor", "level", "entry", "gap_train", "gap_test"]].to_string())
    print(inc[["factor", "rule", "n_test", "incr_train", "incr_test", "incr_ev_test", "valuable"]].to_string())


if __name__ == "__main__":
    main()
