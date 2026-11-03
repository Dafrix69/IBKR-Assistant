"""V-0006: independent training-period audit of P-0006 (14:00 iron fly vs iron condor by FE tercile).
TRAINING PERIOD ONLY (date < 2024-11-01). Test-period chain files are never opened.
Written from the data dictionary (research/spx_fly/reports/mining/BRIEF.md) and config.yaml fills;
does not import or run proposer code.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0006_shape.py
Step 1 builds per-day quotes/payoffs (cache days.parquet), step 2 prints the audit tables to log.txt.
"""
import os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0006_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                                   # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END].set_index("ts")                   # TIME WALL
vix = pd.read_parquet(f"{R}/data/tws/vix_1d.parquet")
vix = vix[pd.to_datetime(vix.date) < TRAIN_END]                    # TIME WALL
vix = pd.Series(vix.vix_close.values, index=pd.to_datetime(vix.date)).sort_index()

FL = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]
COMM = [(float(x["below"]), x["fee"]) for x in FL["commission"]]
EXCH = [(float(x["below"]), x["fee"]) for x in FL["exchange"]]
SUR, REG, MINLEG, MULT = FL["execution_surcharge"], FL["regulatory_clearing"], FL["commission_min_per_leg"], FL["multiplier"]
WIDTHS = [20, 25, 30, 50, 75]
CAP = 3.0


def fee(px, n):
    c = next(f for b, f in COMM if px < b)
    e = next(f for b, f in EXCH if px < b)
    return max(c * n, MINLEG) + n * (e + SUR + REG)


def payoff(k, r, s):
    return max(s - k, 0.0) if r == "C" else max(k - s, 0.0)


def pnl(legs, Q, st, kf):
    """legs (strike,right,+1 buy/-1 sell,qty); fill = mid + side*kf*half-spread per leg NBBO."""
    tot = 0.0
    for k, r, sd, n in legs:
        b, a = Q[(k, r)]
        px = (b + a) / 2 + sd * kf * (a - b) / 2
        tot += sd * n * (payoff(k, r, st) - px) * MULT - (fee(px, n) if kf is not None else 0)
    return tot


def mid_pnl(legs, Q, st):
    return sum(sd * n * (payoff(k, r, st) - (Q[(k, r)][0] + Q[(k, r)][1]) / 2) * MULT for k, r, sd, n in legs)


def day(d):
    if d >= TRAIN_END:
        return None
    rec = {"date": d}
    t = pd.Timestamp(f"{d:%Y-%m-%d} 14:00")
    if t not in spot.index:
        rec["drop"] = "nospot"; return rec
    S = float(spot.loc[t, "spot"]); F = float(spot.loc[t, "parity_F"])
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        rec["drop"] = "nochain"; return rec
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    ch = ch[(ch.ts == t) & (~ch.flag_bad)]
    Q = {(float(k), r): (float(b), float(a)) for k, r, b, a in zip(ch.strike, ch.right, ch.bid, ch.ask)}
    both = sorted({k for k, r in Q if (k, "C") in Q and (k, "P") in Q})
    allk = sorted({k for k, _ in Q})
    if not both:
        rec["drop"] = "noatm"; return rec
    K = min(both, key=lambda k: (abs(k - S), k))
    Kall = min(allk, key=lambda k: (abs(k - S), k))
    rec["atm_onesided"] = K != Kall
    mid = lambda x: (Q[x][0] + Q[x][1]) / 2
    I = mid((K, "C")) + mid((K, "P"))
    dist = [abs(w / I - 2) for w in WIDTHS]
    w = WIDTHS[int(np.argmin(dist))]
    rec["w_tie"] = sorted(dist)[0] == sorted(dist)[1]
    st = float(cal.loc[d, "settle"])
    vp = vix[vix.index < d]
    rec.update(S=S, F=F, K=K, I=I, w=w, w_over_I=w / I, settle=st, vix_prev=float(vp.iloc[-1]),
               FE=(I / S) / (float(vp.iloc[-1]) / 100))
    ific = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C"), (K - 5, "P"), (K + 5, "C")]
    pf_itm = (K + w, "P")
    if any(x not in Q for x in ific + [pf_itm]):
        rec["drop"] = "missing"
        if any(x not in Q for x in ific):
            return rec
    sp = lambda x: Q[x][1] - Q[x][0]
    rec["wide_ific"] = max(sp(x) for x in ific) > CAP
    rec["wide_pf"] = (pf_itm in Q) and sp(pf_itm) > CAP
    rec.setdefault("drop", "")
    IF = [(K - w, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + w, "C", 1, 1)]
    IC = [(K - w, "P", 1, 1), (K - 5, "P", -1, 1), (K + 5, "C", -1, 1), (K + w, "C", 1, 1)]
    for kf, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
        rec["IF" + tag] = pnl(IF, Q, st, kf)
        rec["IC" + tag] = pnl(IC, Q, st, kf)
    if pf_itm in Q:
        PF = [(K - w, "P", 1, 1), (K, "P", -1, 2), (K + w, "P", 1, 1)]
        rec["PF"] = pnl(PF, Q, st, 0.20)
    # G_b: short ATM iron fly of half-width b at mid (= credit_b - min(|S-K|, b)), USD
    for b in (5, 10, 15, 20):
        legs = [(K - b, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + b, "C", 1, 1)]
        rec[f"G{b}"] = mid_pnl(legs, Q, st) if all((k, r) in Q for k, r, _, _ in legs) else np.nan
        rec[f"cr{b}"] = -mid_pnl(legs, Q, 1e9) / 1 if False else np.nan
        if all((k, r) in Q for k, r, _, _ in legs):
            rec[f"cr{b}"] = (mid((K, "P")) + mid((K, "C")) - mid((K - b, "P")) - mid((K + b, "C")))
    return rec


