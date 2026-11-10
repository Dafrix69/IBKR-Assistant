"""Read-only TWS pull for the E-ext study (quant_loop round 25): 5-min TRADES and BID_ASK bars incl. pre/post market
(SMART, useRTH=0, 04:00-20:00 ET) for every name of the 7 ex-ante pools over its pool year.
Output ~/Data/tws_ext/<SYM>/SMART_<WHAT>/<chunk-end YYYYMMDD>.parquet; failures -> ~/Data/tws_ext/unavailable.csv.
6-month requests, ~12 s apart. Resumable. readonly=True, no orders.
"""
import os, time, datetime as dt
import pandas as pd
from ib_async import IB, Stock
OUT=os.path.expanduser('~/Data/tws_ext')
U=os.path.expanduser('~/Developer/ibkr/work/datrix-qt/research/call_spread_edge/universe')
POOLS=[('20181031','UNIVERSE_20181031.txt'),('20191031','UNIVERSE_20191031.txt'),('20201030','UNIVERSE_20201030.txt'),
       ('20211029','UNIVERSE_20211029.txt'),('20221031','UNIVERSE_20221031.txt'),('20231031','UNIVERSE_20231031.txt'),('20241031','UNIVERSE.txt')]
ENDS=[p[0] for p in POOLS[1:]]+['20261107']
ALIAS={'SQ':'XYZ','OSTK':'BYON'}
spans={}
for (d,f),e in zip(POOLS,ENDS):
    for s in open(os.path.join(U,f)).read().replace('\n',',').split(','):
        s=s.strip()
        if s: spans.setdefault(s,[]).append((dt.date.fromisoformat(f'{d[:4]}-{d[4:6]}-{d[6:]}')-dt.timedelta(days=5),dt.date.fromisoformat(f'{e[:4]}-{e[4:6]}-{e[6:]}')))
os.makedirs(OUT,exist_ok=True)
bad=[]
ib=IB(); ib.connect('127.0.0.1',7496,clientId=9729,readonly=True,timeout=20)
try:
  for what in ['TRADES','BID_ASK']:
    for sym,sp in sorted(spans.items()):
        tws=ALIAS.get(sym,sym); c=Stock(tws,'SMART','USD')
        q=ib.qualifyContracts(c)
        if not q or q[0] is None:
            if what=='TRADES': bad.append(dict(sym=sym,tws=tws,why='not qualified')); print('UNAVAILABLE',sym,flush=True)
            continue
        d=os.path.join(OUT,sym,f'SMART_{what}'); os.makedirs(d,exist_ok=True)
        for a,b in sp:
            end=b
            while end>a:
                p=os.path.join(d,end.strftime('%Y%m%d')+'.parquet')
                if not os.path.exists(p):
                    e=dt.datetime.combine(end,dt.time(0,0),dt.timezone.utc).strftime('%Y%m%d-%H:%M:%S')
                    for attempt in range(3):
                        bars=ib.reqHistoricalData(c,endDateTime=e,durationStr='6 M',barSizeSetting='5 mins',whatToShow=what,useRTH=False,formatDate=2,timeout=240)
                        if bars: break
                        time.sleep(12)
                    df=pd.DataFrame([dict(ts=x.date,open=x.open,high=x.high,low=x.low,close=x.close,volume=x.volume,count=x.barCount) for x in bars])
                    df.to_parquet(p+'.part',index=False); os.replace(p+'.part',p)
                    print(time.strftime('%H:%M:%S'),sym,what,end,len(df),flush=True)
                    time.sleep(12)
                end=end-dt.timedelta(days=175)
finally:
    ib.disconnect()
    pd.DataFrame(bad).to_csv(os.path.join(OUT,'unavailable.csv'),index=False)
print('ALL DONE',flush=True)
