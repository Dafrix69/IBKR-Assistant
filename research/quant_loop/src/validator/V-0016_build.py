"""V-0016 independent build for P-0016 (A-tape, training period only; light audit, no test period).

For every base day < 2025-11-01, every hour 11..15 and every minute m = 0..57 of that hour:
fixed iron-fly legs chosen at t0 = hh:mm (K = 5-pt strike nearest spot(t0), I = chain mid C(K)+P(K) at t0-1min,
w in {20,25,30,50,75} nearest 2*I, ties to narrower), then the sum of four half-spreads H on a 1-second grid
(asof on quote_timestamp of tape rows, staleness <= 60 s, ask > bid >= 0), window A = [t0, t0+10s) and
window B = [t0+90s, t0+120s). m = 0 is the hour cell, m = 37 is the proposer's placebo, all other m form the
validator's minute-placebo distribution. Combo prints (iron fly / 1:2:1 fly) and their effective k are
rebuilt for m = 0 and m = 37 only.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0016_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import pyarrow.csv as pacsv

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0016_tables"
WALL = pd.Timestamp("2025-11-01")       # A-tape time wall: training = date < 2025-11-01
FIRST = pd.Timestamp("2024-10-30")
MULTI = {130, 131, 134, 137, 144}
WINGS = (20, 25, 30, 50, 75)
MAXAGE = 60.0
NS = 1_000_000_000


def read_tape(path):
    t = pacsv.read_csv(path, convert_options=pacsv.ConvertOptions(
        include_columns=["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]))
    d = t.to_pandas()
    d["trade_timestamp"] = pd.to_datetime(d["trade_timestamp"])
    d = d.loc[d["trade_timestamp"] < WALL].copy()              # time wall, first step after reading
    d["quote_timestamp"] = pd.to_datetime(d["quote_timestamp"])
    d["rt"] = np.where(d["right"].str.upper().str.startswith("C"), "C", "P")
    d["ti"] = d["trade_timestamp"].values.astype("datetime64[ns]").astype(np.int64)
    d["qi"] = d["quote_timestamp"].values.astype("datetime64[ns]").astype(np.int64)
    return d


class Book:
    """Per contract: sorted unique (quote time, bid, ask) taken from every tape row of that contract."""
    def __init__(self, d):
        self.q = {}
        for (k, r), g in d.groupby(["strike", "rt"], sort=False):
            g = g[["qi", "bid", "ask"]].drop_duplicates().sort_values("qi", kind="mergesort")
            self.q[(float(k), r)] = (g.qi.values, g.bid.values.astype(float), g.ask.values.astype(float))

    def half(self, leg, pts):
        """Half-spread at each point (NaN if missing/stale/bad) and quote age in seconds."""
        if leg not in self.q:
            return np.full(len(pts), np.nan), np.full(len(pts), np.nan)
        qi, b, a = self.q[leg]
        j = np.searchsorted(qi, pts, side="right") - 1
        jj = np.clip(j, 0, None)
        age = (pts - qi[jj]) / NS
        ok = (j >= 0) & (age <= MAXAGE) & (a[jj] > b[jj]) & (b[jj] >= 0)
        return np.where(ok, (a[jj] - b[jj]) / 2, np.nan), np.where(j >= 0, age, np.nan)


def Hpath(book, legs, pts):
    hs, ages = zip(*(book.half(l, pts) for l in legs))
    H = np.sum(hs, axis=0)                                         # NaN if any leg NaN
    return H, np.nanmax(np.vstack(ages), axis=0)


def winmean(x):
    good = np.isfinite(x)
    return float(x[good].mean()) if good.sum() >= len(x) / 2 else np.nan


def flies(win, spot):
    """Combo reconstruction: aggregate same-ms same-contract rows first, then identify the shape in that ms."""
    if win.empty:
        return []
    w = win.assign(pv=win["price"] * win["size"])
    agg = w.groupby(["ti", "strike", "rt"], sort=False).agg(n=("size", "sum"), pv=("pv", "sum"),
                                                              b=("bid", "first"), a=("ask", "first")).reset_index()
    agg["px"] = agg.pv / agg.n
    res = []
    for ti, g in agg.groupby("ti", sort=False):
        if len(g) not in (3, 4):
            continue
        st = np.sort(g.strike.unique())
        if len(st) != 3 or not np.isclose(st[1] - st[0], st[2] - st[1]):
            continue
        wid = st[1] - st[0]
        L = {(float(s), r): (n, px, b, a) for s, r, n, px, b, a in zip(g.strike, g.rt, g.n, g.px, g.b, g.a)}
        if len(g) == 4:
            want = [(st[0], "P"), (st[1], "P"), (st[1], "C"), (st[2], "C")]
            if set(want) != set(L) or len({L[x][0] for x in want}) != 1:
                continue
            sgn, mult = np.array([1, -1, -1, 1]), np.array([1, 1, 1, 1])
        else:
            rights = {r for _, r in L}
            if len(rights) != 1:
                continue
            r = rights.pop()
            want = [(float(s), r) for s in st]
            n = [L[x][0] for x in want]
            if not (n[0] == n[2] and n[1] == 2 * n[0]):
                continue
            sgn, mult = np.array([1, -1, 1]), np.array([1, 2, 1])
        px = np.array([L[x][1] for x in want]); b = np.array([L[x][2] for x in want]); a = np.array([L[x][3] for x in want])
        if np.any(a <= b) or np.any(b < 0):                       # zero/crossed leg check AFTER identification
            continue
        S = spot.get(pd.Timestamp(ti).floor("min"), np.nan)
        if not (np.isfinite(S) and abs(st[1] - S) <= 5 and 15 <= wid < 80):
            continue
        mid, h = (a + b) / 2, (a - b) / 2
        res.append((ti, abs(float(np.sum(sgn * mult * (px - mid)))) / float(np.sum(mult * h))))
    return res


def one_day(ds):
    D = pd.Timestamp(ds)
    assert D < WALL
    d = read_tape(f"{R}/data/raw/SPXW/trade_quote_dte0/{ds[:4]}/{ds}.csv.gz")
    sp = pd.read_parquet(f"{R}/data/clean/spot.parquet", columns=["ts", "spot"])
    sp = sp[sp.ts < WALL]                                          # time wall
    sp = sp[(sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]
    spot = dict(zip(sp.ts, sp.spot))
    ch = pd.read_parquet(f"{R}/data/clean/chain_{ds}.parquet", columns=["strike", "right", "ts", "mid", "flag_bad"])
    ch = ch[ch.ts < WALL]                                          # time wall
    ch = ch[~ch.flag_bad]
    mid = {(t, float(k), r): v for t, k, r, v in zip(ch.ts, ch.strike, ch.right, ch.mid)}
    book = Book(d)
    ml = d[d.condition.isin(MULTI)]
    cells, prof = [], []
    for hh in (11, 12, 13, 14, 15):
        for mm in range(58):
            t0 = D + pd.Timedelta(hours=hh, minutes=mm)
            S = spot.get(t0, np.nan)
            if not np.isfinite(S):
                continue
            K = float(np.floor(S / 5 + 0.5) * 5)
            tp = t0 - pd.Timedelta(minutes=1)
            if (tp, K, "C") not in mid or (tp, K, "P") not in mid:
                continue
            I = mid[(tp, K, "C")] + mid[(tp, K, "P")]
            w = sorted(WINGS, key=lambda x: (round(abs(x / I - 2), 9), x))[0]
            legs = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C")]
            t0i = t0.value
            gA = t0i + ((np.arange(0, 10) + 0.5) * NS).astype(np.int64)
            gB = t0i + ((np.arange(90, 120) + 0.5) * NS).astype(np.int64)
            HA, agA = Hpath(book, legs, gA)
            HB, agB = Hpath(book, legs, gB)
            row = dict(date=D, hour=hh, minute=mm, S=S, K=K, I=I, w=w, HA=winmean(HA), HB=winmean(HB),
                       medA=float(np.nanmedian(HA)) if np.isfinite(HA).any() else np.nan,
                       medB=float(np.nanmedian(HB)) if np.isfinite(HB).any() else np.nan,
                       ageA=float(np.nanmean(agA)), ageB=float(np.nanmean(agB)),
                       okA=int(np.isfinite(HA).sum()), okB=int(np.isfinite(HB).sum()))
            if mm in (0, 37):
                gP = t0i + ((np.arange(-30, 0) + 0.5) * NS).astype(np.int64)
                row["Hpre"] = winmean(Hpath(book, legs, gP)[0])
                lo, hi = t0i - 60 * NS, t0i + 180 * NS
                fl = flies(ml[(ml.ti >= lo) & (ml.ti < hi)], spot)
                sec = np.array([(t - t0i) / NS for t, _ in fl]); kk = np.array([k for _, k in fl])
                inA = (sec >= 0) & (sec < 10) if len(fl) else np.array([], bool)
                inB = (sec >= 90) & (sec < 120) if len(fl) else np.array([], bool)
                row.update(nfA=int(inA.sum()), nfB=int(inB.sum()),
                           kA=float(kk[inA].mean()) if inA.any() else np.nan,
                           kB=float(kk[inB].mean()) if inB.any() else np.nan)
                gall = t0i + ((np.arange(-60, 180) + 0.5) * NS).astype(np.int64)
                Hall = Hpath(book, legs, gall)[0]
                for b in range(24):
                    s0 = -60 + 10 * b
                    nf = int(((sec >= s0) & (sec < s0 + 10)).sum()) if len(fl) else 0
                    prof.append(dict(date=D, hour=hh, minute=mm, bucket=s0, H=winmean(Hall[b * 10:(b + 1) * 10]), nf=nf))
            cells.append(row)
    return cells, prof


def main():
    cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
    cal = cal[cal.index < WALL]                                    # time wall
    cal = cal[(cal.index >= FIRST) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index
            if os.path.exists(f"{R}/data/raw/SPXW/trade_quote_dte0/{t.year}/{t.strftime('%Y%m%d')}.csv.gz")]
    C, P = [], []
    with ProcessPoolExecutor(6) as ex:
        for c, p in ex.map(one_day, days, chunksize=2):
            C += c; P += p
    pd.DataFrame(C).to_parquet(f"{OUT}/cells.parquet")
    pd.DataFrame(P).to_parquet(f"{OUT}/profile.parquet")
    print(len(days), "days", len(C), "cells")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        import time; t = time.time(); c, p = one_day(sys.argv[1]); print(len(c), len(p), time.time() - t)
        print(pd.DataFrame(c).query("minute in (0,37)").head(10).to_string())
    else:
        main()
