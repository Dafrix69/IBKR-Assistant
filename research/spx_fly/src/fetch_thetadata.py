"""Fetch the Step 4 entry snapshots: every Friday 15:00 ET, NBBO of the SPXW expiring the
following week (next Friday, or the Thursday before it when that Friday is a holiday).

    .venv/bin/python src/fetch_thetadata.py

Endpoint and parameters: thetadata.net/docs/operations/option_history_quote.html, Options
Standard tier. Reuses tools/thetadata/download.py for terminal start-up and resumable,
validated downloads. Writes data/raw/SPXW/quote_weekly_entry/YYYY/{entry}_{expiry}.csv.gz.
Half-day Fridays have no 15:00 and are skipped. Holiday Fridays have no entry.
"""
import os
import sys

import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOLS = os.environ.get("THETA_TOOLS") or os.path.abspath(os.path.join(ROOT, "..", "..", "..", "..", "tools", "thetadata"))
sys.path.insert(0, TOOLS)
import download as D  # noqa: E402

CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
RAW = os.path.join(ROOT, CFG["paths"]["raw"])
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])


def entries(cal, expirations):
    """(entry date, expiry) for each full-day Friday whose next-week expiry exists."""
    out = []
    exps = pd.DatetimeIndex(sorted(pd.Timestamp(e) for e in expirations))
    for d in cal.index[(cal.index.weekday == 4) & ~cal.half_day]:
        nxt = d + pd.Timedelta(days=7)
        cand = exps[(exps > d + pd.Timedelta(days=4)) & (exps <= nxt)]
        if len(cand):
            out.append((d, cand[-1]))
    return out


def main():
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    proc = D.start_terminal()
    try:
        pairs = entries(cal, D.spxw_expirations())
        print(len(pairs), "entries", pairs[0][0].date(), "->", pairs[-1][0].date(), flush=True)
        got = 0
        for d, e in pairs:
            ymd, exp = d.strftime("%Y%m%d"), e.strftime("%Y%m%d")
            dest = os.path.join(RAW, "SPXW", "quote_weekly_entry", ymd[:4], f"{ymd}_{exp}.csv.gz")
            if os.path.exists(dest):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            url = (f"{D.BASE}/option/history/quote?symbol=SPXW&expiration={exp}&date={ymd}"
                   "&interval=1m&start_time=15:00:00&end_time=15:00:00")
            status, rows, _ = D.fetch_to_gz(url, dest)
            got += status == "ok"
            print(ymd, exp, status, rows, flush=True)
        print("fetched", got)
    finally:
        if proc is not None:
            proc.terminate()


if __name__ == "__main__":
    main()
