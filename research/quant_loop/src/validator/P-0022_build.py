"""V-0022 independent implementation of P-0022 (sell weekly OTM put, daily delta hedge), written from the data dictionary.
Builds EVERY (stock, ISO-week, delta target) trade of the period (signal and control alike); the ret5 split is done in P-0022_stats.py.

Run:  research/spx_fly/.venv/bin/python src/validator/P-0022_build.py train|test|etf
  train : entry < 2025-11-01 and expiry < 2025-11-01          (small caps)
  test  : entry >= 2025-11-01 and expiry <= last data day       (small caps)  -- run ONCE
  etf   : SPY/QQQ/IWM, all entries 2022-05-02 .. data end (background only; split is done in stats)
Output: src/validator/P-0022_tables/trades_<period>.parquet
"""
import os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "P-0022_cache")
TAB = os.path.join(HERE, "P-0022_tables")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()
ETF = "SPY QQQ IWM".split()
WALL = pd.Timestamp("2025-11-01")
R = 0.043
TARGETS = (-0.25, -0.10)
KS = (0.0, 0.5, 1.0)
WOLF_OLD_LAST, WOLF_NEW = pd.Timestamp("2025-09-26"), pd.Timestamp("2025-10-13")
PERIOD = sys.argv[1] if len(sys.argv) > 1 else "train"


# ---------- Black-Scholes (no dividends), own implementation ----------
def bs_put(S, K, T, v):
    sd = v * np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * v * v) * T) / sd
    return K * np.exp(-R * T) * ndtr(-(d1 - sd)) - S * ndtr(-d1)


def put_delta(S, K, T, v):
    return ndtr((np.log(S / K) + (R + 0.5 * v * v) * T) / (v * np.sqrt(T))) - 1.0


def put_iv(S, K, T, px, lo=1e-3, hi=20.0, it=70):
    """Vectorised bisection on log-vol. NaN when px is outside (BS(lo), BS(hi)) (e.g. mid below intrinsic)."""
    S, K, T, px = np.broadcast_arrays(*[np.asarray(x, float) for x in (S, K, T, px)])
    a = np.full(px.shape, np.log(lo)); b = np.full(px.shape, np.log(hi))
    for _ in range(it):
        m = 0.5 * (a + b)
        over = bs_put(S, K, T, np.exp(m)) > px
        b = np.where(over, m, b); a = np.where(over, a, m)
    ok = (bs_put(S, K, T, lo) < px) & (bs_put(S, K, T, hi) > px)
    return np.where(ok, np.exp(0.5 * (a + b)), np.nan)


def load(sym):
    q = pd.read_parquet(os.path.join(CACHE, f"{sym}_puts.parquet"))
    spot = pd.read_parquet(os.path.join(CACHE, f"{sym}_check.parquet")).set_index("date").S.sort_index()
    end = spot.index.max()
    # ---- TIME WALL: first step after reading ----
    if PERIOD == "train":
        q = q[(q.date < WALL) & (q.exp < WALL)]
        spot = spot[spot.index < WALL]
    elif PERIOD == "test":
        q = q[(q.date >= WALL) & (q.exp <= end)]
        # spot before the wall is kept ONLY for the 5-day lookback of ret5 (closes known at entry)
    q = q[(q.ask >= q.bid) & (q.ask > 0)].copy()
    q["mid"] = 0.5 * (q.bid + q.ask)
    return q, spot, end


