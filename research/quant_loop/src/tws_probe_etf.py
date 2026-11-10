"""Read-only probe: does TWS serve 5-min TRADES / BID_ASK history for leveraged ETFs on SMART (useRTH=0) and OVERNIGHT, and how far back?
Prints only bar counts and first/last timestamps (no returns)."""
import sys, datetime as dt
from ib_async import IB, Stock
ib=IB(); ib.connect('127.0.0.1',7496,clientId=9725,readonly=True,timeout=20)
sym=sys.argv[1] if len(sys.argv)>1 else 'TSLL'
for exch in ['SMART','OVERNIGHT']:
    c=Stock(sym,exch,'USD'); q=ib.qualifyContracts(c)
    print(exch,'qualified' if q else 'NOT qualified', c.conId, c.primaryExchange)
    if not q: continue
    try:
        h=ib.reqHeadTimeStamp(c,whatToShow='TRADES',useRTH=False,formatDate=2); print(' head TRADES',h)
    except Exception as e: print(' head err',e)
    for what in ['TRADES','BID_ASK']:
        for end in ['', '20250115-00:00:00','20240115-00:00:00','20230615-00:00:00']:
            b=ib.reqHistoricalData(c,endDateTime=end,durationStr='1 M',barSizeSetting='5 mins',whatToShow=what,useRTH=False,formatDate=2,timeout=90)
            print(f' {what:8s} end={end or "now":18s} n={len(b)}', (b[0].date, b[-1].date) if b else '')
            ib.sleep(11)
ib.disconnect()
