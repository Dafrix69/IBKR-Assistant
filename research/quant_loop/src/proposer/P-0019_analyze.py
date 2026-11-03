"""P-0019 analyze (spec 3.2-3.7, gates 5.1). research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0019_analyze.py train"""
import os
import sys
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0019_tables"
SPLIT = pd.Timestamp("2025-11-01")
which = sys.argv[1] if len(sys.argv) > 1 else "train"
assert which == "train"

p = pd.read_parquet(os.path.join(T, f"prints_{which}.parquet"))
p = p[p.date < SPLIT]                                            # time wall (first step after reading)
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                     # time wall
sd = pd.read_parquet(os.path.join(T, f"singlediag_{which}.parquet"))
sd = sd[sd.date < SPLIT]                                         # time wall
qa = pd.read_parquet(os.path.join(T, f"qage_{which}.parquet"))
qa = qa[qa.date < SPLIT]                                         # time wall

SEG = pd.Timestamp("2025-04-30")
tm = p.ts.dt.hour * 60 + p.ts.dt.minute
p["late"] = tm >= 15 * 60 + 30
p["ref"] = (1 - p.u) * p.pi_m0 + p.u * p.pi_m1
p["D"] = (p.pi_trade - p.ref) * 100
p["D_m0"] = (p.pi_trade - p.pi_m0) * 100
p["D_own"] = (p.pi_trade - p.pi_own) * 100
p["F"] = (p.pi_own - p.ref) * 100
p["P_own"] = p.p_own * 100
for s in ("a1", "b1", "a5", "b5"):
    p[f"A_{s}"] = (p.pi_own - p[f"pi_nb{s}"]) * 100
    p[f"B_{s}"] = (p[f"pi_nb{s}"] - p.ref) * 100
    p[f"Dnb_{s}"] = (p.pi_trade - p[f"pi_nb{s}"]) * 100
main = p[~p.late & p.D.notna()].copy()
late = p[p.late].copy()
late["D"] = late.D.fillna(late.D_m0)

TR = lambda x: trim_mean(x, 0.10)
rng = np.random.default_rng(19)


def daily(df, col):
    return df.dropna(subset=[col]).groupby("date")[col].apply(lambda x: TR(x.values))


def boot(v, B=10000):
    v = np.asarray(v)
    idx = rng.integers(0, len(v), (B, len(v)))
    return np.percentile([TR(v[i]) for i in idx], [2.5, 97.5])


def line(df, col, name, ci=False):
    dv = daily(df, col)
    if len(dv) == 0:
        print(f"{name:50s} n_days 0"); return np.nan
    est = TR(dv.values)
    s1, s2 = dv[dv.index <= SEG], dv[dv.index > SEG]
    c = boot(dv.values) if ci else None
    cis = f"[{c[0]:+.2f}, {c[1]:+.2f}]" if ci else ""
    print(f"{name:50s} trim {est:+6.2f} {cis:17s} med {dv.median():+6.2f} mean {dv.mean():+6.2f} "
          f"seg1 {TR(s1.values) if len(s1) else np.nan:+6.2f} seg2 {TR(s2.values) if len(s2) else np.nan:+6.2f} "
          f"days {len(dv)} prints {df[col].notna().sum()}")
    return est


print(f"prints total {len(p)}; main {len(main)}; late {len(late)}; days {main.date.nunique()}")
print("\n== GATED (5.1 / 5.2) ==")
D = line(main, "D", "D (chain interp) [1,2]", ci=True)
Po = line(main, "P_own", "P_own placebo (single px - own mid) [3]", ci=True)
F = line(main, "F", "F (combo own mid - chain interp) [4]", ci=True)
Do = line(main, "D_own", "D_own (px - own mid; named co-quantity)", ci=True)
print(f"placebo coverage {main.P_own.notna().mean():.3f}")
print(f"gate1 D>0 & CI excl 0 ; gate2 halves>0 ; gate3 |P_own|<D/2: {abs(Po) < D / 2} ({abs(Po):.2f} vs {D / 2:.2f}) ; "
      f"gate4 |F|<D/4: {abs(F) < D / 4} ({abs(F):.2f} vs {D / 4:.2f})")

