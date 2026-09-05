"""持仓列表必须是券商账户的**实际持仓**(broker.py positions)。

两件事一旦错了,追踪就盯错东西:
  * 账号在持仓项上,不在合约上——从合约取永远是空,所有账户的仓都会记到默认账户名下;
  * 别名表之外的账户不是本软件管的:它的仓不显示、不追踪,否则界面上有、下单时找不到。
持仓只来自券商查询;已校验未发送 / 排队 / 未成交的订单本来就不在这条路上。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from conftest import make_settings
from ibkr_agent.broker import BrokerRouter


#: ib_insync.PortfolioItem 的字段名,逐字照抄(注意 unrealizedPNL 是全大写的 PNL)
PORTFOLIO_FIELDS = ("contract", "position", "marketPrice", "marketValue",
                    "averageCost", "unrealizedPNL", "realizedPNL", "account")


class PortfolioItem:
    """照 ib_insync.PortfolioItem 做的替身。

    刻意**不用** SimpleNamespace:那东西你写什么字段它就有什么字段。代码里把
    ``unrealizedPNL`` 写成 ``unrealizedPnL`` 时,fixture 会跟着一起错——测试全绿,
    而真机上账户一有持仓,``positions()`` 就抛 AttributeError,持仓列表与组合追踪
    整个瘫掉(2026-09-04 纸面账户实测踩到)。

    这里用 __slots__ + 构造时校验:字段名写错当场失败,不装 ib_insync 也有这层保护。
    """

    __slots__ = PORTFOLIO_FIELDS

    def __init__(self, **kw):
        unknown = sorted(set(kw) - set(PORTFOLIO_FIELDS))
        if unknown:
            raise AssertionError(
                "ib_insync.PortfolioItem 上没有这些字段:%s(是不是把 unrealizedPNL "
                "写成 unrealizedPnL 了?)" % unknown)
        for field in PORTFOLIO_FIELDS:
            setattr(self, field, kw.get(field))


def test_portfolio_field_names_match_ib_insync():
    """替身的字段名要和真库一致——库改了名,这里要红,而不是等真机崩。"""
    ib_insync = pytest.importorskip("ib_insync", reason="ib_insync 是可选依赖(extras: broker)")
    assert tuple(ib_insync.PortfolioItem._fields) == PORTFOLIO_FIELDS


def contract(symbol, sec_type="STK", **extra):
    base = dict(symbol=symbol, secType=sec_type, exchange="SMART", currency="USD",
                multiplier="100" if sec_type == "OPT" else "", lastTradeDateOrContractMonth="",
                strike=0.0, right="", tradingClass="")
    base.update(extra)
    return SimpleNamespace(**base)


class _FakeIb:
    def __init__(self, portfolio_items=(), position_items=()):
        self._portfolio = list(portfolio_items)
        self._positions = list(position_items)

    def portfolio(self):
        return self._portfolio

    def positions(self):
        return self._positions


def _router(fake):
    router = BrokerRouter(make_settings())
    router.sessions = lambda: [fake]                       # type: ignore[assignment]
    router._fill_position_prices = lambda rows: None       # type: ignore[assignment]
    return router


def test_positions_are_attributed_by_the_item_account_not_the_contract(capsys):
    """DU7654321 是配置里的「模拟」;U9999999 不在别名表里 → 跳过并提醒一次。"""
    fake = _FakeIb(
        portfolio_items=[
            PortfolioItem(account="DU7654321", contract=contract("AAPL"), position=100.0,
                          averageCost=220.0, marketPrice=230.0, marketValue=23000.0,
                          unrealizedPNL=1000.0),
            PortfolioItem(account="U9999999", contract=contract("TSLA"), position=50.0,
                          averageCost=250.0, marketPrice=260.0, marketValue=13000.0,
                          unrealizedPNL=500.0),
        ],
        position_items=[
            SimpleNamespace(account="U9999999", contract=contract("NVDA"), position=10.0, avgCost=180.0),
        ],
    )
    rows = _router(fake).positions()
    assert [(r["account"], r["symbol"]) for r in rows] == [("模拟", "AAPL")]
    assert rows[0]["unrealized_pnl"] == 1000.0              # portfolio 的口径原样带出
    err = capsys.readouterr().err
    assert "不在配置的别名表里" in err and "U9999999" not in err   # 提醒但账号掩码


def test_positions_without_an_account_fall_back_to_the_default_account():
    fake = _FakeIb(position_items=[
        SimpleNamespace(account="", contract=contract("AAPL"), position=10.0, avgCost=100.0),
    ])
    rows = _router(fake).positions()
    assert [(r["account"], r["symbol"]) for r in rows] == [("模拟", "AAPL")]


def test_option_legs_of_a_butterfly_survive_aggregation():
    """三条腿都是 SPX 的 OPT:key 带腿身份,三条都在,而不是只剩最后一条。"""
    legs = [
        SimpleNamespace(account="DU7654321", position=q, avgCost=c,
                        contract=contract("SPX", "OPT", lastTradeDateOrContractMonth="20260901",
                                          strike=k, right="P"))
        for q, c, k in ((1.0, 50.0, 7600.0), (-2.0, 40.0, 7615.0), (1.0, 30.0, 7630.0))
    ]
    rows = _router(_FakeIb(position_items=legs)).positions()
    assert len(rows) == 3
    assert {r["label"] for r in rows} == {
        "SPX 7600P 2026-09-01", "SPX 7615P 2026-09-01", "SPX 7630P 2026-09-01"
    }
    assert len({r["key"] for r in rows}) == 3


def test_flat_positions_are_dropped():
    fake = _FakeIb(position_items=[
        SimpleNamespace(account="DU7654321", contract=contract("AAPL"), position=0.0, avgCost=100.0),
    ])
    assert _router(fake).positions() == []


def test_portfolio_item_typo_is_caught_by_the_fixture():
    """这条测的是 fixture 本身:字段名写错必须当场炸,而不是悄悄多一个属性。"""
    with pytest.raises(AssertionError, match="unrealizedPnL"):
        PortfolioItem(account="DU7654321", contract=contract("AAPL"), position=1.0,
                      averageCost=1.0, marketPrice=1.0, marketValue=1.0, unrealizedPnL=1.0)
