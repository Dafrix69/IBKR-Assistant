"""Opening-range breakout backtest, rules in SPEC.md. Offline: reads data/ only.

    ../spx_fly/.venv/bin/python backtest.py
"""
import glob
import itertools
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
COMM = 0.0035
NAMES = ("IREN", "AXTI", "LITE", "OKLO")  # the named set; LITE / OKLO added 2026-10-31, see SPEC
LEV = {"IREN": ("IREN", 1), "AXTI": ("AXTI", 1), "IRE": ("IREN", 2), "AXTX": ("AXTI", 2)}
NS, STOPS, SIDES, VOLS = (5, 15, 30), (0.5, 1.0), ("both", "long"), (0.0, 1.0, 1.5)
GRID = list(itertools.product(NS, STOPS, SIDES, VOLS))


def load_all_hours(sym, what):
    """Every bar on disk: 04:00-20:00 ET from the _EXT files (else regular hours) plus the
    OVERNIGHT session 20:00-03:50 from the _OVN files where they exist. `date` is the
    TRADING day: bars from 20:00 to midnight belong to the next calendar day's session."""
    fs = sorted(glob.glob(os.path.join(ROOT, "data", f"{sym}_{what}_EXT", "*.parquet")))
    fs = fs or sorted(glob.glob(os.path.join(ROOT, "data", f"{sym}_{what}", "*.parquet")))
    fs += sorted(glob.glob(os.path.join(ROOT, "data", f"{sym}_{what}_OVN", "*.parquet")))
    df = pd.concat([pd.read_parquet(f) for f in fs]).drop_duplicates("ts").sort_values("ts")
    df["m"] = df.ts.dt.hour * 60 + df.ts.dt.minute - 570  # minutes since 09:30, negative pre-market
    evening = df.m >= 630  # 20:00 and later: the overnight session that leads into the next day
    df["date"] = (df.ts + pd.to_timedelta(evening.astype(int), unit="D")).dt.date
    df.loc[evening, "m"] -= 1440  # so the overnight bars sort before 04:00 of their trading day
    return df


def load(sym, what):
    """Regular hours only, 09:30-15:59."""
    df = load_all_hours(sym, what)
    return df[(df.m >= 0) & (df.m < 390)]


