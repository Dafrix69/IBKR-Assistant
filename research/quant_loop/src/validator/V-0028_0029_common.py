"""V-0028 / V-0029 validator: own implementation (does NOT import anything from src/proposer).

Written from the spec text (proposals/P-0028.md §2-§4, P-0029.md §2-§4), PROTOCOL A-hist supplement and the raw
ThetaData files. Pieces:
  extract(lo, hi)        -> per-day 14:00 snapshot + spot + session end, and greeks_eod closes, for files lo..hi (by NAME)
  usable / leg_fee        -> quote validity and fee model (config.yaml fills, 2026 schedule)
  h1_day / h2_day         -> the frozen one-trade-per-day rules
  wilson / sboot          -> statistics (ISO-week stationary block bootstrap, ratio of sums)
"""
import glob
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

RAW = os.path.expanduser("~/Data/thetadata/SPXW")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "V-0028_cache")
MULT = 100.0

# ---------------------------------------------------------------- fees: spx_fly/config.yaml `fills` (2026 schedule)
COMM = ((0.05, 0.25), (0.10, 0.50), (np.inf, 0.65))
EXCH = ((1.00, 0.36), (np.inf, 0.45))
SURCH, REG, COMM_MIN = 0.14, 0.04028, 1.00
SPREAD_MAX, BID0_ASK_MAX = 1.0, 1.00         # config.yaml quote_filters


def tier(px, tab):
    for below, fee in tab:
        if px < below:
            return fee
    return tab[-1][1]


def leg_fee(mid, qty):
    return max(qty * tier(mid, COMM), COMM_MIN) + qty * (tier(mid, EXCH) + SURCH + REG)


def usable(bid, ask):
    """Spec §2: unusable iff 0/0, crossed (both >0, bid>ask), bid 0 & ask > 1.00, both > 0 & ask-bid > 1.0*mid."""
    mid = (bid + ask) / 2.0
    if bid == 0 and ask == 0:
        return False
    if bid > 0 and ask > 0 and bid > ask:
        return False
    if bid == 0 and ask > BID0_ASK_MAX:
        return False
    if bid > 0 and ask > 0 and (ask - bid) > SPREAD_MAX * mid:
        return False
    return True


# ---------------------------------------------------------------- raw extraction
def _name_files(ds, lo, hi):
    out = {}
    for f in glob.glob(os.path.join(RAW, ds, "*", "*.csv.gz")):
        n = os.path.basename(f)[:8]
        if lo <= n <= hi:                    # filter by FILE NAME before anything is opened
            out[n] = f
    return dict(sorted(out.items()))


def _day(args):
    d, fq, fu, lo_iso, hi_iso = args
    iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
    q = pd.read_csv(fq, usecols=["expiration", "strike", "right", "timestamp", "bid", "ask"])
    q = q[(q.timestamp.str[:10] >= lo_iso) & (q.timestamp.str[:10] <= hi_iso)]     # first data step: window
    last_q = q.timestamp.max() if len(q) else None
    q = q[(q.expiration == iso) & (q.timestamp == f"{iso}T14:00:00.000")]
    snap = pd.DataFrame({"date": iso, "strike": q.strike.astype(float).values, "right": q.right.str[0].values,
                         "bid": q.bid.astype(float).values, "ask": q.ask.astype(float).values})
    info = {"date": iso, "n1400": len(snap), "last_quote_ts": last_q, "spot": np.nan, "last_u_ts": None, "last_u": np.nan, "last_u_change_ts": None}
    if fu is not None:
        u = pd.read_csv(fu, usecols=["timestamp", "underlying_price"])
        u = u[(u.timestamp.str[:10] >= lo_iso) & (u.timestamp.str[:10] <= hi_iso)]
        up = u[u.underlying_price > 0]
        s = up[up.timestamp == f"{iso}T14:00:00.000"].underlying_price
        info["spot"] = float(s.iloc[0]) if len(s) else np.nan
        info["spot_n_distinct"] = int(s.round(4).nunique())
        if len(up):
            info["last_u_ts"] = up.timestamp.max()
            us = up.drop_duplicates("timestamp").sort_values("timestamp")
            info["last_u"] = float(us.underlying_price.iloc[-1])
            chg = us[us.underlying_price.diff() != 0]
            info["last_u_change_ts"] = chg.timestamp.iloc[-1]          # session end signature: half days stop ~13:0x
    return snap, info


