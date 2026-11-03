"""V-0005 analysis. Called via V-0005_center.py analyze --period train|test. Reads only <period>_days.parquet."""
import os
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0005_tables")
SEED = 5005
NB = 5000
# fixed from TRAINING (written here before the test run; see V-0005.md pre-registration)
WIDE_PUT_SPREAD_F10 = 2.0   # fixed from TRAINING (16 of 539 base days)
SKEW_CUTS = [0.0338, 0.0756]   # fixed from TRAINING base-day terciles


def boot(v, n=NB, seed=SEED):
    v = np.asarray(v, float); v = v[np.isfinite(v)]
    if len(v) == 0:
        return np.nan, np.nan, np.nan
    rng = np.random.default_rng(seed)
    m = v[rng.integers(0, len(v), (n, len(v)))].mean(1)
    return v.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5)


def signflip_p(v, n=NB, seed=SEED):
    """one-sided p for mean > 0 under H0: daily paired difference symmetric about 0"""
    v = np.asarray(v, float); v = v[np.isfinite(v)]
    rng = np.random.default_rng(seed)
    s = rng.choice([-1.0, 1.0], (n, len(v)))
    null = (s * v).mean(1)
    return (1 + (null >= v.mean()).sum()) / (n + 1)


def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return 100 * (c - h), 100 * (c + h)


def maxdd(p):
    c = np.cumsum(np.asarray(p, float)); peak = np.maximum.accumulate(np.concatenate([[0], c]))[1:]
    return float((c - peak).min())


def pnl(D, nm, k=0.20, suf="", minleg=True, wcol="w"):
    pay = np.maximum(0, D[wcol] - (D.settle - D[f"k_{nm}" if not nm.startswith("F") else f"k{nm[0]}_{nm[1:]}"]).abs())
    fee = D[f"fee{'' if minleg else '_nomin'}_{nm}{suf}"]
    return (pay - D[f"mid_{nm}{suf}"] - k * D[f"H_{nm}{suf}"]) * 100 - fee


def ystr(d):
    if d < pd.Timestamp("2024-11-01"):
        return str(d.year)
    return "2024-11~12" if d.year == 2024 else str(d.year)


def summ(p):
    p = np.asarray(p, float); n = len(p); k = int((p > 0).sum())
    lo, hi = wilson(k, n); m, blo, bhi = boot(p)
    return {"n": n, "win": round(100 * k / n, 1), "w_lo": round(lo, 1), "w_hi": round(hi, 1),
            "ev": round(m, 1), "ev_lo": round(blo, 1), "ev_hi": round(bhi, 1), "maxdd": round(maxdd(p), 0)}


def m1(G, fq="FQ_cummax", anchor="F"):
    out = {}
    for x, tag in ((0, "0"), (-5, "m5"), (5, "p5")):
        if anchor == "F":
            ind = (G.settle > G.F + x).astype(float); q = 1 - G[f"{fq}_{tag}"]
        else:
            if x != 0:
                continue
            ind = (G.settle > G.s0).astype(float); q = 1 - G[f"{fq}_s0"]
        v = ((ind - q) * 100).dropna()
        m, lo, hi = boot(v)
        out[f"M1_{tag}"] = (round(m, 2), round(lo, 2), round(hi, 2), len(v), round(100 * ind[v.index].mean(), 1), round(100 * q[v.index].mean(), 1))
    return out


