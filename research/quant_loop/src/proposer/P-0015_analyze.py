"""P-0015 analyze: decision cells of the spec (sections 3-5). Training period only.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0015_analyze.py | tee .../P-0015_tables/analyze_out.txt
"""
import os
import sys

import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "P-0015_tables")
SPLIT = pd.Timestamp("2024-11-01")
RNG = np.random.default_rng(15)

cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                   # time wall
ev = pd.read_csv(os.path.join(HERE, "P-0015_events.csv"), parse_dates=["date"])
ev = ev[ev.date < SPLIT]                                       # time wall
er = pd.read_parquet(os.path.join(T, "entry_rows.parquet"))
er = er[er.date < SPLIT]                                       # time wall
fx = pd.read_parquet(os.path.join(T, "fixed_rows.parquet"))
fx = fx[fx.date < SPLIT]                                       # time wall
wp = pd.read_parquet(os.path.join(R, "data/clean/winrate_panel.parquet"))
wp = wp[wp.date < SPLIT]                                       # time wall

EVD = dict(zip(ev.date, ev.type))
assert not any(cal.loc[cal.index.isin(ev.date), "fomc"]), "event coincides with FOMC statement day"


def base_days(incl_fomc=False):
    b = cal[(~cal.half_day) & cal.has_0dte & (cal.spx_ret_prev > -0.01)]
    if not incl_fomc:
        b = b[~b.fomc]
    d = pd.DataFrame(index=b.index)
    d["event"] = d.index.isin(ev.date)
    d["type"] = [EVD.get(x, "") for x in d.index]
    d["fomc"] = b.fomc
    d["stratum"] = [f"{x.year}-{x.dayofweek}" for x in d.index]
    d["year"] = d.index.year
    d["settle"] = b.settle
    return d


def entry_table(name="iron", k=0.20, cap=2.0):
    kk = f"k{int(k * 100):02d}"
    x = er.dropna(subset=[f"mid_{name}"]).copy()
    x = x[x[f"mx_{name}"] <= cap]
    x["E"] = k * x[f"H_{name}"] * 100 + x[f"fee_{name}_{kk}"]
    x["settle"] = cal.settle.reindex(x.date).values
    x["payoff"] = np.maximum(0, x.w - (x.settle - x.K).abs())
    x["pnl"] = (x.payoff - x[f"mid_{name}"] - k * x[f"H_{name}"]) * 100 - x[f"fee_{name}_{kk}"]
    x["x"] = (x.settle - x.S).abs() / x.I
    return x.pivot_table(index="date", columns="entry", values=["E", "pnl", "x", f"H_{name}", f"mid_{name}", "K", "w"])


def did(v, d, evmask, ctrlmask):
    """v: Series by date. Mean over event days of v - mean(v over same-stratum control days)."""
    v = v.dropna()
    dd = d.loc[d.index.isin(v.index)]
    diffs = []
    for s, g in dd.groupby("stratum"):
        e = g.index[evmask.reindex(g.index).values]
        c = g.index[ctrlmask.reindex(g.index).values]
        if len(e) == 0 or len(c) == 0:
            continue
        cm = v.loc[c].mean()
        for day in e:
            diffs.append((day, v.loc[day] - cm))
    return pd.Series(dict(diffs)).sort_index()


def boot(a, n=2000):
    a = np.asarray(a, float)
    if len(a) < 2:
        return (np.nan, np.nan)
    m = a[RNG.integers(0, len(a), (n, len(a)))].mean(1)
    return tuple(np.percentile(m, [2.5, 97.5]))


def perm_did(v, d, n=5000):
    v = v.dropna()
    dd = d.loc[d.index.isin(v.index)].copy()
    obs = did(v, dd, dd.event, ~dd.event).mean()
    groups = [(g.index, int(g.event.sum())) for _, g in dd.groupby("stratum") if g.event.any() and (~g.event).any()]
    vals = {s: v.loc[ix].values for s, (ix, _) in enumerate(groups)}
    cnt = 0
    for _ in range(n):
        tot, m = 0.0, 0
        for s, (ix, ne) in enumerate(groups):
            a = vals[s]
            p = RNG.permutation(len(a))
            e, c = a[p[:ne]], a[p[ne:]]
            tot += (e - c.mean()).sum()
            m += ne
        if tot / m >= obs:
            cnt += 1
    return obs, (cnt + 1) / (n + 1)


