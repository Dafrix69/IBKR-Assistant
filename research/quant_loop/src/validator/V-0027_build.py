"""V-0027 (validator for P-0027): signals (IVOL, VOV), monthly cycles, per-trade simulation.

Usage:
    python V-0027_build.py train          # training pools, entry AND exit < 2023-10-31
    python V-0027_build.py test --test    # 2023 and 2024 pools, entry >= 2023-10-31 (ONE run)

Two structures per (pool, M, stock):
  (a) P-0027 spec: short call + put at ONE strike K (both legs pass quality, nearest S_E, tie -> lower K,
      |K/S_E-1| <= 0.10), NET delta (BS, each leg its own ThetaData IV) hedged daily at the close,
      5 bp on hedge notional, held to M, settled at |S_M - K|.
  (b) training-diagnostic structure (P-0023 sec. 8): each leg its own nearest qualifying strike,
      each leg hedged separately, each its own 5 bp; requires both legs.
P&L in % of S_E. k cost = k * (sum of half-spreads) carried to M.
Writes src/validator/V-0027_cache/trades_<phase>.pkl and selfcheck_<phase>.csv.
"""
import os, sys, importlib.util
import numpy as np
import pandas as pd
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("vc", os.path.join(HERE, "V-0027_cache.py"))
VC = importlib.util.module_from_spec(spec); spec.loader.exec_module(VC)
WALL = VC.WALL
CACHE = VC.CACHE
DEFECTS = os.path.join(VC.QL, "data/pools_defects.csv")
FEE = 0.0005
WIN = 21
NEXT = {"20181031": "20191031", "20191031": "20201030", "20201030": "20211029", "20211029": "20221031",
        "20221031": "20231031", "20231031": "20241031", "20241031": "20991231"}


def bs_delta(S, K, T, r, s, right):
    if T <= 0 or not (s > 0):
        if right == "C":
            return 1.0 if S > K else 0.0
        return -1.0 if S < K else 0.0
    d1 = (np.log(S / K) + (r + 0.5 * s * s) * T) / (s * np.sqrt(T))
    return norm.cdf(d1) if right == "C" else norm.cdf(d1) - 1.0


def iv21(atm):
    """Constant 21-day ATM IV by total-variance interpolation (P-0024 sec. 2)."""
    out = {}
    for d, g in atm.groupby("date"):
        lo = g[(g["dte"] >= 5) & (g["dte"] <= 21)]
        hi = g[(g["dte"] >= 21) & (g["dte"] <= 30)]
        if len(lo) == 0 or len(hi) == 0:
            continue
        a = lo.loc[lo["dte"].idxmax()]; b = hi.loc[hi["dte"].idxmin()]
        if a["dte"] == 21:
            out[d] = a["iv"]; continue
        if b["dte"] == 21:
            out[d] = b["iv"]; continue
        T1, T2 = a["dte"], b["dte"]
        w = (21 - T1) / (T2 - T1)
        v = ((1 - w) * a["iv"] ** 2 * T1 + w * b["iv"] ** 2 * T2) / 21
        out[d] = np.sqrt(v) if v > 0 else np.nan
    return pd.Series(out, dtype=float)


def monthly(exps):
    s = pd.Series(sorted(set(pd.to_datetime(list(exps)))))
    out = []
    for _, g in s.groupby([s.dt.year, s.dt.month]):
        fri = g[(g.dt.day_of_week == 4) & g.dt.day.between(15, 21)]
        thu = g[(g.dt.day_of_week == 3) & g.dt.day.between(14, 20)]
        if len(fri):
            out.append(fri.iloc[0])
        elif len(thu):
            out.append(thu.iloc[0])
    return out


def ivok(iv, err):
    return (iv > 0) and (iv <= 10) and (abs(err) < 0.01)


