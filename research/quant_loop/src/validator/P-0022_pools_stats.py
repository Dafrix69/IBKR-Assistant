"""V-0022-pools statistics (report list frozen in validations/V-0022-pools.md section 0). Inference exactly as P-0022 §5:
unit = entry ISO week (all trades of that week pooled), stationary block bootstrap (mean block 8 weeks, 10 000 reps),
statistic = sum(pnl of drawn weeks) / number of trades. Week frame = every calendar week between the group's first and last entry week.
Run once: research/spx_fly/.venv/bin/python src/validator/P-0022_pools_stats.py > P-0022_pools_tables/stats_pools.txt
"""
import os
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
TAB = os.path.join(HERE, "P-0022_pools_tables")
POOLS = ["20181031", "20191031", "20201030", "20211029", "20221031", "20231031", "20241031"]
WALL = pd.Timestamp("2025-11-01")
CUT = 0.0948
NB, BLOCK, SEED = 10_000, 8, 22
C = "daily_k0.5"


def wilson(w, n, z=1.96):
    p = w / n; c = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); d = 1 + z * z / n
    return ((p + z * z / (2 * n) - c) / d, (p + z * z / (2 * n) + c) / d)


def sb_index(nw, rng, nb=NB, block=BLOCK):
    idx = np.empty((nb, nw), int)
    idx[:, 0] = rng.integers(nw, size=nb)
    for t in range(1, nw):
        jump = rng.random(nb) < 1.0 / block
        idx[:, t] = np.where(jump, rng.integers(nw, size=nb), (idx[:, t - 1] + 1) % nw)
    return idx


def monday(s):
    return s - pd.to_timedelta(s.dt.day_of_week, unit="D")


class Weeks:
    def __init__(self, all_trades):
        mon = monday(all_trades.entry)
        self.weeks = pd.date_range(mon.min(), mon.max(), freq="7D")
        self.idx = sb_index(len(self.weeks), np.random.default_rng(SEED))

    def agg(self, g, col):
        s = g.groupby(monday(g.entry))[col].agg(["sum", "count"]).reindex(self.weeks, fill_value=0)
        return s["sum"].values.astype(float), s["count"].values.astype(float)

    def stat(self, g, col):
        s, c = self.agg(g, col)
        S, N = s[self.idx].sum(1), c[self.idx].sum(1)
        return np.where(N > 0, S / np.maximum(N, 1), np.nan)

    def ci(self, g, col):
        st = self.stat(g, col)
        return np.nanpercentile(st, [2.5, 97.5, 1.25, 98.75]), np.nanmean(st <= 0)

    def ci_diff(self, a, b, col):
        d = self.stat(a, col) - self.stat(b, col)
        return np.nanpercentile(d, [2.5, 97.5]), np.nanmean(d <= 0)


def fmt_ci(W, g, col, both=True):
    if len(g) == 0:
        return "n 0"
    (a, b, c, d), p = W.ci(g, col)
    s = f"{g[col].mean():+.3f} [{a:+.3f},{b:+.3f}]"
    if both:
        s += f" Bonf[{c:+.3f},{d:+.3f}] P<=0 {p:.3f}"
    return s


