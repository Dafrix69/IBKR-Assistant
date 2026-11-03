"""V-0013 tape statistics (day-cluster bootstraps via per-day sufficient statistics).
Usage: V-0013_tape_stats.py train|test"""
import os, sys
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
period = sys.argv[1]
c = pd.read_parquet(os.path.join(OUT, f"tape_{period}.parquet"))
c = c[c.date < SPLIT] if period == "train" else c[c.date >= SPLIT]
c = c[((c.K - c.S).abs() <= 5) & (c.w >= 15) & (c.w < 80)].copy()
c["band"] = np.where(c.w < 30, "15-29", "30-79")
c["fly"] = c.struct != "iron"
for ref in ("own", "common", "asof"):
    c[f"s_{ref}"] = (c.net - c[ref]).abs()
c.loc[c.stale > 10, "s_asof"] = np.nan
c["k_own"] = c.s_own / c.H
c["k_asof"] = c.s_asof / c.H
rng = np.random.default_rng(13)
B = 1000


def day_weights(days, B):
    n = len(days)
    return np.stack([np.bincount(rng.integers(0, n, n), minlength=n) for _ in range(B)])   # B x n


def ratio_boot(x, col, W=None, days=None):
    x = x.dropna(subset=[col])
    days = days if days is not None else np.sort(x.date.unique())
    pos = pd.Index(days)
    agg = x.groupby(["date", "fly"])[col].agg(["sum", "count"]).unstack("fly").reindex(pos).fillna(0)
    sf, nf, si, ni = (agg[("sum", True)].values, agg[("count", True)].values, agg[("sum", False)].values, agg[("count", False)].values)
    obs = (sf.sum() / nf.sum()) / (si.sum() / ni.sum())
    if W is None:
        W = day_weights(days, B)
    r = (W @ sf / (W @ nf)) / (W @ si / (W @ ni))
    return obs, np.nanpercentile(r, [2.5, 97.5])


def perm(x, col):
    x = x.dropna(subset=[col])
    obs = x[x.fly][col].mean() / x[~x.fly][col].mean()
    lab = x.fly.values; v = x[col].values
    grp = pd.factorize(x.date.astype(str) + x.band)[0]
    order = np.argsort(grp, kind="stable"); grp_s = grp[order]; v_s = v[order]; lab_s = lab[order]
    bounds = np.r_[0, np.flatnonzero(np.diff(grp_s)) + 1, len(grp_s)]
    cnt = 0
    for _ in range(B):
        L = lab_s.copy()
        for a, b in zip(bounds[:-1], bounds[1:]):
            L[a:b] = L[a:b][rng.permutation(b - a)]
        cnt += (v_s[L].mean() / v_s[~L].mean()) >= obs
    return obs, (cnt + 1) / (B + 1)


def slope_boot(x, col):
    x = x.dropna(subset=[col]).assign(H2=lambda z: z.H ** 2, Hy=lambda z: z.H * z[col], y=lambda z: z[col])
    a = x.groupby("date")[["H", "H2", "y", "Hy"]].sum().join(x.groupby("date").size().rename("n"))
    def b_of(w):
        n, sH, sH2, sy, sHy = (w @ a[k].values for k in ("n", "H", "H2", "y", "Hy"))
        return (n * sHy - sH * sy) / (n * sH2 - sH ** 2), (sy - (n * sHy - sH * sy) / (n * sH2 - sH ** 2) * sH) / n
    W = day_weights(a.index, B)
    bs = np.array([b_of(W[i].astype(float))[0] for i in range(B)])
    b, a0 = b_of(np.ones(len(a)))
    return a0, b, np.percentile(bs, [2.5, 97.5])


def deconv_stats(x, which):
    """per (date, w): sums needed by the deconvolution."""
    x = x.dropna(subset=["s_asof"])
    f_ = x[x.struct.isin(which)]; i_ = x[~x.fly]
    F = f_.groupby(["date", "w"]).agg(nf=("H", "size"), Hf=("H", "sum"), qf=("s_asof", lambda s: (s ** 2).sum()),
                                      qfo=("s_own", lambda s: (s ** 2).sum()))
    I = i_.groupby(["date", "w"]).agg(ni=("H", "size"), Hi=("H", "sum"), qi=("s_asof", lambda s: (s ** 2).sum()),
                                      qio=("s_own", lambda s: (s ** 2).sum()))
    return F.join(I, how="outer").fillna(0).reset_index()


def deconv(T, wdays):
    T = T.assign(m=T.date.map(wdays))
    cols = ["nf", "Hf", "qf", "qfo", "ni", "Hi", "qi", "qio"]
    g = T[cols].mul(T.m, axis=0).groupby(T.w).sum()
    g = g[(g.nf >= 5) & (g.ni >= 5)]
    if g.empty:
        return [np.nan] * 7
    wt = g.nf / g.nf.sum()
    mf = (wt * (g.qf / g.nf - g.qi / g.ni + g.qio / g.ni)).sum()
    mi = (wt * (g.qio / g.ni)).sum()
    Hf, Hi = (wt * g.Hf / g.nf).sum(), (wt * g.Hi / g.ni).sum()
    mfo = (wt * g.qfo / g.nf).sum()
    rf, ri = np.sqrt(max(mf, 0)), np.sqrt(mi)
    return [rf, ri, rf / Hf, ri / Hi, 100 * (rf - ri), 20 * (Hf - Hi), np.sqrt(mfo) / Hf]


