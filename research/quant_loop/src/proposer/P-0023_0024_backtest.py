"""P-0023 / P-0024 training-period backtest (round 23, B-pools).

For every monthly-expiry cycle and every stock in the pool: signals at t (IVOL, VOL, VOV, VOV+),
and the delta-hedged short ATM call (and put, descriptive) entered at t+1 = E, held to expiry M.
Grouping into quintiles and all statistics are in P-0023_analyze.py / P-0024_analyze.py.

TIME WALL: entry AND exit < 2023-10-31. The cache (P-0023_0024_common.py) never opens a file dated
>= 2023-10-31 and only the five pools 2018..2022; first step after loading the cache filters again.
"""
import os, sys, importlib.util
import numpy as np
import pandas as pd
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("c", os.path.join(HERE, "P-0023_0024_common.py"))
C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
WALL = C.WALL
HEDGE_FEE = 0.0005
WIN = 21


def wall(df, col="date"):
    return df[df[col] < WALL]


def bs_delta(S, K, T, r, s, right):
    if T <= 0 or s <= 0:
        return (1.0 if S > K else 0.0) if right == "C" else (-1.0 if S < K else 0.0)
    d1 = (np.log(S / K) + (r + 0.5 * s * s) * T) / (s * np.sqrt(T))
    return norm.cdf(d1) if right == "C" else norm.cdf(d1) - 1.0


def iv21_series(atm):
    """Constant 21-day ATM IV by total-variance interpolation between bracketing expiries."""
    out = {}
    for d, g in atm.groupby("date"):
        g = g.dropna(subset=["atm_iv"])
        lo = g[(g["dte"] >= 5) & (g["dte"] <= 21)]
        hi = g[(g["dte"] >= 21) & (g["dte"] <= 30)]
        if len(lo) == 0 or len(hi) == 0:
            continue
        a = lo.loc[lo["dte"].idxmax()]
        b = hi.loc[hi["dte"].idxmin()]
        if a["dte"] == 21:
            out[d] = a["atm_iv"]; continue
        if b["dte"] == 21:
            out[d] = b["atm_iv"]; continue
        T1, T2 = a["dte"], b["dte"]
        w = (21 - T1) / (T2 - T1)
        v = ((1 - w) * a["atm_iv"] ** 2 * T1 + w * b["atm_iv"] ** 2 * T2) / 21
        out[d] = np.sqrt(v) if v > 0 else np.nan
    return pd.Series(out, dtype=float)


