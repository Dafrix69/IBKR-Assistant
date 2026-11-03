"""P-0016 post-run diagnostics of the placebo (report only, does not change the gates)."""
import numpy as np, pandas as pd
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer"
SPLIT = pd.Timestamp("2025-11-01")
c = pd.read_parquet(f"{T}/P-0016_tables/cells_train.parquet")
c = c[c.date < SPLIT]                                            # time wall
c["Gq"] = 0.2 * (c.HA - c.HB) * 100
for kind in ("main", "plac"):
    g = c[(c.kind == kind) & c.hour.isin([13, 15])].dropna(subset=["Gq"])
    q = g.Gq
    print(kind, "n", len(q), "mean %+.3f median %+.3f trim5%% %+.3f share>0 %.2f" % (q.mean(), q.median(),
          q[(q > q.quantile(.05)) & (q < q.quantile(.95))].mean(), (q > 0).mean()))
    print("  worst/best 4:", g.nsmallest(4, "Gq")[["date", "hour", "w", "HA", "HB", "Gq"]].round(3).to_dict("records"))
    print("  ", g.nlargest(4, "Gq")[["date", "hour", "w", "HA", "HB", "Gq"]].round(3).to_dict("records"))

# median profile across day-hours (13/14/15, base non-event via main cells present), relative to the day-hour's own -60..-10 mean
p = pd.read_parquet(f"{T}/P-0016_tables/profile_train.parquet")
p = p[p.date < SPLIT]                                            # time wall
p = p[p.hour.isin([13, 14, 15])].dropna(subset=["H"])
pre = p[p.bucket < 0].groupby(["date", "hour"]).H.mean().rename("Hpre")
p = p.join(pre, on=["date", "hour"])
p["rel"] = p.H - p.Hpre
print("\nmedian / mean of H - own pre-minute level (points), 13+14+15 pooled (events NOT removed here):")
print(p.groupby("bucket").rel.agg(["median", "mean", lambda v: (v > 0).mean()]).round(4).T.to_string())
