"""P-0015 review, item 7: independent spot check from RAW files (not chain_*.parquet, not spot.parquet).

Raw inputs:
  ~/Data/thetadata/SPXW/quote_1m_dte0/YYYY/YYYYMMDD.csv.gz   (ThetaData 1-minute NBBO, 0DTE SPXW)
  research/spx_fly/data/tws/spx_1m/*.parquet                 (TWS 1-minute SPX bars; spot at t = close of bar t-1)
Compared against: src/validator/V-0015_tables/events_test.csv (validator's per-event-day G, H1355, H1400)
                  and entries_test.parquet for control days.

Days: the 5 test-period event days with the largest G, 5 random other event days, 5 random control days
(seed 15, fixed before running).

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0015_spotcheck.py
"""
import glob
import os

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
V = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0015_tables"
RAW = os.path.expanduser("~/Data/thetadata/SPXW/quote_1m_dte0")
WIDTHS = (20, 25, 30, 50, 75)
K_FILL = 0.20

bars = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(os.path.join(R, "data/tws/spx_1m/*.parquet")))])
bars["ts"] = bars.ts.dt.tz_localize(None)
bars = bars.drop_duplicates("ts").set_index("ts").sort_index()


def spot_at(t):
    return float(bars.close.loc[t - pd.Timedelta(minutes=1)])   # known at t = close of the bar that started at t-1


def fee_leg(p):
    comm = 0.25 if p < 0.05 else (0.50 if p < 0.10 else 0.65)
    exch = 0.36 if p < 1.00 else 0.45
    return max(comm, 1.00) + exch + 0.14 + 0.04028


def entry(q, d, hhmm):
    t = d + pd.Timedelta(hhmm + ":00")
    g = q[(q.ts == t) & (q.ask > q.bid) & (q.bid >= 0)]
    book = {(s, r[0]): (b, a) for s, r, b, a in zip(g.strike, g.right, g.bid, g.ask)}
    S = spot_at(t)
    ks = np.array(sorted({s for s, _ in book}))
    K = float(ks[np.argmin(np.abs(ks - S))])
    I = sum(0.5 * sum(book[(K, r)]) for r in "CP")
    best = None
    for w in WIDTHS:
        dd = abs(w / I - 2.0)
        if best is None or dd < best[0] - 1e-9:
            best = (dd, w)
    w = best[1]
    legs = [(K - w, "P", +1), (K, "P", -1), (K, "C", -1), (K + w, "C", +1)]
    H = 0.0
    fee = 0.0
    widest = 0.0
    desc = []
    for s, r, side in legs:
        b, a = book[(s, r)]
        h = 0.5 * (a - b)
        H += h
        widest = max(widest, a - b)
        fee += fee_leg(0.5 * (a + b) + side * K_FILL * h)
        desc.append(f"{int(s)}{r} {b:.2f}/{a:.2f}")
    E = K_FILL * H * 100 + fee
    return dict(S=S, K=K, w=w, I=I, H=H, widest=widest, fee=fee, E=E, legs="  ".join(desc))


def main():
    ev = pd.read_csv(os.path.join(V, "events_test.csv"), parse_dates=["date"]).set_index("date")
    ent = pd.read_parquet(os.path.join(V, "entries_test.parquet"))
    ent["E"] = K_FILL * ent.iron_H * 100 + ent.iron_fee20
    Ev = ent.pivot_table(index="date", columns="entry", values="E")
    Gv = (Ev["14:00"] - Ev["13:55"]).dropna()
    top = ev.G.sort_values().index[-5:]
    rng = np.random.default_rng(15)
    rest = ev.index.difference(top)
    rnd = rest[np.sort(rng.choice(len(rest), 5, replace=False))]
    ctrl_pool = Gv.index.difference(ev.index)
    ctrl_pool = ctrl_pool[ctrl_pool.dayofweek == 2]
    ctl = ctrl_pool[np.sort(rng.choice(len(ctrl_pool), 5, replace=False))]
    worst = 0.0
    for lab, days in (("TOP5", top), ("RANDOM5 events", rnd), ("RANDOM5 controls (Wed)", ctl)):
        print(f"\n== {lab}")
        for d in days:
            q = pd.read_csv(os.path.join(RAW, f"{d.year}/{d:%Y%m%d}.csv.gz"),
                            usecols=["strike", "right", "timestamp", "bid", "ask"])
            q["ts"] = pd.to_datetime(q.timestamp)
            a = entry(q, d, "13:55")
            b = entry(q, d, "14:00")
            G = b["E"] - a["E"]
            diff = G - Gv.loc[d]
            worst = max(worst, abs(diff))
            print(f"{d.date()} {ev.type.get(d, 'control'):<10} mine G {G:+6.2f} | validator G {Gv.loc[d]:+6.2f} | diff {diff:+.3f}")
            for hh, r in (("13:55", a), ("14:00", b)):
                print(f"     {hh} S {r['S']:.2f} K {r['K']:.0f} w {r['w']} I {r['I']:.2f} H {r['H']:.3f} widest {r['widest']:.2f} "
                      f"fee {r['fee']:.2f} E {r['E']:.2f} | {r['legs']}")
    print(f"\nmax |mine - validator| over 15 days: {worst:.4f} USD")


if __name__ == "__main__":
    main()
