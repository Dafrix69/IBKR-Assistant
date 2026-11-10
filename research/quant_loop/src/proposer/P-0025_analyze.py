"""P-0025 (and engine shared with P-0026): long-only top-quintile stock portfolios ranked
by an option-implied signal, versus the same-period equal-weight pool basket.

Training only: pools 2018-10-31 .. 2022-10-31, entry and exit < 2023-10-31.
Reads src/proposer/P-0025_cache/daily.parquet (built by P-0025_build.py).
"""
import os, sys
import numpy as np
import pandas as pd

CUTOFF = pd.Timestamp("2023-10-31")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "P-0025_cache", "daily.parquet")
DEFECTS = os.path.join(HERE, "..", "..", "data", "pools_defects.csv")
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031"]
SEL = [pd.Timestamp(p) for p in POOLS] + [pd.Timestamp("2023-10-31")]
COSTS = [0.0, 10.0, 25.0]
NBOOT = 10000
EXTRA_EXCLUDE = []  # (pool, sym, day) found by our own data checks; filled after checks


def load():
    d = pd.read_parquet(CACHE)
    d = d[d.date < CUTOFF]  # time wall: first statement after reading
    d = d[d.pool.isin(POOLS)]
    d.loc[~(d.px > 0), "px"] = np.nan
    df = pd.read_csv(DEFECTS, dtype={"pool": str})
    df = df[df.pool.isin(POOLS)]
    ev = {}
    for r in df.itertuples():
        day = pd.Timestamp(r.day)
        if r.action == "exclude_span":
            ev.setdefault((r.pool, r.sym), []).append(day)
        elif r.action == "day_dropped":
            d.loc[(d.pool == r.pool) & (d.sym == r.sym) & (d.date == day), "px"] = np.nan
    for pool, sym, day in EXTRA_EXCLUDE:
        ev.setdefault((pool, sym), []).append(pd.Timestamp(day))
    return d, ev


def calendar(d, freq):
    days = pd.DatetimeIndex(sorted(d.loc[d.px.notna(), "date"].unique()))
    s = pd.Series(days, index=days)
    if freq == "W":
        key = [x.isocalendar()[0] * 100 + x.isocalendar()[1] for x in days]
    else:
        key = [x.year * 100 + x.month for x in days]
    sig = s.groupby(np.array(key)).max().sort_values().tolist()
    nxt = {days[i]: days[i + 1] for i in range(len(days) - 1)}
    rows = []
    for i, t in enumerate(sig):
        if t not in nxt:
            continue
        rows.append(dict(t=t, t_prev=sig[i - 1] if i > 0 else pd.NaT, entry=nxt[t]))
    per = pd.DataFrame(rows)
    per["exit"] = per.entry.shift(-1)
    per = per.dropna(subset=["exit"])
    per = per[per.exit < CUTOFF]
    pool_of = []
    for e in per.entry:
        p = None
        for j in range(len(POOLS)):
            if SEL[j] <= e < SEL[j + 1]:
                p = POOLS[j]
        pool_of.append(p)
    per["pool"] = pool_of
    return per.dropna(subset=["pool"]).reset_index(drop=True)


def build_periods(d, ev, freq, sigfun, lookback_prev, drop=None):
    """Return list of period dicts with per-stock returns and signals.
    sigfun(tab, t, t_prev) -> Series sym->signal (higher = buy).
    lookback_prev: exclusion span starts at t_prev (True) or t (False)."""
    per = calendar(d, freq)
    px = {k: g.set_index("date").px.dropna() for k, g in d.groupby(["pool", "sym"])}
    tabs = {p: g.pivot(index="date", columns="sym") for p, g in d.groupby("pool")}
    out = []
    for r in per.itertuples():
        tab = tabs[r.pool]
        syms = [s for s in tab["px"].columns if not (drop and (r.pool, s) in drop)]
        sig = sigfun(tab, r.t, r.t_prev)
        recs = []
        for s in syms:
            ser = px[(r.pool, s)]
            if r.entry not in ser.index:
                continue
            p0 = ser.loc[r.entry]
            seg = ser[(ser.index > r.entry) & (ser.index <= r.exit)]
            p1 = seg.iloc[-1] if len(seg) else p0  # last price on/before exit (delisting)
            evs = ev.get((r.pool, s), [])
            bad_hold = any(r.t < e <= r.exit for e in evs)
            start = r.t_prev if (lookback_prev and pd.notna(r.t_prev)) else r.t
            bad_sig = any(start < e <= r.exit for e in evs)
            v = sig.get(s, np.nan) if sig is not None else np.nan
            stale = (len(seg) == 0 or seg.index[-1] < r.exit) and ser.index.max() > r.exit
            ended = (len(seg) == 0 or seg.index[-1] < r.exit) and ser.index.max() <= r.exit
            recs.append(dict(sym=s, r=p1 / p0 - 1, bench=not bad_hold, stale=stale, ended=ended,
                             elig=(not bad_sig) and np.isfinite(v), sig=v))
        out.append(dict(pool=r.pool, t=r.t, entry=r.entry, exit=r.exit,
                        df=pd.DataFrame(recs)))
    return out


