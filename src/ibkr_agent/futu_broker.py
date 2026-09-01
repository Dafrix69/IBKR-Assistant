"""富途 OpenD 下单层——`broker.BrokerRouter` 的另一条腿。

为什么要有它:IBKR 的 API 不是每个人都能跑起来。TWS 装不上、握手过不去、
行情权限没开、账户在别的券商——任何一条卡住,整个引擎就没有出路。这个模块
提供第二条出路,**接口与 BrokerRouter 完全一致**,上层(engine / rpc / 界面)
一行都不用改:

    router = FutuRouter(settings) if settings.broker.provider == "futu" else BrokerRouter(settings)

刻意保持不变的三件事:
  * **纯计算部分不重写**。中间价、AUTO_MID 限价、盘口流动性、行权价宽度全部
    复用 broker.py 里那几个已经被单测钉死的纯函数——定价逻辑只能有一份;
  * **校验层不放松**。限额、方向复核、账户映射、别名表都在 validator 里做完了,
    这里只负责"把已经批准的订单发出去";
  * **拿不到实时报价就拒单**。富途的美股行情要单独开通,没开通时报价为空,
    LegQuote.mid 的守卫会拒绝——绝不用坏报价给真单定价。

三件事和 IBKR 不一样,必须说在前面:

  1. **不支持组合单(BAG)**。富途的下单接口是单腿的,没有 IBKR 那种把价差
     当成一个合约整体撮合的 BAG。拆成单腿分别发会产生腿风险(一条腿成了另一条
     没成,建出的是裸头寸而不是价差),所以这里**直接拒绝**,而不是偷偷拆单。
     价差 / 蝴蝶 / 铁鹰请切回 IBKR。
  2. **回报是拉的,不是推的**。ib_insync 有事件流,富途这边靠 poll_order_updates()
     在 UI 的定时轮询里拉。拉到的更新会被包成和 ib_insync 同形的对象喂给
     engine 里那套现成的入库逻辑,所以记录格式两家一致。
  3. **实盘要先交易解锁**。解锁密码是 S0 级,只走 Keychain / DPAPI。没解锁就
     下实盘单会被这里拦住,而不是等富途回一个看不懂的错误码。
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from datetime import date as _date, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

# 定价与展示的纯计算全部复用 IBKR 那一侧——同一套数学只能有一份实现。
from .broker import (
    BrokerError,
    LegQuote,
    PlacementResult,
    _clean_price,
    _finite_quote,
    _log_stderr,
    book_liquidity,
    redact_for_log,
)
from .config import AccountConfig, Settings
from .futu import FutuUnavailable, _futu, quiet_stdout
from .keychain import KeychainError, get_secret
from .models import ContractSpec
from .priceaction import MIN_BARS, TIMEFRAMES
from .tws import probe_port
from .validator import ApprovedOrder

# 本系统的 K 线周期 → 富途 KLType。富途没有 2 分钟线,缺的就明说,不拿 1 分钟
# 线合成——合成出来的 K 线在 PA 分析里和真线长得一样,但摆动点是假的。
_KLTYPE = {
    "1m": "K_1M",
    "5m": "K_5M",
    "15m": "K_15M",
    "30m": "K_30M",
    "1h": "K_60M",
    "1d": "K_DAY",
}

# 富途订单状态 → ib_insync 口径的状态名。翻成同一套词表,engine 里那张
# 终态映射表(Filled / Cancelled / Inactive)就能原样复用。
_ORDER_STATUS = {
    "UNSUBMITTED": "PendingSubmit",
    "WAITING_SUBMIT": "PreSubmitted",
    "SUBMITTING": "PreSubmitted",
    "SUBMITTED": "Submitted",
    "FILLED_PART": "Submitted",
    "FILLED_ALL": "Filled",
    "CANCELLING_ALL": "PendingCancel",
    "CANCELLING_PART": "PendingCancel",
    "CANCELLED_ALL": "Cancelled",
    "CANCELLED_PART": "Cancelled",
    "FILL_CANCELLED": "Cancelled",
    "DELETED": "Cancelled",
    "FAILED": "Inactive",
    "SUBMIT_FAILED": "Inactive",
    "DISABLED": "Inactive",
    "TIMEOUT": "Inactive",
    "NONE": "Unknown",
}
# 还活着、撤得掉的状态。CANCELLING_* 不算——它们已经在撤了,再发一次只会报错。
# put-call parity 反推现价的质量闸(见 implied_spot)。
_PARITY_MIN_POINTS = 4          # 少于这么多个行权价,拟合不可信
_PARITY_MIN_DISCOUNT = 0.90     # 折现因子的合理下界(约等于 10 年期 1% 或 2 年期 5%)
_PARITY_MAX_DISCOUNT = 1.001    # 略微超过 1 容忍浮点与极短到期
_PARITY_MAX_RESIDUAL = 0.005    # 最大残差不得超过现价的 0.5%

_OPEN_STATUS = (
    "UNSUBMITTED", "WAITING_SUBMIT", "SUBMITTING", "SUBMITTED", "FILLED_PART",
)


# ======================================================================
# 取值助手
# ======================================================================
def _rows(data) -> List[Dict[str, Any]]:
    """把 futu 返回的 DataFrame 摊成 list[dict]。

    刻意不 import pandas:一来它不是本项目的依赖,二来 SDK 早期版本直接回
    list[dict],兼容两种形态比赌一种稳。
    """
    if data is None:
        return []
    if isinstance(data, list):
        return [dict(r) for r in data]
    to_dict = getattr(data, "to_dict", None)
    if callable(to_dict):
        try:
            return [dict(r) for r in to_dict("records")]
        except Exception:  # noqa: BLE001
            pass
    try:
        return [dict(r) for r in data]
    except Exception:  # noqa: BLE001
        return []


def _field(row: Dict[str, Any], *names: str):
    """按候选列名依次取值。

    富途 SDK 在不同版本里给期权快照的列名换过前缀(`open_interest` /
    `option_open_interest`),赌一个名字的后果是墙分析静默变成一片零。
    多试几个是唯一稳妥的做法。
    """
    for name in names:
        if name in row:
            value = row[name]
            if value is not None and str(value).lower() != "nan":
                return value
    return None


def _to_float(value) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _futu_date(day: str) -> str:
    """'YYYYMMDD'(本系统 / IBKR 口径)→ 'YYYY-MM-DD'(富途口径)。"""
    text = (day or "").strip()
    if len(text) == 8 and text.isdigit():
        return "%s-%s-%s" % (text[:4], text[4:6], text[6:8])
    return text


def _plain_date(day: str) -> str:
    """'YYYY-MM-DD' → 'YYYYMMDD'。"""
    return (day or "").strip()[:10].replace("-", "")


def _bar_time(time_key: str, daily: bool) -> str:
    text = str(time_key or "").strip()
    if daily:
        return text[:10]
    return text[:16] if len(text) >= 16 else text


def _duration_days(spec: Dict[str, Any]) -> int:
    """把 IBKR 口径的 durationStr('5 D' / '1 Y')换算成日历天数。

    IBKR 数的是**交易日**,富途的历史 K 线按日历区间取——直接拿数字当天数会
    少三成的数据(周末休市)。乘 1.5 再加几天缓冲,宁可多取也不能少到
    MIN_BARS 以下,少了 PA 分析就只能不出结论。
    """
    text = str(spec.get("duration") or "5 D").strip().upper()
    try:
        amount = int(text.split()[0])
    except (ValueError, IndexError):
        amount = 5
    if text.endswith("Y"):
        return amount * 365 + 10
    return int(amount * 1.5) + 5


# ======================================================================
# 从期权链自己反推标的现价(put-call parity)
# ======================================================================
def implied_spot(pairs: Sequence[Tuple[float, float, float]]) -> Dict[str, float]:
    """由同一到期日的若干 (行权价, Call 价, Put 价) 反推标的现价。

    **为什么需要它**:富途拿不到美股指数的现价(实测三条路皆拒),而期权墙必须
    知道现价才能判断墙在上方还是下方。但期权链自己就隐含着这个价格——用它反推
    出来的现价,和链上的报价是自洽的,这对墙分析而言恰恰是最合适的参考价。

    **用的是恒等式,不是估计**。看跌看涨平价关系:

        C − P = S − K·D        (D = e^(−rT),折现因子)

    对同一到期日的所有行权价都成立。所以把 (C−P) 对 K 做一次最小二乘直线拟合,
    **截距就是 S、斜率的相反数就是 D**——利率和到期时间都不用假设,它们被拟合
    出来了。只用单个行权价、把 D 当成 1 的做法在 SPX 上会差出二十几个点
    (7500 × (1−e^(−4%×1/12)) ≈ 25),那是不能接受的。

    残差是天然的质量闸:平价关系是恒等式,报价干净时残差接近零。残差一大就说明
    报价有问题(盘口不全、深度虚价、链取错了),这时候宁可拒绝也不能给一个看起来
    像模像样的错价——墙的位置全靠它。
    """
    points = [
        (float(k), float(c) - float(p))
        for k, c, p in pairs
        if k and math.isfinite(k) and math.isfinite(c) and math.isfinite(p) and c > 0 and p > 0
    ]
    if len(points) < _PARITY_MIN_POINTS:
        raise BrokerError(
            "只有 %d 个行权价同时拿到了看涨与看跌的有效报价(至少要 %d 个),"
            "无法反推标的现价。多半是这条链的盘口太稀疏。"
            % (len(points), _PARITY_MIN_POINTS)
        )

    n = float(len(points))
    sum_k = sum(k for k, _ in points)
    sum_y = sum(y for _, y in points)
    sum_kk = sum(k * k for k, _ in points)
    sum_ky = sum(k * y for k, y in points)
    denom = n * sum_kk - sum_k * sum_k
    if abs(denom) < 1e-9:
        raise BrokerError("反推现价失败:所有取样的行权价都一样,拟合不出斜率。")

    slope = (n * sum_ky - sum_k * sum_y) / denom
    spot = (sum_y - slope * sum_k) / n
    discount = -slope

    if not math.isfinite(spot) or spot <= 0:
        raise BrokerError("反推出的现价不是正数(%.4f),拒绝使用。" % spot)
    if not (_PARITY_MIN_DISCOUNT <= discount <= _PARITY_MAX_DISCOUNT):
        # D 应该略小于 1(远期贴现)。跑到范围外说明拟合的根本不是平价关系,
        # 常见原因是把两个不同到期日的合约混进了同一组。
        raise BrokerError(
            "反推出的折现因子 %.4f 不合理(应在 %.2f ~ %.3f 之间),"
            "这条链的报价对不上平价关系,拒绝据此定位墙。"
            % (discount, _PARITY_MIN_DISCOUNT, _PARITY_MAX_DISCOUNT)
        )

    worst = max(abs(y - (spot - discount * k)) for k, y in points)
    if worst > spot * _PARITY_MAX_RESIDUAL:
        raise BrokerError(
            "平价关系拟合的最大残差 %.2f 超过现价的 %.1f%%(%.2f),"
            "说明这条链的报价不干净,拒绝用它反推现价。"
            % (worst, _PARITY_MAX_RESIDUAL * 100, spot * _PARITY_MAX_RESIDUAL)
        )
    return {
        "spot": round(spot, 4),
        "discount": round(discount, 6),
        "residual": round(worst, 4),
        "samples": len(points),
    }


# ======================================================================
# 回报 shim:把富途的订单/成交包成 ib_insync 同形的对象
# ======================================================================
@dataclass
class _ShimOrder:
    orderId: int
    permId: int


@dataclass
class _ShimStatus:
    status: str
    filled: float
    remaining: float


@dataclass
class _ShimContract:
    symbol: str


@dataclass
class _ShimTrade:
    order: _ShimOrder
    orderStatus: _ShimStatus
    contract: _ShimContract


@dataclass
class _ShimExecution:
    execId: str
    time: str
    price: float
    shares: float
    side: str
    acctNumber: str


@dataclass
class _ShimFill:
    execution: _ShimExecution


# ======================================================================
# 会话
# ======================================================================
@dataclass
class FutuSession:
    """一条 OpenD 会话。

    富途把行情和交易拆成两个 context,但它们连的是同一个 OpenD、对用户来说
    就是"一条连接",所以打包在一起——上层只认连接名。
    """

    name: str
    host: str
    port: int
    quote_ctx: Any
    trade_ctx: Any
    accounts: List[str] = field(default_factory=list)
    #: 账号 → 富途报的真实交易环境(SIMULATE / REAL)。见 place() 里那段核对。
    account_envs: Dict[str, str] = field(default_factory=dict)
    unlocked: bool = False
    subscriptions: Dict[str, set] = field(default_factory=dict)   # code → {SubType 名}

    def is_connected(self) -> bool:
        return self.quote_ctx is not None


class FutuRouter:
    """按账户别名把订单路由到对应的 OpenD 会话(FutuRouter ≡ BrokerRouter)。"""

    BROKER = "futu"
    #: 富途的下单接口没有 IBKR 那种"条件挂在服务器上"的原生条件单(§8.1 方式 A)。
    #: engine 据此把**所有**条件单都送进方式 B 的软件盯盘队列——少了这个标记,
    #: 带明确价格的条件单会被当成普通单立刻发出去,触发价形同虚设。
    SUPPORTS_NATIVE_CONDITIONS = False

    #: 富途的行情订阅有额度(按资产等级,常见 100 条)。一次性铺开整条期权链
    #: 会把额度吃干,连 AUTO_MID 定价都会跟着拿不到报价,所以每侧最多取这么多档。
    _CHAIN_MAX_WIDTH = 15
    #: 订阅后第一笔推送要等一下才到。等太短会拿到空盘口被守卫误判成"盘口不可用"。
    _SUB_SETTLE = 0.6
    #: 单页历史 K 线上限(富途接口本身的上限)。
    _PAGE = 1000

    def __init__(self, settings: Settings):
        self.settings = settings
        self._sessions: Dict[str, FutuSession] = {}
        # 账户实际归属的连接缓存(账号 → 连接名),语义与 BrokerRouter 一致。
        self._account_route: Dict[str, str] = {}
        # engine 用它挂回报监听。富途没有事件流,这个钩子调用后会立刻返回 False,
        # 真正的回报走 poll_order_updates()——留着这个属性是为了接口一致。
        self.session_hook: Optional[Any] = None
        # 常驻流式行情订阅的代码集合(顶栏宏观带用)。
        self._streams: set = set()
        # 期权代码缓存:(标的, 到期日, 行权价, C/P) → 富途代码。
        # 每次下单都去拉一遍期权链既慢又浪费额度。
        self._option_codes: Dict[Tuple[str, str, float, str], str] = {}
        # 指数代码缓存:本系统代码 → 富途代码(见 _index_code 的说明)。
        self._index_codes: Dict[str, Optional[str]] = {}
        # 已经提示过"富途报不了这个价"的标的,避免盯盘循环刷屏。
        self._unquotable: set = set()
        # 查不到逐笔成交的账户(富途模拟盘就是这样)。见 _poll_deals 的说明。
        self._no_deal_query: set = set()
        # 已提交订单:内部句柄 → 跟踪信息。句柄是自增整数,不是富途的订单号
        # ——engine 的订单索引是 int 键的,而富途订单号是字符串,格式还随版本变。
        self._orders: Dict[int, Dict[str, Any]] = {}
        self._next_handle = 1
        self._seen_deals: set = set()
        # OpenD 与富途服务器那一段是否通(诊断读到的 qot_logined)。
        self._upstream_ok = True

    # ---- 连接 -----------------------------------------------------------
    @property
    def connections(self) -> Dict[str, Any]:
        return self.settings.connections_for(self.BROKER)

    def connect(self, connection_name: str) -> FutuSession:
        existing = self._sessions.get(connection_name)
        if existing is not None and existing.is_connected():
            return existing

        cfg = self.connections.get(connection_name)
        if cfg is None:
            raise BrokerError("未定义的连接:%s(这里只在富途连接里查找)" % connection_name)

        # 先探端口再建 context:futu 的 context 构造函数连不上时会自己重试若干秒,
        # 而 RPC 服务是串行的,这几秒会把后面所有请求堵在管道里(见 broker.py 里
        # 那次死锁事故留下的约束)。
        probe = probe_port(cfg.host, cfg.port)
        if not probe["open"]:
            raise BrokerError(
                "连接 %s (%s:%d) 失败:%s。请确认富途 OpenD 已启动并完成登录,"
                "且它的 api_port 就是 %d。"
                % (connection_name, cfg.host, cfg.port, probe["error"] or "端口未监听", cfg.port)
            )

        try:
            mod = _futu()
        except FutuUnavailable as exc:
            raise BrokerError(str(exc)) from exc

        futu_cfg = self.settings.broker.futu
        quote_ctx = trade_ctx = None
        try:
            with quiet_stdout():
                quote_ctx = mod.OpenQuoteContext(host=cfg.host, port=cfg.port)
                trade_ctx = mod.OpenSecTradeContext(
                    filter_trdmarket=getattr(mod.TrdMarket, futu_cfg.trd_market),
                    host=cfg.host,
                    port=cfg.port,
                    security_firm=getattr(mod.SecurityFirm, futu_cfg.security_firm),
                )
        except Exception as exc:  # noqa: BLE001
            _close(quote_ctx)
            _close(trade_ctx)
            raise BrokerError(
                "连接 %s (%s:%d) 失败:%s。请在「富途 OpenD」面板点「检测连接」看具体卡在哪一步。"
                % (connection_name, cfg.host, cfg.port, exc)
            ) from exc

        session = FutuSession(
            name=connection_name, host=cfg.host, port=cfg.port,
            quote_ctx=quote_ctx, trade_ctx=trade_ctx,
        )
        session.accounts, session.account_envs = self._read_accounts(session)
        self._upstream_ok = True
        self._sessions[connection_name] = session
        if self.session_hook is not None:
            try:
                self.session_hook(session)
            except Exception:  # noqa: BLE001 - 挂监听失败不应阻断连接本身
                pass
        return session

    def _read_accounts(self, session: FutuSession) -> Tuple[List[str], Dict[str, str]]:
        """读回这条会话能管的账号,以及每个账号**真实的**交易环境。

        trd_env 不是可有可无的元数据:配置里的 is_paper 决定要不要过
        allow_live_trading 那道闸,而富途的模拟账号和实盘账号是两个不同的
        acc_id。把实盘账号标成 is_paper=true,实盘闸门就等于形同虚设——
        所以真实环境必须读回来,下单前逐笔核对。
        """
        mod = _futu()
        try:
            with quiet_stdout():
                ret, data = session.trade_ctx.get_acc_list()
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("读取富途交易账户失败:%s" % str(exc)[:200]) from exc
        if ret != mod.RET_OK:
            raise BrokerError(
                "读取富途交易账户失败:%s。多半是 OpenD 的交易服务没登录。" % str(data)[:200]
            )
        accounts: List[str] = []
        envs: Dict[str, str] = {}
        for row in _rows(data):
            acc = str(_field(row, "acc_id") or "").strip()
            if not acc:
                continue
            accounts.append(acc)
            envs[acc] = str(_field(row, "trd_env") or "").strip().upper()
        return accounts, envs

    @property
    def upstream_ok(self) -> bool:
        return self._upstream_ok

    def sessions(self) -> List[Any]:
        return [s for s in self._sessions.values() if s.is_connected()]

    def connected_names(self) -> List[str]:
        return sorted(name for name, s in self._sessions.items() if s.is_connected())

    def disconnect_all(self) -> None:
        for session in self._sessions.values():
            self._unsubscribe_all(session)
            _close(session.quote_ctx)
            _close(session.trade_ctx)
            session.quote_ctx = None
            session.trade_ctx = None
        self._sessions.clear()
        self._account_route.clear()
        self._streams.clear()

    def for_account(self, account: AccountConfig) -> FutuSession:
        """找到真正管理该账户的会话。语义与 BrokerRouter.for_account 一致:
        路由永远以会话实况为准,映射不上就拒绝,绝不把单子发进错误会话。"""
        connections = self.connections
        if account.connection not in connections:
            # 跨券商绝不改道。同一家券商内部改道是真实场景(用户在 OpenD 里换了
            # 登录),跨券商则永远是配置写错——放行的话,一个配给 IBKR 的账户会
            # 因为账号数字碰巧对得上而把单发进富途。
            raise BrokerError(
                "账户 %s 绑的连接 %s 不是富途连接(当前券商接入:富途)。"
                "请在设置里给它配一条富途连接和富途账号,或把券商接入切回 IBKR。"
                % (account.alias, account.connection)
            )
        order: List[str] = []
        cached = self._account_route.get(account.account_id)
        if cached and cached in connections:
            order.append(cached)
        if account.connection not in order:
            order.append(account.connection)
        order += [n for n in connections if n not in order]

        failures: List[str] = []
        for name in order:
            try:
                session = self.connect(name)
            except BrokerError as exc:
                failures.append(str(exc))
                continue
            if account.account_id in set(session.accounts):
                if name != account.connection:
                    _log_stderr(
                        "[futu] 账户 %s 实际由连接 %s 管理(配置写的是 %s),已自动改道"
                        % (redact_for_log(account.account_id), name, account.connection)
                    )
                self._account_route[account.account_id] = name
                return session
            if not session.accounts and name == account.connection:
                return session   # 账户列表为空(交易服务未登录):只对配置指定的连接放行
            failures.append("连接 %s 的会话不管理该账户(当前登录的可能是另一个富途账号)" % name)

        raise BrokerError(
            "账户 %s 在所有已配置的富途连接上都找不到对应会话:%s。"
            "请确认 OpenD 当前登录的就是这个账号,或核对配置里的 account_id。"
            % (account.alias, ";".join(failures) or "无可用连接")
        )

    def _market_session(self) -> FutuSession:
        sessions = self.sessions()
        if not sessions:
            raise BrokerError("引擎未连接富途 OpenD。请先在「富途 OpenD」面板连接引擎。")
        return sessions[0]

    # ---- 代码换算 --------------------------------------------------------
    _MARKET_PREFIX = {"US": "US", "HK": "HK", "CN": "SH"}

    def code(self, symbol: str) -> str:
        """本系统代码 → 富途代码。

        普通美股按 `US.<代码>` 拼即可;指数各家命名不一致,先查配置的覆盖表,
        再走 _index_code() 去富途的证券列表里实测——**绝不拿猜的代码去下单**。
        """
        upper = (symbol or "").strip().upper()
        override = self.settings.broker.futu.symbol_map.get(upper)
        if override:
            return override
        # 注意:指数走到这里也只是把代码解析出来(US..SPX 确实存在于富途的证券
        # 列表里),但它报不出价——拦截发生在 quote_capability(),不在这里。
        # 也正因为如此,symbol_map 里把 SPX 映射成 US.SPY 是没用的:闸门认的是
        # 配置里的 index_symbols,而不是映射后的代码。这是刻意的,SPX 七千多点、
        # SPY 七百多块,静默换标的会让触发价整个失去意义。
        if self.settings.index_config(upper) is not None:
            resolved = self._index_code(upper)
            if resolved:
                return resolved
            raise BrokerError(
                "在富途的美股指数列表里找不到 %s 对应的代码。"
                "请在 config/settings.json 的 broker.futu.symbol_map 里显式指定"
                "(例如 \"%s\": \"US.%s\")。" % (upper, upper, upper)
            )
        prefix = self._MARKET_PREFIX.get(self.settings.broker.futu.trd_market, "US")
        return "%s.%s" % (prefix, upper)

    def _index_code(self, symbol: str) -> Optional[str]:
        """去富途的证券列表里实测指数代码,结果缓存。

        指数代码是这条链路上最容易静默出错的地方:拼错了不一定报错,可能拿到
        另一个标的的价格,而触发价复核会照单全收。所以宁可多一次查询。
        """
        if symbol in self._index_codes:
            return self._index_codes[symbol]
        mod = _futu()
        session = self._market_session()
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_stock_basicinfo(
                    mod.Market.US, mod.SecurityType.IDX
                )
        except Exception:  # noqa: BLE001
            self._index_codes[symbol] = None
            return None
        if ret != mod.RET_OK:
            self._index_codes[symbol] = None
            return None

        wanted = symbol.upper()
        best: Optional[str] = None
        for row in _rows(data):
            code = str(_field(row, "code") or "")
            tail = code.split(".")[-1].lstrip(".").upper()
            if tail == wanted:
                best = code
                break
        self._index_codes[symbol] = best
        return best

    def option_code(self, symbol: str, expiry: str, strike: float, right: str) -> str:
        """(标的, 到期日, 行权价, C/P) → 富途期权代码。

        用期权链查而不是按规则拼字符串:各家的期权代码规则都改过,拼错的后果
        是下到另一个合约上,而这个错误在回报回来之前看不出来。
        """
        key = (symbol.upper(), expiry, round(float(strike), 4), right.upper())
        cached = self._option_codes.get(key)
        if cached:
            return cached

        mod = _futu()
        session = self._market_session()
        day = _futu_date(expiry)
        option_type = mod.OptionType.CALL if right.upper() == "C" else mod.OptionType.PUT
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_option_chain(
                    code=self.code(symbol), start=day, end=day, option_type=option_type
                )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 的期权链失败:%s" % (symbol, str(exc)[:200])) from exc
        if ret != mod.RET_OK:
            raise BrokerError(
                "获取 %s %s 的期权链失败:%s(该到期日是否存在?富途的期权行情是否已开通?)"
                % (symbol, expiry, str(data)[:200])
            )

        target = None
        for row in _rows(data):
            value = _to_float(_field(row, "strike_price", "option_strike_price"))
            if value is not None and abs(value - float(strike)) < 1e-6:
                target = str(_field(row, "code") or "")
                break
        if not target:
            raise BrokerError(
                "富途的 %s %s 期权链里没有行权价 %s 的 %s(行权价或到期日不存在)。已拦截。"
                % (symbol, expiry, strike, "看涨" if right.upper() == "C" else "看跌")
            )
        self._option_codes[key] = target
        return target

    def contract_code(self, contract: ContractSpec) -> str:
        """把已批准的合约换成富途代码。BAG 在这里就拒——理由见模块头。"""
        if contract.secType == "STK":
            return self.code(contract.symbol)
        if contract.secType == "OPT":
            return self.option_code(
                contract.symbol,
                contract.lastTradeDateOrContractMonth or "",
                float(contract.strike or 0),
                contract.right or "C",
            )
        raise BrokerError(
            "富途 OpenD 不支持多腿组合单(BAG)。价差 / 蝴蝶 / 铁鹰在富途只能拆成"
            "单腿分别下,而拆单会产生腿风险(一条腿成了另一条没成,建出的是裸头寸"
            "而不是价差),所以这里直接拒绝。这类结构请把券商接入切回 IBKR。"
        )

    # ---- 订阅 -----------------------------------------------------------
    def _subscribe(self, session: FutuSession, codes: Sequence[str], subtype: str) -> None:
        mod = _futu()
        fresh = [c for c in codes if subtype not in session.subscriptions.get(c, set())]
        if not fresh:
            return
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.subscribe(
                    list(fresh), [getattr(mod.SubType, subtype)]
                )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("订阅富途行情失败:%s" % str(exc)[:200]) from exc
        if ret != mod.RET_OK:
            raise BrokerError(
                "订阅富途行情失败:%s。常见原因:①该市场的行情权限没开通;"
                "②订阅额度已用满(富途按资产等级给额度)。" % str(data)[:200]
            )
        for code in fresh:
            session.subscriptions.setdefault(code, set()).add(subtype)
        time.sleep(self._SUB_SETTLE)

    def _unsubscribe(self, session: FutuSession, codes: Sequence[str], subtype: str) -> None:
        """用完即退订。不退会一直占着订阅额度,占满之后 AUTO_MID 定价会在盘中
        开始拿不到报价——和 IBKR 那边行情线路泄漏是同一类事故。"""
        mod = _futu()
        live = [c for c in codes if subtype in session.subscriptions.get(c, set())]
        if not live:
            return
        try:
            with quiet_stdout():
                session.quote_ctx.unsubscribe(list(live), [getattr(mod.SubType, subtype)])
        except Exception:  # noqa: BLE001 - 退订失败不该拦住主流程
            return
        for code in live:
            session.subscriptions.get(code, set()).discard(subtype)

    def _unsubscribe_all(self, session: FutuSession) -> None:
        if session.quote_ctx is None:
            return
        try:
            with quiet_stdout():
                session.quote_ctx.unsubscribe_all()
        except Exception:  # noqa: BLE001
            pass
        session.subscriptions.clear()

    # ---- 行情 -----------------------------------------------------------
    def _snapshot(self, codes: Sequence[str]) -> Dict[str, Dict[str, Any]]:
        """快照。不需要订阅,但富途对它有调用频率限制(30 秒内若干次),
        所以只用在一次性查询上;要秒级刷新走 stream_quotes。"""
        if not codes:
            return {}
        mod = _futu()
        session = self._market_session()
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_market_snapshot(list(codes))
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取富途快照失败:%s" % str(exc)[:200]) from exc
        if ret != mod.RET_OK:
            raise BrokerError(_quote_error(str(data)))
        return {str(_field(row, "code") or ""): row for row in _rows(data)}

    def quote_capability(self, symbol: str) -> Optional[str]:
        """这个标的富途能不能报价?能就回 None,不能就回"为什么"。

        **富途 OpenAPI 不支持美股指数**——这不是权限没开,是能力缺口:快照、
        订阅、历史 K 线三条路都会回「暂不支持美股指数」(真机实测)。麻烦的是
        指数代码在它的证券列表里查得到(US..SPX),所以代码解析会"成功",
        然后每一次取数都静默空手而归。最坏的下场是 SPX 条件单进了盯盘队列却
        永远不会触发——软件看起来在盯,其实盯的是一个永远为 None 的价格。
        所以这个判断必须前置,并且要让调用方能把它变成一次明确的拒绝。
        """
        if self.settings.index_config(symbol) is not None:
            return (
                "富途 OpenAPI 不支持美股指数(%s):快照、订阅、K 线三条路都会回"
                "「暂不支持美股指数」。改用对应的 ETF 自己重下(SPX→SPY、NDX→QQQ、"
                "RUT→IWM、VIX→VIXY),或把券商接入切回 IBKR。"
                "**本软件不会替你换标的**——ETF 和指数的点数、乘数、行权规则都不一样。"
                % symbol
            )
        return None

    def index_price(self, symbol: str) -> Optional[float]:
        """给触发价复核与快照用。取不到就回 None,让上层按"没有行情"处理。"""
        if not self.sessions():
            return None
        reason = self.quote_capability(symbol)
        if reason:
            # 每个标的只吼一次:盯盘循环几秒一轮,每轮都打会把日志淹掉
            if symbol not in self._unquotable:
                self._unquotable.add(symbol)
                _log_stderr("[futu] %s" % reason)
            return None
        try:
            code = self.code(symbol)
            rows = self._snapshot([code])
        except BrokerError:
            return None
        row = rows.get(code)
        if not row:
            return None
        for key in ("last_price", "cur_price", "prev_close_price"):
            value = _clean_price(_field(row, key))
            if value is not None:
                return value
        return None

    def stock_quotes(self, symbols: Sequence[str]) -> Dict[str, Dict[str, Optional[float]]]:
        """批量报价,给「板块关注」页用;绝不用于订单定价。"""
        if not symbols or not self.sessions():
            return {}
        codes = {}
        for symbol in symbols:
            if self.quote_capability(symbol):
                continue                   # 富途报不了的(指数)直接跳,别白跑一次必然失败的请求
            try:
                codes[symbol] = self.code(symbol)
            except BrokerError:
                continue
        try:
            rows = self._snapshot(list(codes.values()))
        except BrokerError:
            return {s: {"last": None, "close": None, "change_pct": None} for s in codes}

        out: Dict[str, Dict[str, Optional[float]]] = {}
        for symbol in symbols:
            if symbol not in codes:
                continue          # 富途报不了的(指数)干脆不出现,而不是给一行全 None
            row = rows.get(codes[symbol], {})
            last = _clean_price(_field(row, "last_price", "cur_price"))
            close = _clean_price(_field(row, "prev_close_price", "last_close"))
            change = round((last - close) / close * 100.0, 2) if (last and close) else None
            out[symbol] = {"last": last, "close": close, "change_pct": change}
        return out

    def stream_quotes(self, symbols: Sequence[str]) -> Dict[str, Dict[str, Any]]:
        """常驻订阅 + 每次只读当前值(顶栏宏观带用,要秒级刷新)。

        和 stock_quotes 的区别就是这个"常驻":快照接口有频率限制,顶栏那种
        刷法几秒就会撞上限;订阅一次留着,之后每次只花一次读的时间。
        """
        if not symbols or not self.sessions():
            return {}
        session = self._market_session()
        mod = _futu()

        codes: Dict[str, str] = {}
        for symbol in symbols:
            if self.quote_capability(symbol):
                continue                   # 同上:指数直接跳,交给公开源兜底
            try:
                codes[symbol] = self.code(symbol)
            except BrokerError:
                continue
        if not codes:
            return {}
        try:
            self._subscribe(session, list(codes.values()), "QUOTE")
        except BrokerError:
            return {}                      # 没权限 / 没额度 → 交给公开源兜底
        self._streams.update(codes.values())

        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_stock_quote(list(codes.values()))
        except Exception:  # noqa: BLE001
            return {}
        if ret != mod.RET_OK:
            return {}

        rows = {str(_field(r, "code") or ""): r for r in _rows(data)}
        out: Dict[str, Dict[str, Any]] = {}
        for symbol, code in codes.items():
            row = rows.get(code)
            if not row:
                continue
            last = _clean_price(_field(row, "last_price", "cur_price"))
            close = _clean_price(_field(row, "prev_close_price", "last_close"))
            if last is None:
                continue                   # 没数据 → 交给公开源兜底
            change = round((last - close) / close * 100.0, 2) if close else None
            out[symbol] = {"last": last, "close": close, "change_pct": change}
        return out

    def leg_quotes(self, contract: ContractSpec, account: AccountConfig) -> List[LegQuote]:
        """组合各腿的盘口(AUTO_MID 定价用)。

        富途不能发组合单,但**定价照样要算**——不然用户在切到富途之后看到的
        会是一个语焉不详的错误。这里如实把各腿盘口取回来,真正的拒绝发生在
        place() 里,理由写得清清楚楚。

        和 IBKR 那一侧有一处刻意的不同:**没有"纸面账户退到延迟盘口"这条后路**。
        富途没有 reqMarketDataType 那种全局降级开关,拿不到实时报价就是拿不到,
        LegQuote.mid 的守卫会直接拒单。宁可拒,不拿坏报价定价。
        """
        session = self.for_account(account)
        codes: List[str] = []
        legs = list(contract.legs or [])
        for leg in legs:
            codes.append(
                self.option_code(
                    contract.symbol, leg.lastTradeDateOrContractMonth, leg.strike, leg.right
                )
            )
        quotes: List[LegQuote] = []
        try:
            self._subscribe(session, codes, "ORDER_BOOK")
            for leg, code in zip(legs, codes):
                bid, ask = self._top_of_book(session, code)
                quotes.append(
                    LegQuote(
                        action=leg.action,
                        ratio=leg.ratio,
                        # 拿不到报价一律归零,让 LegQuote.mid 的守卫拦下来。
                        bid=_finite_quote(bid),
                        ask=_finite_quote(ask),
                    )
                )
        finally:
            self._unsubscribe(session, codes, "ORDER_BOOK")
        return quotes

    def _top_of_book(self, session: FutuSession, code: str) -> Tuple[float, float]:
        mod = _futu()
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_order_book(code, num=1)
        except Exception:  # noqa: BLE001
            return 0.0, 0.0
        if ret != mod.RET_OK or not isinstance(data, dict):
            return 0.0, 0.0
        bid = _level_price(data.get("Bid"))
        ask = _level_price(data.get("Ask"))
        return bid, ask

    def order_book(self, symbol: str, rows: int = 10) -> Dict[str, Any]:
        """一档盘口 + 深度(取决于行情等级)。只读展示,不参与定价与下单。"""
        session = self._market_session()
        mod = _futu()
        if self.settings.index_config(symbol) is not None:
            raise BrokerError("指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。")

        code = self.code(symbol)
        out: Dict[str, Any] = {"symbol": symbol, "l1": {}, "bids": [], "asks": [], "note": ""}
        try:
            self._subscribe(session, [code], "ORDER_BOOK")
            with quiet_stdout():
                ret, data = session.quote_ctx.get_order_book(code, num=max(1, min(int(rows), 10)))
            if ret != mod.RET_OK:
                raise BrokerError(_quote_error(str(data)))
            data = data if isinstance(data, dict) else {}
            out["bids"] = _levels(data.get("Bid"))
            out["asks"] = _levels(data.get("Ask"))
        finally:
            self._unsubscribe(session, [code], "ORDER_BOOK")

        bid = out["bids"][0]["price"] if out["bids"] else None
        ask = out["asks"][0]["price"] if out["asks"] else None
        l1: Dict[str, Any] = {
            "bid": bid,
            "ask": ask,
            "bid_size": out["bids"][0]["size"] if out["bids"] else None,
            "ask_size": out["asks"][0]["size"] if out["asks"] else None,
            "last": None,
        }
        try:
            snap = self._snapshot([code]).get(code, {})
            l1["last"] = _clean_price(_field(snap, "last_price", "cur_price")) or _clean_price(
                _field(snap, "prev_close_price")
            )
        except BrokerError:
            pass
        if bid and ask and ask >= bid:
            mid = (bid + ask) / 2.0
            l1["spread"] = round(ask - bid, 4)
            l1["spread_bps"] = round((ask - bid) / mid * 10_000, 1) if mid else None
        out["l1"] = l1
        if len(out["bids"]) <= 1 and len(out["asks"]) <= 1:
            out["note"] = "只收到一档:富途的多档深度需要 LV2 行情权限。上方为一档盘口。"
        out["liquidity"] = book_liquidity(out)
        return out

    # ---- K 线 -----------------------------------------------------------
    def _history(
        self, code: str, ktype: str, start: str, end: Optional[str], extended: bool
    ) -> List[Dict[str, Any]]:
        """分页拉历史 K 线。start/end 为 'YYYY-MM-DD';end=None 表示取到最新。"""
        mod = _futu()
        session = self._market_session()
        collected: List[Dict[str, Any]] = []
        page_key = None
        for _ in range(20):                      # 上限兜底:20 页 × 1000 根足够任何周期
            kwargs = dict(
                code=code, start=start, end=end,
                ktype=getattr(mod.KLType, ktype), autype=mod.AuType.QFQ,
                max_count=self._PAGE, page_req_key=page_key,
            )
            try:
                with quiet_stdout():
                    try:
                        ret, data, page_key = session.quote_ctx.request_history_kline(
                            extended_time=extended, **kwargs
                        )
                    except TypeError:
                        # 老版本 SDK 没有 extended_time 参数:退回只取盘中,
                        # 并在上层的 note 里说明,而不是假装拿到了全时段数据。
                        ret, data, page_key = session.quote_ctx.request_history_kline(**kwargs)
            except Exception as exc:  # noqa: BLE001
                raise BrokerError("获取 %s 历史 K 线失败:%s" % (code, str(exc)[:200])) from exc
            if ret != mod.RET_OK:
                raise BrokerError(_quote_error(str(data)))
            collected.extend(_rows(data))
            if not page_key:
                break
        return collected

    def historical_bars(self, symbol: str, start: str, end: str) -> List[Dict[str, Any]]:
        """日线历史(回测用)。start/end 为 YYYY-MM-DD;返回按日期升序的 OHLC。"""
        if not self.sessions():
            raise BrokerError("引擎未连接富途 OpenD,无法获取历史数据。请先在「富途 OpenD」面板连接引擎。")
        reason = self.quote_capability(symbol)
        if reason:
            raise BrokerError(reason)
        code = self.code(symbol)
        raw = self._history(code, "K_DAY", start, end, extended=False)

        bars: List[Dict[str, Any]] = []
        for row in raw:
            day = str(_field(row, "time_key", "time") or "")[:10]
            if not (start <= day <= end):
                continue
            values = _ohlc(row)
            if values is None:
                continue
            bars.append({"date": day, **values})
        bars.sort(key=lambda b: b["date"])
        if not bars:
            raise BrokerError(
                "%s 在 %s ~ %s 内没有历史数据(标的代码是否正确?区间是否全是休市日?"
                "富途的历史 K 线额度是否已用完?)" % (symbol, start, end)
            )
        return bars

    def intraday_bars(
        self, symbol: str, timeframe: str, rth: bool = False
    ) -> List[Dict[str, Any]]:
        """按周期拉 K 线(PA 分析用),返回按时间升序的 OHLCV。

        `rth=False` 取全时段(含盘前盘后)——和 IBKR 那边同一口径:隔夜与盘前
        恰恰是缺口和扫单最密集的地方,只取盘中会让收盘后的图停在昨天 16:00。
        """
        spec = TIMEFRAMES.get(timeframe)
        if spec is None:
            raise BrokerError("未知 K 线周期:%s(可选:%s)" % (timeframe, "、".join(TIMEFRAMES)))
        ktype = _KLTYPE.get(timeframe)
        if ktype is None:
            raise BrokerError(
                "富途不提供 %s 周期的 K 线(它的最小档位是 1 分钟,往上是 5 / 15 / 30 / 60 分钟与日线)。"
                "用 1m 或 5m 代替,或把券商接入切回 IBKR。" % spec["label"]
            )
        if not self.sessions():
            raise BrokerError("引擎未连接富途 OpenD,无法获取 K 线。请先在「富途 OpenD」面板连接引擎。")
        reason = self.quote_capability(symbol)
        if reason:
            raise BrokerError(reason)

        code = self.code(symbol)
        daily = timeframe == "1d"
        # 只给下界,不给上界:上界写"本机今天"会在时区两侧各错一次——本机比美东
        # 早的时候截掉当天盘中,晚的时候又要一个未来日期。不给上界,富途自己给到最新。
        today = _date.today()
        span = _duration_days(spec)
        raw = self._history(
            code, ktype, (today - timedelta(days=span)).isoformat(), None, extended=not rth
        )
        # 区间取窄了就退一档再要一次:富途按日历天算,遇上连着的假期第一档可能
        # 凑不满 MIN_BARS,和 IBKR 那边"交易日翻篇"是同一类问题。
        if len(raw) < MIN_BARS:
            raw = self._history(
                code, ktype, (today - timedelta(days=span * 2)).isoformat(), None,
                extended=not rth,
            ) or raw

        bars: List[Dict[str, Any]] = []
        for row in raw:
            values = _ohlc(row)
            if values is None:
                continue
            bars.append(
                {
                    "time": _bar_time(_field(row, "time_key", "time"), daily),
                    **values,
                    "volume": max(_to_float(_field(row, "volume")) or 0.0, 0.0),
                }
            )
        bars.sort(key=lambda b: b["time"])
        bars = bars[-1000:]
        if not bars:
            raise BrokerError(
                "%s 没有返回 %s K 线(标的代码是否正确?是否刚好整段休市?"
                "富途的历史 K 线额度是否已用完?)" % (symbol, spec["label"])
            )
        return bars

    # ---- 期权链(只读,不进下单链路)---------------------------------------
    def option_expiries(self, symbol: str) -> Dict[str, Any]:
        # 这里刻意**不**过 quote_capability:那道闸管的是"标的本身的行情",
        # 而富途的指数**期权链**是支持的(实测 US..SPX 回的是权限错误,不是
        # 「暂不支持」)。指数缺的只是现价,由 option_chain 用平价关系反推。
        mod = _futu()
        session = self._market_session()
        code = self.code(symbol)
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_option_expiration_date(code=code)
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 的期权到期日失败:%s" % (symbol, str(exc)[:200])) from exc
        if ret != mod.RET_OK:
            # 富途对"没开期权行情权限"回的就是一句「无权限…请先申请美股市场期权行情权限」
            # (真机实测)。原来这里还要反问一句"该标的是否有期权",对 AAPL 这种
            # 显然有期权的标的只会把人带偏——交给 _quote_error 统一翻译。
            raise BrokerError("%s:%s" % (symbol, _quote_error(str(data))))
        expiries = sorted(
            {
                _plain_date(str(_field(row, "strike_time", "option_expiry_date") or ""))
                for row in _rows(data)
            }
            - {""}
        )
        if not expiries:
            raise BrokerError("%s 没有可用的到期日" % symbol)
        return {"symbol": symbol, "expiries": expiries, "strikes": [], "exchange": "FUTU"}

    def option_chain(
        self, symbol: str, expiry: Optional[str] = None, width: int = 10
    ) -> Dict[str, Any]:
        """现价附近若干档的期权报价(OI / 成交量 / IV / gamma)。

        只取现价附近的理由和 IBKR 那边一样:整条链动辄上千个合约,而富途的
        行情订阅有额度,一次性铺开会把额度吃干,连定价都会跟着拿不到报价。
        """
        width = max(3, min(int(width), self._CHAIN_MAX_WIDTH))
        mod = _futu()
        session = self._market_session()
        meta = self.option_expiries(symbol)
        target_expiry = expiry or meta["expiries"][0]
        if target_expiry not in meta["expiries"]:
            raise BrokerError(
                "%s 没有 %s 这个到期日。最近的几个:%s"
                % (symbol, target_expiry, "、".join(meta["expiries"][:5]))
            )

        day = _futu_date(target_expiry)
        try:
            with quiet_stdout():
                ret, data = session.quote_ctx.get_option_chain(
                    code=self.code(symbol), start=day, end=day
                )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 的期权链失败:%s" % (symbol, str(exc)[:200])) from exc
        if ret != mod.RET_OK:
            raise BrokerError(_quote_error(str(data)))

        by_strike: Dict[float, List[Dict[str, Any]]] = {}
        for row in _rows(data):
            strike = _to_float(_field(row, "strike_price", "option_strike_price"))
            code = str(_field(row, "code") or "")
            if strike is None or not code:
                continue
            by_strike.setdefault(round(strike, 4), []).append(row)
        if not by_strike:
            raise BrokerError("%s %s 这条链没有任何合约" % (symbol, target_expiry))

        # 现价:能直接问就直接问;富途拿不到的(指数)从这条链自己反推。
        spot, spot_source = self.index_price(symbol), "quote"
        if not spot:
            spot = self._parity_spot(symbol, by_strike)
            spot_source = "parity"

        # 按离现价的距离挑行权价,两侧各 width 档
        strikes = sorted(by_strike)
        nearest = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
        band = strikes[max(0, nearest - width): nearest + width + 1]
        codes = [str(_field(r, "code")) for k in band for r in by_strike[k]]

        snap = self._snapshot(codes)
        rows: List[Dict[str, Any]] = []
        for strike in band:
            for entry in by_strike[strike]:
                code = str(_field(entry, "code") or "")
                row = snap.get(code, {})
                right = _right_of(entry, row)
                rows.append(
                    {
                        "strike": float(strike),
                        "right": right,
                        "oi": _to_float(_field(row, "option_open_interest", "open_interest")) or 0.0,
                        "volume": _to_float(_field(row, "volume")) or 0.0,
                        "gamma": _to_float(_field(row, "option_gamma", "gamma")),
                        "iv": _iv(row),
                    }
                )
        return {
            "symbol": symbol, "expiry": target_expiry, "spot": spot,
            # 界面要能看出这个现价是问来的还是算出来的——算出来的精度取决于
            # 链上报价的质量,不该和真实报价混为一谈。
            "spot_source": spot_source,
            "expiries": meta["expiries"][:20], "rows": rows,
            "multiplier": 100.0, "strike_count": len(band),
        }

    #: 反推现价时在整条行权价网格上取多少个样。取太少拟合不稳,取太多白花快照配额。
    _PARITY_SAMPLES = 24

    def _parity_spot(self, symbol: str, by_strike: Dict[float, List[Dict[str, Any]]]) -> float:
        """用 put-call parity 从这条期权链反推标的现价(富途拿不到指数现价时走这条)。

        在整条行权价网格上均匀取样,而不是只看几个"猜的"平值附近——因为不知道
        现价在哪,正是要解的问题。取样后一次快照拿回所有报价,再做线性拟合。
        """
        strikes = sorted(by_strike)
        if len(strikes) < _PARITY_MIN_POINTS:
            raise BrokerError(
                "%s 这条链只有 %d 个行权价,不够反推现价。" % (symbol, len(strikes))
            )
        step = max(1, len(strikes) // self._PARITY_SAMPLES)
        sampled = strikes[::step][: self._PARITY_SAMPLES]

        codes: Dict[str, Tuple[float, str]] = {}
        for strike in sampled:
            for entry in by_strike[strike]:
                code = str(_field(entry, "code") or "")
                if code:
                    codes[code] = (strike, _right_of(entry, {}))
        snap = self._snapshot(list(codes))

        legs: Dict[float, Dict[str, float]] = {}
        for code, (strike, right) in codes.items():
            price = _option_mid(snap.get(code, {}))
            if price is not None:
                legs.setdefault(strike, {})[right] = price
        pairs = [
            (strike, sides["C"], sides["P"])
            for strike, sides in legs.items()
            if "C" in sides and "P" in sides
        ]
        result = implied_spot(pairs)
        _log_stderr(
            "[futu] %s 的现价由期权链反推得出:%.4f(折现因子 %.6f,最大残差 %.4f,%d 个取样)"
            % (symbol, result["spot"], result["discount"], result["residual"], result["samples"])
        )
        return result["spot"]

    # ---- 交易解锁 --------------------------------------------------------
    def unlock(self, connection_name: Optional[str] = None) -> Dict[str, Any]:
        """实盘交易解锁。密码(的 md5)只从 Keychain / DPAPI 读,不落任何日志。

        富途的实盘下单要求先解锁一次,解锁状态跟着 OpenD 的会话走。模拟盘不需要,
        所以这里不强制:没配密码时明确回一句"只有模拟盘可用",而不是静默放行。
        """
        futu_cfg = self.settings.broker.futu
        names = [connection_name] if connection_name else list(self.connections)
        try:
            secret = get_secret(futu_cfg.keychain_service, futu_cfg.keychain_account)
        except KeychainError as exc:
            raise BrokerError("读取交易解锁密码失败:%s" % exc) from exc
        if not secret:
            raise BrokerError(
                "没有存交易解锁密码(service=%s, account=%s)。"
                "请在「富途 OpenD」面板里填写并保存;不解锁只能下模拟盘。"
                % (futu_cfg.keychain_service, futu_cfg.keychain_account)
            )

        mod = _futu()
        unlocked, failed = [], {}
        for name in names:
            try:
                session = self.connect(name)
            except BrokerError as exc:
                failed[name] = str(exc)
                continue
            try:
                with quiet_stdout():
                    ret, data = session.trade_ctx.unlock_trade(password_md5=secret)
            except Exception as exc:  # noqa: BLE001
                failed[name] = str(exc)[:200]
                continue
            if ret != mod.RET_OK:
                # 只回富途的原文,绝不回显任何与密码有关的内容
                failed[name] = str(data)[:200]
                continue
            session.unlocked = True
            unlocked.append(name)
        return {"unlocked": unlocked, "failed": failed}

    # ---- 持仓 -----------------------------------------------------------
    def positions(self) -> List[Dict[str, Any]]:
        """账户里现在拿着什么。

        富途的 position_list_query 直接给市值和盈亏(pl_val),口径和它自己的
        客户端一致——和 IBKR 那边优先用 portfolio() 是同一个道理:对账要以
        券商报的为准。
        """
        mod = _futu()
        rows: List[Dict[str, Any]] = []
        for session in self.sessions():
            for account in self.settings.accounts:
                if account.account_id not in set(session.accounts):
                    continue
                env = mod.TrdEnv.SIMULATE if account.is_paper else mod.TrdEnv.REAL
                try:
                    with quiet_stdout():
                        ret, data = session.trade_ctx.position_list_query(
                            trd_env=env, acc_id=_acc_id(account.account_id), refresh_cache=True
                        )
                except Exception as exc:  # noqa: BLE001
                    _log_stderr("[futu] 读持仓失败:%s" % str(exc)[:200])
                    continue
                if ret != mod.RET_OK:
                    _log_stderr("[futu] 读持仓失败:%s" % str(data)[:200])
                    continue
                for row in _rows(data):
                    parsed = self._position_row(row, account.alias)
                    if parsed:
                        rows.append(parsed)
        return sorted(rows, key=lambda r: (r["account"], r["symbol"]))

    def _position_row(self, row: Dict[str, Any], alias: str) -> Optional[Dict[str, Any]]:
        code = str(_field(row, "code") or "")
        symbol = code.split(".")[-1]
        qty = _to_float(_field(row, "qty")) or 0.0
        if not symbol or not qty:
            return None
        # 富途用 position_side 表示多空,qty 本身是正的
        side = str(_field(row, "position_side") or "LONG").upper()
        if side.startswith("SHORT"):
            qty = -qty
        return {
            "key": "%s|%s|STK" % (alias, symbol),
            "account": alias,
            "symbol": symbol,
            "sec_type": "STK",
            "quantity": qty,
            "multiplier": 1.0,
            "currency": "USD",
            "avg_cost": _to_float(_field(row, "cost_price")) or 0.0,
            "market_price": _to_float(_field(row, "nominal_price")),
            "market_value": _to_float(_field(row, "market_val")),
            "unrealized_pnl": _to_float(_field(row, "pl_val")),
            "contract": {"secType": "STK", "symbol": symbol,
                         "exchange": "SMART", "currency": "USD"},
        }

    # ---- 下单 -----------------------------------------------------------
    def place(
        self, record_id: str, approved: ApprovedOrder, limit_override: Optional[float] = None
    ) -> PlacementResult:
        parsed = approved.order
        session = self.for_account(approved.account)
        code = self.contract_code(parsed.contract)   # BAG 在这里就被拒
        mod = _futu()

        wanted_env = "SIMULATE" if approved.account.is_paper else "REAL"
        actual_env = session.account_envs.get(approved.account_id, "")
        if actual_env and actual_env != wanted_env:
            # 这不是小错。is_paper 是 allow_live_trading 那道闸的输入:把实盘账号
            # 标成模拟,实盘保护就整个失效了。所以以富途报的为准,不一致直接拒。
            raise BrokerError(
                "账户 %s 在配置里写的是「%s」,但富途报它是「%s」。"
                "is_paper 决定要不要过实盘闸门,写反了等于把保护关掉——已拒绝下单。"
                "请改 config/settings.json 里这个账户的 is_paper。"
                % (approved.account.alias,
                   "模拟盘" if approved.account.is_paper else "实盘",
                   "模拟盘" if actual_env == "SIMULATE" else "实盘")
            )

        if not approved.account.is_paper and not session.unlocked:
            raise BrokerError(
                "实盘账户尚未做交易解锁,拒绝下单。请在「富途 OpenD」面板点「交易解锁」"
                "(解锁状态跟着 OpenD 会话走,重启 OpenD 后要重新解锁)。"
            )

        spec = parsed.order
        limit = limit_override if limit_override is not None else spec.lmtPrice
        kwargs = _order_kwargs(mod, spec, limit)
        try:
            with quiet_stdout():
                ret, data = session.trade_ctx.place_order(
                    code=code,
                    qty=spec.totalQuantity,
                    trd_side=(mod.TrdSide.BUY if spec.action == "BUY" else mod.TrdSide.SELL),
                    trd_env=(
                        mod.TrdEnv.SIMULATE if approved.account.is_paper else mod.TrdEnv.REAL
                    ),
                    acc_id=_acc_id(approved.account_id),
                    # 幂等标识:回报、对账、去重都能凭 remark 找回这条记录
                    remark=record_id[:64],
                    time_in_force=(
                        mod.TimeInForce.GTC if spec.tif == "GTC" else mod.TimeInForce.DAY
                    ),
                    fill_outside_rth=bool(spec.outsideRth),
                    **kwargs,
                )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("富途下单失败:%s" % str(exc)[:300]) from exc
        if ret != mod.RET_OK:
            raise BrokerError("富途拒绝了这笔订单:%s" % str(data)[:300])

        rows = _rows(data)
        futu_order_id = str(_field(rows[0], "order_id") or "") if rows else ""
        if not futu_order_id:
            raise BrokerError(
                "富途没有回订单号,无法跟踪这笔订单的状态。"
                "请立刻在富途客户端里核对是否已经挂单。"
            )

        handle = self._next_handle
        self._next_handle += 1
        self._orders[handle] = {
            "record_id": record_id,
            "futu_order_id": futu_order_id,
            "connection": session.name,
            "account_id": approved.account_id,
            "is_paper": approved.account.is_paper,
            "symbol": parsed.contract.symbol,
            "status": "",
            "dealt": 0.0,
        }
        return PlacementResult(
            record_id=record_id,
            order_id=handle,
            perm_id=handle,
            status=_ORDER_STATUS.get(
                str(_field(rows[0], "order_status") or "").upper(), "Submitted"
            ),
            limit_price=limit,
            detail={"account": approved.account_id, "futu_order_id": futu_order_id,
                    "broker": "futu", "code": code},
        )

    # ---- 回报(拉取式)----------------------------------------------------
    def poll_order_updates(self) -> List[Tuple[str, Any, Any]]:
        """拉一次订单与成交,返回 (kind, trade, fill) 列表。

        富途没有 ib_insync 那种事件流,只能主动拉。返回的对象和 ib_insync 同形,
        engine 里那套现成的入库逻辑就能原样吃下去——两家券商的记录格式因此一致。
        没有这一步,富途下的单会永远停在 Submitted。

        按 (连接, 账户, 交易环境) 分组去查:富途的订单查询是**按账户**的,同一个
        OpenD 上挂着两个账户时,不指定 acc_id 只会回默认账户的单,另一个账户的
        回报就此消失。
        """
        if not self._orders:
            return []
        mod = _futu()
        events: List[Tuple[str, Any, Any]] = []
        for session in self.sessions():
            for (account_id, is_paper), tracked in self._tracked_by_account(session).items():
                env = mod.TrdEnv.SIMULATE if is_paper else mod.TrdEnv.REAL
                # 顺序有讲究:先问成交、再读订单。成交查询会顺带告诉我们这个账户
                # 支不支持逐笔成交(模拟盘不支持),订单那一轮才知道要不要自己合成。
                events.extend(self._poll_deals(mod, session, tracked, env, account_id))
                events.extend(self._poll_orders(mod, session, tracked, env, account_id))
        return events

    def _tracked_by_account(
        self, session: FutuSession
    ) -> Dict[Tuple[str, bool], Dict[str, Tuple[int, Dict[str, Any]]]]:
        grouped: Dict[Tuple[str, bool], Dict[str, Tuple[int, Dict[str, Any]]]] = {}
        for handle, info in self._orders.items():
            if info["connection"] != session.name:
                continue
            key = (info["account_id"], info["is_paper"])
            grouped.setdefault(key, {})[info["futu_order_id"]] = (handle, info)
        return grouped

    def _poll_orders(self, mod, session, tracked, env, account_id) -> List[Tuple[str, Any, Any]]:
        try:
            with quiet_stdout():
                ret, data = session.trade_ctx.order_list_query(
                    trd_env=env, acc_id=_acc_id(account_id), refresh_cache=True
                )
        except Exception as exc:  # noqa: BLE001 - 拉回报失败不该炸掉轮询循环
            _log_stderr("[futu] 拉订单状态失败:%s" % str(exc)[:200])
            return []
        if ret != mod.RET_OK:
            _log_stderr("[futu] 拉订单状态失败:%s" % str(data)[:200])
            return []

        events: List[Tuple[str, Any, Any]] = []
        for row in _rows(data):
            entry = tracked.get(str(_field(row, "order_id") or ""))
            if entry is None:
                continue                      # 别人的单(比如用户在富途客户端里手动下的)
            handle, info = entry
            raw_status = str(_field(row, "order_status") or "").upper()
            status = _ORDER_STATUS.get(raw_status, "Submitted")
            dealt = _to_float(_field(row, "dealt_qty")) or 0.0
            total = _to_float(_field(row, "qty")) or 0.0
            if status == info["status"] and abs(dealt - info["dealt"]) < 1e-9:
                continue                      # 没变化就不重复落库
            filled_delta = dealt - info["dealt"]
            info["status"] = status
            info["dealt"] = dealt
            if filled_delta > 1e-9 and account_id in self._no_deal_query:
                events.append(
                    self._synthetic_fill(handle, info, row, filled_delta, account_id)
                )
            events.append(
                (
                    "status",
                    _ShimTrade(
                        order=_ShimOrder(orderId=handle, permId=handle),
                        orderStatus=_ShimStatus(
                            status=status, filled=dealt, remaining=max(total - dealt, 0.0)
                        ),
                        contract=_ShimContract(symbol=info["symbol"]),
                    ),
                    None,
                )
            )
        return events

    def _poll_deals(self, mod, session, tracked, env, account_id) -> List[Tuple[str, Any, Any]]:
        if account_id in self._no_deal_query:
            return []                     # 这个账户查不了成交,别每轮都白跑一次
        try:
            with quiet_stdout():
                ret, data = session.trade_ctx.deal_list_query(
                    trd_env=env, acc_id=_acc_id(account_id), refresh_cache=True
                )
        except Exception as exc:  # noqa: BLE001
            _log_stderr("[futu] 拉成交明细失败:%s" % str(exc)[:200])
            return []
        if ret != mod.RET_OK:
            # 富途的**模拟盘不支持成交查询**(真机实测回「模拟交易不支持成交查询」)。
            # 认出来之后就不再问,改成从订单行的 dealt_qty / dealt_avg_price 合成
            # 成交——不然纸面账户的记录会只有状态没有成交明细,"自动记录每笔交易"
            # 在这条通道上就成了半句空话。
            self._no_deal_query.add(account_id)
            _log_stderr(
                "[futu] 账户 %s 查不到逐笔成交(%s),改用订单行的成交均价合成。"
                % (redact_for_log(account_id), str(data)[:120])
            )
            return []

        events: List[Tuple[str, Any, Any]] = []
        for row in _rows(data):
            deal_id = str(_field(row, "deal_id") or "")
            entry = tracked.get(str(_field(row, "order_id") or ""))
            if entry is None or not deal_id or deal_id in self._seen_deals:
                continue
            handle, info = entry
            self._seen_deals.add(deal_id)
            events.append(
                (
                    "fill",
                    _ShimTrade(
                        order=_ShimOrder(orderId=handle, permId=handle),
                        orderStatus=_ShimStatus(status="Submitted", filled=0.0, remaining=0.0),
                        contract=_ShimContract(symbol=info["symbol"]),
                    ),
                    _ShimFill(
                        execution=_ShimExecution(
                            execId=deal_id,
                            time=str(_field(row, "create_time", "updated_time") or ""),
                            price=_to_float(_field(row, "price")) or 0.0,
                            shares=_to_float(_field(row, "qty")) or 0.0,
                            side=str(_field(row, "trd_side") or ""),
                            acctNumber=info["account_id"],
                        )
                    ),
                )
            )
        return events

    def _synthetic_fill(self, handle, info, row, shares: float, account_id: str):
        """用订单行的成交均价合成一笔成交(模拟盘专用)。

        它不是逐笔成交:富途模拟盘只给"累计成交量 + 成交均价",所以这里记的是
        **本轮新增的那一段**,价格取当前均价。落库时会显式带上 synthetic 标记,
        免得日后有人拿它当逐笔明细去做滑点归因——那是它给不了的精度。
        """
        info["fill_seq"] = info.get("fill_seq", 0) + 1
        price = _to_float(_field(row, "dealt_avg_price")) or _to_float(_field(row, "price")) or 0.0
        return (
            "fill",
            _ShimTrade(
                order=_ShimOrder(orderId=handle, permId=handle),
                orderStatus=_ShimStatus(status="Submitted", filled=0.0, remaining=0.0),
                contract=_ShimContract(symbol=info["symbol"]),
            ),
            _ShimFill(
                execution=_ShimExecution(
                    execId="%s#%d(合成)" % (info["futu_order_id"], info["fill_seq"]),
                    time=str(_field(row, "updated_time", "create_time") or ""),
                    price=price,
                    shares=shares,
                    side=str(_field(row, "trd_side") or ""),
                    acctNumber=account_id,
                )
            ),
        )

    # ---- 熔断 -----------------------------------------------------------
    def cancel_all_open(self) -> int:
        """熔断用:撤掉**本引擎发出的**全部未成交单(§9.7)。

        刻意不撤别人的单。富途的 order_list_query 会把这个账户下所有渠道的挂单
        都回给你,包括用户在富途客户端里手动挂的——熔断是"停掉这个软件的自动
        执行",不是替用户清空账户。IBKR 那边天然只看得到本 clientId 的单,这里
        用跟踪表把范围对齐;顺带把没被撤的挂单数量写进日志,免得用户以为账户
        已经清空了。
        """
        mod = _futu()
        count, untouched = 0, 0
        for session in self.sessions():
            for (account_id, is_paper), tracked in self._tracked_by_account(session).items():
                env = mod.TrdEnv.SIMULATE if is_paper else mod.TrdEnv.REAL
                try:
                    with quiet_stdout():
                        ret, data = session.trade_ctx.order_list_query(
                            trd_env=env, acc_id=_acc_id(account_id), refresh_cache=True
                        )
                except Exception as exc:  # noqa: BLE001
                    _log_stderr("[futu] 熔断时拉挂单失败:%s" % str(exc)[:200])
                    continue
                if ret != mod.RET_OK:
                    _log_stderr("[futu] 熔断时拉挂单失败:%s" % str(data)[:200])
                    continue
                for row in _rows(data):
                    if str(_field(row, "order_status") or "").upper() not in _OPEN_STATUS:
                        continue
                    order_id = str(_field(row, "order_id") or "")
                    if order_id not in tracked:
                        untouched += 1
                        continue
                    try:
                        with quiet_stdout():
                            ok, detail = session.trade_ctx.modify_order(
                                mod.ModifyOrderOp.CANCEL, order_id, 0, 0,
                                trd_env=env, acc_id=_acc_id(account_id),
                            )
                    except Exception as exc:  # noqa: BLE001 - 撤不掉的要继续撤下一笔
                        _log_stderr("[futu] 撤单失败(%s):%s" % (order_id, str(exc)[:120]))
                        continue
                    if ok == mod.RET_OK:
                        count += 1
                    else:
                        _log_stderr("[futu] 撤单被拒(%s):%s" % (order_id, str(detail)[:120]))
        if untouched:
            _log_stderr(
                "[futu] 熔断只撤了本软件发出的单;账户里还有 %d 笔来自其他渠道的挂单没动。"
                % untouched
            )
        return count

# ======================================================================
# 模块级助手
# ======================================================================
def _order_kwargs(mod, spec, limit: Optional[float]) -> Dict[str, Any]:
    """把本系统的订单类型翻成富途 place_order 的参数。

    价格为空的限价单在这里就报错,不留到富途——和 build_ib_order 同一条原则。
    """
    if spec.orderType == "MKT":
        return {"order_type": mod.OrderType.MARKET, "price": 0.0}
    if spec.orderType == "LMT":
        if limit is None:
            raise BrokerError("限价单缺少限价(AUTO_MID 未定价?),拒绝下单")
        return {"order_type": mod.OrderType.NORMAL, "price": float(limit)}
    if spec.orderType == "STP":
        return {
            "order_type": mod.OrderType.STOP,
            "price": 0.0,
            "aux_price": float(spec.auxPrice),
        }
    if spec.orderType == "STP LMT":
        if limit is None:
            raise BrokerError("止损限价单缺少限价,拒绝下单")
        return {
            "order_type": mod.OrderType.STOP_LIMIT,
            "price": float(limit),
            "aux_price": float(spec.auxPrice),
        }
    if spec.orderType == "TRAIL":
        if spec.trailingPercent is not None:
            return {
                "order_type": mod.OrderType.TRAILING_STOP,
                "price": 0.0,
                "trail_type": mod.TrailType.RATIO,
                "trail_value": float(spec.trailingPercent),
            }
        return {
            "order_type": mod.OrderType.TRAILING_STOP,
            "price": 0.0,
            "trail_type": mod.TrailType.AMOUNT,
            "trail_value": float(spec.auxPrice),
        }
    raise BrokerError("不支持的订单类型:%s" % spec.orderType)


def _acc_id(account_id: str) -> int:
    """富途的账号是数字。转不动就明说是配置写错了,而不是让 SDK 回一个错误码。"""
    try:
        return int(str(account_id).strip())
    except (TypeError, ValueError):
        raise BrokerError(
            "富途账号必须是数字,配置里写的是 %s。"
            "IBKR 的 U/DU 开头账号不能用在富途连接上。" % redact_for_log(str(account_id))
        ) from None


def _level_price(levels) -> float:
    """富途盘口的一档是 (price, volume, order_num[, detail]) 元组。"""
    if not levels:
        return 0.0
    first = levels[0]
    try:
        return float(first[0])
    except (TypeError, ValueError, IndexError):
        return 0.0


def _levels(levels) -> List[Dict[str, float]]:
    out: List[Dict[str, float]] = []
    for level in levels or []:
        try:
            price, size = float(level[0]), float(level[1])
        except (TypeError, ValueError, IndexError):
            continue
        if price > 0:
            out.append({"price": price, "size": size})
    return out


def _ohlc(row: Dict[str, Any]) -> Optional[Dict[str, float]]:
    values = {}
    for key in ("open", "high", "low", "close"):
        value = _to_float(_field(row, key))
        if value is None:
            return None
        values[key] = value
    return values


def _option_mid(row: Dict[str, Any]) -> Optional[float]:
    """一份期权快照 → 可用于平价拟合的价格。

    优先盘口中间价:平价关系用的是"当前价值",而期权的最新成交可能是很久以前
    的一笔,拿它去拟合会把残差撑大、最后整条链被质量闸拒掉。盘口不全时才退到
    最新价。
    """
    bid = _to_float(_field(row, "bid_price"))
    ask = _to_float(_field(row, "ask_price"))
    if bid and ask and bid > 0 and ask >= bid:
        return (bid + ask) / 2.0
    last = _to_float(_field(row, "last_price", "cur_price"))
    return last if last and last > 0 else None


def _right_of(chain_row: Dict[str, Any], snap_row: Dict[str, Any]) -> str:
    """CALL/PUT → C/P。链和快照都可能带这个字段,谁有用谁。"""
    raw = str(_field(chain_row, "option_type") or _field(snap_row, "option_type") or "").upper()
    return "P" if "PUT" in raw else "C"


def _iv(row: Dict[str, Any]) -> Optional[float]:
    """隐含波动率归一到小数(IBKR 口径:0.32 而不是 32)。

    富途给的是百分数。不归一的话期权墙里的 IV 会大 100 倍,画出来的图完全错位。
    """
    value = _to_float(_field(row, "option_implied_volatility", "implied_volatility"))
    if value is None or value <= 0:
        return None
    return round(value / 100.0, 6) if value > 3.0 else value


def _quote_error(text: str) -> str:
    """把富途的取数报错翻成"下一步该做什么"。

    行情权限是这条链路最常见的坑,而富途的原文只会说"没有权限"或回一串错误码,
    不会告诉你去哪开。
    """
    lowered = text.lower()
    if "权限" in text or "permission" in lowered or "no right" in lowered:
        # 期权和股票是两份独立的行情权限,而且**期权链连结构元数据都要权限**
        # (实测:没开权限时连到期日列表都取不到)。分开说,否则用户会去核对
        # 已经开好的那份股票行情,白折腾一圈。
        if "期权" in text or "option" in lowered:
            return (
                "富途返回「没有美股期权行情权限」。这份权限和股票行情是**分开**的:"
                "股票报价能用不代表期权能用,而且没有它连期权链的到期日都取不到。"
                "请在富途 / moomoo 客户端里开通「美股期权行情」,开通后重连引擎即可。"
                "原始报错:%s" % text[:200]
            )
        return (
            "富途返回「没有行情权限」。美股行情要在富途/moomoo 客户端里单独开通"
            "(LV1 基础报价即可满足报价与 K 线;多档盘口需要 LV2)。原始报错:%s" % text[:200]
        )
    if "额度" in text or "quota" in lowered or "limit" in lowered:
        return (
            "富途返回「额度不足」。它的历史 K 线和行情订阅都是按额度计的:"
            "历史 K 线按标的数计费,订阅按条数计。等额度恢复,或减少同时关注的标的。"
            "原始报错:%s" % text[:200]
        )
    return "富途取数失败:%s" % text[:300]


def _close(ctx) -> None:
    if ctx is None:
        return
    try:
        with quiet_stdout():
            ctx.close()
    except Exception:  # noqa: BLE001
        pass
