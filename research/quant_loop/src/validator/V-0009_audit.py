"""V-0009 audit (validator). TRAINING PERIOD ONLY. Reads V-0009_tables/candidates.parquet
(built by V-0009_candidates.py) and spx_fly's own spread_credit_panel.parquet (winrate_study anchor).
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0009_audit.py
"""
import itertools, math, os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0009_tables")
WALL = pd.Timestamp("2024-11-01")
c = pd.read_parquet(f"{OUT}/candidates.parquet"); c = c[c.date < WALL]            # TIME WALL
ws = pd.read_parquet(f"{R}/data/clean/spread_credit_panel.parquet"); ws = ws[ws.date < WALL]  # TIME WALL
rng = np.random.default_rng(9009)
L = []
def P(*a):
    s = " ".join(str(x) for x in a); print(s); L.append(s)

def boot(x, n=5000):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    m = x[rng.integers(0, len(x), (n, len(x)))].mean(1)
    return round(np.percentile(m, 2.5), 3), round(np.percentile(m, 97.5), 3)

# ---------- Anchor A: winrate_study panel, train only ----------
P("== Anchor A: spread_credit_panel (winrate_study口径), train only, bear call 15 wide, credit (3,4]")
a = ws[(ws.width == 15) & (ws.credit > 3) & (ws.credit <= 4)]
for e in ("10:30", "12:00", "14:00"):
    g = a[a.entry == e]
    P(e, "n", len(g), "days", g.date.nunique(), "ev", round(g.pnl.mean(), 2), "win", round((g.pnl > 0).mean(), 3))

# ---------- my replica of WS口径 ----------
cc = c[c.side == "C"]
rep = cc[(cc.credit > 3) & (cc.credit <= 4) & (cc.dist >= -30) & (cc.dist <= 80)]
P("== my replica of WS口径 (all strikes, (3,4], k .25, fee on mid no min-leg, FOMC in, no cap)")
for e in ("10:30", "12:00", "14:00"):
    g = rep[rep.time == e]
    P(e, "n", len(g), "ev", round(g.p25_ws.mean(), 2), "win", round((g.p25_ws > 0).mean(), 3))
m = a.merge(rep, left_on=["date", "entry", "k_short"], right_on=["date", "time", "K"], how="outer", indicator=True)
P("row match", m._merge.value_counts().to_dict(), "max |pnl diff|", round((m.pnl - m.p25_ws).abs().max(), 4))

# ---------- Anchor B: P-0009 spec ----------
def pick(df):
    """one spread per (date,time,side): spec rule."""
    x = df.assign(key=(df.credit - 3.5).abs().round(9))
    x = x.sort_values(["date", "time", "side", "key", "dist"], ascending=[True, True, True, True, False])
    return x.drop_duplicates(["date", "time", "side"])

base = c[c.has_0dte & (c.dist >= 0) & (c.sprd_s <= 2.0) & (c.sprd_l <= 2.0) & (c.credit >= 3) & (c.credit <= 4)]
sp = pick(base)
sp["d"] = sp.q_ramp - sp.ramp
sp["g"] = (sp.credit - sp.owe) / 15
sp.to_csv(f"{OUT}/spec_picks.csv", index=False)
P("== candidate days per time (spec filter, incl FOMC)")
P(sp.groupby(["side", "time"]).size().unstack().to_string())

def paired(side, t1="14:00", t0="10:30", fomc=False, src=None, col="p20_min"):
    s = (sp if src is None else src); s = s[s.side == side]
    if not fomc:
        s = s[~s.fomc]
    x = s[s.time == t1].set_index("date"); y = s[s.time == t0].set_index("date")
    j = x.join(y, lsuffix="_1", rsuffix="_0", how="inner")
    j["dd"] = j.d_1 - j.d_0; j["gg"] = j.g_1 - j.g_0; j["pp"] = j[col + "_1"] - j[col + "_0"]
    return j

