"""Summaries for the 2–4 week run. Run: ../spx_fly/.venv/bin/python analyze_multiweek.py > result_mw.txt"""
import os
import numpy as np, pandas as pd
from backtest import block_boot_mean, weekly_series, spots, SYMS

HERE = os.path.dirname(os.path.abspath(__file__))
CUT = pd.Timestamp("2026-03-02")
BLOCK = 8
pd.set_option("display.width", 260, "display.max_columns", 40, "display.float_format", "{:.3f}".format)

t = pd.read_csv(os.path.join(HERE, "trades_mw.csv"), parse_dates=["entry", "exit", "exp"])
t["part"] = np.where(t.entry < CUT, "train", "test")
keys = ["dte_mode", "variant", "w", "k", "stop", "stop_mult", "tp"]
print(f"trades={len(t)}  test starts {CUT.date()}  bootstrap block {BLOCK} weeks\n")

# weeks of data per symbol, split at CUT (denominator for 'per week %')
wk = {}
for s in SYMS:
    d = spots(s).index
    wk[s] = {"all": d.to_period("W").nunique(), "train": d[d < CUT].to_period("W").nunique(), "test": d[d >= CUT].to_period("W").nunique()}


def per_week_pct(g, part):
    """Mean over symbols of (sum of pnl% over trades entered in `part`) / weeks of data in `part`; also #symbols > 0."""
    gp = g if part == "all" else g[g.part == part]
    tot = gp.groupby("sym").pnl_pct.sum().reindex(SYMS, fill_value=0.0)
    pw = pd.Series({s: tot[s] / wk[s][part] for s in SYMS})
    return pw.mean(), int((tot > 0).sum())


rows = []
for key, g in t.groupby(keys, dropna=False):
    r = dict(zip(keys, key))
    for part in ("train", "test", "all"):
        gp = g if part == "all" else g[g.part == part]
        r[f"n_{part}"] = len(gp)
        r[f"mean_pct_{part}"] = gp.pnl_pct.mean()
        r[f"wk_pct_{part}"], r[f"pos_syms_{part}"] = per_week_pct(g, part)
    r["test_ci_lo"], r["test_ci_hi"] = block_boot_mean(weekly_series(g[g.part == "test"]).values, block=BLOCK)
    wins, losses = g.pnl[g.pnl > 0], g.pnl[g.pnl <= 0]
    r["win_rate"] = len(wins) / len(g)
    r["avg_win"], r["avg_loss"] = wins.mean(), losses.mean()
    r["cw_med"] = g.cw.median(); r["delta_med"] = g.delta_s.median(); r["dte_med"] = g.dte.median(); r["held_med"] = g.held.median()
    for reason in ("expiry", "spread_stop", "stock_stop", "take_profit"):
        r[f"x_{reason}"] = (g.reason == reason).mean()
    rows.append(r)
grid = pd.DataFrame(rows)
grid.to_csv(os.path.join(HERE, "grid_mw.csv"), index=False)

show = keys + ["n_all", "mean_pct_train", "mean_pct_test", "test_ci_lo", "test_ci_hi", "wk_pct_test", "pos_syms_test", "wk_pct_all",
               "win_rate", "avg_win", "avg_loss", "cw_med", "delta_med", "dte_med", "held_med",
               "x_expiry", "x_spread_stop", "x_stock_stop", "x_take_profit"]
main = grid[(grid.k == 0.5) & (grid.stop == 0.08)]
for mode in ("mid", "short", "long"):
    print(f"== {mode} expiry (k=0.5, stock stop 8%) ==")
    print(main[main.dte_mode == mode][show].to_string(index=False)); print()

