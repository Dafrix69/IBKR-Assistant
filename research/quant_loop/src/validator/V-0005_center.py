"""V-0005: independent re-implementation for P-0005 (fly center K_up vs K_near vs K_dn; M1 = P - Q above F).
Does NOT import proposer code nor spx_fly/src. Built from the data dictionary (BRIEF.md) and config.yaml fills.

    PY=research/spx_fly/.venv/bin/python
    $PY research/quant_loop/src/validator/V-0005_center.py build --period train
    $PY research/quant_loop/src/validator/V-0005_center.py analyze --period train
    (test: same with --period test, run once)
"""
import argparse, glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CLEAN = os.path.join(R, "data/clean")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0005_tables")
SPLIT = pd.Timestamp("2024-11-01")
WIDTHS = (20, 25, 30, 50, 75)
SEED = 5005
ENTRIES = ("14:00", "13:30", "14:30")


def in_period(d, period):
    return d < SPLIT if period == "train" else d >= SPLIT


# ---------- fills (config.yaml `fills`, re-typed) ----------
def comm(px):
    return 0.25 if px < 0.05 else (0.50 if px < 0.10 else 0.65)


def exch(px):
    return 0.36 if px < 1.00 else 0.45


def fees(px, qty, minleg=True):
    c = comm(px) * qty
    if minleg:
        c = max(c, 1.00)
    return c + qty * (exch(px) + 0.14 + 0.04028)


