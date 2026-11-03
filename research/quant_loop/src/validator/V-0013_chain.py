"""V-0013 independent chain-side implementation: 14:00 execution cost of put fly / call fly / short iron fly
(same K, same w, same payoff). Written from the data dictionary; does not import proposer code.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0013_chain.py train|test
Output: V-0013_tables/chain_<period>.parquet (one row per baseline day).
"""
import os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
WID = [20, 25, 30, 50, 75]
KS = (0.0, 0.20, 0.50)


def fee(px, q):
    px = abs(px)
    comm = 0.25 if px < 0.05 else (0.50 if px < 0.10 else 0.65)
    exch = 0.36 if px < 1.0 else 0.45
    return max(comm * q, 1.00) + q * (exch + 0.14 + 0.04028)


# legs: (strike offset in w, right, +1 buy / -1 sell, qty)
LEGS = {"put": [(-1, "P", 1, 1), (0, "P", -1, 2), (1, "P", 1, 1)],
        "call": [(-1, "C", 1, 1), (0, "C", -1, 2), (1, "C", 1, 1)],
        "iron": [(-1, "P", 1, 1), (0, "P", -1, 1), (0, "C", -1, 1), (1, "C", 1, 1)]}


def cost(Q, K, w, s, k):
    mid = H = fe = 0.0
    for o, r, sd, q in LEGS[s]:
        b, a = Q[(K + o * w, r)]
        m, h = 0.5 * (a + b), 0.5 * (a - b)
        mid += sd * q * m; H += q * h
        fe += fee(m + sd * k * h, q)
    if s == "iron":
        mid += w            # long-fly debit equivalent: w - credit
    return mid, H, fe


def one(args):
    date, S = args
    p = os.path.join(R, f"data/clean/chain_{date:%Y%m%d}.parquet")
    if not os.path.exists(p):
        return None
    c = pd.read_parquet(p, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    c = c[c.ts == pd.Timestamp(f"{date:%Y-%m-%d} 14:00")]
    c = c[(~c.flag_bad) & (c.ask > c.bid) & (c.bid >= 0)]
    if c.empty:
        return None
    Q = {(float(s), r): (float(b), float(a)) for s, r, b, a in zip(c.strike, c.right, c.bid, c.ask)}
    st = np.unique(c.strike.values)
    K = float(st[np.argmin(np.abs(st - S))])
    if (K, "C") not in Q or (K, "P") not in Q:
        return None
    I = sum(0.5 * sum(Q[(K, r)]) for r in "CP")
    w = sorted(WID, key=lambda x: (round(abs(x / I - 2), 9), x))[0]
    out = {"date": date, "S": S, "K": K, "d": S - K, "I": I, "w": w}
    for tag, ww in (("", w), ("_wm", WID[WID.index(w) - 1] if WID.index(w) > 0 else None),
                    ("_wp", WID[WID.index(w) + 1] if WID.index(w) < 4 else None)):
        if ww is None:
            continue
        legs = [(K + o * ww, r) for o in (-1, 0, 1) for r in "CP"]
        if not all(l in Q for l in legs):
            if tag == "":
                return None
            continue
        out["maxsp" + tag] = max(Q[l][1] - Q[l][0] for l in legs)
        for s in LEGS:
            for k in KS:
                m, H, fe = cost(Q, K, ww, s, k)
                out[f"mid_{s}{tag}"], out[f"H_{s}{tag}"] = m, H
                out[f"E_{s}_k{int(k*100):02d}{tag}"] = 100 * k * H + fe
                out[f"fee_{s}_k{int(k*100):02d}{tag}"] = fe
    return out


def main(period):
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT] if period == "train" else cal[cal.index >= SPLIT]   # time wall, first step
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[sp.ts < SPLIT] if period == "train" else sp[sp.ts >= SPLIT]              # time wall
    sp = sp[sp.ts.dt.strftime("%H:%M") == "14:00"].set_index(sp.ts.dt.normalize()[sp.ts.dt.strftime("%H:%M") == "14:00"]).spot
    base = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01)]
    jobs = [(d, float(sp[d])) for d in base.index if d in sp.index]
    with ProcessPoolExecutor(6) as ex:
        rows = [r for r in ex.map(one, jobs, chunksize=8) if r is not None]
    df = pd.DataFrame(rows)
    df["fomc"] = df.date.map(cal.fomc)
    df.to_parquet(os.path.join(OUT, f"chain_{period}.parquet"))
    print(period, "baseline days", len(base), "with 14:00 spot", len(jobs), "rows", len(df))


if __name__ == "__main__":
    main(sys.argv[1])
