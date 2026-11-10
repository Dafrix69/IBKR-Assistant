"""P-0015 review, items 3/4/6: stress the PASS with the validator's per-day test table (verified against raw files
by P-0015_spotcheck.py) and the validator's tick extract (tick_test.parquet).

  S1 minutes-only and combined: stratified (year x weekday) permutation, one-sided, 20000 draws, own implementation.
  S2 fragility: drop the best 1/2/3/5 minutes days; sign test; exact per-day list; halves of the test period.
  S3 decay: minutes-day G by calendar year, train + test.
  S4 multiplicity scenarios and the 2026-11-08 posterior bound for each p.
  S5 tick: per-day ATM spread ratio in 14:00:00-:10 vs the same day's 13:55:00-13:59:30 (how many of 14 days carry
     the "2.3x"), and the four-leg half-spread sum by fill window after 14:00:00 vs before (USD at k 0.20),
     minutes days minus same-weekday controls.

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0015_stress.py
"""
import math
import os

import numpy as np
import pandas as pd
from scipy.stats import binomtest

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
Q = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator"
T = os.path.join(Q, "V-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
rng = np.random.default_rng(1500015)

cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
evc = pd.read_csv(os.path.join(Q, "V-0015_events.csv"), parse_dates=["date"])
typ = dict(zip(evc.date, evc.event))


def load(period):
    e = pd.read_parquet(os.path.join(T, f"entries_{period}.parquet"))
    e["E"] = 0.20 * e.iron_H * 100 + e.iron_fee20
    e = e[e.iron_mid.notna() & (e.iron_widest <= 2.0)]
    E = e.pivot_table(index="date", columns="entry", values="E")
    G = (E["14:00"] - E["13:55"]).dropna()
    b = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01) & (~cal.fomc)]
    G = G[G.index.isin(b.index)]
    d = pd.DataFrame({"G": G})
    d["typ"] = [typ.get(x, "") for x in d.index]
    d["stratum"] = d.index.year * 10 + d.index.dayofweek
    return d


def did(d, which):
    """mean over event days of (G - mean of non-event days in the same stratum); which = set of event types."""
    tot, n = 0.0, 0
    for _, g in d.groupby("stratum"):
        e = g.typ.isin(which).to_numpy()
        c = (g.typ == "").to_numpy()
        if e.any() and c.any():
            v = g.G.to_numpy()
            tot += (v[e] - v[c].mean()).sum()
            n += e.sum()
    return tot / n


def perm(d, which, n=20000):
    obs = did(d, which)
    groups = [(g.G.to_numpy(), g.typ.to_numpy()) for _, g in d.groupby("stratum")]
    hits = 0
    for _ in range(n):
        tot, m = 0.0, 0
        for v, lab in groups:
            L = lab[rng.permutation(len(lab))]
            e = np.isin(L, list(which))
            c = L == ""
            if e.any() and c.any():
                tot += (v[e] - v[c].mean()).sum()
                m += e.sum()
        hits += (tot / m if m else -np.inf) >= obs - 1e-12
    return obs, (hits + 1) / (n + 1)


def boot(a, n=10000):
    a = np.asarray(a, float)
    m = a[rng.integers(0, len(a), (n, len(a)))].mean(1)
    return np.percentile(m, 2.5), np.percentile(m, 97.5), float(np.mean(m <= 0))


def post(prior, p):
    bf = 1.0 if p >= 1 / math.e else 1.0 / (-math.e * p * math.log(p))
    o = prior / (1 - prior) * bf
    return o / (1 + o)


te = load("test")
tr = load("train")
mi = te[te.typ == "minutes"].G
print("== S1 own permutation (test period)")
res = {}
for lab, which in (("combined (minutes + beige)", {"minutes", "beige_book"}), ("minutes only", {"minutes"}),
                   ("beige only", {"beige_book"})):
    obs, p = perm(te, which)
    res[lab] = p
    print(f"  {lab:<28} DiD {obs:+.3f}  one-sided p {p:.5f}")
lo, hi, p0 = boot(mi.values)
print(f"  minutes G_ev n {len(mi)} mean {mi.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]  bootstrap P(mean<=0) {p0:.4f}")
allv = te[te.typ != ""].G
lo, hi, p0a = boot(allv.values)
print(f"  combined G_ev n {len(allv)} mean {allv.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]  bootstrap P(mean<=0) {p0a:.4f}")

print("\n== S2 fragility of the minutes-only cell (test)")
print("  per day:", "  ".join(f"{d:%y-%m-%d} {v:+.2f}" for d, v in mi.items()))
pos, neg, zero = int((mi > 1e-9).sum()), int((mi < -1e-9).sum()), int((mi.abs() <= 1e-9).sum())
print(f"  + {pos} / - {neg} / 0 {zero}; sign test (zeros dropped) one-sided p {binomtest(pos, pos + neg, 0.5, alternative='greater').pvalue:.4f}")
ctrl = te[te.typ == ""].G
print(f"  controls: n {len(ctrl)} mean {ctrl.mean():+.3f}, share G >= +2.5: {np.mean(ctrl >= 2.5 - 1e-9):.3f}, >= +4: {np.mean(ctrl >= 4 - 1e-9):.3f}, "
      f">= +7.5: {np.mean(ctrl >= 7.5 - 1e-9):.4f}; minutes days >= +2.5: {int((mi >= 2.5 - 1e-9).sum())}/{len(mi)}")
