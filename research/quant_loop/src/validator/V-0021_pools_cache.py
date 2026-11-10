"""V-0021-pools cache: calls with 0..35 DTE + per-file facts, for the 7 ex-ante pools.
Independent of research/call_spread_edge (written from the data dictionary; does not read its src/ or out/).
No P&L here. Output under src/validator/V-0021_pools_cache/<pool>/ (git-ignored: ThetaData licence).

Run: research/spx_fly/.venv/bin/python src/validator/V-0021_pools_cache.py [pool ...]
"""
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "V-0021_pools_cache")
UNIV = os.path.join(HERE, "..", "..", "..", "call_spread_edge", "universe")
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031", "20231031", "20241031"]
MAX_DTE = 35


def raw_dir(pool):
    return os.path.expanduser("~/Data/thetadata_univ" if pool == "20241031" else f"~/Data/thetadata_univ_{pool}")


def members(pool):
    f = os.path.join(UNIV, "UNIVERSE.txt" if pool == "20241031" else f"UNIVERSE_{pool}.txt")
    return [s.strip() for s in open(f).read().replace("\n", ",").split(",") if s.strip()]


def build(args):
    pool, sym = args
    od = os.path.join(OUT, pool)
    op, sp = os.path.join(od, f"{sym}_calls.parquet"), os.path.join(od, f"{sym}_files.parquet")
    if os.path.exists(op) and os.path.exists(sp):
        return pool, sym, "cached"
    calls, meta = [], []
    for f in sorted(glob.glob(f"{raw_dir(pool)}/{sym}/greeks_eod/*/*.csv.gz")):
        day = pd.Timestamp(os.path.basename(f)[:8])
        d = pd.read_csv(f, usecols=["symbol", "expiration", "strike", "right", "bid", "ask", "volume", "underlying_price"])
        if d.empty:
            meta.append(dict(date=day, nrows=0)); continue
        up = d.underlying_price.unique()
        ex = pd.to_datetime(d.expiration)
        dte = (ex - day).dt.days
        meta.append(dict(date=day, nrows=len(d), n_up=len(up), S=float(np.median(d.underlying_price)),
                         S_min=float(d.underlying_price.min()), S_max=float(d.underlying_price.max()),
                         roots="|".join(sorted(map(str, d.symbol.unique()))), n_exp=d.expiration.nunique(),
                         dte_min=int(dte.min()), dte_max=int(dte.max())))
        m = (d.right.str.upper().str.startswith("C")) & (dte >= 0) & (dte <= MAX_DTE)
        d = d[m]
        calls.append(pd.DataFrame(dict(date=day, exp=ex[m].values, strike=d.strike.values.astype(float),
                                       bid=d.bid.values.astype(float), ask=d.ask.values.astype(float),
                                       vol=d.volume.values.astype(float), root=d.symbol.values.astype(str))))
    os.makedirs(od, exist_ok=True)
    (pd.concat(calls, ignore_index=True) if calls else pd.DataFrame(
        columns=["date", "exp", "strike", "bid", "ask", "vol", "root"])).to_parquet(op)
    pd.DataFrame(meta).to_parquet(sp)
    return pool, sym, f"built {len(meta)} files"


if __name__ == "__main__":
    pools = sys.argv[1:] or POOLS
    jobs = [(p, s) for p in pools for s in members(p)]
    with Pool(6) as pp:
        for p, s, st in pp.imap_unordered(build, jobs):
            print(p, s, st, flush=True)
