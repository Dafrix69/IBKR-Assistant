"""P-0004 build: 14:00 candidate 0DTE credit spreads (bear call / bull put, 10 / 15 wide),
TRAINING PERIOD ONLY. Writes quotes + entry-time signals; NO settlement / P&L here.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0004_build.py

Output: P-0004_tables/cand.parquet (one row = day x side x width x short strike)
        P-0004_tables/days.parquet (one row = day: spot, ATM straddle I)
"""
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CLEAN = os.path.join(R, "data/clean")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0004_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
ENTRY = "14:00"
WIDTHS = [10, 15]

# calibrated fee schedule, research/spx_fly/config.yaml `fills` (copied, not imported)
COMM_MIN_PER_LEG = 1.00
def leg_fee_1lot(px):
    comm = 0.25 if px < 0.05 else (0.50 if px < 0.10 else 0.65)
    exch = 0.36 if px < 1.00 else 0.45
    return max(comm, COMM_MIN_PER_LEG) + exch + 0.14 + 0.04028


def day_rows(args):
    path, s0 = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    t = pd.Timestamp(f"{date.date()} {ENTRY}")
    q = df[(df.ts == t) & ~df.flag_bad].set_index(["strike", "right"])[["bid", "ask", "mid"]]
    if q.empty:
        return None, []
    strikes = np.sort(q.index.get_level_values(0).unique().values)
    katm = float(strikes[np.abs(strikes - s0).argmin()])
    try:
        I = float(q.loc[(katm, "C"), "mid"] + q.loc[(katm, "P"), "mid"])
    except KeyError:
        return None, []
    day = {"date": date, "spot": s0, "k_atm": katm, "I": I}
    rows = []
    for side, right, sgn in (("bear_call", "C", 1), ("bull_put", "P", -1)):
        for w in WIDTHS:
            for ks in strikes:
                d = sgn * (ks - s0)            # OTM distance of the short leg, points (>0 = OTM)
                if d < -15 or d > 90:
                    continue
                kl = ks + sgn * w
                try:
                    sh, lo = q.loc[(ks, right)], q.loc[(kl, right)]
                except KeyError:
                    continue
                credit = float(sh.mid - lo.mid)
                H = float((sh.ask - sh.bid) / 2 + (lo.ask - lo.bid) / 2)
                fee = leg_fee_1lot(float(sh.mid)) + leg_fee_1lot(float(lo.mid))
                rows.append({"date": date, "side": side, "width": w, "k_short": float(ks), "k_long": float(kl),
                             "dist": d, "dist_I": d / I, "credit": credit, "H": H, "fee": fee,
                             "short_bid": float(sh.bid), "long_bid": float(lo.bid)})
    return day, rows


def main():
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[cal.index < TRAIN_END]                                  # TIME WALL: training only
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    spot = spot[spot.ts < TRAIN_END]                                  # TIME WALL: training only
    spot = spot.set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if d >= TRAIN_END:                                            # TIME WALL: never open test files
            continue
        if d not in cal.index or cal.loc[d, "half_day"]:
            continue
        t = pd.Timestamp(f"{d.date()} {ENTRY}")
        if t not in spot.index:
            continue
        jobs.append((f, float(spot.loc[t])))
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(day_rows, jobs, chunksize=8))
    days = pd.DataFrame([d for d, _ in res if d is not None])
    cand = pd.DataFrame([r for _, rs in res for r in rs])
    assert days.date.max() < TRAIN_END and cand.date.max() < TRAIN_END
    days.to_parquet(os.path.join(OUT, "days.parquet"), index=False)
    cand.to_parquet(os.path.join(OUT, "cand.parquet"), index=False)
    print(len(jobs), "jobs", len(days), "days", len(cand), "candidate rows", days.date.min(), days.date.max())


if __name__ == "__main__":
    main()
