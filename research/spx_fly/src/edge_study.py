"""Step 2: implied vs realized, landing distribution, GEX regime.

    .venv/bin/python src/edge_study.py panel [--workers 6]   # build data/clean/edge_panel.parquet
    .venv/bin/python src/edge_study.py tables                # reports/step2_tables/*.csv, figures

Definitions (spec section 3):
- implied_move = mid of the ATM straddle at the entry minute, ATM = strike nearest spot
- realized_move = |official close - spot at entry|; ratio = realized / implied
- An ATM straddle is worth about E|move| under BS, so a mean ratio of 1 means fairly priced.

Half days are left out of every table: their entries are at a different distance to the close.
The first-30-minute split only exists for entries after 10:00, otherwise it looks ahead.
VIX quintiles use the whole sample's cut points: descriptive, not a tradable filter.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gex as G  # noqa: E402

ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])
TABLES = os.path.join(ROOT, CFG["paths"]["reports"], "step2_tables")
FIGS = os.path.join(ROOT, CFG["paths"]["reports"], "figs")
E = CFG["edge"]


# ---------------------------------------------------------------- panel

def entry_row(date, hhmm, snap, spot, settle, session_min_left):
    good = snap[~snap.flag_bad]
    c = good[good.right == "C"].set_index("strike").mid
    p = good[good.right == "P"].set_index("strike").mid
    both = c.index.intersection(p.index)
    if len(both) == 0:
        return None
    K = float(both[np.abs(both - spot).argmin()])
    implied = float(c[K] + p[K])
    w = float(G.solve_total_var(np.array([implied]), lambda x: G.black_straddle(spot, K, x))[0])
    rec = {"date": date, "entry": hhmm, "spot": spot, "K": K, "implied": implied, "settle": settle,
           "realized": abs(settle - spot), "w": w, "min_left": session_min_left,
           "iv_ann": np.sqrt(w / (session_min_left / (390 * 252))) if w == w else np.nan}
    pq = good[good.right == "P"].set_index("strike").mid
    for wd in E["fly_widths"]:
        if K - wd in pq.index and K + wd in pq.index and K in pq.index:
            rec[f"fly{wd}_mid"] = float(pq[K - wd] - 2 * pq[K] + pq[K + wd])
            rec[f"fly{wd}_pay"] = max(0.0, wd - abs(settle - K))
    return rec


def panel_day(args):
    path, settle, end_hhmm, spot_day = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path)
    end = pd.Timestamp(f"{date.date()} {end_hhmm}")
    out = []
    for hhmm in CFG["entries"]:
        t = pd.Timestamp(f"{date.date()} {hhmm}")
        if t >= end or t not in spot_day.index:
            continue
        r = entry_row(date, hhmm, df[df.ts == t], float(spot_day.loc[t]), settle, (end - t).total_seconds() / 60)
        if r:
            out.append(r)
    return out


def build_panel(workers):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        jobs.append((f, float(cal.loc[d, "settle"]), cal.loc[d, "session_end"], spot[spot.index.normalize() == d]))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(panel_day, jobs, chunksize=8) for r in day]
    p = pd.DataFrame(rows)
    p["ratio"] = p.realized / p.implied
    p.to_parquet(os.path.join(CLEAN, "edge_panel.parquet"), index=False)
    print(len(p), "rows", p.date.nunique(), "days")


# ---------------------------------------------------------------- stats

def boot_ci(x, rng):
    x = np.asarray(x)
    if len(x) < 5:
        return np.nan, np.nan
    idx = rng.integers(0, len(x), (E["bootstrap_n"], len(x)))
    m = x[idx].mean(axis=1)
    return float(np.quantile(m, .025)), float(np.quantile(m, .975))


def summarize(g, rng):
    r = g.ratio.dropna().values
    lo, hi = boot_ci(r, rng)
    return pd.Series({"n": len(r), "mean": r.mean(), "ci_lo": lo, "ci_hi": hi, "median": np.median(r),
                      "p25": np.quantile(r, .25), "p75": np.quantile(r, .75), "p90": np.quantile(r, .9),
                      "ratio_of_means": g.realized.sum() / g.implied.sum(), "share_lt_1": (r < 1).mean(),
                      "edge_pts": (g.implied - g.realized).mean(), "implied_avg": g.implied.mean()})


def group_table(p, col, rng):
    t = p.dropna(subset=[col]).groupby(["entry", col], observed=True).apply(lambda g: summarize(g, rng), include_groups=False)
    return t.round(3)


def bs_prob_within(spot, w, x):
    s = np.sqrt(w)
    hi = (np.log((spot + x) / spot) + w / 2) / s
    lo = (np.log((spot - x) / spot) + w / 2) / s
    return ndtr(hi) - ndtr(lo)


def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    ph = k / n
    d = 1 + z * z / n
    c = (ph + z * z / (2 * n)) / d
    h = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def landing_table(p, by=None):
    rows = []
    groups = p.groupby(["entry"] + ([by] if by else []), observed=True)
    for key, g in groups:
        key = key if isinstance(key, tuple) else (key,)
        g = g.dropna(subset=["w"])
        for x in E["landing_bands"]:
            hit = (g.realized <= x)
            lo, hi = wilson(int(hit.sum()), len(g))
            rows.append(dict(zip(["entry"] + ([by] if by else []), key)) | {
                "band": x, "n": len(g), "actual": hit.mean(), "ci_lo": lo, "ci_hi": hi,
                "bs": bs_prob_within(g.spot.values, g.w.values, x).mean()})
    t = pd.DataFrame(rows)
    t["actual_minus_bs"] = t.actual - t.bs
    return t.round(4)


def implied_band_table(p):
    rows = []
    for e, g in p.dropna(subset=["w"]).groupby("entry"):
        for u in E["implied_bands"]:
            hit = g.realized <= u * g.implied
            lo, hi = wilson(int(hit.sum()), len(g))
            rows.append({"entry": e, "band_x_implied": u, "n": len(g), "actual": hit.mean(), "ci_lo": lo, "ci_hi": hi,
                         "bs": bs_prob_within(g.spot.values, g.w.values, u * g.implied.values).mean()})
    t = pd.DataFrame(rows)
    t["actual_minus_bs"] = t.actual - t.bs
    return t.round(4)


def fly_table(p, rng, by=None):
    """Average settlement payoff against the mid paid: the market's own price for that
    range, smile included, where the BS comparison above assumes flat vol. Before any cost."""
    rows = []
    for key, g in p.groupby(["entry"] + ([by] if by else []), observed=True):
        key = key if isinstance(key, tuple) else (key,)
        for wd in E["fly_widths"]:
            s = g.dropna(subset=[f"fly{wd}_mid"])
            if len(s) < 5:
                continue
            pnl = (s[f"fly{wd}_pay"] - s[f"fly{wd}_mid"]).values
            lo, hi = boot_ci(pnl, rng)
            rows.append(dict(zip(["entry"] + ([by] if by else []), key)) | {
                "width": wd, "n": len(s), "mid": s[f"fly{wd}_mid"].mean(), "payoff": s[f"fly{wd}_pay"].mean(),
                "edge_pts": pnl.mean(), "ci_lo": lo, "ci_hi": hi, "edge_pct_of_mid": pnl.mean() / s[f"fly{wd}_mid"].mean(),
                "win_rate": (pnl > 0).mean()})
    return pd.DataFrame(rows).round(3)


def add_regimes(p):
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    gx = pd.read_parquet(os.path.join(CLEAN, "gex_daily.parquet"))
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet")).set_index("ts").spot
    p = p.merge(cal.drop(columns=["settle"]), left_on="date", right_index=True).merge(gx, left_on="date", right_index=True, how="left")
    p = p[~p.half_day].copy()
    p["year"] = p.date.dt.year
    p["weekday"] = p.date.dt.day_name().str[:3]
    p["vix_q"] = pd.qcut(p.vix_prev_close, 5, labels=["Q1 low", "Q2", "Q3", "Q4", "Q5 high"])
    p["vix_t"] = pd.qcut(p.vix_prev_close, 3, labels=["low", "mid", "high"])
    big = E["prev_ret_big"]
    p["prev_ret"] = np.select([p.spx_ret_prev >= big, p.spx_ret_prev <= -big], ["big up", "big down"], "flat")
    p.loc[p.spx_ret_prev.isna(), "prev_ret"] = None

    ev = p[["fomc", "cpi", "nfp", "pce", "triple_witching"]]
    p["event"] = np.select([p.fomc, p.cpi, p.nfp, p.pce, p.triple_witching, p.opex],
                           ["FOMC", "CPI", "NFP", "PCE", "triple witching", "monthly opex"], "none")

    # First 30 minutes: range against the 09:35 implied move, so it does not just restate VIX.
    first = spot[(spot.index.time >= pd.Timestamp("09:30").time()) & (spot.index.time <= pd.Timestamp("10:00").time())]
    rng_30 = first.groupby(first.index.normalize()).agg(lambda s: s.max() - s.min())
    i935 = p[p.entry == "09:35"].set_index("date").implied
    rel = (rng_30 / i935).rename("rel30")
    p = p.merge(rel, left_on="date", right_index=True, how="left")
    p["first30"] = np.where(p.entry == "09:35", None, np.where(p.rel30 >= rel.median(), "high", "low"))
    p.loc[p.rel30.isna(), "first30"] = None

    # Days after a half day have almost no closing quotes and a few days have partial OI:
    # their GEX is an undercount, so they get no gamma label.
    med = gx[["n_strikes", "oi_total"]].rolling(61, center=True, min_periods=20).median()
    gx_bad = (gx.n_strikes < 0.5 * med.n_strikes) | (gx.oi_total < 0.7 * med.oi_total)
    print("days without a gamma label:", int(gx_bad.sum()), [d.strftime("%Y-%m-%d") for d in gx.index[gx_bad]])
    p.loc[p.date.isin(gx.index[gx_bad]), ["gex_total", "zero_gamma", "call_wall", "put_wall"]] = np.nan

    # Levels are fixed before the open; which side you are on is judged at the entry minute.
    side = np.where(p.zero_gamma.notna(), p.spot >= p.zero_gamma, p.gex_total > 0)
    p["gamma_side"] = np.where(side, "above zero gamma", "below zero gamma")
    p.loc[p.gex_total.isna(), "gamma_side"] = None
    prev = np.where(p.zero_gamma.notna(), p.spot_prev >= p.zero_gamma, p.gex_total > 0)
    p["gamma_side_prev"] = np.where(prev, "above zero gamma", "below zero gamma")
    p.loc[p.gex_total.isna(), "gamma_side_prev"] = None
    dist = np.minimum((p.call_wall - p.spot).abs(), (p.spot - p.put_wall).abs()) / p.spot
    p["wall_dist_pct"] = dist * 100
    p["wall_t"] = pd.qcut(p.wall_dist_pct, 3, labels=["near", "mid", "far"])
    return p


def figures(p):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(FIGS, exist_ok=True)
    fig, ax = plt.subplots(1, 4, figsize=(15, 3.2), sharey=True)
    for a, (e, g) in zip(ax, p.groupby("entry")):
        a.hist(g.ratio.clip(upper=4), bins=40, color="#4477aa")
        a.axvline(1, color="k", lw=1)
        a.set_title(f"{e}  mean {g.ratio.mean():.2f}  median {g.ratio.median():.2f}")
        a.set_xlabel("realized / implied")
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, "step2_ratio_hist.png"), dpi=130); plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 3.6))
    t = p.groupby(["year", "entry"]).ratio.mean().unstack()
    t.plot(ax=ax, marker="o"); ax.axhline(1, color="k", lw=1); ax.set_ylabel("mean ratio"); fig.tight_layout()
    fig.savefig(os.path.join(FIGS, "step2_ratio_by_year.png"), dpi=130); plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 3.6))
    t = p.groupby(["entry", "gamma_side"]).ratio.mean().unstack()
    t.plot.bar(ax=ax); ax.axhline(1, color="k", lw=1); ax.set_ylabel("mean ratio"); fig.tight_layout()
    fig.savefig(os.path.join(FIGS, "step2_ratio_gamma.png"), dpi=130); plt.close(fig)


def tables():
    os.makedirs(TABLES, exist_ok=True)
    p = add_regimes(pd.read_parquet(os.path.join(CLEAN, "edge_panel.parquet")))
    rng = np.random.default_rng(E["seed"])
    out = {}
    out["overall"] = p.groupby("entry").apply(lambda g: summarize(g, rng), include_groups=False).round(3)
    for col in ["year", "vix_q", "event", "prev_ret", "weekday", "first30", "gamma_side", "gamma_side_prev", "wall_t"]:
        out[f"by_{col}"] = group_table(p, col, rng)
    # gamma side inside each VIX tercile and year: positive gamma days are also calm days
    p["vix_gamma"] = p.vix_t.astype(str) + " / " + p.gamma_side.astype(str)
    p["year_gamma"] = p.year.astype(str) + " / " + p.gamma_side.astype(str)
    p.loc[p.gamma_side.isna(), ["vix_gamma", "year_gamma"]] = None
    out["vix_gamma"] = group_table(p, "vix_gamma", rng)
    out["year_gamma"] = group_table(p, "year_gamma", rng)
    out["landing"] = landing_table(p).set_index(["entry", "band"])
    out["landing_year"] = landing_table(p, "year").set_index(["entry", "year", "band"])
    out["landing_implied"] = implied_band_table(p).set_index(["entry", "band_x_implied"])
    out["fly"] = fly_table(p, rng).set_index(["entry", "width"])
    out["fly_year"] = fly_table(p, rng, "year").set_index(["entry", "year", "width"])
    out["fly_gamma"] = fly_table(p, rng, "gamma_side").set_index(["entry", "gamma_side", "width"])
    out["fly_vix"] = fly_table(p, rng, "vix_t").set_index(["entry", "vix_t", "width"])
    # Above minus below zero gamma, paired by nothing: bootstrap the difference of means
    rows = []
    for col in ("gamma_side", "gamma_side_prev"):
        for e, g in p.dropna(subset=[col]).groupby("entry"):
            a_, b_ = [g[g[col] == s].ratio.values for s in ("above zero gamma", "below zero gamma")]
            d = (rng.choice(a_, (E["bootstrap_n"], len(a_))).mean(1) - rng.choice(b_, (E["bootstrap_n"], len(b_))).mean(1))
            rows.append({"label": col, "entry": e, "above": a_.mean(), "below": b_.mean(), "diff": a_.mean() - b_.mean(),
                         "ci_lo": np.quantile(d, .025), "ci_hi": np.quantile(d, .975), "n_above": len(a_), "n_below": len(b_)})
    out["gamma_diff"] = pd.DataFrame(rows).set_index(["label", "entry"]).round(3)
    for k, t in out.items():
        t.to_csv(os.path.join(TABLES, k + ".csv"))
    figures(p)
    p[["date", "entry", "ratio", "vix_t", "gamma_side", "wall_t", "event"]].to_parquet(os.path.join(CLEAN, "edge_labels.parquet"), index=False)
    print("tables:", sorted(out))


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["panel", "tables"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    build_panel(x.workers) if x.cmd == "panel" else tables()