def fmt(s, lab, unit=""):
    lo, hi = boot(s.values)
    yr = " ".join(f"{y}:{s[s.index.year == y].mean():+.3f}(n{(s.index.year == y).sum()})" for y in (2022, 2023, 2024))
    print(f"{lab:<44} n {len(s):3d}  mean {s.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]{unit}  {yr}")


def main():
    d = base_days()
    print("base days", len(d), "events", int(d.event.sum()), d[d.event].type.value_counts().to_dict(),
          "weekday", d[d.event].index.dayofweek.value_counts().to_dict())
    print("training events in csv", len(ev), "dropped (half/ret/no0dte):",
          sorted(set(ev.date.dt.date) - set(d[d.event].index.date)))

    # ---- gate 6: reconciliation
    t = entry_table()
    w = wp[(wp.entry == "14:00") & (wp.structure == "iron_fly")].set_index(["date", "K", "width"]).cost
    m = []
    for day in t.index:
        try:
            K, ww = t.loc[day, ("K", "14:00")], t.loc[day, ("w", "14:00")]
            m.append(abs(t.loc[day, ("mid_iron", "14:00")] - w.loc[(day, K, int(ww))]))
        except (KeyError, TypeError, ValueError):
            pass
    m = np.array([x for x in m if np.isfinite(x)])
    print(f"\n[gate 6] 14:00 iron mid vs winrate_panel: n {len(m)}, median |diff| {np.median(m):.4f}, p95 {np.percentile(m, 95):.4f}")

    def run(name="iron", k=0.20, cap=2.0, incl_fomc=False, drop_tue=False, label="MAIN"):
        dd = base_days(incl_fomc)
        if drop_tue:
            dd = dd[dd.index.dayofweek != 1]
        t = entry_table(name, k, cap)
        t = t.reindex(dd.index)
        ok = t[("E", "14:00")].notna() & t[("E", "13:55")].notna()
        G = (t[("E", "14:00")] - t[("E", "13:55")])[ok]
        ne = int(dd.event.sum())
        ne_ok = int(dd.event.reindex(G.index).sum())
        print(f"\n== {label}: {name} k{k} cap{cap} fomc={incl_fomc} drop_tue={drop_tue}  "
              f"event days {ne}, both minutes valid {ne_ok}")
        miss = dd.index[dd.event & ~ok.reindex(dd.index, fill_value=False)]
        for day in miss:
            print("   dropped event day", day.date(), "E13:55", round(t.loc[day, ("E", "13:55")], 2),
                  "E14:00", round(t.loc[day, ("E", "14:00")], 2))
        evm = dd.event.reindex(G.index)
        Gev = G[evm]
        fmt(Gev, "G_ev = E14:00 - E13:55 (USD/event day)")
        fmt(G[~evm], "G_ctrl (all controls)")
        D = did(G, dd, dd.event, ~dd.event)
        fmt(D, "DiD")
        obs, p = perm_did(G, dd)
        print(f"   stratified permutation DiD {obs:+.3f}, one-sided p {p:.4f}")
        return dd, t, G

    dd, t, G = run()
    for typ in ("minutes", "beige_book"):
        s = G[dd.event.reindex(G.index) & (dd.type.reindex(G.index) == typ)]
        fmt(s, f"  G_ev {typ}")
        m2 = dd.event & (dd.type == typ)
        fmt(did(G, dd, m2, ~dd.event), f"  DiD {typ}")

    # placebo: same weekday one week earlier
    pse = []
    for day in dd.index[dd.event]:
        p = day - pd.Timedelta(days=7)
        if p in dd.index and not dd.loc[p, "event"]:
            pse.append(p)
    pm = pd.Series(dd.index.isin(pse), index=dd.index)
    ctrl = (~dd.event) & (~pm)
    P = did(G, dd, pm, ctrl)
    print(f"\n[placebo] pseudo-events {len(pse)}")
    fmt(P, "placebo DiD (week before)")

    # ---- mechanism: fixed legs (13:55 selection)
    f = fx.copy()
    f.loc[f.mx_iron > 2.0, "H_iron"] = np.nan
    H = f.pivot_table(index="date", columns="off", values="H_iron")
    H = H.reindex(dd.index)
    pre = H[[0, 1, 2, 3, 4]].mean(1)
    post = H[[5, 6]].mean(1)
    step = (post - pre).dropna()
    print("\n== mechanism (fixed 13:55 iron legs, cap 2.0)")
    fmt(step[dd.event.reindex(step.index)], "step event (pt)")
    fmt(step[~dd.event.reindex(step.index)], "step control (pt)")
    fmt(did(step, dd, dd.event, ~dd.event), "D_step (pt)")
    print("   D_step perm:", "obs %+.4f p %.4f" % perm_did(step, dd))
    for typ in ("minutes", "beige_book"):
        fmt(did(step, dd, dd.event & (dd.type == typ), ~dd.event), f"  D_step {typ}")
    fmt(did(H[0], dd, dd.event, ~dd.event), "P_w = H(13:55) event - ctrl (pt)")
    prof = pd.DataFrame({"event": H[dd.event].mean(), "ctrl": H[~dd.event].mean()})
    prof["diff"] = prof.event - prof.ctrl
    print("   fixed-leg H profile (off from 13:55):")
    print(prof.round(4).T.to_string())
    S = fx.pivot_table(index="date", columns="off", values="spot").reindex(dd.index)
    mv = S.sub(S[0], axis=0).abs()
    sp = pd.DataFrame({"event": mv[dd.event].mean(), "ctrl": mv[~dd.event].mean()})
    print("   |S(t) - S(13:55)| profile:")
    print(sp.round(2).T.to_string())

    # ---- P&L (report + gate 5)
    print("\n== P&L (k 0.20, hold to settlement)")
    ok = t[("pnl", "14:00")].notna() & t[("pnl", "13:55")].notna()
    dP = (t[("pnl", "13:55")] - t[("pnl", "14:00")])[ok]
    fmt(dP[dd.event.reindex(dP.index)], "dPnL = pnl13:55 - pnl14:00, events")
    fmt(dP[~dd.event.reindex(dP.index)], "dPnL controls")
    p14 = t[("pnl", "14:00")].dropna()
    fmt(p14[dd.event.reindex(p14.index)], "base-A pnl 14:00 events")
    fmt(p14[~dd.event.reindex(p14.index)], "base-A pnl 14:00 controls")
    fmt(did(p14, dd, dd.event, ~dd.event), "base-A pnl DiD")
    x = t[("x", "13:55")].dropna()
    fmt(did(x, dd, dd.event, ~dd.event), "x(13:55) event - ctrl")
    fmt(x[dd.event.reindex(x.index)], "x(13:55) events")
    ok2 = t[("E", "14:10")].notna() & t[("E", "13:55")].notna()
    e10 = (t[("E", "14:10")] - t[("E", "13:55")])[ok2]
    fmt(e10[dd.event.reindex(e10.index)], "E14:10 - E13:55, events")
    fmt(did(e10, dd, dd.event, ~dd.event), "E14:10 - E13:55 DiD")
    ok3 = t[("pnl", "14:10")].notna() & t[("pnl", "13:55")].notna()
    p10 = (t[("pnl", "14:10")] - t[("pnl", "13:55")])[ok3]
    fmt(p10[dd.event.reindex(p10.index)], "pnl14:10 - pnl13:55, events")

    # ---- robustness (report only)
    print("\n== robustness (report only)")
    run(cap=1.0, label="cap 1.0")
    run(k=0.5, label="k 0.5")
    run(name="put", label="put fly")
    run(incl_fomc=True, label="incl FOMC statement days")
    run(drop_tue=True, label="drop Tuesday events")

    # per-event listing
    Gev = G[dd.event.reindex(G.index)]
    lst = pd.DataFrame({"type": dd.type.reindex(Gev.index), "G": Gev.round(2),
                        "step": step.reindex(Gev.index).round(3),
                        "H1355": t[("H_iron", "13:55")].reindex(Gev.index).round(3),
                        "H1400": t[("H_iron", "14:00")].reindex(Gev.index).round(3),
                        "dPnL": dP.reindex(Gev.index).round(0)})
    print("\n== per event day")
    print(lst.to_string())


if __name__ == "__main__":
    main()