def simulate(S, dates, M, legs, rate, look, stats):
    """legs = [(right, K, iv0)]; one hedge account on the summed BS delta.
    Returns k0 cash at M (per share), growth factor, turnover (shares), short share-years * S ($*yr)."""
    cash = 0.0; growth = 1.0; pos = 0.0; turn = 0.0; sd = 0.0
    ivp = [l[2] for l in legs]
    d0 = None
    for j, d in enumerate(dates):
        Sd = S[d]
        if j > 0:
            g = np.exp(rate[dates[j - 1]] * (d - dates[j - 1]).days / 365.0)
            cash *= g; growth *= g
            if pos < 0:
                sd += (-pos) * S[dates[j - 1]] * (d - dates[j - 1]).days / 365.0
        if d == M:
            pay = sum(max(Sd - K, 0.0) if r == "C" else max(K - Sd, 0.0) for r, K, _ in legs)
            cash += pos * Sd - FEE * abs(pos) * Sd - pay
            turn += abs(pos)
            break
        T = (M - d).days / 365.0
        dl = 0.0
        for i, (r, K, _) in enumerate(legs):
            stats["marks"] += 1
            v = look.get((d, K, r))
            if v is not None and ivok(v[0], v[1]):
                ivp[i] = v[0]
            else:
                stats["carry"] += 1
            dl += bs_delta(Sd, K, T, rate[d], ivp[i], r)
        tr = dl - pos
        cash -= tr * Sd + FEE * abs(tr) * Sd
        turn += abs(tr); pos = dl
        if j == 0:
            d0 = dl
    return cash, growth, turn, sd, d0


def run_pool(pool, phase, defects, scan_only=False):
    C = pd.read_pickle(os.path.join(CACHE, f"{pool}.pkl"))
    res = C["res"]; syms = sorted(res)
    sel = pd.Timestamp(pool); nxt = pd.Timestamp(NEXT[pool])
    spot = {s: res[s]["spot"] for s in syms}
    if phase == "train":                                   # wall, first step after loading
        spot = {s: v[v.index < WALL] for s, v in spot.items()}
    cal = pd.DatetimeIndex(sorted(set().union(*[set(v.index) for v in spot.values()])))
    if phase == "train":
        assert cal.max() < WALL
    rate = pd.concat([res[s]["rate"] for s in syms]).groupby(level=0).median().reindex(cal).ffill().bfill()
    # ---------------- self-checks ----------------
    dp = defects[defects["pool"] == pool]
    known = list(zip(dp["sym"], dp["day"], dp["action"]))
    flags = []
    for s in syms:
        sp = spot[s].dropna()
        jump = sp / sp.shift(1) - 1
        ck = res[s]["chk"].set_index("date")
        ck = ck[ck.index.isin(cal)]
        days = set(jump[jump.abs() > 0.35].index) | set(ck[ck["min_kept"] < 0.6].index)
        for d in sorted(days):
            row = ck.loc[d] if d in ck.index else None
            near = any(sy == s and abs((dd - d).days) <= 5 for sy, dd, _ in known)
            flags.append(dict(pool=pool, sym=s, date=d, jump=jump.get(d, np.nan),
                              min_kept=None if row is None else row["min_kept"],
                              n_common=None if row is None else row["n_common"],
                              shift_c=None if row is None else row["shift_c"],
                              shift_frac=None if row is None else row["shift_frac"], near_known=near))
        z = spot[s][(spot[s].isna()) | (spot[s] <= 0)]
        for d in z.index:
            flags.append(dict(pool=pool, sym=s, date=d, jump=np.nan, min_kept=None, n_common=None,
                              shift_c=None, shift_frac=None, near_known=any(sy == s and dd == d for sy, dd, _ in known),
                              zero_close=True))
        nu = res[s]["nuniq"]
        for d in nu[nu > 1].index:
            if d in cal:
                flags.append(dict(pool=pool, sym=s, date=d, jump=np.nan, min_kept=None, n_common=None, shift_c=None,
                                  shift_frac=None, near_known=False, multi_close=int(nu[d])))
    ev = [(s, d, a) for s, d, a in known]
    for f in flags:
        if f.get("min_kept") is not None and pd.notna(f["min_kept"]) and f["min_kept"] < 0.6 and not f["near_known"]:
            ev.append((f["sym"], f["date"], "exclude_span_self"))
    # ---------------- returns, leave-one-out basket, VOV ----------------
    P = pd.DataFrame({s: spot[s] for s in syms}).reindex(cal)
    R = P / P.shift(1) - 1
    IV = pd.DataFrame({s: iv21(res[s]["atm"]) for s in syms}).reindex(cal)
    VR = IV / IV.shift(1) - 1
    for s, d, a in ev:
        if a.startswith("exclude_span") and d in R.index:
            R.loc[d, s] = np.nan; VR.loc[d, s] = np.nan
    tot = R.sum(axis=1, min_count=1); cnt = R.notna().sum(axis=1)
    # ---------------- cycles ----------------
    exps = set()
    for s in syms:
        exps |= set(res[s]["mon"]["expiration"].unique())
    cyc = []
    for M in monthly(exps):
        if phase == "train" and M >= WALL:
            continue
        if M > cal.max():
            continue
        c = cal[(cal >= M - pd.Timedelta(days=30)) & (cal < M)]
        if len(c) == 0:
            continue
        E = c[0]
        if not (sel <= E < nxt):
            continue
        if phase == "train" and E >= WALL:
            continue
        if phase == "test" and E < WALL:
            continue
        i = cal.get_loc(E)
        if i - 1 < WIN:
            continue
        cyc.append((M, E, cal[i - 1], i - 1))
    if scan_only:   # self-checks and cycle list only, no P&L
        log = (f"[{pool}] cycles {len(cyc)}: " + ", ".join(f"{E.date()}->{M.date()}" for M, E, _, _ in cyc) +
               "\n[{pool}] events: ".replace('{pool}', pool) + "; ".join(f"{s} {d.date()} {a}" for s, d, a in ev))
        return None, pd.DataFrame(flags), log
    # ---------------- per stock lookups ----------------
    mons = {}
    for s in syms:
        m = res[s]["mon"]
        if phase == "train":
            m = m[(m["date"] < WALL) & (m["expiration"] < WALL)]
        mons[s] = {e: g for e, g in m.groupby("expiration")}
    rows = []
    stats = dict(carry=0, marks=0)
    for M, E, t, it in cyc:
        w0 = it - WIN + 1
        first_used = cal[w0 - 1]
        for s in syms:
            ri = R[s].iloc[w0:it + 1]
            mk = ((tot - R[s].fillna(0)) / (cnt - R[s].notna().astype(int))).iloc[w0:it + 1]
            ok = ri.notna() & mk.notna() & np.isfinite(mk)
            ivol = np.nan
            if ok.sum() >= 17:
                y = ri[ok].values; x = mk[ok].values
                X = np.c_[np.ones_like(x), x]
                b, *_ = np.linalg.lstsq(X, y, rcond=None)
                e = y - X @ b
                ivol = np.sqrt((e ** 2).sum() / (len(e) - 2)) * np.sqrt(252)
            vr = VR[s].iloc[w0:it + 1].dropna()
            vov = vr.std(ddof=1) if len(vr) >= 15 else np.nan
            excl = None
            for s2, d, a in ev:
                if s2 != s:
                    continue
                if a.startswith("exclude_span") and first_used < d <= M:
                    excl = a
                if a == "day_dropped" and d == M:
                    excl = a
            rec = dict(pool=pool, sym=s, M=M, E=E, t=t, ivol=ivol, vov=vov, excl=excl)
            rec.update(trade(s, M, E, spot[s].dropna(), mons[s].get(M), rate, stats))
            rows.append(rec)
    log = (f"[{pool}] cycles {len(cyc)}: " + ", ".join(f"{E.date()}->{M.date()}" for M, E, _, _ in cyc) +
           f"\n[{pool}] IV carries {stats['carry']} of {stats['marks']} leg-day marks; events used: " +
           "; ".join(f"{s} {d.date()} {a}" for s, d, a in ev))
    return pd.DataFrame(rows), pd.DataFrame(flags), log


