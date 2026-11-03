"""P-0017 build: post-trade markouts of near-ATM 0DTE iron-fly / 1:2:1-fly combo prints (A-tape scope).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0017_build.py train
Output: research/quant_loop/src/proposer/P-0017_tables/prints_train.parquet  (one row per identified combo print)

Sign convention (spec 3.1): Pi = sum g_i * x_i, the short-gamma package (= w - iron-fly credit; = long-fly debit).
s = +1 if Pi_trade - Pi_mid >= +0.05 (buyer of Pi aggressive), -1 if <= -0.05.
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0017_tables"
SPLIT = pd.Timestamp("2025-11-01")          # A-tape time wall: train = date < 2025-11-01
START = pd.Timestamp("2024-10-30")
ML = [130, 131, 134, 137, 144]
TAUS = [1, 5, 15]
COLS = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"]
T_LO, T_HI = 9 * 60 + 45, 15 * 60 + 30       # minutes after midnight: 09:45 <= t < 15:30


def combos(m):
    """Identify iron flies and 1:2:1 flies; same-ms same-leg rows aggregated first. Returns list of dicts."""
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
        mid = (b + k_) / 2
        out.append({"ts": pd.Timestamp(ts[i0]), "struct": struct, "K": ks[1], "w": w, "size": int(size),
                    "pi_trade": float(g @ p), "pi0": float(g @ mid), "H": float(np.abs(g) @ ((k_ - b) / 2)),
                    "legs": tuple(need), "g": g})
    return out


def day(x):
    path = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz")
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    if d.empty:
        return []
    D = pd.Timestamp(x)
    d = d[d.condition.isin(ML)]
    tmin = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    d = d[(tmin >= T_LO) & (tmin < T_HI)]
    d["r"] = d.right.str[0]
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{x}.parquet"),
                         columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT]                                       # time wall
    ch = ch[~ch.flag_bad & (ch.bid > 0)]
    cm = {k: v for k, v in zip(zip(ch.ts, ch.strike, ch.right), ch.mid)}
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < SPLIT) & (sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]   # time wall
    spot_min = dict(zip(sp.ts, sp.spot))

    def pi_chain(m, legs, g):
        v = 0.0
        for (s, r), gi in zip(legs, g):
            x_ = cm.get((m, s, r))
            if x_ is None:
                return np.nan
            v += gi * x_
        return v

    base_cache = {}

    def beta(legs, g, win0, tau):
        key = (legs, win0, tau)
        if key not in base_cache:
            vals = []
            for j in range(15):
                m = win0 + pd.Timedelta(minutes=j)
                a, b = pi_chain(m, legs, g), pi_chain(m + pd.Timedelta(minutes=tau), legs, g)
                if np.isfinite(a) and np.isfinite(b):
                    vals.append(b - a)
            base_cache[key] = float(np.mean(vals)) if len(vals) >= 8 else np.nan
        return base_cache[key]

    rows = []
    for c in combos(d):
        fl = c["ts"].floor("min")
        S = spot_min.get(fl, np.nan)
        if not (abs(c["K"] - S) <= 5 and 15 <= c["w"] < 80):
            continue
        legs, g = c.pop("legs"), c.pop("g")
        win0 = c["ts"].floor("15min")
        c.update(date=D, S=S, win=win0)
        c["pi_ch0"] = pi_chain(fl, legs, g)
        c["pi_pre"] = pi_chain(fl - pd.Timedelta(minutes=1), legs, g)
        for tau in TAUS:
            c[f"pi_{tau}"] = pi_chain(fl + pd.Timedelta(minutes=tau), legs, g)
            c[f"beta_{tau}"] = beta(legs, g, win0, tau)
        rows.append(c)
    return rows


def main(which):
    assert which == "train"
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                 # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{t.year}/{t.strftime('%Y%m%d')}.csv.gz"))]
    rows = []
    with ProcessPoolExecutor(6) as ex:
        for r in ex.map(day, days):
            rows += r
    os.makedirs(OUT, exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_parquet(os.path.join(OUT, f"prints_{which}.parquet"))
    print(len(days), "days", len(df), "prints")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "one":
        r = pd.DataFrame(day(sys.argv[2]))
        print(len(r)); print(r.head(10).T); print(r.struct.value_counts())
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "train")
