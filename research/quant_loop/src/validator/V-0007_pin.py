"""V-0007: independent rebuild of P-0007 (OI pin within +-10 at 14:00), TRAINING PERIOD ONLY.
Written from BRIEF.md data dictionary; does not import proposer code.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0007_pin.py
"""
import os, gzip
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0007_tables")
WALL = pd.Timestamp("2024-11-01")

CAL = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
CAL = CAL.loc[CAL.index < WALL]                                   # time wall, first step
SP = pd.read_parquet(f"{R}/data/clean/spot.parquet")
SP = SP.loc[SP.ts < WALL].set_index("ts")                         # time wall, first step
CFG = yaml.safe_load(open(f"{R}/config.yaml"))["fills"]
K_DEF = float(CFG["k_default"])
MULT = CFG["multiplier"]
def _tiers(lst): return [(float(x["below"]), float(x["fee"])) for x in lst]
COMM = _tiers(CFG["commission"]); EXCH = _tiers(CFG["exchange"])
SUR = float(CFG["execution_surcharge"])
OTHER = sum(float(v) for k, v in CFG.items() if k in ("regulatory", "clearing", "orf", "occ", "regulatory_clearing"))
MINC = float(CFG["commission_min_per_leg"])


def fee(tiers, p):
    for b, f in tiers:
        if p < b:
            return f
    return tiers[-1][1]


def leg_cost(px, n):
    return max(fee(COMM, px) * n, MINC) + n * (fee(EXCH, px) + SUR + OTHER)


def putfly(K, w, bk, settle, k):
    """long P(K-w), short 2 P(K), long P(K+w); returns USD incl. opening fees. bk: dict (strike)->(bid,ask)"""
    tot = 0.0
    for strike, qty in ((K - w, 1), (K, -2), (K + w, 1)):
        b, a = bk[strike]
        px = 0.5 * (a + b) + np.sign(qty) * k * 0.5 * (a - b)
        tot += -qty * px * MULT - leg_cost(px, abs(qty)) + qty * max(strike - settle, 0.0) * MULT
    return tot


def oi_for(d):
    p = f"{R}/data/raw/SPXW/oi/{d.year}/{d:%Y%m%d}.csv.gz"
    if not os.path.exists(p):
        return None
    o = pd.read_csv(p, usecols=["expiration", "strike", "right", "open_interest"])
    o["expiration"] = pd.to_datetime(o.expiration)
    o = o.loc[(o.expiration < WALL) & (o.expiration == d)]       # D file = D-1 close; 0DTE only
    return o.groupby("strike")["open_interest"].sum().to_dict()


def choose(cands, oi, S, largest):
    rows = sorted(cands, key=lambda K: ((-1 if largest else 1) * oi.get(K, 0), abs(K - S), K))
    return rows[0]


def day(d):
    f = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    t, t0 = d + pd.Timedelta(hours=14), d + pd.Timedelta(hours=9, minutes=30)
    if not os.path.exists(f) or t not in SP.index or t0 not in SP.index:
        return None
    c = pd.read_parquet(f, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    c = c.loc[(c.ts < WALL) & (c.ts == t)]
    S = float(SP.at[t, "spot"]); F = float(SP.at[t, "parity_F"]); O = float(SP.at[t0, "spot"])
    st = float(CAL.at[d, "settle"])
    good = c.loc[~c.flag_bad.astype(bool)]
    puts = {float(r.strike): (float(r.bid), float(r.ask)) for r in good.loc[good.right == "P"].itertuples()}
    calls = {float(r.strike): float(r.mid) for r in good.loc[good.right == "C"].itertuples()}
    pmid = {float(r.strike): float(r.mid) for r in good.loc[good.right == "P"].itertuples()}
    allK = np.array(sorted(set(good.strike.astype(float))))
    rec = dict(date=d, S=S, F=F, O=O, settle=st)
    # nearest 5-pt strike to S on the pure grid (validator choice: grid, not chain availability)
    K0g = 5 * np.round(S / 5)
    K0 = float(allK[np.argmin(np.abs(allK - S))]) if len(allK) else np.nan
    lo, hi = np.ceil((S - 10) / 5) * 5, np.floor((S + 10) / 5) * 5
    cands = [float(x) for x in np.arange(lo, hi + 1e-9, 5)]
    oi = oi_for(d)
    ok = oi is not None and sum(oi.get(K, 0) for K in cands) > 0
    if ok:
        Ks = choose(cands, oi, S, True)
        Kmin = choose([K for K in cands if K != Ks], oi, S, False)
    else:
        Ks = Kmin = K0
    rec.update(K0=K0, K0g=K0g, Ks=Ks, Kmin=Kmin, oi_ok=ok, ncand=len(cands),
               oiKs=oi.get(Ks, 0) if ok else 0, oiK0=oi.get(K0, 0) if ok else 0)
    if K0 not in calls or K0 not in pmid:
        rec["drop"] = "missing"; return rec
    I = calls[K0] + pmid[K0]
    w = min((20, 25, 30, 50, 75), key=lambda x: abs(x / I - 2))
    rec.update(I=I, w=w)
    need = {K0 - w, K0, K0 + w, Ks - w, Ks, Ks + w}
    if not need <= set(puts):
        rec["drop"] = "missing"; return rec
    if max(puts[x][1] - puts[x][0] for x in need) > 3.0:
        rec["drop"] = "wide"; return rec
    rec["drop"] = ""
    for k, tag in ((K_DEF, ""), (0.5, "_k05"), (0.0, "_k0")):
        rec["R" + tag] = putfly(Ks, w, puts, st, k)
        rec["R0" + tag] = putfly(K0, w, puts, st, k)
    return rec


if __name__ == "__main__":
    print("fees: comm", COMM, "exch", EXCH, "sur", SUR, "other", OTHER, "min", MINC, "k", K_DEF)
    days = [d for d in CAL.index if not CAL.at[d, "half_day"] and CAL.at[d, "has_0dte"]]
    with ProcessPoolExecutor(6) as ex:
        out = [r for r in ex.map(day, days, chunksize=8) if r]
    df = pd.DataFrame(out)
    df = df.loc[df.date < WALL]
    df.to_csv(f"{OUT}/days.csv", index=False)
    print(len(df), df["drop"].value_counts().to_dict())
