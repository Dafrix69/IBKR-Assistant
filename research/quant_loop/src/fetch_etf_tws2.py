"""Batch 2 (K-open basket names missing from batch 1): TMF QLD BULZ FNGU BITU + TLT. Otherwise identical to fetch_etf_tws.py.
Output ~/Data/tws_etf/<SYM>/<EXCH>_<WHAT>/<YYYYMM-end>.parquet (raw, never in the repo).
SMART with useRTH=0 covers 04:00-20:00 ET; OVERNIGHT covers 20:00-03:50 ET (history from 2023-07).
One request = 1 month of 5-min bars, ~11 s apart (IB pacing). Resumable. No orders, readonly=True.
    research/spx_fly/.venv/bin/python fetch_etf_tws.py
"""
import os, sys, time, datetime as dt
import pandas as pd
from ib_async import IB, Stock
OUT=os.path.expanduser('~/Data/tws_etf')
ETF=['TMF','QLD','BULZ','FNGU','BITU']
UND=['TLT']
START=dt.date(2023,7,1)
JOBS=[(s,'SMART','TRADES') for s in ETF]+[(s,'OVERNIGHT','TRADES') for s in ETF]+\
     [(s,'SMART','TRADES') for s in UND]+[(s,'OVERNIGHT','TRADES') for s in UND]+\
     [(s,'SMART','BID_ASK') for s in ETF]+[(s,'OVERNIGHT','BID_ASK') for s in ETF]
def month_ends():
    d=dt.date.today().replace(day=1)+dt.timedelta(days=32); d=d.replace(day=1)
    while d>START:
        yield d; d=(d-dt.timedelta(days=1)).replace(day=1)
ib=IB(); ib.connect('127.0.0.1',7496,clientId=9727,readonly=True,timeout=20)
try:
    for sym,exch,what in JOBS:
        c=Stock(sym,exch,'USD')
        if not ib.qualifyContracts(c): print(sym,exch,'not qualified',flush=True); continue
        try: head=pd.Timestamp(ib.reqHeadTimeStamp(c,whatToShow='TRADES',useRTH=False,formatDate=2)).date()
        except Exception: head=START
        d=os.path.join(OUT,sym,f'{exch}_{what}'); os.makedirs(d,exist_ok=True)
        for me in month_ends():
            if me<=head: break
            p=os.path.join(d,me.strftime('%Y%m%d')+'.parquet')
            if os.path.exists(p) and me<dt.date.today(): continue
            end=dt.datetime.combine(me,dt.time(0,0),dt.timezone.utc).strftime('%Y%m%d-%H:%M:%S')
            if me>dt.date.today(): end=''
            for attempt in range(3):
                b=ib.reqHistoricalData(c,endDateTime=end,durationStr='1 M',barSizeSetting='5 mins',whatToShow=what,useRTH=False,formatDate=2,timeout=120)
                if b: break
                time.sleep(11)
            df=pd.DataFrame([dict(ts=x.date,open=x.open,high=x.high,low=x.low,close=x.close,volume=x.volume,wap=x.average,count=x.barCount) for x in b])
            df.to_parquet(p+'.part',index=False); os.replace(p+'.part',p)
            print(time.strftime('%H:%M:%S'),sym,exch,what,me,len(df),flush=True)
            time.sleep(11)
finally:
    ib.disconnect()
print('ALL DONE',flush=True)
