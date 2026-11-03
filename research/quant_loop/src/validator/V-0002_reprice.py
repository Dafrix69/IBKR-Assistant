"""V-0002: independent training-period audit of P-0002 (withdrawn at gate I1).
Written from the data dictionary (research/spx_fly/reports/mining/BRIEF.md); imports nothing from src/proposer.
Reproduces: 14:00 base anchor, R80/M50, trigger rate, I1 (trigger - control fwd 15m d ln(A/sqrt(tau))), I2,
paired D (rule - base) overall and by year. Extra: day-clustered bootstrap CI on I1, minute-stratified I1,
alternative control 'quiet but not rich'. TRAINING PERIOD ONLY; nothing >= 2024-11-01 is read past the filter.
Run: research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0002_reprice.py"""
import os, math
import numpy as np, pandas as pd, yaml
from concurrent.futures import ProcessPoolExecutor

SPX = '/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'V-0002_tables')
CUT = pd.Timestamp('2024-11-01')

CAL = pd.read_parquet(f'{SPX}/data/clean/calendar.parquet')
CAL = CAL.loc[CAL.index < CUT]                                   # time wall, first step
SPOT = pd.read_parquet(f'{SPX}/data/clean/spot.parquet')
SPOT = SPOT.loc[SPOT.ts < CUT]                                   # time wall, first step
CFG = yaml.safe_load(open(f'{SPX}/config.yaml'))['fills']
DAYS = CAL.index[(~CAL.half_day) & CAL.has_0dte]
WING = (20, 25, 30, 50, 75)


def _tier(px, tiers):
    return next((t['fee'] for t in tiers if px < t['below']), tiers[-1]['fee'])


def fee(px, n):
    return (max(_tier(px, CFG['commission']) * n, CFG['commission_min_per_leg'])
            + n * (_tier(px, CFG['exchange']) + CFG['execution_surcharge'] + CFG['regulatory_clearing']))


def day(d):
    path = f'{SPX}/data/clean/chain_{d:%Y%m%d}.parquet'
    if not os.path.exists(path):
        return None
    c = pd.read_parquet(path)
    c = c.loc[(c.ts < CUT) & (~c.flag_bad)]
    t0 = d + pd.Timedelta('13:15:00'); t1 = d + pd.Timedelta('14:15:00')
    c = c.loc[(c.ts >= t0) & (c.ts <= t1)]
    sp = SPOT.loc[(SPOT.ts >= d + pd.Timedelta('13:00:00')) & (SPOT.ts <= t1)].set_index('ts').spot
    close16 = d + pd.Timedelta('16:00:00')
    settle = float(CAL.at[d, 'settle'])
    # per-minute wide tables of mid / bid / ask indexed by strike
    piv = {}
    for ts, g in c.groupby('ts'):
        piv[ts] = {r: g.loc[g.right == r].set_index('strike')[['bid', 'ask', 'mid']] for r in ('C', 'P')}
    norm, strad = {}, {}
    for ts, q in piv.items():
        if ts not in sp.index:
            continue
        s = sp[ts]
        both = q['C'].index.intersection(q['P'].index)
        if len(both) == 0:
            continue
        st = (q['C'].loc[both, 'mid'] + q['P'].loc[both, 'mid']).sort_index()
        below, above = st.index[st.index <= s], st.index[st.index >= s]
        # require the bracketing strikes of the full strike grid (5-pt) to both have C and P
        k1, k2 = math.floor(s / 5) * 5, math.ceil(s / 5) * 5
        if k1 not in st.index or k2 not in st.index:
            continue
        a = st[k1] if k1 == k2 else st[k1] + (st[k2] - st[k1]) * (s - k1) / (k2 - k1)
        if a > 0:
            strad[ts] = a
            norm[ts] = a / math.sqrt((close16 - ts).total_seconds() / 60)

    def fly(ts):
        if ts not in piv or ts not in sp.index:
            return None
        q = piv[ts]; s = sp[ts]
        ks = q['P'].index.union(q['C'].index).values
        kc = float(ks[np.argmin(np.abs(ks - s))])
        if kc not in q['C'].index or kc not in q['P'].index:
            return None
        imp = q['C'].at[kc, 'mid'] + q['P'].at[kc, 'mid']
        w = min(WING, key=lambda x: abs(x / imp - 2))
        P = q['P']
        if not all(k in P.index for k in (kc - w, kc, kc + w)):
            return None
        legs = [(kc - w, 1), (kc, -2), (kc + w, 1)]
        mid = sum(n * P.at[k, 'mid'] for k, n in legs)
        if mid <= 0:
            return None
        half = sum(abs(n) * (P.at[k, 'ask'] - P.at[k, 'bid']) / 2 for k, n in legs)
        fees = sum(fee(P.at[k, 'mid'], abs(n)) for k, n in legs)
        pay = max(0.0, w - abs(settle - kc))
        return dict(pnl=(pay - mid - 0.20 * half) * 100 - fees, pnl05=(pay - mid - 0.50 * half) * 100 - fees, w=w)

    rows = []
    for i in range(30):
        t = d + pd.Timedelta(hours=13, minutes=30 + i)
        tb, tf = t - pd.Timedelta(minutes=15), t + pd.Timedelta(minutes=15)
        if t not in norm or tb not in norm:
            continue
        back = sp.loc[tb:t]; fwd = sp.loc[t:tf]
        rows.append(dict(date=d, i=i, R=math.log(norm[t] / norm[tb]), M=(back.max() - back.min()) / strad[t],
                         fdn=math.log(norm[tf] / norm[t]) if tf in norm else np.nan,
                         frg=(fwd.max() - fwd.min()) / strad[t] if len(fwd) >= 8 else np.nan))
    flies = {}
    for e in range(1, 31):
        r = fly(d + pd.Timedelta(hours=13, minutes=30 + e))
        if r:
            flies[e] = r
    return rows, flies


