"""V-0003: independent training-period audit of P-0003 (equal-risk sizing, withdrawn at gate G2).
Written from the data dictionary (research/spx_fly/reports/mining/BRIEF.md); imports nothing from src/proposer
and does not read winrate_panel: the 14:00 baseline-A fly is re-priced from chain_*.parquet + spot.parquet.
TRAINING PERIOD ONLY: every read is filtered to date < 2024-11-01 as its first step.
Run: research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0003_equal_risk.py"""
import os
import numpy as np, pandas as pd, yaml
from scipy.stats import spearmanr, pearsonr, rankdata
from concurrent.futures import ProcessPoolExecutor

SPX = '/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'V-0003_tables')
CUT = pd.Timestamp('2024-11-01')
WING = (20, 25, 30, 50, 75)
K = 0.20

CAL = pd.read_parquet(f'{SPX}/data/clean/calendar.parquet')
CAL = CAL.loc[CAL.index < CUT]                                    # time wall, first step
CFG = yaml.safe_load(open(f'{SPX}/config.yaml'))['fills']


def tier(px, tiers):
    return next((t['fee'] for t in tiers if px < t['below']), tiers[-1]['fee'])


def leg_fee(px, n):
    return (max(tier(px, CFG['commission']) * n, CFG['commission_min_per_leg'])
            + n * (tier(px, CFG['exchange']) + CFG['execution_surcharge'] + CFG['regulatory_clearing']))


def price_day(args):
    d, settle, spot14 = args
    path = f'{SPX}/data/clean/chain_{d:%Y%m%d}.parquet'
    if not os.path.exists(path):
        return None
    c = pd.read_parquet(path, columns=['strike', 'right', 'ts', 'bid', 'ask', 'mid', 'flag_bad'])
    c = c.loc[(c.ts < CUT) & (c.ts == d + pd.Timedelta('14:00:00')) & ~c.flag_bad]
    if c.empty:
        return None
    q = c.set_index(['strike', 'right'])
    ks = q.index.get_level_values(0).unique().values
    Kc = float(ks[np.abs(ks - spot14).argmin()])
    try:
        implied = float(q.loc[(Kc, 'C'), 'mid'] + q.loc[(Kc, 'P'), 'mid'])
    except KeyError:
        return None
    rows = []
    for w in WING:
        legs = [(Kc - w, 'P', +1, 1), (Kc, 'P', -1, 2), (Kc + w, 'P', +1, 1)]
        if any((k, r) not in q.index for k, r, _, _ in legs):
            continue
        mid = sum(s * n * q.loc[(k, r), 'mid'] for k, r, s, n in legs)
        if mid <= 0:
            continue
        debit, fees = 0.0, 0.0
        for k, r, s, n in legs:
            b, a = q.loc[(k, r), 'bid'], q.loc[(k, r), 'ask']
            px = (a + b) / 2 + s * K * (a - b) / 2                 # buy above mid, sell below
            debit += s * n * px
            fees += leg_fee(px, n)
        D = debit * 100 + fees
        D05 = sum(s * n * ((q.loc[(k, r), 'ask'] + q.loc[(k, r), 'bid']) / 2 + s * 0.5 * (q.loc[(k, r), 'ask'] - q.loc[(k, r), 'bid']) / 2)
                  for k, r, s, n in legs) * 100 + fees
        pay = max(0.0, w - abs(settle - Kc)) * 100
        rows.append(dict(date=d, width=w, K=Kc, implied=implied, wI=w / implied, mid=mid, D=D, D05=D05,
                         pay=pay, pnl=pay - D, pnl05=pay - D05))
    if not rows:
        return None
    r = pd.DataFrame(rows)
    return r.iloc[(r.wI - 2).abs().values.argmin()].to_dict()      # first (narrowest) on ties


def maxdd(x):
    c = np.cumsum(x)
    return float(np.max(np.maximum.accumulate(np.concatenate([[0.0], c]))[1:] - c))


def sharpe(x):
    return float(np.mean(x) / np.std(x, ddof=1))


def partial_rank(y, x, groups):
    """Pearson of rank(y), rank(x) after removing group means of the ranks (= regression on dummies)."""
    ry, rx = pd.Series(rankdata(y)), pd.Series(rankdata(x))
    g = pd.Series(groups)
    ey = ry - ry.groupby(g.values).transform('mean').values
    ex = rx - rx.groupby(g.values).transform('mean').values
    return float(np.corrcoef(ey, ex)[0, 1])


def within_rank_spearman(y, x, groups):
    """Pooled Pearson of within-group percentile ranks."""
    df = pd.DataFrame(dict(y=y, x=x, g=groups))
    py = df.groupby('g').y.rank(pct=True); px = df.groupby('g').x.rank(pct=True)
    return float(np.corrcoef(py, px)[0, 1])


