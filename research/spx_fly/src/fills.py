"""Fill and fee model, reused by every backtest step.

Prices are in index points, fees in USD per contract. k slides the fill from mid (0)
to the far touch (1): buy = mid + k*(ask-mid), sell = mid - k*(mid-bid).
Spec section 2.2. No tick rounding: combos print in 0.05 and k is itself an assumption.
"""
import numpy as np


def _tiered(premium, tiers):
    premium = np.asarray(premium, dtype=float)
    below = [t["below"] for t in tiers]
    fees = np.array([t["fee"] for t in tiers])
    return fees[np.searchsorted(below, premium, side="right").clip(max=len(fees) - 1)]


def fill_price(side, bid, ask, k):
    """side: +1 buy, -1 sell (scalar or array)."""
    bid, ask = np.asarray(bid, dtype=float), np.asarray(ask, dtype=float)
    mid = (bid + ask) / 2
    half = (ask - bid) / 2
    return mid + np.asarray(side) * k * half


def leg_fee(premium, fills_cfg):
    """All-in USD per contract for one leg, one way."""
    return (_tiered(premium, fills_cfg["commission"]) + _tiered(premium, fills_cfg["exchange"])
            + fills_cfg["execution_surcharge"] + fills_cfg["regulatory_clearing"])


def combo_cost(sides, qtys, bids, asks, k, fills_cfg):
    """Net debit in USD for one combo: sides +1/-1 per leg, qtys contracts per leg.
    Positive = paid. Fees are always added."""
    sides, qtys = np.asarray(sides), np.asarray(qtys)
    px = fill_price(sides, bids, asks, k)
    mult = fills_cfg["multiplier"]
    return float((sides * qtys * px).sum() * mult + (qtys * leg_fee(px, fills_cfg)).sum())


def fly_legs(center, width, right="P"):
    """Long 1 lower, short 2 center, long 1 upper. Returns (strikes, sides, qtys)."""
    return ([center - width, center, center + width], [1, -1, 1], [1, 2, 1])


def fly_settle_value(settle, center, width):
    """Fly value in points at expiry; same for call and put flies."""
    return max(0.0, width - abs(settle - center))
