"""V-0011 report item: P-0010-definition short 1DTE SPXW iron fly at D close (greeks_eod NBBO, centre on parity F,
wing nearest 2xI), held to N settle, for nights where N is post-non-trading (gap >= 2). TEST PERIOD (N >= 2024-11-01
and D >= 2024-11-01), run once, report only. Own code (copied from V-0010_audit.night), no proposer import.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0011_friday.py
"""
import os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0011_tables")
WALL = pd.Timestamp("2024-11-01")
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
fills = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]


def fee_leg(px):
    com = next(t["fee"] for t in fills["commission"] if px < float(t["below"]))
    exc = next(t["fee"] for t in fills["exchange"] if px < float(t["below"]))
    return max(com, fills["commission_min_per_leg"]) + exc + fills["execution_surcharge"] + fills["regulatory_clearing"]


td = list(cal.index)
PAIRS = [(td[i], td[i + 1]) for i in range(len(td) - 1) if td[i] >= WALL]


def night(p):
    D, N = p
    f = f"{R}/data/raw/SPXW/greeks_eod/{D:%Y}/{D:%Y%m%d}.csv.gz"
    if not os.path.exists(f):
        return dict(D=D, N=N, why="nofile")
    q = pd.read_csv(f, usecols=["expiration", "strike", "right", "bid", "ask", "underlying_price"])
    q = q[pd.to_datetime(q.expiration) == N]
    if q.empty:
        return dict(D=D, N=N, why="noexp")
    q["m"] = (q.bid + q.ask) / 2
    C = q[q.right == "CALL"].set_index("strike"); Pt = q[q.right == "PUT"].set_index("strike")
    ks = np.array(sorted(set(C.index) & set(Pt.index)))
    U = float(q.underlying_price.iloc[0])
    near = ks[np.argsort(np.abs(ks - U), kind="stable")[:5]]
    F = float(np.median([k + C.at[k, "m"] - Pt.at[k, "m"] for k in near]))
    d = np.abs(ks - F); K = float(ks[np.where(d <= d.min() + 1e-9)[0][0]])
    I = float(C.at[K, "m"] + Pt.at[K, "m"])
    grid = np.arange(10, 2000, 5); g = np.abs(grid - 2 * I); w = int(grid[np.where(g <= g.min() + 1e-9)[0][0]])
    o = dict(D=D, N=N, why="", F=F, K=K, I=I, w=w)
    qs = []
    for t, k, s in [(C, K, -1), (Pt, K, -1), (C, K + w, +1), (Pt, K - w, +1)]:
        if k not in t.index:
            o["why"] = "missing"; return o
        b, a = float(t.at[k, "bid"]), float(t.at[k, "ask"])
        if a <= 0 or (s < 0 and b <= 0) or a - b > 2.0:
            o["why"] = "quote"; return o
        qs.append((b, a, s))
    for kk in (0.0, 0.2, 0.5):
        o[f"cr{kk}"] = sum(-s * ((b + a) / 2 + s * kk * (a - b) / 2) for b, a, s in qs) * 100
        o[f"fee{kk}"] = sum(fee_leg((b + a) / 2 + s * kk * (a - b) / 2) for b, a, s in qs)
    return o


if __name__ == "__main__":
    with ProcessPoolExecutor(6) as ex:
        n = pd.DataFrame([r for r in ex.map(night, PAIRS, chunksize=8)])
    n["gap"] = (n.N - n.D).dt.days
    n["half"] = n.D.map(cal.half_day).astype(bool) | n.N.map(cal.half_day).astype(bool)
    n["settle"] = n.N.map(cal.settle)
    r = n[(n.why == "") & ~n.half].copy()
    owed = np.minimum((r.settle - r.K).abs(), r.w)
    for kk in (0.0, 0.2, 0.5):
        r[f"pnl{kk}"] = r[f"cr{kk}"] - 100 * owed - r[f"fee{kk}"]
    r["x"] = (r.settle - r.F).abs() / r.I
    r.to_csv(f"{OUT}/friday_test.csv", index=False)
    rng = np.random.default_rng(5)
    def boot(v):
        v = np.asarray(v, float); m = v[rng.integers(0, len(v), (10000, len(v)))].mean(1)
        return round(v.mean(), 1), round(np.percentile(m, 2.5), 1), round(np.percentile(m, 97.5), 1)
    lines = [f"pairs {len(n)} reasons {n.why.value_counts().to_dict()} half {int(n.half.sum())}; usable {len(r)}"]
    for nm, g in (("PNT nights (gap>=2)", r[r.gap >= 2]), ("1-night", r[r.gap == 1]), ("all", r)):
        lines.append(f"{nm}: n {len(g)} pnl k0.20 {boot(g['pnl0.2'])} k0 {g['pnl0.0'].mean():+.1f} k0.5 {g['pnl0.5'].mean():+.1f} "
                     f"win {(g['pnl0.2']>0).mean():.3f} x {g.x.mean():.3f}")
    for y, g in r[r.gap >= 2].groupby(r.N.dt.year):
        lines.append(f"  PNT nights N year {y}: n {len(g)} pnl {g['pnl0.2'].mean():+.1f} x {g.x.mean():.3f}")
    print("\n".join(lines)); open(f"{OUT}/friday_test.txt", "w").write("\n".join(lines) + "\n")
