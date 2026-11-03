"""Known-answer checks on synthetic days. Run: ../spx_fly/.venv/bin/python test_backtest.py"""
import datetime as dt

import numpy as np
import pandas as pd

from backtest import block_ci, day_trade


def day(path):
    """path = {minute: (o, h, l, c)}; flat 100 elsewhere."""
    rows = [dict(m=i, open=100.0, high=100.5, low=99.5, close=100.0) for i in range(390)]
    for i, (o, h, l, c) in path.items():
        rows[i].update(open=o, high=h, low=l, close=c)
    return pd.DataFrame(rows)


# breakout at minute 10, entry at next open, no stop hit, exit at the 15:55 open
d = day({10: (100, 101, 100, 101), 11: (101.1, 101.2, 101, 101.1), 385: (103, 103, 103, 103)})
for i in range(12, 385):
    d.loc[i, ["open", "high", "low", "close"]] = [102, 102.1, 101.9, 102]
t = day_trade(d, 5, 1.0, "both", True)
assert t[0] == 1 and t[1] == 11 and t[2] == 101.1 and t[3] == 385 and t[4] == 103 and not t[5], t

# entry uses only the close: an intrabar poke through the range does not trigger
d = day({10: (100, 101, 100, 100)})
assert day_trade(d, 5, 1.0, "both", True) is None

# stop gaps through: fills at the bar open, not the stop
d = day({10: (100, 101, 100, 101), 11: (101, 101, 101, 101), 12: (98, 98, 97, 97.5)})
for i in range(13, 390):
    d.loc[i, ["open", "high", "low", "close"]] = [101, 101.1, 100.9, 101]
d.loc[12, ["open", "high", "low", "close"]] = [98, 98, 97, 97.5]
t = day_trade(d, 5, 1.0, "both", True)
assert t[5] and t[4] == 98, t

# long-only ignores a downside break
d = day({10: (100, 100, 99, 99)})
assert day_trade(d, 5, 1.0, "long", True) is None
assert day_trade(d, 5, 1.0, "both", True)[0] == -1

# bootstrap brackets a known mean
x = np.random.default_rng(1).normal(0.01, 0.02, 2000)
lo, hi = block_ci(x, draws=2000)
assert lo < 0.01 < hi and hi - lo < 0.003, (lo, hi)

# walls: the biggest gex above and below spot, far expiries and small OI ignored
from walls import after_touch, compute_wall
D = dt.date(2026, 10, 1)
near, far = "2026-10-16", "2027-01-15"
oi = pd.DataFrame([("%s" % near, 110.0, "CALL", 3000), (near, 105.0, "CALL", 1000), (far, 120.0, "CALL", 99000),
                   (near, 90.0, "PUT", 2000), (near, 95.0, "PUT", 400)],
                  columns=["expiration", "strike", "right", "open_interest"])
gk = oi[["expiration", "strike", "right"]].assign(gamma=0.02)
w = compute_wall(oi, gk, 100.0, D)
assert w["call_wall"] == 110.0 and w["put_wall"] == 90.0, w
assert abs(w["net"] - (4000 - 2400) * 0.02 * 100 * 1e4 * 0.01) < 1e-6, w

# after a touch at 105 from below, 30 minutes later at 104: rejected, positive
d = day({})
d["open"], d["high"], d["low"], d["close"] = 100.0, 100.5, 99.5, 100.0
d.loc[50, "high"] = 105.0
d.loc[80, "close"] = 104.0
assert abs(after_touch(d, 1, 105.0) - 1 / 105) < 1e-12
# a level already passed at the open is not a touch
assert after_touch(d, 1, 99.0) is None

# spread model: exact log-log data is recovered
from universe_backtest import predict_spread
coef = {0: np.array([np.log(0.01), -0.5, -0.2])}
assert abs(predict_spread(coef, 0, 20.0, 1e8) - 0.01 * 20 ** -0.5 * 1e8 ** -0.2) < 1e-12
assert predict_spread(coef, 7, 20.0, 1e8) == predict_spread(coef, 0, 20.0, 1e8)  # nearest bucket

