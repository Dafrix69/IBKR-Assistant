"""V-0016 statistics on V-0016_tables/cells.parquet + profile.parquet (training period only).

    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0016_stats.py
"""
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
V = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator"
WALL = pd.Timestamp("2025-11-01")
rng = np.random.default_rng(20261101)
B = 10000

c = pd.read_parquet(f"{V}/V-0016_tables/cells.parquet"); c = c[c.date < WALL]            # time wall
p = pd.read_parquet(f"{V}/V-0016_tables/profile.parquet"); p = p[p.date < WALL]          # time wall
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet"); cal = cal[cal.index < WALL]   # time wall
ev = pd.read_csv(f"{V}/V-0015_events.csv"); ev = ev[pd.to_datetime(ev.date) < WALL]     # time wall
au = pd.read_csv(f"{V}/V-0001_auctions.csv"); au = au[pd.to_datetime(au.auction_date) < WALL]
fomc = set(cal.index[cal.fomc])
fed14 = set(pd.to_datetime(ev.date)) | fomc
auc13 = set(pd.to_datetime(au.auction_date))

c["base"] = c.date.map(cal.spx_ret_prev) > -0.01
c["event"] = [(h == 14 and d in fed14) or (h == 13 and (d in auc13 or d in fomc)) or (h == 15 and d in fomc)
              for d, h in zip(c.date, c.hour)]
c["G"] = 0.20 * (c.HA - c.HB) * 100
c["G5"] = 0.50 * (c.HA - c.HB) * 100
c["Gmed"] = 0.20 * (c.medA - c.medB) * 100
c["Gpre"] = 0.20 * (c.Hpre - c.HB) * 100
c["Gr"] = (c.kA * c.HA - c.kB * c.HB) * 100
c["dk"] = c.kA - c.kB
c["seg"] = np.where(c.date < pd.Timestamp("2025-05-01"), 1, 2)


def daymeans(df, col):
    return df.dropna(subset=[col]).groupby("date")[col].mean()


def boot(v, f=np.mean):
    v = np.asarray(v)
    idx = rng.integers(0, len(v), (B, len(v)))
    s = np.array([f(v[i]) for i in idx]) if f is not np.mean else v[idx].mean(1)
    return np.percentile(s, [2.5, 97.5])


def trim(v, q=0.05):
    v = np.sort(np.asarray(v)); k = int(len(v) * q)
    return v[k:len(v) - k].mean()


def row(name, df, col, med=False):
    v = daymeans(df, col)
    lo, hi = boot(v.values)
    s1 = daymeans(df[df.seg == 1], col).mean(); s2 = daymeans(df[df.seg == 2], col).mean()
    out = f"  {name:38s} n {len(v):3d}  mean {v.mean():+.3f} [{lo:+.3f}, {hi:+.3f}]  seg1 {s1:+.3f} seg2 {s2:+.3f}"
    if med:
        ml, mh = boot(v.values, np.median)
        out += f" | median {v.median():+.3f} [{ml:+.3f}, {mh:+.3f}]  trim5 {trim(v.values):+.3f}  >0 {(v > 0).mean():.2f}"
    print(out)
    return v


main0 = c[(c.minute == 0) & c.base & ~c.event]
print(f"main cells (m=0, base, non-event, 11-15): {len(main0)}; event cells dropped (13-15): "
      f"{((c.minute == 0) & c.base & c.event & c.hour.isin([13, 14, 15])).sum()}")
print("cells per hour:", main0.groupby("hour").size().to_dict(), " valid HA/HB:",
      main0.groupby("hour").apply(lambda g: f"{g.HA.notna().sum()}/{g.HB.notna().sum()}").to_dict())
blind = main0[main0.hour.isin([13, 15])]
h14 = main0[main0.hour == 14]
pool = main0[main0.hour.isin([13, 14, 15])]
plac = c[(c.minute == 37) & c.base]
placB = plac[plac.hour.isin([13, 15])]

print("\n== 1. pre-registered (mean) cells, $/group, k 0.20, day-clustered bootstrap")
gb = row("G_q blind (13+15)", blind, "G", True)
row("G_q 13", main0[main0.hour == 13], "G", True)
row("G_q 15", main0[main0.hour == 15], "G", True)
row("G_q 14 (non-blind)", h14, "G", True)
row("G_q pool", pool, "G", True)
gp = row("G_q placebo :37 (13+15), no event filter", placB, "G", True)
row("G_q placebo :37 (13+15), same event filter", placB[~placB.event], "G", True)
row("G_r blind", blind, "Gr", True)
row("G_r 14", h14, "Gr", True)
row("dk blind", blind, "dk", True)
row("G_q k0.5 blind", blind, "G5", True)
row("G_pre blind (hh-1:59:30..hh:00 vs B)", blind, "Gpre", True)
row("G_q 11 (no excl)", c[(c.minute == 0) & c.base & (c.hour == 11)], "G", True)
row("G_q 12 (no excl)", c[(c.minute == 0) & c.base & (c.hour == 12)], "G", True)
row("G_q blind using window medians", blind, "Gmed", True)
print(f"  combo flies / s, A vs B: blind {blind.nfA.sum()/10/len(blind):.3f} / {blind.nfB.sum()/30/len(blind):.3f}"
      f"  14 {h14.nfA.sum()/10/len(h14):.3f} / {h14.nfB.sum()/30/len(h14):.3f}"
      f"  placebo:37 (13+15) {placB.nfA.sum()/10/len(placB):.3f} / {placB.nfB.sum()/30/len(placB):.3f}")
