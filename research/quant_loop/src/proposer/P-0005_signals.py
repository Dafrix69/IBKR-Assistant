"""P-0005 signal-only diagnostics (TRAINING PERIOD ONLY, NO settlement, NO P&L).
Used to choose between two candidate mechanisms before any outcome is looked at:
  (a) 10:30 credit-spread anchor (premium vs implied): do the anchors diverge more than at 14:00?
  (b) 14:00 risk-neutral median offset from the forward (put skew): size and stability.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0005_signals.py
"""
import glob, os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CLEAN = os.path.join(R, "data/clean")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0005_tables")
TRAIN_END = pd.Timestamp("2024-11-01")


def snap(df, date, hhmm):
    t = pd.Timestamp(f"{date.date()} {hhmm}")
    return df[(df.ts == t) & ~df.flag_bad].set_index(["strike", "right"])[["bid", "ask", "mid"]]


def qcdf(q, F):
    """Risk-neutral CDF at strike midpoints from 5-wide put verticals: F_Q(K+2.5) = (P(K+5)-P(K))/5."""
    p = q.xs("P", level=1).mid.sort_index()
    ks = p.index.values
    xs, ys = [], []
    for a, b in zip(ks[:-1], ks[1:]):
        if b - a == 5 and abs(a - F) < 60:
            xs.append(a + 2.5); ys.append((p[b] - p[a]) / 5)
    return np.array(xs), np.array(ys)


