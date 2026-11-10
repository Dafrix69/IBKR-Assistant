"""V-0021 independent build: long ~3-week call vs Δ shares (static hedge) and the same call delta-hedged daily.
Written from the data dictionary + P-0021 §2–§3; does not import research/call_spread_edge.

Usage:
  P-0021_build.py train            small caps, entry < 2025-11-01 and expiry < 2025-11-01
  P-0021_build.py test             small caps, entry >= 2025-11-01, expiry <= last data day   (RUN ONCE)
  P-0021_build.py etf_train START  SPY/QQQ/IWM, START <= entry, entry & expiry < 2025-11-01
  P-0021_build.py etf_test         SPY/QQQ/IWM, entry >= 2025-11-01

Per trade (pnl per 1 share of notional, in % of S0), for target Δ ∈ {0.15,0.25,0.35,0.50}, k ∈ {0,0.5,1}:
  static = max(S_T-K,0) - (mid+k·hs)(1+rT) - h0(S_T-S0) + h0 Σ r S_t dt_t - c(h0 S0 + h0 S_T)
  daily  = max(S_T-K,0) - (mid+k·hs)(1+rT) - Σ h_t (S_{t+1}-S_t - r S_t dt_t) - c(h_0 S_0 + Σ|h_t-h_{t-1}| S_t + h_last S_T)
  h_t = BS call delta at that close with the contract's own mid-implied vol (carried forward when no usable quote).
T, dt in calendar days / 365; r = 4.3 %; no dividends; c = 5 bp (small caps), ETF 5 bp and 1 bp both stored.
"""
import json, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, "V-0021_cache")
OUTD = os.path.join(HERE, "V-0021_tables")
SMALL = "ALAB APLD AXTI CLSK CRDO IREN LITE NBIS NVTS OKLO QBTS QUBT RKLB SNDK WOLF".split()
ETF = "SPY QQQ IWM".split()
WALL = pd.Timestamp("2025-11-01")
R = 0.043
TGTS = (0.15, 0.25, 0.35, 0.50)
KS = (0.0, 0.5, 1.0)
WOLF_OLD_LAST, WOLF_NEW = pd.Timestamp("2025-09-26"), pd.Timestamp("2025-10-13")


def bs_call(S, K, T, v):
    sd = v * np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * v * v) * T) / sd
    return S * ndtr(d1) - K * np.exp(-R * T) * ndtr(d1 - sd)


def call_delta(S, K, T, v):
    return ndtr((np.log(S / K) + (R + 0.5 * v * v) * T) / (v * np.sqrt(T)))


def call_iv(S, K, T, px):
    """Vectorised bisection on log-vol in [0.005, 20]; NaN when px is outside the no-arbitrage band."""
    S, K, T, px = np.broadcast_arrays(*(np.asarray(x, float) for x in (S, K, T, px)))
    lo_b, hi_b = np.log(0.005), np.log(20.0)
    a = np.full(px.shape, lo_b); b = np.full(px.shape, hi_b)
    for _ in range(70):
        m = 0.5 * (a + b)
        over = bs_call(S, K, T, np.exp(m)) > px
        b = np.where(over, m, b); a = np.where(over, a, m)
    ok = (bs_call(S, K, T, 0.005) < px) & (bs_call(S, K, T, 20.0) > px)
    return np.where(ok, np.exp(0.5 * (a + b)), np.nan)


def load(sym, mode, start):
    calls = pd.read_parquet(os.path.join(C, f"{sym}_calls.parquet"))
    spot = pd.read_parquet(os.path.join(C, f"{sym}_spot.parquet")).set_index("date").S.sort_index()
    # ---- time wall: first step after reading ----
    if mode == "train":
        calls = calls[(calls.date >= start) & (calls.date < WALL) & (calls.exp < WALL)]
        spot = spot[(spot.index >= start) & (spot.index < WALL)]
    else:
        calls = calls[calls.date >= WALL]
        spot = spot[spot.index >= WALL]
        calls = calls[calls.exp <= spot.index.max()]
    return calls, spot


