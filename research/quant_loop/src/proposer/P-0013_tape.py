"""P-0013 mechanism probe on the tape: reconstruct exchange-printed fly / iron-fly combos from
multi-leg prints (conditions 130/131/134/137/144), measure |combo price - leg-mid sum| in points.
Training period only: the tape starts 2024-10-30, so only 2024-10-30 and 2024-10-31 are < 2024-11-01.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0013_tape.py [YYYYMMDD ...]
"""
import glob
import os
import sys
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
SPLIT = pd.Timestamp("2024-11-01")
ML = [130, 131, 134, 137, 144]


def combos(path):
    d = pd.read_csv(path, usecols=["strike", "right", "trade_timestamp", "sequence", "condition", "size", "price", "bid", "ask"])
    d["trade_timestamp"] = pd.to_datetime(d.trade_timestamp)
    d = d[d.trade_timestamp < SPLIT]                          # time wall
    d = d[d.condition.isin(ML) & (d.ask > d.bid) & (d.bid > 0)].sort_values("sequence")
    d["r"] = d.right.str[0]
    d["mid"] = (d.bid + d.ask) / 2
    d["h"] = (d.ask - d.bid) / 2
    # a combo = same timestamp, consecutive sequence numbers (gap <= 10)
    new = (d.trade_timestamp != d.trade_timestamp.shift()) | (d.sequence - d.sequence.shift() > 10)
    d["cid"] = new.cumsum()
    out = []
    for cid, g in d.groupby("cid"):
        if len(g) not in (3, 4) or g.groupby(["strike", "r"]).size().max() > 1:
            continue
        legs = {(s, r): (q, p, m, h) for s, r, q, p, m, h in zip(g.strike, g.r, g["size"], g.price, g.mid, g.h)}
        ks = sorted({s for s, _ in legs})
        rs = {r for _, r in legs}
        if len(g) == 3 and len(rs) == 1 and len(ks) == 3 and ks[1] - ks[0] == ks[2] - ks[1]:
            r = rs.pop()
            q = [legs[(k, r)][0] for k in ks]
            if not (q[1] == 2 * q[0] == 2 * q[2]):
                continue
            w = ks[1] - ks[0]
            sg, qq = np.array([1, -1, 1]), np.array([1, 2, 1])
            L = [legs[(k, r)] for k in ks]
            name = "put" if r == "P" else "call"
        elif len(g) == 4 and len(ks) == 3 and ks[1] - ks[0] == ks[2] - ks[1]:
            w = ks[1] - ks[0]
            need = [(ks[0], "P"), (ks[1], "P"), (ks[1], "C"), (ks[2], "C")]
            if set(need) != set(legs) or len({legs[x][0] for x in need}) != 1:
                continue
            sg, qq = np.array([1, -1, -1, 1]), np.array([1, 1, 1, 1])
            L = [legs[x] for x in need]
            name = "iron"
        else:
            continue
        px = np.array([x[1] for x in L]); mid = np.array([x[2] for x in L]); h = np.array([x[3] for x in L])
        s = float((sg * qq * (px - mid)).sum())              # paid - mid in long-fly debit terms (iron: sign flips, |.| same)
        net = float((sg * qq * px).sum()) + (w if name == "iron" else 0.0)   # long-fly debit, points
        out.append({"ts": g.trade_timestamp.iloc[0], "struct": name, "K": ks[1], "w": w, "lots": L[0][0], "net": net,
                    "abs_slip": abs(s), "H": float((qq * h).sum()), "k_abs": abs(s) / float((qq * h).sum())})
    return pd.DataFrame(out)


def add_common_ref(c, day):
    """Common reference for every structure: w - iron credit from the chain mids of P(K-w), P(K), C(K), C(K+w)
    at floor(ts, minute). The payoff identity makes it the fair long-fly debit for put, call and iron alike,
    without any deep-ITM leg in it."""
    ch = pd.read_parquet(os.path.join(R, f"data/clean/chain_{day}.parquet"), columns=["strike", "right", "ts", "mid", "flag_bad"])
    ch = ch[ch.ts < SPLIT]                                     # time wall
    ch = ch[~ch.flag_bad].set_index(["ts", "strike", "right"]).mid
    ref = []
    for t, K, w in zip(c.ts.dt.floor("min"), c.K, c.w):
        try:
            ref.append(w + ch[(t, K - w, "P")] - ch[(t, K, "P")] - ch[(t, K, "C")] + ch[(t, K + w, "C")])
        except KeyError:
            ref.append(np.nan)
    c = c.copy()
    c["ref"] = ref
    c["abs_slip_common"] = (c.net - c.ref).abs()
    return c


def near_atm(c):
    """Keep combos centred within 5 points of the minute spot (spot.parquet at floor(ts, minute))."""
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"), columns=["ts", "spot"])
    sp = sp[sp.ts < SPLIT].set_index("ts").spot                # time wall
    c = c.copy()
    c["S"] = c.ts.dt.floor("min").map(sp)
    return c[(c.K - c.S).abs() <= 5]


def main(days):
    days = [x for x in days if pd.Timestamp(x) < SPLIT]       # time wall
    parts = []
    for x in days:
        c = combos(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{x[:4]}/{x}.csv.gz"))
        c = near_atm(c)
        c = c[c.w >= 15]
        parts.append(add_common_ref(c, x))
    c = pd.concat(parts).dropna(subset=["ref"])
    print("near ATM (|K-S|<=5), w>=15, common reference available:")
    print(c.groupby("struct").agg(n=("H", "size"), w=("w", "median"), Hmean=("H", "mean"),
                                  own_mean=("abs_slip", "mean"), own_med=("abs_slip", "median"),
                                  common_mean=("abs_slip_common", "mean"), common_med=("abs_slip_common", "median"),
                                  signed_common=("net", lambda v: np.nan)).drop(columns="signed_common").round(3))
    fl, ir = c[c.struct != "iron"], c[c.struct == "iron"]
    print(f"M own-leg ratio  = {fl.abs_slip.mean() / ir.abs_slip.mean():.2f}")
    print(f"M common-ref ratio = {fl.abs_slip_common.mean() / ir.abs_slip_common.mean():.2f}")
    for lo, hi in ((15, 30), (30, 80)):
        a, b = fl[(fl.w >= lo) & (fl.w < hi)], ir[(ir.w >= lo) & (ir.w < hi)]
        print(f"  w [{lo},{hi}): flies n={len(a)} common {a.abs_slip_common.mean():.3f}  iron n={len(b)} common {b.abs_slip_common.mean():.3f}"
              f"  ratio {a.abs_slip_common.mean() / b.abs_slip_common.mean():.2f}")
    return c


if __name__ == "__main__":
    main(sys.argv[1:] or ["20241030", "20241031"])
