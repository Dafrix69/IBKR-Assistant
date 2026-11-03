"""V-0019 build (independent; combo identification reused from V-0018, D / P_own / F / neighbours rewritten).

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0019_build.py train
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0019_build.py test     # ONE run only
Window: train = [2024-10-30, 2025-11-01), test = [2025-11-01, 2026-10-30). Every file read is filtered to [LO, HI)
as the first step after reading (tape, chain, spot, calendar).
Outputs V-0019_tables/combos_<which>.parquet (one row per combo print, 09:45-16:00, |K-S|<=15, 10<=w<100)
        V-0019_tables/aggr_<which>.parquet  (per day x type x right x bin: aggressor-composition counts, 09:45-15:30)
Pi weights: iron (+1,-1,-1,+1) on (K-w P, K P, K C, K+w C); fly (+1,-2,+1). All Pi values in points.
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0019_tables")
WIN = {"train": (pd.Timestamp("2024-10-30"), pd.Timestamp("2025-11-01")),
       "test": (pd.Timestamp("2025-11-01"), pd.Timestamp("2026-10-30"))}
ML = (130, 131, 134, 137, 144)
COLS = ["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]
BINS = [-0.1, 5, 15, 30, 50, 85]
LAB = ["0-5", "6-15", "16-30", "31-50", "51-85"]
S1, S5 = 1_000_000_000, 5_000_000_000


def nb_table(df):
    """per contract: sorted unique ms-group timestamps (int ns) and mean attached mid of that group"""
    g = df.groupby(["strike", "r", "trade_timestamp"], sort=True).omid.mean().reset_index()
    out = {}
    for key, x in g.groupby(["strike", "r"], sort=False):
        out[key] = (x.trade_timestamp.values.astype("datetime64[ns]").astype(np.int64), x.omid.values)
    return out


def nb(tab, key, t, w):
    v = tab.get(key)
    if v is None:
        return np.nan
    ts, md = v
    i = np.searchsorted(ts, t, "left") - 1
    j = np.searchsorted(ts, t, "right")
    if i < 0 or j >= len(ts) or t - ts[i] > w or ts[j] - t > w:
        return np.nan
    return 0.5 * (md[i] + md[j])


def one_day(args):
    D, LO, HI = args
    assert LO <= D < HI
    f = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{D.year}/{D:%Y%m%d}.csv.gz")
    t = pd.read_csv(f, usecols=COLS)
    t["trade_timestamp"] = pd.to_datetime(t.trade_timestamp)
    t = t[(t.trade_timestamp >= LO) & (t.trade_timestamp < HI)]       # time wall, first step
    if t.empty:
        return None
    t["r"] = t.right.str[0]
    t["isM"] = t.condition.isin(ML)
    t["good"] = (t.bid > 0) & (t.ask > t.bid)
    t["omid"] = (t.bid + t.ask) / 2
    hm = t.trade_timestamp.dt.hour * 60 + t.trade_timestamp.dt.minute

    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{D:%Y%m%d}.parquet"),
                         columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[(ch.ts >= LO) & (ch.ts < HI)]                             # time wall
    ch = ch[(~ch.flag_bad) & (ch.bid > 0)].rename(columns={"right": "r"})
    ch["ts"] = ch.ts.astype("datetime64[ns]")
    ch["hs"] = (ch.ask - ch.bid) / 2
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts >= LO) & (sp.ts < HI) & (sp.ts.dt.normalize() == D)]   # time wall
    spot = pd.Series(sp.spot.values, index=sp.ts.values.astype("datetime64[ns]"))

    # neighbour tables (whole day): (a) single-leg rows, (b) multi-leg-coded rows
    sing = t[(~t.isM) & t.good & (t.price > 0)]
    tabA = nb_table(sing)
    tabB = nb_table(t[t.isM & t.good])
    # placebo: per (15-min window, contract) mean of single price - own mid (points)
    lm = (sing.assign(win=sing.trade_timestamp.dt.floor("15min"), ell=sing.price - sing.omid)
          .groupby(["win", "strike", "r"]).ell.mean().to_dict())

    m = t[t.isM & (hm >= 585) & (hm < 960)].copy()
    m["pq"] = m.price * m["size"]
    a = m.groupby(["trade_timestamp", "strike", "r"], sort=True).agg(
        q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first")).reset_index()
    a["px"] = a.pq / a.q
    chi = ch.set_index(["ts", "strike", "r"])[["mid", "hs"]]
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
        m0 = ts.floor("min")
        S = spot.get(np.datetime64(m0, "ns"), np.nan)
        if not (abs(ks[1] - S) <= 15 and 10 <= w < 100):
            continue
        m1 = m0 + pd.Timedelta(minutes=1)

        def cpi(mm, col):
            v = []
            for k, r in keys:
                try:
                    v.append(chi.at[(mm, k, r), col])
                except KeyError:
                    return np.nan
            v = np.array(v, dtype=float)
            return float(np.abs(gv) @ v) if col == "hs" else float(gv @ v)
        win = ts.floor("15min")
        ls = [lm.get((win, k, r)) for k, r in keys]
        tn = np.datetime64(ts, "ns").astype(np.int64)
        rec = {"date": D, "ts": ts, "struct": st, "lots": int(q[ix[0]]), "w": float(w), "K": float(ks[1]), "S": float(S),
               "trade": float(gv @ g.px.values[ix]), "own": float(gv @ ((bd + ak) / 2)),
               "pib": float(gv @ np.where(gv > 0, bd, ak)), "pia": float(gv @ np.where(gv > 0, ak, bd)),
               "ch0": cpi(m0, "mid"), "ch1": cpi(m1, "mid"), "H": cpi(m0, "hs"),
               "u": (ts - m0).total_seconds() / 60.0,
               "Pown": float(gv @ np.array(ls)) if all(x is not None for x in ls) else np.nan}
        for nm, tab in (("a", tabA), ("b", tabB)):
            for wn, wv in (("1", S1), ("5", S5)):
                rec[f"nb{nm}{wn}"] = float(gv @ np.array([nb(tab, (k, r), tn, wv) for k, r in keys]))
        rows.append(rec)
    combos = pd.DataFrame(rows)

    # aggressor composition, 09:45-15:30, |K-S|<=85, legs with good quote
    x = t[t.good & (hm >= 585) & (hm < 930) & (t.price > 0)].copy()
    x["S"] = spot.reindex(x.trade_timestamp.dt.floor("min").values).values
    x["bin"] = pd.cut((x.strike - x.S).abs(), BINS, labels=LAB).astype(str)
    x = x[x.bin != "nan"]
    eps = 1e-9
    x["ge_ask"] = x.price >= x.ask - eps
    x["le_bid"] = x.price <= x.bid + eps
    x["at_mid"] = (x.price - x.omid).abs() < eps
    x["inside"] = ~(x.ge_ask | x.le_bid | x.at_mid)
    x["ell"] = (x.price - x.omid) * 100
    x["typ"] = np.where(x.isM, "M", "S")
    ag = x.groupby(["typ", "r", "bin"]).agg(n=("price", "size"), ge_ask=("ge_ask", "sum"), le_bid=("le_bid", "sum"),
                                             at_mid=("at_mid", "sum"), inside=("inside", "sum"), ell=("ell", "mean")).reset_index()
    ag["date"] = D
    return combos, ag


def main(which):
    LO, HI = WIN[which]
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[(cal.index >= LO) & (cal.index < HI)]                    # time wall
    cal = cal[cal.has_0dte & ~cal.half_day]
    days = [d for d in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz"))]
    print(which, len(cal), "calendar days,", len(days), "with tape", flush=True)
    co, ag = [], []
    with ProcessPoolExecutor(6) as ex:
        for res in ex.map(one_day, [(d, LO, HI) for d in days], chunksize=1):
            if res is None:
                continue
            co.append(res[0]); ag.append(res[1])
    os.makedirs(OUT, exist_ok=True)
    pd.concat(co, ignore_index=True).to_parquet(os.path.join(OUT, f"combos_{which}.parquet"))
    pd.concat(ag, ignore_index=True).to_parquet(os.path.join(OUT, f"aggr_{which}.parquet"))
    print(len(days), "days", sum(len(c) for c in co), "combos")


if __name__ == "__main__":
    if sys.argv[1] == "one":
        D = pd.Timestamp(sys.argv[2]); c, a = one_day((D, *WIN["train"]))
        print(len(c)); print(c.head(3).T); print(c.notna().mean()); print(a.head(12))
    else:
        main(sys.argv[1])
