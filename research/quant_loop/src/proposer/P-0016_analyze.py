"""P-0016 analyze (spec sections 3-5).   .venv/bin/python P-0016_analyze.py train"""
import os
import sys
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer"
SPLIT = pd.Timestamp("2025-11-01")
K0 = 0.20
rng = np.random.default_rng(16)

which = sys.argv[1] if len(sys.argv) > 1 else "train"
c = pd.read_parquet(f"{T}/P-0016_tables/cells_{which}.parquet")
c = c[c.date < SPLIT]                                            # time wall
p = pd.read_parquet(f"{T}/P-0016_tables/profile_{which}.parquet")
p = p[p.date < SPLIT]                                            # time wall
cal = pd.read_parquet(os.path.join(R, "data/clean/calendar.parquet"))
cal = cal[cal.index < SPLIT]                                     # time wall
ev = pd.read_csv(f"{T}/P-0015_events.csv")
ev = ev[pd.to_datetime(ev.date) < SPLIT]                         # time wall
au = pd.read_csv(f"{T}/P-0001_auctions.csv", comment="#")
au = au[pd.to_datetime(au.auction_date) < SPLIT]                 # time wall
fed14 = set(pd.to_datetime(ev.date)) | set(cal.index[cal.fomc])
auc13 = set(pd.to_datetime(au[(au.closing_time_comp == "01:00 PM") & au.security_type.isin(["Note", "Bond"])].auction_date))
fomc = set(cal.index[cal.fomc])

c["base"] = c.date.map(cal.spx_ret_prev) > -0.01
c["event"] = [(h == 14 and d in fed14) or (h == 13 and (d in auc13 or d in fomc)) or (h == 15 and d in fomc)
              for d, h in zip(c.date, c.hour)]
c["Gq"] = K0 * (c.HA - c.HB) * 100
c["Gq5"] = 0.5 * (c.HA - c.HB) * 100
c["Gpre"] = K0 * (c.Hpre - c.HB) * 100
c["Gr"] = (c.kA * c.HA - c.kB * c.HB) * 100
c["dk"] = c.kA - c.kB
c["seg"] = np.where(c.date < pd.Timestamp("2025-05-01"), 1, 2)


def boot(df, col, n=10000):
    """Day-clustered: average the cells within a day, bootstrap days."""
    v = df.dropna(subset=[col]).groupby("date")[col].mean().values
    if len(v) < 3:
        return len(v), np.nan, np.nan, np.nan
    b = rng.choice(v, (n, len(v))).mean(1)
    return len(v), v.mean(), *np.percentile(b, [2.5, 97.5])


def line(name, df, col):
    n, m, lo, hi = boot(df, col)
    s = [boot(df[df.seg == k], col)[1] for k in (1, 2)]
    print(f"  {name:34s} n_days {n:3d}  {m:+.3f} [{lo:+.3f}, {hi:+.3f}]   seg1 {s[0]:+.3f}  seg2 {s[1]:+.3f}")
    return m, lo, hi, s


main = c[(c.kind == "main") & c.base & ~c.event]
plac = c[(c.kind == "plac") & c.base]
blind = main[main.hour.isin([13, 15])]
h14 = main[main.hour == 14]
pool = main[main.hour.isin([13, 14, 15])]
print(f"== {which}: cells main {len(main)} (events dropped {((c.kind=='main') & c.base & c.event & c.hour.isin([13,14,15])).sum()})")
print("valid HA/HB by hour:", main.groupby("hour").apply(lambda g: f"{g.HA.notna().sum()}/{g.HB.notna().sum()}").to_dict())
print("\nG_q = 0.20*(H_A - H_B)*100, $/group")
r1 = line("G_q blind (13+15)", blind, "Gq")
line("G_q 13", main[main.hour == 13], "Gq")
line("G_q 15", main[main.hour == 15], "Gq")
r14 = line("G_q 14 (non-blind)", h14, "Gq")
line("G_q pool (13+14+15)", pool, "Gq")
rp = line("G_q placebo hh:37 (13+15)", plac[plac.hour.isin([13, 15])], "Gq")
line("G_q placebo hh:37 (13+14+15)", plac[plac.hour.isin([13, 14, 15])], "Gq")
print("\nrealized component")
rr = line("G_r blind", blind, "Gr")
line("G_r 14", h14, "Gr")
line("dk blind", blind, "dk")
line("dk 14", h14, "dk")
print("  combo prints per second A/B (blind):", round(blind.ncA.sum() / 10 / len(blind), 3), "/", round(blind.ncB.sum() / 30 / len(blind), 3),
      " 14:", round(h14.ncA.sum() / 10 / len(h14), 3), "/", round(h14.ncB.sum() / 30 / len(h14), 3))
print("\nreport-only")
line("G_q k0.5 blind", blind, "Gq5")
line("G_pre (hh-1:59:30..hh:00) blind", blind, "Gpre")
line("G_pre 14", h14, "Gpre")
for h in (11, 12):
    line(f"G_q {h}:00 (no exclusions)", c[(c.kind == "main") & c.base & (c.hour == h)], "Gq")
allday = c[(c.kind == "main") & ~c.event & c.hour.isin([13, 15])]
line("G_q blind, all non-half days", allday, "Gq")
v = blind.dropna(subset=["Gq"]).groupby("date").Gq.mean()
print(f"  G_q blind median {v.median():+.3f}; drop top-5 days mean {v.sort_values().iloc[:-5].mean():+.3f}; share>0 {(v>0).mean():.2f}")
ex = c[(c.kind == "main") & c.base & c.event & c.hour.isin([13, 14, 15])]
for h in (13, 14):
    line(f"excluded event cells {h}:00", ex[ex.hour == h], "Gq")
print("  H level blind: HA", round(blind.HA.mean(), 4), "HB", round(blind.HB.mean(), 4), "Hpre", round(blind.Hpre.mean(), 4))

print("\nprofile (10-s buckets, base non-event, mean H in points; rel to hh:00 bucket start)")
p = p.merge(c[(c.kind == "main")][["date", "hour", "base", "event"]], on=["date", "hour"])
p = p[p.base & ~p.event]
tab = p.pivot_table(index="bucket", columns="hour", values="H", aggfunc="mean").round(4)
tab["prints/s 13+15"] = p[p.hour.isin([13, 15])].groupby("bucket").nc.mean() / 10
print(tab.to_string())

print("\njudgement (train gates 1, 2, 5):")
g1 = r1[0] > 0 and r1[1] > 0
g2 = all(x > 0 for x in r1[3])
g5 = abs(rp[0]) < r1[0] / 2
print(f"  gate1 {g1}  gate2 {g2}  gate3(14>0) {r14[0] > 0}  gate4(G_r>0) {rr[0] > 0}  gate5 {g5}")
