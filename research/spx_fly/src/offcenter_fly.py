"""Off-center 25-wide put flies (center = ATM strike +/- 25, 50) vs ATM, held to settlement,
and whether the morning direction picks the right side.  .venv/bin/python src/offcenter_fly.py
"""
import glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fills, winrate_study as S
F = S.F
ENTRIES = ["10:30", "12:00", "14:00"]
OFFS = [-50, -25, 0, 25, 50]

def day(args):
    path, spot_day, settle, date = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    out = []
    open_ = float(spot_day.iloc[0])
    for e in ENTRIES:
        t = pd.Timestamp(f"{date.date()} {e}")
        if t not in spot_day.index:
            continue
        s0 = float(spot_day.loc[t]); q = S.snap_mids(df, t)
        if q.empty:
            continue
        strikes = q.index.get_level_values(0).unique().values
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            imp = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        for off in OFFS:
            K = Kc + off
            try:
                r = q.loc[[(K - 25, "P"), (K, "P"), (K + 25, "P")]]
            except KeyError:
                continue
            sign, qty = np.array([1, -1, 1.0]), np.array([1, 2, 1.0])
            mid = float((sign * qty * r.mid.values).sum()); H = float((qty * (r.ask.values - r.bid.values) / 2).sum())
            if mid <= 0:
                continue
            fee = float((qty * fills.leg_fee(r.mid.values, F)).sum())
            pnl = (fills.fly_settle_value(settle, K, 25) - mid - S.K * H) * F["multiplier"] - fee
            out.append({"date": date, "entry": e, "off": off, "cost": mid, "pnl": pnl, "win": pnl > 0, "implied": imp,
                        "morning": np.sign(s0 - open_), "settle_move": settle - s0})
    return out

if __name__ == "__main__":
    cal = pd.read_parquet(os.path.join(S.CLEAN, "calendar.parquet")); spot = pd.read_parquet(os.path.join(S.CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d) for f in sorted(glob.glob(os.path.join(S.CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(6) as ex:
        rows = [r for dd in ex.map(day, jobs, chunksize=8) for r in dd]
    p = pd.DataFrame(rows); p.to_parquet(os.path.join(S.CLEAN, "offcenter_panel.parquet"), index=False)
    pd.set_option("display.width", 200)
    g = p.groupby(["entry", "off"]).agg(n=("win", "size"), win=("win", "mean"), ev=("pnl", "mean"), cost=("cost", "mean"),
                                        avg_win=("pnl", lambda x: x[x > 0].mean()), avg_loss=("pnl", lambda x: x[x < 0].mean())).round(2)
    print(g.to_string())
    # follow the morning: shift the center in the direction of the open-to-entry move
    p["with_trend"] = np.sign(p.off) == p.morning
    x = p[p.off.abs() > 0]
    print(x.groupby(["entry", x.off.abs(), "with_trend"]).agg(n=("win", "size"), win=("win", "mean"), ev=("pnl", "mean")).round(2).to_string())
    # how often does the close land >= 50 above / below the 14:00 spot
    s = p[(p.entry == "14:00") & (p.off == 0)]
    print("14:00: close >= +50:", round((s.settle_move >= 50).mean(), 3), " <= -50:", round((s.settle_move <= -50).mean(), 3), " within +-25:", round((s.settle_move.abs() <= 25).mean(), 3))
    s = p[(p.entry == "10:30") & (p.off == 0)]
    print("10:30: close >= +50:", round((s.settle_move >= 50).mean(), 3), " <= -50:", round((s.settle_move <= -50).mean(), 3), " within +-25:", round((s.settle_move.abs() <= 25).mean(), 3))
    g.to_csv(os.path.join(S.TABLES, "offcenter_fly.csv"))
