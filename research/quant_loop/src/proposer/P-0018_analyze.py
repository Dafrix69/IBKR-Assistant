"""P-0018 analyze (spec sections 3.2-3.5). Gated: D, two halves, placebo. Everything else report-only.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0018_analyze.py train
"""
import os
import sys
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0018_tables"
SPLIT = pd.Timestamp("2025-11-01")
which = sys.argv[1] if len(sys.argv) > 1 else "train"
assert which == "train"

p = pd.read_parquet(os.path.join(T, f"prints_{which}.parquet"))
p = p[p.date < SPLIT]                                            # time wall (first step after reading)
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                     # time wall

tm = p.ts.dt.hour * 60 + p.ts.dt.minute
p["late"] = tm >= 15 * 60 + 30
p["ref"] = np.where(p.u.notna() & p.pi_m1.notna(), (1 - p.u) * p.pi_m0 + p.u * p.pi_m1, np.nan)
p["D"] = (p.pi_trade - p.ref) * 100
p["D_m0"] = (p.pi_trade - p.pi_m0) * 100
p["D_own"] = (p.pi_trade - p.pi_own) * 100
p["D_single"] = p.single * 100
dev = p.pi_trade - p.pi_own
p["s"] = np.where(dev >= 0.05 - 1e-9, 1, np.where(dev <= -0.05 + 1e-9, -1, 0))
main = p[~p.late & p.D.notna()].copy()
late = p[p.late].copy()
late["D"] = late.D.fillna(late.D_m0)                             # 15:59 has no 16:00 row -> m row (spec 3.5)

TR = lambda x: trim_mean(x, 0.10)
rng = np.random.default_rng(18)


def daily(df, col):
    g = df.dropna(subset=[col]).groupby("date")[col]
    return g.apply(lambda x: TR(x.values))


def boot(v, B=10000):
    v = np.asarray(v)
    idx = rng.integers(0, len(v), (B, len(v)))
    bs = np.array([TR(v[i]) for i in idx])
    return np.percentile(bs, [2.5, 97.5])


def line(df, col, name, ci=False):
    dv = daily(df, col)
    if len(dv) == 0:
        print(f"{name:52s} n_days 0"); return np.nan
    est = TR(dv.values)
    seg1 = dv[dv.index <= pd.Timestamp("2025-04-30")]
    seg2 = dv[dv.index >= pd.Timestamp("2025-05-01")]
    c = boot(dv.values) if ci else (np.nan, np.nan)
    cis = f"[{c[0]:+.2f}, {c[1]:+.2f}]" if ci else ""
    print(f"{name:52s} trim {est:+6.2f} {cis:18s} med {dv.median():+6.2f} mean {dv.mean():+6.2f} "
          f"seg1 {TR(seg1.values) if len(seg1) else np.nan:+6.2f} seg2 {TR(seg2.values) if len(seg2) else np.nan:+6.2f} "
          f"days {len(dv)} prints {df[col].notna().sum()}")
    return est


print(f"prints total {len(p)}; main (09:45-15:30, both chain rows) {len(main)}; late 15:30-15:59 {len(late)}; days {main.date.nunique()}")
print(f"struct shares main: {main.struct.value_counts(normalize=True).round(3).to_dict()}")
print("\n== GATED ==")
D = line(main, "D", "D (chain interp ref) [GATE 1,2]", ci=True)
Ds = line(main, "D_single", "D_single placebo [GATE 3]", ci=True)
print(f"placebo coverage: {main.D_single.notna().mean():.3f} of main prints")
print(f"GATE 1: D>0 & CI excl 0 ; GATE 2: seg1, seg2 > 0 ; GATE 3: |D_single| < D/2 = {abs(Ds) < D / 2}  ({abs(Ds):.2f} vs {D / 2:.2f})")
sub = main[main.D_single.notna()]
line(sub, "D", "D on placebo-covered prints (report)")

print("\n== k translation ==")
Hd = daily(main, "H_ch")
Hbar = TR(Hd.values)
print(f"H_bar (chain m-row half-spread sum, pts) {Hbar:.4f}; 0.20*H*100 = {20 * Hbar:.2f} USD; "
      f"k_buy ~ {0.20 + D / (100 * Hbar):.3f}, k_sell ~ {0.20 - D / (100 * Hbar):.3f}")

print("\n== REPORT ONLY ==")
for st in ("iron", "fly_C", "fly_P"):
    line(main[main.struct == st], "D", f"struct {st}")
mt = main.ts.dt.hour * 60 + main.ts.dt.minute
for lo, hi, nm in ((585, 720, "09:45-12:00"), (720, 840, "12:00-14:00"), (840, 930, "14:00-15:30")):
    line(main[(mt >= lo) & (mt < hi)], "D", f"time {nm}")
line(late, "D", "time 15:30-15:59 (m+1 interp, 15:59 m row)")
for lo, hi, nm in ((1, 2, "1-2 lots"), (3, 9, "3-9 lots"), (10, 10 ** 9, ">=10 lots")):
    line(main[(main["size"] >= lo) & (main["size"] <= hi)], "D", f"size {nm}")
line(main, "D_own", "ref = own attached NBBO mid")
line(main, "D_m0", "ref = chain m row only")
for sv, nm in ((1, "s=+1"), (-1, "s=-1"), (0, "unsigned")):
    print(f"   share {nm}: {(main.s == sv).mean():.3f}")
    line(main[main.s == sv], "D", f"signed split {nm} (sign own NBBO, level chain)")
base = cal.index[cal.spx_ret_prev > -0.01]
line(main[main.date.isin(base)], "D", "baseline-A days (spx_ret_prev > -1%)")
line(main[~main.date.between(pd.Timestamp("2025-04-03"), pd.Timestamp("2025-04-11"))], "D", "ex 2025-04-03..04-11")
pw = main.D
print(f"print-level (unweighted) D mean {pw.mean():+.2f} median {pw.median():+.2f}; share D>0 {(pw > 0).mean():.3f}, D<0 {(pw < 0).mean():.3f}")
