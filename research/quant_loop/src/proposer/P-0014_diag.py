"""P-0014 post-hoc diagnostics (written after analyze; report-only, not used to pick a rule).
(1) put-fly N0 at the other round hours and :37; (2) the 14:00 'step' S = mean H(0,1) - mean H(-5..-1)
of the fixed iron legs: concentration and top days. Training only."""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0014_tables")
SPLIT = pd.Timestamp("2024-11-01")
prof = pd.read_parquet(os.path.join(T, "profile_rows.parquet"))
prof = prof[prof.date < SPLIT]                               # time wall
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                 # time wall
base = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01) & (~cal.fomc.astype(bool))]
prof = prof[prof.date.isin(set(base.index))]
rng = np.random.default_rng(7)


def boot(x):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    b = rng.choice(x, (2000, len(x))).mean(1)
    return f"{x.mean():+.4f} [{np.percentile(b, 2.5):+.4f}, {np.percentile(b, 97.5):+.4f}] n={len(x)}"


def step(g, s, cap=2.0):
    h = g.set_index("off")
    H = h[f"H_{s}"].where(h[f"mx_{s}"] <= cap)
    pre, post = H.reindex([-5, -4, -3, -2, -1]).dropna(), H.reindex([0, 1]).dropna()
    fit = H.reindex([-5, -4, -3, -2, 2, 3, 4, 5]).dropna()
    n0 = np.nan
    if len(fit) >= 6 and not pd.isna(H.get(0)):
        b, a = np.polyfit(fit.index.values.astype(float), fit.values, 1); n0 = H[0] - a
    return pd.Series({"N0": n0, "S": post.mean() - pre.mean() if len(pre) >= 4 and len(post) == 2 else np.nan})


for s in ("put", "iron"):
    t = prof.groupby(["anchor", "date"]).apply(lambda g: step(g, s), include_groups=False).reset_index()
    print(f"== {s} ==")
    for an in sorted(t.anchor.unique()):
        g = t[t.anchor == an]
        print(an, "N0", boot(g.N0), "| step S", boot(g.S))
    if s == "iron":
        g = t[t.anchor == "14:00"].dropna(subset=["S"]).sort_values("S")
        print("14:00 iron step: share >0", round((g.S > 1e-9).mean(), 3), "<0", round((g.S < -1e-9).mean(), 3),
              "median", g.S.median(), "trimmed mean (drop top/bottom 5%)",
              round(g.S.iloc[int(.05*len(g)):int(.95*len(g))].mean(), 4))
        print("top 10 days:", [(str(d.date()), d.day_name()[:3], round(v, 3)) for d, v in zip(g.date.tail(10), g.S.tail(10))])
        print("mean without top 10:", round(g.S.iloc[:-10].mean(), 4))
