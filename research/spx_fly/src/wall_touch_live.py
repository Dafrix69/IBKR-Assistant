"""Same test as wall_touch.py, but with the wall defined the way the Datrix wall strip does it:
recomputed every minute as the strike strictly below the CURRENT spot with the largest
(a) 0DTE put open interest (prior close, what TWS shows intraday)  -> "oi"
(b) 0DTE put volume traded so far today (the app's 成交墙)          -> "vol", 2024-10-30 on
Touch = first minute after 10:00 (before 15:00) that spot <= live wall + 3 points.

    .venv/bin/python src/wall_touch_live.py [--workers 6]
"""
import argparse, glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wall_factors as W, wall_touch as T, winrate_study as S

def live_wall_touch(spot_win, size_by_strike_at):
    """size_by_strike_at(t) -> Series strike->size. First minute spot <= wall(t)+3."""
    for t, s in spot_win.items():
        tbl = size_by_strike_at(t)
        if tbl is None or tbl.empty:
            continue
        below = tbl[(tbl.index < s) & (tbl.index >= s - 150) & (tbl > 0)]
        if below.empty:
            continue
        wall = float(below.idxmax())
        if s <= wall + T.TOUCH_PTS:
            return t, wall
    return None, None

def day(args):
    path, spot_day, settle, date = args
    oi = W.oi_0dte("SPXW", date)
    tr = W.trades_until(date)
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "mid", "spread", "flag_bad"])
    win = spot_day[(spot_day.index.time >= pd.Timestamp("10:00").time()) & (spot_day.index.time < pd.Timestamp("15:00").time())]
    out = []
    if oi is not None and "PUT" in oi:
        put_oi = oi["PUT"]
        t, wall = live_wall_touch(win, lambda _t: put_oi)
        if t is not None:
            rec = T.measure(df, spot_day, t, settle); rec.update({"date": date, "kind": "oi_live", "t": t, "wall": wall}); out.append(rec)
    if tr is not None:
        puts = tr[tr.right == "PUT"].sort_values("ts")
        def vol_at(t):
            u = puts[puts.ts < t]
            return u.groupby("strike")["size"].sum() if len(u) else None
        t, wall = live_wall_touch(win, vol_at)
        if t is not None:
            rec = T.measure(df, spot_day, t, settle); rec.update({"date": date, "kind": "vol_live", "t": t, "wall": wall}); out.append(rec)
    return out

if __name__ == "__main__":
    a = argparse.ArgumentParser(); a.add_argument("--workers", type=int, default=6); x = a.parse_args()
    cal = pd.read_parquet(os.path.join(S.CLEAN, "calendar.parquet")); spot = pd.read_parquet(os.path.join(S.CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d) for f in sorted(glob.glob(os.path.join(S.CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for dd in ex.map(day, jobs, chunksize=4) for r in dd]
    p = pd.DataFrame(rows); p.to_parquet(os.path.join(S.CLEAN, "wall_touch_live_panel.parquet"), index=False)
    pd.set_option("display.width", 220)
    print(p.kind.value_counts().to_dict())
    print(p.groupby("kind").t.apply(lambda s: s.dt.time.astype(str).quantile(0.5) if False else str(s.dt.hour.median())+"h").to_dict())
    cols = ["move_15", "move_30", "move_60", "max_up_60", "max_dn_60", "settle_move"]
    print(p.groupby("kind")[cols].agg(["mean", "median"]).round(1).to_string())
    for h in T.HORIZONS:
        print(f"P(up>=10 in {h}m):", p.groupby("kind")[f"move_{h}"].apply(lambda s: (s >= 10).mean()).round(3).to_dict(), " P(dn<=-10):", p.groupby("kind")[f"move_{h}"].apply(lambda s: (s <= -10).mean()).round(3).to_dict())
    rows = []
    for k, g in p.groupby("kind"):
        for off in T.OFFS:
            for h in T.HORIZONS:
                c = f"fly{off}"; s = g.dropna(subset=[f"{c}_pnl_{h}"])
                rows.append({"kind": k, "center": f"+{off}", "horizon": h, "n": len(s), "cost_pts": s[f"{c}_cost"].mean(), "pnl_at_h": s[f"{c}_pnl_{h}"].mean(),
                             "win_at_h": (s[f"{c}_pnl_{h}"] > 0).mean(), "best_in_h": s[f"{c}_max_{h}"].mean(), "hit_1.5x": s[f"{c}_hit15x_{h}"].mean(), "hit_2x": s[f"{c}_hit2x_{h}"].mean(),
                             "settle_pnl": s[f"{c}_settle_pnl"].mean(), "settle_win": (s[f"{c}_settle_pnl"] > 0).mean()})
    t = pd.DataFrame(rows).round(3); t.to_csv(os.path.join(S.TABLES, "wall_touch_live.csv"), index=False); print(t.to_string())
