"""V-0021-pools: one build of P-0021 (frozen rule) on the 7 ex-ante pools. RUN ONCE.
Copied from P-0021_build.py (my own V-0021 implementation) and parameterised per pool; does not import
research/call_spread_edge. Rule = P-0021 §2-§3; pre-registered choices = validations/V-0021-pools.md §0.

Entry: for each ISO week, the first day of the pool calendar (union of member file dates) that lies in the
pool window [selection day, next selection day); the member needs a file with S>0 on that day.
Exclusions (counted): no file / S<=0 on entry; no expiry with DTE in [14,28]; crossing one of MY defect days
(V-0021_pools_defects.csv: entry < J <= expiry); expiry without a file (unsettleable); no usable quote; no
strike with |Δ-0.35|<=0.05 (per target). Only rows with root = member code (SQ+XYZ, OSTK+BYON) are used.

Per trade pnl in % of S0 (per 1 share notional), Δ ∈ {0.15,0.25,0.35,0.50}, k ∈ {0,0.5,1}:
  static = max(S_T-K,0) - (mid+k·hs)(1+rT) - h0(S_T-S0) + h0 Σ r S_t dt_t - 5bp·h0(S0+S_T)
  daily  = max(S_T-K,0) - (mid+k·hs)(1+rT) - Σ h_t (S_{t+1}-S_t - r S_t dt_t) - 5bp·turnover
  static_r0 (sensitivity, §0.5 item 9): same with r = 0 in the financing / interest terms only.
"""
import json, os, sys
from collections import Counter
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.special import ndtr
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cc", os.path.join(HERE, "V-0021_pools_cache.py"))
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)
TD = os.path.join(HERE, "V-0021_pools_tables")
R = 0.043
TGTS = (0.15, 0.25, 0.35, 0.50)
KS = (0.0, 0.5, 1.0)
WALL = pd.Timestamp("2025-11-01")
SEL = [pd.Timestamp(p) for p in cc.POOLS]
WEND = {p: (SEL[i + 1] if i + 1 < len(SEL) else pd.Timestamp("2100-01-01")) for i, p in enumerate(cc.POOLS)}


def bs_call(S, K, T, v):
    sd = v * np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * v * v) * T) / sd
    return S * ndtr(d1) - K * np.exp(-R * T) * ndtr(d1 - sd)


def call_delta(S, K, T, v):
    return ndtr((np.log(S / K) + (R + 0.5 * v * v) * T) / (v * np.sqrt(T)))


def call_iv(S, K, T, px):
    S, K, T, px = np.broadcast_arrays(*(np.asarray(x, float) for x in (S, K, T, px)))
    lo_b, hi_b = np.log(0.005), np.log(20.0)
    a = np.full(px.shape, lo_b); b = np.full(px.shape, hi_b)
    for _ in range(70):
        m = 0.5 * (a + b)
        over = bs_call(S, K, T, np.exp(m)) > px
        b = np.where(over, m, b); a = np.where(over, a, m)
    ok = (bs_call(S, K, T, 0.005) < px) & (bs_call(S, K, T, 20.0) > px)
    return np.where(ok, np.exp(0.5 * (a + b)), np.nan)


def allowed(sym):
    return {sym, "XYZ"} if sym == "SQ" else ({sym, "BYON"} if sym == "OSTK" else {sym})