print("\n== +-1 s neighbour quotes (3.5; gate 5 on the 1 s rows) ==")
conv = []
for s, nm in (("a1", "(a) single-leg, 1 s"), ("b1", "(b) multi-leg-coded, 1 s"), ("a5", "(a) single-leg, 5 s [report]"), ("b5", "(b) multi-leg-coded, 5 s [report]")):
    sub = main[main[f"pi_nb{s}"].notna()]
    print(f"-- {nm}: coverage {len(sub) / len(main):.4f} ({len(sub)} prints, {sub.date.nunique()} days); "
          f"iron share {(sub.struct == 'iron').mean():.3f}, median w {sub.w.median():.0f} (main {main.w.median():.0f})")
    A = line(sub, f"A_{s}", "   A = own mid - nb", ci=True)
    B = line(sub, f"B_{s}", "   B = nb - chain interp", ci=True)
    line(sub, "F", "   F on covered subset")
    line(sub, "D", "   D on covered subset")
    line(sub, "D_own", "   D_own on covered subset")
    line(sub, f"Dnb_{s}", "   D_nb = px - nb")
    if s.endswith("1"):
        agrees = abs(B) < D / 4
        c = agrees and abs(A) >= D / 4
        conv.append(c)
        print(f"   agrees with chain (|B|<D/4={D / 4:.2f}): {agrees}; convicts (agrees & |A|>=D/4): {c}")
print(f"gate5 (no neighbour set convicts): {not any(conv)}")

print("\n== k translation ==")
Hbar = TR(daily(main, "H_ch").values)
print(f"H_bar {Hbar:.4f} pts; k_buy ~ {0.20 + D / (100 * Hbar):.3f}, k_sell ~ {0.20 - D / (100 * Hbar):.3f}")

print("\n== REPORT ONLY ==")
for st in ("iron", "fly_C", "fly_P"):
    line(main[main.struct == st], "D", f"D struct {st}")
    line(main[main.struct == st], "P_own", f"P_own struct {st}")
    line(main[main.struct == st], "F", f"F struct {st}")
mt = main.ts.dt.hour * 60 + main.ts.dt.minute
for lo, hi, nm in ((585, 720, "09:45-12:00"), (720, 840, "12:00-14:00"), (840, 930, "14:00-15:30")):
    line(main[(mt >= lo) & (mt < hi)], "D", f"D time {nm}")
line(late, "D", "D time 15:30-15:59")
for lo, hi, nm in ((1, 2, "1-2 lots"), (3, 9, "3-9 lots"), (10, 10 ** 9, ">=10 lots")):
    line(main[(main["size"] >= lo) & (main["size"] <= hi)], "D", f"D size {nm}")
line(main, "D_m0", "D ref = chain m row only")
base = cal.index[cal.spx_ret_prev > -0.01]
line(main[main.date.isin(base)], "D", "D baseline-A days")
line(main[~main.date.between(pd.Timestamp("2025-04-03"), pd.Timestamp("2025-04-11"))], "D", "D ex 2025-04-03..04-11")

print("\n== single-leg diagnostics (USD per contract, day-level 10% trimmed means of daily means) ==")
g = sd.groupby(["date", "bin", "r"], observed=True)[["oc_s", "oc_n", "on_s", "on_n", "nc_s", "n"]].sum().reset_index()
g["own_chain"] = g.oc_s / g.oc_n
g["own_nb1"] = np.where(g.on_n > 0, g.on_s / g.on_n.replace(0, np.nan), np.nan)
g["nb_chain"] = np.where(g.on_n > 0, g.nc_s / g.on_n.replace(0, np.nan), np.nan)
for (b, r), x in g.groupby(["bin", "r"], observed=True):
    print(f"  {b:8s} {r}  own-chain {TR(x.own_chain.dropna()):+6.2f}  own - nb(+-1s) {TR(x.own_nb1.dropna()):+6.2f}  "
          f"nb - chain {TR(x.nb_chain.dropna()):+6.2f}  nb coverage {x.on_n.sum() / x.oc_n.sum():.3f}  prints/day {x.n.mean():.0f}")
print("  single-leg own mid - chain interp by quote age (body<=5 and 6-15, C+P pooled):")
h = sd[sd.bin.isin(["body<=5", "6-15"])].groupby(["date", "agebin"], observed=True)[["oc_s", "oc_n"]].sum().reset_index()
h["v"] = h.oc_s / h.oc_n
tot = h.groupby("agebin", observed=True).oc_n.sum()
for a, x in h.groupby("agebin", observed=True):
    print(f"    {a:9s} {TR(x.v.dropna()):+6.2f}  share {tot[a] / tot.sum():.3f}")
print("  quote age (ms) 09:45-15:30, day medians of daily median / p90 / share > 1 s:")
for k, x in qa.groupby("kind"):
    print(f"    {k:6s} med {x.med.median():.1f}  p90 {x.p90.median():.1f}  >1s {x.gt1s.median():.4f}")
