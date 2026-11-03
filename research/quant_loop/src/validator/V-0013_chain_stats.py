"""V-0013 chain-side statistics. Usage: V-0013_chain_stats.py train|test"""
import os, sys
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
period = sys.argv[1]
d = pd.read_parquet(os.path.join(OUT, f"chain_{period}.parquet"))
d = d[d.date < SPLIT] if period == "train" else d[d.date >= SPLIT]
rng = np.random.default_rng(13)


def boot(x, B=5000):
    x = np.asarray(pd.Series(x).dropna(), float)
    if len(x) < 2:
        return f"{x.mean() if len(x) else np.nan:+.2f} n={len(x)}"
    bs = x[rng.integers(0, len(x), (B, len(x)))].mean(1)
    return f"{x.mean():+.2f} [{np.percentile(bs, 2.5):+.2f}, {np.percentile(bs, 97.5):+.2f}] n={len(x)}"


def seg(dt):
    if period == "train":
        return dt.dt.year.astype(str)
    return np.where(dt < "2025-01-01", "2024-11~12", dt.dt.year.astype(str))


print(f"=== {period}: rows {len(d)}, cap2 dropped {(d.maxsp > 2).sum()}, FOMC rows {d.fomc.sum()} (of which cap2-dropped {(d.fomc & (d.maxsp > 2)).sum()})")
for cap in (2.0, 1.0):
    x = d[d.maxsp <= cap].copy()
    x["seg"] = seg(x.date)
    G = {k: x[f"E_put_k{k}"] - x[f"E_iron_k{k}"] for k in ("00", "20", "50")}
    print(f"\n-- cap {cap}: {len(x)} days")
    print(" G_a k0.20:", boot(G["20"]), " share>0", round((G["20"] > 0).mean(), 3), " min", round(G["20"].min(), 2))
    print(" G_a k0   :", boot(G["00"]), "  k0.5:", boot(G["50"]))
    print(" segments k0.20:", {s: round(v.mean(), 2) for s, v in G["20"].groupby(x.seg)}, {s: len(v) for s, v in G["20"].groupby(x.seg)})
    print(" segments k0   :", {s: round(v.mean(), 2) for s, v in G["00"].groupby(x.seg)})
    print(" split  k*dH:", boot(20 * (x.H_put - x.H_iron)), " dfee:", boot(x.fee_put_k20 - x.fee_iron_k20),
          " dmid put-iron USD:", boot(100 * (x.mid_put - x.mid_iron)), " call-iron:", boot(100 * (x.mid_call - x.mid_iron)))
    print(" H put/call/iron:", [round(x[f"H_{s}"].mean(), 3) for s in ("put", "call", "iron")],
          " E k0.20 put/call/iron:", [round(x[f"E_{s}_k20"].mean(), 2) for s in ("put", "call", "iron")])
    print(" G_a by w:", {int(w): round(v.mean(), 2) for w, v in G["20"].groupby(x.w)}, {int(w): len(v) for w, v in G["20"].groupby(x.w)})
    if cap == 2.0:
        top5 = G["20"].sort_values().iloc[:-5]
        print(" drop best 5 days:", boot(top5))
        for t in ("_wm", "_wp"):
            ok = x[f"maxsp{t}"].notna() & (x[f"maxsp{t}"] <= 2.0) if f"maxsp{t}" in x else None
            g = (x[f"E_put_k20{t}"] - x[f"E_iron_k20{t}"])[ok]
            print(f" w {t}:", boot(g))
        nf = ~x.fomc.astype(bool)
        print(" no FOMC:", boot(G["20"][nf]), " FOMC rows kept:", int(x.fomc.sum()))
        # T
        CP = x.E_call_k20 - x.E_put_k20
        up, dn = x.d > 0, x.d < 0
        print("\n T: mean CP", boot(CP), " up", round(CP[up].mean(), 2), up.sum(), " down", round(CP[dn].mean(), 2), dn.sum())
        a, b = CP[up].values, CP[dn].values
        bs = [rng.choice(a, len(a)).mean() - rng.choice(b, len(b)).mean() for _ in range(5000)]
        print(f" T = {a.mean() - b.mean():+.2f} [{np.percentile(bs, 2.5):+.2f}, {np.percentile(bs, 97.5):+.2f}]")
        Ts = {}
        for s, g in x.groupby("seg"):
            cp = g.E_call_k20 - g.E_put_k20
            Ts[s] = (round(cp[g.d > 0].mean() - cp[g.d < 0].mean(), 2), int((g.d > 0).sum()), int((g.d < 0).sum()))
        print(" T segments:", Ts)
        print(" T k0 (spread-only check):", round((x.E_call_k00 - x.E_put_k00)[up].mean() - (x.E_call_k00 - x.E_put_k00)[dn].mean(), 2))
        x.assign(G20=G["20"]).to_csv(os.path.join(OUT, f"daily_{period}.csv"), index=False)