def build():
    days = [d for d in cal[(~cal.half_day) & cal.has_0dte].index if d < TRAIN_END]
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(day, days) if r]
    df = pd.DataFrame(res)
    assert df.date.max() < TRAIN_END
    df.to_parquet(f"{OUT}/days.parquet")
    return df


rng = np.random.default_rng(6)


def boot(x, n=4000):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    m = rng.choice(x, (n, len(x))).mean(1)
    return np.percentile(m, [2.5, 97.5]).round(1)


def boot_diff(a, b, n=4000):
    a = np.asarray(a, float); b = np.asarray(b, float)
    a = a[~np.isnan(a)]; b = b[~np.isnan(b)]
    m = rng.choice(a, (n, len(a))).mean(1) - rng.choice(b, (n, len(b))).mean(1)
    return np.percentile(m, [2.5, 97.5]).round(1), float((m <= 0).mean())


def analyze(df, mode, seg_labels=None, cuts=None):
    """mode 'main': cap on all 7 legs (spec); 'ific': cap only on IF/IC legs (proposer variant 2)."""
    L = []; P = L.append
    d = df[df["drop"].isin(["", "missing"])].copy()
    d = d.join(cal[["spx_ret_prev", "fomc"]], on="date")
    if mode == "main":
        d = d[(d["drop"] == "") & ~d.wide_ific & ~d.wide_pf.astype(bool)]
    else:
        d = d[~d.wide_ific & d.IF.notna()]
        if "strict" in sys.argv:          # proposer-identical: also drop days where only the PF ITM leg is missing
            d = d[d["drop"] == ""]
    d = d[~(d.spx_ret_prev <= -0.01)]
    q1, q2 = (d.FE.quantile([1 / 3, 2 / 3]) if cuts is None else cuts)
    d["tier"] = np.where(d.FE <= q1, "L", np.where(d.FE <= q2, "M", "H"))
    d["G"] = d.G5; d["dIC"] = d.IC - d.IF; d["dIC_k05"] = d.IC_k05 - d.IF_k05; d["dIC_k0"] = d.IC_k0 - d.IF_k0
    d["year"] = d.date.dt.year; d["ym"] = d.date.dt.to_period("M")
    own = d.groupby("ym").apply(lambda g: (g.settle - g.F).median())
    d["seg_own"] = np.where(d.ym.map(own) > 0, "up", "down")
    if seg_labels is not None:
        d["seg_fixed"] = np.where(d.ym.map(seg_labels) > 0, "up", "down")
    P(f"[{mode}] n={len(d)} cuts q1={q1:.5f} q2={q2:.5f}; drop counts {df['drop'].value_counts().to_dict()}; "
      f"wide_ific {int(df.wide_ific.fillna(False).sum())} wide_pf-only {int((df.wide_pf.fillna(False).astype(bool) & ~df.wide_ific.fillna(False).astype(bool)).sum())}; "
      f"atm_onesided days {int(df.atm_onesided.fillna(False).sum())}; w ties {int(df.w_tie.fillna(False).sum())}")
    P("spearman FE~I %.3f  FE~w/I %.3f" % (d[["FE", "I"]].corr("spearman").iloc[0, 1], d[["FE", "w_over_I"]].corr("spearman").iloc[0, 1]))
    rows = []
    for k in "LMH":
        g = d[d.tier == k]
        rows.append(dict(tier=k, n=len(g), I_med=g.I.median(), G=g.G.mean(), G_ci=boot(g.G), dIC=g.dIC.mean(), dIC_ci=boot(g.dIC),
                         dIC_k05=g.dIC_k05.mean(), dIC_k0=g.dIC_k0.mean(), IF=g.IF.mean(), IC=g.IC.mean(), PF=g.PF.mean(),
                         winIF=(g.IF > 0).mean(), winIC=(g.IC > 0).mean(), body_over_I=(5 / g.I).median()))
    t = pd.DataFrame(rows); P(t.round(2).to_string(index=False))
    ci, p = boot_diff(d[d.tier == "H"].G, d[d.tier == "L"].G)
    P(f"G_H-G_L {d[d.tier=='H'].G.mean()-d[d.tier=='L'].G.mean():.1f} CI {ci} P(<=0) {p:.2f}; Delta_L sd {d[d.tier=='L'].dIC.std():.0f}")
    yr = []
    for y, gy in d.groupby("year"):
        gl, gh = gy[gy.tier == "L"], gy[gy.tier == "H"]
        ci, p = boot_diff(gh.G, gl.G) if len(gl) > 4 and len(gh) > 4 else ((np.nan, np.nan), np.nan)
        yr.append(dict(year=y, nL=len(gl), nM=int((gy.tier == "M").sum()), nH=len(gh), G_L=gl.G.mean(), G_H=gh.G.mean(),
                       GH_GL=gh.G.mean() - gl.G.mean(), ci=ci, p_le0=p, dL=gl.dIC.mean()))
    P("by year:\n" + pd.DataFrame(yr).round(2).to_string(index=False))
    Ld = d[d.tier == "L"]
    for col in ["seg_own"] + (["seg_fixed"] if seg_labels is not None else []):
        s = Ld.groupby(col).agg(n=("dIC", "size"), dIC=("dIC", "mean"), G=("G", "mean"))
        P(f"low tier by {col}:\n" + s.round(1).to_string())
        P(f"G by {col} x tier:\n" + d.groupby([col, "tier"]).G.mean().unstack().reindex(columns=list("LMH")).round(1).to_string())
    wq = d.w_over_I.quantile([1 / 3, 2 / 3]).values
    d["wt"] = np.digitize(d.w_over_I, wq, right=True)
    P("low tier within w/I terciles dIC: " + str(Ld.assign(wt=d.wt).groupby("wt").dIC.mean().round(1).to_dict()))
    return d, (q1, q2), own, L


