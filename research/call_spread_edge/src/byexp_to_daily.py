"""Re-slice ~/Data/thetadata/<SYM>/greeks_eod_byexp/*.csv.gz into the usual per-day layout under
~/Data/thetadata_univ/<SYM>/greeks_eod/YYYY/YYYYMMDD.csv.gz (same columns as the full greeks_eod files,
but only expirations within 30–45 days of each date). Run: ../spx_fly/.venv/bin/python src/byexp_to_daily.py SYM1,SYM2"""
import glob, os, sys
import pandas as pd

SRC = os.path.expanduser("~/Data/thetadata")
DST = os.path.expanduser(os.environ.get("CSE_DST", "~/Data/thetadata_univ"))
SUBDIR = os.environ.get("CSE_SUBDIR", "greeks_eod_byexp")   # SPEC change 3: e.g. greeks_eod_byexp_20231031

for sym in sys.argv[1].split(","):
    files = sorted(glob.glob(f"{SRC}/{sym}/{SUBDIR}/*.csv.gz"))
    parts = [pd.read_csv(f) for f in files if os.path.getsize(f) > 30]
    parts = [p for p in parts if len(p)]
    if not parts:
        print(sym, "no data"); continue
    d = pd.concat(parts, ignore_index=True)
    d["_day"] = d.timestamp.astype(str).str[:10].str.replace("-", "")
    n = 0
    for day, g in d.groupby("_day"):
        dest = f"{DST}/{sym}/greeks_eod/{day[:4]}/{day}.csv.gz"
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        g.drop(columns="_day").sort_values(["expiration", "strike", "right"]).to_csv(dest, index=False, compression="gzip")
        n += 1
    print(sym, "days", n, "rows", len(d), "first", min(d._day), "last", max(d._day), flush=True)
