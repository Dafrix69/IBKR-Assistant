"""V-0012: independent per-day build for P-0012 (PNT 10:00 short 0DTE iron fly, w ~ 2xI, closed at 14:00 by quotes).
Does not import proposer code. Fees from config.yaml.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0012_build.py train
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0012_build.py test     # run once
train: every input filtered to date < 2024-11-01 as the first step.
test : rows for date >= 2024-11-01 only (days_test.csv).
Exit rule (spec): at t in base..base+10 min, legs to be traded must be present, not flag_bad, ask-bid <= 2.
  Wings: if the raw row (flag_bad or not) has bid == 0 the wing is not traded and is kept to settle (intrinsic).
  Proposer variant ("prop"): wing must be present among non-flag_bad rows first (bid0 & ask>1 -> defer). Both recorded.
"""
import os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pandas as pd
import yaml

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0012_tables")
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
KS = {"k0": 0.0, "k20": 0.20, "k50": 0.5}
td = list(cal.index)
GAP = {d: (d - p).days for p, d in zip(td[:-1], td[1:])}


def fee_leg(px):
    com = next(t["fee"] for t in fills["commission"] if px < float(t["below"]))
    exc = next(t["fee"] for t in fills["exchange"] if px < float(t["below"]))
    return max(com, fills["commission_min_per_leg"]) + exc + fills["execution_surcharge"] + fills["regulatory_clearing"]


def wing(I):
    grid = np.arange(10, 1000, 5, dtype=float)
    g = np.abs(grid - 2 * I)
    return float(grid[np.where(g <= g.min() + 1e-9)[0][0]])      # tie -> narrower


def atm(good, S):
    c = good[good.right == "C"].set_index("strike")
    p = good[good.right == "P"].set_index("strike")
    ks = np.array(sorted(set(c.index) & set(p.index)), float)
    if len(ks) == 0:
        return None, None, None, None
    dist = np.abs(ks - S)
    K = float(ks[np.where(dist <= dist.min() + 1e-9)[0][0]])        # tie -> lower
    return K, float(c.at[K, "mid"] + p.at[K, "mid"]), float(c.at[K, "mid"]), float(p.at[K, "mid"])


def intrinsic(K, r, s):
    return max(s - K, 0.0) if r == "C" else max(K - s, 0.0)


def build_fly(o, tag, g10, raw_by_t, good_by_t, K, w, settle, t_of):
    legs = [(K, "C", -1), (K, "P", -1), (K + w, "C", 1), (K - w, "P", 1)]
    q = g10
    qs = []
    for k, r, s in legs:
        if (k, r) not in q.index:
            o[f"ok{tag}"] = False; return
        b, a = float(q.at[(k, r), "bid"]), float(q.at[(k, r), "ask"])
        if a - b > 2.0 or (s < 0 and b <= 0):
            o[f"ok{tag}"] = False; return
        qs.append((k, r, s, b, a))
    o[f"ok{tag}"] = True
    V10 = -sum(s * (b + a) / 2 for k, r, s, b, a in qs)
    o[f"V10{tag}"] = V10
    o[f"pay{tag}"] = min(abs(settle - K), w)
    ent = {}
    for nm, kk in KS.items():
        pxs = [((b + a) / 2 + s * kk * (a - b) / 2, s) for k, r, s, b, a in qs]
        ent[nm] = (sum(s * px for px, s in pxs), sum(fee_leg(px) for px, s in pxs))   # cash out (neg=credit), fees
        o[f"hold{tag}_{nm}"] = (-ent[nm][0] - o[f"pay{tag}"]) * 100 - ent[nm][1]
    # mark-only mids (no fallback)
    for hm in ("13:00", "14:00", "15:00"):
        gq = good_by_t.get(t_of(hm))
        hh = hm.replace(":", "")
        if gq is not None and all((k, r) in gq.index for k, r, s, b, a in qs):
            o[f"V{hh}{tag}"] = -sum(s * float(gq.at[(k, r), "mid"]) for k, r, s, b, a in qs)
    # tradable exits
    for hm in ("13:00", "14:00", "15:00"):
        hh = hm.replace(":", "")
        for variant in ("", "_prop"):
            if tag != "" and variant:
                continue
            done = False
            for m in range(11):
                t = t_of(hm) + pd.Timedelta(minutes=m)
                gq, rq = good_by_t.get(t), raw_by_t.get(t)
                if gq is None:
                    continue
                trade, kept, good = [], [], True
                for k, r, s, b0, a0 in qs:
                    if s > 0:
                        if variant == "_prop":
                            if (k, r) not in gq.index:
                                good = False; break
                            b, a = float(gq.at[(k, r), "bid"]), float(gq.at[(k, r), "ask"])
                            if b <= 0:
                                kept.append((k, r)); continue
                        else:
                            if rq is not None and (k, r) in rq.index and float(rq.at[(k, r), "bid"]) <= 0:
                                kept.append((k, r)); continue
                            if (k, r) not in gq.index:
                                good = False; break
                            b, a = float(gq.at[(k, r), "bid"]), float(gq.at[(k, r), "ask"])
                    else:
                        if (k, r) not in gq.index:
                            good = False; break
                        b, a = float(gq.at[(k, r), "bid"]), float(gq.at[(k, r), "ask"])
                    if a - b > 2.0:
                        good = False; break
                    trade.append((k, r, s, b, a))
                if not good:
                    continue
                resid = sum(intrinsic(k, r, settle) for k, r in kept)
                for nm, kk in KS.items():
                    cash, fees = ent[nm]
                    xc = 0.0
                    for k, r, s, b, a in trade:
                        px = (b + a) / 2 - s * kk * (a - b) / 2
                        xc += s * px
                        fees += fee_leg(px)
                    o[f"x{hh}{tag}{variant}_{nm}"] = (-cash + xc + resid) * 100 - fees
                o[f"xmin{hh}{tag}{variant}"] = m
                o[f"kept{hh}{tag}{variant}"] = len(kept)
                o[f"resid{hh}{tag}{variant}"] = resid * 100
                done = True
                break
            if not done:
                for nm in KS:
                    o[f"x{hh}{tag}{variant}_{nm}"] = o[f"hold{tag}_{nm}"]
                o[f"xmin{hh}{tag}{variant}"] = -1
                o[f"kept{hh}{tag}{variant}"] = 0
                o[f"resid{hh}{tag}{variant}"] = np.nan