def _close(args):
    d, f = args
    g = pd.read_csv(f, usecols=["underlying_price"])
    g = g[g.underlying_price > 0].underlying_price
    if not len(g):
        return d, np.nan, np.nan, np.nan
    return d, float(g.iloc[0]), float(g.min()), float(g.max())


def extract(lo, hi, tag, workers=8):
    """lo, hi as YYYYMMDD. Writes CACHE/{tag}_snap.parquet, {tag}_days.parquet, {tag}_closes.parquet."""
    lo_iso, hi_iso = f"{lo[:4]}-{lo[4:6]}-{lo[6:]}", f"{hi[:4]}-{hi[4:6]}-{hi[6:]}"
    fq, fu, fe = (_name_files(x, lo, hi) for x in ("quote_1m_dte0", "underlying_1m", "greeks_eod"))
    jobs = [(d, fq[d], fu.get(d), lo_iso, hi_iso) for d in fq]
    with ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("fork")) as ex:   # fork: workers inherit sys.modules['vc']
        res = list(ex.map(_day, jobs, chunksize=2))
        cl = list(ex.map(_close, list(fe.items()), chunksize=4))
    snap = pd.concat([r[0] for r in res], ignore_index=True)
    days = pd.DataFrame([r[1] for r in res])
    closes = pd.DataFrame(cl, columns=["date", "close", "cmin", "cmax"])
    closes["date"] = pd.to_datetime(closes.date)
    snap["date"] = pd.to_datetime(snap.date)
    days["date"] = pd.to_datetime(days.date)
    os.makedirs(CACHE, exist_ok=True)
    snap.to_parquet(os.path.join(CACHE, f"{tag}_snap.parquet"), index=False)
    days.to_parquet(os.path.join(CACHE, f"{tag}_days.parquet"), index=False)
    closes.to_parquet(os.path.join(CACHE, f"{tag}_closes.parquet"), index=False)
    return snap, days, closes


# ---------------------------------------------------------------- per-day book
def make_book(g):
    bk = {}
    for s, r, b, a in zip(g.strike.values, g.right.values, g.bid.values, g.ask.values):
        if usable(b, a):
            bk[(float(s), r)] = (b, a, (b + a) / 2.0, (a - b) / 2.0)      # bid, ask, mid, half-spread
    return bk


def atm_I(bk, S):
    """ATM = usable strike (either right) nearest S, exact tie -> higher. I = mid C + mid P at K (None if a side unusable)."""
    ks = sorted({k for k, _ in bk})
    if not ks:
        return None, None
    best = min(ks, key=lambda k: (abs(k - S), -k))
    if (best, "C") in bk and (best, "P") in bk:
        return best, bk[(best, "C")][2] + bk[(best, "P")][2]
    return best, None


H1_W = (20, 25, 30, 50, 75)


def iron_terms(bk, K, w):
    legs = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C")]
    if any(l not in bk for l in legs):
        return None
    m = [bk[l][2] for l in legs]
    c = m[1] + m[2] - m[0] - m[3]
    if not c < w:
        return None
    return dict(credit=c, SH=sum(bk[l][3] for l in legs), fee=sum(leg_fee(x, 1) for x in m))


def putfly_terms(bk, K, w):
    legs = [(K - w, "P"), (K, "P"), (K + w, "P")]
    if any(l not in bk for l in legs):
        return None
    m = [bk[l][2] for l in legs]
    cost = m[0] - 2 * m[1] + m[2]
    if cost <= 0:
        return None
    SH = bk[legs[0]][3] + 2 * bk[legs[1]][3] + bk[legs[2]][3]
    return dict(cost=cost, SH=SH, fee=leg_fee(m[0], 1) + leg_fee(m[1], 2) + leg_fee(m[2], 1))


