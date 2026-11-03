"""P-0002 panel builder. Training period only (date < 2024-11-01).
Per day: minute rows 13:30-13:59 with R, M, forward reversion / range, and the fly pnl
for an entry at every minute 13:31-14:00 (k 0.20, per-leg $1 commission minimum).
Output: P-0002_tables/minutes.parquet, P-0002_tables/flies.parquet"""
import os
import numpy as np, pandas as pd, yaml
from concurrent.futures import ProcessPoolExecutor
R = '/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'P-0002_tables')
WALL = pd.Timestamp('2024-11-01')
cal = pd.read_parquet(f'{R}/data/clean/calendar.parquet')
cal = cal[cal.index < WALL]                       # TIME WALL: training period only
cal = cal[(~cal.half_day) & cal.has_0dte]
spot_all = pd.read_parquet(f'{R}/data/clean/spot.parquet')
spot_all = spot_all[spot_all.ts < WALL]           # TIME WALL
spot_all = spot_all.set_index('ts').spot
F = yaml.safe_load(open(f'{R}/config.yaml'))['fills']
K_FILL = F['k_default']                           # 0.20
WIDTHS = [20, 25, 30, 50, 75]
LOOK = 15


def tier(p, tiers):
    for t in tiers:
        if p < t['below']:
            return t['fee']
    return tiers[-1]['fee']


def leg_fees(px, qty):
    comm = max(tier(px, F['commission']) * qty, F['commission_min_per_leg'])
    return comm + qty * (tier(px, F['exchange']) + F['execution_surcharge'] + F['regulatory_clearing'])


def straddle_at(q, s):
    """A(t): ATM straddle interpolated at spot between the two bracketing strikes."""
    ks = np.array(sorted(set(q.index.get_level_values(0))))
    lo, hi = ks[ks <= s], ks[ks >= s]
    if len(lo) == 0 or len(hi) == 0:
        return np.nan
    k1, k2 = lo.max(), hi.min()
    try:
        v1 = q.loc[(k1, 'C'), 'mid'] + q.loc[(k1, 'P'), 'mid']
        v2 = q.loc[(k2, 'C'), 'mid'] + q.loc[(k2, 'P'), 'mid']
    except KeyError:
        return np.nan
    return float(v1) if k1 == k2 else float(v1 + (v2 - v1) * (s - k1) / (k2 - k1))


def fly_pnl(q, s, settle):
    """Base-A fly at this snapshot: center nearest strike, width ~2x implied. Returns dict or None."""
    ks = np.array(sorted(set(q.index.get_level_values(0))))
    Kc = float(ks[np.abs(ks - s).argmin()])
    try:
        implied = float(q.loc[(Kc, 'C'), 'mid'] + q.loc[(Kc, 'P'), 'mid'])
    except KeyError:
        return None
    w = min(WIDTHS, key=lambda x: abs(x / implied - 2))
    legs = [(Kc - w, 'P', 1, 1), (Kc, 'P', -1, 2), (Kc + w, 'P', 1, 1)]
    try:
        r = [q.loc[(k, rt)] for k, rt, _, _ in legs]
    except KeyError:
        return None
    mid = sum(sg * qt * x.mid for (_, _, sg, qt), x in zip(legs, r))
    H = sum(qt * (x.ask - x.bid) / 2 for (_, _, _, qt), x in zip(legs, r))
    if mid <= 0:
        return None
    fees = sum(leg_fees(x.mid, qt) for (_, _, _, qt), x in zip(legs, r))
    pay = max(0.0, w - abs(settle - Kc))
    pnl = (pay - mid - K_FILL * H) * 100 - fees
    pnl05 = (pay - mid - 0.5 * H) * 100 - fees
    return dict(K=Kc, width=w, implied=implied, cost=mid, H=H, fees=fees, payoff=pay, pnl=pnl, pnl_k05=pnl05)


def one(d):
    f = f'{R}/data/clean/chain_{d:%Y%m%d}.parquet'
    if not os.path.exists(f):
        return [], []
    ch = pd.read_parquet(f, columns=['strike', 'right', 'ts', 'bid', 'ask', 'mid', 'flag_bad'])
    ch = ch[ch.ts < WALL]                         # TIME WALL (redundant: file date < wall)
    ch = ch[~ch.flag_bad]
    settle = float(cal.loc[d, 'settle'])
    sp = spot_all[spot_all.index.normalize() == d]
    day0 = pd.Timestamp(f'{d:%Y-%m-%d} 13:15')
    snaps = {t: g.set_index(['strike', 'right'])[['bid', 'ask', 'mid']]
             for t, g in ch[(ch.ts >= day0) & (ch.ts <= day0 + pd.Timedelta(minutes=60))].groupby('ts')}
    N, A = {}, {}
    for t, q in snaps.items():
        if t not in sp.index:
            continue
        a = straddle_at(q, float(sp.loc[t]))
        if np.isfinite(a) and a > 0:
            tau = (pd.Timestamp(f'{d:%Y-%m-%d} 16:00') - t).total_seconds() / 60
            A[t], N[t] = a, a / np.sqrt(tau)
    mins = []
    for i in range(30):
        t = pd.Timestamp(f'{d:%Y-%m-%d} 13:30') + pd.Timedelta(minutes=i)
        tb, tf = t - pd.Timedelta(minutes=LOOK), t + pd.Timedelta(minutes=LOOK)
        if t not in N or tb not in N:
            continue
        win = sp[(sp.index >= tb) & (sp.index <= t)]
        fwd = sp[(sp.index >= t) & (sp.index <= tf)]
        mins.append(dict(date=d, t=t, minute=i, A=A[t], R=np.log(N[t] / N[tb]),
                         M=(win.max() - win.min()) / A[t],
                         fwd_dlnN=np.log(N[tf] / N[t]) if tf in N else np.nan,
                         fwd_range=(fwd.max() - fwd.min()) / A[t] if len(fwd) > LOOK // 2 else np.nan))
    flies = []
    for i in range(1, 31):                        # entries 13:31 .. 14:00
        t = pd.Timestamp(f'{d:%Y-%m-%d} 13:30') + pd.Timedelta(minutes=i)
        if t not in snaps or t not in sp.index:
            continue
        r = fly_pnl(snaps[t], float(sp.loc[t]), settle)
        if r:
            r.update(date=d, t=t, minute=i)
            flies.append(r)
    return mins, flies


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(one, list(cal.index), chunksize=8))
    m = pd.DataFrame([x for a, _ in res for x in a])
    fl = pd.DataFrame([x for _, b in res for x in b])
    m.to_parquet(f'{OUT}/minutes.parquet', index=False)
    fl.to_parquet(f'{OUT}/flies.parquet', index=False)
    print(len(m), 'minute rows', m.date.nunique(), 'days;', len(fl), 'fly rows', fl.date.nunique(), 'days')
