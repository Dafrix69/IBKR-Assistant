"""Long 100 shares + sell a same-week call vertical. See SPEC.md.

Run: ../spx_fly/.venv/bin/python backtest.py
Outputs: cache/<SYM>.parquet, trades.csv, grid.csv, few_vs_every.csv, result.txt
"""
import glob, os, sys, math
import numpy as np, pandas as pd

RAW = os.path.expanduser("~/Data/thetadata")
HERE = os.path.dirname(os.path.abspath(__file__))
SYMS = "IREN AXTI LITE OKLO CRDO NBIS QUBT NVTS APLD CLSK SNDK WOLF ALAB QBTS RKLB".split()
R = 0.043
COMM = 0.65  # per contract per leg


# ---------------------------------------------------------------- data
def load(sym):
    cp = os.path.join(HERE, "cache", f"{sym}.parquet")
    if os.path.exists(cp):
        return pd.read_parquet(cp)
    out = []
    for f in sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz")):
        d = pd.read_csv(f, usecols=["expiration", "strike", "right", "timestamp", "bid", "ask", "underlying_price"])
        d = d[d.right == "CALL"]
        d["date"] = pd.to_datetime(d.timestamp.str[:10])
        d["exp"] = pd.to_datetime(d.expiration)
        d = d[((d.exp - d.date).dt.days >= 0) & ((d.exp - d.date).dt.days <= 8)]
        out.append(d[["date", "exp", "strike", "bid", "ask", "underlying_price"]].rename(columns={"underlying_price": "S"}))
    df = pd.concat(out, ignore_index=True)
    os.makedirs(os.path.dirname(cp), exist_ok=True)
    df.to_parquet(cp)
    return df


def spots(sym):
    """Daily close for every trading day in the file set (from any row)."""
    out = {}
    for f in sorted(glob.glob(f"{RAW}/{sym}/greeks_eod/*/*.csv.gz")):
        day = pd.Timestamp(os.path.basename(f)[:8])
        # read only a few rows: underlying_price is the same on every row
        d = pd.read_csv(f, usecols=["underlying_price"], nrows=5)
        if len(d):
            out[day] = float(d.underlying_price.iloc[0])
    return pd.Series(out).sort_index()


