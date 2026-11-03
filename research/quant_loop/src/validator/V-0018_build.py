"""V-0018 build (independent rewrite, TRAIN ONLY: 2024-10-30 <= date < 2025-11-01).

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0018_build.py
Outputs (V-0018_tables/):
  combos.parquet   one row per near-ATM combo print: trade, own, ch0, ch1 (Pi, points), u, D_single (points)
  cells.parquet    per day x cell diagnostics on leg-level quotes (USD / contract), see stats script

Pi: iron g=(+1,-1,-1,+1) on (K-w P, K P, K C, K+w C); fly g=(+1,-2,+1) same right.
Diagnostics on every tape row with bid>0, ask>bid, 09:45-15:30, |K-S|<=85 (S = spot at floor(t)):
  typ   = 'S' single-leg (condition not in ML) / 'M' combo leg (condition in ML)
  oc    = own attached NBBO mid - chain interp mid
  ch    = 1: oc ; 2: own mid - nearest other-ms row of same contract before / after (<=1 s) ;
          3: own mid - chain row m (no interp) for rows with t in [m, m+0.5 s) ;
          4: contract-minutes with both S and M rows: mean oc(S) - mean oc(M)
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0018_tables")
WALL = pd.Timestamp("2025-11-01")
START = pd.Timestamp("2024-10-30")
ML = (130, 131, 134, 137, 144)
COLS = ["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]
BINS = [-0.1, 5, 15, 30, 50, 85]
LAB = ["0-5", "6-15", "16-30", "31-50", "51-85"]
MIN = np.timedelta64(1, "m")


def one_day(D):
    assert D < WALL
    f = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{D.year}/{D:%Y%m%d}.csv.gz")
    t = pd.read_csv(f, usecols=COLS)
    t["trade_timestamp"] = pd.to_datetime(t.trade_timestamp)
    t = t[t.trade_timestamp < WALL]                                   # time wall, first step
    if t.empty:
        return None
    t["quote_timestamp"] = pd.to_datetime(t.quote_timestamp)
    hm = t.trade_timestamp.dt.hour * 60 + t.trade_timestamp.dt.minute
    t = t[(hm >= 585) & (hm < 930)].copy()                            # 09:45 <= t < 15:30
    t["r"] = t.right.str[0]
    t["isM"] = t.condition.isin(ML)

    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{D:%Y%m%d}.parquet"),
                         columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[ch.ts < WALL]                                             # time wall
    ch = ch[(~ch.flag_bad) & (ch.bid > 0)][["ts", "strike", "right", "mid"]].rename(columns={"right": "r"})
    ch["ts"] = ch.ts.astype("datetime64[ns]")
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < WALL) & (sp.ts.dt.normalize() == D)]             # time wall
    spot = pd.Series(sp.spot.values, index=sp.ts.values.astype("datetime64[ns]"))

    # chain interp for every row
    t["m"] = t.trade_timestamp.dt.floor("min")
    t["m1"] = t.m + pd.Timedelta(minutes=1)
    t = t.merge(ch.rename(columns={"ts": "m", "mid": "c0"}), on=["m", "strike", "r"], how="left")
    t = t.merge(ch.rename(columns={"ts": "m1", "mid": "c1"}), on=["m1", "strike", "r"], how="left")
    t["u"] = (t.trade_timestamp - t.m).dt.total_seconds() / 60.0
    t["ci"] = (1 - t.u) * t.c0 + t.u * t.c1
    t["S"] = spot.reindex(t.m.values).values
    t["good"] = (t.bid > 0) & (t.ask > t.bid)
    t["omid"] = (t.bid + t.ask) / 2

    # ---------- combos ----------
    m = t[t.isM].copy()
    m["pq"] = m.price * m["size"]
    a = m.groupby(["trade_timestamp", "strike", "r"], sort=True).agg(
        q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first"),
        c0=("c0", "first"), c1=("c1", "first"), S=("S", "first"), u=("u", "first")).reset_index()
    a["px"] = a.pq / a.q
    # single-leg placebo leg means: (15-min window, strike, r) mean of price - chain interp
    s1 = t[(~t.isM) & t.good & (t.price > 0)]
    s1 = s1.assign(win=s1.trade_timestamp.dt.floor("15min"), ell=s1.price - s1.ci).dropna(subset=["ell"])
    lm = s1.groupby(["win", "strike", "r"]).ell.mean().to_dict()

    rows = []
    for ts, g in a.groupby("trade_timestamp", sort=True):
        n = len(g)
        if n not in (3, 4):
            continue
        L = {(s, r): i for i, (s, r) in enumerate(zip(g.strike.values, g.r.values))}
        ks = sorted({s for s, _ in L})
        if len(ks) != 3 or ks[2] - ks[1] != ks[1] - ks[0]:
            continue
        w = ks[1] - ks[0]
        q = g.q.values
        if n == 4:
            keys = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
            if set(keys) != set(L) or len({q[L[x]] for x in keys}) != 1:
                continue
            gv = np.array([1.0, -1.0, -1.0, 1.0]); st = "iron"
        else:
            rs = {r for _, r in L}
            if len(rs) != 1:
                continue
            r0 = rs.pop(); keys = [(k, r0) for k in ks]
            qq = [q[L[x]] for x in keys]
            if not (qq[0] == qq[2] and qq[1] == 2 * qq[0]):
                continue
            gv = np.array([1.0, -2.0, 1.0]); st = "fly_" + r0
        ix = [L[x] for x in keys]
        bd, ak = g.bid.values[ix], g.ask.values[ix]
        if (bd <= 0).any() or (ak <= bd).any():
            continue
        S = g.S.values[0]
        if not (abs(ks[1] - S) <= 5 and 15 <= w < 80):
            continue
        c0, c1 = g.c0.values[ix], g.c1.values[ix]
        win = ts.floor("15min")
        ls = [lm.get((win, k, r)) for k, r in keys]
        rows.append({"date": D, "ts": ts, "struct": st, "lots": int(q[ix[0]]),
                     "trade": float(gv @ g.px.values[ix]), "own": float(gv @ ((bd + ak) / 2)),
                     "ch0": float(gv @ c0), "ch1": float(gv @ c1), "u": float(g.u.values[0]),
                     "Dsingle": float(gv @ np.array(ls)) if all(x is not None for x in ls) else np.nan})
    combos = pd.DataFrame(rows)

    # ---------- leg-level diagnostics ----------
    x = t[t.good & t.S.notna()].copy()
    x["dist"] = (x.strike - x.S).abs()
    x = x[x.dist <= 85]
    x["bin"] = pd.cut(x.dist, BINS, labels=LAB).astype(str)
    x["typ"] = np.where(x.isM, "M", "S")
    x["age"] = (x.trade_timestamp - x.quote_timestamp).dt.total_seconds()
    x["oc"] = (x.omid - x.ci) * 100
    x["om0"] = (x.omid - x.c0) * 100
    # neighbours: per contract, ms-groups
    x = x.sort_values(["strike", "r", "trade_timestamp"], kind="stable").reset_index(drop=True)
    grp = x.groupby(["strike", "r", "trade_timestamp"], sort=False)
    gg = grp.agg(first=("omid", "first"), last=("omid", "last"), c=("ci", "first")).reset_index()
    same = (gg.strike.values[1:] == gg.strike.values[:-1]) & (gg.r.values[1:] == gg.r.values[:-1])
    tt = gg.trade_timestamp.values
    prev_mid = np.r_[np.nan, np.where(same, gg["last"].values[:-1], np.nan)]
    prev_dt = np.r_[np.nan, np.where(same, (tt[1:] - tt[:-1]) / np.timedelta64(1, "ms"), np.nan)]
    next_mid = np.r_[np.where(same, gg["first"].values[1:], np.nan), np.nan]
    next_dt = np.r_[np.where(same, (tt[1:] - tt[:-1]) / np.timedelta64(1, "ms"), np.nan), np.nan]
    gg["pm"] = np.where(prev_dt <= 1000, prev_mid, np.nan)
    gg["nm"] = np.where(next_dt <= 1000, next_mid, np.nan)
    x = x.merge(gg[["strike", "r", "trade_timestamp", "pm", "nm"]], on=["strike", "r", "trade_timestamp"], how="left")
    x["d_prev"] = (x.omid - x.pm) * 100
    x["d_next"] = (x.omid - x.nm) * 100
    x["prev_c"] = (x.pm - x.ci) * 100
    x["next_c"] = (x.nm - x.ci) * 100
    x["early"] = x.u * 60 < 0.5
    x["aq"] = pd.cut(x.age, [-1e9, 0.01, 0.1, 1, 10, 1e9], labels=["<10ms", "10-100ms", "0.1-1s", "1-10s", ">10s"]).astype(str)

    cells = []
    def add(df, key, cols, tag):
        if df.empty:
            return
        h = df.groupby(key)[cols].mean()
        n = df.groupby(key).size().rename("n")
        h = h.join(n).reset_index()
        h["tag"] = tag
        cells.append(h)
    add(x, ["typ", "r", "bin"], ["oc", "d_prev", "d_next", "prev_c", "next_c", "age"], "base")
    add(x[x.early], ["typ", "r", "bin"], ["om0"], "early")
    add(x[x.typ == "S"], ["r", "bin", "aq"], ["oc"], "age")
    xs = x[x.typ == "S"].copy(); xs["cond"] = xs.condition.astype(str)
    add(xs, ["r", "bin", "cond"], ["oc"], "cond")
    add(x, ["typ", "r", "bin"], ["u"], "u")
    # check 4: same contract-minute
    cm = x.groupby(["strike", "r", "m", "typ"]).oc.mean().unstack("typ")
    if {"S", "M"} <= set(cm.columns):
        cm = cm.dropna(subset=["S", "M"]).reset_index()
        cm = cm.merge(x.groupby(["strike", "r", "m"]).bin.first().reset_index(), on=["strike", "r", "m"])
        cm["diff"] = cm.S - cm.M
        add(cm, ["r", "bin"], ["S", "M", "diff"], "cm")
    # age distribution
    ages = x.groupby("typ").age.quantile([0.5, 0.9, 0.99]).unstack().reset_index()
    ages["tag"] = "ageq"; cells.append(ages)
    c = pd.concat(cells, ignore_index=True); c["date"] = D
    return combos, c


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < WALL]                                       # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [d for d in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz"))]
    co, ce = [], []
    with ProcessPoolExecutor(6) as ex:
        for res in ex.map(one_day, days, chunksize=1):
            if res is None:
                continue
            co.append(res[0]); ce.append(res[1])
    os.makedirs(OUT, exist_ok=True)
    pd.concat(co, ignore_index=True).to_parquet(os.path.join(OUT, "combos.parquet"))
    ce = pd.concat(ce, ignore_index=True)
    for k in ("bin", "aq", "cond", "typ", "r"):
        if k in ce:
            ce[k] = ce[k].astype(str)
    ce.columns = [str(c) for c in ce.columns]
    ce.to_parquet(os.path.join(OUT, "cells.parquet"))
    print(len(days), "days", sum(len(c) for c in co), "combos")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        c, e = one_day(pd.Timestamp(sys.argv[1]))
        print(len(c), c.head()); print(e[e.tag == "base"].to_string()); print(e[e.tag == "ageq"])
    else:
        main()
