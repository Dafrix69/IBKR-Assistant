"""Step 4: the live weekly fly against the 0DTE fly.

    .venv/bin/python src/weekly_fly.py

Entry: Friday 15:00, SPXW expiring the next week, 50-wide put fly at ATM and at ATM-50.
Path: daily closing NBBO from greeks_eod. Greeks are recomputed here from those mids
(ThetaData's come from the last trade). Half days have no closing quotes and are skipped.

Exits, none of which trades on the quote that triggered it:
- hold: official close on expiry day, no exit spread or fee
- close_prior: closing NBBO of the last trading day before expiry
- cross_X: spot (TWS minutes) moves X from the center; filled at that day's closing NBBO.
  This is an approximation: the real exit would be at the crossing minute, and there are
  no intraday quotes for this expiry. On expiry day it settles.
- tp3: daily close >= 3x entry mid; filled at the NEXT close, or settled
- tp3_now: same trigger, filled at the trigger close. Optimistic, shown because with daily
  data a next-close fill almost always lands on expiry and tp3 degenerates into hold.
"""
import glob
import os
import sys

import numpy as np
import pandas as pd
import yaml
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402
import fly_grid as Y  # noqa: E402
import gex as G  # noqa: E402

ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])
RAW = os.path.join(ROOT, CFG["paths"]["raw"])
TABLES = os.path.join(ROOT, CFG["paths"]["reports"], "step4_tables")
FIGS = os.path.join(ROOT, CFG["paths"]["reports"], "figs")
W = CFG["weekly"]
F = CFG["fills"]
KS = F["k_levels"]
MULT = F["multiplier"]
QTY = np.array([1.0, 2.0, 1.0])
SIGN = np.array([1.0, -1.0, 1.0])


def put_greeks(F0, K, mid, T_years):
    """Delta (per share) and theta (USD-free, points per calendar day) of a put from its mid."""
    F0, K, mid = np.asarray(F0, float), np.asarray(K, float), np.asarray(mid, float)
    w = G.solve_total_var(mid, lambda x: G.black_price(F0, K, x, False))
    s = np.sqrt(w)
    d1 = (np.log(F0 / K) + w / 2) / s
    delta = ndtr(d1) - 1
    theta = -F0 * np.exp(-d1 ** 2 / 2) / np.sqrt(2 * np.pi) * s / (2 * T_years) / 365
    return delta, theta


def first_cross(spot, center, x):
    """First timestamp |spot - center| >= x, else None."""
    hit = spot[(spot - center).abs() >= x]
    return hit.index[0] if len(hit) else None


def exit_for(plan, closes, days, expiry, cost, cross_day=None, tp=None):
    """Exit day for a plan, or None for settlement. closes: value by day (NaN = no quote)."""
    if plan == "hold":
        return None
    if plan == "close_prior":
        before = [d for d in days if d < expiry and not np.isnan(closes[d])]
        return before[-1] if before else None
    if plan.startswith("cross"):
        if cross_day is None or cross_day >= expiry:
            return None
        later = [d for d in days if d >= cross_day and d < expiry and not np.isnan(closes[d])]
        return later[0] if later else None
    if plan in ("tp3", "tp3_now"):
        usable = [d for d in days if d < expiry and not np.isnan(closes[d])]
        for i, d in enumerate(usable):
            if closes[d] >= tp * cost:
                if plan == "tp3_now":
                    return d
                return usable[i + 1] if i + 1 < len(usable) else None
        return None
    raise ValueError(plan)


def load_entry(path):
    df = pd.read_csv(path, compression="gzip", usecols=["strike", "right", "bid", "ask"])
    df["mid"] = (df.bid + df.ask) / 2
    return df


def day_quotes(day, expiry):
    f = os.path.join(RAW, "SPXW/greeks_eod", day.strftime("%Y"), day.strftime("%Y%m%d") + ".csv.gz")
    df = pd.read_csv(f, compression="gzip", usecols=["expiration", "strike", "right", "bid", "ask"])
    df = df[pd.to_datetime(df.expiration) == expiry].copy()
    df["mid"] = (df.bid + df.ask) / 2
    return df


def plans():
    return ["hold", "close_prior", "tp3", "tp3_now"] + [f"cross{x}" for x in W["cross_x"]]


