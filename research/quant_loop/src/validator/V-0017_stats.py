"""V-0017 stats (independent; train only). Reproduces the judged I_tau, the chain-start I'_tau and the
proposer's decomposition, then a sign-source x start-reference cross matrix, and V-0013 effective-k checks.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0017_stats.py > V-0017_tables/stats_out.txt
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0017_tables")
WALL = pd.Timestamp("2025-11-01")
SEG2 = pd.Timestamp("2025-05-01")
rng = np.random.default_rng(17017)
EPS = 1e-9

p = pd.read_parquet(os.path.join(T, "prints.parquet"))
p = p[p.date < WALL].reset_index(drop=True)                      # time wall, first step
p["win"] = p.ts.dt.floor("15min")
p["bucket"] = pd.factorize(p.date.astype(str) + p.struct + p.K.astype(str) + "|" + p.w.astype(str) + p.win.astype(str))[0]
p["interp"] = p.ch_0 + p.u * (p.ch_1 - p.ch_0)
DAYS = np.sort(p.date.unique())


def sgn(dev, thr=0.05):
    if thr == 0:
        return np.where(dev > EPS, 1, np.where(dev < -EPS, -1, 0))
    return np.where(dev >= thr - EPS, 1, np.where(dev <= -thr + EPS, -1, 0))


def dayvals(y, s, mask=None):
    """Bucket-hedged I per day (USD/combo). y in points."""
    ok = (s != 0) & np.isfinite(y)
    if mask is not None:
        ok &= mask
    q = pd.DataFrame({"d": p.date.values[ok], "b": p.bucket.values[ok], "s": s[ok], "y": y[ok]})
    g = q.groupby(["d", "b", "s"]).y.agg(["mean", "size"]).unstack("s")
    g = g.dropna()
    if g.empty:
        return pd.Series(dtype=float)
    I = 50.0 * (g[("mean", 1)] - g[("mean", -1)])
    n1, n2 = g[("size", 1)], g[("size", -1)]
    wt = 2 * n1 * n2 / (n1 + n2)
    df = pd.DataFrame({"I": I * wt, "w": wt}).groupby(level="d").sum()
    return df.I / df.w


def tm(x):
    return float(trim_mean(np.asarray(x), 0.10))


def boot(dv, nb=10000):
    x = dv.values
    idx = rng.integers(0, len(x), (nb, len(x)))
    xs = np.sort(x[idx], axis=1)
    k = int(0.10 * len(x))
    b = xs[:, k:len(x) - k].mean(axis=1)
    return np.percentile(b, [2.5, 97.5])


def line(lab, dv, ci=True):
    lo, hi = boot(dv) if ci else (np.nan, np.nan)
    s1, s2 = dv[dv.index < SEG2], dv[dv.index >= SEG2]
    print(f"{lab:<58s} n={len(dv):3d} trim {tm(dv):+7.2f} [{lo:+6.2f},{hi:+6.2f}] med {dv.median():+7.2f} "
          f"mean {dv.mean():+7.2f} seg1 {tm(s1):+6.2f} seg2 {tm(s2):+6.2f}")
    return tm(dv)


dev_own = (p.trade - p.own).values
s_own = sgn(dev_own)
print(f"prints {len(p)} days {p.date.nunique()}  signed {np.mean(s_own != 0):.3f}  s+ {np.mean(s_own == 1):.3f}  "
      f"s- {np.mean(s_own == -1):.3f}  exact-mid {np.mean(np.abs(dev_own) < EPS):.3f}")
E = 100 * s_own * dev_own
print(f"E signed mean {E[s_own != 0].mean():.2f} median {np.median(E[s_own != 0]):.2f};  H mean {p.H.mean():.3f}")
qa = pd.read_parquet(os.path.join(T, "qage.parquet")).qage.values
print(f"quote age of ML leg rows (trade_ts - quote_ts, s), all train days, n={len(qa)}: median {np.median(qa):.3f} "
      f"p90 {np.percentile(qa, 90):.3f} p99 {np.percentile(qa, 99):.2f}  share > 1 s {np.mean(qa > 1):.3f}")

print("\n== 1. judged I_tau (sign = own, start = own, end = chain floor+tau) ==")
res = {}
for tau in (1, 5, 15):
    res[tau] = line(f"I_{tau}", dayvals((p[f"ch_{tau}"] - p.own).values, s_own))

# permutation null: shuffle s within bucket
y5 = (p.ch_5 - p.own).values
ok = (s_own != 0) & np.isfinite(y5)
bk = p.bucket.values
ix = np.flatnonzero(ok)
order = ix[np.lexsort((np.zeros(len(ix)), bk[ix]))]
null = []
for _ in range(200):
    o2 = ix[np.lexsort((rng.random(len(ix)), bk[ix]))]
    sp = s_own.copy()
    sp[order] = s_own[o2]                         # within-bucket permutation of signed prints, counts kept
    null.append(tm(dayvals(y5, sp)))
null = np.array(null)
print(f"perm null I_5 (200, shuffle s among signed prints within bucket): mean {null.mean():+.2f} "
      f"p97.5 {np.percentile(null, 97.5):+.2f}  real {res[5]:+.2f}")

print("\n== 2. I'_tau (start = chain floor(t)) and decomposition, sign = own ==")
for tau in (1, 5, 15):
    line(f"I'_{tau} start=ch_0", dayvals((p[f"ch_{tau}"] - p.ch_0).values, s_own), ci=(tau == 5))
parts = [("pre   ch_0 - ch_-1", p.ch_0 - p["ch_-1"]),
         ("disp  own - ch_0", p.own - p.ch_0),
         ("dispI own - interp", p.own - p.interp),
         ("trade - interp", p.trade - p.interp),
         ("absorb u*(ch_1 - ch_0) = interp - ch_0", p.interp - p.ch_0),
         ("post  ch_1 - interp", p.ch_1 - p.interp),
         ("post  ch_5 - interp", p.ch_5 - p.interp),
         ("post  ch_15 - interp", p.ch_15 - p.interp)]
for lab, y in parts:
    line(lab, dayvals(y.values, s_own), ci=lab.startswith("post") or lab.startswith("dispI") or lab.startswith("absorb"))
a = np.abs(dev_own)
for lo, hi in ((0.05, 0.10), (0.10, 0.20), (0.20, 99)):
    m = (a >= lo - EPS) & (a < hi - EPS)
    line(f"dispI |dev| [{lo},{hi})", dayvals((p.own - p.interp).values, s_own, m), ci=False)
    line(f"post5-interp |dev| [{lo},{hi})", dayvals((p.ch_5 - p.interp).values, s_own, m), ci=False)
d = 100 * (p.own - p.interp)
print(f"unsigned own - interp, all prints: mean {d.mean():+.2f} median {d.median():+.2f} mean|.| {d.abs().mean():.2f}; "
      f"exact-mid prints mean|.| {d[np.abs(dev_own) < EPS].abs().mean():.2f}")
for lab, m in (("s=+1", s_own == 1), ("s=-1", s_own == -1), ("mid", np.abs(dev_own) < EPS)):
    print(f"  {lab}: own-interp {np.nanmean(d[m]):+.2f}  trade-interp {np.nanmean(100 * (p.trade - p.interp)[m]):+.2f}")

print("\n== 3. cross matrix: sign source x start reference (end = chain floor+tau; also end = own-tape asof NBBO) ==")
refs = {"own": p.own.values, "interp": p.interp.values, "ch_0": p.ch_0.values, "prior": p.prior.values}
signs = {k: sgn((p.trade - v).values) for k, v in refs.items()}
for k, s in signs.items():
    print(f"sign by {k:<6s}: signed share {np.mean(s != 0):.3f} (s+ {np.mean(s == 1):.3f}, s- {np.mean(s == -1):.3f})")
for sk, s in signs.items():
    for rk, r in refs.items():
        for tau in (5, 15):
            y = p[f"ch_{tau}"].values - r
            dv = dayvals(y, s)
            ci = (sk in ("own", "interp", "ch_0") and rk in ("own", "interp", "ch_0"))
            line(f"sign={sk:<6s} start={rk:<6s} end=chain+{tau}", dv, ci=ci)
print("-- end = own-tape asof NBBO at t+tau (last print of each leg at or before t+tau) --")
for sk in ("own", "interp", "ch_0"):
    for rk in ("own", "interp", "ch_0"):
        for tau, col in ((5, "end5o"), (15, "end15o")):
            line(f"sign={sk:<6s} start={rk:<6s} end=asof+{tau}", dayvals(p[col].values - refs[rk], signs[sk]), ci=False)
print("-- sign by prior-asof (stale) with prior start, and own-tape displacement vs prior --")
line("sign=own start=prior end=chain+5 (prior age<=2s only)",
     dayvals(p.ch_5.values - p.prior.values, s_own, (p.prior_age <= 2).values), ci=False)
line("sign=own, own - prior (prior age<=2s)", dayvals((p.own - p.prior).values, s_own, (p.prior_age <= 2).values), ci=False)
print(f"prior age median {p.prior_age.median():.2f}s p90 {p.prior_age.quantile(.9):.1f}s")
print("-- passive realized spread vs trade price, sign by interp (s*(trade - end)) --")
for tau in (5, 15):
    s = signs["interp"]
    y = -(p[f"ch_{tau}"].values - p.trade.values)       # pass y = trade - end; hedged I = 0.5(mean+ - mean-) of y
    line(f"realized half-spread to passive, sign=interp, tau={tau}", dayvals(y, s), ci=False)

print("\n== 4. V-0013 effective k, iron only (|trade - ref| / H) ==")
ir = (p.struct == "iron").values
for rk in ("own", "interp", "ch_0", "prior"):
    k = (np.abs(p.trade - refs[rk]) / p.H).values[ir]
    k = k[np.isfinite(k)]
    sl = 100 * np.abs(p.trade - refs[rk]).values[ir]
    sl = sl[np.isfinite(sl)]
    print(f"ref {rk:<6s}: k mean {k.mean():.3f} median {np.median(k):.3f};  |slip| USD mean {sl.mean():.2f} "
          f"median {np.median(sl):.2f}  share >10 {np.mean(sl > 10.0 + 1e-6):.3f}")
s_i = signs["interp"]
flip = (s_own != 0) & ir
print(f"iron signed by own (|dev|>=0.05): n {flip.sum()}; sign by interp same {np.mean(s_i[flip] == s_own[flip]):.3f}, "
      f"opposite {np.mean(s_i[flip] == -s_own[flip]):.3f}, interp unsigned {np.mean(s_i[flip] == 0):.3f}")
kown = (np.abs(dev_own) / p.H).values
for lab, m in (("s=+1 (Pi buyer aggr = sells iron fly)", (s_own == 1) & ir), ("s=-1", (s_own == -1) & ir),
               ("all iron", ir)):
    print(f"  k_own mean {lab}: {kown[m].mean():.3f}  median {np.median(kown[m]):.3f}")
# signed k vs interp: where on the interp spread do fills land, by own-sign side (user's side = Pi buyer = s+)
kint = ((p.trade - p.interp) / p.H).values
for lab, m in (("own s=+1", (s_own == 1) & ir), ("own s=-1", (s_own == -1) & ir), ("own mid", (np.abs(dev_own) < EPS) & ir),
               ("all iron", ir)):
    v = kint[m]; v = v[np.isfinite(v)]
    print(f"  signed (trade - interp)/H {lab}: mean {v.mean():+.3f} median {np.median(v):+.3f}")
