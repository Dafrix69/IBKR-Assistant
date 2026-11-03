"""V-0007 analysis, TRAINING PERIOD ONLY. Reads V-0007_tables/days.csv (V-0007_pin.py).
Compares with proposer's days_all.csv per day (read only, as audit object)."""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
Q = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop"
OUT = f"{Q}/src/validator/V-0007_tables"
WALL = pd.Timestamp("2024-11-01")
rng = np.random.default_rng(7)

v = pd.read_csv(f"{OUT}/days.csv", parse_dates=["date"]); v = v.loc[v.date < WALL]
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet"); cal = cal.loc[cal.index < WALL]
v = v.join(cal[["spx_ret_prev", "fomc"]], on="date")
v["drop"] = v["drop"].fillna("")
L = []
def P(s): L.append(str(s)); print(s)

def ci(x, n=5000):
    x = np.asarray(x, float)
    m = x[rng.integers(0, len(x), (n, len(x)))].mean(1)
    return np.round(np.percentile(m, [2.5, 97.5]), 4)

# ---------- per-day reconciliation with proposer
p = pd.read_csv(f"{Q}/src/proposer/P-0007_tables/days_all.csv", parse_dates=["date"])
p = p.loc[p.date < WALL]; p["drop"] = p["drop"].fillna("")
m = v.merge(p, on="date", suffixes=("", "_p"), how="outer", indicator=True)
P(f"merge {m._merge.value_counts().to_dict()}")
for a, b in (("drop", "drop_p"), ("K0", "K0"), ("Ks", "Ks"), ("Kmin", "Kmin"), ("w", "w"), ("settle", "settle")):
    bb = b + "_p" if b == a else b
    x, y = m[a], m[bb]
    diff = ~((x == y) | (x.isna() & y.isna()) | (np.isclose(pd.to_numeric(x, errors="coerce"), pd.to_numeric(y, errors="coerce"))))
    P(f"  per-day mismatch {a}: {int(diff.sum())}")
mm = m[(m["drop"] == "") & (m["drop_p"] == "")]
P(f"  max |R - R_p| {np.nanmax(np.abs(mm.R - mm.R_p)):.4f}; max |R0 - R0_p| {np.nanmax(np.abs(mm.R0 - mm.R0_p)):.4f}")
P(f"  K0 (chain nearest) vs pure 5-grid nearest differ on {(v.K0 != v.K0g).sum()} days")

# ---------- main sample
def prep(d):
    d = d.copy()
    d["year"] = d.date.dt.year
    d["moved"] = d.Ks != d.K0
    d["Km"] = 2 * d.S - d.Ks
    d["seg"] = d.date.dt.to_period("M").map((d.settle - d.F).groupby(d.date.dt.to_period("M")).median()).gt(0).map({True: "up", False: "down"})
    return d

base = prep(v.loc[(v["drop"] == "") & ~(v.spx_ret_prev <= -0.01)])
P(f"\nbaseline days {len(base)}; moved {base.moved.sum()} ({base.moved.mean():.3f}); shift dist {(base.Ks - base.K0).abs()[base.moved].value_counts().to_dict()}")
P(f"base rate |settle-K0|<=2.5: {((base.settle - base.K0).abs() <= 2.5).mean():.4f}")

def mcells(d, win=2.5, label=""):
    mv = d.loc[d.moved].copy()
    hk = ((mv.settle - mv.Ks).abs() <= win).astype(float)
    hm = ((mv.settle - mv.Km).abs() <= win).astype(float)
    pl = ((mv.settle - mv.Kmin).abs() <= win).astype(float) - ((mv.settle - (2 * mv.S - mv.Kmin)).abs() <= win).astype(float)
    mv["m1"] = hk - hm; mv["m1pl"] = pl; mv["m1d"] = mv.m1 - pl
    mv["m2"] = np.sign(mv.Ks - mv.S) * (mv.settle - mv.S) / mv.I
    mv["dist"] = (mv.settle - mv.Km).abs() - (mv.settle - mv.Ks).abs()     # >0 = settle closer to K*
    mv["side"] = np.where(mv.Ks > mv.S, "above", "below")
    mv["openrel"] = np.where(np.sign(mv.Ks - mv.S) == np.sign(mv.O - mv.S), "toward", "away")
    mv["r25"] = (mv.Ks % 25 == 0)
    mv["kminK0"] = mv.Kmin == mv.K0
    rows = []
    def row(g, name):
        rows.append(dict(cell=name, n=len(g), hitK=g.eval("abs(settle-Ks)").le(win).mean(),
                         hitM=g.eval("abs(settle-Km)").le(win).mean(), M1=g.m1.mean(), M1_ci=ci(g.m1),
                         M1_minus_pl=g.m1d.mean(), M1d_ci=ci(g.m1d),
                         M1_minus_pl_kminmoved=g.loc[~g.kminK0, "m1d"].mean(), n_kminmoved=int((~g.kminK0).sum()),
                         M2=g.m2.mean(), dist_pts=g.dist.mean(), dist_ci=ci(g.dist)))
    row(mv, "all moved")
    for col in ("year", "side", "openrel", "seg", "r25"):
        for k, g in mv.groupby(col):
            row(g, f"{col}={k}")
    t = pd.DataFrame(rows)
    return t, mv

