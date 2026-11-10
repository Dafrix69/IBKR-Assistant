"""P-0019 review, item 7: independent spot check of 10 test days from the raw tape.

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0019_spotcheck.py

Days: the 5 test days with the largest validator daily D, plus 5 drawn at random (seed 19) from the rest.
For each day the combos are rebuilt from the raw tape with code written for this review (no import of proposer or
validator code), and the per-day print count and the 10% trimmed D / D_own / F / P_own are compared with the values
derived from the validator's stored table (V-0019_tables/combos_test.parquet).
Additionally (review-only, not in the validator's table): D_own by the oldest leg quote age of the print.
Raw data is opened read-only; only the 10 selected files are read.
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
Q = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop"
LO, HI = pd.Timestamp("2025-11-01"), pd.Timestamp("2026-10-30")
MULTI = [130, 131, 134, 137, 144]
tm = lambda v: trim_mean(np.asarray(v, float), 0.10)


def validator_days():
    p = pd.read_parquet(os.path.join(Q, "src/validator/V-0019_tables/combos_test.parquet"))
    p = p[(p.date >= LO) & (p.date < HI)]
    hm = p.ts.dt.hour * 60 + p.ts.dt.minute
    p = p[(hm >= 585) & (hm < 930) & (p.w >= 15) & (p.w < 80) & ((p.K - p.S).abs() <= 5) & p.ch0.notna() & p.ch1.notna()].copy()
    ref = (1 - p.u) * p.ch0 + p.u * p.ch1
    p["D"] = (p.trade - ref) * 100
    p["D_own"] = (p.trade - p.own) * 100
    p["F"] = (p.own - ref) * 100
    p["P_own"] = p.Pown * 100
    g = p.groupby("date")
    out = pd.DataFrame({"n": g.size(), "D": g.D.apply(tm), "D_own": g.D_own.apply(tm), "F": g.F.apply(tm),
                        "P_own": g.P_own.apply(lambda x: tm(x.dropna()))})
    return out


def rebuild(day):
    f = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{day.year}/{day:%Y%m%d}.csv.gz")
    t = pd.read_csv(f, usecols=["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"])
    t["tt"] = pd.to_datetime(t.trade_timestamp)
    t = t[(t.tt >= LO) & (t.tt < HI)]
    t["qt"] = pd.to_datetime(t.quote_timestamp)
    t["cp"] = t.right.str[0]
    t["age"] = (t.tt - t.qt).dt.total_seconds()
    multi = t.condition.isin(MULTI)

    # single-leg placebo: mean(price - own mid) per 15-minute window and contract
    s = t[~multi & (t.bid > 0) & (t.ask > t.bid) & (t.price > 0)]
    ell = (s.price - (s.bid + s.ask) / 2).groupby([s.tt.dt.floor("15min"), s.strike, s.cp]).mean()

    mins = t.tt.dt.hour * 60 + t.tt.dt.minute
    m = t[multi & (mins >= 9 * 60 + 45) & (mins < 15 * 60 + 30)].copy()
    m["notional"] = m.price * m["size"]
    leg = m.groupby(["tt", "strike", "cp"], sort=True).agg(qty=("size", "sum"), notional=("notional", "sum"),
                                                          bid=("bid", "first"), ask=("ask", "first"), age=("age", "max")).reset_index()
    leg["px"] = leg.notional / leg.qty
    leg["nleg"] = leg.groupby("tt").strike.transform("size")
    leg = leg[leg.nleg.isin([3, 4])]

    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{day:%Y%m%d}.parquet"), columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[(ch.ts >= LO) & (ch.ts < HI) & ~ch.flag_bad & (ch.bid > 0)]
    cmid = ch.set_index(["ts", "strike", "right"]).mid
    cmid.index = cmid.index.set_levels(cmid.index.levels[0].astype("datetime64[ns]"), level=0)
    cmid = cmid.to_dict()
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts >= day) & (sp.ts < day + pd.Timedelta(days=1))]
    spot = dict(zip(sp.ts.astype("datetime64[ns]"), sp.spot))

    rows = []
    for ts, g in leg.groupby("tt", sort=False):
        g = g.sort_values(["strike", "cp"])
        strikes = np.unique(g.strike.values)
        if len(strikes) != 3 or not np.isclose(strikes[1] - strikes[0], strikes[2] - strikes[1]):
            continue
        lo, mid, hi = strikes
        w = mid - lo
        d = {(k, c): r for k, c, r in zip(g.strike, g.cp, g.itertuples(index=False))}
        if len(g) == 4:
            order = [(lo, "P"), (mid, "P"), (mid, "C"), (hi, "C")]
            wt = np.array([1.0, -1.0, -1.0, 1.0])
            if any(o not in d for o in order) or len({d[o].qty for o in order}) != 1:
                continue
        else:
            cps = set(g.cp)
            if len(cps) != 1:
                continue
            c0 = next(iter(cps))
            order = [(lo, c0), (mid, c0), (hi, c0)]
            wt = np.array([1.0, -2.0, 1.0])
            if not (d[order[0]].qty == d[order[2]].qty and d[order[1]].qty == 2 * d[order[0]].qty):
                continue
        bid = np.array([d[o].bid for o in order]); ask = np.array([d[o].ask for o in order])
        if (bid <= 0).any() or (ask <= bid).any():
            continue
        m0 = pd.Timestamp(ts).floor("min"); m1 = m0 + pd.Timedelta(minutes=1)
        S = spot.get(m0, np.nan)
        if not (abs(mid - S) <= 5 and 15 <= w < 80):
            continue
        try:
            c0v = sum(a * cmid[(m0, k, c)] for a, (k, c) in zip(wt, order))
            c1v = sum(a * cmid[(m1, k, c)] for a, (k, c) in zip(wt, order))
        except KeyError:
            continue
        u = (pd.Timestamp(ts) - m0).total_seconds() / 60
        ref = (1 - u) * c0v + u * c1v
        trade = float(wt @ np.array([d[o].px for o in order]))
        own = float(wt @ ((bid + ask) / 2))
        w15 = pd.Timestamp(ts).floor("15min")
        try:
            po = float(sum(a * ell.loc[(w15, k, c)] for a, (k, c) in zip(wt, order))) * 100
        except KeyError:
            po = np.nan
        rows.append({"D": (trade - ref) * 100, "D_own": (trade - own) * 100, "F": (own - ref) * 100, "P_own": po,
                     "age": max(d[o].age for o in order)})
    return pd.DataFrame(rows)


def main():
    v = validator_days()
    top = v.D.sort_values().index[-5:]
    rest = v.index.difference(top)
    rnd = pd.DatetimeIndex(np.random.default_rng(19).choice(rest, 5, replace=False)).sort_values()
    print("validator table: %d days; overall D %.3f D_own %.3f F %.3f" % (len(v), tm(v.D), tm(v.D_own), tm(v.F)))
    allp = []
    worst = 0.0
    for tag, days in (("top-5 daily D", top), ("random-5 (seed 19)", rnd)):
        print(f"\n== {tag} ==")
        print("date         n(mine/valid)        D(mine/valid)     D_own(mine/valid)       F(mine/valid)   P_own(mine/valid)")
        for dday in days:
            r = rebuild(pd.Timestamp(dday))
            r["date"] = dday
            allp.append(r)
            mine = (len(r), tm(r.D), tm(r.D_own), tm(r.F), tm(r.P_own.dropna()))
            val = v.loc[dday]
            worst = max(worst, *(abs(mine[i + 1] - val.iloc[i + 1]) for i in range(4)), abs(mine[0] - val.n))
            print(f"{pd.Timestamp(dday):%Y-%m-%d}  {mine[0]:6d}/{int(val.n):6d}   {mine[1]:+7.3f}/{val.D:+7.3f}   {mine[2]:+7.3f}/{val.D_own:+7.3f}"
                  f"   {mine[3]:+7.3f}/{val.F:+7.3f}   {mine[4]:+7.3f}/{val.P_own:+7.3f}")
    print(f"\nlargest absolute difference over all cells (count or USD): {worst:.4f}")
    a = pd.concat(allp, ignore_index=True)
    print("\n== review-only: D_own by oldest leg quote age (10 days pooled, print-level) ==")
    bins = [-1, 0.005, 0.05, 0.5, 5, 1e9]
    lab = ["<5ms", "5-50ms", "50-500ms", "0.5-5s", ">=5s"]
    a["ab"] = pd.cut(a.age, bins, labels=lab)
    for k, x in a.groupby("ab", observed=True):
        print(f"{k:10s} share {len(x) / len(a):.3f}  D_own mean {x.D_own.mean():+.2f}  trimmed {tm(x.D_own):+.2f}  "
              f"above/at/below own mid {np.mean(x.D_own > 0.5):.2f}/{np.mean(x.D_own.abs() <= 0.5):.2f}/{np.mean(x.D_own < -0.5):.2f}")


if __name__ == "__main__":
    main()