def run(args):
    sym, mode, start = args
    calls, spot = load(sym, mode, start)
    days = spot.index
    calls = calls[(calls.ask > 0) & (calls.ask >= calls.bid)].copy()
    calls["mid"] = 0.5 * (calls.bid + calls.ask)
    by_day = {d: g for d, g in calls.groupby("date")}
    q = calls.set_index(["exp", "strike", "date"]).mid.sort_index()
    iso = days.isocalendar()
    wk = pd.Series(days, index=days).groupby([iso.year.values, iso.week.values]).min()
    rows, liq = [], []
    for (y, w), d0 in wk.items():
        if d0 not in by_day:
            continue
        ch0 = by_day[d0]
        S0 = float(spot[d0])
        exps = np.array(sorted(ch0.exp.unique()))
        dte = np.array([(e - d0).days for e in exps])
        ok = (dte >= 14) & (dte <= 28)
        if not ok.any():
            continue
        cand = sorted(zip(np.abs(dte[ok] - 21), exps[ok]))
        exp = cand[0][1]
        if sym == "WOLF" and d0 < WOLF_NEW and exp > WOLF_OLD_LAST:
            continue
        hold = days[(days > d0) & (days <= exp)]
        if len(hold) == 0 or hold[-1] != exp:
            continue
        T0 = (exp - d0).days / 365.0
        ch = ch0[ch0.exp == exp].copy()
        ch["iv"] = call_iv(S0, ch.strike.values, T0, ch.mid.values)
        ch["dl"] = call_delta(S0, ch.strike.values, T0, ch.iv.values)
        # liquidity of the 0.15..0.55 Δ region (with bid=0 quotes included, IV from mid)
        reg = ch[np.isfinite(ch.dl) & (ch.dl >= 0.10) & (ch.dl <= 0.60)]
        liq.append(dict(sym=sym, entry=d0, n=len(reg), bid0=int((reg.bid <= 0).sum())))
        ch = ch[np.isfinite(ch.iv) & (ch.bid > 0)]
        if ch.empty:
            continue
        Sp = np.r_[S0, spot.loc[hold].values.astype(float)]
        tdays = [d0] + list(hold)
        Ts = np.array([(exp - d).days / 365.0 for d in tdays[:-1]])
        dt = -np.diff(np.r_[Ts, 0.0])
        carry = R * Sp[:-1] * dt
        dS = np.diff(Sp)
        for tgt in TGTS:
            i = int(np.argmin(np.abs(ch.dl.values - tgt)))
            r = ch.iloc[i]
            if abs(r.dl - tgt) > 0.05:
                continue
            K = float(r.strike)
            ivs = [float(r.iv)]
            ivc = [float(r.iv)]
            for d in hold[:-1]:
                v = np.nan
                key = (exp, K, d)
                if key in q.index:
                    m = q.loc[key]
                    m = float(m.iloc[0]) if isinstance(m, pd.Series) else float(m)
                    v = float(call_iv(spot[d], K, (exp - d).days / 365.0, m))
                ivs.append(v if np.isfinite(v) else ivs[-1])
                ivc.append(v if (np.isfinite(v) and 0.01 <= v <= 10.0) else ivc[-1])
            ivs = np.array(ivs)
            # variant: proposer-style IV band [0.01, 10] (outside → carry forward), for the reconciliation only
            h10 = call_delta(Sp[:-1], K, Ts, np.array(ivc))
            dyn10 = -np.sum(h10 * (dS - carry))
            turn10 = h10[0] * Sp[0] + np.sum(np.abs(np.diff(h10)) * Sp[1:-1]) + h10[-1] * Sp[-1]
            h = call_delta(Sp[:-1], K, Ts, ivs)
            h0 = h[0]
            payoff = max(Sp[-1] - K, 0.0)
            hs = 0.5 * (r.ask - r.bid)
            sta_hedge = -h0 * (Sp[-1] - Sp[0]) + h0 * carry.sum()
            dyn_hedge = -np.sum(h * (dS - carry))
            turn_sta = h0 * (Sp[0] + Sp[-1])
            turn_dyn = h[0] * Sp[0] + np.sum(np.abs(np.diff(h)) * Sp[1:-1]) + h[-1] * Sp[-1]
            base = dict(sym=sym, entry=d0, iso_y=int(y), iso_w=int(w), exp=exp, dte=(exp - d0).days, tgt=tgt, K=K, S0=S0,
                        ST=Sp[-1], dl=float(r.dl), iv=float(r.iv), mid=float(r.mid), hs=hs, bid=float(r.bid), ask=float(r.ask),
                        vol=float(r.vol), payoff=payoff, h0=float(h0), nsteps=len(dS), turn_sta=turn_sta, turn_dyn=turn_dyn,
                        hedge_sta=sta_hedge, hedge_dyn=dyn_hedge, path=json.dumps([round(x, 6) for x in Sp]),
                        ivpath=json.dumps([round(x, 6) for x in ivs]), Ts=json.dumps([round(x, 8) for x in Ts]))
            for k in KS:
                prem = (r.mid + k * hs) * (1 + R * T0)
                for bps, tag in ((5e-4, ""), (1e-4, "_1bp")):
                    base[f"sta_k{k:g}{tag}"] = (payoff - prem + sta_hedge - bps * turn_sta) / S0 * 100
                    base[f"dyn_k{k:g}{tag}"] = (payoff - prem + dyn_hedge - bps * turn_dyn) / S0 * 100
                base[f"none_k{k:g}"] = (payoff - prem) / S0 * 100
                base[f"dyn10_k{k:g}"] = (payoff - prem + dyn10 - 5e-4 * turn10) / S0 * 100
            rows.append(dict(base))
    return rows, liq


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "train":
        jobs, tag, m, start = SMALL, "train", "train", pd.Timestamp("2000-01-01")
    elif mode == "test":
        jobs, tag, m, start = SMALL, "test", "test", None
    elif mode == "etf_train":
        start = pd.Timestamp(sys.argv[2]); jobs, tag, m = ETF, f"etf_train_{start.date()}", "train"
    elif mode == "etf_test":
        jobs, tag, m, start = ETF, "etf_test", "test", None
    else:
        raise SystemExit(mode)
    out = os.path.join(OUTD, f"trades_{tag}.parquet")
    if mode == "test" and os.path.exists(out):
        raise SystemExit("test table already exists -- the test period is run once")
    with Pool(8) as p:
        res = p.map(run, [(s, m, start) for s in jobs])
    t = pd.DataFrame([r for rows, _ in res for r in rows])
    lq = pd.DataFrame([r for _, l in res for r in l])
    if m == "train":
        assert t.entry.max() < WALL and t.exp.max() < WALL
    else:
        assert t.entry.min() >= WALL
    os.makedirs(OUTD, exist_ok=True)
    t.to_parquet(out)
    lq.to_parquet(os.path.join(OUTD, f"liq_{tag}.parquet"))
    print(tag, len(t), t.entry.min().date(), t.entry.max().date(), t.exp.max().date())
