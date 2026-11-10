"""V-0028 / V-0029 ONE-SHOT TEST on A-hist (2020-01-02 <= date <= 2022-04-29). Frozen 2026-11-09 before the first run.

    research/spx_fly/.venv/bin/python src/validator/V-0028_0029_test.py > src/validator/V-0028_tables/test_out.txt

Rules are the frozen specs (P-0028 §2-§4, P-0029 §2-§4) implemented in V-0028_0029_common.py, reproduced exactly on
training (V-0028_0029_train.py: 980/568 and 766/456 days, identical K/w/credit and P&L on every day).
Population = ALL A-hist 0DTE days (no Mon/Wed/Fri filter). Seed 20261110 for every bootstrap call, 10 000 draws,
ISO-week stationary blocks (mean 4 weeks), statistic = day mean.

Pre-declared outputs (nothing else is computed on A-hist):
  S  sample account: 0DTE days, half days (hard-coded 3 + generic session-end < 14:00), no 14:00 rows, no spot,
     no settle, MWF days with greeks_eod but no quote file; greeks_eod consistency; settle vs last underlying print
  H1 skips (half, no prev ret incl. 2020-01-03, prev <= -1 %, no spot, no ATM straddle, no width), width distribution,
     width fallbacks, I > 37.5 and w/I < 1.5 counts
  for H1 iron (primary), H1 put fly (report), H2 (primary):
     n; win k0.5 & k0.2 + Wilson; mean k0/0.2/0.5/1 each with 95 % and 97.5 % CI and one-sided p
     by year 2020 / 2021 / 2022-01..04 (n, win, k0..k1); COVID 2020-02-20..04-30 (n, k0, k0.5, worst 5) and ex-COVID
     (all, 2020) k0.5; drop best 5; worst day; sd; max drawdown (k0.5 cumulative); weekday + EOM (n, win, k0.2, k0.5)
     effective cost per lot E(k) by year, sum of half-spreads median/mean, ATM straddle half-spread median
  H1 mechanism: |settle - spot|/I mean & median; credit/w vs min(|settle-K|,w)/w; P(|settle-K| < w); iron - put fly diff
  H2: skip rate by year and by I tercile; candidates/day; P(settle>K); credit/15 vs loss/15; settle - spot drift
     (trade days and all 0DTE days, by year); short-leg distance and dist/I
  PASS table (7 rows each), posterior (p k0.5, BF upper, posterior upper at prior 5 %)
"""
import importlib.util
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("vc", os.path.join(HERE, "V-0028_0029_common.py"))
C = importlib.util.module_from_spec(spec)
sys.modules["vc"] = C
spec.loader.exec_module(C)

LO, HI = "20200102", "20220429"
WLO, WHI, TAG = "2020-01-02", "2022-04-29", "test"
if os.environ.get("V_SMOKE"):          # code-path smoke test on an already-seen TRAINING window; never A-hist
    LO, HI, WLO, WHI, TAG = "20220502", "20230428", "2022-05-02", "2023-04-28", "smoke"
KS = (0.0, 0.2, 0.5, 1.0)
SEED = 20261110
PRIOR = 0.05
HALF_DAYS = {pd.Timestamp(x) for x in ("2020-11-27", "2020-12-24", "2021-11-26")}
COVID = (pd.Timestamp("2020-02-20"), pd.Timestamp("2020-04-30"))
TAB = os.path.join(HERE, "V-0028_tables" if not os.environ.get("V_SMOKE") else "V-0028_cache/smoke_tables")
os.makedirs(TAB, exist_ok=True)
pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 40)

if not os.path.exists(os.path.join(C.CACHE, f"{TAG}_days.parquet")):
    C.extract(LO, HI, TAG)
snap = pd.read_parquet(os.path.join(C.CACHE, f"{TAG}_snap.parquet"))
snap = snap[(snap.date >= WLO) & (snap.date <= WHI)]           # FIRST DATA STEP: A-hist window only
days = pd.read_parquet(os.path.join(C.CACHE, f"{TAG}_days.parquet"))
days = days[(days.date >= WLO) & (days.date <= WHI)].set_index("date").sort_index()
cl = pd.read_parquet(os.path.join(C.CACHE, f"{TAG}_closes.parquet"))
cl = cl[(cl.date >= WLO) & (cl.date <= WHI)].set_index("date").sort_index()

