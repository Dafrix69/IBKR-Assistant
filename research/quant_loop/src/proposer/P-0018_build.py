"""P-0018 build: level of near-ATM 0DTE iron-fly / 1:2:1-fly combo prints vs an independent leg-mid reference
(chain mid interpolated to the trade second), plus the single-leg Pi-mapped placebo (A-tape scope).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0018_build.py train
Output: research/quant_loop/src/proposer/P-0018_tables/prints_train.parquet (one row per identified combo print)

Pi = sum g_i x_i ; iron g = (+1,-1,-1,+1) on (K-w P, K P, K C, K+w C); fly g = (+1,-2,+1) same right.
Holding Pi = short iron fly = long 1:2:1 fly.
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0018_tables"
SPLIT = pd.Timestamp("2025-11-01")          # A-tape time wall: train = date < 2025-11-01
START = pd.Timestamp("2024-10-30")
ML = [130, 131, 134, 137, 144]
COLS = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"]
T_LO, T_HI = 9 * 60 + 45, 16 * 60            # build 09:45-15:59; main sample < 15:30 is applied in analyze


def combos(m):
    """Same identification as P-0017 (same-ms same-leg aggregation first, then shape)."""
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
                    "H_own": float(np.abs(g) @ ((k_ - b) / 2)), "legs": tuple(need), "g": g})
    return out


def day(x):
    path = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz")
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    if d.empty:
        return [], {}
    D = pd.Timestamp(x)
    tmin = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    d = d[(tmin >= T_LO) & (tmin < T_HI)].copy()
    d["r"] = d.right.str[0]
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{x}.parquet"),
                         columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT]                                       # time wall
    ch = ch[~ch.flag_bad & (ch.bid > 0)]
    cm = {k: (v, a - b) for k, v, a, b in zip(zip(ch.ts, ch.strike, ch.right), ch.mid, ch.ask, ch.bid)}
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < SPLIT) & (sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]   # time wall
    spot_min = dict(zip(sp.ts, sp.spot))
    one = pd.Timedelta(minutes=1)

    # ---- single-leg placebo: per (15-min window, strike, right) mean of price - chain interp mid (points)
    s1 = d[~d.condition.isin(ML) & (d.bid > 0) & (d.ask > d.bid) & (d.price > 0)]
    fl = s1.trade_timestamp.dt.floor("min")
    u = ((s1.trade_timestamp - fl).dt.total_seconds() / 60).values
    m0 = np.array([cm.get(k, (np.nan, np.nan))[0] for k in zip(fl, s1.strike, s1.r)])
    m1 = np.array([cm.get(k, (np.nan, np.nan))[0] for k in zip(fl + one, s1.strike, s1.r)])
    ell = s1.price.values - ((1 - u) * m0 + u * m1)
    sl = pd.DataFrame({"win": s1.trade_timestamp.dt.floor("15min").values, "strike": s1.strike.values,
                       "r": s1.r.values, "ell": ell, "cond": s1.condition.values}).dropna(subset=["ell"])
    leg_mean = sl.groupby(["win", "strike", "r"]).ell.mean().to_dict()
    cond_counts = sl.cond.value_counts().to_dict()

    rows = []
    for c in combos(d[d.condition.isin(ML)]):
        flm = c["ts"].floor("min")
        S = spot_min.get(flm, np.nan)
        if not (abs(c["K"] - S) <= 5 and 15 <= c["w"] < 80):
            continue
        legs, g = c.pop("legs"), c.pop("g")
        uu = (c["ts"] - flm).total_seconds() / 60
        a0 = [cm.get((flm, k, r)) for k, r in legs]
        a1 = [cm.get((flm + one, k, r)) for k, r in legs]
        pi_m0 = float(sum(gi * v[0] for gi, v in zip(g, a0))) if all(v is not None for v in a0) else np.nan
        H_ch = float(sum(abs(gi) * v[1] / 2 for gi, v in zip(g, a0))) if all(v is not None for v in a0) else np.nan
        pi_m1 = float(sum(gi * v[0] for gi, v in zip(g, a1))) if all(v is not None for v in a1) else np.nan
        win = c["ts"].floor("15min")
        lm = [leg_mean.get((win, k, r)) for k, r in legs]
        d_single = float(sum(gi * v for gi, v in zip(g, lm))) if all(v is not None for v in lm) else np.nan
        c.update(date=D, S=S, u=uu, pi_m0=pi_m0, pi_m1=pi_m1, H_ch=H_ch, single=d_single)
        rows.append(c)
    return rows, cond_counts


def main(which):
    assert which == "train"
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                 # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{t.year}/{t.strftime('%Y%m%d')}.csv.gz"))]
    rows, cc = [], {}
    with ProcessPoolExecutor(6) as ex:
        for r, c in ex.map(day, days):
            rows += r
            for k, v in c.items():
                cc[k] = cc.get(k, 0) + v
    os.makedirs(OUT, exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_parquet(os.path.join(OUT, f"prints_{which}.parquet"))
    pd.Series(cc).sort_values(ascending=False).to_csv(os.path.join(OUT, f"single_cond_{which}.csv"))
    print(len(days), "days", len(df), "prints; single-leg condition counts:", cc)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "one":
        r, c = day(sys.argv[2])
        r = pd.DataFrame(r)
        print(len(r), c); print(r.head(8).T); print(r.struct.value_counts())
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "train")
