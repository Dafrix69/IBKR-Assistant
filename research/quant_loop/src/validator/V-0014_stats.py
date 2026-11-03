"""V-0014 stats on V-0014_audit.py output. Training only. Prints to stdout (tee to V-0014_tables/stats_out.txt)."""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "V-0014_tables")
WALL = pd.Timestamp("2024-11-01")
CAP = 2.0
FIT = np.array([-5, -4, -3, -2, 2, 3, 4, 5], float)
rng = np.random.default_rng(14014)

prof = pd.read_parquet(os.path.join(T, "prof.parquet")); prof = prof[prof.date < WALL]
ent = pd.read_parquet(os.path.join(T, "ent.parquet")); ent = ent[ent.date < WALL]
base = pd.read_parquet(os.path.join(T, "base.parquet")); base = base[base.index < WALL]
ev = pd.read_csv(os.path.join(HERE, "V-0014_events.csv"), parse_dates=["date"])
ev = ev[ev.date < WALL]
NOF = set(base.index[~base.fomc.astype(bool)])
ALL = set(base.index)
MIN = set(ev.date[ev.event.str.startswith("FOMC")])
BB = set(ev.date[ev.event == "Beige Book"])
EV14 = MIN | BB


def ci(x, scale=1.0, nd=4):
    x = np.asarray(x, float); x = x[~np.isnan(x)] * scale
    b = rng.choice(x, (2000, len(x))).mean(1)
    return f"{x.mean():+.{nd}f} [{np.percentile(b, 2.5):+.{nd}f}, {np.percentile(b, 97.5):+.{nd}f}] n={len(x)}"


# wide matrix: (anchor, date) x off of capped H
prof["Hc"] = prof.H.where(prof.mx <= CAP)
W = prof.pivot_table(index=["anchor", "date"], columns="off", values="Hc", dropna=False)
W = W.reindex(columns=range(-5, 11))


def resid(row):
    y = row.reindex(FIT.astype(int)).to_numpy(float)
    ok = ~np.isnan(y)
    if ok.sum() < 6 or np.isnan(row[0]):
        return np.nan, np.nan
    A = np.c_[np.ones(ok.sum()), FIT[ok]]
    a, b = np.linalg.lstsq(A, y[ok], rcond=None)[0]
    return row[0] - a, (row[1] - (a + b)) if not np.isnan(row[1]) else np.nan


rr = np.array([resid(W.iloc[i]) for i in range(len(W))])
N = pd.DataFrame(rr, index=W.index, columns=["N0", "N1"]).reset_index()
N["N"] = N[["N0", "N1"]].mean(axis=1, skipna=False)
pre = W[[-5, -4, -3, -2, -1]]; post = W[[0, 1]]
S = (post.mean(1) - pre.mean(1)).where((pre.notna().sum(1) >= 4) & (post.notna().sum(1) == 2))
N["S"] = S.to_numpy()
N.to_csv(os.path.join(T, "notch.csv"), index=False)

print("== N0 / N, iron fixed legs, cap 2.0, no FOMC (points) ==")
for an in ["11:00", "12:00", "13:00", "14:00", "15:00", "11:37", "12:37", "13:37", "14:37", "15:37"]:
    g = N[(N.anchor == an) & N.date.isin(NOF)]
    print(an, "N0", ci(g.N0), "| N", ci(g.N), "| step S", ci(g.S))
g = N[(N.anchor == "14:00") & N.date.isin(NOF)]
print("14:00 N0 by year:", g.groupby(g.date.dt.year).N0.mean().round(4).to_dict())
print("14:00 N0 >0/=0/<0:", round((g.N0 > 1e-9).mean(), 3), round((g.N0.abs() <= 1e-9).mean(), 3), round((g.N0 < -1e-9).mean(), 3))
x = N[(N.anchor == "14:00") & N.date.isin(ALL)]
print("14:00 incl FOMC N0", ci(x.N0))

print("\n== 14:00 scheduled-event decomposition (no FOMC decision days) ==")
print("event days in base, no FOMC: minutes", len(MIN & NOF), "beige", len(BB & NOF))
for lab, ds in [("minutes days", MIN & NOF), ("beige days", BB & NOF), ("minutes+beige", EV14 & NOF),
                ("non-event", NOF - EV14)]:
    g = N[(N.anchor == "14:00") & N.date.isin(ds)]
    print(f"{lab:14s} N0 {ci(g.N0)} | N {ci(g.N)} | S {ci(g.S)}")
# median / trimmed
g = N[(N.anchor == "14:00") & N.date.isin(NOF)].dropna(subset=["S"]).sort_values("S")
print("14:00 S all no-FOMC: mean", round(g.S.mean(), 4), "median", round(g.S.median(), 4))
top = g.tail(10)
print("top 10 S days:", [(str(d.date()), d.day_name()[:3], round(v, 3), "MIN" if d in MIN else ("BB" if d in BB else "-")) for d, v in zip(top.date, top.S)])
print("S without top 10:", round(g.S.iloc[:-10].mean(), 4))
# same-calendar placebo: event days at other anchors
for an in ["11:00", "12:00", "13:00", "15:00"]:
    g2 = N[(N.anchor == an) & N.date.isin(EV14 & NOF)]
    print(f"event days at {an}: N0 {ci(g2.N0)} | S {ci(g2.S)}")

# raw profile, fixed 14:00 legs, days with all offsets
for lab, ds in [("all no-FOMC", NOF), ("non-event", NOF - EV14), ("event", EV14 & NOF)]:
    w = W.loc["14:00"]; w = w[w.index.isin(ds)].dropna()
    print(f"profile {lab} (n={len(w)}):", w.mean().round(4).to_dict())

print("\n== G = E(14:00) - E(14:02), iron, re-selected (USD/day) ==")
settle = base.settle


def G(days, k=0.20, cap=CAP, alt=2):
    e = ent[(ent.k == k) & ent.date.isin(days) & (ent.mx <= cap)].copy()
    e["E"] = k * e.H * 100 + e.fee
    a = e[e.m == 0].set_index("date"); b = e[e.m == alt].set_index("date")
    j = a.join(b, lsuffix="0", rsuffix="1", how="inner")
    j["G"] = j.E0 - j.E1
    j["chg"] = (j.K0 != j.K1) | (j.w0 != j.w1)
    pay = lambda Kc, w, s: np.maximum(0, w - (s - Kc).abs())
    st = j.index.map(settle)
    j["dpnl"] = ((pay(j.K1, j.w1, st) - j.debit1) * 100 - j.E1) - ((pay(j.K0, j.w0, st) - j.debit0) * 100 - j.E0)
    return j, len(set(a.index) ^ set(b.index))


j, lost = G(NOF)
j.to_csv(os.path.join(T, "G.csv"))
print("main:", ci(j.G, nd=3), "lost", lost, "| by year", j.groupby(j.index.year).G.mean().round(3).to_dict(),
      "| K/w changed", round(j.chg.mean(), 3), "| dPnL", ci(j.dpnl, nd=2))
for lab, days, kw in [("cap1.0", NOF, dict(cap=1.0)), ("k0.5", NOF, dict(k=0.5)), ("incl FOMC", ALL, {}),
                      ("non-event (no FOMC, no minutes/beige)", NOF - EV14, {}), ("14:01", NOF, dict(alt=1))]:
    x, l = G(days, **kw)
    print(f"{lab}: {ci(x.G, nd=3)} lost {l} | by year {x.groupby(x.index.year).G.mean().round(3).to_dict()}")
x, _ = G(EV14 & NOF)
print("event days only:", ci(x.G, nd=3))
