"""V-0021 full metric set on one trades table (all numbers in the validation report come from here).
Usage: P-0021_report.py <tag>      e.g. train | test | etf_train_2023-01-27 | etf_test
"""
import importlib.util, json, os, sys
import numpy as np, pandas as pd
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("st", os.path.join(HERE, "P-0021_stats.py"))
st = importlib.util.module_from_spec(spec); spec.loader.exec_module(st)
spec = importlib.util.spec_from_file_location("bd", os.path.join(HERE, "P-0021_build.py"))
bd = importlib.util.module_from_spec(spec); spec.loader.exec_module(bd)

tag = sys.argv[1]
t = pd.read_parquet(os.path.join(st.T, f"trades_{tag}.parquet"))
t["wk"] = t.iso_y * 100 + t.iso_w
etf = tag.startswith("etf")
P = print


def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def line(g, col, label):
    d = st.summary(g, col)
    lo, hi = wilson(int((g[col] > 0).sum()), len(g))
    P(f"{label}: {st.fmt(d)} win-Wilson [{lo:.1%},{hi:.1%}]")
    return d


def maxdd(g, col):
    w = g.groupby("wk")[col].mean().sort_index().cumsum()
    return float((w - w.cummax()).min())


main = t[t.tgt == 0.35]
P(f"===== {tag}: {len(t)} trades; Δ0.35 n {len(main)}; weeks {main.wk.nunique()}; entries {t.entry.min().date()}..{t.entry.max().date()}; exp max {t.exp.max().date()}")
if etf:
    for sym in sorted(t.sym.unique()):
        g = t[(t.sym == sym) & (t.tgt == 0.35)]
        for col in ("sta_k0.5", "sta_k0.5_1bp", "sta_k1", "dyn_k0.5", "dyn_k0.5_1bp"):
            line(g, col, f"{sym} Δ0.35 {col}")
    for col in ("sta_k0.5", "sta_k0.5_1bp", "sta_k1", "dyn_k0.5", "dyn_k0.5_1bp"):
        line(main, col, f"ALL-ETF Δ0.35 {col}")
    for tgt in (0.25, 0.50):
        line(t[t.tgt == tgt], "sta_k0.5", f"ALL-ETF Δ{tgt} sta_k0.5")
    sys.exit()

P("\n-- §5 primary rows --")
for col in ("sta_k0.5", "sta_k1", "dyn_k0.5", "dyn10_k0.5", "dyn_k1"):
    line(main, col, f"Δ0.35 {col}")
for tgt in (0.25, 0.50, 0.15):
    for col in ("sta_k0.5", "dyn_k0.5"):
        line(t[t.tgt == tgt], col, f"Δ{tgt:.2f} {col}")
line(t[t.tgt.isin([0.25, 0.35])], "dyn_k0.5", "Δ0.25+0.35 dyn_k0.5")

P("\n-- commissions (not in P-0021 §3; protocol rule 5), Δ0.35 k0.5 --")
itm = (main.payoff > 0).astype(float)
c_ib = (0.65 * (1 + itm)) / 100 + 0.0035 * main.h0 * 2            # IB tiered-ish, size >= a few lots
c_min = (1.0 * (1 + itm) + 2 * 1.0) / 100                           # 1-lot: $1 per option leg, $1 min per stock order
for lab, c in (("$0.65/contract + $0.0035/share", c_ib), ("1-lot $1 min per leg/order", c_min)):
    for col in ("sta_k0.5", "dyn_k0.5"):
        g = main.assign(x=main[col] - c / main.S0 * 100)
        line(g, "x", f"  {col} with {lab}")
P(f"  median commission ($0.65 version) {np.median(c_ib / main.S0 * 100):.3f} % of S0; median S0 {main.S0.median():.2f}")

P("\n-- k 0 / 0.5 / 1, Δ0.35 --")
for h in ("sta", "dyn"):
    P("  " + "  ".join(f"{h} k{k:g} {main[f'{h}_k{k:g}'].mean():+.3f}" for k in (0, 0.5, 1)))

