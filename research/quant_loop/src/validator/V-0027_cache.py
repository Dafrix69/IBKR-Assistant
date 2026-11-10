"""V-0027 (validator for P-0027): own reader / cache for the B-pools greeks_eod files.

Independent of src/proposer/*. Usage:
    python V-0027_cache.py train          # 2018..2022 pools, files dated < 2023-10-31 only
    python V-0027_cache.py test --test    # 2023-10-31 and 2024-10-31 pools (explicit flag required)

TIME WALL
  train: only the five pools 20181031..20221031 are listed; every file whose name-date is >= 2023-10-31
         is dropped from the file list BEFORE it is opened, and the frame is filtered again right after
         reading (date < WALL). The two test pools are never touched in train mode.
  test : only 20231031 (~/Data/thetadata_univ_20231031) and 20241031 (~/Data/thetadata_univ).
         OSTK dir already holds BYON, SQ dir already holds XYZ (byte-identical files) -> the separate
         BYON / XYZ dirs are not read.

Cache (ThetaData licence, git-ignored): src/validator/V-0027_cache/<pool>.pkl
Per symbol: spot, monthly-candidate quotes (+-35 %), ATM IV per (date, expiry) for all expiries,
strike-grid retention stats per consecutive file pair, implied-rate samples.
"""
import os, sys, glob
import numpy as np
import pandas as pd
from multiprocessing import Pool
from scipy.stats import norm

WALL = pd.Timestamp("2023-10-31")
HOME = os.path.expanduser("~")
QL = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop"
UNIV = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/call_spread_edge/universe"
CACHE = os.path.join(QL, "src/validator/V-0027_cache")
TRAIN_POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031"]
TEST_POOLS = ["20231031", "20241031"]
COLS = ["expiration", "strike", "right", "bid", "ask", "delta", "implied_vol", "iv_error",
        "underlying_price", "volume"]


def pool_dir(pool):
    return os.path.join(HOME, "Data/thetadata_univ" if pool == "20241031" else f"Data/thetadata_univ_{pool}")


def universe(pool):
    fn = "UNIVERSE.txt" if pool == "20241031" else f"UNIVERSE_{pool}.txt"
    with open(os.path.join(UNIV, fn)) as f:
        return [s.strip() for s in f.read().replace("\n", ",").split(",") if s.strip()]


def quality(df):
    mid = (df["bid"] + df["ask"]) / 2
    return ((df["bid"] > 0) & (df["ask"] > df["bid"]) & ((df["ask"] - df["bid"]) / mid <= 0.5)
            & (df["implied_vol"] > 0) & (df["implied_vol"] <= 10) & (df["iv_error"].abs() < 0.01))


def load_symbol(args):
    pool, sym, mode = args
    files = sorted(glob.glob(os.path.join(pool_dir(pool), sym, "greeks_eod", "*", "*.csv.gz")))
    if mode == "train":
        files = [f for f in files if pd.Timestamp(os.path.basename(f)[:8]) < WALL]   # wall on the file list
    frames = []
    for f in files:
        d = pd.Timestamp(os.path.basename(f)[:8])
        try:
            x = pd.read_csv(f, usecols=COLS)
        except Exception:
            continue
        if len(x) == 0:
            continue
        x["date"] = d
        frames.append(x)
    if not frames:
        return pool, sym, None
    df = pd.concat(frames, ignore_index=True)
    if mode == "train":
        df = df[df["date"] < WALL]                                                    # wall, first step after reading
    df["expiration"] = pd.to_datetime(df["expiration"])
    df["right"] = df["right"].astype(str).str[0]
    return pool, sym, summarise(df)


