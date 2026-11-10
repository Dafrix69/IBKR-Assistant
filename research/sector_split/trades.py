"""The user's own stock round trips: was the P&L in the stock-specific part or in the module part?

    ../spx_fly/.venv/bin/python trades.py prep     # my_trades/trips.csv, my_trades/need.csv
    ../spx_fly/.venv/bin/python trades.py fetch    # 5-min bars of the peers from TWS (read-only)
    ../spx_fly/.venv/bin/python trades.py calc > my_trades/result.txt

Input my_trades/stk_trades.json = stock fills from the IBKR connector (no account id inside).
Everything under my_trades/ is git-ignored (personal trading records, public repo).

Method (fixed before the peer prices were fetched):
  * round trips by FIFO per symbol from flat; fills of one entry-minute / exit-minute are merged.
    ETFs that are not a view on one stock are left out (LEFT_OUT). A single-stock leveraged ETF is
    kept, its peers are those of the underlying and the peer return is multiplied by the leverage.
  * module of a name = the 4 COMMON stocks (close >= $5, dv20 >= $30M) with the highest
    correlation of daily returns to it over the 60 trading days ending the day before entry
    (daily bars end 2026-10-30; later entries use that last day). IBKR's own category is not
    used here: it files IREN under "Investment Companies" and BE under construction machinery.
  * peer price at a fill time = close of the last 5-min bar (04:00-20:00 ET, TWS TRADES) that
    ENDED at or before the fill; fills in the overnight session therefore see the 20:00 price.
  * A = dir * (exit/entry - 1) from the real fills, commissions ignored.
    S = dir * lever * mean(peer exit/entry - 1).  B = (A + 4 S) / 5.  X = A - S.
  * t over entry dates (trips of one date averaged first); 95 % CI by bootstrap over dates.
"""
import datetime as dt
import json
import os
import sys
import time
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

import backtest as b

ROOT = os.path.dirname(os.path.abspath(__file__))
MY = os.path.join(ROOT, "my_trades")
BARS = os.path.join(MY, "bars")
ET = ZoneInfo("America/New_York")
LEFT_OUT = {"DRAM", "MSTY", "GLD"}
LEVERED = {"AXTX": ("AXTI", 2.0)}
SAME_COMPANY = {"GOOG": {"GOOGL"}}  # another share class of the same company is not a peer
NPEER, LOOK = 4, 60


def trips():
    f = pd.read_json(os.path.join(MY, "stk_trades.json"))
    f["ts"] = pd.to_datetime(f.trade_time, utc=True)
    f = f.sort_values("ts", kind="stable")
    rows = []
    for sym, g in f.groupby("symbol"):
        book = []  # open lots: [signed qty, price, ts]
        for r in g.itertuples():
            q = r.size if r.side == "BUY" else -r.size
            while q and book and np.sign(book[0][0]) != np.sign(q):
                lot = book[0]
                m = min(abs(q), abs(lot[0]))
                rows.append((sym, int(np.sign(lot[0])), m, lot[1], lot[2], r.price, r.ts))
                lot[0] -= np.sign(lot[0]) * m
                q -= np.sign(q) * m
                if lot[0] == 0:
                    book.pop(0)
            if q:
                book.append([q, r.price, r.ts])
    t = pd.DataFrame(rows, columns=["sym", "dir", "qty", "p_in", "t_in", "p_out", "t_out"])
    t["k_in"], t["k_out"] = t.t_in.dt.floor("min"), t.t_out.dt.floor("min")
    t["n_in"], t["n_out"] = t.qty * t.p_in, t.qty * t.p_out
    a = t.groupby(["sym", "dir", "k_in", "k_out"], as_index=False).agg(qty=("qty", "sum"), n_in=("n_in", "sum"), n_out=("n_out", "sum"),
                                                                     t_in=("t_in", "min"), t_out=("t_out", "max"))
    a["p_in"], a["p_out"] = a.n_in / a.qty, a.n_out / a.qty
    return a.drop(columns=["k_in", "k_out", "n_out"]).rename(columns={"n_in": "notional"}).sort_values("t_in").reset_index(drop=True)


