"""P-0014 analyze: round-hour spread notch N and the 14:00 -> 14:02 rule G. Training only.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0014_analyze.py
"""
import os

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0014_tables")
SPLIT = pd.Timestamp("2024-11-01")
K_ = 0.20
rng = np.random.default_rng(20261101)

prof = pd.read_parquet(os.path.join(T, "profile_rows.parquet"))
prof = prof[prof.date < SPLIT]                               # time wall
ent = pd.read_parquet(os.path.join(T, "entry_rows.parquet"))
ent = ent[ent.date < SPLIT]                                  # time wall
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                 # time wall
base = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01)]
nofomc = set(base.index[~base.fomc.astype(bool)])
allbase = set(base.index)


def boot(x, n=2000):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    if len(x) < 5:
        return np.nan, np.nan, np.nan, len(x)
    b = rng.choice(x, (n, len(x))).mean(1)
    return x.mean(), np.percentile(b, 2.5), np.percentile(b, 97.5), len(x)


def fmt(t, scale=1.0, nd=4):
    m, lo, hi, n = t
    return f"{m*scale:+.{nd}f} [{lo*scale:+.{nd}f}, {hi*scale:+.{nd}f}] n={n}"


# ---------- N: fixed-leg detrended notch ----------
def notch(g, struct, cap):
    h = g.set_index("off")
    ok = h[f"mx_{struct}"] <= cap
    H = h[f"H_{struct}"].where(ok)
    if pd.isna(H.get(0)):
        return pd.Series({"N0": np.nan, "N1": np.nan})
    fit = H.reindex([-5, -4, -3, -2, 2, 3, 4, 5]).dropna()
    if len(fit) < 6:
        return pd.Series({"N0": np.nan, "N1": np.nan})
    b, a = np.polyfit(fit.index.values.astype(float), fit.values, 1)
    n0 = H[0] - a
    n1 = H.get(1, np.nan) - (a + b) if not pd.isna(H.get(1, np.nan)) else np.nan
    return pd.Series({"N0": n0, "N1": n1})


def notch_table(days, struct="iron", cap=2.0):
    p = prof[prof.date.isin(days)]
    out = p.groupby(["anchor", "date"]).apply(lambda g: notch(g, struct, cap), include_groups=False).reset_index()
    out["N"] = out[["N0", "N1"]].mean(axis=1, skipna=False)
    return out


print("== N (points; dollars = x 20) iron, cap 2.0, no FOMC ==")
nt = notch_table(nofomc)
nt.to_csv(os.path.join(T, "notch_iron.csv"), index=False)
for an in ["11:00", "12:00", "13:00", "14:00", "15:00", "11:37", "12:37", "13:37", "14:37", "15:37"]:
    g = nt[nt.anchor == an]
    print(an, "N0", fmt(boot(g.N0)), "| N1", fmt(boot(g.N1)), "| N", fmt(boot(g.N)))
g = nt[nt.anchor == "14:00"].copy()
g["y"] = g.date.dt.year
print("14:00 N0 by year:", {y: round(v.N0.mean(), 4) for y, v in g.groupby("y")})
print("14:00 N  by year:", {y: round(v.N.mean(), 4) for y, v in g.groupby("y")})
print("14:00 N0 share > 0 / = 0 / < 0:", (g.N0 > 1e-9).mean().round(3), (g.N0.abs() <= 1e-9).mean().round(3), (g.N0 < -1e-9).mean().round(3))
for lab, kw in [("put", dict(struct="put")), ("iron cap1.0", dict(cap=1.0))]:
    x = notch_table(nofomc, **kw)
    x = x[x.anchor == "14:00"]
    print(f"14:00 {lab}: N0", fmt(boot(x.N0)), "| N", fmt(boot(x.N)))
x = notch_table(allbase)
x = x[x.anchor == "14:00"]
print("14:00 iron incl FOMC: N0", fmt(boot(x.N0)), "| N", fmt(boot(x.N)))

# raw fixed-leg profile around 14:00 (mean H relative to off 0, same days with all offsets)
p = prof[(prof.anchor == "14:00") & prof.date.isin(nofomc)].copy()
p["Hc"] = p.H_iron.where(p.mx_iron <= 2.0)
wide = p.pivot_table(index="date", columns="off", values="Hc").dropna()
print("\n== fixed 14:00 iron legs, mean H by offset (points), days with all offsets:", len(wide))
print((wide.mean()).round(4).to_string())
print("minus off0:", (wide.sub(wide[0], axis=0).mean()).round(4).to_dict())

# ---------- G: rule 14:00 -> 14:02 (re-selected) ----------
settle = cal.settle
ent = ent.copy()
ent["m"] = ent.ts.dt.hour * 60 + ent.ts.dt.minute - 14 * 60