# ================================================================= S: sample account
print("=== S sample account")
days["settle"] = cl.close.reindex(days.index)
days["prev_ret"] = (cl.close / cl.close.shift(1) - 1).shift(1).reindex(days.index)
days["half_gen"] = days.last_u_change_ts.str[11:16] < "14:00"
half = HALF_DAYS | set(days.index[days.half_gen.fillna(False)])
print("0DTE days (quote files):", len(days), "| by weekday:", days.index.day_name().str[:3].value_counts().to_dict())
print("half days hard-coded:", sorted(d.date() for d in HALF_DAYS & set(days.index)),
      "| generic (underlying stops < 14:00):", sorted(d.date() for d in days.index[days.half_gen.fillna(False)]))
print("days with no 14:00 0DTE rows:", int((days.n1400 == 0).sum()), "| no 14:00 spot:", int(days.spot.isna().sum()),
      "| no settle:", int(days.settle.isna().sum()))
tdays = cl.index
eom = set(pd.Series(tdays).groupby(pd.Series(tdays).dt.to_period("M")).max())
mwf_no_q = [d for d in tdays if d.day_of_week in (0, 2, 4) and d not in days.index]
print("trading days (greeks_eod):", len(tdays), "| MWF trading days without a 0DTE quote file:", len(mwf_no_q), [d.date() for d in mwf_no_q][:30])
print("greeks_eod files with non-constant underlying_price:", int(((cl.cmax - cl.cmin) > 0.011).sum()))
dl = (days.settle - days.last_u).abs()
print("settle vs last underlying_1m print: median %.2f, 95%% %.2f, max %.2f (%s); days > 5 pts: %s" % (
    dl.median(), dl.quantile(.95), dl.max(), dl.idxmax().date(), [d.date() for d in dl.index[dl > 5]]))
print("14:00 spot distinct values within the row set > 1:", int((days.spot_n_distinct > 1).sum()))

# ================================================================= rules, every day
books = {d: C.make_book(g) for d, g in snap.groupby("date")}
H1, PF, H2, ALLD = [], [], [], []
sk1, sk2 = {}, {}
inc = lambda dct, key: dct.__setitem__(key, dct.get(key, 0) + 1)
for d, r in days.iterrows():
    bk = books.get(d, {})
    K0, I0 = C.atm_I(bk, r.spot) if np.isfinite(r.spot) else (None, None)
    rec = {"date": d, "I": I0, "half": d in half, "drift": r.settle - r.spot}
    if d in half:
        inc(sk1, "half_day"); inc(sk2, "half_day"); rec["h2"] = "half"; ALLD.append(rec); continue
    if not np.isfinite(r.settle):
        inc(sk1, "no_settle"); inc(sk2, "no_settle"); rec["h2"] = "no_settle"; ALLD.append(rec); continue
    # ---- H2
    t2 = C.h2_day(bk, r.spot)
    rec["h2"] = t2["status"]
    rec["ncand"] = t2["ncand"]
    if t2["status"] == "ok":
        H2.append({"date": d, "K": t2["K"], "credit": t2["credit"], "SH": t2["SH"], "fee": t2["fee"], "spot": r.spot,
                   "settle": r.settle, "I": I0, "ncand": t2["ncand"], **{f"k{k}": C.h2_pnl(t2, r.settle, k) for k in KS}})
    else:
        inc(sk2, t2["status"])
    ALLD.append(rec)
    # ---- H1
    if not np.isfinite(r.prev_ret):
        inc(sk1, "no_prev_ret"); continue
    if r.prev_ret <= -0.01:
        inc(sk1, "prev_ret<=-1%"); continue
    t1 = C.h1_day(bk, r.spot)
    if t1["status"] != "ok":
        inc(sk1, t1["status"]); continue
    atmH = bk[(t1["K"], "C")][3] + bk[(t1["K"], "P")][3]
    H1.append({"date": d, "K": t1["K"], "I": t1["I"], "w": t1["w"], "fallback": t1["w_fallback"], "credit": t1["credit"],
               "SH": t1["SH"], "fee": t1["fee"], "spot": r.spot, "settle": r.settle, "atmH": atmH,
               **{f"k{k}": C.h1_pnl(t1, r.settle, k) for k in KS}})
    if t1["pf"] is not None:
        PF.append({"date": d, "SH": t1["pf"]["SH"], "fee": t1["pf"]["fee"], **{f"k{k}": C.pf_pnl(t1, r.settle, k) for k in KS}})
