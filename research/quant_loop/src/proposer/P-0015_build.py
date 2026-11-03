"""P-0015 build: per training day, 13:50-14:15 quotes around the 14:00 Fed-release minute.
Training period only (date < 2024-11-01).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0015_build.py

Outputs (P-0015_tables/):
  entry_rows.parquet : day x entry minute (13:55, 14:00, 14:10): re-selected K, w, I, S;
                       per structure (iron, put): mid (debit-equivalent, points), H (sum of half
                       spreads), mx (widest leg spread), fee at k 0.20 / 0.50.
  fixed_rows.parquet : day x minute 13:50..14:15: H and mx of the iron-fly legs fixed at the
                       13:55 selection; spot.
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, COMM_MIN = 0.14, 0.04028, 1.00
KS = [0.20, 0.50]
STRUCTS = {
    "put":  [(-1, "P", 1, 1), (0, "P", -1, 2), (1, "P", 1, 1)],
    "iron": [(-1, "P", 1, 1), (0, "P", -1, 1), (0, "C", -1, 1), (1, "C", 1, 1)],
}
ENTRIES = ["13:55", "14:00", "14:10"]
FIX_FROM, FIX_MIN = "13:55", list(range(-5, 21))       # 13:50 .. 14:15


def tier(px, tiers):
    for b, f in tiers:
        if px < b:
            return f
    return tiers[-1][1]


def leg_fee(px, qty):
    return max(tier(px, COMM) * qty, COMM_MIN) + qty * (tier(px, EXCH) + SURCH + REG)


def cost(q, name, K, w, k):
    """mid (debit-equivalent points; iron = w - credit), H (points), fee (USD), widest leg spread."""
    mid = H = fee = mx = 0.0
    for o, r, side, qty in STRUCTS[name]:
        key = (K + o * w, r)
        if key not in q:
            return None
        b, a = q[key]
        m, h = (a + b) / 2, (a - b) / 2
        mid += side * qty * m
        H += qty * h
        mx = max(mx, a - b)
        fee += leg_fee(m + side * k * h, qty)
    if name == "iron":
        mid = w + mid
    return mid, H, fee, mx


def select(q, strikes, S):
    K = float(strikes[np.abs(strikes - S).argmin()])
    if (K, "C") not in q or (K, "P") not in q:
        return None
    I = sum((q[(K, r)][0] + q[(K, r)][1]) / 2 for r in "CP")
    if I <= 0:
        return None
    w = min(WIDTHS, key=lambda x: (round(abs(x / I - 2), 9), x))
    return K, w, I


def day(path):
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    df = df[df.ts < SPLIT]                                   # time wall: training period only
    if df.empty or date not in SPOT:
        return [], []
    spot = SPOT[date]
    df = df[~df.flag_bad & (df.ask > df.bid) & (df.bid >= 0)]
    df = df[(df.ts >= date + pd.Timedelta("13:50:00")) & (df.ts <= date + pd.Timedelta("14:15:00"))]
    Q, STK = {}, {}
    for t, g in df.groupby("ts"):
        Q[t] = {(s, r): (b, a) for s, r, b, a in zip(g.strike.values, g.right.values, g.bid.values, g.ask.values)}
        STK[t] = np.unique(g.strike.values)
    erow, frow = [], []
    for e in ENTRIES:
        t = date + pd.Timedelta(e + ":00")
        if t not in Q or t not in spot.index:
            continue
        S = float(spot.loc[t])
        sel = select(Q[t], STK[t], S)
        if sel is None:
            continue
        K, w, I = sel
        r = {"date": date, "entry": e, "S": S, "K": K, "w": w, "I": I}
        for name in STRUCTS:
            for k in KS:
                c = cost(Q[t], name, K, w, k)
                if c is None:
                    continue
                r[f"mid_{name}"], r[f"H_{name}"], r[f"mx_{name}"] = c[0], c[1], c[3]
                r[f"fee_{name}_k{int(k * 100):02d}"] = c[2]
        erow.append(r)
    t0 = date + pd.Timedelta(FIX_FROM + ":00")
    if t0 in Q and t0 in spot.index:
        sel = select(Q[t0], STK[t0], float(spot.loc[t0]))
        if sel is not None:
            K, w, I = sel
            for off in FIX_MIN:
                t = t0 + pd.Timedelta(minutes=off)
                r = {"date": date, "off": off, "K": K, "w": w, "I": I,
                     "spot": float(spot.loc[t]) if t in spot.index else np.nan}
                if t in Q:
                    c = cost(Q[t], "iron", K, w, 0.20)
                    if c is not None:
                        r["H_iron"], r["mx_iron"] = c[1], c[3]
                frow.append(r)
    return erow, frow


def init(s):
    global SPOT
    SPOT = s


def main():
    files = sorted(glob.glob(os.path.join(R, "data/clean/chain_*.parquet")))
    files = [f for f in files if pd.Timestamp(os.path.basename(f)[6:14]) < SPLIT]   # time wall
    spot = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    spot = spot[spot.ts < SPLIT]                              # time wall
    spot["date"] = spot.ts.dt.normalize()
    sb = {d: g.set_index("ts").spot for d, g in spot.groupby("date")}
    E, F = [], []
    with ProcessPoolExecutor(6, initializer=init, initargs=(sb,)) as ex:
        for a, b in ex.map(day, files, chunksize=4):
            E += a
            F += b
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(E).to_parquet(os.path.join(OUT, "entry_rows.parquet"))
    pd.DataFrame(F).to_parquet(os.path.join(OUT, "fixed_rows.parquet"))
    print(len(E), len(F))


if __name__ == "__main__":
    main()
