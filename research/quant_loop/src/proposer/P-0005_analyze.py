"""P-0005: 14:00 base-A put fly, center on the upper bracketing strike vs nearest (and the lower mirror);
M1 = P(settle > F) - Q(settle > F). TRAINING PERIOD ONLY.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0005_analyze.py
"""
import glob, os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CLEAN = os.path.join(R, "data/clean")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0005_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
SEED = 20261101

# calibrated fills, research/spx_fly/config.yaml `fills` (copied, not imported)
def tier_comm(p): return 0.25 if p < 0.05 else (0.50 if p < 0.10 else 0.65)
def tier_exch(p): return 0.36 if p < 1.00 else 0.45
def leg_fees(px, qty):
    return max(tier_comm(px) * qty, 1.00) + qty * (tier_exch(px) + 0.14 + 0.04028)


def fly(q, Kc, w):
    legs = [(Kc - w, 1, 1), (Kc, -1, 2), (Kc + w, 1, 1)]
    try:
        r = [q.loc[(k, "P")] for k, _, _ in legs]
    except KeyError:
        return None
    mid = sum(sg * qt * x.mid for (_, sg, qt), x in zip(legs, r))
    H = sum(qt * (x.ask - x.bid) / 2 for (_, _, qt), x in zip(legs, r))
    fees = sum(leg_fees(float(x.mid), qt) for (_, _, qt), x in zip(legs, r))
    if mid <= 0:
        return None
    return float(mid), float(H), float(fees)


def qcdf_at(q, F, x):
    p = q.xs("P", level=1).mid.sort_index()
    ks = p.index.values
    xs, ys = [], []
    for a, b in zip(ks[:-1], ks[1:]):
        if b - a == 5 and abs(a - F) < 60:
            xs.append(a + 2.5); ys.append((p[b] - p[a]) / 5)
    xs, ys = np.array(xs), np.array(ys)
    ok = (ys >= -0.02) & (ys <= 1.02)
    xs, ys = xs[ok], ys[ok]
    if len(xs) < 5:
        return [np.nan] * len(x), np.nan
    o = np.argsort(xs); xs, ys = xs[o], np.clip(np.maximum.accumulate(ys[o]), 0, 1)
    vals = [float(np.interp(v, xs, ys)) if xs[0] <= v <= xs[-1] else np.nan for v in x]
    qmed = np.nan
    if ys.min() < 0.5 < ys.max():
        j = np.searchsorted(ys, 0.5)
        x0, x1, y0, y1 = xs[j-1], xs[j], ys[j-1], ys[j]
        qmed = x0 + (0.5 - y0) * (x1 - x0) / max(y1 - y0, 1e-9)
    return vals, qmed


def day(args):
    path, s0, F = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    t = pd.Timestamp(f"{date.date()} 14:00")
    q = df[(df.ts == t) & ~df.flag_bad].set_index(["strike", "right"])[["bid", "ask", "mid"]]
    if q.empty:
        return None
    ks = np.sort(q.index.get_level_values(0).unique().values)
    kn = float(ks[np.abs(ks - s0).argmin()])
    up, dn = ks[ks >= s0], ks[ks <= s0]
    if len(up) == 0 or len(dn) == 0:
        return None
    ku, kd = float(up.min()), float(dn.max())
    try:
        I = float(q.loc[(kn, "C"), "mid"] + q.loc[(kn, "P"), "mid"])
    except KeyError:
        return None
    w = min(WIDTHS, key=lambda x: abs(x / I - 2))
    out = {"date": date, "s0": s0, "F": F, "I": I, "w": w, "k_near": kn, "k_up": ku, "k_dn": kd}
    for nm, k in (("near", kn), ("up", ku), ("dn", kd)):
        f = fly(q, k, w)
        if f is None:
            return None
        out[f"mid_{nm}"], out[f"H_{nm}"], out[f"fee_{nm}"] = f
    vals, qmed = qcdf_at(q, F, [F - 5, F, F + 5])
    out["FQ_m5"], out["FQ_0"], out["FQ_p5"] = vals
    out["qmed_off"] = qmed - F
    return out


def boot(v, n=2000):
    v = np.asarray(v, float); rng = np.random.default_rng(SEED)
    m = v[rng.integers(0, len(v), (n, len(v)))].mean(1)
    return v.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5)


