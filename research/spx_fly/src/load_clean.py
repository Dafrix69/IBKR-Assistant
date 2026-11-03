"""Step 1: clean the raw data into data/clean/.

    .venv/bin/python src/load_clean.py [--workers 6] [--days 20241129,20251028]

Writes chain_{date}.parquet (one per 0DTE day), spot.parquet, calendar.parquet,
and reports/step1_days.csv with per-day counts for the report.

Rules (spec 2.1, plus what step 0 found):
- 1-minute NBBO of SPXW 0DTE only. Bad quotes are flagged and kept.
- Rows at or after the session end are dropped: the 16:00 snapshot is unusable and on
  half days quotes stay frozen from 13:00 to 16:00.
- Spot at minute t = close of the TWS bar that STARTED at t-1, so it is known at t.
  09:30 uses the open of the 09:30 bar.
- Settlement = official close from greeks_eod underlying_price.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402

ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
RAW = os.path.join(ROOT, CFG["paths"]["raw"])
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])
REPORTS = os.path.join(ROOT, CFG["paths"]["reports"])


def raw_files(dataset):
    return sorted(glob.glob(os.path.join(RAW, dataset, "*", "*.csv.gz")))


def ymd(path):
    return os.path.basename(path)[:8]


# ---------------------------------------------------------------- spot

def load_tws_bars():
    fs = sorted(glob.glob(os.path.join(ROOT, "data", "tws", "spx_1m", "*.parquet")))
    df = pd.concat(pd.read_parquet(f) for f in fs).drop_duplicates("ts").sort_values("ts")
    df["ts"] = df.ts.dt.tz_localize(None)
    return df[df.ts >= "2022-05-02"].reset_index(drop=True)


def spot_from_bars(bars):
    """One row per minute 09:30 .. last bar's start, value known AT that minute."""
    out = []
    for _, d in bars.groupby(bars.ts.dt.normalize()):
        close = d.set_index("ts")["close"].shift(1)      # bar t-1's close is known at t
        close.iloc[0] = d["open"].iloc[0]
        out.append(close.rename("spot"))
    return pd.concat(out).reset_index()


# ---------------------------------------------------------------- calendar

def third_friday(year, month):
    d = pd.Timestamp(year, month, 1)
    first_fri = d + pd.Timedelta(days=(4 - d.weekday()) % 7)
    return first_fri + pd.Timedelta(days=14)


def opex_days(trading_days):
    """Third Friday, or the trading day before it when the exchange is shut."""
    td = pd.DatetimeIndex(sorted(trading_days))
    out = {}
    for y, m in sorted({(d.year, d.month) for d in td}):
        f = third_friday(y, m)
        prior = td[td <= f]
        if len(prior) and (f - prior[-1]).days < 7 and f <= td[-1]:
            out[prior[-1]] = m in (3, 6, 9, 12)
    return out


def build_calendar(bars):
    closes = {}
    for f in raw_files("SPXW/greeks_eod"):
        closes[pd.Timestamp(ymd(f))] = pd.read_csv(f, compression="gzip", usecols=["underlying_price"], nrows=1).iloc[0, 0]
    cal = pd.DataFrame({"settle": pd.Series(closes)}).rename_axis("date").sort_index()

    n = bars.groupby(bars.ts.dt.normalize()).size()
    cal["half_day"] = n.reindex(cal.index) < 390
    cal["session_end"] = np.where(cal.half_day, "13:00", "16:00")
    cal["has_0dte"] = [os.path.exists(os.path.join(RAW, "SPXW/quote_1m_dte0", d.strftime("%Y"), d.strftime("%Y%m%d") + ".csv.gz"))
                       for d in cal.index]

    ev = pd.read_csv(os.path.join(ROOT, "events.csv"), parse_dates=["date"])
    for name in ["fomc", "cpi", "nfp", "pce"]:
        cal[name] = cal.index.isin(ev[ev.event == name].date)

    ox = opex_days(cal.index)
    cal["opex"] = cal.index.isin(list(ox))
    cal["triple_witching"] = cal.index.isin([d for d, q in ox.items() if q])

    vix = pd.read_parquet(os.path.join(ROOT, "data", "tws", "vix_1d.parquet")).set_index("date").vix_close
    cal["vix_prev_close"] = vix.reindex(vix.index.union(cal.index)).ffill().shift(1).reindex(cal.index)
    # previous close change, known before the open
    cal["spx_ret_prev"] = cal.settle.pct_change().shift(1)
    return cal


# ---------------------------------------------------------------- chain

def session_cut(ts, date, end_hhmm):
    return ts < pd.Timestamp(f"{date.strftime('%Y-%m-%d')} {end_hhmm}")


def flag_quotes(df, qf):
    two = (df.bid > 0) & (df.ask > 0)
    df["flag_no_quote"] = (df.bid == 0) & (df.ask == 0)
    df["flag_crossed"] = two & (df.bid > df.ask)
    df["flag_bid0_ask_big"] = (df.bid == 0) & (df.ask > qf["bid0_ask_max"])
    df["flag_wide"] = two & ((df.ask - df.bid) > qf["max_spread_to_mid"] * df.mid)
    df["flag_bad"] = df.flag_no_quote | df.flag_crossed | df.flag_bid0_ask_big | df.flag_wide
    return df


def atm_strike(strikes, spot):
    s = np.asarray(strikes)
    return s[np.abs(s - spot).argmin()]


