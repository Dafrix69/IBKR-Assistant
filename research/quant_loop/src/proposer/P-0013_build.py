"""P-0013 build: per-day, per-minute execution cost of equal-payoff fly structures, and
round-strike spread ratios. Training period only (date < 2024-11-01).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0013_build.py

Outputs (P-0013_tables/): struct_rows.parquet (one row per day x minute, 10:00-14:00),
round_rows.parquet (per day x minute x right x strike neighbour log-spread ratio, |K-S|<=50,
minutes on a 5-minute grid), all from chain_*.parquet.
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
MULT = 100
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, COMM_MIN = 0.14, 0.04028, 1.00
KS = [0.0, 0.20, 0.5]

STRUCTS = {  # (strike offset in units of w, right, side, qty)
    "put":  [(-1, "P", 1, 1), (0, "P", -1, 2), (1, "P", 1, 1)],
    "call": [(-1, "C", 1, 1), (0, "C", -1, 2), (1, "C", 1, 1)],
    "iron": [(-1, "P", 1, 1), (0, "P", -1, 1), (0, "C", -1, 1), (1, "C", 1, 1)],   # short iron, debit = w - credit
    "rev":  [(-1, "C", 1, 1), (0, "C", -1, 1), (0, "P", -1, 1), (1, "P", 1, 1)],   # ITM iron, debit = paid - w
}


def tier(px, tiers):
    for b, f in tiers:
        if px < b:
            return f
    return tiers[-1][1]


def leg_fee(px, qty):
    """USD for one leg of a 1-lot combo, calibrated: per-leg 1.00 minimum (calibration.md)."""
    return max(tier(px, COMM) * qty, COMM_MIN) + qty * (tier(px, EXCH) + SURCH + REG)


def struct_cost(q, K, w, name, k):
    """Return (mid_debit_pts, H_pts, fee_usd) in long-fly debit terms, or None."""
    mid = H = fee = 0.0
    for off, r, side, qty in STRUCTS[name]:
        key = (K + off * w, r)
        if key not in q:
            return None
        b, a = q[key]
        m, h = (a + b) / 2, (a - b) / 2
        mid += side * qty * m
        H += qty * h
        fee += leg_fee(m + side * k * h, qty)
    if name == "iron":
        mid = w + mid
    elif name == "rev":
        mid = mid - w
    return mid, H, fee


def day(path):
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    df = df[df.ts < SPLIT]                                   # time wall: training period only
    if df.empty:
        return [], []
    spot = SPOT.get(date)
    if spot is None:
        return [], []
    df = df[~df.flag_bad & (df.ask > df.bid) & (df.bid >= 0)]
    t0, t1 = pd.Timestamp(f"{date.date()} 10:00"), pd.Timestamp(f"{date.date()} 14:00")
    df = df[(df.ts >= t0) & (df.ts <= t1)]
    rows, rrows = [], []
    for t, g in df.groupby("ts"):
        if t not in spot.index:
            continue
        S = float(spot.loc[t])
        q = {(s, r): (b, a) for s, r, b, a in zip(g.strike.values, g.right.values, g.bid.values, g.ask.values)}
        strikes = np.unique(g.strike.values)
        K = float(strikes[np.abs(strikes - S).argmin()])
        if (K, "C") not in q or (K, "P") not in q:
            continue
        I = sum((q[(K, r)][0] + q[(K, r)][1]) / 2 for r in "CP")
        if I <= 0:
            continue
        w = min(WIDTHS, key=lambda x: (round(abs(x / I - 2), 9), x))
        legs = [(K + o * w, r) for o in (-1, 0, 1) for r in "CP"]
        if not all(l in q for l in legs):
            continue
        maxsp = max(q[l][1] - q[l][0] for l in legs)
        row = {"date": date, "ts": t, "S": S, "K": K, "d": S - K, "I": I, "w": w, "maxsp": maxsp,
               "itm_put_sp": q[(K + w, "P")][1] - q[(K + w, "P")][0],
               "itm_call_sp": q[(K - w, "C")][1] - q[(K - w, "C")][0],
               "otm_put_sp": q[(K - w, "P")][1] - q[(K - w, "P")][0],
               "otm_call_sp": q[(K + w, "C")][1] - q[(K + w, "C")][0]}
        for name in STRUCTS:
            for k in KS:
                c = struct_cost(q, K, w, name, k)
                tag = f"{name}_k{int(k * 100):02d}"
                row[f"mid_{name}"], row[f"H_{name}"] = c[0], c[1]
                row[f"fee_{tag}"] = c[2]
        # R_b: shift centre to the second-nearest strike if it is a multiple of 25 and K is not
        K2 = K + (5.0 if S > K else -5.0)
        row["K2"] = K2
        if K % 25 != 0 and K2 % 25 == 0:
            for name in ("put", "iron"):
                c = struct_cost(q, K2, w, name, 0.20)
                if c is not None:
                    row[f"mid_{name}_K2"], row[f"H_{name}_K2"], row[f"fee_{name}_K2"] = c
                    l2 = [(K2 + o * w, r) for o in (-1, 0, 1) for r in "CP" if (K2 + o * w, r) in q]
                    row[f"maxsp_K2"] = max(q[l][1] - q[l][0] for l in l2)
        rows.append(row)
        # (b) neighbour-differenced log spread, 5-minute grid
        if t.minute % 5 == 0:
            for r in "CP":
                for s in strikes:
                    if abs(s - S) > 50 or (s, r) not in q or (s - 5, r) not in q or (s + 5, r) not in q:
                        continue
                    sp = [q[(x, r)][1] - q[(x, r)][0] for x in (s - 5, s, s + 5)]
                    rrows.append((date, t, r, s, s - S, sp[1], (q[(s, r)][0] + q[(s, r)][1]) / 2,
                                  np.log(sp[1]) - 0.5 * (np.log(sp[0]) + np.log(sp[2]))))
    return rows, rrows


def init(spot_by_day):
    global SPOT
    SPOT = spot_by_day


def main():
    files = sorted(glob.glob(os.path.join(R, "data/clean/chain_*.parquet")))
    files = [f for f in files if pd.Timestamp(os.path.basename(f)[6:14]) < SPLIT]   # time wall
    spot = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    spot = spot[spot.ts < SPLIT]                              # time wall
    spot["date"] = spot.ts.dt.normalize()
    spot_by_day = {d: g.set_index("ts").spot for d, g in spot.groupby("date")}
    rows, rrows = [], []
    with ProcessPoolExecutor(6, initializer=init, initargs=(spot_by_day,)) as ex:
        for a, b in ex.map(day, files, chunksize=4):
            rows += a
            rrows += b
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(rows).to_parquet(os.path.join(OUT, "struct_rows.parquet"))
    pd.DataFrame(rrows, columns=["date", "ts", "right", "strike", "dist", "spread", "mid", "lr"]).to_parquet(
        os.path.join(OUT, "round_rows.parquet"))
    print(len(rows), len(rrows))


if __name__ == "__main__":
    main()