def run(sym):
    q, spot, end = load(sym)
    days = spot.index
    iso = days.isocalendar()
    wk = pd.Series(days, index=days).groupby([iso.year.values, iso.week.values]).first().sort_values()
    if PERIOD == "test":
        wk = wk[wk >= WALL]
    qi = q.set_index(["strike", "exp", "date"]).sort_index()
    byday = {d: g for d, g in q.groupby("date")}
    out, miss = [], []
    for d0 in wk:
        i0 = days.get_loc(d0)
        S0 = float(spot.iloc[i0])
        ret5 = S0 / float(spot.iloc[i0 - 5]) - 1 if i0 >= 5 else np.nan
        day = byday.get(d0)
        if day is None:
            miss.append((sym, d0, "no_chain")); continue
        y, w = d0.isocalendar()[:2]
        exps = [e for e in day.exp.unique() if 2 <= (e - d0).days <= 6 and e.isocalendar()[:2] == (y, w)]
        if not exps:
            miss.append((sym, d0, "no_weekly_exp")); continue
        exp = max(exps)
        if sym == "WOLF" and d0 < WOLF_NEW and exp > WOLF_OLD_LAST:
            miss.append((sym, d0, "wolf_defect")); continue
        if exp > end or exp not in days:
            miss.append((sym, d0, "exp_not_trading_day")); continue
        hold = days[(days > d0) & (days <= exp)]
        T0 = (exp - d0).days / 365.0
        ch = day[(day.exp == exp) & (day.bid > 0)].copy()
        ch["iv"] = put_iv(S0, ch.strike.values, T0, ch.mid.values)
        ch = ch[np.isfinite(ch.iv)]
        if ch.empty:
            miss.append((sym, d0, "no_priceable")); continue
        ch["dl"] = put_delta(S0, ch.strike.values, T0, ch.iv.values)
        ch = ch.sort_values("strike").reset_index(drop=True)
        n_chain0 = int(((day.exp == exp)).sum()); n_bid0 = int(((day.exp == exp) & (day.bid <= 0)).sum())
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
            h = put_delta(Sp[:-1], K, Ts, np.array(ivs))          # shares held over each step (negative = short)
            dS = np.diff(Sp)
            carry = R * Sp[:-1] * dts
            payoff = max(K - Sp[-1], 0.0)
            hedge_d = float(np.sum(h * (dS - carry)))
            cost_d = 5e-4 * (abs(h[0]) * Sp[0] + np.sum(np.abs(np.diff(h)) * Sp[1:-1]) + abs(h[-1]) * Sp[-1])
            hedge_s = float(h[0] * (Sp[-1] - Sp[0] - np.sum(carry)))
            cost_s = 5e-4 * abs(h[0]) * (Sp[0] + Sp[-1])
            hs = 0.5 * (r.ask - r.bid)
            rec = dict(sym=sym, entry=d0, exp=exp, dte=(exp - d0).days, tgt=tgt, K=K, S0=S0, ST=Sp[-1], ret5=ret5,
                       dl=float(r.dl), iv=float(r.iv), mid=float(r.mid), hs=hs, bid=float(r.bid), vol=float(r.vol),
                       n_chain=n_chain0, n_bid0=n_bid0, n_carry=n_carry, payoff=payoff,
                       hedge_d=hedge_d, cost_d=cost_d, hedge_s=hedge_s, cost_s=cost_s, n_hold=len(hold))
            for k in KS:
                base = (r.mid - k * hs) * (1 + R * T0) - payoff
                rec[f"none_k{k:g}"] = base / S0 * 100
                rec[f"static_k{k:g}"] = (base + hedge_s - cost_s) / S0 * 100
                rec[f"daily_k{k:g}"] = (base + hedge_d - cost_d) / S0 * 100
                if PERIOD == "etf":   # ETF hedge cost 1 bp (SPEC); daily cost scales linearly
                    rec[f"daily1bp_k{k:g}"] = (base + hedge_d - cost_d / 5) / S0 * 100
            out.append(rec)
    return out, miss


if __name__ == "__main__":
    os.makedirs(TAB, exist_ok=True)
    syms = ETF if PERIOD == "etf" else SMALL
    with Pool(min(8, len(syms))) as p:
        res = p.map(run, syms)
    t = pd.DataFrame([r for o, _ in res for r in o])
    m = pd.DataFrame([x for _, ms in res for x in ms], columns=["sym", "entry", "why"])
    if PERIOD == "train":
        assert t.entry.max() < WALL and t.exp.max() < WALL
    if PERIOD == "test":
        assert t.entry.min() >= WALL
    t.to_parquet(os.path.join(TAB, f"trades_{PERIOD}.parquet"))
    m.to_parquet(os.path.join(TAB, f"skipped_{PERIOD}.parquet"))
    print(PERIOD, len(t), t.entry.min().date(), t.entry.max().date(), t.exp.max().date())
    print(m.why.value_counts().to_string())
