"""V-0019 stats. research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0019_stats.py train|test
Day-level 10% two-sided trimmed means of per-day 10% trimmed means, USD / package (points x 100).
Bootstrap over days, 10,000 draws (Bonferroni-68 interval with 40,000), validator seed 20261102."""
import os
import sys
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0019_tables")
R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
which = sys.argv[1]
LO, HI, SEG = {"train": ("2024-10-30", "2025-11-01", "2025-05-01"),
               "test": ("2025-11-01", "2026-10-30", "2026-05-01")}[which]
LO, HI, SEG = pd.Timestamp(LO), pd.Timestamp(HI), pd.Timestamp(SEG)
p = pd.read_parquet(os.path.join(T, f"combos_{which}.parquet"))
p = p[(p.date >= LO) & (p.date < HI)]                                 # time wall
ag = pd.read_parquet(os.path.join(T, f"aggr_{which}.parquet"))
ag = ag[(ag.date >= LO) & (ag.date < HI)]                             # time wall
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[(cal.index >= LO) & (cal.index < HI)]                       # time wall
TRIM = float(os.environ.get("TRIM", "0.10"))
TR = lambda v: trim_mean(np.asarray(v, float), TRIM)
rng = np.random.default_rng(20261102)

hm = p.ts.dt.hour * 60 + p.ts.dt.minute
p["ref"] = (1 - p.u) * p.ch0 + p.u * p.ch1
p["D"] = (p.trade - p.ref) * 100
p["D_m0"] = (p.trade - p.ch0) * 100
p["D_own"] = (p.trade - p.own) * 100
p["F"] = (p.own - p.ref) * 100
p["P_own"] = p.Pown * 100
p["Hc"] = p.H
for s in ("a1", "b1", "a5", "b5"):
    p[f"A_{s}"] = (p.own - p[f"nb{s}"]) * 100
    p[f"B_{s}"] = (p[f"nb{s}"] - p.ref) * 100
    p[f"Dnb_{s}"] = (p.trade - p[f"nb{s}"]) * 100
base = (hm >= 585) & (p.w >= 15) & (p.w < 80)
near = (p.K - p.S).abs() <= 5
main = p[base & near & (hm < 930) & p.ch0.notna() & p.ch1.notna()].copy()
late = p[base & near & (hm >= 930)].copy()
late["D"] = late.D.fillna(late.D_m0)


def daily(df, col):
    return df.dropna(subset=[col]).groupby("date")[col].apply(lambda x: TR(x.values))


def boot(v, q=(2.5, 97.5), B=10000):
    v = np.asarray(v); i = rng.integers(0, len(v), (B, len(v)))
    return np.percentile([TR(v[j]) for j in i], q)


def line(df, col, name, ci=False, ret=False):
    dv = daily(df, col)
    if len(dv) == 0:
        print(f"{name:46s} no days"); return np.nan
    e = TR(dv.values)
    s1, s2 = dv[dv.index < SEG], dv[dv.index >= SEG]
    cs = "[%+.2f, %+.2f]" % tuple(boot(dv.values)) if ci else ""
    yr = " ".join(f"{y}:{TR(x.values):+.2f}" for y, x in dv.groupby(dv.index.year))
    print(f"{name:46s} {e:+6.2f} {cs:16s} med {dv.median():+6.2f} seg {TR(s1.values) if len(s1) else np.nan:+6.2f} / "
          f"{TR(s2.values) if len(s2) else np.nan:+6.2f}  yr {yr}  days {len(dv)} n {df[col].notna().sum()}")
    return (e, dv) if ret else e


print(f"{which}: combos stored {len(p)}, main {len(main)} prints / {main.date.nunique()} days, late {len(late)}; "
      f"calendar non-half 0DTE days {int((cal.has_0dte & ~cal.half_day).sum())}")
