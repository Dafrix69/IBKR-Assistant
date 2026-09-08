"""组合(蝴蝶)的到价自动平仓:从轮询到真的发出那张 BAG 单。

纯函数层(腿反转、限价、闸门、分档)在 test_legs / test_tracker 里已经逐个盯住了。
这里盯的是**集成**——把它们串起来跑一遍 `engine.poll_trackers(NOON)`,因为串起来才会
暴露只有真机才碰得到的那类问题(2026-09-04 就是这么发现 `unrealizedPNL` 拼错的:
纯函数全绿,账户一有持仓就整个炸)。

四件必须成立的事:
  * 触发之后**真的发单**,而且发的是腿方向全部反转的 BAG 限价单;
  * 分档回撤在集成层生效——阈值随浮盈换档,不是配置里那个静态值;
  * 实盘账户没开 allow_combo_live 时**发不出去**,而且当场告诉用户;
  * 发过一次就落闩,下一轮不会再发第二枪(重复平仓 = 反向开仓)。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from datetime import datetime

from conftest import make_settings
from ibkr_agent import flyexit as fx
from ibkr_agent.config import ET
from ibkr_agent import tracker as tk
from ibkr_agent.broker import PlacementResult
from ibkr_agent.engine import TradingEngine
from ibkr_agent.notify import Notifier
from ibkr_agent.store import TradeStore

EXPIRY = "20260901"
STRIKES = (7600.0, 7615.0, 7630.0)
#: 盘中的一刻。不传的话 poll_trackers 用真实当下,半夜跑测试全被"休市"闸门拦掉。
NOON = datetime(2026, 8, 14, 10, 32, tzinfo=ET)
#: 15:00 之后:分档回撤的阈值要减半
LATE = datetime(2026, 8, 14, 15, 30, tzinfo=ET)


def leg_row(strike: float, qty: float, cost: float, price: Optional[float], account="模拟"):
    contract = {"secType": "OPT", "symbol": "SPX", "lastTradeDateOrContractMonth": EXPIRY,
                "strike": strike, "right": "P", "multiplier": "100"}
    ident = tk.leg_of(contract)
    return {"key": tk.position_key(account, "SPX", "OPT", ident), "account": account,
            "symbol": "SPX", "sec_type": "OPT", "leg": ident,
            "label": tk.position_label("SPX", "OPT", contract), "quantity": qty,
            "avg_cost": cost, "multiplier": 100.0, "currency": "USD",
            "market_price": price, "market_value": None, "unrealized_pnl": None,
            "contract": contract}


#: 每条腿的成本(IBKR 口径,含乘数)。净成本 = 300 − 2×200 + 325 = 225,即 D = 2.25。
#: 组合的净成本是按比例加权的,不是三条腿一加了事——这里写错会让浮盈倍数整个跑偏。
LEG_COSTS = (300.0, 200.0, 325.0)


def butterfly_legs(prices=(1.20, 0.90, 0.70), account="模拟"):
    """买入看跌蝶 +1/−2/+1,每组净成本 2.25(= D),净价由 prices 决定。"""
    return [
        leg_row(STRIKES[0], 1.0, LEG_COSTS[0], prices[0], account),
        leg_row(STRIKES[1], -2.0, LEG_COSTS[1], prices[1], account),
        leg_row(STRIKES[2], 1.0, LEG_COSTS[2], prices[2], account),
    ]


class FakeRouter:
    """只记账不发单的 router。place() 把 approved 原样留下来给断言看。"""

    SUPPORTS_HOSTED_CLOSE = False
    BROKER = "ibkr"

    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows
        self.placed: List[Any] = []

    def positions(self):
        return list(self.rows)

    def index_price(self, symbol):          # 组合不走这条,留着免得 AttributeError
        return None

    def place(self, record_id, approved):
        self.placed.append(approved)
        return PlacementResult(record_id=record_id, order_id=900 + len(self.placed),
                               status="Submitted")


def build_engine(tmp_path, rows, policies=None, hours=None):
    settings = make_settings(
        policies={"auto_execute": True, **(policies or {})},
        storage={"db_path": str(tmp_path / "combo.db")},
    )
    router = HoursRouter(rows, *hours) if hours else FakeRouter(rows)
    engine = TradingEngine(settings, parser=object(), store=TradeStore(settings.db_path),
                           notifier=Notifier(enabled=False), router=router)
    return engine, router


def combo_key(rows):
    return [r for r in tk.with_combos(rows) if r["sec_type"] == "BAG"][0]["key"]


def add_combo_track(engine, rows, targets, account="模拟"):
    fly = [r for r in tk.with_combos(rows) if r["sec_type"] == "BAG"][0]
    return engine.store.add_track({
        "account": account, "symbol": "SPX", "sec_type": "BAG", "leg": fly["leg"],
        "contract": fly["contract"], "targets": targets,
        "auto_close": {"enabled": True, "order_type": "MKT", "slippage_pct": 5.0},
        "peak": None,
    })


# ---------------------------------------------------------------- 完整链路
def test_butterfly_take_profit_places_a_reversed_bag_order(tmp_path):
    """止盈到价 → 发出一张腿方向全部反转的 BAG 限价单(MKT 被强制转 LMT)。"""
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))          # 净价 = 1.20−1.80+0.70 = 0.10
    engine, router = build_engine(tmp_path, rows)
    add_combo_track(engine, rows, {"take_profit": 0.05})      # 现价 0.10 已越过

    out = engine.poll_trackers(NOON)
    assert len(out["fired"]) == 1, out
    assert not out["blocked"]

    approved = router.placed[0]
    contract, order = approved.order.contract, approved.order.order
    assert contract.secType == "BAG" and contract.combo_strategy == "BUTTERFLY"
    # 持仓 +1/−2/+1 → 平仓 SELL 1 / BUY 2 / SELL 1
    assert [(l.action, l.ratio, l.strike) for l in contract.legs] == [
        ("SELL", 1, 7600.0), ("BUY", 2, 7615.0), ("SELL", 1, 7630.0)]
    assert order.action == "SELL"                  # 用户口径:卖出组合
    assert order.orderType == "LMT"                # 组合绝不发市价单
    assert order.totalQuantity == 1
    # 提交给 IBKR 的带符号净价必须是负的(平掉借方蝶 = 收权利金)
    from ibkr_agent.broker import bag_signed_limit
    assert bag_signed_limit(order.action, order.lmtPrice) < 0


def test_tiered_drawdown_drives_the_combo_exit(tmp_path):
    """分档在集成层生效:阈值随浮盈换档,触发理由里写的是当时那一档。"""
    # 峰值净价 8.00(浮盈 5.75 = 2.56×D → 30% 档),现价 5.90 已跌破 5.925
    rows = butterfly_legs(prices=(3.00, 0.30, 3.50))          # 净价 = 3.00−0.60+3.50 = 5.90
    engine, router = build_engine(tmp_path, rows)
    track = add_combo_track(engine, rows, {
        "profit_drawdown_tiers": fx.drawdown_tiers(None),
        "profit_drawdown_late": fx.drawdown_late(None),
    })
    engine.store.update_track(track["id"], peak=8.00)

    out = engine.poll_trackers(NOON)
    assert len(out["fired"]) == 1, out
    fired = out["fired"][0]
    assert fired["state"] == tk.STATE_PROFIT_TRAIL
    assert "阈值 30%" in fired["reason"], fired["reason"]
    assert router.placed and router.placed[0].order.order.orderType == "LMT"
    # 差一点点就不该动:净价 6.30 还在触发价 6.275 之上
    rows2 = butterfly_legs(prices=(3.00, 0.10, 3.50))         # 净价 6.30
    engine2, router2 = build_engine(tmp_path / "b", rows2)
    t2 = add_combo_track(engine2, rows2, {"profit_drawdown_tiers": fx.drawdown_tiers(None)})
    engine2.store.update_track(t2["id"], peak=8.00)
    out2 = engine2.poll_trackers(NOON)
    assert out2["fired"] == [] and router2.placed == []


def test_late_session_halves_the_drawdown_tier(tmp_path):
    """同一个价位,盘中不动、15:00 之后就该走——尾盘阈值减半。

    浮盈高水位 5.75 点(2.56×D,30% 档):盘中触发价 2.25+5.75×0.70 = 6.275,
    15:00 之后档位减半到 15%,触发价抬到 2.25+5.75×0.85 = 7.1375。净价 7.00 卡在中间。
    """
    rows = butterfly_legs(prices=(3.00, 0.25, 4.50))          # 净价 = 3.00−0.50+4.50 = 7.00
    targets = {"profit_drawdown_tiers": fx.drawdown_tiers(None),
               "profit_drawdown_late": fx.drawdown_late(None)}

    engine, router = build_engine(tmp_path, rows)
    t = add_combo_track(engine, rows, targets)
    engine.store.update_track(t["id"], peak=8.00)
    assert engine.poll_trackers(NOON)["fired"] == []          # 盘中:7.00 > 6.275,继续拿着
    assert router.placed == []

    engine2, router2 = build_engine(tmp_path / "late", rows)
    t2 = add_combo_track(engine2, rows, targets)
    engine2.store.update_track(t2["id"], peak=8.00)
    out = engine2.poll_trackers(LATE)                         # 15:30:7.00 < 7.1375,该走
    assert len(out["fired"]) == 1, out
    assert "阈值 15%" in out["fired"][0]["reason"], out["fired"][0]["reason"]
    assert len(router2.placed) == 1


def test_live_account_needs_the_combo_switch(tmp_path):
    """实盘账户没开 allow_combo_live:算得出该平,但发不出去,而且当场说。"""
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70), account="主账户")
    engine, router = build_engine(tmp_path, rows, {"allow_live_trading": True})
    add_combo_track(engine, rows, {"take_profit": 0.05}, account="主账户")

    out = engine.poll_trackers(NOON)
    assert out["fired"] == [] and router.placed == []
    assert out["blocked"] and tk.BLOCK_COMBO_LIVE in out["blocked"][0]["blockers"]

    # 开了开关就放行
    engine2, router2 = build_engine(tmp_path / "c", rows,
                                    {"allow_live_trading": True, "allow_combo_live": True})
    add_combo_track(engine2, rows, {"take_profit": 0.05}, account="主账户")
    out2 = engine2.poll_trackers(NOON)
    assert len(out2["fired"]) == 1 and len(router2.placed) == 1


def test_combo_fires_only_once(tmp_path):
    """发过一次就落闩:重复平仓等于反向开仓。"""
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    engine, router = build_engine(tmp_path, rows)
    add_combo_track(engine, rows, {"take_profit": 0.05})

    assert len(engine.poll_trackers(NOON)["fired"]) == 1
    again = engine.poll_trackers(NOON)
    assert again["fired"] == [] and len(router.placed) == 1


def test_combo_without_a_net_price_does_not_fire(tmp_path):
    """任何一条腿没报价 → 组合净价是 None → 不判断、更不发单。"""
    rows = butterfly_legs(prices=(1.20, None, 0.70))
    engine, router = build_engine(tmp_path, rows)
    add_combo_track(engine, rows, {"take_profit": 0.05})

    out = engine.poll_trackers(NOON)
    assert out["fired"] == [] and router.placed == []
    assert out["rows"][0]["state"] == tk.STATE_HOLDING


# ---------------------------------------------------------------- 合约时段
#: IBKR 对 SPXW(0DTE)实报的时段(2026-09-04 纸面账户实测)。时区是 US/Central,
#: 换成美东就是「20:15–次日 09:25 隔夜」+「09:30–16:00 常规」。
SPXW_HOURS = "20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED"
SPXW_LIQUID = "20260904:0830-20260904:1500;20260905:CLOSED"
SPXW_TZ = "US/Central"

#: 美东 01:10——正股表判"休市",而 SPX 期权此刻在隔夜段里,能交易
OVERNIGHT = datetime(2026, 9, 4, 1, 10, tzinfo=ET)


class HoursRouter(FakeRouter):
    """会报合约时段的 router(真 router 走 reqContractDetails,这里直接给表)。"""

    def __init__(self, rows, hours=SPXW_HOURS, liquid=SPXW_LIQUID, tz=SPXW_TZ):
        super().__init__(rows)
        self._hours = (hours, liquid, tz)
        self.hours_calls = 0

    def contract_hours(self, row, account):
        self.hours_calls += 1
        return self._hours


def test_option_hours_beat_the_stock_calendar_overnight(tmp_path):
    """美东 01:10:正股表说休市,但 SPX 期权在隔夜段里——必须照样能平。

    这是 2026-09-04 实测发现的:`Settings.market_status` 是照美股正股写死的
    (4:00/9:30/16:00/20:00),用它判期权会把 20:15–次日 09:25 整段当成休市,
    0DTE 蝶在隔夜完全不设防。
    """
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    settings = make_settings(policies={"auto_execute": True},
                             storage={"db_path": str(tmp_path / "combo.db")})
    # 先确认正股表在这一刻确实说"休市"——不然这条测试测了个寂寞
    assert settings.market_status(OVERNIGHT) == "休市"

    router = HoursRouter(rows)
    engine = TradingEngine(settings, parser=object(), store=TradeStore(settings.db_path),
                           notifier=Notifier(enabled=False), router=router)
    add_combo_track(engine, rows, {"take_profit": 0.05})

    out = engine.poll_trackers(OVERNIGHT)
    assert len(out["fired"]) == 1, out
    assert router.hours_calls >= 1                    # 真的去问了合约时段
    assert router.placed[0].order.order.outsideRth is True   # 隔夜 = 盘外,要打标志


def test_option_hours_still_close_when_the_contract_says_closed(tmp_path):
    """合约说 CLOSED 就是不能交易——放宽的是"按合约算",不是"一律放行"。"""
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    settings = make_settings(policies={"auto_execute": True},
                             storage={"db_path": str(tmp_path / "combo.db")})
    router = HoursRouter(rows, hours="20260905:CLOSED;20260906:CLOSED", liquid="")
    engine = TradingEngine(settings, parser=object(), store=TradeStore(settings.db_path),
                           notifier=Notifier(enabled=False), router=router)
    add_combo_track(engine, rows, {"take_profit": 0.05})

    out = engine.poll_trackers(OVERNIGHT)
    assert out["fired"] == [] and router.placed == []
    assert "当前时段不能交易" in out["blocked"][0]["blockers"][0]


def test_missing_hours_falls_back_to_the_stock_calendar(tmp_path):
    """查不到时段就退回正股表,而不是把仓位卡死在"休市"或一路放行。"""
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    settings = make_settings(policies={"auto_execute": True},
                             storage={"db_path": str(tmp_path / "combo.db")})
    router = HoursRouter(rows, hours="", liquid="", tz="")
    engine = TradingEngine(settings, parser=object(), store=TradeStore(settings.db_path),
                           notifier=Notifier(enabled=False), router=router)
    add_combo_track(engine, rows, {"take_profit": 0.05})

    assert engine.poll_trackers(OVERNIGHT)["fired"] == []      # 正股表:休市
    assert len(engine.poll_trackers(NOON)["fired"]) == 1       # 正股表:盘中


# ---------------------------------------------------------------- 成交闭环
class _NS:
    """回报对象的替身(ib_insync 的 Trade/Fill 只是属性袋)。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def bag_fill_reports(order_id, perm_id=7788, price=0.05):
    """IBKR 对一张成交的 BAG 单会回:1 条 BAG 订单状态 + 每条腿一条成交。

    腿的 side 是**平仓方向**的:买入蝶 +1/−2/+1 平掉,就是卖 1 / 买 2 / 卖 1。
    """
    trade = _NS(
        order=_NS(permId=perm_id, orderId=order_id),
        orderStatus=_NS(status="Filled", filled=1, remaining=0),
        contract=_NS(symbol="SPX"),
    )
    legs = [
        ("e-1", "SLD", 1.0, 1.20, 7600.0),
        ("e-2", "BOT", 2.0, 0.90, 7615.0),
        ("e-3", "SLD", 1.0, 0.70, 7630.0),
    ]
    fills = [
        _NS(execution=_NS(execId=eid, time="2026-08-14T10:33:00", price=px, shares=qty,
                          side=side, acctNumber="DU7654321"))
        for eid, side, qty, px, _k in legs
    ]
    return trade, fills


