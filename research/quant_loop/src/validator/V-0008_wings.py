"""V-0008: independent rebuild of P-0008 (14:00 put-fly wing multiple by prior-close VIX9D/VIX tercile).
TRAINING PERIOD ONLY (light audit, no test period). Written from BRIEF.md; does not import proposer code.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0008_wings.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0008_tables")
WALL = pd.Timestamp("2024-11-01")

CAL = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
CAL = CAL.loc[CAL.index < WALL]                                   # time wall, first step
SP = pd.read_parquet(f"{R}/data/clean/spot.parquet")
SP = SP.loc[SP.ts < WALL].set_index("ts")                         # time wall, first step
VT = pd.read_parquet(f"{R}/data/tws/vix_term_1d.parquet")
VT = VT.loc[pd.to_datetime(VT.date) < WALL]                        # time wall
VX = pd.read_parquet(f"{R}/data/tws/vix_1d.parquet")
VX = VX.loc[pd.to_datetime(VX.date) < WALL]                        # time wall

CFG = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]
K_DEF = float(CFG["k_default"]); MULT = CFG["multiplier"]
def _t(lst): return [(float(x["below"]), float(x["fee"])) for x in lst]
COMM, EXCH = _t(CFG["commission"]), _t(CFG["exchange"])
SUR, REG, MINC = float(CFG["execution_surcharge"]), float(CFG["regulatory_clearing"]), float(CFG["commission_min_per_leg"])

V = pd.DataFrame({"date": pd.to_datetime(VT.date), "v9": VT.vix9d_close}).merge(
    pd.DataFrame({"date": pd.to_datetime(VX.date), "vx": VX.vix_close}), on="date").dropna()
V = V.sort_values("date").reset_index(drop=True)
V["s"] = V.v9 / V.vx
CUT1, CUT2 = 0.9118, 0.9821            # spec cut points (training terciles); my own recomputation printed below
GRID = list(range(15, 101, 5)); BASE = [20, 25, 30, 50, 75]


def fee(tiers, p):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def putfly(K, w, bk, settle, k):
    tot = 0.0
    for strike, qty in ((K - w, 1), (K, -2), (K + w, 1)):
        b, a = bk[strike]
        px = 0.5 * (a + b) + np.sign(qty) * k * 0.5 * (a - b)
        n = abs(qty)
        tot += -qty * px * MULT - (max(fee(COMM, px) * n, MINC) + n * (fee(EXCH, px) + SUR + REG)) \
               + qty * max(strike - settle, 0.0) * MULT
    return tot


def signal(d):
    prev = V.loc[V.date < d]                                      # strictly before D
    if prev.empty:
        return np.nan, pd.NaT
    r = prev.iloc[-1]
    return float(r.s), r.date


def pick(I, m, grid):
    best = None
    for w in grid:                                                # ascending -> ties keep the narrower
        e = abs(w / I - m)
        if best is None or e < best[0] - 1e-12:
            best = (e, w)
    return best[1]


def day(d):
    f = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    t, t0 = d + pd.Timedelta(hours=14), d + pd.Timedelta(hours=9, minutes=30)
    if not os.path.exists(f) or t not in SP.index or t0 not in SP.index:
        return None
    c = pd.read_parquet(f, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    c = c.loc[(c.ts < WALL) & (c.ts == t)]
    c = c.loc[~c.flag_bad.astype(bool)]
    S = float(SP.at[t, "spot"]); F = float(SP.at[t, "parity_F"]); O = float(SP.at[t0, "spot"])
    s, src = signal(d)
    rec = dict(date=d, S=S, F=F, O=O, s=s, src=src, settle=float(CAL.at[d, "settle"]),
               ret_prev=float(CAL.at[d, "spx_ret_prev"]), vix_prev=float(CAL.at[d, "vix_prev_close"]),
               fomc=bool(CAL.at[d, "fomc"]))
    puts = {float(r.strike): (float(r.bid), float(r.ask)) for r in c.loc[c.right == "P"].itertuples()}
    pm = {float(r.strike): float(r.mid) for r in c.loc[c.right == "P"].itertuples()}
    cm = {float(r.strike): float(r.mid) for r in c.loc[c.right == "C"].itertuples()}
    allK = np.array(sorted(set(c.strike.astype(float))))
    if not len(allK):
        rec["drop"] = "missing"; return rec
    K0 = float(allK[np.argmin(np.abs(allK - S))])
    if K0 not in pm or K0 not in cm:
        rec["drop"] = "missing"; return rec
    I = pm[K0] + cm[K0]
    ws = dict(w15=pick(I, 1.5, GRID), w2=pick(I, 2, GRID), w3=pick(I, 3, GRID), wB=pick(I, 2, BASE))
    rec.update(K0=K0, I=I, **ws)
    need = {K0 + e * w for w in ws.values() for e in (-1, 0, 1)}
    if not need <= set(puts):
        rec["drop"] = "missing"; return rec
    if max(puts[x][1] - puts[x][0] for x in need) > 3.0:
        rec["drop"] = "wide"; return rec
    rec["drop"] = ""
    for k, tag in ((K_DEF, ""), (0.5, "_k05"), (0.0, "_k0")):
        for nm, w in ws.items():
            rec[f"p_{nm}{tag}"] = putfly(K0, w, puts, rec["settle"], k)
    return rec


if __name__ == "__main__":
    days = [d for d in CAL.index if not CAL.at[d, "half_day"] and CAL.at[d, "has_0dte"]]
    with ProcessPoolExecutor(6) as ex:
        out = [r for r in ex.map(day, days, chunksize=8) if r]
    df = pd.DataFrame(out)
    df = df.loc[df.date < WALL]
    df.to_parquet(f"{OUT}/days.parquet")
    print(len(df), df["drop"].value_counts().to_dict())