def main():
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[cal.index < TRAIN_END]                                  # TIME WALL: training only
    sp = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    sp = sp[sp.ts < TRAIN_END]                                        # TIME WALL: training only
    sp = sp.set_index("ts")
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if d >= TRAIN_END:                                            # TIME WALL: never open test files
            continue
        if d not in cal.index or cal.loc[d, "half_day"]:
            continue
        t = pd.Timestamp(f"{d.date()} 14:00")
        if t not in sp.index:
            continue
        jobs.append((f, float(sp.loc[t, "spot"]), float(sp.loc[t, "parity_F"])))
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(day, jobs, chunksize=8) if r is not None]
    D = pd.DataFrame(res)
    assert D.date.max() < TRAIN_END
    D = D.join(cal[["settle", "spx_ret_prev"]], on="date")
    D["year"] = D.date.dt.year
    for nm in ("near", "up", "dn"):
        k = D[f"k_{nm}"]
        pay = np.maximum(0, D.w - (D.settle - k).abs())
        for kk, suf in ((0.20, ""), (0.50, "_k05")):
            D[f"pnl_{nm}{suf}"] = (pay - D[f"mid_{nm}"] - kk * D[f"H_{nm}"]) * 100 - D[f"fee_{nm}"]
    D.to_parquet(os.path.join(OUT, "days.parquet"), index=False)
    B = D[D.spx_ret_prev > -0.01].copy()                             # base-A days
    print("all days", len(D), "base-A days", len(B))

    # baseline replication
    print("\n== baseline replication (near center): n %d, win %.1f%%, ev %+.0f, ev_k05 %+.0f" %
          (len(B), 100 * (B.pnl_near > 0).mean(), B.pnl_near.mean(), B.pnl_near_k05.mean()))
    for nm in ("up", "dn"):
        print(f"   {nm}: win {100*(B[f'pnl_{nm}']>0).mean():.1f}%, ev {B[f'pnl_{nm}'].mean():+.0f}, ev_k05 {B[f'pnl_{nm}_k05'].mean():+.0f}")

    # M1
    rows = []
    def m1(g, col, off):
        if off == 0:
            ind = (g.settle > g.F).astype(float); qq = 1 - g.FQ_0
        elif off == 5:
            ind = (g.settle > g.F + 5).astype(float); qq = 1 - g.FQ_p5
        else:
            ind = (g.settle > g.F - 5).astype(float); qq = 1 - g.FQ_m5
        v = (ind - qq).dropna() * 100
        return boot(v), len(v), ind.mean() * 100, qq.mean() * 100
    print("\n== M1: P(settle > F+x) - Q(settle > F+x), pp (base-A days and all days)")
    for lab, G in (("base-A", B), ("all", D)):
        for off in (0, -5, 5):
            (m, lo, hi), n, p, qq = m1(G, "", off)
            rows.append({"set": lab, "x": off, "year": "all", "n": n, "P": round(p, 1), "Q": round(qq, 1), "M1": round(m, 2), "lo": round(lo, 2), "hi": round(hi, 2)})
            if off == 0:
                for y, g in G.groupby("year"):
                    (m, lo, hi), n, p, qq = m1(g, "", 0)
                    rows.append({"set": lab, "x": 0, "year": y, "n": n, "P": round(p, 1), "Q": round(qq, 1), "M1": round(m, 2), "lo": round(lo, 2), "hi": round(hi, 2)})
    M1 = pd.DataFrame(rows); print(M1.to_string(index=False)); M1.to_csv(os.path.join(OUT, "m1.csv"), index=False)

    # Delta
    B["d_up"] = B.pnl_up - B.pnl_near; B["d_dn"] = B.pnl_dn - B.pnl_near
    B["d_up_k05"] = B.pnl_up_k05 - B.pnl_near_k05; B["d_dn_k05"] = B.pnl_dn_k05 - B.pnl_near_k05
    B["ch_up"] = B.k_up != B.k_near; B["ch_dn"] = B.k_dn != B.k_near
    rows = []
    for col, ch in (("d_up", "ch_up"), ("d_dn", "ch_dn"), ("d_up_k05", "ch_up"), ("d_dn_k05", "ch_dn")):
        for y, g in [("all", B)] + list(B.groupby("year")):
            m, lo, hi = boot(g[col])
            gc = g[g[ch]]
            mc, loc_, hic = boot(gc[col])
            rows.append({"delta": col, "year": y, "n": len(g), "n_changed": len(gc), "per_day": round(m, 1), "lo": round(lo, 1), "hi": round(hi, 1),
                         "per_changed": round(mc, 1), "lo_c": round(loc_, 1), "hi_c": round(hic, 1), "sd_changed": round(gc[col].std(), 0),
                         "win_rule_changed": round(100 * (gc[col.replace('d_', 'pnl_').replace('_k05', '')] > 0).mean(), 1),
                         "win_near_changed": round(100 * (gc.pnl_near > 0).mean(), 1)})
    Dl = pd.DataFrame(rows); print("\n== Delta (rule - near), $/day over base-A days; per_changed = on days the center moved"); print(Dl.to_string(index=False))
    Dl.to_csv(os.path.join(OUT, "delta.csv"), index=False)

    # diagnostic: by skew tercile (qmed_off / I), report only
    B["sk"] = B.qmed_off / B.I
    cuts = B.sk.quantile([1/3, 2/3]).values
    B["skt"] = pd.cut(B.sk, [-np.inf, *cuts, np.inf], labels=["low", "mid", "high"])
    print("\n== diagnostic by (Q_med - F)/I tercile (report only); cuts", np.round(cuts, 4))
    t = B.groupby("skt", observed=True).apply(lambda g: pd.Series({"n": len(g), "d_up": g.d_up.mean(), "d_dn": g.d_dn.mean(),
        "M1": ((g.settle > g.F).astype(float) - (1 - g.FQ_0)).mean() * 100})).round(1)
    print(t.to_string()); t.to_csv(os.path.join(OUT, "by_skew_tercile.csv"))
    # all-days (incl. skipped) delta for reference
    D["d_up"] = D.pnl_up - D.pnl_near; D["d_dn"] = D.pnl_dn - D.pnl_near
    print("\n== reference, all days incl. prev<=-1%%: n %d, d_up %+.1f, d_dn %+.1f" % (len(D), D.d_up.mean(), D.d_dn.mean()))
    # drift context
    print("\n== drift context: settle - F by year (mean / median)")
    print(B.assign(dr=B.settle - B.F).groupby("year").dr.agg(["mean", "median"]).round(2).to_string())


if __name__ == "__main__":
    main()
