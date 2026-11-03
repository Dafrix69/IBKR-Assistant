"""Pre-market / overnight hypotheses, rules in SPEC.md "Pre-market and after-hours".
Offline: reads data/<SYM>_TRADES_EXT (04:00-20:00) and _OVN (20:00-03:50) only.

    ../spx_fly/.venv/bin/python premarket.py

Prints, per the spec: the first overnight bar per name, the pre-market / night spread
(30 bps gate), the H1 descriptive table by pm_ret bucket, the H1 short-ladder grid (30
configurations, pooled by day over the names), and the H2 pm_high overlay on ORB long.

Conventions to state in the report: (1) scalp.trade returns None when the 09:31 open is
already at or beyond the stop, so H1 skips days that open above the pre-market high (that
is why pm >= 8 % has more days than trades); (2) pm_high / pm_ret cover 04:00-09:29 on
days without overnight bars and 20:00-09:29 where the OVERNIGHT history exists, so the
window changes mid-sample per name; (3) the descriptive table's CI is an iid bootstrap
over symbol-days, not pooled by date, so it is narrower than the SPEC inference would be.
"""
import itertools
import os

import numpy as np
import pandas as pd

import backtest as B
import scalp as S

ROOT = os.path.dirname(os.path.abspath(__file__))
XS, TPS, FADES = (0.03, 0.05, 0.08), (None, 0.005, 0.01, 0.02, 0.03), (False, True)
GRID = list(itertools.product(XS, TPS, FADES))
N_ALL = 97  # 36 ORB + 30 VWAP/TP + 30 H1 + 1 H2, see SPEC
SPREAD_GATE = 0.0030


def features(full):
    """Per trading day: pm_ret, pm_high, pm_low, pm_vol over 20:00 (prev) - 09:29, fade_in,
    the regular open, and the first overnight bar time. Uses the trading-day `date` and
    `m` from backtest.load_all_hours (m < 0 = before 09:30, m < -330 = overnight)."""
    rows = []
    prev_close = None
    for date, d in full.groupby("date", sort=True):
        reg = d[(d.m >= 0) & (d.m < 390)]
        pre = d[d.m < 0]
        if len(reg) and reg.m.iloc[0] == 0 and len(pre) and prev_close:
            last_pre = pre.close.iloc[-1]
            rows.append(dict(date=date, prev_close=prev_close, open=reg.open.iloc[0],
                             pm_ret=last_pre / prev_close - 1, pm_high=pre.high.max(), pm_low=pre.low.min(),
                             pm_vol=float(pre.volume.sum()), fade_in=reg.open.iloc[0] / pre.high.max() - 1,
                             n_pre=len(pre), n_night=int((pre.m < -330).sum())))
        if len(reg):
            prev_close = reg.close.iloc[-1]
    return pd.DataFrame(rows).set_index("date")


def h1_signal(d, f, x, fade):
    """Short at the 09:31 open when pm_ret >= x (and fade_in <= -1 % if `fade`); stop pm_high."""
    if f.pm_ret < x or (fade and f.fade_in > -0.01):
        return None
    return -1, 0, float(f.pm_high)  # signal index 0 -> filled at bar 1's open


def run_h1(reg, feat, cfg, seed=None):
    x, tp, fade = cfg
    rng = np.random.default_rng(seed) if seed is not None else None
    out = []
    for date, d in reg.groupby("date", sort=True):
        if date not in feat.index or len(d) < 380 or d.m.iloc[0] != 0:
            continue
        t = S.trade(d, h1_signal(d, feat.loc[date], x, fade), tp)
        if t is None:
            continue
        s, ie, e, ix, xp, stopped, risk = t
        if rng is not None:
            s = rng.choice([-1, 1])
        out.append(dict(date=date, side=s, entry=e, exit=xp, im=d.m.values[ie], xm=d.m.values[ix],
                        ts_e=d.ts.values[ie], ts_x=d.ts.values[ix], stopped=stopped, risk=risk))
    return pd.DataFrame(out)


def run_h2(reg, feat):
    """ORB(15, 1.0, long) only when the breakout close is above pm_high."""
    out = []
    for date, d in reg.groupby("date", sort=True):
        if date not in feat.index or len(d) < 380 or d.m.iloc[0] != 0:
            continue
        sig = S.entry_orb(d, S.OR_N, 1.0, "long")
        if sig is None or d.close.values[sig[1]] <= feat.loc[date].pm_high:
            continue
        t = S.trade(d, sig, None)
        if t is None:
            continue
        s, ie, e, ix, xp, stopped, risk = t
        out.append(dict(date=date, side=s, entry=e, exit=xp, im=d.m.values[ie], xm=d.m.values[ix],
                        ts_e=d.ts.values[ie], ts_x=d.ts.values[ix], stopped=stopped, risk=risk))
    return pd.DataFrame(out)


