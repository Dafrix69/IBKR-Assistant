"""P-0003: equal-risk sizing of the baseline-A 0DTE put fly (contracts = c / filled debit).

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0003_equal_risk.py

Training period only (date < 2024-11-01): the time wall is the first statement after every read.
Costs: k = 0.20 interpolated from the panel's k = 0 / 0.25 columns, plus the IBKR USD 1.00 per-leg
minimum for the two qty-1 legs (same conversion as P-0001). Filled debit D_t (USD, max loss of one
fly held to settlement) = cost*100 + 0.20*H*100 + fee + 0.70, with 0.25*H*100 = pnl_k0 - pnl and
fee = (payoff - cost)*100 - pnl_k0 (entry-known quantities recovered from the panel's columns).
"""
import os

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.normpath(os.path.join(HERE, "..", "..", "..", "spx_fly"))
CLEAN = os.path.join(R, "data", "clean")
OUT = os.path.join(HERE, "P-0003_tables")
WALL = pd.Timestamp("2024-11-01")
WIDTHS = [20, 25, 30, 50, 75]
K = 0.20
TOPUP = 2 * (1.00 - 0.65)
B_N, SEED = 2000, 20261030


def load():
    p = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
    p = p[p.date < WALL]                                   # TIME WALL: training period only
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    cal = cal[cal.index < WALL]                            # TIME WALL
    p = p[(p.structure == "put_fly") & (p.entry == "14:00") & p.width.isin(WIDTHS)]
    p = p.merge(cal[["half_day", "spx_ret_prev"]], left_on="date", right_index=True)
    p = p[~p.half_day & ~(p.spx_ret_prev <= -0.01)].copy()
    p["d2"] = (p.w_over_implied - 2).abs()
    b = p.sort_values(["date", "d2"]).groupby("date").head(1).set_index("date").sort_index()
    H100 = (b.pnl_k0 - b.pnl) / 0.25                       # half-spread sum * 100
    fee = (b.payoff - b.cost) * 100 - b.pnl_k0
    b["pnl20"] = b.pnl_k0 - K * H100 - TOPUP
    b["pnl50"] = b.pnl_k0 - 0.5 * H100 - TOPUP
    b["D"] = b.cost * 100 + K * H100 + fee + TOPUP
    return b


def maxdd(x):
    c = np.cumsum(x)
    return float(np.max(np.maximum.accumulate(np.concatenate([[0.0], c]))[1:] - c))


def sharpe(x):
    return float(np.mean(x) / np.std(x, ddof=1))


