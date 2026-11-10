"""Stage 1 diagnostic: delta-hedged returns of short single options on the 15 small caps, TRAINING PERIOD ONLY.
Run: ../spx_fly/.venv/bin/python src/diag.py  → out/diag_trades.csv
"""
import os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bs
from build_cache import HERE, SMALL, CACHE

PERIOD_END = pd.Timestamp(os.environ.get("CSE_PERIOD_END", "2025-11-01"))   # time wall: everything below uses date < PERIOD_END only
OUT = os.environ.get("CSE_OUT", "diag_trades.csv")
CALL_T = [0.50, 0.35, 0.25, 0.15, 0.10]
PUT_T = [-0.50, -0.25, -0.10]
HEDGE_BPS = 5e-4
KS = (0.0, 0.5)
WOLF_OLD_LAST, WOLF_NEW = pd.Timestamp("2025-09-26"), pd.Timestamp("2025-10-13")   # data defect, see SPEC changes
# Extra defects (universe run): CSV sym,jump_day — any trade whose window contains jump_day is dropped.
DEFECTS = {}
if os.environ.get("CSE_DEFECTS") and os.path.exists(os.environ["CSE_DEFECTS"]):
    _d = pd.read_csv(os.environ["CSE_DEFECTS"], parse_dates=["jump_day"])
    for _s, _g in _d.groupby("sym"):
        DEFECTS[_s] = list(_g.jump_day)


def load(sym):
    o = pd.read_parquet(os.path.join(HERE, CACHE, f"{sym}.parquet"))
    o = o[(o.date < PERIOD_END) & (o.exp < PERIOD_END)]          # first step: training period only (incl. settlement)
    s = pd.read_parquet(os.path.join(HERE, CACHE, f"{sym}_spot.parquet")).S
    s = s[s.index < PERIOD_END]
    return o, s


def atm_iv(ch, S, T):
    """Mean of call and put IV at the strike nearest S (mid)."""
    k = ch.strike.values[np.argmin(np.abs(ch.strike.values - S))]
    r = ch[ch.strike == k]
    v = bs.iv(S, r.strike.values, T, r.mid.values, (r.right == "C").values)
    return np.nanmean(v) if np.isfinite(v).any() else np.nan


