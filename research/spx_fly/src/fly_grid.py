"""Step 3: fly grid backtest with mandatory walk-forward.

    .venv/bin/python src/fly_grid.py sim [--workers 6]   # data/clean/fly_trades.parquet
    .venv/bin/python src/fly_grid.py wf                  # reports/step3_tables/*.csv, figures

Trade model
- Center: ATM strike at the entry minute (edge_panel K). Half days excluded.
- Every structure is expressed as a long-fly-equivalent value V. An iron fly is
  V = width - (cost to close the short iron fly), so it has the same payoff and the same
  rule thresholds as a fly; only quotes and fees differ.
- Thresholds use the entry MID, so one exit path is shared by every k. k then only moves
  the fills: entry V + k*H, exit V - k*H, H = sum of leg half spreads.
- TP / SL are checked on mid. A trigger at minute t fills at the first usable quote AFTER t,
  so the signal never trades on the quote that produced it. Scheduled time exits fill at
  that minute. A leg with a flagged quote blocks the check for that minute.
- No later fill available: the position settles at the official close, no exit spread or fee.
"""
import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fills  # noqa: E402

ROOT = os.path.dirname(HERE)
CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml")))
CLEAN = os.path.join(ROOT, CFG["paths"]["clean"])
TABLES = os.path.join(ROOT, CFG["paths"]["reports"], "step3_tables")
FIGS = os.path.join(ROOT, CFG["paths"]["reports"], "figs")
G = CFG["grid"]
F = CFG["fills"]
KS = CFG["fills"]["k_levels"]
N_MIN = 390


def minute_of(hhmm):
    h, m = hhmm.split(":")
    return (int(h) - 9) * 60 + int(m) - 30


def legs_for(structure, K, W):
    """(strike, right, sign, qty) with the value offset. Sign +1 = long."""
    if structure == "put_fly":
        return [(K - W, "P", 1, 1), (K, "P", -1, 2), (K + W, "P", 1, 1)], 0.0
    if structure == "call_fly":
        return [(K - W, "C", 1, 1), (K, "C", -1, 2), (K + W, "C", 1, 1)], 0.0
    if structure == "iron_fly":
        return [(K - W, "P", 1, 1), (K, "P", -1, 1), (K, "C", -1, 1), (K + W, "C", 1, 1)], float(W)
    raise ValueError(structure)


def quote_book(chain):
    """{(strike, right): (bid[390], ask[390])}, NaN where missing or flagged."""
    c = chain[~chain.flag_bad].copy()
    c["m"] = (c.ts.dt.hour - 9) * 60 + c.ts.dt.minute - 30
    book = {}
    for key, g in c.groupby(["strike", "right"]):
        b, a = np.full(N_MIN, np.nan), np.full(N_MIN, np.nan)
        m = g.m.values
        b[m], a[m] = g.bid.values, g.ask.values
        book[key] = (b, a)
    return book


def leg_arrays(book, legs):
    bids, asks = [], []
    for k_, r, _, _ in legs:
        q = book.get((float(k_), r))
        if q is None:
            return None
        bids.append(q[0])
        asks.append(q[1])
    return np.array(bids), np.array(asks)


def first_exit(V, e, tp, sl, t_stop):
    """V: value by minute (NaN = unusable). Returns (fill_minute or None, reason)."""
    end = t_stop if t_stop is not None else N_MIN
    for t in range(e + 1, min(end, N_MIN)):
        v = V[t]
        if np.isnan(v):
            continue
        if (tp is not None and v >= tp) or (sl is not None and v <= sl):
            reason = "tp" if tp is not None and v >= tp else "sl"
            nxt = np.where(~np.isnan(V[t + 1:]))[0]
            return (t + 1 + int(nxt[0]), reason) if len(nxt) else (None, reason + "_settled")
    if t_stop is not None:
        nxt = np.where(~np.isnan(V[t_stop:]))[0]
        return (t_stop + int(nxt[0]), "time") if len(nxt) else (None, "time_settled")
    return None, "settle"