print(f"  gate5: |placebo| {abs(gp.mean()):.3f} vs G_blind/2 {gb.mean()/2:.3f} -> {'fail' if abs(gp.mean()) >= gb.mean()/2 else 'pass'}")
print(f"  quote age (s, mean of max-leg age): blind A {blind.ageA.mean():.1f}  B {blind.ageB.mean():.1f}")

print("\n  per-cell (13+15): main mean/median/trim5/>0:",
      *[f"{x:+.3f}" for x in (blind.G.mean(), blind.G.median(), trim(blind.G.dropna()))], f"{(blind.G > 0).mean():.2f}",
      "| placebo:", *[f"{x:+.3f}" for x in (placB.G.mean(), placB.G.median(), trim(placB.G.dropna()))], f"{(placB.G > 0).mean():.2f}")
for nm, g in (("main", blind), ("placebo", placB)):
    print(f"  {nm} extremes:", g.dropna(subset=['G']).reindex(g.G.abs().sort_values(ascending=False).index[:4])
          [["date", "hour", "w", "HA", "HB", "G"]].round(3).to_dict("records"))

print("\n== 2. minute placebo (validator): every minute m = 3..57 except 30, same day x hour cells as main")
keys = blind[["date", "hour"]]
pl = c.merge(keys, on=["date", "hour"])
pl = pl[pl.minute.between(3, 57) & (pl.minute != 30)]
stat = {}
for m, g in pl.groupby("minute"):
    v = daymeans(g, "G")
    stat[m] = (v.mean(), v.median(), trim(v.values), (v > 0).mean())
S = pd.DataFrame(stat, index=["mean", "median", "trim5", "share>0"]).T
obs = (gb.mean(), gb.median(), trim(gb.values), (gb > 0).mean())
for i, k in enumerate(S.columns):
    print(f"  {k:8s} hour {obs[i]:+.3f}   placebo minutes: median {S[k].median():+.3f}  [min {S[k].min():+.3f}, max {S[k].max():+.3f}]"
          f"  rank of hour: {int((S[k] >= obs[i]).sum())} of {len(S)} minutes >= hour")
m30 = daymeans(c.merge(keys, on=["date", "hour"]).query("minute == 30"), "G")
print(f"  minute :30  mean {m30.mean():+.3f} median {m30.median():+.3f} >0 {(m30 > 0).mean():.2f}")

# paired: hour cell minus the same day-hour's median over the placebo minutes
ref = pl.groupby(["date", "hour"]).G.median().rename("ref")
bb = blind.join(ref, on=["date", "hour"])
bb["D"] = bb.G - bb.ref
v = daymeans(bb, "D")
print(f"  paired D = G(hh:00) - median_m G(hh:m) same day-hour: mean {v.mean():+.3f} {np.round(boot(v.values),3)}"
      f"  median {v.median():+.3f} {np.round(boot(v.values, np.median),3)}  >0 {(v > 0).mean():.2f}"
      f"  seg1 med {daymeans(bb[bb.seg==1],'D').median():+.3f} seg2 med {daymeans(bb[bb.seg==2],'D').median():+.3f}")

# permutation: in every (day, hour) cell pick a random minute from {0} U placebo minutes, recompute day-mean median
allm = pd.concat([blind[["date", "hour", "minute", "G"]], pl[["date", "hour", "minute", "G"]]]).dropna(subset=["G"])
arr = allm.groupby(["date", "hour"]).G.apply(np.array)
dates = arr.index.get_level_values(0).values
cells = list(arr.values)
nperm, res_med, res_mean = 1000, [], []
for _ in range(nperm):
    pick = np.array([x[rng.integers(len(x))] for x in cells])
    dm = pd.Series(pick).groupby(dates).mean()
    res_med.append(dm.median()); res_mean.append(dm.mean())
res_med, res_mean = np.array(res_med), np.array(res_mean)
print(f"  permutation (1000, minute labels within day-hour): median stat p_one = {(res_med >= gb.median()).mean():.3f}"
      f" (null 95% {np.percentile(res_med, 2.5):+.3f}..{np.percentile(res_med, 97.5):+.3f});"
      f" mean stat p_two = {(np.abs(res_mean - res_mean.mean()) >= abs(gb.mean() - res_mean.mean())).mean():.3f}")

print("\n== 3. profile (fixed legs, base non-event, 13+14+15): H relative to the cell's own [-60,0) level, points")
pp = p.merge(c[["date", "hour", "minute", "base", "event"]], on=["date", "hour", "minute"])
pp = pp[pp.base & pp.hour.isin([13, 14, 15])].dropna(subset=["H"])
pre = pp[pp.bucket < 0].groupby(["date", "hour", "minute"]).H.mean().rename("pre")
pp = pp.join(pre, on=["date", "hour", "minute"]); pp["rel"] = pp.H - pp.pre
for mm in (0, 37):
    q = pp[(pp.minute == mm) & ~(pp.event & (mm == 0))]
    t = q.groupby("bucket").agg(med=("rel", "median"), mean=("rel", "mean"), pos=("rel", lambda x: (x > 0).mean()),
                                nf=("nf", "mean"))
    t["nf"] = t.nf / 10
    print(f"  minute {mm:02d}:"); print(t.loc[[-30, -10, 0, 10, 20, 30, 40, 60, 90, 120]].round(4).T.to_string())