print("== pass bar (k=0.5: test mean>0 & CI excludes 0; k=1 test mean>0), all 288 configs ==")
npass = 0; npos = 0; ntot = 0
for gk, g in grid.groupby(["dte_mode", "variant", "w", "stop", "stop_mult", "tp"], dropna=False):
    a = g[g.k == 0.5].iloc[0]; b = g[g.k == 1.0].iloc[0]
    ok = a.mean_pct_test > 0 and a.test_ci_lo > 0 and b.mean_pct_test > 0
    npass += ok; npos += a.mean_pct_test > 0; ntot += 1
    print(f"{gk}: k.5 test {a.mean_pct_test:+.3f}% CI[{a.test_ci_lo:+.3f},{a.test_ci_hi:+.3f}]  k1 {b.mean_pct_test:+.3f}%  -> {'PASS' if ok else 'fail'}")
print(f"\nPASS {npass}/{ntot};  k=0.5 test mean > 0 in {npos}/{ntot} (k=0 rows not counted)")
print(f"k=0 (mid fills) test mean > 0: {(grid[grid.k == 0].mean_pct_test > 0).sum()}/{(grid.k == 0).sum()}")

# same-week reference on the same per-week unit
print("\n== per-week % (mean over symbols of sum pnl% / weeks of data), k=0.5, stock stop 8%: same-week runs vs 2–4 week ==")
ref = []
for suf, sm, tp in (("", 2.0, 0), ("_tp75", 2.0, 0.75), ("_stop1", 1.0, 0), ("_stop1_tp75", 1.0, 0.75)):
    s = pd.read_csv(os.path.join(HERE, f"trades{suf}.csv"), parse_dates=["entry"])
    s = s[(s.k == 0.5) & (s.stop == 0.08)]
    s["part"] = np.where(s.entry < CUT, "train", "test")
    for (v, w), g in s.groupby(["variant", "w"]):
        ref.append(dict(dte_mode="same_week", variant=v, w=w, stop_mult=sm, tp=tp, wk_pct_test=per_week_pct(g, "test")[0],
                        pos_syms_test=per_week_pct(g, "test")[1], wk_pct_all=per_week_pct(g, "all")[0]))
cmp_ = pd.concat([pd.DataFrame(ref), main[["dte_mode", "variant", "w", "stop_mult", "tp", "wk_pct_test", "pos_syms_test", "wk_pct_all"]]])
print(cmp_.pivot_table(index=["variant", "w", "stop_mult", "tp"], columns="dte_mode", values="wk_pct_test").round(3).to_string())
print("\n(all dates)")
print(cmp_.pivot_table(index=["variant", "w", "stop_mult", "tp"], columns="dte_mode", values="wk_pct_all").round(3).to_string())

print("\n== by calendar year, mid expiry, k=0.5, stop 8%, 2x stop: sum pnl% over symbols ==")
mm = t[(t.dte_mode == "mid") & (t.k == 0.5) & (t.stop == 0.08) & (t.stop_mult == 2.0)]
print(mm.assign(y=mm.entry.dt.year).pivot_table(index=["variant", "w", "tp"], columns="y", values="pnl_pct", aggfunc="sum").round(1).to_string())

print("\n== per symbol, mid expiry, k=0.5, stop 8%, 2x stop: sum pnl% all dates ==")
print(mm.pivot_table(index="sym", columns=["variant", "w", "tp"], values="pnl_pct", aggfunc="sum").round(1).to_string())

print("\n== losers: loss in multiples of credit, mid, k=0.5, stop 8% ==")
for (v, w, sm, tp), g in t[(t.dte_mode == "mid") & (t.k == 0.5) & (t.stop == 0.08)].groupby(["variant", "w", "stop_mult", "tp"]):
    lo = g[g.pnl < 0]; mult = (lo.exit_cost - lo.credit) / lo.credit
    print(f"{v} w={w} stop {sm:g}x tp {tp}: losers {len(lo)}/{len(g)}; loss/credit median {mult.median():.2f}, p90 {mult.quantile(.9):.2f}; "
          f"by reason {lo.reason.value_counts().to_dict()}")

sk = pd.read_csv(os.path.join(HERE, "skips_mw.csv"))
print("\n== skips (mid, k=0.5, stop 8%, 2x, no tp) ==")
print(sk[(sk.dte_mode == "mid") & (sk.k == 0.5) & (sk.stop == 0.08) & (sk.stop_mult == 2.0) & (sk.tp == 0)].to_string(index=False))