def run_pool(pool, defects, log):
    res = C.build_pool(pool)
    sel = pd.Timestamp(pool); nxt = pd.Timestamp(C.NEXT_SEL[pool])
    syms = sorted(res)
    # ---- time wall, first step after loading ----
    spot = {s: wall(res[s][0]).set_index("date")["S"] for s in syms}
    mon = {s: wall(wall(res[s][1]), "expiration") for s in syms}
    atm = {s: wall(res[s][2]) for s in syms}
    chk = {s: wall(res[s][3]) for s in syms}
    rr = pd.concat([wall(res[s][5]) for s in syms])
    cal = sorted(set().union(*[set(spot[s].index) for s in syms]))
    cal = pd.DatetimeIndex(cal)
    rate = rr.groupby("date")["r"].median().reindex(cal).ffill().bfill()

    # ---- data self-checks (new findings are printed; flagged days are treated like exclude_span) ----
    dpool = defects[defects["pool"] == pool]
    known = set(zip(dpool["sym"], dpool["day"]))
    flags = []
    for s in syms:
        c = chk[s]
        f = c[(c["jump"].abs() > 0.35) | (c["min_kept"] < 0.6)]
        for _, row in f.iterrows():
            flags.append((pool, s, row["date"].date(), row["prev_date"].date(), round(row["jump"], 3),
                          round(row["min_kept"], 3) if pd.notna(row["min_kept"]) else None, int(row["n_common_exp"]),
                          any(sy == s and abs((dd - row["date"]).days) <= 5 for sy, dd in known)))
        z = spot[s][(spot[s] <= 0) | spot[s].isna()]
        for d in z.index:
            flags.append((pool, s, d.date(), None, None, None, 0, False, ))
    # events used for exclusion: canonical defects + own grid-replacement flags (min_kept < 0.6)
    ev = [(r_.sym, r_.day, r_.action) for r_ in dpool.itertuples()]
    for (pl, s, d, d0, j, mk, nce, kn) in flags:
        if mk is not None and mk < 0.6 and not kn:
            ev.append((s, pd.Timestamp(d), "exclude_span_self"))

    # ---- returns and market basket (leave-one-out EW of the pool) ----
    P = pd.DataFrame({s: spot[s] for s in syms}).reindex(cal)
    R = P / P.shift(1) - 1
    for s, d, a in ev:
        if a.startswith("exclude_span") and s in R.columns and d in R.index:
            R.loc[d, s] = np.nan
    tot = R.sum(axis=1, min_count=1); cnt = R.notna().sum(axis=1)
    # ---- 21-day ATM IV and vol-returns ----
    IV = pd.DataFrame({s: iv21_series(atm[s]) for s in syms}).reindex(cal)
    VR = IV / IV.shift(1) - 1
    for s, d, a in ev:
        if a.startswith("exclude_span") and s in VR.columns and d in VR.index:
            VR.loc[d, s] = np.nan

    # ---- cycles ----
    allexp = set()
    for s in syms:
        allexp |= set(mon[s]["expiration"].unique())
    mexp = sorted(e for e in C.monthly_expiries(list(allexp)) if e < WALL)
    cyc = []
    for M in mexp:
        cand = cal[(cal >= M - pd.Timedelta(days=30)) & (cal < M)]
        if len(cand) == 0:
            continue
        E = cand[0]
        if not (sel <= E < nxt) or M >= WALL:
            continue
        i = cal.get_loc(E)
        if i - 1 < WIN:
            continue
        cyc.append((M, E, cal[i - 1], i - 1))
    log.append(f"[{pool}] cycles {len(cyc)}: " + ", ".join(f"{E.date()}->{M.date()}" for M, E, t, _ in cyc))

    rows = []
    stats = dict(carry=0, marks=0)
    for M, E, t, it in cyc:
        w0 = it - WIN + 1                 # first return row in the window
        win_first_date = cal[w0 - 1]      # earliest price used
        for s in syms:
            # ---- signals at t ----
            ri = R[s].iloc[w0:it + 1]
            m = ((tot - R[s].fillna(0)) / (cnt - R[s].notna().astype(int))).iloc[w0:it + 1]
            ok = ri.notna() & m.notna()
            ivol = vol = np.nan
            if ok.sum() >= 17:
                y = ri[ok].values; x = m[ok].values
                X = np.c_[np.ones_like(x), x]
                beta, *_ = np.linalg.lstsq(X, y, rcond=None)
                e = y - X @ beta
                ivol = np.sqrt((e ** 2).sum() / (len(e) - 2)) * np.sqrt(252)
                vol = np.std(y, ddof=1) * np.sqrt(252)
            vr = VR[s].iloc[w0:it + 1].dropna()
            vov = vr.std(ddof=1) if len(vr) >= 15 else np.nan
            vp = vr[vr > 0]
            vovp = vp.std(ddof=1) if (len(vr) >= 15 and len(vp) >= 5) else np.nan
            # ---- exclusions over (win_first_date, M] ----
            excl = None
            for s2, d, a in ev:
                if s2 != s:
                    continue
                if a.startswith("exclude_span") and win_first_date < d <= M:
                    excl = a
                if a == "day_dropped" and d == M:
                    excl = a
            base = dict(pool=pool, sym=s, M=M, E=E, t=t, ivol=ivol, vol=vol, vov=vov, vovp=vovp, excl=excl)
            for right in ("C", "P"):
                rec = dict(base, right=right)
                rec.update(trade(s, right, M, E, spot[s], mon[s], rate, stats))
                rows.append(rec)
    log.append(f"[{pool}] IV carries {stats['carry']} of {stats['marks']} daily marks")
    return pd.DataFrame(rows), flags


