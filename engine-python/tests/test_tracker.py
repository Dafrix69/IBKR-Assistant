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


# ---- 利润回撤追踪平仓(用户需求:利润比峰值低 30% 时卖出 50%)------------------
def _pos(qty=100.0, cost=200.0, mult=1.0):
    from ibkr_agent.tracker import Position

    return Position(account="模拟", symbol="AAPL", quantity=qty, avg_cost=cost,
                    multiplier=mult)


def test_profit_drawdown_fires_when_profit_falls_from_peak():
    from ibkr_agent import tracker as tk

    targets = tk.Targets(profit_drawdown_pct=30.0)
    # 峰值价 260 → 峰值利润 6000;现价 240 → 利润 4000,回撤 33.3% > 30% → 触发
    result = tk.evaluate(_pos(), targets, price=240.0, peak=260.0)
    assert result["state"] == tk.STATE_PROFIT_TRAIL
    assert result["profit_peak"] == 6000.0
    assert abs(result["profit_drawdown_pct"] - 33.33) < 0.01
    assert "利润回撤触发" in result["reason"]


def test_profit_drawdown_does_not_fire_within_threshold():
    from ibkr_agent import tracker as tk

    targets = tk.Targets(profit_drawdown_pct=30.0)
    # 现价 250 → 利润 5000,回撤 16.7% < 30% → 继续持有
    result = tk.evaluate(_pos(), targets, price=250.0, peak=260.0)
    assert result["state"] == tk.STATE_HOLDING
    assert abs(result["profit_drawdown_pct"] - 16.67) < 0.01


def test_profit_drawdown_needs_a_profitable_peak():
    from ibkr_agent import tracker as tk

    # 峰值价 190 < 成本 200:从未盈利,谈不上"利润回撤",不触发
    targets = tk.Targets(profit_drawdown_pct=30.0)
    result = tk.evaluate(_pos(), targets, price=180.0, peak=190.0)
    assert result["state"] == tk.STATE_HOLDING
    assert result["profit_drawdown_pct"] is None


def test_profit_drawdown_works_for_shorts():
    from ibkr_agent import tracker as tk

    # 空头:成本 200 卖出,峰值价 150 → 峰值利润 5000;反弹到 185 → 利润 1500,回撤 70%
    targets = tk.Targets(profit_drawdown_pct=30.0)
    result = tk.evaluate(_pos(qty=-100.0), targets, price=185.0, peak=150.0)
    assert result["state"] == tk.STATE_PROFIT_TRAIL


def test_stop_loss_still_beats_profit_trail():
    from ibkr_agent import tracker as tk

    targets = tk.Targets(profit_drawdown_pct=30.0, stop_loss=190.0)
    result = tk.evaluate(_pos(), targets, price=185.0, peak=260.0)
    assert result["state"] == tk.STATE_STOP_LOSS   # 止损优先,按最坏的一边算


def test_partial_close_rounds_down_and_never_exceeds():
    from ibkr_agent import tracker as tk

    contract = {"secType": "STK", "symbol": "AAPL"}
    auto = tk.AutoClose(enabled=True, order_type="MKT", close_fraction_pct=50.0)
    payload = tk.build_close_order(_pos(qty=101.0), auto, 240.0, tk.STATE_PROFIT_TRAIL, contract)
    assert payload["order"]["totalQuantity"] == 50      # 101 × 50% 向下取整
    assert "利润回撤平仓" in payload["intent_summary"]
    assert "平 50/101" in payload["intent_summary"]

    # 1 股持仓也至少平 1 股;100% 时不带"平 x/y"标记
    payload = tk.build_close_order(_pos(qty=1.0), auto, 240.0, tk.STATE_PROFIT_TRAIL, contract)
    assert payload["order"]["totalQuantity"] == 1
    full = tk.AutoClose(enabled=True, close_fraction_pct=100.0)
    payload = tk.build_close_order(_pos(qty=100.0), full, 240.0, tk.STATE_STOP_LOSS, contract)
    assert payload["order"]["totalQuantity"] == 100
    assert "平 " not in payload["intent_summary"]

    import pytest

    with pytest.raises(tk.TrackerError):
        tk.build_close_order(_pos(), tk.AutoClose(close_fraction_pct=0.0), 240.0,
                             tk.STATE_STOP_LOSS, contract)
    with pytest.raises(tk.TrackerError):
        tk.build_close_order(_pos(), tk.AutoClose(close_fraction_pct=150.0), 240.0,
                             tk.STATE_STOP_LOSS, contract)


