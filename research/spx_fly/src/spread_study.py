"""0DTE credit spreads (bear call / bull put) held to settlement: win rate and EV.

    .venv/bin/python src/spread_study.py [--workers 6]

Short strike = first strike at or beyond spot + m * implied (m in SHORT_MULT), implied =
ATM straddle mid at entry. Width in points. Win = PnL > 0 at k = 0.25 after fees. Entries
from 10:30 on (the user enters after 10:00). Writes data/clean/spread_panel.parquet and
reports/spread_tables/*.csv.
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
import winrate_study as S  # noqa: E402

CLEAN, F, K = S.CLEAN, S.F, S.K
TABLES = os.path.join(S.ROOT, S.CFG["paths"]["reports"], "spread_tables")
ENTRIES = ["10:30", "12:00", "13:00", "14:00", "15:00"]
SHORT_MULT = [0.5, 1.0, 1.5, 2.0]
WIDTHS = [10, 25]
MULT = F["multiplier"]


def strike_at_or_beyond(strikes, level, direction):
    s = strikes[strikes >= level] if direction > 0 else strikes[strikes <= level]
    if len(s) == 0:
        return None
    return float(s.min() if direction > 0 else s.max())


def spread(q, k_short, k_long, right):
    try:
        sh, lo = q.loc[(k_short, right)], q.loc[(k_long, right)]
    except KeyError:
        return None
    credit = float(sh.mid - lo.mid)
    H = float((sh.ask - sh.bid) / 2 + (lo.ask - lo.bid) / 2)
    fee = float(fills.leg_fee(np.array([sh.mid, lo.mid]), F).sum())
    return credit, H, fee


def day_rows(args):
    path, settle, spot_day = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    out = []
    for e in ENTRIES:
        t = pd.Timestamp(f"{date.date()} {e}")
        if t not in spot_day.index:
            continue
        s0 = float(spot_day.loc[t])
        q = S.snap_mids(df, t)
        if q.empty:
            continue
        strikes = q.index.get_level_values(0).unique().values
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            implied = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        for m in SHORT_MULT:
            for w in WIDTHS:
                for side, right, d in (("bear_call", "C", 1), ("bull_put", "P", -1)):
                    ks = strike_at_or_beyond(strikes, s0 + d * m * implied, d)
                    if ks is None:
                        continue
                    kl = ks + d * w
                    r = spread(q, ks, kl, right)
                    if r is None or r[0] <= 0:
                        continue
                    credit, H, fee = r
                    loss = min(max(0.0, (settle - ks) * d), w)             # intrinsic of the spread at settle
                    out.append({"date": date, "entry": e, "side": side, "mult": m, "width": w, "spot": s0, "k_short": ks,
                                "dist": (ks - s0) * d, "implied": implied, "credit": credit, "credit_pct": credit / w,
                                "pnl": (credit - loss - K * H) * MULT - fee, "pnl_k0": (credit - loss) * MULT - fee,
                                "pnl_k05": (credit - loss - 0.5 * H) * MULT - fee, "max_loss_usd": (w - credit) * MULT})
    return out


def stats(g):
    n = len(g)
    lo, hi = S.wilson(int((g.pnl > 0).sum()), n)
    wins, losses = g.pnl[g.pnl > 0], g.pnl[g.pnl < 0]
    return pd.Series({"n": n, "win": (g.pnl > 0).mean(), "win_lo": lo, "win_hi": hi, "ev": g.pnl.mean(), "ev_k05": g.pnl_k05.mean(),
                      "credit_pct_of_width": (g.credit / (g.credit + g.max_loss_usd / MULT)).mean(), "dist_pts": g.dist.mean(), "avg_win": wins.mean(),
                      "avg_loss": losses.mean(), "ev_pct_of_risk": g.pnl.mean() / g.max_loss_usd.mean()})


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    os.makedirs(TABLES, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, float(cal.loc[d, "settle"]), spot[spot.index.normalize() == d])
            for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for day in ex.map(day_rows, jobs, chunksize=8) for r in day]
    p = pd.DataFrame(rows)
    p.to_parquet(os.path.join(CLEAN, "spread_panel.parquet"), index=False)
    r = p.date.map(cal.spx_ret_prev)
    big = S.CFG["edge"]["prev_ret_big"]
    p["prev_ret"] = np.select([r >= big, r <= -big], ["big up", "big down"], "flat")
    p["weekday"] = p.date.dt.day_name().str[:3]
    p["year"] = p.date.dt.year
    p["period"] = np.where(p.date >= S.SPLIT, "test", "train")
    gb = lambda cols, d=p: d.groupby(cols, observed=True).apply(stats, include_groups=False).round(3)  # noqa: E731
    gb(["side", "entry", "mult", "width"]).to_csv(os.path.join(TABLES, "entry_dist_width.csv"))
    gb(["side", "mult", "width", "year"]).to_csv(os.path.join(TABLES, "by_year.csv"))
    gb(["side", "entry", "prev_ret"], p[(p.mult == 1.0) & (p.width == 25)]).to_csv(os.path.join(TABLES, "prev_ret_1x_25.csv"))
    gb(["side", "entry", "weekday"], p[(p.mult == 1.0) & (p.width == 25)]).to_csv(os.path.join(TABLES, "weekday_1x_25.csv"))
    gb(["side", "period", "entry", "mult"], p[p.width == 25]).to_csv(os.path.join(TABLES, "train_test_25.csv"))
    print(len(p), "rows", p.date.nunique(), "days")


if __name__ == "__main__":
    main()
