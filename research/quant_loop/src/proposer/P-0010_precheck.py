"""P-0010 pre-check (no outcome variables): quote timing of next-expiry closing NBBO and sample counts.
TRAINING PERIOD ONLY. Reads greeks_eod for day D, expiration = next trading day N; never reads settle.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0010_precheck.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0010_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL (entry day and expiry day both < 2024-11-01)
cal = cal.drop(columns=["settle"])                     # pre-check must not see outcomes
days = list(cal.index)
pairs = []
for d, n in zip(days[:-1], days[1:]):                  # N = next trading day in calendar, also < TRAIN_END
    pairs.append((d, n))


def one(p):
    d, n = p
    f = f"{R}/data/raw/SPXW/greeks_eod/{d:%Y}/{d:%Y%m%d}.csv.gz"
    if not os.path.exists(f):
        return dict(D=d, N=n, ok=False, why="nofile")
    x = pd.read_csv(f, usecols=["expiration", "strike", "right", "bid", "ask", "underlying_price"])
    x["expiration"] = pd.to_datetime(x.expiration)
    x = x[x.expiration < TRAIN_END]                    # TIME WALL per file
    y = x[x.expiration == n]
    if y.empty:
        return dict(D=d, N=n, ok=False, why="noexp")
    S = float(y.underlying_price.iloc[0])
    c = y[y.right == "CALL"].set_index("strike"); pu = y[y.right == "PUT"].set_index("strike")
    ks = sorted(set(c.index) & set(pu.index), key=lambda k: abs(k - S))[:5]
    fp = [k + (c.loc[k, "bid"] + c.loc[k, "ask"]) / 2 - (pu.loc[k, "bid"] + pu.loc[k, "ask"]) / 2 for k in ks]
    F = float(np.median(fp))
    K = min(sorted(set(c.index) & set(pu.index)), key=lambda k: (abs(k - F), k))
    cs = float(c.loc[K, "ask"] - c.loc[K, "bid"]); ps = float(pu.loc[K, "ask"] - pu.loc[K, "bid"])
    I = float((c.loc[K, "bid"] + c.loc[K, "ask"] + pu.loc[K, "bid"] + pu.loc[K, "ask"]) / 2)
    return dict(D=d, N=n, ok=True, why="", S=S, F=F, gap=F - S, K=K, I=I, call_spr=cs, put_spr=ps)


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        r = pd.DataFrame(list(ex.map(one, pairs)))
    r = r[(r.N < TRAIN_END)]                           # TIME WALL on output
    r["nights"] = (r.N - r.D).dt.days
    hd = cal.half_day
    r["half"] = r.D.map(hd).astype(bool) | r.N.map(hd).astype(bool)
    r.to_csv(f"{OUT}/precheck.csv", index=False)
    print(r.why.value_counts())
    ok = r[r.ok]
    print("n ok", len(ok), ok.D.min(), ok.D.max())
    print("F-S gap quantiles", ok.gap.quantile([.01, .05, .25, .5, .75, .95, .99]).round(2).to_dict())
    print("|gap|>3:", (ok.gap.abs() > 3).mean().round(3))
    print("ATM spreads q", ok[["call_spr", "put_spr"]].quantile([.5, .9, .99]).round(2).to_string())
    print("I q", ok.I.quantile([.1, .5, .9]).round(1).to_dict())
    print(pd.crosstab(ok.nights, ok.half))
    print(ok.groupby(ok.D.dt.year).nights.value_counts().unstack())
