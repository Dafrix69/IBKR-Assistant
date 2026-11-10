"""V-0022 statistics for P-0022. Inference exactly as P-0022 §5: unit = entry ISO week (all trades pooled),
stationary block bootstrap (mean block 8 weeks, 10 000 reps), statistic = sum(pnl of drawn weeks) / number of trades.
Run: research/spx_fly/.venv/bin/python src/validator/P-0022_stats.py train|test   (test: ONCE)
     research/spx_fly/.venv/bin/python src/validator/P-0022_stats.py etf
"""
import os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
TAB = os.path.join(HERE, "P-0022_tables")
PERIOD = sys.argv[1] if len(sys.argv) > 1 else "train"
WALL = pd.Timestamp("2025-11-01")
CUT = 0.0948                      # frozen in P-0022 §2, not recomputed
NOTCH = (0.0679, 0.1479)          # +-1 notch = training (stock, week) put-unit ret5 quantiles 0.60 / 0.75 (fixed before the test run)
NB, BLOCK, SEED = 10_000, 8, 22


def wilson(w, n, z=1.96):
    if n == 0:
        return (np.nan, np.nan)
    p = w / n; c = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); d = 1 + z * z / n
    return ((p + z * z / (2 * n) - c) / d, (p + z * z / (2 * n) + c) / d)


def sb_index(nw, rng, nb=NB, block=BLOCK):
    """Stationary (Politis-Romano) bootstrap indices, nb x nw."""
    idx = np.empty((nb, nw), int)
    idx[:, 0] = rng.integers(nw, size=nb)
    for t in range(1, nw):
        jump = rng.random(nb) < 1.0 / block
        idx[:, t] = np.where(jump, rng.integers(nw, size=nb), (idx[:, t - 1] + 1) % nw)
    return idx


class Weeks:
    def __init__(self, all_trades):
        mon = all_trades.entry - pd.to_timedelta(all_trades.entry.dt.day_of_week, unit="D")
        self.weeks = pd.date_range(mon.min(), mon.max(), freq="7D")
        self.idx = sb_index(len(self.weeks), np.random.default_rng(SEED))

    def agg(self, g, col):
        mon = g.entry - pd.to_timedelta(g.entry.dt.day_of_week, unit="D")
        s = g.groupby(mon)[col].agg(["sum", "count"]).reindex(self.weeks, fill_value=0)
        return s["sum"].values.astype(float), s["count"].values.astype(float)

    def ci(self, g, col, q=(2.5, 97.5, 1.25, 98.75)):
        s, c = self.agg(g, col)
        S, C = s[self.idx].sum(1), c[self.idx].sum(1)
        st = np.where(C > 0, S / np.maximum(C, 1), np.nan)
        return np.nanpercentile(st, q), np.mean(st <= 0)

    def ci_diff(self, a, b, col):
        sa, ca = self.agg(a, col); sb, cb = self.agg(b, col)
        A = sa[self.idx].sum(1) / np.maximum(ca[self.idx].sum(1), 1)
        B = sb[self.idx].sum(1) / np.maximum(cb[self.idx].sum(1), 1)
        d = A - B
        return np.percentile(d, [2.5, 97.5]), np.mean(d <= 0)

    def ci_weekmean(self, g, col, nb=5000):
        """Proposer-style (training table only): bootstrap of the series of weekly means (weeks with trades)."""
        x = g.groupby("entry")[col].mean().sort_index().values
        idx = sb_index(len(x), np.random.default_rng(0), nb)
        return np.percentile(x[idx].mean(1), [2.5, 97.5])


def trimmed(x, q=0.02):
    x = np.sort(np.asarray(x, float)); c = int(len(x) * q)
    return x[c: len(x) - c].mean()


def line(W, g, col, label, ci=True, extra=""):
    if len(g) == 0:
        return f"{label:<44s} n    0"
    s = f"{label:<44s} n {len(g):4d} mean {g[col].mean():+.3f}"
    if ci:
        (a, b, c, d), p0 = W.ci(g, col)
        s += f" CI95 [{a:+.3f},{b:+.3f}] CI97.5 [{c:+.3f},{d:+.3f}] P(boot<=0) {p0:.3f}"
    w = (g[col] > 0).sum(); lo, hi = wilson(w, len(g))
    s += f" med {g[col].median():+.3f} trim2 {trimmed(g[col]):+.3f} win {w / len(g):.1%} [{lo:.1%},{hi:.1%}]" + extra
    return s


