"""V-0021 cache: calls with 0..35 DTE + daily close spot, for the 15 small caps and SPY/QQQ/IWM.
Independent of research/call_spread_edge (written from the data dictionary only).

The cache is period-agnostic (no numbers are produced here); every analysis script filters the period
as its first step after reading the cache.

Per file also records data-quality facts: n rows, n distinct underlying_price values, symbol values.
Run: research/spx_fly/.venv/bin/python src/validator/P-0021_cache.py
"""
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd

RAW = os.path.expanduser("~/Data/thetadata")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0021_cache")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()
ETF = "SPY QQQ IWM".split()
MAX_DTE = 35


def build(sym):
    op = os.path.join(OUT, f"{sym}_calls.parquet")
    sp = os.path.join(OUT, f"{sym}_spot.parquet")
    if os.path.exists(op) and os.path.exists(sp):
        return sym, "cached"
    calls, meta = [], []
    for f in sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz")):
        day = pd.Timestamp(os.path.basename(f)[:8])
        d = pd.read_csv(f, usecols=["symbol", "expiration", "strike", "right", "bid", "ask", "volume", "underlying_price"])
        up = d.underlying_price.unique() if len(d) else np.array([])
        meta.append(dict(date=day, nrows=len(d), n_up=len(up), S=float(np.median(d.underlying_price)) if len(d) else np.nan,
                         S_min=float(d.underlying_price.min()) if len(d) else np.nan,
                         S_max=float(d.underlying_price.max()) if len(d) else np.nan,
                         syms="|".join(sorted(map(str, d.symbol.unique()))),
                         n_exp=d.expiration.nunique(), k_med=float(d.strike.median()) if len(d) else np.nan))
        if d.empty:
            continue
        ex = pd.to_datetime(d.expiration)
        dte = (ex - day).dt.days
        m = (d.right.str.upper().str.startswith("C")) & (dte >= 0) & (dte <= MAX_DTE)
        d = d[m]
        calls.append(pd.DataFrame(dict(date=day, exp=ex[m].values, strike=d.strike.values.astype(float),
                                       bid=d.bid.values.astype(float), ask=d.ask.values.astype(float),
                                       vol=d.volume.values.astype(float), root=d.symbol.values)))
    os.makedirs(OUT, exist_ok=True)
    pd.concat(calls, ignore_index=True).to_parquet(op)
    pd.DataFrame(meta).to_parquet(sp)
    return sym, "built"


if __name__ == "__main__":
    syms = sys.argv[1:] or SMALL + ETF
    with Pool(8) as p:
        for s, st in p.imap_unordered(build, syms):
            print(s, st, flush=True)
