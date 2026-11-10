"""QQQ→SPX second-level lead-lag: T1 cross-correlation, T2 incremental prediction, T3 trading rule.

    ../spx_fly/.venv/bin/python src/analyze.py            # train: T1, T2, grid, pick -> out/selected.json
    ../spx_fly/.venv/bin/python src/analyze.py --test     # test: T1, T2, the selected variant only (run once)

Conventions (SPEC.md): c[i] = mid at the END of second i (bar close). A signal at index i is known at
time i+1; delay d executes at c[i+d]; exit at c[i+d+h].
"""
import argparse
import glob
import itertools
import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = 23400  # seconds 09:30:00 .. 15:59:59 ET
TICK = {"SPY": 0.01, "ES": 0.25}
COMM_BP = {"SPY": 0.13, "ES": 0.12}  # round trip
DELAYS = [0, 1, 2, 3, 5]
WS, THETAS, HS = [1, 2, 5, 10], [3, 4, 6], [5, 10, 30, 60]
RNG = np.random.default_rng(20261110)


def load_stream(name, day):
    path = os.path.join(ROOT, "data", name, day + ".parquet")
    if not os.path.exists(path):
        return None
    df = pd.read_parquet(path)
    ts = df.ts.dt.tz_convert("America/New_York")
    sec = ((ts.dt.hour * 3600 + ts.dt.minute * 60 + ts.dt.second) - 34200).to_numpy()
    ok = (sec >= 0) & (sec < N)
    return sec[ok], df[ok]


def grid(name, day, col="close"):
    r = load_stream(name, day)
    out = np.full(N, np.nan)
    if r is not None:
        out[r[0]] = r[1][col].to_numpy()
    return out


def load_day(day):
    d = {k: grid(f"{k}_MIDPOINT", day) for k in ("QQQ", "NQ", "SPY", "ES")}
    for k in ("SPY", "ES"):
        bid, ask = grid(f"{k}_BID_ASK", day, "open"), grid(f"{k}_BID_ASK", day, "close")
        hs = (ask - bid) / 2
        d[k + "_hs"] = np.where(np.isnan(hs), TICK[k] / 2, np.maximum(hs, TICK[k] / 2))
    d["SPX"] = grid("SPX_TRADES", day)
    return d


def days_all():
    sets = [set(os.path.basename(p)[:8] for p in glob.glob(os.path.join(ROOT, "data", f"{k}_MIDPOINT", "*.parquet")))
            for k in ("QQQ", "NQ", "SPY", "ES")]
    return sorted(set.intersection(*sets))


def lret(c, w):
    out = np.full(len(c), np.nan)
    out[w:] = np.log(c[w:] / c[:-w])
    return out


# ---------- T1 ----------
def t1(data, pairs, K=10):
    rows = []
    for a, b in pairs:
        acc = np.zeros(2 * K + 1)
        nd = 0
        for d in data.values():
            ra, rb = lret(d[a], 1), lret(d[b], 1)
            if np.isnan(d[b]).mean() > 0.5:
                continue
            row = []
            for k in range(-K, K + 1):  # corr(a[t-k], b[t]); k>0 means a leads b
                x = ra[max(0, -k):N - max(0, k)] if k >= 0 else ra[-k:]
                y = rb[k:] if k >= 0 else rb[:N + k]
                x, y = (ra[:N - k], rb[k:]) if k >= 0 else (ra[-k:], rb[:N + k])
                m = ~np.isnan(x) & ~np.isnan(y)
                row.append(np.corrcoef(x[m], y[m])[0, 1])
            acc += np.array(row)
            nd += 1
        acc /= max(nd, 1)
        rows.append({"lead": a, "lag": b, "days": nd, **{f"k{k:+d}": round(acc[k + K], 4) for k in range(-K, K + 1)},
                     "sum_k>0": round(acc[K + 1:].sum(), 4), "sum_k<0": round(acc[:K].sum(), 4)})
    return pd.DataFrame(rows)


