"""Step 0: inventory of data/raw (ThetaData downloads). Read-only.

Writes reports/step0_inventory.json with every number the step-0 report quotes,
so the markdown can be checked against a reproducible run:

    .venv/bin/python src/inventory.py
"""
import glob
import gzip
import json
import os
import sys
from collections import Counter

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
RAW = os.environ.get("SPXFLY_RAW") or os.path.join(ROOT, CFG["paths"]["raw"])  # env override for tests


def files(dataset):
    return sorted(glob.glob(os.path.join(RAW, dataset, "*", "*.csv.gz")))


def ymd(path):
    return os.path.basename(path)[:8]


def header(path):
    with gzip.open(path, "rt") as f:
        return f.readline().strip().split(",")


def manifest():
    rows = [json.loads(l) for l in open(os.path.join(RAW, "manifest.jsonl")) if l.strip()]
    m = pd.DataFrame(rows)
    # a day can appear twice if it was re-fetched; keep the last record
    return m.drop_duplicates(["dataset", "date"], keep="last")


def dataset_summary(m, ds):
    fs = files(ds)
    sub = m[m.dataset == ds]
    ok = sub[sub.status == "ok"]
    return {
        "files": len(fs),
        "first": ymd(fs[0]) if fs else None,
        "last": ymd(fs[-1]) if fs else None,
        "gz_GB": round(sum(os.path.getsize(f) for f in fs) / 1e9, 3),
        "rows_total": int(ok.rows.sum()),
        "rows_per_day_median": int(ok.rows.median()) if len(ok) else 0,
        "rows_per_day_min": int(ok.rows.min()) if len(ok) else 0,
        "rows_per_day_max": int(ok.rows.max()) if len(ok) else 0,
        "no_data_days": sorted(sub[sub.status == "no_data"].date.tolist()),
        "fields": header(fs[0]) if fs else [],
    }


def trading_days(m):
    """Days the exchange was open = days with SPXW open interest."""
    oi = m[(m.dataset == "SPXW/oi") & (m.status == "ok")]
    return sorted(oi.date.tolist())


def read_quote_day(path):
    df = pd.read_csv(path, compression="gzip")
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["mid"] = (df.bid + df.ask) / 2
    return df


def parity_forward(df):
    """Per minute: F = K + C_mid - P_mid at the strikes where |C-P| is smallest.
    Median over the 3 closest strikes; only two-sided quotes on both legs."""
    good = df[(df.bid > 0) & (df.ask > 0) & (df.ask >= df.bid)]
    piv = good.pivot_table(index=["timestamp", "strike"], columns="right", values="mid")
    piv = piv.dropna()
    if piv.empty:
        return pd.Series(dtype=float)
    piv["diff"] = (piv["CALL"] - piv["PUT"]).abs()
    piv["F"] = piv.index.get_level_values("strike") + piv["CALL"] - piv["PUT"]
    piv = piv.reset_index().sort_values(["timestamp", "diff"])
    return piv.groupby("timestamp").head(3).groupby("timestamp")["F"].median()


def tws_spot():
    """SPX 1-min bars from TWS, indexed by the bar END minute in naive ET, so the value
    lines up with ThetaData's snapshot stamped at that minute."""
    fs = sorted(glob.glob(os.path.join(ROOT, "data", "tws", "spx_1m", "*.parquet")))
    if not fs:
        return None
    df = pd.concat(pd.read_parquet(f) for f in fs).drop_duplicates("ts").sort_values("ts")
    df["end"] = df.ts.dt.tz_localize(None) + pd.Timedelta(minutes=1)
    return df


