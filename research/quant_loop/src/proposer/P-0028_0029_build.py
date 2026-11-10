"""P-0028 / P-0029 build: 14:00 ET snapshot of SPXW 0DTE quotes, spot and official close, from RAW ThetaData files.

Training only (A-hist scope, PROTOCOL 2026-11-09): 2022-05-02 <= date <= 2026-10-29.
Files whose basename date is < 20220502 are never opened (the file list is filtered by name first).

Reads (raw, the same sources the validator will use on A-hist):
  ~/Data/thetadata/SPXW/quote_1m_dte0/YYYY/YYYYMMDD.csv.gz   (strike, right, timestamp, bid, ask, expiration)
  ~/Data/thetadata/SPXW/underlying_1m/YYYY/YYYYMMDD.csv.gz   (underlying_price at the 14:00:00 row, > 0)
  ~/Data/thetadata/SPXW/greeks_eod/YYYY/YYYYMMDD.csv.gz      (first underlying_price > 0 = official close)
Also (reproduction only): spx_fly/data/clean/spot.parquet (TWS bar t-1 close) and calendar.parquet (half_day).

Writes P-0028_0029_cache/{snap_1400.parquet, days.parquet}. Settlement values are stored but not used here.
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml

WALL = "20220502"           # time wall: nothing before this date is opened
END = "20261029"
RAW = os.path.expanduser("~/Data/thetadata/SPXW")
SPX = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CFG = yaml.safe_load(open(os.path.join(SPX, "config.yaml")))
QF = CFG["quote_filters"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0028_0029_cache")
T = "14:00:00"


def files(ds):
    fs = sorted(glob.glob(os.path.join(RAW, ds, "*", "*.csv.gz")))
    return {os.path.basename(f)[:8]: f for f in fs if WALL <= os.path.basename(f)[:8] <= END}   # filter by NAME before any read


def flag(df):
    """Quote validity, identical to spx_fly/src/load_clean.flag_quotes (restated in the spec)."""
    two = (df.bid > 0) & (df.ask > 0)
    no_quote = (df.bid == 0) & (df.ask == 0)
    crossed = two & (df.bid > df.ask)
    bid0_big = (df.bid == 0) & (df.ask > QF["bid0_ask_max"])
    wide = two & ((df.ask - df.bid) > QF["max_spread_to_mid"] * df.mid)
    return no_quote | crossed | bid0_big | wide


def one_day(args):
    d, fq, fu = args
    if d < WALL:                                   # time wall (redundant with the name filter)
        return None
    iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
    q = pd.read_csv(fq, compression="gzip", usecols=["expiration", "strike", "right", "timestamp", "bid", "ask"])
    q = q[q.timestamp.str[:10] >= "2022-05-02"]   # first data step: time wall on the data itself
    q = q[(q.expiration == iso) & (q.timestamp == f"{iso}T{T}.000")].copy()
    q["right"] = q.right.str[0]
    q["mid"] = (q.bid + q.ask) / 2
    q["bad"] = flag(q)
    q["date"] = pd.Timestamp(iso)
    spot_u = np.nan
    if fu is not None:
        u = pd.read_csv(fu, compression="gzip", usecols=["timestamp", "underlying_price"])
        u = u[u.timestamp.str[:10] >= "2022-05-02"]
        s = u.loc[(u.timestamp == f"{iso}T{T}.000") & (u.underlying_price > 0), "underlying_price"]
        spot_u = float(s.iloc[0]) if len(s) else np.nan
    return q[["date", "strike", "right", "bid", "ask", "mid", "bad"]], {"date": pd.Timestamp(iso), "spot_u": spot_u, "n_rows_1400": len(q)}


def close_of(f):
    g = pd.read_csv(f, compression="gzip", usecols=["underlying_price"])
    g = g[g.underlying_price > 0]
    return float(g.underlying_price.iloc[0]) if len(g) else np.nan


def main():
    os.makedirs(OUT, exist_ok=True)
    fq, fu, fe = files("quote_1m_dte0"), files("underlying_1m"), files("greeks_eod")
    jobs = [(d, fq[d], fu.get(d)) for d in sorted(fq)]
    with ProcessPoolExecutor(8) as ex:
        res = [r for r in ex.map(one_day, jobs, chunksize=4) if r is not None]
        closes = dict(zip(sorted(fe), ex.map(close_of, [fe[d] for d in sorted(fe)], chunksize=8)))
    snap = pd.concat([r[0] for r in res], ignore_index=True)
    days = pd.DataFrame([r[1] for r in res])
    # official closes on every trading day (greeks_eod), >= 2022-05-02 only
    cl = pd.Series({pd.Timestamp(k): v for k, v in closes.items()}).sort_index()
    cl = cl[cl.index >= "2022-05-02"]
    prev_ret = (cl / cl.shift(1) - 1).shift(1)        # D: close(D-1)/close(D-2) - 1, previous TRADING day (not previous 0DTE day)
    days["settle"] = days.date.map(cl)
    days["prev_ret"] = days.date.map(prev_ret)
    # reproduction-only inputs from the clean pipeline (both start 2022-05-02)
    cal = pd.read_parquet(os.path.join(SPX, "data/clean/calendar.parquet"))
    cal = cal[cal.index >= "2022-05-02"]
    days["half_day"] = days.date.map(cal.half_day).fillna(False).astype(bool)
    days["spx_ret_prev_clean"] = days.date.map(cal.spx_ret_prev)
    sp = pd.read_parquet(os.path.join(SPX, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[sp.ts >= "2022-05-02"]
    sp = sp[sp.ts.dt.strftime("%H:%M") == "14:00"].set_index(sp[sp.ts.dt.strftime("%H:%M") == "14:00"].ts.dt.normalize()).spot
    days["spot_tws"] = days.date.map(sp)
    snap.to_parquet(os.path.join(OUT, "snap_1400.parquet"), index=False)
    days.to_parquet(os.path.join(OUT, "days.parquet"), index=False)
    print(len(days), "days", len(snap), "rows; no 14:00 rows:", int((days.n_rows_1400 == 0).sum()),
          "; no spot_u:", int(days.spot_u.isna().sum()), "; no settle:", int(days.settle.isna().sum()))


if __name__ == "__main__":
    main()
