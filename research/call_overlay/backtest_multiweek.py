"""Long 100 shares + one call vertical at a time, 2–4 week expiry. See SPEC.md change 4.

Run: ../spx_fly/.venv/bin/python backtest_multiweek.py      → cache_mw/<SYM>.parquet, trades_mw.csv, skips_mw.csv
"""
import glob, os, sys, itertools
from multiprocessing import Pool
import pandas as pd
from backtest import RAW, HERE, SYMS, COMM, pick, spots

MAX_DTE = 35
DTE_LO, DTE_HI, DTE_MID = 14, 28, 21
DTE_MODES = ("mid", "short", "long")
GRID = list(itertools.product(("A", "B"), (0.05, 0.10), (0.0, 0.5, 1.0), (0.08, None), (2.0, 1.0), (None, 0.75)))


def load_mw(sym):
    cp = os.path.join(HERE, "cache_mw", f"{sym}.parquet")
    if os.path.exists(cp):
        return pd.read_parquet(cp)
    out = []
    for f in sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz")):
        d = pd.read_csv(f, usecols=["expiration", "strike", "right", "timestamp", "bid", "ask", "underlying_price"])
        d = d[d.right == "CALL"]
        d["date"] = pd.to_datetime(d.timestamp.str[:10])
        d["exp"] = pd.to_datetime(d.expiration)
        dte = (d.exp - d.date).dt.days
        d = d[(dte >= 0) & (dte <= MAX_DTE)]
        out.append(d[["date", "exp", "strike", "bid", "ask"]])
    df = pd.concat(out, ignore_index=True)
    os.makedirs(os.path.dirname(cp), exist_ok=True)
    df.to_parquet(cp)
    return df


def choose_exp(exps, d0, mode):
    c = [e for e in exps if DTE_LO <= (e - d0).days <= DTE_HI]
    if not c:
        return None
    if mode == "short":
        return min(c)
    if mode == "long":
        return max(c)
    return min(c, key=lambda e: (abs((e - d0).days - DTE_MID), e))


def simulate_mw(sym, dfi, spot, variant, w, k, stop, stop_mult, tp, mode, pick_cache):
    """dfi: options indexed by (date, exp, strike), sorted. One spread at a time."""
    days = spot.index
    iso = days.isocalendar()
    firsts = pd.Series(days, index=days).groupby([iso.year.values, iso.week.values]).first().sort_values()
    trades, skips = [], {"no_expiry": 0, "no_strike": 0, "no_credit": 0, "no_settle": 0}
    free_after = pd.Timestamp.min  # next entry must be strictly after this date
    for d0 in firsts:
        if d0 <= free_after:
            continue
        S0 = spot[d0]
        try:
            day = dfi.loc[d0]
        except KeyError:
            skips["no_expiry"] += 1; continue
        exp = choose_exp(day.index.get_level_values(0).unique(), d0, mode)
        if exp is None:
            skips["no_expiry"] += 1; continue
        T = (exp - d0).days / 365.0
        ck = (d0, exp, variant, w)
        if ck not in pick_cache:
            pick_cache[ck] = pick(day.loc[exp].reset_index(), S0, T, variant, w)
        p = pick_cache[ck]
        if p is None:
            skips["no_strike"] += 1; continue
        s, l = p
        Ks, Kl = float(s.strike), float(l.strike)
        hs_s, hs_l = (s.ask - s.bid) / 2, (l.ask - l.bid) / 2
        credit = (s.mid - k * hs_s) - (l.mid + k * hs_l)
        if credit <= 0:
            skips["no_credit"] += 1; continue
        last = {"ms": s.mid, "ml": l.mid, "hs": hs_s, "hl": hs_l}
        exit_cost, reason, dx = None, None, None
        for d in days[(days > d0) & (days <= exp)]:
            S = spot[d]
            if d == exp:
                exit_cost = max(0.0, S - Ks) - max(0.0, S - Kl); reason = "expiry"; dx = d; break
            for K, mk, hk in ((Ks, "ms", "hs"), (Kl, "ml", "hl")):
                try:
                    q = dfi.loc[(d, exp, K)]
                    if q.ask >= q.bid and q.ask > 0:
                        last[mk] = (q.bid + q.ask) / 2; last[hk] = (q.ask - q.bid) / 2
                except KeyError:
                    pass
            close_fill = (last["ms"] + k * last["hs"]) - (last["ml"] - k * last["hl"])
            close_fill = min(max(close_fill, 0.0), Kl - Ks)
            if stop is not None and S <= S0 * (1 - stop):
                exit_cost, reason, dx = close_fill, "stock_stop", d; break
            if (last["ms"] - last["ml"]) - credit >= stop_mult * credit:
                exit_cost, reason, dx = close_fill, "spread_stop", d; break
            if tp is not None and close_fill <= (1 - tp) * credit:
                exit_cost, reason, dx = (1 - tp) * credit, "take_profit", d; break
        if exit_cost is None:
            skips["no_settle"] += 1; free_after = exp; continue
        free_after = dx
        comm = 2 * COMM + (2 * COMM if reason != "expiry" else 0)
        pnl = 100 * (credit - exit_cost) - comm
        trades.append(dict(sym=sym, dte_mode=mode, variant=variant, w=w, k=k, stop=stop if stop else 0, stop_mult=stop_mult,
                           tp=tp if tp else 0, entry=d0.date(), exp=exp.date(), dte=(exp - d0).days, exit=dx.date(),
                           held=(dx - d0).days, reason=reason, S0=S0, S_exit=spot[dx], Ks=Ks, Kl=Kl,
                           delta_s=round(float(s.delta), 3), credit=round(credit, 4), width=Kl - Ks,
                           cw=round(credit / (Kl - Ks), 3), exit_cost=round(exit_cost, 4), pnl=round(pnl, 2),
                           pnl_pct=pnl / (100 * S0) * 100))
    return trades, skips


def run_one(args):
    sym, mode = args
    df = load_mw(sym)
    dfi = df.set_index(["date", "exp", "strike"]).sort_index()
    spot = spots(sym)
    cache, rows, sk_rows = {}, [], []
    for variant, w, k, stop, sm, tp in GRID:
        tr, sk = simulate_mw(sym, dfi, spot, variant, w, k, stop, sm, tp, mode, cache)
        rows += tr
        sk.update(sym=sym, dte_mode=mode, variant=variant, w=w, k=k, stop=stop if stop else 0, stop_mult=sm, tp=tp if tp else 0,
                  weeks=spot.index.to_period("W").nunique())
        sk_rows.append(sk)
    print(sym, mode, len(rows), flush=True)
    return rows, sk_rows


def main():
    for s in SYMS:  # build caches serially first (one read per symbol)
        load_mw(s)
    jobs = [(s, m) for m in DTE_MODES for s in SYMS]
    with Pool(9) as pool:
        res = pool.map(run_one, jobs)
    t = pd.DataFrame([r for rows, _ in res for r in rows])
    sk = pd.DataFrame([r for _, sks in res for r in sks])
    # invariant: one spread at a time per symbol and config
    keys = ["sym", "dte_mode", "variant", "w", "k", "stop", "stop_mult", "tp"]
    for _, g in t.groupby(keys):
        g = g.sort_values("entry")
        assert (pd.to_datetime(g.entry.values[1:]) > pd.to_datetime(g.exit.values[:-1])).all(), g.iloc[0][keys].to_dict()
    t.to_csv(os.path.join(HERE, "trades_mw.csv"), index=False)
    sk.to_csv(os.path.join(HERE, "skips_mw.csv"), index=False)
    print("trades", len(t))


if __name__ == "__main__":
    main()