def quote_day_stats(path, spx_close, tws=None):
    df = read_quote_day(path)
    per_contract = df.groupby(["strike", "right"]).size()
    last = df.timestamp.max()
    first = df.timestamp.min()
    two_sided = (df.bid > 0) & (df.ask > 0)
    crossed = (df.bid > df.ask) & two_sided
    wide = two_sided & ((df.ask - df.bid) > CFG["quote_filters"]["max_spread_to_mid"] * df.mid)
    fwd = parity_forward(df)
    out = {
        "date": ymd(path),
        "rows": len(df),
        "contracts": int(len(per_contract)),
        "minutes_per_contract": int(per_contract.median()),
        "first_ts": str(first.time()),
        "last_ts": str(last.time()),
        "share_no_bid": round(float((df.bid == 0).mean()), 4),
        "share_crossed": round(float(crossed.mean()), 5),
        "share_wide": round(float(wide.mean()), 4),
        "parity_minutes": int(len(fwd)),
    }
    if len(fwd) and spx_close:
        out["parity_last"] = round(float(fwd.iloc[-1]), 2)
        out["parity_err_close"] = round(float(fwd.iloc[-1] - spx_close), 2)
        # minute-to-minute noise of the parity series (no true intraday SPX to compare)
        out["parity_step_abs_med"] = round(float(fwd.diff().abs().median()), 3)
    if tws is not None and len(fwd):
        day = tws[tws.end.dt.strftime("%Y%m%d") == ymd(path)].set_index("end")["close"]
        # exclude the last bar: its close is the auction value, not a tradable spot
        e = (fwd - day.iloc[:-1]).dropna()
        out["tws_bars"] = int(len(day))
        if len(e):
            out["parity_vs_tws_n"] = int(len(e))
            out["parity_vs_tws_mean"] = round(float(e.mean()), 3)
            out["parity_vs_tws_abs_med"] = round(float(e.abs().median()), 3)
            out["parity_vs_tws_abs_p95"] = round(float(e.abs().quantile(0.95)), 3)
        if spx_close and len(day):
            out["tws_last_minus_close"] = round(float(day.iloc[-1] - spx_close), 2)
    return out


def spx_closes():
    """SPX close per day from greeks_eod underlying_price (17:15 ET EOD report)."""
    out = {}
    for f in files("SPXW/greeks_eod"):
        df = pd.read_csv(f, compression="gzip", usecols=["underlying_price", "underlying_timestamp"], nrows=50)
        out[ymd(f)] = (float(df.underlying_price.iloc[0]), str(df.underlying_timestamp.iloc[0]))
    return out


