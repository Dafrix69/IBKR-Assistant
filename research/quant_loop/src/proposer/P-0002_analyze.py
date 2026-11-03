"""P-0002 analysis on the training panel: thresholds, mechanism gates (trigger rate, I1, I2),
then paired P&L vs base A (14:00) and the H2 placebo. Training period only."""
import os
import numpy as np, pandas as pd
R = '/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly'
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'P-0002_tables')
WALL = pd.Timestamp('2024-11-01')
m = pd.read_parquet(f'{T}/minutes.parquet'); m = m[m.date < WALL]       # TIME WALL
fl = pd.read_parquet(f'{T}/flies.parquet'); fl = fl[fl.date < WALL]     # TIME WALL
cal = pd.read_parquet(f'{R}/data/clean/calendar.parquet'); cal = cal[cal.index < WALL]  # TIME WALL
rng = np.random.default_rng(20261101)

# base-A days: skip previous-day <= -1%
prev = cal.spx_ret_prev
base_days = set(prev[~(prev <= -0.01)].index)
m = m[m.date.isin(base_days)].copy()
fl = fl[fl.date.isin(base_days)].copy()

R80, M50 = m.R.quantile(0.80), m.M.quantile(0.50)
m['trig'] = (m.R >= R80) & (m.M <= M50)
print(f'thresholds: R80={R80:.4f}  M50={M50:.4f}  candidate minutes={len(m)}  days={m.date.nunique()}')

# ---- mechanism gates
days_trig = m.groupby('date').trig.any()
rate = days_trig.mean()
ctrl = (m.R >= R80) & (m.M > M50)
i1_t, i1_c = m.loc[m.trig, 'fwd_dlnN'].mean(), m.loc[ctrl, 'fwd_dlnN'].mean()
i1_all = m.fwd_dlnN.mean()
i2 = m.loc[m.trig, 'fwd_range'].mean() / m.fwd_range.mean()
i2_c = m.loc[ctrl, 'fwd_range'].mean() / m.fwd_range.mean()
gates = pd.DataFrame({'value': [rate, i1_t, i1_c, i1_t - i1_c, i1_all, i2, i2_c,
                                m.trig.sum(), ctrl.sum()]},
                     index=['trigger_day_rate', 'I1_trig_fwd_dlnN', 'I1_ctrl_fwd_dlnN', 'I1_diff',
                            'all_fwd_dlnN', 'I2_trig_range_ratio', 'I2_ctrl_range_ratio', 'n_trig_min', 'n_ctrl_min'])
print(gates.round(4).to_string())
gates.to_csv(f'{T}/gates.csv')
m['year'] = m.date.dt.year
gy = m.groupby('year').apply(lambda g: pd.Series({
    'trig_day_rate': g.groupby('date').trig.any().mean(),
    'I1_diff': g.loc[g.trig, 'fwd_dlnN'].mean() - g.loc[(g.R >= R80) & (g.M > M50), 'fwd_dlnN'].mean(),
    'I2': g.loc[g.trig, 'fwd_range'].mean() / g.fwd_range.mean()}), include_groups=False)
print(gy.round(4).to_string()); gy.to_csv(f'{T}/gates_by_year.csv')

passed = rate >= 0.20 and (i1_t - i1_c) < 0 and i2 <= 1.1
print('MECHANISM GATES PASSED' if passed else 'MECHANISM GATES FAILED (spec: no P&L claim; P&L below printed for the record only)')

# ---- paired P&L
fk = fl.set_index(['date', 'minute'])
base = fl[fl.minute == 30].set_index('date')
rows = []
for d, g in m.groupby('date'):
    if d not in base.index:
        continue
    b = base.loc[d]
    tr = g[g.trig].sort_values('minute')
    rule, em = b, 30
    if len(tr):
        e = int(tr.minute.iloc[0]) + 1
        if (d, e) in fk.index:
            rule, em = fk.loc[(d, e)], e
    rows.append(dict(date=d, trig=len(tr) > 0, entry_min=em, pnl_base=b.pnl, pnl_rule=rule.pnl,
                     win_base=b.pnl > 0, win_rule=rule.pnl > 0, k05_base=b.pnl_k05, k05_rule=rule.pnl_k05,
                     cost_base=b.cost, cost_rule=rule.cost, w_base=b.width, w_rule=rule.width))
p = pd.DataFrame(rows); p['D'] = p.pnl_rule - p.pnl_base; p['D05'] = p.k05_rule - p.k05_base
p['year'] = p.date.dt.year
p.to_csv(f'{T}/paired_days.csv', index=False)


def boot(x, n=5000):
    x = np.asarray(x); i = rng.integers(0, len(x), (n, len(x)))
    return np.percentile(x[i].mean(1), [2.5, 97.5])


def summ(g):
    lo, hi = boot(g.D)
    return pd.Series({'days': len(g), 'trig_days': g.trig.sum(), 'base_win': g.win_base.mean(), 'rule_win': g.win_rule.mean(),
                      'base_ev': g.pnl_base.mean(), 'rule_ev': g.pnl_rule.mean(), 'D_mean': g.D.mean(), 'D_lo': lo, 'D_hi': hi,
                      'D_trigdays': g.loc[g.trig, 'D'].mean(), 'D_sd_trigdays': g.loc[g.trig, 'D'].std(),
                      'D05_mean': g.D05.mean()})
out = pd.concat([summ(p).rename('all')] + [summ(g).rename(y) for y, g in p.groupby('year')], axis=1).T
print(out.round(3).to_string()); out.to_csv(f'{T}/paired_summary.csv')

# ---- H2 placebo: every candidate minute i (trigger or not), entry at i+1 vs same-day 14:00, stratified by minute
z = m[['date', 'minute', 'trig']].copy(); z['e'] = z.minute + 1
z = z[z.e < 30]
z = z.join(fk.pnl.rename('pnl_e'), on=['date', 'e']).join(base.pnl.rename('pnl_b'), on='date').dropna()
z['D'] = z.pnl_e - z.pnl_b
by_min = z.groupby(['minute', 'trig']).D.mean().unstack()
wts = z[z.trig].groupby('minute').size()
h2 = ((by_min[True] - by_min[False]) * wts).sum() / wts.sum()
# day-cluster bootstrap of H2
days = z.date.unique()
def h2_of(zz):
    bm = zz.groupby(['minute', 'trig']).D.mean().unstack()
    w = zz[zz.trig].groupby('minute').size()
    return ((bm[True] - bm[False]) * w).sum() / w.sum()
zg = {d: g for d, g in z.groupby('date')}
bs = [h2_of(pd.concat([zg[d] for d in rng.choice(days, len(days))])) for _ in range(500)]
h2y = {y: h2_of(g) for y, g in z.groupby(z.date.dt.year)}
print(f'H2 (trigger minus non-trigger, minute-stratified): {h2:.1f}  95% [{np.percentile(bs,2.5):.1f}, {np.percentile(bs,97.5):.1f}]  by year {dict((k, round(v,1)) for k,v in h2y.items())}')
print('non-trigger early-entry D (all minutes):', round(z.loc[~z.trig, 'D'].mean(), 1), ' trigger:', round(z.loc[z.trig, 'D'].mean(), 1))
pd.Series({'H2': h2, 'H2_lo': np.percentile(bs, 2.5), 'H2_hi': np.percentile(bs, 97.5), **{f'H2_{k}': v for k, v in h2y.items()}}).to_csv(f'{T}/h2.csv')
