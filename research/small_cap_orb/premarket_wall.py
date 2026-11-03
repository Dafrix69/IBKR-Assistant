"""Pre-market call wall, rules in SPEC.md "Pre-market call wall". Offline: data/ bars and the
ThetaData day files via walls.build_walls.

    ../spx_fly/.venv/bin/python premarket_wall.py [--names ...] [--tag _x]

A: first traded bar in 20:00-09:29 whose high reaches the call wall from below; signed return
   from the wall over the next 30 traded bars and to the 09:30 open (+ = pushed down), vs a
   placebo distance drawn from another day's wall. Paired by day, block-bootstrap CI.
B: one trade rule: short at the next traded bar once a bar's high is within 0.5 % below the
   wall (or above), stop wall x 1.025, cover at the 09:30 open. Night bars use D-1's wall
   (the OI stamp is 06:30), pre-market bars use D's.
"""
import argparse
import os

import numpy as np
import pandas as pd

import backtest as B
import premarket_short as PS
import walls as W

ROOT = os.path.dirname(os.path.abspath(__file__))
NEAR, STOP_MULT, N_ALL = 0.005, 1.025, 106


def wall_for_bars(d, walls, date, prev_date):
    """Per-bar call wall level: D-1's for the night session, D's for pre-market; NaN if absent."""
    w_d = walls.call_wall.get(date, np.nan)
    w_p = walls.call_wall.get(prev_date, np.nan) if prev_date is not None else np.nan
    return np.where(d.m.values < -330, w_p, w_d)


def touch_a(d, lvl_arr):
    """(r30, r_open) after the first traded bar whose high reaches its wall from below, else None."""
    pre = d[d.m < 0]
    if not len(pre) or not (d.m == 0).any():
        return None
    h, c, v, lv = pre.high.values, pre.close.values, pre.volume.values, lvl_arr[: len(pre)]
    traded = np.nonzero(v > 0)[0]
    if not len(traded):
        return None
    first = traded[0]
    if np.isnan(lv[first]) or pre.open.values[first] >= lv[first]:
        return None
    hit = [i for i in traded if not np.isnan(lv[i]) and h[i] >= lv[i]]
    if not hit:
        return None
    k = hit[0]
    lvl = lv[k]
    later = traded[traded > k]
    if len(later) < 30:
        return None
    r30 = -(c[later[29]] - lvl) / lvl
    r_open = -(d[d.m == 0].open.iloc[0] - lvl) / lvl
    return r30, r_open


def trade_b(d, lvl_arr):
    m, o, h, v = d.m.values, d.open.values, d.high.values, d.volume.values
    end = int(np.searchsorted(m, 0))
    if end >= len(d) or m[end] != 0 or m[0] >= 0:
        return None
    for i in range(end - 1):
        if m[i] > PS.LAST_SIGNAL:
            return None
        lvl = lvl_arr[i]
        if not np.isnan(lvl) and h[i] >= lvl * (1 - NEAR) and v[i] > 0 and v[i + 1] > 0:
            break
    else:
        return None
    e, stop = o[i + 1], lvl * STOP_MULT
    sess = "night" if m[i + 1] < -330 else "pre"
    for j in range(i + 1, end):
        if h[j] >= stop:
            return -1, i + 1, e, j, max(stop, o[j]), True, stop - e, sess
    return -1, i + 1, e, end, o[end], False, stop - e, sess