def trade(s, right, M, E, S, mon, rate, stats):
    out = dict(status=None)
    if E not in S.index or M not in S.index:
        out["status"] = "no_entry_or_settle"; return out
    q = mon[(mon["date"] == E) & (mon["expiration"] == M) & (mon["right"] == right)]
    mid = (q["bid"] + q["ask"]) / 2
    good = (q["bid"] > 0) & (q["ask"] > q["bid"]) & ((q["ask"] - q["bid"]) / mid <= 0.5) \
        & (q["implied_vol"] > 0) & (q["implied_vol"] <= 10) & (q["iv_error"].abs() < 0.01)
    q = q[good]
    SE = S.loc[E]
    if len(q) == 0:
        out["status"] = "no_quote"; return out
    q = q.assign(dist=(q["strike"] - SE).abs()).sort_values(["dist", "strike"])
    row = q.iloc[0]
    K = row["strike"]
    if abs(K / SE - 1) > 0.10:
        out["status"] = "no_atm"; return out
    cmid = (row["bid"] + row["ask"]) / 2; hs = (row["ask"] - row["bid"]) / 2
    path = S[(S.index >= E) & (S.index <= M)]
    ser = mon[(mon["expiration"] == M) & (mon["strike"] == K) & (mon["right"] == right)].set_index("date")
    iv_prev = row["implied_vol"]
    cash = cmid; growth = 1.0
    pos = 0.0; turnover = 0.0
    dates = list(path.index)
    for j, d in enumerate(dates):
        Sd = path.loc[d]
        if j > 0:
            dt = (d - dates[j - 1]).days / 365.0
            g = np.exp(rate.loc[dates[j - 1]] * dt)
            cash *= g; growth *= g
        if d == M:
            payoff = max(Sd - K, 0.0) if right == "C" else max(K - Sd, 0.0)
            cash += pos * Sd - HEDGE_FEE * abs(pos) * Sd - payoff
            turnover += abs(pos)
            break
        stats["marks"] += 1
        iv = iv_prev
        if d in ser.index:
            rr_ = ser.loc[d]
            if isinstance(rr_, pd.DataFrame):
                rr_ = rr_.iloc[0]
            if 0 < rr_["implied_vol"] <= 10 and abs(rr_["iv_error"]) < 0.01 and rr_["ask"] > rr_["bid"] >= 0:
                iv = rr_["implied_vol"]
            else:
                stats["carry"] += 1
        else:
            stats["carry"] += 1
        iv_prev = iv
        T = (M - d).days / 365.0
        dlt = bs_delta(Sd, K, T, rate.loc[d], iv, right)
        trade_sh = dlt - pos
        cash -= trade_sh * Sd + HEDGE_FEE * abs(trade_sh) * Sd
        turnover += abs(trade_sh)
        pos = dlt
        if j == 0:
            d0 = dlt
    pnl0 = cash                        # k = 0 (mid), per share of notional
    out.update(status="ok", K=K, S_E=SE, S_M=path.loc[M], mid=cmid, hs=hs, delta0=d0, iv0=row["implied_vol"],
               turnover=turnover, growth=growth,
               pnl_k0=pnl0 / SE * 100, pnl_k05=(pnl0 - 0.5 * hs * growth) / SE * 100,
               pnl_k1=(pnl0 - 1.0 * hs * growth) / SE * 100,
               invest=(d0 * SE - cmid) if right == "C" else (cmid - d0 * SE))
    out["pnl_k05_inv"] = (pnl0 - 0.5 * hs * growth) / out["invest"] * 100 if out["invest"] > 0 else np.nan
    return out


if __name__ == "__main__":
    defects = C.load_defects()
    log = []; allrows = []; allflags = []
    for pool in C.POOLS:
        df, fl = run_pool(pool, defects, log)
        allrows.append(df); allflags += fl
        print(log[-2]); print(log[-1], flush=True)
    T = pd.concat(allrows, ignore_index=True)
    # ---- final wall check: entry and exit both < 2023-10-31 ----
    assert (T["E"] < WALL).all() and (T["M"] < WALL).all()
    out = os.path.join(C.CACHE, "trades.pkl")
    T.to_pickle(out)
    F = pd.DataFrame(allflags, columns=["pool", "sym", "date", "prev_date", "jump", "min_kept", "n_common_exp", "near_known_defect"])
    F.to_csv(os.path.join(HERE, "P-0023_0024_selfcheck_flags.csv"), index=False)
    with open(os.path.join(HERE, "P-0023_0024_backtest.log"), "w") as f:
        f.write("\n".join(log) + "\n")
    print(T.groupby(["right", "status"]).size())
    print(F.to_string())