def run(args):
    pool, sym, entries, defects = args
    cnt = Counter()
    calls = pd.read_parquet(os.path.join(cc.OUT, pool, f"{sym}_calls.parquet"))
    meta = pd.read_parquet(os.path.join(cc.OUT, pool, f"{sym}_files.parquet"))
    meta = meta[(meta.nrows > 0)]
    cnt["S<=0 days"] = int((meta.S <= 0).sum())
    spot = meta[meta.S > 0].set_index("date").S.sort_index()
    days = spot.index
    cnt["other-root rows"] = int((~calls.root.isin(allowed(sym))).sum())
    calls = calls[calls.root.isin(allowed(sym))]
    calls = calls[(calls.ask > 0) & (calls.ask >= calls.bid)].copy()
    n0 = len(calls)
    calls = calls.drop_duplicates(["date", "exp", "strike"])
    cnt["dup quote rows"] = n0 - len(calls)
    calls["mid"] = 0.5 * (calls.bid + calls.ask)
    by_day = {d: g for d, g in calls.groupby("date")}
    q = calls.set_index(["exp", "strike", "date"]).mid.sort_index()
    rows, liq = [], []
    for d0 in entries:
        cnt["symbol-weeks"] += 1
        if d0 not in by_day or d0 not in spot.index:
            cnt["x no file/S on entry"] += 1; continue
        ch0 = by_day[d0]
        S0 = float(spot[d0])
        exps = np.array(sorted(ch0.exp.unique()))
        dte = np.array([(e - d0).days for e in exps])
        ok = (dte >= 14) & (dte <= 28)
        if not ok.any():
            cnt["x no expiry DTE 14-28"] += 1; continue
        exp = sorted(zip(np.abs(dte[ok] - 21), exps[ok]))[0][1]
        if any(d0 < J <= exp for J in defects):
            cnt["x crosses defect day"] += 1; continue
        hold = days[(days > d0) & (days <= exp)]
        if len(hold) == 0 or hold[-1] != exp:
            cnt["x unsettleable (no file at expiry)"] += 1; continue
        T0 = (exp - d0).days / 365.0
        ch = ch0[ch0.exp == exp].copy()
        ch["iv"] = call_iv(S0, ch.strike.values, T0, ch.mid.values)
        ch["dl"] = call_delta(S0, ch.strike.values, T0, ch.iv.values)
        reg = ch[np.isfinite(ch.dl) & (ch.dl >= 0.10) & (ch.dl <= 0.60)]
        liq.append(dict(pool=pool, sym=sym, entry=d0, n=len(reg), bid0=int((reg.bid <= 0).sum())))
        ch = ch[np.isfinite(ch.iv) & (ch.bid > 0)]
        if ch.empty:
            cnt["x no usable quote"] += 1; continue
        Sp = np.r_[S0, spot.loc[hold].values.astype(float)]
        tdays = [d0] + list(hold)
        Ts = np.array([(exp - d).days / 365.0 for d in tdays[:-1]])
        dt = -np.diff(np.r_[Ts, 0.0])
        carry = R * Sp[:-1] * dt
        dS = np.diff(Sp)
        iso = d0.isocalendar()
        for tgt in TGTS:
            i = int(np.argmin(np.abs(ch.dl.values - tgt)))
            r = ch.iloc[i]
            if abs(r.dl - tgt) > 0.05:
                cnt[f"x no strike within 0.05 of Δ{tgt}"] += 1; continue
            K = float(r.strike)
            ivs = [float(r.iv)]
            for d in hold[:-1]:
                v = np.nan
                key = (exp, K, d)
                if key in q.index:
                    v = float(call_iv(spot[d], K, (exp - d).days / 365.0, float(q.loc[key])))
                ivs.append(v if np.isfinite(v) else ivs[-1])
            ivs = np.array(ivs)
            h = call_delta(Sp[:-1], K, Ts, ivs)
            h0 = h[0]
            payoff = max(Sp[-1] - K, 0.0)
            hs = 0.5 * (r.ask - r.bid)
            sta_hedge = -h0 * (Sp[-1] - Sp[0]) + h0 * carry.sum()
            sta_hedge_r0 = -h0 * (Sp[-1] - Sp[0])
            dyn_hedge = -np.sum(h * (dS - carry))
            turn_sta = h0 * (Sp[0] + Sp[-1])
            turn_dyn = h[0] * Sp[0] + np.sum(np.abs(np.diff(h)) * Sp[1:-1]) + h[-1] * Sp[-1]
            base = dict(pool=pool, sym=sym, entry=d0, iso_y=int(iso[0]), iso_w=int(iso[1]), exp=exp, dte=(exp - d0).days,
                        tgt=tgt, K=K, S0=S0, ST=Sp[-1], dl=float(r.dl), iv=float(r.iv), mid=float(r.mid), hs=hs,
                        bid=float(r.bid), ask=float(r.ask), vol=float(r.vol), payoff=payoff, h0=float(h0),
                        nsteps=len(dS), hedge_sta=sta_hedge, hedge_dyn=dyn_hedge,
                        path=json.dumps([round(x, 6) for x in Sp]))
            for k in KS:
                prem = (r.mid + k * hs) * (1 + R * T0)
                base[f"sta_k{k:g}"] = (payoff - prem + sta_hedge - 5e-4 * turn_sta) / S0 * 100
                base[f"dyn_k{k:g}"] = (payoff - prem + dyn_hedge - 5e-4 * turn_dyn) / S0 * 100
                base[f"sta_r0_k{k:g}"] = (payoff - (r.mid + k * hs) + sta_hedge_r0 - 5e-4 * turn_sta) / S0 * 100
            rows.append(dict(base))
            cnt[f"trades Δ{tgt}"] += 1
    return rows, liq, dict(pool=pool, sym=sym, **cnt)


if __name__ == "__main__":
    out = os.path.join(TD, "trades.parquet")
    if os.path.exists(out):
        raise SystemExit("trades table already exists -- the pools are built once")
    dfx = pd.read_csv(os.path.join(HERE, "V-0021_pools_defects.csv"), parse_dates=["day"])
    jobs = []
    for pool in cc.POOLS:
        syms = cc.members(pool)
        cal = set()
        for s in syms:
            m = pd.read_parquet(os.path.join(cc.OUT, pool, f"{s}_files.parquet"))
            cal |= set(m.date[m.nrows > 0])
        cal = pd.DatetimeIndex(sorted(cal))
        cal = cal[(cal >= pd.Timestamp(pool)) & (cal < WEND[pool])]
        iso = cal.isocalendar()
        entries = list(pd.Series(cal, index=cal).groupby([iso.year.values, iso.week.values]).min().sort_values())
        for s in syms:
            J = list(dfx[(dfx.pool.astype(str) == pool) & (dfx.sym == s)].day)
            jobs.append((pool, s, entries, J))
    with Pool(6) as p:
        res = p.map(run, jobs)
    t = pd.DataFrame([r for rows, _, _ in res for r in rows])
    lq = pd.DataFrame([r for _, l, _ in res for r in l])
    cn = pd.DataFrame([c for _, _, c in res]).fillna(0)
    t["seg"] = "all"
    m24 = t.pool == "20241031"
    t.loc[m24 & (t.entry < WALL) & (t.exp < WALL), "seg"] = "train"
    t.loc[m24 & (t.entry >= WALL), "seg"] = "test"
    t.loc[m24 & (t.entry < WALL) & (t.exp >= WALL), "seg"] = "straddle"
    for pool in cc.POOLS:
        g = t[t.pool == pool]
        assert g.entry.min() >= pd.Timestamp(pool) and g.entry.max() < WEND[pool]
    os.makedirs(TD, exist_ok=True)
    t.to_parquet(out)
    lq.to_parquet(os.path.join(TD, "liq.parquet"))
    cn.to_csv(os.path.join(TD, "exclusion_counts.csv"), index=False)
    print(len(t), t.groupby(["pool", "tgt"]).size().unstack())
