"""0DTE bear call spreads with intraday stop-loss / take-profit rules, from the 1-minute chain.

    .venv/bin/python src/spread_stops.py [--workers 6]

Entry: 12:00 and 14:00; short strike = first strike at/beyond spot + m * implied (m = 0.5, 1.0)
or chosen by credit (3-4 points); widths 10 and 15. Rules, all judged on the spread's mid
value (what it costs to close) and filled on the NEXT usable minute at mid + k*H:
  hold           : settle
  sl2x / sl3x    : close when value >= 2x / 3x the credit received
  sl_touch       : close when spot >= short strike
  tp50 / tp80    : close when value <= 50% / 20% of credit (keep 50% / 80% of it)
  combos         : tp50 + sl2x, tp50 + sl3x, tp80 + sl2x
Win = PnL > 0 at k = 0.25 after fees.  Half days excluded.
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

F, CLEAN = S.F, S.CLEAN
TABLES = os.path.join(S.ROOT, S.CFG["paths"]["reports"], "spread_tables")
ENTRIES = ["12:00", "14:00"]
WIDTHS = [10, 15]
SHORT = [("m0.5", 0.5), ("m1.0", 1.0), ("c3-4", None)]
RULES = {"hold": {}, "sl2x": {"sl": 2.0}, "sl3x": {"sl": 3.0}, "sl_touch": {"touch": True}, "tp50": {"tp": 0.5}, "tp80": {"tp": 0.2},
         "tp50_sl2x": {"tp": 0.5, "sl": 2.0}, "tp50_sl3x": {"tp": 0.5, "sl": 3.0}, "tp80_sl2x": {"tp": 0.2, "sl": 2.0}}
K = 0.25
N_MIN = 390


def minute_of(ts):
    return (ts.hour - 9) * 60 + ts.minute - 30


def leg_arrays(df, strike, right):
    g = df[(df.strike == strike) & (df.right == right) & ~df.flag_bad]
    b = np.full(N_MIN, np.nan); a = np.full(N_MIN, np.nan)
    m = ((g.ts.dt.hour - 9) * 60 + g.ts.dt.minute - 30).values
    b[m] = g.bid.values; a[m] = g.ask.values
    return b, a


def simulate(V, H, e, credit, k_short, spot_min, settle, w, fee_leg):
    """V: spread value (cost to close, points) by minute; H: sum of half spreads. Returns dict rule->(pnl, reason, exit_min)."""
    out = {}
    for name, r in RULES.items():
        x, reason = None, "settle"
        for t in range(e + 1, N_MIN):
            v = V[t]
            hit = None
            if r.get("touch") and spot_min[t] >= k_short:
                hit = "touch"
            elif "sl" in r and not np.isnan(v) and v >= r["sl"] * credit:
                hit = "sl"
            elif "tp" in r and not np.isnan(v) and v <= r["tp"] * credit:
                hit = "tp"
            if hit:
                nxt = np.where(~np.isnan(V[t + 1:]))[0]
                if len(nxt):
                    x, reason = t + 1 + int(nxt[0]), hit
                else:
                    reason = hit + "_settled"
                break
        if x is None:
            loss = min(max(0.0, settle - k_short), w)
            pnl = (credit - loss - K * H[e]) * F["multiplier"] - 2 * fee_leg
        else:
            pnl = (credit - K * H[e] - (V[x] + K * H[x])) * F["multiplier"] - 4 * fee_leg
        out[name] = (pnl, reason, x if x is not None else N_MIN)
    return out


def day(args):
    path, spot_day, settle, date = args
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    spot_min = np.full(N_MIN, np.nan)
    sm = ((spot_day.index.hour - 9) * 60 + spot_day.index.minute - 30).values
    spot_min[sm] = spot_day.values
    out = []
    for e_str in ENTRIES:
        t0 = pd.Timestamp(f"{date.date()} {e_str}")
        if t0 not in spot_day.index:
            continue
        e = minute_of(t0); s0 = float(spot_day.loc[t0])
        q = S.snap_mids(df, t0)
        if q.empty:
            continue
        strikes = np.sort(q.index.get_level_values(0).unique().values)
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            imp = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        for w in WIDTHS:
            for tag, m in SHORT:
                if m is not None:
                    cands = strikes[strikes >= s0 + m * imp]
                    if len(cands) == 0:
                        continue
                    ks = float(cands.min())
                else:
                    ks = None
                    for cand in strikes[strikes >= s0 - 30]:
                        try:
                            cr = float(q.loc[(cand, "C"), "mid"] - q.loc[(cand + w, "C"), "mid"])
                        except KeyError:
                            continue
                        if 3.0 <= cr <= 4.0:
                            ks = float(cand); break
                    if ks is None:
                        continue
                kl = ks + w
                try:
                    sh, lo = q.loc[(ks, "C")], q.loc[(kl, "C")]
                except KeyError:
                    continue
                credit = float(sh.mid - lo.mid)
                if credit <= 0:
                    continue
                bs, as_ = leg_arrays(df, ks, "C"); bl, al = leg_arrays(df, kl, "C")
                V = (bs + as_) / 2 - (bl + al) / 2                      # cost to close the spread, points
                H = (as_ - bs) / 2 + (al - bl) / 2
                fee_leg = float(fills.leg_fee(np.array([sh.mid]), F)[0])
                res = simulate(V, H, e, credit, ks, spot_min, settle, w, fee_leg)
                for rule, (pnl, reason, x) in res.items():
                    out.append({"date": date, "entry": e_str, "width": w, "short": tag, "rule": rule, "k_short": ks, "dist": ks - s0,
                                "implied": imp, "credit": credit, "credit_pct": credit / w, "pnl": pnl, "win": pnl > 0, "reason": reason,
                                "minutes": x - e, "max_loss_usd": (w - credit) * F["multiplier"]})
    return out


def main():
    a = argparse.ArgumentParser(); a.add_argument("--workers", type=int, default=6); x = a.parse_args()
    os.makedirs(TABLES, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet")); spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, spot[spot.index.normalize() == d], float(cal.loc[d, "settle"]), d) for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for dd in ex.map(day, jobs, chunksize=8) for r in dd]
    p = pd.DataFrame(rows); p.to_parquet(os.path.join(CLEAN, "spread_stops_panel.parquet"), index=False)
    p["year"] = p.date.dt.year
    def stats(g):
        n = len(g); lo, hi = S.wilson(int(g.win.sum()), n); wins, losses = g.pnl[g.pnl > 0], g.pnl[g.pnl < 0]
        return pd.Series({"n": n, "win": g.win.mean(), "win_lo": lo, "win_hi": hi, "ev": g.pnl.mean(), "ev_pct_risk": g.pnl.mean() / g.max_loss_usd.mean(),
                          "avg_win": wins.mean(), "avg_loss": losses.mean(), "worst": g.pnl.min(), "p5": g.pnl.quantile(.05), "stopped": (g.reason != "settle").mean(),
                          "avg_min": g.minutes.mean(), "credit_pct": g.credit_pct.mean()})
    t = p.groupby(["short", "width", "entry", "rule"], observed=True).apply(stats, include_groups=False).round(3)
    t.to_csv(os.path.join(TABLES, "stops_by_rule.csv"))
    y = p.groupby(["short", "width", "entry", "rule", "year"], observed=True).pnl.mean().unstack().round(0)
    y.to_csv(os.path.join(TABLES, "stops_by_year.csv"))
    pd.set_option("display.width", 240); pd.set_option("display.max_rows", 400)
    print(t.to_string())


if __name__ == "__main__":
    main()