def group(name, t, out, summary, permute=False, stock_key="sym"):
    t = t.copy(); t["tgt"] = t.tgt.round(2)
    W = Weeks(t)
    sig = t[t.ret5 > CUT]; ctl = t[t.ret5 <= CUT]
    sw = set(monday(sig.entry)); ctl_same = ctl[monday(ctl.entry).isin(sw)]
    units = t.drop_duplicates(["pool", "sym", "entry"])
    out.append(f"\n==================== {name} ====================")
    out.append(f"trades {len(t)} ({t.entry.min().date()} .. {t.entry.max().date()}, exp max {t.exp.max().date()}); weeks in frame {len(W.weeks)}; "
               f"(stock,week) units {len(units)}, signal units {(units.ret5 > CUT).sum()} ({np.mean(units.ret5 > CUT):.1%}); stocks {t.groupby(['pool', 'sym']).ngroups}")
    out.append(f"SIGNAL n {len(sig)}  k0 {sig.daily_k0.mean():+.3f}  k1 {sig.daily_k1.mean():+.3f} {fmt_ci(W, sig, 'daily_k1', False)}")
    out.append(f"SIGNAL k0.5  {fmt_ci(W, sig, C)}")
    out.append(f"CONTROL same-week n {len(ctl_same)}  k0.5 {fmt_ci(W, ctl_same, C, False)}   | all-week control n {len(ctl)} k0.5 {fmt_ci(W, ctl, C, False)}")
    out.append(f"ALL trades (no signal) n {len(t)}  k0.5 {fmt_ci(W, t, C, False)}  k1 {t.daily_k1.mean():+.3f}")
    (lo, hi), p = W.ci_diff(sig, ctl_same, C)
    diff = sig[C].mean() - ctl_same[C].mean()
    out.append(f"SIGNAL - same-week control k0.5 {diff:+.3f} [{lo:+.3f},{hi:+.3f}] P(diff<=0) {p:.3f}")
    key = ["pool", "sym"] if stock_key == "pool_sym" else ["sym"]
    bys = sig.groupby(key)[C].agg(["count", "mean", "sum"]).sort_values("sum")
    pos = f"{(bys['mean'] > 0).sum()}/{len(bys)}"
    top_sym = sig.groupby("sym")[C].sum().idxmax()
    g_top = sig[sig.sym != top_sym]
    mon = monday(sig.entry); wsum = sig.groupby(mon)[C].sum().sort_values(); best5 = wsum.index[-5:]
    g_b5 = sig[~mon.isin(best5)]
    out.append(f"stocks positive (k0.5, unit {'/'.join(key)}): {pos}")
    out.append(f"drop top contributor {top_sym} (sum {sig[sig.sym == top_sym][C].sum():+.1f}, n {int((sig.sym == top_sym).sum())}): k0.5 {fmt_ci(W, g_top, C, False)}  k1 {g_top.daily_k1.mean():+.3f}")
    out.append(f"drop best 5 weeks ({', '.join(str(x.date()) for x in best5)}; sum {wsum.iloc[-5:].sum():+.1f} of total {sig[C].sum():+.1f}): k0.5 {fmt_ci(W, g_b5, C, False)}")
    # descriptive
    for tg in (-0.25, -0.10):
        g = sig[np.isclose(sig.tgt, tg)]
        out.append(f"  tgt {tg}: n {len(g)} k0 {g.daily_k0.mean():+.3f} k0.5 {fmt_ci(W, g, C, False)} k1 {g.daily_k1.mean():+.3f}")
    w = (sig[C] > 0).sum(); lo_, hi_ = wilson(w, len(sig))
    out.append(f"  k0.5 median {sig[C].median():+.3f}; win {w / len(sig):.1%} [{lo_:.1%},{hi_:.1%}]; commission 1 USD/contract k0.5 {sig['daily_k0.5_comm'].mean():+.3f}; "
               f"unhedged {sig['none_k0.5'].mean():+.3f}; static hedge {sig['static_k0.5'].mean():+.3f}")
    itm = sig.K >= sig.S0
    out.append(f"  (post-hoc, descriptive) strike ITM at entry (K >= S0, stub-quote artifact): {int(itm.sum())} signal trades, sum k0.5 {sig[itm][C].sum():+.1f}; "
               f"without them k0.5 {sig[~itm][C].mean():+.3f}; control without them {ctl_same[ctl_same.K < ctl_same.S0][C].mean():+.3f}")
    out.append(f"  liquidity: half-spread/mid median {np.median(sig.hs / sig.mid):.1%}; k0.5 cost mean {np.mean(0.5 * sig.hs / sig.S0 * 100):.3f}% of spot; "
               f"S0 median {sig.S0.median():.1f}; mid median {sig.mid.median():.2f}; entry contract volume median {sig.vol.median():.0f}; "
               f"bid=0 share median {np.median(sig.n_bid0 / sig.n_chain):.1%}; IV carried {int(sig.n_carry.sum())}; trades with missing hold days {int((sig.n_gap > 0).sum())}")
    if permute:
        rng = np.random.default_rng(SEED)
        u = t.copy(); u["mon"] = monday(u.entry)
        unit = u.groupby(["mon", "pool", "sym"]).agg(s=(C, "sum"), n=(C, "count"), sig=("ret5", lambda x: x.iloc[0] > CUT)).reset_index()
        def dd(lab):
            a = unit[lab]; b = unit[~lab]
            return a.s.sum() / a.n.sum() - b.s.sum() / b.n.sum()
        obs = dd(unit.sig.values); grp = unit.groupby("mon").indices; pw = []
        for _ in range(1000):
            lab = np.zeros(len(unit), bool)
            for ix in grp.values():
                lab[ix] = rng.permutation(unit.sig.values[ix])
            pw.append(dd(lab))
        pw = np.array(pw)
        out.append(f"  within-week permutation (1000, (pool,stock,week) units, signal - all control): observed {obs:+.3f}, null mean {pw.mean():+.3f} sd {pw.std():.3f}, p {np.mean(pw >= obs):.3f}")
    # verdict (P-0022 §5 / V-0022 §0.5)
    (a, b, c, d), p0 = W.ci(sig, C)
    m5, m1 = sig[C].mean(), sig.daily_k1.mean()
    ok1 = m5 > 0 and a > 0 and c > 0; ok2 = m1 > 0; ok3 = ctl_same[C].mean() < m5
    v = "PASS" if (ok1 and ok2 and ok3) else ("FAIL (refuted: k0.5 <= 0)" if m5 <= 0 else "FAIL (not proven)")
    out.append(f"VERDICT {name}: {v}   [row1 k0.5>0 & CIs exclude 0: {ok1}; row2 k1>0: {ok2}; row3 control<signal: {ok3}]")
    summary.append(dict(group=name, n_sig=len(sig), k05=m5, ci95=f"[{a:+.3f},{b:+.3f}]", ci975=f"[{c:+.3f},{d:+.3f}]", P0=p0, k1=m1,
                        ctl=ctl_same[C].mean(), all=t[C].mean(), diff=diff, diff_ci=f"[{lo:+.3f},{hi:+.3f}]", pos=pos,
                        drop_top=g_top[C].mean(), drop_b5=g_b5[C].mean(), verdict=v))


