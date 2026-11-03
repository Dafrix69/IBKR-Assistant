"""V-0004: independent re-implementation of P-0004 (implied anchor vs credit anchor), TRAINING ONLY.
No test-period file is opened. Does not import or read anything of the proposer.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0004_anchor.py
"""
import glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
C = os.path.join(R, "data/clean")
# variant: "" = spec literally (all strikes); "win" = proposer's -15..90 pt window; "win_nofomc" = window, FOMC days dropped
VAR = sys.argv[1] if len(sys.argv) > 1 else ""
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0004_tables" + (("_" + VAR) if VAR else ""))
os.makedirs(OUT, exist_ok=True)
WALL = pd.Timestamp("2024-11-01")
M = {("bear_call", 10): 0.15, ("bear_call", 15): 0.41, ("bull_put", 10): 0.05, ("bull_put", 15): 0.32}
K = 0.20

# config.yaml fills (read here as literals; checked against the file in the report)
def fee_leg(px):
    comm = 0.25 if px < 0.05 else 0.50 if px < 0.10 else 0.65
    return max(comm, 1.00) + (0.36 if px < 1.00 else 0.45) + 0.14 + 0.04028


def one_day(a):
    f, d, s0 = a
    q = pd.read_parquet(f, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    q = q[(q.ts == d + pd.Timedelta(hours=14)) & (~q.flag_bad)]
    if q.empty:
        return None
    c = q[q.right == "C"].set_index("strike")
    p = q[q.right == "P"].set_index("strike")
    both = c.index.intersection(p.index)
    if len(both) == 0:
        return None
    ka = both[np.argmin(np.abs(both.values - s0))]
    I = c.at[ka, "mid"] + p.at[ka, "mid"]
    rows = []
    for side, tab, sg in (("bear_call", c, 1), ("bull_put", p, -1)):
        for w in (10, 15):
            for ks in tab.index:           # every strike with both legs quoted, no distance window
                kl = ks + sg * w
                if kl not in tab.index:
                    continue
                sh, lo = tab.loc[ks], tab.loc[kl]
                rows.append((d, side, w, ks, sg * (ks - s0), sh.mid - lo.mid,
                             (sh.ask - sh.bid + lo.ask - lo.bid) / 2, fee_leg(sh.mid) + fee_leg(lo.mid)))
    return (d, s0, I), rows


def main():
    cal = pd.read_parquet(os.path.join(C, "calendar.parquet")); cal = cal[cal.index < WALL]
    sp = pd.read_parquet(os.path.join(C, "spot.parquet")); sp = sp[sp.ts < WALL].set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(C, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if d >= WALL or d not in cal.index or bool(cal.at[d, "half_day"]):
            continue
        t = d + pd.Timedelta(hours=14)
        if t in sp.index:
            jobs.append((f, d, float(sp.at[t])))
    with ProcessPoolExecutor(6) as ex:
        res = [r for r in ex.map(one_day, jobs, chunksize=8) if r is not None]
    days = pd.DataFrame([r[0] for r in res], columns=["date", "s0", "I"])
    cand = pd.DataFrame([x for r in res for x in r[1]],
                        columns=["date", "side", "w", "ks", "dist", "credit", "H", "fee"])
    assert cand.date.max() < WALL
    if VAR.startswith("win"):
        cand = cand[cand.dist.between(-15, 90)]
    if VAR.endswith("nofomc"):
        fomc = set(cal.index[cal.fomc.astype(bool)])
        cand = cand[~cand.date.isin(fomc)]; days = days[~days.date.isin(fomc)]
    cand = cand.merge(days[["date", "I"]], on="date")
    cand["dI"] = cand.dist / cand.I
    # outcomes (only here)
    cand = cand.merge(cal[["settle"]], left_on="date", right_index=True)
    sg = np.where(cand.side == "bear_call", 1.0, -1.0)
    loss = np.clip(sg * (cand.settle - cand.ks), 0, cand.w)
    cand["pnl"] = (cand.credit - K * cand.H - loss) * 100 - cand.fee
    cand["pnl05"] = (cand.credit - 0.5 * cand.H - loss) * 100 - cand.fee
    cut = days.I.quantile([1 / 3, 2 / 3]).values
    cand["Iq"] = np.select([cand.I <= cut[0], cand.I <= cut[1]], ["low", "mid"], "high")
    cand["year"] = cand.date.dt.year
    log = [f"jobs {len(jobs)} days {len(days)} cand {len(cand)} I median {days.I.median():.2f} "
           f"quartiles {days.I.quantile(.25):.2f}/{days.I.quantile(.75):.2f} tercile cuts {cut.round(2)}"]

    # rules
    g = cand.groupby(["date", "side", "w"])
    cr = cand.loc[(cand.credit - 3.5).abs().groupby([cand.date, cand.side, cand.w]).idxmin()]
    # m check: median dI of credit-anchor picks, by cell and by I tercile
    log.append("credit-anchor dist_I median by cell (m check):\n" +
               cr.groupby(["side", "w"]).dI.median().round(3).to_string())
    log.append(cr.groupby(["side", "w", "Iq"]).dI.median().unstack().round(2).to_string())
    log.append("credit in [3,4] share:\n" + cr.groupby(["side", "w"]).credit.apply(lambda v: v.between(3, 4).mean()).round(2).to_string())
    m = pd.Series([M[k] for k in zip(cand.side, cand.w)], index=cand.index)
    im = cand.loc[(cand.dI - m).abs().groupby([cand.date, cand.side, cand.w]).idxmin()]
    key = ["date", "side", "w"]
    P = im[key + ["ks", "pnl", "pnl05", "Iq", "year", "credit"]].merge(
        cr[key + ["ks", "pnl", "pnl05", "credit"]], on=key, suffixes=("_im", "_cr"))
    P["d"] = P.pnl_im - P.pnl_cr; P["d05"] = P.pnl05_im - P.pnl05_cr; P["diff"] = P.ks_im != P.ks_cr
    P.to_parquet(os.path.join(OUT, "paired.parquet"), index=False)
    full = P.groupby("date").filter(lambda x: len(x) == 4)
    D = full.groupby("date").agg(d=("d", "mean"), d05=("d05", "mean"), Iq=("Iq", "first"),
                                 year=("year", "first"), diff=("diff", "mean"))
    rng = np.random.default_rng(4)

    def S(v):
        v = np.asarray(v, float)
        b = v[rng.integers(0, len(v), (2000, len(v)))].mean(1)
        return pd.Series({"n": len(v), "D": v.mean(), "lo": np.percentile(b, 2.5), "hi": np.percentile(b, 97.5)})
    T = {}
    T["primary"] = pd.DataFrame({"k020": S(D.d), "k050": S(D.d05)}).T.assign(frac_diff=D["diff"].mean())
    T["by_year"] = D.groupby("year").d.apply(S).unstack()
    T["by_Iq"] = D.groupby("Iq").d.apply(S).unstack()
    T["by_year_Iq"] = D.groupby(["year", "Iq"]).d.apply(S).unstack()
    T["by_cell"] = P.groupby(["side", "w"]).d.apply(S).unstack()
    T["by_cell_Iq"] = P.groupby(["side", "w", "Iq"]).d.mean().unstack()
    T["by_cell_year"] = P.groupby(["side", "w", "year"]).d.mean().unstack()
    T["by_side"] = P.groupby(["side", "date"]).d.mean().groupby("side").apply(S).unstack()
    T["levels"] = pd.DataFrame({
        "win_im": P.groupby(["side", "w"]).pnl_im.apply(lambda v: (v > 0).mean()),
        "ev_im": P.groupby(["side", "w"]).pnl_im.mean(), "ev05_im": P.groupby(["side", "w"]).pnl05_im.mean(),
        "win_cr": P.groupby(["side", "w"]).pnl_cr.apply(lambda v: (v > 0).mean()),
        "ev_cr": P.groupby(["side", "w"]).pnl_cr.mean(), "ev05_cr": P.groupby(["side", "w"]).pnl05_cr.mean()})

    # ---- P3 redo: same candidate rows for both anchors, quantile buckets, day-bootstrap ----
    cand["cr"] = cand.credit / cand.w
    common = cand[cand.dI.between(-0.2, 0.8) & cand.cr.between(0.15, 0.55)].copy()

    def flat(x, var, q):
        b = pd.qcut(x[var], q, labels=False, duplicates="drop")
        dd = x.assign(b=b).groupby(["b", "Iq", "date"]).pnl.mean().reset_index()
        t = dd.groupby(["b", "Iq"]).pnl.agg(["mean", "size"]).unstack("Iq")
        ok = (t["size"] >= 30).all(axis=1)
        ev = t["mean"][ok]
        return (ev.max(axis=1) - ev.min(axis=1)).mean(), ev.std(axis=1).mean(), int(ok.sum())

    p3 = []
    cells = list(M)
    dates = np.array(sorted(common.date.unique()))
    for q in (4, 5):
        # quantile edges fixed on full training common set (signals only) per cell
        point = {}
        for (s, w) in cells:
            x = common[(common.side == s) & (common.w == w)]
            a = flat(x, "dI", q); b = flat(x, "cr", q)
            point[(s, w)] = b[0] - a[0]
            p3.append({"q": q, "side": s, "w": w, "range_dI": a[0], "range_cr": b[0], "sd_dI": a[1], "sd_cr": b[1],
                       "nb_dI": a[2], "nb_cr": b[2], "flatter": "credit" if b[0] < a[0] else "dist_I"})
        # day bootstrap (resample dates; quantile edges recomputed inside, same for both anchors)
        rs = np.random.default_rng(100 + q)
        byd = {d: grp for d, grp in common.groupby("date")}
        bd = {c: [] for c in cells}; cnt = []
        for _ in range(300 if not VAR else 0):
            pick = rs.choice(dates, len(dates))
            parts = []
            for i, d in enumerate(pick):
                z = byd[d].copy(); z["date"] = i; parts.append(z)
            xb = pd.concat(parts)
            k = 0
            for (s, w) in cells:
                x = xb[(xb.side == s) & (xb.w == w)]
                v = flat(x, "cr", q)[0] - flat(x, "dI", q)[0]
                bd[(s, w)].append(v); k += v < 0
            cnt.append(k)
        for r in p3:
            if r["q"] == q:
                v = np.array(bd[(r["side"], r["w"])])
                r["cr_minus_dI"] = point[(r["side"], r["w"])]
                if len(v):
                    r["boot_lo"], r["boot_hi"] = np.percentile(v, [2.5, 97.5])
                    r["boot_P(credit flatter)"] = (v < 0).mean()
        if cnt: log.append(f"P3 q={q}: bootstrap P(credit flatter in >=3 of 4 cells) = {(np.array(cnt) >= 3).mean():.2f}")
    T["p3"] = pd.DataFrame(p3)
    # proposer's own buckets on my candidate set (fixed edges, all candidate rows) for reproduction
    pr = []
    for (s, w) in cells:
        x = cand[(cand.side == s) & (cand.w == w)]
        for name, var, edges in (("dist_I", "dI", [-0.2, 0, 0.2, 0.4, 0.6, 0.8]), ("credit_ratio", "cr", [0.15, 0.25, 0.35, 0.45, 0.55])):
            b = pd.cut(x[var], edges)
            dd = x.assign(b=b).groupby(["b", "Iq", "date"], observed=True).pnl.mean().reset_index()
            t = dd.groupby(["b", "Iq"], observed=True).pnl.agg(["mean", "size"]).unstack("Iq")
            ok = (t["size"] >= 30).all(axis=1); ev = t["mean"][ok]
            pr.append({"side": s, "w": w, "anchor": name, "buckets": int(ok.sum()), "range": (ev.max(axis=1) - ev.min(axis=1)).mean()})
    T["p3_fixed_edges"] = pd.DataFrame(pr)

    pd.set_option("display.width", 220)
    with open(os.path.join(OUT, "log.txt"), "w") as fh:
        for s in log:
            print(s); fh.write(s + "\n")
        for k, v in T.items():
            v.to_csv(os.path.join(OUT, f"{k}.csv"))
            s = f"\n=== {k} ===\n{v.round(3).to_string()}"
            print(s); fh.write(s + "\n")


if __name__ == "__main__":
    main()
