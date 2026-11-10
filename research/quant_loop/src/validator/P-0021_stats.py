"""V-0021 statistics on a trades table built by P-0021_build.py.
Inference (P-0021 §5, fixed): stationary block bootstrap over the time-ordered ISO weeks that have trades,
mean block 8 weeks (geometric, circular), 10000 resamples, seed 21; statistic = sum of pnl of all trades
in the drawn weeks / number of those trades (trade-weighted). Report 2.5/97.5 and 1.25/98.75.
The proposer's §4 interval (mean of weekly means) is also computed, for reconciliation only.

Usage: P-0021_stats.py <tag> [--full]
"""
import os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "V-0021_tables")
B, BLOCK, SEED = 10000, 8, 21


def week_index(t):
    wk = t.iso_y * 100 + t.iso_w
    order = np.sort(wk.unique())
    return pd.Series(np.searchsorted(order, wk), index=t.index), len(order)


def boot_idx(N, n=B, block=BLOCK, seed=SEED):
    rng = np.random.default_rng(seed)
    p = 1.0 / block
    start = rng.integers(N, size=(n, N))
    new = rng.random((n, N)) < p
    new[:, 0] = True
    idx = np.empty((n, N), int)
    cur = start[:, 0].copy()
    for t in range(N):
        cur = np.where(new[:, t], start[:, t], (cur + 1) % N)
        idx[:, t] = cur
    return idx


def boot(t, col, weekmean=False, idx=None):
    wi, N = week_index(t)
    s = np.bincount(wi, weights=t[col].values, minlength=N)
    c = np.bincount(wi, minlength=N).astype(float)
    if idx is None:
        idx = boot_idx(N)
    if weekmean:
        m = (s / np.where(c > 0, c, np.nan))[idx].mean(1)
    else:
        m = s[idx].sum(1) / c[idx].sum(1)
    return np.percentile(m, [2.5, 97.5, 1.25, 98.75]), m


def trimmed(x, q=0.02):
    x = np.sort(np.asarray(x, float)); c = int(len(x) * q)
    return x[c: len(x) - c].mean()


def summary(t, col, h_split=None):
    ci, dist = boot(t, col)
    ciw, _ = boot(t, col, weekmean=True)
    bys = t.groupby("sym")[col].agg(["sum", "mean", "count"])
    top = bys["sum"].idxmax()
    ex = t[t.sym != top][col].mean()
    d = dict(n=len(t), mean=t[col].mean(), lo=ci[0], hi=ci[1], lo_b=ci[2], hi_b=ci[3], p_le0=(dist <= 0).mean(),
             wlo=ciw[0], whi=ciw[1], median=t[col].median(), trim=trimmed(t[col]),
             pos_syms=f"{(bys['mean'] > 0).sum()}/{len(bys)}", top_sym=top, ex_top=ex, winrate=(t[col] > 0).mean())
    if h_split is not None:
        d["h1"] = t[t.entry < h_split][col].mean(); d["h2"] = t[t.entry >= h_split][col].mean()
    return d


def fmt(d):
    s = (f"n {d['n']:4d} mean {d['mean']:+.3f} [{d['lo']:+.2f},{d['hi']:+.2f}] bonf [{d['lo_b']:+.2f},{d['hi_b']:+.2f}] "
         f"P(boot<=0) {d['p_le0']:.3f} | wk-mean CI [{d['wlo']:+.2f},{d['whi']:+.2f}] | med {d['median']:+.3f} trim2% {d['trim']:+.3f} "
         f"win {d['winrate']:.1%} syms+ {d['pos_syms']} ex-{d['top_sym']} {d['ex_top']:+.3f}")
    if "h1" in d:
        s += f" h1 {d['h1']:+.3f} h2 {d['h2']:+.3f}"
    return s


if __name__ == "__main__":
    tag = sys.argv[1]
    t = pd.read_parquet(os.path.join(T, f"trades_{tag}.parquet"))
    split = pd.Timestamp("2025-05-01") if "train" in tag else pd.Timestamp("2026-05-01")
    print(f"== {tag}: {len(t)} trades, entries {t.entry.min().date()}..{t.entry.max().date()}, exp max {t.exp.max().date()}")
    for hedge in ("sta", "dyn"):
        for tgt in (0.35, 0.25, 0.50, 0.15):
            for k in (0, 0.5, 1):
                g = t[t.tgt == tgt]
                print(f"{hedge} Δ{tgt:.2f} k{k:g}: " + fmt(summary(g, f"{hedge}_k{k:g}", split)))
        g = t[t.tgt.isin([0.25, 0.35])]
        print(f"{hedge} Δ0.25+0.35 k0.5: " + fmt(summary(g, f"{hedge}_k0.5", split)))
