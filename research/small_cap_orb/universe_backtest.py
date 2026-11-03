"""Universe test, rules in SPEC.md "Universe extension". Offline: reads universe/ only.
Configuration is the two-name pick carried over: 15-minute range, stop at the other side,
long only, no volume filter (the gap screen stands in for it).

    ../spx_fly/.venv/bin/python universe_backtest.py [--two-names]

--two-names: dry run of the same code on the IREN / AXTI weekly files restricted to their own
gap >= 3 % days, so the pipeline is checked before the universe minute bars exist.
"""
import argparse
import glob
import os

import numpy as np
import pandas as pd

import backtest as B

ROOT = os.path.dirname(os.path.abspath(__file__))
DAYS = os.path.join(ROOT, "universe", "days")
CFG = (15, 1.0, "long", 0.0)
IS_CUT = None  # set from the two-name split so both tests share dates


def two_name_candidates():
    rows = []
    for s in ("IREN", "AXTI"):
        df = B.load(s, "TRADES")
        d = df.groupby("date").agg(open=("open", "first"), close=("close", "last"))
        d["prev_close"] = d.close.shift(1)
        d["gap"] = d.open / d.prev_close - 1
        d = d[d.gap.abs() >= 0.03].reset_index()
        d["symbol"] = s
        d["dv20"] = np.nan
        rows.append(d[["date", "symbol", "gap", "prev_close", "dv20", "open"]])
    return pd.concat(rows), {s: B.load(s, "TRADES") for s in ("IREN", "AXTI")}


def load_day(sym, date):
    f = os.path.join(DAYS, "TRADES", f"{sym}_{date.strftime('%Y%m%d')}.parquet")
    if not os.path.exists(f):
        return None
    d = pd.read_parquet(f)
    d["date"] = d.ts.dt.date
    d["m"] = d.ts.dt.hour * 60 + d.ts.dt.minute - 570
    return d[(d.m >= 0) & (d.m < 390)]


