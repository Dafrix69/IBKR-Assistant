"""Calibrate the backtest's fill and fee assumptions against the trader's own SPX/SPXW fills.

Reads the Datrix trade database read-only (broker_fills + record_events), keeps SPX option
legs with a real price, groups them into combos by exec-id prefix, and compares each fill to
the NBBO from two sources:
  chain  data/clean/chain_YYYYMMDD.parquet   1-minute NBBO, minute of the fill and the next
  tick   data/raw/SPXW/trade_quote_dte0/...  quote attached to the last print at or before the fill
k is measured as in src/fills.py: buy k = (px - mid) / (ask - mid), sell k = (mid - px) / (mid - bid).
Combo k uses the net debit paid vs the sum of leg mids and the sum of leg far touches.

Account ids are dropped at load and never written. Outputs go to reports/calibration_tables/.
Run:  .venv/bin/python src/calibrate_fills.py
"""
import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yaml

ET = ZoneInfo("America/New_York")
RIGHT_LONG = {"P": "PUT", "C": "CALL"}
PRINT_WINDOW_S = 2.0        # a leg price is "market" if the tape shows that price and size within this
STALE_MAX_S = 60.0          # tick-basis quotes older than this are dropped


def mask(s):
    return "U***"


def load_fills(db_path):
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        rows = con.execute("SELECT exec_id, time, fill_json FROM broker_fills ORDER BY time, exec_id").fetchall()
        ev = con.execute("SELECT record_id, at, kind, payload FROM record_events WHERE kind IN ('fill','commission') ORDER BY seq").fetchall()
    finally:
        con.close()
    legs, bags = [], []
    for exec_id, t, fj in rows:
        f = json.loads(fj)
        c = f["contract"]
        if c.get("symbol") != "SPX" or c.get("secType") not in ("OPT", "BAG"):
            continue
        if f["price"] is None or f["price"] == 0 and c["secType"] == "OPT":
            continue  # expiry processing rows (SMART, price 0)
        rec = dict(exec_id=exec_id, combo=exec_id.rsplit(".", 2)[0], perm_id=str(f.get("perm_id", "")),
                   time_utc=datetime.fromisoformat(f["time"]), side=f["side"], qty=float(f["shares"]),
                   price=float(f["price"]), exchange=c.get("exchange", ""),
                   commission=float(f.get("commission") or 0.0))
        if c["secType"] == "OPT":
            rec.update(expiry=c["expiry"], strike=float(c["strike"]), right=c["right"], trading_class=c.get("tradingClass", ""))
            legs.append(rec)
        else:
            bags.append(rec)
    legs = pd.DataFrame(legs)
    bags = pd.DataFrame(bags)
    # commissions reported through order events (the Sep-30 fly only lives there)
    ev_fills, ev_comm = {}, {}
    for rid, at, kind, payload in ev:
        p = json.loads(payload)
        if kind == "fill" and p.get("sec_type") == "OPT":
            ev_fills[p["exec_id"]] = dict(exec_id=p["exec_id"], time_tws=p["time"], price=p["price"], qty=p["qty"], con_id=p["con_id"])
        elif kind == "commission":
            ev_comm[p["exec_id"]] = p["commission"]
    return legs, bags, ev_fills, ev_comm


def attach_times(legs):
    legs["time_et"] = legs.time_utc.apply(lambda t: t.astimezone(ET).replace(tzinfo=None))
    legs["day"] = legs.time_et.dt.strftime("%Y%m%d")
    legs["dte0"] = legs.expiry == legs.day
    legs["sign"] = np.where(legs.side == "BOT", 1, -1)
    return legs


_chain_cache, _tick_cache = {}, {}


def chain_quotes(research, day, strikes):
    key = (day, tuple(sorted(strikes)))
    if key not in _chain_cache:
        p = research / "data" / "clean" / f"chain_{day}.parquet"
        _chain_cache[key] = pd.read_parquet(p, filters=[("strike", "in", list(strikes))]) if p.exists() else None
    return _chain_cache[key]


def tick_quotes(research, day, strikes):
    key = (day, tuple(sorted(strikes)))
    if key not in _tick_cache:
        p = research / "data" / "raw" / "SPXW" / "trade_quote_dte0" / day[:4] / f"{day}.csv.gz"
        if p.exists():
            d = pd.read_csv(p, usecols=["strike", "right", "trade_timestamp", "quote_timestamp", "size", "price", "bid", "ask", "condition"],
                            parse_dates=["trade_timestamp", "quote_timestamp"])
            d = d[d.strike.isin(strikes)].sort_values("trade_timestamp").reset_index(drop=True)
        else:
            d = None
        _tick_cache[key] = d
    return _tick_cache[key]


