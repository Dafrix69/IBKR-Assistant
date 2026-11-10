"""Small-cap option cache (calls + puts, 0–60 DTE) and daily spot. ETFs are sealed (SPEC) and NOT built here.
Run: ../spx_fly/.venv/bin/python src/build_cache.py"""
import glob, os
from multiprocessing import Pool
import pandas as pd

# Overrides for the ex-ante universe run (SPEC change 2): CSE_RAW, CSE_SYMS (comma list), CSE_CACHE.
RAW = os.path.expanduser(os.environ.get("CSE_RAW", "~/Data/thetadata"))
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SMALL = os.environ["CSE_SYMS"].split(",") if os.environ.get("CSE_SYMS") else "IREN AXTI LITE OKLO CRDO NBIS QUBT NVTS APLD CLSK SNDK WOLF ALAB QBTS RKLB".split()
CACHE = os.environ.get("CSE_CACHE", "cache")


def build(sym):
    op, sp = os.path.join(HERE, CACHE, f"{sym}.parquet"), os.path.join(HERE, CACHE, f"{sym}_spot.parquet")
    if os.path.exists(op) and os.path.exists(sp):
        return sym
    out, spot = [], {}
    for f in sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz")):
        d = pd.read_csv(f, usecols=["expiration", "strike", "right", "bid", "ask", "underlying_price"])
        if d.empty:
            continue
        day = pd.Timestamp(os.path.basename(f)[:8])
        spot[day] = float(d.underlying_price.iloc[0])
        d["exp"] = pd.to_datetime(d.expiration)
        dte = (d.exp - day).dt.days
        d = d[(dte >= 0) & (dte <= 60)]
        out.append(pd.DataFrame(dict(date=day, exp=d.exp.values, strike=d.strike.values, right=(d.right == "CALL").map({True: "C", False: "P"}).values,
                                     bid=d.bid.values, ask=d.ask.values)))
    os.makedirs(os.path.dirname(op), exist_ok=True)
    pd.concat(out, ignore_index=True).to_parquet(op)
    pd.Series(spot, name="S").sort_index().rename_axis("date").to_frame().to_parquet(sp)
    return sym


if __name__ == "__main__":
    with Pool(8) as p:
        for s in p.imap_unordered(build, SMALL):
            print(s, flush=True)