P("== Anchor B: spec, paired 14:00-10:30, FOMC out, k .20 + min-leg")
J = {}
for s in ("C", "P"):
    j = paired(s); J[s] = j
    P(s, "n", len(j), "nD", int(j.dd.notna().sum()), "D", round(j.dd.mean(), 4), boot(j.dd), "G", round(j.gg.mean(), 4),
      "dPnL", round(j.pp.mean(), 2), boot(j.pp), "k.5", round((j.p50_min_1 - j.p50_min_0).mean(), 2),
      "k0", round((j.p00_min_1 - j.p00_min_0).mean(), 2), "pnl14/1030", round(j.p20_min_1.mean(), 2), round(j.p20_min_0.mean(), 2),
      "win14/1030", round((j.p20_min_1 > 0).mean(), 3), round((j.p20_min_0 > 0).mean(), 3),
      "distI14/1030", round((j.dist_1 / j.I_1).median(), 3), round((j.dist_0 / j.I_0).median(), 3))
    for y, g in j.groupby(j.index.year):
        P("   ", y, "n", len(g), "D", round(g.dd.mean(), 4), "dPnL", round(g.pp.mean(), 1), "pnl14/1030", round(g.p20_min_1.mean(), 1), round(g.p20_min_0.mean(), 1))
P("D_2", round((J["C"].dd.mean() + J["P"].dd.mean()) / 2, 4), "G_2", round((J["C"].gg.mean() + J["P"].gg.mean()) / 2, 4))
for s in ("C", "P"):
    j = paired(s, fomc=True); P("FOMC incl", s, "n", len(j), "D", round(j.dd.mean(), 4), "dPnL", round(j.pp.mean(), 2))

# gate 3 under two label 口径
P("== gate 3: month label union (proposer) vs per-side")
def labels(days):
    lab = sp[(sp.time == "10:30") & sp.date.isin(days)].drop_duplicates("date").set_index("date")
    x = (lab.settle - lab.F); return x.groupby(x.index.to_period("M")).median().apply(lambda v: "up" if v > 0 else "down")
lu = labels(sorted(set(J["C"].index) | set(J["P"].index)))
lc, lp = labels(list(J["C"].index)), labels(list(J["P"].index))
for nm, labc, labp in (("union", lu, lu), ("per-side", lc, lp)):
    for seg in ("down", "up"):
        jc = J["C"][J["C"].index.to_period("M").map(labc) == seg]; jp = J["P"][J["P"].index.to_period("M").map(labp) == seg]
        P(nm, seg, "n", len(jc), len(jp), "D_call", round(jc.dd.mean(), 4), "D_put", round(jp.dd.mean(), 4),
          "D_2", round((jc.dd.mean() + jp.dd.mean()) / 2, 4), "dPnL c/p", round(jc.pp.mean(), 1), round(jp.pp.mean(), 1))
P("months relabelled between口径:", int((lu.reindex(lc.index) != lc).sum()), "(call)", int((lu.reindex(lp.index) != lp).sum()), "(put)")

# ---------- decomposition: WS 口径 -> spec 口径, call side, metric = ev14 - ev10:30 ----------
P("== decomposition (call side, train only). metric = mean pnl 14:00 - mean pnl 10:30")
FACT = ["k020", "minleg", "fomc_out", "cap2", "band_edges", "one_per_day", "paired"]
cc = c[(c.side == "C") & (c.dist >= -30) & (c.dist <= 80) & (c.credit >= 3) & (c.credit <= 4)]
def metric(on):
    x = cc
    if on["band_edges"]:
        x = x[(x.dist >= 0) & x.has_0dte]
    else:
        x = x[x.credit > 3]
    if on["fomc_out"]:
        x = x[~x.fomc]
    if on["cap2"]:
        x = x[(x.sprd_s <= 2) & (x.sprd_l <= 2)]
    if on["one_per_day"]:
        x = pick(x)
    col = ("p20" if on["k020"] else "p25") + ("_min" if on["minleg"] else "_ws")
    if on["paired"]:
        d1 = set(x[x.time == "14:00"].date); d0 = set(x[x.time == "10:30"].date); keep = d1 & d0
        x = x[x.date.isin(keep)]
    e1, e0 = x[x.time == "14:00"][col], x[x.time == "10:30"][col]
    return e1.mean() - e0.mean(), e1.mean(), e0.mean(), len(e1), len(e0)
