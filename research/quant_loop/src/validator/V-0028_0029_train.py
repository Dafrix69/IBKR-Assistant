"""V-0028/0029 training reproduction (2022-05-02 -> 2026-10-29, already-seen period). Not used for any verdict.

    research/spx_fly/.venv/bin/python src/validator/V-0028_0029_train.py [--extract]
Compares with the proposer's numbers (P-0028 §7.1, P-0029 §7.1) and day-by-day with their cached trades (read only).
"""
import importlib.util
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("vc", os.path.join(HERE, "V-0028_0029_common.py"))
C = importlib.util.module_from_spec(spec)
sys.modules["vc"] = C
spec.loader.exec_module(C)

LO, HI = "20220502", "20261029"
KS = (0.0, 0.2, 0.5, 1.0)
SEED = 20261110
SPX = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"

if "--extract" in sys.argv or not os.path.exists(os.path.join(C.CACHE, "train_days.parquet")):
    C.extract(LO, HI, "train")
snap = pd.read_parquet(os.path.join(C.CACHE, "train_snap.parquet"))
snap = snap[(snap.date >= "2022-05-02") & (snap.date <= "2026-10-29")]          # first data step: window
days = pd.read_parquet(os.path.join(C.CACHE, "train_days.parquet"))
days = days[(days.date >= "2022-05-02") & (days.date <= "2026-10-29")].set_index("date").sort_index()
cl = pd.read_parquet(os.path.join(C.CACHE, "train_closes.parquet"))
cl = cl[(cl.date >= "2022-05-02") & (cl.date <= "2026-10-29")].set_index("date").sort_index()

# half days: generic detection (last positive underlying print before 13:30) vs calendar.parquet
lt = days.last_u_change_ts.str[11:16]
days["half_gen"] = lt < "14:00"          # spec: any day whose session ends before 14:00 is excluded
cal = pd.read_parquet(os.path.join(SPX, "data/clean/calendar.parquet"))
cal = cal[cal.index >= "2022-05-02"]
hd_cal = set(cal.index[cal.half_day])
hd_gen = set(days.index[days.half_gen])
print("half days: calendar", len(hd_cal & set(days.index)), "generic", len(hd_gen), "symmetric diff", sorted(hd_cal ^ hd_gen))
# settle consistency
cl["spread"] = cl.cmax - cl.cmin
print("greeks_eod underlying_price non-constant files:", int((cl.spread > 0.011).sum()))
prev_ret = (cl.close / cl.close.shift(1) - 1).shift(1)
days["settle"] = cl.close.reindex(days.index)
days["prev_ret"] = prev_ret.reindex(days.index)
d_last = (days.settle - days.last_u).abs()
print("settle vs last underlying_1m print: median |diff| %.3f, 95%% %.3f, max %.3f on %s" % (d_last.median(), d_last.quantile(.95), d_last.max(), d_last.idxmax().date()))

books = {d: C.make_book(g) for d, g in snap.groupby("date")}
h1, h2, sk1, sk2 = [], [], {}, {}
for d, r in days.iterrows():
    bk = books.get(d, {})
    if d in hd_cal:
        sk1["half"] = sk1.get("half", 0) + 1; sk2["half"] = sk2.get("half", 0) + 1; continue
    t2 = C.h2_day(bk, r.spot)
    if t2["status"] == "ok":
        h2.append({"date": d, "K": t2["K"], "credit": t2["credit"], "SH": t2["SH"], "fee": t2["fee"], **{f"k{k}": C.h2_pnl(t2, r.settle, k) for k in KS}})
    else:
        sk2[t2["status"]] = sk2.get(t2["status"], 0) + 1
    if not np.isfinite(r.prev_ret):
        sk1["no_prev"] = sk1.get("no_prev", 0) + 1; continue
    if r.prev_ret <= -0.01:
        sk1["prev<=-1%"] = sk1.get("prev<=-1%", 0) + 1; continue
    t1 = C.h1_day(bk, r.spot)
    if t1["status"] != "ok":
        sk1[t1["status"]] = sk1.get(t1["status"], 0) + 1; continue
    h1.append({"date": d, "K": t1["K"], "w": t1["w"], "I": t1["I"], "credit": t1["credit"], "SH": t1["SH"], "fee": t1["fee"],
               **{f"k{k}": C.h1_pnl(t1, r.settle, k) for k in KS}})
h1 = pd.DataFrame(h1).set_index("date")
h2 = pd.DataFrame(h2).set_index("date")


def summ(t, lab):
    out = [lab, len(t), f"{(t['k0.5'] > 0).mean():.1%}"]
    for k in KS:
        out.append(f"{t[f'k{k}'].mean():+.1f}")
    b = C.sboot(t.index, t["k0.5"].values, SEED)
    out.append(f"k0.5 95% [{np.percentile(b, 2.5):+.0f},{np.percentile(b, 97.5):+.0f}] p1 {np.mean(b <= 0):.3f}")
    print("  ".join(map(str, out)))


mwf = lambda t: t[t.index.day_of_week.isin([0, 2, 4])]
print("H1 skips", sk1)
print("H2 skips", sk2)
print("set n win(k0.5) k0 k0.2 k0.5 k1")
summ(h1, "H1 ALL"); summ(mwf(h1), "H1 MWF"); summ(h2, "H2 ALL"); summ(mwf(h2), "H2 MWF")

# day-by-day diff with the proposer's cache (read only)
P = os.path.join(HERE, "..", "proposer", "P-0028_0029_cache")
p1 = pd.read_parquet(os.path.join(P, "h1_trades.parquet"))
p2 = pd.read_parquet(os.path.join(P, "h2_trades.parquet"))
for lab, mine, theirs, cols in (("H1", h1, p1, ["K", "w", "credit"]), ("H2", h2, p2, ["K", "credit"])):
    only_m, only_t = mine.index.difference(theirs.index), theirs.index.difference(mine.index)
    j = mine.join(theirs, how="inner", suffixes=("", "_p"))
    diff = pd.Series(False, index=j.index)
    for c in cols:
        diff |= (j[c] - j[f"{c}_p"]).abs() > 1e-6
    dp = (j["k0.5"] - j["pnl_k0.5"]).abs()
    print(f"{lab}: only mine {list(only_m.date)}, only proposer {list(only_t.date)}, structure differs {int(diff.sum())}, "
          f"max |pnl k0.5 diff| {dp.max():.4f}")
    if diff.any():
        print(j.loc[diff, cols + [f"{c}_p" for c in cols]].head(20))

# effective cost per lot (training comparison for the A-hist cost item)
for lab, t in (("H1 iron", h1), ("H2", h2)):
    for sub, x in (("ALL", t), ("MWF", mwf(t))):
        print(f"cost {lab} {sub}: SH median {x.SH.median():.3f} mean {x.SH.mean():.3f}; fee {x.fee.mean():.2f}; "
              + " ".join(f"E(k{k})={k * x.SH.mean() * 100 + x.fee.mean():.1f}" for k in (0.2, 0.5, 1.0)))
    for y, x in t.groupby(t.index.year):
        print(f"   {lab} {y}: n {len(x)} SH median {x.SH.median():.3f} mean {x.SH.mean():.3f} E(k0.5) {0.5 * x.SH.mean() * 100 + x.fee.mean():.1f}")
