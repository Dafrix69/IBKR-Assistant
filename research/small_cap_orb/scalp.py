"""VWAP entries and take-profit ladder, rules in SPEC.md "VWAP and take-profit exits".
Offline: reads data/ only. Runs on every name in NAMES that has TRADES bars, pools the
30 new configurations with the 36 ORB ones and picks by in-sample Sharpe across all 66.

    ../spx_fly/.venv/bin/python scalp.py
"""
import itertools
import os

import numpy as np
import pandas as pd

import backtest as B

ROOT = os.path.dirname(os.path.abspath(__file__))
NAMES = ("IREN", "AXTI", "LITE", "OKLO")
RULES, TPS, SIDES = ("ORB", "V1", "V2"), (None, 0.005, 0.01, 0.02, 0.03), ("both", "long")
GRID = list(itertools.product(RULES, TPS, SIDES))
N_ALL = 97  # 36 ORB + 30 here + 30 H1 + 1 H2 (SPEC); was 66 before the pre-market section was added
START, LAST_ENTRY, OR_N = 15, 330, 15  # V rules start at 09:45; opening range for stops


def vwap(d):
    tp = (d.high.values + d.low.values + d.close.values) / 3
    v = d.volume.values.astype(float)
    cv = np.cumsum(v)
    return np.where(cv > 0, np.cumsum(tp * v) / np.where(cv > 0, cv, 1), tp)


def or_width(d):
    k = int(np.searchsorted(d.m.values, OR_N))
    return float(d.high.values[:k].max() - d.low.values[:k].min())


def entry_orb(d, n, f, side):
    """First close outside the opening range -> (side, signal index, stop)."""
    m, h, l, c = d.m.values, d.high.values, d.low.values, d.close.values
    k = int(np.searchsorted(m, n))
    hi, lo = h[:k].max(), l[:k].min()
    w = hi - lo
    if w <= 0:
        return None
    for i in range(k, len(d) - 1):
        if m[i] >= LAST_ENTRY:
            return None
        if c[i] > hi:
            return 1, i, hi - f * w
        if c[i] < lo and side == "both":
            return -1, i, lo + f * w
    return None


def entry_v1(d, side):
    """Pullback: 5 closes on one side of VWAP, a bar whose range comes within 0.1 % of
    VWAP, then a close back on the original side -> trade that way at the next open."""
    m, h, l, c = d.m.values, d.high.values, d.low.values, d.close.values
    vw, w = vwap(d), or_width(d)
    k = int(np.searchsorted(m, START))
    armed = 0  # +1 / -1 once 5 straight closes are on that side, 0 otherwise
    touched = False
    for i in range(k, len(d) - 1):
        if m[i] >= LAST_ENTRY:
            return None
        above, below = c[i] > vw[i], c[i] < vw[i]
        if i >= 5 and all(c[i - j] > vw[i - j] for j in range(5)):
            touched = touched and armed == 1
            armed = 1
        elif i >= 5 and all(c[i - j] < vw[i - j] for j in range(5)):
            touched = touched and armed == -1
            armed = -1
        if armed == 0 or (armed < 0 and side != "both"):
            continue
        near = (l[i] <= vw[i] * 1.001) if armed > 0 else (h[i] >= vw[i] * 0.999)
        if near:
            touched = True
            continue  # the touch bar itself is not the signal
        if touched and ((armed > 0 and above) or (armed < 0 and below)):
            return armed, i, vw[i] - armed * 0.5 * w
    return None


def entry_v2(d, gap_sign, side):
    """First close through VWAP in the gap's direction; stop at the session extreme so far."""
    if gap_sign == 0 or (gap_sign < 0 and side != "both"):
        return None
    m, h, l, c = d.m.values, d.high.values, d.low.values, d.close.values
    vw = vwap(d)
    k = int(np.searchsorted(m, START))
    for i in range(k, len(d) - 1):
        if m[i] >= LAST_ENTRY:
            return None
        if gap_sign > 0 and c[i - 1] <= vw[i - 1] and c[i] > vw[i]:
            return 1, i, l[: i + 1].min()
        if gap_sign < 0 and c[i - 1] >= vw[i - 1] and c[i] < vw[i]:
            return -1, i, h[: i + 1].max()
    return None


def trade(d, sig, tp):
    """Fill the signal at the next open, run stop / take-profit / 15:55 exit.
    Stop on the bar's low or high, TP only on a close beyond it; a bar that does both
    counts as the stop. Returns the same tuple as backtest.day_trade."""
    if sig is None:
        return None
    s, i, stop = sig
    m, o, h, l, c = d.m.values, d.open.values, d.high.values, d.low.values, d.close.values
    end = int(np.searchsorted(m, 385))
    if i + 1 >= end:
        return None
    e = o[i + 1]
    if (e - stop) * s <= 0:
        return None
    target = e * (1 + s * tp) if tp else None
    for j in range(i + 1, end):
        if s > 0 and l[j] <= stop:
            return s, i + 1, e, j, min(stop, o[j]), True, abs(e - stop)
        if s < 0 and h[j] >= stop:
            return s, i + 1, e, j, max(stop, o[j]), True, abs(e - stop)
        if target is not None and (c[j] - target) * s >= 0:
            return s, i + 1, e, j, c[j], False, abs(e - stop)
    return s, i + 1, e, end, o[end], False, abs(e - stop)


def day_signal(d, rule, side, gap_sign):
    if rule == "ORB":
        return entry_orb(d, OR_N, 1.0, side)
    if rule == "V1":
        return entry_v1(d, side)
    return entry_v2(d, gap_sign, side)