def summarise(df):
    # ---- spot: underlying_price; record non-uniqueness; <= 0 -> NaN
    g = df.groupby("date")["underlying_price"]
    spot = g.median()
    nuniq = g.nunique()
    spot = spot.where(spot > 0)
    df = df.join(spot.rename("S"), on="date")
    df["dte"] = (df["expiration"] - df["date"]).dt.days
    ok = quality(df)
    # ---- monthly candidates (Fri day 15..21 or Thu day 14..20), strikes within +-35 %
    ex = df["expiration"]
    cand = (((ex.dt.day_of_week == 4) & ex.dt.day.between(15, 21)) |
            ((ex.dt.day_of_week == 3) & ex.dt.day.between(14, 20)))
    mon = df[cand & ((df["strike"] / df["S"] - 1).abs() <= 0.35)][
        ["date", "expiration", "strike", "right", "bid", "ask", "delta", "implied_vol", "iv_error", "volume", "S"]].copy()
    # ---- ATM IV per (date, expiry), DTE >= 1: quality rows, bracketing strikes (gap <= 25 % S), linear in K,
    #      call and put separately then averaged (P-0024 sec. 2 definition)
    q = df[ok & (df["dte"] >= 1) & ((df["strike"] / df["S"] - 1).abs() <= 0.25)]
    rows = []
    for (d, e, r), gg in q.groupby(["date", "expiration", "right"], sort=False):
        S = gg["S"].iat[0]
        k = gg["strike"].values; v = gg["implied_vol"].values
        lo = k <= S; hi = k >= S
        if not lo.any() or not hi.any():
            continue
        ia = np.flatnonzero(lo)[np.argmax(k[lo])]; ib = np.flatnonzero(hi)[np.argmin(k[hi])]
        ka, kb = k[ia], k[ib]
        if (kb - ka) / S > 0.25:
            continue
        iv = v[ia] if kb == ka else v[ia] + (v[ib] - v[ia]) * (S - ka) / (kb - ka)
        rows.append((d, e, iv))
    atm = pd.DataFrame(rows, columns=["date", "expiration", "iv"]).groupby(["date", "expiration"])["iv"].mean().reset_index()
    atm["dte"] = (atm["expiration"] - atm["date"]).dt.days
    # ---- strike-grid retention across consecutive files (expiries > d1, >= 6 strikes on d0), shift detection
    grid = {}
    for (d, e), gg in df.groupby(["date", "expiration"], sort=False):
        grid.setdefault(d, {})[e] = np.unique(np.round(gg["strike"].values, 4))
    dates = sorted(grid)
    chk = []
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        best = (np.nan, None, 0, np.nan, np.nan)
        n_common = 0
        for e, k0 in grid[d0].items():
            if e <= d1 or len(k0) < 6 or e not in grid[d1]:
                continue
            k1 = grid[d1][e]
            n_common += 1
            kept = np.isin(k0, k1).mean()
            if np.isnan(best[0]) or kept < best[0]:
                lost = k0[~np.isin(k0, k1)]
                sc = sf = np.nan
                if len(lost) and len(k1):
                    diffs = np.round(lost[:, None] - k1[None, :], 4)
                    near = diffs[np.arange(len(lost)), np.abs(diffs).argmin(axis=1)]
                    vals, cnts = np.unique(near, return_counts=True)
                    j = cnts.argmax(); sc = vals[j]; sf = cnts[j] / len(lost)
                best = (kept, e, len(k0), sc, sf)
        chk.append((d1, d0, best[0], best[1], best[2], n_common, best[3], best[4]))
    chk = pd.DataFrame(chk, columns=["date", "prev_date", "min_kept", "exp_min", "n_k0", "n_common", "shift_c", "shift_frac"])
    # ---- implied-rate samples from ThetaData call deltas (ATM-ish, DTE >= 20)
    c = df[ok & (df["right"] == "C") & (df["dte"] >= 20) & ((df["strike"] / df["S"] - 1).abs() <= 0.05)
           & (df["delta"] > 0.05) & (df["delta"] < 0.95)].copy()
    T = c["dte"] / 365.0
    c["r"] = (norm.ppf(c["delta"]) * c["implied_vol"] * np.sqrt(T) - np.log(c["S"] / c["strike"])) / T - c["implied_vol"] ** 2 / 2
    rate = c.groupby("date")["r"].median()
    return dict(spot=spot, nuniq=nuniq, mon=mon.reset_index(drop=True), atm=atm, chk=chk, rate=rate,
                ndays=int(df["date"].nunique()), first=df["date"].min(), last=df["date"].max())


def build(pool, mode, nproc=8):
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, f"{pool}.pkl")
    if os.path.exists(out):
        print(f"[{pool}] cached", flush=True); return
    syms = universe(pool)
    res = {}
    with Pool(nproc) as p:
        for pl, sym, r in p.imap_unordered(load_symbol, [(pool, s, mode) for s in syms]):
            if r is None:
                print(f"[{pool}] {sym}: NO DATA", flush=True); continue
            res[sym] = r
            print(f"[{pool}] {sym}: {r['ndays']} days {r['first'].date()} .. {r['last'].date()}", flush=True)
    pd.to_pickle(dict(pool=pool, mode=mode, syms=syms, res=res), out)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "train":
        for pl in TRAIN_POOLS:
            build(pl, "train")
    elif mode == "test":
        assert "--test" in sys.argv, "test pools need the explicit --test flag"
        for pl in TEST_POOLS:
            build(pl, "test")
    else:
        raise SystemExit("mode = train | test")