def day(args):
    path, s1030, s1400, f1400 = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    out = {"date": date}
    # (a) 10:30 anchor divergence
    q = snap(df, date, "10:30")
    a_rows = []
    if not q.empty:
        strikes = np.sort(q.index.get_level_values(0).unique().values)
        katm = float(strikes[np.abs(strikes - s1030).argmin()])
        try:
            I = float(q.loc[(katm, "C"), "mid"] + q.loc[(katm, "P"), "mid"])
        except KeyError:
            I = np.nan
        out["I_1030"] = I
        for side, right, sgn in (("bear_call", "C", 1), ("bull_put", "P", -1)):
            for w in (10, 15):
                for ks in strikes:
                    d = sgn * (ks - s1030)
                    if d < -15 or d > 120:
                        continue
                    kl = ks + sgn * w
                    if (ks, right) not in q.index or (kl, right) not in q.index:
                        continue
                    a_rows.append({"date": date, "side": side, "width": w, "k_short": float(ks), "dist": d,
                                   "dist_I": d / I, "credit": float(q.loc[(ks, right), "mid"] - q.loc[(kl, right), "mid"])})
    # (b) 14:00 RN median offset vs forward
    q = snap(df, date, "14:00")
    if not q.empty and np.isfinite(f1400):
        xs, ys = qcdf(q, f1400)
        ok = (ys >= -0.02) & (ys <= 1.02)
        xs, ys = xs[ok], ys[ok]
        if len(xs) > 4 and ys.min() < 0.5 < ys.max():
            o = np.argsort(xs); xs, ys = xs[o], np.maximum.accumulate(ys[o])
            j = np.searchsorted(ys, 0.5)
            if 0 < j < len(xs):
                x0, x1, y0, y1 = xs[j-1], xs[j], ys[j-1], ys[j]
                qmed = x0 + (0.5 - y0) * (x1 - x0) / max(y1 - y0, 1e-9)
                out["qmed_off"] = qmed - f1400
        strikes = np.sort(q.index.get_level_values(0).unique().values)
        katm = float(strikes[np.abs(strikes - s1400).argmin()])
        try:
            out["I_1400"] = float(q.loc[(katm, "C"), "mid"] + q.loc[(katm, "P"), "mid"])
        except KeyError:
            pass
        out["spot_1400"] = s1400; out["F_1400"] = f1400; out["katm_1400"] = katm
        for off in (-10, -5, 0, 5, 10):
            c = katm + off
            try:
                out[f"fly25_cost_{off:+d}"] = float(q.loc[(c - 25, "P"), "mid"] - 2 * q.loc[(c, "P"), "mid"] + q.loc[(c + 25, "P"), "mid"])
            except KeyError:
                pass
        klo = float(np.floor(f1400 / 5) * 5); khi = klo + 5
        for nm, c in (("lo", klo), ("hi", khi)):
            try:
                out[f"fly25_cost_{nm}"] = float(q.loc[(c - 25, "P"), "mid"] - 2 * q.loc[(c, "P"), "mid"] + q.loc[(c + 25, "P"), "mid"])
            except KeyError:
                pass
        out["frac_lo"] = (f1400 - klo) / 5   # 0 = F on the lower strike, 1 = on the upper
    return out, a_rows


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
        t1, t2 = pd.Timestamp(f"{d.date()} 10:30"), pd.Timestamp(f"{d.date()} 14:00")
        if t1 not in sp.index or t2 not in sp.index:
            continue
        jobs.append((f, float(sp.loc[t1, "spot"]), float(sp.loc[t2, "spot"]), float(sp.loc[t2, "parity_F"])))
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(day, jobs, chunksize=8))
    days = pd.DataFrame([r for r, _ in res]); cand = pd.DataFrame([x for _, a in res for x in a])
    assert days.date.max() < TRAIN_END
    days.to_parquet(os.path.join(OUT, "signals_days.parquet"), index=False)
    cand.to_parquet(os.path.join(OUT, "signals_cand1030.parquet"), index=False)

    # ---- (a) report
    print("== (a) 10:30 anchor divergence, days", days.I_1030.notna().sum())
    print("I_1030 quantiles", days.I_1030.quantile([.25, .5, .75]).round(1).tolist())
    ter = pd.qcut(days.set_index("date").I_1030, 3, labels=["low", "mid", "high"])
    rows = []
    for (side, w), g in cand.groupby(["side", "width"]):
        g = g.copy(); g["e"] = (g.credit - 3.5).abs()
        pc = g.loc[g.groupby("date").e.idxmin()].set_index("date")
        m = pc.dist_I.median()
        # implied anchor: strike nearest spot +/- m*I
        dd = days.set_index("date")
        target = m * dd.I_1030
        g["e2"] = (g.dist - target.reindex(g.date).values).abs(); g = g.dropna(subset=["e2"])
        pi = g.loc[g.groupby("date").e2.idxmin()].set_index("date")
        j = pc.join(pi[["k_short"]], rsuffix="_im")
        j["gap"] = (j.k_short - j.k_short_im).abs() / 5
        j["ter"] = ter.reindex(j.index)
        rows.append({"side": side, "w": w, "m": round(m, 3), "dist_med": pc.dist.median(),
                     "credit_in_3_4": round(((pc.credit >= 3) & (pc.credit <= 4)).mean(), 2),
                     "w_over_I_med": round((w / dd.I_1030).median(), 2),
                     "diff_all": round((j.gap > 0).mean(), 2), "gap>=2_all": round((j.gap >= 2).mean(), 2),
                     **{f"diff_{t}": round((j[j.ter == t].gap > 0).mean(), 2) for t in ("low", "mid", "high")},
                     "gap>=2_high": round((j[j.ter == "high"].gap >= 2).mean(), 2),
                     "mean_gap_high_strikes": round(j[j.ter == "high"].gap.mean(), 2)})
    print(pd.DataFrame(rows).to_string(index=False))

    # ---- (b) report
    b = days.dropna(subset=["qmed_off"]).copy()
    b["year"] = b.date.dt.year
    print("\n== (b) 14:00 RN median minus parity forward (points), days", len(b))
    print(b.qmed_off.describe().round(2).to_string())
    print("by year median / share>0:", b.groupby("year").qmed_off.agg(["median", lambda v: (v > 0).mean()]).round(2).to_string())
    b["qmed_over_I"] = b.qmed_off / b.I_1400
    print("qmed_off / I_1400 quantiles", b.qmed_over_I.quantile([.1, .25, .5, .75, .9]).round(3).tolist())
    print("corr(qmed_off, I_1400)", round(b[["qmed_off", "I_1400"]].corr().iloc[0, 1], 2))
    for off in (-10, -5, 0, 5, 10):
        print(f"fly25 cost center ATM{off:+d}: median {b[f'fly25_cost_{off:+d}'].median():.2f}")
    print("bracketing: median cost lo / hi", b.fly25_cost_lo.median().round(2), b.fly25_cost_hi.median().round(2),
          " share hi>lo", round((b.fly25_cost_hi > b.fly25_cost_lo).mean(), 2))
    # same, controlling for where F sits between the two strikes
    b["fb"] = pd.cut(b.frac_lo, [0, .25, .5, .75, 1.0], include_lowest=True)
    print(b.groupby("fb", observed=True).apply(lambda g: pd.Series({"n": len(g), "hi_minus_lo": (g.fly25_cost_hi - g.fly25_cost_lo).median()})).round(2).to_string())


if __name__ == "__main__":
    main()
