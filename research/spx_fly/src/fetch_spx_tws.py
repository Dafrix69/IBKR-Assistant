"""SPX index 1-minute bars (regular hours) from TWS, read-only.

ThetaData's index tier on this account is FREE (no intraday SPX), so spot comes
from TWS instead. One request per week of bars, newest first, throttled under
IB's 60-requests-per-10-minutes pacing limit. Resumable: weeks already in
data/tws/spx_1m/ are skipped.

    .venv/bin/python src/fetch_spx_tws.py --port 7496 [--start 2024-10-30] [--end 2026-10-29]

Bar timestamps are bar START times in America/New_York. The 15:59 bar's close is
NOT the official close (equal on 11 of 1129 days, median gap 0.51, max 16.21); use
greeks_eod underlying_price for settlement, see reports/step0_close_check.csv.
"""
import argparse
import datetime as dt
import os
import time
from zoneinfo import ZoneInfo

import pandas as pd
import yaml
from ib_async import IB, Index

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
OUT = os.path.join(ROOT, "data", "tws", "spx_1m")
TZ = CFG["data"]["tz"]


def week_ends(start, end):
    """Fridays (week ends) covering [start, end], newest first."""
    d = end + dt.timedelta(days=(4 - end.weekday()) % 7)
    while d - dt.timedelta(days=6) >= start - dt.timedelta(days=6):
        yield d
        d -= dt.timedelta(days=7)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, required=True, help="TWS API port (live 7496, paper 7497)")
    p.add_argument("--client-id", type=int, default=9711)
    p.add_argument("--start", default="2024-10-30")
    p.add_argument("--end", default=(dt.date.today() - dt.timedelta(days=1)).isoformat())
    p.add_argument("--pause", type=float, default=11.0, help="seconds between requests (pacing)")
    a = p.parse_args()

    os.makedirs(OUT, exist_ok=True)
    ib = IB()
    ib.connect(a.host, a.port, clientId=a.client_id, readonly=True, timeout=20)
    spx = Index("SPX", "CBOE", "USD")
    ib.qualifyContracts(spx)
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    try:
        for fri in week_ends(start, end):
            path = os.path.join(OUT, fri.strftime("%Y%m%d") + ".parquet")
            if os.path.exists(path) and fri < dt.date.today():
                continue
            # UTC form "yyyymmdd-hh:mm:ss": TWS rejects named zones in this locale
            end_ts = (dt.datetime.combine(fri, dt.time(16, 30), ZoneInfo(TZ))
                      .astimezone(dt.timezone.utc).strftime("%Y%m%d-%H:%M:%S"))
            bars = ib.reqHistoricalData(spx, endDateTime=end_ts, durationStr="1 W", barSizeSetting="1 min",
                                        whatToShow="TRADES", useRTH=True, formatDate=2, timeout=120)
            if not bars:
                print(fri, "no bars", flush=True)
                time.sleep(a.pause)
                continue
            df = pd.DataFrame([{"ts": b.date, "open": b.open, "high": b.high, "low": b.low, "close": b.close}
                               for b in bars])
            df["ts"] = pd.to_datetime(df.ts, utc=True).dt.tz_convert(TZ)
            df.to_parquet(path + ".part", index=False)
            os.replace(path + ".part", path)
            days = df.ts.dt.date.nunique()
            print(fri, len(df), "bars", days, "days", df.ts.min(), "->", df.ts.max(), flush=True)
            time.sleep(a.pause)
    finally:
        ib.disconnect()


if __name__ == "__main__":
    main()
