"""配置与市场日历(设计文档 §9.1 数据分级 / §11 落地建议)。

两条硬约束体现在这里:
1. 真实账号(U/DU 开头)只存在于配置与软件层映射中,`prompt_account_table()`
   只吐别名——LLM 永远见不到账号。
2. 提示词模板不硬编码,放 prompts/ 目录带版本号,配置里指定用哪一版。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from dataclasses import fields as dataclass_fields
from datetime import date, datetime, time
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
BJ = ZoneInfo("Asia/Shanghai")

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent
DEFAULT_PROMPT_DIR = PROJECT_ROOT / "prompts"
DEFAULT_CONFIG_PATH = Path(
    os.environ.get("DAFRI_CONFIG", PROJECT_ROOT / "config" / "settings.json")
)


@dataclass(frozen=True)
class Limits:
    max_order_notional: float = 5_000.0
    max_option_contracts: int = 5
    max_mkt_shares: int = 200
    min_confidence: float = 0.9
    max_spread_slippage: float = 0.10   # AUTO_MID 相对中间价允许的最大加价(绝对美元/张)
    max_orders_per_input: int = 5
    duplicate_window_minutes: int = 10
    duplicate_qty_tolerance: float = 0.2


@dataclass(frozen=True)
class Policies:
    auto_execute: bool = False           # 总开关:false = 只解析校验不下单(§9.7 熔断)
    allow_live_trading: bool = False     # 实盘开关,默认关闭(§11 先跑纸面账户)
    # 组合(BAG)自动平仓:纸面账户不受此开关约束,实盘账户必须显式打开。
    # 平组合要反转每条腿再发 BAG 单,这条路还没在真机上核对过——在核对通过之前,
    # "允许碰实盘"和"信任这条新路径"是两件事,分开授权。
    allow_combo_live: bool = False
    # 合约此刻在盘外时段能交易时,自动给订单打上 outsideRth。
    # 不打这个标志的后果是单子挂着不动——IBKR 会等到常规时段才送交易所(原话:
    # "您的委托单在 …前不会被下达交易所")。而 SPX 期权 20:15–次日 09:25 本来就能成交,
    # 在那个时段下单的人要的显然是现在就成交,不是等明早。默认开;盘外流动性薄、
    # 点差宽,不想在那个时段成交就关掉它。
    auto_outside_rth: bool = True
    require_trigger_price_verification: bool = True
    trigger_min_gap_bps: float = 5.0     # 现价与触发价过近 → 方向不可靠,拒绝
    closed_market_policy: str = "reject_market_orders"  # allow | reject_market_orders | reject_all
    consecutive_failure_breaker: int = 3
    review_feature_enabled: bool = False  # §7 复盘功能会把成交记录外发,默认关闭


@dataclass(frozen=True)
class AccountConfig:
    alias: str
    account_id: str
    is_paper: bool
    connection: str
    default: bool = False


@dataclass(frozen=True)
class ConnectionConfig:
    """一条券商本地网关连接。

    `broker` 决定这条连接说的是谁家的协议:`ibkr` 走 TWS / IB Gateway 的
    socket API,`futu` 走富途 OpenD 的网关端口。两种连接可以同时写在配置里,
    真正被使用的只有 `broker.provider` 指定的那一种——这样切换券商只改一个
    字段,不用把另一家的配置删掉再抄回来。

    client_id 只对 IBKR 有意义(IBKR 用它区分同一个 TWS 上的多个客户端);
    富途 OpenD 没有这个概念,填了也不会被用到。
    """

    name: str
    host: str = "127.0.0.1"
    port: int = 7497
    client_id: int = 11
    readonly: bool = False
    broker: str = "ibkr"          # ibkr | futu


@dataclass(frozen=True)
class FutuConfig:
    """富途 OpenD 的接入参数(仅当 broker.provider="futu" 时生效)。

    和 IBKR 一侧同一条边界:**这里不存任何密码**。富途的登录在 OpenD 自己的
    程序里完成;实盘交易还需要一次"交易解锁",解锁密码属于 §9.1 的 S0 级,
    只走 Keychain / DPAPI(见 keychain.py),配置文件里只记它存在哪个条目。

    symbol_map 是本系统代码(AAPL / SPX)到富途代码(US.AAPL / …)的覆盖表。
    普通美股按 `US.<代码>` 自动拼,拼不出来的(代码带后缀、ADR 之类)在这里指定。

    **它不是"把指数换成 ETF"的后门**:富途 OpenAPI 压根不支持美股指数(实测
    快照/订阅/K 线三条路都回「暂不支持美股指数」),而 SPX 七千多点、SPY 七百
    多块,静默换标的会让触发价整个失去意义。所以指数一律在 quote_capability()
    那里被明确拒绝,和这张表怎么写无关。
    """

    trd_market: str = "US"                       # 交易市场:US / HK / CN
    security_firm: str = "FUTUSECURITIES"        # 券商实体:FUTUSECURITIES / FUTUINC / FUTUSG / FUTUAU
    keychain_service: str = "dafri-futu-unlock"
    keychain_account: str = "futu"
    symbol_map: Dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class BrokerConfig:
    """当前生效的券商接入。

    只能有一个:同一时刻引擎只连一家,免得同一笔单子有两条出路。
    IBKR 的 API 用不了(没装 TWS、握手过不去、行情权限缺)时,把 provider
    改成 futu 就换一条通道,别名表、限额、校验层一律不变。
    """

    provider: str = "ibkr"                       # ibkr | futu
    futu: FutuConfig = field(default_factory=FutuConfig)


@dataclass(frozen=True)
class IndexConfig:
    symbol: str
    exchange: str = "CBOE"
    daily_trading_class: str = ""
    monthly_trading_class: str = ""


@dataclass(frozen=True)
class LLMConfig:
    provider: str = "anthropic"
    model: str = "claude-opus-5"
    effort: str = "high"           # low | medium | high | xhigh | max(仅 Anthropic)
    temperature: Optional[float] = None  # 当前主力 Claude 模型已移除采样参数,留 null
    base_url: str = ""             # 仅 OpenAI 兼容端点需要
    max_tokens: int = 8_000
    timeout_s: float = 60.0
    keychain_service: str = "dafri-llm-api-key"
    keychain_account: str = "anthropic"


@dataclass
class Settings:
    prompt_version: str = "v1.0.0"
    prompt_dir: Path = DEFAULT_PROMPT_DIR
    llm: LLMConfig = field(default_factory=LLMConfig)
    broker: BrokerConfig = field(default_factory=BrokerConfig)
    limits: Limits = field(default_factory=Limits)
    policies: Policies = field(default_factory=Policies)
    accounts: List[AccountConfig] = field(default_factory=list)
    connections: Dict[str, ConnectionConfig] = field(default_factory=dict)
    symbol_aliases: Dict[str, str] = field(default_factory=dict)
    index_symbols: Dict[str, IndexConfig] = field(default_factory=dict)
    market_holidays: List[str] = field(default_factory=list)
    early_close_days: List[str] = field(default_factory=list)
    db_path: Path = Path.home() / "Library/Application Support/dafri/trades.db"
    source_path: Optional[Path] = None

    # ---- 账户映射(别名 → 真实账号,只在软件层做)-------------------------
    def account_by_alias(self, alias: str) -> Optional[AccountConfig]:
        if alias == "DEFAULT":
            return self.default_account()
        for acct in self.accounts:
            if acct.alias == alias:
                return acct
        return None

    def default_account(self) -> Optional[AccountConfig]:
        for acct in self.accounts:
            if acct.default:
                return acct
        return self.accounts[0] if self.accounts else None

    def alias_list(self) -> List[str]:
        return [a.alias for a in self.accounts]

    # ---- 券商接入 -------------------------------------------------------
    def connections_for(self, provider: Optional[str] = None) -> Dict[str, "ConnectionConfig"]:
        """只属于某一家券商的连接。

        两家的连接共用一张表,是为了让"切券商"只改一个字段。代价是每个
        使用方都必须先筛一遍——把 IBKR 的 7497 发给富途的 router 是能连上
        TCP 的,后果是握手一直超时却查不出原因。
        """
        target = provider or self.broker.provider
        return {n: c for n, c in self.connections.items() if c.broker == target}

    def account_broker(self, account: "AccountConfig") -> str:
        """账户实际绑在哪家券商上(由它的连接决定)。"""
        conn = self.connections.get(account.connection)
        return conn.broker if conn else "ibkr"

    # ---- 注入提示词的表(只含别名,绝不含账号)---------------------------
    def prompt_account_table(self) -> str:
        parts = []
        for acct in self.accounts:
            tag = "(默认)" if acct.default else ""
            kind = "纸面测试账户" if acct.is_paper else "实盘账户"
            parts.append("%s=%s%s" % (acct.alias, kind, tag))
        return ";".join(parts) if parts else "(未配置账户,只允许 DEFAULT)"

    def prompt_symbol_table(self) -> str:
        if not self.symbol_aliases:
            return "(未配置中文别名,所有中文公司名一律拒绝)"
        return ";".join("%s=%s" % (k, v) for k, v in self.symbol_aliases.items())

    # ---- 市场日历 -------------------------------------------------------
    def is_trading_day(self, day: date) -> bool:
        if day.weekday() >= 5:
            return False
        return day.isoformat() not in set(self.market_holidays)

    def market_status(self, now_et: datetime) -> str:
        if not self.is_trading_day(now_et.date()):
            return "休市"
        close = time(13, 0) if now_et.date().isoformat() in set(self.early_close_days) else time(16, 0)
        t = now_et.time()
        if t < time(4, 0):
            return "休市"
        if t < time(9, 30):
            return "盘前"
        if t < close:
            return "盘中"
        if t < time(20, 0):
            return "盘后"
        return "休市"

    def index_config(self, symbol: str) -> Optional[IndexConfig]:
        return self.index_symbols.get(symbol.upper())


#: `market_status` 之外的第三种答案:合约在交易,但不在流动性时段(盘外/隔夜)。
#: 闸门认的是"能不能交易",这个和"盘前/盘后"一样属于能交易。
STATUS_OPEN = "盘中"
STATUS_OUTSIDE = "盘外"
STATUS_CLOSED = "休市"


def parse_trading_hours(spec: str) -> List[tuple]:
    """把 IBKR `contractDetails.tradingHours` 拆成 [(开始, 结束)] 的**朴素**时刻对。

    格式:`20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED`。
    时刻是合约自己的时区(`timeZoneId`,SPX 期权是 US/Central),这里不做时区换算——
    换算交给调用方,因为只有它知道 timeZoneId。CLOSED 的日子直接跳过。

    IBKR 已经把节假日算进去了(周末、假期都会是 CLOSED),所以拿它当权威表比自己
    维护一份假期列表可靠。
    """
    out: List[tuple] = []
    for chunk in (spec or "").split(";"):
        chunk = chunk.strip()
        if not chunk or chunk.endswith(":CLOSED"):
            continue
        try:
            start_raw, end_raw = chunk.split("-", 1)
            start = datetime.strptime(start_raw.strip(), "%Y%m%d:%H%M")
            end_raw = end_raw.strip()
            if ":" in end_raw:
                end = datetime.strptime(end_raw, "%Y%m%d:%H%M")
            else:                      # 少数交易所只给结束时刻,当作同一天
                end = datetime.strptime("%s:%s" % (start_raw.split(":")[0], end_raw), "%Y%m%d:%H%M")
        except ValueError:
            continue                   # 认不出的片段跳过,不猜
        if end > start:
            out.append((start, end))
    return out


def hours_status(spec: str, tz_id: str, moment: datetime,
                 liquid: Optional[str] = None) -> str:
    """按合约自己的交易时段判断此刻能不能交易。

    这条路存在的原因:`Settings.market_status` 是照**美股正股**写死的
    (4:00 盘前 / 9:30 盘中 / 16:00 盘后 / 20:00 休市),而 SPX 期权不是那个时段——
    IBKR 报的 SPXW 是 `20:15–次日 09:25`(隔夜)加 `09:30–16:00`(常规,美东)。
    拿正股的表去判期权,0DTE 蝶在隔夜那一整段会被当成"休市",追踪止盈完全不设防。

    返回 STATUS_OPEN(在流动性时段)/ STATUS_OUTSIDE(能交易但不在流动性时段)/
    STATUS_CLOSED。拿不到时段表时返回空串,让调用方退回正股那套。
    """
    if not spec:
        return ""
    try:
        tz = ZoneInfo(tz_id) if tz_id else None
    except Exception:                  # noqa: BLE001 - 认不出的时区不猜,退回正股表
        return ""
    if tz is None:
        return ""
    local = moment.astimezone(tz).replace(tzinfo=None)
    windows = parse_trading_hours(spec)
    if not windows:
        return STATUS_CLOSED
    if not any(start <= local < end for start, end in windows):
        return STATUS_CLOSED
    liquid_windows = parse_trading_hours(liquid or "")
    if liquid_windows and not any(start <= local < end for start, end in liquid_windows):
        return STATUS_OUTSIDE
    return STATUS_OPEN


def load_settings(path: Optional[Path] = None) -> Settings:
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not path.exists():
        raise FileNotFoundError(
            "找不到配置文件 %s。请复制 config/settings.example.json 为 config/settings.json 后修改。" % path
        )
    raw = json.loads(path.read_text(encoding="utf-8"))
    return _from_dict(raw, path)


def patch_config_file(path: Optional[Path], patch: Dict) -> Settings:
    """深合并一份补丁到配置文件。先在内存里验一遍,验不过就不落盘。

    这样 UI 改限额/策略时,写坏的配置永远不会留在磁盘上把软件锁死。
    """
    if path is None:
        raise ValueError("当前设置不是从文件加载的,无法写回")
    path = Path(path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    merged = _deep_merge(raw, patch)
    settings = _from_dict(merged, path)  # 验证:抛异常就不会走到写盘
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    return settings


def _deep_merge(base: Dict, patch: Dict) -> Dict:
    out = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}
_CLOSED_MARKET_POLICIES = {"allow", "reject_market_orders", "reject_all"}
BROKER_PROVIDERS = ("ibkr", "futu")
# 各家网关的默认端口。写在这里而不是散在解析里:配置省略 port 时,
# 富途连接不能悄悄落到 IBKR 的 7497——那会连上另一个程序还看不出错。
DEFAULT_BROKER_PORT = {"ibkr": 7497, "futu": 11111}
_FUTU_MARKETS = {"US", "HK", "CN"}
# 与 futu-api 的 SecurityFirm 枚举对齐(10.10 实测)。少写一个,用那家券商的
# 用户就会卡在"security_firm 只能是…"上,而这跟本软件的安全边界毫无关系。
_FUTU_FIRMS = {
    "FUTUSECURITIES", "FUTUINC", "FUTUSG", "FUTUAU", "FUTUCA", "FUTUJP", "FUTUMY",
}


def _reject_unknown(cls, raw: Dict, label: str) -> None:
    unknown = set(raw) - {f.name for f in dataclass_fields(cls)}
    if unknown:
        raise ValueError("%s 里有未知配置项:%s" % (label, ", ".join(sorted(unknown))))


def _num(raw: Dict, key: str, cast, default, *, minimum=None, maximum=None, label: str):
    if key not in raw:
        return default
    value = raw[key]
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError("%s.%s 必须是数字,收到 %r" % (label, key, value))
    try:
        value = cast(value)
    except (TypeError, ValueError):
        raise ValueError("%s.%s 必须是数字,收到 %r" % (label, key, raw[key]))
    if minimum is not None and value < minimum:
        raise ValueError("%s.%s 不能小于 %s(收到 %s)" % (label, key, minimum, value))
    if maximum is not None and value > maximum:
        raise ValueError("%s.%s 不能大于 %s(收到 %s)" % (label, key, maximum, value))
    return value


def _flag(raw: Dict, key: str, default: bool, label: str) -> bool:
    if key not in raw:
        return default
    value = raw[key]
    # 故意不接受 "true"/"1":配置里写成字符串一律是笔误,而这几个开关误判会直接下单
    if not isinstance(value, bool):
        raise ValueError("%s.%s 必须是 true/false,收到 %r" % (label, key, value))
    return value


def _build_limits(raw: Dict) -> Limits:
    _reject_unknown(Limits, raw, "limits")
    return Limits(
        max_order_notional=_num(raw, "max_order_notional", float, 5_000.0, minimum=0.01, label="limits"),
        max_option_contracts=_num(raw, "max_option_contracts", int, 5, minimum=1, label="limits"),
        max_mkt_shares=_num(raw, "max_mkt_shares", int, 200, minimum=1, label="limits"),
        min_confidence=_num(raw, "min_confidence", float, 0.9, minimum=0.0, maximum=1.0, label="limits"),
        max_spread_slippage=_num(raw, "max_spread_slippage", float, 0.10, minimum=0.0, label="limits"),
        max_orders_per_input=_num(raw, "max_orders_per_input", int, 5, minimum=1, label="limits"),
        duplicate_window_minutes=_num(raw, "duplicate_window_minutes", int, 10, minimum=0, label="limits"),
        duplicate_qty_tolerance=_num(raw, "duplicate_qty_tolerance", float, 0.2, minimum=0.0, label="limits"),
    )


def _build_policies(raw: Dict) -> Policies:
    _reject_unknown(Policies, raw, "policies")
    policy = raw.get("closed_market_policy", "reject_market_orders")
    if policy not in _CLOSED_MARKET_POLICIES:
        raise ValueError(
            "policies.closed_market_policy 只能是 %s" % "、".join(sorted(_CLOSED_MARKET_POLICIES))
        )
    return Policies(
        auto_execute=_flag(raw, "auto_execute", False, "policies"),
        allow_live_trading=_flag(raw, "allow_live_trading", False, "policies"),
        allow_combo_live=_flag(raw, "allow_combo_live", False, "policies"),
        auto_outside_rth=_flag(raw, "auto_outside_rth", True, "policies"),
        require_trigger_price_verification=_flag(
            raw, "require_trigger_price_verification", True, "policies"
        ),
        trigger_min_gap_bps=_num(raw, "trigger_min_gap_bps", float, 5.0, minimum=0.0, label="policies"),
        closed_market_policy=policy,
        consecutive_failure_breaker=_num(
            raw, "consecutive_failure_breaker", int, 3, minimum=1, label="policies"
        ),
        review_feature_enabled=_flag(raw, "review_feature_enabled", False, "policies"),
    )


def _build_llm(raw: Dict) -> LLMConfig:
    _reject_unknown(LLMConfig, raw, "llm")
    effort = raw.get("effort", "high")
    if effort not in _EFFORT_LEVELS:
        raise ValueError("llm.effort 只能是 %s" % "、".join(sorted(_EFFORT_LEVELS)))
    temperature = raw.get("temperature")
    if temperature is not None:
        temperature = _num(raw, "temperature", float, None, minimum=0.0, maximum=2.0, label="llm")

    provider = str(raw.get("provider", "anthropic"))
    from .providers import PROVIDERS, validate_base_url

    if provider not in PROVIDERS:
        raise ValueError("llm.provider 只能是 %s" % "、".join(sorted(PROVIDERS)))
    base_url = str(raw.get("base_url", "") or "")
    if PROVIDERS[provider]["needs_base_url"]:
        try:
            base_url = validate_base_url(base_url)
        except Exception as exc:  # noqa: BLE001
            # 统一成 ValueError:配置层的错误只有一种类型,上层才能一致地
            # 回成"配置校验失败,已回滚",而不是漏成内部错误
            raise ValueError("llm.base_url:%s" % exc)
    model = str(raw.get("model", "") or PROVIDERS[provider]["default_model"])
    if not model:
        raise ValueError("llm.model 不能为空:请在「大模型」面板里选择或填写模型标识")

    return LLMConfig(
        provider=provider,
        model=model,
        effort=effort,
        temperature=temperature,
        base_url=base_url,
        max_tokens=_num(raw, "max_tokens", int, 8_000, minimum=1_000, label="llm"),
        timeout_s=_num(raw, "timeout_s", float, 60.0, minimum=1.0, label="llm"),
        keychain_service=str(raw.get("keychain_service", "dafri-llm-api-key")),
        # 每个供应商一把 key,换供应商不会把上一把冲掉
        keychain_account=str(raw.get("keychain_account", "") or provider),
    )


def _build_futu(raw: Dict) -> FutuConfig:
    _reject_unknown(FutuConfig, raw, "broker.futu")
    market = str(raw.get("trd_market", "US")).upper()
    if market not in _FUTU_MARKETS:
        raise ValueError("broker.futu.trd_market 只能是 %s" % "、".join(sorted(_FUTU_MARKETS)))
    firm = str(raw.get("security_firm", "FUTUSECURITIES")).upper()
    if firm not in _FUTU_FIRMS:
        raise ValueError("broker.futu.security_firm 只能是 %s" % "、".join(sorted(_FUTU_FIRMS)))
    symbol_map = {}
    for key, value in (raw.get("symbol_map") or {}).items():
        code = str(value).strip()
        if not code:
            raise ValueError("broker.futu.symbol_map 里 %s 的富途代码为空" % key)
        symbol_map[str(key).strip().upper()] = code
    return FutuConfig(
        trd_market=market,
        security_firm=firm,
        keychain_service=str(raw.get("keychain_service", "dafri-futu-unlock")),
        keychain_account=str(raw.get("keychain_account", "") or "futu"),
        symbol_map=symbol_map,
    )


def _build_broker(raw: Dict) -> BrokerConfig:
    _reject_unknown(BrokerConfig, raw, "broker")
    provider = str(raw.get("provider", "ibkr"))
    if provider not in BROKER_PROVIDERS:
        raise ValueError("broker.provider 只能是 %s" % "、".join(BROKER_PROVIDERS))
    return BrokerConfig(provider=provider, futu=_build_futu(raw.get("futu", {})))


def _from_dict(raw: Dict, source: Optional[Path] = None) -> Settings:
    accounts = [
        AccountConfig(
            alias=a["alias"],
            account_id=a["account_id"],
            is_paper=bool(a.get("is_paper", True)),
            connection=a.get("connection", "paper"),
            default=bool(a.get("default", False)),
        )
        for a in raw.get("accounts", [])
    ]
    _assert_unique_aliases(accounts)

    connections = {
        name: _build_connection(name, c) for name, c in raw.get("connections", {}).items()
    }
    for conn in connections.values():
        if conn.host not in ("127.0.0.1", "localhost", "::1"):
            # §9.2:API 端口只绑本机,绝不跨网段
            raise ValueError("连接 %s 的 host 必须是本机地址,当前为 %s" % (conn.name, conn.host))

    indexes = {
        sym.upper(): IndexConfig(
            symbol=sym.upper(),
            exchange=c.get("exchange", "CBOE"),
            daily_trading_class=c.get("daily_trading_class", ""),
            monthly_trading_class=c.get("monthly_trading_class", ""),
        )
        for sym, c in raw.get("index_symbols", {}).items()
    }

    storage = raw.get("storage", {})
    prompt_dir = Path(raw["prompt_dir"]).expanduser() if raw.get("prompt_dir") else DEFAULT_PROMPT_DIR

    settings = Settings(
        prompt_version=raw.get("prompt_version", "v1.0.0"),
        prompt_dir=prompt_dir,
        llm=_build_llm(raw.get("llm", {})),
        broker=_build_broker(raw.get("broker", {})),
        limits=_build_limits(raw.get("limits", {})),
        policies=_build_policies(raw.get("policies", {})),
        accounts=accounts,
        connections=connections,
        symbol_aliases={k: str(v).upper() for k, v in raw.get("symbol_aliases", {}).items()},
        index_symbols=indexes,
        market_holidays=list(raw.get("market_holidays", [])),
        early_close_days=list(raw.get("early_close_days", [])),
        db_path=Path(storage.get("db_path", Settings.db_path)).expanduser(),
        source_path=source,
    )
    _assert_account_connections(settings)
    return settings


def _build_connection(name: str, raw: Dict) -> ConnectionConfig:
    broker = str(raw.get("broker", "ibkr"))
    if broker not in BROKER_PROVIDERS:
        raise ValueError(
            "连接 %s 的 broker 只能是 %s(收到 %r)" % (name, "、".join(BROKER_PROVIDERS), broker)
        )
    return ConnectionConfig(
        name=name,
        host=raw.get("host", "127.0.0.1"),
        port=int(raw.get("port", DEFAULT_BROKER_PORT[broker])),
        client_id=int(raw.get("client_id", 11)),
        readonly=bool(raw.get("readonly", False)),
        broker=broker,
    )


def _assert_unique_aliases(accounts: List[AccountConfig]) -> None:
    seen = set()
    defaults = 0
    for a in accounts:
        if a.alias in seen:
            raise ValueError("账户别名重复:%s" % a.alias)
        if a.alias == "DEFAULT":
            raise ValueError("别名不得叫 DEFAULT(保留字)")
        seen.add(a.alias)
        defaults += int(a.default)
    if accounts and defaults != 1:
        raise ValueError("必须且只能有一个账户标记 default=true(当前 %d 个)" % defaults)


def _assert_account_connections(settings: Settings) -> None:
    for acct in settings.accounts:
        if acct.connection not in settings.connections:
            raise ValueError("账户 %s 指向未定义的连接 %s" % (acct.alias, acct.connection))
        if not acct.is_paper and not settings.policies.allow_live_trading:
            continue  # 实盘账户可以配置,但下单时会被 policies.allow_live_trading 拦住
    # 生效的那家券商必须至少有一条连接,否则"已切换"其实是切到了空档:
    # 界面显示富途,连接按钮却无处可连,错误要到下单那一刻才暴露。
    if settings.connections and not settings.connections_for():
        raise ValueError(
            "broker.provider=%s,但 connections 里没有任何 broker=\"%s\" 的连接。"
            "请先在配置里加一条(富途 OpenD 默认端口 %d)。"
            % (settings.broker.provider, settings.broker.provider,
               DEFAULT_BROKER_PORT[settings.broker.provider])
        )


def now_et() -> datetime:
    return datetime.now(tz=ET)


def to_bj(dt_et: datetime) -> datetime:
    return dt_et.astimezone(BJ)
