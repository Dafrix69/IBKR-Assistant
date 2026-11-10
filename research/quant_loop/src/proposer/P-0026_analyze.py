"""P-0026: long-only top-quintile by monthly change in 21-day ATM call IV (An, Ang, Bali &
Cakici 2014), versus the same-period equal-weight pool basket. Training pools only.
Engine (calendar, exclusions, turnover, bootstrap) shared with P-0025_analyze.py."""
import os, importlib.util
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("eng", os.path.join(HERE, "P-0025_analyze.py"))
eng = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eng)
CUTOFF = eng.CUTOFF


def make(col_fn):
    def f(tab, t, t_prev):
        if pd.isna(t_prev) or t not in tab.index or t_prev not in tab.index:
            return None
        return col_fn(tab, t) - col_fn(tab, t_prev)
    return f


sig_dc = make(lambda tab, t: tab.loc[t, "c21"])
sig_dp = make(lambda tab, t: tab.loc[t, "p21"])
sig_dcp = make(lambda tab, t: tab.loc[t, "c21"] - tab.loc[t, "p21"])


def main():
    d, ev = eng.load()
    d = d[d.date < CUTOFF]  # time wall (already applied in eng.load right after reading)
    os.makedirs(os.path.join(HERE, "P-0026_tables"), exist_ok=True)
    with open(os.path.join(HERE, "P-0026_tables", "results.md"), "w") as out:
        eng.report("G-main dCVOL21 monthly", lambda drop: eng.build_periods(d, ev, "M", sig_dc, True, drop), True, 3, 12, out)
        eng.report("G-v1 dPVOL21 lowest", lambda drop: eng.build_periods(d, ev, "M", sig_dp, True, drop), False, 3, 12, out)
        eng.report("G-v2 d(CVOL-PVOL)21", lambda drop: eng.build_periods(d, ev, "M", sig_dcp, True, drop), True, 3, 12, out)


if __name__ == "__main__":
    main()
