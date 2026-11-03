"""P-0011: post-non-trading-day morning 0DTE iron fly (10:00, wing ~2xI, held to settle) vs other days.
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0011.md (pre-declared sections written before this ran)
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0011_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0011_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
spot = spot[spot.ts < TRAIN_END]                       # TIME WALL
wp = pd.read_parquet(f"{R}/data/clean/winrate_panel.parquet")
wp = wp[wp.date < TRAIN_END]                           # TIME WALL

COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT, LEGCAP = 0.14, 0.04028, 1.00, 100, 2.0
TIMES = ["09:35", "10:00", "10:30", "14:00"]
FLY_TIMES = ["10:00", "10:30"]

# PNT flag uses the full trading calendar (incl. half days) before filtering
days_all = list(cal.index)
prev_gap = {d: (d - p).days for p, d in zip(days_all[:-1], days_all[1:])}
spot = spot.set_index("ts")


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def fly_pnl(q, K, w, settle, k):
    legs = [((K, "C"), -1), ((K, "P"), -1), ((K + w, "C"), 1), ((K - w, "P"), 1)]
    cash = fees = 0.0
    for key, s in legs:
        b, a = float(q.loc[key, "bid"]), float(q.loc[key, "ask"])
        px = (b + a) / 2 + s * k * (a - b) / 2
        cash += s * px * MULT
        fees += max(tier(px, COMM), MINLEG) + tier(px, EXCH) + SURCH + REG
    owe = min(abs(settle - K), w)
    return -cash - fees - owe * MULT


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return None
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    settle = float(cal.loc[d, "settle"])
    row = {"date": d, "settle": settle, "gap": prev_gap.get(d, np.nan)}
    for hm in TIMES:
        t = pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
        tag = hm.replace(":", "")
        if t not in spot.index:
            continue
        S = float(spot.loc[t, "spot"])
        q = ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])
        if q.empty:
            continue
        both = [K for K in np.unique(q.index.get_level_values(0).values)
                if (K, "C") in q.index and (K, "P") in q.index]
        if not both:
            continue
        both = np.array(both, dtype=float)
        K = float(both[np.argmin(np.abs(both - S) + 1e-9 * both)])   # tie -> lower
        I = float(q.loc[(K, "C"), "mid"] + q.loc[(K, "P"), "mid"])
        row.update({f"S{tag}": S, f"K{tag}": K, f"I{tag}": I})
        if hm not in FLY_TIMES:
            continue
        cands = sorted({max(10.0, 5 * np.floor(2 * I / 5)), max(10.0, 5 * np.ceil(2 * I / 5))})
        w = min(cands, key=lambda x: (abs(x - 2 * I), x))
        if len(cands) == 2 and abs(abs(cands[0] - 2 * I) - abs(cands[1] - 2 * I)) < 1e-9:
            w = cands[0]                                  # tie -> narrow
        keys = [(K, "C"), (K, "P"), (K + w, "C"), (K - w, "P")]
        ok = all(k in q.index for k in keys)
        if ok:
            spr = [float(q.loc[k, "ask"] - q.loc[k, "bid"]) for k in keys]
            ok = max(spr) <= LEGCAP and float(q.loc[keys[0], "bid"]) > 0 and float(q.loc[keys[1], "bid"]) > 0
        row[f"ok{tag}"] = ok
        row[f"w{tag}"] = w
        if ok:
            for k, sfx in ((0.20, ""), (0.0, "_k0"), (0.5, "_k05")):
                row[f"pnl{tag}{sfx}"] = fly_pnl(q, K, w, settle, k)
            row[f"credit{tag}"] = float(sum(q.loc[k, "mid"] * s for k, s in
                                            zip(keys, (1, 1, -1, -1))))
    return row


if __name__ == "__main__":
    use = cal[(~cal.half_day) & cal.has_0dte]
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, list(use.index)) if r is not None]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                       # TIME WALL (again)
    c = cal.loc[df.date]
    for col in ("fomc", "cpi", "nfp", "pce", "vix_prev_close", "spx_ret_prev"):
        df[col] = c[col].values
    df["event"] = df[["fomc", "cpi", "nfp", "pce"]].any(axis=1)
    df["pnt"] = df.gap >= 2
    df["wd"] = pd.to_datetime(df.date).dt.day_of_week
    # baseline A daily pnl (14:00, put_fly, width nearest 2x implied, skip prev <= -1%), k 0.25 panel, correlation only
    b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
    b["dd"] = (b.w_over_implied - 2).abs()
    b = b.sort_values(["date", "dd", "width"]).groupby("date").head(1)
    b = b.merge(cal[["spx_ret_prev"]], left_on="date", right_index=True)
    b = b[~(b.spx_ret_prev <= -0.01)]
    df = df.merge(b[["date", "pnl"]].rename(columns={"pnl": "base_pnl"}), on="date", how="left")
    df.to_csv(f"{OUT}/days.csv", index=False)
    print(len(df), df.pnt.sum(), df.ok1000.sum())
