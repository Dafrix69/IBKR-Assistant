"""P-0007: 14:00 put fly centred on the highest prior-close 0DTE OI strike within +-10 of spot.
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0007.md
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0007_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0007_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
SPREAD_CAP = 3.0
WIDTHS = [20, 25, 30, 50, 75]
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT = 0.14, 0.04028, 1.00, 100
WIN = 10.0

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END]                       # TIME WALL

cal = cal[(~cal.half_day) & cal.has_0dte]
spot = spot.set_index("ts")


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def fly_pnl(K, w, q, settle, k_fill):
    """put fly long K-w, short 2K, long K+w; USD incl. opening fees."""
    cash = fees = pay = 0.0
    for k, s, n in ((K - w, 1, 1), (K, -1, 2), (K + w, 1, 1)):
        b, a = float(q.loc[(k, "P"), "bid"]), float(q.loc[(k, "P"), "ask"])
        px = (b + a) / 2 + s * k_fill * (a - b) / 2
        cash += s * px * MULT * n
        fees += max(tier(px, COMM) * n, MINLEG) + n * (tier(px, EXCH) + SURCH + REG)
        pay += s * n * max(k - settle, 0) * MULT
    return pay - cash - fees


def load_oi(d):
    f = f"{R}/data/raw/SPXW/oi/{d:%Y}/{d:%Y%m%d}.csv.gz"
    if not os.path.exists(f):
        return None
    o = pd.read_csv(f, usecols=["expiration", "strike", "right", "open_interest"])
    o = o[pd.to_datetime(o.expiration) < TRAIN_END]    # TIME WALL (per file; D file = D-1 close)
    o = o[pd.to_datetime(o.expiration) == d]
    return o.groupby("strike").open_interest.sum()


def pick(cands, oi, S, how):
    v = np.array([oi.get(k, 0.0) for k in cands], float)
    key = (-v if how == "max" else v, np.abs(np.array(cands) - S), np.array(cands))
    order = np.lexsort(key[::-1])
    return cands[order[0]], v


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return None
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    t = pd.Timestamp(f"{d:%Y-%m-%d} 14:00")
    t0 = pd.Timestamp(f"{d:%Y-%m-%d} 09:30")
    if t not in spot.index or t0 not in spot.index:
        return None
    S, F, O = float(spot.loc[t, "spot"]), float(spot.loc[t, "parity_F"]), float(spot.loc[t0, "spot"])
    q = ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])
    if q.empty:
        return None
    strikes = np.unique(q.index.get_level_values(0).values)
    K0 = float(strikes[np.abs(strikes - S).argmin()])
    if (K0, "C") not in q.index or (K0, "P") not in q.index:
        return {"date": d, "drop": "missing"}
    I = float(q.loc[(K0, "C"), "mid"] + q.loc[(K0, "P"), "mid"])
    w = min(WIDTHS, key=lambda x: abs(x / I - 2))
    lo, hi = np.ceil((S - WIN) / 5) * 5, np.floor((S + WIN) / 5) * 5
    cands = [float(k) for k in np.arange(lo, hi + 0.1, 5)]
    oi = load_oi(d)
    oi_ok = oi is not None and sum(oi.get(k, 0.0) for k in cands) > 0
    if oi_ok:
        Ks, v = pick(cands, oi, S, "max")
        rest = [k for k in cands if k != Ks]
        Kmin, _ = pick(rest, oi, S, "min")
    else:
        Ks, Kmin, v = K0, K0, np.zeros(len(cands))
    legs = {(K0 - w, "P"), (K0, "P"), (K0 + w, "P"), (Ks - w, "P"), (Ks, "P"), (Ks + w, "P")}
    if any(x not in q.index for x in legs):
        return {"date": d, "drop": "missing"}
    if max(float(q.loc[x, "ask"] - q.loc[x, "bid"]) for x in legs) > SPREAD_CAP:
        return {"date": d, "drop": "wide"}
    st = float(cal.loc[d, "settle"])
    out = {"date": d, "drop": "", "S": S, "F": F, "O": O, "K0": K0, "Ks": Ks, "Kmin": Kmin, "I": I, "w": w,
           "settle": st, "oi_ok": oi_ok, "n_cand": len(cands),
           "oi_max": float(v.max()), "oi_med": float(np.median(v)), "oi_sum": float(v.sum()),
           "oi_K0": float(oi.get(K0, 0.0)) if oi_ok else 0.0}
    for kf, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
        out[f"R{tag}"] = fly_pnl(Ks, w, q, st, kf)
        out[f"R0{tag}"] = fly_pnl(K0, w, q, st, kf)
    return out


if __name__ == "__main__":
    days = list(cal.index)
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, days) if r]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                        # TIME WALL (again)
    df.to_csv(f"{OUT}/days_all.csv", index=False)
    print("drops:", df["drop"].value_counts().to_dict())
