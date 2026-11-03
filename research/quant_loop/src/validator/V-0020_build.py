"""V-0020 independent rebuild of P-0020 (A-tape TRAIN ONLY; test period never read).
Two-leg 0DTE vertical combo prints: same ms, after per-(strike,right) aggregation exactly 2 rows,
same right, different strikes, same qty, multi-leg condition codes.
Per print stores: V_trade, V_own (own NBBO, first row of each leg), V_own_last (last row variant),
V_ref (chain m/m+1 interpolated), V_pre (that contract's NBBO on its last tape row strictly before the
combo ms, <= 60 s, any condition), H_own, H_ch, placebo leg means (15-min window, single-leg rows).
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0020_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0020_tables"
LO, HI = pd.Timestamp("2024-10-30"), pd.Timestamp("2025-11-01")   # A-tape train window
ML = {130, 131, 134, 137, 144}
USE = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"]


def run_day(tag):
    f = f"{R}/data/raw/SPXW/trade_quote_dte0/{tag[:4]}/{tag}.csv.gz"
    t = pd.read_csv(f, usecols=USE)
    t["trade_timestamp"] = pd.to_datetime(t["trade_timestamp"])
    t = t[(t.trade_timestamp >= LO) & (t.trade_timestamp < HI)]       # time wall, first step
    if len(t) == 0:
        return None
    day = pd.Timestamp(tag)
    t = t.reset_index(drop=True)
    t["cp"] = np.where(t.right.str.upper().str.startswith("C"), "C", "P")
    t["ml"] = t.condition.isin(ML)
    t["qok"] = (t.bid > 0) & (t.ask > t.bid)
    t["mid"] = (t.bid + t.ask) / 2

    # previous-row NBBO per contract (strictly earlier timestamp), for V_pre
    t = t.sort_values(["strike", "cp", "trade_timestamp"], kind="mergesort").reset_index(drop=True)
    key = t.strike.astype(str) + t.cp
    # last row of each (contract, ms) group, then shift by group
    g = t.groupby([t.strike, t.cp, t.trade_timestamp], sort=False)
    last = g.agg(mid=("mid", "last"), qok=("qok", "last")).reset_index()
    last = last.sort_values(["strike", "cp", "trade_timestamp"]).reset_index(drop=True)
    same = (last.strike.eq(last.strike.shift())) & (last.cp.eq(last.cp.shift()))
    last["pre_mid"] = np.where(same & last.qok.shift(fill_value=False), last.mid.shift(), np.nan)
    last["pre_ts"] = np.where(same, last.trade_timestamp.shift(), pd.NaT)
    pre = {(a, b, c): (m, p) for a, b, c, m, p in zip(last.strike, last.cp, last.trade_timestamp, last.pre_mid, last.pre_ts)}

    # placebo: single-leg ell = price - own mid, mean per (15-min window, strike, right)
    s = t[~t.ml & t.qok & (t.price > 0)]
    plc = (s.price - s.mid).groupby([s.trade_timestamp.dt.floor("15min"), s.strike, s.cp]).mean().to_dict()

    # combos
    m = t[t.ml].copy()
    m["pq"] = m.price * m["size"]
    a = (m.sort_values(["trade_timestamp", "strike", "cp"], kind="mergesort")
         .groupby(["trade_timestamp", "strike", "cp"], sort=True)
         .agg(q=("size", "sum"), pq=("pq", "sum"), b0=("bid", "first"), a0=("ask", "first"),
              b1=("bid", "last"), a1=("ask", "last")).reset_index())
    a["px"] = a.pq / a.q
    n = a.groupby("trade_timestamp").strike.transform("size")
    a = a[n == 2]
    a = a.sort_values(["trade_timestamp", "strike"]).reset_index(drop=True)
    lo_ = a.iloc[0::2].reset_index(drop=True)
    hi_ = a.iloc[1::2].reset_index(drop=True)
    assert (lo_.trade_timestamp.values == hi_.trade_timestamp.values).all()
    ok = (lo_.cp.values == hi_.cp.values) & (lo_.strike.values != hi_.strike.values) & (lo_.q.values == hi_.q.values)
    lo_, hi_ = lo_[ok].reset_index(drop=True), hi_[ok].reset_index(drop=True)
    isc = (lo_.cp == "C").values
    # richer leg: call -> lower strike, put -> higher strike
    S_ = pd.DataFrame(np.where(isc[:, None], lo_.values, hi_.values), columns=lo_.columns)
    L_ = pd.DataFrame(np.where(isc[:, None], hi_.values, lo_.values), columns=lo_.columns)
    for c in ["strike", "q", "px", "b0", "a0", "b1", "a1"]:
        S_[c] = S_[c].astype(float); L_[c] = L_[c].astype(float)
    v = pd.DataFrame({"ts": pd.to_datetime(S_.trade_timestamp), "cp": S_.cp, "Ks": S_.strike, "Kl": L_.strike,
                      "q": S_.q})
    v["w"] = (v.Ks - v.Kl).abs()
    good = (S_.b0 > 0) & (L_.b0 > 0) & (S_.a0 > S_.b0) & (L_.a0 > L_.b0)
    v["v_trade"] = S_.px - L_.px
    v["v_own"] = (S_.b0 + S_.a0) / 2 - (L_.b0 + L_.a0) / 2
    v["v_own_last"] = (S_.b1 + S_.a1) / 2 - (L_.b1 + L_.a1) / 2
    v["v_bid"] = S_.b0 - L_.a0
    v["v_ask"] = S_.a0 - L_.b0
    v["h_own"] = (S_.a0 - S_.b0) / 2 + (L_.a0 - L_.b0) / 2
    v = v[good.values].reset_index(drop=True)
    mins = v.ts.dt.hour * 60 + v.ts.dt.minute
    v = v[(mins >= 600) & (mins < 930) & v.w.isin([10, 15, 20, 25])].reset_index(drop=True)

    sp = pd.read_parquet(f"{R}/data/clean/spot.parquet", columns=["ts", "spot"])
    sp = sp[(sp.ts >= LO) & (sp.ts < HI)]                              # time wall
    sp = sp[(sp.ts >= day) & (sp.ts < day + pd.Timedelta(days=1))].set_index("ts").spot
    v["fm"] = v.ts.dt.floor("min")
    v["S"] = v.fm.map(sp)
    v = v[(v.Ks - v.S).abs() <= 30].reset_index(drop=True)

    ch = pd.read_parquet(f"{R}/data/clean/chain_{tag}.parquet", columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    ch = ch[(ch.ts >= LO) & (ch.ts < HI)]                              # time wall
    ch = ch[~ch.flag_bad & (ch.bid > 0) & (ch.ask >= ch.bid)]
    ch["cp"] = ch.right.str.upper().str[0]
    ch["cm"] = (ch.bid + ch.ask) / 2
    ch["ch"] = (ch.ask - ch.bid) / 2
    cmap = ch.set_index(["ts", "strike", "cp"])[["cm", "ch"]]
    cmap = cmap[~cmap.index.duplicated()]

    def look(tcol, kcol):
        idx = pd.MultiIndex.from_arrays([tcol, v[kcol].astype(float), v.cp])
        r = cmap.reindex(idx)
        return r.cm.values, r.ch.values
    one = pd.Timedelta(minutes=1)
    ms0, hs0 = look(v.fm, "Ks"); ml0, hl0 = look(v.fm, "Kl")
    ms1, hs1 = look(v.fm + one, "Ks"); ml1, hl1 = look(v.fm + one, "Kl")
    u = ((v.ts - v.fm).dt.total_seconds() / 60).values
    v["v_ref"] = (1 - u) * (ms0 - ml0) + u * (ms1 - ml1)
    v["v_m"] = ms0 - ml0
    v["h_ch"] = (1 - u) * (hs0 + hl0) + u * (hs1 + hl1)
    v = v[np.isfinite(v.v_ref) & np.isfinite(v.h_ch)].reset_index(drop=True)

    # pre-trade NBBO reference
    ps = [pre.get((k, c, t_)) for k, c, t_ in zip(v.Ks, v.cp, v.ts)]
    pl = [pre.get((k, c, t_)) for k, c, t_ in zip(v.Kl, v.cp, v.ts)]
    def pv(x, t_):
        if x is None or not np.isfinite(x[0]) or pd.isna(x[1]):
            return np.nan
        return x[0] if (t_ - pd.Timestamp(x[1])).total_seconds() <= 60 else np.nan
    v["pre_s"] = [pv(x, t_) for x, t_ in zip(ps, v.ts)]
    v["pre_l"] = [pv(x, t_) for x, t_ in zip(pl, v.ts)]
    v["v_pre"] = v.pre_s - v.pre_l

    w15 = v.ts.dt.floor("15min")
    es = np.array([plc.get((a_, b_, c_), np.nan) for a_, b_, c_ in zip(w15, v.Ks, v.cp)])
    el = np.array([plc.get((a_, b_, c_), np.nan) for a_, b_, c_ in zip(w15, v.Kl, v.cp)])
    v["p_own"] = -(es - el)
    v["itm"] = np.where(v.cp == "C", v.Ks < v.S, v.Ks > v.S)
    v["date"] = day
    return v.drop(columns=["fm"])


def main():
    cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
    cal = cal[(cal.index >= LO) & (cal.index < HI)]                    # time wall
    cal = cal[cal.has_0dte & ~cal.half_day]
    tags = [d.strftime("%Y%m%d") for d in cal.index
            if os.path.exists(f"{R}/data/raw/SPXW/trade_quote_dte0/{d.year}/{d.strftime('%Y%m%d')}.csv.gz")]
    with ProcessPoolExecutor(6) as ex:
        parts = [p for p in ex.map(run_day, tags) if p is not None]
    out = pd.concat(parts, ignore_index=True)
    out.to_parquet(f"{OUT}/prints_train.parquet")
    print(len(tags), "days", len(out), "prints")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        r = run_day(sys.argv[1]); print(len(r)); print(r.describe().T.to_string())
    else:
        main()