def boot_ci(f, groups, n=1000, seed=7):
    rg = np.random.default_rng(seed); keys = list(groups)
    v = [f(pd.concat([groups[k] for k in rg.choice(keys, len(keys))])) for _ in range(n)]
    return np.nanpercentile(v, [2.5, 97.5])


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    with ProcessPoolExecutor(6) as ex:
        res = dict(zip(DAYS, ex.map(day, list(DAYS), chunksize=8)))
    res = {d: r for d, r in res.items() if r is not None}
    base_days = [d for d in res if not (CAL.at[d, 'spx_ret_prev'] <= -0.01)]
    # anchor: 14:00 base
    b = pd.Series({d: res[d][1][30]['pnl'] for d in base_days if 30 in res[d][1]})
    print(f'anchor 14:00 base: n={len(b)} win={100*(b>0).mean():.1f}% ev={b.mean():+.1f}')
    m = pd.DataFrame([r for d in base_days for r in res[d][0]])
    R80, M50 = m.R.quantile(0.8), m.M.quantile(0.5)
    mall = pd.DataFrame([r for d in res for r in res[d][0]])
    print(f'R80={R80:.4f} M50={M50:.3f} cand={len(m)} days={m.date.nunique()} | all-days thresholds R80={mall.R.quantile(.8):.4f} M50={mall.M.quantile(.5):.3f}')
    m['trig'] = (m.R >= R80) & (m.M <= M50)
    m['ctrl'] = (m.R >= R80) & (m.M > M50)
    m['qnr'] = (m.R < R80) & (m.M <= M50)
    m['yr'] = m.date.dt.year

    def i1(z, c='ctrl'):
        return z.loc[z.trig, 'fdn'].mean() - z.loc[z[c], 'fdn'].mean()

    def i1_strat(z, c='ctrl'):
        g = z.groupby('i')
        dt = g.apply(lambda x: x.loc[x.trig, 'fdn'].mean() - x.loc[x[c], 'fdn'].mean(), include_groups=False)
        w = z.loc[z.trig].groupby('i').size()
        dt = dt.reindex(w.index); ok = dt.notna()
        return (dt[ok] * w[ok]).sum() / w[ok].sum()

    G = {d: g for d, g in m.groupby('date')}
    out = {}
    out['trigger_day_rate'] = m.groupby('date').trig.any().mean()
    out['n_trig_min'], out['n_ctrl_min'], out['n_qnr_min'] = m.trig.sum(), m.ctrl.sum(), m.qnr.sum()
    out['fdn_trig'], out['fdn_ctrl'], out['fdn_qnr'], out['fdn_all'] = (m.loc[m.trig, 'fdn'].mean(), m.loc[m.ctrl, 'fdn'].mean(),
                                                                     m.loc[m.qnr, 'fdn'].mean(), m.fdn.mean())
    out['I1'] = i1(m); out['I1_lo'], out['I1_hi'] = boot_ci(i1, G)
    out['I1_strat'] = i1_strat(m); out['I1_strat_lo'], out['I1_strat_hi'] = boot_ci(i1_strat, G, n=300)
    out['I1_qnr'] = i1(m, 'qnr'); out['I1_qnr_lo'], out['I1_qnr_hi'] = boot_ci(lambda z: i1(z, 'qnr'), G)
    out['I1_qnr_strat'] = i1_strat(m, 'qnr')
    out['I1_vs_all'] = m.loc[m.trig, 'fdn'].mean() - m.fdn.mean()
    out['I2'] = m.loc[m.trig, 'frg'].mean() / m.frg.mean()
    for y, z in m.groupby('yr'):
        out[f'I1_{y}'] = i1(z); out[f'I1_strat_{y}'] = i1_strat(z); out[f'I1_qnr_{y}'] = i1(z, 'qnr')
        out[f'rate_{y}'] = z.groupby('date').trig.any().mean()
    o = pd.Series(out); print(o.to_string()); o.to_csv(f'{OUT}/gates.csv')
    # paired D
    rows = []
    for d, g in m.groupby('date'):
        fl = res[d][1]
        if 30 not in fl:
            continue
        hit = g.loc[g.trig, 'i'].sort_values()
        e = int(hit.iloc[0]) + 1 if len(hit) else 30
        r = fl.get(e, fl[30])
        rows.append(dict(date=d, trig=len(hit) > 0, e=e, base=fl[30]['pnl'], rule=r['pnl'],
                         D=r['pnl'] - fl[30]['pnl'], D05=r['pnl05'] - fl[30]['pnl05']))
    p = pd.DataFrame(rows); p['yr'] = p.date.dt.year
    p.to_csv(f'{OUT}/paired_days.csv', index=False)
    rg = np.random.default_rng(11)

    def summ(z):
        x = z.D.values; bs = x[rg.integers(0, len(x), (5000, len(x)))].mean(1)
        return pd.Series(dict(days=len(z), trig_days=int(z.trig.sum()), base_win=(z.base > 0).mean(), rule_win=(z.rule > 0).mean(),
                              base_ev=z.base.mean(), rule_ev=z.rule.mean(), D=x.mean(), D_lo=np.percentile(bs, 2.5),
                              D_hi=np.percentile(bs, 97.5), D_trig=z.loc[z.trig, 'D'].mean(), D05=z.D05.mean()))
    s = pd.concat([summ(p).rename('all')] + [summ(z).rename(y) for y, z in p.groupby('yr')], axis=1).T
    print(s.round(3).to_string()); s.to_csv(f'{OUT}/paired_summary.csv')
