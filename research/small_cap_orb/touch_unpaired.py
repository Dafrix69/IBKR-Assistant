"""POST-HOC, exploratory. SPEC test A pairs real and placebo touches, which keeps only days
reaching both levels. This keeps every touch of each. It does not replace test A.

    ../spx_fly/.venv/bin/python touch_unpaired.py
"""
import numpy as np
import pandas as pd

import backtest as B
from walls import after_touch, build_walls


def collect(stock, walls, seed=11):
    rng = np.random.default_rng(seed)
    pools = {1: (walls.call_wall / walls.spot - 1).dropna().values,
             -1: (1 - walls.put_wall / walls.spot).dropna().values}
    rows = []
    for date, d in stock.groupby("date", sort=True):
        if date not in walls.index or len(d) < 380:
            continue
        w = walls.loc[date]
        for side, lvl in ((1, w.call_wall), (-1, w.put_wall)):
            if np.isnan(lvl):
                continue
            real = after_touch(d, side, lvl)
            if real is not None:
                rows.append(dict(date=date, kind="real", side=side, r=real))
            for _ in range(20):  # many draws so the placebo mean is not one lucky day
                p = after_touch(d, side, w.spot * (1 + side * rng.choice(pools[side])))
                if p is not None:
                    rows.append(dict(date=date, kind="placebo", side=side, r=p))
    return pd.DataFrame(rows)


def main():
    stocks = {s: B.load(s, "TRADES") for s in ("IREN", "AXTI")}
    dates = sorted(set(stocks["IREN"].date) & set(stocks["AXTI"].date))
    rows = []
    for s, df in stocks.items():
        t = collect(df, build_walls(s, dates)).assign(sym=s)
        rows.append(t)
    t = pd.concat(rows)
    print("mean 30-minute return after first touch, + = rejected, bps")
    print((t.groupby(["sym", "side", "kind"]).r.agg(["mean", "count"]).assign(mean=lambda x: x["mean"] * 1e4)).round(1).to_string())
    r = t[t.kind == "real"].groupby("date").r.mean()
    p = t[t.kind == "placebo"].groupby("date").r.mean()
    d = (r - p).dropna()
    lo, hi = B.block_ci(d.values)
    print(f"real - placebo, days with a real touch: {d.mean()*1e4:.1f} bps  CI [{lo*1e4:.1f}, {hi*1e4:.1f}]  days {len(d)}")


if __name__ == "__main__":
    main()
