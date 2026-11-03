"""V-0001: independent validation of P-0001 (Treasury coupon-auction days, 13:00 ET 0DTE put fly).

    PY=research/spx_fly/.venv/bin/python
    $PY research/quant_loop/src/validator/V-0001_auction.py calendar
    $PY research/quant_loop/src/validator/V-0001_auction.py build   --period train
    $PY research/quant_loop/src/validator/V-0001_auction.py analyze --period train
    $PY research/quant_loop/src/validator/V-0001_auction.py build   --period test     # once
    $PY research/quant_loop/src/validator/V-0001_auction.py analyze --period test     # once

Written from the data dictionary (spx_fly/reports/mining/BRIEF.md) and config.yaml only. Imports
nothing from research/quant_loop/src/proposer and nothing from research/spx_fly/src (own fee model).
Time wall: every data read is followed immediately by the period filter; chain files of the other
period are never opened (filename date checked before the read).
"""
import argparse
import glob
import json
import os

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
QL = os.path.normpath(os.path.join(HERE, "..", ".."))
R = os.path.normpath(os.path.join(QL, "..", "spx_fly"))
CLEAN = os.path.join(R, "data", "clean")
F = yaml.safe_load(open(os.path.join(R, "config.yaml")))["fills"]
OUT = os.path.join(QL, "validations", "V-0001_tables")
CACHE = os.path.join(HERE, "V-0001_cache")
WALL = pd.Timestamp("2024-11-01")
ENTRIES = ["12:50", "13:00", "13:10", "14:00"]
WIDTHS = [20, 25, 30, 50, 75]
KS = {"k0": 0.0, "k20": 0.20, "k25": 0.25, "k50": 0.50}
SEED = 20261101


def in_period(d, period):
    d = pd.Timestamp(d)
    return d < WALL if period == "train" else d >= WALL


# ------------------------------------------------------------------ auction calendar
def build_calendar():
    """Coupon auctions closing 13:00 ET that were announced before the auction day."""
    fd = pd.DataFrame(json.load(open(os.path.join(HERE, "V-0001_fiscaldata_auctions_query_20261101.json")))["data"])
    fd = fd[fd.security_type.isin(["Note", "Bond"]) & (fd.closing_time_comp == "01:00 PM")].copy()
    fd["offering"] = pd.to_numeric(fd.offering_amt, errors="coerce")
    fd["ex_ante"] = pd.to_datetime(fd.announcemt_date) < pd.to_datetime(fd.auction_date)
    dropped = fd[~fd.ex_ante | (fd.offering < 1e9)]
    fd = fd[fd.ex_ante & (fd.offering >= 1e9)]
    rows = fd[["auction_date", "announcemt_date", "security_term", "original_security_term"]].rename(
        columns={"announcemt_date": "announce_date"})
    rows["src"] = "fiscaldata"
    td = pd.DataFrame(json.load(open(os.path.join(HERE, "V-0001_treasurydirect_notes_auctioned_20261101.json"))))
    td = td[td.securityType.isin(["Note", "Bond"]) & (td.competitiveAuctionCloseTime == "01:00 PM")].copy()
    td["auction_date"] = td.competitiveAuctionCloseDate.str[:10]
    td["announce_date"] = td.announcementDate.str[:10]
    td = td[td.announce_date < td.auction_date]
    td = td[~td.auction_date.isin(rows.auction_date)]
    tdr = td[["auction_date", "announce_date", "securityTerm"]].rename(columns={"securityTerm": "security_term"})
    tdr["original_security_term"] = tdr.security_term.str.split(" ").str[0].str.replace("-Year", "") + "-Year"
    tdr["src"] = "treasurydirect"
    cal = pd.concat([rows, tdr]).sort_values("auction_date")
    cal.to_csv(os.path.join(HERE, "V-0001_auctions.csv"), index=False)
    print("kept", len(cal), "rows,", cal.auction_date.nunique(), "days; dropped", len(dropped))
    print(dropped[["auction_date", "announcemt_date", "security_term", "offering_amt"]].to_string())
    print("added from TreasuryDirect:\n", tdr.to_string())
    lead = (pd.to_datetime(cal.auction_date) - pd.to_datetime(cal.announce_date)).dt.days
    print("announcement lead days:", lead.describe().round(2).to_dict())


