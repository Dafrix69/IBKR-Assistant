"""V-0021 data-integrity checks (no P&L computed here).
- per file: underlying_price unique? symbol column values? row-count outliers vs neighbours
- spot jumps |log r| > 0.4 and whether the strike grid (median strike / spot) jumps with it (split / reorg)
- date coverage: small caps vs ETF; ETF dates vs NYSE weekdays minus holidays
Run: research/spx_fly/.venv/bin/python src/validator/P-0021_checks.py
"""
import os
import numpy as np, pandas as pd

C = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0021_cache")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()
ETF = "SPY QQQ IWM".split()

# NYSE full-day closures 2022-05 .. 2026-11 (published exchange calendar)
HOL = pd.to_datetime("""2022-05-30 2022-06-20 2022-07-04 2022-09-05 2022-11-24 2022-12-26
2023-01-02 2023-01-16 2023-02-20 2023-04-07 2023-05-29 2023-06-19 2023-07-04 2023-09-04 2023-11-23 2023-12-25
2024-01-01 2024-01-15 2024-02-19 2024-03-29 2024-05-27 2024-06-19 2024-07-04 2024-09-02 2024-11-28 2024-12-25
2025-01-01 2025-01-09 2025-01-20 2025-02-17 2025-04-18 2025-05-26 2025-06-19 2025-07-04 2025-09-01 2025-11-27 2025-12-25
2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07""".split())

allm = {}
for s in SMALL + ETF:
    m = pd.read_parquet(os.path.join(C, f"{s}_spot.parquet")).sort_values("date").reset_index(drop=True)
    allm[s] = m
    bad_up = m[m.n_up > 1]
    roots = sorted(set("|".join(m.syms).split("|")))
    med = m.nrows.rolling(11, center=True, min_periods=3).median()
    thin = m[m.nrows < 0.5 * med]
    lr = np.log(m.S).diff()
    kr = np.log(m.k_med / m.S)
    jumps = m[(lr.abs() > 0.4)]
    print(f"{s}: files {len(m)} {m.date.min().date()}..{m.date.max().date()} roots {roots} multi-underlying-files {len(bad_up)} "
          f"thin-files {len(thin)} jumps>0.4 {len(jumps)}")
    if len(bad_up):
        print("   multi underlying_price:", bad_up[["date", "n_up", "S_min", "S_max"]].head(5).to_string(index=False))
    if len(thin):
        print("   thin:", ", ".join(f"{r.date.date()}({r.nrows})" for r in thin.itertuples()))
    for i in jumps.index:
        print(f"   jump {m.date[i-1].date()}->{m.date[i].date()}: S {m.S[i-1]:.3f}->{m.S[i]:.3f}  "
              f"log(medK/S) {kr[i-1]:+.2f}->{kr[i]:+.2f}  rows {m.nrows[i-1]}->{m.nrows[i]}")

# date coverage
ref = set(allm["SPY"].date)
for s in SMALL:
    miss = sorted(set(d for d in ref if d >= allm[s].date.min()) - set(allm[s].date))
    extra = sorted(set(allm[s].date) - ref)
    print(f"{s}: missing vs SPY {[str(d.date()) for d in miss]} extra {[str(d.date()) for d in extra]}")
bd = pd.bdate_range("2022-05-02", "2026-11-05")
nyse = set(bd) - set(HOL)
for s in ETF:
    have = set(allm[s].date)
    print(f"{s}: NYSE days {len(nyse)} files {len(have)} missing {[str(d.date()) for d in sorted(nyse - have)]} "
          f"extra {[str(d.date()) for d in sorted(have - nyse)]}")

# WOLF around the reorganisation
w = allm["WOLF"]
print(w[(w.date >= "2025-09-20") & (w.date <= "2025-10-20")][["date", "nrows", "S", "k_med", "syms"]].to_string(index=False))
