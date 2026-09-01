"""持仓追踪:盈亏、触发、自动平仓的闸门。

这条链会**真的发单**,而且是在用户不在场的时候发。所以测试盯的是那几件一旦错了
就会造成实际损失的事:

  * 方向搞反(空头的止盈止损上下颠倒)——错了会在开仓那一刻立刻平掉;
  * 乘数乘两次(期权的 avgCost 已含乘数)——错了盈亏差一百倍;
  * 跟踪止损的峰值退回——错了等于把已锁住的利润放开;
  * 闸门放行(熔断中、实盘没开、已经触发过)——错了就是越权发单;
  * 平仓数量多一股——那就从平仓变成了反向开仓。
"""
from __future__ import annotations

import pytest

from ibkr_agent import tracker as tk


def long_stock(**kw):
    base = dict(account="主账户", symbol="NVDA", sec_type="STK",
                quantity=100, avg_cost=180.0, multiplier=1.0)
    base.update(kw)
    return tk.Position(**base)


def short_stock(**kw):
    base = dict(account="主账户", symbol="TSLA", sec_type="STK",
                quantity=-50, avg_cost=400.0, multiplier=1.0)
    base.update(kw)
    return tk.Position(**base)


def long_option(**kw):
    # IBKR 口径:5.50 的期权,avgCost 是含乘数的 550
    base = dict(account="主账户", symbol="NVDA", sec_type="OPT",
                quantity=2, avg_cost=550.0, multiplier=100.0)
    base.update(kw)
    return tk.Position(**base)


# ======================================================================
# 盈亏
# ======================================================================
def test_long_stock_pnl():
    out = tk.unrealized(long_stock(), 200.0)
    assert out["cost_basis"] == 18000.0
    assert out["market_value"] == 20000.0
    assert out["unrealized_pnl"] == 2000.0
    assert round(out["unrealized_pct"], 2) == 11.11


def test_option_multiplier_is_applied_exactly_once():
    """IBKR 的 avgCost 对期权已经含乘数。成本再乘一次会差一百倍。"""
    out = tk.unrealized(long_option(), 6.20)
    assert out["cost_basis"] == 1100.0          # 550 × 2,不是 550 × 2 × 100
    assert out["market_value"] == 1240.0        # 6.20 × 100 × 2
    assert out["unrealized_pnl"] == 140.0


def test_short_position_profits_when_price_falls():
    out = tk.unrealized(short_stock(), 380.0)
    assert out["cost_basis"] == -20000.0
    assert out["unrealized_pnl"] == 1000.0
    # 成本是负数,但赚钱的百分比得是正的——用绝对值做分母
    assert out["unrealized_pct"] == 5.0


def test_broker_pnl_wins_over_our_own_arithmetic():
    """券商报的是对账口径。它给了就用它,不拿自己算的去覆盖。"""
    p = long_stock(unrealized_pnl=1888.0, market_value=19888.0)
    out = tk.unrealized(p, 200.0)
    assert out["unrealized_pnl"] == 1888.0
    assert out["pnl_source"] == "broker"


def test_missing_price_yields_none_not_a_fake_zero():
    """算不出来就回 None。拿成本价冒充现价会算出"盈亏为零"的假象。"""
    out = tk.unrealized(long_stock(), None)
    assert out["unrealized_pnl"] is None and out["market_value"] is None


# ======================================================================
# 设置校验:方向搞反必须当场拒
# ======================================================================
def test_long_take_profit_below_price_is_refused():
    with pytest.raises(tk.TrackerError, match="立刻触发"):
        tk.validate(long_stock(), tk.Targets(take_profit=170.0), price=190.0)


def test_long_stop_above_price_is_refused():
    with pytest.raises(tk.TrackerError, match="立刻触发"):
        tk.validate(long_stock(), tk.Targets(stop_loss=195.0), price=190.0)


def test_short_targets_are_mirrored():
    """空头是跌了才赚:止盈在下、止损在上。按多头的直觉填会全反。"""
    tk.validate(short_stock(), tk.Targets(take_profit=360.0, stop_loss=420.0), price=390.0)
    with pytest.raises(tk.TrackerError, match="空头"):
        tk.validate(short_stock(), tk.Targets(take_profit=420.0), price=390.0)
    with pytest.raises(tk.TrackerError, match="空头"):
        tk.validate(short_stock(), tk.Targets(stop_loss=360.0), price=390.0)