# ---------- T2 ----------
def t2(data, src, tgt):
    rows = []
    for w, h, d in itertools.product(WS, HS, DELAYS):
        X, Y, G = [], [], []
        for gi, dd in enumerate(data.values()):
            cs, ct = dd[src], dd[tgt]
            xs, xt = lret(cs, w), lret(ct, w)
            y = np.full(N, np.nan)
            y[:N - d - h] = np.log(ct[d + h:] / ct[d:N - h])
            m = ~np.isnan(xs) & ~np.isnan(xt) & ~np.isnan(y)
            m[:60] = False
            m[N - 60:] = False
            X.append(np.column_stack([xs[m], xt[m]]))
            Y.append(y[m])
            G.append(np.full(m.sum(), gi))
        X, Y, G = np.vstack(X) * 1e4, np.concatenate(Y) * 1e4, np.concatenate(G)
        Xc = np.column_stack([np.ones(len(X)), X])
        XtX_inv = np.linalg.inv(Xc.T @ Xc)
        beta = XtX_inv @ Xc.T @ Y
        e = Y - Xc @ beta
        meat = np.zeros((3, 3))
        for g in np.unique(G):  # cluster by day
            s = Xc[G == g].T @ e[G == g]
            meat += np.outer(s, s)
        se = np.sqrt(np.diag(XtX_inv @ meat @ XtX_inv))
        rows.append({"src": src, "tgt": tgt, "w": w, "h": h, "d": d, "b_src": round(beta[1], 4),
                     "t_src": round(beta[1] / se[1], 2), "b_own": round(beta[2], 4), "t_own": round(beta[2] / se[2], 2)})
    return pd.DataFrame(rows)


# ---------- T3 ----------
def beta_1m(data, src, tgt):
    xs, ys = [], []
    for d in data.values():
        a, b = d[src][59::60], d[tgt][59::60]
        x, y = np.diff(np.log(a)), np.diff(np.log(b))
        m = ~np.isnan(x) & ~np.isnan(y)
        xs.append(x[m]); ys.append(y[m])
    x, y = np.concatenate(xs), np.concatenate(ys)
    return float((x * y).sum() / (x * x).sum())


def trades_day(d, src, tgt, w, theta, h, sig, beta):
    """Per-trade arrays for one day: gross_bp[d], net_bp[d] for d in DELAYS."""
    cs, ct, hs = d[src], d[tgt], d[tgt + "_hs"]
    rs, rt = lret(cs, w), lret(ct, w)
    sd = pd.Series(rs).shift(1).rolling(1800, min_periods=600).std().to_numpy()
    z = rs / sd
    cand = np.abs(z) >= theta
    if sig == "S2":
        sgn = np.sign(rs)
        cand &= (rt * sgn) < 0.5 * beta * np.abs(rs)
    cand[:60] = False
    cand[N - 60 - h - max(DELAYS):] = False
    idx = np.flatnonzero(cand & ~np.isnan(z))
    out, nxt = [], -1
    for i in idx:
        if i < nxt:
            continue
        seg = ct[i:i + max(DELAYS) + h + 1]
        if np.isnan(seg).any():
            continue
        s = np.sign(rs[i])
        row = []
        for dl in DELAYS:
            pin, pout = ct[i + dl], ct[i + dl + h]
            gross = s * np.log(pout / pin) * 1e4
            cost = (hs[i + dl] + hs[i + dl + h]) / pin * 1e4 + COMM_BP[tgt]
            row += [gross, gross - cost]
        out.append(row)
        nxt = i + h + max(DELAYS)
    return np.array(out).reshape(-1, 2 * len(DELAYS))


def run_variant(data, v, beta):
    per_day = [trades_day(d, v["src"], v["tgt"], v["w"], v["theta"], v["h"], v["sig"], beta) for d in data.values()]
    return per_day


def boot(per_day, col, B=5000):
    """Day-block bootstrap of the pooled per-trade mean."""
    sums = np.array([p[:, col].sum() if len(p) else 0.0 for p in per_day])
    ns = np.array([len(p) for p in per_day])
    k = len(per_day)
    pick = RNG.integers(0, k, size=(B, k))
    num, den = sums[pick].sum(1), ns[pick].sum(1)
    m = num[den > 0] / den[den > 0]
    return np.percentile(m, [2.5, 97.5]), float((m <= 0).mean())


