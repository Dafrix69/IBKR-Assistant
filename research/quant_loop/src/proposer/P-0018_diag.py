"""P-0018 diag -- written AFTER the gated placebo failed (report only, does not change the verdict).
Single-leg (non-combo) print level vs chain-interp mid, by distance from spot and right, 09:45-15:30, training only.
Answers: which legs make D_single negative (body above mid? wings below?)."""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
SPLIT = pd.Timestamp("2025-11-01")
ML = [130, 131, 134, 137, 144]
BINS = [-1, 5, 15, 30, 50, 85]
LAB = ["body<=5", "6-15", "16-30", "31-50", "51-85"]


def day(x):
    d = pd.read_csv(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz"),
                    usecols=["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"])
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    D = pd.Timestamp(x)
    tm = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    d = d[(tm >= 585) & (tm < 930) & ~d.condition.isin(ML) & (d.bid > 0) & (d.ask > d.bid) & (d.price > 0)].copy()
    d["r"] = d.right.str[0]
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{x}.parquet"), columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[(ch.ts < SPLIT) & ~ch.flag_bad & (ch.bid > 0)]       # time wall
    cm = dict(zip(zip(ch.ts, ch.strike, ch.right), ch.mid))
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < SPLIT) & (sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]   # time wall
    sm = dict(zip(sp.ts, sp.spot))
    fl = d.trade_timestamp.dt.floor("min")
    u = ((d.trade_timestamp - fl).dt.total_seconds() / 60).values
    m0 = np.array([cm.get(k, np.nan) for k in zip(fl, d.strike, d.r)])
    m1 = np.array([cm.get(k, np.nan) for k in zip(fl + pd.Timedelta(minutes=1), d.strike, d.r)])
    S = np.array([sm.get(t, np.nan) for t in fl])
    dist = np.abs(d.strike.values - S)
    otm = np.where(d.r.values == "C", d.strike.values >= S, d.strike.values <= S)
    out = pd.DataFrame({"ell": (d.price.values - ((1 - u) * m0 + u * m1)) * 100, "r": d.r.values,
                        "b": pd.cut(dist, BINS, labels=LAB), "otm": otm, "own": (d.price.values - (d.bid.values + d.ask.values) / 2) * 100,
                        "cm": (((d.bid.values + d.ask.values) / 2) - ((1 - u) * m0 + u * m1)) * 100, "ab": (d.price.values >= d.ask.values).astype(int) - (d.price.values <= d.bid.values).astype(int)})
    out = out.dropna(subset=["ell", "b"])
    g = out.groupby(["b", "r"], observed=True)
    return D, g.ell.mean(), g.ab.mean(), g.size(), g.own.mean(), g.cm.mean()


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                     # time wall
    cal = cal[(cal.index >= pd.Timestamp("2024-10-30")) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index]
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(day, days))
    E = pd.DataFrame({r[0]: r[1] for r in res}).T
    A = pd.DataFrame({r[0]: r[2] for r in res}).T
    N = pd.DataFrame({r[0]: r[3] for r in res}).T
    O = pd.DataFrame({r[0]: r[4] for r in res}).T
    C = pd.DataFrame({r[0]: r[5] for r in res}).T
    print("single-leg print level - chain interp mid (USD per contract), day-level 10% trimmed mean;"
          " net aggressor = share(at/above ask) - share(at/below bid)")
    for c in E.columns:
        print(f"  {c[0]:8s} {c[1]}  ell {trim_mean(E[c].dropna(), 0.1):+6.2f}  net-aggr {trim_mean(A[c].dropna(), 0.1):+.3f}  px-own {trim_mean(O[c].dropna(), 0.1):+6.2f}  own-chain {trim_mean(C[c].dropna(), 0.1):+6.2f}  prints/day {N[c].mean():8.0f}")


if __name__ == "__main__":
    main()
