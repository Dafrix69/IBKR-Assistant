"""VIX1D / VIX9D / VIX3M daily closes from TWS, read-only. Writes data/tws/vix_term_1d.parquet.

    .venv/bin/python src/fetch_vix_term_tws.py --port 7496
"""
import argparse
import os

import pandas as pd
from ib_async import IB, Index

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9716)
    a = p.parse_args()
    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    frames = []
    for sym in ["VIX1D", "VIX9D", "VIX3M"]:
        c = Index(sym, "CBOE", "USD")
        try:
            ib.qualifyContracts(c)
        except Exception as e:
            print(sym, "qualify failed", e)
            continue
        bars = ib.reqHistoricalData(c, endDateTime="", durationStr="5 Y", barSizeSetting="1 day",
                                    whatToShow="TRADES", useRTH=True, formatDate=1, timeout=120)
        df = pd.DataFrame([{"date": pd.Timestamp(b.date), sym.lower() + "_close": b.close} for b in bars])
        print(sym, len(df), df.date.min().date() if len(df) else None, df.date.max().date() if len(df) else None)
        frames.append(df.set_index("date"))
    ib.disconnect()
    out = pd.concat(frames, axis=1).sort_index().reset_index()
    out.to_parquet(os.path.join(ROOT, "data", "tws", "vix_term_1d.parquet"), index=False)
    print(out.tail(3))


if __name__ == "__main__":
    main()