def run_b(full, walls):
    out, prev = [], None
    for date, d in full.groupby("date", sort=True):
        t = trade_b(d, wall_for_bars(d, walls, date, prev))
        prev = date
        if t is None:
            continue
        s, ie, e, ix, xp, stopped, risk, sess = t
        out.append(dict(date=date, side=s, entry=e, exit=xp, im=d.m.values[ie], xm=d.m.values[ix], ts_e=d.ts.values[ie],
                        ts_x=d.ts.values[ix], stopped=stopped, risk=risk, session=sess, vol_e=d.volume.values[ie]))
    return pd.DataFrame(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--names", nargs="*", default=list(B.NAMES))
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    P = B.Panel(a.names)
    P.describe()
    full = {s: B.load_all_hours(s, "TRADES") for s in P.names}
    walls = {s: W.build_walls(s, P.dates) for s in P.names}
    spreads, gates = {}, {}
    for s in P.names:
        spreads[s], gates[s] = PS.spread_all_hours(s)
        print(f"  {s}: wall days {len(walls[s])}, call wall on {walls[s].call_wall.notna().mean():.0%};"
              f" spread night {gates[s]['night']*1e4:.1f} pre {gates[s]['pre']*1e4:.1f} bps")

    print("\nA. first pre-market / night touch of the call wall from below, + = pushed down, bps")
    rng = np.random.default_rng(11)
    all_rows = []
    for s in P.names:
        w = walls[s]
        dist = (w.call_wall / w.spot - 1).dropna().values
        rows, prev = [], None
        for date, d in full[s].groupby("date", sort=True):
            lv = wall_for_bars(d, w, date, prev)
            if date in w.index and not np.isnan(w.call_wall.get(date, np.nan)):
                spot = w.spot[date]
                plac = np.full(len(d), spot * (1 + rng.choice(dist)))
                r, p = touch_a(d, lv), touch_a(d, plac)
                if r is not None and p is not None:
                    rows.append(dict(sym=s, date=date, r30=r[0], r_open=r[1], p30=p[0], p_open=p[1]))
            prev = date
        t = pd.DataFrame(rows)
        all_rows.append(t)
        if len(t):
            print(f"  {s}: n={len(t)}  real 30 traded min {t.r30.mean()*1e4:+.0f} (placebo {t.p30.mean()*1e4:+.0f})"
                  f"  to 09:30 open {t.r_open.mean()*1e4:+.0f} (placebo {t.p_open.mean()*1e4:+.0f})"
                  f"  pushed down by the open {(t.r_open > 0).mean():.0%}")
        else:
            print(f"  {s}: no touches")
    t = pd.concat(all_rows)
    t.to_csv(os.path.join(ROOT, f"premarket_wall_touches{a.tag}.csv"), index=False)
    for col, pcol, nm in (("r30", "p30", "30 traded min"), ("r_open", "p_open", "to the open")):
        diff = (t[col] - t[pcol]).groupby(t.date).mean()
        lo, hi = B.block_ci(diff.values)
        print(f"  pooled paired difference {nm}: {diff.mean()*1e4:+.1f} bps  95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  days {len(diff)}")

    print("\nB. short near the call wall in 20:00-09:20, stop wall x 1.025, cover 09:30; gated = name-sessions under 30 bps")
    trs = {s: run_b(full[s], walls[s]) for s in P.names}
    for gated in (True, False):
        per, tg = {}, {}
        for s in P.names:
            tr = trs[s]
            if gated and len(tr):
                tr = tr[tr.session.map(lambda k: gates[s][k] <= PS.GATE)]
            tg[s] = tr
            per[s] = B.daily(tr.date, B.stock_returns(tr, spreads[s]), P.dates) if len(tr) else pd.Series(0.0, index=P.dates)
        p = P.pool(per)
        o, i = p.reindex(P.oos_d).dropna(), p.reindex(P.is_d).dropna()
        q = 0.05 / N_ALL
        lo, hi = B.block_ci(o.values)
        lo2, hi2 = B.block_ci(o.values, alpha=q)
        print(f"  gated={gated}: IS {i.mean()*1e4:.1f} bps/day Sharpe {B.sharpe(i):.2f}  OOS {o.mean()*1e4:.1f} bps/day"
              f"  95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  {100*(1-q):.2f}% CI [{lo2*1e4:.1f}, {hi2*1e4:.1f}]  Sharpe {B.sharpe(o):.2f}")
        for s, tr in tg.items():
            if not len(tr):
                print(f"    {s}: no trades")
                continue
            r = B.stock_returns(tr, spreads[s])
            oo = tr.date.isin(P.oos_d)
            print(f"    {s}: {len(tr)} trades ({int(oo.sum())} OOS)  per-trade net {r.mean()*1e4:.0f} bps  win {(r > 0).mean():.0%}"
                  f"  stopped {tr.stopped.mean():.0%}  IS {r[~oo].mean()*1e4 if (~oo).any() else float('nan'):.0f}"
                  f"  OOS {r[oo].mean()*1e4 if oo.any() else float('nan'):.0f}  night/pre {int((tr.session == 'night').sum())}/{int((tr.session == 'pre').sum())}")
        if gated:
            allt = pd.concat([tr.assign(sym=s, net=B.stock_returns(tr, spreads[s])) for s, tr in tg.items() if len(tr)])
            allt.sort_values("date").to_csv(os.path.join(ROOT, f"trades_premarket_wall{a.tag}.csv"), index=False)


if __name__ == "__main__":
    main()
