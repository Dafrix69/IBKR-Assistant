"""Option-wall hypotheses, rules in SPEC.md "Option walls". Offline: reads data/ and the
ThetaData day files only. Run after backtest.py has written grid.csv.

    ../spx_fly/.venv/bin/python walls.py
"""
import datetime as dt
import gzip
import os

import numpy as np
import pandas as pd

import backtest as B

RAW = os.path.expanduser("~/Data/thetadata")
MAX_DTE, BAND, MIN_OI = 30, 0.25, 500


def day_file(sym, ds, d):
    return os.path.join(RAW, sym, ds, d.strftime("%Y"), d.strftime("%Y%m%d") + ".csv.gz")


def read(path, cols):
    if not os.path.exists(path):
        return None
    with gzip.open(path, "rt") as f:
        df = pd.read_csv(f, usecols=cols)
    return df if len(df) else None


def compute_wall(oi, gk, spot, date):
    """oi: open interest known on `date`. gk: prior day's EOD gamma. Pure, tested synthetically."""
    m = oi.merge(gk[["expiration", "strike", "right", "gamma"]], on=["expiration", "strike", "right"])
    dte = (pd.to_datetime(m.expiration) - pd.Timestamp(date)).dt.days
    m = m[(dte >= 0) & (dte <= MAX_DTE) & (m.strike.between(spot * (1 - BAND), spot * (1 + BAND)))]
    if m.empty:
        return None
    m = m.assign(gex=m.gamma * m.open_interest * 100 * spot ** 2 * 0.01)
    g = m.groupby(["right", "strike"]).agg(gex=("gex", "sum"), oi=("open_interest", "sum")).reset_index()
    calls, puts = g[(g.right == "CALL") & (g.strike > spot)], g[(g.right == "PUT") & (g.strike < spot)]
    out = dict(date=date, spot=spot, net=g[g.right == "CALL"].gex.sum() - g[g.right == "PUT"].gex.sum(),
               call_wall=np.nan, put_wall=np.nan)
    if len(calls):
        top = calls.loc[calls.gex.idxmax()]
        if top.oi >= MIN_OI:
            out["call_wall"] = float(top.strike)
    if len(puts):
        top = puts.loc[puts.gex.idxmax()]
        if top.oi >= MIN_OI:
            out["put_wall"] = float(top.strike)
    return out


def build_walls(sym, dates):
    out, prev = [], None
    for d in dates:
        if prev is not None:
            oi = read(day_file(sym, "oi", d), ["expiration", "strike", "right", "open_interest"])
            gk = read(day_file(sym, "greeks_eod", prev), ["expiration", "strike", "right", "gamma", "underlying_price"])
            if oi is not None and gk is not None:
                w = compute_wall(oi, gk, float(gk.underlying_price.median()), d)
                if w:
                    out.append(w)
        prev = d
    return pd.DataFrame(out).set_index("date")


def touch_test(stock, walls, seed=11):
    """A: signed 30-minute return after the first touch, real wall vs shuffled-distance placebo."""
    rng = np.random.default_rng(seed)
    dist_c = (walls.call_wall / walls.spot - 1).dropna().values
    dist_p = (1 - walls.put_wall / walls.spot).dropna().values
    rows = []
    for date, d in stock.groupby("date", sort=True):
        if date not in walls.index or len(d) < 380:
            continue
        w = walls.loc[date]
        for side, lvl, pool in ((1, w.call_wall, dist_c), (-1, w.put_wall, dist_p)):
            if np.isnan(lvl):
                continue
            placebo = w.spot * (1 + side * rng.choice(pool))
            r, p = after_touch(d, side, lvl), after_touch(d, side, placebo)
            if r is not None and p is not None:
                rows.append(dict(date=date, real=r, placebo=p))
    return pd.DataFrame(rows)


def after_touch(d, side, level):
    """First bar reaching level; return from level over 30 min, positive = away from the wall.
    A level already passed at the open is not a touch from the prior close's side."""
    o, h, l, c = d.open.values, d.high.values, d.low.values, d.close.values
    if (side > 0 and o[0] >= level) or (side < 0 and o[0] <= level):
        return None
    hit = np.nonzero(h >= level if side > 0 else l <= level)[0]
    if not len(hit) or hit[0] + 30 >= len(c):
        return None
    return -side * (c[hit[0] + 30] - level) / level