def report_group(W, g, title, out, full=True):
    out.append(f"\n=== {title} ===")
    for col in ("daily_k0", "daily_k0.5", "daily_k1"):
        out.append(line(W, g, col, col))
    if not full:
        return
    c = "daily_k0.5"
    for tgt in (-0.25, -0.10):
        for col in ("daily_k0", "daily_k0.5", "daily_k1"):
            out.append(line(W, g[np.isclose(g.tgt, tgt)], col, f"  tgt {tgt} {col}"))
    bys = g.groupby("sym")[c].agg(["count", "mean", "sum"]).sort_values("sum")
    out.append(f"  stocks positive (k0.5): {(bys['mean'] > 0).sum()}/{len(bys)}   by stock: " +
               ", ".join(f"{s} {r['mean']:+.2f}(n{int(r['count'])},sum{r['sum']:+.1f})" for s, r in bys.iterrows()))
    top = bys["sum"].idxmax()
    out.append(line(W, g[g.sym != top], c, f"  drop top contributor {top}"))
    for k in ("daily_k0", "daily_k1"):
        out.append(line(W, g[g.sym != top], k, f"  drop {top} {k}", ci=False))
    mon = g.entry - pd.to_timedelta(g.entry.dt.day_of_week, unit="D")
    wsum = g.groupby(mon)[c].sum().sort_values()
    best5 = wsum.index[-5:]
    out.append(line(W, g[~mon.isin(best5)], c, "  drop best 5 weeks", extra=f"  (weeks {', '.join(str(x.date()) for x in best5)})"))
    out.append(line(W, g[~mon.isin(wsum.index[:5])], c, "  drop worst 5 weeks (descriptive)", ci=False))
    qtr = g.entry.dt.to_period("Q")
    for qq, gq in g.groupby(qtr):
        out.append(line(W, gq, c, f"  quarter {qq}", ci=False))
    mid = g.entry.min() + (g.entry.max() - g.entry.min()) / 2
    out.append(line(W, g[g.entry < mid], c, f"  first half (< {mid.date()})", ci=False))
    out.append(line(W, g[g.entry >= mid], c, "  second half", ci=False))
    for col in ("none_k0.5", "static_k0.5"):
        out.append(line(W, g, col, f"  hedge variant {col}"))
    cum = g.sort_values("entry").groupby("entry")[c].sum().cumsum()
    dd = (cum - cum.cummax()).min()
    out.append(f"  cumulative sum k0.5 (sum of per-trade % of spot) {cum.iloc[-1]:+.2f}; max drawdown {dd:+.2f}")
    out.append(f"  liquidity: half-spread/mid median {np.median(g.hs / g.mid):.1%} (p75 {np.percentile(g.hs / g.mid, 75):.1%}); "
               f"k0.5 cost per trade (0.5*hs/S0) mean {np.mean(0.5 * g.hs / g.S0 * 100):.3f}% of spot; mid median ${g.mid.median():.2f}; "
               f"entry-day contract volume median {g.vol.median():.0f}, zero-volume share {np.mean(g.vol == 0):.1%}; "
               f"bid=0 share of that expiry's puts median {np.median(g.n_bid0 / g.n_chain):.1%}; IV carried-forward days {g.n_carry.sum()}/{(g.n_hold - 1).sum()}")