def run(stock, cfg, seed=None):
    rule, tp, side = cfg
    prev_close = stock.groupby("date").close.last().shift(1)
    rng = np.random.default_rng(seed) if seed is not None else None
    out = []
    for date, d in stock.groupby("date", sort=True):
        if len(d) < 380 or d.m.iloc[0] != 0:
            continue
        pc = prev_close.get(date, np.nan)
        gap = 0 if np.isnan(pc) else int(np.sign(d.open.iloc[0] / pc - 1))
        t = trade(d, day_signal(d, rule, side, gap), tp)
        if t is None:
            continue
        s, ie, e, ix, x, stopped, risk = t
        if rng is not None:
            s = rng.choice([-1, 1])
        out.append(dict(date=date, side=s, entry=e, exit=x, im=d.m.values[ie], xm=d.m.values[ix],
                        ts_e=d.ts.values[ie], ts_x=d.ts.values[ix], stopped=stopped, risk=risk))
    return pd.DataFrame(out)


def main():
    P = B.Panel(NAMES)
    stocks, spreads, dates, is_d, oos_d, pool = P.stocks, P.spreads, P.dates, P.is_d, P.oos_d, P.pool
    P.describe()

    rows, trades = [], {}
    for cfg in GRID:
        per = {}
        for s, df in stocks.items():
            tr = run(df, cfg)
            trades[(cfg, s)] = tr
            per[s] = B.daily(tr.date, B.stock_returns(tr, spreads[s]), dates) if len(tr) else pd.Series(0.0, index=dates)
        p = pool(per).dropna()
        rows.append(dict(rule=cfg[0], tp=cfg[1], side=cfg[2], is_sh=B.sharpe(p.reindex(is_d).dropna()),
                         oos_sh=B.sharpe(p.reindex(oos_d).dropna()), oos_bps=p.reindex(oos_d).dropna().mean() * 1e4,
                         oos_trades=sum(int(trades[(cfg, s)].date.isin(oos_d).sum()) for s in stocks),
                         tp_hits=sum(int(((~trades[(cfg, s)].stopped) & (trades[(cfg, s)].xm < 385)).sum())
                                     for s in stocks if len(trades[(cfg, s)]))))
    grid = pd.DataFrame(rows).sort_values("is_sh", ascending=False)
    grid.to_csv(os.path.join(ROOT, "grid_scalp.csv"), index=False)
    print(grid.round(2).to_string(index=False))
    print(f"OOS mean>0: {(grid.oos_bps > 0).sum()} of {len(grid)}")

    orb = pd.read_csv(os.path.join(ROOT, "grid.csv")) if os.path.exists(os.path.join(ROOT, "grid.csv")) else None
    if orb is not None:
        print(f"best ORB in-sample Sharpe from grid.csv: {orb.is_sh.max():.2f}  (this grid: {grid.is_sh.max():.2f})")
    best = (grid.iloc[0].rule, None if pd.isna(grid.iloc[0].tp) else float(grid.iloc[0].tp), grid.iloc[0].side)
    print("PICK (best in-sample among the 30):", best)

    def pooled(mult, seed=None):
        per = {}
        for s, df in stocks.items():
            tr = run(df, best, seed) if seed is not None else trades[(best, s)]
            per[s] = B.daily(tr.date, B.stock_returns(tr, spreads[s], mult), dates)
        return per, pool(per)

    per, p = pooled(1.0)
    _, p2 = pooled(2.0)
    o = p.reindex(oos_d).dropna()
    q = 0.05 / N_ALL
    lo, hi = B.block_ci(o.values)
    lo2, hi2 = B.block_ci(o.values, alpha=q)
    print(f"OOS net {o.mean()*1e4:.1f} bps/day  95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]"
          f"  {100*(1-q):.1f}% CI [{lo2*1e4:.1f}, {hi2*1e4:.1f}]  Sharpe {B.sharpe(o):.2f}"
          f"  2x cost {p2.reindex(oos_d).dropna().mean()*1e4:.1f} bps/day  ({len(o)} days)")
    i = p.reindex(is_d).dropna()
    print(f"IS  net {i.mean()*1e4:.1f} bps/day  Sharpe {B.sharpe(i):.2f}")
    for s in per:
        tr = trades[(best, s)]
        oo = tr[tr.date.isin(oos_d)]
        tp_hit = ((~oo.stopped) & (oo.xm < 385)).mean() if len(oo) else float("nan")
        print(f"  {s}: OOS {per[s].reindex(oos_d).mean()*1e4:.1f} bps/day, {len(oo)} trades,"
              f" stopped {oo.stopped.mean():.0%}, took profit {tp_hit:.0%}")
    rand = [pooled(1.0, seed=k)[1].reindex(oos_d).dropna().mean() * 1e4 for k in range(200)]
    print(f"baseline random side: mean {np.mean(rand):.1f}, 95th pct {np.quantile(rand, .95):.1f} bps/day")
    print(f"multiple testing: {N_ALL} configurations in all; a pick needs the {100*(1-q):.1f}% CI to exclude 0")
    with open(os.path.join(ROOT, "result_scalp.txt"), "w") as f:
        f.write(grid.round(2).to_string(index=False) + "\n")
        f.write(f"PICK {best}  OOS net {o.mean()*1e4:.1f} bps/day  CI [{lo*1e4:.1f}, {hi*1e4:.1f}]"
                f"  2x cost {p2.reindex(oos_d).dropna().mean()*1e4:.1f}  random-side 95th {np.quantile(rand, .95):.1f}\n")


if __name__ == "__main__":
    main()
