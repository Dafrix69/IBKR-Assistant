"""V-0021-pools: every number in validations/V-0021-pools.md comes from here (reads the one trades table).
Inference = P-0021 §5: stationary block bootstrap over time-ordered ISO weeks with trades (mean block 8,
circular), 10000 draws, seed 21, statistic = sum of pnl in drawn weeks / number of trades.
Output: V-0021_pools_tables/report.txt and summary.csv
"""
import os, sys
import numpy as np, pandas as pd
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
TD = os.path.join(HERE, "V-0021_pools_tables")
spec = importlib.util.spec_from_file_location("bd", os.path.join(HERE, "V-0021_pools_build.py"))
bd = importlib.util.module_from_spec(spec); spec.loader.exec_module(bd)
cc = bd.cc
B, BLOCK, SEED = 10000, 8, 21

t = pd.read_parquet(os.path.join(TD, "trades.parquet"))
t["wk"] = t.iso_y * 100 + t.iso_w
liq = pd.read_parquet(os.path.join(TD, "liq.parquet"))
cnt = pd.read_csv(os.path.join(TD, "exclusion_counts.csv"))
out = []
P = lambda s="": out.append(s)


def boot_idx(N, n=B, block=BLOCK, seed=SEED):
    rng = np.random.default_rng(seed)
    start = rng.integers(N, size=(n, N))
    new = rng.random((n, N)) < 1.0 / block
    new[:, 0] = True
    idx = np.empty((n, N), int); cur = start[:, 0].copy()
    for i in range(N):
        cur = np.where(new[:, i], start[:, i], (cur + 1) % N); idx[:, i] = cur
    return idx


_IDX = {}


def boot(g, col):
    order = np.sort(g.wk.unique()); wi = np.searchsorted(order, g.wk.values); N = len(order)
    s = np.bincount(wi, weights=g[col].values, minlength=N); c = np.bincount(wi, minlength=N).astype(float)
    if N not in _IDX: _IDX[N] = boot_idx(N)
    m = s[_IDX[N]].sum(1) / c[_IDX[N]].sum(1)
    return np.percentile(m, [2.5, 97.5, 1.25, 98.75]), (m <= 0).mean()


def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def trimmed(x, q=0.02):
    x = np.sort(np.asarray(x, float)); c = int(len(x) * q); return x[c: len(x) - c].mean()


def ci_s(g, col):
    ci, p = boot(g, col)
    return f"{g[col].mean():+.3f} [{ci[0]:+.2f},{ci[1]:+.2f}] bonf [{ci[2]:+.2f},{ci[3]:+.2f}] P(<=0) {p:.3f}", ci


def maxdd(g, col):
    w = g.groupby("wk")[col].mean().sort_index().cumsum(); return float((w - w.cummax()).min())


def buyhold(pool):
    rets = []
    for s in cc.members(pool):
        m = pd.read_parquet(os.path.join(cc.OUT, pool, f"{s}_files.parquet"))
        m = m[(m.nrows > 0) & (m.S > 0)].set_index("date").S.sort_index()
        m = m[(m.index >= pd.Timestamp(pool)) & (m.index < bd.WEND[pool])]
        J = [pd.Timestamp(x) for x in DEF[(DEF.pool == pool) & (DEF.sym == s)].day]
        if J:  # price series is not comparable across splits / reorganisations: chain-link around the defect day
            r = np.log(m).diff().drop(index=[d for d in J if d in m.index], errors="ignore").sum()
            rets.append(np.exp(r) - 1)
        else:
            rets.append(m.iloc[-1] / m.iloc[0] - 1)
    return np.mean(rets), np.median(rets), sum(np.array(rets) > 0), len(rets)


DEF = pd.read_csv(os.path.join(HERE, "V-0021_pools_defects.csv"), dtype={"pool": str})
POOLS = cc.POOLS
samples = [(p, t[t.pool == p], "pool") for p in POOLS[:-1]]
t24 = t[t.pool == "20241031"]
samples += [("20241031 全", t24, "pool"), ("20241031 训练段", t24[t24.seg == "train"], "seg"),
            ("20241031 测试段", t24[t24.seg == "test"], "seg"),
            ("合并 7 池", t, "pooled"), ("合并 2018–2023 六池", t[t.pool != "20241031"], "pooled")]