def test_profit_drawdown_validation():
    from ibkr_agent import tracker as tk
    import pytest

    tk.validate(_pos(), tk.Targets(profit_drawdown_pct=30.0), 240.0)   # 合法
    for bad in (0.0, 100.0, -5.0):
        with pytest.raises(tk.TrackerError, match="利润回撤"):
            tk.validate(_pos(), tk.Targets(profit_drawdown_pct=bad), 240.0)


# ======================================================================
# 券商托管:hosted_plan 与利润回撤的停损价换算
# ======================================================================
def _auto_hosted(**kw):
    base = dict(enabled=True, host_at_broker=True)
    base.update(kw)
    return tk.AutoClose(**base)


def test_hosted_plan_is_empty_when_hosting_is_off():
    targets = tk.Targets(take_profit=250.0)
    assert tk.hosted_plan(long_stock(), targets, tk.AutoClose(enabled=True), 200.0) == []


def test_hosted_plan_static_targets_become_lmt_and_stp():
    targets = tk.Targets(take_profit=250.0, stop_loss=160.0)
    plan = tk.hosted_plan(long_stock(), targets, _auto_hosted(), 200.0)
    assert [p["kind"] for p in plan] == ["tp", "sl"]
    tp, sl = plan
    assert (tp["order_type"], tp["action"], tp["quantity"], tp["lmt_price"]) == \
        ("LMT", "SELL", 100, 250.0)
    assert (sl["order_type"], sl["aux_price"]) == ("STP", 160.0)


def test_hosted_trail_uses_native_trail_seeded_from_peak():
    # 峰值 260、回撤 5% → 初始停损 247:重启不把已锁住的利润放开
    plan = tk.hosted_plan(long_stock(), tk.Targets(trail_pct=5.0), _auto_hosted(), 260.0)
    assert plan[0]["kind"] == "trail"
    assert plan[0]["order_type"] == "TRAIL"
    assert plan[0]["trailing_percent"] == 5.0
    assert plan[0]["trail_stop_seed"] == 247.0


def test_profit_trail_stop_matches_evaluate_trigger_price():
    """托管停损价必须与软件盯盘的触发条件给出同一个价位——两条路径不同价,
    用户换一种模式就换一种风险,这是不可接受的。"""
    position = long_stock()          # 成本 180
    stop = tk.profit_trail_stop_price(position, 260.0, 30.0)
    assert stop == pytest.approx(236.0)   # 180 + 80×0.7
    # 在这个价位上,evaluate 恰好触发(<= 峰值利润×70%)
    result = tk.evaluate(position, tk.Targets(profit_drawdown_pct=30.0), 236.0, peak=260.0)
    assert result["state"] == tk.STATE_PROFIT_TRAIL
    # 高一分钱就不触发
    result = tk.evaluate(position, tk.Targets(profit_drawdown_pct=30.0), 236.01, peak=260.0)
    assert result["state"] == tk.STATE_HOLDING


def test_profit_trail_stop_requires_a_profitable_peak():
    assert tk.profit_trail_stop_price(long_stock(), 175.0, 30.0) is None
    plan = tk.hosted_plan(
        long_stock(), tk.Targets(profit_drawdown_pct=30.0), _auto_hosted(), 175.0
    )
    assert plan == []