def load_auction_days():
    a = pd.read_csv(os.path.join(HERE, "V-0001_auctions.csv"))
    a["date"] = pd.to_datetime(a.auction_date)
    long_end = a.original_security_term.isin(["10-Year", "20-Year", "30-Year"])
    return pd.Series(long_end.values, index=a.date).groupby(level=0).any()


# ------------------------------------------------------------------ fees and fills (config.yaml)
def tier(p, tiers):
    for t in tiers:
        if p < t["below"]:
            return t["fee"]
    return tiers[-1]["fee"]


def leg_fees(px, qty, with_min=True):
    comm = tier(px, F["commission"]) * qty
    if with_min:
        comm = max(comm, F["commission_min_per_leg"])
    return comm + qty * (tier(px, F["exchange"]) + F["execution_surcharge"] + F["regulatory_clearing"])


def fly_pnl(legs, settle, Kc, w, k, with_min=True, fee_on_mid=False):
    """legs: [(bid, ask)] for K-w, K, K+w puts. Buy 1, sell 2, buy 1. Held to settlement."""
    sides, qtys = [1, -1, 1], [1, 2, 1]
    debit, fees = 0.0, 0.0
    for (b, a), s, q in zip(legs, sides, qtys):
        mid, half = (a + b) / 2, (a - b) / 2
        px = mid + s * k * half
        debit += s * q * px
        fees += leg_fees(mid if fee_on_mid else px, q, with_min)
    pay = max(0.0, w - abs(settle - Kc))
    return (pay - debit) * F["multiplier"] - fees


# ------------------------------------------------------------------ build
def day_rows(args):
    path, settle, spots = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"])
    df = df[~df.flag_bad]
    out = []
    for e in ENTRIES:
        if e not in spots:
            continue
        s0 = spots[e]
        q = df[df.ts == pd.Timestamp(f"{date.date()} {e}")]
        if q.empty:
            continue
        P = q[q.right == "P"].set_index("strike")[["bid", "ask"]]
        C = q[q.right == "C"].set_index("strike")[["bid", "ask"]]
        both = P.index.intersection(C.index)
        if len(both) == 0:
            continue
        Kc = float(both[np.abs(both.values - s0).argmin()])
        implied = float((P.loc[Kc].sum() + C.loc[Kc].sum()) / 2)
        for w in WIDTHS:
            ks = [Kc - w, Kc, Kc + w]
            if not all(x in P.index for x in ks):
                continue
            legs = [(float(P.loc[x, "bid"]), float(P.loc[x, "ask"])) for x in ks]
            mid = legs[0][0] / 2 + legs[0][1] / 2 - (legs[1][0] + legs[1][1]) + legs[2][0] / 2 + legs[2][1] / 2
            if mid <= 0:
                continue
            r = dict(date=date, entry=e, width=w, K=Kc, spot=s0, implied=implied, w_over_implied=w / implied,
                     mid=mid, settle=settle)
            for name, k in KS.items():
                r["pnl_" + name] = fly_pnl(legs, settle, Kc, w, k)
            r["pnl_k25_ledger"] = fly_pnl(legs, settle, Kc, w, 0.25, with_min=False, fee_on_mid=True)
            out.append(r)
    return out


