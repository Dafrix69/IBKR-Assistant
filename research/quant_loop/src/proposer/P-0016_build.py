"""P-0016 build: second-level quoted spread (H, four fixed iron-fly legs) and combo effective k around
hh:00 (and the hh:37 placebo), from the SPXW 0DTE tape. A-tape scope.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0016_build.py train
Output: research/quant_loop/src/proposer/P-0016_tables/cells_train.parquet, profile_train.parquet
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0016_tables"
SPLIT = pd.Timestamp("2025-11-01")          # A-tape time wall: train = date < 2025-11-01
START = pd.Timestamp("2024-10-30")
ML = [130, 131, 134, 137, 144]
HOURS = [11, 12, 13, 14, 15]
WIDTHS = [20, 25, 30, 50, 75]
STALE = 60.0                                 # seconds
COLS = ["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]


def grid(t0, a, b):
    """1-second grid points t0 + a + 0.5 ... t0 + b - 0.5 (seconds)."""
    return t0 + pd.to_timedelta(np.arange(a, b) + 0.5, unit="s")


def leg_quotes(d, K, w):
    legs = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C")]
    out = []
    for s, r in legs:
        g = d[(d.strike == s) & (d.r == r)]
        if g.empty:
            return None
        g = g.sort_values("qt", kind="stable")
        out.append((g.qt.values, g.bid.values, g.ask.values))
    return out


def H_at(lq, pts):
    """Sum of four half-spreads at each grid point (asof on quote_timestamp, staleness <= STALE)."""
    tot = np.zeros(len(pts))
    ok = np.ones(len(pts), bool)
    pv = pts.values
    for qt, bid, ask in lq:
        i = np.searchsorted(qt, pv, side="right") - 1
        valid = i >= 0
        ii = np.where(valid, i, 0)
        age = (pv - qt[ii]) / np.timedelta64(1, "s")
        b, a = bid[ii], ask[ii]
        valid &= (age <= STALE) & (a > b) & (b >= 0)
        ok &= valid
        tot += np.where(valid, (a - b) / 2, 0.0)
    return np.where(ok, tot, np.nan)


def wmean(x):
    n = np.isfinite(x).sum()
    return (np.nanmean(x) if n * 2 >= len(x) else np.nan), int(n)


def combos(m, spot_min):
    """Reconstruct iron flies / 1:2:1 flies from multi-leg prints; aggregate same-ms same-leg rows first."""
    if m.empty:
        return pd.DataFrame(columns=["ts", "k"])
    a = (m.assign(pq=m.price * m["size"])
         .groupby(["trade_timestamp", "strike", "r"], sort=False)
         .agg(q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first")).reset_index())
    a["px"] = a.pq / a.q
    out = []
    for ts, g in a.groupby("trade_timestamp", sort=False):
        n = len(g)
        if n not in (3, 4):
            continue
        ks = sorted(set(g.strike))
        if len(ks) != 3 or ks[1] - ks[0] != ks[2] - ks[1]:
            continue
        w = ks[1] - ks[0]
        legs = {(s, r): (q, p, b, k_) for s, r, q, p, b, k_ in zip(g.strike, g.r, g.q, g.px, g.bid, g.ask)}
        if n == 4:
            need = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
            if set(need) != set(legs) or len({legs[x][0] for x in need}) != 1:
                continue
            sg, qq = np.array([1, -1, -1, 1]), np.array([1, 1, 1, 1])
        else:
            rs = {r for _, r in legs}
            if len(rs) != 1:
                continue
            r = next(iter(rs))
            need = [(k, r) for k in ks]
            q = [legs[x][0] for x in need]
            if not (q[1] == 2 * q[0] == 2 * q[2]):
                continue
            sg, qq = np.array([1, -1, 1]), np.array([1, 2, 1])
        L = [legs[x] for x in need]
        px = np.array([x[1] for x in L]); bid = np.array([x[2] for x in L]); ask = np.array([x[3] for x in L])
        if (ask <= bid).any() or (bid < 0).any():
            continue
        mid, h = (bid + ask) / 2, (ask - bid) / 2
        S = spot_min.get(ts.floor("min"), np.nan)
        if not (abs(ks[1] - S) <= 5 and 15 <= w < 80):
            continue
        H = float((qq * h).sum())
        out.append({"ts": ts, "k": abs(float((sg * qq * (px - mid)).sum())) / H})
    return pd.DataFrame(out, columns=["ts", "k"])


def day(x):
    path = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz")
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                             # time wall (first step after reading)
    if d.empty:
        return [], []
    d["qt"] = pd.to_datetime(d.quote_timestamp)
    d["r"] = d.right.str[0]
    D = pd.Timestamp(x)
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{x}.parquet"), columns=["strike", "right", "ts", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT]                                       # time wall
    ch = ch[~ch.flag_bad].set_index(["ts", "strike", "right"]).mid
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < SPLIT) & (sp.ts >= D) & (sp.ts < D + pd.Timedelta(days=1))]   # time wall
    spot_min = dict(zip(sp.ts, sp.spot))
    ml = d[d.condition.isin(ML)]
    cells, prof = [], []
    for hh in HOURS:
        for kind, mm in (("main", 0), ("plac", 37)):
            t0 = D + pd.Timedelta(hours=hh, minutes=mm)
            S = spot_min.get(t0, np.nan)
            if not np.isfinite(S):
                continue
            K = int(round(S / 5) * 5)
            tI = t0 - pd.Timedelta(minutes=1)
            try:
                I = ch[(tI, K, "C")] + ch[(tI, K, "P")]
            except KeyError:
                continue
            w = min(WIDTHS, key=lambda v: (round(abs(v / I - 2), 9), v))
            lq = leg_quotes(d, K, w)
            if lq is None:
                continue
            HA, nA = wmean(H_at(lq, grid(t0, 0, 10)))
            HB, nB = wmean(H_at(lq, grid(t0, 90, 120)))
            Hpre, _ = wmean(H_at(lq, grid(t0, -30, 0)))
            mw = ml[(ml.trade_timestamp >= t0 - pd.Timedelta(seconds=60)) & (ml.trade_timestamp < t0 + pd.Timedelta(seconds=180))]
            c = combos(mw, spot_min)
            sec = (c.ts - t0).dt.total_seconds() if len(c) else pd.Series(dtype=float)
            cA, cB = c[(sec >= 0) & (sec < 10)], c[(sec >= 90) & (sec < 120)]
            cells.append({"date": D, "hour": hh, "kind": kind, "K": K, "w": w, "I": I, "S": S,
                          "HA": HA, "HB": HB, "Hpre": Hpre, "nptA": nA, "nptB": nB,
                          "kA": cA.k.mean() if len(cA) else np.nan, "kB": cB.k.mean() if len(cB) else np.nan,
                          "ncA": len(cA), "ncB": len(cB)})
            if kind == "main":
                Hs = H_at(lq, grid(t0, -60, 180))
                for b in range(24):
                    seg = Hs[b * 10:(b + 1) * 10]
                    cs = c[(sec >= -60 + b * 10) & (sec < -50 + b * 10)] if len(c) else c
                    prof.append({"date": D, "hour": hh, "bucket": -60 + b * 10, "H": wmean(seg)[0], "nc": len(cs)})
    return cells, prof


def main(which):
    assert which == "train"
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                 # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [t.strftime("%Y%m%d") for t in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{t.year}/{t.strftime('%Y%m%d')}.csv.gz"))]
    cells, prof = [], []
    with ProcessPoolExecutor(6) as ex:
        for c, p in ex.map(day, days):
            cells += c; prof += p
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(cells).to_parquet(os.path.join(OUT, f"cells_{which}.parquet"))
    pd.DataFrame(prof).to_parquet(os.path.join(OUT, f"profile_{which}.parquet"))
    print(len(days), "days", len(cells), "cells")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "train")
