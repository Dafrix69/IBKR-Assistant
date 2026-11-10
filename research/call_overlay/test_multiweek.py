"""Known-answer checks for the 2–4 week scheduler. Run: ../spx_fly/.venv/bin/python test_multiweek.py"""
import pandas as pd
import backtest_multiweek as m

days = pd.bdate_range("2026-01-05", "2026-02-06")
spot = pd.Series(100.0, index=days)
exps = [pd.Timestamp("2026-01-23"), pd.Timestamp("2026-01-30"), pd.Timestamp("2026-02-06")]
rows = []
for d in days:
    for e in exps:
        if d > e:
            continue
        # short 100 / long 105: mids 2.0/1.0 at entry, collapse to 0.4/0.2 from 2026-01-07 on
        ms, ml = (0.4, 0.2) if d >= pd.Timestamp("2026-01-07") else (2.0, 1.0)
        rows += [dict(date=d, exp=e, strike=100.0, bid=ms, ask=ms), dict(date=d, exp=e, strike=105.0, bid=ml, ask=ml)]
dfi = pd.DataFrame(rows).set_index(["date", "exp", "strike"]).sort_index()
m.pick = lambda chain, S, T, v, w: tuple(chain[chain.strike == K].assign(mid=lambda x: (x.bid + x.ask) / 2, delta=0.25).iloc[0] for K in (100.0, 105.0))

# with 75% TP: entry 01-05 (exp 01-23, 18 d) closed 01-07; next entry must be Monday 01-12 (exp 01-30, 18 d), and so on
tr, sk = m.simulate_mw("X", dfi, spot, "A", 0.05, 0.0, None, 2.0, 0.75, "mid", {})
assert [str(t["entry"]) for t in tr][:2] == ["2026-01-05", "2026-01-12"], tr
assert tr[0]["reason"] == "take_profit" and str(tr[0]["exit"]) == "2026-01-07" and tr[0]["dte"] == 18
assert all(pd.Timestamp(b["entry"]) > pd.Timestamp(a["exit"]) for a, b in zip(tr, tr[1:]))
# without TP: the first spread is held to 01-23, the next one opens Monday 01-26 -> exp 02-06 is 11 d -> no expiry in range
tr, sk = m.simulate_mw("X", dfi, spot, "A", 0.05, 0.0, None, 2.0, None, "mid", {})
assert len(tr) == 1 and tr[0]["reason"] == "expiry" and str(tr[0]["exit"]) == "2026-01-23", tr
assert abs(tr[0]["pnl"] - (100 - 2 * 0.65)) < 1e-9
print("ok")
