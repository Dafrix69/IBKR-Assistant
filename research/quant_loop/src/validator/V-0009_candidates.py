"""V-0009 (validator, independent of proposer code). TRAINING PERIOD ONLY.
Enumerates every 15-wide 0DTE credit spread (bear call and bull put) at 10:30/12:00/13:00/14:00
with all fields needed to apply either the P-0009 spec or the winrate_study (spread_credit_scan) 口径.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0009_candidates.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0009_tables")
WALL = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < WALL]                                   # TIME WALL, first step after read
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < WALL].set_index("ts")                  # TIME WALL
cal = cal[~cal.half_day]
FL = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]
TIMES = ["10:30", "12:00", "13:00", "14:00"]
W = 15


def tiered(p, tab):
    for row in tab:
        if p < float(row["below"]):
            return float(row["fee"])
    return float(tab[-1]["fee"])


def leg_fee(px, minleg):
    c = tiered(px, FL["commission"])
    if minleg:
        c = max(c, FL["commission_min_per_leg"])
    return c + tiered(px, FL["exchange"]) + FL["execution_surcharge"] + FL["regulatory_clearing"]


def pnl(sb, sa, lb, la, owe, k, minleg, fee_on_mid):
    """sell short leg, buy long leg, hold to settle; USD."""
    ps = (sb + sa) / 2 - k * (sa - sb) / 2
    pl = (lb + la) / 2 + k * (la - lb) / 2
    fs = leg_fee((sb + sa) / 2 if fee_on_mid else ps, minleg)
    fl = leg_fee((lb + la) / 2 if fee_on_mid else pl, minleg)
    return (ps - pl - owe) * 100 - fs - fl


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return []
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < WALL]                                     # TIME WALL per file
    settle = float(cal.loc[d, "settle"])
    rows = []
    for hm in TIMES:
        t = pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
        if t not in spot.index:
            continue
        S, F = float(spot.loc[t, "spot"]), float(spot.loc[t, "parity_F"])
        q = ch[(ch.ts == t) & ~ch.flag_bad]
        if q.empty:
            continue
        qd = {(float(a), b): (float(x), float(y), float(m)) for a, b, x, y, m in
              zip(q.strike, q.right, q.bid, q.ask, q["mid"])}
        ks = np.unique(q.strike.values.astype(float))
        K0 = float(ks[np.abs(ks - S).argmin()])
        I = qd[(K0, "C")][2] + qd[(K0, "P")][2] if (K0, "C") in qd and (K0, "P") in qd else np.nan
        for side, sg in (("C", 1), ("P", -1)):
            for K in ks:
                if sg * (K - S) < -30 or sg * (K - S) > 120:
                    continue
                sh, lg = (K, side), (K + sg * W, side)
                if sh not in qd or lg not in qd:
                    continue
                sb, sa, sm = qd[sh]; lb, la, lm = qd[lg]
                cr = sm - lm
                if not (0 < cr <= 6):
                    continue
                x = max(sg * (settle - K), 0.0)
                owe = min(x, W)
                rk = (K + sg * 5, side)
                qr = (sm - qd[rk][2]) / 5 if rk in qd else np.nan
                r = {"date": d, "time": hm, "side": side, "K": K, "S": S, "F": F, "I": I, "settle": settle,
                     "fomc": bool(cal.loc[d, "fomc"]), "has_0dte": bool(cal.loc[d, "has_0dte"]),
                     "spx_ret_prev": float(cal.loc[d, "spx_ret_prev"]),
                     "credit": cr, "sprd_s": sa - sb, "sprd_l": la - lb, "dist": sg * (K - S),
                     "owe": owe, "ramp": min(x, 5.0) / 5, "q_ramp": qr}
                for k in (0.0, 0.20, 0.25, 0.5):
                    r[f"p{int(k*100):02d}_min"] = pnl(sb, sa, lb, la, owe, k, True, False)
                    r[f"p{int(k*100):02d}_ws"] = pnl(sb, sa, lb, la, owe, k, False, True)
                rows.append(r)
    return rows


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        res = [r for rs in ex.map(one, list(cal.index), chunksize=8) for r in rs]
    df = pd.DataFrame(res)
    df = df[df.date < WALL]
    df.to_parquet(f"{OUT}/candidates.parquet", index=False)
    print(len(df), df.date.min(), df.date.max(), df.date.nunique())
