"""Pre-registered statistics for P-0023 (sig=ivol) and P-0024 (sig=vov). Usage: python P-0023_0024_stats.py ivol|vov
Reads only the training trade table built by P-0023_0024_backtest.py (entry AND exit < 2023-10-31)."""
import os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
WALL = pd.Timestamp("2023-10-31")
T = pd.read_pickle(os.path.join(HERE, "P-0023_0024_cache", "trades.pkl"))
T = T[(T["E"] < WALL) & (T["M"] < WALL)]          # time wall, first step after reading
RNG = np.random.default_rng(20261108)
NB = 10000


def week(d):
    return (d - pd.to_timedelta(d.dt.day_of_week, unit="D")).dt.normalize()


def boot_idx(W, nb=NB, L=8):
    p = 1.0 / L
    idx = np.empty((nb, W), dtype=np.int64)
    idx[:, 0] = RNG.integers(0, W, nb)
    jump = RNG.random((nb, W)) < p
    new = RNG.integers(0, W, (nb, W))
    for j in range(1, W):
        idx[:, j] = np.where(jump[:, j], new[:, j], (idx[:, j - 1] + 1) % W)
    return idx


def boot_ci(df, col, weeks_all, idx):
    """per-trade mean: resample calendar weeks, sum(pnl)/count."""
    g = df.groupby("wk")[col].agg(["sum", "count"]).reindex(weeks_all, fill_value=0)
    s = g["sum"].values[idx].sum(axis=1); c = g["count"].values[idx].sum(axis=1)
    m = s / np.where(c == 0, np.nan, c)
    return np.nanpercentile(m, [2.5, 97.5, 0.625, 99.375]), np.nanmean(m <= 0)


def boot_ci_cycle(diff, weeks_all, idx):
    g = diff.groupby("wk")["d"].agg(["sum", "count"]).reindex(weeks_all, fill_value=0)
    s = g["sum"].values[idx].sum(axis=1); c = g["count"].values[idx].sum(axis=1)
    m = s / np.where(c == 0, np.nan, c)
    return np.nanpercentile(m, [2.5, 97.5, 0.625, 99.375]), np.nanmean(m <= 0)


def assign(T, sig, nq):
    X = T[T["excl"].isna() & T[sig].notna()].copy()
    out = []
    for (pool, M, right), g in X.groupby(["pool", "M", "right"]):
        n = len(g)
        r = g[sig].rank(method="first")
        g = g.assign(q=(np.floor(nq * (r - 1) / n) + 1).astype(int), n_rank=n)
        out.append(g)
    return pd.concat(out)


def summ(d, weeks_all, idx, label):
    d = d[d["status"] == "ok"]
    if len(d) == 0:
        return f"{label}: n 0"
    ci05, p05 = boot_ci(d, "pnl_k05", weeks_all, idx)
    ci0, _ = boot_ci(d, "pnl_k0", weeks_all, idx)
    ci1, _ = boot_ci(d, "pnl_k1", weeks_all, idx)
    x = d["pnl_k05"]; lo, hi = x.quantile([0.02, 0.98])
    return (f"{label}: n {len(d):4d} | k0 {d.pnl_k0.mean():+.3f} [{ci0[0]:+.2f},{ci0[1]:+.2f}] | "
            f"k0.5 {x.mean():+.3f} [{ci05[0]:+.2f},{ci05[1]:+.2f}] Bonf [{ci05[2]:+.2f},{ci05[3]:+.2f}] p1s {p05:.3f} | "
            f"k1 {d.pnl_k1.mean():+.3f} [{ci1[0]:+.2f},{ci1[1]:+.2f}] | med {x.median():+.3f} trim2% {x[(x >= lo) & (x <= hi)].mean():+.3f}")


