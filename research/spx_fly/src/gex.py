"""Black-76 helpers and dealer gamma exposure (GEX) per day.

    .venv/bin/python src/gex.py [--workers 6]

Writes data/clean/gex_daily.parquet. For day D, known before D's open:
- open interest: raw file dated D (stamped 06:30 ET, it reports D-1's close)
- quotes: greeks_eod of D-1, closing NBBO
- spot: D-1's official close

ThetaData's greeks are not used: its IV comes from the last trade, and contracts with
no trade that day have gamma 0, which would silently drop open interest. IV is solved
here from the closing NBBO mid of the OTM side of each strike; strikes with no usable
quote take the IV of the nearest quoted strike in that expiry.

Sign convention (spec 3.3): GEX per strike = (call OI - put OI) * gamma * 100 * spot,
i.e. dealers assumed long calls and short puts. OI carries no side information, so
this is an assumption, not an observation.
"""
import argparse
import glob
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
RAW = os.path.join(ROOT, CFG["paths"]["raw"])
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])


# ---------------------------------------------------------------- Black-76, r = 0

def black_price(F, K, w, is_call):
    """Undiscounted option price; w = sigma^2 * T (total variance)."""
    F, K, w = np.broadcast_arrays(np.asarray(F, float), np.asarray(K, float), np.asarray(w, float))
    s = np.sqrt(np.maximum(w, 1e-16))
    d1 = (np.log(F / K) + w / 2) / s
    d2 = d1 - s
    call = F * ndtr(d1) - K * ndtr(d2)
    return np.where(is_call, call, call - F + K)


def black_straddle(F, K, w):
    return black_price(F, K, w, True) + black_price(F, K, w, False)


def black_gamma(F, K, w):
    """d2V/dF2 per 1 point of the underlying, one share."""
    F, K, w = np.broadcast_arrays(np.asarray(F, float), np.asarray(K, float), np.asarray(w, float))
    s = np.sqrt(np.maximum(w, 1e-16))
    d1 = (np.log(F / K) + w / 2) / s
    return np.exp(-d1 ** 2 / 2) / np.sqrt(2 * np.pi) / (F * s)


def solve_total_var(price, fn, lo=1e-9, hi=4.0, iters=60):
    """Bisection on w so fn(w) = price; fn must rise with w. Out-of-range prices give NaN."""
    price = np.asarray(price, float)
    a = np.full(price.shape, lo)
    b = np.full(price.shape, hi)
    bad = (price < fn(a) - 1e-10) | (price > fn(b)) | ~np.isfinite(price)
    for _ in range(iters):
        m = (a + b) / 2
        up = fn(m) < price
        a = np.where(up, m, a)
        b = np.where(up, b, m)
    out = (a + b) / 2
    return np.where(bad, np.nan, out)


# ---------------------------------------------------------------- GEX

def raw_path(dataset, ymd):
    return os.path.join(RAW, dataset, ymd[:4], ymd + ".csv.gz")


def forward(chain, spot):
    """Parity forward at the strikes where C and P are closest. Discounting is ignored:
    near the forward C-P is small, so the error is second order."""
    c = chain[(chain.right == "CALL") & (chain.bid > 0)].set_index("strike").mid
    p = chain[(chain.right == "PUT") & (chain.bid > 0)].set_index("strike").mid
    both = pd.DataFrame({"c": c, "p": p}).dropna()
    if both.empty:
        return float(spot)
    both["d"] = (both.c - both.p).abs()
    top = both.nsmallest(3, "d")
    return float((top.index.values + top.c - top.p).median())


def expiry_iv(g, spot, T):
    """One IV per strike from the OTM mid; gaps filled from the nearest quoted strike."""
    F = forward(g, spot)
    otm = g[((g.right == "CALL") & (g.strike >= F)) | ((g.right == "PUT") & (g.strike < F))]
    good = otm[(otm.bid > 0) & (otm.ask >= otm.bid)]
    if good.empty:
        return None
    K = good.strike.values
    is_call = (good.right == "CALL").values
    w = solve_total_var(good.mid.values, lambda x: black_price(F, K, x, is_call))
    ok = np.isfinite(w)
    if not ok.any():
        return None
    order = np.argsort(K[ok])
    strikes = np.sort(g.strike.unique())
    # np.interp holds the end values flat outside the quoted range
    iv = np.interp(np.log(strikes / F), np.log(K[ok][order] / F), np.sqrt(w[ok][order] / T))
    return F, strikes, iv