def test_combo_close_settles_and_the_track_stops_when_the_position_is_gone(tmp_path):
    """平仓单成交之后的收尾:记录落终态、三条腿成交都入库、持仓没了就停止追踪。

    这一段以前没测过。发单只是开始——回报进不来、记录停在 Submitted、或者持仓已经平掉
    追踪还在盯着,每一样都会让人以为"还有保护"而其实没有。
    """
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    engine, router = build_engine(tmp_path, rows)
    track = add_combo_track(engine, rows, {"take_profit": 0.05})

    fired = engine.poll_trackers(NOON)["fired"]
    assert len(fired) == 1
    record_id = fired[0]["record_id"]
    order_id = fired[0]["order_id"]

    # 追踪已落闩:即使还没收到回报,也绝不会再发第二枪
    after_fire = engine.store.get_track(track["id"])
    assert after_fire["fired_at"] and after_fire["enabled"] is False
    assert after_fire["fired_state"] == tk.STATE_TAKE_PROFIT

    # 券商回报进来:BAG 状态 + 三条腿成交
    trade, fills = bag_fill_reports(order_id)
    engine._index_placement(record_id, PlacementResult(record_id=record_id, order_id=order_id,
                                                       perm_id=7788, status="Submitted"))
    for fill in fills:
        engine._on_exec_details(trade, fill)
    engine._on_order_status(trade)

    record = engine.store.get_record(record_id)
    assert record["final_status"] == "filled"
    assert len(record["ibkr"]["fills"]) == 3            # 三条腿各一条,不是一条 BAG 行
    assert {f["exec_id"] for f in record["ibkr"]["fills"]} == {"e-1", "e-2", "e-3"}
    assert record["contract"]["secType"] == "BAG"

    # 下一轮:三条腿都平掉了,持仓消失 → 追踪停止,并且不会因为"找不到持仓"而发单
    router.rows = []
    out = engine.poll_trackers(NOON)
    assert out["fired"] == [] and len(router.placed) == 1
    assert out["rows"][0]["state"] == "closed"
    assert engine.store.get_track(track["id"])["enabled"] is False