def spread_by_minute(sym):
    """Median quoted spread as a fraction of mid, per 15-minute bucket of the day."""
    q = load(sym, "BID_ASK")
    q = q[(q.bid > 0) & (q.ask >= q.bid)]
    frac = (q.ask - q.bid) / ((q.ask + q.bid) / 2)
    return frac.groupby(q.m // 15).median()


def day_trade(d, n, f, side, vol_ok):
    """One day's bars -> (direction, entry index, entry px, exit index, exit px, stopped) or None."""
    if not vol_ok or len(d) < 380 or d.m.iloc[0] != 0:
        return None
    m, o, h, l, c = d.m.values, d.open.values, d.high.values, d.low.values, d.close.values
    k = int(np.searchsorted(m, n))
    if k == 0 or m[k - 1] != n - 1:
        return None
    hi, lo = h[:k].max(), l[:k].min()
    w = hi - lo
    if w <= 0:
        return None
    end = int(np.searchsorted(m, 385))  # the 15:55 bar
    for i in range(k, end - 1):
        if m[i] >= 330:  # no entries after 15:00
            return None
        up, dn = c[i] > hi, c[i] < lo
        if not (up or (dn and side == "both")):
            continue
        s = 1 if up else -1
        e = o[i + 1]
        stop = hi - f * w if s > 0 else lo + f * w
        if (e - stop) * s <= 0:  # opened through the stop, no trade
            return None
        for j in range(i + 1, end):
            if s > 0 and l[j] <= stop:
                return s, i + 1, e, j, min(stop, o[j]), True, abs(e - stop)
            if s < 0 and h[j] >= stop:
                return s, i + 1, e, j, max(stop, o[j]), True, abs(e - stop)
        return s, i + 1, e, end, o[end], False, abs(e - stop)
    return None


def vol_flags(df, n, mult):
    """Opening-range volume > mult x trailing 14-day mean, prior days only."""
    v = df[df.m < n].groupby("date").volume.sum()
    base = v.shift(1).rolling(14, min_periods=14).mean()
    return (v > mult * base) if mult > 0 else pd.Series(True, index=v.index)


def run(stock, cfg, seed=None):
    """Trades of one config on a stock frame. seed flips directions at random (baseline)."""
    n, f, side, vm = cfg
    flags = vol_flags(stock, n, vm)
    out = []
    rng = np.random.default_rng(seed) if seed is not None else None
    for date, d in stock.groupby("date", sort=True):
        t = day_trade(d, n, f, side, bool(flags.get(date, False)))
        if t is None:
            continue
        s, ie, e, ix, x, stopped, risk = t
        if rng is not None:  # same entry and exit times, random side
            s = rng.choice([-1, 1])
        out.append(dict(date=date, side=s, entry=e, exit=x, im=d.m.values[ie], xm=d.m.values[ix],
                        ts_e=d.ts.values[ie], ts_x=d.ts.values[ix], stopped=stopped, risk=risk))
    return pd.DataFrame(out)


def cost_frac(tr, spread, px_e, px_x, mult):
    """Round-trip cost as a fraction of notional for the instrument actually traded."""
    get = lambda m: spread.reindex(m // 15).ffill().bfill().values
    half_e, half_x = get(tr.im.values) / 2, get(tr.xm.values) / 2
    extra = np.where(tr.stopped, half_x, 0.0)  # stops cross a moving market
    comm = COMM / px_e + COMM / px_x
    return mult * (half_e + half_x + extra + comm)


def stock_returns(tr, spread, cost_mult=1.0):
    gross = tr.side * (tr.exit - tr.entry) / tr.entry
    return gross - cost_frac(tr, spread, tr.entry.values, tr.exit.values, cost_mult)


def etf_returns(tr, etf, spread, cost_mult=1.0):
    """Same times, real ETF prices. Long side only; shorts have no long-ETF equivalent."""
    t = tr[tr.side > 0].copy()
    px = etf.set_index("ts")
    e = px.open.reindex(pd.DatetimeIndex(t.ts_e, tz="UTC").tz_convert(px.index.tz)).values
    x = px.open.reindex(pd.DatetimeIndex(t.ts_x, tz="UTC").tz_convert(px.index.tz)).values
    ok = ~(np.isnan(e) | np.isnan(x))
    t, e, x = t[ok], e[ok], x[ok]
    return t, (x - e) / e - cost_frac(t, spread, e, x, cost_mult)


def daily(dates, r, all_dates):
    return pd.Series(np.asarray(r), index=pd.Index(dates)).groupby(level=0).sum().reindex(all_dates, fill_value=0.0)


def sharpe(x):
    s = x.std()
    return 0.0 if s == 0 else float(x.mean() / s * np.sqrt(252))


class Panel:
    """The named set loaded once: bars, spreads, the union of dates, which names have bars
    on each date, and the IS / OOS split (first 2/3 of dates by count, as in SPEC)."""

    def __init__(self, names=NAMES, what="TRADES"):
        self.names = [s for s in names if os.path.isdir(os.path.join(ROOT, "data", f"{s}_{what}"))
                      or os.path.isdir(os.path.join(ROOT, "data", f"{s}_{what}_EXT"))]
        self.stocks = {s: load(s, what) for s in self.names}
        self.spreads = {s: spread_by_minute(s) for s in self.names}
        self.dates = sorted(set().union(*(set(df.date) for df in self.stocks.values())))
        self.have = pd.DataFrame({s: pd.Series(1.0, index=sorted(set(df.date))) for s, df in self.stocks.items()}
                                 ).reindex(self.dates).fillna(0.0)
        self.cut = self.dates[int(len(self.dates) * 2 / 3)]
        self.is_d = [d for d in self.dates if d < self.cut]
        self.oos_d = [d for d in self.dates if d >= self.cut]

    def describe(self):
        print(f"names {self.names}  days {len(self.dates)}  {self.dates[0]}..{self.dates[-1]}"
              f"  OOS from {self.cut} ({len(self.oos_d)} days)")
        for s, df in self.stocks.items():
            print(f"  {s}: {df.date.nunique()} days from {df.date.min()}")

    def pool(self, per):
        """Equal-weight mean over the names that have bars that day; NaN where none has."""
        f = pd.DataFrame(per).reindex(self.dates).fillna(0.0)
        return (f * self.have).sum(axis=1) / self.have.sum(axis=1).replace(0, np.nan)


def block_ci(x, draws=10000, p=0.2, seed=7, alpha=0.05):
    """Stationary bootstrap (Politis-Romano) of the mean, block mean 1/p days."""
    a, n = np.asarray(x), len(x)
    rng = np.random.default_rng(seed)
    idx = np.empty((draws, n), dtype=int)
    idx[:, 0] = rng.integers(0, n, draws)
    for t in range(1, n):
        jump = rng.random(draws) < p
        idx[:, t] = np.where(jump, rng.integers(0, n, draws), (idx[:, t - 1] + 1) % n)
    means = a[idx].mean(axis=1)
    return float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))