def pick(q, S_E):
    q = q.assign(dist=(q["strike"] - S_E).abs()).sort_values(["dist", "strike"])
    return q.iloc[0]


def trade(s, M, E, S, mon, rate, stats):
    out = dict(status=None, d_status=None)
    if E not in S.index or M not in S.index:
        out["status"] = out["d_status"] = "no_entry_or_settle"; return out
    if mon is None:
        out["status"] = out["d_status"] = "no_quote"; return out
    S_E = S[E]
    path = [d for d in S.index if E <= d <= M]
    Sd = {d: S[d] for d in path}
    look = {(r.date, r.strike, r.right): (r.implied_vol, r.iv_error) for r in mon.itertuples() if E <= r.date <= M}
    q = mon[mon["date"] == E]
    q = q[VC.quality(q)]
    # ---- (a) spec straddle at one strike
    c = q[q["right"] == "C"].set_index("strike"); p = q[q["right"] == "P"].set_index("strike")
    both = c.index.intersection(p.index)
    if len(both) == 0:
        out["status"] = "no_quote"
    else:
        ks = pd.Series(both, index=both)
        ks = pd.DataFrame({"strike": both, "dist": np.abs(both - S_E)}).sort_values(["dist", "strike"])
        K = ks["strike"].iloc[0]
        if abs(K / S_E - 1) > 0.10:
            out["status"] = "no_atm"
        else:
            rc = c.loc[K]; rp = p.loc[K]
            if isinstance(rc, pd.DataFrame): rc = rc.iloc[0]
            if isinstance(rp, pd.DataFrame): rp = rp.iloc[0]
            mid = (rc.bid + rc.ask) / 2 + (rp.bid + rp.ask) / 2
            hs = (rc.ask - rc.bid) / 2 + (rp.ask - rp.bid) / 2
            cash, gr, turn, sd, d0 = simulate(Sd, path, M, [("C", K, rc.implied_vol), ("P", K, rp.implied_vol)], rate, look, stats)
            k0 = cash + mid * gr          # premium received at E earns the cash rate to M
            out.update(status="ok", K=K, S_E=S_E, S_M=S[M], mid=mid, hs=hs, hs_c=(rc.ask - rc.bid) / 2,
                       hs_p=(rp.ask - rp.bid) / 2, iv_c=rc.implied_vol, iv_p=rp.implied_vol,
                       gap=rp.implied_vol - rc.implied_vol, vol_c=rc.volume, vol_p=rp.volume, growth=gr,
                       turnover=turn, short_sd=sd, delta0=d0, ndays=len(path),
                       pnl_k0=k0 / S_E * 100, pnl_k05=(k0 - 0.5 * hs * gr) / S_E * 100,
                       pnl_k1=(k0 - hs * gr) / S_E * 100, sdpct=sd / S_E * 100)
    # ---- (b) diagnostic structure: each leg nearest own strike, own hedge
    legs = {}
    for r in ("C", "P"):
        qq = q[q["right"] == r]
        if len(qq) == 0:
            legs[r] = "no_quote"; continue
        row = pick(qq, S_E)
        if abs(row["strike"] / S_E - 1) > 0.10:
            legs[r] = "no_atm"; continue
        legs[r] = row
    if all(not isinstance(v, str) for v in legs.values()):
        tot0 = 0.0; hs2 = 0.0; gr2 = 1.0
        for r, row in legs.items():
            m = (row["bid"] + row["ask"]) / 2; h = (row["ask"] - row["bid"]) / 2
            cash, gr2, _, _, _ = simulate(Sd, path, M, [(r, row["strike"], row["implied_vol"])], rate, look, dict(carry=0, marks=0))
            tot0 += cash + m * gr2; hs2 += h
        out.update(d_status="ok", d_Kc=legs["C"]["strike"], d_Kp=legs["P"]["strike"],
                   d_gap=legs["P"]["implied_vol"] - legs["C"]["implied_vol"],
                   d_pnl_k0=tot0 / S_E * 100, d_pnl_k05=(tot0 - 0.5 * hs2 * gr2) / S_E * 100,
                   d_pnl_k1=(tot0 - hs2 * gr2) / S_E * 100)
    else:
        out["d_status"] = next(v for v in legs.values() if isinstance(v, str))
    return out