def prep():
    t = trips()
    print(f"round trips {len(t)}; left out (ETF, not a one-stock view): {sorted(set(t.sym) & LEFT_OUT)}"
          f" = {t.sym.isin(LEFT_OUT).sum()} trips")
    t = t[~t.sym.isin(LEFT_OUT)].copy()
    px, ret, dv20, elig, cat, _ = b.load()
    types = pd.read_csv(os.path.join(b.U, "types.csv"))
    common = [s for s in types[types.type == "COMMON"].symbol if s in px.columns]
    extra = {}
    for s in set(t.sym.map(lambda x: LEVERED.get(x, (x, 1))[0])) - set(px.columns):
        f = os.path.join(b.U, "eod", s + ".csv")
        if os.path.exists(f):
            d = pd.read_csv(f, usecols=["created", "close"])
            d["date"] = pd.to_datetime(d.created.str[:10])
            c = d.drop_duplicates("date").set_index("date").close.reindex(px.index)
            extra[s] = c / c.shift(1) - 1
    peers, lev, miss = [], [], []
    for r in t.itertuples():
        base, lv = LEVERED.get(r.sym, (r.sym, 1.0))
        D = pd.Timestamp(r.t_in.tz_convert(ET).date())
        i = min(px.index.searchsorted(D), len(px.index)) - 1  # last daily bar strictly before the entry date
        own = ret[base] if base in ret.columns else extra.get(base)
        if own is None:
            peers.append(""); lev.append(lv); miss.append(r.sym)
            continue
        win = slice(i - LOOK + 1, i + 1)
        ok = [s for s in common if s != base and s not in SAME_COMPANY.get(base, ()) and elig[s].iloc[i]]
        c = ret[ok].iloc[win].corrwith(own.iloc[win])
        n = ret[ok].iloc[win].notna().sum()
        c = c[n >= 40].nlargest(NPEER)
        peers.append(" ".join(c.index)); lev.append(lv)
    t["peers"], t["lever"] = peers, lev
    if miss:
        print("no daily bars, dropped:", sorted(set(miss)))
    t = t[t.peers != ""]
    t.to_csv(os.path.join(MY, "trips.csv"), index=False)
    need = set()
    for r in t.itertuples():
        for p in r.peers.split():
            need.add((p, r.t_in.floor("5min").isoformat()))
            need.add((p, r.t_out.floor("5min").isoformat()))
    pd.DataFrame(sorted(need), columns=["sym", "ts"]).to_csv(os.path.join(MY, "need.csv"), index=False)
    print(f"trips kept {len(t)}, symbols {t.sym.nunique()}, peer price points needed {len(need)}")
    print(t.assign(t_in=t.t_in.dt.tz_convert(ET).dt.strftime("%m-%d %H:%M"), t_out=t.t_out.dt.tz_convert(ET).dt.strftime("%m-%d %H:%M"))
          [["sym", "dir", "qty", "t_in", "t_out", "p_in", "p_out", "peers"]].to_string())


def fetch():
    from ib_async import IB, Stock
    os.makedirs(BARS, exist_ok=True)
    need = pd.read_csv(os.path.join(MY, "need.csv"))
    ib = IB()
    ib.connect("127.0.0.1", 7496, clientId=9741, readonly=True, timeout=15)
    con = {}
    for k, r in enumerate(need.itertuples()):
        out = os.path.join(BARS, f"{r.sym}_{r.ts.replace(':', '').replace('+', 'Z')}.json")
        if os.path.exists(out):
            continue
        if r.sym not in con:
            c = Stock(r.sym, "SMART", "USD")
            q = ib.qualifyContracts(c)
            con[r.sym] = q[0] if q and q[0] else None
        if con[r.sym] is None:
            print("no contract", r.sym, flush=True)
            continue
        end = pd.Timestamp(r.ts).tz_convert("UTC")
        for attempt in range(3):
            try:
                bars = ib.reqHistoricalData(con[r.sym], endDateTime=end.strftime("%Y%m%d-%H:%M:%S"), durationStr="2 D",
                                            barSizeSetting="5 mins", whatToShow="TRADES", useRTH=False, formatDate=2, timeout=60)
                break
            except Exception as e:  # noqa: BLE001
                print("retry", r.sym, r.ts, e, flush=True)
                bars = []
                time.sleep(5)
        rows = [{"ts": x.date.isoformat(), "close": x.close} for x in bars[-3:]]
        if rows:
            with open(out, "w") as f:
                json.dump(rows, f)
        print(k + 1, len(need), r.sym, r.ts, rows[-1] if rows else "EMPTY", flush=True)
        time.sleep(1.0)
    ib.disconnect()


