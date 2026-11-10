"""V-0028/0029 post-run data audit (does NOT change any rule or number in the test).
Put-call parity forward F = K + C - P at the ATM strike vs spot (14:00) and vs settle (15:59 quotes), A-hist and training,
plus the main session's ahist_quality_14h.csv as an independent read of the 14:00 snapshot."""
import glob, os, sys
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
import numpy as np, pandas as pd
RAW = os.path.expanduser("~/Data/thetadata/SPXW")
HERE = os.path.dirname(os.path.abspath(__file__))
CA = os.path.join(HERE, "V-0028_cache")

def par(args):
    d, f = args
    iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
    q = pd.read_csv(f, usecols=["expiration", "strike", "right", "timestamp", "bid", "ask"])
    q = q[q.expiration == iso]
    out = {"date": iso}
    for hm in ("14:00", "15:59"):
        s = q[q.timestamp == f"{iso}T{hm}:00.000"]
        s = s[(s.bid > 0) & (s.ask > s.bid)]
        m = s.assign(mid=(s.bid + s.ask) / 2).pivot_table(index="strike", columns="right", values="mid")
        if not {"CALL", "PUT"} <= set(m.columns):
            continue
        m = m.dropna()
        if not len(m):
            continue
        m["F"] = m.index + m.CALL - m.PUT
        k = (m.CALL - m.PUT).abs().idxmin()
        out[f"F_{hm}"] = float(m.loc[k, "F"])
    return out

def run(lo, hi):
    fs = {os.path.basename(f)[:8]: f for f in glob.glob(os.path.join(RAW, "quote_1m_dte0", "*", "*.csv.gz"))}
    fs = sorted((d, f) for d, f in fs.items() if lo <= d <= hi)
    with ProcessPoolExecutor(8, mp_context=multiprocessing.get_context("fork")) as ex:
        return pd.DataFrame(list(ex.map(par, fs, chunksize=2))).assign(date=lambda x: pd.to_datetime(x.date)).set_index("date")

for tag, lo, hi in (("test", "20200102", "20220429"), ("train", "20220502", "20261029")):
    p = run(lo, hi)
    days = pd.read_parquet(os.path.join(CA, f"{tag}_days.parquet")).set_index("date")
    cl = pd.read_parquet(os.path.join(CA, f"{tag}_closes.parquet")).set_index("date")
    p["spot"] = days.spot; p["settle"] = cl.close.reindex(p.index)
    a = (p["F_14:00"] - p.spot); b = (p["F_15:59"] - p.settle)
    print(f"{tag}: n {len(p)} | F(14:00)-spot median {a.median():+.2f}, |.| 95% {a.abs().quantile(.95):.2f}, max {a.abs().max():.2f} ({a.abs().idxmax().date()})"
          f" | F(15:59)-settle median {b.median():+.2f}, |.| 95% {b.abs().quantile(.95):.2f}, max {b.abs().max():.2f} ({b.abs().idxmax().date()})")
    big = b.abs()[b.abs() > 5]
    print("   days |F(15:59)-settle| > 5:", [(d.date(), round(v, 1)) for d, v in big.items()][:20])
cl = pd.read_parquet(os.path.join(CA, "test_closes.parquet")).set_index("date").close
print("known SPX official closes vs greeks_eod:", {d: cl.get(pd.Timestamp(d)) for d in ("2020-02-19", "2020-03-16", "2020-03-23", "2020-12-31", "2021-12-31", "2022-04-29")})
qa = pd.read_csv(os.path.join(HERE, "..", "..", "data", "ahist_quality_14h.csv"))
print("ahist_quality columns:", list(qa.columns))
