"""V-0015 statistics (validator). Reads only V-0015_build outputs, calendar.parquet and V-0015_events.csv.

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0015_stats.py train|test

Metric list frozen before the single test run (same code for both periods):
  sample: base days, event days in base, strata (year x weekday) sizes, dropped calendar events.
  M1 G_ev = E(14:00) - E(13:55), iron fly, k 0.20, cap 2.0, both minutes valid; mean, bootstrap 95%, by segment,
     median, share > 0.
  M2 DiD vs same (year x weekday) controls; bootstrap 95%; stratified permutation one-sided p (5000).
  M3 D_step (13:55 fixed legs: mean H(14:00,14:01) - mean H(13:55..13:59)), DiD; bootstrap; permutation p.
     P_w = H(13:55) event - control.
  M4 minutes / beige book separately: G_ev, DiD, D_step.
  M5 placebo DiD (same weekday one week earlier, pseudo events removed from controls).
  M6 dPnL = pnl(13:55) - pnl(14:00) on event days, bootstrap 95%, by segment; controls.
  M7 participation: event days with 13:55 valid and 14:00 invalid (cap / missing): count, 13:55 E and pnl;
     intention-to-treat G with the 14:00 cap lifted; rule-vs-base event-day pnl when the base does not trade those days.
  M8 win rate (pnl > 0) + Wilson at 13:55 and 14:00 on event days; cumulative pnl max drawdown, rule vs base.
  M9 robustness: cap 1.0; k 0.5; put fly; drop Tuesday events; FOMC statement days as events / out of controls;
     entry 13:54 / 13:56 / 13:58 in place of 13:55; remove best 5 event days (G_ev, DiD).
  M10 profiles: fixed-leg H by minute (event - control), |S(t) - S(13:55)| by minute; E(14:10) - E(13:55).
"""
import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import norm

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "V-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
PERIOD = sys.argv[1] if len(sys.argv) > 1 else "train"
rng = np.random.default_rng(20261101)


def in_period(ix):
    return (ix < SPLIT) if PERIOD == "train" else (ix >= SPLIT)


cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[in_period(cal.index)]                                               # time wall
evc = pd.read_csv(os.path.join(HERE, "V-0015_events.csv"), parse_dates=["date"])
evc = evc[in_period(evc.date)]                                                # time wall
ent = pd.read_parquet(os.path.join(T, f"entries_{PERIOD}.parquet"))
ent = ent[in_period(ent.date)]
fix = pd.read_parquet(os.path.join(T, f"fixed_{PERIOD}.parquet"))
fix = fix[in_period(fix.date)]
EVT = dict(zip(evc.date, evc.event))

if PERIOD == "train":
    SEGS = [("2022", lambda d: d.year == 2022), ("2023", lambda d: d.year == 2023), ("2024", lambda d: d.year == 2024)]
else:
    SEGS = [("2024-11~12", lambda d: d.year == 2024), ("2025", lambda d: d.year == 2025), ("2026", lambda d: d.year == 2026)]


def base(fomc_mode="out"):
    b = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01)].copy()
    if fomc_mode == "out":
        b = b[~b.fomc]
    b["event"] = b.index.isin(evc.date)
    if fomc_mode == "event":
        b["event"] = b.event | b.fomc
    b["etype"] = [EVT.get(x, "fomc" if b.loc[x, "fomc"] else "") for x in b.index]
    b["stratum"] = b.index.year * 10 + b.index.dayofweek
    return b


def boot(a, n=2000):
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    if len(a) < 2:
        return np.nan, np.nan
    m = a[rng.integers(0, len(a), (n, len(a)))].mean(1)
    return np.percentile(m, 2.5), np.percentile(m, 97.5)


def wilson(k, n, z=1.96):
    if n == 0:
        return np.nan, np.nan
    p = k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return c - h, c + h


def segs(s):
    return "  ".join(f"{lab} {s[f(s.index)].mean():+.3f}(n{int(f(s.index).sum())})" for lab, f in SEGS)


def line(lab, s, unit=""):
    s = s.dropna()
    lo, hi = boot(s.values)
    print(f"{lab:<46} n {len(s):3d} mean {s.mean():+8.3f} [{lo:+8.3f}, {hi:+8.3f}]{unit}  | {segs(s)}")
    return s


