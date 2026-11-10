"""Return side: when a rule gives a direction on ONE name, is the P&L better on that name or on
the equal-weight basket of its module's hot names (same direction)?

The user gave no rule, so three textbook rules are fixed here before any result is seen. They are
stand-ins for "having a view on one stock", not strategies being proposed. Each rule is reported
in one sign only; the opposite rule is the same numbers with the sign flipped.

  G  gap (intraday, open -> close of day D). Hot set H (top K by dv20, eligibility as in
     backtest.py) formed at the close of D-1. Name i in H opens >= +3 % above the prior close ->
     LONG i at the open (gap-follow); opens <= -3 % -> SHORT. Basket = all K names of H, same
     direction, open -> close.
  M  momentum (close D -> close D+5, non-overlapping). Within H (K=5) the name with the highest
     20-day return -> LONG, the lowest -> SHORT.
  R  1-day move (close D -> close D+1). Name i in H closed >= +5 % on day D -> LONG next day
     (continuation); <= -5 % -> SHORT.

Per trade: A = dir * r_i, B = dir * mean(r_H) (i included), S = dir * mean(r_H without i),
X = A - S (the stock-specific part). Inference: P&L averaged per date first, then t = mean /
(sd / sqrt(n_dates)) over dates (dates are the clusters). No costs.

    ../spx_fly/.venv/bin/python returns.py > result_returns.txt
"""
import os

import numpy as np
import pandas as pd

import backtest as b

K = 5
TECH = ("Semiconductors", "Software", "Computers", "Internet", "Telecommunications")


def load_open():
    cat = None
    px, ret, dv20, elig, cat, _ = b.load()
    frames = []
    for s in px.columns:
        d = pd.read_csv(os.path.join(b.U, "eod", s + ".csv"), usecols=["created", "open", "close"])
        d = d[(d.open > 0) & (d.close > 0)]
        d["date"] = pd.to_datetime(d.created.str[:10])
        frames.append(d.drop_duplicates("date").set_index("date").open.rename(s))
    op = pd.concat(frames, axis=1).reindex(px.index)
    return px, op, ret, dv20, elig, cat


def hot_sets(dv20, elig, groups, t_idx, dates):
    """{(date, module): Index of K names} formed with information up to that date's close"""
    out = {}
    for t in t_idx:
        D = dates[t]
        for g, syms in groups.items():
            ok = [s for s in syms if elig.at[D, s]]
            if len(ok) >= K:
                out[(t, g)] = dv20.loc[D, ok].nlargest(K).index
    return out


def trades_gap(px, op, ret, dv20, elig, groups):
    dates = px.index
    gap = (op / px.shift(1) - 1).where(ret.notna())  # ret is NaN on split-like days
    oc = px / op - 1
    rows = []
    H = hot_sets(dv20, elig, groups, range(b.MIN_HIST, len(dates) - 1), dates)
    for (t, g), names in H.items():
        D = dates[t + 1]
        r, gp = oc.loc[D, names].values, gap.loc[D, names].values
        if np.isnan(r).any() or np.isnan(gp).any():
            continue
        for j, s in enumerate(names):
            d = 1 if gp[j] >= 0.03 else -1 if gp[j] <= -0.03 else 0
            if d:
                rows.append((D, g, s, d, d * r[j], d * r.mean(), d * (r.sum() - r[j]) / (K - 1)))
    return pd.DataFrame(rows, columns=["date", "module", "sym", "dir", "A", "B", "S"])


def trades_mom(px, ret, dv20, elig, groups, h=5, look=20):
    dates = px.index
    logr = np.log1p(ret)
    past = px / px.shift(look) - 1
    rows = []
    idx = range(b.MIN_HIST, len(dates) - h, h)
    H = hot_sets(dv20, elig, groups, idx, dates)
    for (t, g), names in H.items():
        D = dates[t]
        r = np.expm1(logr.iloc[t + 1:t + 1 + h][names].sum(skipna=False)).values
        p = past.loc[D, names].values
        if np.isnan(r).any() or np.isnan(p).any():
            continue
        for j, d in ((int(np.argmax(p)), 1), (int(np.argmin(p)), -1)):
            rows.append((D, g, names[j], d, d * r[j], d * r.mean(), d * (r.sum() - r[j]) / (K - 1)))
    return pd.DataFrame(rows, columns=["date", "module", "sym", "dir", "A", "B", "S"])


