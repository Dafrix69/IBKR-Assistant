"""P-0013 review, checklist item 7: recompute G_a for the 5 largest-contribution test days and 5 random
test days straight from the raw ThetaData 1-minute quote files (not the cleaned chain, not validator code)
and compare with the validator's per-day table.

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0013_spotcheck.py
"""
import gzip, os, csv, glob
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
V = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0013_tables"
WID = [20, 25, 30, 50, 75]
K_FILL = 0.20


def leg_fee(px, q):                      # config.yaml fills + commission_min_per_leg
    comm = 0.25 if px < 0.05 else 0.50 if px < 0.10 else 0.65
    exch = 0.36 if px < 1.0 else 0.45
    return max(comm * q, 1.00) + q * (exch + 0.14 + 0.04028)


def raw_quotes(date):
    p = f"{R}/data/raw/SPXW/quote_1m_dte0/{date:%Y}/{date:%Y%m%d}.csv.gz"
    want = f"{date:%Y-%m-%d}T14:00:00.000"
    Q = {}
    with gzip.open(p, "rt") as f:
        rd = csv.DictReader(f)
        for r in rd:
            if r["timestamp"] != want:
                continue
            b, a = float(r["bid"]), float(r["ask"])
            Q[(float(r["strike"]), r["right"][0])] = (b, a)
    return Q


def bad(b, a):                           # load_clean.flag_quotes with config quote_filters
    if b == 0 and a == 0: return True
    if b > 0 and a > 0 and b > a: return True
    if b == 0 and a > 1.00: return True
    if b > 0 and a > 0 and (a - b) > 1.0 * 0.5 * (a + b): return True
    return False


def spot_1400(date):
    """spot known at 14:00 = close of the 13:59 TWS bar, read from the raw TWS bar files."""
    for p in sorted(glob.glob(f"{R}/data/tws/spx_1m/*.parquet")):
        if pd.Timestamp(os.path.basename(p)[:8]) >= date:
            b = pd.read_parquet(p)
            t = b.ts.dt.tz_localize(None) if b.ts.dt.tz is not None else b.ts
            m = b[t == pd.Timestamp(f"{date:%Y-%m-%d} 13:59")]
            if len(m):
                return float(m.close.iloc[0])
    return np.nan


def one(date):
    Q = {k: v for k, v in raw_quotes(date).items() if not bad(*v) and v[1] > v[0] and v[0] >= 0}
    S = spot_1400(date)
    st = np.array(sorted({k for k, _ in Q}))
    K = float(st[np.argmin(np.abs(st - S))])
    I = sum(0.5 * sum(Q[(K, r)]) for r in "CP")
    w = sorted(WID, key=lambda x: (round(abs(x / I - 2), 9), x))[0]
    put = [(K - w, "P", 1, 1), (K, "P", -1, 2), (K + w, "P", 1, 1)]
    iron = [(K - w, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + w, "C", 1, 1)]
    res = {}
    for name, legs in (("put", put), ("iron", iron)):
        H = fe = 0.0
        for s, r, sd, q in legs:
            b, a = Q[(s, r)]
            m, h = 0.5 * (a + b), 0.5 * (a - b)
            H += q * h
            fe += leg_fee(m + sd * K_FILL * h, q)
        res[name] = (H, fe, 100 * K_FILL * H + fe)
    maxsp = max(Q[(K + o * w, r)][1] - Q[(K + o * w, r)][0] for o in (-1, 0, 1) for r in "CP")
    return dict(S=S, K=K, w=w, maxsp=maxsp, H_put=res["put"][0], H_iron=res["iron"][0],
                fee_put=res["put"][1], fee_iron=res["iron"][1], G=res["put"][2] - res["iron"][2], Q=Q)


d = pd.read_csv(f"{V}/daily_test.csv", parse_dates=["date"])
top = d.sort_values("G20", ascending=False).head(5)
rnd = d.drop(top.index).sample(5, random_state=20261110)
print("validator test rows", len(d), "mean G20", round(d.G20.mean(), 3), "| top-5 share of total", round(top.G20.sum() / d.G20.sum(), 4))
worst = 0.0
for tag, sub in (("top5", top), ("random5", rnd)):
    for _, r in sub.iterrows():
        m = one(r.date)
        diff = m["G"] - r.G20
        worst = max(worst, abs(diff))
        Q, K, w = m["Q"], m["K"], m["w"]
        legs = " ".join(f"{int(s)}{rt} {Q[(s, rt)][0]:.2f}/{Q[(s, rt)][1]:.2f}" for s, rt in
                        [(K - w, "P"), (K, "P"), (K + w, "P"), (K, "C"), (K + w, "C")])
        print(f"{tag:8s} {r.date:%Y-%m-%d} S {m['S']:.2f} (val {r.S:.2f}) K {K:.0f}/{r.K:.0f} w {w}/{int(r.w)} maxsp {m['maxsp']:.2f} "
              f"H put {m['H_put']:.3f} iron {m['H_iron']:.3f} fee {m['fee_put']:.2f}/{m['fee_iron']:.2f} "
              f"G mine {m['G']:+.3f} validator {r.G20:+.3f} diff {diff:+.4f}\n          legs {legs}")
print("max |diff| USD:", round(worst, 6))
