"""P-0025 / P-0026 daily signal cache (B-pools, training pools only).

Per (pool, sym, date) from greeks_eod:
  px        underlying_price (16:00 close)
  vs, vs_n  P-0025: equal-weight mean of (IV_call - IV_put) over same-strike same-expiry
            pairs, both legs pass quote quality, DTE in [7,30], call delta in [0.25,0.75]
  c21, p21  P-0026: 21-day constant-maturity ATM (delta +/-0.5) IV, calls / puts
  kept, offgrid, nstrk   data checks (strike-grid continuity vs previous file, share of
            strikes off the 0.5 grid, strike count)

Time wall: only the five training pools; files with date >= 2023-10-31 are never opened,
and the first statement after each read filters date < 2023-10-31 again.
Output: src/proposer/P-0025_cache/daily.parquet (ThetaData-derived; *.parquet is gitignored).
"""
import os, glob, sys
import numpy as np
import pandas as pd
from multiprocessing import Pool

CUTOFF = pd.Timestamp("2023-10-31")
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031"]
DATA = os.path.expanduser("~/Data")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0025_cache")
COLS = ["expiration", "strike", "right", "bid", "ask", "delta", "implied_vol", "iv_error",
        "underlying_price"]


def quality(df):
    mid = (df.bid + df.ask) / 2
    return ((df.bid > 0) & (df.ask > df.bid) & ((df.ask - df.bid) / mid <= 0.5)
            & (df.implied_vol > 0) & (df.implied_vol <= 10) & (df.iv_error.abs() < 1))


def atm_iv(sub, target):
    """IV at delta=target by linear interpolation between the two nearest bracketing
    contracts with |delta| in [0.25, 0.75]."""
    s = sub[(sub.delta.abs() >= 0.25) & (sub.delta.abs() <= 0.75)]
    lo = s[s.delta <= target]
    hi = s[s.delta >= target]
    if lo.empty or hi.empty:
        return np.nan
    a = lo.loc[lo.delta.idxmax()]
    b = hi.loc[hi.delta.idxmin()]
    if b.delta == a.delta:
        return float(a.implied_vol)
    w = (target - a.delta) / (b.delta - a.delta)
    return float(a.implied_vol + w * (b.implied_vol - a.implied_vol))


def cm21(per_exp):
    """per_exp: list of (dte, iv). Total-variance interpolation to 21 days."""
    pe = sorted([(t, v) for t, v in per_exp if np.isfinite(v)])
    if not pe:
        return np.nan
    lo = [p for p in pe if p[0] <= 21]
    hi = [p for p in pe if p[0] >= 21]
    if lo and hi:
        (t1, v1), (t2, v2) = lo[-1], hi[0]
        if t1 == t2:
            return v1
        w1, w2 = v1 ** 2 * t1, v2 ** 2 * t2
        w = w1 + (w2 - w1) * (21 - t1) / (t2 - t1)
        return float(np.sqrt(max(w, 0) / 21))
    cand = [p for p in pe if 14 <= p[0] <= 30]
    if not cand:
        return np.nan
    return min(cand, key=lambda p: abs(p[0] - 21))[1]


def one_symbol(args):
    pool, sym = args
    files = sorted(glob.glob(os.path.join(DATA, f"thetadata_univ_{pool}", sym, "greeks_eod", "*", "*.csv.gz")))
    files = [f for f in files if os.path.basename(f)[:8] < "20231031"]  # never open test-period files
    rows, prev = [], None
    for f in files:
        d = pd.Timestamp(os.path.basename(f)[:8])
        try:
            df = pd.read_csv(f, usecols=COLS)
        except Exception:
            df = pd.DataFrame(columns=COLS)
        df["date"] = d
        df = df[df["date"] < CUTOFF]  # time wall: first statement after reading
        if df.empty:
            rows.append(dict(pool=pool, sym=sym, date=d, px=np.nan, vs=np.nan, vs_n=0,
                             c21=np.nan, p21=np.nan, kept=np.nan, offgrid=np.nan, nstrk=0))
            prev = None
            continue
        px = float(df.underlying_price.iloc[0])
        df["exp"] = pd.to_datetime(df.expiration)
        df["dte"] = (df.exp - d).dt.days
        # data checks on the full grid
        grid = {e: set(g.strike.round(4)) for e, g in df.groupby("exp")}
        kept = np.nan
        if prev is not None:
            common = [e for e in grid if e in prev]
            if common:
                kept = sum(len(prev[e] & grid[e]) for e in common) / sum(len(prev[e]) for e in common)
        prev = grid
        allk = df.strike.unique()
        offgrid = float(np.mean(np.abs(allk * 2 - np.round(allk * 2)) > 1e-6)) if len(allk) else np.nan
        q = df[quality(df) & (df.dte >= 7) & (df.dte <= 30)]
        c = q[q.right == "CALL"]
        p = q[q.right == "PUT"]
        # P-0025 pairs
        m = c.merge(p, on=["exp", "strike"], suffixes=("_c", "_p"))
        m = m[(m.delta_c >= 0.25) & (m.delta_c <= 0.75)]
        vs_n = len(m)
        vs = float((m.implied_vol_c - m.implied_vol_p).mean()) if vs_n >= 2 else np.nan
        # P-0026 21-day ATM
        ce = [(int(t), atm_iv(g, 0.5)) for t, g in c.groupby("dte")]
        pe = [(int(t), atm_iv(g, -0.5)) for t, g in p.groupby("dte")]
        rows.append(dict(pool=pool, sym=sym, date=d, px=px, vs=vs, vs_n=vs_n,
                         c21=cm21(ce), p21=cm21(pe), kept=kept, offgrid=offgrid, nstrk=len(allk)))
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = []
    for pool in POOLS:
        syms = open(f"/Users/dafrix/Developer/ibkr/work/datrix-qt/research/call_spread_edge/universe/UNIVERSE_{pool}.txt").read().strip().split(",")
        for s in syms:
            s = s.strip()
            if not os.path.isdir(os.path.join(DATA, f"thetadata_univ_{pool}", s)):
                print("missing dir", pool, s, file=sys.stderr)
            jobs.append((pool, s))
    with Pool(8) as pl:
        res = pl.map(one_symbol, jobs, chunksize=1)
    out = pd.DataFrame([r for rr in res for r in rr])
    out = out[out.date < CUTOFF]
    out.to_parquet(os.path.join(OUT, "daily.parquet"), index=False)
    print(out.groupby("pool").agg(n=("sym", "size"), syms=("sym", "nunique"),
                                  vs_ok=("vs", lambda x: x.notna().mean()),
                                  c21_ok=("c21", lambda x: x.notna().mean()),
                                  p21_ok=("p21", lambda x: x.notna().mean())))


if __name__ == "__main__":
    main()