def compare(base, rule, scale):
    """base/rule: aligned daily pnl arrays; scale: equal-risk factor applied to rule for USD stats."""
    r = rule * scale
    out = dict(n=len(base), sh_base=sharpe(base), sh_rule=sharpe(rule),
               ev_base=base.mean(), ev_rule=r.mean(), dd_base=maxdd(base), dd_rule=maxdd(r))
    out["sh_ratio"] = out["sh_rule"] / out["sh_base"]
    out["sh_diff"] = out["sh_rule"] - out["sh_base"]
    out["ev_diff"] = out["ev_rule"] - out["ev_base"]
    out["dd_change"] = out["dd_rule"] / out["dd_base"] - 1
    out["calmar_base"] = base.sum() / out["dd_base"]
    out["calmar_rule"] = r.sum() / out["dd_rule"]
    rng = np.random.default_rng(SEED)
    n = len(base)
    sd, ed = [], []
    for _ in range(B_N):
        i = rng.integers(0, n, n)
        sd.append(sharpe(rule[i]) - sharpe(base[i]))
        ed.append(r[i].mean() - base[i].mean())
    out["sh_diff_lo"], out["sh_diff_hi"] = np.percentile(sd, [2.5, 97.5])
    out["ev_diff_lo"], out["ev_diff_hi"] = np.percentile(ed, [2.5, 97.5])
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    b = load()
    c = float(b.D.mean())
    b["x"] = c / b.D
    print(f"baseline days {len(b)}  win {np.mean(b.pnl20 > 0):.3f}  ev {b.pnl20.mean():+.1f}  c = {c:.1f}")

    # ---- gates (baseline series only)
    terc = pd.qcut(b.D, 3, labels=["low", "mid", "high"])
    g = b.groupby(terc, observed=True).agg(n=("D", "size"), D=("D", "mean"), sd=("pnl20", "std"),
                                           ev=("pnl20", "mean"), win=("pnl20", lambda s: (s > 0).mean()))
    g["ev_per_D"] = b.groupby(terc, observed=True).apply(lambda q: (q.pnl20 / q.D).mean())
    rho, pval = spearmanr(b.pnl20 / b.D, b.D)
    G1 = g.loc["high", "sd"] / g.loc["low", "sd"]
    print(g.round(3)); print(f"G1 sd high/low = {G1:.2f}   G2 spearman(pnl/D, D) = {rho:+.3f} (p {pval:.3f})")
    g.to_csv(os.path.join(OUT, "gates_terciles.csv"))
    yrs = []
    for y, q in b.groupby(b.index.year):
        t = pd.qcut(q.D, 3, labels=["low", "mid", "high"], duplicates="drop")
        sdv = q.groupby(t, observed=True).pnl20.std()
        yrs.append(dict(year=y, n=len(q), G1=sdv.get("high", np.nan) / sdv.get("low", np.nan),
                        G2=spearmanr(q.pnl20 / q.D, q.D)[0], cv_D=q.D.std() / q.D.mean()))
    gy = pd.DataFrame(yrs); print(gy.round(3)); gy.to_csv(os.path.join(OUT, "gates_by_year.csv"), index=False)
    pd.DataFrame([dict(G1=G1, G2=rho, G2_p=pval, c=c, cv_D=b.D.std() / b.D.mean())]).to_csv(
        os.path.join(OUT, "gates.csv"), index=False)

    # ---- V1 continuous, k 0.20 and k 0.5
    rows = []
    for name, col in [("V1_k020", "pnl20"), ("V1_k050", "pnl50")]:
        base = b[col].values
        rule = (b.x * b[col]).values
        rows.append(dict(variant=name, period="all", **compare(base, rule, b.D.mean() / c)))
        for y, q in b.groupby(b.index.year):
            rows.append(dict(variant=name, period=str(y),
                             **compare(q[col].values, (q.x * q[col]).values, q.D.mean() / c)))
    # ---- V2 integer: 2 lots baseline vs n = clip(round(2c/D), 0|1, 2)
    p2 = 2 * (b.pnl20 + TOPUP)                             # 2 lots: every leg >= 2 contracts, no minimum top-up
    for name, lo in [("V2_clip0", 0), ("V2_clip1", 1)]:
        n = np.clip(np.round(2 * c / b.D), lo, 2)
        rule = np.where(n == 2, p2, np.where(n == 1, b.pnl20, 0.0))
        scale = (2 * b.D).mean() / (n * b.D).mean()        # equal average debit at risk
        rows.append(dict(variant=name, period="all", lots0=int((n == 0).sum()), lots1=int((n == 1).sum()),
                         lots2=int((n == 2).sum()), **compare(p2.values, rule, scale)))
    res = pd.DataFrame(rows)
    pd.set_option("display.width", 250)
    cols = ["variant", "period", "n", "sh_base", "sh_rule", "sh_ratio", "sh_diff", "sh_diff_lo", "sh_diff_hi",
            "ev_base", "ev_rule", "ev_diff", "ev_diff_lo", "ev_diff_hi", "dd_base", "dd_rule", "dd_change",
            "calmar_base", "calmar_rule"]
    extra = [c_ for c_ in ["lots0", "lots1", "lots2"] if c_ in res]
    print(res[cols + extra].round(3).to_string())
    res.to_csv(os.path.join(OUT, "results.csv"), index=False)
    b[["width", "implied", "cost", "D", "x", "pnl20", "pnl50"]].to_csv(os.path.join(OUT, "days.csv"))


if __name__ == "__main__":
    main()
