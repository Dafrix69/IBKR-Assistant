"""V-0022 raw cache: weekly-horizon PUT quotes (DTE 0..10) + daily close from ThetaData greeks_eod.
Independent of research/call_spread_edge. Caches ALL dates; the time wall is applied as the first step
after loading in P-0022_build.py.  Also writes per-file integrity checks.
Run: research/spx_fly/.venv/bin/python src/validator/P-0022_cache.py [SYM ...]
"""
import glob, gzip, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd

RAW = os.path.expanduser("~/Data/thetadata")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0022_cache")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()
ETF = "SPY QQQ IWM".split()
COLS = ["expiration", "strike", "right", "bid", "ask", "volume", "underlying_price"]


def one(f):
    day = pd.Timestamp(os.path.basename(f)[:8])
    try:
        d = pd.read_csv(f, usecols=COLS)
    except Exception as e:  # corrupt / empty file
        return day, None, dict(date=day, rows=0, err=str(e)[:80])
    if d.empty:
        return day, None, dict(date=day, rows=0, err="empty")
    up = d.underlying_price.astype(float)
    chk = dict(date=day, rows=len(d), up_n=up.nunique(), up_min=up.min(), up_max=up.max(), err="")
    d["exp"] = pd.to_datetime(d.expiration)
    dte = (d.exp - day).dt.days
    p = d[(d.right == "PUT") & (dte >= 0) & (dte <= 10)]
    p = pd.DataFrame(dict(date=day, exp=p.exp.values, strike=p.strike.values.astype(float), bid=p.bid.values.astype(float),
                          ask=p.ask.values.astype(float), vol=p.volume.values.astype(float)))
    chk["S"] = float(up.median())
    return day, p, chk


def build(sym):
    files = sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz"))
    res = [one(f) for f in files]
    q = pd.concat([r[1] for r in res if r[1] is not None], ignore_index=True)
    chk = pd.DataFrame([r[2] for r in res])
    q.to_parquet(os.path.join(OUT, f"{sym}_puts.parquet"))
    chk.to_parquet(os.path.join(OUT, f"{sym}_check.parquet"))
    return sym, len(files), len(q), int((chk.rows == 0).sum()), int((chk.get("up_n", pd.Series([1])) > 1).sum())


if __name__ == "__main__":
    syms = sys.argv[1:] or SMALL + ETF
    os.makedirs(OUT, exist_ok=True)
    with Pool(8) as p:
        for r in p.imap_unordered(build, syms):
            print(r, flush=True)
