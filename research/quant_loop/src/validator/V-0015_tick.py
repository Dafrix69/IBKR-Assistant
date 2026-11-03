"""V-0015 tick check (validator, test period only: trade_quote_dte0 starts 2024-10-30).

For every test-period base day (event days and same-weekday controls), the four iron-fly legs chosen at 13:55
(from entries_test.parquet) and every 0DTE print in 13:50:00-14:10:00:
  T1 per 10-second bucket: mean quoted spread (ask - bid of the NBBO attached to prints) of the ATM call+put
     at K, and of the wings, event (minutes / beige book) vs control.  -> when does the widening start?
  T2 per minutes day: max ATM C+P quoted spread in 13:59:00-13:59:59.999 vs 14:00:00-14:00:04.999 vs 14:00:05-14:00:30.
  T3 combo-leg prints (condition 130/131/134/137/144) on the four legs, per minute 13:55..14:05:
     count, |price - mid| / half-spread ("effective k", 0 = mid, 1 = touch), share at or outside the touch.
Run once:
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0015_tick.py
"""
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "V-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
COMBO = {130, 131, 134, 137, 144}


def one(args):
    d, K, w = args
    p = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz")
    if not os.path.exists(p):
        return None
    x = pd.read_csv(p, usecols=["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"])
    x["ts"] = pd.to_datetime(x.trade_timestamp)
    x = x[(x.ts >= d + pd.Timedelta("13:50:00")) & (x.ts < d + pd.Timedelta("14:10:00"))]
    x = x[x.ts >= SPLIT]                                                      # time wall (test only)
    leg = {(K - w, "PUT"): "wp", (K, "PUT"): "kp", (K, "CALL"): "kc", (K + w, "CALL"): "wc"}
    x["leg"] = [leg.get((s, r)) for s, r in zip(x.strike, x.right)]
    x = x[x.leg.notna() & (x.ask > x.bid) & (x.bid >= 0)].copy()
    x["spr"] = x.ask - x.bid
    x["sec"] = (x.ts - (d + pd.Timedelta("14:00:00"))).dt.total_seconds()
    x["b10"] = np.floor(x.sec / 10).astype(int)
    x["mid"] = (x.ask + x.bid) / 2
    x["keff"] = (x.price - x.mid).abs() / (x.spr / 2)
    x["combo"] = x.condition.isin(COMBO)
    x["date"] = d
    return x[["date", "leg", "sec", "b10", "spr", "keff", "combo", "size"]]


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index >= SPLIT]                                            # time wall
    ev = pd.read_csv(os.path.join(HERE, "V-0015_events.csv"), parse_dates=["date"])
    ev = ev[ev.date >= SPLIT]
    typ = dict(zip(ev.date, ev.event))
    b = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01) & (~cal.fomc)]
    e = pd.read_parquet(os.path.join(T, "entries_test.parquet"))
    e = e[(e.entry == "13:55") & (e.date >= SPLIT)].set_index("date")
    evdow = {d.dayofweek for d in ev.date}
    days = [d for d in b.index if d.dayofweek in evdow and d in e.index]
    jobs = [(d, float(e.loc[d, "K"]), float(e.loc[d, "w"])) for d in days]
    out = []
    with ProcessPoolExecutor(6) as ex:
        for r in ex.map(one, jobs):
            if r is not None and len(r):
                out.append(r)
    x = pd.concat(out)
    x["grp"] = [typ.get(d, "control") for d in x.date]
    print("days with ticks:", x.groupby("grp").date.nunique().to_dict())
    x.to_parquet(os.path.join(T, "tick_test.parquet"))

    print("\n== T1 mean quoted spread (pts) of ATM C+P prints (legs kc,kp) per 10 s bucket from 14:00:00")
    a = x[x.leg.isin(["kc", "kp"])]
    # per day x bucket mean, then mean over days (each day weight 1)
    db = a.groupby(["grp", "date", "b10"]).spr.mean().reset_index()
    t1 = db.groupby(["grp", "b10"]).spr.mean().unstack(0)
    print(t1.loc[-36:30].round(3).to_string())
    wg = x[x.leg.isin(["wc", "wp"])].groupby(["grp", "date", "b10"]).spr.mean().reset_index()
    print("\n   wings (wc, wp), every 30 s bucket:")
    wg["b30"] = np.floor(wg.b10 / 3).astype(int)
    print(wg.groupby(["grp", "b30"]).spr.mean().unstack(0).loc[-12:12].round(3).to_string())

    print("\n== T2 minutes days: max ATM C/P quoted spread by window (pts)")
    m = a[a.grp == "minutes"]
    rows = []
    for d, g in m.groupby("date"):
        def mx(lo, hi):
            s = g[(g.sec >= lo) & (g.sec < hi)].spr
            return s.max() if len(s) else np.nan
        rows.append({"date": d.date(), "13:58:00-59:00": mx(-120, -60), "13:59:00-59:50": mx(-60, -10),
                     "13:59:50-14:00:00": mx(-10, 0), "14:00:00-00:05": mx(0, 5), "14:00:05-00:30": mx(5, 30),
                     "14:00:30-02:00": mx(30, 120), "n_prints": len(g)})
    print(pd.DataFrame(rows).round(2).to_string(index=False))

    print("\n== T3 combo-leg prints on the four legs, per minute from 13:55")
    c = x[x.combo].copy()
    c["min"] = np.floor(c.sec / 60).astype(int)
    c = c[(c["min"] >= -5) & (c["min"] <= 5)]
    g = c.groupby(["grp", "min"])
    t3 = pd.DataFrame({"n": g.size(), "days": g.date.nunique(), "keff_med": g.keff.median(),
                       "keff_mean": g.keff.mean(), "at_or_outside_touch": g.keff.apply(lambda s: np.mean(s >= 0.999))})
    print(t3.round(3).to_string())
    print("\n   per-day prints per minute (n/days):")
    print((t3.n / t3.days).unstack(0).round(2).to_string())


if __name__ == "__main__":
    main()