def test_partially_filled_combo_is_not_reported_as_filled(tmp_path):
    """组合只成交了一部分:记录必须是 partially_filled。

    对蝶式尤其要紧——部分成交意味着**腿不平衡**,剩下的是一个谁也没打算持有的结构,
    把它记成"已成交"会让人以为仓位已经干净了。
    """
    rows = butterfly_legs(prices=(1.20, 0.90, 0.70))
    engine, router = build_engine(tmp_path, rows)
    add_combo_track(engine, rows, {"take_profit": 0.05})
    fired = engine.poll_trackers(NOON)["fired"][0]

    trade = _NS(
        order=_NS(permId=9001, orderId=fired["order_id"]),
        orderStatus=_NS(status="Filled", filled=1, remaining=1),   # 还剩一组没成
        contract=_NS(symbol="SPX"),
    )
    engine._index_placement(record_id := fired["record_id"],
                            PlacementResult(record_id=record_id, order_id=fired["order_id"],
                                            perm_id=9001, status="Submitted"))
    engine._on_order_status(trade)
    assert engine.store.get_record(record_id)["final_status"] == "partially_filled"


# ---------------------------------------------------------------- 下单侧的时段
def test_option_order_is_not_told_market_is_closed_during_the_overnight_session(tmp_path):
    """隔夜下期权单:不能再拿正股日历告诉用户"当前休市"。

    2026-09-04 实测:美东 01:2x 提交一张当日到期的 SPX 蝶,界面回「当前休市,订单将挂到
    下一个交易时段」——而 IBKR 报的 SPXW 那时正在隔夜段(20:15–次日 09:25)里,能成交。
    下单与平仓必须用同一张时段表,否则会出现"能平不能开"这种荒唐结果。
    """
    from ibkr_agent.models import ContractSpec, Leg, OrderSpec, ParsedOrder
    from ibkr_agent.validator import Validator

    settings = make_settings(policies={"auto_execute": True},
                             storage={"db_path": str(tmp_path / "v.db")})
    assert settings.market_status(OVERNIGHT) == "休市"        # 正股表这么说

    fly = ContractSpec(
        secType="BAG", symbol="SPX", exchange="SMART", currency="USD",
        combo_strategy="BUTTERFLY",
        legs=[Leg(action="BUY", ratio=1, lastTradeDateOrContractMonth="20260904",
                  strike=7700.0, right="P", tradingClass="SPXW"),
              Leg(action="SELL", ratio=2, lastTradeDateOrContractMonth="20260904",
                  strike=7720.0, right="P", tradingClass="SPXW"),
              Leg(action="BUY", ratio=1, lastTradeDateOrContractMonth="20260904",
                  strike=7740.0, right="P", tradingClass="SPXW")],
    )
    order = ParsedOrder(
        intent_summary="买入 SPX 蝶", contract=fly, execution_type="IMMEDIATE", trigger=None,
        account="模拟",
        order=OrderSpec(action="BUY", orderType="LMT", totalQuantity=1,
                        price_mode="EXPLICIT", lmtPrice=2.25, tif="DAY", outsideRth=True),
        reason="测试", confidence=1.0, warnings=[],
    )

    # 不给时段函数:退回正股表 → 老行为(告诉用户休市)
    plain = Validator(settings, OVERNIGHT)
    assert plain.status_for(order) == "休市"

    # 给了合约时段:隔夜段判"盘外",可交易
    smart = Validator(settings, OVERNIGHT, market_status_fn=lambda o: "盘外")
    assert smart.status_for(order) == "盘外"
    out = smart.validate_all([order])
    assert not out.rejected, [r.issues for r in out.rejected]
    joined = " ".join(w for a in out.approved for w in a.warnings)
    assert "当前休市" not in joined
    # 盘外只收限价单:限价单放行,市价单硬拒(和盘前/盘后同一套规矩)
    mkt = order.model_copy(update={
        "order": order.order.model_copy(update={"orderType": "MKT", "lmtPrice": None,
                                                "price_mode": "AUTO_MID"})})
    rejected = Validator(settings, OVERNIGHT, market_status_fn=lambda o: "盘外").validate_all([mkt])
    assert rejected.rejected and any(
        "只接受限价单" in i.message for r in rejected.rejected for i in r.issues)


