"""P-0009: 0DTE 15-wide credit spreads (credit 3-4 mid) at 10:30 / 12:00 / 13:00 / 14:00, held to settle.
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0009.md (pre-declared before this script ran)
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0009_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0009_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END]                       # TIME WALL

TIMES = ["10:30", "12:00", "13:00", "14:00"]
W, LO, HI, MID, LEGCAP, RAMP = 15, 3.0, 4.0, 3.5, 2.0, 5
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT = 0.14, 0.04028, 1.00, 100

cal = cal[(~cal.half_day) & cal.has_0dte]
spot = spot.set_index("ts")


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def leg_ok(q, key):
    return key in q.index and float(q.loc[key, "ask"] - q.loc[key, "bid"]) <= LEGCAP


def mid(q, key):
    return float(q.loc[key, "mid"])


def spread_pnl(q, short, long_, payoff_pts, k):
    """credit spread: sell `short`, buy `long_`; payoff_pts = what we owe at settle (>=0)."""
    cash = fees = 0.0
    for key, s in ((short, -1), (long_, 1)):
        b, a = float(q.loc[key, "bid"]), float(q.loc[key, "ask"])
        px = (b + a) / 2 + s * k * (a - b) / 2
        cash += s * px * MULT
        fees += max(tier(px, COMM), MINLEG) + tier(px, EXCH) + SURCH + REG
    return -cash - fees - payoff_pts * MULT


def pick(q, S, side):
    strikes = np.unique(q.index.get_level_values(0).values)
    best = None
    for K in strikes:
        if side == "C":
            if K < S:
                continue
            sh, lg = (K, "C"), (K + W, "C")
        else:
            if K > S:
                continue
            sh, lg = (K, "P"), (K - W, "P")
        if not (leg_ok(q, sh) and leg_ok(q, lg)):
            continue
        cr = mid(q, sh) - mid(q, lg)
        if not (LO <= cr <= HI):
            continue
        far = K if side == "C" else -K
        key = (abs(cr - MID), -far)
        if best is None or key < best[0]:
            best = (key, K, cr)
    return None if best is None else (best[1], best[2])


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return []
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    settle = float(cal.loc[d, "settle"])
    rows = []
    for hm in TIMES:
        t = pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
        if t not in spot.index:
            continue
        S, F = float(spot.loc[t, "spot"]), float(spot.loc[t, "parity_F"])
        q = ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])
        if q.empty:
            continue
        strikes = np.unique(q.index.get_level_values(0).values)
        K0 = float(strikes[np.abs(strikes - S).argmin()])
        I = mid(q, (K0, "C")) + mid(q, (K0, "P")) if (K0, "C") in q.index and (K0, "P") in q.index else np.nan
        for side in ("C", "P"):
            r = pick(q, S, side)
            base = {"date": d, "time": hm, "side": side, "S": S, "F": F, "I": I, "settle": settle,
                    "fomc": bool(cal.loc[d, "fomc"]), "spx_ret_prev": float(cal.loc[d, "spx_ret_prev"])}
            if r is None:
                rows.append({**base, "ok": False})
                continue
            K, cr = r
            if side == "C":
                sh, lg, rk = (K, "C"), (K + W, "C"), (K + RAMP, "C")
                owe = min(max(settle - K, 0), W)
                ramp = min(max(settle - K, 0), RAMP) / RAMP
            else:
                sh, lg, rk = (K, "P"), (K - W, "P"), (K - RAMP, "P")
                owe = min(max(K - settle, 0), W)
                ramp = min(max(K - settle, 0), RAMP) / RAMP
            qr = (mid(q, sh) - mid(q, rk)) / RAMP if rk in q.index else np.nan
            out = {**base, "ok": True, "K": K, "credit_mid": cr, "dist_I": abs(K - S) / I if I == I else np.nan,
                   "owe": owe, "ramp": ramp, "q_ramp": qr, "d": qr - ramp, "g": (cr - owe) / W}
            for k, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
                out[f"pnl{tag}"] = spread_pnl(q, sh, lg, owe, k)
            rows.append(out)
    return rows


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        res = [r for rs in ex.map(one, list(cal.index)) for r in rs]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                       # TIME WALL (again)
    df.to_csv(f"{OUT}/legs_all.csv", index=False)
    print("rows", len(df), df.groupby(["time", "side"]).ok.agg(["sum", "size"]))
