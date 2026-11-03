"""P-0013 analysis on the training period (date < 2024-11-01). Reads P-0013_build.py output."""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
NAMES = ["put", "call", "iron", "rev"]

s = pd.read_parquet(os.path.join(T, "struct_rows.parquet"))
s = s[s.date < SPLIT]                                         # time wall
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                  # time wall
ok = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01)]
s = s[s.date.isin(ok.index)].copy()
s["fomc"] = s.date.map(cal.fomc)
s["settle"] = s.date.map(cal.settle)
s["year"] = s.date.dt.year
s["hm"] = s.ts.dt.strftime("%H:%M")
for n in NAMES:
    for k in (0, 20, 50):
        s[f"E_{n}_k{k:02d}"] = (k / 100) * s[f"H_{n}"] * 100 + s[f"fee_{n}_k{k:02d}"]


def ci(x):
    x = pd.Series(x).dropna()
    m, se = x.mean(), x.std(ddof=1) / np.sqrt(len(x))
    return f"{m:+.2f} [{m - 1.96 * se:+.2f}, {m + 1.96 * se:+.2f}] n={len(x)}"


def block(d, label):
    print(f"\n=== {label}: {d.date.nunique()} days, {len(d)} rows")
    for k in (0, 20, 50):
        d[f"G_k{k:02d}"] = d[f"E_put_k{k:02d}"] - d[f"E_iron_k{k:02d}"]
    dd = d.groupby("date").mean(numeric_only=True)
    print(" G_a k0.20:", ci(dd.G_k20))
    print(" G_a k0   :", ci(dd.G_k00), "  k0.5:", ci(dd.G_k50))
    print(" by year k0.20:", {y: round(g.G_k20.mean(), 2) for y, g in dd.groupby(dd.year)})
    print(" dmid put-iron (USD):", ci((dd.mid_put - dd.mid_iron) * 100), " call-iron:", ci((dd.mid_call - dd.mid_iron) * 100))
    print(" k*dH part (USD):", ci(0.2 * (dd.H_put - dd.H_iron) * 100), " dfee part:", ci(dd.fee_put_k20 - dd.fee_iron_k20))
    for n in NAMES:
        print(f"  E_{n} k0.20 mean {dd[f'E_{n}_k20'].mean():.2f}  H {dd[f'H_{n}'].mean():.3f}")
    E = d[[f"E_{n}_k20" for n in NAMES]]
    print(" cheapest share (rows):", (E.idxmin(axis=1).str[2:-4].value_counts(normalize=True).round(3)).to_dict())
    tot = d[[f"mid_{n}" for n in NAMES]].mul(100).values + E.values
    print(" cheapest by total debit incl mid:", pd.Series(np.array(NAMES)[tot.argmin(1)]).value_counts(normalize=True).round(3).to_dict())
    return dd


s2 = s[s.maxsp <= 2.0]
p14 = s2[s2.hm == "14:00"].copy()
print("dropped by cap 2.0 at 14:00:", (s[s.hm == "14:00"].maxsp > 2.0).sum(), "of", (s.hm == "14:00").sum())
dd14 = block(p14, "14:00 baseline days, cap 2.0")
block(s[(s.hm == "14:00") & (s.maxsp <= 1.0)].copy(), "14:00 cap 1.0")
block(p14[~p14.fomc].copy(), "14:00 cap 2.0 no FOMC")
for h0, h1 in (("10:00", "10:59"), ("11:00", "11:59"), ("12:00", "12:59"), ("13:00", "13:59")):
    block(s2[(s2.hm >= h0) & (s2.hm <= h1)].copy(), f"grid {h0}-{h1}")

# (a') call - put vs sign(d), 14:00
p14["CP"] = p14.E_call_k20 - p14.E_put_k20
print("\n=== (a') E_call - E_put by sign(d), 14:00")
print(" all:", ci(p14.CP), " up:", ci(p14[p14.d > 0].CP), " down:", ci(p14[p14.d < 0].CP))
for y, g in p14.groupby("year"):
    print(f"  {y}: T = {g[g.d > 0].CP.mean() - g[g.d < 0].CP.mean():+.2f}  mean CP {g.CP.mean():+.2f} n={len(g)}")
