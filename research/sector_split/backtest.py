"""Single name vs. equal-weight basket of the "hot" names of the same module (IBKR category).

Question: if I want to be long or short one stock, is the result better when the position is
split across the hot stocks of its module?

Data (offline): ../small_cap_orb/universe/eod/<SYM>.csv (ThetaData daily bars, UNADJUSTED,
2024-10-01..2026-10-30, delisted names included), universe/industry.csv (IBKR category, 1276
names that were classified in the small-cap study), universe/types.csv (COMMON only).

Method, fixed before looking at results:
  * daily close-to-close returns; a day whose open/prev_close is within 2 % of n or 1/n
    (n = 2..50) is treated as a split and that return is dropped (window dropped with it).
  * formation day D (information up to the close of D): within each category rank names by
    dv20 = mean(close*volume) over the 20 days ending D; eligible = close >= $5, dv20 >= $30M,
    >= 30 days of history. Hot set H = top K. Categories with fewer than K eligible are skipped.
  * hold D close -> D+h close, non-overlapping windows, h in {1, 5, 20}; K in {3, 5}.
  * A = return of one name i in H (every i is a target once: no selection skill assumed).
    B = equal-weight mean of the K names of H (i included).
    S = mean of the other K-1 names ("the module without i").
  * By construction mean(A) == mean(B); what the data can tell is risk, tails, and how often a
    single name goes against its module.
  * 95 % CI: bootstrap over formation dates (2000 resamples), clusters = dates.
  * second universe "smallcap": the 15 names of the small-cap study as one module (chosen with
    hindsight on gap days: descriptive only).

    ../spx_fly/.venv/bin/python backtest.py > result.txt
"""
import glob
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
U = os.path.join(ROOT, "..", "small_cap_orb", "universe")
MIN_PX, MIN_DV, MIN_HIST = 5.0, 30e6, 30
SMALLCAP = ["IREN", "AXTI", "LITE", "OKLO", "RKLB", "CRDO", "NBIS", "QUBT", "NVTS", "APLD", "CLSK",
            "SNDK", "WOLF", "ALAB", "QBTS"]
RNG = np.random.default_rng(20261110)


def load():
    ind = pd.read_csv(os.path.join(U, "industry.csv"))
    types = pd.read_csv(os.path.join(U, "types.csv"))
    common = set(types[types.type == "COMMON"].symbol)
    ind = ind[ind.symbol.isin(common) & ind.category.notna() & (ind.category != "")]
    cat = dict(zip(ind.symbol, ind.category))
    frames = []
    for s in list(cat) + ["SPY"]:
        f = os.path.join(U, "eod", s + ".csv")
        if not os.path.exists(f):
            continue
        d = pd.read_csv(f, usecols=["created", "open", "close", "volume"])
        d = d[(d.open > 0) & (d.close > 0)]
        d["date"] = pd.to_datetime(d.created.str[:10])
        d["symbol"] = s
        frames.append(d.drop(columns="created").drop_duplicates("date"))
    e = pd.concat(frames, ignore_index=True)
    px = e.pivot(index="date", columns="symbol", values="close").sort_index()
    op = e.pivot(index="date", columns="symbol", values="open").sort_index()
    vol = e.pivot(index="date", columns="symbol", values="volume").sort_index()
    ret = px / px.shift(1) - 1
    ratio = op / px.shift(1)
    split = pd.DataFrame(False, index=px.index, columns=px.columns)
    for n in range(2, 51):
        split |= ((ratio / n - 1).abs() < 0.02) | ((ratio * n - 1).abs() < 0.02)
    nsplit = int(split.sum().sum())
    ret = ret.mask(split)
    dv20 = (px * vol).rolling(20).mean()
    hist = px.notna().cumsum()
    elig = (px >= MIN_PX) & (dv20 >= MIN_DV) & (hist >= MIN_HIST)
    return px, ret, dv20, elig, cat, nsplit


def windows(ret, dv20, elig, groups, K, h):
    """rows: one per (formation date, module, target i). groups: {module: [symbols]}"""
    dates = ret.index
    logr = np.log1p(ret)
    rows = []
    start = MIN_HIST
    for t in range(start, len(dates) - h, h):
        D = dates[t]
        fwd = logr.iloc[t + 1:t + 1 + h]
        hr = np.expm1(fwd.sum(skipna=False))  # NaN if any day missing (delisted / split)
        for g, syms in groups.items():
            ok = [s for s in syms if elig.at[D, s]]
            if len(ok) < K:
                continue
            H = dv20.loc[D, ok].nlargest(K).index
            r = hr[H].values
            if np.isnan(r).any():
                continue
            b = r.mean()
            for j, s in enumerate(H):
                rows.append((D, g, s, r[j], b, (r.sum() - r[j]) / (K - 1)))
    return pd.DataFrame(rows, columns=["date", "module", "sym", "A", "B", "S"])