def main():
    t = pd.read_parquet(os.path.join(TAB, f"trades_{PERIOD}.parquet"))
    t["tgt"] = t.tgt.round(2)
    out = [f"V-0022 stats, period={PERIOD}, trades in file {len(t)}, entries {t.entry.min().date()} .. {t.entry.max().date()}, exp max {t.exp.max().date()}"]
    W = Weeks(t)
    out.append(f"weeks in bootstrap frame: {len(W.weeks)} ({W.weeks[0].date()} .. {W.weeks[-1].date()}), block {BLOCK}, reps {NB}")
    if PERIOD == "etf":
        etf(t, out); print("\n".join(out)); return
    v = t.dropna(subset=["ret5"])
    units = v.drop_duplicates(["sym", "entry"])
    out.append(f"(stock, week) units with >=1 trade and ret5: {len(units)}; ret5 > cut: {(units.ret5 > CUT).sum()} ({np.mean(units.ret5 > CUT):.1%})")
    sig = v[v.ret5 > CUT]; ctl = v[v.ret5 <= CUT]
    sig_weeks = set(sig.entry - pd.to_timedelta(sig.entry.dt.day_of_week, unit="D"))
    cmon = ctl.entry - pd.to_timedelta(ctl.entry.dt.day_of_week, unit="D")
    ctl_same = ctl[cmon.isin(sig_weeks)]
    report_group(W, sig, "SIGNAL ret5 > 0.0948 (both deltas pooled)", out)
    report_group(W, ctl_same, "CONTROL row 4 (primary): ret5 <= 0.0948, same ISO weeks as a signal trade", out, full=False)
    report_group(W, ctl, "CONTROL (secondary): ret5 <= 0.0948, all weeks", out, full=False)
    for name, c in (("same-week control", ctl_same), ("all-week control", ctl)):
        for col in ("daily_k0.5", "daily_k0", "daily_k1"):
            (lo, hi), p = W.ci_diff(sig, c, col)
            out.append(f"  signal - {name} {col}: {sig[col].mean() - c[col].mean():+.3f} block-boot CI95 [{lo:+.3f},{hi:+.3f}] P(diff<=0) {p:.3f}")
    # permutation of the signal label within ISO week (1000x), keeps week composition and the number of signal units per week
    rng = np.random.default_rng(SEED)
    u = v.copy(); u["mon"] = u.entry - pd.to_timedelta(u.entry.dt.day_of_week, unit="D")
    unit = u.groupby(["mon", "sym"]).agg(s=("daily_k0.5", "sum"), n=("daily_k0.5", "count"), sig=("ret5", lambda x: x.iloc[0] > CUT)).reset_index()
    def diff(lab):
        a = unit[lab]; b = unit[~lab]
        return a.s.sum() / a.n.sum() - b.s.sum() / b.n.sum()
    obs = diff(unit.sig.values)
    grp = unit.groupby("mon").indices
    perm_w, perm_g = [], []
    for _ in range(1000):
        lab = np.zeros(len(unit), bool)
        for ix in grp.values():
            lab[ix] = rng.permutation(unit.sig.values[ix])
        perm_w.append(diff(lab))
        perm_g.append(diff(rng.permutation(unit.sig.values)))
    out.append(f"  permutation (signal label, (stock,week) units, k0.5): observed diff {obs:+.3f}; within-week p(>=obs) {np.mean(np.array(perm_w) >= obs):.3f}; "
               f"global p(>=obs) {np.mean(np.array(perm_g) >= obs):.3f}")
    out.append("\n=== threshold +-1 notch (descriptive only) ===")
    for cut in NOTCH:
        g = v[v.ret5 > cut]
        out.append(line(W, g, "daily_k0.5", f"ret5 > {cut}"))
    if PERIOD == "train":
        out.append("\n=== proposer-style weekly-mean bootstrap (training table comparison only) ===")
        for col in ("daily_k0", "daily_k0.5", "daily_k1"):
            a, b = W.ci_weekmean(sig, col)
            out.append(f"  {col}: [{a:+.2f},{b:+.2f}]   h1(<2025-05-01) {sig[sig.entry < '2025-05-01'][col].mean():+.3f} h2 {sig[sig.entry >= '2025-05-01'][col].mean():+.3f}")
    print("\n".join(out))


def etf(t, out):
    for per, g0 in (("train (entry < 2025-11-01)", t[t.entry < WALL]), ("test (entry >= 2025-11-01)", t[t.entry >= WALL]), ("all", t)):
        Wp = Weeks(g0)
        out.append(f"\n=== ETF unconditional weekly put, daily hedge, {per}: {g0.entry.min().date()} .. {g0.entry.max().date()} ===")
        for sym in ("SPY", "QQQ", "IWM", "ALL"):
            g1 = g0 if sym == "ALL" else g0[g0.sym == sym]
            for tgt in (-0.25, -0.10, None):
                g = g1 if tgt is None else g1[np.isclose(g1.tgt, tgt)]
                for col in ("daily1bp_k0.5", "daily_k0.5", "daily1bp_k0", "none_k0.5"):
                    out.append(line(Wp, g, col, f"{sym} {'pooled' if tgt is None else tgt} {col}", ci=(col == "daily1bp_k0.5")))


if __name__ == "__main__":
    main()
