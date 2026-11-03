"""VIX daily closes from TWS, read-only. Writes data/tws/vix_1d.parquet.

    .venv/bin/python src/fetch_vix_tws.py --port 7496
"""
import argparse
import os

import pandas as pd
from ib_async import IB, Index

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9713)
    a = p.parse_args()
    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    vix = Index("VIX", "CBOE", "USD")
    ib.qualifyContracts(vix)
    bars = ib.reqHistoricalData(vix, endDateTime="", durationStr="5 Y", barSizeSetting="1 day",
                                whatToShow="TRADES", useRTH=True, formatDate=1, timeout=120)
    ib.disconnect()
    df = pd.DataFrame([{"date": pd.Timestamp(b.date), "vix_close": b.close} for b in bars])
    df.to_parquet(os.path.join(ROOT, "data", "tws", "vix_1d.parquet"), index=False)
    print(len(df), df.date.min().date(), df.date.max().date(), df.vix_close.min(), df.vix_close.max())


if __name__ == "__main__":
    main()
