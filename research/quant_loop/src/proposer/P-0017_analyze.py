"""P-0017 analyze: bucket-hedged signed markouts I_tau (spec 3.3), permutation null (3.4), report cells (3.5).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0017_analyze.py train
"""
import os
import sys
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0017_tables"
SPLIT = pd.Timestamp("2025-11-01")
SEG2 = pd.Timestamp("2025-05-01")
rng = np.random.default_rng(20261101)
TR = 0.10
NB = 10000
NPERM = 200


def load(which):
    p = pd.read_parquet(os.path.join(T, f"prints_{which}.parquet"))
    p = p[p.date < SPLIT]                                        # time wall (first step after reading)
    cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
    cal = cal[cal.index < SPLIT]                                 # time wall
    p["base_day"] = p.date.map(cal.spx_ret_prev) > -0.01
    p["fomc"] = p.date.map(cal.fomc).fillna(False).astype(bool)
    p["dev"] = p.pi_trade - p.pi0
    return p


def sign(p, thr=0.05):
    s = np.where(p.dev >= thr - 1e-9, 1, np.where(p.dev <= -thr + 1e-9, -1, 0))
    if thr == 0:
        s = np.where(p.dev > 1e-9, 1, np.where(p.dev < -1e-9, -1, 0))
    return s


def day_values(p, y, s, wcol=None):
    """I_d per day from bucket-hedged differences. y = markout in points (NaN allowed); s = +-1."""
    q = pd.DataFrame({"date": p.date.values, "b": p.bkey.values, "y": y, "s": s,
                      "wt": (p[wcol].values if wcol else 1.0)})
    q = q[(q.s != 0) & np.isfinite(q.y)]
    q["yw"] = q.y * q.wt
    g = q.groupby(["date", "b", "s"]).agg(yw=("yw", "sum"), wt=("wt", "sum"), n=("y", "size"))
    g["m"] = g.yw / g.wt
    u = g.m.unstack("s"); n = g.n.unstack("s")
    ok = u[1].notna() & u[-1].notna()
    u, n = u[ok], n[ok]
    Ib = 0.5 * (u[1] - u[-1]) * 100
    wb = 2 * n[1] * n[-1] / (n[1] + n[-1])
    df = pd.DataFrame({"I": Ib, "w": wb}).reset_index()
    dv = df.groupby("date").apply(lambda x: np.average(x.I, weights=x.w), include_groups=False)
    return dv


def tm(x):
    return trim_mean(np.asarray(x), TR) if len(x) else np.nan


def boot(x, f=tm):
    x = np.asarray(x)
    i = rng.integers(0, len(x), (NB, len(x)))
    b = np.array([f(x[r]) for r in i])
    return np.percentile(b, [2.5, 97.5])


def summ(dv, label, ci=True):
    lo, hi = boot(dv.values) if ci else (np.nan, np.nan)
    s1 = dv[dv.index < SEG2]; s2 = dv[dv.index >= SEG2]
    print(f"{label:<44s} n={len(dv):4d} trim={tm(dv):+7.3f} [{lo:+7.3f},{hi:+7.3f}] "
          f"med={np.median(dv):+7.3f} mean={dv.mean():+7.3f} seg1={tm(s1):+7.3f} seg2={tm(s2):+7.3f}")
    return tm(dv)


def perm_null(p, y, s):
    """Shuffle s within bucket (date, bkey) keeping counts; recompute trimmed mean of day values."""
    q = pd.DataFrame({"g": (p.date.astype(str) + "|" + p.bkey).values, "y": y, "s": s})
    q = q[(q.s != 0) & np.isfinite(q.y)].reset_index(drop=True)
    sub = p.loc[p.index[(s != 0) & np.isfinite(y)]].reset_index(drop=True)
    codes, _ = pd.factorize(q.g)
    order = np.argsort(codes, kind="stable")
    out = []
    sv = q.s.values.copy()
    for _ in range(NPERM):
        order2 = np.lexsort((rng.random(len(codes)), codes))
        sp = sv.copy()
        sp[order] = sv[order2]
        out.append(tm(day_values(sub, q.y.values, sp)))
    return np.array(out)