def test_stock_orders_still_use_the_stock_calendar(tmp_path):
    """正股不受影响:合约时段那条路只对期权/组合生效。"""
    from ibkr_agent.validator import Validator

    settings = make_settings(storage={"db_path": str(tmp_path / "v.db")})
    engine, _router = build_engine(tmp_path, [])
    from conftest import stock_order
    from ibkr_agent.models import parse_llm_payload

    order = parse_llm_payload({"orders": [stock_order()], "rejections": []}).orders[0]
    assert engine._order_market_status(order, OVERNIGHT) is None   # 不查合约时段
    assert Validator(settings, OVERNIGHT).status_for(order) == "休市"


# ---------------------------------------------------------------- 自动盘外
def _fly_order(outside=False, order_type="LMT"):
    from ibkr_agent.models import ContractSpec, Leg, OrderSpec, ParsedOrder

    fly = ContractSpec(
        secType="BAG", symbol="SPX", exchange="SMART", currency="USD",
        combo_strategy="BUTTERFLY",
        legs=[Leg(action="BUY", ratio=1, lastTradeDateOrContractMonth="20260904",
                  strike=7610.0, right="P", tradingClass="SPXW"),
              Leg(action="SELL", ratio=2, lastTradeDateOrContractMonth="20260904",
                  strike=7620.0, right="P", tradingClass="SPXW"),
              Leg(action="BUY", ratio=1, lastTradeDateOrContractMonth="20260904",
                  strike=7630.0, right="P", tradingClass="SPXW")],
    )
    return ParsedOrder(
        intent_summary="买入 SPX 蝶", contract=fly, execution_type="IMMEDIATE", trigger=None,
        account="模拟",
        order=OrderSpec(action="BUY", orderType=order_type, totalQuantity=1,
                        price_mode="EXPLICIT",
                        lmtPrice=2.25 if order_type == "LMT" else None,
                        tif="DAY", outsideRth=outside),
        reason="测试", confidence=1.0, warnings=[],
    )