for rule, sub in (("V (aggregate repeats)", c), ("P (drop repeats)", c[~c.dup])):
    print(f"\n######## rule {rule}: {len(sub)} combos, {sub.date.nunique()} days")
    print(sub.groupby("struct").agg(n=("H", "size"), w=("w", "median"), H=("H", "mean"), lots=("lots", "median"),
                                    own=("s_own", "mean"), own_med=("s_own", "median"), common=("s_common", "mean"),
                                    common_med=("s_common", "median"), asof=("s_asof", "mean"), asof_med=("s_asof", "median"),
                                    k_own_med=("k_own", "median"), k_own_mean=("k_own", "mean"),
                                    k_asof_med=("k_asof", "median"), k_asof_mean=("k_asof", "mean")).round(3).to_string())
    for col in ("s_common", "s_own", "s_asof"):
        o, ci = ratio_boot(sub, col)
        line = f" M[{col}] all: {o:.3f} [{ci[0]:.3f}, {ci[1]:.3f}]"
        for bd, y in sub.groupby("band"):
            o, ci = ratio_boot(y, col)
            line += f" | {bd}: {o:.3f} [{ci[0]:.3f}, {ci[1]:.3f}] (fly {y.fly.sum()}, iron {(~y.fly).sum()})"
        print(line)
    if not rule.startswith("V"):
        continue
    for col in ("s_common", "s_asof"):
        print(f" perm (within day x band label shuffle, {B}) {col}: obs {perm(sub, col)[0]:.3f} p_one_sided {perm(sub, col)[1]:.4f}")
    for col in ("s_own", "s_asof", "s_common"):
        a0, b, ci = slope_boot(sub, col)
        line = f" slope {col} ~ a + b*H: a {a0:+.4f} b {b:+.4f} [{ci[0]:+.4f}, {ci[1]:+.4f}]"
        for s_, z in sub.groupby("struct"):
            line += f" | {s_} b {slope_boot(z, col)[1]:+.4f}"
        print(line)
    ir = sub[~sub.fly]
    print(f" noise floor iron: mean|net-common| - mean|net-own| {ir.s_common.mean() - ir.s_own.mean():+.4f};"
          f" mean|net-asof| - mean|net-own| {ir.s_asof.mean() - ir.s_own.mean():+.4f}")
    for bd, y in sub.groupby("band"):
        p_, i_ = y[y.struct == "put"], y[~y.fly]
        print(f" put-only band {bd}: n put {len(p_)} iron {len(i_)}; ratio asof {p_.s_asof.mean() / i_.s_asof.mean():.3f}, common {p_.s_common.mean() / i_.s_common.mean():.3f};"
              f" mean k_asof put {p_.k_asof.mean():.3f} iron {i_.k_asof.mean():.3f}; d mean|slip| asof USD {100 * (p_.s_asof.mean() - i_.s_asof.mean()):+.2f} vs model {20 * (p_.H.mean() - i_.H.mean()):+.2f}")
    if period == "test":
        sub = sub.assign(seg=np.where(sub.date < "2025-01-01", "2024-11~12", sub.date.dt.year.astype(str)))
        for s_, y in sub.groupby("seg"):
            print(f"  seg {s_}: fly {y.fly.sum()} iron {(~y.fly).sum()} M_common {ratio_boot(y, 's_common')[0]:.3f}"
                  f" M_asof {ratio_boot(y, 's_asof')[0]:.3f}  bands common " +
                  " ".join(f"{bd} {ratio_boot(z, 's_common')[0]:.3f}" for bd, z in y.groupby("band")))
    print(" asof coverage:", round(sub.s_asof.notna().mean(), 3), " median stale s:", round(sub.stale.median(), 2))
    print("\n ## Addendum 2 deconvolution (asof ref, per exact w, fly-count weights; rms units)")
    for which, lab in ((("put",), "put fly"), (("put", "call"), "put+call")):
        for bd, y in [("all", sub)] + list(sub.groupby("band")):
            T = deconv_stats(y, which)
            days = np.sort(T.date.unique())
            est = deconv(T, dict(zip(days, np.ones(len(days)))))
            W = day_weights(days, 300)
            bs = np.array([deconv(T, dict(zip(days, W[i]))) for i in range(300)])
            ci = lambda j: f"[{np.nanpercentile(bs[:, j], 2.5):.3f}, {np.nanpercentile(bs[:, j], 97.5):.3f}]"
            print(f"  {lab:8s} {bd:5s}: rms slip fly {est[0]:.4f} iron {est[1]:.4f} | k_rms fly {est[2]:.3f} {ci(2)} iron {est[3]:.3f} {ci(3)}"
                  f" | USD fly-iron {est[4]:+.2f} {ci(4)} vs k-model {est[5]:+.2f} | fly own-ref k_rms (undeconvolved) {est[6]:.3f}")
    sub.to_parquet(os.path.join(OUT, f"tape_{period}_filtered.parquet"))