def test_profit_trail_stop_for_shorts_is_a_buy_stop_above():
    position = short_stock()         # 成本 400,空头
    stop = tk.profit_trail_stop_price(position, 300.0, 30.0)
    assert stop == pytest.approx(330.0)   # 400 − 100×0.7
    plan = tk.hosted_plan(
        position, tk.Targets(profit_drawdown_pct=30.0), _auto_hosted(), 300.0
    )
    assert plan[0]["kind"] == "ptrail"
    assert (plan[0]["action"], plan[0]["order_type"], plan[0]["aux_price"]) == \
        ("BUY", "STP", 330.0)


def test_profit_trail_stop_divides_out_the_option_multiplier():
    # avgCost 550 是含乘数的整张成本,每股成本 5.50;峰值报价 8.00、回撤 50%
    position = long_option()
    stop = tk.profit_trail_stop_price(position, 8.0, 50.0)
    assert stop == pytest.approx(6.75)    # 5.5 + 2.5×0.5


def test_hosted_plan_applies_the_close_fraction_to_every_order():
    position = long_stock(quantity=101)
    targets = tk.Targets(take_profit=250.0, stop_loss=160.0)
    plan = tk.hosted_plan(position, targets, _auto_hosted(close_fraction_pct=50.0), 200.0)
    assert [p["quantity"] for p in plan] == [50, 50]


def test_hosted_prices_snap_to_cents():
    # 4 位小数的停损价会被 IBKR 110 拒掉;托管价一律收敛到 2 位
    plan = tk.hosted_plan(
        long_stock(), tk.Targets(take_profit=236.456789), _auto_hosted(), 200.0
    )
    assert plan[0]["lmt_price"] == 236.46


def test_hosted_needs_update_ignores_sub_cent_jitter():
    cur = {"quantity": 100, "aux_price": 236.0, "lmt_price": None, "trailing_percent": None}
    assert not tk.hosted_needs_update(cur, {**cur, "aux_price": 236.004})
    assert tk.hosted_needs_update(cur, {**cur, "aux_price": 236.01})
    assert tk.hosted_needs_update(cur, {**cur, "quantity": 50})
    assert tk.hosted_needs_update(cur, {**cur, "aux_price": None})


# ======================================================================
# 全时段:盘前/盘后照样平,平仓单自动转盘外限价
# ======================================================================
def test_extended_session_market_close_becomes_outside_rth_limit():
    """交易所盘外不收市价单:盘前触发的市价平仓要转成带盘外标志的限价单,让价方向不变。"""
    payload = tk.build_close_order(
        long_stock(), tk.AutoClose(enabled=True, order_type="MKT", slippage_pct=1.0), 200.0,
        tk.STATE_TAKE_PROFIT, CONTRACT, market_status="盘前",
    )
    assert payload["order"]["orderType"] == "LMT"
    assert payload["order"]["outsideRth"] is True
    assert payload["order"]["lmtPrice"] == 198.0        # 卖:让低
    assert "盘外限价" in payload["intent_summary"]


def test_extended_session_limit_close_keeps_limit_and_flags_outside_rth():
    payload = tk.build_close_order(
        short_stock(), tk.AutoClose(enabled=True, order_type="LMT", slippage_pct=1.0), 400.0,
        tk.STATE_STOP_LOSS, CONTRACT, market_status="盘后",
    )
    assert payload["order"]["orderType"] == "LMT"
    assert payload["order"]["outsideRth"] is True
    assert payload["order"]["lmtPrice"] == 404.0        # 买:让高


def test_regular_and_closed_sessions_are_unchanged():
    for status in ("盘中", "休市"):
        payload = tk.build_close_order(
            long_stock(), tk.AutoClose(enabled=True), 200.0, tk.STATE_TAKE_PROFIT, CONTRACT,
            market_status=status,
        )
        assert payload["order"]["orderType"] == "MKT"
        assert payload["order"]["outsideRth"] is False


