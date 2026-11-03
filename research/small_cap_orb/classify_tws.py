"""Security type of every screened symbol from TWS contract details (read-only, no market
data): COMMON, ETF, ADR, ... in IB's stockType. Used to keep common stocks only.

    ../spx_fly/.venv/bin/python classify_tws.py --port 7496   # writes universe/types.csv
"""
import argparse
import os

import pandas as pd
from ib_async import IB, Stock

ROOT = os.path.dirname(os.path.abspath(__file__))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--client-id", type=int, default=9731)
    p.add_argument("--industry", action="store_true", help="industry/category of the COMMON names -> universe/industry.csv")
    a = p.parse_args()
    out = os.path.join(ROOT, "universe", "industry.csv" if a.industry else "types.csv")
    cols = ["symbol", "industry", "category", "name"] if a.industry else ["symbol", "type", "name"]
    done = pd.read_csv(out) if os.path.exists(out) else pd.DataFrame(columns=cols)
    want = set()
    for f in ("candidates_raw.csv", "candidates.csv"):  # re-run after each screen until nothing new
        path = os.path.join(ROOT, "universe", f)
        if os.path.exists(path):
            want |= set(pd.read_csv(path).symbol)
    if a.industry:
        t = pd.read_csv(os.path.join(ROOT, "universe", "types.csv"))
        want &= set(t[t.type == "COMMON"].symbol)
    syms = sorted(want - set(done.symbol))
    print(len(syms), "symbols to classify", flush=True)
    ib = IB()
    ib.connect("127.0.0.1", a.port, clientId=a.client_id, readonly=True, timeout=20)
    rows = []
    try:
        for i, s in enumerate(syms):
            cds = ib.reqContractDetails(Stock(s, "SMART", "USD"))
            cd = cds[0] if cds else None
            if a.industry:
                rows.append(dict(symbol=s, industry=cd.industry if cd else "", category=cd.category if cd else "",
                                 name=cd.longName if cd else ""))
            else:
                rows.append(dict(symbol=s, type=cd.stockType if cd else "UNRESOLVED", name=cd.longName if cd else ""))
            if (i + 1) % 100 == 0:
                print(i + 1, "/", len(syms), flush=True)
    finally:
        ib.disconnect()
        pd.concat([done, pd.DataFrame(rows)]).to_csv(out, index=False)
    t = pd.read_csv(out)
    print((t.industry if a.industry else t.type).value_counts().to_string())


if __name__ == "__main__":
    main()
