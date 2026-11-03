"""P-0001: Treasury coupon-auction days (13:00 ET close) and the 13:00 0DTE ATM put fly.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0001_auction_days.py [--workers 6]

Training period only (date < 2024-11-01): the time wall is the first statement after every
data read. The auction calendar (P-0001_auctions.csv, FiscalData) is a published schedule,
not outcome data, and is merged after the wall.

Costs: k = 0.20 interpolated from the panel's k = 0 / 0.25 columns, plus the IBKR USD 1.00
per-leg order minimum that src/fills.py does not apply (put fly: two qty-1 legs 0.65 -> 1.00).
13:10 entries are priced from the chain parquets with the same fill model (fills.py).
"""
import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.normpath(os.path.join(HERE, "..", "..", "..", "spx_fly"))
sys.path.insert(0, os.path.join(R, "src"))
import fills  # noqa: E402  (spx_fly's fill model; read-only use)

CFG = yaml.safe_load(open(os.path.join(R, "config.yaml")))
F = CFG["fills"]
CLEAN = os.path.join(R, "data", "clean")
OUT = os.path.join(HERE, "P-0001_tables")
WALL = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
K = 0.20
MIN_LEG = F.get("commission_min_per_leg", 1.0)


def wilson(k, n, z=1.96):
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def stats(g, col="pnl20"):
    n = len(g)
    w = int((g[col] > 0).sum())
    lo, hi = wilson(w, n)
    return pd.Series({"n": n, "win": w / n if n else np.nan, "lo": lo, "hi": hi,
                      "ev": g[col].mean(), "ev_k05": g["pnl_k05"].mean() if "pnl_k05" in g else np.nan})


# ---------------------------------------------------------------- data
def load_panel():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[p.date < WALL]                                   # TIME WALL: training period only
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[cal.index < WALL]                            # TIME WALL
    p = p[p.structure == "put_fly"]
    p = p.merge(cal[["half_day", "spx_ret_prev", "fomc", "cpi", "nfp", "pce"]], left_on="date", right_index=True)
    p = p[~p.half_day]
    # k = 0.20 from the k = 0 and k = 0.25 columns (pnl is linear in k), then the per-leg minimum
    p["pnl20"] = p.pnl_k0 + (K / 0.25) * (p.pnl - p.pnl_k0) - 2 * (MIN_LEG - 0.65)
    return p, cal


def load_auctions():
    a = pd.read_csv(os.path.join(HERE, "P-0001_auctions.csv"), comment="#")
    a = a[(a.closing_time_comp == "01:00 PM") & a.security_type.isin(["Note", "Bond"])]
    a["date"] = pd.to_datetime(a.auction_date)
    long_end = a.original_security_term.isin(["10-Year", "20-Year", "30-Year"])
    days = a.groupby("date").agg(n_auct=("original_security_term", "size"), long_end=("original_security_term", lambda s: bool(s.isin(["10-Year", "20-Year", "30-Year"]).any())))
    return days


def baseline_rule(p, entry):
    """One put fly per day: width/implied closest to 2, skip prev-day <= -1%."""
    q = p[(p.entry == entry) & (p.width.isin(WIDTHS))].copy()
    q = q[~(q.spx_ret_prev <= -0.01)]
    q["d2"] = (q.w_over_implied - 2).abs()
    q = q.sort_values(["date", "d2"]).groupby("date").head(1)
    return q.set_index("date")


# ---------------------------------------------------------------- 13:10 entry from the chain
def fly_cost(q, legs):
    try:
        r = q.loc[legs]
    except KeyError:
        return None
    sign, qty = np.array([1, -1, 1.0]), np.array([1, 2, 1.0])
    mid = float((sign * qty * r.mid.values).sum())
    H = float((qty * (r.ask.values - r.bid.values) / 2).sum())
    fee = float((qty * fills.leg_fee(r.mid.values, F)).sum())
    fee += sum(max(0.0, MIN_LEG - f) for f in fills.leg_fee(r.mid.values, F)[[0, 2]])  # qty-1 legs: order minimum
    return mid, H, fee