def build(period, workers=6):
    from concurrent.futures import ProcessPoolExecutor
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[[in_period(d, period) for d in cal.index]]                      # TIME WALL
    spot = pd.read_parquet(os.path.join(CLEAN, "spot.parquet"))
    spot = spot[spot.ts.apply(lambda t: in_period(t.normalize(), period))]   # TIME WALL
    spot["date"] = spot.ts.dt.normalize()
    spot["hm"] = spot.ts.dt.strftime("%H:%M")
    piv = spot.pivot(index="date", columns="hm", values="spot")
    piv.to_parquet(os.path.join(CACHE, f"spot_{period}.parquet"))
    jobs = []
    for f in sorted(glob.glob(os.path.join(CLEAN, "chain_*.parquet"))):
        d = pd.Timestamp(os.path.basename(f)[6:14])
        if not in_period(d, period):                                         # TIME WALL (before the read)
            continue
        if d not in cal.index or cal.loc[d, "half_day"] or d not in piv.index:
            continue
        sp = {e: float(piv.loc[d, e]) for e in ENTRIES if e in piv.columns and pd.notna(piv.loc[d, e])}
        jobs.append((f, float(cal.loc[d, "settle"]), sp))
    with ProcessPoolExecutor(workers) as ex:
        rows = [r for day in ex.map(day_rows, jobs, chunksize=8) for r in day]
    p = pd.DataFrame(rows)
    p.to_parquet(os.path.join(CACHE, f"panel_{period}.parquet"), index=False)
    print(period, len(p), "rows", p.date.nunique(), "days", p.date.min().date(), p.date.max().date())


# ------------------------------------------------------------------ statistics
def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def boot_mean(x, n=5000, seed=SEED):
    x = np.asarray(x, float)
    rng = np.random.default_rng(seed)
    m = x[rng.integers(0, len(x), (n, len(x)))].mean(1)
    return np.percentile(m, [2.5, 97.5])


def boot_diff(a, b, n=5000, seed=SEED):
    a, b = np.asarray(a, float), np.asarray(b, float)
    rng = np.random.default_rng(seed)
    ma = a[rng.integers(0, len(a), (n, len(a)))]
    mb = b[rng.integers(0, len(b), (n, len(b)))]
    dev = ma.mean(1) - mb.mean(1)
    dwin = (ma > 0).mean(1) - (mb > 0).mean(1)
    return np.percentile(dev, [2.5, 97.5]), np.percentile(dwin, [2.5, 97.5])


def maxdd(s):
    c = s.sort_index().cumsum()
    return float((c.cummax().clip(lower=0) - c).max())


def st(x):
    x = pd.Series(x).dropna()
    n = len(x)
    w = int((x > 0).sum())
    lo, hi = wilson(w, n)
    blo, bhi = boot_mean(x) if n > 1 else (np.nan, np.nan)
    return dict(n=n, win=w / n if n else np.nan, win_lo=lo, win_hi=hi, ev=x.mean(), ev_lo=blo, ev_hi=bhi)


def rule(p, entry, col="pnl_k20", target=2.0, skip=-0.01, cal=None):
    """One put fly per day: width with w/implied closest to target; skip prev-day return <= skip."""
    q = p[p.entry == entry].copy()
    q["err"] = (q.w_over_implied - target).abs()
    q = q.sort_values(["date", "err", "width"]).groupby("date").head(1).set_index("date")
    q = q.join(cal[["spx_ret_prev", "fomc", "cpi", "nfp", "pce"]])
    q = q[~(q.spx_ret_prev <= skip)]
    q["pnl"] = q[col]
    return q


