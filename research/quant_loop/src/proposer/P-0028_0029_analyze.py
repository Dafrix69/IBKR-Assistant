"""P-0028 / P-0029 training evidence (2022-05-02 -> 2026-10-29, already-seen data) + reproduction checks.

    research/spx_fly/.venv/bin/python src/proposer/P-0028_0029_analyze.py > src/proposer/P-0028_0029_tables/analyze_out.txt
"""
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("rules", os.path.join(HERE, "P-0028_0029_rules.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

CACHE = os.path.join(HERE, "P-0028_0029_cache")
TAB = os.path.join(HERE, "P-0028_0029_tables")
KS = (0.0, 0.2, 0.5, 1.0)
SEED = 20261109
NBOOT = 10000

snap = pd.read_parquet(os.path.join(CACHE, "snap_1400.parquet"))
snap = snap[(snap.date >= "2022-05-02") & (snap.date <= "2026-10-29")]        # TIME WALL: first data step
days = pd.read_parquet(os.path.join(CACHE, "days.parquet"))
days = days[(days.date >= "2022-05-02") & (days.date <= "2026-10-29")]        # TIME WALL
days = days.set_index("date").sort_index()
books = {d: R.book(g) for d, g in snap.groupby("date")}
dates = list(days.index)
last_of_month = set(pd.Series(dates).groupby(pd.Series(dates).dt.to_period("M")).max())


# ------------------------------------------------------------------ stats
def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def block_boot(dates_, x, nboot=NBOOT, mean_block=4, seed=SEED):
    """Stationary bootstrap over ISO weeks (Politis-Romano), mean block 4 weeks. Returns array of resampled day-means."""
    iso = pd.DatetimeIndex(dates_).isocalendar()
    wk = (iso.year.astype(int) * 100 + iso.week.astype(int)).values
    df = pd.DataFrame({"wk": wk, "x": x}).groupby("wk").x.agg(["sum", "count"])
    s, c = df["sum"].values, df["count"].values
    W = len(s)
    rng = np.random.default_rng(seed)
    idx = np.empty((nboot, W), dtype=np.int64)
    idx[:, 0] = rng.integers(0, W, nboot)
    new = rng.random((nboot, W)) < 1.0 / mean_block
    starts = rng.integers(0, W, (nboot, W))
    for j in range(1, W):
        idx[:, j] = np.where(new[:, j], starts[:, j], (idx[:, j - 1] + 1) % W)
    return s[idx].sum(1) / c[idx].sum(1)


def summarize(t, label, kmain=0.5):
    """t: DataFrame indexed by date with pnl_k0, pnl_k0.2, pnl_k0.5, pnl_k1 (+ cost cols)."""
    n = len(t)
    out = {"set": label, "n": n}
    for k in (0.2, 0.5):
        w = int((t[f"pnl_k{k}"] > 0).sum())
        lo, hi = wilson(w, n)
        out[f"win_k{k}"] = f"{w / n:.1%} [{lo:.1%},{hi:.1%}]"
    for k in KS:
        out[f"mean_k{k}"] = round(t[f"pnl_k{k}"].mean(), 1)
    for k in KS:
        b = block_boot(t.index, t[f"pnl_k{k}"].values)
        out[f"ci95_k{k}"] = f"[{np.percentile(b, 2.5):+.0f},{np.percentile(b, 97.5):+.0f}]"
        out[f"ci975_k{k}"] = f"[{np.percentile(b, 1.25):+.0f},{np.percentile(b, 98.75):+.0f}]"
        out[f"p1_k{k}"] = round(float((b <= 0).mean()), 4)
    x = t[f"pnl_k{kmain}"]
    out["drop_best5_k0.5"] = round(x.sort_values().iloc[:-5].mean(), 1) if n > 5 else np.nan
    out["worst_day_k0.5"] = f"{x.min():.0f} ({x.idxmin().date()})"
    out["sd_k0.5"] = round(x.std(), 0)
    return out


def by_cols(t, label):
    rows = []
    g = t.copy()
    g["year"] = g.index.year
    for y, s in g.groupby("year"):
        rows.append({"set": label, "cut": str(y), "n": len(s), "win_k0.5": round((s["pnl_k0.5"] > 0).mean(), 3),
                     **{f"mean_k{k}": round(s[f"pnl_k{k}"].mean(), 1) for k in KS}})
    g["dow"] = g.index.day_name().str[:3]
    g["eom"] = g.index.isin(last_of_month)
    for dw, s in g.groupby("dow"):
        rows.append({"set": label, "cut": dw, "n": len(s), "win_k0.5": round((s["pnl_k0.5"] > 0).mean(), 3),
                     **{f"mean_k{k}": round(s[f"pnl_k{k}"].mean(), 1) for k in KS}})
    s = g[g.eom]
    rows.append({"set": label, "cut": "EOM", "n": len(s), "win_k0.5": round((s["pnl_k0.5"] > 0).mean(), 3),
                 **{f"mean_k{k}": round(s[f"pnl_k{k}"].mean(), 1) for k in KS}})
    return rows


# ------------------------------------------------------------------ H1
h1, h1_skip = [], {}
for d in dates:
    r = days.loc[d]
    def skip(why):
        h1_skip[why] = h1_skip.get(why, 0) + 1
    if r.half_day:
        skip("half_day"); continue
    if np.isnan(r.prev_ret):
        skip("no_prev_ret"); continue
    if r.prev_ret <= -0.01:
        skip("prev_ret<=-1%"); continue
    bk = books.get(d, {})
    st, K, I, w = R.h1_pick(bk, r.spot_u)
    if st != "ok":
        skip(st); continue
    row = {"date": d, "K": K, "I": I, "w": w, "spot": r.spot_u, "settle": r.settle, "w_over_I": w / I}
    for k in KS:
        p, info = R.h1_pnl(bk, K, w, r.settle, k, "iron")
        row[f"pnl_k{k}"] = p
    row.update(H=info["H"], fee=info["fee"], credit=info["credit"])
    pf = R.h1_pnl(bk, K, w, r.settle, 0.5, "put")
    row["pf_ok"] = pf is not None
    for k in KS:
        x = R.h1_pnl(bk, K, w, r.settle, k, "put")
        row[f"pf_pnl_k{k}"] = x[0] if x is not None else np.nan
    if pf is not None:
        row.update(pf_H=pf[1]["H"], pf_fee=pf[1]["fee"])
    h1.append(row)
h1 = pd.DataFrame(h1).set_index("date")
h1.to_parquet(os.path.join(CACHE, "h1_trades.parquet"))

# ------------------------------------------------------------------ H2
h2, h2_skip, h2_ncand = [], {}, []
for d in dates:
    r = days.loc[d]
    if r.half_day:
        h2_skip["half_day"] = h2_skip.get("half_day", 0) + 1; continue
    bk = books.get(d, {})
    c = R.h2_candidates(bk, r.spot_u)
    h2_ncand.append(len(c))
    pick = R.h2_pick(c)
    if pick is None:
        h2_skip["no_candidate"] = h2_skip.get("no_candidate", 0) + 1; continue
    row = {"date": d, "K": pick["K"], "credit": pick["credit"], "dist": pick["K"] - r.spot_u, "spot": r.spot_u,
           "settle": r.settle, "H": pick["H"], "n_cand": len(c)}
    for k in KS:
        row[f"pnl_k{k}"], row["fee"] = R.h2_pnl(pick, r.settle, k)
    I = R.atm(bk, r.spot_u)
    row["I"] = I[1] if I is not None else np.nan
    h2.append(row)
h2 = pd.DataFrame(h2).set_index("date")
h2.to_parquet(os.path.join(CACHE, "h2_trades.parquet"))


def mwf(t):
    return t[t.index.day_of_week.isin([0, 2, 4])]


def mirror(t):
    return t[t.index.day_of_week.isin([0, 2, 4]) | t.index.isin(last_of_month)]


pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 40)
print("=== H1 (P-0028) primary: short iron fly, 14:00, w in {20,25,30,50,75} closest to 2*I, skip prev <= -1 %")
print("skips:", h1_skip, "| traded:", len(h1), "| of", len(dates), "0DTE days")
pfh1 = h1[h1.pf_ok].rename(columns={f"pf_pnl_k{k}": f"pnl_k{k}" for k in KS}, errors="ignore")
pfh1 = pfh1[[f"pnl_k{k}" for k in KS]] if False else h1[h1.pf_ok][[f"pf_pnl_k{k}" for k in KS]].rename(columns=lambda c: c[3:])
rows = [summarize(h1, "H1 iron ALL"), summarize(mwf(h1), "H1 iron MWF"), summarize(mirror(h1), "H1 iron MWF+EOM"),
        summarize(pfh1, "H1 putfly ALL"), summarize(mwf(pfh1), "H1 putfly MWF")]
S1 = pd.DataFrame(rows).set_index("set")
print(S1.T.to_string())
print("put fly unavailable at the chosen (K, w):", int((~h1.pf_ok).sum()), "days")
B1 = pd.DataFrame(by_cols(h1, "H1 iron ALL") + by_cols(mwf(h1), "H1 iron MWF") + by_cols(pfh1, "H1 putfly ALL"))
print(B1.to_string(index=False))
print("width chosen (ALL):", h1.w.value_counts().sort_index().to_dict(), "| MWF:", mwf(h1).w.value_counts().sort_index().to_dict())
print("w/I: median %.2f, share < 1.5: %.1f%%" % (h1.w_over_I.median(), 100 * (h1.w_over_I < 1.5).mean()),
      "| I median %.1f, 90%% %.1f, max %.1f" % (h1.I.median(), h1.I.quantile(.9), h1.I.max()))
for lab, t in (("ALL", h1), ("MWF", mwf(h1))):
    print(f"cost/lot {lab}: H median {t.H.median():.2f} pts mean {t.H.mean():.2f}; fee mean {t.fee.mean():.2f}; "
          f"E(k0.2)={0.2 * t.H.mean() * 100 + t.fee.mean():.1f}  E(k0.5)={0.5 * t.H.mean() * 100 + t.fee.mean():.1f}  E(k1)={t.H.mean() * 100 + t.fee.mean():.1f} USD"
          f" | putfly E(k0.5)={0.5 * t.pf_H.mean() * 100 + t.pf_fee.mean():.1f}")
for y, t in h1.groupby(h1.index.year):
    print(f"  {y}: H median {t.H.median():.2f}, mean {t.H.mean():.2f}, E(k0.5) {0.5 * t.H.mean() * 100 + t.fee.mean():.1f}")

print()
print("=== H2 (P-0029) primary: bear call 15 wide, 14:00, mid credit in (3,4] closest to 3.5, tie -> higher K")
print("skips:", h2_skip, "| traded:", len(h2), "| candidates per day:", pd.Series(h2_ncand).value_counts().sort_index().to_dict())
rows = [summarize(h2, "H2 ALL"), summarize(mwf(h2), "H2 MWF"), summarize(mirror(h2), "H2 MWF+EOM")]
S2 = pd.DataFrame(rows).set_index("set")
print(S2.T.to_string())
B2 = pd.DataFrame(by_cols(h2, "H2 ALL") + by_cols(mwf(h2), "H2 MWF"))
print(B2.to_string(index=False))
print("short strike OTM distance: median %.1f, IQR %.1f-%.1f; dist/I median %.2f; K < spot: %d days" % (
    h2.dist.median(), h2.dist.quantile(.25), h2.dist.quantile(.75), (h2.dist / h2.I).median(), int((h2.dist < 0).sum())))
for lab, t in (("ALL", h2), ("MWF", mwf(h2))):
    print(f"cost/lot {lab}: H median {t.H.median():.2f} mean {t.H.mean():.2f}; fee {t.fee.mean():.2f}; "
          f"E(k0.2)={0.2 * t.H.mean() * 100 + t.fee.mean():.1f} E(k0.5)={0.5 * t.H.mean() * 100 + t.fee.mean():.1f}")
print("H2 skipped days by year:", {y: int(n) for y, n in pd.Series([d for d in dates if d not in h2.index and not days.loc[d].half_day]).dt.year.value_counts().sort_index().items()})

S1.to_csv(os.path.join(TAB, "h1_summary.csv")); B1.to_csv(os.path.join(TAB, "h1_by.csv"), index=False)
S2.to_csv(os.path.join(TAB, "h2_summary.csv")); B2.to_csv(os.path.join(TAB, "h2_by.csv"), index=False)


# ------------------------------------------------------------------ what an A-hist-sized sample of the MWF training looks like
def boot_W(dates_, x, W, nboot=NBOOT, mean_block=4, seed=SEED + 1):
    iso = pd.DatetimeIndex(dates_).isocalendar()
    wk = (iso.year.astype(int) * 100 + iso.week.astype(int)).values
    df = pd.DataFrame({"wk": wk, "x": x}).groupby("wk").x.agg(["sum", "count"])
    s, c = df["sum"].values, df["count"].values
    n = len(s)
    rng = np.random.default_rng(seed)
    idx = np.empty((nboot, W), dtype=np.int64)
    idx[:, 0] = rng.integers(0, n, nboot)
    new = rng.random((nboot, W)) < 1.0 / mean_block
    starts = rng.integers(0, n, (nboot, W))
    for j in range(1, W):
        idx[:, j] = np.where(new[:, j], starts[:, j], (idx[:, j - 1] + 1) % n)
    return s[idx].sum(1) / c[idx].sum(1)


W_AHIST = 122   # ISO weeks from 2020-01-03 to 2022-04-29 (pd.bdate_range count, no A-hist data read)
print()
print(f"=== MWF training resampled to an A-hist-sized sample ({W_AHIST} ISO weeks, stationary blocks of 4)")
for lab, t in (("H1 iron MWF", mwf(h1)), ("H1 iron MWF+EOM", mirror(h1)), ("H2 MWF", mwf(h2)), ("H2 MWF+EOM", mirror(h2))):
    for k in (0.0, 0.2, 0.5, 1.0):
        b = boot_W(t.index, t[f"pnl_k{k}"].values, W_AHIST)
        se = b.std()
        print(f"{lab} k{k}: mean {t[f'pnl_k{k}'].mean():+.1f}; A-hist-size 95% range [{np.percentile(b, 2.5):+.0f},{np.percentile(b, 97.5):+.0f}], SE {se:.0f}; "
              f"P(mean>0) {np.mean(b > 0):.2f}; P(mean > 2.24*SE) {np.mean(b > 2.24 * se):.2f}")

# ------------------------------------------------------------------ P&L-free mechanism diagnostics (report items)
print()
for lab, t in (("H1 ALL", h1), ("H1 MWF", mwf(h1))):
    ratio = (t.settle - t.spot).abs() / t.I
    print(f"{lab}: mean |settle - spot_14|/I = {ratio.mean():.3f} (median {ratio.median():.3f}); "
          f"P(|settle-K| < w) = {((t.settle - t.K).abs() < t.w).mean():.3f}; mean credit/w = {(t.credit / t.w).mean():.3f}; "
          f"mean min(|settle-K|,w)/w = {(np.minimum((t.settle - t.K).abs(), t.w) / t.w).mean():.3f}")
for lab, t in (("H2 ALL", h2), ("H2 MWF", mwf(h2))):
    print(f"{lab}: P(settle > K_short) = {(t.settle > t.K).mean():.3f}; mean credit/15 = {(t.credit / 15).mean():.3f}; "
          f"mean loss/15 = {(np.clip(t.settle - t.K, 0, 15) / 15).mean():.3f}; mean (settle - spot_14) = {(t.settle - t.spot).mean():+.2f} pts")
