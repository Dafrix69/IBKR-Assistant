"""P-0018 grid check -- post-hoc (after the gate failed), report only: is D a half-tick grid effect?"""
import numpy as np
import pandas as pd
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0018_tables"
SPLIT = pd.Timestamp("2025-11-01")
p = pd.read_parquet(f"{T}/prints_train.parquet")
p = p[p.date < SPLIT]                                            # time wall (first step after reading)
tm = p.ts.dt.hour * 60 + p.ts.dt.minute
p = p[(tm < 930) & p.pi_m1.notna() & p.pi_m0.notna()]
ref = (1 - p.u) * p.pi_m0 + p.u * p.pi_m1
D = (p.pi_trade - ref) * 100
fr = lambda x: np.round((np.round(x * 1000) % 50) / 10) * 10 / 1000      # residue mod 0.05, to 0.01
print("pi_m0 mod 0.05 share:", (np.round(p.pi_m0 * 100) % 5).value_counts(normalize=True).sort_index().round(3).to_dict(), "(units of 0.01)")
print("pi_trade mod 0.05 share:", (np.round(p.pi_trade * 100) % 5).value_counts(normalize=True).sort_index().round(3).to_dict())
print("pi_own mod 0.05 share:", (np.round(p.pi_own * 100) % 5).value_counts(normalize=True).sort_index().round(3).to_dict())
same = (p.pi_m0 == p.pi_m1).mean()
print(f"chain m and m+1 rows equal: {same:.3f}")
b = np.round(D / 2.5) * 2.5
print("D rounded to 2.5 USD, share:", b.clip(-12.5, 12.5).value_counts(normalize=True).sort_index().round(3).to_dict())
print(f"|D - 2.5| < 0.5 share {(abs(D - 2.5) < 0.5).mean():.3f}; |D + 2.5| < 0.5 {(abs(D + 2.5) < 0.5).mean():.3f}; |D| < 0.5 {(abs(D) < 0.5).mean():.3f}")
q = (np.round(p.pi_m0 * 100) % 5 == 0)
print(f"on-grid pi_m0 (mod 0.05 == 0, share {q.mean():.3f}): D mean {D[q].mean():+.2f}, >0 {(D[q] > 0).mean():.3f}, <0 {(D[q] < 0).mean():.3f}")
print(f"half-tick pi_m0 (mod 0.05 == 0.025): D mean {D[np.round(p.pi_m0 * 1000) % 50 == 25].mean():+.2f}")