def main(which):
    p = load(which)
    p["bkey"] = p.struct + "|" + p.K.astype(str) + "|" + p.w.astype(str) + "|" + p.win.astype(str)
    s = sign(p)
    print(f"prints {len(p)}  days {p.date.nunique()}  struct {p.struct.value_counts().to_dict()}")
    print(f"signed (|dev|>=0.05): {np.mean(s != 0):.3f}  s=+1 {np.mean(s == 1):.3f}  s=-1 {np.mean(s == -1):.3f}  "
          f"exact-mid {np.mean(np.abs(p.dev) < 1e-9):.3f}")
    sg = s != 0
    E = (s * p.dev * 100)[sg]
    print(f"E (signed, USD) mean {E.mean():.2f} median {np.median(E):.2f}; H mean {p.H.mean():.3f} pts; "
          f"0.20*H*100 = {20 * p.H.mean():.2f}")
    print()
    print("== judged cells (day-level 10% trimmed mean, USD/combo, day bootstrap) ==")
    res = {}
    for tau in (1, 5, 15):
        y = (p[f"pi_{tau}"] - p.pi0).values
        res[tau] = summ(day_values(p, y, s), f"I_{tau}")
    y5 = (p.pi_5 - p.pi0).values
    null = perm_null(p, y5, s)
    print(f"perm null I_5 (n={NPERM}): mean {null.mean():+.3f} p2.5 {np.percentile(null, 2.5):+.3f} "
          f"p97.5 {np.percentile(null, 97.5):+.3f}  real {res[5]:+.3f}  frac>=real {np.mean(null >= res[5]):.3f}")
    print()
    print("== report only ==")
    Hm = p.H.mean()
    print(f"I_5 / (0.20*H*100) = {res[5] / (20 * Hm):.3f};  I_5 / E_mean = {res[5] / E.mean():.3f}")
    for tau in (1, 5, 15):
        y = (p[f"pi_{tau}"] - p.pi_ch0).values
        summ(day_values(p, y, s), f"I'_{tau} (start = chain floor(t))", ci=False)
    summ(day_values(p, y5, sign(p, 0)), "I_5 sign threshold >0", ci=False)
    summ(day_values(p, y5, s, "size"), "I_5 size-weighted", ci=False)
    for st in ("iron", "fly"):
        m = p.struct.str.startswith(st).values
        summ(day_values(p[m], y5[m], s[m]), f"I_5 struct={st}", ci=False)
    tmin = p.ts.dt.hour * 60 + p.ts.dt.minute
    for lab, lo, hi in (("09:45-12:00", 585, 720), ("12:00-14:00", 720, 840), ("14:00-15:30", 840, 930)):
        m = ((tmin >= lo) & (tmin < hi)).values
        summ(day_values(p[m], y5[m], s[m]), f"I_5 {lab}", ci=False)
    m = p.base_day.values
    summ(day_values(p[m], y5[m], s[m]), "I_5 base-A days", ci=False)
    m = ~((p.date >= "2025-04-03") & (p.date <= "2025-04-11")).values
    summ(day_values(p[m], y5[m], s[m]), "I_5 excl 2025-04-03..04-11", ci=False)
    m = p.fomc.values
    if m.sum():
        summ(day_values(p[m], y5[m], s[m]), "I_5 FOMC days only", ci=False)
    # side-specific vs time-weighted chain baseline (start reference differs; report only)
    for tau in (5, 15):
        r = (p[f"pi_{tau}"] - p.pi0 - p[f"beta_{tau}"]).values * 100
        ok = np.isfinite(r)
        dp = pd.Series(r[ok & (s == 1)]).groupby(p.date.values[ok & (s == 1)]).mean()
        dm = pd.Series(-r[ok & (s == -1)]).groupby(p.date.values[ok & (s == -1)]).mean()
        print(f"side tau={tau:2d}: A+ (Pi-buyer aggr) trim {tm(dp):+.3f}   A- (Pi-seller aggr, hits a resting "
              f"Pi-buyer = user) trim {tm(dm):+.3f}")
    pre = (s * (p.pi0 - p.pi_pre) * 100)
    ok = np.isfinite(pre) & sg
    dpre = pd.Series(pre[ok].values).groupby(p.date.values[ok]).mean()
    print(f"pre-trade drift s*(pi0 - pi_chain(floor-1)) trim {tm(dpre):+.3f}")
    nb = day_values(p, y5, s)
    print(f"days with buckets (I_5): {len(nb)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "train")
