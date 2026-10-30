"""Independent check of the SPX official close: TWS daily bars vs ThetaData
greeks_eod underlying_price vs the last TWS 1-minute bar. Read-only.

    .venv/bin/python src/check_daily_close.py --port 7496
"""
import argparse
import os
import sys

import pandas as pd
from ib_async import IB, Index

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inventory as I


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9712)
    a = p.parse_args()
    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    spx = Index("SPX", "CBOE", "USD")
    ib.qualifyContracts(spx)
    bars = ib.reqHistoricalData(spx, endDateTime="", durationStr="5 Y", barSizeSetting="1 day",
                                whatToShow="TRADES", useRTH=True, formatDate=1, timeout=120)
    ib.disconnect()
    daily = pd.Series({pd.Timestamp(b.date).strftime("%Y%m%d"): b.close for b in bars})
    td = {}
    for f in I.files("SPXW/greeks_eod"):
        td[I.ymd(f)] = pd.read_csv(f, compression="gzip", usecols=["underlying_price"], nrows=1).iloc[0, 0]
    td = pd.Series(td)
    tws = I.tws_spot()
    last = tws.groupby(tws.ts.dt.strftime("%Y%m%d")).close.last()
    df = pd.DataFrame({"tws_daily": daily, "theta_close": td, "tws_last_1m": last}).dropna()
    df["daily_minus_theta"] = (df.tws_daily - df.theta_close).round(2)
    df["last1m_minus_theta"] = (df.tws_last_1m - df.theta_close).round(2)
    df.to_csv(os.path.join(I.ROOT, "reports", "step0_close_check.csv"))
    d = df.daily_minus_theta.abs()
    l = df.last1m_minus_theta.abs()
    print("days", len(df))
    print("tws_daily vs theta: exact", int((d < 0.005).sum()), "p95", round(d.quantile(.95), 2), "max", d.max())
    print("last_1m  vs theta: exact", int((l < 0.005).sum()), "median", round(l.median(), 2), "p95", round(l.quantile(.95), 2), "max", l.max())
    print(df[d >= 0.005].head(10).to_string())


if __name__ == "__main__":
    main()