pd.set_option("display.width", 260); pd.set_option("display.max_columns", 30)
t, mv = mcells(base)
t.to_csv(f"{OUT}/m_cells.csv", index=False)
P("\nM on moved days (2.5 window):\n" + t.round(4).to_string(index=False))

# Delta
for tg in ("", "_k05", "_k0"):
    base["D" + tg] = base["R" + tg] - base["R0" + tg]
P(f"\nDelta all {len(base)} days: {base.D.mean():.2f} ci {ci(base.D)}; k0.5 {base.D_k05.mean():.2f}; k0 {base.D_k0.mean():.2f}; sd {base.D.std():.1f}")
P("Delta by year: " + str(base.groupby('year').D.mean().round(2).to_dict()) + " by seg: " + str(base.groupby('seg').D.mean().round(2).to_dict()))
P(f"R0 win {(base.R0 > 0).mean():.4f} ev {base.R0.mean():.2f}; R win {(base.R > 0).mean():.4f} ev {base.R.mean():.2f}")

# ---------- robustness (training only)
P("\nRobustness of M1 (all moved):")
for win in (1.5, 2.5, 5.0):
    tt, _ = mcells(base, win)
    a = tt.iloc[0]
    P(f"  window {win}: n {a.n} M1 {a.M1:+.4f} {a.M1_ci} ; M1-pl {a.M1_minus_pl:+.4f}; by year " +
      str(tt[tt.cell.str.startswith('year')].set_index('cell').M1.round(4).to_dict()))
# no price drops, no prev-day skip: M needs no prices
allm = prep(v.loc[v.oi_ok.astype(bool) & v.K0.notna()])
tt, _ = mcells(allm)
P(f"  all OI days, no price drop / no prev-day skip: n {tt.iloc[0].n} M1 {tt.iloc[0].M1:+.4f} {tt.iloc[0].M1_ci}; dist {tt.iloc[0].dist_pts:+.3f} {tt.iloc[0].dist_ci}; by year " +
  str(tt[tt.cell.str.startswith('year')].set_index('cell').M1.round(4).to_dict()))
P(f"  continuous (baseline moved): mean |settle-Km| - |settle-K*| = {t.iloc[0].dist_pts:+.3f} pts {t.iloc[0].dist_ci}")
P(f"  Kmin==K0 on {int(mv.kminK0.sum())} of {len(mv)} moved days; M1-pl restricted to Kmin moved: {t.iloc[0].M1_minus_pl_kminmoved:+.4f} (n {t.iloc[0].n_kminmoved})")

# ---------- OI-free pinning test: settle vs 5 / 25 grid
allcal = cal.loc[(~cal.half_day) & cal.has_0dte]
sp = pd.read_parquet(f"{R}/data/clean/spot.parquet"); sp = sp.loc[sp.ts < WALL].set_index("ts")
def gridstats(x, g):
    dd = np.abs(x - g * np.round(x / g))
    return len(dd), dd.mean(), (dd <= 0.1 * g).mean()
P("\nOI-free pin test (training non-half 0DTE days). Uniform: mean dist = g/4, P(dist<=0.1g)=0.20")
for g in (5, 25):
    for name, ser in (("settle", allcal.settle),
                      ("spot 14:00", pd.Series([sp.spot.get(d + pd.Timedelta(hours=14), np.nan) for d in allcal.index])),
                      ("spot 15:30", pd.Series([sp.spot.get(d + pd.Timedelta(hours=15, minutes=30), np.nan) for d in allcal.index])),
                      ("spot 15:59", pd.Series([sp.spot.get(d + pd.Timedelta(hours=15, minutes=59), np.nan) for d in allcal.index]))):
        x = ser.dropna().values
        n, md, pn = gridstats(x, g)
        se = np.sqrt(0.2 * 0.8 / n)
        P(f"  grid {g:>2} {name:<10} n {n} mean dist {md:.3f} (uniform {g/4:.3f}, se {g/np.sqrt(48*n):.3f}); P(<= {0.1*g:.1f}) {pn:.3f} (se {se:.3f})")
open(f"{OUT}/summary.txt", "w").write("\n".join(L) + "\n")
