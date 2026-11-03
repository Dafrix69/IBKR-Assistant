"""P-0006: 14:00 iron fly vs iron condor (body +-5), chosen by FE = (I/S)/(VIX_prev/100).
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0006.md
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0006_shape.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0006_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
K_FILL = 0.20
import sys
CAP_IFIC_ONLY = len(sys.argv) > 1 and sys.argv[1] == "ific"   # variant 2 (sensitivity, post-run)
SUFFIX = "_ific" if CAP_IFIC_ONLY else ""
SPREAD_CAP = 3.0
WIDTHS = [20, 25, 30, 50, 75]
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT = 0.14, 0.04028, 1.00, 100

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END]                       # TIME WALL
vix = pd.read_parquet(f"{R}/data/tws/vix_1d.parquet")
vix = vix[vix.date < TRAIN_END]                        # TIME WALL

cal = cal[(~cal.half_day) & cal.has_0dte]
spot = spot.set_index("ts")
vix = vix.assign(date=pd.to_datetime(vix.date)).set_index("date").vix_close.sort_index()


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def structure_pnl(legs, q, settle, k_fill):
    """legs: list of (strike, right, side +1 buy/-1 sell, qty). Returns (pnl USD at k incl. fees,
    pnl USD at mid without fees). Fees: commission max(per-contract tier * qty, 1.00 per leg)
    + qty * (exchange + surcharge + regulatory). Opening only (cash-settled at expiry)."""
    cash, fees, mid_cash, pay = 0.0, 0.0, 0.0, 0.0
    for k, r, s, n in legs:
        b, a = float(q.loc[(k, r), "bid"]), float(q.loc[(k, r), "ask"])
        mid, half = (b + a) / 2, (a - b) / 2
        px = mid + s * k_fill * half
        cash += s * px * MULT * n
        fees += max(tier(px, COMM) * n, MINLEG) + n * (tier(px, EXCH) + SURCH + REG)
        mid_cash += s * mid * MULT * n
        intr = max(settle - k, 0) if r == "C" else max(k - settle, 0)
        pay += s * n * intr * MULT
    return pay - cash - fees, pay - mid_cash


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return None
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "spread", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    t = pd.Timestamp(f"{d:%Y-%m-%d} 14:00")
    if t not in spot.index:
        return None
    S, F = float(spot.loc[t, "spot"]), float(spot.loc[t, "parity_F"])
    q = ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])
    if q.empty:
        return None
    strikes = np.unique(q.index.get_level_values(0).values)
    K = float(strikes[np.abs(strikes - S).argmin()])
    if (K, "C") not in q.index or (K, "P") not in q.index:
        return None
    I = float(q.loc[(K, "C"), "mid"] + q.loc[(K, "P"), "mid"])
    w = min(WIDTHS, key=lambda x: abs(x / I - 2))
    need = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C"), (K - 5, "P"), (K + 5, "C"), (K + w, "P")]
    if any(x not in q.index for x in need):
        return {"date": d, "drop": "missing"}
    capped = need[:-1] if CAP_IFIC_ONLY else need     # sensitivity: cap only the IF/IC legs
    if max(float(q.loc[x, "ask"] - q.loc[x, "bid"]) for x in capped) > SPREAD_CAP:
        return {"date": d, "drop": "wide"}
    st = float(cal.loc[d, "settle"])
    IF = [(K - w, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + w, "C", 1, 1)]
    IC = [(K - w, "P", 1, 1), (K - 5, "P", -1, 1), (K + 5, "C", -1, 1), (K + w, "C", 1, 1)]
    PF = [(K - w, "P", 1, 1), (K, "P", -1, 2), (K + w, "P", 1, 1)]
    N5 = [(K - 5, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + 5, "C", 1, 1)]
    vp = vix[vix.index < d]
    if vp.empty:
        return {"date": d, "drop": "novix"}
    out = {"date": d, "drop": "", "vix_prev": float(vp.iloc[-1]), "FE": (I / S) / (float(vp.iloc[-1]) / 100), "S": S, "F": F, "K": K, "I": I, "w": w, "w_over_I": w / I, "settle": st}
    for name, legs in (("IF", IF), ("IC", IC), ("PF", PF)):
        for kf, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
            p, m = structure_pnl(legs, q, st, kf)
            out[f"{name}{tag}"] = p
        out[f"{name}_mid"] = m
    # 5-wide ATM iron fly short-center gain at mid, USD: G = credit5 - min(|S-K|,5)
    # N5 = short K straddle + long K+-5 = IF minus IC: long the centre mass, pays credit5 - min(|S-K|,5)
    _, g = structure_pnl(N5, q, st, 0.0)
    out["G"] = g
    return out


if __name__ == "__main__":
    days = list(cal.index)
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, days) if r]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                        # TIME WALL (again)
    df.to_csv(f"{OUT}/days_all{SUFFIX}.csv", index=False)
    print("drops:", df["drop"].value_counts().to_dict())
