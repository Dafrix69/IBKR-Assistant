"""V-0017 build (independent rewrite; train only): near-ATM 0DTE iron-fly / 1:2:1-fly combo prints with
several references for post-trade markouts.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0017_build.py
Output: V-0017_tables/prints.parquet, qage.parquet

Pi = short-gamma package value in points: iron g = (+1,-1,-1,+1) on (K-w P, K P, K C, K+w C); fly g = (+1,-2,+1).
References stored per print:
  own      : sum g * mid of the NBBO attached to the combo's own leg rows (first row per leg in the ms)
  ch_m1, ch_0, ch_1, ch_5, ch_15, ch_6, ch_16 : chain mid at floor(t) + k minutes
  prior    : sum g * mid of the last NBBO attached to ANY print of that leg strictly before the combo ms (asof),
             plus its max age in seconds
  end5o/end15o : same asof own-tape NBBO at t + 5 / 15 minutes (last print at or before)
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0017_tables")
WALL = pd.Timestamp("2025-11-01")          # A-tape time wall
START = pd.Timestamp("2024-10-30")
ML = (130, 131, 134, 137, 144)
COLS = ["strike", "right", "trade_timestamp", "quote_timestamp", "condition", "size", "price", "bid", "ask"]
OFFS = (-1, 0, 1, 5, 6, 15, 16)


def one_day(D):
    assert D < WALL
    f = os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{D.year}/{D:%Y%m%d}.csv.gz")
    t = pd.read_csv(f, usecols=COLS)
    t["trade_timestamp"] = pd.to_datetime(t.trade_timestamp)
    t = t[t.trade_timestamp < WALL]                               # time wall, first step
    if t.empty:
        return None
    t["quote_timestamp"] = pd.to_datetime(t.quote_timestamp)
    t["r"] = t.right.str[0]
    # asof book per leg from all prints
    t = t.sort_values("trade_timestamp", kind="stable")
    book = {k: (g.trade_timestamp.values, g.quote_timestamp.values, g.bid.values, g.ask.values)
            for k, g in t.groupby(["strike", "r"], sort=False)}
    m = t[t.condition.isin(ML)]
    hm = m.trade_timestamp.dt.hour * 60 + m.trade_timestamp.dt.minute
    m = m[(hm >= 585) & (hm < 930)]
    qage = (m.trade_timestamp - m.quote_timestamp).dt.total_seconds().values

    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{D:%Y%m%d}.parquet"),
                         columns=["strike", "right", "ts", "bid", "mid", "flag_bad"])
    ch = ch[ch.ts < WALL]
    ch = ch[(~ch.flag_bad) & (ch.bid > 0)]
    cmid = dict(zip(zip(ch.ts.values, ch.strike.values, ch.right.values), ch.mid.values))
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[(sp.ts < WALL) & (sp.ts.dt.normalize() == D)]
    spot = dict(zip(sp.ts.values, sp.spot.values))

    # aggregate same ms, same leg
    m = m.assign(pq=m.price * m["size"])
    a = m.groupby(["trade_timestamp", "strike", "r"], sort=True).agg(
        q=("size", "sum"), pq=("pq", "sum"), bid=("bid", "first"), ask=("ask", "first")).reset_index()
    a["px"] = a.pq / a.q
    rows = []
    for ts, g in a.groupby("trade_timestamp", sort=True):
        n = len(g)
        if n not in (3, 4):
            continue
        L = {(s, r): (q, p, b, k) for s, r, q, p, b, k in zip(g.strike, g.r, g.q, g.px, g.bid, g.ask)}
        ks = sorted({s for s, _ in L})
        if len(ks) != 3 or ks[2] - ks[1] != ks[1] - ks[0]:
            continue
        w = ks[1] - ks[0]
        if n == 4:
            keys = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
            if set(keys) != set(L) or len({L[x][0] for x in keys}) != 1:
                continue
            gv = np.array([1.0, -1.0, -1.0, 1.0]); struct = "iron"; lots = L[keys[0]][0]
        else:
            rs = {r for _, r in L}
            if len(rs) != 1:
                continue
            r0 = rs.pop(); keys = [(k, r0) for k in ks]
            q = [L[x][0] for x in keys]
            if not (q[0] == q[2] and q[1] == 2 * q[0]):
                continue
            gv = np.array([1.0, -2.0, 1.0]); struct = "fly_" + r0; lots = q[0]
        px = np.array([L[x][1] for x in keys]); bd = np.array([L[x][2] for x in keys]); ak = np.array([L[x][3] for x in keys])
        if (bd <= 0).any() or (ak <= bd).any():
            continue
        fl = ts.floor("min")
        S = spot.get(fl.to_datetime64(), np.nan)
        if not (abs(ks[1] - S) <= 5 and 15 <= w < 80):
            continue
        rec = {"date": D, "ts": ts, "struct": struct, "K": ks[1], "w": w, "lots": int(lots),
               "trade": float(gv @ px), "own": float(gv @ ((bd + ak) / 2)), "H": float(np.abs(gv) @ ((ak - bd) / 2)),
               "u": (ts - fl).total_seconds() / 60.0}
        for o in OFFS:
            mm = (fl + pd.Timedelta(minutes=o)).to_datetime64()
            v = 0.0
            for (s, r), gi in zip(keys, gv):
                x = cmid.get((mm, s, r))
                if x is None:
                    v = np.nan; break
                v += gi * x
            rec[f"ch_{o}"] = v
        # asof references from the tape
        t64 = ts.to_datetime64()
        for lab, tq, strict in (("prior", t64, True), ("end5o", t64 + np.timedelta64(5, "m"), False),
                                ("end15o", t64 + np.timedelta64(15, "m"), False)):
            v, age = 0.0, 0.0
            for (s, r), gi in zip(keys, gv):
                tt, qt, bb, aa = book[(s, r)]
                i = np.searchsorted(tt, tq, "left" if strict else "right") - 1
                if i < 0 or not (aa[i] > bb[i] > 0):
                    v = np.nan; break
                v += gi * 0.5 * (aa[i] + bb[i])
                age = max(age, (tq - qt[i]) / np.timedelta64(1, "s"))
            rec[lab] = v
            rec[lab + "_age"] = age if np.isfinite(v) else np.nan
        rows.append(rec)
    return pd.DataFrame(rows), qage


def main():
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < WALL]                                   # time wall
    cal = cal[(cal.index >= START) & cal.has_0dte & ~cal.half_day]
    days = [d for d in cal.index
            if os.path.exists(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz"))]
    out, qa = [], []
    with ProcessPoolExecutor(8) as ex:
        for res in ex.map(one_day, days, chunksize=2):
            if res is None:
                continue
            out.append(res[0]); qa.append(res[1])
    os.makedirs(OUT, exist_ok=True)
    p = pd.concat(out, ignore_index=True)
    p.to_parquet(os.path.join(OUT, "prints.parquet"))
    q = np.concatenate(qa)
    pd.DataFrame({"qage": q}).to_parquet(os.path.join(OUT, "qage.parquet"))
    print(len(days), "days", len(p), "prints", p.struct.value_counts().to_dict())


if __name__ == "__main__":
    main()
