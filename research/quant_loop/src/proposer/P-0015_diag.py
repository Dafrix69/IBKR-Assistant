"""P-0015 post-hoc diagnostics (written AFTER analyze_out.txt; not used to choose the rule).
(1) 'incl FOMC' re-done with FOMC statement days as events (analyze put them in the control pool);
(2) distribution of G_ev (median, share > 0) and minutes-only listing of the cap-dropped days.
"""
import importlib.util
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("an", os.path.join(HERE, "P-0015_analyze.py"))
an = importlib.util.module_from_spec(spec)
spec.loader.exec_module(an)          # the module applies the time wall (date < 2024-11-01) on load
SPLIT = pd.Timestamp("2024-11-01")

d = an.base_days(incl_fomc=True)
d = d[d.index < SPLIT]                                           # time wall (again, explicit)
t = an.entry_table().reindex(d.index)
ok = t[("E", "14:00")].notna() & t[("E", "13:55")].notna()
G = (t[("E", "14:00")] - t[("E", "13:55")])[ok]
evf = d.event | d.fomc
print("FOMC days in base:", int(d.fomc.sum()), " with both minutes valid:", int(d.fomc.reindex(G.index).sum()))
print("FOMC G values:", G[d.fomc.reindex(G.index)].round(2).to_dict())
an.fmt(an.did(G, d, evf, ~evf), "DiD, events = minutes+BB+FOMC")
an.fmt(an.did(G, d, d.event, ~evf), "DiD, events = minutes+BB, FOMC out of controls")

d0 = an.base_days()
G0 = (an.entry_table().reindex(d0.index)[("E", "14:00")] - an.entry_table().reindex(d0.index)[("E", "13:55")]).dropna()
ge = G0[d0.event.reindex(G0.index)]
print(f"\nG_ev median {ge.median():+.2f}, share >0 {np.mean(ge > 0):.2f}, =0 {np.mean(ge == 0):.2f}, <0 {np.mean(ge < 0):.2f}")
gc = G0[~d0.event.reindex(G0.index)]
print(f"G_ctrl median {gc.median():+.2f}, share >0 {np.mean(gc > 0):.2f}, <0 {np.mean(gc < 0):.2f}")

# (3) the three event days dropped by the symmetric cap condition (14:00 over the cap): pnl if entered at 13:55
tt = an.entry_table(cap=99.0)
tt = tt[tt.index < SPLIT]                                        # time wall
er = an.er[an.er.date < SPLIT]                                   # time wall
print("\ncap-dropped event days (cap lifted only to read them):")
for day in pd.to_datetime(["2022-10-12", "2022-11-23", "2023-01-04"]):
    r = tt.loc[day]
    e = er[(er.date == day) & (er.entry == "14:00")].iloc[0]
    print(f"  {day.date()} pnl13:55 {r[('pnl', '13:55')]:+.0f}  pnl14:00(uncapped) {r[('pnl', '14:00')]:+.0f}  "
          f"E13:55 {r[('E', '13:55')]:.2f}  E14:00 {r[('E', '14:00')]:.2f}  14:00 widest leg {e.mx_iron:.1f}  H {e.H_iron:.2f}")
