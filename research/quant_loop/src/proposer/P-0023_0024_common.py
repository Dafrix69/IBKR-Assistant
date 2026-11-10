"""Shared reader / cache builder for P-0023 (IVOL) and P-0024 (VOV), round 23, B-pools.

TIME WALL: training = entry AND exit < 2023-10-31. Only the five pools 2018-10-31 .. 2022-10-31
are ever listed or opened; within them every file dated >= 2023-10-31 is skipped before it is
opened, and the concatenated frame is filtered again as the first step after reading.
The 2023-10-31 and 2024-10-31 pools are never touched.

Raw data: ~/Data/thetadata_univ_<sel>/<SYM>/greeks_eod/<YYYY>/<YYYYMMDD>.csv.gz
Cache (ThetaData licence, not for the repo): src/proposer/P-0023_0024_cache/
"""
import os, glob, sys
import numpy as np
import pandas as pd
from multiprocessing import Pool

WALL = pd.Timestamp("2023-10-31")          # entry AND exit must be < WALL
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031"]   # training pools only
NEXT_SEL = {"20181031": "20191031", "20191031": "20201030", "20201030": "20211029",
            "20211029": "20221031", "20221031": "20231031"}
HOME = os.path.expanduser("~")
QL = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop"
UNIV = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/call_spread_edge/universe"
CACHE = os.path.join(QL, "src/proposer/P-0023_0024_cache")
DEFECTS = os.path.join(QL, "data/pools_defects.csv")
COLS = ["expiration", "strike", "right", "bid", "ask", "delta", "implied_vol", "iv_error", "underlying_price"]


def universe(pool):
    assert pool in POOLS, pool
    with open(os.path.join(UNIV, f"UNIVERSE_{pool}.txt")) as f:
        return [s.strip() for s in f.read().replace("\n", ",").split(",") if s.strip()]


def monthly_expiries(exps):
    """Third-Friday monthly expiries (Thursday when the Friday is a holiday) among `exps`."""
    out = []
    s = pd.Series(sorted(set(pd.to_datetime(exps))))
    for (y, m), g in s.groupby([s.dt.year, s.dt.month]):
        # third Friday is always on day 15..21; when it is a holiday the monthly moves to Thursday (day 14..20)
        fri = g[(g.dt.day >= 15) & (g.dt.day <= 21) & (g.dt.day_of_week == 4)]
        thu = g[(g.dt.day >= 14) & (g.dt.day <= 20) & (g.dt.day_of_week == 3)]
        if len(fri):
            out.append(fri.iloc[0])
        elif len(thu):
            out.append(thu.iloc[0])
    return out


def _load_symbol(args):
    pool, sym = args
    base = os.path.join(HOME, f"Data/thetadata_univ_{pool}", sym, "greeks_eod")
    files = sorted(glob.glob(os.path.join(base, "*", "*.csv.gz")))
    # --- time wall on the file list: never open a file dated >= 2023-10-31 ---
    files = [f for f in files if pd.Timestamp(os.path.basename(f)[:8]) < WALL]
    frames = []
    for f in files:
        d = pd.Timestamp(os.path.basename(f)[:8])
        try:
            x = pd.read_csv(f, usecols=COLS)
        except Exception:
            continue
        x["date"] = d
        frames.append(x)
    if not frames:
        return pool, sym, None
    df = pd.concat(frames, ignore_index=True)
    # --- time wall, first step after reading ---
    df = df[df["date"] < WALL]
    df["expiration"] = pd.to_datetime(df["expiration"])
    df = df[df["expiration"] < WALL + pd.Timedelta(days=60)]  # rows themselves are all < WALL by date
    df["right"] = df["right"].str[0]
    return pool, sym, df


