"""V-0027 statistics: every P-0027 sec. 4-6 cell from the trade table built by V-0027_build.py.

Usage:  python V-0027_stats.py train
        python V-0027_stats.py test      (reads trades_test.pkl; the build is the one-shot step)
Output: src/validator/V-0027_tables/stats_<phase>.txt (+ summary csv)

Inference (P-0027 sec. 4): stationary block bootstrap over entry ISO weeks (Monday start), mean block 8 weeks,
10 000 draws; all calendar weeks between the first and last entry week of the phase take part (empty weeks
contribute 0 trades); statistic = sum of resampled P&L / number of resampled trades. One-sided p = share of
draws with mean <= 0. Seed fixed below.
"""
import os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "V-0027_cache")
OUT = os.path.join(HERE, "V-0027_tables")
WALL = pd.Timestamp("2023-10-31")
SEED = 270270
NB = 10000
L_BLOCK = 8


def week(d):
    d = pd.to_datetime(d)
    return (d - pd.to_timedelta(d.dt.day_of_week, unit="D")).dt.normalize()


def boot_idx(W, rng, nb=NB, L=L_BLOCK):
    idx = np.empty((nb, W), dtype=np.int64)
    idx[:, 0] = rng.integers(0, W, nb)
    jump = rng.random((nb, W)) < 1.0 / L
    new = rng.integers(0, W, (nb, W))
    for j in range(1, W):
        idx[:, j] = np.where(jump[:, j], new[:, j], (idx[:, j - 1] + 1) % W)
    return idx


class Boot:
    def __init__(self, weeks_all, seed=SEED):
        self.weeks = weeks_all
        self.idx = boot_idx(len(weeks_all), np.random.default_rng(seed))

    def dist(self, wk, x):
        g = pd.DataFrame({"wk": wk.values, "x": np.asarray(x, float)}).groupby("wk")["x"].agg(["sum", "count"])
        g = g.reindex(self.weeks, fill_value=0)
        s = g["sum"].values[self.idx].sum(axis=1); c = g["count"].values[self.idx].sum(axis=1)
        return s / np.where(c == 0, np.nan, c)

    def ci(self, wk, x):
        m = self.dist(wk, x)
        lo, hi = np.nanpercentile(m, [2.5, 97.5])
        return lo, hi, float(np.nanmean(m <= 0))


def assign(T, sig):
    """Quintiles per (pool, M) among rows with a valid signal and no defect exclusion.
    rank(method='first') on rows sorted by symbol -> ties broken alphabetically (P-0027 sec. 2)."""
    X = T[T["excl"].isna() & T[sig].notna()].copy()
    out = []
    for _, g in X.groupby(["pool", "M"]):
        g = g.sort_values("sym")
        n = len(g)
        r = g[sig].rank(method="first")
        out.append(g.assign(q=(np.floor(5 * (r - 1) / n) + 1).astype(int), n_rank=n))
    return pd.concat(out)


def wilson(k, n, z=1.959964):
    if n == 0:
        return np.nan, np.nan
    p = k / n; den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def bf_bound(p):
    if p <= 0:
        return np.inf
    if p >= 1 / np.e:
        return 1.0
    return 1.0 / (-np.e * p * np.log(p))


