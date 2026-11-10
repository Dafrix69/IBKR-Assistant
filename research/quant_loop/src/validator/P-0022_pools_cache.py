"""V-0022-pools raw cache (ex-ante stock pools of call_spread_edge SPEC changes 2/3).
Independent of research/call_spread_edge/src. Per pool and symbol, from ThetaData greeks_eod daily CSVs:
  <pool>/<SYM>_puts.parquet  : PUT quotes with DTE 0..10 (date, exp, strike, bid, ask, vol)
  <pool>/<SYM>_check.parquet : per-file checks: rows, symbol names, underlying_price unique / min / max, S (median),
                               S_par (put-call parity close from the nearest DTE>=1 expiry), kept (min strike-retention vs
                               the previous file over common expiries with >=5 put strikes), kept_w (pooled retention), n_common
Run: research/spx_fly/.venv/bin/python src/validator/P-0022_pools_cache.py [pool ...]
"""
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "P-0022_pools_cache")
UNIV = os.path.join(HERE, "..", "..", "..", "call_spread_edge", "universe")   # name lists only (read-only)
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031", "20231031", "20241031"]
R = 0.043
COLS = ["symbol", "expiration", "strike", "right", "bid", "ask", "volume", "underlying_price"]


def raw_dir(pool):
    return os.path.expanduser("~/Data/thetadata_univ" if pool == "20241031" else f"~/Data/thetadata_univ_{pool}")


def universe(pool):
    f = "UNIVERSE.txt" if pool == "20241031" else f"UNIVERSE_{pool}.txt"
    return [s.strip() for s in open(os.path.join(UNIV, f)).read().replace("\n", ",").split(",") if s.strip()]


def parity(d, day):
    """Close implied by put-call parity on the nearest expiry with DTE >= 1: median over the 3 strikes with smallest |C-P|."""
    try:
        x = d[(d.bid > 0) & (d.ask >= d.bid)].copy()
        x["dte"] = (x.exp - day).dt.days
        x = x[x.dte >= 1]
        if x.empty:
            return np.nan
        e = x.exp.min(); x = x[x.exp == e]
        x["mid"] = 0.5 * (x.bid + x.ask)
        c = x[x.right == "CALL"].set_index("strike").mid; p = x[x.right == "PUT"].set_index("strike").mid
        j = c.index.intersection(p.index)
        if len(j) == 0:
            return np.nan
        T = (e - day).days / 365.0
        diff = (c[j] - p[j]); s = diff + np.asarray(j) * np.exp(-R * T)
        return float(s.iloc[np.argsort(np.abs(diff.values))[:3]].median())
    except Exception:
        return np.nan


def build(args):
    pool, sym = args
    files = sorted(glob.glob(f"{raw_dir(pool)}/{sym}/greeks_eod/*/*.csv.gz"))
    puts, chk, prev = [], [], None
    for f in files:
        day = pd.Timestamp(os.path.basename(f)[:8])
        try:
            d = pd.read_csv(f, usecols=COLS)
        except Exception as e:
            chk.append(dict(date=day, rows=0, err=str(e)[:80])); continue
        if d.empty:
            chk.append(dict(date=day, rows=0, err="empty")); continue
        d["exp"] = pd.to_datetime(d.expiration)
        up = d.underlying_price.astype(float)
        c = dict(date=day, rows=len(d), names="/".join(sorted(d.symbol.astype(str).unique())), up_n=up.nunique(),
                 up_min=up.min(), up_max=up.max(), S=float(up.median()), S_par=parity(d, day), err="")
        p = d[d.right == "PUT"]
        grid = {e: set(g.strike.astype(float)) for e, g in p.groupby("exp")}
        if prev is not None:
            ks, num, den = [], 0, 0
            for e, kp in prev.items():
                if e in grid and len(kp) >= 5:
                    kk = len(kp & grid[e]); ks.append(kk / len(kp)); num += kk; den += len(kp)
            c.update(kept=min(ks) if ks else np.nan, kept_w=num / den if den else np.nan, n_common=len(ks))
        prev = grid
        chk.append(c)
        dte = (p.exp - day).dt.days
        p = p[(dte >= 0) & (dte <= 10)]
        puts.append(pd.DataFrame(dict(date=day, exp=p.exp.values, strike=p.strike.values.astype(float), bid=p.bid.values.astype(float),
                                      ask=p.ask.values.astype(float), vol=p.volume.values.astype(float))))
    os.makedirs(os.path.join(OUT, pool), exist_ok=True)
    pd.concat(puts, ignore_index=True).to_parquet(os.path.join(OUT, pool, f"{sym}_puts.parquet"))
    pd.DataFrame(chk).to_parquet(os.path.join(OUT, pool, f"{sym}_check.parquet"))
    return pool, sym, len(files)


if __name__ == "__main__":
    pools = sys.argv[1:] or POOLS
    jobs = [(p, s) for p in pools for s in universe(p)]
    for p, s in jobs:
        assert glob.glob(f"{raw_dir(p)}/{s}/greeks_eod/*/*.csv.gz"), (p, s)
    with Pool(8) as pp:
        for r in pp.imap_unordered(build, jobs):
            print(r, flush=True)