if __name__ == "__main__":
    phase = sys.argv[1]
    if "--scan" in sys.argv:          # defect scan + cycle list, no P&L (run before the one-shot test build)
        defects = pd.read_csv(DEFECTS, dtype={"pool": str}); defects["day"] = pd.to_datetime(defects["day"])
        pools = VC.TEST_POOLS if phase == "test" else VC.TRAIN_POOLS
        F = []
        for pl in pools:
            _, fl, log = run_pool(pl, phase, defects, scan_only=True); F.append(fl); print(log, flush=True)
        pd.concat(F, ignore_index=True).to_csv(os.path.join(CACHE, f"selfcheck_{phase}.csv"), index=False)
        sys.exit(0)
    if phase == "test":
        assert "--test" in sys.argv
        pools = VC.TEST_POOLS
        assert not os.path.exists(os.path.join(CACHE, "trades_test.pkl")), "test already run once; refuse to rerun"
    else:
        pools = VC.TRAIN_POOLS
    defects = pd.read_csv(DEFECTS, dtype={"pool": str}); defects["day"] = pd.to_datetime(defects["day"])
    T = []; F = []; L = []
    for pl in pools:
        df, fl, log = run_pool(pl, phase, defects)
        T.append(df); F.append(fl); L.append(log); print(log, flush=True)
    T = pd.concat(T, ignore_index=True)
    if phase == "train":
        assert (T["E"] < WALL).all() and (T["M"] < WALL).all()
    else:
        assert (T["E"] >= WALL).all()
    T.to_pickle(os.path.join(CACHE, f"trades_{phase}.pkl"))
    pd.concat(F, ignore_index=True).to_csv(os.path.join(CACHE, f"selfcheck_{phase}.csv"), index=False)
    with open(os.path.join(CACHE, f"build_{phase}.log"), "w") as f:
        f.write("\n".join(L) + "\n")
    print(T.groupby("status").size()); print(T.groupby("d_status").size())