def diagnostics(d):
    """Level vs shape: (a) within I terciles, FE below/above bin median; (b) body matched in I-units."""
    L = []; P = L.append
    iq = d.I.quantile([1 / 3, 2 / 3]).values
    d = d.copy(); d["Ib"] = np.digitize(d.I, iq, right=True)
    rows = []
    for b, g in d.groupby("Ib"):
        med = g.FE.median(); lo, hi = g[g.FE <= med], g[g.FE > med]
        ci, p = boot_diff(hi.G, lo.G)
        rows.append(dict(Ibin=b, n=len(g), I_med=g.I.median(), FE_rho_I=g[["FE", "I"]].corr("spearman").iloc[0, 1],
                         G_loFE=lo.G.mean(), G_hiFE=hi.G.mean(), diff=hi.G.mean() - lo.G.mean(), ci=ci, p_le0=p,
                         dIC_loFE=lo.dIC.mean(), dIC_hiFE=hi.dIC.mean()))
    P("(a) within I terciles, FE split at bin median (G = 5-wide short-centre at mid, USD):\n" + pd.DataFrame(rows).round(2).to_string(index=False))
    # partial: residualise FE on log I, tercile the residual
    X = np.c_[np.ones(len(d)), np.log(d.I)]
    beta = np.linalg.lstsq(X, np.log(d.FE), rcond=None)[0]
    d["FEres"] = np.log(d.FE) - X @ beta
    r1, r2 = d.FEres.quantile([1 / 3, 2 / 3])
    d["rt"] = np.where(d.FEres <= r1, "L", np.where(d.FEres <= r2, "M", "H"))
    t = d.groupby("rt").agg(n=("G", "size"), I_med=("I", "median"), vix=("vix_prev", "median"), G=("G", "mean"), dIC=("dIC", "mean")).reindex(list("LMH"))
    ci, p = boot_diff(d[d.rt == "H"].G, d[d.rt == "L"].G)
    P(f"(a2) FE residual on log I (=VIX_prev effect at fixed I), terciles:\n{t.round(1).to_string()}\n  G_H-G_L {t.G['H']-t.G['L']:.1f} CI {ci} P(<=0) {p:.2f}")
    P("    by year G_H-G_L (residual tiers): " + str({y: round(g[g.rt=='H'].G.mean() - g[g.rt=='L'].G.mean(), 1) for y, g in d.groupby(d.date.dt.year)}))
    # (b) matched body b = multiple of 5 nearest 0.5*I (min 5, max 20); report G_b / b (fraction of width kept) and G_b/(100*b)
    bsel = np.clip(np.round(0.5 * d.I / 5) * 5, 5, 20).astype(int)
    d["bm"] = bsel
    d["Gm"] = [row[f"G{b}"] for b, (_, row) in zip(bsel, d.iterrows())]
    d["Gm_frac"] = d.Gm / (100 * d.bm)
    d["bm_over_I"] = d.bm / d.I
    t = d.groupby("tier").agg(n=("Gm", "size"), body=("bm", "mean"), body_over_I=("bm_over_I", "median"),
                              Gm=("Gm", "mean"), Gm_frac=("Gm_frac", "mean")).reindex(list("LMH"))
    ci, p = boot_diff(d[d.tier == "H"].Gm_frac, d[d.tier == "L"].Gm_frac)
    P(f"(b) body matched to ~0.5 I (5/10/15/20), by FE tier:\n{t.round(3).to_string()}\n  frac H-L {t.Gm_frac['H']-t.Gm_frac['L']:.3f} CI {ci} P(<=0) {p:.2f}")
    P("    by year frac H-L: " + str({y: round(g[g.tier=='H'].Gm_frac.mean() - g[g.tier=='L'].Gm_frac.mean(), 3) for y, g in d.groupby(d.date.dt.year)}))
    t = d.groupby("rt").agg(n=("Gm", "size"), Gm_frac=("Gm_frac", "mean")).reindex(list("LMH"))
    ci, p = boot_diff(d[d.rt == "H"].Gm_frac, d[d.rt == "L"].Gm_frac)
    P(f"(b2) matched body, FE-residual tiers: {t.Gm_frac.round(3).to_dict()} H-L CI {ci} P(<=0) {p:.2f}")
    # (c) fixed body in I-units across all days: G_b/(100 b) for b in 5..20 by FE tier (whole curve)
    rows = []
    for b in (5, 10, 15, 20):
        g = d.assign(f=d[f"G{b}"] / (100 * b))
        rows.append({"b": b, **g.groupby("tier").f.mean().reindex(list("LMH")).round(3).to_dict(),
                     **{f"rt{k}": v for k, v in g.groupby("rt").f.mean().reindex(list("LMH")).round(3).to_dict().items()}})
    P("(c) fraction of width kept, G_b/(100 b), by FE tier (L M H) and FE-residual tier (rtL rtM rtH):\n" + pd.DataFrame(rows).to_string(index=False))
    return L