def load_day_inputs(prev_ymd, ymd):
    frames = []
    for root, am_shift in (("SPXW", 0.0), ("SPX", 6.5 / 24)):
        gr = pd.read_csv(raw_path(f"{root}/greeks_eod", prev_ymd), compression="gzip",
                         usecols=["expiration", "strike", "right", "bid", "ask"])
        oi = pd.read_csv(raw_path(f"{root}/oi", ymd), compression="gzip",
                         usecols=["expiration", "strike", "right", "open_interest"])
        # 2022-08-31's OI file repeats 174 contracts, some with differing values; keep the last
        keys = ["expiration", "strike", "right"]
        df = gr.drop_duplicates(keys, keep="last").merge(oi.drop_duplicates(keys, keep="last"), on=keys, how="left")
        df["open_interest"] = df.open_interest.fillna(0.0)
        df["root"] = root
        df["am_shift"] = am_shift
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["mid"] = (df.bid + df.ask) / 2
    df["expiration"] = pd.to_datetime(df.expiration)
    return df


def net_by_strike(df, spot, base_date):
    """Collapse to (expiry, strike) with one IV and net (call - put) OI.
    SPX and SPXW with the same expiry and strike stay apart: one is AM settled."""
    rows = []
    for (root, exp), g in df.groupby(["root", "expiration"]):
        days = (exp - base_date).days - g.am_shift.iloc[0]
        if days <= 0:
            continue
        T = days / 365.0
        res = expiry_iv(g, spot, T)
        if res is None:
            continue
        F, strikes, iv = res
        net = g.assign(s=np.where(g.right == "CALL", 1, -1) * g.open_interest).groupby("strike").s.sum()
        rows.append(pd.DataFrame({"root": root, "exp": exp, "T": T, "F_ratio": F / spot, "K": strikes,
                                  "iv": iv, "net_oi": net.reindex(strikes).values, "days": days}))
    return pd.concat(rows, ignore_index=True)


def gex_at(net, S):
    """Total GEX with the underlying at S, fixed IV per contract; USD per 1 point."""
    F = S * net.F_ratio.values
    w = net.iv.values ** 2 * net["T"].values
    return float((net.net_oi.values * black_gamma(F, net.K.values, w)).sum() * 100 * S)


def zero_gamma(levels, totals, spot):
    """Crossing nearest to spot, linear between grid points; NaN if GEX never changes sign."""
    levels, totals = np.asarray(levels), np.asarray(totals)
    idx = np.where(np.sign(totals[:-1]) * np.sign(totals[1:]) < 0)[0]
    if len(idx) == 0:
        return np.nan
    x = levels[idx] - totals[idx] * (levels[idx + 1] - levels[idx]) / (totals[idx + 1] - totals[idx])
    return float(x[np.abs(x - spot).argmin()])


def walls(by_strike, spot):
    """call wall: strike above spot with the largest positive GEX.
    put wall: strike below spot with the most negative GEX."""
    up = by_strike[(by_strike.index > spot) & (by_strike > 0)]
    dn = by_strike[(by_strike.index < spot) & (by_strike < 0)]
    return (float(up.idxmax()) if len(up) else np.nan, float(dn.idxmin()) if len(dn) else np.nan)


def gex_day(args):
    prev, ymd, spot = args
    base = pd.Timestamp(prev)
    df = load_day_inputs(prev, ymd)
    d0 = pd.Timestamp(ymd)
    df = df[df.expiration >= d0]
    oi_total = float(df.open_interest.sum())
    net = net_by_strike(df, spot, base)
    F = spot * net.F_ratio.values
    w = net.iv.values ** 2 * net["T"].values
    per = net.net_oi.values * black_gamma(F, net.K.values, w) * 100 * spot
    by_strike = pd.Series(per).groupby(net.K.values).sum()
    total = float(per.sum())
    grid = spot * (1 + np.arange(-0.06, 0.0601, 0.0025))
    prof = [gex_at(net, s) for s in grid]
    zg = zero_gamma(grid, prof, spot)
    cw, pw = walls(by_strike, spot)
    near = net[np.abs(net.K / spot - 1) < 0.1]
    return {"date": d0, "spot_prev": spot, "gex_total": total, "zero_gamma": zg, "call_wall": cw, "put_wall": pw,
            "oi_total": oi_total, "oi_0dte": float(df[df.expiration == d0].open_interest.sum()),
            "gex_0dte": float(per[net.exp.values == np.datetime64(d0)].sum()),
            "n_strikes": int(len(net)), "iv_atm_med": float(near.iv.median())}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workers", type=int, default=6)
    a = p.parse_args()
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    days = cal.index.strftime("%Y%m%d").tolist()
    jobs = [(days[i - 1], days[i], float(cal.settle.iloc[i - 1])) for i in range(1, len(days))]
    with ProcessPoolExecutor(a.workers) as ex:
        recs = list(ex.map(gex_day, jobs, chunksize=8))
    out = pd.DataFrame(recs).set_index("date").sort_index()
    out.to_parquet(os.path.join(CLEAN, "gex_daily.parquet"))
    print(len(out), "days; zero_gamma found on", int(out.zero_gamma.notna().sum()))


if __name__ == "__main__":
    main()