P("\n-- drop best 5 weeks (by weekly pnl sum), Δ0.35 --")
for col in ("sta_k0.5", "dyn_k0.5"):
    ws = main.groupby("wk")[col].sum().sort_values(ascending=False)
    top = ws.index[:5]
    g = main[~main.wk.isin(top)]
    d = st.summary(g, col)
    P(f"  {col}: best weeks {list(top)} (sum {ws.iloc[:5].sum():+.1f} of total {ws.sum():+.1f}) -> n {d['n']} mean {d['mean']:+.3f} [{d['lo']:+.2f},{d['hi']:+.2f}]")
for col in ("sta_k0.5", "dyn_k0.5"):
    top = main[col].nlargest(5)
    P(f"  {col}: best 5 trades sum {top.sum():+.1f} of total {main[col].sum():+.1f}; mean without them {main.drop(top.index)[col].mean():+.3f}")

P("\n-- by stock, Δ0.35 k0.5 --")
bys = main.groupby("sym").agg(n=("sta_k0.5", "size"), sta_mean=("sta_k0.5", "mean"), sta_sum=("sta_k0.5", "sum"),
                              dyn_mean=("dyn_k0.5", "mean"), dyn_sum=("dyn_k0.5", "sum"),
                              stock_ret_mean=("ST", lambda s: 0)).drop(columns="stock_ret_mean")
bys["S_ret_mean%"] = main.groupby("sym").apply(lambda g: ((g.ST / g.S0 - 1) * 100).mean())
P(bys.sort_values("sta_sum").round(3).to_string())
for col in ("sta_k0.5", "dyn_k0.5"):
    s = main.groupby("sym")[col].sum()
    top = s.idxmax()
    g = main[main.sym != top]
    d = st.summary(g, col)
    P(f"  drop top contributor {top} ({s.max():+.1f} of {s.sum():+.1f}) {col}: mean {d['mean']:+.3f} [{d['lo']:+.2f},{d['hi']:+.2f}]")
    top2 = s.nlargest(2).index
    g = main[~main.sym.isin(top2)]
    P(f"  drop top-2 {list(top2)} {col}: mean {g[col].mean():+.3f}")

P("\n-- by quarter (entry), Δ0.35 --")
q = main.entry.dt.to_period("Q")
P(main.groupby(q).agg(n=("sta_k0.5", "size"), sta=("sta_k0.5", "mean"), dyn=("dyn_k0.5", "mean"),
                      S_ret=("ST", "size")).assign(S_ret=main.groupby(q).apply(lambda g: ((g.ST / g.S0 - 1) * 100).mean())).round(3).to_string())
P(f"\n-- max drawdown (cum. sum of weekly mean pnl %, entry order), Δ0.35: sta_k0.5 {maxdd(main, 'sta_k0.5'):+.2f}  dyn_k0.5 {maxdd(main, 'dyn_k0.5'):+.2f}")

P("\n-- decomposition, Δ0.35 k0.5 (per trade, % of S0) --")
gap = main["sta_k0.5"] - main["dyn_k0.5"]
P(f"  static - daily = {gap.mean():+.3f}  [hedge-path term {( (main.hedge_sta - main.hedge_dyn) / main.S0 * 100).mean():+.3f}, "
  f"cost term {(-(main.turn_sta - main.turn_dyn) * 5e-4 / main.S0 * 100).mean():+.3f}]")
P(f"  unhedged long call (none_k0.5) mean {main['none_k0.5'].mean():+.3f}; stock move over the hold (S_T/S0-1) mean {((main.ST / main.S0 - 1) * 100).mean():+.3f}%"
  f"; h0·move mean {(main.h0 * (main.ST - main.S0) / main.S0 * 100).mean():+.3f}")
P(f"  regress sta_k0.5 on stock move: corr {np.corrcoef(main['sta_k0.5'], main.ST / main.S0 - 1)[0, 1]:+.3f}; "
  f"dyn_k0.5 corr {np.corrcoef(main['dyn_k0.5'], main.ST / main.S0 - 1)[0, 1]:+.3f}")
for lab, m in (("stock up over hold", main.ST > main.S0), ("stock down/flat", main.ST <= main.S0)):
    g = main[m]
    P(f"  {lab}: n {len(g)} sta {g['sta_k0.5'].mean():+.3f} dyn {g['dyn_k0.5'].mean():+.3f}")