def test_extended_session_without_price_is_refused():
    with pytest.raises(tk.TrackerError, match="盘外只能限价平仓"):
        tk.build_close_order(
            long_stock(), tk.AutoClose(enabled=True), None, tk.STATE_STOP_LOSS, CONTRACT,
            market_status="盘前",
        )


def test_extended_close_payload_passes_the_order_schema():
    from ibkr_agent.models import parse_llm_payload

    payload = tk.build_close_order(
        long_stock(), tk.AutoClose(enabled=True), 200.0, tk.STATE_STOP_LOSS, CONTRACT,
        market_status="盘后",
    )
    parsed = parse_llm_payload({"orders": [payload], "rejections": []})
    assert parsed.orders and not parsed.rejections
    assert parsed.orders[0].order.outsideRth is True


def test_close_limit_price_snaps_to_tick_in_the_concession_direction():
    """TWS 对不合最小跳动的限价直接拒单;取整必须仍朝让价方向。"""
    assert tk.close_limit_price(long_stock(), 324.7, 0.3) == 323.72      # 323.7259 → 向下
    assert tk.close_limit_price(short_stock(), 324.7, 0.3) == 325.68     # 325.6741 → 向上
    assert tk.close_limit_price(long_stock(), 200.0, 1.0) == 198.0       # 已在跳动上不动
    opt = tk.Position(account="模拟", symbol="SPX", sec_type="OPT", quantity=1, avg_cost=550.0,
                      multiplier=100.0, currency="USD", market_price=5.5)
    assert tk.close_limit_price(opt, 5.5, 1.0) == 5.4                    # 5.445 → 0.05 跳动向下


def test_close_order_uses_a_clean_smart_contract_for_stocks():
    """持仓行里的合约(NASDAQ / NMS / multiplier="1")原样下单会被 TWS 以 200 拒掉。"""
    raw = {"secType": "STK", "symbol": "AAPL", "exchange": "NASDAQ", "currency": "USD",
           "lastTradeDateOrContractMonth": None, "strike": None, "right": None,
           "multiplier": "1", "tradingClass": "NMS"}
    payload = tk.build_close_order(long_stock(), tk.AutoClose(enabled=True), 200.0,
                                   tk.STATE_TAKE_PROFIT, raw)
    assert payload["contract"] == {"secType": "STK", "symbol": "AAPL",
                                   "exchange": "SMART", "currency": "USD"}
    opt = {"secType": "OPT", "symbol": "SPX", "exchange": "CBOE", "currency": "USD",
           "lastTradeDateOrContractMonth": "20260903", "strike": 7600.0, "right": "P",
           "multiplier": "100", "tradingClass": "SPXW", "conId": None}
    assert "conId" not in tk.close_contract(opt)
    assert tk.close_contract(opt)["tradingClass"] == "SPXW"


# ---------------------------------------------------------------- 分档利润回撤
def test_tiered_drawdown_picks_the_highest_matching_tier():
    """档位按浮盈倍数选:取所有 above ≤ 当前倍数 里最高的那一档。"""
    tiers = [{"above": 0, "pct": 40}, {"above": 1, "pct": 30}, {"above": 3, "pct": 20}]
    tg = tk.Targets(profit_drawdown_tiers=tiers)
    basis = 225.0                                   # D=2.25、1 张、乘数 100
    assert tk.drawdown_threshold(tg, 75.0, basis) == 40      # 浮盈 0.33×D
    assert tk.drawdown_threshold(tg, 225.0, basis) == 30     # 正好 1×D:进中档
    assert tk.drawdown_threshold(tg, 525.0, basis) == 30     # 2.33×D
    assert tk.drawdown_threshold(tg, 775.0, basis) == 20     # 3.44×D
    # 档位乱序也要对
    assert tk.drawdown_threshold(tk.Targets(profit_drawdown_tiers=list(reversed(tiers))),
                                 525.0, basis) == 30
    # 没配分档就是那个固定值;两个都没配就是 None
    assert tk.drawdown_threshold(tk.Targets(profit_drawdown_pct=25.0), 525.0, basis) == 25
    assert tk.drawdown_threshold(tk.Targets(), 525.0, basis) is None


