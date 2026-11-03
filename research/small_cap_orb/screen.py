"""Daily gap screen over the optionable universe, rules in SPEC.md "Universe extension".
Uses only information known at 09:30 of day D. Writes universe/candidates.csv.

    ../spx_fly/.venv/bin/python screen.py
"""
import glob
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
MIN_PX, MIN_DV, MIN_HIST, TOP, MIN_GAP = 5.0, 30e6, 30, 10, 0.03


def load_all():
    frames = []
    for f in glob.glob(os.path.join(ROOT, "universe", "eod", "*.csv")):
        d = pd.read_csv(f, usecols=["created", "open", "high", "low", "close", "volume"])
        if len(d) < MIN_HIST + 1:
            continue
        d["date"] = pd.to_datetime(d.created.str[:10]).dt.date
        d["symbol"] = os.path.basename(f)[:-4]
        frames.append(d.drop(columns="created"))
    return pd.concat(frames, ignore_index=True)


def main():
    eod = load_all().sort_values(["symbol", "date"])
    eod = eod[(eod.open > 0) & (eod.close > 0)]
    types = os.path.join(ROOT, "universe", "types.csv")
    if os.path.exists(types):  # common stocks only, see SPEC "Universe extension"
        t = pd.read_csv(types)
        drop = set(t[t.type != "COMMON"].symbol)  # unclassified names stay until classified
        eod = eod[~eod.symbol.isin(drop)]
        print(f"types.csv: dropped {len(drop)} non-COMMON symbols (ETF etc.)")
    g = eod.groupby("symbol")
    eod["prev_close"] = g.close.shift(1)
    eod["dv20"] = g.apply(lambda x: (x.close * x.volume).shift(1).rolling(20).mean(), include_groups=False).reset_index(level=0, drop=True)
    eod["hist"] = g.cumcount()
    eod["gap"] = eod.open / eod.prev_close - 1
    elig = eod[(eod.prev_close >= MIN_PX) & (eod.dv20 >= MIN_DV) & (eod["hist"] >= MIN_HIST) & (eod.gap.abs() >= MIN_GAP)]
    elig = elig.assign(absgap=elig.gap.abs()).sort_values(["date", "absgap"], ascending=[True, False])
    cand = elig.groupby("date").head(TOP)[["date", "symbol", "gap", "prev_close", "dv20", "open"]]
    cand.to_csv(os.path.join(ROOT, "universe", "candidates.csv"), index=False)
    print(f"universe symbols {eod.symbol.nunique()}, days {eod.date.nunique()}, eligible symbol-days {len(elig)},"
          f" candidates {len(cand)} over {cand.date.nunique()} days, distinct symbols {cand.symbol.nunique()}")
    print("per-day count:", cand.groupby("date").size().describe()[["min", "50%", "max"]].to_dict())
    print("most frequent:", cand.symbol.value_counts().head(15).to_dict())
    print("gap sign: up", (cand.gap > 0).mean().round(2))


if __name__ == "__main__":
    main()