def day(d):
    f = f"{R}/data/clean/chain_{d:%Y%m%d}.parquet"
    if not os.path.exists(f):
        return None
    ch = pd.read_parquet(f, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    if PHASE == "train":
        ch = ch[ch.ts < WALL]                                     # TIME WALL per file
    settle = float(cal.at[d, "settle"])
    t_of = lambda hm: pd.Timestamp(f"{d:%Y-%m-%d} {hm}")
    o = {"date": d, "settle": settle, "gap": GAP.get(d, np.nan)}
    times = [t_of("10:00")] + [t_of(h) + pd.Timedelta(minutes=m) for h in ("13:00", "14:00", "15:00") for m in range(11)]
    sub = ch[ch.ts.isin(times)]
    raw_by_t = {t: g.set_index(["strike", "right"]) for t, g in sub.groupby("ts")}
    good_by_t = {t: g[~g.flag_bad.astype(bool)].set_index(["strike", "right"]) for t, g in sub.groupby("ts")}
    t0 = t_of("10:00")
    if t0 not in spot.index or t0 not in good_by_t:
        return o
    S10 = float(spot.at[t0]); o["S10"] = S10
    g10 = good_by_t[t0]
    K, I, cm, pm = atm(g10.reset_index(), S10)
    if K is None:
        return o
    w = wing(I)
    o.update({"K": K, "I10": I, "w": w, "F10": K + cm - pm})
    build_fly(o, "", g10, raw_by_t, good_by_t, K, w, settle, t_of)
    for dw, tg in ((-5, "_wm"), (5, "_wp")):
        if w + dw >= 10:
            build_fly(o, tg, g10, raw_by_t, good_by_t, K, w + dw, settle, t_of)
    t14 = t_of("14:00")
    if t14 in spot.index and t14 in good_by_t:
        S14 = float(spot.at[t14])
        K14, I14, _, _ = atm(good_by_t[t14].reset_index(), S14)
        o.update({"S14": S14, "I14": I14})
    return o


if __name__ == "__main__":
    use = cal[(~cal.half_day.astype(bool)) & cal.has_0dte.astype(bool)]
    if PHASE == "test":
        use = use[use.index >= WALL]
    with ProcessPoolExecutor(6) as ex:
        rows = [r for r in ex.map(day, list(use.index), chunksize=4) if r is not None]
    df = pd.DataFrame(rows)
    if PHASE == "train":
        df = df[df.date < WALL]
    else:
        df = df[df.date >= WALL]
    c = cal.loc[df.date]
    df["event"] = c[["fomc", "cpi", "nfp", "pce"]].any(axis=1).values
    df["spx_ret_prev"] = c.spx_ret_prev.values
    df["pnt"] = df.gap >= 2
    nxt = {td[i + 1]: GAP.get(td[i], 0) >= 2 for i in range(len(td) - 1)}
    df["pnt1"] = df.date.map(nxt).fillna(False).astype(bool) & ~df.pnt
    df["wd"] = pd.to_datetime(df.date).dt.dayofweek
    df.to_csv(f"{OUT}/days_{PHASE}.csv", index=False)
    print(PHASE, len(df), int(df.ok.fillna(False).sum()))