def run(sym):
    o, spot = load(sym)
    o = o[(o.ask >= o.bid) & (o.ask > 0)].copy()
    o["mid"] = (o.bid + o.ask) / 2
    idx = o.set_index(["exp", "strike", "right", "date"]).sort_index()
    days = spot.index
    lr = np.log(spot).diff()
    iso = days.isocalendar()
    firsts = pd.Series(days, index=days).groupby([iso.year.values, iso.week.values]).first().sort_values()
    rows = []
    for d0 in firsts:
        S0 = spot[d0]
        day = o[o.date == d0]
        if day.empty:
            continue
        exps = sorted(day.exp.unique())
        picks = {}
        same = [e for e in exps if 2 <= (e - d0).days <= 6 and e.isocalendar()[:2] == d0.isocalendar()[:2]]
        if same:
            picks["wk"] = max(same)
        mid3 = [e for e in exps if 14 <= (e - d0).days <= 28]
        if mid3:
            picks["3w"] = min(mid3, key=lambda e: (abs((e - d0).days - 21), e))
        i0 = days.get_loc(d0)
        rv20 = lr.iloc[max(0, i0 - 19): i0 + 1].std() * np.sqrt(252) if i0 >= 20 else np.nan
        ret5 = S0 / spot.iloc[i0 - 5] - 1 if i0 >= 5 else np.nan
        for bucket, exp in picks.items():
            T0 = (exp - d0).days / 365.0
            ch = day[day.exp == exp].copy()
            ch["iv"] = bs.iv(S0, ch.strike.values, T0, ch.mid.values, (ch.right == "C").values)
            ch = ch[np.isfinite(ch.iv) & (ch.bid > 0)]
            if ch.empty:
                continue
            ch["dl"] = bs.delta(S0, ch.strike.values, T0, ch.iv.values, (ch.right == "C").values)
            a_iv = atm_iv(day[day.exp == exp], S0, T0)
            later = [e for e in exps if e > exp]
            nxt_iv = atm_iv(day[day.exp == later[0]], S0, (later[0] - d0).days / 365.0) if later else np.nan
            calls = ch[ch.right == "C"]
            c25 = calls.iloc[(calls.dl - 0.25).abs().argmin()] if len(calls) else None
            skew = (c25.iv - a_iv) if c25 is not None and abs(c25.dl - 0.25) <= 0.05 else np.nan
            if sym == "WOLF" and d0 < WOLF_NEW and exp > WOLF_OLD_LAST:
                continue                                           # Chapter 11: old equity cancelled after 2025-09-26, new shares from 2025-10-10
            if any(d0 <= jump_day and exp >= jump_day for jump_day in DEFECTS.get(sym, [])):
                continue                                           # split / reverse split / ticker defect inside the holding window
            hold = days[(days > d0) & (days <= exp)]
            if len(hold) == 0 or hold[-1] != exp:
                continue                                           # cannot settle inside the training period
            path = spot.loc[hold]
            rv_fwd = np.log(pd.concat([pd.Series([S0]), path.reset_index(drop=True)])).diff().std() * np.sqrt(252) if len(hold) > 1 else np.nan
            for right, targets in (("C", CALL_T), ("P", PUT_T)):
                side = ch[ch.right == right]
                for tgt in targets:
                    if side.empty:
                        continue
                    r = side.iloc[(side.dl - tgt).abs().argmin()]
                    if abs(r.dl - tgt) > 0.05:
                        continue
                    K, iscall = float(r.strike), right == "C"
                    hs = (r.ask - r.bid) / 2
                    # daily IV for the held contract (carry forward when the quote is missing/unpriceable)
                    try:
                        q = idx.loc[(exp, K, right)]
                    except KeyError:
                        q = pd.DataFrame(columns=["mid"])
                    ivs, sig = [], r.iv
                    for d in hold[:-1]:
                        if d in q.index:
                            v = bs.iv(spot[d], K, (exp - d).days / 365.0, q.loc[d, "mid"], iscall)
                            if np.isfinite(v):
                                sig = float(v)
                        ivs.append(sig)
                    Sp = np.r_[S0, path.values]                       # S_0 .. S_exp
                    Ts = np.array([(exp - d).days / 365.0 for d in [d0] + list(hold[:-1])])
                    h = np.asarray(bs.delta(Sp[:-1], K, Ts, np.r_[r.iv, ivs], iscall), float)  # shares held over each step
                    dS = np.diff(Sp)
                    payoff = max(Sp[-1] - K, 0) if iscall else max(K - Sp[-1], 0)
                    dts = -np.diff(np.r_[Ts, 0.0])                   # year fraction of each step
                    carry = bs.R * Sp[:-1] * dts                       # financing of one share over each step
                    hedge_dyn = float(np.sum(h * (dS - carry)))
                    cost_dyn = HEDGE_BPS * (abs(h[0]) * Sp[0] + np.sum(np.abs(np.diff(h)) * Sp[1:-1]) + abs(h[-1]) * Sp[-1])
                    hedge_sta = float(h[0] * (Sp[-1] - Sp[0] - np.sum(carry)))
                    cost_sta = HEDGE_BPS * abs(h[0]) * (Sp[0] + Sp[-1])
                    for k in KS:
                        prem = r.mid - k * hs
                        base = prem * (1 + bs.R * T0) - payoff                # premium earns R until expiry
                        for mode, hp, hc in (("none", 0.0, 0.0), ("static", hedge_sta, cost_sta), ("daily", hedge_dyn, cost_dyn)):
                            pnl = base + hp - hc
                            rows.append(dict(sym=sym, entry=d0.date(), bucket=bucket, exp=exp.date(), dte=(exp - d0).days, right=right,
                                             tgt=tgt, K=K, S0=S0, S_T=Sp[-1], dl=round(float(r.dl), 3), iv=r.iv, atm_iv=a_iv, next_atm_iv=nxt_iv,
                                             rv20=rv20, rv_fwd=rv_fwd, skew25=skew, ret5=ret5, mid=r.mid, hs=hs, k=k, hedge=mode,
                                             pnl=pnl, pnl_pct=pnl / S0 * 100, pnl_prem=pnl / r.mid,
                                             payoff=payoff, T0=T0, H=hp, C=hc))
    return rows


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    with Pool(8) as p:
        res = p.map(run, SMALL)
    t = pd.DataFrame([r for rows in res for r in rows])
    assert pd.to_datetime(t.exp).max() < PERIOD_END and pd.to_datetime(t.entry).max() < PERIOD_END
    t.to_csv(os.path.join(HERE, "out", OUT), index=False)
    print(len(t), t.entry.min(), t.exp.max())