# scalp: VWAP, V1 pullback, V2 cross, take-profit on close only
from scalp import entry_v1, entry_v2, trade, vwap
d = day({})
d["volume"] = 100.0
d.loc[0, ["high", "low", "close"]] = [110, 110, 110]  # typical 110 x 100, then 100 x 100 each
assert abs(vwap(d)[1] - 105) < 1e-9 and abs(vwap(d)[0] - 110) < 1e-9
# V2: gap up, close below VWAP at first, then the first close above -> long, stop at the low so far
d = day({})
d["volume"] = 100.0
d.loc[:39, "close"] = 98.0; d.loc[:39, "high"] = 99.5; d.loc[:39, "low"] = 97.5; d.loc[:39, "open"] = 98.0  # close < typical
d.loc[20, "low"] = 97.0
d.loc[40, "close"] = 100.5
s, i, stop = entry_v2(d, 1, "long")
assert s == 1 and i == 40 and stop == 97.0, (s, i, stop)
assert entry_v2(d, -1, "long") is None and entry_v2(d, 0, "both") is None
# V1: 5 closes above VWAP, a low that touches VWAP, then a close above -> long after the touch bar
d = day({})
d["volume"] = 100.0
d.loc[:, ["open", "high", "low", "close"]] = [[105, 105.2, 104.8, 105]] * 390
d.loc[0, ["open", "high", "low", "close", "volume"]] = [100, 100.5, 99.5, 100, 1e6]  # pins VWAP near 100
vw = vwap(d)
assert vw[41] < 100.2 and all(d.low.values[1:40] > vw[1:40] * 1.001)
d.loc[40, "low"] = vw[40]  # the pullback touches VWAP
vw = vwap(d)  # the touch bar's typical price moves VWAP a little
s, i, stop = entry_v1(d, "long")
assert s == 1 and i == 41 and abs(stop - (vw[41] - 0.5 * (105.2 - 99.5))) < 1e-9, (s, i, stop)
assert entry_v1(d.iloc[:40], "long") is None  # no close after the touch, no signal
# take-profit: an intrabar poke through the target does not fill, a close beyond it does
d = day({})
d.loc[9, ["open", "high", "low", "close"]] = [100, 100, 100, 100]
d.loc[10, "high"] = 102.0                      # poke, close stays 100
d.loc[11, ["open", "high", "low", "close"]] = [100, 101.5, 100, 101.2]
t = trade(d, (1, 8, 99.0), 0.01)
assert t[3] == 11 and t[4] == 101.2 and not t[5], t
# a bar that hits the stop and would close past the target counts as the stop
d = day({})
d.loc[10, ["open", "high", "low", "close"]] = [100, 102, 98.5, 101.5]
t = trade(d, (1, 8, 99.0), 0.01)
assert t[5] and t[4] == 99.0, t
# no target: runs to 15:55
assert trade(day({}), (1, 8, 99.0), None)[3] == 385
print("ok")


def test_premarket_features_and_h1():
    import premarket as PM
    ts = pd.date_range("2025-01-06 04:00", "2025-01-06 19:59", freq="1min", tz="America/New_York")
    ts2 = pd.date_range("2025-01-07 04:00", "2025-01-07 19:59", freq="1min", tz="America/New_York")
    def day(ts, pre_px, open_px):
        n = len(ts)
        px = np.full(n, open_px, dtype=float)
        m = ts.hour * 60 + ts.minute - 570
        px[m < 0] = pre_px
        return pd.DataFrame(dict(ts=ts, open=px, high=px + 0.1, low=px - 0.1, close=px, volume=100, m=m, date=ts.date))
    d1 = day(ts, 10.0, 10.0)
    d2 = day(ts2, 11.0, 10.5)  # pre-market +10 % on the prior close, opens 4.5 % below the pre-market high
    full = pd.concat([d1, d2])
    f = PM.features(full)
    assert list(f.index) == [ts2[0].date()], f
    r = f.iloc[0]
    assert abs(r.pm_ret - 0.10) < 1e-9 and abs(r.pm_high - 11.1) < 1e-9 and abs(r.fade_in - (10.5 / 11.1 - 1)) < 1e-9
    assert PM.h1_signal(None, r, 0.08, False) == (-1, 0, 11.1)
    assert PM.h1_signal(None, r, 0.12, False) is None
    assert PM.h1_signal(None, r, 0.08, True) == (-1, 0, 11.1)   # fade_in -5.4 % <= -1 %
    r2 = r.copy(); r2["fade_in"] = -0.005
    assert PM.h1_signal(None, r2, 0.08, True) is None
    # night bars (20:00 prev day) count into the next day's pm_high
    night = pd.date_range("2025-01-06 20:00", "2025-01-07 03:49", freq="1min", tz="America/New_York")
    dn = pd.DataFrame(dict(ts=night, open=12.0, high=12.1, low=11.9, close=12.0, volume=1,
                           m=np.where(night.hour >= 20, night.hour * 60 + night.minute - 570 - 1440, night.hour * 60 + night.minute - 570),
                           date=[ts2[0].date()] * len(night)))
    f2 = PM.features(pd.concat([d1, dn, d2]))
    assert abs(f2.iloc[0].pm_high - 12.1) < 1e-9 and f2.iloc[0].n_night == len(night)


