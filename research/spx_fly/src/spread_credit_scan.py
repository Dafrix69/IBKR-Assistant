"""Bear call spreads selected by the CREDIT received (the user's rule: about 3-4 points),
for widths 5 / 10 / 25, entries 10:30 / 12:00 / 14:00, held to settlement.

    .venv/bin/python src/spread_credit_scan.py [--workers 6]

Writes reports/spread_tables/by_credit.csv.
"""
import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import spread_study as P  # noqa: E402
import winrate_study as S  # noqa: E402

ENTRIES = ["10:30", "12:00", "14:00"]
WIDTHS = [5, 10, 15, 25]


def day_rows(args):
    path, settle, spot_day = args
    date = pd.Timestamp(os.path.basename(path)[6:14])
    df = pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "mid", "flag_bad"])
    out = []
    for e in ENTRIES:
        t = pd.Timestamp(f"{date.date()} {e}")
        if t not in spot_day.index:
            continue
        s0 = float(spot_day.loc[t])
        q = S.snap_mids(df, t)
        if q.empty:
            continue
        strikes = np.sort(q.index.get_level_values(0).unique().values)
        Kc = float(strikes[np.abs(strikes - s0).argmin()])
        try:
            implied = float(q.loc[(Kc, "C"), "mid"] + q.loc[(Kc, "P"), "mid"])
        except KeyError:
            continue
        for ks in strikes[(strikes >= s0 - 30) & (strikes <= s0 + 80)]:
            for w in WIDTHS:
                r = P.spread(q, float(ks), float(ks + w), "C")
                if r is None or r[0] <= 0:
                    continue
                credit, H, fee = r
                loss = min(max(0.0, settle - ks), w)
                out.append({"date": date, "entry": e, "width": w, "k_short": float(ks), "dist": ks - s0, "implied": implied,
                            "credit": credit, "pnl": (credit - loss - P.K * H) * P.MULT - fee,
                            "pnl_k05": (credit - loss - 0.5 * H) * P.MULT - fee, "max_loss_usd": (w - credit) * P.MULT})
    return out


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    cal = pd.read_parquet(os.path.join(P.CLEAN, "calendar.parquet"))
    spot = pd.read_parquet(os.path.join(P.CLEAN, "spot.parquet")).set_index("ts").spot
    jobs = [(f, float(cal.loc[d, "settle"]), spot[spot.index.normalize() == d])
            for f in sorted(glob.glob(os.path.join(P.CLEAN, "chain_*.parquet")))
            for d in [pd.Timestamp(os.path.basename(f)[6:14])] if not cal.loc[d, "half_day"]]
    with ProcessPoolExecutor(x.workers) as ex:
        rows = [r for day in ex.map(day_rows, jobs, chunksize=8) for r in day]
    p = pd.DataFrame(rows)
    p.to_parquet(os.path.join(P.CLEAN, "spread_credit_panel.parquet"), index=False)
    p["credit_bucket"] = pd.cut(p.credit, [0, 1, 2, 3, 4, 5, 7.5, 10, 15, 25], right=True)
    p["credit_pct"] = p.credit / p.width
    p["year"] = p.date.dt.year
    g = p.groupby(["width", "entry", "credit_bucket"], observed=True).apply(P.stats, include_groups=False).round(3)
    g.to_csv(os.path.join(P.TABLES, "by_credit.csv"))
    sel = p[(p.credit >= 3) & (p.credit <= 4)]
    sel.groupby(["width", "entry", "year"]).apply(P.stats, include_groups=False).round(3).to_csv(os.path.join(P.TABLES, "credit_3_4_by_year.csv"))
    print(len(p), "rows")


if __name__ == "__main__":
    main()
