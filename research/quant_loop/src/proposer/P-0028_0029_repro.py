"""Reproduction of the published winrate_study rows, then step-by-step to the frozen P-0028 / P-0029 rules.
Reproduction columns are NOT variants. Training data only (2022-05-02 -> 2026-10-29)."""
import os
import sys
import importlib.util

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("rules", os.path.join(HERE, "P-0028_0029_rules.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
CACHE = os.path.join(HERE, "P-0028_0029_cache")
SPX = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly/data/clean"

snap = pd.read_parquet(os.path.join(CACHE, "snap_1400.parquet"))
snap = snap[(snap.date >= "2022-05-02") & (snap.date <= "2026-10-29")]        # TIME WALL: first data step
days = pd.read_parquet(os.path.join(CACHE, "days.parquet"))
days = days[(days.date >= "2022-05-02") & (days.date <= "2026-10-29")].set_index("date").sort_index()   # TIME WALL
books = {d: R.book(g) for d, g in snap.groupby("date")}
TEST = pd.Timestamp("2024-11-01")


def line(t, lab):
    def one(x):
        return f"n {len(x)} win {(x.pnl > 0).mean():.1%} ev {x.pnl.mean():+.1f} ev_k05 {x.pnl_k05.mean():+.1f}"
    print(f"{lab:62s} | train {one(t[t.index < TEST])} | test {one(t[t.index >= TEST])}")


def h1_run(widths, spot_col, select_on, structure, min_fee, k, prev_col, nan_skip, tie="smaller"):
    out = []
    for d, r in days.iterrows():
        if r.half_day:
            continue
        pr = r[prev_col]
        if pd.isna(pr):
            if nan_skip:
                continue
        elif pr <= -0.01:
            continue
        bk = books.get(d, {})
        st, K, I, w = R.h1_pick(bk, r[spot_col], widths, select_on)
        if st != "ok":
            continue
        if tie == "larger":
            fn = R.iron if select_on == "iron" else R.putfly
            cand = [x for x in widths if fn(bk, K, x) is not None]
            w = min(cand, key=lambda x: (abs(x / I - 2.0), -x))
        a = R.h1_pnl(bk, K, w, r.settle, k, structure, min_fee)
        b = R.h1_pnl(bk, K, w, r.settle, 0.5, structure, min_fee)
        if a is None:
            continue
        out.append({"date": d, "pnl": a[0], "pnl_k05": b[0], "K": K, "w": w})
    return pd.DataFrame(out).set_index("date")


print("=== H1 reproduction. Published: test 439 / 62.4% / +110 / +92 (widths 25/50/75, put fly, k 0.25, TWS spot, no min fee);")
print("    ledger 基准-A: test 439 / 61.0% / +100, train 543 / 58.0% / +59 (widths 20/25/30/50/75)")
# 0. straight from the published panel
wp = pd.read_parquet(os.path.join(SPX, "winrate_panel.parquet"))
wp = wp[wp.date >= "2022-05-02"]                                                  # TIME WALL
cal = pd.read_parquet(os.path.join(SPX, "calendar.parquet"))
cal = cal[cal.index >= "2022-05-02"]
for ws in ((25, 50, 75), (20, 25, 30, 50, 75)):
    g = wp[(wp.structure == "put_fly") & (wp.entry == "14:00") & wp.width.isin(ws)]
    g = g.assign(err=(g.w_over_implied - 2).abs()).sort_values(["err", "width"]).groupby("date").head(1).set_index("date").sort_index()
    g = g[~(g.index.map(cal.spx_ret_prev) <= -0.01)]
    line(g, f"0 published panel, widths {ws}")
base = dict(spot_col="spot_tws", select_on="put", structure="put", min_fee=False, k=0.25, prev_col="spx_ret_prev_clean", nan_skip=False)
for ws in ((25, 50, 75), (20, 25, 30, 50, 75)):
    line(h1_run(ws, **base), f"1 raw rebuild, widths {ws}, put/put, TWS, k.25, no min")
W5 = (20, 25, 30, 50, 75)
steps = [("2 + spot = underlying_1m 14:00", dict(base, spot_col="spot_u")),
         ("3 + prev-ret NaN -> skip", dict(base, spot_col="spot_u", nan_skip=True)),
         ("4 + $1 min commission per leg", dict(base, spot_col="spot_u", nan_skip=True, min_fee=True)),
         ("5 + k 0.2 (pnl col; k05 col unchanged)", dict(base, spot_col="spot_u", nan_skip=True, min_fee=True, k=0.2)),
         ("6 + select width on iron legs, put fly P&L", dict(base, spot_col="spot_u", nan_skip=True, min_fee=True, k=0.2, select_on="iron")),
         ("7 = FROZEN H1: iron fly P&L", dict(base, spot_col="spot_u", nan_skip=True, min_fee=True, k=0.2, select_on="iron", structure="iron")),
         ("7b frozen, tie -> larger width (report only)", dict(base, spot_col="spot_u", nan_skip=True, min_fee=True, k=0.2, select_on="iron", structure="iron", tie="larger"))]
for lab, kw in steps:
    line(h1_run(W5, **kw), lab)
a = h1_run(W5, **base)
b = h1_run(W5, **dict(base, spot_col="spot_u"))
j = a.join(b, rsuffix="_u", how="inner")
print("ATM strike differs TWS vs underlying_1m:", int((j.K != j.K_u).sum()), "of", len(j), "days; width differs:", int((j.w != j.w_u).sum()))
dd = days[~days.half_day]
print("spot_u - spot_tws at 14:00: median %.2f, |.| p95 %.2f, max %.2f" % ((dd.spot_u - dd.spot_tws).median(), (dd.spot_u - dd.spot_tws).abs().quantile(.95), (dd.spot_u - dd.spot_tws).abs().max()))

print()
print("=== H2 reproduction. Published (全样本, every qualifying strike counted): 15 wide 14:00 k0.25 74% / +38, k0.5 +32")
sc = os.path.join(SPX, "spread_credit_panel.parquet")
if os.path.exists(sc):
    p = pd.read_parquet(sc)
    p = p[p.date >= "2022-05-02"]                                                 # TIME WALL
    for lab, m in (("[3,4] (credit_3_4_by_year.csv)", lambda c: (c >= 3) & (c <= 4)), ("(3,4] (by_credit.csv bucket = published row)", lambda c: (c > 3) & (c <= 4))):
        s = p[(p.width == 15) & (p.entry == "14:00") & m(p.credit)]
        print(f"0 published panel rows {lab}: n {len(s)} days {s.date.nunique()} win {(s.pnl > 0).mean():.1%} ev {s.pnl.mean():+.1f} k05 {s.pnl_k05.mean():+.1f}")


def h2_run(spot_col, min_fee, k, one_per_day):
    out = []
    for d, r in days.iterrows():
        if r.half_day:
            continue
        bk = books.get(d, {})
        c = R.h2_candidates(bk, r[spot_col])
        sel = c if not one_per_day else ([R.h2_pick(c)] if c else [])
        for x in sel:
            out.append({"date": d, "pnl": R.h2_pnl(x, r.settle, k, 15, min_fee)[0], "pnl_k05": R.h2_pnl(x, r.settle, 0.5, 15, min_fee)[0]})
    return pd.DataFrame(out).set_index("date")


for lab, kw in [("1 raw rebuild, all rows, TWS, k.25, no min", dict(spot_col="spot_tws", min_fee=False, k=0.25, one_per_day=False)),
                ("2 + one per day (closest 3.5, tie higher K)", dict(spot_col="spot_tws", min_fee=False, k=0.25, one_per_day=True)),
                ("3 + spot underlying_1m", dict(spot_col="spot_u", min_fee=False, k=0.25, one_per_day=True)),
                ("4 + $1 min per leg", dict(spot_col="spot_u", min_fee=True, k=0.25, one_per_day=True)),
                ("5 = FROZEN H2 at k 0.2", dict(spot_col="spot_u", min_fee=True, k=0.2, one_per_day=True))]:
    t = h2_run(**kw)
    print(f"{lab:50s} | full n {len(t)} days {t.index.nunique()} win {(t.pnl > 0).mean():.1%} ev {t.pnl.mean():+.1f} k05 {t.pnl_k05.mean():+.1f}")
    line(t, "   split")
