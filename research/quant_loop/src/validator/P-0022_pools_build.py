"""V-0022-pools: P-0022 (sell weekly OTM put, daily delta hedge) on the ex-ante stock pools. Rule frozen, not changed.
Copied from P-0022_build.py and parameterised (pool directory, entry window, calendar, defect days).
Builds EVERY (stock, ISO-week, delta target) trade with a valid ret5 (signal and control alike); split is in the stats script.

Run:  research/spx_fly/.venv/bin/python src/validator/P-0022_pools_build.py <pool> [...]
  pool = 20181031 .. 20241031 (ex-ante pools; cache P-0022_pools_cache/<pool>, defects P-0022_pools_tables/defects_validator.csv)
         orig15        regression on the original 15, training period, new rules (market calendar, ret5-lookback rule)
         orig15compat  regression, V-0022 behaviour (stock's own trading days, no lookback rule) -> must equal V-0022 train
Output: P-0022_pools_tables/trades_<pool>.parquet, skipped_<pool>.parquet
"""
import os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
TAB = os.path.join(HERE, "P-0022_pools_tables")
R = 0.043
TARGETS = (-0.25, -0.10)
KS = (0.0, 0.5, 1.0)
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031", "20231031", "20241031"]
DATA_END = pd.Timestamp("2026-11-05")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()


def config(pool):
    if pool.startswith("orig15"):
        compat = pool == "orig15compat"
        return dict(cache=os.path.join(HERE, "P-0022_cache"), syms=SMALL, start=pd.Timestamp("2024-10-31"),
                    stop=pd.Timestamp("2025-11-01"), exp_lt=pd.Timestamp("2025-11-01"),
                    own_cal=compat, lookback_rule=not compat, defects={"WOLF": [pd.Timestamp("2025-10-10")]}, wolf_compat=compat)
    i = POOLS.index(pool)
    stop = pd.Timestamp(POOLS[i + 1]) if i + 1 < len(POOLS) else pd.Timestamp("2100-01-01")
    sys.path.insert(0, HERE)
    from importlib import import_module
    univ = import_module("P-0022_pools_cache").universe(pool)
    df = pd.read_csv(os.path.join(TAB, "defects_validator.csv"), parse_dates=["J"])
    df = df[(df.pool.astype(str) == pool) & (df.action == "exclude_span")]
    defects = {s: list(g.J) for s, g in df.groupby("sym")}
    return dict(cache=os.path.join(HERE, "P-0022_pools_cache", pool), syms=univ, start=pd.Timestamp(pool), stop=stop,
                exp_lt=None, own_cal=False, lookback_rule=True, defects=defects, wolf_compat=False)


# ---------- Black-Scholes (no dividends), own implementation (identical to P-0022_build.py) ----------
def bs_put(S, K, T, v):
    sd = v * np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * v * v) * T) / sd
    return K * np.exp(-R * T) * ndtr(-(d1 - sd)) - S * ndtr(-d1)


def put_delta(S, K, T, v):
    return ndtr((np.log(S / K) + (R + 0.5 * v * v) * T) / (v * np.sqrt(T))) - 1.0


def put_iv(S, K, T, px, lo=1e-3, hi=20.0, it=70):
    S, K, T, px = np.broadcast_arrays(*[np.asarray(x, float) for x in (S, K, T, px)])
    a = np.full(px.shape, np.log(lo)); b = np.full(px.shape, np.log(hi))
    for _ in range(it):
        m = 0.5 * (a + b)
        over = bs_put(S, K, T, np.exp(m)) > px
        b = np.where(over, m, b); a = np.where(over, a, m)
    ok = (bs_put(S, K, T, lo) < px) & (bs_put(S, K, T, hi) > px)
    return np.where(ok, np.exp(0.5 * (a + b)), np.nan)


def spot_series(cache, sym):
    """Daily close; closes <= 0 or not unique within a file are replaced by the parity close (flagged), else dropped."""
    c = pd.read_parquet(os.path.join(cache, f"{sym}_check.parquet"))
    c = c[c.rows > 0].set_index("date").sort_index()
    bad = (c.S <= 0) | (c.get("up_n", pd.Series(1, index=c.index)) > 1) | (c.get("up_min", c.S) <= 0)
    s = c.S.astype(float).copy()
    imputed = []
    if bad.any():
        for d in c.index[bad]:
            sp = c.S_par.get(d, np.nan) if "S_par" in c else np.nan
            if np.isfinite(sp) and sp > 0:
                s[d] = sp; imputed.append((sym, d, float(c.S[d]), float(sp)))
            else:
                s = s.drop(d); imputed.append((sym, d, float(c.S[d]), np.nan))
    return s, imputed


