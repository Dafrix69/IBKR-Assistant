"""For each candidate jump (find_defects.py output on stdin-file), compare the strike grid of a common expiration on the day
before and the jump day. A split/consolidation replaces the grid (low same-set share); a real move keeps it or only adds strikes.
Run: CSE_CACHE=cache_univ_<day> ../spx_fly/.venv/bin/python src/check_jumps.py universe/jump_candidates_<day>.csv"""
import os, sys
import pandas as pd
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("CSE_CACHE", "cache_univ")
c = pd.read_csv(sys.argv[1], parse_dates=["jump_day"]).dropna(subset=["jump_day"])
print("sym,jump_day,ratio,gap_days,exp,strikes_before,strikes_after,kept_share,same_set")
for _, r in c.iterrows():
    o = pd.read_parquet(os.path.join(HERE, CACHE, f"{r.sym}.parquet")); s = pd.read_parquet(os.path.join(HERE, CACHE, f"{r.sym}_spot.parquet")).S
    i = s.index.get_loc(r.jump_day); d0, d1 = s.index[i - 1], s.index[i]
    a, b = o[o.date == d0], o[o.date == d1]
    common = sorted(set(a.exp) & set(b.exp))
    if not common:
        print(f"{r.sym},{r.jump_day.date()},{r.ratio:.3f},{r.gap_days},,,,,no common exp"); continue
    e = common[len(common) // 2]
    ka, kb = set(a[a.exp == e].strike), set(b[b.exp == e].strike)
    print(f"{r.sym},{r.jump_day.date()},{r.ratio:.3f},{r.gap_days},{e.date()},{len(ka)},{len(kb)},{len(ka & kb) / max(1, len(ka)):.2f},{len(ka & kb) / max(1, len(ka | kb)):.2f}")
