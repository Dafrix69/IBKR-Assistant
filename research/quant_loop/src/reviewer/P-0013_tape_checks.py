"""P-0013 review: adversarial re-reads of the validator's reconstructed combo table (tape_test_filtered.parquet,
rule V, |K-S|<=5, 15<=w<80). Nothing here re-fetches; it asks whether 'put fly deviates more than iron fly'
survives matching on the things that drive reference noise, and how big it is in USD.

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0013_tape_checks.py
"""
import numpy as np
import pandas as pd

V = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0013_tables"
c = pd.read_parquet(f"{V}/tape_test_filtered.parquet")
c = c[c.date >= "2024-11-01"]
pd.set_option("display.width", 250)
print("rows", len(c), c.struct.value_counts().to_dict())
c["hour"] = c.ts.dt.hour
c["minute"] = c.ts.dt.floor("min")
c["sg_common"] = c.net - c.common          # signed, long-fly debit terms: >0 = print above the iron-leg fair debit
c["sg_asof"] = np.where(c.stale <= 10, c.net - c["asof"], np.nan)
c["sg_own"] = c.net - c.own

print("\n[A] put - iron mean|net-asof| (USD) per exact w vs k-model 20*(H_put-H_iron); ratio = measured/model")
rows = []
for w, g in c.groupby("w"):
    p, i = g[g.struct == "put"], g[g.struct == "iron"]
    if len(p) < 300 or len(i) < 300:
        continue
    meas = 100 * (p.s_asof.mean() - i.s_asof.mean()); mc = 100 * (p.s_common.mean() - i.s_common.mean())
    model = 20 * (p.H.mean() - i.H.mean())
    rows.append((w, len(p), len(i), round(meas, 2), round(mc, 2), round(model, 2), round(meas / model, 2), round(mc / model, 2),
                 round(100 * (p.s_asof.median() - i.s_asof.median()), 2)))
A = pd.DataFrame(rows, columns=["w", "n_put", "n_iron", "asof_usd", "common_usd", "model_usd", "asof/model", "common/model", "median_diff_usd"])
print(A.to_string(index=False))
wt = A.n_put / A.n_put.sum()
print(" put-count-weighted: asof", round((wt * A.asof_usd).sum(), 2), "common", round((wt * A.common_usd).sum(), 2), "model", round((wt * A.model_usd).sum(), 2))

print("\n[B] reference staleness by structure (asof): the asof reference is fresher when the four iron legs just printed")
print(c.groupby("struct").stale.describe(percentiles=[.25, .5, .75, .9]).round(2).to_string())
for lo, hi in ((0, 0.5), (0.5, 2), (2, 5), (5, 10)):
    g = c[(c.stale > lo) & (c.stale <= hi)]
    for bd, y in g.groupby("band"):
        p, i = y[y.struct == "put"], y[y.struct == "iron"]
        print(f"  stale ({lo},{hi}] band {bd}: n put {len(p)} iron {len(i)}  put-iron mean|asof| USD {100*(p.s_asof.mean()-i.s_asof.mean()):+.2f}  model {20*(p.H.mean()-i.H.mean()):+.2f}")

print("\n[C] 13:30-14:30 ET only, 1-lots only (what a 14:00 one-lot order competes with)")
g = c[(c.ts.dt.hour * 60 + c.ts.dt.minute).between(13 * 60 + 30, 14 * 60 + 30) & (c.lots == 1)]
for bd, y in g.groupby("band"):
    p, i = y[y.struct == "put"], y[y.struct == "iron"]
    print(f"  band {bd}: n put {len(p)} iron {len(i)}  asof {100*(p.s_asof.mean()-i.s_asof.mean()):+.2f}  common {100*(p.s_common.mean()-i.s_common.mean()):+.2f}"
          f"  own {100*(p.s_own.mean()-i.s_own.mean()):+.2f}  model {20*(p.H.mean()-i.H.mean()):+.2f}  k_own iron mean {i.k_own.mean():.3f} med {i.k_own.median():.3f}")

print("\n[D] matched cells: same date, same minute, same K, same w, both a put fly and an iron fly printed.")
print("    Within a cell the chain 'common' reference is literally the same number, so structure mix cannot move it.")
key = ["date", "minute", "K", "w"]
for which in ("put", "call"):
    f = c[c.struct == which].groupby(key).agg(nf=("net", "size"), af=("s_common", "mean"), sf=("sg_common", "mean"), Hf=("H", "mean"))
    i = c[c.struct == "iron"].groupby(key).agg(ni=("net", "size"), ai=("s_common", "mean"), si=("sg_common", "mean"), Hi=("H", "mean"))
    m = f.join(i, how="inner").dropna().reset_index()
    m["band"] = np.where(m.w < 30, "15-29", "30-79")
    rng = np.random.default_rng(7)
    for bd, y in [("all", m)] + list(m.groupby("band")):
        dd = y.assign(da=100 * (y.af - y.ai), ds=100 * (y.sf - y.si), mo=20 * (y.Hf - y.Hi))
        per = dd.groupby("date").apply(lambda z: pd.Series({"n": z.nf.sum(), "da": (z.da * z.nf).sum(), "ds": (z.ds * z.nf).sum(), "mo": (z.mo * z.nf).sum()}), include_groups=False)
        obs = per.sum(); n = len(per)
        idx = rng.integers(0, n, (2000, n))
        P = per.values
        bs = P[idx].sum(1)
        ci = lambda j: np.percentile(bs[:, j] / bs[:, 0], [2.5, 97.5]).round(2)
        print(f"  {which} vs iron, band {bd}: cells {len(y)} days {n} | abs-dev diff USD {obs.da/obs.n:+.2f} {ci(1)} | signed level diff USD {obs.ds/obs.n:+.2f} {ci(2)} | model {obs.mo/obs.n:+.2f}")

print("\n[E] signed level of prints vs the iron-leg fair debit (USD/combo; >0 = printed above fair, i.e. against the fly buyer / iron seller)")
print((100 * c.groupby("struct")[["sg_own", "sg_common", "sg_asof"]].mean()).round(2).to_string())
print((100 * c.groupby(["band", "struct"])[["sg_own", "sg_common", "sg_asof"]].mean()).round(2).to_string())

print("\n[F] where the difference sits: share of prints by |net-asof| bucket (points)")
bk = pd.cut(c.s_asof, [-1e-9, 0.0251, 0.0501, 0.1001, 0.2001, 9], labels=["<=0.025", "0.05", "0.10", "0.20", ">0.20"])
print(pd.crosstab(c.struct, bk, normalize="index").round(3).to_string())
print(" own-ref:")
bk = pd.cut(c.s_own, [-1e-9, 0.0251, 0.0501, 0.1001, 0.2001, 9], labels=["<=0.025", "0.05", "0.10", "0.20", ">0.20"])
print(pd.crosstab(c.struct, bk, normalize="index").round(3).to_string())