s = mi.sort_values(ascending=False)
for k in (1, 2, 3, 5):
    r = s.iloc[k:]
    lo, hi, pp = boot(r.values)
    d2 = te.drop(s.index[:k])
    obs, p = perm(d2, {"minutes"}, 5000)
    print(f"  drop best {k}: n {len(r)} mean {r.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]  DiD {obs:+.3f} perm p {p:.4f}")
h = te.index.sort_values()[len(te) // 2]
for lab, m in (("first half", mi[mi.index < h]), ("second half", mi[mi.index >= h]),
               ("2025", mi[mi.index.year == 2025]), ("2026", mi[mi.index.year == 2026]),
               ("last 6", mi.iloc[-6:]), ("last 4", mi.iloc[-4:])):
    lo, hi, pp = boot(m.values)
    print(f"  {lab:<12} n {len(m)} mean {m.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]")
for yr in (2025, 2026):
    d2 = te[te.index.year == yr]
    obs, p = perm(d2, {"minutes"}, 5000)
    print(f"  {yr} alone: minutes DiD {obs:+.3f} perm p {p:.4f}")

print("\n== S3 decay: minutes-day G_ev by year (train + test)")
al = pd.concat([tr, te])
m2 = al[al.typ == "minutes"]
print(m2.groupby(m2.index.year).G.agg(["count", "mean", "median"]).round(2).to_string())
print("  beige:")
b2 = al[al.typ == "beige_book"]
print(b2.groupby(b2.index.year).G.agg(["count", "mean", "median"]).round(2).to_string())

print("\n== S4 multiplicity scenarios -> adjusted p -> posterior upper bound (Sellke-Bayarri-Berger), prior 5% / 15% / 30%")
pc, pm = res["combined (minutes + beige)"], res["minutes only"]
scen = [
    ("combined, single pre-registered test (raw)", pc),
    ("combined, one-sided max-T over 12 cells (validator, post hoc family)", 0.032),
    ("combined, two-sided max-T over 17 cells (validator)", 0.0755),
    ("combined, Bonferroni x53 (protocol rule 6 literal)", min(1, 53 * pc)),
    ("minutes only, raw", pm),
    ("minutes only, x2 (combined or minutes, the two readings the proposal pre-declared)", min(1, 2 * pm)),
    ("minutes only, x3 (combined / minutes / beige)", min(1, 3 * pm)),
    ("minutes only, one-sided max-T 12 cells (validator)", 0.0015),
    ("minutes only, two-sided max-T 17 cells (validator)", 0.0085),
    ("minutes only, Bonferroni x53", min(1, 53 * pm)),
]
for lab, p in scen:
    print(f"  {lab:<82} p {p:.4f}  posterior <= {post(.05, p):.0%} / {post(.15, p):.0%} / {post(.30, p):.0%}")

print("\n== S5 tick (validator extract tick_test.parquet; NBBO attached to prints)")
x = pd.read_parquet(os.path.join(T, "tick_test.parquet"))
x["grp"] = [typ.get(d, "control") for d in x.date]
a = x[x.leg.isin(["kc", "kp"])]
pre = a[(a.sec >= -300) & (a.sec < -30)].groupby("date").spr.mean()
w0 = a[(a.sec >= 0) & (a.sec < 10)].groupby("date").spr.mean()
ratio = (w0 / pre).dropna()
g = pd.Series([typ.get(d, "control") for d in ratio.index], index=ratio.index)
for k in ("minutes", "beige_book", "control"):
    r = ratio[g == k]
    print(f"  {k:<10} days {len(r):3d}  ratio 14:00:00-:10 / 13:55:00-13:59:30: mean {r.mean():.2f} median {r.median():.2f} "
          f"p90 {r.quantile(.9):.2f}  share > 1.5: {np.mean(r > 1.5):.2f}")
c95 = ratio[g == "control"].quantile(.95)
rm = ratio[g == "minutes"]
print(f"  control 95th pct ratio {c95:.2f}; minutes days above it: {int((rm > c95).sum())}/{len(rm)}")
print("  minutes days:", "  ".join(f"{d:%y-%m-%d} {v:.2f}" for d, v in rm.items()))

print("\n  four-leg half-spread sum by window, minus same day's 13:55:00-13:59:30, x 20 = USD at k 0.20 (day needs all 4 legs printed)")
wins = [(-30, -10), (-10, 0), (0, 10), (10, 30), (30, 60), (60, 90), (90, 120), (120, 300), (300, 600)]


def H(lo, hi):
    s = x[(x.sec >= lo) & (x.sec < hi)].groupby(["date", "leg"]).spr.mean().unstack()
    return (s.dropna().sum(axis=1)) / 2


Hpre = H(-300, -30)
rows = []
for lo, hi in wins:
    dd = ((H(lo, hi) - Hpre) * 20).dropna()
    gg = pd.Series([typ.get(d, "control") for d in dd.index], index=dd.index)
    row = {"window_s": f"{lo:+d}..{hi:+d}"}
    for k in ("minutes", "beige_book", "control"):
        v = dd[gg == k]
        row[f"{k}_n"] = len(v)
        row[f"{k}_mean"] = round(v.mean(), 2)
        row[f"{k}_med"] = round(v.median(), 2)
    v = dd[gg == "minutes"] - dd[gg == "control"].mean()
    if len(v) > 1:
        lo_, hi_, _ = boot(v.values, 4000)
        row["min-ctrl"] = round(v.mean(), 2)
        row["ci"] = f"[{lo_:+.2f},{hi_:+.2f}]"
    rows.append(row)
print(pd.DataFrame(rows).to_string(index=False))
