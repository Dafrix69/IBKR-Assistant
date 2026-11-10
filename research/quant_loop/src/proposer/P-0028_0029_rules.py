"""P-0028 (H1, 基准 A) and P-0029 (H2, bear call 15 wide, credit 3-4) trade rules, one trade per day.

Pure functions on a 14:00 snapshot; no I/O. The spec (proposals/P-0028.md, P-0029.md) restates them in words.
"""
import numpy as np
import pandas as pd

MULT = 100
WIDTHS_H1 = (20, 25, 30, 50, 75)
FEE = dict(comm=((0.05, 0.25), (0.10, 0.50), (np.inf, 0.65)), exch=((1.00, 0.36), (np.inf, 0.45)),
           surcharge=0.14, reg=0.04028, comm_min=1.00)


def _tier(px, tiers):
    for below, fee in tiers:
        if px < below:
            return fee
    return tiers[-1][1]


def leg_fee(mid, qty, min_per_leg=True):
    """USD for one leg of qty contracts, one way. Tiers by the leg's mid. min_per_leg=False reproduces spx_fly fills.leg_fee."""
    comm = qty * _tier(mid, FEE["comm"])
    if min_per_leg:
        comm = max(comm, FEE["comm_min"])
    return comm + qty * (_tier(mid, FEE["exch"]) + FEE["surcharge"] + FEE["reg"])


def book(snap_day):
    """Usable quotes: bad == False (no 0/0, not crossed, not bid0&ask>1.00, spread <= 100 % of mid)."""
    ok = snap_day[~snap_day.bad]
    return {(float(r.strike), r.right): (r.bid, r.ask, r.mid) for r in ok.itertuples()}


def atm(bk, spot):
    strikes = np.array(sorted({k for k, _ in bk}))
    if len(strikes) == 0:
        return None
    K = float(min(strikes, key=lambda x: (abs(x - spot), -x)))     # tie (exactly 2.5 away) -> higher strike (matches the published panel)
    if (K, "C") not in bk or (K, "P") not in bk:
        return K, None
    return K, bk[(K, "C")][2] + bk[(K, "P")][2]


def legs_ok(bk, legs):
    return all(l in bk for l in legs)


def iron(bk, K, w, min_fee=True):
    legs = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C")]
    if not legs_ok(bk, legs):
        return None
    m = [bk[l][2] for l in legs]
    credit = m[1] + m[2] - m[0] - m[3]
    if w - credit <= 0:                                           # equivalent fly cost must be > 0 (as winrate_study)
        return None
    H = sum((bk[l][1] - bk[l][0]) / 2 for l in legs)
    fee = sum(leg_fee(x, 1, min_fee) for x in m)
    return dict(credit=credit, H=H, fee=fee)


def putfly(bk, K, w, min_fee=True):
    legs = [(K - w, "P"), (K, "P"), (K + w, "P")]
    if not legs_ok(bk, legs):
        return None
    m = [bk[l][2] for l in legs]
    cost = m[0] - 2 * m[1] + m[2]
    if cost <= 0:
        return None
    H = (bk[legs[0]][1] - bk[legs[0]][0]) / 2 + 2 * (bk[legs[1]][1] - bk[legs[1]][0]) / 2 + (bk[legs[2]][1] - bk[legs[2]][0]) / 2
    fee = leg_fee(m[0], 1, min_fee) + leg_fee(m[1], 2, min_fee) + leg_fee(m[2], 1, min_fee)
    return dict(cost=cost, H=H, fee=fee)


def h1_pick(bk, spot, widths=WIDTHS_H1, select_on="iron"):
    """Returns (status, K, I, w). Candidate width = all legs of the selecting structure usable; closest w/I to 2, tie -> smaller w."""
    a = atm(bk, spot)
    if a is None:
        return "no_quotes", None, None, None
    K, I = a
    if I is None or I <= 0:
        return "no_atm_straddle", K, None, None
    fn = iron if select_on == "iron" else putfly
    cand = [w for w in widths if fn(bk, K, w) is not None]
    if not cand:
        return "no_width", K, I, None
    w = min(cand, key=lambda w: (abs(w / I - 2.0), w))
    return "ok", K, I, w


def h1_pnl(bk, K, w, settle, k, structure="iron", min_fee=True):
    if structure == "iron":
        r = iron(bk, K, w, min_fee)
        if r is None:
            return None
        return (r["credit"] - k * r["H"] - min(abs(settle - K), w)) * MULT - r["fee"], r
    r = putfly(bk, K, w, min_fee)
    if r is None:
        return None
    return (max(0.0, w - abs(settle - K)) - r["cost"] - k * r["H"]) * MULT - r["fee"], r


def h2_candidates(bk, spot, width=15, lo=3.0, hi=4.0):
    strikes = sorted({k for k, r in bk if r == "C"})
    out = []
    for K in strikes:
        if not (spot - 30 <= K <= spot + 80):                     # spread_credit_scan.py scan range
            continue
        if (K, "C") not in bk or (K + width, "C") not in bk:
            continue
        cr = round(bk[(K, "C")][2] - bk[(K + width, "C")][2], 6)
        if cr <= 0 or not (lo < cr <= hi):                            # (3, 4]: the bucket behind the published 74 % / +38 / +32 row
            continue
        H = (bk[(K, "C")][1] - bk[(K, "C")][0]) / 2 + (bk[(K + width, "C")][1] - bk[(K + width, "C")][0]) / 2
        out.append(dict(K=K, credit=cr, H=H, m_short=bk[(K, "C")][2], m_long=bk[(K + width, "C")][2]))
    return out


def h2_pick(cands):
    if not cands:
        return None
    return min(cands, key=lambda c: (abs(c["credit"] - 3.5), -c["K"]))      # closest to 3.5, tie -> higher K


def h2_pnl(c, settle, k, width=15, min_fee=True):
    fee = leg_fee(c["m_short"], 1, min_fee) + leg_fee(c["m_long"], 1, min_fee)
    loss = min(max(0.0, settle - c["K"]), width)
    return (c["credit"] - k * c["H"] - loss) * MULT - fee, fee
