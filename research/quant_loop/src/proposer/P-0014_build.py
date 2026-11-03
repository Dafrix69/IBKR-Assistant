"""P-0014 build: per-day fixed-leg H profiles around round hours (and :37 placebo), and the
14:00 / 14:02 baseline-A selections. Training period only (date < 2024-11-01).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0014_build.py

Outputs (P-0014_tables/): profile_rows.parquet (day x anchor x offset: H of the 4 iron-fly legs
and of the put-fly legs fixed at the anchor's K, w), entry_rows.parquet (day x minute 13:55-14:10:
re-selected K, w, mid / H / fee per structure).
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0014_tables")
SPLIT = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, COMM_MIN = 0.14, 0.04028, 1.00
KS = [0.0, 0.20, 0.5]
CAP = 2.0
STRUCTS = {
    "put":  [(-1, "P", 1, 1), (0, "P", -1, 2), (1, "P", 1, 1)],
    "iron": [(-1, "P", 1, 1), (0, "P", -1, 1), (0, "C", -1, 1), (1, "C", 1, 1)],
}
ANCHORS = [f"{h}:00" for h in (11, 12, 13, 14, 15)] + [f"{h}:37" for h in (11, 12, 13, 14, 15)]
OFFS = list(range(-5, 11))


def tier(px, tiers):
    for b, f in tiers:
        if px < b:
            return f
    return tiers[-1][1]


def leg_fee(px, qty):
    return max(tier(px, COMM) * qty, COMM_MIN) + qty * (tier(px, EXCH) + SURCH + REG)


def legs_of(name, K, w):
    return [((K + o * w, r), side, qty) for o, r, side, qty in STRUCTS[name]]


def cost(q, name, K, w, k):
    mid = H = fee = 0.0
    mx = 0.0
    for key, side, qty in legs_of(name, K, w):
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
    df = df[(df.ts >= date + pd.Timedelta("10:50:00")) & (df.ts <= date + pd.Timedelta("15:59:00"))]
    Q, STK = {}, {}
    for t, g in df.groupby("ts"):
        Q[t] = {(s, r): (b, a) for s, r, b, a in zip(g.strike.values, g.right.values, g.bid.values, g.ask.values)}
        STK[t] = np.unique(g.strike.values)
    prow, erow = [], []
    for an in ANCHORS:
        t0 = date + pd.Timedelta(an + ":00")
        if t0 not in Q or t0 not in spot.index:
            continue
        sel = select(Q[t0], STK[t0], float(spot.loc[t0]))
        if sel is None:
            continue
        K, w, I = sel
        for off in OFFS:
            t = t0 + pd.Timedelta(minutes=off)
            if t not in Q:
                continue
            r = {"date": date, "anchor": an, "off": off, "K": K, "w": w, "I": I}
            for name in STRUCTS:
                c = cost(Q[t], name, K, w, 0.20)
                if c is not None:
                    r[f"H_{name}"], r[f"mx_{name}"], r[f"mid_{name}"] = c[1], c[3], c[0]
            prow.append(r)
    for mm in range(55, 71):
        t = date + pd.Timedelta(hours=13, minutes=mm)
        if t not in Q or t not in spot.index:
            continue
        S = float(spot.loc[t])
        sel = select(Q[t], STK[t], S)
        if sel is None:
            continue
        K, w, I = sel
        r = {"date": date, "ts": t, "S": S, "K": K, "w": w, "I": I}
        for name in STRUCTS:
            for k in KS:
                c = cost(Q[t], name, K, w, k)
                if c is None:
                    continue
                r[f"mid_{name}"], r[f"H_{name}"], r[f"mx_{name}"] = c[0], c[1], c[3]
                r[f"fee_{name}_k{int(k * 100):02d}"] = c[2]
        erow.append(r)
    return prow, erow


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
    P, E = [], []
    with ProcessPoolExecutor(6, initializer=init, initargs=(sb,)) as ex:
        for a, b in ex.map(day, files, chunksize=4):
            P += a
            E += b
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(P).to_parquet(os.path.join(OUT, "profile_rows.parquet"))
    pd.DataFrame(E).to_parquet(os.path.join(OUT, "entry_rows.parquet"))
    print(len(P), len(E))


if __name__ == "__main__":
    main()