def k_of(sign, px, bid, ask):
    mid = (bid + ask) / 2
    half = (ask - bid) / 2
    if not (half > 0):
        return math.nan
    return (px - mid) / half if sign > 0 else (mid - px) / half


def quote_legs(legs, research):
    out = []
    for _, l in legs.iterrows():
        r = dict(l)
        r.update(chain_bid=np.nan, chain_ask=np.nan, chain_bad=None, chain1_bid=np.nan, chain1_ask=np.nan,
                 tick_bid=np.nan, tick_ask=np.nan, tick_stale_s=np.nan, tape_match=None, tape_dt_s=np.nan)
        if l.dte0:
            strikes = set(legs.loc[legs.combo == l.combo, "strike"])
            ch = chain_quotes(research, l.day, strikes)
            if ch is not None:
                m0 = l.time_et.replace(second=0, microsecond=0)
                for tag, m in (("chain", m0), ("chain1", m0 + timedelta(minutes=1))):
                    q = ch[(ch.strike == l.strike) & (ch.right == l.right) & (ch.ts == m)]
                    if len(q):
                        r[f"{tag}_bid"], r[f"{tag}_ask"] = float(q.bid.iloc[0]), float(q.ask.iloc[0])
                        if tag == "chain":
                            r["chain_bad"] = bool(q.flag_bad.iloc[0])
            tk = tick_quotes(research, l.day, strikes)
            if tk is not None:
                s = tk[(tk.strike == l.strike) & (tk.right == RIGHT_LONG[l.right])]
                before = s[s.quote_timestamp <= l.time_et]
                if len(before):
                    q = before.iloc[-1]
                    r["tick_bid"], r["tick_ask"] = float(q.bid), float(q.ask)
                    r["tick_stale_s"] = (l.time_et - q.quote_timestamp).total_seconds()
                near = s[(s.trade_timestamp - l.time_et).abs() <= timedelta(seconds=PRINT_WINDOW_S)]
                hit = near[((near.price - l.price).abs() < 1e-9) & (near["size"] == l.qty)]
                r["tape_match"] = bool(len(hit))
                if len(hit):
                    r["tape_dt_s"] = float((hit.trade_timestamp.iloc[0] - l.time_et).total_seconds())
        out.append(r)
    q = pd.DataFrame(out)
    for basis in ("chain", "chain1", "tick"):
        q[f"{basis}_mid"] = (q[f"{basis}_bid"] + q[f"{basis}_ask"]) / 2
        q[f"k_{basis}"] = [k_of(s, p, b, a) for s, p, b, a in zip(q.sign, q.price, q[f"{basis}_bid"], q[f"{basis}_ask"])]
    q.loc[q.tick_stale_s > STALE_MAX_S, ["k_tick"]] = np.nan
    q.loc[q.chain_bad == True, ["k_chain"]] = np.nan  # noqa: E712
    return q


def structure_name(g):
    rights = set(g.right)
    n = len(g)
    qtys = sorted(g.qty / g.qty.min())
    if n == 2:
        return "vertical"
    if n == 3 and rights and len(rights) == 1 and qtys == [1, 1, 2]:
        return "fly"
    if n == 4 and len(rights) == 2:
        return "iron_condor" if len(set(g.strike)) == 4 else "iron_fly"
    return f"{n}-leg"


def combo_table(q, bags):
    rows = []
    for cid, g in q.groupby("combo", sort=False):
        bag = bags[bags.combo == cid]
        bag_qty = float(bag.qty.iloc[0]) if len(bag) else g.qty.min()
        bag_side = bag.side.iloc[0] if len(bag) else ""
        bag_price = float(bag.price.iloc[0]) if len(bag) else np.nan
        unit = g.qty / bag_qty
        paid = float((g.sign * unit * g.price).sum())  # net debit per combo unit, + = paid
        bag_paid = bag_price * (1 if bag_side == "BOT" else -1) if len(bag) else np.nan
        row = dict(combo=cid, time_utc=g.time_utc.iloc[0], time_et=g.time_et.iloc[0], expiry=g.expiry.iloc[0], dte0=bool(g.dte0.iloc[0]),
                   structure=structure_name(g), legs=len(g), combo_qty=bag_qty, bag_side=bag_side, bag_price=bag_price,
                   paid=paid, bag_mismatch=bool(len(bag) and abs(paid - bag_paid) > 0.011),
                   direction="debit" if paid > 0 else "credit", legs_on_tape=int((g.tape_match == True).sum()),  # noqa: E712
                   exchange=g.exchange.iloc[0])
        for basis in ("chain", "chain1", "tick"):
            bid, ask, mid = g[f"{basis}_bid"], g[f"{basis}_ask"], g[f"{basis}_mid"]
            if mid.isna().any():
                row.update({f"{basis}_mid_debit": np.nan, f"{basis}_cross_debit": np.nan, f"k_{basis}": np.nan})
                continue
            touch = np.where(g.sign > 0, ask, bid)
            mid_debit = float((g.sign * unit * mid).sum())
            cross_debit = float((g.sign * unit * touch).sum())
            width = cross_debit - mid_debit
            row[f"{basis}_mid_debit"] = mid_debit
            row[f"{basis}_cross_debit"] = cross_debit
            row[f"k_{basis}"] = (paid - mid_debit) / width if width > 0 else np.nan
            if basis == "tick":
                row["tick_max_stale_s"] = float(g.tick_stale_s.max())
        rows.append(row)
    c = pd.DataFrame(rows)
    c.loc[c.tick_max_stale_s > STALE_MAX_S, "k_tick"] = np.nan
    return c