def run():
    os.makedirs(TABLES, exist_ok=True)
    os.makedirs(FIGS, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    tdays = cal.index
    trades, path, skipped = [], [], []
    for f in sorted(glob.glob(os.path.join(RAW, "SPXW/quote_weekly_entry/*/*.csv.gz"))):
        ymd, exp = os.path.basename(f)[:17].split("_")
        d0, expiry = pd.Timestamp(ymd), pd.Timestamp(exp)
        if expiry not in cal.index:
            skipped.append((ymd, "expiry beyond the data"))
            continue
        t0 = pd.Timestamp(f"{d0.date()} {W['entry']}")
        if t0 not in spot.index:
            skipped.append((ymd, "no spot"))
            continue
        s0 = float(spot.loc[t0])
        ent = load_entry(f)
        put = ent[(ent.right == "PUT") & (ent.bid > 0) & (ent.ask >= ent.bid)].set_index("strike")
        if put.empty:
            skipped.append((ymd, "no quotes"))
            continue
        atm = float(put.index[np.abs(put.index.values - s0).argmin()])
        settle = float(cal.loc[expiry, "settle"])
        days = list(tdays[(tdays > d0) & (tdays <= expiry)])
        quotes = {d: day_quotes(d, expiry).set_index(["strike", "right"]) for d in days if d < expiry}
        win = spot[(spot.index > t0) & (spot.index <= pd.Timestamp(f"{expiry.date()} 16:00"))]

        for off in W["centers"]:
            c = atm + off
            ks = [c - W["width"], c, c + W["width"]]
            if not all(k in put.index for k in ks):
                skipped.append((ymd, f"legs missing, center {off}"))
                continue
            q = put.loc[ks]
            cost = float((SIGN * QTY * q.mid.values).sum())
            H0 = float((QTY * (q.ask.values - q.bid.values) / 2).sum())
            if cost <= 0:
                skipped.append((ymd, f"non-positive cost, center {off}"))
                continue
            fee0 = float((QTY * fills.leg_fee(q.mid.values, F)).sum())
            closes, halves, mids = {}, {}, {}
            for d in days:
                if d == expiry:
                    continue
                try:
                    r = quotes[d].loc[[(k, "PUT") for k in ks]]
                    ok = (r.bid.values > 0).all() or (r.ask.values[1] > 0 and (r.bid.values >= 0).all())
                except KeyError:
                    ok = False
                if ok and (r.ask.values > 0).all():
                    closes[d] = float((SIGN * QTY * r.mid.values).sum())
                    halves[d] = float((QTY * (r.ask.values - r.bid.values) / 2).sum())
                    mids[d] = r.mid.values
                else:
                    closes[d] = np.nan
            # path record, Greeks from the day's mids
            for d, v in [(d0, cost)] + [(d, closes[d]) for d in days if d < expiry]:
                dte = (expiry - d).days + (1 / 24 if d == d0 else 0)
                s = s0 if d == d0 else float(cal.loc[d, "settle"])
                m = q.mid.values if d == d0 else mids.get(d)
                if m is None or np.isnan(v):
                    continue
                dl, th = put_greeks(s, np.array(ks), m, dte / 365)
                path.append({"entry_date": d0, "center": off, "date": d, "dte": (expiry - d).days, "value": v, "spot": s,
                             "delta": float((SIGN * QTY * dl).sum()) * MULT, "theta": float((SIGN * QTY * th).sum()) * MULT})
            for plan in plans():
                cross_day = None
                if plan.startswith("cross"):
                    ts = first_cross(win, c, float(plan[5:]))
                    cross_day = None if ts is None else ts.normalize()
                x = exit_for(plan, closes, days[:-1] + [expiry], expiry, cost, cross_day, W["tp"])
                rec = {"entry_date": d0, "expiry": expiry, "center": off, "plan": plan, "K": c, "cost": cost,
                       "spot0": s0, "exit_date": x if x is not None else expiry, "settled": x is None,
                       "days_held": ((x if x is not None else expiry) - d0).days}
                if x is None:
                    pay = fills.fly_settle_value(settle, c, W["width"])
                    rec["exit_value"] = pay
                    for k in KS:
                        rec[f"pnl_k{k}"] = (pay - (cost + k * H0)) * MULT - fee0
                else:
                    fee1 = float((QTY * fills.leg_fee(mids[x], F)).sum())
                    rec["exit_value"] = closes[x]
                    for k in KS:
                        rec[f"pnl_k{k}"] = ((closes[x] - k * halves[x]) - (cost + k * H0)) * MULT - fee0 - fee1
                trades.append(rec)
    t = pd.DataFrame(trades)
    p = pd.DataFrame(path)
    t.to_parquet(os.path.join(CLEAN, "weekly_trades.parquet"), index=False)
    p.to_parquet(os.path.join(CLEAN, "weekly_path.parquet"), index=False)
    pd.DataFrame(skipped, columns=["entry", "why"]).to_csv(os.path.join(TABLES, "skipped.csv"), index=False)
    print(len(t), "trades", t.entry_date.nunique(), "weeks; skipped", len(skipped))
    return t, p


def week_key(s):
    return s.dt.to_period("W-SUN").dt.start_time


def sharpe_ci(x, rng, n=4000):
    x = np.asarray(x, float)
    i = rng.integers(0, len(x), (n, len(x)))
    b = x[i]
    sr = b.mean(1) / b.std(1, ddof=1) * np.sqrt(52)
    return float(np.quantile(sr, .025)), float(np.quantile(sr, .975))


def compare_row(name, s, date_col, days_col, per_week_capital, rng, k):
    """s: one row per trade. Weekly PnL aggregates several trades in the same week."""
    p = s[Y.PK(k)].values
    eq = np.cumsum(p)
    wk = s.groupby(week_key(s[date_col]))[Y.PK(k)].sum()
    lo, hi = sharpe_ci(wk.values, rng)
    boot = p[rng.integers(0, len(p), (4000, len(p)))].mean(1)
    cap = s.cost.mean() * MULT
    capdays = (s.cost * MULT * s[days_col]).sum()
    wins, losses = p[p > 0], p[p < 0]
    years = (s[date_col].max() - s[date_col].min()).days / 365.25
    dd = (eq - np.maximum.accumulate(eq)).min()
    return {"plan": name, "calmar": p.sum() / years / -dd if dd < 0 else np.nan, "k": k, "trades": len(p), "ev_usd": p.mean(), "ci_lo": np.quantile(boot, .025), "ci_hi": np.quantile(boot, .975),
            "win": (p > 0).mean(), "payoff": wins.mean() / -losses.mean() if len(losses) else np.nan, "total_usd": p.sum(),
            "max_dd_usd": (eq - np.maximum.accumulate(eq)).min(), "avg_capital": cap, "ev_pct_capital": p.mean() / cap,
            "usd_per_100k_capital_day": p.sum() / capdays * 1e5, "avg_days": s[days_col].mean(),
            "sharpe": wk.mean() / wk.std(ddof=1) * np.sqrt(52), "sharpe_lo": lo, "sharpe_hi": hi, "weeks": len(wk)}


def tables(t, p):
    rng = np.random.default_rng(CFG["edge"]["seed"])
    start = t.entry_date.min()
    z = pd.read_parquet(os.path.join(CLEAN, "fly_trades.parquet"))
    z = z[z.date >= start]
    rows = []
    for k in KS:
        for c in W["centers"]:
            for plan in plans():
                s = t[(t.center == c) & (t.plan == plan)].sort_values("entry_date")
                rows.append(compare_row(f"weekly center {c:+d} {plan}", s, "entry_date", "days_held", None, rng, k))
        both = t[t.plan == "hold"].sort_values("entry_date")
        rows.append(compare_row("weekly both legs hold", both, "entry_date", "days_held", None, rng, k))
        for name, e, w, st in [("0DTE 14:00 25 put", "14:00", 25, "put_fly"), ("0DTE 14:00 25 iron", "14:00", 25, "iron_fly"),
                               ("0DTE 14:00 50 put", "14:00", 50, "put_fly"), ("0DTE 12:00 50 put", "12:00", 50, "put_fly")]:
            s = z[(z.entry == e) & (z.width == w) & (z.structure == st) & (z.rule == "hold")].sort_values("date").copy()
            s["held"] = s.minutes / (60 * 24)
            rows.append(compare_row(name, s, "date", "held", None, rng, k))
    # Honest 0DTE comparator: the walk-forward pick, not the best row of a table. Same months for all.
    wf = CFG["walkforward"]
    _, oos = Y.walk_forward(pd.read_parquet(os.path.join(CLEAN, "fly_trades.parquet")), wf, "per_risk")
    oos = oos.sort_values("date").assign(held=lambda x: x.minutes / (60 * 24))
    o0 = oos.date.min()
    for k in KS:
        rows.append(compare_row("OOS: 0DTE walk-forward per risk", oos, "date", "held", None, rng, k))
        fixed = z[(z.entry == "14:00") & (z.width == 25) & (z.structure == "put_fly") & (z.rule == "hold") & (z.date >= o0)].sort_values("date").copy()
        fixed["held"] = fixed.minutes / (60 * 24)
        rows.append(compare_row("OOS: 0DTE 14:00 25 put", fixed, "date", "held", None, rng, k))
        for c in W["centers"]:
            s = t[(t.center == c) & (t.plan == "hold") & (t.entry_date >= o0)].sort_values("entry_date")
            rows.append(compare_row(f"OOS: weekly center {c:+d} hold", s, "entry_date", "days_held", None, rng, k))
    pd.DataFrame(rows).round(3).to_csv(os.path.join(TABLES, "compare.csv"), index=False)

    y = t.assign(year=t.entry_date.dt.year).groupby(["center", "plan", "year"])[Y.PK(0.25)].mean().unstack().round(0)
    y.to_csv(os.path.join(TABLES, "by_year.csv"))
    z2 = z[(z.entry == "14:00") & (z.width == 25) & (z.structure == "put_fly") & (z.rule == "hold")]
    z2.groupby(z2.date.dt.year)[Y.PK(0.25)].sum().round(0).to_csv(os.path.join(TABLES, "zero_dte_year_sum.csv"))
    g = p.groupby(["center", "dte"])[["value", "delta", "theta"]].median().round(2)
    g["n"] = p.groupby(["center", "dte"]).size()
    g.to_csv(os.path.join(TABLES, "path_by_dte.csv"))

    # Paired weekly PnL, same weeks, to compare the two plans directly
    wk = t[(t.center == 0) & (t.plan == "hold")].set_index(week_key(t[(t.center == 0) & (t.plan == "hold")].entry_date))[Y.PK(0.25)]
    wz = z2.groupby(week_key(z2.date))[Y.PK(0.25)].sum()
    both = pd.concat([wk.rename("weekly"), wz.rename("zero")], axis=1, sort=True).dropna()
    both.to_csv(os.path.join(TABLES, "weekly_vs_0dte_paired.csv"))
    i = rng.integers(0, len(both), (4000, len(both)))
    a_, b_ = both.weekly.values[i], both.zero.values[i]
    md = (b_ - a_).mean(1)
    sd = b_.mean(1) / b_.std(1, ddof=1) * np.sqrt(52) - a_.mean(1) / a_.std(1, ddof=1) * np.sqrt(52)
    pd.DataFrame([{"weeks": len(both), "corr": both.corr().iloc[0, 1], "mean_diff_usd": (both.zero - both.weekly).mean(),
                   "mean_ci_lo": np.quantile(md, .025), "mean_ci_hi": np.quantile(md, .975),
                   "sharpe_diff_ci_lo": np.quantile(sd, .025), "sharpe_diff_ci_hi": np.quantile(sd, .975)}]).round(3).to_csv(os.path.join(TABLES, "paired_diff.csv"), index=False)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 4))
    for c in W["centers"]:
        s = t[(t.center == c) & (t.plan == "hold")].sort_values("entry_date")
        ax.plot(s.entry_date, s[Y.PK(0.25)].cumsum(), label=f"weekly center {c:+d}")
    s = z2.sort_values("date")
    ax.plot(s.date, s[Y.PK(0.25)].cumsum(), label="0DTE 14:00 25")
    ax.axhline(0, color="k", lw=.8); ax.set_ylabel("cumulative USD, 1 lot, k=0.25"); ax.legend()
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, "step4_curves.png"), dpi=130); plt.close(fig)


if __name__ == "__main__":
    tr, pa = run()
    tables(tr, pa)
