"""What moves the WIN RATE of an ATM 0DTE fly held to settlement, and what it costs in EV.

    .venv/bin/python src/winrate_study.py panel [--workers 6]   # data/clean/winrate_panel.parquet
    .venv/bin/python src/winrate_study.py tables                # reports/winrate_tables/*.csv

Adds entries after 14:00 (not in the step-3 grid), the width expressed in units of the
implied move, the spot-to-center distance and the pre-entry realized range. Win = PnL > 0
at k = 0.25 after fees. Half days excluded. Out-of-sample split for filters: rules are
judged on days before 2024-11-01 and reported on days from then on.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402
import fly_grid as Y  # noqa: E402

ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])
TABLES = os.path.join(ROOT, CFG["paths"]["reports"], "winrate_tables")
F = CFG["fills"]
ENTRIES = ["09:35", "10:30", "12:00", "13:00", "14:00", "14:30", "15:00", "15:30"]
WIDTHS = [20, 25, 30, 50, 75]
K = 0.25
SPLIT = pd.Timestamp("2024-11-01")


def snap_mids(df, t):
    s = df[(df.ts == t) & ~df.flag_bad]
    return s.set_index(["strike", "right"])[["bid", "ask", "mid"]]


def fly_at(q, legs):
    try:
        r = q.loc[legs]
    except KeyError:
        return None
    sign, qty = np.array([1, -1, 1.0]), np.array([1, 2, 1.0])
    if len(legs) == 4:                                    # iron: long P wing, short P, short C, long C wing
        sign, qty = np.array([1, -1, -1, 1.0]), np.array([1, 1, 1, 1.0])
    mid = float((sign * qty * r.mid.values).sum())
    H = float((qty * (r.ask.values - r.bid.values) / 2).sum())
    fee = float((qty * fills.leg_fee(r.mid.values, F)).sum())
    return mid, H, fee


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
        q = snap_mids(df, t)
        if q.empty:
            continue
        strikes = q.index.get_level_values(0).unique().values
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            implied = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        pre = spot_day[(spot_day.index <= t) & (spot_day.index > t - pd.Timedelta(minutes=60))]
        rng60 = float(pre.max() - pre.min()) if len(pre) > 5 else np.nan
        for w in WIDTHS:
            for st, legs in (("put_fly", [(Kc - w, "P"), (Kc, "P"), (Kc + w, "P")]),
                             ("iron_fly", [(Kc - w, "P"), (Kc, "P"), (Kc, "C"), (Kc + w, "C")])):
                r = fly_at(q, legs)
                if r is None:
                    continue
                mid, H, fee = r
                if st == "iron_fly":
                    mid = w + mid                             # mid is the (negative) net credit; V = w - credit
                if mid <= 0:
                    continue
                pay = fills.fly_settle_value(settle, Kc, w)
                out.append({"date": date, "entry": e, "width": w, "structure": st, "K": Kc, "spot": s0,
                            "dist": abs(s0 - Kc), "implied": implied, "w_over_implied": w / implied,
                            "range60_over_implied": rng60 / implied if implied else np.nan,
                            "cost": mid, "payoff": pay, "pnl": (pay - mid - K * H) * F["multiplier"] - fee,
                            "pnl_k0": (pay - mid) * F["multiplier"] - fee, "pnl_k05": (pay - mid - 0.5 * H) * F["multiplier"] - fee})
    return out


def build_panel(workers):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if cal.loc[d, "half_day"]:
            continue
        jobs.append((f, float(cal.loc[d, "settle"]), spot[spot.index.normalize() == d]))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(day_rows, jobs, chunksize=8) for r in day]
    p = pd.DataFrame(rows)
    p["win"] = p.pnl > 0
    p.to_parquet(os.path.join(CLEAN, "winrate_panel.parquet"), index=False)
    print(len(p), "rows", p.date.nunique(), "days")


def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    ph = k / n
    d = 1 + z * z / n
    c = (ph + z * z / (2 * n)) / d
    h = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def stats(g):
    n = len(g)
    lo, hi = wilson(int(g.win.sum()), n)
    wins, losses = g.pnl[g.pnl > 0], g.pnl[g.pnl < 0]
    return pd.Series({"n": n, "win": g.win.mean(), "win_lo": lo, "win_hi": hi, "ev": g.pnl.mean(), "ev_k0": g.pnl_k0.mean(),
                      "ev_k05": g.pnl_k05.mean(), "avg_win": wins.mean(), "avg_loss": losses.mean(),
                      "payoff": wins.mean() / -losses.mean() if len(losses) else np.nan, "cost_usd": g.cost.mean() * 100})


def by(p, cols):
    return p.groupby(cols, observed=True).apply(stats, include_groups=False).round(3)


def tables():
    os.makedirs(TABLES, exist_ok=True)
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    lab = Y.regime_labels()[["date", "entry", "gamma_side", "event", "vix_t", "prev_ret", "weekday", "year"]]
    p = p.merge(lab, on=["date", "entry"], how="left")
    p["year"] = p.date.dt.year
    p["weekday"] = p.date.dt.day_name().str[:3]
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    for c in ["fomc", "cpi", "nfp", "pce"]:
        p[c] = p.date.map(cal[c])
    big = CFG["edge"]["prev_ret_big"]
    r = p.date.map(cal.spx_ret_prev)
    p["prev_ret"] = np.select([r >= big, r <= -big], ["big up", "big down"], "flat")
    p["period"] = np.where(p.date >= SPLIT, "test 2024-11+", "train <2024-11")

    by(p, ["structure", "entry", "width"]).to_csv(os.path.join(TABLES, "entry_width.csv"))
    pf = p[p.structure == "put_fly"].copy()

    pf["w_bucket"] = pd.cut(pf.w_over_implied, [0, .5, .75, 1, 1.25, 1.5, 2, 99], labels=["<0.5", "0.5-0.75", "0.75-1", "1-1.25", "1.25-1.5", "1.5-2", ">2"])
    by(pf, ["w_bucket"]).to_csv(os.path.join(TABLES, "width_over_implied.csv"))
    by(pf[pf.entry.isin(["12:00", "14:00", "15:00"])], ["entry", "w_bucket"]).to_csv(os.path.join(TABLES, "width_over_implied_by_entry.csv"))

    # Dynamic width: at each entry pick the width whose w/implied is closest to a target
    rows = []
    for e in ENTRIES:
        g = pf[pf.entry == e]
        for target in [1.0, 1.5, 2.0, 2.5, 3.0]:
            pick = g.assign(err=(g.w_over_implied - target).abs()).sort_values("err").groupby("date").head(1)
            rows.append(stats(pick).rename(f"{e} target {target}"))
        for w in WIDTHS:
            rows.append(stats(g[g.width == w]).rename(f"{e} fixed {w}"))
    pd.DataFrame(rows).round(3).to_csv(os.path.join(TABLES, "dynamic_width.csv"))

    pf["dist_bucket"] = pd.cut(pf.dist, [-0.01, 2.5, 5, 7.5, 10, 12.6], labels=["0-2.5", "2.5-5", "5-7.5", "7.5-10", "10-12.5"])
    by(pf[pf.width == 25], ["entry", "dist_bucket"]).to_csv(os.path.join(TABLES, "spot_distance_25w.csv"))

    pf["range_bucket"] = pd.qcut(pf.range60_over_implied, 4, labels=["q1 calm", "q2", "q3", "q4 busy"])
    by(pf[pf.width == 25], ["entry", "range_bucket"]).to_csv(os.path.join(TABLES, "pre_entry_range_25w.csv"))

    for col in ["year", "vix_t", "weekday", "prev_ret", "gamma_side", "fomc", "cpi", "nfp"]:
        by(pf[pf.width == 25], ["entry", col]).to_csv(os.path.join(TABLES, f"by_{col}_25w.csv"))

    # Filters: defined from steps 2/3 (and the tables above) on train, reported on test
    conds = {
        "no 09:35": lambda d: d.entry == "09:35",
        "no Thu before noon": lambda d: (d.weekday == "Thu") & d.entry.isin(["09:35", "10:30"]),
        "no afternoon after big down": lambda d: (d.prev_ret == "big down") & d.entry.isin(["12:00", "13:00", "14:00", "14:30", "15:00", "15:30"]),
        "no FOMC afternoon": lambda d: d.fomc & d.entry.isin(["12:00", "13:00", "14:00", "14:30", "15:00", "15:30"]),
        "no Wed 14:00+": lambda d: (d.weekday == "Wed") & d.entry.isin(["14:00", "14:30", "15:00", "15:30"]),
    }
    rows = []
    for name, fn in conds.items():
        for per, g in pf[pf.width == 25].groupby("period"):
            m = fn(g)
            if m.sum() < 10:
                continue
            a, b = stats(g[m]), stats(g[~m])
            rows.append({"condition": name, "period": per, "n_excluded": int(m.sum()), "win_excluded": a.win, "ev_excluded": a.ev,
                         "win_kept": b.win, "ev_kept": b.ev})
    pd.DataFrame(rows).round(3).to_csv(os.path.join(TABLES, "filters_train_test.csv"), index=False)

    # Stacked plan on the test period: later entry + width target + filters, vs the plain 14:00/25
    test = pf[pf.date >= SPLIT]
    plans = {}
    plans["14:00 fixed 25, no filter"] = test[(test.entry == "14:00") & (test.width == 25)]
    plans["15:00 fixed 25, no filter"] = test[(test.entry == "15:00") & (test.width == 25)]
    excl = lambda d: ((d.prev_ret == "big down") | d.fomc | (d.weekday == "Wed"))  # noqa: E731
    for e in ["14:00", "15:00", "15:30"]:
        g = test[test.entry == e]
        g1 = g.assign(err=(g.w_over_implied - 2.0).abs()).sort_values("err").groupby("date").head(1)
        plans[f"{e} width~2x implied, no filter"] = g1
        plans[f"{e} width~2x implied, filtered"] = g1[~excl(g1)]
        plans[f"{e} fixed 25, filtered"] = g[(g.width == 25) & ~excl(g)]
    pd.DataFrame({k: stats(v) for k, v in plans.items()}).T.round(3).to_csv(os.path.join(TABLES, "stacked_test_period.csv"))
    print("done")


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["panel", "tables"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    build_panel(x.workers) if x.cmd == "panel" else tables()