def main():
    T = {p: pd.read_parquet(os.path.join(TAB, f"trades_{p}.parquet")) for p in POOLS}
    out, summary = [], []
    out.append("V-0022-pools stats (P-0022 frozen rule on ex-ante pools); k0.5 cells: mean [95%] Bonf[97.5%] P(boot<=0)")
    for p in POOLS:
        group(f"pool {p}", T[p], out, summary)
    t24 = T["20241031"]
    group("pool 20241031 train segment (entry < 2025-11-01)", t24[t24.entry < WALL], out, summary)
    group("pool 20241031 test segment (entry >= 2025-11-01)", t24[t24.entry >= WALL], out, summary)
    allp = pd.concat(T.values(), ignore_index=True)
    group("POOLED all 7 pools (primary)", allp, out, summary, permute=True, stock_key="pool_sym")
    group("POOLED 6 pre-sample pools 2018-2023", allp[allp.pool != "20241031"], out, summary, permute=True, stock_key="pool_sym")
    s = pd.DataFrame(summary)
    pd.set_option("display.width", 300); pd.set_option("display.max_columns", 30)
    out.append("\n==================== SUMMARY ====================")
    out.append(s.to_string(index=False, float_format=lambda x: f"{x:+.3f}"))
    print("\n".join(out))
    s.to_csv(os.path.join(TAB, "summary_pools.csv"), index=False)


if __name__ == "__main__":
    main()