def run(args):
    pool, sym, cal = args
    cf = config(pool)
    q = pd.read_parquet(os.path.join(cf["cache"], f"{sym}_puts.parquet"))
    spot, imputed = spot_series(cf["cache"], sym)
    end = min(spot.index.max(), DATA_END)
    # ---- WINDOW / TIME WALL: first step after reading ----
    q = q[(q.date >= cf["start"]) & (q.date <= end)]
    if cf["exp_lt"] is not None:
        q = q[(q.date < cf["exp_lt"]) & (q.exp < cf["exp_lt"])]
        spot = spot[spot.index < cf["exp_lt"]]
        end = spot.index.max()
    q = q[(q.ask >= q.bid) & (q.ask > 0)].copy()
    q["mid"] = 0.5 * (q.bid + q.ask)
    sdays = spot.index
    mcal = sdays if cf["own_cal"] else cal
    iso = mcal.isocalendar()
    wk = pd.Series(mcal, index=mcal).groupby([iso.year.values, iso.week.values]).first().sort_values()
    wk = wk[(wk >= cf["start"]) & (wk < cf["stop"])]
    qi = q.set_index(["strike", "exp", "date"]).sort_index()
    byday = {d: g for d, g in q.groupby("date")}
    defects = cf["defects"].get(sym, [])
    out, miss = [], []
    for d0 in wk:
        if d0 not in sdays or d0 not in byday:
            miss.append((sym, d0, "no_chain_or_close")); continue
        i0 = mcal.get_loc(d0)
        lb = mcal[i0 - 5] if i0 >= 5 else None
        if lb is None or lb not in sdays:
            miss.append((sym, d0, "no_ret5")); continue
        S0 = float(spot[d0])
        ret5 = S0 / float(spot[lb]) - 1
        day = byday[d0]
        y, w = d0.isocalendar()[:2]
        exps = [e for e in day.exp.unique() if 2 <= (e - d0).days <= 6 and e.isocalendar()[:2] == (y, w)]
        if not exps:
            miss.append((sym, d0, "no_weekly_exp")); continue
        exp = max(exps)
        if cf["wolf_compat"] and sym == "WOLF":
            if d0 < pd.Timestamp("2025-10-13") and exp > pd.Timestamp("2025-09-26"):
                miss.append((sym, d0, "ca_span")); continue
        else:
            if any(d0 < J <= exp for J in defects):
                miss.append((sym, d0, "ca_span")); continue
            if cf["lookback_rule"] and any(lb < J <= d0 for J in defects):
                miss.append((sym, d0, "ca_ret5")); continue
        if exp > end or exp not in sdays:
            miss.append((sym, d0, "cannot_settle")); continue
        hold = sdays[(sdays > d0) & (sdays <= exp)]
        n_gap = int(((mcal > d0) & (mcal <= exp)).sum()) - len(hold)
        T0 = (exp - d0).days / 365.0
        ch = day[(day.exp == exp) & (day.bid > 0)].copy()
        ch["iv"] = put_iv(S0, ch.strike.values, T0, ch.mid.values)
        ch = ch[np.isfinite(ch.iv)]
        if ch.empty:
            miss.append((sym, d0, "no_priceable")); continue
        ch["dl"] = put_delta(S0, ch.strike.values, T0, ch.iv.values)
        ch = ch.sort_values("strike").reset_index(drop=True)
        n_chain0 = int((day.exp == exp).sum()); n_bid0 = int(((day.exp == exp) & (day.bid <= 0)).sum())
        Sp = np.r_[S0, spot.loc[hold].values.astype(float)]
        dts = np.diff(np.array([d.value for d in [d0] + list(hold)]) / 86400e9) / 365.0
        Ts = np.array([(exp - d).days / 365.0 for d in [d0] + list(hold[:-1])])
        for tgt in TARGETS:
            j = int((ch.dl - tgt).abs().values.argmin())
            r = ch.iloc[j]
            if abs(r.dl - tgt) > 0.05:
                miss.append((sym, d0, f"no_strike_{tgt}")); continue
            K = float(r.strike)
            try:
                path_q = qi.loc[(K, exp)]
            except KeyError:
                path_q = pd.DataFrame(columns=["mid"])
            ivs, sig, n_carry = [float(r.iv)], float(r.iv), 0
            for t, d in enumerate(hold[:-1]):
                v = np.nan
                if d in path_q.index:
                    v = float(put_iv(Sp[t + 1], K, Ts[t + 1], float(path_q.loc[d, "mid"])))
                if np.isfinite(v):
                    sig = v
                else:
                    n_carry += 1
                ivs.append(sig)
            h = put_delta(Sp[:-1], K, Ts, np.array(ivs))
            dS = np.diff(Sp)
            carry = R * Sp[:-1] * dts
            payoff = max(K - Sp[-1], 0.0)
            hedge_d = float(np.sum(h * (dS - carry)))
            cost_d = 5e-4 * (abs(h[0]) * Sp[0] + np.sum(np.abs(np.diff(h)) * Sp[1:-1]) + abs(h[-1]) * Sp[-1])
            hedge_s = float(h[0] * (Sp[-1] - Sp[0] - np.sum(carry)))
            cost_s = 5e-4 * abs(h[0]) * (Sp[0] + Sp[-1])
            hs = 0.5 * (r.ask - r.bid)
            rec = dict(pool=pool, sym=sym, entry=d0, exp=exp, dte=(exp - d0).days, tgt=tgt, K=K, S0=S0, ST=Sp[-1], ret5=ret5,
                       dl=float(r.dl), iv=float(r.iv), mid=float(r.mid), hs=hs, bid=float(r.bid), vol=float(r.vol),
                       n_chain=n_chain0, n_bid0=n_bid0, n_carry=n_carry, n_gap=n_gap, payoff=payoff,
                       hedge_d=hedge_d, cost_d=cost_d, hedge_s=hedge_s, cost_s=cost_s, n_hold=len(hold),
                       minS=float(Sp.min()), maxS=float(Sp.max()))
            for k in KS:
                base = (r.mid - k * hs) * (1 + R * T0) - payoff
                rec[f"none_k{k:g}"] = base / S0 * 100
                rec[f"static_k{k:g}"] = (base + hedge_s - cost_s) / S0 * 100
                rec[f"daily_k{k:g}"] = (base + hedge_d - cost_d) / S0 * 100
            rec["daily_k0.5_comm"] = rec["daily_k0.5"] - 0.01 / S0 * 100      # 1 USD / contract (descriptive)
            out.append(rec)
    return out, miss, imputed