def price(sym, ts):
    """close of the last 5-min bar that ended at or before the 5-min floor of the fill time"""
    key = ts.floor("5min")
    f = os.path.join(BARS, f"{sym}_{key.isoformat().replace(':', '').replace('+', 'Z')}.json")
    if not os.path.exists(f):
        return np.nan, None
    rows = json.load(open(f))
    ok = [x for x in rows if pd.Timestamp(x["ts"]) + pd.Timedelta(minutes=5) <= key]
    if not ok:
        return np.nan, None
    return ok[-1]["close"], (key - pd.Timestamp(ok[-1]["ts"]) - pd.Timedelta(minutes=5)).total_seconds() / 60


def stats(lab, t, col, rng):
    d = t.groupby(t.t_in.dt.tz_convert(ET).dt.date)[col].mean()
    m, sd, n = d.mean(), d.std(), len(d)
    bs = [d.sample(n, replace=True, random_state=rng).mean() for _ in range(4000)]
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f"  {lab:38s} mean {m*100:+.2f}%  [{lo*100:+.2f}, {hi*100:+.2f}]  t {m/(sd/np.sqrt(n)):+.2f}"
          f"  per-trip sd {t[col].std()*100:.2f}%  win {(t[col] > 0).mean()*100:.0f}%  median {t[col].median()*100:+.2f}%")


def calc():
    t = pd.read_csv(os.path.join(MY, "trips.csv"), parse_dates=["t_in", "t_out"])
    S, stale, npeer = [], [], []
    for r in t.itertuples():
        rs, st = [], 0.0
        for p in r.peers.split():
            a, sa = price(p, r.t_in)
            z, sz = price(p, r.t_out)
            if np.isnan(a) or np.isnan(z):
                continue
            rs.append(z / a - 1)
            st = max(st, sa, sz)
        S.append(r.dir * r.lever * np.mean(rs) if rs else np.nan)
        stale.append(st); npeer.append(len(rs))
    t["A"] = t.dir * (t.p_out / t.p_in - 1)
    t["S"], t["stale_min"], t["npeer"] = S, stale, npeer
    print(f"trips {len(t)}; with all {NPEER} peers priced {(t.npeer == NPEER).sum()}, with none {(t.npeer == 0).sum()}")
    t = t[t.npeer >= 2].copy()
    t["B"] = (t.A + NPEER * t.S) / (NPEER + 1)
    t["X"] = t.A - t.S
    t["hold_h"] = (t.t_out - t.t_in).dt.total_seconds() / 3600
    show = t.assign(t_in=t.t_in.dt.tz_convert(ET).dt.strftime("%m-%d %H:%M"))
    for c in "ASBX":
        show[c] = (show[c] * 100).round(2)
    print(show[["sym", "dir", "t_in", "hold_h", "notional", "A", "S", "B", "X", "npeer", "stale_min", "peers"]]
          .round({"hold_h": 1, "notional": 0, "stale_min": 0}).to_string())
    rng = np.random.RandomState(20261110)
    for lab, sub in (("ALL trips", t), ("peer prices fresh (stale <= 10 min)", t[t.stale_min <= 10]),
                     ("intraday (held < 8 h)", t[t.hold_h < 8]), ("overnight or longer", t[t.hold_h >= 8]),
                     ("without the leveraged ETF", t[t.lever == 1]), ("without IREN", t[t.sym != "IREN"]), ("IREN only", t[t.sym == "IREN"])):
        if len(sub) < 5:
            continue
        print(f"\n{lab}: trips {len(sub)}, entry dates {sub.t_in.dt.tz_convert(ET).dt.date.nunique()}, symbols {sub.sym.nunique()}")
        stats("A  what you did (single name)", sub, "A", rng)
        stats("S  same direction on the 4 peers", sub, "S", rng)
        stats("B  split 1/5 each (you + 4 peers)", sub, "B", rng)
        stats("X  = A - S  stock-specific part", sub, "X", rng)
        usd = lambda c: (sub[c] * sub.notional).sum()
        print(f"  dollars at your real sizes: A {usd('A'):+.0f}  S {usd('S'):+.0f}  B {usd('B'):+.0f}   worst trip A {(sub.A*sub.notional).min():+.0f}"
              f"  B {(sub.B*sub.notional).min():+.0f}   corr(A,S) {np.corrcoef(sub.A, sub.S)[0,1]:+.2f}")
    t.to_csv(os.path.join(MY, "trips_scored.csv"), index=False)


if __name__ == "__main__":
    {"prep": prep, "fetch": fetch, "calc": calc}[sys.argv[1]]()