summ = []
for name, g, kind in samples:
    m = g[g.tgt == 0.35]
    P(f"\n===== {name}: Δ0.35 n {len(m)}, weeks {m.wk.nunique()}, syms {m.sym.nunique()}, entries {m.entry.min().date()}..{m.entry.max().date()}, exp max {m.exp.max().date()}")
    s05, ci05 = ci_s(m, "sta_k0.5"); s1, ci1 = ci_s(m, "sta_k1"); d05, cid = ci_s(m, "dyn_k0.5")
    c1 = m["sta_k0.5"].mean() > 0; c2 = (ci05[0] > 0) and (ci05[2] > 0); c3 = m["sta_k1"].mean() > 0
    verdict = "PASS" if (c1 and c2 and c3) else "FAIL"
    dyn_ok = m["dyn_k0.5"].mean() > 0 and cid[0] > 0
    interp = ("期权低估向上尾部（静态、每日都 > 0 且每日区间不含 0）" if (m["sta_k0.5"].mean() > 0 and dyn_ok)
              else ("动量 / 终值波动敞口，不是期权便宜" if m["sta_k0.5"].mean() > 0 else "静态 ≤ 0，解读不适用"))
    P(f"  [判定] 静态 k0.5 {s05}")
    P(f"  [判定] 静态 k1   {s1}")
    P(f"  [判定] (1) {c1} (2) {c2} (3) {c3} -> {verdict}")
    P(f"  [解读] 每日 k0.5 {d05} -> {interp}")
    x = m["sta_k0.5"]; lo, hi = wilson(int((x > 0).sum()), len(x))
    P(f"  win {(x > 0).mean():.1%} Wilson [{lo:.1%},{hi:.1%}] median {x.median():+.3f} trim2% {trimmed(x):+.3f}")
    bys = m.groupby("sym")["sta_k0.5"].agg(["sum", "mean", "count"])
    pos = int((bys["mean"] > 0).sum())
    top = bys["sum"].idxmax()
    P(f"  syms + {pos}/{len(bys)} ({pos / len(bys):.0%}); top contributor {top} (sum {bys['sum'].max():+.1f} of {x.sum():+.1f}) -> ex-top {m[m.sym != top]['sta_k0.5'].mean():+.3f}")
    if kind == "pooled":
        bsp = m.groupby(["sym", "pool"])["sta_k0.5"].sum(); tp = bsp.idxmax()
        P(f"  top code×pool {tp} (sum {bsp.max():+.1f}) -> ex {m[~((m.sym == tp[0]) & (m.pool == tp[1]))]['sta_k0.5'].mean():+.3f}")
        P("  per pool sta k0.5: " + "  ".join(f"{p[:4]} {m[m.pool == p]['sta_k0.5'].mean():+.3f}" for p in POOLS))
    for col in ("sta_k0.5", "dyn_k0.5"):
        ws = m.groupby("wk")[col].sum().sort_values(ascending=False); topw = ws.index[:5]
        gg = m[~m.wk.isin(topw)]; s, _ = ci_s(gg, col)
        P(f"  drop best 5 weeks {col}: {list(topw)} (sum {ws.iloc[:5].sum():+.1f} of {ws.sum():+.1f}) -> {s}")
    adj = {tg: g[g.tgt == tg]["sta_k0.5"].mean() for tg in (0.15, 0.25, 0.50)}
    same = all(np.sign(adj[tg]) == np.sign(x.mean()) for tg in (0.25, 0.50))
    P(f"  adjacent sta k0.5: Δ0.25 {adj[0.25]:+.3f} Δ0.50 {adj[0.50]:+.3f} (same sign: {same}); Δ0.15 {adj[0.15]:+.3f}")
    P("  k0/0.5/1: " + "  ".join(f"{h} " + "/".join(f"{m[f'{h}_k{k:g}'].mean():+.3f}" for k in (0, 0.5, 1)) for h in ("sta", "dyn")))
    if kind == "pool":
        if name.startswith("20241031"):
            mid = bd.WALL
        else:
            mid = pd.Timestamp(name[:8]) + (bd.WEND[name[:8]] - pd.Timestamp(name[:8])) / 2
        P(f"  halves (split {mid.date()}): {m[m.entry < mid]['sta_k0.5'].mean():+.3f} / {m[m.entry >= mid]['sta_k0.5'].mean():+.3f}"
          f"  dyn {m[m.entry < mid]['dyn_k0.5'].mean():+.3f} / {m[m.entry >= mid]['dyn_k0.5'].mean():+.3f}")
    P(f"  maxDD (cum weekly mean) sta {maxdd(m, 'sta_k0.5'):+.1f} dyn {maxdd(m, 'dyn_k0.5'):+.1f}")
    r0, _ = ci_s(m, "sta_r0_k0.5")
    itm = (m.payoff > 0).astype(float)
    com = ((0.65 * (1 + itm)) / 100 + 0.0035 * m.h0 * 2) / m.S0 * 100
    P(f"  sens r=0 financing: sta k0.5 {r0}; commission $0.65/ct+$0.0035/sh: sta {(m['sta_k0.5'] - com).mean():+.3f} dyn {(m['dyn_k0.5'] - com).mean():+.3f}")
    hsm = (m.hs / m.mid)
    lq = liq[liq.entry.isin(m.entry.unique()) & liq.pool.isin(m.pool.unique())]
    P(f"  liquidity: half-spread/mid median {hsm.median():.3f} (p75 {hsm.quantile(.75):.3f}); k0.5 cost % S0 median {(0.5 * m.hs / m.S0 * 100).median():.3f};"
      f" contract volume median {m.vol.median():.0f}, zero {(m.vol == 0).mean():.1%}; Δ0.10–0.60 bid=0 {lq.bid0.sum() / max(lq.n.sum(), 1):.1%}")
    summ.append(dict(sample=name, n=len(m), sta05=x.mean(), lo=ci05[0], hi=ci05[1], blo=ci05[2], bhi=ci05[3], sta1=m["sta_k1"].mean(),
                     verdict=verdict, dyn05=m["dyn_k0.5"].mean(), dlo=cid[0], dhi=cid[1], pos=f"{pos}/{len(bys)}",
                     ex_top=m[m.sym != top]["sta_k0.5"].mean(), top=top, trim=trimmed(x), d25=adj[0.25], d50=adj[0.50]))

P("\n===== exclusion counts (symbol-weeks; per target for the Δ rows)")
P(cnt.groupby("pool").sum(numeric_only=True).T.to_string())
P("\n===== equal-weight buy & hold over each pool window (background; split / reorg days chain-linked)")
for p in POOLS:
    mn, md, npos, n = buyhold(p)
    P(f"  {p}: mean {mn:+.1%} median {md:+.1%} up {npos}/{n}")
open(os.path.join(TD, "report.txt"), "w").write("\n".join(out) + "\n")
pd.DataFrame(summ).to_csv(os.path.join(TD, "summary.csv"), index=False)
print("\n".join(out))
