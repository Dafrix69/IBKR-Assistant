import pandas as pd, numpy as np, sys
O='/Users/dafrix/Developer/ibkr/work/datrix-qt/research/call_spread_edge/out/'
pd.set_option('display.width',250); pd.set_option('display.max_rows',300)
P=["20181031","20191031","20201030","20211029","20221031","20231031","20241031"]
allj=[]
for i,p in enumerate(P):
    f=O+(f'univ_diag_trades_{p}.csv' if p!='20241031' else 'univ_diag_trades.csv')
    d=pd.read_csv(f,parse_dates=['entry','exp'],usecols=['sym','entry','bucket','exp','right','tgt','K','S0','S_T','iv','ret5','mid','hs','k','hedge','pnl_pct'])
    d=d[(d.bucket=='wk')&(d.right=='P')&(d.hedge=='daily')]
    d['tgt']=d.tgt.round(2); d=d[d.tgt.isin([-0.25,-0.1])]
    stop=pd.Timestamp(P[i+1]) if i+1<len(P) else pd.Timestamp('2100-01-01')
    d=d[(d.entry>=pd.Timestamp(p))&(d.entry<stop)&d.ret5.notna()]
    w=d.pivot_table(index=['sym','entry','tgt'],columns='k',values='pnl_pct').reset_index()
    w.columns=['sym','entry','tgt']+[f'p_k{c:g}' for c in w.columns[3:]]
    w=w.merge(d.drop_duplicates(['sym','entry','tgt'])[['sym','entry','tgt','K','S0','ret5','exp','iv','mid','S_T']],on=['sym','entry','tgt'])
    m=pd.read_parquet(f'P-0022_pools_tables/trades_{p}.parquet'); m['tgt']=m.tgt.round(2)
    j=w.merge(m,on=['sym','entry','tgt'],how='outer',suffixes=('_p','_v'),indicator=True); j['pool']=p
    b=j[j._merge=='both']; dd=(b['p_k0.5']-b['daily_k0.5']).abs()
    kdiff=(b.K_p!=b.K_v)
    print(f'== {p}: proposer {len(w)} mine {len(m)} both {len(b)} p_only {(j._merge=="left_only").sum()} v_only {(j._merge=="right_only").sum()}; K differs {kdiff.sum()}; same K pnl diff>1e-6 {((dd>1e-6)&~kdiff).sum()} (max {dd[~kdiff].max():.3g}); ret5 maxdiff {np.nanmax(np.abs(b.ret5_p-b.ret5_v)):.2g}')
    sig=lambda r: r>0.0948
    for nm,x in [('K differs',b[kdiff]),('same K pnl differs',b[(dd>1e-6)&~kdiff])]:
        if len(x): print('  ',nm); print(x[['sym','entry','tgt','K_p','K_v','S0_p','ret5_p','mid_p','mid_v','iv_p','iv_v','p_k0.5','daily_k0.5','n_carry']].to_string())
    o=j[j._merge!='both']
    if len(o): print('   one-sided:'); print(o[['sym','entry','tgt','_merge','ret5_p','ret5_v','K_p','K_v','exp_p','exp_v','p_k0.5','daily_k0.5']].to_string())
    allj.append(j)
pd.concat(allj).to_parquet('P-0022_pools_tables/diff_vs_proposer.parquet')