def calendar(pool, syms):
    cf = config(pool)
    days = set()
    for s in syms:
        c = pd.read_parquet(os.path.join(cf["cache"], f"{s}_check.parquet"), columns=["date", "rows"])
        days |= set(c.date[c.rows > 0])
    return pd.DatetimeIndex(sorted(days))


if __name__ == "__main__":
    os.makedirs(TAB, exist_ok=True)
    for pool in sys.argv[1:]:
        cf = config(pool)
        cal = calendar(pool, cf["syms"])
        with Pool(8) as p:
            res = p.map(run, [(pool, s, cal) for s in cf["syms"]])
        t = pd.DataFrame([r for o, _, _ in res for r in o])
        m = pd.DataFrame([x for _, ms, _ in res for x in ms], columns=["sym", "entry", "why"])
        imp = pd.DataFrame([x for _, _, im in res for x in im], columns=["sym", "date", "S_file", "S_used"])
        assert t.entry.min() >= cf["start"] and t.entry.max() < cf["stop"]
        if cf["exp_lt"] is not None:
            assert t.exp.max() < cf["exp_lt"]
        t.to_parquet(os.path.join(TAB, f"trades_{pool}.parquet"))
        m.to_parquet(os.path.join(TAB, f"skipped_{pool}.parquet"))
        print(pool, len(t), t.entry.min().date(), t.entry.max().date(), t.exp.max().date(), "syms", t.sym.nunique(), "/", len(cf["syms"]))
        print("  skipped:", m.why.value_counts().to_dict())
        if len(imp):
            print("  closes replaced/dropped:", imp.to_dict("records"))
