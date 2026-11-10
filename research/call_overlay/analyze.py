"""Summaries from trades.csv. Run: ../spx_fly/.venv/bin/python analyze.py [suffix] > result[suffix].txt"""
import os, sys
import numpy as np, pandas as pd
from backtest import block_boot_mean, weekly_series

HERE = os.path.dirname(os.path.abspath(__file__))
SUF = sys.argv[1] if len(sys.argv) > 1 else ""
t = pd.read_csv(os.path.join(HERE, f"trades{SUF}.csv"), parse_dates=["entry"])
weeks = np.sort(t.entry.unique())
cut = weeks[int(len(weeks) * 2 / 3)]
t["part"] = np.where(t.entry < cut, "train", "test")
print(f"trades={len(t)}  weeks={len(weeks)}  test starts {pd.Timestamp(cut).date()}\n")

keys = ["variant", "w", "k", "stop"]
rows = []
for key, g in t.groupby(keys):
    r = dict(zip(keys, key))
    for part in ("train", "test", "all"):
        gp = g if part == "all" else g[g.part == part]
        r[f"n_{part}"] = len(gp)
        r[f"mean_pct_{part}"] = gp.pnl_pct.mean()
        r[f"mean_usd_{part}"] = gp.pnl.mean()
    gt = g[g.part == "test"]
    lo, hi = block_boot_mean(weekly_series(gt).values)
    r["test_ci_lo"], r["test_ci_hi"] = lo, hi
    wins, losses = g.pnl[g.pnl > 0], g.pnl[g.pnl <= 0]
    r["win_rate"] = len(wins) / len(g)
    r["avg_win"], r["avg_loss"] = wins.mean(), losses.mean()
    r["realized_RR"] = -losses.mean() / wins.mean() if len(wins) else np.nan  # loss : win, as 1 : x  -> x = 1/this
    r["credit_over_width_med"] = g.cw.median()
    r["struct_loss_per_win"] = ((1 - g.cw) / g.cw).median()
    r["delta_med"] = g.delta_s.median()
    for reason in ("expiry", "spread_stop", "stock_stop", "take_profit"):
        r[f"exit_{reason}"] = (g.reason == reason).mean()
    r["total_usd_all"] = g.pnl.sum()
    rows.append(r)
grid = pd.DataFrame(rows)
grid.to_csv(os.path.join(HERE, f"grid{SUF}.csv"), index=False)
pd.set_option("display.width", 250, "display.max_columns", 40, "display.float_format", "{:.3f}".format)
print("== grid (pnl_pct = spread P&L as % of 100-share notional, per trade) ==")
print(grid[keys + ["n_all", "mean_pct_train", "mean_pct_test", "test_ci_lo", "test_ci_hi", "mean_usd_all", "total_usd_all",
                   "win_rate", "avg_win", "avg_loss", "credit_over_width_med", "struct_loss_per_win", "delta_med",
                   "exit_expiry", "exit_spread_stop", "exit_stock_stop", "exit_take_profit"]].to_string(index=False))

print("\n== pass bar (k=0.5 test mean>0 & CI excludes 0, and k=1 test mean>0) ==")
for (v, w, stop), g in grid.groupby(["variant", "w", "stop"]):
    a = g[g.k == 0.5].iloc[0]; b = g[g.k == 1.0].iloc[0]
    ok = a.mean_pct_test > 0 and a.test_ci_lo > 0 and b.mean_pct_test > 0
    print(f"{v} w={w} stop={stop}: k.5 test {a.mean_pct_test:.3f}% CI[{a.test_ci_lo:.3f},{a.test_ci_hi:.3f}]  k1 test {b.mean_pct_test:.3f}%  -> {'PASS' if ok else 'fail'}")

print("\n== per symbol, k=0.5 stop=0.08, all dates: total USD ==")
sub = t[(t.k == 0.5) & (t.stop == 0.08)]
print(sub.pivot_table(index="sym", columns=["variant", "w"], values="pnl", aggfunc=["count", "sum"]).round(0).to_string())

print("\n== paired effect: stock alone vs stock+spread, per trade-week (k=0.5, stop 8%) ==")
for (v, w), g in sub.groupby(["variant", "w"]):
    both = g.stock_pnl + g.pnl
    up = g.stock_pnl > 0
    print(f"{v} w={w}: stock mean {g.stock_pnl.mean():7.2f}  stock+spread {both.mean():7.2f}  "
          f"spread on up weeks {g.pnl[up].mean():7.2f}  on down weeks {g.pnl[~up].mean():7.2f}  "
          f"stdev stock {g.stock_pnl.std():.1f} vs combined {both.std():.1f}")

# ---------------- every week vs only a few times
print("\n== every week vs a few times (k=0.5, stop 8%) ==")
rng = np.random.default_rng(1)
out = []
for (v, w), g in sub.groupby(["variant", "w"]):
    for sym, gs in g.groupby("sym"):
        p = gs.sort_values("entry").pnl.values
        if len(p) < 13:
            continue
        r = dict(variant=v, w=w, sym=sym, weeks=len(p), every_total=p.sum(), every_mean=p.mean(), every_loss=(p.sum() < 0))
        for n in (4, 8, 13):
            draws = np.array([rng.choice(p, n, replace=False).sum() for _ in range(10000)])
            r[f"n{n}_mean"] = draws.mean() / n
            r[f"n{n}_p5"], r[f"n{n}_p95"] = np.percentile(draws, [5, 95])
            r[f"n{n}_ploss"] = (draws < 0).mean()
        m = gs.assign(m=gs.entry.dt.to_period("M")).sort_values("entry").groupby("m").head(1)
        r["monthly_n"], r["monthly_total"], r["monthly_mean"] = len(m), m.pnl.sum(), m.pnl.mean()
        out.append(r)
few = pd.DataFrame(out)
few.to_csv(os.path.join(HERE, f"few_vs_every{SUF}.csv"), index=False)
for (v, w), g in few.groupby(["variant", "w"]):
    print(f"\n-- {v} w={w} --")
    print(g[["sym", "weeks", "every_total", "every_mean", "n4_ploss", "n8_ploss", "n13_ploss", "n4_p5", "n4_p95",
             "monthly_n", "monthly_total", "monthly_mean"]].to_string(index=False))
    print(f"names losing selling every week: {int(g.every_loss.sum())}/{len(g)};  "
          f"avg P(loss) if only 4 random weeks: {g.n4_ploss.mean():.2f}, 8: {g.n8_ploss.mean():.2f}, 13: {g.n13_ploss.mean():.2f};  "
          f"monthly-schedule mean/trade {g.monthly_mean.mean():.2f} vs every-week {g.every_mean.mean():.2f}")