def did_series(v, b, evmask, ctrlmask):
    v = v.dropna()
    out = {}
    for st, g in b.loc[b.index.intersection(v.index)].groupby("stratum"):
        e = g.index[evmask.reindex(g.index).fillna(False).to_numpy(bool)]
        c = g.index[ctrlmask.reindex(g.index).fillna(False).to_numpy(bool)]
        if len(e) and len(c):
            cm = v.loc[c].mean()
            for x in e:
                out[x] = v.loc[x] - cm
    return pd.Series(out, dtype=float).sort_index()


def perm(v, b, n=5000):
    v = v.dropna()
    bb = b.loc[b.index.intersection(v.index)]
    obs = did_series(v, bb, bb.event, ~bb.event).mean()
    groups = []
    for _, g in bb.groupby("stratum"):
        ne = int(g.event.sum())
        if 0 < ne < len(g):
            groups.append((v.loc[g.index].to_numpy(), ne))
    hits = 0
    for _ in range(n):
        tot = 0.0
        m = 0
        for a, ne in groups:
            p = rng.permutation(len(a))
            tot += (a[p[:ne]] - a[p[ne:]].mean()).sum()
            m += ne
        hits += (tot / m) >= obs - 1e-12
    return obs, (hits + 1) / (n + 1)


def table(struct="iron", k=0.20, cap=2.0):
    x = ent.copy()
    fk = "fee20" if k == 0.20 else "fee50"
    x["E"] = k * x[f"{struct}_H"] * 100 + x[f"{struct}_{fk}"]
    x["ok"] = x[f"{struct}_mid"].notna() & (x[f"{struct}_widest"] <= cap)
    st = cal.settle.reindex(x.date).to_numpy()
    pay = np.maximum(0.0, x.w - np.abs(st - x.K))
    x["pnl"] = (pay - x[f"{struct}_mid"] - k * x[f"{struct}_H"]) * 100 - x[f"{struct}_{fk}"]
    x["x"] = np.abs(st - x.S) / x.I
    return x


def piv(x, col, okonly=True):
    y = x[x.ok] if okonly else x[x[col].notna()]
    return y.pivot_table(index="date", columns="entry", values=col)


def G_of(x, a="13:55", b_="14:00"):
    E = piv(x, "E")
    if a not in E or b_ not in E:
        return pd.Series(dtype=float)
    return (E[b_] - E[a]).dropna()


def core(label, b, struct="iron", k=0.20, cap=2.0, a="13:55", verbose=True):
    x = table(struct, k, cap)
    G = G_of(x, a).reindex(b.index).dropna()
    ev = b.event.reindex(G.index)
    D = did_series(G, b, b.event, ~b.event)
    obs, p = perm(G, b)
    lo, hi = boot(G[ev].values)
    dlo, dhi = boot(D.values)
    print(f"[{label}] n_ev {int(ev.sum())}  G_ev {G[ev].mean():+.3f} [{lo:+.3f},{hi:+.3f}]  DiD {D.mean():+.3f} "
          f"[{dlo:+.3f},{dhi:+.3f}]  perm p {p:.4f}  | {segs(G[ev])}")
    return G, D, p


