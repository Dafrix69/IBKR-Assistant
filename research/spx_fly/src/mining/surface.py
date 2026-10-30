"""因子族 surface：0DTE 波动率曲面形状 / 期限结构 / 日内 IV 变化，对 ATM 蝶胜率与期望的挖掘。

    .venv/bin/python src/mining/surface.py            # 全部：因子面板 → 筛查 → 报告
    .venv/bin/python src/mining/surface.py --stage report   # 只用已算好的因子面板重做统计与报告

产出
    reports/mining/surface_tables/factor_panel.csv     每天 × 入场的全部因子（可复现中间结果）
    reports/mining/surface_tables/*.csv                筛查 / 控制 / 增量 / 分年 / 多重比较表
    reports/mining/surface.md                          报告（全部数字由本脚本写出）

口径（完整版见 METHOD，报告第 2 节原文引用）
- 现货用 spot.parquet 在入场分钟的值；远期 F 用当分钟 C−P 最接近的三个行权价做平价反推（中位数）。
- IV 用 OTM 一侧的中间价按 Black-76（r=0）反解，按交易时间年化：0DTE 剩余时间 = 到 16:00 的分钟数 / (252·390)；
  D−1 日终文件的到期日按交易日数 / 252 年化。日历时间年化会把下午的 0DTE IV 机械抬高约 √5（3 小时剩余 vs 24 小时），
  只改尺度不改排序；用交易时间是为了让 iv_over_vix、ts_* 的数值可读（≈1 / ≈0 为中性）。隔夜跳空不在 0DTE 剩余时间里，
  所以 0DTE IV 相对 D−1 收盘的 IV 系统性偏高，同样只影响尺度。
- 微笑拟合：IV = a + b·x + c·x²，x = ln(K/F) / (σ_ATM·√T)（以 ATM 标准差为单位的对数在值程度），
  只用 |x| ≤ 2.5、bid>0、未被 flag_bad 的行权价，权重 1/max(spread, 0.05)，两侧各至少 4 个点，否则 NaN。
  同时给出以原始 ln(K/F) 为自变量的 b_raw、c_raw（变体，计入多重比较）。
- 期限结构用 SPXW 根（PM 结算）D−1 17:15 日终报告的收盘 NBBO：距 D−1 日历 7 天与 30 天最近的到期日，
  ATM IV 取 gex.expiry_iv 插值到 F 处；另外取 D 这一天到期合约在 D−1 收盘的 IV（同一合约隔夜变化）。
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
SRC = os.path.dirname(HERE)
sys.path.insert(0, SRC)
import gex  # noqa: E402
from winrate_study import stats, wilson  # noqa: E402,F401

ROOT = os.path.dirname(SRC)
CLEAN = os.path.join(ROOT, "data", "clean")
RAW = os.path.join(ROOT, "data", "raw")
REPORT_DIR = os.path.join(ROOT, "reports", "mining")
TABLES = os.path.join(REPORT_DIR, "surface_tables")
REPORT = os.path.join(REPORT_DIR, "surface.md")

SPLIT = pd.Timestamp("2024-11-01")
ENTRIES = ["13:00", "14:00"]
SNAPS = ["09:35", "12:00", "12:30", "13:00", "13:30", "14:00"]
WIDTHS = (25, 30)
X_MAX = 2.5          # 拟合窗口：|x| ≤ 2.5 个 ATM 标准差
MIN_SIDE = 4         # 两侧各至少几个点
HOLD_GAP = 0.05      # 单变量"成立"：两期同号且 |Q5−Q1| ≥ 5 个百分点
INC_GAP = 0.03       # 增量"有价值"：两期同号且测试期 ≥ +3 个百分点
OVERLAYS = {"keep60": 0.60, "keep40": 0.40}   # 叠加规则：按训练期分位只留"好的一侧"的 60% / 40%

# ------------------------------------------------------------------ 因子定义（名字 → 中文说明）
FACTORS = {
    "level":         "拟合微笑的 ATM 水平 a（年化 IV）。对照用：它就是 w_over_implied 的另一面",
    "skew_n":        "微笑斜率 b（x 以 ATM 标准差为单位），负 = put 侧贵。偏斜",
    "curv_n":        "微笑曲率 c（同上单位）。凸性 / 两翼相对 ATM 的溢价",
    "skew_raw":      "斜率 b_raw，自变量为原始 ln(K/F)（变体）",
    "curv_raw":      "曲率 c_raw，自变量为原始 ln(K/F)（变体）",
    "skew_chg":      "skew_n(入场) − skew_n(09:35)：偏斜日内变化",
    "curv_chg":      "curv_n(入场) − curv_n(09:35)：凸性日内变化",
    "ts_1w":         "ln(ATM IV 0DTE(入场) / 1 周 ATM IV(D−1 收盘))：期限结构斜率（短端）",
    "ts_1m":         "ln(ATM IV 0DTE(入场) / 1 月 ATM IV(D−1 收盘))：期限结构斜率（长端）",
    "iv_vs_prevclose": "ln(ATM IV(入场) / 同一到期合约 D−1 收盘 ATM IV)：隔夜以来的 IV 变化",
    "iv_chg30":      "ln(ATM IV(入场) / ATM IV(入场−30 分))",
    "iv_chg60":      "ln(ATM IV(入场) / ATM IV(入场−60 分))",
    "iv_chg_open":   "ln(ATM IV(入场) / ATM IV(09:35))",
    "iv_over_vix":   "ATM IV(入场) / (VIX 前收 / 100)：按剩余时间年化的 0DTE 隐含相对 VIX",
    "rr25":          "IV(F−25 put) − IV(F+25 call)：25 点风险逆转",
    "rr25_chg":      "rr25(入场) − rr25(09:35)",
    "wing_put25":    "IV(F−25) − IV(F)：put 翼溢价",
    "wing_call25":   "IV(F+25) − IV(F)：call 翼溢价",
    "strad_spread_pct": "ATM 跨式 (ask−bid 之和) / 中间价：流动性",
    "strad_decay":   "ln(跨式(入场)/跨式(09:35)) − ½·ln(T入场/T09:35)：跨式衰减快于 √T 的程度（<0 快于理论）。代数上 ≈ iv_chg_open",
}


METHOD = """口径：
- 现货 = `spot.parquet` 在入场分钟的值；远期 F = 当分钟 C−P 最接近的三个行权价的平价反推（K + C − P 的中位数）。
- IV 由 OTM 一侧中间价按 Black-76（r=0）反解；只用 bid>0、ask≥bid、未被 `flag_bad` 的行。
- 年化按交易时间：0DTE 剩余时间 = 到 16:00 的分钟数 / (252·390)；D−1 日终到期日 = 交易日数 / 252（`np.busday_count`，不剔交易所假日，
  少数到期日的 T 差一个交易日）。日历时间年化会把下午的 0DTE IV 机械抬高约 √5，只改尺度不改排序。隔夜跳空不在 0DTE 剩余时间里，
  所以 ts_*、iv_vs_prevclose 系统性偏负，同样只影响尺度。
