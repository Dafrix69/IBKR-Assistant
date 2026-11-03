"""Short in the night / pre-market session after a rise of X % over the prior regular close,
rules in SPEC.md "Short in the night / pre-market session". Offline: reads data/ only.

    ../spx_fly/.venv/bin/python premarket_short.py
"""
import itertools
import os

import numpy as np
import pandas as pd

import backtest as B

ROOT = os.path.dirname(os.path.abspath(__file__))
XS, EXITS = (0.05, 0.08), (0, 30)  # exit at the open of the m=0 (09:30) or m=30 (10:00) bar
GRID = list(itertools.product(XS, EXITS))
N_ALL = 101
LAST_SIGNAL, GATE = -10, 0.0030  # signal at or before 09:20; 30 bps median-spread gate


def spread_all_hours(sym):
    """Median quoted spread fraction per 15-minute bucket over the whole 20:00-20:00 day,
    plus the per-session medians (night / pre / rth / post) for the gate."""
    q = B.load_all_hours(sym, "BID_ASK")
    q = q[(q.bid > 0) & (q.ask >= q.bid)]
    frac = (q.ask - q.bid) / ((q.ask + q.bid) / 2)
    by_bucket = frac.groupby(np.floor_divide(q.m.values, 15)).median()
    sess = {"night": float(frac[q.m < -330].median()), "pre": float(frac[(q.m >= -330) & (q.m < 0)].median()),
            "rth": float(frac[(q.m >= 0) & (q.m < 390)].median())}
    return by_bucket, sess


def day_short(d, prev_close, x, exit_m):
    """One trading day's bars (night + pre-market + regular) -> trade tuple or None:
    (side, entry index, entry px, exit index, exit px, stopped, risk, session)."""
    m, o, h, c, v = d.m.values, d.open.values, d.high.values, d.close.values, d.volume.values
    end = int(np.searchsorted(m, exit_m))
    if end >= len(d) or m[end] != exit_m or m[0] >= 0:
        return None
    level = prev_close * (1 + x)
    for i in range(len(d) - 1):
        if m[i] > LAST_SIGNAL:
            return None
        if c[i] >= level and v[i] > 0 and v[i + 1] > 0:  # IB fills empty minutes with 0-volume bars: no trade, no fill
            break
    else:
        return None
    e = o[i + 1]
    stop = e * (1 + x / 2)
    sess = "night" if m[i + 1] < -330 else "pre"
    for j in range(i + 1, end):
        if h[j] >= stop:
            return -1, i + 1, e, j, max(stop, o[j]), True, stop - e, sess
    return -1, i + 1, e, end, o[end], False, stop - e, sess