def main():
    os.makedirs(OUT, exist_ok=True)
    spot = pd.read_parquet(f'{SPX}/data/clean/spot.parquet')
    spot = spot.loc[spot.ts < CUT]                                # time wall, first step
    s14 = spot.loc[spot.ts.dt.time == pd.Timestamp('14:00').time()].set_index('ts').spot
    days = CAL.index[(~CAL.half_day) & CAL.has_0dte & ~(CAL.spx_ret_prev <= -0.01)]
    jobs = [(d, float(CAL.at[d, 'settle']), float(s14[d + pd.Timedelta('14:00:00')]))
            for d in days if d + pd.Timedelta('14:00:00') in s14.index]
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(price_day, jobs, chunksize=8) if r]
    b = pd.DataFrame(res).set_index('date').sort_index()
    b['year'] = b.index.year
    b['u'] = b.pnl / b.D
    c = b.D.mean()
    b['x'] = c / b.D
    b.to_csv(f'{OUT}/days.csv')
    L = []
    def P(*a):
        s = ' '.join(str(v) for v in a); print(s); L.append(s)
    P(f'base days {len(b)} win {np.mean(b.pnl > 0):.4f} ev {b.pnl.mean():+.2f} c {c:.1f} cvD {b.D.std() / c:.3f}')
    P('width counts', b.width.value_counts().sort_index().to_dict())
    # G1 / G2 pooled and by year
    t = pd.qcut(b.D, 3, labels=['low', 'mid', 'high'])
    g = b.groupby(t, observed=True).agg(n=('D', 'size'), D=('D', 'mean'), sd=('pnl', 'std'), ev=('pnl', 'mean'),
                                         win=('pnl', lambda s: (s > 0).mean()), u=('u', 'mean'))
    P(g.round(4).to_string()); g.to_csv(f'{OUT}/terciles_pooled.csv')
    rho, p = spearmanr(b.u, b.D)
    P(f'G1 {g.loc["high", "sd"] / g.loc["low", "sd"]:.3f}  G2 {rho:+.4f} p {p:.3f}')
    yr = []
    for y, q in b.groupby('year'):
        tq = pd.qcut(q.D, 3, labels=['low', 'mid', 'high'])
        gq = q.groupby(tq, observed=True).agg(n=('D', 'size'), D=('D', 'mean'), sd=('pnl', 'std'), ev=('pnl', 'mean'), u=('u', 'mean'))
        base, rule = q.pnl.values, (q.x * q.pnl).values
        yr.append(dict(year=y, n=len(q), G1=gq.loc['high', 'sd'] / gq.loc['low', 'sd'], G2=spearmanr(q.u, q.D)[0],
                       cvD=q.D.std() / q.D.mean(), ev=q.pnl.mean(), sh_base=sharpe(base), sh_rule=sharpe(rule),
                       u_low=gq.loc['low', 'u'], u_mid=gq.loc['mid', 'u'], u_high=gq.loc['high', 'u'],
                       ev_low=gq.loc['low', 'ev'], ev_mid=gq.loc['mid', 'ev'], ev_high=gq.loc['high', 'ev']))
    yr = pd.DataFrame(yr); yr['sh_ratio'] = yr.sh_rule / yr.sh_base
    P(yr.round(4).to_string()); yr.to_csv(f'{OUT}/by_year.csv', index=False)
    base, rule = b.pnl.values, (b.x * b.pnl).values
    P(f'V1 sharpe base {sharpe(base):.4f} rule {sharpe(rule):.4f} ratio {sharpe(rule) / sharpe(base):.3f}')
    b05, r05 = b.pnl05.values, (b.x * b.pnl05).values
    P(f'V1 k0.5 sharpe base {sharpe(b05):.4f} rule {sharpe(r05):.4f}; maxdd base {maxdd(base):.0f} rule(eq risk) {maxdd(rule):.0f}')
    P(f'year counts by width:\n{pd.crosstab(b.year, b.width).to_string()}')

    # Confound analysis: year, year x width, width floor
    rng = np.random.default_rng(20261101)
    yrs, ywd = b.year.values, (b.year.astype(str) + '_' + b.width.astype(str)).values
    stats = {}
    stats['pooled_spearman'] = rho
    stats['partial_year'] = partial_rank(b.u.values, b.D.values, yrs)
    stats['within_year_rank'] = within_rank_spearman(b.u.values, b.D.values, yrs)
    stats['nweighted_year_rho'] = float(np.average(yr.G2, weights=yr.n))
    stats['partial_width'] = partial_rank(b.u.values, b.D.values, b.width.values)
    stats['partial_year_width'] = partial_rank(b.u.values, b.D.values, ywd)
    sub = b[(b.wI >= 1.5) & (b.wI <= 2.5)]
    stats['wI_1.5_2.5_n'] = len(sub)
    stats['wI_1.5_2.5_spearman'] = spearmanr(sub.u, sub.D)[0]
    stats['wI_1.5_2.5_partial_year'] = partial_rank(sub.u.values, sub.D.values, sub.year.values)
    stats['spearman_u_implied'] = spearmanr(b.u, b.implied)[0]
    stats['partial_year_u_implied'] = partial_rank(b.u.values, b.implied.values, yrs)
    # drop top 5 u days
    keep = b.drop(b.u.nlargest(5).index)
    stats['partial_year_drop_best5'] = partial_rank(keep.u.values, keep.D.values, keep.year.values)
    # bootstrap (days) + within-stratum permutation for the main partials
    for name, grp in [('partial_year', yrs), ('partial_year_width', ywd)]:
        bs = []
        n = len(b)
        for _ in range(2000):
            i = rng.integers(0, n, n)
            bs.append(partial_rank(b.u.values[i], b.D.values[i], grp[i]))
        lo, hi = np.percentile(bs, [2.5, 97.5])
        obs = stats[name]
        perm = []
        Dv = b.D.values.copy()
        for _ in range(1000):
            Dp = Dv.copy()
            for gv in np.unique(grp):
                m = grp == gv
                Dp[m] = rng.permutation(Dv[m])
            perm.append(partial_rank(b.u.values, Dp, grp))
        perm = np.array(perm)
        stats[name + '_lo'], stats[name + '_hi'] = lo, hi
        stats[name + '_perm_p_two'] = float(np.mean(np.abs(perm) >= abs(obs)))
        stats[name + '_perm_p_gt005'] = float(np.mean(np.array(bs) > 0.05))   # bootstrap share above gate
    # pooled spearman bootstrap
    bs = []
    for _ in range(2000):
        i = rng.integers(0, len(b), len(b))
        bs.append(spearmanr(b.u.values[i], b.D.values[i])[0])
    stats['pooled_lo'], stats['pooled_hi'] = np.percentile(bs, [2.5, 97.5])
    # built-in ratio bias: if payoff independent of D, spearman(pay/D - 1, D)
    pb = []
    for _ in range(1000):
        pb.append(partial_rank(rng.permutation(b.pay.values) / b.D.values, b.D.values, yrs))
    stats['null_ratio_bias_partial_year_mean'] = float(np.mean(pb))
    for k_, v in stats.items():
        P(f'{k_:40s} {v:+.4f}' if isinstance(v, float) else f'{k_:40s} {v}')
    pd.Series(stats).to_csv(f'{OUT}/confound.csv')
    # within-year terciles of D, pooled across years
    b['tY'] = b.groupby('year').D.transform(lambda s: pd.qcut(s, 3, labels=False))
    ty = b.groupby('tY').agg(n=('D', 'size'), D=('D', 'mean'), ev=('pnl', 'mean'), u=('u', 'mean'), win=('pnl', lambda s: (s > 0).mean()))
    ty['u_se'] = b.groupby('tY').u.std() / np.sqrt(ty.n)
    P('within-year terciles pooled\n' + ty.round(4).to_string()); ty.to_csv(f'{OUT}/terciles_within_year.csv')
    # unit return by width x year (where the pooled G2 comes from)
    wy = b.groupby(['width', 'year']).agg(n=('u', 'size'), u=('u', 'mean'), ev=('pnl', 'mean'), wI=('wI', 'mean')).unstack('year')
    wa = b.groupby('width').agg(n=('u', 'size'), u=('u', 'mean'), u_se=('u', lambda s: s.std() / np.sqrt(len(s))), wI=('wI', 'mean'))
    P('unit return by width\n' + wa.round(4).to_string()); P('by width x year\n' + wy.round(3).to_string())
    wa.to_csv(f'{OUT}/by_width.csv'); wy.to_csv(f'{OUT}/by_width_year.csv')
    # fair ratio-bias null: payoff as a fraction of width independent of D
    nb = []
    f = (b.pay / (b.width * 100)).values
    for _ in range(1000):
        nb.append(spearmanr(rng.permutation(f) * b.width.values * 100 / b.D.values - 1, b.D.values)[0])
    P(f'null (pay/width shuffled) pooled spearman mean {np.mean(nb):+.4f} [{np.percentile(nb, 2.5):+.4f}, {np.percentile(nb, 97.5):+.4f}]')
    open(f'{OUT}/log.txt', 'w').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