def simulate(book, date, entry, K, width, structure, settle, rules):
    legs, offset = legs_for(structure, K, width)
    arr = leg_arrays(book, legs)
    if arr is None:
        return []
    bids, asks = arr
    signs = np.array([l[2] for l in legs], float)
    qtys = np.array([l[3] for l in legs], float)
    e = minute_of(entry)
    mids = (bids + asks) / 2
    half = (asks - bids) / 2
    V = ((signs * qtys)[:, None] * mids).sum(axis=0) + offset          # NaN if any leg is NaN
    H = (qtys[:, None] * half).sum(axis=0)
    if np.isnan(V[e]) or V[e] <= 0:
        return []
    cost = V[e]
    entry_fee = float((qtys * fills.leg_fee(mids[:, e], F)).sum())
    payoff = fills.fly_settle_value(settle, K, width)
    out = []
    for name, r in rules.items():
        t_stop = minute_of(r["time"]) if "time" in r else None
        if t_stop is not None and t_stop <= e:
            continue
        tp = r["tp"] * cost if "tp" in r else None
        sl = r["sl"] * cost if "sl" in r else None
        x, reason = first_exit(V, e, tp, sl, t_stop)
        path = V[e: (x if x is not None else N_MIN) + (1 if x is not None else 0)]
        rec = {"date": date, "entry": entry, "width": width, "structure": structure, "rule": name, "K": K,
               "cost": cost, "reason": reason, "exit_min": x if x is not None else N_MIN,
               "minutes": (x if x is not None else N_MIN) - e,
               "max_up": np.nanmax(path) - cost, "max_dn": np.nanmin(path) - cost}
        exit_fee = float((qtys * fills.leg_fee(mids[:, x], F)).sum()) if x is not None else 0.0
        rec["exit_value"] = V[x] if x is not None else payoff
        for k in KS:
            xv = V[x] - k * H[x] if x is not None else payoff
            rec[f"pnl_k{k}"] = (xv - (cost + k * H[e])) * F["multiplier"] - entry_fee - exit_fee
        out.append(rec)
    return out


def sim_day(args):
    path, rows, settle = args
    date = rows[0][0]
    book = quote_book(pd.read_parquet(path, columns=["strike", "right", "ts", "bid", "ask", "flag_bad"]))
    out = []
    for _, entry, K in rows:
        for w in G["widths"]:
            for s in G["structures"]:
                out += simulate(book, date, entry, K, w, s, settle, G["rules"])
    return out


def run_sim(workers):
    panel = pd.read_parquet(os.path.join(CLEAN, "edge_panel.parquet"))
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    full = cal.index[~cal.half_day]
    jobs = []
    for d, g in panel[panel.date.isin(full)].groupby("date"):
        rows = [(d, e, float(k)) for e, k in zip(g.entry, g.K)]
        jobs.append((os.path.join(CLEAN, f"chain_{d.strftime('%Y%m%d')}.parquet"), rows, float(cal.loc[d, "settle"])))
    with ProcessPoolExecutor(workers) as ex:
        recs = [r for day in ex.map(sim_day, jobs, chunksize=8) for r in day]
    t = pd.DataFrame(recs)
    t.to_parquet(os.path.join(CLEAN, "fly_trades.parquet"), index=False, compression="zstd")
    print(len(t), "trades,", t.date.nunique(), "days")


# ---------------------------------------------------------------- walk-forward

PARAM = ["entry", "width", "structure", "rule"]
PK = lambda k: f"pnl_k{k}"  # noqa: E731


def windows(first, last, wf):
    """Yields (train_start, valid_start, valid_end); valid windows never overlap."""
    t = pd.Timestamp(first.year, first.month, 1)
    while True:
        vs = t + pd.DateOffset(months=wf["train_months"])
        ve = vs + pd.DateOffset(months=wf["valid_months"])
        if vs > last:
            return
        yield t, vs, ve
        t = t + pd.DateOffset(months=wf["step_months"])


def select(train, wf, metric="usd"):
    """Best parameters on the training window. None when nothing clears the floor."""
    g = train.groupby(PARAM)
    ev = g[PK(wf["rank_k"])].mean()
    floor = g[PK(wf["floor_k"])].mean()
    if metric == "per_risk":
        ev = ev / (g.cost.mean() * F["multiplier"])
    ok = ev[floor > 0]
    return (ok.idxmax() if len(ok) else None), (float(ok.max()) if len(ok) else np.nan)


def walk_forward(t, wf, metric="usd"):
    picks, oos = [], []
    for ts, vs, ve in windows(t.date.min(), t.date.max(), wf):
        train = t[(t.date >= ts) & (t.date < vs)]
        valid = t[(t.date >= vs) & (t.date < ve)]
        best, ev = select(train, wf, metric)
        picks.append({"train_start": ts.date(), "valid_start": vs.date(), "valid_end": ve.date(),
                      "picked": "none" if best is None else " ".join(map(str, best)), "train_ev": ev,
                      "valid_days": valid.date.nunique()})
        if best is not None:
            m = valid
            for col, val in zip(PARAM, best):
                m = m[m[col] == val]
            oos.append(m.assign(window=vs.date()))
    return pd.DataFrame(picks), (pd.concat(oos) if oos else t.iloc[0:0])