def spread_model():
    """log(median spread fraction) ~ a + b log(price) + c log(dv20), per 15-minute bucket, fitted
    on the sampled BID_ASK days. Returns bucket -> (a, b, c) and the fit summary."""
    cand = pd.read_csv(os.path.join(ROOT, "universe", "candidates.csv"), parse_dates=["date"])
    rows = []
    for f in glob.glob(os.path.join(DAYS, "BID_ASK", "*.parquet")):
        sym, ymd = os.path.basename(f)[:-8].rsplit("_", 1)
        q = pd.read_parquet(f)
        q = q[(q.bid > 0) & (q.ask >= q.bid)]
        if q.empty:
            continue
        m = q.ts.dt.hour * 60 + q.ts.dt.minute - 570
        frac = (q.ask - q.bid) / ((q.ask + q.bid) / 2)
        med = frac.groupby(m // 15).median()
        c = cand[(cand.symbol == sym) & (cand.date == pd.Timestamp(ymd))]
        if c.empty:
            continue
        for b, v in med.items():
            rows.append(dict(bucket=int(b), spread=float(v), px=float(c.open.iloc[0]), dv=float(c.dv20.iloc[0])))
    s = pd.DataFrame(rows)
    s = s[s.spread > 0]
    coef = {}
    for b, g in s.groupby("bucket"):
        X = np.column_stack([np.ones(len(g)), np.log(g.px), np.log(g.dv)])
        beta, *_ = np.linalg.lstsq(X, np.log(g.spread), rcond=None)
        coef[b] = beta
    return coef, s


def predict_spread(coef, bucket, px, dv):
    b = coef[bucket] if bucket in coef else coef[min(coef, key=lambda k: abs(k - bucket))]
    return float(np.exp(b[0] + b[1] * np.log(px) + b[2] * np.log(dv)))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--two-names", action="store_true")
    a = p.parse_args()

    two = {s: B.load(s, "TRADES") for s in ("IREN", "AXTI")}
    all_dates = sorted(set(two["IREN"].date) & set(two["AXTI"].date))
    cut = all_dates[int(len(all_dates) * 2 / 3)]

    if a.two_names:
        cand, frames = two_name_candidates()
        spreads = {s: B.spread_by_minute(s) for s in two}
        get_day = lambda s, d: frames[s][frames[s].date == d]
        cost = lambda tr, s, px_e, px_x, mult: B.cost_frac(tr, spreads[s], px_e, px_x, mult)
    else:
        cand = pd.read_csv(os.path.join(ROOT, "universe", "candidates.csv"), parse_dates=["date"])
        cand["date"] = cand.date.dt.date
        coef, fit = spread_model()
        print(f"spread model fitted on {fit.groupby(['px', 'dv']).ngroups} symbol-days; coefficients at 09:30 bucket"
              f" (a, b_price, b_dollarvol) = {np.round(coef[0], 3)}")
        get_day = lambda s, d: load_day(s, pd.Timestamp(d))

        def cost(tr, s, px_e, px_x, mult):
            sp_e = np.array([predict_spread(coef, int(m // 15), px, dv) for m, px, dv in zip(tr.im, px_e, tr.dv20)])
            sp_x = np.array([predict_spread(coef, int(m // 15), px, dv) for m, px, dv in zip(tr.xm, px_x, tr.dv20)])
            extra = np.where(tr.stopped, sp_x / 2, 0.0)
            return mult * (sp_e / 2 + sp_x / 2 + extra + B.COMM / px_e + B.COMM / px_x)

    trades, missing, drift = [], 0, []
    for r in cand.itertuples():
        d = get_day(r.symbol, r.date)
        if d is None or len(d) < 380:
            missing += 1
            continue
        drift.append(dict(date=r.date, r=d[d.m == 385].open.iloc[0] / d.open.iloc[0] - 1 if (d.m == 385).any() else 0.0))
        t = B.day_trade(d, CFG[0], CFG[1], CFG[2], True)
        if t is None:
            continue
        s, ie, e, ix, x, stopped, risk = t
        trades.append(dict(date=r.date, symbol=r.symbol, side=s, entry=e, exit=x, im=d.m.values[ie], xm=d.m.values[ix],
                           stopped=stopped, risk=risk, dv20=r.dv20, gap=r.gap))
    tr = pd.DataFrame(trades)
    print(f"candidates {len(cand)}, days without bars {missing}, trades {len(tr)} on {tr.date.nunique()} days,"
          f" distinct symbols {tr.symbol.nunique()}, stopped {tr.stopped.mean():.0%}")

    def daily_net(mult, seed=None):
        side = tr.side.values
        if seed is not None:
            side = np.random.default_rng(seed).choice([-1, 1], len(tr))
        gross = side * (tr.exit - tr.entry) / tr.entry
        if a.two_names:
            c = np.concatenate([cost(tr[tr.symbol == s], s, tr[tr.symbol == s].entry.values, tr[tr.symbol == s].exit.values, mult)
                                for s in ("IREN", "AXTI")])
            order = np.concatenate([np.flatnonzero(tr.symbol == s) for s in ("IREN", "AXTI")])
            cc = np.empty(len(tr)); cc[order] = c
        else:
            cc = cost(tr, None, tr.entry.values, tr.exit.values, mult)
        net = gross - cc
        return net.groupby(tr.date).mean()  # equal weight per trade, per-day mean

    is_d = [d for d in all_dates if d < cut]
    oos_d = [d for d in all_dates if d >= cut]
    for label, mult in (("net", 1.0), ("2x cost", 2.0)):
        dn = daily_net(mult)
        o, i = dn.reindex(oos_d).dropna(), dn.reindex(is_d).dropna()
        lo, hi = B.block_ci(o.values)
        print(f"{label:8} IS {i.mean()*1e4:6.1f} bps/day (Sharpe {B.sharpe(i):.2f}, {len(i)} days)"
              f"  OOS {o.mean()*1e4:6.1f} bps/day  CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  Sharpe {B.sharpe(o):.2f}  {len(o)} days")
    dr = pd.DataFrame(drift).groupby("date").r.mean().reindex(oos_d).dropna()
    print(f"baseline long open->15:55 on the same candidates, gross: OOS {dr.mean()*1e4:.1f} bps/day")
    rand = [daily_net(1.0, seed=i).reindex(oos_d).dropna().mean() * 1e4 for i in range(200)]
    print(f"baseline random side: mean {np.mean(rand):.1f}, 95th pct {np.quantile(rand, .95):.1f} bps/day")
    o = tr[tr.date >= cut]
    print(f"OOS by gap sign: up-gap trades {(o.gap > 0).sum()}, down-gap trades {(o.gap < 0).sum()}")
    tr.to_csv(os.path.join(ROOT, "universe", "trades_two_names.csv" if a.two_names else "trades.csv"), index=False)


if __name__ == "__main__":
    main()