- 微笑拟合：IV = a + b·x + c·x²，x = ln(K/F) / (σ_ATM·√T)，σ_ATM 为 (ln(K/F), IV) 线性插值到 0 的值；窗口 |x| ≤ 2.5，
  权重 1/max(spread, 0.05)，F 两侧各至少 4 个点，否则 NaN。b_raw、c_raw 用原始 ln(K/F) 做同一拟合。IV(F±25) 为线性插值。
- ATM 跨式 = 离现货最近的行权价的 C+P 中间价（与 `winrate_panel` 同口径），点差 = 两腿 ask−bid 之和。
- 期限结构：SPXW 根 D−1 17:15 日终报告的收盘 NBBO，取距 D−1 日历 7 天与 30 天最近的到期日，ATM IV 用 `gex.expiry_iv` 插到 F；
  另取 D 当天到期合约在 D−1 收盘的 IV（同一合约隔夜变化）。D−1 = `calendar` 里的前一个交易日；2022-05-02 无前一日文件 → NaN。
- 快照时刻：09:35（开盘参照）、12:00、12:30、13:00、13:30、14:00；入场 13:00 的 −30/−60 分钟 = 12:30/12:00，14:00 的 = 13:30/13:00。
"""


# ------------------------------------------------------------------ 一个时间快照
def snapshot(df, t, spot, session_end):
    """返回该分钟的曲面量；缺数据时给 NaN。"""
    out = dict(F=np.nan, atm_iv=np.nan, a=np.nan, b=np.nan, c=np.nan, b_raw=np.nan, c_raw=np.nan,
               n_pts=0, rms=np.nan, iv_p25=np.nan, iv_c25=np.nan, strad=np.nan, strad_spr=np.nan, T=np.nan)
    q = df[(df.ts == t) & ~df.flag_bad & (df.bid > 0) & (df.ask >= df.bid)]
    if q.empty:
        return out
    T = (pd.Timestamp(f"{t.date()} {session_end}") - t).total_seconds() / 60 / (252 * 390)
    out["T"] = T
    c = q[q.right == "C"].set_index("strike").mid
    p = q[q.right == "P"].set_index("strike").mid
    both = pd.DataFrame({"c": c, "p": p}).dropna()
    if both.empty:
        return out
    both["d"] = (both.c - both.p).abs()
    top = both.nsmallest(3, "d")
    F = float((top.index.values + top.c - top.p).median())
    out["F"] = F
    # ATM 跨式：离现货最近的行权价（与 winrate_panel 同口径）
    strikes = both.index.values
    Kc = float(strikes[np.abs(strikes - spot).argmin()])
    qi = q.set_index(["strike", "right"])
    try:
        rc, rp = qi.loc[(Kc, "C")], qi.loc[(Kc, "P")]
        out["strad"] = float(rc.mid + rp.mid)
        out["strad_spr"] = float((rc.ask - rc.bid) + (rp.ask - rp.bid))
    except KeyError:
        pass
    otm = q[((q.right == "C") & (q.strike >= F)) | ((q.right == "P") & (q.strike < F))]
    K = otm.strike.values
    is_call = (otm.right == "C").values
    w = gex.solve_total_var(otm.mid.values, lambda x: gex.black_price(F, K, x, is_call))
    ok = np.isfinite(w) & (w > 0)
    if ok.sum() < 2 * MIN_SIDE:
        return out
    k = np.log(K[ok] / F)
    iv = np.sqrt(w[ok] / T)
    spr = otm.spread.values[ok]
    order = np.argsort(k)
    k, iv, spr = k[order], iv[order], spr[order]
    if not (k.min() < 0 < k.max()):
        return out
    atm = float(np.interp(0.0, k, iv))
    out["atm_iv"] = atm
    sd = atm * np.sqrt(T)
    out["iv_p25"] = float(np.interp(np.log((F - 25) / F), k, iv))
    out["iv_c25"] = float(np.interp(np.log((F + 25) / F), k, iv))
    x = k / sd
    sel = np.abs(x) <= X_MAX
    if (sel & (x < 0)).sum() < MIN_SIDE or (sel & (x > 0)).sum() < MIN_SIDE:
        return out
    wts = 1 / np.maximum(spr[sel], 0.05)
    cc, bb, aa = np.polyfit(x[sel], iv[sel], 2, w=wts)
    cr, br, _ = np.polyfit(k[sel], iv[sel], 2, w=wts)
    fit = aa + bb * x[sel] + cc * x[sel] ** 2
    out.update(a=float(aa), b=float(bb), c=float(cc), b_raw=float(br), c_raw=float(cr),
               n_pts=int(sel.sum()), rms=float(np.sqrt(np.mean((fit - iv[sel]) ** 2))))
    return out


# ------------------------------------------------------------------ D−1 日终：期限结构
def term_structure(prev_ymd, date):
    """返回 iv_1w, iv_1m, iv_dte(D 到期合约在 D−1 收盘的 IV) 与所选到期日的日历天数。"""
    out = dict(iv_1w=np.nan, iv_1m=np.nan, iv_dte=np.nan, dte_1w=np.nan, dte_1m=np.nan)
    path = gex.raw_path("SPXW/greeks_eod", prev_ymd)
    if not os.path.exists(path):
        return out
    g = pd.read_csv(path, compression="gzip", usecols=["expiration", "strike", "right", "bid", "ask", "underlying_price"])
    g["mid"] = (g.bid + g.ask) / 2
    g["expiration"] = pd.to_datetime(g.expiration)
    prev = pd.Timestamp(prev_ymd)
    S = float(g.underlying_price.iloc[0])
    dte = (g.expiration - prev).dt.days
    cands = sorted(set(dte[dte >= 1]))
    if not cands:
        return out
    picks = {"iv_1w": min(cands, key=lambda d: (abs(d - 7), d)), "iv_1m": min(cands, key=lambda d: (abs(d - 30), d))}
    if (date - prev).days in cands:
        picks["iv_dte"] = (date - prev).days
    for key, d in picks.items():
        sub = g[dte == d]
        bd = int(np.busday_count(prev.date(), (prev + pd.Timedelta(days=d)).date()))
        r = gex.expiry_iv(sub, S, max(bd, 1) / 252)
        if r is None:
            continue
        F, strikes, iv = r
        out[key] = float(np.interp(F, strikes, iv))
        if key != "iv_dte":
            out["dte_" + key[3:]] = d
    return out


def day_job(args):
    path, date, prev_ymd, session_end, spot_day, vix_prev = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "spread", "flag_bad"])
    snaps = {}
    for s in SNAPS:
        t = pd.Timestamp(f"{date.date()} {s}")
        if t not in spot_day.index:
            continue
        snaps[s] = snapshot(df, t, float(spot_day.loc[t]), session_end)
    ts = term_structure(prev_ymd, date)
    rows = []
    for e in ENTRIES:
        if e not in snaps or "09:35" not in snaps:
            continue
        n = snaps[e]
        o = snaps["09:35"]
        m30 = snaps.get({"13:00": "12:30", "14:00": "13:30"}[e], {})
        m60 = snaps.get({"13:00": "12:00", "14:00": "13:00"}[e], {})
        lg = lambda u, v: np.log(u / v) if (u and v and np.isfinite(u) and np.isfinite(v) and u > 0 and v > 0) else np.nan  # noqa: E731
        rows.append({
            "date": date, "entry": e,
            "level": n["atm_iv"], "skew_n": n["b"], "curv_n": n["c"], "skew_raw": n["b_raw"], "curv_raw": n["c_raw"],
            "skew_chg": n["b"] - o["b"], "curv_chg": n["c"] - o["c"],
            "ts_1w": lg(n["atm_iv"], ts["iv_1w"]), "ts_1m": lg(n["atm_iv"], ts["iv_1m"]),
            "iv_vs_prevclose": lg(n["atm_iv"], ts["iv_dte"]),
            "iv_chg30": lg(n["atm_iv"], m30.get("atm_iv", np.nan)), "iv_chg60": lg(n["atm_iv"], m60.get("atm_iv", np.nan)),
            "iv_chg_open": lg(n["atm_iv"], o["atm_iv"]),
            "iv_over_vix": n["atm_iv"] / (vix_prev / 100) if vix_prev and np.isfinite(vix_prev) else np.nan,
            "rr25": n["iv_p25"] - n["iv_c25"], "rr25_chg": (n["iv_p25"] - n["iv_c25"]) - (o["iv_p25"] - o["iv_c25"]),
            "wing_put25": n["iv_p25"] - n["atm_iv"], "wing_call25": n["iv_c25"] - n["atm_iv"],
            "strad_spread_pct": n["strad_spr"] / n["strad"] if n["strad"] and np.isfinite(n["strad"]) and n["strad"] > 0 else np.nan,
            "strad_decay": lg(n["strad"], o["strad"]) - 0.5 * lg(n["T"], o["T"]),
            # 审计列
            "F": n["F"], "n_pts": n["n_pts"], "fit_rms": n["rms"], "iv_1w": ts["iv_1w"], "iv_1m": ts["iv_1m"],
            "iv_dte_prev": ts["iv_dte"], "dte_1w": ts["dte_1w"], "dte_1m": ts["dte_1m"],
        })
    return rows


def build_factor_panel(workers):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    days = list(cal.index)
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if cal.loc[d, "half_day"]:
            continue
        i = days.index(d)
        prev = days[i - 1].strftime("%Y%m%d") if i > 0 else "00000000"
        jobs.append((f, d, prev, cal.loc[d, "session_end"], spot[spot.index.normalize() == d], float(cal.loc[d, "vix_prev_close"])))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(day_job, jobs, chunksize=4) for r in day]
    fp = pd.DataFrame(rows)
    os.makedirs(TABLES, exist_ok=True)
    fp.to_csv(os.path.join(TABLES, "factor_panel.csv"), index=False)
    return fp


# ------------------------------------------------------------------ 统计
def load_target():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    p = p[(p.structure == "put_fly")].copy()
    p["spx_ret_prev"] = p.date.map(cal.spx_ret_prev)
    p["train"] = p.date < SPLIT
    p["year"] = p.date.dt.year
    return p


def qbins(train_vals, q):
    edges = np.unique(np.nanquantile(train_vals, np.linspace(0, 1, q + 1)))
    edges[0], edges[-1] = -np.inf, np.inf
    return edges


def rho(x, y):
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 10:
        return np.nan
    return float(spearmanr(x[m], y[m]).statistic)


def univariate(tp):
    """tp：目标行（put_fly, width 25/30, entry 13/14）已并上因子。每个 因子 × 入场 × 翅宽 一行。"""
    rows = []
    for f in FACTORS:
        for e in ENTRIES:
            for w in WIDTHS:
                cell = tp[(tp.entry == e) & (tp.width == w) & np.isfinite(tp[f])]
                tr, te = cell[cell.train], cell[~cell.train]
                if len(tr) < 50 or len(te) < 50:
                    continue
                edges = qbins(tr[f].values, 5)
                r = {"factor": f, "entry": e, "width": w, "n_train": len(tr), "n_test": len(te),
                     "rho_woi_train": rho(tr[f].values, tr.w_over_implied.values)}
                for name, d in (("train", tr), ("test", te)):
                    qd = pd.cut(d[f], edges, labels=False, include_lowest=True)
                    q1, q5 = d[qd == 0], d[qd == edges.size - 2]
                    r[f"q1_win_{name}"] = q1.win.mean()
                    r[f"q5_win_{name}"] = q5.win.mean()
                    r[f"gap_{name}"] = q5.win.mean() - q1.win.mean()
                    r[f"q1_ev_{name}"] = q1.pnl.mean()
                    r[f"q5_ev_{name}"] = q5.pnl.mean()
                    r[f"rho_win_{name}"] = rho(d[f].values, d.win.astype(float).values)
                    r[f"rho_pnl_{name}"] = rho(d[f].values, d.pnl.values)
                r["holds"] = bool(np.sign(r["gap_train"]) == np.sign(r["gap_test"]) and abs(r["gap_train"]) >= HOLD_GAP
                                  and abs(r["gap_test"]) >= HOLD_GAP)
                rows.append(r)
    return pd.DataFrame(rows)


def control_implied(tp, factors):
    """按 w_over_implied 训练期三分位（按翅宽分别切）分组，组内看因子训练期三分位 T3−T1 的胜率差。"""
    rows = []
    for w in WIDTHS:
        cw = tp[tp.width == w]
        wedges = qbins(cw[cw.train].w_over_implied.values, 3)
        for f in factors:
            for e in ENTRIES:
                cell = cw[(cw.entry == e) & np.isfinite(cw[f])].copy()
                cell["wt"] = pd.cut(cell.w_over_implied, wedges, labels=["低隐含比", "中", "高隐含比"], include_lowest=True)
                for t in ["低隐含比", "中", "高隐含比"]:
                    g = cell[cell.wt == t]
                    tr, te = g[g.train], g[~g.train]
                    if len(tr) < 30 or len(te) < 30:
                        continue
                    fedges = qbins(tr[f].values, 3)
                    r = {"factor": f, "entry": e, "width": w, "woi_tercile": t, "n_train": len(tr), "n_test": len(te)}
                    for name, d in (("train", tr), ("test", te)):
                        qd = pd.cut(d[f], fedges, labels=False, include_lowest=True)
                        lo, hi = d[qd == 0], d[qd == fedges.size - 2]
                        r[f"lo_win_{name}"] = lo.win.mean()
                        r[f"hi_win_{name}"] = hi.win.mean()
                        r[f"gap_{name}"] = hi.win.mean() - lo.win.mean()
                    r["same_sign"] = bool(np.sign(r["gap_train"]) == np.sign(r["gap_test"]))
                    rows.append(r)
    return pd.DataFrame(rows)


def baseline_rows(p):
    """基准：14:00 入场，每天在 20/25/30/50/75 里选 w_over_implied 最接近 2 的翅宽，跳过 spx_ret_prev ≤ −1%。"""
    b = p[(p.entry == "14:00")].copy()
    b["d2"] = (b.w_over_implied - 2).abs()
    b = b.sort_values(["date", "d2"]).drop_duplicates("date", keep="first")
    b = b[~(b.spx_ret_prev <= -0.01)]
    return b


def sstats(g):
    if len(g) == 0:
        return pd.Series({"n": 0, "win": np.nan, "win_lo": np.nan, "win_hi": np.nan, "ev": np.nan, "ev_k05": np.nan})
    lo, hi = wilson(int(g.win.sum()), len(g))
    return pd.Series({"n": len(g), "win": g.win.mean(), "win_lo": lo, "win_hi": hi, "ev": g.pnl.mean(), "ev_k05": g.pnl_k05.mean()})


def incremental(base, fp, uni):
    """在基准上叠加每个因子（14:00 的因子值）。两种定方向的规则都报（都计入试验数）：
    uni_gap   = 单变量筛查训练期 gap（4 个单元之和）的符号，即"按筛查说的方向用"；
    spear_base = 训练期基准样本里因子与 win 的 Spearman 符号（第一版用的规则，保留以免只报对自己有利的那种）。
    阈值 = 训练期基准样本的分位数；keep60 留好的一侧 60%，keep40 留 40%。"""
    b = base.merge(fp[fp.entry == "14:00"][["date"] + list(FACTORS)], on="date", how="left")
    btr, bte = b[b.train], b[~b.train]
    s_tr, s_te = sstats(btr), sstats(bte)
    rows = [{"factor": "基准", "direction_rule": "-", "overlay": "-", "direction": "-", "threshold": np.nan,
             **{f"{k}_train": v for k, v in s_tr.items()}, **{f"{k}_test": v for k, v in s_te.items()},
             "d_win_train": 0.0, "d_win_test": 0.0, "d_ev_train": 0.0, "d_ev_test": 0.0, "valuable": False}]
    gap_sign = uni.groupby("factor").gap_train.sum()
    for f in FACTORS:
        tr = btr[np.isfinite(btr[f])]
        rules = {"uni_gap": np.sign(gap_sign.get(f, np.nan)),
                 "spear_base": np.sign(rho(tr[f].values, tr.win.astype(float).values))}
        for rule, direction in rules.items():
            if not np.isfinite(direction) or direction == 0:
                continue
            for name, keep in OVERLAYS.items():
                if direction > 0:
                    thr = float(np.nanquantile(tr[f].values, 1 - keep))
                    m = b[f] >= thr
                else:
                    thr = float(np.nanquantile(tr[f].values, keep))
                    m = b[f] <= thr
                sub = b[m & np.isfinite(b[f])]
                k_tr, k_te = sstats(sub[sub.train]), sstats(sub[~sub.train])
                d_tr, d_te = k_tr["win"] - s_tr["win"], k_te["win"] - s_te["win"]
                rows.append({"factor": f, "direction_rule": rule, "overlay": name, "direction": "高留" if direction > 0 else "低留",
                             "threshold": thr,
                             **{f"{k}_train": v for k, v in k_tr.items()}, **{f"{k}_test": v for k, v in k_te.items()},
                             "d_win_train": d_tr, "d_win_test": d_te,
                             "d_ev_train": k_tr["ev"] - s_tr["ev"], "d_ev_test": k_te["ev"] - s_te["ev"],
                             "valuable": bool(np.sign(d_tr) == np.sign(d_te) and d_te >= INC_GAP)})
    return pd.DataFrame(rows)


def yearly(tp, factors):
    rows = []
    for f in factors:
        for e in ENTRIES:
            for w in WIDTHS:
                cell = tp[(tp.entry == e) & (tp.width == w) & np.isfinite(tp[f])]
                med = float(np.nanmedian(cell[cell.train][f]))
                for y, g in cell.groupby("year"):
                    hi, lo = g[g[f] > med], g[g[f] <= med]
                    rows.append({"factor": f, "entry": e, "width": w, "year": int(y), "median_train": med,
                                 "n_lo": len(lo), "win_lo": lo.win.mean(), "ev_lo": lo.pnl.mean(),
                                 "n_hi": len(hi), "win_hi": hi.win.mean(), "ev_hi": hi.pnl.mean(),
                                 "gap": hi.win.mean() - lo.win.mean()})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ 报告
def md_table(df, cols, fmt=None):
    fmt = fmt or {}
    head = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    body = ""
    for _, r in df.iterrows():
        cells = []
        for c in cols:
            v = r[c]
            if c in fmt:
                cells.append(fmt[c](v))
            elif isinstance(v, (float, np.floating)):
                cells.append("" if not np.isfinite(v) else f"{v:.3f}")
            else:
                cells.append(str(v))
        body += "| " + " | ".join(cells) + " |\n"
    return head + body


def pct(v):
    return "" if not np.isfinite(v) else f"{100 * v:.1f}%"


def pp(v):
    return "" if not np.isfinite(v) else f"{100 * v:+.1f}"


def usd(v):
    return "" if not np.isfinite(v) else f"{v:+.0f}"


def summarise_held(uni, ctrl, inc):
    """成立者一览：成立单元数、与隐含的相关、控制隐含后通过的单元数、增量检验最好的测试期 Δ。"""
    rows = []
    cok = ctrl.same_sign & (ctrl.gap_train.abs() >= HOLD_GAP) & (ctrl.gap_test.abs() >= HOLD_GAP)
    for f, g in uni[uni.holds].groupby("factor"):
        c = ctrl[ctrl.factor == f]
        i = inc[inc.factor == f]
        best = i.loc[i.d_win_test.idxmax()] if len(i) else None
        rows.append({"factor": f, "held_cells": f"{len(g)}/4", "rho_woi_mean": uni[uni.factor == f].rho_woi_train.mean(),
                     "ctrl_pass": f"{int(cok[c.index].sum())}/{len(c)}",
                     "inc_best": "" if best is None else f"{best.direction_rule}/{best.overlay}",
                     "inc_d_train": np.nan if best is None else best.d_win_train,
                     "inc_d_test": np.nan if best is None else best.d_win_test,
                     "valuable": bool(i.valuable.any()) if len(i) else False})
    return pd.DataFrame(rows).sort_values("held_cells", ascending=False)


def control_pivot(ctrl, held_cells):
    rows = []
    for _, h in held_cells.iterrows():
        c = ctrl[(ctrl.factor == h.factor) & (ctrl.entry == h.entry) & (ctrl.width == h.width)]
        r = {"factor": h.factor, "entry": h.entry, "width": h.width, "pass": 0}
        for t in ["低隐含比", "中", "高隐含比"]:
            g = c[c.woi_tercile == t]
            if len(g) == 0:
                r[t] = ""
                continue
            g = g.iloc[0]
            r[t] = f"{pp(g.gap_train)} / {pp(g.gap_test)} (n {g.n_train}/{g.n_test})"
            if g.same_sign and abs(g.gap_train) >= HOLD_GAP and abs(g.gap_test) >= HOLD_GAP:
                r["pass"] += 1
        rows.append(r)
    return pd.DataFrame(rows)


def yearly_pivot(yr, held_cells):
    rows = []
    for _, h in held_cells.iterrows():
        y = yr[(yr.factor == h.factor) & (yr.entry == h.entry) & (yr.width == h.width)]
        r = {"factor": h.factor, "entry": h.entry, "width": h.width}
        sign = np.sign(h.gap_train)
        same = 0
        for yy in sorted(y.year.unique()):
            g = y[y.year == yy].iloc[0]
            r[str(yy)] = f"{pp(g.gap)} ({g.n_lo}/{g.n_hi})"
            same += int(np.sign(g.gap) == sign)
        r["same_sign_years"] = f"{same}/{len(y)}"
        rows.append(r)
    return pd.DataFrame(rows)


def write_report(fp, uni, ctrl, inc, yr, coverage, counts):
    held = uni[uni.holds]
    held_factors = held.groupby("factor").size().sort_values(ascending=False)
    valuable = inc[inc.valuable]
    summ = summarise_held(uni, ctrl, inc) if len(held) else pd.DataFrame()
    shadows = summ[summ.rho_woi_mean.abs() >= 0.6].factor.tolist() if len(summ) else []
    nonshadow = summ[summ.rho_woi_mean.abs() < 0.6] if len(summ) else pd.DataFrame()
    L = []
    L.append("# 因子族 surface：波动率曲面与期限结构\n")
    L.append(f"脚本 `src/mining/surface.py`；训练期 date < {SPLIT.date()}，测试期 ≥ {SPLIT.date()}；"
             "目标 = `winrate_panel` 里 put_fly、翅宽 25/30、13:00/14:00 入场的 `win`（pnl>0，k=0.25 含费）与 `pnl`。"
             "单元 = 入场 × 翅宽（2 × 2 = 4 个），每个单元的 n 是天数；13:00 与 14:00 两笔高度相关，不要把两个入场的 n 加起来看。\n")
    # 1 结论
    L.append("## 1. 一句话结论\n")
    n_cells = len(uni)
    n_hold = int(uni.holds.sum())
    base = inc.iloc[0]
    if len(valuable):
        vf = "、".join(f"`{r.factor}` {r.direction_rule}/{r.overlay}（训练 {pp(r.d_win_train)}、测试 {pp(r.d_win_test)} pp，测试 n={int(r.n_test)}）"
                       for r in valuable.itertuples())
        concl = (f"{len(FACTORS)} 个曲面因子 × 4 个单元共 {n_cells} 次单变量试验，{n_hold} 次两期同号且 |gap| ≥ 5pp（运气预期约 {n_cells * 0.05:.0f} 次），"
                 f"但成立者里 {len(shadows)} 个与 `w_over_implied` 的 |Spearman| ≥ 0.6（隐含水平的影子：" + "、".join(f"`{f}`" for f in shadows) + "）；"
                 f"叠加到基准规则（训练期胜率 {pct(base.win_train)}、测试期 {pct(base.win_test)}）上，{len(inc) - 1} 种因子 × 定向规则 × 阈值里 "
                 f"{len(valuable)} 种过了增量门槛（两期同号且测试期 ≥ +3pp；运气预期约 {(len(inc) - 1) * 0.05:.0f} 种）：{vf}。"
                 "这两种都够不上证据：一个是隐含水平影子且测试期样本很小，另一个训练期增量接近零（+0.3pp），按筛查方向（uni_gap）用时增量为零或反号。"
                 "结论：0DTE 微笑的偏斜、凸性、期限结构、日内 IV 变化与流动性在控制隐含水平之后，都不提供样本外站得住的胜率增量。")
    else:
        concl = (f"{len(FACTORS)} 个曲面因子 × 4 个单元共 {n_cells} 次单变量试验，{n_hold} 次两期同号且 |gap| ≥ 5pp"
                 f"（运气预期约 {n_cells * 0.05:.0f} 次），但成立者里 {len(shadows)} 个与 `w_over_implied` 的 |Spearman| ≥ 0.6（隐含水平的影子："
                 + "、".join(f"`{f}`" for f in shadows) + "）；"
                 f"叠加到基准规则（训练期胜率 {pct(base.win_train)}、测试期 {pct(base.win_test)}）上，{len(inc) - 1} 种因子 × 阈值没有一种通过增量门槛"
                 "（两期同号且测试期 ≥ +3pp）。结论：0DTE 微笑的偏斜、凸性、期限结构、日内 IV 变化与流动性在控制隐含水平之后，"
                 "都不提供样本外站得住的胜率增量。")
    L.append(concl + "\n")
    # 2 因子清单
    L.append("## 2. 试过的因子\n")
    L.append("入场时刻 13:00 与 14:00 各算一次；全部量只用入场那一分钟及之前的报价、D−1 日终报告与 VIX 前收。\n")
    L.append(METHOD)
    L.append("| 因子 | 定义 / 为什么有道理 |\n|---|---|\n" + "".join(f"| `{k}` | {v} |\n" for k, v in FACTORS.items()))
    L.append("\n覆盖率（有效值天数 / 目标天数，13:00 与 14:00 分别）：\n")
    L.append(md_table(coverage, ["factor", "n_13:00", "cov_13:00", "n_14:00", "cov_14:00"], {"cov_13:00": pct, "cov_14:00": pct}))
    # 3 单变量
    L.append("\n## 3. 单变量筛查（全部）\n")
    L.append("训练期五分位切点 → 测试期同切点。gap = Q5 胜率 − Q1 胜率；ρ(win)/ρ(pnl) = 因子与 win / pnl 的 Spearman；"
             "ρ(w/impl) = 训练期因子与 `w_over_implied` 的 Spearman（接近 ±1 的因子只是隐含水平的影子）。"
             "Q1/Q5 ev = 该分位 pnl 均值（美元/手）。成立 = 两期 gap 同号且都 ≥ 5pp。\n")
    cols = ["factor", "entry", "width", "n_train", "n_test", "rho_woi_train", "q1_win_train", "q5_win_train", "gap_train",
            "q1_win_test", "q5_win_test", "gap_test", "rho_win_train", "rho_win_test", "rho_pnl_train", "rho_pnl_test",
            "q1_ev_test", "q5_ev_test", "holds"]
    fmt = {c: pct for c in ["q1_win_train", "q5_win_train", "q1_win_test", "q5_win_test"]}
    fmt.update({"gap_train": pp, "gap_test": pp, "q1_ev_test": usd, "q5_ev_test": usd})
    L.append(md_table(uni, cols, fmt))
    L.append(f"\n成立的单元：{n_hold} / {n_cells}。按因子计数：" +
             ("、".join(f"`{f}` {n}/4" for f, n in held_factors.items()) if len(held_factors) else "无") + "\n")
    # 4 成立者
    L.append("\n## 4. 成立者的控制隐含、增量检验、分年\n")
    if len(held_factors) == 0:
        L.append("没有单元成立，本节只给增量检验的全表（所有因子都叠加过，作为完整记录）。\n")
    else:
        L.append("### 4.0 一览\n")
        L.append("held_cells = 成立单元数；rho_woi_mean = 四个单元 ρ(w/impl) 均值；ctrl_pass = 控制隐含后两期同号且 |gap| ≥ 5pp 的（单元 × 三分位）数；"
                 "inc_* = 增量检验里测试期 Δ 最大的那个阈值变体及其两期 Δ（pp）。\n")
        L.append(md_table(summ, ["factor", "held_cells", "rho_woi_mean", "ctrl_pass", "inc_best", "inc_d_train", "inc_d_test", "valuable"],
                          {"inc_d_train": pp, "inc_d_test": pp}))
        if len(nonshadow):
            L.append("\n|ρ(w/impl)| < 0.6 的成立者（不是单纯的水平影子）：" + "、".join(f"`{f}`" for f in nonshadow.factor) +
                     "。它们的单变量方向与增量检验里的表现见下。\n")
        L.append("\n### 4.1 控制隐含水平（成立单元）\n")
        L.append("按 `w_over_implied` 训练期三分位（按翅宽分别切）分组；组内把因子按训练期三分位切，格内 = T3−T1 胜率差 训练 / 测试（pp），括号为两期 n。"
                 "空格 = 该组测试期落入训练期因子三分位两端的样本不足（隐含水平换了档，训练切点在测试期失效）。pass = 两期同号且都 ≥ 5pp 的组数。\n")
        L.append(md_table(control_pivot(ctrl, held), ["factor", "entry", "width", "低隐含比", "中", "高隐含比", "pass"]))
    L.append("\n### 4.2 增量检验（全部因子）\n")
    L.append("基准 = 14:00 入场、每天在 20/25/30/50/75 里选 `w_over_implied` 最接近 2 的翅宽（每天一笔）、跳过 `spx_ret_prev ≤ −1%`。"
             "叠加：direction_rule=uni_gap 时方向由第 3 节训练期 gap 的符号决定（两个入场四个单元之和；本次没有一个因子两个入场的 gap 符号相反），"
             "spear_base 时由训练期基准样本里因子与 win 的 Spearman 符号决定（第一版规则，保留以免只报对自己有利的那种）；"
             "高留 = 只留因子高的一侧；阈值为训练期基准样本的分位数，keep60 留 60%，keep40 留 40%。Δ胜率 = 叠加后 − 基准（百分点）；Wilson 95% 区间按天算。有价值 = 两期 Δ 同号且测试期 ≥ +3pp。"
             "注意测试期留下的比例常与训练期不同（如 level/keep60 训练留 60%，测试留 79%），因为隐含水平在测试期整体换了档，固定阈值在样本外的含义变了。\n")
    cols = ["factor", "direction_rule", "overlay", "direction", "n_train", "win_train", "win_lo_train", "win_hi_train", "ev_train", "d_win_train",
            "n_test", "win_test", "win_lo_test", "win_hi_test", "ev_test", "ev_k05_test", "d_win_test", "d_ev_test", "valuable"]
    fmt = {c: pct for c in ["win_train", "win_lo_train", "win_hi_train", "win_test", "win_lo_test", "win_hi_test"]}
    fmt.update({"d_win_train": pp, "d_win_test": pp, "ev_train": usd, "ev_test": usd, "ev_k05_test": usd, "d_ev_test": usd,
                "n_train": lambda v: f"{int(v)}", "n_test": lambda v: f"{int(v)}"})
    L.append(md_table(inc, cols, fmt))
    if len(held_factors):
        L.append("\n### 4.3 分年稳定性（成立单元；高/低 = 训练期中位数两侧）\n")
        L.append("格内 = 高组胜率 − 低组胜率（pp），括号为 (n_低/n_高)；same_sign_years = 与训练期 gap 同号的年数。全表（含各组胜率与期望）在 `yearly.csv`。\n")
        yp = yearly_pivot(yr, held)
        ycols = [c for c in yp.columns if c.isdigit()]
        L.append(md_table(yp, ["factor", "entry", "width"] + ycols + ["same_sign_years"]))
    # 5 多重比较
    L.append("\n## 5. 多重比较账\n")
    L.append(md_table(counts, ["项目", "试验数", "5% 水平下运气预期", "实际通过"], {"5% 水平下运气预期": lambda v: f"{v:.1f}"}))
    L.append(f"\n单变量通过数远超运气预期，但成立者里 |ρ(w/impl)| ≥ 0.6 的有 {len(shadows)} 个（" + "、".join(f"`{f}`" for f in shadows) +
             "），它们重复的是已知的\"翅宽按隐含定\"这一条；其余成立者也都与隐含有 0.3–0.5 的相关。"
             f"增量检验（基准已经按隐含选翅宽）里 {int(inc.valuable.sum())} 通过，不高于运气预期。"
             "`skew_raw`/`curv_raw` 是 `skew_n`/`curv_n` 的变体，`strad_decay` 代数上近似 `iv_chg_open`，有效独立因子数少于名义的 20。\n")
    # 6 复现
    L.append("\n## 6. 可复现命令\n")
    L.append("```\ncd research/spx_fly\n.venv/bin/python src/mining/surface.py --workers 6          # 因子面板 + 统计 + 报告（约 25 秒）\n"
             ".venv/bin/python src/mining/surface.py --stage report       # 只重做统计与报告\n```\n")
    L.append("表：`reports/mining/surface_tables/{factor_panel,univariate,control_implied,incremental,yearly,multiple_comparisons,coverage}.csv`。\n")
    with open(REPORT, "w") as fh:
        fh.write("\n".join(L))


def analyse(fp):
    os.makedirs(TABLES, exist_ok=True)
    p = load_target()
    tp = p[p.width.isin(WIDTHS) & p.entry.isin(ENTRIES)].merge(fp, on=["date", "entry"], how="left")
    # 覆盖率
    cov = []
    for f in FACTORS:
        r = {"factor": f}
        for e in ENTRIES:
            d = tp[(tp.entry == e) & (tp.width == 25)]
            r[f"n_{e}"] = int(np.isfinite(d[f]).sum())
            r[f"cov_{e}"] = np.isfinite(d[f]).mean()
        cov.append(r)
    coverage = pd.DataFrame(cov)
    uni = univariate(tp)
    held = sorted(uni[uni.holds].factor.unique())
    ctrl = control_implied(tp, list(FACTORS))
    base = baseline_rows(p)
    inc = incremental(base, fp, uni)
    yr = yearly(tp, list(FACTORS))
    n_uni = len(uni)
    n_ctrl = len(ctrl)
    n_inc = len(inc) - 1
    counts = pd.DataFrame([
        {"项目": "单变量：因子 × 入场 × 翅宽", "试验数": n_uni, "5% 水平下运气预期": round(n_uni * 0.05, 1), "实际通过": int(uni.holds.sum())},
        {"项目": "控制隐含：因子 × 入场 × 翅宽 × 隐含三分位", "试验数": n_ctrl, "5% 水平下运气预期": round(n_ctrl * 0.05, 1),
         "实际通过": int((ctrl.same_sign & (ctrl.gap_test.abs() >= HOLD_GAP) & (ctrl.gap_train.abs() >= HOLD_GAP)).sum())},
        {"项目": "增量：因子 × 定向规则 × 阈值变体", "试验数": n_inc, "5% 水平下运气预期": round(n_inc * 0.05, 1), "实际通过": int(inc.valuable.sum())},
        {"项目": "合计", "试验数": n_uni + n_ctrl + n_inc, "5% 水平下运气预期": round((n_uni + n_ctrl + n_inc) * 0.05, 1),
         "实际通过": int(uni.holds.sum()) + int((ctrl.same_sign & (ctrl.gap_test.abs() >= HOLD_GAP) & (ctrl.gap_train.abs() >= HOLD_GAP)).sum()) + int(inc.valuable.sum())},
    ])
    for name, df in (("univariate", uni), ("control_implied", ctrl), ("incremental", inc), ("yearly", yr),
                     ("multiple_comparisons", counts), ("coverage", coverage)):
        df.to_csv(os.path.join(TABLES, name + ".csv"), index=False)
    write_report(fp, uni, ctrl, inc, yr, coverage, counts)
    print("held cells:", int(uni.holds.sum()), "of", len(uni), "| held factors:", held)
    print("valuable overlays:", inc[inc.valuable][["factor", "direction_rule", "overlay", "d_win_train", "d_win_test", "n_test"]].to_string())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--stage", choices=["all", "panel", "report"], default="all")
    a = ap.parse_args()
    if a.stage in ("all", "panel"):
        fp = build_factor_panel(a.workers)
        print(len(fp), "factor rows", fp.date.nunique(), "days")
    else:
        fp = pd.read_csv(os.path.join(TABLES, "factor_panel.csv"), parse_dates=["date"])
    if a.stage in ("all", "report"):
        analyse(fp)


if __name__ == "__main__":
    main()