def _summaries(pool, sym, df):
    """Reduce one symbol's raw rows to (a) spot series, (b) monthly near-money quotes,
    (c) per-expiry ATM IV for the VOV signal, (d) data-check stats, (e) implied-rate samples."""
    spot = df.groupby("date")["underlying_price"].first().rename("S").to_frame()
    df = df.join(spot, on="date")
    df["dte"] = (df["expiration"] - df["date"]).dt.days
    # (b) monthly expiries, strikes within +-35% of spot, both rights
    mexp = monthly_expiries(df["expiration"].unique())
    mon = df[df["expiration"].isin(mexp) & ((df["strike"] / df["S"] - 1).abs() <= 0.35)].copy()
    mon = mon[["date", "expiration", "strike", "right", "bid", "ask", "delta", "implied_vol", "iv_error", "S", "dte"]]
    # (c) ATM IV per (date, expiry): ThetaData implied_vol, quotes sane, IV valid,
    #     linear interpolation in strike at K = S, call and put averaged when both exist
    ok = (df["bid"] > 0) & (df["ask"] > df["bid"]) & ((df["ask"] - df["bid"]) / ((df["ask"] + df["bid"]) / 2) <= 0.5) \
         & (df["implied_vol"] > 0) & (df["implied_vol"] <= 10) & (df["iv_error"].abs() < 0.01) & (df["dte"] >= 1)
    q = df[ok & ((df["strike"] / df["S"] - 1).abs() <= 0.25)]
    rows = []
    for (d, e, r), g in q.groupby(["date", "expiration", "right"], sort=False):
        S = g["S"].iloc[0]
        lo = g[g["strike"] <= S]
        hi = g[g["strike"] >= S]
        if len(lo) == 0 or len(hi) == 0:
            continue
        a = lo.loc[lo["strike"].idxmax()]
        b = hi.loc[hi["strike"].idxmin()]
        if b["strike"] == a["strike"]:
            iv = a["implied_vol"]
        else:
            w = (S - a["strike"]) / (b["strike"] - a["strike"])
            iv = (1 - w) * a["implied_vol"] + w * b["implied_vol"]
        if (b["strike"] - a["strike"]) / S > 0.25:
            continue
        rows.append((d, e, r, iv))
    atm = pd.DataFrame(rows, columns=["date", "expiration", "right", "iv"])
    atm = atm.groupby(["date", "expiration"])["iv"].mean().rename("atm_iv").reset_index()
    atm["dte"] = (atm["expiration"] - atm["date"]).dt.days
    # (d) data checks: day jumps, strike-grid kept fraction for common expiries, zero closes
    sp = spot["S"]
    jump = (sp / sp.shift(1) - 1)
    grid = {}
    for (d, e), g in df.groupby(["date", "expiration"]):
        grid[(d, e)] = set(np.round(g["strike"].values, 4))
    dates = list(sp.index)
    chk = []
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        kept = []
        for (dd, e), ks in grid.items():
            if dd != d0 or e <= d1:
                continue
            k1 = grid.get((d1, e))
            if k1 is None or len(ks) < 6:
                continue
            kept.append((e, len(ks & k1) / len(ks)))
        mink = min([k for _, k in kept]) if kept else np.nan
        chk.append((d1, d0, jump.loc[d1], mink, len(kept)))
    chk = pd.DataFrame(chk, columns=["date", "prev_date", "jump", "min_kept", "n_common_exp"])
    zero = sp[(sp <= 0) | sp.isna()]
    # (e) implied-rate samples from ThetaData call deltas (to recover the rate it uses)
    c = df[ok & (df["right"] == "C") & (df["dte"] >= 20) & ((df["strike"] / df["S"] - 1).abs() <= 0.05)
           & (df["delta"] > 0.05) & (df["delta"] < 0.95)].copy()
    from scipy.stats import norm
    T = c["dte"] / 365.0
    d1 = norm.ppf(c["delta"])
    c["r"] = (d1 * c["implied_vol"] * np.sqrt(T) - np.log(c["S"] / c["strike"])) / T - c["implied_vol"] ** 2 / 2
    rr = c.groupby("date")["r"].median().rename("r").reset_index()
    return spot.reset_index(), mon, atm, chk, zero, rr


def build_pool(pool, nproc=8):
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, f"pool_{pool}.pkl")
    if os.path.exists(out):
        return pd.read_pickle(out)
    syms = universe(pool)
    res = {}
    with Pool(nproc) as p:
        for pl, sym, df in p.imap_unordered(_load_symbol, [(pool, s) for s in syms]):
            if df is None:
                print(f"[{pool}] {sym}: no data", flush=True)
                continue
            res[sym] = _summaries(pl, sym, df)
            print(f"[{pool}] {sym}: {df['date'].nunique()} days, max date {df['date'].max().date()}", flush=True)
    pd.to_pickle(res, out)
    return res


def load_defects():
    d = pd.read_csv(DEFECTS, dtype={"pool": str})
    d["day"] = pd.to_datetime(d["day"])
    return d[d["pool"].isin(POOLS)]


if __name__ == "__main__":
    for pl in (sys.argv[1:] or POOLS):
        build_pool(pl)