def summarize(per_day):
    allt = np.vstack([p for p in per_day if len(p)]) if any(len(p) for p in per_day) else np.zeros((0, 10))
    rows = []
    for j, dl in enumerate(DELAYS):
        if not len(allt):
            break
        (gl, gh), gp = boot(per_day, 2 * j)
        (nl, nh), npv = boot(per_day, 2 * j + 1)
        rows.append({"delay_s": dl, "n": len(allt), "gross_bp": round(allt[:, 2 * j].mean(), 3),
                     "gross_ci": f"[{gl:.3f}, {gh:.3f}]", "gross_p": round(gp, 4),
                     "net_bp": round(allt[:, 2 * j + 1].mean(), 3), "net_ci": f"[{nl:.3f}, {nh:.3f}]",
                     "net_p": round(npv, 4), "win_net": round((allt[:, 2 * j + 1] > 0).mean(), 3)})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    days = days_all()
    half = len(days) // 2
    use = days[half:] if a.test else days[:half]  # time wall
    tag = "test" if a.test else "train"
    print(f"{tag}: {len(use)} days {use[0]} .. {use[-1]} (all {len(days)})")
    data = {d: load_day(d) for d in use}
    out = os.path.join(ROOT, "out")
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40); pd.set_option("display.max_rows", 500)

    c = t1(data, [("QQQ", "SPY"), ("QQQ", "ES"), ("NQ", "ES"), ("NQ", "SPY"), ("ES", "SPY"), ("ES", "SPX"), ("QQQ", "SPX")])
    c.to_csv(os.path.join(out, f"t1_{tag}.csv"), index=False)
    print("\nT1 corr(lead[t-k], lag[t]), k>0 = first column leads")
    print(c[["lead", "lag", "days", "k-3", "k-2", "k-1", "k+0", "k+1", "k+2", "k+3", "sum_k>0", "sum_k<0"]].to_string(index=False))

    r = pd.concat([t2(data, s, t) for s, t in [("QQQ", "SPY"), ("QQQ", "ES"), ("NQ", "ES")]])
    r.to_csv(os.path.join(out, f"t2_{tag}.csv"), index=False)
    print("\nT2 (bp per bp), h=10 rows")
    print(r[(r.h == 10)].to_string(index=False))

    sel_path = os.path.join(out, "selected.json")
    if not a.test:
        betas = {(s, t): beta_1m(data, s, t) for s in ("QQQ", "NQ") for t in ("SPY", "ES")}
        rows = []
        for src, tgt, sig, w, th, h in itertools.product(("QQQ", "NQ"), ("SPY", "ES"), ("S1", "S2"), WS, THETAS, HS):
            v = dict(src=src, tgt=tgt, sig=sig, w=w, theta=th, h=h)
            pdx = run_variant(data, v, betas[(src, tgt)])
            allt = np.vstack([p for p in pdx if len(p)]) if any(len(p) for p in pdx) else np.zeros((0, 10))
            if len(allt):
                rows.append({**v, "n": len(allt), **{f"gross_d{dl}": allt[:, 2 * j].mean() for j, dl in enumerate(DELAYS)},
                             **{f"net_d{dl}": allt[:, 2 * j + 1].mean() for j, dl in enumerate(DELAYS)}})
        g = pd.DataFrame(rows).round(4)
        g.to_csv(os.path.join(out, "grid_train.csv"), index=False)
        ok = g[g.n >= 100].sort_values("net_d1", ascending=False)
        print(f"\nT3 train grid: {len(g)} variants, {len(ok)} with n>=100; net_d1>0: {(ok.net_d1 > 0).sum()}; gross_d1>0: {(ok.gross_d1 > 0).sum()}; gross_d0>0: {(ok.gross_d0 > 0).sum()}")
        print(ok.head(10).to_string(index=False))
        print("\nbest by gross_d1:")
        print(ok.sort_values("gross_d1", ascending=False).head(10).to_string(index=False))
        best = ok.iloc[0]
        sel = dict(src=best.src, tgt=best.tgt, sig=best.sig, w=int(best.w), theta=int(best.theta), h=int(best.h),
                   beta=betas[(best.src, best.tgt)], n_variants=len(g), train_days=use)
        json.dump(sel, open(sel_path, "w"), indent=1)
        print("\nselected:", sel)
        print(summarize(run_variant(data, sel, sel["beta"])).to_string(index=False))
    else:
        sel = json.load(open(sel_path))
        assert not set(sel["train_days"]) & set(use), "time wall"
        print("\nT3 test, selected variant:", {k: sel[k] for k in ("src", "tgt", "sig", "w", "theta", "h")}, "of", sel["n_variants"], "variants")
        s = summarize(run_variant(data, sel, sel["beta"]))
        s.to_csv(os.path.join(out, "t3_test.csv"), index=False)
        print(s.to_string(index=False))
        print("Bonferroni one-sided threshold:", 0.05 / sel["n_variants"])


if __name__ == "__main__":
    main()