def fee_table(legs, ev_fills, ev_comm, cfg):
    """Every leg with a reported commission, from broker_fills or order events, against the schedule."""
    rows = []
    seen = set()
    for _, l in legs.iterrows():
        if l.commission > 0:
            rows.append(dict(exec_id=l.exec_id, source="broker_fills", time_utc=l.time_utc.isoformat(), qty=l.qty, price=l.price, commission=l.commission))
            seen.add(l.exec_id)
    for eid, comm in ev_comm.items():
        if eid in seen or eid not in ev_fills:
            continue
        f = ev_fills[eid]
        rows.append(dict(exec_id=eid, source="record_events", time_utc=f["time_tws"], qty=float(f["qty"]), price=float(f["price"]), commission=float(comm)))
    t = pd.DataFrame(rows)
    if t.empty:
        return t
    comm_rate = tier(t.price, cfg["commission"])
    exch = tier(t.price, cfg["exchange"])
    t["model_config"] = t.qty * (comm_rate + exch + cfg["execution_surcharge"] + cfg["regulatory_clearing"])
    # schedule with IBKR's USD 1.00 minimum per leg and the observed regulatory+clearing rate
    reg = 0.04028
    t["model_min1"] = np.maximum(t.qty * comm_rate, 1.0) + t.qty * (exch + cfg["execution_surcharge"] + reg)
    t["per_contract"] = t.commission / t.qty
    t["ibkr_part"] = t.commission - t.qty * (exch + cfg["execution_surcharge"]) - t.qty * reg
    return t


def tier(premium, tiers):
    below = np.array([t["below"] for t in tiers], dtype=float)
    fees = np.array([t["fee"] for t in tiers], dtype=float)
    idx = np.searchsorted(below, np.asarray(premium, dtype=float), side="right").clip(max=len(fees) - 1)
    return fees[idx]


def describe(s):
    s = pd.Series(s).dropna()
    if s.empty:
        return dict(n=0)
    return dict(n=int(len(s)), mean=round(float(s.mean()), 3), median=round(float(s.median()), 3),
                p25=round(float(s.quantile(0.25)), 3), p75=round(float(s.quantile(0.75)), 3),
                min=round(float(s.min()), 3), max=round(float(s.max()), 3))


def hour_bucket(t):
    h = t.hour + t.minute / 60
    if h < 9.5:
        return "pre-09:30 (GTH)"
    if h < 10.5:
        return "09:30-10:30"
    if h < 12:
        return "10:30-12:00"
    if h < 14:
        return "12:00-14:00"
    return "14:00-16:00"


