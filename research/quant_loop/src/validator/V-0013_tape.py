"""V-0013 tape side: reconstruct exchange-printed put fly / call fly / iron fly combos from SPXW 0DTE
multi-leg prints and measure their price against three references. Independent rewrite.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0013_tape.py train|test
Output: V-0013_tables/tape_<period>.parquet (one row per combo, both rules tagged).
"""
import glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0013_tables")
SPLIT = pd.Timestamp("2024-11-01")
ML = {130, 131, 134, 137, 144}
COLS = ["strike", "right", "trade_timestamp", "sequence", "condition", "size", "price", "bid", "ask"]
PERIOD = None
SPOT = None


def classify(legs):
    """legs: dict (strike, r) -> (size, price, bid, ask). Return (struct, K, w, sign, ratio, keys) or None."""
    ks = sorted({k for k, _ in legs}); rs = {r for _, r in legs}
    if len(ks) != 3 or ks[1] - ks[0] != ks[2] - ks[1]:
        return None
    w = ks[1] - ks[0]
    if len(legs) == 3 and len(rs) == 1:
        r = next(iter(rs)); keys = [(k, r) for k in ks]
        q = [legs[x][0] for x in keys]
        if q[1] != 2 * q[0] or q[0] != q[2]:
            return None
        return ("put" if r == "P" else "call"), ks[1], w, np.array([1, -1, 1]), np.array([1, 2, 1]), keys, q[0]
    if len(legs) == 4:
        keys = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
        if set(keys) != set(legs) or len({legs[x][0] for x in keys}) != 1:
            return None
        return "iron", ks[1], w, np.array([1, -1, -1, 1]), np.array([1, 1, 1, 1]), keys, legs[keys[0]][0]
    return None


def day(path):
    date = pd.Timestamp(os.path.basename(path)[:8])
    d = pd.read_csv(path, usecols=COLS)
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT] if PERIOD == "train" else d[d.trade_timestamp >= SPLIT]   # time wall
    if d.empty:
        return []
    d["r"] = d.right.str[0]
    d = d.sort_values("sequence")
    # last-print NBBO per option for the asof reference (all conditions)
    book = {k: (g.trade_timestamp.values, g.bid.values, g.ask.values)
            for k, g in d[["strike", "r", "trade_timestamp", "bid", "ask"]].sort_values("trade_timestamp").groupby(["strike", "r"])}
    m = d[d.condition.isin(ML)].copy()
    new = (m.trade_timestamp != m.trade_timestamp.shift()) | (m.sequence - m.sequence.shift() > 10)
    m["blk"] = new.cumsum()
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{date:%Y%m%d}.parquet"), columns=["strike", "right", "ts", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT] if PERIOD == "train" else ch[ch.ts >= SPLIT]
    chm = ch[~ch.flag_bad].set_index(["ts", "strike", "right"]).mid.to_dict()
    sp = SPOT.get(date, {})
    out = []
    for _, g in m.groupby("blk", sort=False):
        if len(g) < 3 or len(g) > 40:
            continue
        ts = g.trade_timestamp.iloc[0]
        dup = g.duplicated(["strike", "r"]).any()
        # rule V: aggregate by option
        agg = {}
        for s, r, q, p, b, a in zip(g.strike, g.r, g["size"], g.price, g.bid, g.ask):
            if (s, r) in agg:
                Q, PQ, B, A = agg[(s, r)]
                agg[(s, r)] = (Q + q, PQ + p * q, B, A)
            else:
                agg[(s, r)] = (q, p * q, b, a)
        legs = {k: (v[0], v[1] / v[0], v[2], v[3]) for k, v in agg.items()}
        c = classify(legs)
        if c is None:
            continue
        st, K, w, sg, qq, keys, lots = c
        L = [legs[x] for x in keys]
        bid = np.array([x[2] for x in L]); ask = np.array([x[3] for x in L]); px = np.array([x[1] for x in L])
        if not ((ask > bid).all() and (bid > 0).all()):
            continue
        mid, h = 0.5 * (ask + bid), 0.5 * (ask - bid)
        net = float((sg * qq * px).sum()) + (w if st == "iron" else 0.0)
        own = float((sg * qq * mid).sum()) + (w if st == "iron" else 0.0)
        H = float((qq * h).sum())
        tmin = ts.floor("min")
        ck = [(tmin, K - w, "P"), (tmin, K, "P"), (tmin, K, "C"), (tmin, K + w, "C")]
        common = w + chm[ck[0]] - chm[ck[1]] - chm[ck[2]] + chm[ck[3]] if all(x in chm for x in ck) else np.nan
        asof, stale = np.nan, np.nan
        ik = [(K - w, "P", 1), (K, "P", -1), (K, "C", -1), (K + w, "C", 1)]
        vals, st_ = [], []
        for s, r, sgn in ik:
            if (s, r) not in book:
                break
            tt, bb, aa = book[(s, r)]
            i = np.searchsorted(tt, ts.to_datetime64(), "left") - 1
            if i < 0 or not (aa[i] > bb[i]):
                break
            vals.append(sgn * 0.5 * (aa[i] + bb[i])); st_.append((ts.to_datetime64() - tt[i]) / np.timedelta64(1, "s"))
        if len(vals) == 4:
            asof, stale = w + sum(vals), max(st_)
        out.append({"date": date, "ts": ts, "struct": st, "K": K, "w": w, "lots": lots, "S": sp.get(tmin, np.nan),
                    "net": net, "own": own, "H": H, "common": common, "asof": asof, "stale": stale,
                    "dup": dup, "nrows": len(g), "maxleg_h": float(h.max())})
    return out


def init(period, spot):
    global PERIOD, SPOT
    PERIOD, SPOT = period, spot


def main(period):
    files = sorted(glob.glob(os.path.join(R, "data/raw/SPXW/trade_quote_dte0/*/*.csv.gz")))
    files = [f for f in files if (pd.Timestamp(os.path.basename(f)[:8]) < SPLIT) == (period == "train")]   # time wall
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[sp.ts < SPLIT] if period == "train" else sp[sp.ts >= SPLIT]
    spot = {d: dict(zip(g.ts, g.spot)) for d, g in sp.groupby(sp.ts.dt.normalize())}
    rows = []
    with ProcessPoolExecutor(6, initializer=init, initargs=(period, spot)) as ex:
        for r in ex.map(day, files, chunksize=1):
            rows += r
    df = pd.DataFrame(rows)
    df.to_parquet(os.path.join(OUT, f"tape_{period}.parquet"))
    print(period, len(files), "files", len(df), "combos")


if __name__ == "__main__":
    main(sys.argv[1])