# ------------------------------------------------------------------ analysis
def analyze(period, n_perm=1000):
    os.makedirs(OUT, exist_ok=True)
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[[in_period(d, period) for d in cal.index]]                      # TIME WALL
    p = pd.read_parquet(os.path.join(CACHE, f"panel_{period}.parquet"))
    assert all(in_period(d, period) for d in p.date.unique())
    piv = pd.read_parquet(os.path.join(CACHE, f"spot_{period}.parquet"))
    auct = load_auction_days()
    auct = auct[[in_period(d, period) for d in auct.index]]
    full = cal[~cal.half_day].index
    is_a = lambda idx: pd.Index(idx).isin(auct.index)  # noqa: E731
    res = {}
    T = lambda name, d: res.__setitem__(name, d)  # noqa: E731

    # --- D1 / D2 (all non-half days, no prev-day filter)
    d = pd.DataFrame({"j0010": (piv["13:10"] - piv["13:00"]).abs(), "j0030": (piv["13:30"] - piv["13:00"]).abs(),
                      "c1200": (piv["12:10"] - piv["12:00"]).abs(), "c1400": (piv["14:10"] - piv["14:00"]).abs()})
    d = d.loc[d.index.intersection(full)]
    d["auction"] = is_a(d.index)
    d["wd"] = d.index.day_name()
    d["event"] = cal.loc[d.index, ["fomc", "cpi", "nfp", "pce"]].any(axis=1)
    rows = {}
    def jr(x, col):
        a, b = x[x.auction][col].median(), x[~x.auction][col].median()
        return dict(n_a=int(x.auction.sum()), n_n=int((~x.auction).sum()), med_a=a, med_n=b, ratio=a / b)
    for col in ["j0010", "j0030", "c1200", "c1400"]:
        rows[col] = jr(d, col)
    rows["j0010 no-event"] = jr(d[~d.event], "j0010")
    for wd in ["Monday", "Tuesday", "Wednesday", "Thursday"]:
        rows["j0010 " + wd] = jr(d[d.wd == wd], "j0010")
    T("D1", pd.DataFrame(rows).T)
    imp = p[p.width == 25].pivot_table(index="date", columns="entry", values="implied", aggfunc="first")
    r2 = (imp["13:00"] / imp["14:00"]).dropna().to_frame("ratio")
    r2 = r2.loc[r2.index.intersection(full)]
    r2["auction"] = is_a(r2.index)
    T("D2", r2.groupby("auction").ratio.agg(["count", "mean", "median"]))

    # --- rule trades, k 0.20 + per-leg minimum
    def legs_for(col="pnl_k20", target=2.0, skip=-0.01):
        return {e: rule(p, e, col, target, skip, cal) for e in ENTRIES}
    L = legs_for()
    common = L["13:00"].index.intersection(L["13:10"].index).intersection(L["14:00"].index)
    for e in ENTRIES:
        L[e]["auction"] = is_a(L[e].index)

    # replication rows vs proposer's training table (proposer: b13 / b14 sets, not intersected)
    rep = {}
    for e in ["13:00", "13:10", "14:00"]:
        b = L[e]
        rep[f"{e} all"] = st(b.pnl)
        rep[f"{e} auction"] = st(b[b.auction].pnl)
        rep[f"{e} non-auction"] = st(b[~b.auction].pnl)
    b14l = rule(p, "14:00", "pnl_k25_ledger", cal=cal)
    rep["14:00 ledger-style k0.25 no-min"] = st(b14l.pnl)
    T("rule_by_auction", pd.DataFrame(rep).T)

    # --- primary: 13:00 rule, auction vs non-auction
    b13 = L["13:00"]
    A, N = b13[b13.auction].pnl, b13[~b13.auction].pnl
    (ev_lo, ev_hi), (w_lo, w_hi) = boot_diff(A, N)
    prim = dict(n_a=len(A), win_a=(A > 0).mean(), ev_a=A.mean(), n_n=len(N), win_n=(N > 0).mean(), ev_n=N.mean(),
                d_win=(A > 0).mean() - (N > 0).mean(), d_win_lo=w_lo, d_win_hi=w_hi,
                d_ev=A.mean() - N.mean(), d_ev_lo=ev_lo, d_ev_hi=ev_hi)
    # permutation: shuffle auction labels within weekday (and unstratified)
    rng = np.random.default_rng(SEED)
    lab = b13.auction.values.copy()
    wd = b13.index.dayofweek.values
    pn = b13.pnl.values
    obs_ev, obs_w = prim["d_ev"], prim["d_win"]
    def diffs(l):
        return pn[l].mean() - pn[~l].mean(), (pn[l] > 0).mean() - (pn[~l] > 0).mean()
    perm_s, perm_u = [], []
    for _ in range(n_perm):
        ls = lab.copy()
        for g in np.unique(wd):
            m = wd == g
            ls[m] = rng.permutation(ls[m])
        perm_s.append(diffs(ls))
        perm_u.append(diffs(rng.permutation(lab)))
    perm_s, perm_u = np.array(perm_s), np.array(perm_u)
    prim["p_ev_wdstrat"] = (np.sum(perm_s[:, 0] <= obs_ev) + 1) / (n_perm + 1)
    prim["p_win_wdstrat"] = (np.sum(perm_s[:, 1] <= obs_w) + 1) / (n_perm + 1)
    prim["p_ev_unstrat"] = (np.sum(perm_u[:, 0] <= obs_ev) + 1) / (n_perm + 1)
    prim["p_win_unstrat"] = (np.sum(perm_u[:, 1] <= obs_w) + 1) / (n_perm + 1)
    T("primary", pd.Series(prim).to_frame("value"))

    # diagnostics of the primary: by year, weekday, ex-event, long end
    sl = {}
    b13 = b13.assign(year=b13.index.year, wd=b13.index.day_name(),
                     event=b13[["fomc", "cpi", "nfp", "pce"]].any(axis=1),
                     long_end=[bool(auct.get(x, False)) for x in b13.index])
    for y, g in b13.groupby("year"):
        sl[f"{y} auction"] = st(g[g.auction].pnl); sl[f"{y} non"] = st(g[~g.auction].pnl)
    for w_, g in b13.groupby("wd"):
        sl[f"{w_} auction"] = st(g[g.auction].pnl); sl[f"{w_} non"] = st(g[~g.auction].pnl)
    g = b13[~b13.event]
    sl["no-event auction"] = st(g[g.auction].pnl); sl["no-event non"] = st(g[~g.auction].pnl)
    sl["long-end auction"] = st(b13[b13.auction & b13.long_end].pnl)
    sl["short-end auction"] = st(b13[b13.auction & ~b13.long_end].pnl)
    T("primary_slices", pd.DataFrame(sl).T)

    # --- variants on the common day set
    c13, c1310, c14 = L["13:00"].loc[common], L["13:10"].loc[common], L["14:00"].loc[common]
    a = c13.auction
    var = {"13:00 all-days": c13.pnl, "14:00 all-days (baseline A rule)": c14.pnl,
           "V1 13:00 / auction 13:10": c13.pnl.where(~a, c1310.pnl),
           "V2 13:00 / auction 14:00": c13.pnl.where(~a, c14.pnl),
           "V3 13:00 / skip auction (NOT pre-registered)": c13.pnl[~a]}
    vt = {}
    for k_, s in var.items():
        r = st(s); r["maxdd"] = maxdd(s); r["sum"] = s.sum()
        for ref_name, ref in (("13:00", c13.pnl), ("14:00", c14.pnl)):
            if k_.startswith("V3"):
                # per-day increment when the auction day is skipped (pnl 0) vs trading it
                inc = pd.Series(np.where(a, 0.0, c13.pnl), index=common) - ref
                r[f"d_win_vs_{ref_name}"] = (s > 0).mean() - (ref > 0).mean()
            else:
                inc = s - ref
                r[f"d_win_vs_{ref_name}"] = (s > 0).mean() - (ref > 0).mean()
            r[f"d_ev_vs_{ref_name}"] = inc.mean() if not k_.startswith("V3") else s.mean() - ref.mean()
            lo, hi = boot_mean(inc)
            r[f"d_evday_vs_{ref_name}"] = inc.mean()
            r[f"d_evday_lo_vs_{ref_name}"], r[f"d_evday_hi_vs_{ref_name}"] = lo, hi
        vt[k_] = r
    T("variants", pd.DataFrame(vt).T)
    # ledger-style baseline A for comparability
    T("baselineA_ledger_style", pd.Series(st(b14l.pnl)).to_frame("value"))

    # V1 by year and permutation of the V1 increment
    inc1 = (c1310.pnl - c13.pnl).where(a, 0.0)
    yy = {}
    for y in sorted(set(common.year)):
        m = common.year == y
        yy[f"{y} V1"] = st(var["V1 13:00 / auction 13:10"][m])
        yy[f"{y} 13:00"] = st(c13.pnl[m])
        yy[f"{y} 14:00"] = st(c14.pnl[m])
        yy[f"{y} V3"] = st(c13.pnl[m & ~a.values])
        yy[f"{y} V1-inc/day"] = dict(n=int(m.sum()), ev=inc1[m].mean())
    T("by_year", pd.DataFrame(yy).T)
    full_inc = (c1310.pnl - c13.pnl).values
    lab = a.values
    wd = common.dayofweek.values
    obs = (full_inc * lab).mean()
    perm = []
    for _ in range(n_perm):
        ls = lab.copy()
        for g_ in np.unique(wd):
            m = wd == g_
            ls[m] = rng.permutation(ls[m])
        perm.append((full_inc * ls).mean())
    T("V1_perm", pd.Series({"obs_inc_per_day": obs, "p_ge_obs_wdstrat": (np.sum(np.array(perm) >= obs) + 1) / (n_perm + 1)}).to_frame("value"))

    # --- robustness of the primary and V1
    rb = {}
    def prim_of(b):
        A_, N_ = b[b.auction].pnl, b[~b.auction].pnl
        return dict(n_a=len(A_), n_n=len(N_), d_win=(A_ > 0).mean() - (N_ > 0).mean(), d_ev=A_.mean() - N_.mean())
    for e in ["12:50", "13:10"]:
        rb[f"primary entry {e}"] = prim_of(L[e])
    for tgt in (1.5, 2.5):
        b = rule(p, "13:00", "pnl_k20", tgt, -0.01, cal); b["auction"] = is_a(b.index)
        rb[f"primary target {tgt}"] = prim_of(b)
    for sk in (-0.005, -0.015):
        b = rule(p, "13:00", "pnl_k20", 2.0, sk, cal); b["auction"] = is_a(b.index)
        rb[f"primary skip {sk}"] = prim_of(b)
    b = rule(p, "13:00", "pnl_k50", cal=cal); b["auction"] = is_a(b.index)
    rb["primary k0.5"] = prim_of(b)
    b = L["13:00"]
    worst5 = b[b.auction].pnl.nsmallest(5).index
    rb["primary drop 5 worst auction days"] = prim_of(b.drop(worst5))
    best5n = b[~b.auction].pnl.nlargest(5).index
    rb["primary drop 5 best non-auction days"] = prim_of(b.drop(best5n))
    best5 = b.pnl.nlargest(5).index
    rb["primary drop 5 best days overall"] = prim_of(b.drop(best5))
    # V1 robustness
    def v1_inc(col="pnl_k20", target=2.0, skip=-0.01, alt="13:10"):
        x13 = rule(p, "13:00", col, target, skip, cal); xa = rule(p, alt, col, target, skip, cal)
        cm = x13.index.intersection(xa.index)
        aa = is_a(cm)
        v = x13.pnl.loc[cm].where(~aa, xa.pnl.loc[cm])
        return dict(n=len(cm), d_win=(v > 0).mean() - (x13.pnl.loc[cm] > 0).mean(), d_ev=(v - x13.pnl.loc[cm]).mean())
    rb["V1 base"] = v1_inc()
    rb["V1 k0.5"] = v1_inc("pnl_k50")
    rb["V1 target 1.5"] = v1_inc(target=1.5)
    rb["V1 target 2.5"] = v1_inc(target=2.5)
    v = var["V1 13:00 / auction 13:10"]
    top = (v - c13.pnl).nlargest(5).index
    rb["V1 drop 5 best increment days"] = dict(n=len(common) - 5, d_ev=(v - c13.pnl).drop(top).mean(),
                                               d_win=(v.drop(top) > 0).mean() - (c13.pnl.drop(top) > 0).mean())
    T("robustness", pd.DataFrame(rb).T)

    tag = period
    for k_, v_ in res.items():
        v_.to_csv(os.path.join(OUT, f"{tag}_{k_}.csv"))
        print(f"\n== [{tag}] {k_}\n{v_.round(4).to_string()}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["calendar", "build", "analyze"])
    ap.add_argument("--period", choices=["train", "test"], default="train")
    ap.add_argument("--workers", type=int, default=6)
    x = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    if x.cmd == "calendar":
        build_calendar()
    elif x.cmd == "build":
        build(x.period, x.workers)
    else:
        analyze(x.period)
