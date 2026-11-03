"""Rule-based list of further tech names for the night / pre-market short, SPEC "More tech
small caps". Offline: universe/eod, universe/types.csv, universe/industry.csv.

    ../spx_fly/.venv/bin/python select_tech.py   # writes universe/tech_names.csv
"""
import os

import pandas as pd

import screen

ROOT = os.path.dirname(os.path.abspath(__file__))
EXCLUDE = {"IREN", "AXTI", "LITE", "OKLO"}
SECTORS, MIN_DAYS, TOP = {"Technology", "Communications"}, 15, 10


def main():
    ind = pd.read_csv(os.path.join(ROOT, "universe", "industry.csv"))
    types = pd.read_csv(os.path.join(ROOT, "universe", "types.csv"))
    pool = set(types[types.type == "COMMON"].symbol) & set(ind[ind.industry.isin(SECTORS)].symbol) - EXCLUDE
    eod = screen.load_all()
    eod = eod[eod.symbol.isin(pool) & (eod.open > 0) & (eod.close > 0)].sort_values(["symbol", "date"])
    g = eod.groupby("symbol")
    eod["prev_close"] = g.close.shift(1)
    eod["dv20"] = g.apply(lambda x: (x.close * x.volume).shift(1).rolling(20).mean(), include_groups=False).reset_index(level=0, drop=True)
    eod = eod[(eod.date >= pd.Timestamp("2024-10-28").date()) & (eod.date <= pd.Timestamp("2026-10-30").date())]
    hit = eod[(eod.open >= eod.prev_close * 1.05) & (eod.prev_close >= screen.MIN_PX) & (eod.dv20 >= screen.MIN_DV)]
    n = hit.groupby("symbol").size().rename("gap_up_days")
    dv = eod.groupby("symbol").dv20.median().rename("median_dv20")
    t = pd.concat([n, dv], axis=1).dropna().query("gap_up_days >= @MIN_DAYS").sort_values(["gap_up_days", "median_dv20"], ascending=False)
    t = t.join(ind.set_index("symbol")[["industry", "category", "name"]])
    print(f"pool {len(pool)} names; {len(t)} with >= {MIN_DAYS} gap-up days; top {TOP}:")
    print(t.head(TOP).to_string())
    t.head(TOP).to_csv(os.path.join(ROOT, "universe", "tech_names.csv"))
    print("\nnext 10 (not used):"); print(t.iloc[TOP:TOP + 10].to_string())


if __name__ == "__main__":
    main()