def main():
    b = base()
    print(f"PERIOD {PERIOD}: base days {len(b)}, events in calendar {len(evc)}, events in base {int(b.event.sum())} "
          f"({b[b.event].etype.value_counts().to_dict()}), weekday {b[b.event].index.dayofweek.value_counts().to_dict()}")
    dropped = sorted(set(evc.date) - set(b.index[b.event]))
    for d in dropped:
        r = cal.loc[d] if d in cal.index else None
        print("  calendar event not in base:", d.date(), EVT[d],
              "" if r is None else f"half {r.half_day} 0dte {r.has_0dte} ret_prev {r.spx_ret_prev:+.4f} fomc {r.fomc}")
    assert not cal.loc[cal.index.isin(evc.date), "fomc"].any()
    st = b.groupby("stratum").event.agg(["sum", "size"])
    print("  strata with events (year*10+dow: events/total):",
          {int(i): f"{int(r['sum'])}/{int(r['size'])}" for i, r in st[st['sum'] > 0].iterrows()})

    x = table()
    E = piv(x, "E")
    Eall = piv(x, "E", okonly=False)
    P = piv(x, "pnl")
    Pall = piv(x, "pnl", okonly=False)
    W = x.pivot_table(index="date", columns="entry", values="iron_widest")

    print("\n== M1/M2 main (iron, k 0.20, cap 2.0)")
    G = (E["14:00"] - E["13:55"]).reindex(b.index).dropna()
    ev = b.event.reindex(G.index)
    Gev = line("G_ev = E14:00 - E13:55 (USD)", G[ev])
    print(f"   G_ev median {Gev.median():+.2f}, share>0 {np.mean(Gev > 0):.2f}; controls median {G[~ev].median():+.2f}, "
          f"share>0 {np.mean(G[~ev] > 0):.2f}")
    line("G_ctrl (all controls)", G[~ev])
    D = line("DiD", did_series(G, b, b.event, ~b.event))
    obs, p = perm(G, b)
    print(f"   stratified permutation DiD {obs:+.3f} one-sided p {p:.4f}  (Bonferroni x53: {min(1, 53 * p):.4f})")
    for lab, f in SEGS:
        s = D[f(D.index)]
        print(f"   DiD {lab}: {s.mean():+.3f} n {len(s)}")

    print("\n== M3 mechanism, fixed 13:55 legs (points)")
    f = fix.copy()
    f.loc[f.widest > 2.0, "H"] = np.nan
    H = f.pivot_table(index="date", columns="off", values="H").reindex(b.index)
    pre = H[[0, 1, 2, 3, 4]].mean(1)
    post = H[[5, 6]].mean(1)
    step = (post - pre).dropna()
    evs = b.event.reindex(step.index)
    line("step event", step[evs])
    line("step control", step[~evs])
    Ds = line("D_step", did_series(step, b, b.event, ~b.event))
    print("   D_step perm obs %+.4f one-sided p %.4f" % perm(step, b))
    line("P_w = H(13:55) event - ctrl", did_series(H[0], b, b.event, ~b.event))

    print("\n== M4 by type")
    for typ in ("minutes", "beige_book"):
        m = b.event & (b.etype == typ)
        line(f"G_ev {typ}", G[m.reindex(G.index)])
        line(f"DiD {typ}", did_series(G, b, m, ~b.event))
        line(f"D_step {typ}", did_series(step, b, m, ~b.event))

    print("\n== M5 placebo (same weekday one week earlier)")
    pse = [d - pd.Timedelta(days=7) for d in b.index[b.event] if (d - pd.Timedelta(days=7)) in b.index
           and not b.loc[d - pd.Timedelta(days=7), "event"]]
    pm = pd.Series(b.index.isin(pse), index=b.index)
    print(f"   pseudo events {len(pse)}")
    line("placebo DiD (G)", did_series(G, b, pm, (~b.event) & (~pm)))
    line("placebo D_step", did_series(step, b, pm, (~b.event) & (~pm)))

    print("\n== M6 P&L (k 0.20, hold to settlement)")
    dP = (P["13:55"] - P["14:00"]).reindex(b.index).dropna()
    evp = b.event.reindex(dP.index)
    line("dPnL = pnl13:55 - pnl14:00, events", dP[evp])
    line("dPnL controls", dP[~evp])
    line("dPnL DiD", did_series(dP, b, b.event, ~b.event))
    p14 = P["14:00"].reindex(b.index).dropna()
    line("base-A pnl 14:00, events", p14[b.event.reindex(p14.index)])
    line("base-A pnl 14:00, controls", p14[~b.event.reindex(p14.index)])
    xx = x[x.ok].pivot_table(index="date", columns="entry", values="x")["13:55"].reindex(b.index).dropna()
    line("x(13:55) event - ctrl", did_series(xx, b, b.event, ~b.event))

    print("\n== M7 participation (14:00 invalid, 13:55 valid) on event days")
    evd = b.index[b.event]
    part = [d for d in evd if d in E.index and np.isfinite(E.loc[d].get("13:55", np.nan)) and not np.isfinite(E.loc[d].get("14:00", np.nan))]
    for d in part:
        print(f"   {d.date()} {EVT[d]:<10} E13:55 {E.loc[d, '13:55']:.2f}  E14:00(uncapped) {Eall.loc[d].get('14:00', np.nan):.2f} "
              f"widest14:00 {W.loc[d].get('14:00', np.nan):.2f}  pnl13:55 {P.loc[d, '13:55']:+.0f}  "
              f"pnl14:00(uncapped) {Pall.loc[d].get('14:00', np.nan):+.0f}")
    other = [d for d in evd if d not in G.index and d not in part]
    for d in other:
        print(f"   {d.date()} {EVT[d]:<10} neither/13:55 invalid: widest13:55 {W.loc[d].get('13:55', np.nan) if d in W.index else np.nan}"
              f" widest14:00 {W.loc[d].get('14:00', np.nan) if d in W.index else np.nan}")
    Gitt = (Eall["14:00"] - E["13:55"]).reindex(evd).dropna()
    line("ITT G_ev (14:00 cap lifted)", Gitt)
    # rule vs base on event days: rule trades 13:55 when valid; base trades 14:00 when valid, else 0
    rule = P["13:55"].reindex(evd)
    basep = P["14:00"].reindex(evd)
    both = pd.DataFrame({"rule": rule, "base": basep})
    both = both[both.rule.notna() | both.base.notna()].fillna(0.0)
    line("rule - base pnl per event day (no-trade = 0)", both.rule - both.base)

    print("\n== M8 win rate / drawdown on event days")
    for lab, s in (("13:55", P["13:55"].reindex(evd).dropna()), ("14:00", P["14:00"].reindex(evd).dropna())):
        k = int((s > 0).sum())
        lo, hi = wilson(k, len(s))
        print(f"   pnl {lab}: n {len(s)} win {k / len(s):.3f} [{lo:.3f},{hi:.3f}] mean {s.mean():+.1f}")
    for lab, s in (("rule", both.rule), ("base", both.base)):
        c = s.sort_index().cumsum()
        print(f"   cum pnl {lab}: total {c.iloc[-1]:+.0f}, max drawdown {(c - c.cummax()).min():+.0f}")

    print("\n== M9 robustness")
    core("cap 1.0", b, cap=1.0)
    core("k 0.5", b, k=0.50)
    core("put fly", b, struct="put")
    bt = b[~(b.event & (b.index.dayofweek == 1))]
    core("drop Tuesday events", bt)
    core("FOMC statement days as events", base("event"))
    bf = base("in")
    bf = bf[~(bf.fomc & ~bf.event)] if False else bf
    bfo = base("in")
    bfo = bfo[~bfo.fomc]
    core("FOMC out of controls (= main)", bfo)
    for a in ("13:54", "13:56", "13:58"):
        core(f"entry {a} instead of 13:55", b, a=a)
    best = Gev.sort_values().index[-5:]
    rest = Gev.drop(best)
    lo, hi = boot(rest.values)
    print(f"   remove best 5 event days ({[str(d.date()) for d in best]}): G_ev {rest.mean():+.3f} [{lo:+.3f},{hi:+.3f}]"
          f"  DiD {D.drop(best, errors='ignore').mean():+.3f} {boot(D.drop(best, errors='ignore').values)}")

    print("\n== M10 profiles")
    prof = pd.DataFrame({"event": H[b.event].mean(), "ctrl": H[~b.event].mean()})
    prof["diff"] = prof.event - prof.ctrl
    print("fixed-leg H by offset from 13:55:\n", prof.round(3).T.to_string())
    Sp = f.pivot_table(index="date", columns="off", values="spot").reindex(b.index)
    mv = Sp.sub(Sp[0], axis=0).abs()
    print("|S(t)-S(13:55)|:\n", pd.DataFrame({"event": mv[b.event].mean(), "ctrl": mv[~b.event].mean()}).round(2).T.to_string())
    e10 = (E["14:10"] - E["13:55"]).reindex(b.index).dropna()
    line("E14:10 - E13:55, events", e10[b.event.reindex(e10.index)])
    line("E14:10 - E13:55 DiD", did_series(e10, b, b.event, ~b.event))

    print("\n== per event day")
    lst = pd.DataFrame({"type": [EVT[d] for d in evd], "G": G.reindex(evd).round(2), "step": step.reindex(evd).round(3),
                        "H1355": x[x.entry == "13:55"].set_index("date").iron_H.reindex(evd).round(3),
                        "H1400": x[x.entry == "14:00"].set_index("date").iron_H.reindex(evd).round(3),
                        "w1400": W.reindex(evd)["14:00"].round(2),
                        "dPnL": dP.reindex(evd).round(0)}, index=evd)
    print(lst.to_string())
    os.makedirs(T, exist_ok=True)
    lst.to_csv(os.path.join(T, f"events_{PERIOD}.csv"))


if __name__ == "__main__":
    main()