def low_i_check(d):
    """Within the low-I tercile: FE residual (on log I, fitted in-bin) split vs direct VIX_prev split."""
    L = []; P = L.append
    iq = d.I.quantile([1 / 3, 2 / 3]).values
    lo = d[d.I <= iq[0]].copy()
    X = np.c_[np.ones(len(lo)), np.log(lo.I)]
    lo["r"] = np.log(lo.FE) - X @ np.linalg.lstsq(X, np.log(lo.FE), rcond=None)[0]
    for col, hi_is_high in (("r", True), ("vix_prev", False)):   # FE high = residual high = VIX_prev low
        med = lo[col].median()
        hi = lo[lo[col] > med] if hi_is_high else lo[lo[col] <= med]
        lw = lo[lo[col] <= med] if hi_is_high else lo[lo[col] > med]
        ci, p = boot_diff(hi.G, lw.G)
        yrs = {}
        for y, g in lo.groupby(lo.date.dt.year):
            h = g[g[col] > med] if hi_is_high else g[g[col] <= med]
            l = g[g[col] <= med] if hi_is_high else g[g[col] > med]
            yrs[y] = (len(h), len(l), round(h.G.mean() - l.G.mean(), 1) if len(h) and len(l) else None)
        P(f"low-I tercile (I<={iq[0]:.2f}, n={len(lo)}) split by {col}: G FE-high - FE-low {hi.G.mean()-lw.G.mean():.1f} CI {ci} P(<=0) {p:.2f}; by year (nH,nL,diff) {yrs}")
    return L


if __name__ == "__main__":
    p = f"{OUT}/days.parquet"
    df = pd.read_parquet(p) if os.path.exists(p) and "rebuild" not in sys.argv else build()
    df = df[df.date < TRAIN_END]                                     # TIME WALL
    for c in ("wide_ific", "wide_pf", "atm_onesided", "w_tie"):
        df[c] = df[c].fillna(False).astype(bool)
    df["drop"] = df["drop"].fillna("")
    log = []
    d, cuts, own, L1 = analyze(df, "main"); log += L1
    d2, _, _, L2 = analyze(df, "ific", seg_labels=own); log += ["", "=== variant 2 (cap on IF/IC legs only), own cuts; seg_fixed = main-sample month labels ==="] + L2
    log += ["", "=== diagnostics on main sample ==="] + diagnostics(d)
    log += low_i_check(d)
    log += ["", "=== diagnostics on ific sample ==="] + diagnostics(d2)
    d.to_csv(f"{OUT}/main_days.csv", index=False)
    open(f"{OUT}/log.txt", "w").write("\n".join(log))
    print("\n".join(log))
