"""Candidate price-jump days in a cache's spot series (SPEC change 2: splits / reverse splits / renames are checked by price jump).
Lists every |close-to-close| > 35 % with the ratio, so each can be judged by hand as a split (exact ratio like 0.1, 2, 1/3 …)
or a real move. Output: CSV to stdout. Run: CSE_CACHE=cache_univ ../spx_fly/.venv/bin/python src/find_defects.py SYM1,SYM2"""
import os, sys
import pandas as pd

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("CSE_CACHE", "cache_univ")
print("sym,jump_day,prev_close,close,ratio,gap_days")
for sym in sys.argv[1].split(","):
    p = os.path.join(HERE, CACHE, f"{sym}_spot.parquet")
    if not os.path.exists(p):
        print(f"{sym},,,,missing,"); continue
    s = pd.read_parquet(p).S.sort_index()
    r = s / s.shift(1)
    for d in r.index[(r > 1.35) | (r < 1 / 1.35)]:
        i = s.index.get_loc(d)
        print(f"{sym},{d.date()},{s.iloc[i-1]:.4f},{s.iloc[i]:.4f},{r[d]:.4f},{(d - s.index[i-1]).days}")