def test_stop_must_sit_on_the_right_side_of_take_profit():
    """这条排序检查只在**拿不到现价**时是唯一防线。

    现价已知时,"止损要低于现价"那条会先命中(止损高于止盈的同时必然高于现价)。
    但行情断了的时候方向校验会跳过,这时它就是最后一道——所以必须留着,也必须测。
    """
    with pytest.raises(tk.TrackerError, match="止损价必须低于止盈价"):
        tk.validate(long_stock(), tk.Targets(take_profit=200.0, stop_loss=210.0), price=None)
    with pytest.raises(tk.TrackerError, match="止损价必须高于止盈价"):
        tk.validate(short_stock(), tk.Targets(take_profit=400.0, stop_loss=380.0), price=None)


def test_empty_targets_are_refused():
    with pytest.raises(tk.TrackerError, match="至少要设一个"):
        tk.validate(long_stock(), tk.Targets(), price=190.0)


def test_trail_pct_must_be_a_sane_percentage():
    for bad in (0, 100, -5, 150):
        with pytest.raises(tk.TrackerError, match="回撤百分比"):
            tk.validate(long_stock(), tk.Targets(trail_pct=bad), price=190.0)


# ======================================================================
# 触发
# ======================================================================
def test_take_profit_and_stop_fire_on_the_right_side():
    t = tk.Targets(take_profit=200.0, stop_loss=170.0)
    assert tk.evaluate(long_stock(), t, 190.0)["state"] == tk.STATE_HOLDING
    assert tk.evaluate(long_stock(), t, 200.0)["state"] == tk.STATE_TAKE_PROFIT
    assert tk.evaluate(long_stock(), t, 169.9)["state"] == tk.STATE_STOP_LOSS


def test_a_gap_through_the_whole_range_counts_as_a_stop():
    """跳空同时穿过止盈和止损时按最坏的算。宁可少赚,不可把跳空当止盈。"""
    t = tk.Targets(take_profit=200.0, stop_loss=170.0)
    # 构造一个同时满足两边的极端:止盈在下、止损在上(校验会拒,但引擎要扛得住)
    weird = tk.Targets(take_profit=180.0, stop_loss=195.0)
    assert tk.evaluate(long_stock(), weird, 190.0)["state"] == tk.STATE_STOP_LOSS
    assert tk.evaluate(long_stock(), t, 190.0)["state"] == tk.STATE_HOLDING


def test_short_position_triggers_are_mirrored():
    t = tk.Targets(take_profit=360.0, stop_loss=420.0)
    assert tk.evaluate(short_stock(), t, 390.0)["state"] == tk.STATE_HOLDING
    assert tk.evaluate(short_stock(), t, 360.0)["state"] == tk.STATE_TAKE_PROFIT
    assert tk.evaluate(short_stock(), t, 421.0)["state"] == tk.STATE_STOP_LOSS


def test_missing_price_never_fires():
    t = tk.Targets(take_profit=200.0, stop_loss=170.0)
    out = tk.evaluate(long_stock(), t, None)
    assert out["state"] == tk.STATE_HOLDING and "拿不到现价" in out["reason"]


# ======================================================================
# 跟踪止损
# ======================================================================
def test_peak_only_moves_in_the_favourable_direction():
    p = long_stock()
    peak = None
    for price in (190.0, 205.0, 198.0, 201.0):
        peak = tk.advance_peak(p, price, peak)
    assert peak == 205.0                      # 回落不把峰值带下来

    s = short_stock()
    speak = None
    for price in (390.0, 370.0, 380.0):
        speak = tk.advance_peak(s, price, speak)
    assert speak == 370.0                     # 空头记最低


def test_trailing_stop_follows_the_peak_up():
    p = long_stock()
    t = tk.Targets(trail_pct=5.0)
    out = tk.evaluate(p, t, 200.0, peak=200.0)
    assert out["trail_stop"] == 190.0         # 200 × (1 − 5%)
    assert out["state"] == tk.STATE_HOLDING

    up = tk.evaluate(p, t, 220.0, peak=200.0)
    assert up["peak"] == 220.0 and up["trail_stop"] == 209.0   # 跟着抬上去了

    hit = tk.evaluate(p, t, 208.0, peak=220.0)
    assert hit["state"] == tk.STATE_STOP_LOSS and "跟踪止损" in hit["reason"]


def test_the_tighter_of_fixed_and_trailing_stop_wins():
    """两个止损同时存在时,取离现价更近的那个——保护要按更严的那条算。"""
    p = long_stock()
    t = tk.Targets(stop_loss=170.0, trail_pct=5.0)
    out = tk.evaluate(p, t, 200.0, peak=220.0)
    assert out["trail_stop"] == 209.0
    assert out["stop_effective"] == 209.0     # 209 比 170 更近
    assert out["state"] == tk.STATE_STOP_LOSS