def main(phase):
    os.makedirs(OUT, exist_ok=True)
    T = pd.read_pickle(os.path.join(CACHE, f"trades_{phase}.pkl"))
    if phase == "train":
        T = T[(T["E"] < WALL) & (T["M"] < WALL)]        # wall, first step after reading
    else:
        T = T[T["E"] >= WALL]
    T = T.copy(); T["wk"] = week(T["E"])
    weeks_all = pd.date_range(T["wk"].min(), T["wk"].max(), freq="7D")
    B = Boot(weeks_all)
    L = []; S = {}
    P = L.append
    P(f"V-0027 {phase}: pools {sorted(T.pool.unique())}; cycles {T.groupby(['pool','M']).ngroups}; "
      f"entry weeks grid {len(weeks_all)} ({weeks_all[0].date()} .. {weeks_all[-1].date()}); seed {SEED}")
    P(f"stock-cycle rows {len(T)}; defect-excluded {T.excl.notna().sum()} ({T[T.excl.notna()].groupby('excl').size().to_dict()}); "
      f"IVOL missing {T.ivol.isna().sum()}; VOV missing {T.vov.isna().sum()}")
    Q = assign(T, "ivol")
    ok = Q[Q.status == "ok"]
    P(f"ranked per cycle median {Q.groupby(['pool','M']).size().median():.0f}; Q5 picked {(Q.q==5).sum()}, traded {((Q.q==5)&(Q.status=='ok')).sum()}; "
      f"Q5 skipped {Q[(Q.q==5)&(Q.status!='ok')].status.value_counts().to_dict()}")

    def cell(d, col="pnl_k05"):
        lo, hi, p = B.ci(d["wk"], d[col])
        return d[col].mean(), lo, hi, p

    def line(d, lab):
        m0 = cell(d, "pnl_k0"); m5 = cell(d, "pnl_k05"); m1 = cell(d, "pnl_k1")
        x = d.pnl_k05; lo, hi = x.quantile([0.02, 0.98])
        return (f"{lab}: n {len(d):4d} | k0 {m0[0]:+.3f} [{m0[1]:+.2f},{m0[2]:+.2f}] | k0.5 {m5[0]:+.3f} [{m5[1]:+.2f},{m5[2]:+.2f}] "
                f"p1s {m5[3]:.4f} | k1 {m1[0]:+.3f} [{m1[1]:+.2f},{m1[2]:+.2f}] | med {x.median():+.3f} trim2% {x[(x>=lo)&(x<=hi)].mean():+.3f}"), m5

    q5 = ok[ok.q == 5]
    P(""); P("== MAIN (P-0027 structure): Q5 short ATM straddle, one strike, net-delta hedged daily, held to M, % of S_E ==")
    txt, m5 = line(q5, "Q5"); P(txt)
    S["q5_n"] = len(q5); S["q5_k05"], S["q5_lo"], S["q5_hi"], S["q5_p"] = m5
    S["q5_k0"] = q5.pnl_k0.mean(); S["q5_k1"] = q5.pnl_k1.mean()
    win = (q5.pnl_k05 > 0).sum(); wl = wilson(win, len(q5))
    P(f"   win rate k0.5 {win}/{len(q5)} = {win/len(q5):.3f}, Wilson 95% [{wl[0]:.3f}, {wl[1]:.3f}]")
    for pool, g in q5.groupby("pool"):
        lo, hi, p = B.ci(g["wk"], g["pnl_k05"])
        P(f"   pool {pool}: n {len(g):3d} k0 {g.pnl_k0.mean():+.3f} k0.5 {g.pnl_k05.mean():+.3f} [{lo:+.2f},{hi:+.2f}] k1 {g.pnl_k1.mean():+.3f} med {g.pnl_k05.median():+.3f}")
        S[f"pool_{pool}"] = g.pnl_k05.mean()
    for y, g in q5.groupby(q5.E.dt.year):
        P(f"   entry year {y}: n {len(g):3d} k0.5 {g.pnl_k05.mean():+.3f} med {g.pnl_k05.median():+.3f}")
    st = q5.groupby(["pool", "sym"]).pnl_k05.agg(["sum", "count", "mean"])
    st_sym = q5.groupby("sym").pnl_k05.agg(["sum", "count"])
    S["pos_stocks"] = int((st_sym["sum"] > 0).sum()); S["n_stocks"] = len(st_sym)
    P(f"   positive stocks (sum of k0.5 over the stock's Q5 trades > 0): {S['pos_stocks']}/{S['n_stocks']} by symbol; "
      f"{(st['sum'] > 0).sum()}/{len(st)} by (pool, symbol)")
    top = st_sym["sum"].idxmax(); bot = st_sym["sum"].idxmin()
    d = q5[q5.sym != top]; lo, hi, _ = B.ci(d.wk, d.pnl_k05)
    P(f"   largest contributor {top} (n {st_sym.loc[top,'count']}, sum {st_sym.loc[top,'sum']:+.2f}); without it k0.5 {d.pnl_k05.mean():+.3f} [{lo:+.2f},{hi:+.2f}]; "
      f"largest loser {bot} (sum {st_sym.loc[bot,'sum']:+.2f}); without it {q5[q5.sym != bot].pnl_k05.mean():+.3f}")
    wk = q5.groupby("wk").pnl_k05.sum().sort_values()
    d = q5[~q5.wk.isin(wk.index[-5:])]; lo, hi, _ = B.ci(d.wk, d.pnl_k05)
    P(f"   drop best 5 entry weeks ({', '.join(str(w.date()) for w in wk.index[-5:])}): k0.5 {d.pnl_k05.mean():+.3f} [{lo:+.2f},{hi:+.2f}]; "
      f"drop worst 5: {q5[~q5.wk.isin(wk.index[:5])].pnl_k05.mean():+.3f}")
    # equity path (per-cycle mean of Q5, cumulative) and max drawdown
    cyc = q5.groupby(["M"]).pnl_k05.mean().sort_index()
    eq = cyc.cumsum(); dd = (eq - eq.cummax()).min()
    P(f"   per-cycle Q5 mean: {len(cyc)} cycles, positive {(cyc > 0).sum()}; cumulative {eq.iloc[-1]:+.2f}; max drawdown {dd:+.2f} (% S, sum of cycle means)")
    P(f"   % of entry straddle mid (k0.5): mean {(q5.pnl_k05 * q5.S_E / q5.mid).mean():+.2f} %, median {(q5.pnl_k05 * q5.S_E / q5.mid).median():+.2f} %; "
      f"straddle mid median {(q5.mid / q5.S_E * 100).median():.2f} % S")
    P(f"   + option commission 1 USD/contract/leg (0.02 USD per share-straddle): k0.5 {(q5.pnl_k05 - 2.0 / q5.S_E).mean():+.3f}")
    P(f"   costs: half-spread sum / S median {(q5.hs / q5.S_E * 100).median():.3f} % (k0.5 entry cost median {(0.5*q5.hs/q5.S_E*100).median():.3f} %); "
      f"half-spread / mid median {(q5.hs / q5.mid).median():.3f}; hedge turnover median {q5.turnover.median():.2f} x (5 bp ~ {(q5.turnover*0.05).median():.3f} % S)")
    P(f"   liquidity: entry volume at K call median {q5.vol_c.median():.0f}, put median {q5.vol_p.median():.0f}; zero-volume legs "
      f"call {(q5.vol_c == 0).mean():.2f} put {(q5.vol_p == 0).mean():.2f}; min(call,put) volume p25 {np.minimum(q5.vol_c, q5.vol_p).quantile(.25):.0f}")
    P(f"   delta0 (net, entry) median {q5.delta0.median():+.3f}; days held median {q5.ndays.median():.0f}")

    P(""); P("== Quintiles (P-0027 structure), k0 / k0.5 / k1 ==")
    for qq in range(1, 6):
        txt, m = line(ok[ok.q == qq], f"Q{qq}"); P(txt); S[f"Q{qq}_k05"] = m[0]
    txt, m = line(ok, "ALL"); P(txt); S["ALL_k05"] = m[0]
    cm = ok.groupby(["pool", "M", "q"]).pnl_k05.mean().unstack()
    allm = ok.groupby(["pool", "M"]).pnl_k05.mean()
    E_of = ok.groupby(["pool", "M"]).wk.first()
    for lab, ds in (("Q5-Q1", cm[5] - cm[1]), ("Q5-ALL", cm[5] - allm)):
        dd_ = pd.DataFrame({"d": ds, "wk": E_of}).dropna()
        lo, hi, p = B.ci(dd_.wk, dd_.d)
        S[lab] = dd_.d.mean(); S[lab + "_lo"] = lo; S[lab + "_hi"] = hi
        P(f"{lab} (k0.5, per-cycle paired, mean over cycles): {dd_.d.mean():+.3f} [{lo:+.2f},{hi:+.2f}] p1s {p:.4f}; cycles {len(dd_)}, positive {(dd_.d>0).sum()}; "
          "by pool " + " ".join(f"{k}:{v:+.2f}" for k, v in dd_.groupby(level=0).d.mean().items()))

    P(""); P("== Borrow (net short hedge) ==")
    sdp = q5.sdpct
    be = q5.pnl_k05.mean() / sdp.mean() if sdp.mean() > 0 else np.nan
    S["be_fee"] = be
    P(f"   net short share-days: mean {sdp.mean():.4f} % S_E-years per trade (i.e. 1 %/yr fee costs {sdp.mean()*0.01:.4f} % S), "
      f"trades with any short day {(q5.short_sd > 0).mean():.2f}")
    P(f"   break-even annual borrow fee (Q5 k0.5 mean -> 0): {be*100:.1f} %" if be == be else "   break-even: n/a")
    for f in (0.10, 0.25, 0.50):
        x = q5.pnl_k05 - f * sdp; lo, hi, p = B.ci(q5.wk, x)
        S[f"borrow_{int(f*100)}"] = x.mean()
        P(f"   k0.5 after {int(f*100)} %/yr borrow on net short: {x.mean():+.3f} [{lo:+.2f},{hi:+.2f}] p1s {p:.4f}")

    P(""); P("== Mechanism reading: Q5 split by entry put-call IV gap (same K) at the Q5 median of this phase ==")
    med = q5.gap.median()
    for lab, g in (("low gap (<= median)", q5[q5.gap <= med]), ("high gap (> median)", q5[q5.gap > med])):
        lo, hi, p = B.ci(g.wk, g.pnl_k05)
        key = "low" if lab.startswith("low") else "high"
        S[f"half_{key}"] = g.pnl_k05.mean(); S[f"half_{key}_n"] = len(g)
        P(f"   {lab}: n {len(g)} gap median {g.gap.median():+.4f} | k0.5 {g.pnl_k05.mean():+.3f} [{lo:+.2f},{hi:+.2f}] p1s {p:.4f} | "
          f"k1 {g.pnl_k1.mean():+.3f} | med {g.pnl_k05.median():+.3f} | short-days mean {g.sdpct.mean():.4f} | by pool "
          + " ".join(f"{k}:{v:+.2f}(n{n})" for (k, v), n in zip(g.groupby('pool').pnl_k05.mean().items(), g.groupby('pool').size())))
    P(f"   median gap (Q5) {med:+.4f}; mean {q5.gap.mean():+.4f}; corr(k0.5, gap) {q5.pnl_k05.corr(q5.gap):+.2f}")

    P(""); P("== VOV sort (P-0024 signal), Q5 k0.5 ==")
    Qv = assign(T, "vov"); qv = Qv[(Qv.status == "ok") & (Qv.q == 5)]
    txt, m = line(qv, "VOV Q5"); P(txt); S["vov_q5"] = m[0]
    a = set(map(tuple, q5[["pool", "M", "sym"]].values)); b = set(map(tuple, qv[["pool", "M", "sym"]].values))
    P(f"   overlap with IVOL Q5: {len(a & b)}/{len(b)}")

    P(""); P("== Training-diagnostic structure (each leg own nearest strike, own hedge, own 5 bp), IVOL Q5 ==")
    Qd = Q[(Q.d_status == "ok")]
    for qq in (1, 5):
        g = Qd[Qd.q == qq]
        r0 = cell(g, "d_pnl_k0"); r5 = cell(g, "d_pnl_k05"); r1 = cell(g, "d_pnl_k1")
        P(f"   Q{qq}: n {len(g)} k0 {r0[0]:+.3f} k0.5 {r5[0]:+.3f} [{r5[1]:+.2f},{r5[2]:+.2f}] p1s {r5[3]:.4f} k1 {r1[0]:+.3f} med {g.d_pnl_k05.median():+.3f}"
          + ("; by pool " + " ".join(f"{k}:{v:+.2f}(n{n})" for (k, v), n in zip(g.groupby('pool').d_pnl_k05.mean().items(), g.groupby('pool').size())) if qq == 5 else ""))
        S[f"diag_Q{qq}"] = r5[0]
    g = Qd[Qd.q == 5]
    P(f"   Q5 diag: strikes differ in {(g.d_Kc != g.d_Kp).mean():.2f} of trades; diag gap median {g.d_gap.median():+.4f}")
    both = Q[(Q.q == 5) & (Q.status == "ok") & (Q.d_status == "ok")]
    P(f"   same Q5 trades in both structures: n {len(both)}; spec {both.pnl_k05.mean():+.3f} vs diag {both.d_pnl_k05.mean():+.3f}; "
      f"corr {both.pnl_k05.corr(both.d_pnl_k05):+.3f}")

    # permutation (declared in V-0027 sec. 0): shuffle IVOL labels within each cycle, Q5-Q1 paired mean
    rng = np.random.default_rng(SEED + 1)
    base = ok[["pool", "M", "q", "pnl_k05"]].copy()
    obs = S["Q5-Q1"]; cnt = 0; NP = 1000
    grp = [g for _, g in base.groupby(["pool", "M"])]
    for _ in range(NP):
        diffs = []
        for g in grp:
            qs = rng.permutation(g.q.values)
            x = g.pnl_k05.values
            a5 = x[qs == 5]; a1 = x[qs == 1]
            if len(a5) and len(a1):
                diffs.append(a5.mean() - a1.mean())
        cnt += np.mean(diffs) >= obs
    S["perm_p"] = (cnt + 1) / (NP + 1)
    P(""); P(f"Permutation (1000 within-cycle shuffles of quintile labels among traded rows), Q5-Q1 k0.5: observed {obs:+.3f}, p(perm >= obs) {S['perm_p']:.4f}")

    p = S["q5_p"]; bf = bf_bound(p); po = 0.15 / 0.85 * bf
    S["bf"] = bf; S["post"] = po / (1 + po)
    P(f"Posterior bound: one-sided p {p:.4f} -> BF <= {bf:.3f} -> posterior <= {S['post']*100:.1f} % (prior 15 %)")
    txt = "\n".join(L)
    print(txt)
    with open(os.path.join(OUT, f"stats_{phase}.txt"), "w") as f:
        f.write(txt + "\n")
    pd.Series(S).to_csv(os.path.join(OUT, f"summary_{phase}.csv"), header=["value"])


if __name__ == "__main__":
    main(sys.argv[1])
