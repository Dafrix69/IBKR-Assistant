"""P-0008: 14:00 put fly wing multiple by prior-close VIX9D/VIX tercile (L->3, M->2, H->1.5 x I).
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0008.md (pre-declared before this script ran)
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0008_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0008_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
SPREAD_CAP = 3.0
BASE_W = [20, 25, 30, 50, 75]
GRID = list(range(15, 101, 5))
CUT1, CUT2 = 0.9118, 0.9821
COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT = 0.14, 0.04028, 1.00, 100

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END]                       # TIME WALL
vt = pd.read_parquet(f"{R}/data/tws/vix_term_1d.parquet")
vt = vt[pd.to_datetime(vt.date) < TRAIN_END]           # TIME WALL
vx = pd.read_parquet(f"{R}/data/tws/vix_1d.parquet")
vx = vx[pd.to_datetime(vx.date) < TRAIN_END]           # TIME WALL

cal = cal[(~cal.half_day) & cal.has_0dte]
spot = spot.set_index("ts")
vt["date"] = pd.to_datetime(vt.date); vx["date"] = pd.to_datetime(vx.date)
v = vt.merge(vx[["date", "vix_close"]], on="date").dropna(subset=["vix9d_close", "vix_close"]).sort_values("date").set_index("date")
v["s"] = v.vix9d_close / v.vix_close


def sig(d):
    i = v.index.searchsorted(d, side="left") - 1      # last close strictly before D
    return (float(v.s.iloc[i]), v.index[i]) if i >= 0 else (np.nan, None)


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def fly_pnl(K, w, q, settle, k_fill):
    cash = fees = pay = 0.0
    for k, s, n in ((K - w, 1, 1), (K, -1, 2), (K + w, 1, 1)):
        b, a = float(q.loc[(k, "P"), "bid"]), float(q.loc[(k, "P"), "ask"])
        px = (b + a) / 2 + s * k_fill * (a - b) / 2
        cash += s * px * MULT * n
        fees += max(tier(px, COMM) * n, MINLEG) + n * (tier(px, EXCH) + SURCH + REG)
        pay += s * n * max(k - settle, 0) * MULT
    return pay - cash - fees


def pickw(I, m, grid):
    return min(grid, key=lambda x: (abs(x / I - m), x))


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return None
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    t, t0 = pd.Timestamp(f"{d:%Y-%m-%d} 14:00"), pd.Timestamp(f"{d:%Y-%m-%d} 09:30")
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
    s, src = sig(d)
    st = "L" if s <= CUT1 else ("M" if s <= CUT2 else "H")
    ws = {"w15": pickw(I, 1.5, GRID), "w2": pickw(I, 2, GRID), "w3": pickw(I, 3, GRID), "wB": pickw(I, 2, BASE_W)}
    legs = {(K0 + e * w, "P") for w in ws.values() for e in (-1, 0, 1)}
    if any(x not in q.index for x in legs):
        return {"date": d, "drop": "missing"}
    if max(float(q.loc[x, "ask"] - q.loc[x, "bid"]) for x in legs) > SPREAD_CAP:
        return {"date": d, "drop": "wide"}
    settle = float(cal.loc[d, "settle"])
    out = {"date": d, "drop": "", "S": S, "F": F, "O": O, "K0": K0, "I": I, "s": s, "s_src": src, "state": st,
           "settle": settle, "spx_ret_prev": float(cal.loc[d, "spx_ret_prev"]), "fomc": bool(cal.loc[d, "fomc"]), **ws}
    wr = {"L": ws["w3"], "M": ws["w2"], "H": ws["w15"]}[st]
    out["wR"] = wr
    for kf, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
        for nm in ("w15", "w2", "w3", "wB"):
            out[f"p_{nm}{tag}"] = fly_pnl(K0, ws[nm], q, settle, kf)
        out[f"p_R{tag}"] = fly_pnl(K0, wr, q, settle, kf)
    return out


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, list(cal.index)) if r]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                       # TIME WALL (again)
    df.to_csv(f"{OUT}/days_all.csv", index=False)
    print("rows", len(df), "drops:", df["drop"].value_counts().to_dict())