def run(periods, higher_is_long=True):
    """Compute per-period long/short/bench series and turnover (weights keyed by sym)."""
    res = []
    wL, wS = {}, {}
    last_exit = None
    for p in periods:
        df = p["df"]
        if df.empty:
            continue
        el = df[df.elig]
        n = len(el)
        bench = df[df.bench].r.mean()
        if n < 6:
            res.append(dict(pool=p["pool"], entry=p["entry"], skip=True))
            continue
        k = max(3, n // 5)
        el = el.sort_values(["sig", "sym"], ascending=[not higher_is_long, True])
        L = el.head(k)
        S = el.tail(k)
        contiguous = last_exit is not None and last_exit == p["entry"]
        tL = turnover(wL if contiguous else {}, L.sym, k) + (0 if contiguous or not wL else 1)
        tS = turnover(wS if contiguous else {}, S.sym, k) + (0 if contiguous or not wS else 1)
        rL, rS = L.r.mean(), S.r.mean()
        # drift weights to exit
        wL = drift(L, k)
        wS = drift(S, k)
        last_exit = p["exit"]
        res.append(dict(pool=p["pool"], entry=p["entry"], exit=p["exit"], skip=False, n=n, k=k,
                        nb=int(df.bench.sum()), rL=rL, rS=rS, bench=bench,
                        elig_bench=el.r.mean(), tL=tL, tS=tS,
                        longsyms=list(L.sym), longr=list(L.r)))
    r = pd.DataFrame(res)
    r = r[~r.skip].reset_index(drop=True)
    # closing trade at the very end
    r.loc[r.index[-1], "tL"] += 1
    r.loc[r.index[-1], "tS"] += 1
    return r


def turnover(wprev, syms, k):
    tgt = {s: 1.0 / k for s in syms}
    keys = set(wprev) | set(tgt)
    return sum(abs(tgt.get(s, 0) - wprev.get(s, 0)) for s in keys)


def drift(sel, k):
    g = {s: (1.0 / k) * (1 + x) for s, x in zip(sel.sym, sel.r)}
    tot = sum(g.values())
    return {s: v / tot for s, v in g.items()} if tot > 0 else {}


def series(r, c_bp, which="main"):
    c = c_bp / 1e4
    net = r.rL - c * r.tL
    if which == "main":
        return net - r.bench
    if which == "elig":
        return net - r.elig_bench
    if which == "ls":
        return r.rL - r.rS - c * (r.tL + r.tS)
    if which == "gross_long":
        return r.rL


def sboot(x, L, nb=NBOOT, seed=7):
    x = np.asarray(x, float)
    n = len(x)
    rng = np.random.default_rng(seed)
    idx = np.empty((nb, n), int)
    idx[:, 0] = rng.integers(0, n, nb)
    newb = rng.random((nb, n)) < 1.0 / L
    rnd = rng.integers(0, n, (nb, n))
    for j in range(1, n):
        idx[:, j] = np.where(newb[:, j], rnd[:, j], (idx[:, j - 1] + 1) % n)
    m = x[idx].mean(1)
    return dict(mean=x.mean(), lo95=np.quantile(m, .025), hi95=np.quantile(m, .975),
                lo9875=np.quantile(m, .00625), hi9875=np.quantile(m, .99375),
                p1=float((m <= 0).mean()))


def contrib(r):
    rows = []
    for x in r.itertuples():
        k = len(x.longsyms)
        for s, rr in zip(x.longsyms, x.longr):
            rows.append(dict(pool=x.pool, sym=s, c=(rr - x.bench) / k))
    c = pd.DataFrame(rows).groupby(["pool", "sym"]).c.sum()
    return c


def report(name, periods_fn, higher_is_long, L, ppy, out):
    periods = periods_fn(None)
    r = run(periods, higher_is_long)
    allrec = pd.concat([p["df"] for p in periods if not p["df"].empty])
    lines = [f"## {name}", f"stock-periods {len(allrec)}, bench-excluded {int((~allrec.bench).sum())}, "
             f"stale exit (hole on exit day) {int(allrec.stale.sum())}, data ended in period (delist/takeover) {int(allrec.ended.sum())}",
             f"periods {len(r)}, mean n_valid {r.n.mean():.1f}, mean k {r.k.mean():.1f}, "
             f"mean bench names {r.nb.mean():.1f}, mean turnover long {r.tL.mean():.3f} short {r.tS.mean():.3f}"]
    lines.append("| 口径 | c bp | 均值 % | 95% | 98.75% | 单侧 p | 中位 % | 去最好5期 % |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for which in ["main", "elig", "ls"]:
        for c in COSTS:
            x = series(r, c, which) * 100
            b = sboot(x, L)
            drop5 = np.sort(x.values)[:-5].mean()
            lines.append(f"| {which} | {c:.0f} | {b['mean']:+.3f} | [{b['lo95']:+.3f}, {b['hi95']:+.3f}] | "
                         f"[{b['lo9875']:+.3f}, {b['hi9875']:+.3f}] | {b['p1']:.3f} | {np.median(x):+.3f} | {drop5:+.3f} |")
    g = (r.rL - r.bench).mean()
    be = g / r.tL.mean() * 1e4
    lines.append(f"breakeven single-side cost (main): {be:+.1f} bp")
    ls10 = series(r, 10, "ls").mean()
    lines.append(f"LS net 10bp mean {ls10*100:+.3f} %/period -> breakeven annual borrow on short leg {ls10*ppy*100:+.1f} %")
    lines.append(f"long gross {r.rL.mean()*100:+.3f}, bench {r.bench.mean()*100:+.3f}, elig bench {r.elig_bench.mean()*100:+.3f}, short gross {r.rS.mean()*100:+.3f} %/period")
    lines.append("by pool (main excess %):")
    lines.append("| pool | n | 0 bp | 10 bp | 25 bp | elig 10bp | LS 10bp | turnover |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for p, g_ in r.groupby("pool"):
        lines.append(f"| {p} | {len(g_)} | {series(g_, 0).mean()*100:+.3f} | {series(g_, 10).mean()*100:+.3f} | "
                     f"{series(g_, 25).mean()*100:+.3f} | {series(g_, 10, 'elig').mean()*100:+.3f} | "
                     f"{series(g_, 10, 'ls').mean()*100:+.3f} | {g_.tL.mean():.2f} |")
    c = contrib(r)
    lines.append(f"stocks in long group: {len(c)}, positive contribution: {(c > 0).sum()}")
    top = c.idxmax()
    lines.append(f"largest contributor {top} {c.max()*100:+.2f} %-periods; top5: " +
                 ", ".join(f"{a}/{b} {v*100:+.1f}" for (a, b), v in c.sort_values().tail(5).items()))
    r2 = run(periods_fn({top}), higher_is_long)
    x2 = series(r2, 10) * 100
    b2 = sboot(x2, L)
    lines.append(f"drop {top}: main 10bp {b2['mean']:+.3f} [{b2['lo95']:+.3f}, {b2['hi95']:+.3f}], "
                 f"0bp {series(r2, 0).mean()*100:+.3f}")
    txt = "\n".join(lines) + "\n"
    print(txt)
    out.write(txt + "\n")
    return r


# ---------------- P-0025 signals ----------------
def sig_vs(tab, t, t_prev):
    if t not in tab.index:
        return None
    return tab.loc[t, "vs"]


def main():
    d, ev = load()
    os.makedirs(os.path.join(HERE, "P-0025_tables"), exist_ok=True)
    with open(os.path.join(HERE, "P-0025_tables", "results.md"), "w") as out:
        report("E-main weekly VS", lambda drop: build_periods(d, ev, "W", sig_vs, False, drop), True, 4, 52, out)
        report("E-v1 monthly VS", lambda drop: build_periods(d, ev, "M", sig_vs, False, drop), True, 3, 12, out)


if __name__ == "__main__":
    main()
