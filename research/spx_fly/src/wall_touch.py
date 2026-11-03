"""Does SPX bounce in the 15-60 minutes after touching the 0DTE put wall, and can a fly
placed above the wall be closed for a profit in that window?

    .venv/bin/python src/wall_touch.py [--workers 6]

Put wall = strike with the most 0DTE put OI (prior close) within 150 points below the open.
Touch = first minute after 10:00 and before 15:00 at which spot <= wall + TOUCH_PTS, coming
from above. At that minute a 25-wide put fly is priced at centers ATM, +25, +50 (relative
to the touch spot) and its mid is tracked for the next 60 minutes. Exit value at horizon h =
mid at the touch minute + h; max = best mid within the horizon (an optimistic, look-ahead
bound on what a take-profit could have caught).
Control: the same measurements on every day at the same clock minute as that day's touch would
have been, using the median touch minute, on days without a touch.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402
import wall_factors as W  # noqa: E402
import winrate_study as S  # noqa: E402

F = S.F
TOUCH_PTS = 3.0
HORIZONS = [15, 30, 60]
OFFS = [0, 25, 50]


def fly_series(df, K, w, t0, t1):
    """Mid value of the 25-wide put fly centred at K for minutes t0..t1; NaN where a leg is flagged."""
    legs = [K - w, K, K + w]
    sub = df[(df.ts >= t0) & (df.ts <= t1) & (df.right == "P") & df.strike.isin(legs)]
    piv = sub.pivot_table(index="ts", columns="strike", values="mid")
    bad = sub[sub.flag_bad].groupby("ts").size()
    if piv.shape[1] < 3:
        return None
    v = piv[K - w] - 2 * piv[K] + piv[K + w]
    v[v.index.isin(bad.index)] = np.nan
    h = sub.pivot_table(index="ts", columns="strike", values="spread")
    half = (h[K - w] + 2 * h[K] + h[K + w]) / 2
    return v, half


def measure(df, spot_day, t, settle):
    s0 = float(spot_day.loc[t])
    strikes = np.sort(df.strike.unique())
    Kc = float(strikes[np.abs(strikes - s0).argmin()])
    end = min(t + pd.Timedelta(minutes=60), spot_day.index.max())
    fwd = spot_day[(spot_day.index > t) & (spot_day.index <= end)]
    rec = {"spot": s0, "settle_move": settle - s0}
    for h in HORIZONS:
        th = t + pd.Timedelta(minutes=h)
        rec[f"move_{h}"] = float(spot_day.loc[th] - s0) if th in spot_day.index else np.nan
    rec["max_up_60"] = float(fwd.max() - s0) if len(fwd) else np.nan
    rec["max_dn_60"] = float(fwd.min() - s0) if len(fwd) else np.nan
    for off in OFFS:
        K = Kc + off
        r = fly_series(df, K, 25, t, end)
        if r is None or t not in r[0].index or np.isnan(r[0].loc[t]) or r[0].loc[t] <= 0:
            continue
        v, half = r
        cost = float(v.loc[t]) + S.K * float(half.loc[t])           # buy at mid + k*H
        fee = float(np.array([1, 2, 1.0]).sum() * fills.leg_fee(np.array([cost / 4]), F)[0])  # approx: 4 legs at the avg leg price
        later = v[v.index > t].dropna()
        for h in HORIZONS:
            th = t + pd.Timedelta(minutes=h)
            win = later[later.index <= th]
            exit_h = float(v.loc[th] - S.K * half.loc[th]) if th in v.index and not np.isnan(v.loc[th]) else np.nan
            rec[f"fly{off}_cost"] = cost
            rec[f"fly{off}_pnl_{h}"] = (exit_h - cost) * F["multiplier"] - 2 * fee if exit_h == exit_h else np.nan
            rec[f"fly{off}_max_{h}"] = (float(win.max()) - S.K * float(half.reindex(win.index).max()) - cost) * F["multiplier"] - 2 * fee if len(win) else np.nan
            rec[f"fly{off}_hit2x_{h}"] = bool(len(win) and (win - S.K * half.reindex(win.index)).max() >= 2 * cost)
            rec[f"fly{off}_hit15x_{h}"] = bool(len(win) and (win - S.K * half.reindex(win.index)).max() >= 1.5 * cost)
        rec[f"fly{off}_settle_pnl"] = (fills.fly_settle_value(settle, K, 25) - cost) * F["multiplier"] - fee
    return rec


def day(args):
    path, spot_day, settle, date, ctrl_minute = args
    oi = W.oi_0dte("SPXW", date)
    if oi is None or "PUT" not in oi:
        return []
    open_ = float(spot_day.iloc[0])
    below = oi[(oi.index < open_) & (oi.index >= open_ - 150)]
    if below.empty or below["PUT"].max() <= 0:
        return []
    wall = float(below["PUT"].idxmax())
    win = spot_day[(spot_day.index.time >= pd.Timestamp("10:00").time()) & (spot_day.index.time < pd.Timestamp("15:00").time())]
    above = win[win > wall + TOUCH_PTS]
    touches = win[(win <= wall + TOUCH_PTS) & (win.index > (above.index.min() if len(above) else win.index.min()))]
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "mid", "spread", "flag_bad"])
    out = []
    if len(touches):
        t = touches.index[0]
        rec = measure(df, spot_day, t, settle)
        rec.update({"date": date, "kind": "touch", "t": t, "wall": wall, "wall_gap_open": open_ - wall})
        out.append(rec)
    else:
        t = pd.Timestamp(f"{date.date()} {ctrl_minute}")
        if t in spot_day.index:
            rec = measure(df, spot_day, t, settle)
            rec.update({"date": date, "kind": "control", "t": t, "wall": wall, "wall_gap_open": open_ - wall})
            out.append(rec)
    return out


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--workers", type=int, default=6)
    a.add_argument("--ctrl-minute", default="12:30")
    x = a.parse_args()
    cal = pd.read_parquet(os.path.join(S.CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(S.CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d, x.ctrl_minute)
            for f in sorted(glob.glob(os.path.join(S.CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for dd in ex.map(day, jobs, chunksize=8) for r in dd]
    p = pd.DataFrame(rows)
    p.to_parquet(os.path.join(S.CLEAN, "wall_touch_panel.parquet"), index=False)
    pd.set_option("display.width", 220)
    print(p.kind.value_counts().to_dict(), "touch minute median", p[p.kind == "touch"].t.dt.time.astype(str).sort_values().iloc[len(p[p.kind == "touch"]) // 2] if (p.kind == "touch").any() else None)
    cols = ["move_15", "move_30", "move_60", "max_up_60", "max_dn_60", "settle_move"]
    print(p.groupby("kind")[cols].agg(["mean", "median"]).round(1).to_string())
    for h in HORIZONS:
        print(f"P(spot up >= 10 in {h}m):", p.groupby("kind")[f"move_{h}"].apply(lambda s: (s >= 10).mean()).round(3).to_dict(),
              " P(up>=25):", p.groupby("kind")[f"move_{h}"].apply(lambda s: (s >= 25).mean()).round(3).to_dict())
    rows = []
    for k, g in p.groupby("kind"):
        for off in OFFS:
            for h in HORIZONS:
                c = f"fly{off}"
                s = g.dropna(subset=[f"{c}_pnl_{h}"])
                rows.append({"kind": k, "center": f"+{off}", "horizon": h, "n": len(s), "cost_pts": s[f"{c}_cost"].mean(),
                             "pnl_at_h": s[f"{c}_pnl_{h}"].mean(), "win_at_h": (s[f"{c}_pnl_{h}"] > 0).mean(),
                             "best_in_h": s[f"{c}_max_{h}"].mean(), "hit_1.5x": s[f"{c}_hit15x_{h}"].mean(), "hit_2x": s[f"{c}_hit2x_{h}"].mean(),
                             "settle_pnl": s[f"{c}_settle_pnl"].mean(), "settle_win": (s[f"{c}_settle_pnl"] > 0).mean()})
    t = pd.DataFrame(rows).round(3)
    t.to_csv(os.path.join(S.TABLES, "wall_touch.csv"), index=False)
    print(t.to_string())


if __name__ == "__main__":
    main()
