"""V-0010: independent light audit of P-0010 (short 1DTE SPXW iron fly at D close held to N settle).
TRAINING PERIOD ONLY (D < 2024-11-01 and N < 2024-11-01). Does not import proposer code.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0010_audit.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0010_tables")
WALL = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < WALL]                                      # TIME WALL, first step
edge = pd.read_parquet(f"{R}/data/clean/edge_panel.parquet")
edge = edge[edge.date < WALL]                                    # TIME WALL, first step
fills = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]


def fee_leg(px):
    com = next(t["fee"] for t in fills["commission"] if px < float(t["below"]))
    exc = next(t["fee"] for t in fills["exchange"] if px < float(t["below"]))
    return max(com, fills["commission_min_per_leg"]) + exc + fills["execution_surcharge"] + fills["regulatory_clearing"]


td = list(cal.index)
PAIRS = [(td[i], td[i + 1]) for i in range(len(td) - 1)]       # both < WALL by construction


def night(p):
    D, N = p
    f = f"{R}/data/raw/SPXW/greeks_eod/{D:%Y}/{D:%Y%m%d}.csv.gz"
    if not os.path.exists(f):
        return dict(D=D, N=N, why="nofile")
    q = pd.read_csv(f, usecols=["expiration", "strike", "right", "bid", "ask", "bid_size", "ask_size",
                                "close", "volume", "underlying_price"])
    q = q[pd.to_datetime(q.expiration) == N]                     # only the N expiry (N < WALL)
    if q.empty:
        return dict(D=D, N=N, why="noexp")
    q["m"] = (q.bid + q.ask) / 2
    C = q[q.right == "CALL"].set_index("strike"); Pt = q[q.right == "PUT"].set_index("strike")
    ks = np.array(sorted(set(C.index) & set(Pt.index)))
    U = float(q.underlying_price.iloc[0])
    near = ks[np.argsort(np.abs(ks - U), kind="stable")[:5]]
    F = float(np.median([k + C.at[k, "m"] - Pt.at[k, "m"] for k in near]))
    near10 = ks[np.argsort(np.abs(ks - U), kind="stable")[:10]]
    F10 = float(np.median([k + C.at[k, "m"] - Pt.at[k, "m"] for k in near10]))
    d = np.abs(ks - F); K = float(ks[np.where(d <= d.min() + 1e-9)[0][0]])   # ties -> lower
    I = float(C.at[K, "m"] + Pt.at[K, "m"])
    grid = np.arange(10, 2000, 5); g = np.abs(grid - 2 * I); w = int(grid[np.where(g <= g.min() + 1e-9)[0][0]])
    o = dict(D=D, N=N, why="", U=U, F=F, F10=F10, K=K, I=I, w=w,
             cspr=float(C.at[K, "ask"] - C.at[K, "bid"]), pspr=float(Pt.at[K, "ask"] - Pt.at[K, "bid"]),
             c_last=float(C.at[K, "close"]), p_last=float(Pt.at[K, "close"]),
             c_vol=int(C.at[K, "volume"]), p_vol=int(Pt.at[K, "volume"]),
             c_m=float(C.at[K, "m"]), p_m=float(Pt.at[K, "m"]),
             c_imb=float((C.at[K, "bid_size"] - C.at[K, "ask_size"]) / max(C.at[K, "bid_size"] + C.at[K, "ask_size"], 1)),
             p_imb=float((Pt.at[K, "bid_size"] - Pt.at[K, "ask_size"]) / max(Pt.at[K, "bid_size"] + Pt.at[K, "ask_size"], 1)))
    legs = [(C, K, -1), (Pt, K, -1), (C, K + w, +1), (Pt, K - w, +1)]
    qs = []
    for t, k, s in legs:
        if k not in t.index:
            o["why"] = "missing"; return o
        b, a = float(t.at[k, "bid"]), float(t.at[k, "ask"])
        if a <= 0 or (s < 0 and b <= 0) or a - b > 2.0:
            o["why"] = "quote"; return o
        qs.append((b, a, s))
    o["wing_mid"] = sum((b + a) / 2 for b, a, s in qs if s > 0)
    for kk in (0.0, 0.2, 0.5):
        cash = sum(-s * ((b + a) / 2 + s * kk * (a - b) / 2) for b, a, s in qs) * 100
        fee = sum(fee_leg((b + a) / 2 + s * kk * (a - b) / 2) for b, a, s in qs)
        o[f"cr{kk}"] = cash; o["fee"] = fee
    return o


def boot(v, B=10000, seed=1):
    v = np.asarray(v, float); r = np.random.default_rng(seed)
    m = v[r.integers(0, len(v), (B, len(v)))].mean(1)
    return v.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5)


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        n = pd.DataFrame(list(ex.map(night, PAIRS)))
    n = n[(n.D < WALL) & (n.N < WALL)]                           # TIME WALL on output
    print("pairs", len(n), n.why.value_counts().to_dict())
    n["half"] = n.D.map(cal.half_day).astype(bool) | n.N.map(cal.half_day).astype(bool)
    n["settle"] = n.N.map(cal.settle); n["closeD"] = n.D.map(cal.settle)
    e0 = edge[edge.entry == "09:35"].set_index("date")
    n["S0"] = n.N.map(e0.spot); n["I0"] = n.N.map(e0.implied); n["x_day"] = n.N.map(e0.ratio)
    n.to_csv(f"{OUT}/nights_all.csv", index=False)
    r = n[(n.why == "") & ~n.half & n.x_day.notna()].copy()
    L = []
    def p(*a):
        s = " ".join(str(x) for x in a); print(s); L.append(s)
    r["wk"] = (r.N - r.D).dt.days >= 2
    r["owed"] = np.minimum((r.settle - r.K).abs(), r.w)
    for kk in (0.0, 0.2, 0.5):
        r[f"pnl{kk}"] = r[f"cr{kk}"] - 100 * r.owed - r.fee
    r["x_full"] = (r.settle - r.F).abs() / r.I
    r["dx"] = r.x_full - r.x_day
    r["strad"] = 100 * (r.I - (r.settle - r.K).abs())
    r["imp_on"] = np.sqrt(np.clip((r.I / r.F) ** 2 - (r.I0 / r.S0) ** 2, 0, None)) * r.F
    r["sprr"] = (r.cspr + r.pspr) / r.I
    r["gap"] = r.F - r.U; r["gapC"] = r.F - r.closeD
    p("U vs official close: max |U - calendar.settle[D]|", round((r.U - r.closeD).abs().max(), 3))
    p("n", len(r), "1-night", int((~r.wk).sum()), "weekend", int(r.wk.sum()))
    p("P", np.round(boot(r.dx), 4))
    p("x_full", round(r.x_full.mean(), 4), "x_day", round(r.x_day.mean(), 4))
    srl = ((r.S0 - r.F) / r.F) ** 2; srt = ((r.settle - r.F) / r.F) ** 2
    it = (r.I / r.F) ** 2; io = it - (r.I0 / r.S0) ** 2
    s_real, s_imp = srl.sum() / srt.sum(), io.sum() / it.sum()
    rg = np.random.default_rng(2); bs = []
    for _ in range(4000):
        i = rg.integers(0, len(r), len(r)); bs.append(srl.iloc[i].sum() / srt.iloc[i].sum() - io.iloc[i].sum() / it.iloc[i].sum())
    p("s_real", round(s_real, 4), "s_imp", round(s_imp, 4), "diff", round(s_real - s_imp, 4), np.round(np.percentile(bs, [2.5, 97.5]), 4))
    p("pnl k0.2", np.round(boot(r["pnl0.2"]), 1), "k0", round(r["pnl0.0"].mean(), 1), "k0.5", round(r["pnl0.5"].mean(), 1),
      "win", round((r["pnl0.2"] > 0).mean(), 3), "fee", round(r.fee.mean(), 2))
    for y, g in r.groupby(r.D.dt.year):
        p(f"  year {y}: n {len(g)} P {g.dx.mean():+.3f} pnl {g['pnl0.2'].mean():+.1f}")
    # ---- item 3: quote-artifact check in spread/I halves
    p("\n# item 3: spread/I halves")
    med = r.sprr.median(); r["hi"] = r.sprr > med
    r["it"] = pd.qcut(r.I / r.F, 3, labels=False)
    r["s_ratio"] = (r.I0 / r.S0) ** 2 / (r.I / r.F) ** 2        # implied share left for N's day session
    r["xon"] = (r.S0 - r.F).abs() / r.imp_on.where(r.imp_on > 0)
    r["mid_minus_last"] = (r.c_m - r.c_last).where(r.c_vol > 0)
    r["mid_minus_last_p"] = (r.p_m - r.p_last).where(r.p_vol > 0)
    r["imb"] = (r.c_imb + r.p_imb) / 2
    r["spr_abs"] = r.cspr + r.pspr
    r["gap10"] = r.F - r.F10
    for h, g in r.groupby("hi"):
        p(f"hi={h}: n {len(g)} P {g.dx.mean():+.3f} x_full {g.x_full.mean():.3f} x_day {g.x_day.mean():.3f} "
          f"I/F {100*(g.I/g.F).median():.3f}% spr_abs med {g.spr_abs.median():.2f} "
          f"F-U mean {g.gap.mean():+.2f} med|F-U| {g.gap.abs().median():.2f} F5-F10 med|.| {g.gap10.abs().median():.3f} "
          f"impl day share {g.s_ratio.median():.3f} x_on mean {(g.S0-g.F).abs().mean()/g.imp_on[g.imp_on>0].mean():.3f} "
          f"x_day med {g.x_day.median():.3f} x_full med {g.x_full.median():.3f} "
          f"C mid-last med {g.mid_minus_last.median():+.3f} P mid-last med {g.mid_minus_last_p.median():+.3f} "
          f"size imb mean {g.imb.mean():+.3f} years {g.D.dt.year.value_counts().sort_index().to_dict()} "
          f"weekend share {g.wk.mean():.2f} pnl {g['pnl0.2'].mean():+.1f}")
    p("spearman(sprr, I/F)", round(r.sprr.corr(r.I / r.F, method="spearman"), 3))
    p("P by I/F tercile x spread half (n, P):")
    for (t, h), g in r.groupby(["it", "hi"]):
        p(f"  I tercile {t} hi={h}: n {len(g)} P {g.dx.mean():+.3f} x_full {g.x_full.mean():.3f} x_day {g.x_day.mean():.3f}")
    # absolute spread halves within I terciles (spread not scaled by I)
    r["hi_abs"] = r.groupby("it").spr_abs.transform(lambda s: s > s.median())
    for h, g in r.groupby("hi_abs"):
        p(f"abs-spread half (within I tercile) hi={h}: n {len(g)} P {g.dx.mean():+.3f} [{boot(g.dx)[1]:+.3f},{boot(g.dx)[2]:+.3f}]")
    # replace F with the 16:00 close and with F10 as the centre for x_full
    for name, c in (("F (spec)", r.F), ("16:00 close", r.closeD), ("F10", r.F10)):
        xf = (r.settle - c).abs() / r.I
        p(f"centre {name}: P all {np.mean(xf - r.x_day):+.3f} hi {np.mean((xf - r.x_day)[r.hi]):+.3f} lo {np.mean((xf - r.x_day)[~r.hi]):+.3f}")
    # ---- item 4: weekend / Monday
    p("\n# item 4: weekend / Monday (training)")
    wk, on = r[r.wk], r[~r.wk]
    p(f"x_day weekend(Mon session) mean {wk.x_day.mean():.3f} med {wk.x_day.median():.3f} n {len(wk)} | other {on.x_day.mean():.3f} med {on.x_day.median():.3f} n {len(on)}")
    d = wk.x_day.mean() - on.x_day.mean(); se = np.sqrt(wk.x_day.var() / len(wk) + on.x_day.var() / len(on))
    p(f"diff {d:+.3f} se {se:.3f} z {d/se:.2f}")
    for name, g in (("weekend", wk), ("1-night", on)):
        h = g[g.imp_on > 0]
        p(f"{name}: x_on {(h.S0-h.F).abs().mean()/h.imp_on.mean():.3f} med {h.xon.median():.3f} (n {len(h)}) "
          f"strad mid $ {g.strad.mean():+.1f} [{boot(g.strad)[1]:+.0f},{boot(g.strad)[2]:+.0f}] med {g.strad.median():+.0f} win {(g.strad>0).mean():.3f} "
          f"fly k0.2 {g['pnl0.2'].mean():+.1f}")
    # drop best 5 / by year
    p("weekend robustness:")
    p(f"  x_day weekend drop 5 lowest: {wk.x_day.drop(wk.x_day.nsmallest(5).index).mean():.3f}; drop 10 lowest {wk.x_day.drop(wk.x_day.nsmallest(10).index).mean():.3f}")
    p(f"  strad weekend drop best 5: {wk.strad.drop(wk.strad.nlargest(5).index).mean():+.1f}; drop best 10 {wk.strad.drop(wk.strad.nlargest(10).index).mean():+.1f}; "
      f"1-night drop best 5 {on.strad.drop(on.strad.nlargest(5).index).mean():+.1f}")
    hw = wk[wk.imp_on > 0]; hw = hw.drop(hw.xon.nsmallest(5).index)
    p(f"  x_on weekend drop 5 smallest: {(hw.S0-hw.F).abs().mean()/hw.imp_on.mean():.3f}")
    p(f"  max single-night weekend straddle share of total: {wk.strad.max()/wk.strad.sum():.3f}; top5 share {wk.strad.nlargest(5).sum()/wk.strad.sum():.3f}")
    for y in sorted(r.D.dt.year.unique()):
        a, b = wk[wk.D.dt.year == y], on[on.D.dt.year == y]
        ha = a[a.imp_on > 0]; hb = b[b.imp_on > 0]
        p(f"  {y}: wk n {len(a)} x_day {a.x_day.mean():.3f} x_on {(ha.S0-ha.F).abs().mean()/ha.imp_on.mean():.3f} strad {a.strad.mean():+.0f} "
          f"| 1n n {len(b)} x_day {b.x_day.mean():.3f} x_on {(hb.S0-hb.F).abs().mean()/hb.imp_on.mean():.3f} strad {b.strad.mean():+.0f}")
    # same weekday x_day across all training days in edge_panel (not only paired sample), several entries
    p("x_day by day-after-weekend, all training edge_panel rows (not just paired):")
    ed = edge[edge.date.isin(cal.index[~cal.half_day])].copy()
    prev = pd.Series(cal.index, index=cal.index).shift(1)
    ed["gapd"] = (ed.date - ed.date.map(prev)).dt.days
    ed["aw"] = ed.gapd >= 2
    for en, g in ed.groupby("entry"):
        a, b = g[g.aw], g[~g.aw]
        p(f"  {en}: after-weekend n {len(a)} ratio {a.ratio.mean():.3f} med {a.ratio.median():.3f} | other n {len(b)} {b.ratio.mean():.3f} med {b.ratio.median():.3f}")
    # rank test for x_day weekend vs other
    from scipy.stats import mannwhitneyu
    p("Mann-Whitney x_day weekend vs other p", round(mannwhitneyu(wk.x_day, on.x_day).pvalue, 4))
    r.to_csv(f"{OUT}/nights.csv", index=False)
    open(f"{OUT}/summary.txt", "w").write("\n".join(L) + "\n")
