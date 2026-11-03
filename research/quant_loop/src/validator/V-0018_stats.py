"""V-0018 stats (train only). research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0018_stats.py"""
import os
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0018_tables")
WALL = pd.Timestamp("2025-11-01")
TR = lambda v: trim_mean(np.asarray(v), 0.10)
rng = np.random.default_rng(20261102)

p = pd.read_parquet(os.path.join(T, "combos.parquet"))
p = p[p.date < WALL]                                                  # time wall
c = pd.read_parquet(os.path.join(T, "cells.parquet"))
c = c[c.date < WALL]                                                  # time wall

p["D"] = (p.trade - ((1 - p.u) * p.ch0 + p.u * p.ch1)) * 100
p["D_own"] = (p.trade - p.own) * 100
p["D_m0"] = (p.trade - p.ch0) * 100
p["D_single"] = p.Dsingle * 100
p["own_ci"] = (p.own - ((1 - p.u) * p.ch0 + p.u * p.ch1)) * 100
mn = p[p.ch0.notna() & p.ch1.notna()]


def boot(v, B=10000):
    v = np.asarray(v); i = rng.integers(0, len(v), (B, len(v)))
    return np.percentile([TR(v[j]) for j in i], [2.5, 97.5])


def line(df, col, name, ci=False):
    dv = df.dropna(subset=[col]).groupby("date")[col].apply(lambda x: TR(x.values))
    s1 = dv[dv.index <= pd.Timestamp("2025-04-30")]; s2 = dv[dv.index >= pd.Timestamp("2025-05-01")]
    cs = "[%+.2f, %+.2f]" % tuple(boot(dv.values)) if ci else ""
    print(f"{name:44s} trim {TR(dv.values):+6.2f} {cs:16s} med {dv.median():+6.2f} seg1 {TR(s1.values):+6.2f} "
          f"seg2 {TR(s2.values):+6.2f} days {len(dv)} prints {df[col].notna().sum()}")


print(f"combos {len(p)}, main (both chain rows) {len(mn)}, days {mn.date.nunique()}")
print("== reproduction ==")
line(mn, "D", "D (chain interp)", ci=True)
line(mn, "D_own", "D_own (own NBBO)", ci=True)
line(mn, "D_m0", "D_m0 (chain m row)")
line(mn, "D_single", "D_single (placebo)", ci=True)
line(mn, "own_ci", "Pi own - chain interp (combo)")
for st in ("iron", "fly_C", "fly_P"):
    line(mn[mn.struct == st], "D", f"D {st}")

print("\n== leg-level diagnostics, USD / contract, day-level 10% trimmed mean of daily cell means ==")


def tab(tag, key, cols):
    d = c[c.tag == tag]
    out = d.groupby(key)[cols].agg(lambda s: TR(s.dropna().values) if s.notna().sum() >= 20 else np.nan)
    n = d.groupby(key).n.mean().rename("n/day") if "n" in d else None
    if n is not None:
        out = out.join(n.round(0))
    return out


order = ["0-5", "6-15", "16-30", "31-50", "51-85"]
pd.set_option("display.width", 200); pd.set_option("display.float_format", lambda v: f"{v:+.2f}")
b = tab("base", ["typ", "r", "bin"], ["oc", "d_prev", "d_next", "prev_c", "next_c", "age"])
print("[1/2] oc = own mid - chain interp; d_prev/d_next = own mid - nearest other-ms row of same contract before/after (<=1 s);")
print("      prev_c/next_c = that neighbour's mid - chain interp at this print's time; age = trade_ts - quote_ts (s)")
print(b.reindex(pd.MultiIndex.from_product([["S", "M"], ["C", "P"], order])).to_string())
print("\n[1b] quote-age quantiles by type (median of daily quantiles)")
print(c[c.tag == "ageq"].groupby("typ")[["0.5", "0.9", "0.99"]].median().to_string())
print("\n[1c] single-leg oc by quote-age bucket")
a = tab("age", ["r", "bin", "aq"], ["oc"]).oc.unstack("aq")
print(a.reindex(pd.MultiIndex.from_product([["C", "P"], order]))[["<10ms", "10-100ms", "0.1-1s", "1-10s", ">10s"]].to_string())
n_aq = c[c.tag == "age"].groupby("aq").n.sum(); print("share of single prints by age bucket:", (n_aq / n_aq.sum()).round(3).to_dict())
print("\n[1d] single-leg oc by condition")
k = c[c.tag == "cond"]; top = k.groupby("cond").n.sum().sort_values(ascending=False)
print("counts", top.head(6).to_dict())
print(tab("cond", ["r", "bin", "cond"], ["oc"]).oc.unstack("cond")[list(top.index[:3])]
      .reindex(pd.MultiIndex.from_product([["C", "P"], order])).to_string())
print("\n[3] rows with t in [m, m+0.5 s): own mid - chain row m (no interp)")
e = tab("early", ["typ", "r", "bin"], ["om0"]).om0.unstack("typ")
print(e.reindex(pd.MultiIndex.from_product([["C", "P"], order]))[["S", "M"]].to_string())
print("\n[4] contract-minutes with both single and combo-leg rows: mean oc(S), mean oc(M), diff")
f = tab("cm", ["r", "bin"], ["S", "M", "diff"])
print(f.reindex(pd.MultiIndex.from_product([["C", "P"], order])).to_string())
print("\n[u] mean within-minute position u of rows")
print(tab("u", ["typ", "r", "bin"], ["u"]).u.unstack("typ").to_string())

# Pi-weighted synthetic placebo built from per-leg cell means (diagnostic): iron ATM body vs 16-30 wings
