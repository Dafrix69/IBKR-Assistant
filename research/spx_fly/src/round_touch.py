"""Touches of big round-number levels (multiples of 50 / 100) from above, window 09:30-15:00,
and the fly placed above them.  .venv/bin/python src/round_touch.py [--workers 6]
Variants: r50 = nearest multiple of 50 below spot; r100 = multiple of 100; r50_oi = multiple of 50
that is also the max-0DTE-put-OI strike below spot (a round number that is also the OI wall).
"""
import argparse, glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wall_factors as W, wall_touch as T, winrate_study as S

def first_touch(win, level_of):
    for t, s in win.items():
        lv = level_of(t, s)
        if lv is not None and s <= lv + T.TOUCH_PTS:
            return t, lv
    return None, None

def day(args):
    path, spot_day, settle, date = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "mid", "spread", "flag_bad"])
    win = spot_day[(spot_day.index.time < pd.Timestamp("15:00").time())]
    oi = W.oi_0dte("SPXW", date); put_oi = oi["PUT"] if oi is not None and "PUT" in oi else None
    def r50(t, s): return np.floor((s - 0.01) / 50) * 50
    def r100(t, s): return np.floor((s - 0.01) / 100) * 100
    def r50_oi(t, s):
        lv = r50(t, s)
        if put_oi is None: return None
        below = put_oi[(put_oi.index < s) & (put_oi.index >= s - 150) & (put_oi > 0)]
        return lv if len(below) and float(below.idxmax()) == lv else None
    out = []
    for kind, fn in (("r50", r50), ("r100", r100), ("r50_oi", r50_oi)):
        t, lv = first_touch(win, fn)
        if t is None: continue
        # skip touches in the very first minute (no quotes yet at 09:30)
        if t == spot_day.index[0]: t = spot_day.index[1]
        rec = T.measure(df, spot_day, t, settle); rec.update({"date": date, "kind": kind, "t": t, "level": lv}); out.append(rec)
    return out

if __name__ == "__main__":
    a = argparse.ArgumentParser(); a.add_argument("--workers", type=int, default=6); x = a.parse_args()
    cal = pd.read_parquet(os.path.join(S.CLEAN, "calendar.parquet")); spot = pd.read_parquet(os.path.join(S.CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d) for f in sorted(glob.glob(os.path.join(S.CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for dd in ex.map(day, jobs, chunksize=8) for r in dd]
    p = pd.DataFrame(rows); p.to_parquet(os.path.join(S.CLEAN, "round_touch_panel.parquet"), index=False)
    pd.set_option("display.width", 220)
    print(p.kind.value_counts().to_dict()); print(p.groupby("kind").t.apply(lambda s: (s.dt.hour + s.dt.minute / 60).median().round(2)).to_dict())
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
    t = pd.DataFrame(rows).round(3); t.to_csv(os.path.join(S.TABLES, "round_touch.csv"), index=False); print(t.to_string())
