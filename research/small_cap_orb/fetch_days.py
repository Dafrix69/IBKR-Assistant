"""1-minute regular-hours bars from TWS for each (candidate, day) in universe/candidates.csv,
read-only, resumable. TRADES for every row; BID_ASK for a 15 % random sample (seed 3).

    ../spx_fly/.venv/bin/python fetch_days.py --port 7496 [--pause 2]

Writes universe/days/<WHAT>/<SYMBOL>_<YYYYMMDD>.parquet. A name TWS cannot resolve any more
(delisted) is logged to universe/days/unresolved.txt and skipped; the report counts them.
"""
import argparse
import datetime as dt
import os
import time
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from ib_async import IB, Stock

from fetch_tws import row

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "universe", "days")
TZ = "America/New_York"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9734)
    p.add_argument("--pause", type=float, default=2.0)
    p.add_argument("--sample", type=float, default=0.15)
    a = p.parse_args()

    cand = pd.read_csv(os.path.join(ROOT, "universe", "candidates.csv"))
    rng = np.random.default_rng(3)
    cand["quote"] = rng.random(len(cand)) < a.sample
    jobs = [(r.symbol, r.date, "TRADES") for r in cand.itertuples()]
    jobs += [(r.symbol, r.date, "BID_ASK") for r in cand.itertuples() if r.quote]
    for w in ("TRADES", "BID_ASK"):
        os.makedirs(os.path.join(OUT, w), exist_ok=True)
    unresolved_path = os.path.join(OUT, "unresolved.txt")
    unresolved = set(open(unresolved_path).read().split()) if os.path.exists(unresolved_path) else set()

    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    contracts, t0, n = {}, time.time(), 0
    try:
        for sym, date, what in jobs:
            path = os.path.join(OUT, what, f"{sym}_{date.replace('-', '')}.parquet")
            if os.path.exists(path) or sym in unresolved:
                continue
            if sym not in contracts:
                c = Stock(sym, "SMART", "USD")
                q = ib.qualifyContracts(c)
                if not q or not c.conId:
                    unresolved.add(sym)
                    with open(unresolved_path, "a") as f:
                        f.write(sym + "\n")
                    print(sym, "unresolved", flush=True)
                    continue
                contracts[sym] = c
            d = dt.date.fromisoformat(date)
            end_ts = (dt.datetime.combine(d, dt.time(16, 30), ZoneInfo(TZ))
                      .astimezone(dt.timezone.utc).strftime("%Y%m%d-%H:%M:%S"))
            bars = ib.reqHistoricalData(contracts[sym], endDateTime=end_ts, durationStr="1 D", barSizeSetting="1 min",
                                        whatToShow=what, useRTH=True, formatDate=2, timeout=120)
            time.sleep(a.pause)
            n += 1
            if not bars:
                print(sym, date, what, "no bars", flush=True)
                continue
            df = pd.DataFrame([row(b, what) for b in bars])
            df["ts"] = pd.to_datetime(df.ts, utc=True).dt.tz_convert(TZ)
            df = df[df.ts.dt.date == d]
            df.to_parquet(path + ".part", index=False)
            os.replace(path + ".part", path)
            if n % 50 == 0:
                print(f"{n} requests, {(time.time() - t0) / n:.1f} s each, last {sym} {date} {what} {len(df)} bars", flush=True)
    finally:
        ib.disconnect()


if __name__ == "__main__":
    main()
