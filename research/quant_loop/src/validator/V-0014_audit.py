"""V-0014: independent light audit of P-0014 (round-hour 14:00 spread notch). Training only.
Written from the data dictionary; does not import or read proposer code/tables.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0014_audit.py
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "V-0014_tables")
WALL = pd.Timestamp("2024-11-01")
WID = (20, 25, 30, 50, 75)
K = 0.20
CAP = 2.0
ANCH = [(h, 0) for h in (11, 12, 13, 14, 15)] + [(h, 37) for h in (11, 12, 13, 14, 15)]
FIT = (-5, -4, -3, -2, 2, 3, 4, 5)


def fee(px, q=1):
    c = 0.25 if px < 0.05 else (0.50 if px < 0.10 else 0.65)
    ex = 0.36 if px < 1.00 else 0.45
    return max(c * q, 1.00) + q * (ex + 0.14 + 0.04028)


def iron(book, Kc, w, k=K):
    """book: {(strike,'C'/'P'): (bid, ask)}. Returns credit-mid as debit (w - credit), H (sum half spreads),
    max leg spread, fee; None if a leg missing."""
    legs = [(Kc - w, "P", +1), (Kc, "P", -1), (Kc, "C", -1), (Kc + w, "C", +1)]
    debit, H, mx, f = float(w), 0.0, 0.0, 0.0
    for s, r, side in legs:
        q = book.get((s, r))
        if q is None:
            return None
        b, a = q
        m, h = 0.5 * (a + b), 0.5 * (a - b)
        debit += side * m
        H += h
        mx = max(mx, a - b)
        f += fee(m + side * k * h)
    return debit, H, mx, f


def pick(book, S):
    ks = np.array(sorted({s for s, _ in book}))
    Kc = float(ks[np.argmin(np.abs(ks - S))])
    if (Kc, "C") not in book or (Kc, "P") not in book:
        return None
    I = sum(0.5 * sum(book[(Kc, r)]) for r in "CP")
    if I <= 0:
        return None
    best = sorted(WID, key=lambda x: (round(abs(x / I - 2.0), 9), x))[0]
    return Kc, best


def one_day(args):
    path, d, spot_d = args
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    ch = ch[ch.ts < WALL]                                       # time wall first
    ch = ch[(~ch.flag_bad) & (ch.ask > ch.bid) & (ch.bid >= 0)]
    books = {}
    for t, g in ch.groupby("ts", sort=False):
        books[t] = dict(zip(zip(g.strike.to_numpy(float), g.right.to_numpy()), zip(g.bid.to_numpy(float), g.ask.to_numpy(float))))
    prof, ent = [], []
    for h, mm in ANCH:
        t0 = d + pd.Timedelta(hours=h, minutes=mm)
        if t0 not in books or t0 not in spot_d:
            continue
        p = pick(books[t0], spot_d[t0])
        if p is None:
            continue
        Kc, w = p
        for off in range(-5, 11):
            t = t0 + pd.Timedelta(minutes=off)
            x = iron(books[t], Kc, w) if t in books else None
            prof.append((d, f"{h}:{mm:02d}", off, Kc, w, np.nan if x is None else x[1], np.nan if x is None else x[2]))
    for mm in range(-5, 11):
        t = d + pd.Timedelta(hours=14, minutes=mm)
        if t not in books or t not in spot_d:
            continue
        p = pick(books[t], spot_d[t])
        if p is None:
            continue
        Kc, w = p
        for k in (0.20, 0.5):
            x = iron(books[t], Kc, w, k)
            if x is not None:
                ent.append((d, mm, k, Kc, w, x[0], x[1], x[2], x[3]))
    return prof, ent


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < WALL]                                  # time wall first
    base = cal[(~cal.half_day.astype(bool)) & cal.has_0dte.astype(bool) & (cal.spx_ret_prev > -0.01)]
    spot = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    spot = spot[spot.ts < WALL]                                  # time wall first
    spot = spot[(spot.ts.dt.hour >= 10) & (spot.ts.dt.hour <= 15)]
    sd = {d: dict(zip(g.ts, g.spot)) for d, g in spot.groupby(spot.ts.dt.normalize())}
    jobs = []
    for f in sorted(glob.glob(os.path.join(R, "data/clean/chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if d >= WALL or d not in base.index or d not in sd:
            continue
        jobs.append((f, d, sd[d]))
    P, E = [], []
    with ProcessPoolExecutor(6) as ex:
        for a, b in ex.map(one_day, jobs, chunksize=4):
            P += a
            E += b
    prof = pd.DataFrame(P, columns=["date", "anchor", "off", "K", "w", "H", "mx"])
    ent = pd.DataFrame(E, columns=["date", "m", "k", "K", "w", "debit", "H", "mx", "fee"])
    os.makedirs(OUT, exist_ok=True)
    prof.to_parquet(os.path.join(OUT, "prof.parquet"))
    ent.to_parquet(os.path.join(OUT, "ent.parquet"))
    base[["fomc", "settle"]].to_parquet(os.path.join(OUT, "base.parquet"))
    print("days", len(jobs), "prof", len(prof), "ent", len(ent))


if __name__ == "__main__":
    main()