# ---------------------------------------------------------------- BS
def _ncdf(x):
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def bs_call(S, K, T, sig):
    d1 = (np.log(S / K) + (R + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
    d2 = d1 - sig * np.sqrt(T)
    return S * _ncdf(d1) - K * np.exp(-R * T) * _ncdf(d2)


def call_delta(S, K, T, price):
    """Delta from an IV backed out of `price` (bisection). Price below intrinsic → 1/0 by moneyness."""
    K = np.asarray(K, float); price = np.asarray(price, float)
    lo = np.full(K.shape, 1e-3); hi = np.full(K.shape, 8.0)
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        too_high = bs_call(S, K, T, mid) > price
        hi = np.where(too_high, mid, hi); lo = np.where(too_high, lo, mid)
    sig = 0.5 * (lo + hi)
    intrinsic = np.maximum(S - K * np.exp(-R * T), 0)
    d1 = (np.log(S / K) + (R + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
    dl = _ncdf(d1)
    bad = (price <= intrinsic + 1e-9) | (sig >= 7.99)
    return np.where(bad, np.where(S > K, 1.0, 0.0), dl)


# ---------------------------------------------------------------- selection
def pick(chain, S, T, variant, w):
    """chain: rows for one (date, exp), sorted by strike. Returns (Ks, Kl, delta_s) or None."""
    c = chain[(chain.ask >= chain.bid) & (chain.ask > 0)].copy()
    if len(c) < 2:
        return None
    c["mid"] = (c.bid + c.ask) / 2
    c["delta"] = call_delta(S, c.strike.values, T, c.mid.values)
    strikes = c.strike.values

    def long_of(Ks):
        hi = c[c.strike >= Ks + w * S - 1e-9]
        return None if hi.empty else hi.iloc[0]

    if variant == "A":
        s = c[(c.bid > 0) & (c.delta >= 0.20) & (c.delta <= 0.30)]
        if s.empty:
            return None
        s = s.iloc[(s.delta - 0.25).abs().argmin()]
        l = long_of(s.strike)
        return None if l is None else (s, l)
    # B: credit/width closest to 0.5
    best = None
    for _, s in c[(c.bid > 0) & (c.strike >= S)].iterrows():  # OTM/ATM only, see SPEC changes
        l = long_of(s.strike)
        if l is None:
            continue
        ratio = (s.mid - l.mid) / (l.strike - s.strike)
        if not (0 < ratio < 1):
            continue
        if best is None or abs(ratio - 0.5) < best[0]:
            best = (abs(ratio - 0.5), s, l)
    return None if best is None else (best[1], best[2])


# ---------------------------------------------------------------- simulation
def simulate(sym, df, spot, variant, w, k, stop, stop_mult=2.0, tp=None):
    """tp: take profit when the closing fill (at this k) is <= (1-tp)*credit; filled at that limit price
    (a resting buy-to-close limit; the close crossing it means the market traded through it that day)."""
    df = df.set_index(["date", "exp", "strike"]).sort_index()
    days = spot.index
    wk = pd.Series(days, index=days).groupby([days.isocalendar().year.values, days.isocalendar().week.values])
    trades, skips = [], {"no_expiry": 0, "no_strike": 0, "no_credit": 0, "no_settle": 0}
    for (_, _), wdays in wk:
        d0 = wdays.iloc[0]
        S0 = spot[d0]
        try:
            day = df.loc[d0]
        except KeyError:
            skips["no_expiry"] += 1; continue
        exps = [e for e in day.index.get_level_values(0).unique() if e > d0 and e.isocalendar()[:2] == d0.isocalendar()[:2]]
        if not exps:
            skips["no_expiry"] += 1; continue
        exp = max(exps)
        chain = day.loc[exp].reset_index()
        T = (exp - d0).days / 365.0
        p = pick(chain, S0, T, variant, w)
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
                    q = df.loc[(d, exp, K)]
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
            skips["no_settle"] += 1; continue
        comm = 2 * COMM + (2 * COMM if reason != "expiry" else 0)
        pnl = 100 * (credit - exit_cost) - comm
        S_end = spot[dx]
        trades.append(dict(sym=sym, variant=variant, w=w, k=k, stop=stop if stop else 0, stop_mult=stop_mult, tp=tp if tp else 0, entry=d0.date(), exp=exp.date(),
                           exit=dx.date(), reason=reason, S0=S0, S_exit=S_end, Ks=Ks, Kl=Kl, delta_s=round(float(s.delta), 3),
                           credit=round(credit, 4), width=Kl - Ks, cw=round(credit / (Kl - Ks), 3),
                           exit_cost=round(exit_cost, 4), pnl=round(pnl, 2), pnl_pct=pnl / (100 * S0) * 100,
                           stock_pnl=round(100 * (S_end - S0), 2)))
    return trades, skips


# ---------------------------------------------------------------- stats
def block_boot_mean(x, block=4, n=10000, seed=0):
    x = np.asarray(x, float); N = len(x)
    if N < 5:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed); p = 1 / block; means = np.empty(n)
    for i in range(n):
        idx = np.empty(N, int); j = rng.integers(N)
        for t in range(N):
            idx[t] = j
            j = rng.integers(N) if rng.random() < p else (j + 1) % N
        means[i] = x[idx].mean()
    return tuple(np.percentile(means, [2.5, 97.5]))


def weekly_series(t):
    """Average pnl% per trade across names for each entry week, in time order."""
    return t.groupby("entry").pnl_pct.mean().sort_index()


def main():
    data = {s: load(s) for s in SYMS}
    spot = {s: spots(s) for s in SYMS}
    rows = []
    for variant in ("A", "B"):
        for w in (0.05, 0.10):
            for k in (0.0, 0.5, 1.0):
                for stop in (0.08, None):
                    for s in SYMS:
                        tr, sk = simulate(s, data[s], spot[s], variant, w, k, stop, STOP_MULT, TP)
                        rows += tr
                        sk.update(sym=s, variant=variant, w=w, k=k, stop=stop if stop else 0, stop_mult=STOP_MULT)
                        SKIPS.append(sk)
                    print(variant, w, k, stop, len(rows), flush=True)
    t = pd.DataFrame(rows)
    t.to_csv(os.path.join(HERE, f"trades{SUFFIX}.csv"), index=False)
    pd.DataFrame(SKIPS).to_csv(os.path.join(HERE, f"skips{SUFFIX}.csv"), index=False)


SKIPS = []
# usage: backtest.py [stop_mult] [take_profit]
#   default 2 = user's rule, no take profit -> trades.csv; `1` -> trades_stop1.csv; `2 0.75` -> trades_tp75.csv
_ARGS = sys.argv[1:] if __name__ == "__main__" else []
STOP_MULT = float(_ARGS[0]) if len(_ARGS) > 0 else 2.0
TP = float(_ARGS[1]) if len(_ARGS) > 1 else None
SUFFIX = ("" if STOP_MULT == 2.0 else f"_stop{STOP_MULT:g}") + ("" if TP is None else f"_tp{round(TP * 100)}")
if __name__ == "__main__":
    main()