vals = {}
for bits in itertools.product([0, 1], repeat=len(FACT)):
    vals[bits] = metric(dict(zip(FACT, bits)))
A0, B1 = vals[(0,) * 7], vals[(1,) * 7]
P("WS口径 train:", [round(v, 2) for v in A0[:3]], A0[3:], " spec口径 train:", [round(v, 2) for v in B1[:3]], B1[3:])
n = len(FACT); sh = {}
for i, f in enumerate(FACT):
    tot = 0.0
    for bits in itertools.product([0, 1], repeat=n - 1):
        b = list(bits); s_ = sum(b)
        w = math.factorial(s_) * math.factorial(n - s_ - 1) / math.factorial(n)
        on = tuple(b[:i] + [1] + b[i:]); off = tuple(b[:i] + [0] + b[i:])
        tot += w * (vals[on][0] - vals[off][0])
    sh[f] = tot
P("Shapley share of (spec - WS) gap:", {k: round(v, 2) for k, v in sh.items()}, "sum", round(sum(sh.values()), 2))
P("one-at-a-time from WS:", {f: round(vals[tuple(int(j == i) for j in range(n))][0] - A0[0], 2) for i, f in enumerate(FACT)})
P("one-at-a-time removed from spec:", {f: round(B1[0] - vals[tuple(int(j != i) for j in range(n))][0], 2) for i, f in enumerate(FACT)})
# FOMC rows in WS bucket
f = rep[rep.fomc]
P("FOMC rows in WS bucket (train):", f.groupby("time").p25_ws.agg(["size", "mean"]).round(1).to_dict())
P("strikes per day in WS bucket:", rep.groupby("time").apply(lambda g: round(len(g) / g.date.nunique(), 2), include_groups=False).to_dict())
P("WS bucket by year, ev 14:00 / 10:30:")
for y, g in rep.groupby(rep.date.dt.year):
    P("  ", y, round(g[g.time == "14:00"].p25_ws.mean(), 1), round(g[g.time == "10:30"].p25_ws.mean(), 1), (g.time == "14:00").sum(), (g.time == "10:30").sum())

# ---------- put side: time vs distance ----------
P("== put side: distance-matched check (train, FOMC out, k .20+min, cap 2)")
pc = c[(c.side == "P") & c.has_0dte & ~c.fomc & (c.dist >= 0) & (c.sprd_s <= 2) & (c.sprd_l <= 2)].copy()
pc["x"] = pc.dist / pc.I
pc["d"] = pc.q_ramp - pc.ramp
for lo, hi in ((0.2, 0.35), (0.35, 0.5), (0.5, 0.65), (0.65, 0.8)):
    out = []
    for t in ("10:30", "14:00"):
        g = pc[(pc.time == t) & (pc.x > lo) & (pc.x <= hi)]
        g1 = g.sort_values("x").drop_duplicates("date")      # one per day: nearest to lo edge
        out.append(f"{t}: days {g1.date.nunique()} d {g1.d.mean():+.4f} pnl {g1.p20_min.mean():+.1f}")
    P(f"  dist/I ({lo},{hi}]", " | ".join(out))
# same picks, put at 14:00 vs call at 14:00 by dist/I
P("spec picks dist/I quantiles put 10:30 / 14:00:", J["P"].pipe(lambda j: (j.dist_0 / j.I_0).quantile([.25, .5, .75]).round(2).tolist()),
  J["P"].pipe(lambda j: (j.dist_1 / j.I_1).quantile([.25, .5, .75]).round(2).tolist()))
jp = J["P"]
top = jp.pp.sort_values(ascending=False)
P("put dPnL without best 5 days:", round(jp.pp.drop(top.index[:5]).mean(), 1), "without worst 5:", round(jp.pp.drop(top.index[-5:]).mean(), 1))
open(f"{OUT}/audit.txt", "w").write("\n".join(L) + "\n")