test_premarket_features_and_h1()


def test_premarket_short():
    import premarket_short as PS
    # night + pre-market + regular bars of one trading day; prev close 10
    m = np.array([-700, -699, -698, -400, -300, -299, -200, -100, -20, -5, 0, 1, 30, 31, 385])
    px = np.array([10.0, 10.2, 10.6, 10.4, 10.3, 10.5, 10.55, 10.5, 10.6, 10.5, 10.4, 10.3, 10.2, 10.1, 10.0])
    d = pd.DataFrame(dict(m=m, open=px, high=px + 0.05, low=px - 0.05, close=px, volume=10, ts=range(len(m))))
    t = PS.day_short(d, 10.0, 0.05, 0)
    assert t[0] == -1 and t[1] == 3 and abs(t[2] - 10.4) < 1e-9 and t[7] == "night", t  # close 10.6 >= 10.5 at bar 2 -> next open
    assert t[3] == 10 and abs(t[4] - 10.4) < 1e-9 and not t[5], t                    # exit at the 09:30 open, stop 10.66 never hit
    t2 = PS.day_short(d, 10.0, 0.05, 30)
    assert t2[3] == 12 and abs(t2[4] - 10.2) < 1e-9, t2                               # exit at the 10:00 open
    assert PS.day_short(d, 10.0, 0.10, 0) is None                                     # never reached
    # stop: entry 10.4, stop 10.66; a bar high of 10.95 after entry stops it at max(stop, open)
    d2 = d.copy(); d2.loc[6, "high"] = 10.95; d2.loc[6, "open"] = 10.9
    t3 = PS.day_short(d2, 10.0, 0.05, 0)
    assert t3[5] and t3[3] == 6 and abs(t3[4] - 10.9) < 1e-9, t3
    # 8 % reached only in pre-market -> session "pre"
    d4 = d.copy(); d4.loc[6, ["close", "high"]] = [10.9, 10.95]
    t4 = PS.day_short(d4, 10.0, 0.08, 0)
    assert t4[7] == "pre" and t4[1] == 7, t4
    # signal after 09:20 is ignored
    d3 = d.copy(); d3.loc[:8, "close"] = 10.0; d3.loc[:8, "high"] = 10.05
    assert PS.day_short(d3, 10.0, 0.05, 0) is None


test_premarket_short()


def test_premarket_wall():
    import premarket_wall as PW
    m = np.array([-700, -699, -698, -400, -300, -299, -200, -100, -20, -5, 0, 1, 30, 31, 385])
    px = np.array([10.0, 10.2, 10.6, 10.4, 10.3, 10.5, 10.55, 10.5, 10.6, 10.5, 10.4, 10.3, 10.2, 10.1, 10.0])
    d = pd.DataFrame(dict(m=m, open=px, high=px + 0.05, low=px - 0.05, close=px, volume=10, ts=range(len(m))))
    walls = pd.DataFrame(dict(call_wall=[11.0, 10.65], spot=[10.0, 10.0]), index=["d0", "d1"])
    lv = PW.wall_for_bars(d, walls, "d1", "d0")
    assert lv[0] == 11.0 and lv[3] == 11.0 and lv[4] == 10.65  # night bars (m < -330) use D-1's wall, pre-market D's
    # B: first pre-market bar with high >= 10.65 * 0.995 = 10.597 is bar 6 (high 10.6) -> short at bar 7 open 10.5
    t = PW.trade_b(d, lv)
    assert t[1] == 7 and abs(t[2] - 10.5) < 1e-9 and t[3] == 10 and not t[5] and t[7] == "pre", t
    # A: wall 10.65 touched at bar 8 (high 10.65), fewer than 30 traded bars after -> None; with 10.6 wall, bar 2 (night, wall 11) no
    assert PW.touch_a(d, lv) is None
    big = pd.concat([d.iloc[:9]] + [d.iloc[[9]].assign(m=-5 + k * 0.1) for k in range(31)] + [d.iloc[10:]], ignore_index=True)
    big["m"] = big.m.astype(float)
    lv2 = np.full(len(big), 10.65)
    r = PW.touch_a(big, lv2)
    assert r is not None and abs(r[0] - (-(10.5 - 10.65) / 10.65)) < 1e-9 and abs(r[1] - (-(10.4 - 10.65) / 10.65)) < 1e-9, r
    # zero-volume bars are not touches
    d2 = d.copy(); d2.loc[6, "volume"] = 0
    assert PW.trade_b(d2, lv)[1] == 9


test_premarket_wall()
