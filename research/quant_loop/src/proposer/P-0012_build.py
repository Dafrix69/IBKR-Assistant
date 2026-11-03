"""P-0012: post-non-trading-day morning segment. 10:00 short 0DTE iron fly (w ~ 2xI), closed at 14:00 by mark.
TRAINING PERIOD ONLY. Spec: research/quant_loop/proposals/P-0012.md (pre-declared sections written before this ran)
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0012_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0012_tables")
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
KS = (0.20, 0.0, 0.5)

days_all = list(cal.index)
prev_gap = {d: (d - p).days for p, d in zip(days_all[:-1], days_all[1:])}
spot = spot.set_index("ts")


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def fee(px):
    return max(tier(px, COMM), MINLEG) + tier(px, EXCH) + SURCH + REG


def snap(ch, t):
    return ch[(ch.ts == t) & ~ch.flag_bad].set_index(["strike", "right"])


def atm(q, S):
    both = [K for K in np.unique(q.index.get_level_values(0).values)
            if (K, "C") in q.index and (K, "P") in q.index]
    if not both:
        return None, None
    both = np.array(both, dtype=float)
    K = float(both[np.argmin(np.abs(both - S) + 1e-9 * both)])
    return K, float(q.loc[(K, "C"), "mid"] + q.loc[(K, "P"), "mid"])


def one(d):
    path = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(path):
        return None
    ch = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    settle = float(cal.loc[d, "settle"])
    T = lambda hm: pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
    row = {"date": d, "settle": settle, "gap": prev_gap.get(d, np.nan)}
    t0 = T("10:00")
    if t0 not in spot.index:
        return row
    S10 = float(spot.loc[t0, "spot"])
    q = snap(ch, t0)
    if q.empty:
        return row
    K, I = atm(q, S10)
    if K is None:
        return row
    cands = sorted({max(10.0, 5 * np.floor(2 * I / 5)), max(10.0, 5 * np.ceil(2 * I / 5))})
    w = min(cands, key=lambda x: (abs(x - 2 * I), x))
    if len(cands) == 2 and abs(abs(cands[0] - 2 * I) - abs(cands[1] - 2 * I)) < 1e-9:
        w = cands[0]
    legs = [((K, "C"), -1), ((K, "P"), -1), ((K + w, "C"), 1), ((K - w, "P"), 1)]
    keys = [k for k, _ in legs]
    row.update({"S10": S10, "K": K, "I10": I, "w": w})
    ok = all(k in q.index for k in keys)
    if ok:
        spr = [float(q.loc[k, "ask"] - q.loc[k, "bid"]) for k in keys]
        ok = max(spr) <= LEGCAP and float(q.loc[keys[0], "bid"]) > 0 and float(q.loc[keys[1], "bid"]) > 0
    row["ok"] = ok
    if not ok:
        return row
    row["F10"] = K + float(q.loc[(K, "C"), "mid"] - q.loc[(K, "P"), "mid"])
    V10 = sum(-s * float(q.loc[k, "mid"]) for k, s in legs)        # short credit at mid
    row["V10"] = V10
    owe = min(abs(settle - K), w)
    row["H"] = (V10 - owe) / I
    # entry cash and fees per k
    ent = {}
    for k in KS:
        cash = fees = 0.0
        for key, s in legs:
            b, a = float(q.loc[key, "bid"]), float(q.loc[key, "ask"])
            px = (b + a) / 2 + s * k * (a - b) / 2
            cash += s * px
            fees += fee(px)
        ent[k] = (cash, fees)
    for k in KS:
        sfx = {0.20: "", 0.0: "_k0", 0.5: "_k05"}[k]
        row[f"pnl_hold{sfx}"] = (-ent[k][0] * MULT - ent[k][1] - owe * MULT)
    # mark-only snapshots for M (mid of all 4 legs, no fallback)
    for hm in ("13:00", "14:00", "15:00"):
        qq = snap(ch, T(hm))
        tag = hm.replace(":", "")
        if all(k in qq.index for k in keys):
            row[f"V{tag}"] = sum(-s * float(qq.loc[k, "mid"]) for k, s in legs)
    # I14 / S14 for c
    t14 = T("14:00")
    if t14 in spot.index:
        S14 = float(spot.loc[t14, "spot"])
        q14 = snap(ch, t14)
        if not q14.empty:
            K14, I14 = atm(q14, S14)
            row.update({"S14": S14, "I14": I14})
    # tradable exit with fallback 14:00..14:10, also report exits at 13:00 / 15:00 (same rule, +10 min)
    for base in ("13:00", "14:00", "15:00"):
        tag = base.replace(":", "")
        done = False
        for m in range(11):
            t = T(base) + pd.Timedelta(minutes=m)
            qq = snap(ch, t)
            trade = []
            good = True
            for key, s in legs:
                if key not in qq.index:
                    good = False
                    break
                b, a = float(qq.loc[key, "bid"]), float(qq.loc[key, "ask"])
                if s == 1 and b <= 0:
                    continue                                   # worthless wing: keep to settle
                if a - b > LEGCAP:
                    good = False
                    break
                trade.append((key, s, b, a))
            if not good:
                continue
            kept = [key for key, s in legs if key not in [x[0] for x in trade]]
            resid = 0.0
            for (Kx, r) in kept:
                resid += max(settle - Kx, 0) if r == "C" else max(Kx - settle, 0)
            for k in KS:
                sfx = {0.20: "", 0.0: "_k0", 0.5: "_k05"}[k]
                cash, fees = ent[k]
                xcash = 0.0
                for key, s, b, a in trade:
                    px = (b + a) / 2 - s * k * (a - b) / 2          # close: buy shorts up, sell longs down
                    xcash += s * px
                    fees += fee(px)
                row[f"pnl_x{tag}{sfx}"] = (-cash + xcash + resid) * MULT - fees
            row[f"xmin{tag}"] = m
            done = True
            break
        if not done:
            for k in KS:
                sfx = {0.20: "", 0.0: "_k0", 0.5: "_k05"}[k]
                row[f"pnl_x{tag}{sfx}"] = row[f"pnl_hold{sfx}"]
            row[f"xmin{tag}"] = -1                              # held to settle
    return row


if __name__ == "__main__":
    use = cal[(~cal.half_day) & cal.has_0dte]
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, list(use.index)) if r is not None]
    df = pd.DataFrame(res)
    df = df[df.date < TRAIN_END]                       # TIME WALL (again)
    c = cal.loc[df.date]
    for col in ("fomc", "cpi", "nfp", "pce", "spx_ret_prev"):
        df[col] = c[col].values
    df["event"] = df[["fomc", "cpi", "nfp", "pce"]].any(axis=1)
    df["pnt"] = df.gap >= 2
    # PNT+1: the trading day right after a PNT day (calendar order, full calendar)
    nxt = {days_all[i + 1]: (prev_gap.get(days_all[i], 0) >= 2) for i in range(len(days_all) - 1)}
    df["pnt1"] = df.date.map(nxt).fillna(False).astype(bool) & ~df.pnt
    df["wd"] = pd.to_datetime(df.date).dt.day_of_week
    b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
    b["dd"] = (b.w_over_implied - 2).abs()
    b = b.sort_values(["date", "dd", "width"]).groupby("date").head(1)
    b = b.merge(cal[["spx_ret_prev"]], left_on="date", right_index=True)
    b = b[~(b.spx_ret_prev <= -0.01)]
    df = df.merge(b[["date", "pnl"]].rename(columns={"pnl": "base_pnl"}), on="date", how="left")
    df.to_csv(f"{OUT}/days.csv", index=False)
    print(len(df), int(df.pnt.sum()), int(df.ok.fillna(False).sum()))
