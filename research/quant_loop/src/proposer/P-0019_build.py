"""P-0019 build (spec sections 2-3). Near-ATM 0DTE iron-fly / 1:2:1-fly combo prints:
level vs chain-interp mid (D), vs own attached NBBO mid (D_own), own-mid vs chain (F),
single-leg placebo price - own mid Pi-mapped (P_own), +-1 s / +-5 s neighbour quotes from
(a) single-leg prints and (b) other multi-leg-coded prints; plus single-leg diagnostics.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0019_build.py train
Writes P-0019_tables/prints_train.parquet, singlediag_train.parquet, qage_train.parquet
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0019_tables"
SPLIT = pd.Timestamp("2025-11-01")          # A-tape time wall: train = date < 2025-11-01
START = pd.Timestamp("2024-10-30")
ML = [130, 131, 134, 137, 144]
COLS = ["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]
T_LO, T_HI = 9 * 60 + 45, 16 * 60
BINS = [-1, 5, 15, 30, 50, 85]
LAB = ["body<=5", "6-15", "16-30", "31-50", "51-85"]
AGE = [-1, 5, 50, 500, 5000, 10 ** 12]       # ms
AGEL = ["<5ms", "5-50ms", "50-500ms", "0.5-5s", ">=5s"]
SEC = 1_000_000_000


def combos(m):
    """Same identification as P-0017/P-0018 (same-ms same-leg aggregation first, then shape)."""
    m = m.assign(pq=m.price * m["size"])
    a = (m.groupby(["trade_timestamp", "strike", "r"], sort=True)
         .agg(q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first")).reset_index())
    a["px"] = a.pq / a.q
    ts = a.trade_timestamp.values
    st, rr, q, px, bd, ak = a.strike.values, a.r.values, a.q.values, a.px.values, a.bid.values, a.ask.values
    br = np.flatnonzero(np.r_[True, ts[1:] != ts[:-1], True])
    out = []
    for i0, i1 in zip(br[:-1], br[1:]):
        n = i1 - i0
        if n not in (3, 4):
            continue
        ks = sorted(set(st[i0:i1]))
        if len(ks) != 3 or ks[1] - ks[0] != ks[2] - ks[1]:
            continue
        w = ks[1] - ks[0]
        legs = {(st[j], rr[j]): j for j in range(i0, i1)}
        if n == 4:
            need = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
            if set(need) != set(legs):
                continue
            idx = [legs[x] for x in need]
            if len({q[j] for j in idx}) != 1:
                continue
            g = np.array([1., -1., -1., 1.]); struct = "iron"; size = q[idx[0]]
        else:
            rs = {r for _, r in legs}
            if len(rs) != 1:
                continue
            r = next(iter(rs))
            need = [(k, r) for k in ks]
            idx = [legs[x] for x in need]
            qq = [q[j] for j in idx]
            if not (qq[1] == 2 * qq[0] == 2 * qq[2]):
                continue
            g = np.array([1., -2., 1.]); struct = "fly_" + r; size = qq[0]
        b, k_, p = bd[idx], ak[idx], px[idx]
        if (b <= 0).any() or (k_ <= b).any():
            continue
        out.append({"ts": pd.Timestamp(ts[i0]), "struct": struct, "K": ks[1], "w": w, "size": int(size),
                    "pi_trade": float(g @ p), "pi_own": float(g @ ((b + k_) / 2)),
                    "legs": tuple(need), "g": g})
    return out


def nb_index(df):
    """(strike, r) -> (sorted int64 ns timestamps, attached mids)."""
    out = {}
    df = df.sort_values("trade_timestamp", kind="stable")
    for key, x in df.groupby(["strike", "r"], sort=False):
        out[key] = (x.trade_timestamp.values.astype("datetime64[ns]").astype("int64"), ((x.bid + x.ask) / 2).values)
    return out


def nb_mid(idx, key, t, win):
    """Mean of (last print in [t-win, t), first print in (t, t+win]) attached mids; same ms excluded."""
    v = idx.get(key)
    if v is None:
        return np.nan
    ts, md = v
    i = np.searchsorted(ts, t, side="left") - 1          # last strictly before t (ms resolution)
    j = np.searchsorted(ts, t, side="right")             # first strictly after t
    if i < 0 or j >= len(ts) or ts[i] < t - win or ts[j] > t + win:
        return np.nan
    return 0.5 * (md[i] + md[j])


def day(x):
    path = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz")
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    if d.empty:
        return [], None, None
    D = pd.Timestamp(x)
    d["quote_timestamp"] = pd.to_datetime(d.quote_timestamp)
    d["r"] = d.right.str[0]
    d = d.copy()
    qok = (d.bid > 0) & (d.ask > d.bid)              # quote filter for single legs / neighbours; combos check after identification (as P-0018)
    tmin = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{x}.parquet"),
                         columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT]                                       # time wall
    ch = ch[~ch.flag_bad & (ch.bid > 0)]
    cm = {k: (v, a - b) for k, v, a, b in zip(zip(ch.ts, ch.strike, ch.right), ch.mid, ch.ask, ch.bid)}
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < SPLIT) & (sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]   # time wall
    spot_min = dict(zip(sp.ts, sp.spot))
    one = pd.Timedelta(minutes=1)

    isml = d.condition.isin(ML)
    single = d[~isml & qok & (d.price > 0)]
    mlrows = d[isml & qok]
    idx_a, idx_b = nb_index(single), nb_index(mlrows)

    # ---- placebo P_own: per (15-min window, strike, right) mean of single-leg price - own mid (points)
    s1 = single[(tmin[single.index] >= T_LO) & (tmin[single.index] < T_HI)]
    ell = (s1.price - (s1.bid + s1.ask) / 2).values
    sl = pd.DataFrame({"win": s1.trade_timestamp.dt.floor("15min").values, "strike": s1.strike.values,
                       "r": s1.r.values, "ell": ell})
    leg_mean = sl.groupby(["win", "strike", "r"]).ell.mean().to_dict()

    # ---- single-leg diagnostics (09:45-15:30): own mid - chain interp by quote age; own mid - +-1s neighbours by bin
    sd = s1[(s1.trade_timestamp.dt.hour * 60 + s1.trade_timestamp.dt.minute) < 930]
    fl = sd.trade_timestamp.dt.floor("min")
    u = ((sd.trade_timestamp - fl).dt.total_seconds() / 60).values
    m0 = np.array([cm.get(k, (np.nan, np.nan))[0] for k in zip(fl, sd.strike, sd.r)])
    m1 = np.array([cm.get(k, (np.nan, np.nan))[0] for k in zip(fl + one, sd.strike, sd.r)])
    own = ((sd.bid + sd.ask) / 2).values
    S = np.array([spot_min.get(t, np.nan) for t in fl])
    age = ((sd.trade_timestamp - sd.quote_timestamp).dt.total_seconds() * 1000).values
    tns = sd.trade_timestamp.values.astype("datetime64[ns]").astype("int64")
    nb = np.array([nb_mid(idx_a, (k, r), t, SEC) for k, r, t in zip(sd.strike.values, sd.r.values, tns)])
    sdg = pd.DataFrame({"date": D, "r": sd.r.values,
                        "bin": pd.cut(np.abs(sd.strike.values - S), BINS, labels=LAB),
                        "agebin": pd.cut(age, AGE, labels=AGEL),
                        "own_chain": (own - ((1 - u) * m0 + u * m1)) * 100, "own_nb": (own - nb) * 100,
                        "nb_chain": (nb - ((1 - u) * m0 + u * m1)) * 100})
    sdg = sdg.dropna(subset=["bin"])
    agg = (sdg.groupby(["date", "bin", "r", "agebin"], observed=True)
           .agg(n=("own_chain", "size"), oc_s=("own_chain", "sum"), oc_n=("own_chain", "count"),
                on_s=("own_nb", "sum"), on_n=("own_nb", "count"), nc_s=("nb_chain", "sum")).reset_index())
    # quote age: combo-coded rows vs single rows, 09:45-15:30
    tm2 = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    dd = d[(tm2 >= T_LO) & (tm2 < 930)]
    ag = (dd.trade_timestamp - dd.quote_timestamp).dt.total_seconds() * 1000
    qa = pd.DataFrame([{"date": D, "kind": k, "med": ag[msk].median(), "p90": ag[msk].quantile(0.9),
                        "gt1s": (ag[msk] > 1000).mean(), "n": int(msk.sum())}
                       for k, msk in (("combo", dd.condition.isin(ML)), ("single", ~dd.condition.isin(ML)))])

    rows = []
    mm = d[isml & (tmin >= T_LO) & (tmin < T_HI)]
    for c in combos(mm):
        flm = c["ts"].floor("min")
        Sv = spot_min.get(flm, np.nan)
        if not (abs(c["K"] - Sv) <= 5 and 15 <= c["w"] < 80):
            continue
        legs, g = c.pop("legs"), c.pop("g")
        uu = (c["ts"] - flm).total_seconds() / 60
        a0 = [cm.get((flm, k, r)) for k, r in legs]
        a1 = [cm.get((flm + one, k, r)) for k, r in legs]
        ok0, ok1 = all(v is not None for v in a0), all(v is not None for v in a1)
        pi_m0 = float(sum(gi * v[0] for gi, v in zip(g, a0))) if ok0 else np.nan
        H_ch = float(sum(abs(gi) * v[1] / 2 for gi, v in zip(g, a0))) if ok0 else np.nan
        pi_m1 = float(sum(gi * v[0] for gi, v in zip(g, a1))) if ok1 else np.nan
        win = c["ts"].floor("15min")
        lm = [leg_mean.get((win, k, r)) for k, r in legs]
        p_own = float(sum(gi * v for gi, v in zip(g, lm))) if all(v is not None for v in lm) else np.nan
        t = c["ts"].value
        nbs = {}
        for nm, ix in (("a", idx_a), ("b", idx_b)):
            for wn, wv in (("1", SEC), ("5", 5 * SEC)):
                mids = [nb_mid(ix, (k, r), t, wv) for k, r in legs]
                nbs[f"pi_nb{nm}{wn}"] = float(np.dot(g, mids))   # nan if any leg missing
        c.update(date=D, S=Sv, u=uu, pi_m0=pi_m0, pi_m1=pi_m1, H_ch=H_ch, p_own=p_own, **nbs)
        rows.append(c)
    return rows, agg, qa


def main(which):
    assert which == "train"
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                 # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{t.year}/{t.strftime('%Y%m%d')}.csv.gz"))]
    rows, aggs, qas = [], [], []
    with ProcessPoolExecutor(6) as ex:
        for r, a, q in ex.map(day, days):
            rows += r
            if a is not None:
                aggs.append(a); qas.append(q)
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(rows).to_parquet(os.path.join(OUT, f"prints_{which}.parquet"))
    pd.concat(aggs).to_parquet(os.path.join(OUT, f"singlediag_{which}.parquet"))
    pd.concat(qas).to_parquet(os.path.join(OUT, f"qage_{which}.parquet"))
    print(len(days), "days", len(rows), "prints")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "one":
        r, a, q = day(sys.argv[2])
        r = pd.DataFrame(r)
        print(len(r)); print(r.head(3).T); print(r.notna().mean()); print(q); print(a.head())
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "train")
