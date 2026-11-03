"""1-minute regular-hours bars from TWS, read-only, one request per week, resumable.

    ../spx_fly/.venv/bin/python fetch_tws.py --port 7496 --job IREN:TRADES:2024-10-31 ...

Writes data/<SYMBOL>_<WHAT>/<friday>.parquet. Bar timestamps are bar START times
in America/New_York. A week that already has a file is skipped, except the last one.
"""
import argparse
import datetime as dt
import os
import time
from zoneinfo import ZoneInfo

import pandas as pd
from ib_async import IB, Stock

ROOT = os.path.dirname(os.path.abspath(__file__))
TZ = "America/New_York"


def fridays(start, end):
    d = end + dt.timedelta(days=(4 - end.weekday()) % 7)
    while d - dt.timedelta(days=6) >= start - dt.timedelta(days=6):
        yield d
        d -= dt.timedelta(days=7)


def row(b, what):
    if what == "BID_ASK":  # IB: open = time-average bid, close = time-average ask
        return {"ts": b.date, "bid": b.open, "ask": b.close, "ask_max": b.high, "bid_min": b.low}
    return {"ts": b.date, "open": b.open, "high": b.high, "low": b.low, "close": b.close,
            "volume": b.volume, "wap": b.average}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9731)
    p.add_argument("--end", default="2026-10-30")
    p.add_argument("--pause", type=float, default=10.5)
    p.add_argument("--job", action="append", required=True, help="SYMBOL:WHAT:START")
    p.add_argument("--all-hours", action="store_true",
                   help="pre-market and after-hours too (04:00-20:00 ET); written to data/<SYMBOL>_<WHAT>_EXT")
    p.add_argument("--overnight", action="store_true",
                   help="IBKR's OVERNIGHT exchange, 20:00-03:50 ET; written to data/<SYMBOL>_<WHAT>_OVN")
    a = p.parse_args()

    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    end = dt.date.fromisoformat(a.end)
    try:
        for job in a.job:
            sym, what, start = job.split(":")
            suffix = "_OVN" if a.overnight else "_EXT" if a.all_hours else ""
            out = os.path.join(ROOT, "data", f"{sym}_{what}{suffix}")
            os.makedirs(out, exist_ok=True)
            c = Stock(sym, "OVERNIGHT" if a.overnight else "SMART", "USD")
            ib.qualifyContracts(c)
            empty = 0
            for fri in fridays(dt.date.fromisoformat(start), end):
                path = os.path.join(out, fri.strftime("%Y%m%d") + ".parquet")
                if os.path.exists(path):
                    continue
                # overnight: the week's last session ends Friday 03:50, so end on Friday 04:00
                end_t = dt.time(4, 0) if a.overnight else dt.time(20, 30) if a.all_hours else dt.time(16, 30)
                end_ts = (dt.datetime.combine(fri, end_t, ZoneInfo(TZ))
                          .astimezone(dt.timezone.utc).strftime("%Y%m%d-%H:%M:%S"))
                bars = None
                for attempt in range(4):  # a TWS disconnect (error 1100) returns nothing: that is not "before listing"
                    for _ in range(60):
                        if ib.isConnected():
                            break
                        ib.sleep(10)
                    bars = ib.reqHistoricalData(c, endDateTime=end_ts, durationStr="1 W", barSizeSetting="1 min",
                                                whatToShow=what, useRTH=not (a.all_hours or a.overnight),
                                                formatDate=2, timeout=120)
                    time.sleep(a.pause)
                    if bars or (ib.isConnected() and attempt >= 1):
                        break
                    print(sym, what, fri, "empty, retrying", flush=True)
                    ib.sleep(30)
                if not bars:
                    print(sym, what, fri, "no bars", flush=True)
                    empty += 1
                    if empty >= 2:  # before listing
                        break
                    continue
                empty = 0
                df = pd.DataFrame([row(b, what) for b in bars])
                df["ts"] = pd.to_datetime(df.ts, utc=True).dt.tz_convert(TZ)
                df.to_parquet(path + ".part", index=False)
                os.replace(path + ".part", path)
                print(sym, what, fri, len(df), "bars", df.ts.min(), "->", df.ts.max(), flush=True)
    finally:
        ib.disconnect()


if __name__ == "__main__":
    main()