def h1_day(bk, S):
    """Steps 3-7 of P-0028 §2 (prev-ret and half-day filters are applied by the caller). Returns dict with status."""
    if not np.isfinite(S):
        return {"status": "no_spot"}
    K, I = atm_I(bk, S)
    if K is None:
        return {"status": "no_quotes"}
    if I is None:
        return {"status": "no_atm_straddle", "K": K}
    cands = {w: iron_terms(bk, K, w) for w in H1_W}
    cands = {w: t for w, t in cands.items() if t is not None}
    if not cands:
        return {"status": "no_width", "K": K, "I": I}
    w = min(cands, key=lambda x: (abs(x / I - 2.0), x))
    w_ideal = min(H1_W, key=lambda x: (abs(x / I - 2.0), x))
    t = cands[w]
    return {"status": "ok", "K": K, "I": I, "w": w, "w_fallback": w != w_ideal, **t, "pf": putfly_terms(bk, K, w)}


def h1_pnl(t, settle, k):
    return (t["credit"] - k * t["SH"] - min(abs(settle - t["K"]), t["w"])) * MULT - t["fee"]


def pf_pnl(t, settle, k):
    p = t["pf"]
    return (max(0.0, t["w"] - abs(settle - t["K"])) - p["cost"] - k * p["SH"]) * MULT - p["fee"]


def h2_day(bk, S, width=15, lo=3.0, hi=4.0):
    if not np.isfinite(S):
        return {"status": "no_spot", "ncand": 0}
    cands = []
    for (K, r) in bk:
        if r != "C" or not (S - 30 <= K <= S + 80):
            continue
        if (K + width, "C") not in bk:
            continue
        c = round(bk[(K, "C")][2] - bk[(K + width, "C")][2], 6)
        if lo < c <= hi:
            cands.append((K, c))
    if not cands:
        return {"status": "no_candidate", "ncand": 0}
    K, c = min(cands, key=lambda x: (abs(x[1] - 3.5), -x[0]))
    ms, ml = bk[(K, "C")][2], bk[(K + width, "C")][2]
    return {"status": "ok", "ncand": len(cands), "K": K, "credit": c, "SH": bk[(K, "C")][3] + bk[(K + width, "C")][3],
            "fee": leg_fee(ms, 1) + leg_fee(ml, 1)}


def h2_pnl(t, settle, k, width=15):
    return (t["credit"] - k * t["SH"] - min(max(0.0, settle - t["K"]), width)) * MULT - t["fee"]


# ---------------------------------------------------------------- statistics
def wilson(x, n, z=1.959964):
    if n == 0:
        return np.nan, np.nan
    p = x / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def sboot(dates, x, seed, nboot=10000, mean_block=4.0):
    """Politis-Romano stationary bootstrap over ISO weeks (circular), mean block length 4 weeks.
    Statistic = resampled sum / resampled day count (day mean). Returns the nboot draws."""
    di = pd.DatetimeIndex(dates)
    iso = di.isocalendar()
    wk = (iso.year.values.astype(int) * 100 + iso.week.values.astype(int))
    df = pd.DataFrame({"wk": wk, "x": np.asarray(x, float)}).groupby("wk").x.agg(["sum", "count"]).sort_index()
    s, c = df["sum"].values, df["count"].values.astype(float)
    W = len(s)
    rng = np.random.default_rng(seed)
    pos = rng.integers(0, W, nboot)
    tot_s, tot_c = s[pos].copy(), c[pos].copy()
    for _ in range(1, W):
        jump = rng.random(nboot) < 1.0 / mean_block
        pos = np.where(jump, rng.integers(0, W, nboot), (pos + 1) % W)
        tot_s += s[pos]
        tot_c += c[pos]
    return tot_s / tot_c


def max_drawdown(x):
    cum = np.cumsum(np.asarray(x, float))
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    return float((cum - peak).min())


def bf_upper(p):
    if p <= 0:
        p = 1e-5
    return 1.0 / (-np.e * p * np.log(p)) if p < 1 / np.e else 1.0


def posterior_upper(prior, p):
    o = prior / (1 - prior) * bf_upper(p)
    return o / (1 + o)