# ---------- risk-neutral CDF ----------
def pava(y):
    """isotonic (non-decreasing) least-squares fit, equal weights"""
    y = list(map(float, y)); blocks = []  # [sum, count]
    for v in y:
        blocks.append([v, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, c = blocks.pop(); blocks[-1][0] += s; blocks[-1][1] += c
    out = []
    for s, c in blocks:
        out += [s / c] * c
    return np.array(out)


def vert_points(px, F, put=True):
    """px: Series strike->mid for one right. F_Q(K+2.5) from 5-wide verticals with K within F+-60."""
    ks = px.index.values.astype(float); v = px.values.astype(float)
    xs, ys = [], []
    for i in range(len(ks) - 1):
        a, b = ks[i], ks[i + 1]
        if b - a == 5 and abs(a - F) < 60:
            d = (v[i + 1] - v[i]) / 5
            xs.append(a + 2.5); ys.append(d if put else 1 + d)
    return np.array(xs), np.array(ys)


def interp_cdf(xs, ys, pts, method):
    ok = (ys >= -0.02) & (ys <= 1.02)
    xs, ys = xs[ok], ys[ok]
    if len(xs) < 5:
        return [np.nan] * len(pts), np.nan
    o = np.argsort(xs); xs, ys = xs[o], ys[o]
    ys = np.maximum.accumulate(ys) if method == "cummax" else pava(ys)
    ys = np.clip(ys, 0, 1)
    vals = [float(np.interp(p, xs, ys)) if xs[0] <= p <= xs[-1] else np.nan for p in pts]
    qmed = np.nan
    if ys.min() < 0.5 < ys.max():
        j = int(np.searchsorted(ys, 0.5, side="left"))
        j = max(j, 1)
        x0, x1, y0, y1 = xs[j - 1], xs[j], ys[j - 1], ys[j]
        qmed = x0 + (0.5 - y0) * (x1 - x0) / max(y1 - y0, 1e-9)
    return vals, qmed


# ---------- per day ----------
def fly_legs(P, Kc, w):
    ks = (Kc - w, Kc, Kc + w)
    if not all(k in P.index for k in ks):
        return None
    lo, c, hi = (P.loc[k] for k in ks)
    mid = lo.mid - 2 * c.mid + hi.mid
    if not mid > 0:
        return None
    H = (lo.ask - lo.bid) / 2 + 2 * (c.ask - c.bid) / 2 + (hi.ask - hi.bid) / 2
    f = fees(lo.mid, 1) + fees(c.mid, 2) + fees(hi.mid, 1)
    f_nomin = fees(lo.mid, 1, False) + fees(c.mid, 2, False) + fees(hi.mid, 1, False)
    return float(mid), float(H), float(f), float(f_nomin)


def snapshot(df, date, hhmm):
    t = pd.Timestamp(f"{date.date()} {hhmm}")
    q = df[(df.ts == t) & ~df.flag_bad]
    P = q[q.right == "P"].set_index("strike")[["bid", "ask", "mid"]].sort_index()
    C = q[q.right == "C"].set_index("strike")[["bid", "ask", "mid"]].sort_index()
    return P, C


def one_entry(P, C, s0, F, wtarget=2.0):
    both = np.array(sorted(set(P.index) & set(C.index)), float)
    if len(both) == 0:
        return None
    kn = float(both[np.abs(both - s0).argmin()])            # ATM: nearest strike with valid C and P
    I = float(C.loc[kn, "mid"] + P.loc[kn, "mid"])
    w = min(WIDTHS, key=lambda x: abs(x / I - wtarget))
    pk = P.index.values.astype(float)
    up, dn = pk[pk >= s0], pk[pk <= s0]
    if len(up) == 0 or len(dn) == 0:
        return None
    ku, kd = float(up.min()), float(dn.max())
    return kn, ku, kd, I, w


def day(args):
    path, period, spots = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    assert in_period(date, period)
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    rows = []
    for hhmm in ENTRIES:
        if hhmm not in spots:
            continue
        s0, F = spots[hhmm]
        P, C = snapshot(df, date, hhmm)
        if P.empty or C.empty:
            continue
        r = {"date": date, "entry": hhmm, "s0": s0, "F": F}
        e = one_entry(P, C, s0, F)
        if e is None:
            continue
        kn, ku, kd, I, w = e
        r.update(k_near=kn, k_up=ku, k_dn=kd, I=I, w=w)
        # F-based centering
        pk = P.index.values.astype(float)
        both = np.array(sorted(set(P.index) & set(C.index)), float)
        r["kF_near"] = float(both[np.abs(both - F).argmin()])
        upF = pk[pk >= F]
        r["kF_up"] = float(upF.min()) if len(upF) else np.nan
        centers = {"near": kn, "up": ku, "dn": kd, "Fnear": r["kF_near"], "Fup": r["kF_up"]}
        for nm, k in centers.items():
            f = fly_legs(P, k, w) if np.isfinite(k) else None
            for j, col in enumerate(("mid", "H", "fee", "fee_nomin")):
                r[f"{col}_{nm}"] = f[j] if f else np.nan
        if hhmm == "14:00":
            for wt, tag in ((1.5, "w15"), (2.5, "w25")):
                w2 = min(WIDTHS, key=lambda x: abs(x / I - wt)); r[f"w_{tag}"] = w2
                for nm, k in (("near", kn), ("up", ku), ("dn", kd)):
                    f = fly_legs(P, k, w2)
                    for j, col in enumerate(("mid", "H", "fee")):
                        r[f"{col}_{nm}_{tag}"] = f[j] if f else np.nan
            # F_Q constructions
            pts = [F - 5, F, F + 5, s0]
            xp, yp = vert_points(P.mid, F, True)
            xc, yc = vert_points(C.mid, F, False)
            for meth in ("cummax", "pava"):
                v, qm = interp_cdf(xp, yp, pts, meth)
                r[f"FQ_{meth}_m5"], r[f"FQ_{meth}_0"], r[f"FQ_{meth}_p5"], r[f"FQ_{meth}_s0"] = v
                r[f"qmed_{meth}"] = qm
            # call-vertical, PAVA (independent side of the book)
            v, qm = interp_cdf(xc, yc, pts, "pava")
            r["FQ_call_m5"], r["FQ_call_0"], r["FQ_call_p5"], r["FQ_call_s0"] = v
            # raw non-monotonicity count near F, and quote quality around F
            near = (xp > F - 30) & (xp < F + 30)
            r["n_nonmono"] = int((np.diff(yp[near]) < -0.01).sum()) if near.sum() > 1 else np.nan
            pw = P[(P.index >= F - 10) & (P.index <= F + 10)]
            r["max_put_spread_F10"] = float((pw.ask - pw.bid).max()) if len(pw) else np.nan
            r["atm_straddle_spread"] = float((C.loc[kn, "ask"] - C.loc[kn, "bid"]) + (P.loc[kn, "ask"] - P.loc[kn, "bid"]))
        rows.append(r)
    return rows


def build(period):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[[in_period(d, period) for d in cal.index]]              # TIME WALL
    sp = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    sp = sp[[in_period(d, period) for d in sp.ts.dt.normalize()]].set_index("ts")   # TIME WALL
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if not in_period(d, period):                                  # TIME WALL: filename check before open
            continue
        if d not in cal.index or bool(cal.loc[d, "half_day"]):
            continue
        spots = {}
        for hhmm in ENTRIES:
            t = pd.Timestamp(f"{d.date()} {hhmm}")
            if t in sp.index:
                spots[hhmm] = (float(sp.loc[t, "spot"]), float(sp.loc[t, "parity_F"]))
        if "14:00" not in spots:
            continue
        jobs.append((f, period, spots))
    with ProcessPoolExecutor(6) as ex:
        res = [x for rows in ex.map(day, jobs, chunksize=8) for x in rows]
    D = pd.DataFrame(res)
    assert all(in_period(d, period) for d in D.date)
    D = D.join(cal[["settle", "spx_ret_prev", "fomc", "cpi", "nfp", "pce"]], on="date")
    D.to_parquet(os.path.join(OUT, f"{period}_days.parquet"), index=False)
    print(period, "rows", len(D), "days", D.date.nunique(), "range", D.date.min().date(), D.date.max().date())


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd"); ap.add_argument("--period", required=True)
    a = ap.parse_args()
    if a.cmd == "build":
        build(a.period)
    else:
        from importlib import import_module
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import_module("V-0005_analyze").analyze(a.period)