# ======================================================================
# 自动平仓的闸门
# ======================================================================
def gates(**over):
    base = dict(
        auto=tk.AutoClose(enabled=True), position=long_stock(),
        account_is_paper=True, auto_execute=True, allow_live_trading=False,
        breaker_engaged=False, market_status="盘中", already_fired=False,
    )
    base.update(over)
    return tk.close_blockers(**base)


def test_all_gates_open_lets_it_through():
    assert gates() == []


def test_every_gate_can_stop_it():
    assert tk.BLOCK_DISABLED in gates(auto=tk.AutoClose(enabled=False))
    assert tk.BLOCK_AUTO_EXECUTE in gates(auto_execute=False)
    assert tk.BLOCK_BREAKER in gates(breaker_engaged=True)
    assert tk.BLOCK_ALREADY in gates(already_fired=True)
    assert tk.BLOCK_QTY in gates(position=long_stock(quantity=0))
    assert any(tk.BLOCK_MARKET in b for b in gates(market_status="休市"))


def test_live_account_needs_the_live_switch():
    """实盘闸门对自动平仓同样有效——它是这个软件最外层的那道保护。"""
    assert tk.BLOCK_LIVE in gates(account_is_paper=False, allow_live_trading=False)
    assert tk.BLOCK_LIVE not in gates(account_is_paper=False, allow_live_trading=True)


def test_outside_rth_opens_the_extended_sessions():
    assert any(tk.BLOCK_MARKET in b for b in gates(market_status="盘前"))
    base = dict(auto=tk.AutoClose(enabled=True), position=long_stock(),
                account_is_paper=True, auto_execute=True, allow_live_trading=False,
                breaker_engaged=False, market_status="盘前", outside_rth=True)
    assert tk.close_blockers(**base) == []


def test_opening_limits_do_not_apply_to_closing():
    """平仓是减少风险。拿开仓的限额挡平仓,持仓超限的人就永远出不来了——
    所以闸门列表里刻意没有名义金额和张数上限。"""
    blockers = " ".join(gates(position=long_stock(quantity=100000)))
    assert "上限" not in blockers and "限额" not in blockers


# ======================================================================
# 平仓单
# ======================================================================
CONTRACT = {"secType": "STK", "symbol": "NVDA", "exchange": "SMART", "currency": "USD"}


def test_close_order_never_exceeds_the_position():
    """多平一股就从平仓变成反向开仓——那是用户完全没授权过的事。"""
    payload = tk.build_close_order(
        long_stock(quantity=137), tk.AutoClose(enabled=True), 200.0,
        tk.STATE_TAKE_PROFIT, CONTRACT,
    )
    assert payload["order"]["totalQuantity"] == 137
    assert payload["order"]["action"] == "SELL"


def test_closing_a_short_buys_back():
    payload = tk.build_close_order(
        short_stock(), tk.AutoClose(enabled=True), 380.0, tk.STATE_TAKE_PROFIT, CONTRACT
    )
    assert payload["order"]["action"] == "BUY"
    assert payload["order"]["totalQuantity"] == 50


def test_limit_close_concedes_towards_getting_filled():
    """这张单存在的理由就是"必须成交"。让价方向反了 = 挂一张永不成交的单。"""
    assert tk.close_limit_price(long_stock(), 200.0, 1.0) == 198.0    # 卖:让低
    assert tk.close_limit_price(short_stock(), 400.0, 1.0) == 404.0   # 买:让高


def test_limit_close_without_a_price_is_refused():
    with pytest.raises(tk.TrackerError, match="拒绝下单"):
        tk.build_close_order(
            long_stock(), tk.AutoClose(enabled=True, order_type="LMT"), None,
            tk.STATE_STOP_LOSS, CONTRACT,
        )


def test_close_payload_passes_the_order_schema():
    """平仓单必须过和普通订单同一套 schema——它走的是同一条下单路径。"""
    from ibkr_agent.models import parse_llm_payload

    for auto in (tk.AutoClose(enabled=True),
                 tk.AutoClose(enabled=True, order_type="LMT", slippage_pct=0.5)):
        payload = tk.build_close_order(
            long_stock(), auto, 200.0, tk.STATE_STOP_LOSS, CONTRACT
        )
        parsed = parse_llm_payload({"orders": [payload], "rejections": []})
        assert parsed.orders and not parsed.rejections
        assert parsed.orders[0].order.action == "SELL"
