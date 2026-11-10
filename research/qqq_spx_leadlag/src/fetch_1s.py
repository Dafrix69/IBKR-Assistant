"""1-second RTH bars from TWS (read-only) for the QQQ→SPX lead-lag study.

    ../spx_fly/.venv/bin/python src/fetch_1s.py --days 30 [--end 2026-11-09] [--client-id 9761]

One request = 1800 seconds of one stream; 13 requests per stream per day.
Resumable: data/<stream>/<YYYYMMDD>.parquet already present is skipped.
Timestamps are bar START times, stored in UTC.
"""
import argparse
import datetime as dt
import os
import time
from zoneinfo import ZoneInfo

import pandas as pd
from ib_async import IB, Future, Index, Stock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NY = ZoneInfo("America/New_York")
STREAMS = [("QQQ", "MIDPOINT"), ("SPY", "MIDPOINT"), ("ES", "MIDPOINT"), ("NQ", "MIDPOINT"),
           ("SPY", "BID_ASK"), ("ES", "BID_ASK"), ("SPX", "TRADES")]


def contracts():
    return {"QQQ": Stock("QQQ", "SMART", "USD"), "SPY": Stock("SPY", "SMART", "USD"),
            "ES": Future("ES", "202612", "CME"), "NQ": Future("NQ", "202612", "CME"),
            "SPX": Index("SPX", "CBOE")}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=7496)
    p.add_argument("--client-id", type=int, default=9761)
    p.add_argument("--end", default="2026-11-09")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--pause", type=float, default=1.0)
    p.add_argument("--streams", default="", help="comma list like QQQ_MIDPOINT,ES_BID_ASK (default all)")
    a = p.parse_args()

    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    errs = []
    ib.errorEvent += lambda reqId, code, msg, c: errs.append((code, msg))
    cons = contracts()
    for c in cons.values():
        ib.qualifyContracts(c)

    d, got = dt.date.fromisoformat(a.end), 0
    try:
        while got < a.days:
            if d.weekday() >= 5:
                d -= dt.timedelta(days=1)
                continue
            day_ok = True
            for name, what in [x for x in STREAMS if not a.streams or f"{x[0]}_{x[1]}" in a.streams.split(",")]:
                out = os.path.join(ROOT, "data", f"{name}_{what}")
                os.makedirs(out, exist_ok=True)
                path = os.path.join(out, d.strftime("%Y%m%d") + ".parquet")
                if os.path.exists(path):
                    continue
                rows = []
                for k in range(13):
                    end_ny = dt.datetime.combine(d, dt.time(10, 0), NY) + dt.timedelta(minutes=30 * k)
                    end_ts = end_ny.astimezone(dt.timezone.utc).strftime("%Y%m%d-%H:%M:%S")
                    attempt = 0
                    while True:
                        errs.clear()
                        bars = ib.reqHistoricalData(cons[name], endDateTime=end_ts, durationStr="1800 S",
                                                    barSizeSetting="1 secs", whatToShow=what, useRTH=True,
                                                    formatDate=2, timeout=90)
                        if bars:
                            break
                        pacing = any("pacing" in m.lower() for _, m in errs)
                        print(d, name, what, k, "empty", errs[-1:] if errs else "", flush=True)
                        if not pacing:
                            attempt += 1
                            if attempt >= 2:
                                break
                        time.sleep(60 if pacing else 5)  # pacing: wait it out, never skip a chunk
                    lo = end_ny - dt.timedelta(minutes=30)
                    for b in bars or []:
                        if lo <= b.date < end_ny:  # keep only this half hour (holiday requests spill back)
                            rows.append((b.date, b.open, b.high, b.low, b.close))
                    time.sleep(a.pause)
                if rows and len(rows) < 23000:
                    print(d, name, what, "INCOMPLETE", len(rows), "- not saved", flush=True)
                    day_ok = False
                    continue
                if not rows:
                    day_ok = False
                    print(d, name, what, "NO DATA (holiday?)", flush=True)
                    break
                df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close"]).drop_duplicates("ts")
                df["ts"] = pd.to_datetime(df.ts, utc=True)
                df.to_parquet(path + ".part", index=False)
                os.replace(path + ".part", path)
                print(d, name, what, len(df), "bars", flush=True)
            if day_ok:
                got += 1
            d -= dt.timedelta(days=1)
    finally:
        ib.disconnect()


if __name__ == "__main__":
    main()