h1 = pd.DataFrame(H1).set_index("date")
pf = pd.DataFrame(PF).set_index("date")
h2 = pd.DataFrame(H2).set_index("date")
alld = pd.DataFrame(ALLD).set_index("date")
h1.to_parquet(os.path.join(C.CACHE, f"{TAG}_h1.parquet")); pf.to_parquet(os.path.join(C.CACHE, f"{TAG}_pf.parquet"))
h2.to_parquet(os.path.join(C.CACHE, f"{TAG}_h2.parquet")); alld.to_parquet(os.path.join(C.CACHE, f"{TAG}_alld.parquet"))


# ================================================================= stats helpers
def ci(t, k, lev):
    b = C.sboot(t.index, t[f"k{k}"].values, SEED)
    a = (1 - lev) / 2 * 100
    return np.percentile(b, a), np.percentile(b, 100 - a), float(np.mean(b <= 0))


def ycut(idx):
    return np.where(idx.year == 2022, "2022-01..04", idx.year.astype(str))


def full_report(t, lab, has_cost=True):
    print(f"\n=== {lab}: n {len(t)}")
    for k in (0.5, 0.2):
        w = int((t[f"k{k}"] > 0).sum())
        lo, hi = C.wilson(w, len(t))
        print(f"win k{k}: {w}/{len(t)} = {w / len(t):.1%} Wilson [{lo:.1%}, {hi:.1%}]")
    res = {}
    for k in KS:
        l95, h95, p = ci(t, k, 0.95)
        l975, h975, _ = ci(t, k, 0.975)
        res[k] = dict(mean=t[f"k{k}"].mean(), l95=l95, h95=h95, l975=l975, h975=h975, p=p)
        print(f"mean k{k}: {t[f'k{k}'].mean():+.1f}  95% [{l95:+.1f}, {h95:+.1f}]  97.5% [{l975:+.1f}, {h975:+.1f}]  one-sided p {p:.4f}")
    x = t["k0.5"]
    print(f"sd k0.5 {x.std():.0f}; worst day {x.min():+.0f} ({x.idxmin().date()}); best day {x.max():+.0f} ({x.idxmax().date()})")
    db5 = x.sort_values().iloc[:-5].mean()
    print(f"drop best 5 (k0.5): {db5:+.1f}; drop worst 1: {x.sort_values().iloc[1:].mean():+.1f}; "
          f"max drawdown k0.5 {C.max_drawdown(x.values):+.0f}, k0.2 {C.max_drawdown(t['k0.2'].values):+.0f}; cumulative k0.5 {x.sum():+.0f}")
    g = t.copy()
    g["y"] = ycut(g.index)
    rows = []
    for y, s in g.groupby("y"):
        rows.append({"cut": y, "n": len(s), "win_k0.5": round((s["k0.5"] > 0).mean(), 3), **{f"k{k}": round(s[f"k{k}"].mean(), 1) for k in KS}})
    cov = (g.index >= COVID[0]) & (g.index <= COVID[1])
    s = g[cov]
    rows.append({"cut": "COVID 02-20..04-30", "n": len(s), "win_k0.5": round((s["k0.5"] > 0).mean(), 3) if len(s) else np.nan,
                 **{f"k{k}": round(s[f"k{k}"].mean(), 1) if len(s) else np.nan for k in KS}})
    ex = g[~cov]
    rows.append({"cut": "ex-COVID all", "n": len(ex), "win_k0.5": round((ex["k0.5"] > 0).mean(), 3), **{f"k{k}": round(ex[f"k{k}"].mean(), 1) for k in KS}})
    e20 = ex[ex.index.year == 2020]
    rows.append({"cut": "ex-COVID 2020", "n": len(e20), "win_k0.5": round((e20["k0.5"] > 0).mean(), 3), **{f"k{k}": round(e20[f"k{k}"].mean(), 1) for k in KS}})
    g["dow"] = g.index.day_name().str[:3]
    for dw in ("Mon", "Tue", "Wed", "Thu", "Fri"):
        s2 = g[g.dow == dw]
        if len(s2):
            rows.append({"cut": dw, "n": len(s2), "win_k0.5": round((s2["k0.5"] > 0).mean(), 3), **{f"k{k}": round(s2[f"k{k}"].mean(), 1) for k in KS}})
    for lab2, m in (("EOM", g.index.isin(eom)), ("not EOM", ~g.index.isin(eom)), ("MWF not EOM", g.dow.isin(["Mon", "Wed", "Fri"]) & ~g.index.isin(eom))):
        s2 = g[m]
        rows.append({"cut": lab2, "n": len(s2), "win_k0.5": round((s2["k0.5"] > 0).mean(), 3), **{f"k{k}": round(s2[f"k{k}"].mean(), 1) for k in KS}})
    B = pd.DataFrame(rows)
    print(B.to_string(index=False))
    if len(s):
        print("COVID worst 5 (k0.5):", [(d.date(), round(v)) for d, v in s["k0.5"].nsmallest(5).items()])
    l95e, h95e, pe = ci(ex, 0.5, 0.95)
    print(f"ex-COVID k0.5 95% [{l95e:+.1f}, {h95e:+.1f}] p {pe:.4f}")
    if has_cost:
        for y, s3 in g.groupby("y"):
            print(f"cost {y}: n {len(s3)} SH median {s3.SH.median():.3f} mean {s3.SH.mean():.3f}; fee {s3.fee.mean():.2f}; "
                  + " ".join(f"E(k{k})={k * s3.SH.mean() * 100 + s3.fee.mean():.1f}" for k in (0.2, 0.5, 1.0)))
        print(f"cost all: SH median {t.SH.median():.3f} mean {t.SH.mean():.3f}; fee {t.fee.mean():.2f}; "
              + " ".join(f"E(k{k})={k * t.SH.mean() * 100 + t.fee.mean():.1f}" for k in (0.2, 0.5, 1.0)))
    B.to_csv(os.path.join(TAB, f"test_by_{lab.split()[0]}_{lab.split()[1]}.csv"), index=False)
    return res, B, db5, ex["k0.5"].mean()