T_all = p14[p14.d > 0].CP.mean() - p14[p14.d < 0].CP.mean()
se = np.sqrt(p14[p14.d > 0].CP.var() / (p14.d > 0).sum() + p14[p14.d < 0].CP.var() / (p14.d < 0).sum())
print(f" T = {T_all:+.2f} [{T_all - 1.96 * se:+.2f}, {T_all + 1.96 * se:+.2f}]")
print(" ITM spreads mean: put(K+w) %.3f call(K-w) %.3f ; OTM put(K-w) %.3f call(K+w) %.3f" % tuple(
    p14[c].mean() for c in ("itm_put_sp", "itm_call_sp", "otm_put_sp", "otm_call_sp")))
# grid version of (a')
g2 = s2.copy(); g2["CP"] = g2.E_call_k20 - g2.E_put_k20; g2["up"] = g2.d > 0
gd = g2[g2.d != 0].groupby(["date", "up"]).CP.mean().unstack().dropna()
print(" grid 10:00-14:00 T per day:", ci(gd[True] - gd[False]), {y: round((g[True] - g[False]).mean(), 2) for y, g in gd.groupby(gd.index.year)})

# (b) round strikes
print("\n=== (b) neighbour log-spread ratio")
r = pd.read_parquet(os.path.join(T, "round_rows.parquet"))
r = r[r.date < SPLIT]                                          # time wall
r = r[r.date.isin(ok.index)]
r["cls"] = np.where(r.strike % 50 == 0, "r50", np.where(r.strike % 25 == 0, "r25", "non"))
r["year"] = r.date.dt.year
r["mintick"] = r.spread <= np.where(r.mid < 3, 0.05, 0.10) + 1e-9
print(" share at min tick by class:", r.groupby("cls").mintick.mean().round(3).to_dict())
dm = r.groupby(["date", "cls"]).lr.mean().unstack()
for c in ("r25", "r50"):
    x = dm[c] - dm["non"]
    print(f" {c} - non (log): {ci(x)}  by year {({y: round(v.mean(), 4) for y, v in x.groupby(x.index.year)})}")
x = dm[["r25", "r50"]].mean(axis=1) - dm["non"]
print(f" any25 - non (log): {ci(x)}  by year {({y: round(v.mean(), 4) for y, v in x.groupby(x.index.year)})}")
for band in ((0, 10), (10, 25), (25, 50)):
    rb = r[(r.dist.abs() > band[0]) & (r.dist.abs() <= band[1])]
    dmb = rb.groupby(["date", "cls"]).lr.mean().unstack()
    print(f"  |K-S| in {band}: any25-non {ci(dmb[['r25','r50']].mean(axis=1) - dmb['non'])}")
print(" raw mean lr by class:", r.groupby("cls").lr.mean().round(4).to_dict())

# R_b at 14:00
print("\n=== R_b (shift centre to adjacent 25-multiple), 14:00")
b = p14[p14.mid_iron_K2.notna() & (p14.maxsp_K2 <= 2.0)].copy() if "mid_iron_K2" in p14 else p14.iloc[:0]
for n in ("put", "iron"):
    E1 = 0.2 * b[f"H_{n}"] * 100 + b[f"fee_{n}_k20"]
    E2 = 0.2 * b[f"H_{n}_K2"] * 100 + b[f"fee_{n}_K2"]
    pay1 = np.maximum(0, b.w - (b.settle - b.K).abs())
    pay2 = np.maximum(0, b.w - (b.settle - b.K2).abs())
    print(f" {n}: n={len(b)} dE(saving)={ci(E1 - E2)}  dmid(K2-K, USD)={ci((b[f'mid_{n}_K2'] - b[f'mid_{n}']) * 100)}"
          f"  dpayoff(K2-K, USD)={ci((pay2 - pay1) * 100)}")
    print("   by year dE:", {y: round(v.mean(), 2) for y, v in (E1 - E2).groupby(b.year)},
          " shift up/down share:", round((b.K2 > b.K).mean(), 3))

# cross-check vs winrate_panel (mid cost) at 14:00
wp = pd.read_parquet(os.path.join(R, "data/clean/winrate_panel.parquet"))
wp = wp[wp.date < SPLIT]                                       # time wall
wp = wp[wp.entry == "14:00"]
m = p14.merge(wp, left_on=["date", "K", "w"], right_on=["date", "K", "width"])
for n, st in (("put", "put_fly"), ("iron", "iron_fly")):
    mm = m[m.structure == st]
    print(f" panel check {st}: n={len(mm)} median |dmid| {np.median(np.abs(mm[f'mid_{n}'] - mm.cost)):.4f}")
dd14.reset_index().to_csv(os.path.join(T, "daily_1400.csv"), index=False)