def analyze(period):
    D = pd.read_parquet(os.path.join(OUT, f"{period}_days.parquet"))
    L = []
    def log(*a):
        s = " ".join(str(x) for x in a); print(s); L.append(s)
    E = D[D.entry == "14:00"].copy()
    E["year"] = E.date.map(ystr)
    allp = E[["mid_near", "mid_up", "mid_dn"]].notna().all(1)
    log(f"== {period}: 14:00 days {len(E)}, all three flies priced {allp.sum()}")
    E = E[allp].copy()
    B = E[E.spx_ret_prev > -0.01].copy()
    log(f"base-A days (prev > -1%): {len(B)}")
    for nm in ("near", "up", "dn"):
        B[f"p_{nm}"] = pnl(B, nm); B[f"p_{nm}_k05"] = pnl(B, nm, 0.5)
        B[f"p_{nm}_led"] = pnl(B, nm, 0.25, minleg=False)
    B["dU"] = B.p_up - B.p_near; B["dD"] = B.p_dn - B.p_near
    B["dU_k05"] = B.p_up_k05 - B.p_near_k05; B["dD_k05"] = B.p_dn_k05 - B.p_near_k05
    B["chU"] = B.k_up != B.k_near; B["chD"] = B.k_dn != B.k_near

    rows = []
    for lab, col in (("near(base)", "p_near"), ("U", "p_up"), ("D", "p_dn"), ("near k0.5", "p_near_k05"), ("U k0.5", "p_up_k05"),
                     ("near ledger k0.25 nomin", "p_near_led"), ("U ledger k0.25 nomin", "p_up_led")):
        rows.append({"series": lab, **summ(B[col])})
    S = pd.DataFrame(rows); log("\n== strategy summaries (base-A days)"); log(S.to_string(index=False))
    S.to_csv(os.path.join(OUT, f"{period}_summary.csv"), index=False)

    rows = []
    for col, ch in (("dU", "chU"), ("dD", "chD"), ("dU_k05", "chU"), ("dD_k05", "chD")):
        for y, g in [("all", B)] + list(B.groupby("year")):
            m, lo, hi = boot(g[col]); gc = g[g[ch]]; mc, lc, hc = boot(gc[col])
            rows.append({"delta": col, "year": y, "n": len(g), "n_ch": len(gc), "per_day": round(m, 1), "lo": round(lo, 1), "hi": round(hi, 1),
                         "per_ch": round(mc, 1), "lo_ch": round(lc, 1), "hi_ch": round(hc, 1), "sd_ch": round(gc[col].std(), 0),
                         "signflip_p": round(signflip_p(g[col]), 4) if y == "all" else np.nan})
    Dl = pd.DataFrame(rows); log("\n== Delta vs near, $/day"); log(Dl.to_string(index=False))
    Dl.to_csv(os.path.join(OUT, f"{period}_delta.csv"), index=False)
    # win-rate increment (U - base), paired
    dw = (B.p_up > 0).astype(float) - (B.p_near > 0).astype(float)
    m, lo, hi = boot(dw * 100)
    log(f"win increment U-base: {m:+.2f}pp [{lo:+.2f},{hi:+.2f}], signflip p {signflip_p(dw):.4f}")
    log(f"maxDD of cumulative dU: {maxdd(B.dU):.0f}")
    by = B.groupby("year").apply(lambda g: pd.Series({"n": len(g), "win_near": 100 * (g.p_near > 0).mean(), "ev_near": g.p_near.mean(),
                                                       "win_U": 100 * (g.p_up > 0).mean(), "ev_U": g.p_up.mean(), "dU": g.dU.mean(), "dD": g.dD.mean()})).round(1)
    log(by.to_string()); by.to_csv(os.path.join(OUT, f"{period}_by_year.csv"))

    # M1
    rows = []
    variants = [("cummax@F (primary)", B, "FQ_cummax", "F"), ("pava@F", B, "FQ_pava", "F"), ("call-vertical pava@F", B, "FQ_call", "F"),
                ("cummax@s0", B, "FQ_cummax", "s0"), ("cummax@F, all 14:00 days", E, "FQ_cummax", "F"),
                ("cummax@F, excl FOMC", B[~B.fomc], "FQ_cummax", "F")]
    if WIDE_PUT_SPREAD_F10 is not None:
        variants.append((f"cummax@F, excl max put spread F+-10 > {WIDE_PUT_SPREAD_F10}", B[B.max_put_spread_F10 <= WIDE_PUT_SPREAD_F10], "FQ_cummax", "F"))
        variants.append((f"pava@F, excl wide", B[B.max_put_spread_F10 <= WIDE_PUT_SPREAD_F10], "FQ_pava", "F"))
    for lab, G, fq, an in variants:
        for k, v in m1(G, fq, an).items():
            rows.append({"variant": lab, "year": "all", "pt": k, "M1": v[0], "lo": v[1], "hi": v[2], "n": v[3], "P": v[4], "Q": v[5]})
        if an == "F" and lab.startswith(("cummax@F (primary)", "pava@F")):
            for y, g in G.groupby("year"):
                v = m1(g, fq, an)["M1_0"]
                rows.append({"variant": lab, "year": y, "pt": "M1_0", "M1": v[0], "lo": v[1], "hi": v[2], "n": v[3], "P": v[4], "Q": v[5]})
    M = pd.DataFrame(rows); log("\n== M1 (pp)"); log(M.to_string(index=False)); M.to_csv(os.path.join(OUT, f"{period}_m1.csv"), index=False)
    d_fq = (B.FQ_cummax_0 - B.FQ_pava_0) * 100
    log(f"FQ(F) cummax - pava, pp: mean {d_fq.mean():+.2f}, median {d_fq.median():+.2f}, p90 {d_fq.quantile(.9):+.2f}, max {d_fq.max():+.2f}; days with nonmono near F: {(B.n_nonmono>0).mean():.2%}")
    log(f"max put spread F+-10: p50 {B.max_put_spread_F10.median():.2f} p90 {B.max_put_spread_F10.quantile(.9):.2f} p99 {B.max_put_spread_F10.quantile(.99):.2f}")

    # drift + down months
    log("\n== drift context settle - F (points), base-A days, mean / median")
    log(B.assign(dr=B.settle - B.F).groupby("year").dr.agg(["mean", "median"]).round(2).to_string())

    # robustness
    rows = []
    def add(lab, v):
        m, lo, hi = boot(v); rows.append({"check": lab, "n": int(np.isfinite(v).sum()), "dU": round(m, 1), "lo": round(lo, 1), "hi": round(hi, 1)})
    add("primary dU", B.dU.values)
    add("k 0.5", B.dU_k05.values)
    srt = B.dU.sort_values(); add("drop best 5 dU days", srt.iloc[:-5].values)
    add("drop best 5 by p_up", B.drop(B.p_up.nlargest(5).index).dU.values)
    BF = B.dropna(subset=["mid_Fup", "mid_Fnear"]).copy()
    BF["pFu"] = pnl(BF, "Fup"); BF["pFn"] = pnl(BF, "Fnear")
    add("center by F: Fup - Fnear", (BF.pFu - BF.pFn).values)
    add("center by F: Fup - near(spot)", (BF.pFu - BF.p_near).values)
    for tag in ("w15", "w25"):
        G = B.dropna(subset=[f"mid_near_{tag}", f"mid_up_{tag}", f"mid_dn_{tag}"]).copy()
        pu = pnl(G, "up", suf=f"_{tag}", wcol=f"w_{tag}"); pn = pnl(G, "near", suf=f"_{tag}", wcol=f"w_{tag}"); pd_ = pnl(G, "dn", suf=f"_{tag}", wcol=f"w_{tag}")
        add(f"width target {tag[1]}.{tag[2]}: dU", (pu - pn).values); add(f"width target {tag[1]}.{tag[2]}: dD", (pd_ - pn).values)
    for ent in ("13:30", "14:30"):
        G = D[(D.entry == ent) & (D.spx_ret_prev > -0.01)].dropna(subset=["mid_near", "mid_up", "mid_dn"]).copy()
        add(f"entry {ent}: dU", (pnl(G, "up") - pnl(G, "near")).values); add(f"entry {ent}: dD", (pnl(G, "dn") - pnl(G, "near")).values)
    add("excl FOMC dU", B[~B.fomc].dU.values)
    if WIDE_PUT_SPREAD_F10 is not None:
        add("excl wide-quote days dU", B[B.max_put_spread_F10 <= WIDE_PUT_SPREAD_F10].dU.values)
    Rb = pd.DataFrame(rows); log("\n== robustness (dU $/day unless noted)"); log(Rb.to_string(index=False)); Rb.to_csv(os.path.join(OUT, f"{period}_robust.csv"), index=False)

    # skew terciles
    B["sk"] = (B.qmed_cummax - B.F) / B.I
    cuts = SKEW_CUTS if SKEW_CUTS is not None else list(B.sk.quantile([1/3, 2/3]).values)
    log(f"\nskew cuts {np.round(cuts, 4)} ({'fixed from train' if SKEW_CUTS is not None else 'computed here (train)'})")
    B["skt"] = pd.cut(B.sk, [-np.inf, *cuts, np.inf], labels=["low", "mid", "high"])
    T = B.groupby("skt", observed=True).apply(lambda g: pd.Series({"n": len(g), "dU": g.dU.mean(), "dD": g.dD.mean(),
        "M1": ((g.settle > g.F).astype(float) - (1 - g.FQ_cummax_0)).mean() * 100})).round(1)
    log(T.to_string()); T.to_csv(os.path.join(OUT, f"{period}_skew.csv"))

    # down months (mechanical): calendar months whose settle-to-settle return (last day of prev month in-period -> last day) < 0
    B["ym"] = B.date.dt.to_period("M")
    mret = B.groupby("ym").settle.last().pct_change()
    first = B.groupby("ym").settle.first()
    mret.iloc[0] = B.groupby("ym").settle.last().iloc[0] / first.iloc[0] - 1
    down = mret[mret < 0].index
    G = B[B.ym.isin(down)]
    v = m1(G)["M1_0"]; m, lo, hi = boot(G.dU)
    log(f"\n== down months ({len(down)}: {[str(x) for x in down]}), n {len(G)}: M1 {v[0]:+.2f} [{v[1]:+.2f},{v[2]:+.2f}], dU {m:+.1f} [{lo:+.1f},{hi:+.1f}]")

    B.to_parquet(os.path.join(OUT, f"{period}_base.parquet"), index=False)
    open(os.path.join(OUT, f"{period}_log.txt"), "w").write("\n".join(L) + "\n")