def pass_table(lab, res, B, db5, exmean):
    y = B.set_index("cut")
    rows = [("1 k0.5 mean > 0", res[0.5]["mean"] > 0, f"{res[0.5]['mean']:+.1f}"),
            ("2 95% CI excludes 0", res[0.5]["l95"] > 0, f"[{res[0.5]['l95']:+.1f}, {res[0.5]['h95']:+.1f}]"),
            ("3 97.5% CI excludes 0", res[0.5]["l975"] > 0, f"[{res[0.5]['l975']:+.1f}, {res[0.5]['h975']:+.1f}]"),
            ("4 k1 mean > 0", res[1.0]["mean"] > 0, f"{res[1.0]['mean']:+.1f}"),
            ("5 2020 and 2021 k0.5 > 0", (y["k0.5"].get("2020", np.nan) > 0) and (y["k0.5"].get("2021", np.nan) > 0),
             f"2020 {y['k0.5'].get('2020', np.nan):+.1f}, 2021 {y['k0.5'].get('2021', np.nan):+.1f}"),
            ("6 ex-COVID k0.5 > 0", exmean > 0, f"{exmean:+.1f}"),
            ("7 drop best 5 k0.5 > 0", db5 > 0, f"{db5:+.1f}")]
    print(f"\n=== PASS table {lab}")
    for nm, ok, v in rows:
        print(f"  {nm:<28} {'yes' if ok else 'NO '}  {v}")
    allok = all(r[1] for r in rows)
    p = res[0.5]["p"]
    print(f"  ALL 7: {'PASS' if allok else 'FAIL'} | posterior: p {p:.4f}, BF upper {C.bf_upper(p):.2f}, posterior upper {C.posterior_upper(PRIOR, p):.1%} (prior 5 %)")


# ================================================================= H1
print("\n=== H1 (P-0028) skips:", sk1, "| traded", len(h1))
print("width distribution:", h1.w.value_counts().sort_index().to_dict(), "| width fallbacks (closest width had a missing leg):", int(h1.fallback.sum()),
      [d.date() for d in h1.index[h1.fallback]])