def main(sig):
    pid = {"ivol": "P-0023", "vov": "P-0024"}[sig]
    alt = {"ivol": "vol", "vov": "vovp"}[sig]
    outdir = os.path.join(HERE, f"{pid}_tables"); os.makedirs(outdir, exist_ok=True)
    L = []
    T2 = T.copy(); T2["wk"] = week(T2["E"])
    weeks_all = pd.date_range(T2["wk"].min(), T2["wk"].max(), freq="7D")
    idx = boot_idx(len(weeks_all))
    L.append(f"{pid} signal={sig}  training pools 2018..2022, entry and exit < {WALL.date()}  weeks in bootstrap grid {len(weeks_all)}")
    L.append(f"rows {len(T2)} (stock x cycle x right); excluded by defects {T2['excl'].notna().sum()}; "
             f"missing signal {T2[sig].isna().sum()}; status counts {T2.groupby('status').size().to_dict()}")
    Q = assign(T2, sig, 5)
    Qc = Q[Q["right"] == "C"]
    ok = Qc[Qc["status"] == "ok"]
    L.append(f"call cross-sections {Qc.groupby(['pool','M']).ngroups}; ranked stocks per cycle median {Qc.groupby(['pool','M']).size().median():.0f}; "
             f"Q5 picked {int((Qc.q==5).sum())}, Q5 traded {int(((Qc.q==5)&(Qc.status=='ok')).sum())} (skipped: {Qc[(Qc.q==5)&(Qc.status!='ok')].status.value_counts().to_dict()})")
    L.append("")
    L.append("== MAIN: Q5 short ATM monthly call, daily delta-hedged, held to expiry, % of S_E ==")
    q5 = ok[ok.q == 5]
    L.append(summ(q5, weeks_all, idx, "Q5 all pools"))
    for pool, g in q5.groupby("pool"):
        L.append(f"   pool {pool}: n {len(g):3d} k0 {g.pnl_k0.mean():+.3f} k0.5 {g.pnl_k05.mean():+.3f} k1 {g.pnl_k1.mean():+.3f} med {g.pnl_k05.median():+.3f}")
    for y, g in q5.groupby(q5.E.dt.year):
        L.append(f"   entry year {y}: n {len(g):3d} k0.5 {g.pnl_k05.mean():+.3f}")
    st = q5.groupby("sym").pnl_k05.agg(["mean", "sum", "count"])
    L.append(f"   stocks positive (k0.5 mean > 0): {(st['mean'] > 0).sum()}/{len(st)}")
    top = st["sum"].idxmax(); bot = st["sum"].idxmin()
    L.append(f"   largest contributor {top} (n {st.loc[top,'count']}, sum {st.loc[top,'sum']:+.2f}); without it k0.5 {q5[q5.sym != top].pnl_k05.mean():+.3f}; "
             f"largest loser {bot} (sum {st.loc[bot,'sum']:+.2f}); without it {q5[q5.sym != bot].pnl_k05.mean():+.3f}")
    wk = q5.groupby("wk").pnl_k05.sum().sort_values()
    L.append(f"   drop best 5 entry weeks ({', '.join(str(w.date()) for w in wk.index[-5:])}): k0.5 {q5[~q5.wk.isin(wk.index[-5:])].pnl_k05.mean():+.3f}; "
             f"drop worst 5: {q5[~q5.wk.isin(wk.index[:5])].pnl_k05.mean():+.3f}")
    L.append(f"   (dS-C) unit k0.5 mean {q5.pnl_k05_inv.mean():+.3f} %  median {q5.pnl_k05_inv.median():+.3f}")
    L.append(f"   + option commission 1 USD/contract: k0.5 {(q5.pnl_k05 - 1.0 / q5.S_E).mean():+.3f}")
    k_be = q5.pnl_k0.mean() / (q5.pnl_k0.mean() - q5.pnl_k1.mean()) if q5.pnl_k0.mean() > 0 else float('nan')
    hedge_pct = (q5.turnover * 0.05).mean()   # % of S at 5 bp (approx, entry price)
    L.append(f"   half-spread/S median {(q5.hs / q5.S_E * 100).median():.3f} %; hedge turnover median {q5.turnover.median():.2f} x (5 bp ~ {hedge_pct:.3f} % S); "
             f"break-even option k {k_be:.2f}; k0.5 with zero hedge fee ~ {q5.pnl_k05.mean() + hedge_pct:+.3f}")
    L.append("")
    L.append("== Descriptive: all quintiles (calls) ==")
    for qq in range(1, 6):
        L.append(summ(ok[ok.q == qq], weeks_all, idx, f"Q{qq}"))
    L.append(summ(ok, weeks_all, idx, "ALL"))
    # paired per-cycle differences
    cm = ok.groupby(["pool", "M", "q"]).pnl_k05.mean().unstack()
    allm = ok.groupby(["pool", "M"]).pnl_k05.mean()
    E_of = ok.groupby(["pool", "M"]).wk.first()
    for lab, dser in (("Q5-Q1", cm[5] - cm[1]), ("Q5-ALL", cm[5] - allm)):
        dd = pd.DataFrame({"d": dser, "wk": E_of}).dropna()
        ci, p = boot_ci_cycle(dd, weeks_all, idx)
        bypool = dd.groupby(level=0)["d"].mean()
        L.append(f"{lab} (k0.5, per-cycle paired): mean {dd.d.mean():+.3f} [{ci[0]:+.2f},{ci[1]:+.2f}] Bonf [{ci[2]:+.2f},{ci[3]:+.2f}] p1s {p:.3f}, "
                 f"cycles {len(dd)}, positive {int((dd.d > 0).sum())}; by pool " + " ".join(f"{k}:{v:+.2f}" for k, v in bypool.items()))
    L.append("")
    L.append("== Descriptive variants (counted) ==")
    Q3 = assign(T2, sig, 3); q3 = Q3[(Q3.right == "C") & (Q3.status == "ok") & (Q3.q == 3)]
    L.append(summ(q3, weeks_all, idx, "Top tercile call"))
    Qp = Q[(Q.right == "P") & (Q.status == "ok")]
    L.append(summ(Qp[Qp.q == 5], weeks_all, idx, "Q5 put"))
    L.append(summ(Qp[Qp.q == 1], weeks_all, idx, "Q1 put"))
    Qa = assign(T2, alt, 5); qa = Qa[(Qa.right == "C") & (Qa.status == "ok") & (Qa.q == 5)]
    L.append(summ(qa, weeks_all, idx, f"Q5 call sorted by {alt}"))
    # relation between the two round-23 signals
    X = T2[(T2.right == "C") & T2.excl.isna() & T2.ivol.notna() & T2.vov.notna()]
    rho = X.groupby(["pool", "M"]).apply(lambda g: g.ivol.rank().corr(g.vov.rank()))
    a = assign(X, "ivol", 5); b = assign(X, "vov", 5)
    ov = pd.merge(a[a.q == 5][["pool", "M", "sym"]], b[b.q == 5][["pool", "M", "sym"]]).shape[0] / max(1, (b.q == 5).sum())
    L.append(f"IVOL vs VOV cross-sectional Spearman: mean {rho.mean():+.2f} (cycles {len(rho)}); Q5 overlap {ov:.2f}")
    txt = "\n".join(L)
    print(txt)
    with open(os.path.join(outdir, f"{pid}_train.txt"), "w") as f:
        f.write(txt + "\n")
    Q.drop(columns=[c for c in ["K"] if False]).to_pickle(os.path.join(HERE, "P-0023_0024_cache", f"{pid}_assigned.pkl"))


if __name__ == "__main__":
    main(sys.argv[1])