def main():
    P = Panel()
    stocks, spreads, dates, is_d, oos_d = P.stocks, dict(P.spreads), P.dates, P.is_d, P.oos_d
    for etf in ("IRE", "AXTX"):
        spreads[etf] = spread_by_minute(etf)
    P.describe()
    print("median spread, bps of mid:", {k: round(float(v.median() * 1e4), 1) for k, v in spreads.items()})

    rows, trades = [], {}
    for cfg in GRID:
        rs = {}
        for s, df in stocks.items():
            tr = run(df, cfg)
            trades[(cfg, s)] = tr
            rs[s] = daily(tr.date, stock_returns(tr, spreads[s]), dates) if len(tr) else pd.Series(0.0, index=dates)
        pool = P.pool(rs).dropna()
        rows.append(dict(n=cfg[0], f=cfg[1], side=cfg[2], vol=cfg[3], is_sh=sharpe(pool.reindex(is_d).dropna()),
                         oos_sh=sharpe(pool.reindex(oos_d).dropna()), oos_bps=pool.reindex(oos_d).dropna().mean() * 1e4,
                         oos_trades=sum(int(trades[(cfg, s)].date.isin(oos_d).sum()) for s in stocks)))
    grid = pd.DataFrame(rows).sort_values("is_sh", ascending=False)
    grid.to_csv(os.path.join(ROOT, "grid.csv"), index=False)
    print(grid.round(2).to_string(index=False))
    print(f"OOS mean>0: {(grid.oos_bps > 0).sum()} of {len(grid)}")

    best = tuple(grid.iloc[0][["n", "f", "side", "vol"]])
    best = (int(best[0]), float(best[1]), best[2], float(best[3]))
    print("PICK (best in-sample):", best)

    def pooled(mult, seed=None):
        out = {}
        for s, df in stocks.items():
            tr = run(df, best, seed) if seed is not None else trades[(best, s)]
            out[s] = daily(tr.date, stock_returns(tr, spreads[s], mult), dates)
        return out, P.pool(out)

    per, pool = pooled(1.0)
    _, pool2 = pooled(2.0)
    o, o2 = pool.reindex(oos_d).dropna(), pool2.reindex(oos_d).dropna()
    i, i2 = pool.reindex(is_d).dropna(), pool2.reindex(is_d).dropna()
    lo, hi = block_ci(o.values)
    print(f"OOS net {o.mean()*1e4:.1f} bps/day  CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  Sharpe {sharpe(o):.2f}"
          f"  2x cost {o2.mean()*1e4:.1f} bps/day")
    print(f"IS  net {i.mean()*1e4:.1f} bps/day  Sharpe {sharpe(i):.2f}  2x cost {i2.mean()*1e4:.1f} bps/day")
    for s in per:
        tr = trades[(best, s)]
        oo = tr[tr.date.isin(oos_d)]
        print(f"  {s}: OOS {per[s].reindex(oos_d).mean()*1e4:.1f} bps/day, {len(oo)} trades, stopped {oo.stopped.mean():.0%}")

    hold = {s: df.groupby("date").apply(lambda d: d[d.m == 385].open.iloc[0] / d.open.iloc[0] - 1
                                        if (d.m == 385).any() else 0.0, include_groups=False)
            for s, df in stocks.items()}
    base = P.pool(hold).reindex(oos_d).dropna()
    print(f"baseline long open->15:55, gross: {base.mean()*1e4:.1f} bps/day")
    rand = [pooled(1.0, seed=k)[1].reindex(oos_d).dropna().mean() * 1e4 for k in range(200)]
    print(f"baseline random side: mean {np.mean(rand):.1f}, 95th pct {np.quantile(rand, .95):.1f} bps/day")

    print("\nSame signal, long trades only: stock vs real 2x ETF, ETF life only, per unit of exposure")
    for etf_sym in ("IRE", "AXTX"):
        under = LEV[etf_sym][0]
        etf = load(etf_sym, "TRADES")
        t, r = etf_returns(trades[(best, under)], etf, spreads[etf_sym])
        if not len(t):
            print(f"  {etf_sym}: no overlapping trades")
            continue
        sr = stock_returns(t, spreads[under])
        cost_s = cost_frac(t, spreads[under], t.entry.values, t.exit.values, 1).mean()
        cost_e = (spreads[etf_sym].median() + 0)  # quoted, for reference
        print(f"  {etf_sym}: {len(t)} trades  ETF net/2 {r.mean()/2*1e4:.1f} bps  stock net {sr.mean()*1e4:.1f} bps"
              f"  stock cost {cost_s*1e4:.1f} bps  ETF spread {cost_e*1e4:.1f} bps")


if __name__ == "__main__":
    main()