def day_1310(args):
    path, settle, spot = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    t = pd.Timestamp(f"{date.date()} 13:10")
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    if date >= WALL:                                       # TIME WALL: training period only
        return []
    s = df[(df.ts == t) & ~df.flag_bad & (df.right == "P")].set_index(["strike", "right"])[["bid", "ask", "mid"]]
    c = df[(df.ts == t) & ~df.flag_bad & (df.right == "C")].set_index(["strike", "right"])[["bid", "ask", "mid"]]
    if s.empty or c.empty:
        return []
    Kc = round(spot / 5) * 5
    try:
        implied = float(s.loc[(Kc, "P"), "mid"] + c.loc[(Kc, "C"), "mid"])
    except KeyError:
        return []
    out = []
    for w in WIDTHS:
        r = fly_cost(s, [(Kc - w, "P"), (Kc, "P"), (Kc + w, "P")])
        if r is None:
            continue
        mid, H, fee = r
        payoff = max(0.0, w - abs(settle - Kc))
        pnl20 = (payoff - mid - K * H) * F["multiplier"] - fee
        pnl05 = (payoff - mid - 0.5 * H) * F["multiplier"] - fee
        out.append(dict(date=date, entry="13:10", width=w, K=Kc, spot=spot, implied=implied,
                        w_over_implied=w / implied, cost=mid, payoff=payoff, pnl20=pnl20, pnl_k05=pnl05))
    return out


