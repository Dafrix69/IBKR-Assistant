"""券商托管的止盈/止损:engine.sync_hosted 的对账循环。

托管单是真单——挂错、漏挂、重复挂、成交后不落闩,每一样都是真金白银的事故。
所以这里盯的是:
  * 挂:该挂的每一张都带 orderRef(trk:<id>:<kind>)与 OCA 组;
  * 改:峰值前进后,动态停损价棘轮上移(改单,不是撤了重挂);
  * 撤:托管关闭 / 闸门落下 / 持仓消失时,券商侧不留孤儿单;
  * 闩:托管单成交 → 追踪落闩,软件永不再发第二枪;
  * 认领:重启后按 orderRef 把还挂着的单认回来,而不是再挂一遍;
  * 分工:host_at_broker 开着时,软件盯盘那条路只算不发(双重平仓=反向开仓)。
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from conftest import make_settings
from ibkr_agent.engine import TradingEngine
from ibkr_agent.notify import Notifier
from ibkr_agent.store import TradeStore


class FakeHostedRouter:
    SUPPORTS_HOSTED_CLOSE = True
    BROKER = "ibkr"

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None):
        self.rows = rows or []
        self.placed: List[Dict[str, Any]] = []
        self.modified: List[Dict[str, Any]] = []
        self.cancelled: List[int] = []
        self.open_rows: List[Dict[str, Any]] = []
        self._next_id = 500

    def positions(self):
        return self.rows

    def place_hosted(self, account, contract_spec, item, oca_group, order_ref):
        self._next_id += 1
        self.placed.append({"item": dict(item), "oca": oca_group, "ref": order_ref,
                            "account": account.alias, "order_id": self._next_id})
        return {"order_id": self._next_id, "perm_id": None, "status": "PreSubmitted"}

    def modify_hosted(self, order_id, item):
        self.modified.append({"order_id": order_id, "item": dict(item)})
        return True

    def cancel_hosted(self, order_id):
        self.cancelled.append(order_id)
        return True

    def list_hosted_open(self, ref_prefix="trk:"):
        return list(self.open_rows)


def position_row(**kw):
    base = dict(
        account="模拟", symbol="NVDA", sec_type="STK", quantity=100.0,
        avg_cost=180.0, multiplier=1.0, currency="USD",
        market_price=220.0, market_value=22000.0, unrealized_pnl=4000.0,
        contract={"secType": "STK", "symbol": "NVDA", "exchange": "SMART",
                  "currency": "USD"},
    )
    base.update(kw)
    base["key"] = "%s|%s|%s" % (base["account"], base["symbol"], base["sec_type"])
    return base


def hosted_engine(tmp_path, router, auto_execute=True):
    settings = make_settings(
        policies={"auto_execute": auto_execute},
        storage={"db_path": str(tmp_path / "hosted.db")},
    )
    return TradingEngine(
        settings, parser=object(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )


def add_hosted_track(engine, **kw):
    track = {
        "account": "模拟", "symbol": "NVDA", "sec_type": "STK",
        "contract": {"secType": "STK", "symbol": "NVDA", "exchange": "SMART",
                     "currency": "USD"},
        "targets": {"take_profit": 250.0, "stop_loss": 160.0},
        "auto_close": {"enabled": True, "host_at_broker": True},
        "peak": 220.0,
    }
    track.update(kw)
    return engine.store.add_track(track)


def filled_trade(order_id):
    return SimpleNamespace(
        order=SimpleNamespace(orderId=order_id, permId=None),
        orderStatus=SimpleNamespace(status="Filled", filled=100, remaining=0),
        contract=SimpleNamespace(symbol="NVDA"),
    )


# ----------------------------------------------------------------------
def test_sync_places_hosted_orders_with_ref_and_oca(tmp_path):
    router = FakeHostedRouter([position_row()])
    engine = hosted_engine(tmp_path, router)
    track = add_hosted_track(engine)

    out = engine.sync_hosted()
    assert [p["item"]["kind"] for p in router.placed] == ["tp", "sl"]
    refs = {p["ref"] for p in router.placed}
    assert refs == {"trk:%s:tp" % track["id"], "trk:%s:sl" % track["id"]}
    assert {p["oca"] for p in router.placed} == {"dafri-trk-%s" % track["id"][:8]}
    assert len(out["hosted"]) == 1
    # 每张托管单都有一条留痕记录
    records = engine.store.list_records(limit=10)
    assert len(records) == 2


def test_profit_trail_stop_ratchets_as_peak_advances(tmp_path):
    row = position_row()
    router = FakeHostedRouter([row])
    engine = hosted_engine(tmp_path, router)
    add_hosted_track(
        engine, targets={"profit_drawdown_pct": 30.0}, peak=260.0,
    )

    engine.sync_hosted()
    assert router.placed[0]["item"]["kind"] == "ptrail"
    assert router.placed[0]["item"]["aux_price"] == 236.0   # 180 + 80×0.7

    # 价格创新高 → 峰值前进 → 停损价上移(改单,不是撤了重挂)
    row["market_price"] = 280.0
    engine.sync_hosted()
    assert len(router.placed) == 1
    assert router.modified[-1]["item"]["aux_price"] == 250.0  # 180 + 100×0.7
    # 回落不动:峰值只朝有利方向走
    row["market_price"] = 270.0
    engine.sync_hosted()
    assert len(router.modified) == 1


def test_gates_cancel_hosted_orders_when_authorization_is_lost(tmp_path):
    router = FakeHostedRouter([position_row()])
    engine = hosted_engine(tmp_path, router)
    add_hosted_track(engine)
    engine.sync_hosted()
    assert len(router.placed) == 2

    # 重启后 auto_execute 已被关掉:新引擎先认领券商侧的旧单,
    # 闸门落下 → 授权没了,那两张单必须撤回来
    router.open_rows = [
        {"order_ref": p["ref"], "order_id": p["order_id"], "account": "DU7654321",
         "action": p["item"]["action"], "order_type": p["item"]["order_type"],
         "quantity": p["item"]["quantity"], "lmt_price": p["item"]["lmt_price"],
         "aux_price": p["item"]["aux_price"],
         "trailing_percent": p["item"]["trailing_percent"], "status": "PreSubmitted"}
        for p in router.placed
    ]
    engine2 = hosted_engine(tmp_path, router, auto_execute=False)
    out = engine2.sync_hosted()
    assert sorted(router.cancelled) == sorted(p["order_id"] for p in router.placed)
    assert out["blocked"] and "auto_execute" in out["blocked"][0]["blockers"][0]


def test_hosted_fill_latches_the_track(tmp_path):
    router = FakeHostedRouter([position_row()])
    engine = hosted_engine(tmp_path, router)
    track = add_hosted_track(engine)
    engine.sync_hosted()
    tp_order_id = router.placed[0]["order_id"]

    engine._on_order_status(filled_trade(tp_order_id))
    after = engine.store.get_track(track["id"])
    assert not after["enabled"]
    assert after["fired_state"] == "take_profit"
    # 缓存清空:下一轮不再对这条追踪做任何动作
    out = engine.sync_hosted()
    assert out["hosted"] == [] and len(router.placed) == 2


def test_restart_adopts_open_orders_instead_of_replacing(tmp_path):
    router = FakeHostedRouter([position_row()])
    engine = hosted_engine(tmp_path, router)
    track = add_hosted_track(engine)
    router.open_rows = [
        {"order_ref": "trk:%s:tp" % track["id"], "order_id": 901, "account": "DU7654321",
         "action": "SELL", "order_type": "LMT", "quantity": 100.0,
         "lmt_price": 250.0, "aux_price": None, "trailing_percent": None,
         "status": "PreSubmitted"},
        {"order_ref": "trk:%s:sl" % track["id"], "order_id": 902, "account": "DU7654321",
         "action": "SELL", "order_type": "STP", "quantity": 100.0,
         "lmt_price": None, "aux_price": 160.0, "trailing_percent": None,
         "status": "PreSubmitted"},
    ]

    out = engine.sync_hosted()
    assert router.placed == []          # 认领,不重挂
    assert router.modified == []        # 价格没变,也不改
    assert {o["order_id"] for o in out["hosted"][0]["orders"]} == {901, 902}


def test_position_gone_cancels_hosted_orders(tmp_path):
    router = FakeHostedRouter([position_row()])
    engine = hosted_engine(tmp_path, router)
    add_hosted_track(engine)
    engine.sync_hosted()
    router.rows = []                    # 仓位被手动平掉了
    engine.sync_hosted()
    assert sorted(router.cancelled) == sorted(p["order_id"] for p in router.placed)


def test_software_watch_only_computes_when_hosting_is_on(tmp_path):
    # 现价已越过止盈价:软件若发单就是和托管单各平一次
    router = FakeHostedRouter([position_row(market_price=260.0)])
    engine = hosted_engine(tmp_path, router)
    add_hosted_track(engine)

    out = engine.poll_trackers()
    assert out["fired"] == []
    assert out["rows"][0].get("hosted") is True
    assert out["rows"][0]["state"] == "take_profit"   # 算还是要算,给界面看


def test_router_without_hosting_support_is_a_noop(tmp_path):
    class Bare:
        SUPPORTS_HOSTED_CLOSE = False

    engine = hosted_engine(tmp_path, Bare())
    add_hosted_track(engine)
    assert engine.sync_hosted() == {
        "hosted": [], "blocked": [], "quote_maybe_delayed": False,
    }