print(f"main struct share {main.struct.value_counts(normalize=True).round(3).to_dict()}")
print("\n== PRE-REGISTERED GATES (proposer 5.2) ==")
D, dvD = line(main, "D", "D (px - chain interp)", ci=True, ret=True)
Po = line(main, "P_own", "P_own (single px - own mid, Pi)", ci=True)
F, dvF = line(main, "F", "F (combo own mid - chain interp)", ci=True, ret=True)
Do = line(main, "D_own", "D_own (px - own mid)", ci=True)
print(f"P_own coverage {main.P_own.notna().mean():.3f}")
s1, s2 = dvD[dvD.index < SEG], dvD[dvD.index >= SEG]
lo, hi = boot(dvD.values)
g = [D > 0 and lo > 0, TR(s1.values) > 0 and TR(s2.values) > 0, abs(Po) < D / 2, abs(F) < D / 4]
print(f"gate1 {g[0]}  gate2 {g[1]}  gate3 {g[2]} (|P_own| {abs(Po):.2f} vs D/2 {D / 2:.2f})  gate4 {g[3]} (|F| {abs(F):.2f} vs D/4 {D / 4:.2f}, F/D {F / D:.3f})")
print("PASS (all four)" if all(g) else "FAIL")
# joint bootstrap of F/D (same day resample)
jj = pd.concat([dvD.rename("D"), dvF.rename("F")], axis=1).dropna()
idx = rng.integers(0, len(jj), (10000, len(jj)))
rat = np.array([TR(jj.F.values[i]) / TR(jj.D.values[i]) for i in idx])
print(f"F/D joint day bootstrap: [{np.percentile(rat, 2.5):.3f}, {np.percentile(rat, 97.5):.3f}], P(|F|/D >= 1/4) {np.mean(np.abs(rat) >= 0.25):.3f}")

print("\n== multiple comparisons (68 quantities) ==")
bq = boot(dvD.values, q=(0.05 / 68 / 2 * 100, 100 - 0.05 / 68 / 2 * 100), B=40000)
print(f"D Bonferroni-68 two-sided interval [{bq[0]:+.2f}, {bq[1]:+.2f}]")
v = dvD.values; ob = TR(v)
flips = np.array([TR(v * rng.choice([-1, 1], len(v))) for _ in range(1000)])
print(f"D sign-flip permutation (1000): p = {(np.sum(np.abs(flips) >= abs(ob)) + 1) / 1001:.4f}; luck expectation 0.05x68 = 3.4 false positives")
for col in ("D_own",):
    v2 = daily(main, col).values; o2 = TR(v2)
    fl2 = np.array([TR(v2 * rng.choice([-1, 1], len(v2))) for _ in range(1000)])
    print(f"{col} sign-flip p = {(np.sum(np.abs(fl2) >= abs(o2)) + 1) / 1001:.4f}")
print(f"share of days with daily D > 0: {(dvD > 0).mean():.3f}; daily D_own > 0: {(daily(main, 'D_own') > 0).mean():.3f}")

print("\n== k translation ==")
for nm, df in (("all", main), ("seg1", main[main.date < SEG]), ("seg2", main[main.date >= SEG])):
    Hb = TR(daily(df, "Hc").values); Dd = TR(daily(df, "D").values); Dod = TR(daily(df, "D_own").values)
    print(f"{nm:5s} H_bar {Hb:.4f} pts  D/(100H) {Dd / (100 * Hb):.3f}  k_buy {0.20 + Dd / (100 * Hb):.3f}  k_sell {0.20 - Dd / (100 * Hb):.3f}"
          f"   (D_own based: {0.20 + Dod / (100 * Hb):.3f} / {0.20 - Dod / (100 * Hb):.3f})")

print("\n== +-1 s / +-5 s neighbour quotes (report only in test) ==")
for s, nm in (("b1", "(b) multi-leg, 1 s"), ("a1", "(a) single, 1 s"), ("b5", "(b) multi-leg, 5 s"), ("a5", "(a) single, 5 s")):
    sub = main[main[f"nb{s}"].notna()]
    print(f"-- {nm}: coverage {len(sub) / len(main):.4f} ({len(sub)} prints, {sub.date.nunique()} days)")
    A = line(sub, f"A_{s}", "   A = own - nb", ci=True)
    B = line(sub, f"B_{s}", "   B = nb - chain", ci=True)
    for c in ("F", "D", "D_own", f"Dnb_{s}"):
        line(sub, c, f"   {c} on subset")
    if s.endswith("1"):
        print(f"   agrees with chain |B|<D/4: {abs(B) < D / 4}; convicts: {abs(B) < D / 4 and abs(A) >= D / 4}")

print("\n== report-only splits ==")
for st in ("iron", "fly_C", "fly_P"):
    x = main[main.struct == st]
    for c in ("D", "P_own", "F", "D_own"):
        line(x, c, f"{st} {c}")
mt = main.ts.dt.hour * 60 + main.ts.dt.minute
for a_, b_, nm in ((585, 720, "09:45-12:00"), (720, 840, "12:00-14:00"), (840, 930, "14:00-15:30")):
    line(main[(mt >= a_) & (mt < b_)], "D", f"D {nm}")