def boot(w, fn, n=2000):
    by = {d: x for d, x in w.groupby("date")}
    keys = list(by)
    out = []
    for _ in range(n):
        pick = RNG.choice(len(keys), len(keys))
        out.append(fn(pd.concat([by[keys[i]] for i in pick])))
    return np.percentile(out, [2.5, 97.5])


def vol_ratio(w):
    return w.B.std() / w.A.std()


def pair_corr(ret, w_daily):
    """mean pairwise correlation of daily returns among the K hot names, pooled demeaning by day
    is NOT applied (we want the raw co-movement). From ratio: rho = (ratio^2 - 1/K)/(1 - 1/K)."""
    return None


def report(name, ret, dv20, elig, groups, spy):
    print(f"\n================ universe: {name} ================")
    for K in (3, 5):
        for h in (1, 5, 20):
            w = windows(ret, dv20, elig, groups, K, h)
            if len(w) < 50:
                print(f"K={K} h={h}: too few rows ({len(w)})")
                continue
            vr = vol_ratio(w)
            lo, hi = boot(w, vol_ratio)
            rho = (vr ** 2 - 1 / K) / (1 - 1 / K)
            q = lambda x, p: np.percentile(x, p) * 100
            S_right = w[np.abs(w.S) >= w.S.abs().median()]  # module moved at least its median size
            against = (np.sign(S_right.A) != np.sign(S_right.S)).mean()
            a_lo, a_hi = boot(w, lambda x: (np.sign(x.A[np.abs(x.S) >= x.S.abs().median()])
                                            != np.sign(x.S[np.abs(x.S) >= x.S.abs().median()])).mean(), 1000)
            r2 = np.corrcoef(w.A, w.S)[0, 1] ** 2
            print(f"\nK={K} h={h}d  rows={len(w)} dates={w.date.nunique()} modules={w.module.nunique()}"
                  f" names={w.sym.nunique()}")
            print(f"  mean  A {w.A.mean()*100:+.3f}%  B {w.B.mean()*100:+.3f}%   (equal by construction)")
            print(f"  std   A {w.A.std()*100:.2f}%  B {w.B.std()*100:.2f}%   ratio B/A {vr:.3f} [{lo:.3f}, {hi:.3f}]"
                  f"  implied rho {rho:.2f}   (uncorrelated would give {1/np.sqrt(K):.3f})")
            print(f"  long tail   p5  A {q(w.A,5):+.1f}%  B {q(w.B,5):+.1f}% | p1  A {q(w.A,1):+.1f}%  B {q(w.B,1):+.1f}%"
                  f" | worst A {w.A.min()*100:+.1f}%  B {w.B.min()*100:+.1f}%")
            print(f"  short tail  p95 A {q(w.A,95):+.1f}%  B {q(w.B,95):+.1f}% | p99 A {q(w.A,99):+.1f}%  B {q(w.B,99):+.1f}%"
                  f" | worst A {w.A.max()*100:+.1f}%  B {w.B.max()*100:+.1f}%")
            print(f"  module moved >= median size: single name ended on the other side in {against*100:.1f}%"
                  f" [{a_lo*100:.1f}, {a_hi*100:.1f}] of cases (n={len(S_right)})")
            print(f"  share of single-name variance explained by the rest of the module (R^2): {r2:.2f}")
            if h == 1:
                m = w.merge(spy.rename("spy"), left_on="date", right_index=True)
                # spy return of the HOLDING day (the day after formation)
                cut_lo, cut_hi = m.spy.quantile(0.10), m.spy.quantile(0.90)
                rms = lambda x: np.sqrt((x.B ** 2).mean() / (x.A ** 2).mean())
                for lab, sub in (("SPY worst 10% days", m[m.spy <= cut_lo]), ("SPY middle 80% days", m[(m.spy > cut_lo) & (m.spy < cut_hi)]),
                                 ("SPY best 10% days", m[m.spy >= cut_hi])):
                    v = rms(sub)
                    print(f"  {lab:20s} rms(B)/rms(A) {v:.3f}  implied rho {(v**2-1/K)/(1-1/K):.2f}  (rows {len(sub)})")


def main():
    px, ret, dv20, elig, cat, nsplit = load()
    print(f"days {len(px)} {px.index[0].date()}..{px.index[-1].date()}, classified COMMON names {len(cat)},"
          f" split-like days dropped {nsplit}")
    spy_next = ret["SPY"].shift(-1)  # return of the day after the formation date
    groups = {}
    for s, c in cat.items():
        if s in px.columns:
            groups.setdefault(c, []).append(s)
    report("all modules (IBKR category), hot = top K by 20-day dollar volume", ret, dv20, elig, groups, spy_next)
    tech = {k: v for k, v in groups.items() if k in ("Semiconductors", "Software", "Computers", "Internet", "Telecommunications")}
    report("tech modules only (Semiconductors, Software, Computers, Internet, Telecommunications)", ret, dv20, elig, tech, spy_next)
    report("smallcap: the 15 study names as one module (hindsight list, descriptive)", ret, dv20, elig,
           {"smallcap": [s for s in SMALLCAP if s in px.columns]}, spy_next)


if __name__ == "__main__":
    main()
