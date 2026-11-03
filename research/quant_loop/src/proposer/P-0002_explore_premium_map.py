"""P-0002 exploration (counted as variants in the spec): where along the 0DTE smile is the
short-to-settlement premium, 13:00 and 14:00, training period only.
Output: P-0002_tables/premium_map.csv, drift.csv"""
import sys, glob, os
import numpy as np, pandas as pd
from concurrent.futures import ProcessPoolExecutor
R = '/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly'
OUT = os.path.join(os.path.dirname(__file__), 'P-0002_tables')
cal = pd.read_parquet(f'{R}/data/clean/calendar.parquet')
cal = cal[cal.index < '2024-11-01']          # TIME WALL: training period only
cal = cal[(~cal.half_day) & cal.has_0dte]
spot = pd.read_parquet(f'{R}/data/clean/spot.parquet')
spot = spot[spot.ts < '2024-11-01']          # TIME WALL
spot = spot.set_index('ts').spot
ENTRIES = ['13:00', '14:00']

def one(d):
    f = f'{R}/data/clean/chain_{d:%Y%m%d}.parquet'
    if not os.path.exists(f):
        return None
    ch = pd.read_parquet(f)
    ch = ch[ch.ts < '2024-11-01']            # TIME WALL (per-file, redundant)
    settle = cal.loc[d, 'settle']
    rows = []
    for e in ENTRIES:
        ts = pd.Timestamp(f'{d:%Y-%m-%d} {e}')
        if ts not in spot.index:
            continue
        s = spot.loc[ts]
        q = ch[(ch.ts == ts) & (~ch.flag_bad)]
        if q.empty:
            continue
        Katm = q.strike.iloc[(q.strike - s).abs().argsort().iloc[0]]
        a = q[q.strike == Katm]
        if set(a.right) != {'C', 'P'}:
            continue
        implied = a.mid.sum()
        for _, r in q.iterrows():
            m = (r.strike - s) / implied
            if abs(m) > 3:
                continue
            pay = max(settle - r.strike, 0) if r.right == 'C' else max(r.strike - settle, 0)
            rows.append((d, e, r.right, m, r.mid, r.spread, pay, implied, (settle - s) / implied))
    return rows

if __name__ == '__main__':
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, list(cal.index)) if r]
    df = pd.DataFrame([x for r in res for x in r],
                      columns=['date', 'entry', 'right', 'm', 'mid', 'spread', 'pay', 'implied', 'drift'])
    df['year'] = df.date.dt.year
    df['short_gain'] = (df.mid - df.pay) / df.implied            # implied units, at mid
    df['short_gain_k20'] = (df.mid - 0.20 * df.spread / 2 - df.pay) / df.implied
    df['bucket'] = (np.floor(df.m / 0.25) * 0.25).round(2)
    g = df.groupby(['entry', 'right', 'bucket', 'year']).agg(n=('short_gain', 'size'), gain=('short_gain', 'mean'),
                                                          gain_k20=('short_gain_k20', 'mean'), mid=('mid', 'mean')).reset_index()
    g.to_csv(f'{OUT}/premium_map.csv', index=False)
    p = g.pivot_table(index=['entry', 'right', 'bucket'], columns='year', values='gain').round(3)
    print(p.to_string())
    d = df.drop_duplicates(['date', 'entry']).groupby(['entry', 'year']).drift.agg(['size', 'mean', 'median', 'std']).round(3)
    d.to_csv(f'{OUT}/drift.csv'); print(d)
