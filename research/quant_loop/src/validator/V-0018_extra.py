"""V-0018 extra (train only): (a) single-leg own-mid - chain interp by contract-minute activity (prints in that
contract-minute) - is the elevation concentrated in busy minutes?  (b) Pi-weighted placebo with ell = price - own mid
(proposer's post-hoc alternative), same 15-min windows as the registered placebo."""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0018_tables")
WALL = pd.Timestamp("2025-11-01")
ML = (130, 131, 134, 137, 144)
COLS = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"]


def one_day(D):
    assert D < WALL
    t = pd.read_csv(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{D.year}/{D:%Y%m%d}.csv.gz"), usecols=COLS)
    t["trade_timestamp"] = pd.to_datetime(t.trade_timestamp)
    t = t[t.trade_timestamp < WALL]                                   # time wall, first step
    hm = t.trade_timestamp.dt.hour * 60 + t.trade_timestamp.dt.minute
    t = t[(hm >= 585) & (hm < 930) & ~t.condition.isin(ML) & (t.bid > 0) & (t.ask > t.bid) & (t.price > 0)].copy()
    t["r"] = t.right.str[0]
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{D:%Y%m%d}.parquet"), columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[(ch.ts < WALL) & ~ch.flag_bad & (ch.bid > 0)][["ts", "strike", "right", "mid"]].rename(columns={"right": "r"})
    ch["ts"] = ch.ts.astype("datetime64[ns]")
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < WALL) & (sp.ts.dt.normalize() == D)]             # time wall
    spot = pd.Series(sp.spot.values, index=sp.ts.values.astype("datetime64[ns]"))
    t["m"] = t.trade_timestamp.dt.floor("min"); t["m1"] = t.m + pd.Timedelta(minutes=1)
    t = t.merge(ch.rename(columns={"ts": "m", "mid": "c0"}), on=["m", "strike", "r"], how="left")
    t = t.merge(ch.rename(columns={"ts": "m1", "mid": "c1"}), on=["m1", "strike", "r"], how="left")
    u = (t.trade_timestamp - t.m).dt.total_seconds() / 60
    t["oc"] = ((t.bid + t.ask) / 2 - ((1 - u) * t.c0 + u * t.c1)) * 100
    t["po"] = t.price - (t.bid + t.ask) / 2
    t["win"] = t.trade_timestamp.dt.floor("15min")
    S = spot.reindex(t.m.values).values
    t["near"] = np.abs(t.strike.values - S) <= 15
    cnt = t.groupby(["strike", "r", "m"]).price.transform("size")
    t["act"] = pd.cut(cnt, [0, 5, 20, 100, 1e9], labels=["1-5", "6-20", "21-100", ">100"]).astype(str)
    a = t[t.near].dropna(subset=["oc"]).groupby(["r", "act"]).oc.agg(["mean", "size"])
    b = (t[t.near].groupby("r").po.mean() * 100)
    return D, a, b


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < WALL]                                       # time wall
    days = [d for d in cal[(cal.index >= pd.Timestamp("2024-10-30")) & cal.has_0dte & ~cal.half_day].index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz"))]
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(one_day, days))
    A = pd.concat([a.assign(date=D) for D, a, _ in res]).reset_index()
    B = pd.DataFrame({D: b for D, _, b in res}).T
    print("(a) single-leg prints |K-S|<=15: own mid - chain interp (USD/contract) by number of single-leg prints in that"
          " contract-minute; day-trimmed mean of daily means; share of prints")
    tot = A.groupby("r")["size"].sum()
    for (r, act), g in A.groupby(["r", "act"]):
        print(f"  {r} {act:7s} oc {trim_mean(g['mean'].values, 0.1):+6.2f}  share {g['size'].sum() / tot[r]:.3f}")
    print("(b) single-leg price - own mid, |K-S|<=15, USD/contract:", {c: round(trim_mean(B[c].dropna(), 0.1), 3) for c in B})


if __name__ == "__main__":
    main()