P("\n-- within-trade shuffle of daily log-returns (keeps S0, S_T, payoff, static pnl; IV path & T grid fixed), 1000 x, Δ0.35 k0.5 --")
rng = np.random.default_rng(2021)
NS = 1000
obs_dyn = main["dyn_k0.5"].values
perm_dyn = np.zeros((NS, len(main)))
for j, r in enumerate(main.itertuples()):
    Sp = np.array(json.loads(r.path)); ivs = np.array(json.loads(r.ivpath)); Ts = np.array(json.loads(r.Ts))
    dt = -np.diff(np.r_[Ts, 0.0])
    lr = np.diff(np.log(Sp))
    T0 = r.dte / 365.0
    prem = (r.mid + 0.5 * r.hs) * (1 + bd.R * T0)
    for i in range(NS):
        p = np.exp(np.log(Sp[0]) + np.r_[0, np.cumsum(rng.permutation(lr))])
        h = bd.call_delta(p[:-1], r.K, Ts, ivs)
        carry = bd.R * p[:-1] * dt
        hedge = -np.sum(h * (np.diff(p) - carry))
        turn = h[0] * p[0] + np.sum(np.abs(np.diff(h)) * p[1:-1]) + h[-1] * p[-1]
        perm_dyn[i, j] = (r.payoff - prem + hedge - 5e-4 * turn) / r.S0 * 100
pm = perm_dyn.mean(1)
P(f"  observed daily mean {obs_dyn.mean():+.3f}; shuffled-path daily mean: median {np.median(pm):+.3f} [2.5% {np.percentile(pm, 2.5):+.3f}, 97.5% {np.percentile(pm, 97.5):+.3f}]")
P(f"  observed static-daily gap {gap.mean():+.3f}; shuffled gap median {np.median(main['sta_k0.5'].mean() - pm):+.3f}; "
  f"one-sided p (shuffled gap >= observed) {np.mean(main['sta_k0.5'].mean() - pm >= gap.mean()):.3f}")

P("\n-- week-block sign-flip (report only; invalid under strong skew), Δ0.35 k0.5 --")
for col in ("sta_k0.5", "dyn_k0.5"):
    ws = main.groupby("wk")[col].sum().values; wc = main.groupby("wk")[col].size().values
    sg = rng.choice([-1, 1], size=(10000, len(ws)))
    null = (sg * ws).sum(1) / wc.sum()
    P(f"  {col}: one-sided p {np.mean(null >= main[col].mean()):.4f}")

P("\n-- liquidity / capacity (chosen Δ0.35 contract at entry) --")
P(f"  half-spread/mid median {(main.hs / main.mid).median():.3f}, p75 {(main.hs / main.mid).quantile(.75):.3f}; full spread % of S0 median {(2 * main.hs / main.S0 * 100).median():.3f}")
P(f"  entry-day volume of the contract: median {main.vol.median():.0f}, zero-volume share {(main.vol == 0).mean():.1%}; "
  f"10% of day volume → median {np.median(0.1 * main.vol):.0f} contracts")
P(f"  cost of k 0.5 vs mid per trade: {(main['sta_k0'] - main['sta_k0.5']).mean():.3f} % of S0")
lq = pd.read_parquet(os.path.join(st.T, f"liq_{tag}.parquet"))
P(f"  Δ0.10–0.60 region at entry: quotes {lq.n.sum()}, bid=0 share {lq.bid0.sum() / max(lq.n.sum(), 1):.1%}")
P(f"  per-stock half-spread/mid median: " + ", ".join(f"{s} {v:.2f}" for s, v in (main.hs / main.mid).groupby(main.sym).median().items()))

P("\n-- context: equal-weight buy-and-hold of the names over the period (from entry-day closes) --")
sp = []
for sym in sorted(t.sym.unique()):
    s = pd.read_parquet(os.path.join(bd.C, f"{sym}_spot.parquet")).set_index("date").S.sort_index()
    s = s[(s.index >= t.entry.min()) & (s.index <= t.exp.max())] if "test" in tag else s[(s.index < bd.WALL)]
    if sym == "WOLF" and "train" in tag:
        s = s[s.index <= "2025-09-26"]
    sp.append((sym, s.iloc[-1] / s.iloc[0] - 1))
P("  " + ", ".join(f"{a} {b:+.0%}" for a, b in sp) + f"; equal-weight mean {np.mean([b for _, b in sp]):+.0%}")