print("I > 37.5: %d days; w/I < 1.5: %d days; I median %.1f, 90%% %.1f, max %.1f; w/I median %.2f" % (
    (h1.I > 37.5).sum(), (h1.w / h1.I < 1.5).sum(), h1.I.median(), h1.I.quantile(.9), h1.I.max(), (h1.w / h1.I).median()))
print("ATM straddle sum of half-spreads (pts) median by year:", h1.groupby(ycut(h1.index)).atmH.median().round(3).to_dict(),
      "| as % of straddle mid:", (h1.atmH / h1.I).groupby(ycut(h1.index)).median().mul(100).round(2).to_dict())
res1, B1, db1, ex1 = full_report(h1, "H1 iron (primary)")
ratio = (h1.settle - h1.spot).abs() / h1.I
print(f"H1 mechanism: mean |settle - spot|/I {ratio.mean():.3f} (median {ratio.median():.3f}); by year {ratio.groupby(ycut(h1.index)).mean().round(3).to_dict()}")
print(f"  mean credit/w {(h1.credit / h1.w).mean():.3f} vs mean min(|settle-K|,w)/w {(np.minimum((h1.settle - h1.K).abs(), h1.w) / h1.w).mean():.3f}; "
      f"P(|settle-K| < w) {((h1.settle - h1.K).abs() < h1.w).mean():.3f}")
print("put fly unavailable at chosen (K,w):", len(h1) - len(pf), "days")
res_pf, B_pf, db_pf, ex_pf = full_report(pf, "H1 putfly (report)")
dd = (h1.loc[pf.index, "k0.5"] - pf["k0.5"])
print(f"iron - put fly, k0.5 daily diff mean {dd.mean():+.1f} (k0 {(h1.loc[pf.index, 'k0.0'] - pf['k0.0']).mean():+.1f}, k1 {(h1.loc[pf.index, 'k1.0'] - pf['k1.0']).mean():+.1f})")

# ================================================================= H2
print("\n=== H2 (P-0029) skips:", sk2, "| traded", len(h2))
nh = alld[~alld.half & (alld.h2 != "no_settle")].copy()
print("candidates per day:", nh.ncand.value_counts().sort_index().to_dict())
nh["skip"] = nh.h2 != "ok"
print("skip rate by year:", nh.groupby(ycut(nh.index)).skip.agg(["sum", "count", "mean"]).round(3).to_dict("index"))
q = nh.I.quantile([1 / 3, 2 / 3]).values
nh["Iterc"] = pd.cut(nh.I, [-np.inf, q[0], q[1], np.inf], labels=["low", "mid", "high"])
print(f"I terciles (A-hist non-half days) cuts {q.round(2)}; skip rate:", nh.groupby("Iterc", observed=True).skip.agg(["sum", "count", "mean"]).round(3).to_dict("index"))
print("I median: skipped %.1f, traded %.1f" % (nh[nh.skip].I.median(), nh[~nh.skip].I.median()))
res2, B2, db2, ex2 = full_report(h2, "H2 bearcall (primary)")
dist = h2.K - h2.spot
print(f"H2 mechanism: mean credit/15 {(h2.credit / 15).mean():.3f} vs mean loss/15 {(np.clip(h2.settle - h2.K, 0, 15) / 15).mean():.3f}; "
      f"P(settle > K) {(h2.settle > h2.K).mean():.3f}")
print(f"  short-leg distance: median {dist.median():.1f}, IQR {dist.quantile(.25):.1f}..{dist.quantile(.75):.1f}; dist/I median {(dist / h2.I).median():.2f}; K < spot {int((dist < 0).sum())} days")
print(f"  drift settle - 14:00 spot: H2 trade days mean {(h2.settle - h2.spot).mean():+.2f} by year {(h2.settle - h2.spot).groupby(ycut(h2.index)).mean().round(2).to_dict()}")
print(f"  drift all non-half 0DTE days mean {nh.drift.mean():+.2f} by year {nh.drift.groupby(ycut(nh.index)).mean().round(2).to_dict()}")
print(f"  drift / I on H2 trade days mean {((h2.settle - h2.spot) / h2.I).mean():+.3f}")

pass_table("H1 iron (P-0028)", res1, B1, db1, ex1)
pass_table("H2 bear call (P-0029)", res2, B2, db2, ex2)
print("\nseed", SEED, "| fees: 2026 IBKR/Cboe schedule applied to 2020-22")