def trades_move(px, ret, dv20, elig, groups, thr=0.05):
    dates = px.index
    rows = []
    H = hot_sets(dv20, elig, groups, range(b.MIN_HIST, len(dates) - 1), dates)
    for (t, g), names in H.items():
        D = dates[t]
        today, r = ret.loc[D, names].values, ret.iloc[t + 1][names].values
        if np.isnan(r).any() or np.isnan(today).any():
            continue
        for j, s in enumerate(names):
            d = 1 if today[j] >= thr else -1 if today[j] <= -thr else 0
            if d:
                rows.append((D, g, s, d, d * r[j], d * r.mean(), d * (r.sum() - r[j]) / (K - 1)))
    return pd.DataFrame(rows, columns=["date", "module", "sym", "dir", "A", "B", "S"])


def line(lab, x_by_date):
    m, sd, n = x_by_date.mean(), x_by_date.std(), len(x_by_date)
    t = m / (sd / np.sqrt(n)) if sd > 0 else np.nan
    return f"    {lab:34s} mean {m*100:+.3f}%  t {t:+.2f}  per-date sd {sd*100:.2f}%  mean/sd {m/sd:+.3f}"


def show(title, w):
    print(f"\n--- {title}")
    if len(w) < 30:
        print(f"    too few trades ({len(w)})")
        return
    w = w.assign(X=w.A - w.S, AB=w.A - w.B)
    for lab, sub in (("both sides", w), ("LONG signals", w[w.dir == 1]), ("SHORT signals", w[w.dir == -1])):
        d = sub.groupby("date")[["A", "B", "S", "X", "AB"]].mean()
        print(f"  {lab}: trades {len(sub)}, dates {len(d)}, names {sub.sym.nunique()},"
              f" win rate A {(sub.A > 0).mean()*100:.1f}%  B {(sub.B > 0).mean()*100:.1f}%,"
              f" per-trade sd A {sub.A.std()*100:.2f}%  B {sub.B.std()*100:.2f}%")
        print(line("A  single name", d.A))
        print(line("B  basket of the K hot names", d.B))
        print(line("S  module without the name", d.S))
        print(line("X  = A - S  stock-specific part", d.X))
        print(line("A - B  (paired)", d.AB))
    half = w.date.sort_values().iloc[len(w) // 2]
    for lab, sub in (("first half", w[w.date < half]), ("second half", w[w.date >= half])):
        d = sub.groupby("date")[["A", "B"]].mean()
        print(f"  {lab}: A {d.A.mean()*100:+.3f}%  B {d.B.mean()*100:+.3f}%  (dates {len(d)})")


def main():
    px, op, ret, dv20, elig, cat = load_open()
    groups = {}
    for s, c in cat.items():
        if s in px.columns:
            groups.setdefault(c, []).append(s)
    unis = (("all modules", groups), ("tech modules", {k: v for k, v in groups.items() if k in TECH}),
            ("smallcap 15 (hindsight list)", {"smallcap": [s for s in b.SMALLCAP if s in px.columns]}))
    print(f"K={K}; days {len(px)} {px.index[0].date()}..{px.index[-1].date()}; no costs; sign convention: G follow the gap,"
          f" M long winner/short loser, R follow the move")
    for un, g in unis:
        print(f"\n================ {un} ================")
        show("G  gap >= 3% at the open, hold open -> close", trades_gap(px, op, ret, dv20, elig, g))
        show("M  20-day winner long / loser short within the hot set, hold 5 days", trades_mom(px, ret, dv20, elig, g))
        show("R  |1-day move| >= 5%, hold the next day", trades_move(px, ret, dv20, elig, g))


if __name__ == "__main__":
    main()
