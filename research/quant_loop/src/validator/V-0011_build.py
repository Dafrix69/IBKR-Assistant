"""V-0011: independent per-day build for P-0011 (post-non-trading-day 10:00 0DTE iron fly, wing ~2xI, held to settle).
Does not import proposer code. Fees from config.yaml.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0011_build.py train
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0011_build.py test     # run once
train: every input filtered to date < 2024-11-01 as the first step.
test : rows for date >= 2024-11-01 only (written to days_test.csv; only V-0011_test.py reads it).
"""
import os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0011_tables")
WALL = pd.Timestamp("2024-11-01")
PHASE = sys.argv[1] if len(sys.argv) > 1 else "train"
assert PHASE in ("train", "test")

cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
if PHASE == "train":
    cal = cal[cal.index < WALL]                                   # TIME WALL, first step
spot = pd.read_parquet(f"{R}/data/clean/spot.parquet")
if PHASE == "train":
    spot = spot[spot.ts < WALL]                                   # TIME WALL, first step
spot = spot.set_index("ts").spot
fills = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]

td = list(cal.index)                                              # full trading calendar incl. half days
GAP = {d: (d - p).days for p, d in zip(td[:-1], td[1:])}          # calendar days since previous session


def fee_leg(px):
    com = next(t["fee"] for t in fills["commission"] if px < float(t["below"]))
    exc = next(t["fee"] for t in fills["exchange"] if px < float(t["below"]))
    return max(com, fills["commission_min_per_leg"]) + exc + fills["execution_surcharge"] + fills["regulatory_clearing"]


def wing(I):
    grid = np.arange(10, 1000, 5, dtype=float)
    g = np.abs(grid - 2 * I)
    return float(grid[np.where(g <= g.min() + 1e-9)[0][0]])      # tie -> narrower


def fly(q, K, w, settle):
    """short iron fly; returns dict or reason string"""
    legs = [(K, "C", -1), (K, "P", -1), (K + w, "C", 1), (K - w, "P", 1)]
    qs = []
    for k, r, s in legs:
        if (k, r) not in q.index:
            return "missing"
        b, a = float(q.at[(k, r), "bid"]), float(q.at[(k, r), "ask"])
        if a - b > 2.0:
            return "spread"
        if s < 0 and b <= 0:
            return "shortbid"
        qs.append((b, a, s))
    o = {"wing_ask0": int(any(a <= 0 for b, a, s in qs if s > 0))}
    pay = min(abs(settle - K), w) * 100
    for kk, tag in ((0.0, "k0"), (0.2, "k20"), (0.5, "k50")):
        pxs = [((b + a) / 2 + s * kk * (a - b) / 2, s) for b, a, s in qs]
        cash = -sum(s * px for px, s in pxs) * 100                # credit received
        fee = sum(fee_leg(px) for px, s in pxs)
        o[tag] = cash - fee - pay
    o["credit_mid"] = -sum(s * (b + a) / 2 for b, a, s in qs)
    return o


def day(d):
    f = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(f):
        return None
    ch = pd.read_parquet(f, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    if PHASE == "train":
        ch = ch[ch.ts < WALL]                                     # TIME WALL per file
    ch = ch[~ch.flag_bad.astype(bool)]
    settle = float(cal.at[d, "settle"])
    o = {"date": d, "settle": settle, "gap": GAP.get(d, np.nan)}
    for hm in ("09:35", "10:00", "10:30", "14:00"):
        t = pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
        tag = hm.replace(":", "")
        if t not in spot.index:
            continue
        S = float(spot.at[t])
        q = ch[ch.ts == t].set_index(["strike", "right"]).sort_index()
        C = set(k for k, r in q.index if r == "C"); P = set(k for k, r in q.index if r == "P")
        ks = np.array(sorted(C & P), dtype=float)
        if len(ks) == 0:
            continue
        dd = np.abs(ks - S); K = float(ks[np.where(dd <= dd.min() + 1e-9)[0][0]])   # tie -> lower
        I = float(q.at[(K, "C"), "mid"] + q.at[(K, "P"), "mid"])
        o.update({f"S{tag}": S, f"K{tag}": K, f"I{tag}": I})
        if hm not in ("10:00", "10:30"):
            continue
        w = wing(I); o[f"w{tag}"] = w
        for dw, nm in ((0, ""), (-5, "_wm"), (5, "_wp")):
            if dw and hm != "10:00":
                continue
            ww = w + dw
            if ww < 10:
                o[f"why{tag}{nm}"] = "w<10"; continue
            r = fly(q, K, ww, settle)
            if isinstance(r, str):
                o[f"why{tag}{nm}"] = r; continue
            o[f"why{tag}{nm}"] = "ok"
            for kk in ("k0", "k20", "k50"):
                o[f"pnl{tag}{nm}_{kk}"] = r[kk]
            if not nm:
                o[f"credit{tag}"] = r["credit_mid"]; o[f"wingask0_{tag}"] = r["wing_ask0"]
    return o


if __name__ == "__main__":
    use = cal[(~cal.half_day.astype(bool)) & cal.has_0dte.astype(bool)]
    if PHASE == "test":
        use = use[use.index >= WALL]
    with ProcessPoolExecutor(6) as ex:
        rows = [r for r in ex.map(day, list(use.index), chunksize=8) if r is not None]
    df = pd.DataFrame(rows)
    if PHASE == "train":
        df = df[df.date < WALL]                                    # TIME WALL again
    c = cal.loc[df.date]
    for col in ("fomc", "cpi", "nfp", "pce", "vix_prev_close", "spx_ret_prev"):
        df[col] = c[col].values
    # baseline A same day (14:00 put fly, width with w/implied nearest 2, skip prev <= -1%), winrate_panel k 0.25
    wp = pd.read_parquet(f"{R}/data/clean/winrate_panel.parquet")
    if PHASE == "train":
        wp = wp[wp.date < WALL]                                    # TIME WALL
    b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
    b["dd"] = (b.w_over_implied - 2).abs()
    b = b.sort_values(["date", "dd", "width"]).groupby("date").head(1)
    b = b.merge(cal[["spx_ret_prev"]], left_on="date", right_index=True)
    b = b[~(b.spx_ret_prev <= -0.01)]
    df = df.merge(b[["date", "pnl", "pnl_k0"]].rename(columns={"pnl": "baseA_k25", "pnl_k0": "baseA_k0"}), on="date", how="left")
    df.to_csv(f"{OUT}/days_{PHASE}.csv", index=False)
    print(PHASE, len(df), (df.gap >= 2).sum(), (df.why1000 == "ok").sum(), df.why1000.value_counts().to_dict(),
          "wing ask0:", df.get("wingask0_1000", pd.Series(dtype=float)).sum())
