"""V-0015 build (validator, independent of the proposer's code).

Per base-candidate day, from chain_YYYYMMDD.parquet (0DTE SPXW 1-minute NBBO) and spot.parquet:
  entries.parquet : day x entry minute in ENTRIES: K (strike nearest spot at t, both C and P quoted),
                    I (ATM straddle mid), w (|w/I - 2| min over 20/25/30/50/75, tie -> narrower),
                    for iron fly and put fly: debit-equivalent mid (points), H (sum qty * half spread),
                    widest leg spread, fees at k 0.20 / 0.50 (per-leg tiers on the execution price).
  fixed.parquet   : day x minute 13:50..14:15: H / widest spread of the iron-fly legs fixed at the
                    13:55 selection, and spot.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0015_build.py train|test

Time wall: the period argument filters chain files by file date and, after reading, every row by ts.
"""
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
PERIOD = sys.argv[1] if len(sys.argv) > 1 else "train"
assert PERIOD in ("train", "test")
WIDTHS = (20, 25, 30, 50, 75)
ENTRIES = ("13:54", "13:55", "13:56", "13:58", "14:00", "14:10")
KLEV = (0.20, 0.50)


def in_period(ts):
    return (ts < SPLIT) if PERIOD == "train" else (ts >= SPLIT)


def commission(p):
    return 0.25 if p < 0.05 else (0.50 if p < 0.10 else 0.65)


def exch(p):
    return 0.36 if p < 1.00 else 0.45


def fee_leg(p, n):
    return max(commission(p) * n, 1.00) + n * (exch(p) + 0.14 + 0.04028)


def legs(struct, K, w):
    # (strike, right, +1 buy / -1 sell, qty)
    if struct == "iron":
        return [(K - w, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + w, "C", 1, 1)]
    return [(K - w, "P", 1, 1), (K, "P", -1, 2), (K + w, "P", 1, 1)]


def price(book, struct, K, w):
    """Return dict(mid debit-equivalent pts, H pts, widest, fee_k20, fee_k50) or None if a leg is missing."""
    tot = 0.0
    H = 0.0
    widest = 0.0
    fees = {k: 0.0 for k in KLEV}
    for s, r, side, n in legs(struct, K, w):
        q = book.get((s, r))
        if q is None:
            return None
        bid, ask = q
        m = 0.5 * (bid + ask)
        h = 0.5 * (ask - bid)
        tot += side * n * m
        H += n * h
        widest = max(widest, ask - bid)
        for k in KLEV:
            fees[k] += fee_leg(m + side * k * h, n)
    debit = tot + w if struct == "iron" else tot      # iron: credit c, debit-equivalent = w - c
    return {"mid": debit, "H": H, "widest": widest, "fee20": fees[0.20], "fee50": fees[0.50]}


def choose(book, S):
    ks = np.array(sorted({s for s, _ in book}))
    K = float(ks[np.argmin(np.abs(ks - S))])
    if (K, "C") not in book or (K, "P") not in book:
        return None
    I = sum(0.5 * (book[(K, r)][0] + book[(K, r)][1]) for r in ("C", "P"))
    if not I > 0:
        return None
    best = None
    for w in WIDTHS:                                    # ascending: ties keep the narrower width
        d = abs(w / I - 2.0)
        if best is None or d < best[0] - 1e-9:
            best = (d, w)
    return K, best[1], I


def one_day(args):
    path, spot_day = args
    d = pd.Timestamp(os.path.basename(path)[6:14])
    c = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    c = c[in_period(c.ts)]                              # time wall (row level)
    lo, hi = d + pd.Timedelta("13:50:00"), d + pd.Timedelta("14:15:00")
    c = c[(c.ts >= lo) & (c.ts <= hi) & (~c.flag_bad) & (c.ask > c.bid) & (c.bid >= 0)]
    books = {}
    for t, g in c.groupby("ts"):
        books[t] = dict(zip(zip(g.strike.to_numpy(), g.right.to_numpy()), zip(g.bid.to_numpy(), g.ask.to_numpy())))
    ent, fix = [], []
    for e in ENTRIES:
        t = d + pd.Timedelta(e + ":00")
        if t not in books or t not in spot_day:
            continue
        S = spot_day[t]
        ch = choose(books[t], S)
        if ch is None:
            continue
        K, w, I = ch
        row = {"date": d, "entry": e, "S": S, "K": K, "w": w, "I": I}
        for st in ("iron", "put"):
            p = price(books[t], st, K, w)
            if p is not None:
                for kk, v in p.items():
                    row[f"{st}_{kk}"] = v
        ent.append(row)
    t0 = d + pd.Timedelta("13:55:00")
    if t0 in books and t0 in spot_day:
        ch = choose(books[t0], spot_day[t0])
        if ch is not None:
            K, w, I = ch
            for off in range(-5, 21):
                t = t0 + pd.Timedelta(minutes=off)
                row = {"date": d, "off": off, "K": K, "w": w, "spot": spot_day.get(t, np.nan)}
                if t in books:
                    p = price(books[t], "iron", K, w)
                    if p is not None:
                        row["H"], row["widest"] = p["H"], p["widest"]
                fix.append(row)
    return ent, fix


def main():
    files = sorted(glob.glob(os.path.join(R, "data/clean/chain_*.parquet")))
    files = [f for f in files if in_period(pd.Timestamp(os.path.basename(f)[6:14]))]   # time wall
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[in_period(sp.ts)]                                                          # time wall
    sp = sp[(sp.ts.dt.hour == 13) & (sp.ts.dt.minute >= 50) | (sp.ts.dt.hour == 14) & (sp.ts.dt.minute <= 15)]
    byday = {k: dict(zip(g.ts, g.spot)) for k, g in sp.groupby(sp.ts.dt.normalize())}
    jobs = [(f, byday.get(pd.Timestamp(os.path.basename(f)[6:14]), {})) for f in files]
    E, F = [], []
    with ProcessPoolExecutor(6) as ex:
        for a, b in ex.map(one_day, jobs, chunksize=8):
            E += a
            F += b
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(E).to_parquet(os.path.join(OUT, f"entries_{PERIOD}.parquet"))
    pd.DataFrame(F).to_parquet(os.path.join(OUT, f"fixed_{PERIOD}.parquet"))
    print(PERIOD, "files", len(files), "entry rows", len(E), "fixed rows", len(F))


if __name__ == "__main__":
    main()
