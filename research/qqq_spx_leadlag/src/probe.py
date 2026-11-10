"""Probe: which 1-second historical streams TWS serves, and how fast. Read-only."""
import sys, time, datetime as dt
from zoneinfo import ZoneInfo
from ib_async import IB, Stock, Future, Index
NY = ZoneInfo("America/New_York")
ib = IB(); ib.connect("127.0.0.1", 7496, clientId=9760, readonly=True, timeout=20)
cons = {"QQQ": Stock("QQQ", "SMART", "USD"), "SPY": Stock("SPY", "SMART", "USD"),
        "ES": Future("ES", "202612", "CME"), "NQ": Future("NQ", "202612", "CME"),
        "SPX": Index("SPX", "CBOE")}
for c in cons.values(): ib.qualifyContracts(c)
end = dt.datetime(2026, 11, 9, 10, 30, tzinfo=NY).astimezone(dt.timezone.utc).strftime("%Y%m%d-%H:%M:%S")
for name, what in [("QQQ","MIDPOINT"),("SPY","MIDPOINT"),("ES","MIDPOINT"),("NQ","MIDPOINT"),
                   ("SPY","BID_ASK"),("ES","BID_ASK"),("SPX","TRADES"),("QQQ","TRADES")]:
    t=time.time()
    try:
        bars = ib.reqHistoricalData(cons[name], endDateTime=end, durationStr="1800 S", barSizeSetting="1 secs",
                                    whatToShow=what, useRTH=True, formatDate=2, timeout=60)
        print(name, what, len(bars), "bars", round(time.time()-t,1), "s", bars[0] if bars else None, bars[-1] if bars else None, flush=True)
    except Exception as e:
        print(name, what, "ERR", e, flush=True)
ib.disconnect()