line(late, "D", "D 15:30-15:59 (m-row fallback)")
line(late[late.ch1.notna()], "F", "F 15:30-15:59 (both rows)")
for a_, b_, nm in ((1, 2, "1-2 lots"), (3, 9, "3-9 lots"), (10, 10 ** 9, ">=10 lots")):
    line(main[(main.lots >= a_) & (main.lots <= b_)], "D", f"D {nm}")
line(main, "D_m0", "D ref chain m row only")
bA = cal.index[cal.spx_ret_prev > -0.01]
line(main[main.date.isin(bA)], "D", "D baseline-A days")

print("\n== robustness (gates re-evaluated) ==")
def gates(df, nm):
    d = daily(df, "D"); f = daily(df, "F"); po = daily(df, "P_own")
    if len(d) < 20:
        print(f"{nm:34s} too few days"); return
    Dd, Ff, Pp = TR(d.values), TR(f.values), TR(po.values)
    l, h = boot(d.values, B=2000)
    a1, a2 = TR(d[d.index < SEG].values), TR(d[d.index >= SEG].values)
    ok = Dd > 0 and l > 0 and a1 > 0 and a2 > 0 and abs(Pp) < Dd / 2 and abs(Ff) < Dd / 4
    print(f"{nm:34s} D {Dd:+.2f} [{l:+.2f},{h:+.2f}] seg {a1:+.2f}/{a2:+.2f} P_own {Pp:+.2f} F {Ff:+.2f} F/D {Ff / Dd:.3f} "
          f"D_own {TR(daily(df, 'D_own').values):+.2f} -> {'pass' if ok else 'FAIL'}  n {len(df)}")
gates(main, "base")
nn = base & (hm < 930) & p.ch0.notna() & p.ch1.notna()
gates(p[nn & ((p.K - p.S).abs() <= 2.5)], "|K-S|<=2.5")
gates(p[nn & ((p.K - p.S).abs() <= 10)], "|K-S|<=10")
gates(main[main.w < 30], "w 15-29")
gates(main[main.w >= 30], "w 30-79")
gates(p[(hm >= 585) & (hm < 930) & near & (p.w >= 10) & (p.w < 100) & p.ch0.notna() & p.ch1.notna()], "w 10-99")
best = dvD.sort_values().index[-5:]
gates(main[~main.date.isin(best)], "drop best-5 D days")
gates(main[main.struct == "iron"], "iron only")
print("(TRIM env var re-runs the whole script at another trim level)")

print("\n== aggressor composition (09:45-15:30, legs with valid quote) ==")
a = ag.groupby(["typ", "bin"])[["n", "ge_ask", "le_bid", "at_mid", "inside"]].sum()
for c in ("ge_ask", "le_bid", "at_mid", "inside"):
    a[c] = a[c] / a.n
a["net_buy"] = a.ge_ask - a.le_bid
print(a.reindex(pd.MultiIndex.from_product([["S", "M"], ["0-5", "6-15", "16-30", "31-50", "51-85"]])).round(3).to_string())
eps = 1e-9
pk = main
print(f"combo package (Pi) vs own Pi NBBO: >= Pi ask {(pk.trade >= pk.pia - eps).mean():.3f}, <= Pi bid {(pk.trade <= pk.pib + eps).mean():.3f}, "
      f"= Pi mid {((pk.trade - pk.own).abs() < eps).mean():.3f}, above mid inside {((pk.trade > pk.own + eps) & (pk.trade < pk.pia - eps)).mean():.3f}, "
      f"below mid inside {((pk.trade < pk.own - eps) & (pk.trade > pk.pib + eps)).mean():.3f}")
print(f"print-level D_own > 0 {(pk.D_own > 0.5).mean():.3f}, = 0 (|.|<=0.5) {(pk.D_own.abs() <= 0.5).mean():.3f}, < 0 {(pk.D_own < -0.5).mean():.3f}; "
      f"quantiles D_own {np.percentile(pk.D_own, [10, 25, 50, 75, 90]).round(1).tolist()}")
print(f"Pi half-spread own NBBO (USD) median {np.median((pk.pia - pk.pib) / 2 * 100):.1f}; D_own / own half-spread trimmed {TR(pk.D_own / ((pk.pia - pk.pib) / 2 * 100)):.3f}")