def spread_outside_rth(sym):
    """Median quoted spread, bps of mid, pre-market (04:00-09:29) and night (20:00-03:50)."""
    try:
        q = B.load_all_hours(sym, "BID_ASK")
    except ValueError:
        return {}
    q = q[(q.bid > 0) & (q.ask >= q.bid)]
    frac = (q.ask - q.bid) / ((q.ask + q.bid) / 2)
    out = {}
    for name, mask in (("night", q.m < -330), ("pre", (q.m >= -330) & (q.m < 0)), ("rth", (q.m >= 0) & (q.m < 390)),
                       ("post", q.m >= 390)):
        if mask.sum():
            out[name] = (float(frac[mask].median() * 1e4), int(mask.sum()))
    return out


def ci(x, n=5000, seed=1):
    rng = np.random.default_rng(seed)
    m = [rng.choice(x, len(x)).mean() for _ in range(n)]
    return float(np.quantile(m, .025)), float(np.quantile(m, .975))


def main():
    P = B.Panel()
    P.describe()
    full = {s: B.load_all_hours(s, "TRADES") for s in P.names}
    feat = {s: features(full[s]) for s in P.names}
    reg = P.stocks

    print("\nCoverage: first bar on disk, first overnight bar, days with pre-market bars")
    for s in P.names:
        f = full[s]
        night = f[f.m < -330]
        print(f"  {s}: first bar {f.ts.min()}  first overnight bar {night.ts.min() if len(night) else 'none'}"
              f"  overnight days {feat[s].n_night.gt(0).sum()} of {len(feat[s])}  pre-market days {len(feat[s])}")

    print(f"\nSpread outside regular hours, median bps of mid (gate {SPREAD_GATE*1e4:.0f} bps for pre-market / night entries)")
    for s in P.names:
        sp = spread_outside_rth(s)
        print(f"  {s}: " + "  ".join(f"{k} {v[0]:.1f} bps (n={v[1]})" for k, v in sp.items()))

    print("\nH1 descriptive: open-to-t return by pm_ret bucket (pooled over names), + = up from the open")
    rows = []
    for s in P.names:
        for date, d in reg[s].groupby("date", sort=True):
            if date not in feat[s].index or len(d) < 380 or d.m.iloc[0] != 0:
                continue
            o = d.open.iloc[0]
            at = lambda m: (d[d.m == m].open.iloc[0] / o - 1) if (d.m == m).any() else np.nan
            f = feat[s].loc[date]
            rows.append(dict(sym=s, date=date, pm_ret=f.pm_ret, fade_in=f.fade_in, r15=at(15), r30=at(30), r60=at(60),
                             r120=at(120), r385=at(385), touched_pm_high=bool(d.high.max() >= f.pm_high)))
    t = pd.DataFrame(rows).dropna()
    t.to_csv(os.path.join(ROOT, "premarket_days.csv"), index=False)
    for name, g in (("all", t), ("pm>=3%", t[t.pm_ret >= .03]), ("pm>=5%", t[t.pm_ret >= .05]), ("pm>=8%", t[t.pm_ret >= .08]),
                    ("pm>=5% & fade", t[(t.pm_ret >= .05) & (t.fade_in <= -.01)]), ("pm<=-3%", t[t.pm_ret <= -.03])):
        if len(g) < 5:
            print(f"  {name}: n={len(g)}")
            continue
        line = f"  {name:14} n={len(g):4d} "
        for c in ("r30", "r60", "r385"):
            lo, hi = ci(g[c].values)
            line += f"| {c} {g[c].mean()*100:+.2f}% [{lo*100:+.2f},{hi*100:+.2f}] <0 {(g[c] < 0).mean():.0%} "
        line += f"| pm_high touched {g.touched_pm_high.mean():.0%}"
        print(line)
    print("  per name, pm_ret >= 5 % (descriptive only, the user's claim is about IREN):")
    for s in P.names:
        g = t[(t.sym == s) & (t.pm_ret >= .05)]
        if len(g) < 5:
            print(f"    {s}: n={len(g)}")
            continue
        lo, hi = ci(g.r385.values)
        print(f"    {s:5} n={len(g):3d} | r30 {g.r30.mean()*100:+.2f}% <0 {(g.r30 < 0).mean():.0%}"
              f" | r60 {g.r60.mean()*100:+.2f}% <0 {(g.r60 < 0).mean():.0%}"
              f" | r385 {g.r385.mean()*100:+.2f}% [{lo*100:+.2f},{hi*100:+.2f}] <0 {(g.r385 < 0).mean():.0%}"
              f" | pm_high touched {g.touched_pm_high.mean():.0%}")

    print("\nH1 grid: short at 09:31 when pm_ret >= x, stop pm_high, TP ladder; pooled by day, bps/day")
    grid_rows, trades = [], {}
    for cfg in GRID:
        per = {}
        for s in P.names:
            tr = run_h1(reg[s], feat[s], cfg)
            trades[(cfg, s)] = tr
            per[s] = B.daily(tr.date, B.stock_returns(tr, P.spreads[s]), P.dates) if len(tr) else pd.Series(0.0, index=P.dates)
        p = P.pool(per).dropna()
        n_oos = sum(int(trades[(cfg, s)].date.isin(P.oos_d).sum()) for s in P.names)
        n_is = sum(int(trades[(cfg, s)].date.isin(P.is_d).sum()) for s in P.names)
        grid_rows.append(dict(x=cfg[0], tp=cfg[1], fade=cfg[2], is_sh=B.sharpe(p.reindex(P.is_d).dropna()),
                              is_trades=n_is, oos_sh=B.sharpe(p.reindex(P.oos_d).dropna()),
                              oos_bps=p.reindex(P.oos_d).dropna().mean() * 1e4, oos_trades=n_oos,
                              per_trade_bps=float(np.mean([v for s in P.names for v in
                                                           B.stock_returns(trades[(cfg, s)], P.spreads[s])]) * 1e4)
                              if n_is + n_oos else np.nan))
    grid = pd.DataFrame(grid_rows).sort_values("is_sh", ascending=False)
    grid.to_csv(os.path.join(ROOT, "grid_premarket.csv"), index=False)
    print(grid.round(2).to_string(index=False))
    print(f"OOS mean>0: {(grid.oos_bps > 0).sum()} of {len(grid)}")
    best = tuple(grid.iloc[0][["x", "tp", "fade"]])
    best = (float(best[0]), None if pd.isna(best[1]) else float(best[1]), bool(best[2]))
    print("PICK (best in-sample among the 30):", best)

    def pooled(mult, seed=None):
        per = {}
        for s in P.names:
            tr = run_h1(reg[s], feat[s], best, seed) if seed is not None else trades[(best, s)]
            per[s] = B.daily(tr.date, B.stock_returns(tr, P.spreads[s], mult), P.dates) if len(tr) else pd.Series(0.0, index=P.dates)
        return per, P.pool(per)

    per, p = pooled(1.0)
    _, p2 = pooled(2.0)
    o = p.reindex(P.oos_d).dropna()
    q = 0.05 / N_ALL
    lo, hi = B.block_ci(o.values)
    lo2, hi2 = B.block_ci(o.values, alpha=q)
    print(f"OOS net {o.mean()*1e4:.1f} bps/day  95% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  {100*(1-q):.2f}% CI [{lo2*1e4:.1f}, {hi2*1e4:.1f}]"
          f"  Sharpe {B.sharpe(o):.2f}  2x cost {p2.reindex(P.oos_d).dropna().mean()*1e4:.1f} bps/day")
    i = p.reindex(P.is_d).dropna()
    print(f"IS  net {i.mean()*1e4:.1f} bps/day  Sharpe {B.sharpe(i):.2f}")
    for s in P.names:
        tr = trades[(best, s)]
        oo = tr[tr.date.isin(P.oos_d)] if len(tr) else tr
        print(f"  {s}: {len(tr)} trades ({len(oo)} OOS), stopped {tr.stopped.mean() if len(tr) else float('nan'):.0%},"
              f" per-trade net {B.stock_returns(tr, P.spreads[s]).mean()*1e4 if len(tr) else float('nan'):.0f} bps")
    rand = [pooled(1.0, seed=k)[1].reindex(P.oos_d).dropna().mean() * 1e4 for k in range(200)]
    print(f"baseline random side: mean {np.mean(rand):.1f}, 95th pct {np.quantile(rand, .95):.1f} bps/day")

    print("\nH2: ORB(15, 1.0, long) only when the breakout close is above pm_high, vs the same ORB without the filter")
    per_b, per_h = {}, {}
    for s in P.names:
        tb = S.run(reg[s], ("ORB", None, "long"))
        th = run_h2(reg[s], feat[s])
        per_b[s] = B.daily(tb.date, B.stock_returns(tb, P.spreads[s]), P.dates) if len(tb) else pd.Series(0.0, index=P.dates)
        per_h[s] = B.daily(th.date, B.stock_returns(th, P.spreads[s]), P.dates) if len(th) else pd.Series(0.0, index=P.dates)
        print(f"  {s}: ORB long {len(tb)} trades, with pm_high filter {len(th)}")
    pb, ph = P.pool(per_b), P.pool(per_h)
    for nm, pp in (("ORB long", pb), ("H2", ph)):
        o, i = pp.reindex(P.oos_d).dropna(), pp.reindex(P.is_d).dropna()
        print(f"  {nm:9} IS {i.mean()*1e4:6.1f} bps/day Sharpe {B.sharpe(i):5.2f}  OOS {o.mean()*1e4:6.1f} Sharpe {B.sharpe(o):5.2f}")
    d = (ph - pb).reindex(P.oos_d).dropna()
    lo, hi = B.block_ci(d.values, alpha=q)
    print(f"  OOS diff H2 - ORB {d.mean()*1e4:.1f} bps/day  {100*(1-q):.2f}% CI [{lo*1e4:.1f}, {hi*1e4:.1f}]"
          f"  IS diff {(ph - pb).reindex(P.is_d).dropna().mean()*1e4:.1f}")


if __name__ == "__main__":
    main()