def overlay(name, tr, stock, walls, spread):
    """Net per-trade returns of one overlay, indexed by trade date."""
    t = tr[tr.date.isin(walls.index)].copy()
    w = walls.loc[t.date]
    t["wall"] = np.where(t.side > 0, w.call_wall.values, w.put_wall.values)
    t["net"] = w.net.values
    if name == "W1":
        room = (t.wall - t.entry) * t.side
        t = t[~((room > 0) & (room < t.width_range))]
    elif name == "W2":
        t = apply_target(t, stock)
    elif name == "W3":
        t = t[t.wall.isna() | ((t.entry - t.wall) * t.side > 0)]
    elif name == "W4-":
        t = t[t.net < 0]
    elif name == "W4+":
        t = t[t.net >= 0]
    return t, B.stock_returns(t, spread) if len(t) else pd.Series(dtype=float)


def apply_target(t, stock):
    """Exit at the wall on the first touch after entry and before the base exit."""
    by = dict(tuple(stock.groupby("date")))
    t = t.copy()
    for i, r in t.iterrows():
        if np.isnan(r.wall) or (r.wall - r.entry) * r.side <= 0:
            continue
        d = by[r.date]
        s = d[(d.m > r.im) & (d.m <= r.xm)]
        hit = s[s.high >= r.wall] if r.side > 0 else s[s.low <= r.wall]
        if len(hit):
            t.loc[i, ["exit", "xm", "stopped"]] = [r.wall, int(hit.m.iloc[0]), False]
    t["xm"] = t.xm.astype(int)
    t["stopped"] = t.stopped.astype(bool)
    return t


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--names", nargs="*", default=list(B.NAMES))
    ap.add_argument("--grid", default="grid.csv", help="ORB grid whose top row is the base config for B")
    a = ap.parse_args()
    grid = pd.read_csv(os.path.join(B.ROOT, a.grid))
    top = grid.iloc[0]
    cfg = (int(top.n), float(top.f), top.side, float(top.vol))
    P = B.Panel(a.names)
    stocks, spreads, dates, is_d, oos_d = P.stocks, P.spreads, P.dates, P.is_d, P.oos_d
    P.describe()
    walls = {s: build_walls(s, dates) for s in stocks}
    for s, w in walls.items():
        print(f"{s}: wall days {len(w)}, call wall {w.call_wall.notna().mean():.0%},"
              f" put wall {w.put_wall.notna().mean():.0%}, from {w.index.min()}")
        w.to_csv(os.path.join(B.ROOT, f"walls_{s}.csv"))

    print("\nA. after first touch, 30-minute return, + = rejected by the wall, bps")
    all_t = []
    for s in stocks:
        t = touch_test(stocks[s], walls[s])
        all_t.append(t)
        print(f"  {s}: n={len(t)} real {t.real.mean()*1e4:.1f}  placebo {t.placebo.mean()*1e4:.1f}")
    t = pd.concat(all_t).sort_values("date")
    diff = (t.real - t.placebo).groupby(t.date).mean()
    lo, hi = B.block_ci(diff.values)
    print(f"  pooled paired difference {diff.mean()*1e4:.1f} bps  CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  days {len(diff)}")

    print(f"\nB. overlays on base {cfg}, bps/day")
    base = {}
    for s, df in stocks.items():
        tr = B.run(df, cfg)
        tr["width_range"] = tr.risk / cfg[1]
        base[s] = tr
    names = ("BASE", "W1", "W2", "W3", "W4-", "W4+")
    day = {}
    for nm in names:
        parts = {}
        for s, df in stocks.items():
            t, r = overlay("none" if nm == "BASE" else nm, base[s], df, walls[s], spreads[s])
            parts[s] = B.daily(t.date, r, dates) if len(t) else pd.Series(0.0, index=dates)
        day[nm] = P.pool(parts).dropna()
    for nm in names:
        d = (day[nm] - day["BASE"]).reindex(oos_d).dropna()
        di = (day[nm] - day["BASE"]).reindex(is_d).dropna()
        o, i = day[nm].reindex(oos_d).dropna(), day[nm].reindex(is_d).dropna()
        lo, hi = block_ci_level(d.values)
        print(f"  {nm:5} IS {i.mean()*1e4:6.1f}  OOS {o.mean()*1e4:6.1f}  Sharpe {B.sharpe(o):5.2f}"
              f"  OOS diff {d.mean()*1e4:6.1f}  98.75% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  IS diff {di.mean()*1e4:.1f}")


def block_ci_level(x, draws=10000, p=0.2, seed=7, alpha=0.0125):
    a, n = np.asarray(x), len(x)
    rng = np.random.default_rng(seed)
    idx = np.empty((draws, n), dtype=int)
    idx[:, 0] = rng.integers(0, n, draws)
    for t in range(1, n):
        jump = rng.random(draws) < p
        idx[:, t] = np.where(jump, rng.integers(0, n, draws), (idx[:, t - 1] + 1) % n)
    m = a[idx].mean(axis=1)
    return float(np.quantile(m, alpha / 2)), float(np.quantile(m, 1 - alpha / 2))


if __name__ == "__main__":
    main()