def G_table(days, struct="iron", k=K_, cap=2.0, alt=2):
    kk = f"k{int(k*100):02d}"
    e = ent[ent.date.isin(days)].copy()
    e = e[e[f"mx_{struct}"] <= cap]
    e["E"] = k * e[f"H_{struct}"] * 100 + e[f"fee_{struct}_{kk}"]
    e["pay"] = np.maximum(0, e.w - (e.date.map(settle) - e.K).abs())
    e["pnl"] = (e.pay - e[f"mid_{struct}"]) * 100 - e.E
    a = e[e.m == 0].set_index("date")
    b = e[e.m == alt].set_index("date")
    j = a.merge(b, left_index=True, right_index=True, suffixes=("0", "1"), how="inner")
    j["G"] = j.E0 - j.E1
    j["kH"] = (j[f"H_{struct}0"] - j[f"H_{struct}1"]) * k * 100
    j["dfee"] = j[f"fee_{struct}_{kk}0"] - j[f"fee_{struct}_{kk}1"]
    j["dmid"] = (j[f"mid_{struct}1"] - j[f"mid_{struct}0"]) * 100
    j["dpay"] = (j.pay1 - j.pay0) * 100
    j["dpnl"] = j.pnl1 - j.pnl0
    j["chg"] = (j.K0 != j.K1) | (j.w0 != j.w1)
    lost = len(set(e[e.m == 0].date) ^ set(e[e.m == alt].date))
    return j, lost


print("\n== G = E(14:00) - E(14:02), USD/day ==")
j, lost = G_table(nofomc)
j.to_csv(os.path.join(T, "G_iron.csv"))
print("main iron k0.20 cap2 noFOMC:", fmt(boot(j.G), nd=3), "| days lost by symmetric pairing:", lost)
print("  kH", fmt(boot(j.kH), nd=3), "| dfee", fmt(boot(j.dfee), nd=3))
jj = j.copy(); jj["y"] = jj.index.year
print("  by year:", {y: round(v.G.mean(), 3) for y, v in jj.groupby("y")}, {y: len(v) for y, v in jj.groupby("y")})
print("  share G>0 / =0 / <0:", (j.G > 1e-9).mean().round(3), (j.G.abs() <= 1e-9).mean().round(3), (j.G < -1e-9).mean().round(3))
print("  K or w changed:", j.chg.mean().round(3))
print("  [report only] dmid", fmt(boot(j.dmid), nd=2), "| dpay", fmt(boot(j.dpay), nd=2), "| dPnL(14:02 - 14:00)", fmt(boot(j.dpnl), nd=2))
for lab, kw, days in [("put", dict(struct="put"), nofomc), ("iron cap1.0", dict(cap=1.0), nofomc),
                      ("iron k0.5", dict(k=0.5), nofomc), ("iron incl FOMC", {}, allbase),
                      ("iron alt 14:01 [desc]", dict(alt=1), nofomc), ("iron alt 14:03 [desc]", dict(alt=3), nofomc)]:
    x, l2 = G_table(days, **kw)
    xx = x.copy(); xx["y"] = xx.index.year
    print(f"{lab}: G", fmt(boot(x.G), nd=3), "| by year", {y: round(v.G.mean(), 3) for y, v in xx.groupby("y")}, "lost", l2)

# ---------- profile 13:55-14:10 re-selected E ----------
print("\n== re-selected iron E (USD) by minute, paired to 14:00 (no FOMC, cap 2) ==")
e = ent[ent.date.isin(nofomc) & (ent.mx_iron <= 2.0)].copy()
e["E"] = K_ * e.H_iron * 100 + e.fee_iron_k20
pv = e.pivot_table(index="date", columns="m", values="E")
d = pv.sub(pv[0], axis=0)
print(pd.DataFrame({"E": pv.mean().round(3), "E - E(14:00)": d.mean().round(3), "n": d.count()}).T.to_string())

# ---------- reconciliation gate 5 ----------
wp = pd.read_parquet(os.path.join(R, "data/clean/winrate_panel.parquet"))
wp = wp[wp.date < SPLIT]                                     # time wall
wp = wp[(wp.entry == "14:00") & (wp.structure == "iron_fly")][["date", "K", "width", "cost"]]
a = ent[ent.m == 0][["date", "K", "w", "mid_iron"]].merge(wp, left_on=["date", "K", "w"], right_on=["date", "K", "width"])
print("\nreconcile 14:00 iron mid vs winrate_panel: n", len(a), "median |diff|", (a.mid_iron - a.cost).abs().median())