def build_1310(cal, dates, workers):
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    spot = spot[spot.ts < WALL]                            # TIME WALL
    spot = spot[spot.ts.dt.strftime("%H:%M") == "13:10"]
    spot = spot.set_index(spot.ts.dt.normalize())["spot"]
    jobs = []
    for d in dates:
        path = os.path.join(CLEAN, f"chain_{d.strftime('%Y%m%d')}.parquet")
        if os.path.exists(path) and d in spot.index:
            jobs.append((path, float(cal.loc[d, "settle"]), float(spot.loc[d])))
    rows = []
    with ProcessPoolExecutor(workers) as ex:
        for r in ex.map(day_1310, jobs, chunksize=8):
            rows += r
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- diagnostics
def jump_diag(cal, auct):
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    spot = spot[spot.ts < WALL]                            # TIME WALL
    spot["date"] = spot.ts.dt.normalize()
    spot["hm"] = spot.ts.dt.strftime("%H:%M")
    w = spot.pivot(index="date", columns="hm", values="spot")
    d = pd.DataFrame({"j0010": (w["13:10"] - w["13:00"]).abs(),
                      "j0030": (w["13:30"] - w["13:00"]).abs(),
                      "ctrl_1200": (w["12:10"] - w["12:00"]).abs(),
                      "ctrl_1400": (w["14:10"] - w["14:00"]).abs()})
    d = d.join(cal[["half_day", "fomc", "cpi", "nfp", "pce", "vix_prev_close"]], how="inner")
    d = d[~d.half_day]
    d["auction"] = d.index.isin(auct.index)
    d["weekday"] = d.index.day_name()
    d["event"] = d[["fomc", "cpi", "nfp", "pce"]].any(axis=1)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    p, cal = load_panel()
    auct = load_auctions()
    auct = auct[auct.index < WALL]                         # schedule rows outside training not needed

    # --- baseline replication (k=0.25 as in the ledger, then k=0.20 + minimum)
    b14 = baseline_rule(p, "14:00")
    b13 = baseline_rule(p, "13:00")
    rep = pd.DataFrame({"14:00 k0.25": [len(b14), (b14.pnl > 0).mean(), b14.pnl.mean()],
                        "14:00 k0.20+min": [len(b14), (b14.pnl20 > 0).mean(), b14.pnl20.mean()],
                        "13:00 k0.25": [len(b13), (b13.pnl > 0).mean(), b13.pnl.mean()],
                        "13:00 k0.20+min": [len(b13), (b13.pnl20 > 0).mean(), b13.pnl20.mean()]},
                       index=["n", "win", "ev"]).T
    print("== baseline replication (training)\n", rep.round(3).to_string())
    rep.to_csv(os.path.join(OUT, "baseline_replication.csv"))

    for b in (b13, b14):
        b["auction"] = b.index.isin(auct.index)
        b["long_end"] = b.index.map(lambda d: bool(auct.long_end.get(d, False)))
        b["weekday"] = b.index.day_name()
        b["event"] = b[["fomc", "cpi", "nfp", "pce"]].any(axis=1)
        b["year"] = b.index.year

    # --- D1/D3: jump diagnostics
    d = jump_diag(cal, auct)
    def ratio(x, col="j0010"):
        m = x.groupby("auction")[col].median()
        return pd.Series({"n_auct": int(x.auction.sum()), "n_non": int((~x.auction).sum()),
                          "med_auct": m.get(True, np.nan), "med_non": m.get(False, np.nan),
                          "ratio": m.get(True, np.nan) / m.get(False, np.nan),
                          "mean_auct": x[x.auction][col].mean(), "mean_non": x[~x.auction][col].mean()})
    diag = {"all 13:00-13:10": ratio(d), "all 13:00-13:30": ratio(d, "j0030"),
            "ctrl 12:00-12:10": ratio(d, "ctrl_1200"), "ctrl 14:00-14:10": ratio(d, "ctrl_1400"),
            "no macro-event days": ratio(d[~d.event])}
    for wd in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]:
        diag[wd] = ratio(d[d.weekday == wd])
    diag = pd.DataFrame(diag).T
    print("\n== D1/D3 |spot move| medians (points), auction vs non-auction, training\n", diag.round(3).to_string())
    diag.to_csv(os.path.join(OUT, "D1_jump.csv"))

    # --- D2: implied(13:00)/implied(14:00)
    i13 = p[(p.entry == "13:00") & (p.width == 25)].set_index("date").implied
    i14 = p[(p.entry == "14:00") & (p.width == 25)].set_index("date").implied
    r = (i13 / i14).dropna().to_frame("ratio").join(cal[["vix_prev_close"]])
    r["auction"] = r.index.isin(auct.index)
    r["vix_t"] = pd.qcut(r.vix_prev_close, 3, labels=["low", "mid", "high"])
    d2 = r.groupby("auction").ratio.agg(["count", "mean", "median"])
    d2t = r.groupby(["vix_t", "auction"], observed=True).ratio.agg(["count", "mean", "median"]).unstack("auction")
    print("\n== D2 implied(13:00)/implied(14:00), training\n", d2.round(4).to_string(), "\n", d2t.round(4).to_string())
    d2.to_csv(os.path.join(OUT, "D2_implied_ratio.csv")); d2t.to_csv(os.path.join(OUT, "D2_implied_ratio_by_vix.csv"))

    # --- P&L: 13:00 and 14:00 baseline-rule fly, auction vs non-auction
    tabs = {}
    for name, b in (("13:00", b13), ("14:00", b14)):
        tabs[f"{name} by auction"] = b.groupby("auction").apply(stats, include_groups=False)
        tabs[f"{name} by auction x year"] = b.groupby(["year", "auction"]).apply(stats, include_groups=False)
        tabs[f"{name} by auction x weekday"] = b.groupby(["weekday", "auction"]).apply(stats, include_groups=False)
        tabs[f"{name} no macro-event days"] = b[~b.event].groupby("auction").apply(stats, include_groups=False)
        tabs[f"{name} auction days: long_end"] = b[b.auction].groupby("long_end").apply(stats, include_groups=False)
    for k, v in tabs.items():
        print(f"\n== {k}\n", v.round(3).to_string())
        v.to_csv(os.path.join(OUT, k.replace(" ", "_").replace(":", "") + ".csv"))

    # --- slice 27: entry-to-settle distance (drift vs jump) at 14:00, by auction flag
    sd = b14.copy(); sd["settle_dist"] = (cal.loc[sd.index, "settle"].values - sd.spot.values); sd["abs_dist"] = sd.settle_dist.abs()
    sdt = sd.groupby("auction").agg(n=("abs_dist", "size"), med_abs=("abs_dist", "median"), mean_abs=("abs_dist", "mean"),
                                    mean_signed=("settle_dist", "mean"), med_implied=("implied", "median"))
    sdt["med_abs_over_implied"] = sd.assign(r=sd.abs_dist / sd.implied).groupby("auction").r.median()
    print("\n== slice 27: |settle - spot(14:00)| by auction (points)\n", sdt.round(3).to_string())
    sdt.to_csv(os.path.join(OUT, "settle_distance_1400.csv"))

    # --- 13:10 entries on auction days (and on all days, as control)
    f1310 = build_1310(cal, b13.index, a.workers)
    f1310 = f1310[f1310.width.isin(WIDTHS)].copy()
    f1310["d2"] = (f1310.w_over_implied - 2).abs()
    f1310 = f1310.sort_values(["date", "d2"]).groupby("date").head(1).set_index("date")
    f1310["auction"] = f1310.index.isin(auct.index)
    f1310.to_csv(os.path.join(OUT, "fly_1310.csv"))
    t = f1310.groupby("auction").apply(stats, include_groups=False)
    print("\n== 13:10 entry (same rule) by auction\n", t.round(3).to_string())
    t.to_csv(os.path.join(OUT, "1310_by_auction.csv"))

    # --- strategy variants vs the 13:00 all-days rule and the 14:00 baseline
    common = b13.index.intersection(b14.index)
    def variant(auction_entry):
        s = b13.loc[common].copy()
        if auction_entry == "13:10":
            idx = s.index[s.auction].intersection(f1310.index)
            s = s.loc[~s.auction].pnl20.rename("pnl20").to_frame().join(pd.DataFrame({"pnl_k05": s.loc[~s.auction].pnl_k05}))
            s = pd.concat([s, f1310.loc[idx, ["pnl20", "pnl_k05"]]])
        elif auction_entry == "14:00":
            s = pd.concat([s.loc[~s.auction, ["pnl20", "pnl_k05"]], b14.loc[s.index[s.auction], ["pnl20", "pnl_k05"]]])
        elif auction_entry == "skip":
            s = s.loc[~s.auction, ["pnl20", "pnl_k05"]]
        return s
    rows = {"13:00 all days (reference)": stats(b13.loc[common]), "14:00 all days (ledger baseline)": stats(b14.loc[common]),
            "V1 13:00 non-auction / 13:10 auction": stats(variant("13:10")),
            "V2 13:00 non-auction / 14:00 auction": stats(variant("14:00")),
            "V3 13:00 non-auction / skip auction": stats(variant("skip"))}
    v = pd.DataFrame(rows).T
    v["sum_pnl"] = [variant(x).pnl20.sum() if x else np.nan for x in ["", "", "13:10", "14:00", "skip"]]
    v.loc["13:00 all days (reference)", "sum_pnl"] = b13.loc[common].pnl20.sum()
    v.loc["14:00 all days (ledger baseline)", "sum_pnl"] = b14.loc[common].pnl20.sum()
    print("\n== strategy variants (training, k 0.20 + minimum)\n", v.round(3).to_string())
    v.to_csv(os.path.join(OUT, "variants.csv"))
    for name, fn in (("V1", "13:10"), ("V2", "14:00"), ("V3", "skip")):
        s = variant(fn); s["year"] = s.index.year
        yy = s.groupby("year").apply(stats, include_groups=False)
        print(f"\n== {name} by year\n", yy.round(3).to_string())
        yy.to_csv(os.path.join(OUT, f"{name}_by_year.csv"))
    ref = b13.loc[common].copy(); ref["year"] = ref.index.year
    print("\n== 13:00 reference by year\n", ref.groupby("year").apply(stats, include_groups=False).round(3).to_string())


if __name__ == "__main__":
    main()