def eod_expiry_coverage(ds):
    """Distinct expirations and DTE range in a sample of all-expiration files."""
    fs = files(ds)
    if not fs:
        return {}
    sample = fs[:: max(1, len(fs) // 6)]
    res = []
    for f in sample:
        df = pd.read_csv(f, compression="gzip", usecols=["expiration"])
        d = pd.Timestamp(ymd(f))
        e = pd.to_datetime(df.expiration.unique())
        dte = (e - d).days
        res.append({"date": ymd(f), "expirations": int(len(e)), "dte_min": int(dte.min()), "dte_max": int(dte.max()),
                    "dte_le_7": int((dte <= 7).sum())})
    return res


def oi_timestamps(ds):
    fs = files(ds)
    res = []
    for f in fs[:: max(1, len(fs) // 6)]:
        df = pd.read_csv(f, compression="gzip", usecols=["timestamp"], nrows=2000)
        res.append({"date": ymd(f), "timestamps": sorted(df.timestamp.astype(str).str[11:19].unique().tolist())[:5]})
    return res


def main():
    m = manifest()
    inv = {"datasets": {}}
    for ds in sorted(m.dataset.unique()):
        inv["datasets"][ds] = dataset_summary(m, ds)

    tdays = trading_days(m)
    inv["trading_days"] = {"count": len(tdays), "first": tdays[0] if tdays else None, "last": tdays[-1] if tdays else None}

    # 0DTE coverage vs trading days
    for ds in ["SPXW/trade_quote_dte0", "SPXW/quote_1m_dte0"]:
        have = {ymd(f) for f in files(ds)}
        missing = [d for d in tdays if d not in have]
        inv["datasets"].setdefault(ds, {})["trading_days_without_file"] = missing

    closes = spx_closes()
    inv["spx_close_source"] = "SPXW/greeks_eod underlying_price"
    inv["spx_close_timestamps_sample"] = sorted({v[1][11:19] for v in closes.values()})[:5]

    tws = tws_spot()
    if tws is not None:
        n = tws.groupby(tws.ts.dt.strftime("%Y%m%d")).size()
        inv["tws_spot"] = {"days": int(len(n)), "first": n.index[0], "last": n.index[-1],
                           "bars_per_day": Counter(n.tolist()).most_common(5),
                           "short_days": n[n < 390].index.tolist(),
                           "trading_days_without_bars": [d for d in tdays if d not in n.index],
                           "bar_days_not_in_oi": [d for d in n.index if d not in set(tdays) and d >= tdays[0] and d <= tdays[-1]]}

    qstats = []
    for f in files("SPXW/quote_1m_dte0"):
        c = closes.get(ymd(f), (None, None))[0]
        qstats.append(quote_day_stats(f, c, tws))
        print("quote", ymd(f), file=sys.stderr, flush=True)
    q = pd.DataFrame(qstats)
    if len(q):
        q.to_csv(os.path.join(ROOT, "reports", "step0_quote_days.csv"), index=False)
        err = q.parity_err_close.dropna()
        inv["quote_1m"] = {
            "days": int(len(q)),
            "minutes_per_contract": Counter(q.minutes_per_contract.tolist()).most_common(5),
            "last_ts": Counter(q.last_ts.tolist()).most_common(5),
            "short_days": q[q.last_ts < "15:59:00"][["date", "last_ts"]].to_dict("records"),
            "contracts_median": int(q.contracts.median()),
            "share_no_bid_median": float(q.share_no_bid.median()),
            "share_crossed_max": float(q.share_crossed.max()),
            "share_wide_median": float(q.share_wide.median()),
            "parity_err_close": {
                "n": int(len(err)),
                "mean": round(float(err.mean()), 3),
                "median": round(float(err.median()), 3),
                "abs_p50": round(float(err.abs().median()), 3),
                "abs_p95": round(float(err.abs().quantile(0.95)), 3),
                "abs_max": round(float(err.abs().max()), 3),
                "worst": q.loc[err.abs().sort_values().index[-5:], ["date", "parity_last", "parity_err_close"]].to_dict("records"),
            },
            "parity_step_abs_med_median": round(float(q.parity_step_abs_med.median()), 3),
        }
        if "parity_vs_tws_abs_med" in q:
            inv["quote_1m"]["parity_vs_tws"] = {
                "days": int(q.parity_vs_tws_abs_med.notna().sum()),
                "mean_of_daily_mean": round(float(q.parity_vs_tws_mean.mean()), 3),
                "abs_med_median": round(float(q.parity_vs_tws_abs_med.median()), 3),
                "abs_p95_median": round(float(q.parity_vs_tws_abs_p95.median()), 3),
                "abs_p95_worst": round(float(q.parity_vs_tws_abs_p95.max()), 3),
                "worst_days": q.sort_values("parity_vs_tws_abs_p95").tail(5)[["date", "parity_vs_tws_abs_med", "parity_vs_tws_abs_p95"]].to_dict("records"),
            }
            lc = q.tws_last_minus_close.dropna()
            inv["quote_1m"]["tws_last_bar_vs_close"] = {
                "days": int(len(lc)), "exact": int((lc.abs() < 0.005).sum()), "abs_max": float(lc.abs().max()),
                "off_days": q.loc[lc[lc.abs() >= 0.005].index, ["date", "tws_last_minus_close"]].to_dict("records")[:20]}

    inv["expiry_coverage"] = {ds: eod_expiry_coverage(ds) for ds in ["SPXW/oi", "SPX/oi", "SPXW/greeks_eod", "SPX/greeks_eod"]}
    inv["oi_timestamps"] = {ds: oi_timestamps(ds) for ds in ["SPXW/oi", "SPX/oi"]}

    with open(os.path.join(ROOT, "reports", "step0_inventory.json"), "w") as f:
        json.dump(inv, f, indent=1, default=str)
    print(json.dumps(inv, indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