def curve_stats(s, k_list=KS):
    """One row per k from a one-trade-per-day series."""
    rows = []
    for k in k_list:
        p = s[PK(k)].values
        eq = np.cumsum(p)
        dd = (eq - np.maximum.accumulate(eq)).min() if len(p) else 0.0
        wins, losses = p[p > 0], p[p < 0]
        rng = np.random.default_rng(CFG["edge"]["seed"])
        boot = p[rng.integers(0, len(p), (2000, len(p)))].mean(1) if len(p) else np.array([np.nan])
        rows.append({"k": k, "trades": len(p), "ev_usd": p.mean() if len(p) else np.nan, "ci_lo": np.quantile(boot, .025),
                     "ci_hi": np.quantile(boot, .975), "total_usd": p.sum(), "win_rate": (p > 0).mean() if len(p) else np.nan,
                     "payoff_ratio": wins.mean() / -losses.mean() if len(wins) and len(losses) else np.nan,
                     "max_dd_usd": dd})
    return pd.DataFrame(rows)


def regime_labels():
    """Everything known before the trade. VIX level is judged against the prior 252 days only."""
    cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
    lab = pd.read_parquet(os.path.join(CLEAN, "edge_labels.parquet"))[["date", "entry", "gamma_side", "event"]]
    v = cal.vix_prev_close
    pct = v.rolling(252, min_periods=60).apply(lambda x: (x[:-1] < x[-1]).mean(), raw=True)
    t = pd.cut(pct, [-.01, 1 / 3, 2 / 3, 1.01], labels=["low", "mid", "high"])
    big = CFG["edge"]["prev_ret_big"]
    day = pd.DataFrame({"vix_t": t.astype(object),
                        "prev_ret": np.select([cal.spx_ret_prev >= big, cal.spx_ret_prev <= -big], ["big up", "big down"], "flat"),
                        "weekday": cal.index.day_name().str[:3], "year": cal.index.year}, index=cal.index)
    return lab.merge(day, left_on="date", right_index=True)


CONDITIONS = {
    "FOMC 下午": lambda d: (d.event == "FOMC") & d.entry.isin(["12:00", "14:00"]),
    "大跌后下午": lambda d: (d.prev_ret == "big down") & d.entry.isin(["12:00", "14:00"]),
    "低VIX且零gamma下": lambda d: (d.vix_t == "low") & (d.gamma_side == "below zero gamma"),
    "周四上午": lambda d: (d.weekday == "Thu") & d.entry.isin(["09:35", "10:30"]),
}


def filter_test(t, wf, labels):
    """Same walk-forward, with no-open conditions learned on the training window only:
    a condition is switched on for a window if the picked parameters lost money under it
    in training (at rank_k, with at least filter_min_n trades)."""
    t = t.merge(labels, on=["date", "entry"], how="left")
    fixed, adaptive, log = [], [], []
    for ts, vs, ve in windows(t.date.min(), t.date.max(), wf):
        train = t[(t.date >= ts) & (t.date < vs)]
        valid = t[(t.date >= vs) & (t.date < ve)]
        best, _ = select(train, wf)
        if best is None:
            continue
        train_p = train
        for col, val in zip(PARAM, best):
            train_p = train_p[train_p[col] == val]
            valid = valid[valid[col] == val]
        adaptive_mask = pd.Series(False, index=valid.index)
        for name, fn in CONDITIONS.items():
            m = fn(train_p)
            on = m.sum() >= wf["filter_min_n"] and train_p.loc[m, PK(wf["rank_k"])].mean() <= 0
            log.append({"valid_start": vs.date(), "condition": name, "train_n": int(m.sum()),
                        "train_ev": train_p.loc[m, PK(wf["rank_k"])].mean() if m.sum() else np.nan, "active": bool(on)})
            if on:
                adaptive_mask |= fn(valid)
        adaptive.append(valid[~adaptive_mask])
        fixed.append(valid)
    return pd.concat(fixed), pd.concat(adaptive), pd.DataFrame(log)


def regime_table(s, cols):
    rows = []
    for col in cols:
        for key, g in s.groupby(col, observed=True):
            for r in curve_stats(g, [0.25]).to_dict("records"):
                rows.append({"dim": col, "group": key} | r)
    return pd.DataFrame(rows)


