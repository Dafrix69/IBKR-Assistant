"""V-0021-pools data-integrity checks (no P&L). Candidate list for manual defect review.
Per pool / symbol:
  - days with |S_t/S_{t-1} - 1| > 35 % (consecutive data days of that symbol)
  - strike-grid persistence: for call expiries present on both days with >= 5 strikes on t-1,
    kept = |K_{t-1} ∩ K_t| / |K_{t-1}| (pooled over common expiries); flag kept < 0.5
  - underlying_price <= 0, files with >1 underlying_price, root codes other than the allowed ones,
    runs of >= 3 identical closes, missing days vs the pool calendar, last data day.
Output: V-0021_pools_tables/checks.txt and checks_candidates.csv
"""
import os
import numpy as np, pandas as pd
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cc", os.path.join(HERE, "V-0021_pools_cache.py"))
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)
TD = os.path.join(HERE, "V-0021_pools_tables")
os.makedirs(TD, exist_ok=True)


def allowed(pool, sym):
    a = {sym}
    if sym == "SQ": a.add("XYZ")
    if sym == "OSTK": a.add("BYON")
    return a


lines, cands = [], []
P = lambda s: lines.append(s)
for pool in cc.POOLS:
    syms = cc.members(pool)
    meta = {s: pd.read_parquet(os.path.join(cc.OUT, pool, f"{s}_files.parquet")).sort_values("date").reset_index(drop=True) for s in syms}
    cal = sorted(set().union(*[set(m.date) for m in meta.values()]))
    P(f"\n===== pool {pool}: {len(syms)} syms, calendar {len(cal)} days {cal[0].date()}..{cal[-1].date()}")
    for s in syms:
        m = meta[s]
        m = m[m.nrows > 0].reset_index(drop=True)
        calls = pd.read_parquet(os.path.join(cc.OUT, pool, f"{s}_calls.parquet"))
        al = allowed(pool, s)
        roots = sorted(set("|".join(m.roots.dropna()).split("|")))
        other = calls[~calls.root.isin(al)]
        ok = calls[calls.root.isin(al)]
        grid = ok.groupby(["date", "exp"]).strike.apply(frozenset)
        days = list(m.date)
        miss = [d for d in cal if d >= days[0] and d <= days[-1] and d not in set(days)]
        S = m.S.values
        flags = []
        for i in range(1, len(m)):
            d0, d1 = days[i - 1], days[i]
            r = S[i] / S[i - 1] - 1 if S[i - 1] > 0 else np.inf
            g0 = grid.loc[d0] if d0 in grid.index.get_level_values(0) else pd.Series(dtype=object)
            g1 = grid.loc[d1] if d1 in grid.index.get_level_values(0) else pd.Series(dtype=object)
            com = [e for e in g0.index if e in g1.index and len(g0[e]) >= 5]
            kept = (sum(len(g0[e] & g1[e]) for e in com) / sum(len(g0[e]) for e in com)) if com else np.nan
            if abs(r) > 0.35 or (np.isfinite(kept) and kept < 0.5) or S[i] <= 0:
                flags.append((d0, d1, S[i - 1], S[i], r, kept, len(com)))
        zero = m[m.S_min <= 0]
        multi = m[m.n_up > 1]
        runs, cur = [], 1
        for i in range(1, len(m)):
            cur = cur + 1 if S[i] == S[i - 1] else 1
            if cur == 3: runs.append(days[i - 2])
        P(f"{s}: files {len(m)} {days[0].date()}..{days[-1].date()} roots {roots} other-root call rows {len(other)}"
          f"{' (' + ','.join(sorted(other.root.unique())) + ' from ' + str(other.date.min().date()) + ')' if len(other) else ''}"
          f" | missing {len(miss)}{' ' + ','.join(str(d.date()) for d in miss[:6]) if miss else ''}"
          f" | S<=0 {len(zero)} multi-S files {len(multi)} stale-runs {len(runs)}{' ' + ','.join(str(d.date()) for d in runs[:4]) if runs else ''}")
        for d0, d1, s0, s1, r, kept, nc in flags:
            P(f"   FLAG {d0.date()}->{d1.date()} S {s0:.3f}->{s1:.3f} ({r:+.1%}) grid-kept {kept:.2f} over {nc} exp")
            cands.append(dict(pool=pool, sym=s, prev=d0, day=d1, S0=s0, S1=s1, ret=r, kept=kept, n_exp=nc))
        if len(zero):
            P("   S<=0 on " + ",".join(str(d.date()) for d in zero.date))
        if len(multi):
            P("   multi-S " + ",".join(f"{r.date.date()}({r.S_min}-{r.S_max})" for r in multi.head(5).itertuples()))
open(os.path.join(TD, "checks.txt"), "w").write("\n".join(lines) + "\n")
pd.DataFrame(cands).to_csv(os.path.join(TD, "checks_candidates.csv"), index=False)
print("\n".join(lines))