def main():
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/Library/Application Support/dafri/trades.db"))
    ap.add_argument("--research", default=str(here))
    ap.add_argument("--out", default=str(here / "reports" / "calibration_tables"))
    a = ap.parse_args()
    research, out = Path(a.research), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cfg = yaml.safe_load(open(research / "config.yaml"))["fills"]

    legs, bags, ev_fills, ev_comm = load_fills(a.db)
    legs = attach_times(legs)
    bags["time_et"] = bags.time_utc.apply(lambda t: t.astimezone(ET).replace(tzinfo=None))
    q = quote_legs(legs, research)
    c = combo_table(q, bags)
    fees = fee_table(legs, ev_fills, ev_comm, cfg)

    q["hour_bucket"] = q.time_et.apply(hour_bucket)
    c["hour_bucket"] = c.time_et.apply(hour_bucket)
    q["year"] = q.time_et.dt.year
    c["year"] = c.time_et.dt.year
    q["side_word"] = np.where(q.sign > 0, "buy", "sell")

    def iso(df):
        d = df.copy()
        for col in d.columns:
            if d[col].dtype == object and len(d) and isinstance(d[col].dropna().iloc[0] if d[col].notna().any() else None, datetime):
                d[col] = d[col].apply(lambda x: x.isoformat() if isinstance(x, datetime) else x)
        return d

    iso(q.drop(columns=["perm_id"])).to_csv(out / "legs.csv", index=False)
    iso(c).to_csv(out / "combos.csv", index=False)
    if not fees.empty:
        fees.to_csv(out / "fees.csv", index=False)

    usable_c = c[c.k_tick.notna() | c.k_chain.notna()]
    summary = {
        "sample": {
            "legs_total": int(len(q)), "legs_dte0": int(q.dte0.sum()), "legs_on_tape": int((q.tape_match == True).sum()),  # noqa: E712
            "combos_total": int(len(c)), "combos_dte0": int(c.dte0.sum()), "combos_with_k": int(len(usable_c)),
            "combos_bag_mismatch": int(c.bag_mismatch.sum()),
            "dropped_not_dte0": c.loc[~c.dte0, ["time_et", "expiry", "structure"]].astype(str).to_dict("records"),
            "dropped_no_quote": c.loc[c.dte0 & c.k_tick.isna() & c.k_chain.isna(), ["time_et", "structure"]].astype(str).to_dict("records"),
            "first": str(c.time_et.min()), "last": str(c.time_et.max()),
        },
        "combo_k": {basis: describe(c[f"k_{basis}"]) for basis in ("tick", "chain", "chain1")},
        "combo_k_tick_by_direction": {d: describe(g.k_tick) for d, g in c.groupby("direction")},
        "combo_k_tick_by_structure": {d: describe(g.k_tick) for d, g in c.groupby("structure")},
        "combo_k_tick_by_hour": {d: describe(g.k_tick) for d, g in c.groupby("hour_bucket")},
        "combo_k_tick_by_year": {int(d): describe(g.k_tick) for d, g in c.groupby("year")},
        "leg_k_tick_all": describe(q.k_tick),
        "leg_k_tick_on_tape": describe(q.loc[q.tape_match == True, "k_tick"]),  # noqa: E712
        "legs_on_tape_inside_own_nbbo_tick": int(((q.tape_match == True) & (q.k_tick.abs() <= 1)).sum()),  # noqa: E712
        "legs_on_tape_inside_own_nbbo_chain": int(((q.tape_match == True) & (q.k_chain.abs() <= 1)).sum()),  # noqa: E712
        "leg_k_tick_on_tape_by_side": {d: describe(g.k_tick) for d, g in q[q.tape_match == True].groupby("side_word")},  # noqa: E712
        "leg_k_chain_on_tape": describe(q.loc[q.tape_match == True, "k_chain"]),  # noqa: E712
        "leg_k_tick_allocated": describe(q.loc[q.tape_match == False, "k_tick"]),  # noqa: E712
        "share_k_at_most": {str(k): round(float((c.k_tick.dropna() <= k).mean()), 3) for k in (0.0, 0.25, 0.5, 1.0)} if c.k_tick.notna().any() else {},
    }
    if not fees.empty:
        summary["fees"] = {
            "legs": int(len(fees)), "contracts": int(fees.qty.sum()),
            "per_contract": describe(fees.per_contract),
            "total_actual": round(float(fees.commission.sum()), 5),
            "total_config_model": round(float(fees.model_config.sum()), 5),
            "total_min1_model": round(float(fees.model_min1.sum()), 5),
            "max_abs_err_min1": round(float((fees.commission - fees.model_min1).abs().max()), 6),
            "max_abs_err_config": round(float((fees.commission - fees.model_config).abs().max()), 6),
        }
    json.dump(summary, open(out / "summary.json", "w"), indent=1, ensure_ascii=False, default=str)

    # per-combo listing for the report
    cols = ["time_et", "structure", "direction", "combo_qty", "paid", "tick_mid_debit", "tick_cross_debit", "k_tick", "k_chain", "k_chain1", "legs_on_tape", "legs", "tick_max_stale_s"]
    lst = c[cols].copy()
    lst["time_et"] = lst.time_et.astype(str)
    lst.to_csv(out / "combo_listing.csv", index=False, float_format="%.3f")

    print(json.dumps(summary, indent=1, ensure_ascii=False, default=str))
    print(lst.to_string())
    if not fees.empty:
        print(fees.to_string())


if __name__ == "__main__":
    sys.exit(main())