def test_outside_rth_is_set_automatically_in_a_tradable_off_hours_session(tmp_path):
    """盘外时段不该逼用户每次手写「盘外」——合约本来就能交易,标志该自动带上。

    2026-09-04 实测:不带 outsideRth 的单子,IBKR 只会挂着,TWS 原话是
    「您的委托单在 08:30:00 美国/中部前不会被下达交易所」。而 SPX 期权那时正在
    隔夜段里能成交,用户按下发送要的是现在就成交。
    """
    engine, router = build_engine(tmp_path, [], hours=(SPXW_HOURS, SPXW_LIQUID, SPXW_TZ))
    order = _fly_order(outside=False)
    assert engine.settings.market_status(OVERNIGHT) == "休市"      # 正股表这么说

    out = engine._auto_outside_rth([order], OVERNIGHT)
    assert out[0].order.outsideRth is True
    assert any("已自动打上盘外标志" in w for w in out[0].warnings)

    # 显式写了的不动,也不重复加警告
    explicit = engine._auto_outside_rth([_fly_order(outside=True)], OVERNIGHT)
    assert explicit[0].order.outsideRth is True
    assert not any("已自动打上盘外标志" in w for w in explicit[0].warnings)

    # 市价单不自动打:盘外只收限价单,打上反而从"挂到开盘"变成"当场被拒"
    mkt = engine._auto_outside_rth([_fly_order(outside=False, order_type="MKT")], OVERNIGHT)
    assert mkt[0].order.outsideRth is False


def test_auto_outside_rth_can_be_switched_off(tmp_path):
    """盘外流动性薄,这个行为必须可关。"""
    engine, _r = build_engine(tmp_path, [], {"auto_outside_rth": False},
                              hours=(SPXW_HOURS, SPXW_LIQUID, SPXW_TZ))
    out = engine._auto_outside_rth([_fly_order(outside=False)], OVERNIGHT)
    assert out[0].order.outsideRth is False


def test_regular_session_orders_are_untouched(tmp_path):
    """盘中不该乱打标志——那是"要在盘外成交"的意思,盘中没有这个语义。"""
    engine, _r = build_engine(tmp_path, [], hours=(SPXW_HOURS, SPXW_LIQUID, SPXW_TZ))
    noon_et = datetime(2026, 9, 4, 10, 30, tzinfo=ET)         # 常规时段
    out = engine._auto_outside_rth([_fly_order(outside=False)], noon_et)
    assert out[0].order.outsideRth is False
