"""P-0010: short iron fly on next-day-expiry SPXW at D close (16:15 closing NBBO), held to N settle.
TRAINING PERIOD ONLY (entry day D and expiry N both < 2024-11-01). Spec: research/quant_loop/proposals/P-0010.md
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0010_build.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0010_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL
edge = pd.read_parquet(f"{R}/data/clean/edge_panel.parquet")
edge = edge[edge.date < TRAIN_END]                     # TIME WALL
wp = pd.read_parquet(f"{R}/data/clean/winrate_panel.parquet")
wp = wp[wp.date < TRAIN_END]                           # TIME WALL

COMM = [(0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)]
EXCH = [(1.00, 0.36), (np.inf, 0.45)]
SURCH, REG, MINLEG, MULT, LEGCAP = 0.14, 0.04028, 1.00, 100, 2.0


def tier(p, tiers):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


days = list(cal.index)
pairs = [(d, n) for d, n in zip(days[:-1], days[1:]) if n < TRAIN_END]   # TIME WALL on expiry


def one(p):
    d, n = p
    f = f"{R}/data/raw/SPXW/greeks_eod/{d:%Y}/{d:%Y%m%d}.csv.gz"
    if not os.path.exists(f):
        return None
    x = pd.read_csv(f, usecols=["expiration", "strike", "right", "bid", "ask", "underlying_price"])
    x["expiration"] = pd.to_datetime(x.expiration)
    x = x[x.expiration < TRAIN_END]                    # TIME WALL per file
    y = x[x.expiration == n]
    if y.empty:
        return None
    S = float(y.underlying_price.iloc[0])
    c = y[y.right == "CALL"].set_index("strike")
    pu = y[y.right == "PUT"].set_index("strike")
    both = sorted(set(c.index) & set(pu.index))
    ks = sorted(both, key=lambda k: abs(k - S))[:5]
    F = float(np.median([k + (c.loc[k, "bid"] + c.loc[k, "ask"]) / 2 - (pu.loc[k, "bid"] + pu.loc[k, "ask"]) / 2 for k in ks]))
    K = min(both, key=lambda k: (abs(k - F), k))
    I = float((c.loc[K, "bid"] + c.loc[K, "ask"] + pu.loc[K, "bid"] + pu.loc[K, "ask"]) / 2)
    cands = np.arange(10, 1000, 5)
    dd = np.abs(cands - 2 * I)
    w = int(cands[np.where(dd <= dd.min() + 1e-9)[0][0]])
    legs = [("C", K, -1), ("P", K, -1), ("C", K + w, 1), ("P", K - w, 1)]
    out = dict(D=d, N=n, S=S, F=F, K=K, I=I, w=w, atm_spr=float(c.loc[K, "ask"] - c.loc[K, "bid"] + pu.loc[K, "ask"] - pu.loc[K, "bid"]))
    q = []
    for r_, k, s in legs:
        t = c if r_ == "C" else pu
        if k not in t.index:
            out["skip"] = "missing"; return out
        b, a = float(t.loc[k, "bid"]), float(t.loc[k, "ask"])
        if a <= 0 or (s == -1 and b <= 0) or a - b > LEGCAP:
            out["skip"] = "quote"; return out
        q.append((b, a, s))
    for kk, tag in ((0.20, ""), (0.5, "_k05"), (0.0, "_k0")):
        cash = fees = 0.0
        for b, a, s in q:
            px = (b + a) / 2 + s * kk * (a - b) / 2
            cash += s * px * MULT
            fees += max(tier(px, COMM), MINLEG) + tier(px, EXCH) + SURCH + REG
        out["credit" + tag] = -cash
        out["fees" + tag] = fees
    out["skip"] = ""
    return out


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        rows = [r for r in ex.map(one, pairs) if r is not None]
    r = pd.DataFrame(rows)
    r = r[(r.D < TRAIN_END) & (r.N < TRAIN_END)]       # TIME WALL on output
    r["nights"] = (r.N - r.D).dt.days
    r["half"] = r.D.map(cal.half_day).astype(bool) | r.N.map(cal.half_day).astype(bool)
    r["settle"] = r.N.map(cal.settle)
    ev = cal.fomc | cal.cpi | cal.nfp
    r["evN"] = r.N.map(ev).astype(bool)
    e0 = edge[edge.entry == "09:35"].set_index("date")
    r["S0"] = r.N.map(e0.spot); r["I0"] = r.N.map(e0.implied); r["x_day"] = r.N.map(e0.ratio)
    owed = np.minimum((r.settle - r.K).abs(), r.w)
    for tag in ("", "_k05", "_k0"):
        r["pnl" + tag] = r["credit" + tag] - owed * MULT - r["fees" + tag]
    # benchmark A on N: 14:00 put fly, width with w/implied closest to 2, skip prev <= -1%
    b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
    b["d2"] = (b.w_over_implied - 2).abs()
    b = b.sort_values(["date", "d2", "width"]).groupby("date").head(1).set_index("date")
    skip = cal.spx_ret_prev <= -0.01
    r["bench"] = [b.pnl.get(n, np.nan) if not skip.get(n, False) else np.nan for n in r.N]
    r.to_csv(f"{OUT}/nights.csv", index=False)
    print(len(r), r.skip.value_counts().to_dict())