def run(full, cfg, seed=None):
    x, exit_m = cfg
    rng = np.random.default_rng(seed) if seed is not None else None
    out, prev_close = [], None
    for date, d in full.groupby("date", sort=True):
        reg = d[(d.m >= 0) & (d.m < 390)]
        t = day_short(d, prev_close, x, exit_m) if prev_close else None
        if len(reg):
            prev_close = reg.close.iloc[-1]
        if t is None:
            continue
        s, ie, e, ix, xp, stopped, risk, sess = t
        if rng is not None:
            s = rng.choice([-1, 1])
        out.append(dict(date=date, side=s, entry=e, exit=xp, im=d.m.values[ie], xm=d.m.values[ix], ts_e=d.ts.values[ie],
                        ts_x=d.ts.values[ix], stopped=stopped, risk=risk, session=sess, vol_e=d.volume.values[ie]))
    return pd.DataFrame(out)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--names", nargs="*", default=list(B.NAMES), help="symbols; default the four-name set")
    ap.add_argument("--tag", default="", help="suffix for the output files, e.g. _tech")
    ap.add_argument("--pick", nargs=2, type=float, metavar=("X", "EXIT"),
                    help="evaluate this configuration instead of the in-sample pick (SPEC: the 14-name pool uses the 10-name pick)")
    a = ap.parse_args()
    P = B.Panel(a.names)
    P.describe()
    missing = [s for s in a.names if s not in P.names]
    if missing:
        print("no bars on disk for", missing)
    full = {s: B.load_all_hours(s, "TRADES") for s in P.names}
    spreads, gates = {}, {}
    for s in P.names:
        spreads[s], gates[s] = spread_all_hours(s)
        ok = [k for k in ("night", "pre") if gates[s][k] <= GATE]
        print(f"  {s}: median spread night {gates[s]['night']*1e4:.1f}  pre {gates[s]['pre']*1e4:.1f}  rth {gates[s]['rth']*1e4:.1f} bps"
              f"  -> entries allowed in {ok or 'none'}")

    def returns(tr, s, mult=1.0):
        return B.stock_returns(tr, spreads[s], mult)

    def pooled(cfg, gated, mult=1.0, seed=None, cache={}):
        per, trs = {}, {}
        for s in P.names:
            key = (cfg, s)
            tr = cache[key] if key in cache and seed is None else run(full[s], cfg, seed)
            if seed is None:
                cache[key] = tr
            if gated and len(tr):
                tr = tr[tr.session.map(lambda k: gates[s][k] <= GATE)]
            trs[s] = tr
            per[s] = B.daily(tr.date, returns(tr, s, mult), P.dates) if len(tr) else pd.Series(0.0, index=P.dates)
        return trs, P.pool(per)

    print("\nGrid, short only, pooled by day over the names, bps/day. 'gated' = only name-sessions under 30 bps")
    rows = []
    for cfg in GRID:
        for gated in (True, False):
            trs, p = pooled(cfg, gated)
            o, i = p.reindex(P.oos_d).dropna(), p.reindex(P.is_d).dropna()
            n_is = sum(int(t.date.isin(P.is_d).sum()) for t in trs.values() if len(t))
            n_oos = sum(int(t.date.isin(P.oos_d).sum()) for t in trs.values() if len(t))
            allr = np.concatenate([returns(t, s).values for s, t in trs.items() if len(t)]) if n_is + n_oos else np.array([np.nan])
            rows.append(dict(x=cfg[0], exit=cfg[1], gated=gated, is_sh=B.sharpe(i), is_trades=n_is, oos_sh=B.sharpe(o),
                             oos_bps=o.mean() * 1e4, oos_trades=n_oos, per_trade_bps=allr.mean() * 1e4,
                             win=(allr > 0).mean(), stopped=np.mean([t.stopped.mean() for t in trs.values() if len(t)])))
    grid = pd.DataFrame(rows)
    grid.to_csv(os.path.join(ROOT, f"grid_premarket_short{a.tag}.csv"), index=False)
    print(grid.round(3).to_string(index=False))

    g = grid[grid.gated].sort_values("is_sh", ascending=False)
    best = (float(g.iloc[0].x), int(g.iloc[0].exit))
    if a.pick:
        best = (float(a.pick[0]), int(a.pick[1]))
        print("\nPICK (given on the command line, not the in-sample pick):", best)
    else:
        print("\nPICK (best in-sample among the 4, gated):", best)
    trs, p = pooled(best, True)
    _, p2 = pooled(best, True, 2.0)
    o = p.reindex(P.oos_d).dropna()
    q = 0.05 / N_ALL
    lo, hi = B.block_ci(o.values)
    lo2, hi2 = B.block_ci(o.values, alpha=q)
    print(f"OOS net {o.mean()*1e4:.1f} bps/day  95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  {100*(1-q):.2f}% CI [{lo2*1e4:.1f}, {hi2*1e4:.1f}]"
          f"  Sharpe {B.sharpe(o):.2f}  2x cost {p2.reindex(P.oos_d).dropna().mean()*1e4:.1f} bps/day")
    i = p.reindex(P.is_d).dropna()
    print(f"IS  net {i.mean()*1e4:.1f} bps/day  Sharpe {B.sharpe(i):.2f}")
    for s, tr in trs.items():
        if not len(tr):
            print(f"  {s}: no trades")
            continue
        r = returns(tr, s)
        oo = tr.date.isin(P.oos_d)
        print(f"  {s}: {len(tr)} trades ({int(oo.sum())} OOS)  per-trade net {r.mean()*1e4:.0f} bps  win {(r > 0).mean():.0%}"
              f"  stopped {tr.stopped.mean():.0%}  night/pre {int((tr.session == 'night').sum())}/{int((tr.session == 'pre').sum())}"
              f"  median entry-bar volume {int(tr.vol_e.median())} sh  gross {(tr.side * (tr.exit - tr.entry) / tr.entry).mean()*1e4:.0f} bps")
    rand = [pooled(best, True, seed=k)[1].reindex(P.oos_d).dropna().mean() * 1e4 for k in range(200)]
    print(f"baseline random side: mean {np.mean(rand):.1f}, 95th pct {np.quantile(rand, .95):.1f} bps/day")
    allt = pd.concat([t.assign(sym=s, net=returns(t, s)) for s, t in trs.items() if len(t)]).sort_values("date")
    allt.to_csv(os.path.join(ROOT, f"trades_premarket_short{a.tag}.csv"), index=False)
    print(f"\nall {len(allt)} trades of the pick written to trades_premarket_short{a.tag}.csv")


if __name__ == "__main__":
    main()