def test_tiered_drawdown_tightens_late_in_the_day():
    tg = tk.Targets(profit_drawdown_tiers=[{"above": 0, "pct": 30}],
                    profit_drawdown_late={"after": "15:00", "factor": 0.5})
    assert tk.drawdown_threshold(tg, 525.0, 225.0, 14 * 60 + 59) == 30
    assert tk.drawdown_threshold(tg, 525.0, 225.0, 15 * 60) == 15
    assert tk.drawdown_threshold(tg, 525.0, 225.0, None) == 30      # 不给时刻就不收紧


def test_live_tiers_and_replay_tiers_agree_on_the_same_trigger_price():
    """实盘按"浮盈/成本"选档、回放按"浮盈/D"选档——同一张组合必须算出同一个触发价。

    两者只差 数量×乘数 这个公因子;差一点就意味着界面上看到的和真实发单的不是一回事。
    """
    from ibkr_agent import flyexit as fx

    d, mult, qty = 2.25, 100.0, 1.0
    pos = tk.Position(account="模拟", symbol="SPX", sec_type="BAG",
                      quantity=qty, avg_cost=d * mult, multiplier=mult)
    tg = tk.Targets(profit_drawdown_tiers=fx.drawdown_tiers(None),
                    profit_drawdown_late=fx.drawdown_late(None))
    basis = tk.cost_basis(pos)
    for peak_price, hhmm in ((3.0, "11:00"), (4.5, "11:00"), (7.5, "11:00"),
                             (10.0, "11:00"), (7.5, "15:30")):
        minute = fx.minutes_of(hhmm)
        peak_pts = peak_price - d
        pct = tk.drawdown_threshold(tg, peak_pts * mult * qty, basis, minute)
        live = d + peak_pts * (1 - pct / 100.0)
        assert live == pytest.approx(fx.trail_stop(peak_pts, d, minute, fx.params_from(None)))
    # 09-03 那张单:浮盈峰值 5.25 点 → 30% 档 → 5.925 触发
    assert tk.drawdown_threshold(tg, 5.25 * mult, basis, fx.minutes_of("11:29")) == 30


def test_evaluate_uses_the_tier_in_force_and_reports_it():
    tg = tk.Targets(profit_drawdown_tiers=[{"above": 0, "pct": 40}, {"above": 3, "pct": 20}])
    pos = tk.Position(account="模拟", symbol="SPX", sec_type="BAG", quantity=1.0,
                      avg_cost=225.0, multiplier=100.0)
    # 峰值 8.0(浮盈 2.56×D → 40% 档):跌到 5.7 时回撤 (575-345)/575 = 40%,正好触发
    out = tk.evaluate(pos, tg, 5.70, peak=8.00)
    assert out["profit_drawdown_threshold"] == 40 and out["state"] == tk.STATE_PROFIT_TRAIL
    assert "阈值 40%" in out["reason"]
    # 同样的峰值只跌到 6.5:回撤 26% < 40%,继续持有
    assert tk.evaluate(pos, tg, 6.50, peak=8.00)["state"] == tk.STATE_HOLDING
    # 浮盈更大时换到 20% 档:峰值 12.0(4.33×D),浮盈 975 让掉 20% → 10.05 触发
    assert tk.evaluate(pos, tg, 10.10, peak=12.00)["state"] == tk.STATE_HOLDING
    out2 = tk.evaluate(pos, tg, 10.00, peak=12.00)
    assert out2["profit_drawdown_threshold"] == 20 and out2["state"] == tk.STATE_PROFIT_TRAIL