def run_wf():
    os.makedirs(TABLES, exist_ok=True)
    os.makedirs(FIGS, exist_ok=True)
    t = pd.read_parquet(os.path.join(CLEAN, "fly_trades.parquet"))
    wf = CFG["walkforward"]
    labels = regime_labels()

    picks, oos = walk_forward(t, wf)
    picks.to_csv(os.path.join(TABLES, "wf_picks.csv"), index=False)
    curve_stats(oos.sort_values("date")).round(2).to_csv(os.path.join(TABLES, "oos_curve_stats.csv"), index=False)
    p2, oos2 = walk_forward(t, wf, "per_risk")
    p2.to_csv(os.path.join(TABLES, "wf_picks_per_risk.csv"), index=False)
    curve_stats(oos2.sort_values("date")).round(2).to_csv(os.path.join(TABLES, "oos_curve_stats_per_risk.csv"), index=False)

    # Fixed plans, no selection, over the same out-of-sample months: the honest comparison
    # for the walk-forward pick, and a larger sample for the regime tables.
    start = pd.Timestamp(picks.valid_start.min())
    fixed_rows = []
    fixed_sets = {}
    for e in CFG["entries"]:
        for w in G["widths"]:
            s = t[(t.entry == e) & (t.width == w) & (t.structure == "put_fly") & (t.rule == "hold") & (t.date >= start)].sort_values("date")
            fixed_sets[(e, w)] = s
            r = curve_stats(s)
            fixed_rows.append(r.assign(entry=e, width=w))
    pd.concat(fixed_rows).round(2).to_csv(os.path.join(TABLES, "fixed_hold_oos.csv"), index=False)

    # Rules and structures, all days, in-sample by construction
    g = t.groupby(PARAM)
    full = pd.DataFrame({f"ev_k{k}": g[PK(k)].mean() for k in KS})
    full["n"] = g.size()
    full["win_k0.25"] = g[PK(0.25)].apply(lambda x: (x > 0).mean())
    full["avg_minutes"] = g.minutes.mean()
    full.round(2).sort_values("ev_k0.25", ascending=False).to_csv(os.path.join(TABLES, "full_sample_in_sample.csv"))
    full.reset_index().groupby("structure")[[f"ev_k{k}" for k in KS]].mean().round(2).to_csv(os.path.join(TABLES, "by_structure_in_sample.csv"))
    full.reset_index().groupby("rule")[[f"ev_k{k}" for k in KS]].mean().round(2).to_csv(os.path.join(TABLES, "by_rule_in_sample.csv"))

    oos_l = oos.merge(labels, on=["date", "entry"], how="left")
    regime_table(oos_l, ["year", "vix_t", "event", "prev_ret", "weekday", "gamma_side"]).round(2).to_csv(os.path.join(TABLES, "regime_oos_pick.csv"), index=False)
    base = fixed_sets[("14:00", 25)].merge(labels, on=["date", "entry"], how="left")
    regime_table(base, ["year", "vix_t", "event", "prev_ret", "weekday", "gamma_side"]).round(2).to_csv(os.path.join(TABLES, "regime_fixed_1400_25.csv"), index=False)
    base2 = fixed_sets[("12:00", 50)].merge(labels, on=["date", "entry"], how="left")
    regime_table(base2, ["year", "vix_t", "event", "prev_ret", "weekday", "gamma_side"]).round(2).to_csv(os.path.join(TABLES, "regime_fixed_1200_50.csv"), index=False)

    # Candidate no-open conditions on fixed plans, year by year (all days, so in-sample)
    h = t[(t.structure == "iron_fly") & (t.rule == "hold") & (t.width == 75)].merge(labels, on=["date", "entry"])
    h["thu"] = h.weekday == "Thu"
    h[h.entry.isin(["09:35", "10:30"])].groupby(["entry", "year", "thu"])[PK(0.25)].mean().unstack().round(0).to_csv(os.path.join(TABLES, "thursday_by_year.csv"))
    h["big_down"] = h.prev_ret == "big down"
    h.groupby(["entry", "year", "big_down"])[PK(0.25)].mean().unstack().round(0).to_csv(os.path.join(TABLES, "bigdown_by_year.csv"))
    t[t.structure == "iron_fly"].groupby(["entry", "rule"])[PK(0.25)].mean().unstack(0).round(1).to_csv(os.path.join(TABLES, "rule_by_entry_iron.csv"))
    t[(t.rule == "hold") & (t.entry == "14:00")].groupby(["width", "structure"])[[PK(k) for k in KS]].mean().round(1).to_csv(os.path.join(TABLES, "structure_1400_hold.csv"))

    a, b, log = filter_test(t, wf, labels)
    log.to_csv(os.path.join(TABLES, "filter_log.csv"), index=False)
    pd.concat([curve_stats(a.sort_values("date")).assign(plan="no filter"),
               curve_stats(b.sort_values("date")).assign(plan="learned filter")]).round(2).to_csv(os.path.join(TABLES, "filter_compare.csv"), index=False)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 4))
    s = oos.sort_values("date")
    for k in KS:
        ax.plot(s.date, s[PK(k)].cumsum(), label=f"k={k}")
    ax.axhline(0, color="k", lw=.8); ax.set_ylabel("cumulative USD, 1 fly"); ax.legend(); ax.set_title("walk-forward out-of-sample")
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, "step3_oos_curve.png"), dpi=130); plt.close(fig)
    print(picks.to_string()); print(curve_stats(oos.sort_values("date")).round(2).to_string())


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["sim", "wf"])
    a.add_argument("--workers", type=int, default=6)
    x = a.parse_args()
    run_sim(x.workers) if x.cmd == "sim" else run_wf()
