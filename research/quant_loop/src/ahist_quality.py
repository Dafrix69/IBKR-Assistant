# A-hist usability: per day at 14:00 -> spot, #strikes within +-50 with 2-sided quotes, ATM straddle half-spread.
# NO P&L, NO settle values are read (greeks_eod only checked for presence of underlying_price>0).
import pandas as pd, numpy as np, glob, os
R=os.path.expanduser('~/Data/thetadata/SPXW')
days=sorted(os.path.basename(p)[:8] for p in glob.glob(f'{R}/quote_1m_dte0/202[01]/*.csv.gz')+glob.glob(f'{R}/quote_1m_dte0/2022/2022[01]*.csv.gz')+glob.glob(f'{R}/quote_1m_dte0/2022/20220[1-4]*.csv.gz'))
days=sorted(set(d for d in days if d<'20220502'))
# reference sample from already-seen era
ref=['20240603','20240605','20240607','20240610','20240612','20240614','20250303','20250305','20250307']
rows=[]
for d in days+ref:
    try:
        q=pd.read_csv(f'{R}/quote_1m_dte0/{d[:4]}/{d}.csv.gz',usecols=['strike','right','timestamp','bid','ask'])
        u=pd.read_csv(f'{R}/underlying_1m/{d[:4]}/{d}.csv.gz',usecols=['timestamp','underlying_price'])
    except Exception as e:
        rows.append(dict(day=d,err=str(e)[:60])); continue
    t=f'{d[:4]}-{d[4:6]}-{d[6:]}T14:00:00.000'
    s=u.loc[(u.timestamp==t)&(u.underlying_price>0),'underlying_price']
    s=s.iloc[0] if len(s) else np.nan
    x=q[q.timestamp==t]
    ok=x[(x.bid>0)&(x.ask>x.bid)]
    near=ok[(ok.strike-s).abs()<=50] if s==s else ok.iloc[:0]
    atmk=near.loc[(near.strike-s).abs().idxmin(),'strike'] if len(near) else np.nan
    a=near[near.strike==atmk]
    hs=((a.ask-a.bid)/2).sum() if len(a)==2 else np.nan
    mid=((a.ask+a.bid)/2).sum() if len(a)==2 else np.nan
    g=f'{R}/greeks_eod/{d[:4]}/{d}.csv.gz'
    rows.append(dict(day=d,spot=s,n14=len(x),nnear=near.strike.nunique(),step=np.median(np.diff(np.sort(near.strike.unique()))) if near.strike.nunique()>2 else np.nan,
                     strad_halfspr=hs,strad_mid=mid,eod=os.path.exists(g)))
df=pd.DataFrame(rows); df['era']=np.where(df.day.isin(ref),'ref2024-25',df.day.str[:4])
df['hs_pct']=df.strad_halfspr/df.strad_mid
df['dow']=pd.to_datetime(df.day).dt.day_name().str[:3]
print(df.groupby('era').agg(days=('day','size'),no_spot=('spot',lambda v:v.isna().sum()),no_atm=('strad_halfspr',lambda v:v.isna().sum()),
      nnear_med=('nnear','median'),step_med=('step','median'),halfspr_pts=('strad_halfspr','median'),halfspr_pct=('hs_pct','median'),eod=('eod','sum')).to_string())
h=df[~df.day.isin(ref)]
print(h.dow.value_counts().to_string())
print('missing 14:00 / no ATM:',h[h.strad_halfspr.isna()].day.tolist())
print('err:',df[df.get('err').notna()].day.tolist() if 'err' in df else [])
h.to_csv('/private/tmp/claude-501/-Users-dafrix-Developer-ibkr/131b9ce7-b3d3-4034-9ade-446408eb8392/scratchpad/ahist_quality.csv',index=False)