def fly_spread_share(snap, spot, width, k_cfg):
    """Put fly at the nearest strike: half-spreads summed over legs, as a share of its mid."""
    p = snap[(snap.right == "P") & ~snap.flag_bad].set_index("strike")
    c = atm_strike(p.index.values, spot)
    if not all(s in p.index for s in (c - width, c + width)):
        return np.nan, np.nan
    strikes, sides, qtys = fills.fly_legs(c, width)
    q = p.loc[strikes]
    mid = float((np.array(sides) * np.array(qtys) * q.mid.values).sum())
    half = float((np.array(qtys) * (q.ask.values - q.bid.values) / 2).sum())
    return (half / mid if mid > 0 else np.nan), mid


def clean_day(args):
    path, end_hhmm, spot_day = args
    date = pd.Timestamp(ymd(path))
    df = pd.read_csv(path, compression="gzip", usecols=["strike", "right", "timestamp", "bid_size", "bid", "ask_size", "ask"])
    n_raw = len(df)
    df["ts"] = pd.to_datetime(df.pop("timestamp"))
    df = df[session_cut(df.ts, date, end_hhmm)].copy()
    n_session = len(df)
    df["right"] = df.right.str[0]
    df["mid"] = (df.bid + df.ask) / 2
    df["spread"] = df.ask - df.bid
    df = flag_quotes(df, CFG["quote_filters"])
    df.to_parquet(os.path.join(CLEAN, f"chain_{date.strftime('%Y%m%d')}.parquet"), index=False, compression="zstd")

    rec = {"date": date.strftime("%Y%m%d"), "rows_raw": n_raw, "rows_session": n_session,
           "contracts": int(df.groupby(["strike", "right"]).ngroups),
           "bad": int(df.flag_bad.sum()), "no_quote": int(df.flag_no_quote.sum()), "crossed": int(df.flag_crossed.sum()),
           "bid0_ask_big": int(df.flag_bid0_ask_big.sum()), "wide": int(df.flag_wide.sum()),
           "bid0": int((df.bid == 0).sum()),
           "bid0_gt_050": int(((df.bid == 0) & (df.ask > 0.5)).sum()), "bid0_gt_200": int(((df.bid == 0) & (df.ask > 2)).sum()),
           "bid0_gt_500": int(((df.bid == 0) & (df.ask > 5)).sum())}
    first = df[df.ts == df.ts.min()]
    rec["share_no_quote_first_min"] = round(float(first.flag_no_quote.mean()), 4)

    # ATM quality at the study's entry times
    for hhmm in CFG["entries"]:
        t = pd.Timestamp(f"{date.strftime('%Y-%m-%d')} {hhmm}")
        snap = df[df.ts == t]
        tag = hhmm.replace(":", "")
        if snap.empty or t not in spot_day.index:
            continue
        s = float(spot_day.loc[t])
        atm = snap[snap.strike == atm_strike(snap.strike.unique(), s)]
        rec[f"atm_spread_{tag}"] = round(float(atm.spread.mean()), 3)
        rec[f"atm_bad_{tag}"] = int(atm.flag_bad.sum())
        for w in (25, 50):
            share, mid = fly_spread_share(snap, s, w, None)
            rec[f"fly{w}_share_{tag}"] = round(share, 4) if share == share else np.nan
            rec[f"fly{w}_mid_{tag}"] = round(mid, 3) if mid == mid else np.nan
    return rec


def parity_series(chain):
    """K + C - P at the 3 strikes nearest C = P, median, per minute. QA only."""
    g = chain[(chain.bid > 0) & (chain.ask > 0) & ~chain.flag_crossed]
    piv = g.pivot_table(index=["ts", "strike"], columns="right", values="mid").dropna().reset_index()
    if piv.empty:
        return pd.Series(dtype=float)
    piv["d"] = (piv.C - piv.P).abs()
    piv["F"] = piv.strike + piv.C - piv.P
    return piv.sort_values(["ts", "d"]).groupby("ts").head(3).groupby("ts").F.median()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--days", default="", help="comma list of yyyymmdd, for a trial run")
    a = p.parse_args()
    os.makedirs(CLEAN, exist_ok=True)

    bars = load_tws_bars()
    spot = spot_from_bars(bars)
    cal = build_calendar(bars)
    cal.to_parquet(os.path.join(CLEAN, "calendar.parquet"))

    spot_idx = spot.set_index("ts").spot
    only = set(a.days.split(",")) if a.days else None
    jobs = []
    for f in raw_files("SPXW/quote_1m_dte0"):
        d = pd.Timestamp(ymd(f))
        if only and ymd(f) not in only:
            continue
        jobs.append((f, cal.loc[d, "session_end"], spot_idx[spot_idx.index.normalize() == d]))
    with ProcessPoolExecutor(a.workers) as ex:
        recs = list(ex.map(clean_day, jobs, chunksize=8))
    days = pd.DataFrame(recs).sort_values("date")
    days.to_csv(os.path.join(REPORTS, "step1_days.csv"), index=False)

    # QA column: parity forward next to the spot it should track
    par = [parity_series(pd.read_parquet(os.path.join(CLEAN, f"chain_{d}.parquet"),
                                         columns=["ts", "strike", "right", "bid", "ask", "mid", "flag_crossed"]))
           for d in days.date]
    spot = spot.merge(pd.concat(par).rename("parity_F").rename_axis("ts").reset_index(), on="ts", how="left")
    spot.to_parquet(os.path.join(CLEAN, "spot.parquet"), index=False)
    print("days", len(days), "rows", int(days.rows_session.sum()), "bad", int(days.bad.sum()))


if __name__ == "__main__":
    main()
