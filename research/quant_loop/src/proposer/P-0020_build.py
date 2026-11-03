"""P-0020 build (spec sections 2-3). Near-ATM 0DTE two-leg vertical combo prints.
V = richer leg - cheaper leg (credit-spread value). Stores per print: V_trade, V_own, V_ref (chain interp),
H_own, H_ch, placebo leg means, strata.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0020_build.py train
Writes P-0020_tables/prints_train.parquet
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0020_tables"
SPLIT = pd.Timestamp("2025-11-01")          # A-tape time wall: train = date < 2025-11-01
START = pd.Timestamp("2024-10-30")
ML = [130, 131, 134, 137, 144]
COLS = ["strike", "right", "trade_timestamp", "condition", "size", "price", "bid", "ask"]
T_LO, T_HI = 10 * 60, 15 * 60 + 30
WIDTHS = {10, 15, 20, 25}


def verticals(m):
    m = m.assign(pq=m.price * m["size"])
    a = (m.groupby(["trade_timestamp", "strike", "r"], sort=True)
         .agg(q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first")).reset_index())
    a["px"] = a.pq / a.q
    ts = a.trade_timestamp.values
    st, rr, q, px, bd, ak = a.strike.values, a.r.values, a.q.values, a.px.values, a.bid.values, a.ask.values
    br = np.flatnonzero(np.r_[True, ts[1:] != ts[:-1], True])
    out = []
    for i0, i1 in zip(br[:-1], br[1:]):
        if i1 - i0 != 2:
            continue
        j0, j1 = i0, i0 + 1
        if rr[j0] != rr[j1] or st[j0] == st[j1] or q[j0] != q[j1]:
            continue
        r = rr[j0]
        lo, hi = (j0, j1) if st[j0] < st[j1] else (j1, j0)
        s, l = (lo, hi) if r == "C" else (hi, lo)          # s = richer (short leg of credit spread)
        if bd[s] <= 0 or bd[l] <= 0 or ak[s] <= bd[s] or ak[l] <= bd[l]:
            continue
        out.append({"ts": pd.Timestamp(ts[i0]), "r": r, "Ks": st[s], "Kl": st[l], "w": abs(st[s] - st[l]),
                    "size": int(q[s]), "v_trade": px[s] - px[l],
                    "v_own": (bd[s] + ak[s]) / 2 - (bd[l] + ak[l]) / 2,
                    "v_bid": bd[s] - ak[l], "v_ask": ak[s] - bd[l],
                    "h_own": (ak[s] - bd[s]) / 2 + (ak[l] - bd[l]) / 2})
    return out


def day(x):
    path = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz")
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    if d.empty:
        return []
    D = pd.Timestamp(x)
    d = d.copy()
    d["r"] = d.right.str[0]
    tmin = d.trade_timestamp.dt.hour * 60 + d.trade_timestamp.dt.minute
    d = d[(tmin >= T_LO) & (tmin < T_HI)]
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
    single = d[~isml & (d.bid > 0) & (d.ask > d.bid) & (d.price > 0)]
    sl = pd.DataFrame({"win": single.trade_timestamp.dt.floor("15min").values, "strike": single.strike.values,
                       "r": single.r.values, "ell": (single.price - (single.bid + single.ask) / 2).values})
    leg_mean = sl.groupby(["win", "strike", "r"]).ell.mean().to_dict()

    rows = []
    for c in verticals(d[isml]):
        if c["w"] not in WIDTHS:
            continue
        flm = c["ts"].floor("min")
        S = spot_min.get(flm, np.nan)
        if not abs(c["Ks"] - S) <= 30:
            continue
        u = (c["ts"] - flm).total_seconds() / 60
        a0 = [cm.get((flm, k, c["r"])) for k in (c["Ks"], c["Kl"])]
        a1 = [cm.get((flm + one, k, c["r"])) for k in (c["Ks"], c["Kl"])]
        if any(v is None for v in a0 + a1):
            continue
        v_ref = (1 - u) * (a0[0][0] - a0[1][0]) + u * (a1[0][0] - a1[1][0])
        h_ch = sum((1 - u) * x[1] / 2 + u * y[1] / 2 for x, y in zip(a0, a1))
        win = c["ts"].floor("15min")
        ls, ll = leg_mean.get((win, c["Ks"], c["r"])), leg_mean.get((win, c["Kl"], c["r"]))
        p_own = -(ls - ll) if (ls is not None and ll is not None) else np.nan
        itm = (c["Ks"] < S) if c["r"] == "C" else (c["Ks"] > S)
        c.update(date=D, S=S, v_ref=v_ref, h_ch=h_ch, p_own=p_own, itm=bool(itm))
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
    pd.DataFrame(rows).to_parquet(os.path.join(OUT, f"prints_{which}.parquet"))
    print(len(days), "days", len(rows), "prints")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "one":
        r = pd.DataFrame(day(sys.argv[2]))
        print(len(r)); print(r.describe().T)
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "train")
