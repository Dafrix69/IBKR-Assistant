"""Score the frozen P-0021 / P-0022 rules on the ex-ante universe, train / test / all, with the frozen inference unit
(weekly stationary block bootstrap, mean block 8, 10000 draws, trade-weighted: sum pnl / n over drawn weeks).
Run: ../spx_fly/.venv/bin/python src/universe_eval.py out/univ_diag_trades.csv > out/univ_eval.txt"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bs
from stats import trimmed

CUT = pd.Timestamp("2025-11-01")
RET5_CUT = 0.0948


def boot_tw(g, col, block=8, n=10000, seed=0, q=(2.5, 97.5)):
    wk = g.groupby("entry")[col].agg(["sum", "count"]).sort_index()
    s, c = wk["sum"].values, wk["count"].values; N = len(s)
    if N < 5:
        return (np.nan,) * len(q)
    rng = np.random.default_rng(seed); p = 1 / block; m = np.empty(n)
    for i in range(n):
        idx = np.empty(N, int); j = rng.integers(N)
        for t in range(N):
            idx[t] = j; j = rng.integers(N) if rng.random() < p else (j + 1) % N
        m[i] = s[idx].sum() / c[idx].sum()
    return tuple(np.percentile(m, q))


def line(name, g, col):
    if g.empty:
        print(f"  {name}: no trades"); return
    lo, hi, blo, bhi = boot_tw(g, col, q=(2.5, 97.5, 1.25, 98.75))
    bys = g.groupby("sym")[col].mean()
    top = g.groupby("sym")[col].sum().idxmax()
    best5 = g.groupby("entry")[col].sum().nlargest(5).index
    print(f"  {name}: n {len(g)} mean {g[col].mean():+.3f} [{lo:+.3f},{hi:+.3f}] Bonf[{blo:+.3f},{bhi:+.3f}] med {g[col].median():+.3f} "
          f"trim2% {trimmed(g[col]):+.3f} syms+ {(bys > 0).sum()}/{len(bys)} ex-{top} {g[g.sym != top][col].mean():+.3f} "
          f"ex-best5wk {g[~g.entry.isin(best5)][col].mean():+.3f}")


t = pd.read_csv(sys.argv[1], parse_dates=["entry", "exp"])
t = t[t.k == 0.0].copy()          # costs are re-applied below from mid / half-spread
for k in (0.0, 0.5, 1.0):
    t[f"long{k:g}"] = (t.payoff - (t.mid + k * t.hs) * (1 + bs.R * t.T0) - t.H - t.C) / t.S0 * 100
    t[f"short{k:g}"] = ((t.mid - k * t.hs) * (1 + bs.R * t.T0) - t.payoff + t.H - t.C) / t.S0 * 100
# SPEC change 3: a rolling pool scores only entries in [screen day, next screen day); one section "pool".
POOL = os.environ.get("CSE_POOL")          # "YYYY-MM-DD,YYYY-MM-DD"
if POOL:
    lo_, hi_ = map(pd.Timestamp, POOL.split(","))
    t = t[(t.entry >= lo_) & (t.entry < hi_)].copy()
    t["period"] = "pool"
    PERIODS = ("pool",)
else:
    t["period"] = np.where(t.entry < CUT, "train", "test")
    PERIODS = ("train", "test", "all")
print(f"symbols {t.sym.nunique()}, entries {t.entry.min().date()} .. {t.entry.max().date()}, last expiry {t.exp.max().date()}\n")

for period in PERIODS:
    g0 = t if period in ("all", "pool") else t[t.period == period]
    print(f"=== {period} ===")
    a = g0[(g0.hedge == "static") & (g0.bucket == "3w") & (g0.right == "C")]
    d = g0[(g0.hedge == "daily") & (g0.bucket == "3w") & (g0.right == "C")]
    print(" P-0021 (long 3w call, static hedge):")
    for tg in (0.35, 0.25, 0.50, 0.15):
        for k in ("0.5", "1", "0") if tg == 0.35 else ("0.5",):
            line(f"Δ{tg} k{k}", a[a.tgt == tg], "long" + k)
    print(" P-0021 interpretation check (same rule, daily hedge):")
    for k in ("0.5", "0", "1"):
        line(f"Δ0.35 daily k{k}", d[d.tgt == 0.35], "long" + k)
    w = g0[(g0.hedge == "daily") & (g0.bucket == "wk") & (g0.right == "P") & (g0.tgt.isin([-0.25, -0.10]))]
    sig = w[w.ret5 > RET5_CUT]; ctl = w[(w.ret5 <= RET5_CUT) & w.entry.isin(sig.entry.unique())]
    print(" P-0022 (short weekly put after ret5 > 0.0948, daily hedge):")
    for k in ("0.5", "0", "1"):
        line(f"signal k{k}", sig, "short" + k)
    for tg in (-0.25, -0.10):
        line(f"signal Δ{tg} k0.5", sig[sig.tgt == tg], "short0.5")
    line("control same weeks ret5<=cut k0.5", ctl, "short0.5")
    line("all weeks, no signal filter k0.5", w, "short0.5")
    print()
