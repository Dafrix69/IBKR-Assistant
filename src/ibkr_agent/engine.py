"""编排:输入 → 解析 → 硬校验 → 下单 → 落库 → 通知(设计文档 §1 全流程)。

顺序是有意的:任何一步失败都必须在"发单"之前结束。下单只在最后一步发生,
且要同时满足:校验通过、熔断未触发、auto_execute=true、账户允许。
"""
from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .broker import BrokerError, BrokerRouter, PendingTrigger, auto_mid_limit, combo_mid_price, strike_width
from .config import Settings, hours_status, now_et
from .killswitch import KillSwitch
from .llm import LLMError, LLMResponse, build_parser
from .market import build_snapshot, extract_symbols
from .models import LenientParseResult, ParsedOrder, Rejection, parse_llm_payload
from .notify import Notifier
from .prompts import PromptBundle, load_prompt_bundle, render_user
from .shorthand import LOCAL_MODEL, looks_like_shorthand, try_parse_shorthand
from .store import TradeStore, redact_account
from .validator import EXTENDED_STATUSES, ApprovedOrder, RejectedOrder, Validator


@dataclass
class EngineResult:
    submitted: List[Dict[str, Any]] = field(default_factory=list)
    queued: List[Dict[str, Any]] = field(default_factory=list)
    validated_only: List[Dict[str, Any]] = field(default_factory=list)
    rejections: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    llm: Optional[Dict[str, Any]] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "submitted": self.submitted,
            "queued": self.queued,
            "validated_only": self.validated_only,
            "rejections": self.rejections,
            "warnings": self.warnings,
            "llm": self.llm,
        }


def resolve_fanout_accounts(settings, accounts: Optional[Sequence[str]]) -> List[str]:
    """把界面/命令行传来的账户别名列表清洗成去重后的有效别名。

    别名表外的名字直接抛 ValueError——这是用户勾选出来的,不该静默丢掉;
    RPC 层会把它变成 -32602 让界面报错。
    """
    if not accounts:
        return []
    seen: List[str] = []
    for alias in accounts:
        alias = str(alias).strip()
        if not alias or alias in seen:
            continue
        if alias == "DEFAULT" or settings.account_by_alias(alias) is None:
            raise ValueError(
                "账户别名 %r 不在别名表中(可用:%s)。"
                % (alias, "、".join(settings.alias_list()) or "(未配置)")
            )
        seen.append(alias)
    return seen


def fan_out_orders(
    orders: Sequence[ParsedOrder], accounts: Sequence[str]
) -> Tuple[List[ParsedOrder], Optional[str]]:
    """按勾选账户复制未指定账户的订单;返回(新订单列表, 给用户看的说明或 None)。

    - 勾了 1 个账户:DEFAULT 订单改指向它(相当于"这次默认发到这个账户")。
    - 勾了 N 个账户:DEFAULT 订单变 N 份,顺序为 账户1 的所有订单、账户2 的所有订单……
      重复防抖的指纹含账户别名,同一笔订单发到两个账户不会被互相当成重复。
    - 指令里明确写了账户别名的订单原样保留,不复制:用户说了算。
    """
    if not accounts:
        return list(orders), None
    defaults = [o for o in orders if o.account == "DEFAULT"]
    explicit = [o for o in orders if o.account != "DEFAULT"]
    expanded: List[ParsedOrder] = []
    for alias in accounts:
        for order in defaults:
            expanded.append(order.model_copy(update={"account": alias}))
    expanded.extend(explicit)
    if len(accounts) == 1 or not defaults:
        return expanded, None
    note = "已按勾选账户同时发单:%s(每笔订单各 %d 份,各自独立校验与记录)" % (
        "、".join(accounts), len(accounts)
    )
    return expanded, note


class TradingEngine:
    def __init__(
        self,
        settings: Settings,
        parser: Optional[Any] = None,
        store: Optional[TradeStore] = None,
        notifier: Optional[Notifier] = None,
        killswitch: Optional[KillSwitch] = None,
        router: Optional[BrokerRouter] = None,
        bundle: Optional[PromptBundle] = None,
    ):
        self.settings = settings
        self.parser = parser or build_parser(settings.llm)
        self.store = store or TradeStore(settings.db_path)
        self.notifier = notifier or Notifier()
        self.killswitch = killswitch or KillSwitch(
            settings.db_path.parent / "breaker.json",
            threshold=settings.policies.consecutive_failure_breaker,
        )
        self.router = router
        self.bundle = bundle or load_prompt_bundle(settings)
        self.pending_triggers: List[PendingTrigger] = []
        # 券商托管单的对账缓存:track_id → {kind: 托管单信息};orderId → (track_id, kind)。
        # 真相永远在券商那边——重启后由 _adopt_hosted() 按 orderRef 认领重建,
        # 这两张表只是为了少打接口。
        self._hosted: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._hosted_index: Dict[int, Any] = {}
        self._hosted_adopted = False
        # 速记解析的公开源现价注入点(测试替身用;None = macro.public_index_price)
        self.public_price_fn: Optional[Any] = None
        # IBKR orderId / permId → 记录 id,回报进来才知道该往哪条记录上追加
        self._order_index: Dict[int, str] = {}
        self._finalized: set = set()
        # 竞态缓冲:placeOrder 后、_index_placement 前,事件循环可能已经把
        # 成交/状态回报推过来(ib.sleep 会跑事件循环)。此时映射还没建好,
        # 直接丢弃就是"快速成交永远停在 Submitted"。先攒着,建好映射再重放。
        self._unmatched_events: deque = deque(maxlen=200)

    # ------------------------------------------------------------------
    def handle_instruction(
        self,
        instruction: str,
        channel: str = "manual",
        moment: Optional[datetime] = None,
        snapshot: Optional[Mapping[str, float]] = None,
        accounts: Optional[Sequence[str]] = None,
    ) -> EngineResult:
        """解析一条指令并走完校验/执行。

        ``accounts`` 是用户在界面上勾选的目标账户别名。给了就把模型没有指定账户
        (account="DEFAULT")的订单按别名逐个复制——勾两个账户,每笔订单就变成两笔,
        各自独立走校验、落库、下单;指令里明确点名账户的订单不受影响。
        不给或为空维持原行为(DEFAULT → 默认账户)。
        """
        result = EngineResult()
        moment = moment or now_et()
        targets = resolve_fanout_accounts(self.settings, accounts)

        breaker = self.killswitch.state()
        if breaker.engaged:
            message = "自动执行已熔断(%s),本条指令未解析。请在软件里手动解除后重试。" % breaker.reason
            self.notifier.breaker(message)
            result.warnings.append(message)
            return result

        snapshot = dict(snapshot or {})
        if self.router is not None:
            symbols = extract_symbols(instruction, self.settings)
            snapshot = build_snapshot(symbols, self.router.index_price, cached=snapshot)

        # 本地速记优先:用户的固定行话(如「1.8 挂15蝴蝶 15CM」)不必等大模型,
        # 微秒级出与 LLM 同形的 payload,走完全相同的校验与执行路径。
        # 本地解析抛任何异常都静默回落到 LLM——快是锦上添花,不能成为新的故障点。
        local_payload = None
        shorthand_note = None
        try:
            if looks_like_shorthand(instruction):
                # 没连券商时快照里没有现价,「15蝴蝶」的中心算不出来——
                # 用宏观行情带同款公开源兜底(^GSPC 就是 SPX 本尊,分钟级延迟)。
                from .macro import public_index_price
                from .shorthand import shorthand_symbols

                fetch = self.public_price_fn or public_index_price
                for sym in shorthand_symbols(instruction):
                    if snapshot.get(sym) is None:
                        price = fetch(sym)
                        if price is not None:
                            snapshot[sym] = price
                            shorthand_note = (
                                "现价来自公开数据源(可能延迟数分钟),请核对中心行权价与方向"
                            )
            local_payload = try_parse_shorthand(instruction, snapshot, moment)
            if local_payload is not None and shorthand_note:
                for item in local_payload["orders"]:
                    item["warnings"].append(shorthand_note)
        except Exception:  # noqa: BLE001
            local_payload = None

        if local_payload is None and looks_like_shorthand(instruction):
            # 观测点:哪条蝴蝶写法没被本地语法接住(落到大模型)。
            # 不影响任何行为,只为日后照着真实落网样本扩语法。
            self.store.audit("engine", "shorthand_fallback", {"instruction": instruction[:120]})

        if local_payload is not None:
            response = LLMResponse(
                text=json.dumps(local_payload, ensure_ascii=False),
                model=LOCAL_MODEL,
                prompt_version=self.bundle.version,
                prompt_fingerprint=self.bundle.fingerprint,
                latency_ms=0,
                usage={},
                structured_mode="none",
            )

        user_message = None
        if local_payload is None:
            user_message = render_user(
                self.bundle, self.settings, instruction, moment, snapshot=snapshot
            )

        try:
            if local_payload is None:
                response = self.parser.parse(self.bundle, user_message)
        except LLMError as exc:
            # 调用失败 = 这条指令被拒了,不是"提示"。界面要按拒绝显示,别让用户以为下单了
            self.killswitch.record_failure(str(exc), kind="parse")
            self.notifier.rejection("LLM_ERROR", str(exc))
            self.store.audit("engine", "llm_error", {"instruction": instruction, "error": str(exc)})
            result.rejections.append(
                {"source": "engine", "code": "LLM_ERROR", "message": str(exc),
                 "original_text": instruction}
            )
            return result

        result.llm = {
            "model": response.model,
            "prompt_version": response.prompt_version,
            "prompt_fingerprint": response.prompt_fingerprint,
            "latency_ms": response.latency_ms,
            "usage": response.usage,
        }

        try:
            parsed = parse_llm_payload(response.payload())
        except (LLMError, TypeError) as exc:
            self.killswitch.record_failure(str(exc), kind="parse")
            self.notifier.rejection("BAD_PAYLOAD", str(exc))
            self.store.audit("engine", "bad_payload", {"error": str(exc), "raw": response.text[:2000]})
            result.rejections.append(
                {"source": "engine", "code": "BAD_PAYLOAD", "message": str(exc),
                 "original_text": instruction}
            )
            return result

        # 只清"解析失败"计数。券商失败计数必须等真正下单成功才清,
        # 否则每次解析成功都会把连续下单失败的账一笔勾销,熔断永远不触发。
        self.killswitch.record_success(kind="parse")
        for note in parsed.schema_errors:
            result.warnings.append(note)

        # 1. 模型自己拒绝的片段:照样落库,拒绝率是要统计的指标(§11)
        for rejection in parsed.rejections:
            self._record_rejection(instruction, channel, response, rejection, "rejected_by_llm")
            self.notifier.rejection(rejection.code, rejection.message)
            result.rejections.append(
                {"source": "llm", "code": rejection.code, "message": rejection.message,
                 "original_text": rejection.original_text}
            )

        # 2. 软件层硬校验(先按勾选账户扇出:同一笔订单每个账户一份)
        orders, fanout_note = fan_out_orders(parsed.orders, targets)
        if fanout_note:
            result.warnings.append(fanout_note)
            self.store.audit(
                "engine", "fanout",
                {"accounts": list(targets), "orders": len(parsed.orders), "expanded": len(orders)},
            )
        orders = self._auto_outside_rth(orders, moment)
        validator = Validator(
            self.settings,
            moment,
            snapshot=snapshot,
            recent_orders=self.store.recent_orders(
                self.settings.limits.duplicate_window_minutes, moment
            ),
            market_status_fn=lambda o: self._order_market_status(o, moment),
        )
        outcome = validator.validate_all(
            orders, limit=self.settings.limits.max_orders_per_input * max(1, len(targets))
        )

        for rejected in outcome.rejected:
            self._record_validator_rejection(instruction, channel, response, rejected)
            self.notifier.rejection(rejected.primary_code, rejected.message())
            result.rejections.append(
                {
                    "source": "validator",
                    "code": rejected.primary_code,
                    "message": rejected.message(),
                    "intent_summary": rejected.order.intent_summary,
                }
            )

        # 3. 通过的订单
        for approved in outcome.approved:
            record_id = self._record_approved(instruction, channel, response, approved)
            for warning in approved.warnings:
                self.notifier.warning(warning)
                self.store.append_event(record_id, "warning", {"message": warning})
            result.warnings.extend(approved.warnings)

            summary = {
                "record_id": record_id,
                "intent_summary": approved.order.intent_summary,
                "account": approved.account.alias,
                "notional": round(approved.notional, 2),
            }

            if not self.settings.policies.auto_execute:
                self.store.append_event(record_id, "status", {"status": "ValidatedOnly"})
                self.notifier.warning(
                    "已通过校验但未发送(auto_execute=false):%s" % approved.order.intent_summary
                )
                result.validated_only.append(summary)
                continue

            # 批内熔断:前一笔失败触发熔断后,同批剩余订单必须停下。
            # 每笔发出前都重查一次开关(也顺带覆盖"另一进程刚刚手动熔断"的情况)。
            breaker_now = self.killswitch.state()
            if breaker_now.engaged:
                self.store.set_final_status(
                    record_id, "halted_by_breaker", breaker_now.reason
                )
                self.notifier.rejection(
                    "BREAKER_ENGAGED",
                    "熔断已触发,本批剩余订单未提交:%s" % approved.order.intent_summary,
                )
                result.rejections.append(
                    {"source": "engine", "code": "BREAKER_ENGAGED",
                     "message": "熔断已触发,订单未提交(%s)" % breaker_now.reason,
                     "record_id": record_id}
                )
                continue

            try:
                summary.update(self._execute(record_id, approved))
            except BrokerError as exc:
                self.store.set_final_status(record_id, "ibkr_error", str(exc))
                engaged = self.killswitch.record_failure(str(exc), kind="broker")
                code = self._broker_code()
                self.notifier.rejection(code, str(exc))
                if engaged:
                    self.notifier.breaker(engaged.reason)
                result.rejections.append(
                    {"source": "broker", "code": code, "message": str(exc),
                     "record_id": record_id}
                )
                continue

            if summary.get("queued"):
                result.queued.append(summary)
            else:
                # 真正把单发出去了才算"券商成功",清连续失败计数;
                # 仅进入盯盘队列不算。
                self.killswitch.record_success(kind="broker")
                result.submitted.append(summary)
        return result

    # ------------------------------------------------------------------
    def _execute(self, record_id: str, approved: ApprovedOrder) -> Dict[str, Any]:
        if self.router is None:
            raise BrokerError("未接入券商连接(router=None),无法下单。")
        parsed = approved.order

        # 方式 B:两种情况必须由软件盯盘(§8.1)——
        #   ① 条件单 + AUTO_MID:触发那一瞬间才能取中间价;
        #   ② 券商没有原生条件单(富途就没有):否则"涨到 7500 再买"会被当成
        #      普通单立刻发出去,触发价形同虚设。这一条不判断的后果是静默错单。
        native_conditions = getattr(self.router, "SUPPORTS_NATIVE_CONDITIONS", True)
        if parsed.trigger is not None and (
            parsed.order.price_mode == "AUTO_MID" or not native_conditions
        ):
            # 进队列之前先问一句:这个触发标的,券商到底报不报得出价?
            # 报不出来的话队列会一直等一个永远为 None 的价格——界面显示"正在盯盘",
            # 实际上什么都不会发生。这种静默失效比直接拒绝危险得多。
            capability = getattr(self.router, "quote_capability", None)
            reason = capability(parsed.trigger.symbol) if callable(capability) else None
            if reason:
                raise BrokerError(reason)
            self.pending_triggers.append(
                PendingTrigger(
                    record_id=record_id,
                    approved=approved,
                    trigger=parsed.trigger,
                    created_at=datetime.now().astimezone().isoformat(timespec="seconds"),
                )
            )
            self.store.append_event(record_id, "status", {"status": "PendingTrigger"})
            self.notifier.warning(
                "已进入盯盘队列:%s(软件必须保持运行,否则条件不会触发)" % parsed.intent_summary
            )
            return {"queued": True, "mode": "software_watch"}

        # 立即执行的 AUTO_MID 组合:现在就取盘口中间价定限价(与触发路径同一套定价)。
        # 少了这一步,limit 为空会在 build_ib_order 处被拒——那是兜底,不是流程。
        limit_override = None
        if parsed.order.price_mode == "AUTO_MID":
            limit_override = self._price_auto_mid(approved)
            note = (
                "(纸面账户:无实时期权订阅时按延迟盘口定价,成交价参考性有限)"
                if approved.account.is_paper
                else ""
            )
            self.store.append_event(
                record_id, "warning",
                {"message": "AUTO_MID 定价:盘口中间价 ± 滑点上限 → 限价 %.4f%s" % (limit_override, note)},
            )

        placement = self.router.place(record_id, approved, limit_override)
        self._index_placement(record_id, placement)
        self.store.append_event(
            record_id,
            "status",
            {
                "status": placement.status,
                "order_id": placement.order_id,
                "perm_id": placement.perm_id,
            },
        )
        self.notifier.notify(
            "订单已提交",
            parsed.intent_summary,
            subtitle="账户 %s" % redact_account(approved.account_id),
        )
        return {
            "queued": parsed.trigger is not None,
            "mode": "ibkr_condition" if parsed.trigger is not None else "immediate",
            "order_id": placement.order_id,
            "status": placement.status,
        }

    def fire_pending(self, prices: Mapping[str, float]) -> List[Dict[str, Any]]:
        """由盯盘循环按行情回调驱动:检查队列里哪些条件满足,满足就按中间价下单。"""
        fired: List[Dict[str, Any]] = []
        # 触发时刻的熔断复查:条件单可能在校验后数小时才触发,
        # 这期间熔断一旦挂起(自动或手动),排队的单绝不能再出去。
        breaker = self.killswitch.state()
        if breaker.engaged:
            return fired
        for pending in list(self.pending_triggers):
            if pending.fired:
                continue
            price = prices.get(pending.trigger.symbol)
            if price is None or not pending.should_fire(float(price)):
                continue
            # 先落闩再下单:place 走到一半(placeOrder 可能已到达 TWS)之后
            # 抛任何异常,都绝不允许下一轮 watch 把同一笔再发一遍。
            # 宁可少发一单(人工核对后重下),不可重复下单。
            pending.fired = True
            try:
                limit = self._auto_mid_limit(pending)
                placement = self.router.place(pending.record_id, pending.approved, limit)
            except BrokerError as exc:
                self.store.set_final_status(pending.record_id, "ibkr_error", str(exc))
                engaged = self.killswitch.record_failure(str(exc), kind="broker")
                self.notifier.rejection(self._broker_code(), str(exc))
                if engaged:
                    self.notifier.breaker(engaged.reason)
                    break  # 熔断已挂起:本轮不再触发任何后续条件单
                continue
            except Exception as exc:  # noqa: BLE001 - 连接层/事件循环的意外异常
                # 去哪核对要跟着生效的券商说:让富途用户去翻 TWS 是白费一趟,
                # 而这条提示出现的时刻恰恰是最需要他立刻看对地方的时刻。
                where = (
                    "富途客户端" if getattr(self.router, "BROKER", "ibkr") == "futu" else "TWS"
                )
                detail = (
                    "触发下单过程中发生未知异常,订单可能已经到达券商,"
                    "请立即在%s里核对未成交单:%s" % (where, exc)
                )
                self.store.set_final_status(pending.record_id, "ibkr_error", detail)
                engaged = self.killswitch.record_failure(str(exc), kind="broker")
                self.notifier.rejection(self._broker_code(), detail)
                if engaged:
                    self.notifier.breaker(engaged.reason)
                    break
                continue
            self.killswitch.record_success(kind="broker")
            self._index_placement(pending.record_id, placement)
            self.store.append_event(
                pending.record_id,
                "trigger",
                {"symbol": pending.trigger.symbol, "price": price, "limit": limit},
            )
            self.store.append_event(
                pending.record_id,
                "status",
                {"status": placement.status, "order_id": placement.order_id,
                 "perm_id": placement.perm_id},
            )
            self.notifier.notify(
                "条件已触发",
                "%s 现价 %.4f,已按净价 %.4f 提交" % (pending.trigger.symbol, price, limit),
            )
            fired.append({"record_id": pending.record_id, "limit": limit, "price": price})
        self.pending_triggers = [p for p in self.pending_triggers if not p.fired]
        return fired

    def _auto_mid_limit(self, pending: PendingTrigger) -> float:
        return self._price_auto_mid(pending.approved)

    def _price_auto_mid(self, approved: ApprovedOrder) -> float:
        """AUTO_MID 定价:盘口中间价 ± 滑点上限(立即单与触发单共用)。"""
        contract = approved.order.contract
        quotes = self.router.leg_quotes(contract, approved.account)
        mid = combo_mid_price(quotes)
        return auto_mid_limit(
            mid,
            approved.order.order.action,
            self.settings.limits.max_spread_slippage,
            strike_width(contract),
        )

    # ---- 持仓追踪:到价自动平仓 -------------------------------------------
    def poll_trackers(self, moment: Optional[datetime] = None) -> Dict[str, Any]:
        """把每条追踪按当前持仓和现价走一遍;到价且授权齐了就平仓。

        由界面的定时轮询驱动,和方式 B 的盯盘队列是同一套节奏。这里刻意把
        "算"和"发"分开:evaluate() 是纯函数(tracker.py 里单测到底),这个方法
        只负责把它的结论变成一次真实的下单,以及把每一步都落进记录。
        """
        from . import tracker as tk

        moment = moment or now_et()
        out: Dict[str, Any] = {"rows": [], "fired": [], "blocked": []}
        tracks = self.store.list_tracks()
        if not tracks or self.router is None:
            return out

        try:
            positions = {p["key"]: p for p in tk.with_combos(self.router.positions() or [])}
        except Exception as exc:  # noqa: BLE001 - 读不到持仓不该炸掉轮询
            self.store.audit("engine", "positions_failed", {"error": str(exc)[:300]})
            return out

        breaker = self.killswitch.state()
        for track in tracks:
            key = tk.track_key(track)
            raw = positions.get(key)
            if raw is None:
                # 仓位已经不在了(手动平掉、或被别的单平了)。停掉追踪但不删——
                # 用户要能看见"它为什么不再盯了"。
                if track["enabled"]:
                    self.store.update_track(track["id"], enabled=False)
                    self.notifier.warning(
                        "%s 的持仓已不存在,追踪自动停止。" % track["symbol"]
                    )
                out["rows"].append({**track, "state": "closed", "reason": "持仓已不存在"})
                continue

            # 持仓行里的现价来自 TWS 的 portfolio 推送,盘前/盘后常常是空的——
            # 追踪要全时段有效,拿不到就退到行情接口再要一次(只对股票;
            # 期权腿的价格接口不同,拿不到就照实说"本轮不判断")。
            if raw.get("market_price") is None and raw.get("sec_type") == "STK":
                try:
                    fallback = self.router.index_price(raw["symbol"])
                except Exception:  # noqa: BLE001 - 行情失败不该炸掉轮询
                    fallback = None
                if fallback is not None:
                    raw["market_price"] = fallback
                    raw["price_source"] = "quote"
            position = tk.Position(
                account=raw["account"], symbol=raw["symbol"], sec_type=raw["sec_type"],
                quantity=raw["quantity"], avg_cost=raw["avg_cost"],
                multiplier=raw["multiplier"], currency=raw["currency"],
                market_price=raw["market_price"], market_value=raw["market_value"],
                unrealized_pnl=raw["unrealized_pnl"],
            )
            targets = tk.Targets(**(track["targets"] or {}))
            result = tk.evaluate(position, targets, raw["market_price"], track.get("peak"),
                                 minute=moment.hour * 60 + moment.minute)

            # 峰值只在变了的时候写,免得每一轮都打一次库
            if result["peak"] is not None and result["peak"] != track.get("peak"):
                self.store.update_track(track["id"], peak=result["peak"])

            row = {**track, **result, "position": raw}
            out["rows"].append(row)

            if not track["enabled"] or result["state"] == tk.STATE_HOLDING:
                continue

            auto = tk.AutoClose(**(track["auto_close"] or {}))
            if auto.host_at_broker and getattr(
                self.router, "SUPPORTS_HOSTED_CLOSE", False
            ):
                # 触发与执行都归券商托管单(sync_hosted 那条路)。这里若再发一次
                # 平仓,就是托管单 + 软件单各平一次——双重平仓等于反向开仓。
                row["hosted"] = True
                continue
            # 追踪止盈全时段有效:盘前/盘后照样平(平仓单会自动转盘外限价),
            # 只有休市才真的发不出去。期权/组合按**合约自己的**时段判——
            # Settings.market_status 是照美股正股写的,SPX 期权还有 20:15–次日 09:25
            # 那一整段隔夜可交易时间,用正股表会把它整段当成休市(见 broker.contract_hours)。
            market_status = self._market_status_for(raw, moment)
            blockers = tk.close_blockers(
                auto=auto, position=position,
                account_is_paper=self._account_is_paper(track["account"]),
                auto_execute=self.settings.policies.auto_execute,
                allow_live_trading=self.settings.policies.allow_live_trading,
                breaker_engaged=breaker.engaged,
                market_status=market_status,
                outside_rth=True,
                already_fired=bool(track.get("fired_at")),
                combo_live_ok=self.settings.policies.allow_combo_live,
            )
            if blockers:
                # 到价了但发不出去,这件事必须让用户当场知道——他可能正指望
                # 这个止损保命。只提醒一次,不刷屏。
                if not track.get("fired_state"):
                    self.store.update_track(track["id"], fired_state="blocked")
                    self.notifier.warning(
                        "%s %s,但没有平仓:%s" % (track["symbol"], result["reason"],
                                                 "、".join(blockers))
                    )
                row["blocked"] = blockers
                out["blocked"].append({"id": track["id"], "symbol": track["symbol"],
                                       "reason": result["reason"], "blockers": blockers})
                continue

            fired = self._close_position(track, position, auto, result, market_status)
            if fired:
                out["fired"].append(fired)
        return out

    def _auto_outside_rth(self, orders: Sequence[ParsedOrder], moment: datetime) -> List[ParsedOrder]:
        """合约此刻在盘外时段能交易时,自动给订单打上 outsideRth。

        不打这个标志,IBKR 只会把单子挂着、等常规时段才送交易所(TWS 原话:"您的委托单在
        08:30:00 美国/中部前不会被下达交易所")。而 SPX 期权 20:15–次日 09:25 本来就能成交——
        在那个时段按下发送的人要的是现在就成交,不是等明早开盘。

        两条不碰:
          * **市价单不自动打**。盘外只收限价单,打上反而从"挂到开盘"变成"当场被拒";
            让它挂着更接近用户本意。
          * 用户已经显式写了 outsideRth 的不动——显式永远压过自动。
        """
        if not self.settings.policies.auto_outside_rth:
            return list(orders)
        out: List[ParsedOrder] = []
        for order in orders:
            spec = order.order
            status = (self._order_market_status(order, moment)
                      or self.settings.market_status(moment))
            if status in EXTENDED_STATUSES and not spec.outsideRth and spec.orderType != "MKT":
                order = order.model_copy(update={
                    "order": spec.model_copy(update={"outsideRth": True}),
                    "warnings": list(order.warnings) + [
                        "当前为%s,已自动打上盘外标志(outsideRth=true):不打的话这张单会挂着,"
                        "等常规时段才送交易所。不想在盘外成交就把 policies.auto_outside_rth 关掉。"
                        % status
                    ],
                })
            out.append(order)
        return out

    def _order_market_status(self, order, moment: datetime) -> Optional[str]:
        """一张**待下单**的期权/组合此刻面对的时段(拿不到回 None,让校验退回正股表)。

        和持仓那条路(_market_status_for)同一个来源:合约自己的 tradingHours。
        下单与平仓用同一张时段表,否则会出现"能平不能开"或反过来的荒唐结果。
        """
        contract = getattr(order, "contract", None)
        if contract is None or contract.secType not in ("OPT", "FOP", "BAG"):
            return None
        legs = getattr(contract, "legs", None) or []
        if contract.secType == "BAG":
            if not legs:
                return None
            leg = legs[0]
            row_contract = {"secType": "BAG", "symbol": contract.symbol, "legs": [{
                "lastTradeDateOrContractMonth": leg.lastTradeDateOrContractMonth,
                "strike": leg.strike, "right": leg.right, "ratio": 1.0}]}
        else:
            row_contract = {
                "secType": contract.secType, "symbol": contract.symbol,
                "lastTradeDateOrContractMonth": contract.lastTradeDateOrContractMonth,
                "strike": contract.strike, "right": contract.right,
            }
        row = {"account": order.account, "symbol": contract.symbol,
               "sec_type": contract.secType, "contract": row_contract}
        status = self._market_status_for(row, moment)
        # 与正股表一致时返回 None:让 validator 用它自己那个,少一次无谓的分歧
        return None if status == self.settings.market_status(moment) else status

    def _market_status_for(self, raw: Dict[str, Any], moment: datetime) -> str:
        """这条持仓此刻能不能交易。期权/组合优先用合约的真实时段,拿不到就退回正股表。"""
        if str(raw.get("sec_type") or "") not in ("OPT", "FOP", "BAG"):
            return self.settings.market_status(moment)
        getter = getattr(self.router, "contract_hours", None)
        if getter is None:
            return self.settings.market_status(moment)
        account = self.settings.account_by_alias(raw.get("account") or "")
        if account is None:
            return self.settings.market_status(moment)
        try:
            hours = getter(raw, account)
        except Exception:  # noqa: BLE001 - 查时段失败不该炸掉轮询
            hours = None
        if not hours:
            return self.settings.market_status(moment)
        trading, liquid, tz_id = hours
        status = hours_status(trading, tz_id, moment, liquid)
        return status or self.settings.market_status(moment)

    def _account_is_paper(self, alias: str) -> bool:
        account = self.settings.account_by_alias(alias)
        return bool(account.is_paper) if account else True

    def _close_position(
        self, track, position, auto, result, market_status: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """真的把平仓单发出去,并且**先落闩再发**。

        闩(fired_at)必须在发单之前写:place() 走到一半抛异常时,单子可能已经
        到了券商——这时候下一轮再发一次,就从平仓变成了反向开仓。宁可少发一单
        让用户手动补,不可重复发。
        """
        from . import tracker as tk
        from .models import parse_llm_payload

        payload = tk.build_close_order(
            position, auto, result.get("price"), result["state"], track["contract"] or {},
            market_status=market_status or self.settings.market_status(now_et()),
        )
        try:
            parsed = parse_llm_payload({"orders": [payload], "rejections": []})
        except Exception as exc:  # noqa: BLE001
            self.notifier.rejection("TRACKER_ERROR", "平仓单构造失败:%s" % exc)
            return None
        if not parsed.orders:
            self.notifier.rejection("TRACKER_ERROR", "平仓单没有通过 schema 校验,已放弃。")
            return None

        account = self.settings.account_by_alias(track["account"])
        if account is None:
            self.notifier.rejection("TRACKER_ERROR", "账户别名 %s 已不存在。" % track["account"])
            return None

        order = parsed.orders[0]
        approved = ApprovedOrder(
            order=order, account=account,
            notional=abs(position.quantity) * (position.market_price or 0)
            * (position.multiplier or 1.0),
            signature="tracker:%s" % track["id"],
            warnings=["由持仓追踪自动发出,未经模型解析"],
        )
        record_id = self.store.create_record(
            {**self._base_record(payload["intent_summary"], "tracker", None),
             "account": {"alias": account.alias, "account_id": account.account_id,
                         "is_paper": account.is_paper},
             "contract": order.contract.model_dump(),
             "order": order.order.model_dump(),
             "execution_type": "IMMEDIATE",
             "notional_estimate": approved.notional}
        )
        self.store.append_event(record_id, "warning", {"message": result["reason"]})

        # 先落闩
        self.store.update_track(
            track["id"], fired_at=now_et().isoformat(timespec="seconds"),
            fired_state=result["state"], fired_record=record_id, enabled=False,
        )
        try:
            placement = self.router.place(record_id, approved)
        except Exception as exc:  # noqa: BLE001
            detail = "自动平仓下单失败:%s。请立刻手动核对持仓。" % exc
            self.store.set_final_status(record_id, "ibkr_error", detail)
            self.killswitch.record_failure(str(exc), kind="broker")
            self.notifier.rejection(self._broker_code(), detail)
            return None

        self._index_placement(record_id, placement)
        self.store.append_event(record_id, "status", {"status": placement.status,
                                                      "order_id": placement.order_id})
        self.killswitch.record_success(kind="broker")
        self.notifier.notify(
            "自动平仓已发出",
            "%s:%s" % (track["symbol"], result["reason"]),
            subtitle=redact_account(account.account_id),
        )
        return {"id": track["id"], "symbol": track["symbol"], "state": result["state"],
                "record_id": record_id, "reason": result["reason"],
                "order_id": placement.order_id}

    # ---- 券商托管的止盈/止损:对账循环 -----------------------------------
    def sync_hosted(self, moment: Optional[datetime] = None) -> Dict[str, Any]:
        """把"追踪设置"和"券商侧挂着的托管单"对齐(挂缺的、改变了的、撤多余的)。

        由界面按秒驱动。软件盯盘怕的三件事——轮询漏插针、软件必须开着、我们
        这头行情延迟——托管单都不怕:触发发生在券商服务器的实时行情上。这里
        每一轮只做增量:该挂的挂上、动态停损价变了就改、不该在的撤掉。
        """
        from . import tracker as tk

        out: Dict[str, Any] = {"hosted": [], "blocked": [], "quote_maybe_delayed": False}
        router = self.router
        if router is None or not getattr(router, "SUPPORTS_HOSTED_CLOSE", False):
            return out
        tracks = self.store.list_tracks()
        wants_hosting = any((t["auto_close"] or {}).get("host_at_broker") for t in tracks)
        if not wants_hosting and not self._hosted:
            return out
        if not self._hosted_adopted:
            self._adopt_hosted()

        try:
            positions = {p["key"]: p for p in tk.with_combos(router.positions() or [])}
        except Exception as exc:  # noqa: BLE001 - 读不到持仓不该炸掉对账
            self.store.audit("engine", "hosted_positions_failed", {"error": str(exc)[:300]})
            return out

        breaker = self.killswitch.state()
        alive = set()
        for track in tracks:
            tid = track["id"]
            auto = tk.AutoClose(**(track["auto_close"] or {}))
            if not auto.host_at_broker:
                self._cancel_hosted_track(tid, "托管已关闭")
                continue
            if self._account_is_paper(track["account"]):
                # 模拟账户常拿延迟行情:动态调整可能滞后(且只会偏松,不会偏紧),
                # 托管单本身仍由券商实时触发——把这件事告诉界面。
                out["quote_maybe_delayed"] = True
            key = tk.track_key(track)
            raw = positions.get(key)
            if raw is None:
                self._cancel_hosted_track(tid, "持仓已不存在")
                continue
            position = tk.Position(
                account=raw["account"], symbol=raw["symbol"], sec_type=raw["sec_type"],
                quantity=raw["quantity"], avg_cost=raw["avg_cost"],
                multiplier=raw["multiplier"], currency=raw["currency"],
                market_price=raw["market_price"], market_value=raw["market_value"],
                unrealized_pnl=raw["unrealized_pnl"],
            )
            # 托管单只是挂着,不是立刻成交——时段闸门不适用,其余闸门照过:
            # 挂单也是发单,授权(auto_execute/实盘开关)与熔断一个都不能少。
            blockers = tk.close_blockers(
                auto=auto, position=position,
                account_is_paper=self._account_is_paper(track["account"]),
                auto_execute=self.settings.policies.auto_execute,
                allow_live_trading=self.settings.policies.allow_live_trading,
                breaker_engaged=breaker.engaged,
                market_status="盘中",
                already_fired=bool(track.get("fired_at")),
            )
            if blockers:
                self._cancel_hosted_track(tid, "、".join(blockers))
                out["blocked"].append({"id": tid, "symbol": track["symbol"],
                                       "blockers": blockers})
                continue

            peak = tk.advance_peak(position, raw["market_price"], track.get("peak"))
            if peak is not None and peak != track.get("peak"):
                self.store.update_track(tid, peak=peak)
            plan = tk.hosted_plan(
                position, tk.Targets(**(track["targets"] or {})), auto, peak
            )
            alive.add(tid)
            current = self._hosted.setdefault(tid, {})
            desired = {item["kind"] for item in plan}
            for kind in [k for k in current if k not in desired]:
                self._cancel_hosted_one(tid, kind, "该目标已移除")
            oca = "dafri-trk-%s" % tid[:8]
            for item in plan:
                cur = current.get(item["kind"])
                try:
                    if cur is None:
                        self._place_hosted_one(track, item, oca)
                    elif tk.hosted_needs_update(cur, item):
                        self._modify_hosted_one(track, cur, item)
                except Exception as exc:  # noqa: BLE001 - 单张失败不拖垮整轮
                    self.store.audit("engine", "hosted_place_failed", {
                        "track": tid, "kind": item["kind"], "error": str(exc)[:300],
                    })
                    self.killswitch.record_failure(str(exc), kind="broker")
            entries = self._hosted.get(tid) or {}
            out["hosted"].append({
                "id": tid, "symbol": track["symbol"],
                "orders": [
                    {k: v.get(k) for k in ("kind", "label", "quantity", "lmt_price",
                                            "aux_price", "trailing_percent", "order_id")}
                    for v in entries.values()
                ],
            })

        for tid in [t for t in self._hosted if t not in alive and t not in
                    {tr["id"] for tr in tracks}]:
            self._cancel_hosted_track(tid, "追踪已删除")
        return out

    def _adopt_hosted(self) -> None:
        """重启后按 orderRef 认领券商侧还挂着的托管单——先认领再对账,
        否则同一追踪会被再挂一遍。"""
        lister = getattr(self.router, "list_hosted_open", None)
        if not callable(lister):
            self._hosted_adopted = True
            return
        try:
            rows = lister()
        except Exception as exc:  # noqa: BLE001 - 下一轮再试
            self.store.audit("engine", "hosted_adopt_failed", {"error": str(exc)[:300]})
            return
        from . import tracker as tk

        for row in rows:
            parts = str(row.get("order_ref") or "").split(":")
            if len(parts) != 3 or parts[0] != "trk":
                continue
            _, tid, kind = parts
            entry = {
                "kind": kind,
                "label": tk.HOSTED_LABELS.get(kind, kind),
                "order_id": row.get("order_id"),
                "record_id": None,
                "quantity": row.get("quantity"),
                "lmt_price": row.get("lmt_price"),
                "aux_price": row.get("aux_price"),
                "trailing_percent": row.get("trailing_percent"),
            }
            self._hosted.setdefault(tid, {})[kind] = entry
            if row.get("order_id"):
                self._hosted_index[int(row["order_id"])] = (tid, kind)
        self._hosted_adopted = True
        if rows:
            self.store.audit("engine", "hosted_adopted", {"count": len(rows)})

    def _place_hosted_one(self, track, item, oca: str) -> None:
        from .models import ContractSpec

        account = self.settings.account_by_alias(track["account"])
        if account is None:
            raise BrokerError("账户别名 %s 已不存在。" % track["account"])
        contract_spec = ContractSpec.model_validate(track["contract"] or {})
        ref = "trk:%s:%s" % (track["id"], item["kind"])
        record = self._base_record(
            "%s:%s %d %s(GTC,挂在券商服务器)" % (
                item["label"], item["action"], item["quantity"], track["symbol"]
            ),
            "tracker", None,
        )
        record["account"] = {"alias": account.alias, "account_id": account.account_id,
                             "is_paper": account.is_paper}
        record["contract"] = dict(track["contract"] or {})
        record["order"] = {k: item.get(k) for k in
                           ("action", "order_type", "quantity", "lmt_price",
                            "aux_price", "trailing_percent")}
        record["execution_type"] = "HOSTED"
        record["signature"] = ref
        record_id = self.store.create_record(record)

        result = self.router.place_hosted(account, contract_spec, item, oca, ref)
        entry = {**item, "order_id": result.get("order_id"), "record_id": record_id}
        self._hosted.setdefault(track["id"], {})[item["kind"]] = entry
        if result.get("order_id"):
            self._hosted_index[int(result["order_id"])] = (track["id"], item["kind"])
            self._order_index[int(result["order_id"])] = record_id
        if result.get("perm_id"):
            self._order_index[int(result["perm_id"])] = record_id
        self.store.append_event(record_id, "status", {
            "status": result.get("status"), "order_id": result.get("order_id"),
        })
        self.killswitch.record_success(kind="broker")
        self.notifier.notify("托管单已挂出", "%s:%s" % (track["symbol"], item["label"]))

    def _modify_hosted_one(self, track, current, item) -> None:
        order_id = current.get("order_id")
        if not order_id:
            return
        ok = self.router.modify_hosted(int(order_id), item)
        if not ok:
            # 券商侧已经不认识这张单(成交/撤销竞态):丢掉缓存,下一轮重挂
            self._drop_hosted_entry(track["id"], current.get("kind"))
            return
        record_id = current.get("record_id")
        if record_id:
            self.store.append_event(record_id, "status", {
                "status": "Adjusted",
                "lmt_price": item.get("lmt_price"),
                "aux_price": item.get("aux_price"),
                "quantity": item.get("quantity"),
            })
        current.update({k: item.get(k) for k in
                        ("quantity", "lmt_price", "aux_price", "trailing_percent",
                         "label")})

    def _cancel_hosted_track(self, track_id: str, reason: str) -> None:
        entries = self._hosted.get(track_id)
        if not entries:
            return
        for kind in list(entries):
            self._cancel_hosted_one(track_id, kind, reason)

    def _cancel_hosted_one(self, track_id: str, kind: str, reason: str) -> None:
        entries = self._hosted.get(track_id) or {}
        entry = entries.get(kind)
        if entry is None:
            return
        order_id = entry.get("order_id")
        if order_id:
            try:
                self.router.cancel_hosted(int(order_id))
            except Exception as exc:  # noqa: BLE001 - 撤单失败要让人知道,但不炸循环
                self.store.audit("engine", "hosted_cancel_failed", {
                    "track": track_id, "kind": kind, "error": str(exc)[:300],
                })
                return
        record_id = entry.get("record_id")
        if record_id:
            self.store.append_event(record_id, "status",
                                    {"status": "Cancelled", "reason": reason})
        self._drop_hosted_entry(track_id, kind)

    def _drop_hosted_entry(self, track_id: str, kind) -> None:
        entries = self._hosted.get(track_id)
        if entries and kind in entries:
            order_id = entries[kind].get("order_id")
            if order_id:
                self._hosted_index.pop(int(order_id), None)
            del entries[kind]
        if entries is not None and not entries:
            self._hosted.pop(track_id, None)

    #: 托管单成交 → 追踪落闩时,kind 映射回软件盯盘同一套触发状态
    _HOSTED_FIRED_STATE = {"tp": "take_profit", "sl": "stop_loss",
                           "trail": "stop_loss", "ptrail": "profit_trail"}

    def _hosted_on_status(self, trade) -> None:
        """托管单的终态处理:成交 → 追踪落闩;撤销 → 丢缓存。

        OCA 的兄弟单由券商自动撤,撤单回报走同一条路清理缓存。
        """
        order_id = getattr(getattr(trade, "order", None), "orderId", None)
        if not order_id or int(order_id) not in self._hosted_index:
            return
        tid, kind = self._hosted_index[int(order_id)]
        status = getattr(getattr(trade, "orderStatus", None), "status", "")
        if status == "Filled":
            entry = (self._hosted.get(tid) or {}).get(kind) or {}
            self.store.update_track(
                tid, fired_at=now_et().isoformat(timespec="seconds"),
                fired_state=self._HOSTED_FIRED_STATE.get(kind, kind),
                fired_record=entry.get("record_id") or "", enabled=False,
            )
            track = self.store.get_track(tid)
            symbol = track["symbol"] if track else "?"
            self.notifier.notify("托管单已成交", "%s:%s" % (symbol, entry.get("label", kind)))
            # 整组落闩:OCA 兄弟单券商会自己撤,这里直接清缓存
            for k in list(self._hosted.get(tid) or {}):
                self._drop_hosted_entry(tid, k)
        elif status in ("Cancelled", "ApiCancelled", "Inactive"):
            self._drop_hosted_entry(tid, kind)

    def expire_pending(self, moment: Optional[datetime] = None) -> int:
        """收盘后清理当日未触发的条件单(tif=DAY 的语义,§8.2b)。"""
        moment = moment or now_et()
        if self.settings.market_status(moment) != "休市":
            return 0
        count = 0
        for pending in self.pending_triggers:
            if pending.approved.order.order.tif == "GTC":
                continue
            self.store.set_final_status(pending.record_id, "expired_untriggered")
            self.notifier.warning("条件单当日未触发,已失效:%s" % pending.approved.order.intent_summary)
            pending.fired = True
            count += 1
        self.pending_triggers = [p for p in self.pending_triggers if not p.fired]
        return count

    # ---- IBKR 回报 → 落库(§6 status_timeline / fills)----------------------
    def _index_placement(self, record_id: str, placement) -> None:
        for key in (placement.perm_id, placement.order_id):
            if key:
                self._order_index[int(key)] = record_id
        self._replay_unmatched()

    def _replay_unmatched(self) -> None:
        """映射建好后,把先前无主的回报重放一遍(见 _unmatched_events 注释)。"""
        if not self._unmatched_events:
            return
        stashed = list(self._unmatched_events)
        self._unmatched_events.clear()
        for kind, trade, fill, report in stashed:
            if self._record_for(trade) is None:
                self._unmatched_events.append((kind, trade, fill, report))
                continue
            if kind == "status":
                self._on_order_status(trade)
            elif kind == "exec":
                self._on_exec_details(trade, fill)
            elif kind == "commission":
                self._on_commission(trade, fill, report)

    def _wire_session(self, ib) -> bool:
        """给一条 IB 会话挂上全部回报监听(幂等)。

        只有 ib_insync 的会话有事件流。富途的会话没有,它的回报靠
        sync_broker_orders() 主动拉——这里直接放行,而不是让 `+=` 抛
        AttributeError 把整条连接流程带崩。
        """
        if getattr(ib, "_dafri_wired", False):
            return False
        if not hasattr(ib, "orderStatusEvent"):
            return False
        ib.orderStatusEvent += self._on_order_status
        ib.execDetailsEvent += self._on_exec_details
        ib.commissionReportEvent += self._on_commission
        # 大量拒单(110 价格档位、201 保证金、203 无权限)只走 errorEvent;
        # 不监听它,被拒的订单永远不会有终态。
        if hasattr(ib, "errorEvent"):
            ib.errorEvent += self._on_ib_error
        ib._dafri_wired = True
        return True

    def attach_listeners(self) -> int:
        """把每条连接的订单状态与成交回报接到 append-only 存储上。

        没有这一步,记录会停在 Submitted——"自动记录每笔交易"就是空话。
        同时把 _wire_session 注册为 router 的 session_hook:TWS 重启后
        connect() 换上的新会话会自动重新挂监听,而不是悄悄变成黑洞。
        """
        if self.router is None:
            return 0
        try:
            self.router.session_hook = self._wire_session
        except Exception:  # noqa: BLE001 - 测试替身可能不接受该属性
            pass
        attached = 0
        sessions = getattr(self.router, "sessions", None)
        for ib in (sessions() if callable(sessions) else []):
            if self._wire_session(ib):
                attached += 1
        return attached

    def _broker_code(self) -> str:
        """拒绝码里的券商名。

        这个字符串是**用户可见的**:通知的副标题、拒绝卡片的标题都用它。
        富途用户看到「broker · IBKR_ERROR」只会以为软件连错了地方。
        """
        return "FUTU_ERROR" if getattr(self.router, "BROKER", "ibkr") == "futu" else "IBKR_ERROR"

    def sync_broker_orders(self) -> int:
        """拉取式回报同步(富途没有事件流,只能主动拉)。

        拉回来的对象与 ib_insync 同形,直接喂给下面那套现成的入库逻辑——
        两家券商的 status_timeline / fills 因此长得一模一样。IBKR 的 router
        没有这个方法,调用就是空转,不用分支判断。
        """
        puller = getattr(self.router, "poll_order_updates", None)
        if not callable(puller):
            return 0
        try:
            updates = puller()
        except Exception as exc:  # noqa: BLE001 - 拉回报失败不该拖垮轮询循环
            self.store.audit("engine", "poll_orders_failed", {"error": str(exc)})
            return 0
        count = 0
        for kind, trade, fill in updates:
            if kind == "status":
                self._on_order_status(trade)
            elif kind == "fill":
                self._on_exec_details(trade, fill)
            else:
                continue
            count += 1
        return count

    _TERMINAL_IB_STATUS = {
        "Filled": "filled",
        "Cancelled": "cancelled",
        "ApiCancelled": "cancelled",
        "Inactive": "ibkr_error",
    }

    def _stash_unmatched(self, kind: str, trade, fill=None, report=None) -> None:
        # 只攒带 orderId/permId 的回报——完全无主的(别的 client 的单)没必要留
        order = getattr(trade, "order", None)
        if order is None:
            return
        if getattr(order, "permId", None) or getattr(order, "orderId", None):
            self._unmatched_events.append((kind, trade, fill, report))

    # IBKR 信息类代码:行情农场连接状态等,与订单成败无关
    _IB_INFO_MIN, _IB_INFO_MAX = 2100, 2200

    def _on_ib_error(self, reqId, errorCode, errorString, contract=None, *extra) -> None:
        """订单级 errorEvent → 终态落库。

        价格档位不合法(110)、保证金不足(201)、无交易权限(203)这类拒单
        只从 errorEvent 来;orderStatus 不会给终态。reqId 对订单级错误就是
        orderId,可直接查映射。
        """
        try:
            code = int(errorCode)
            req = int(reqId)
        except (TypeError, ValueError):
            return
        if req <= 0:
            return  # 系统级消息(连接、行情农场),与具体订单无关
        record_id = self._order_index.get(req)
        if record_id is None:
            return
        message = str(errorString or "")
        if self._IB_INFO_MIN <= code < self._IB_INFO_MAX:
            self.store.append_event(record_id, "warning", {"message": "IBKR %d: %s" % (code, message)})
            return
        final = "cancelled" if code == 202 else "ibkr_error"
        self.store.append_event(
            record_id, "status", {"status": "Error", "code": code, "message": message}
        )
        if record_id not in self._finalized:
            self._finalized.add(record_id)
            self.store.set_final_status(record_id, final, "IBKR %d: %s" % (code, message))
        if final == "ibkr_error":
            self.notifier.rejection("IBKR_ERROR", "IBKR %d: %s" % (code, message))

    def _record_for(self, trade) -> Optional[str]:
        for key in (getattr(trade.order, "permId", None), getattr(trade.order, "orderId", None)):
            if key and key in self._order_index:
                return self._order_index[key]
        return None

    def _on_order_status(self, trade) -> None:
        self._hosted_on_status(trade)
        record_id = self._record_for(trade)
        if not record_id:
            self._stash_unmatched("status", trade)
            return
        status = getattr(trade.orderStatus, "status", "")
        self.store.append_event(
            record_id,
            "status",
            {
                "status": status,
                "filled": getattr(trade.orderStatus, "filled", None),
                "remaining": getattr(trade.orderStatus, "remaining", None),
            },
        )
        final = self._TERMINAL_IB_STATUS.get(status)
        if final == "filled" and getattr(trade.orderStatus, "remaining", 0):
            final = "partially_filled"
        if final and record_id not in self._finalized:
            self._finalized.add(record_id)
            self.store.set_final_status(record_id, final)

    def _on_exec_details(self, trade, fill) -> None:
        record_id = self._record_for(trade)
        if not record_id:
            self._stash_unmatched("exec", trade, fill)
            return
        execution = getattr(fill, "execution", None)
        if execution is None:
            return
        self.store.append_event(
            record_id,
            "fill",
            {
                "exec_id": getattr(execution, "execId", ""),
                "time": str(getattr(execution, "time", "")),
                "price": float(getattr(execution, "price", 0) or 0),
                "qty": float(getattr(execution, "shares", 0) or 0),
                "commission": 0.0,
            },
        )
        self.notifier.fill(
            getattr(trade.contract, "symbol", "?"),
            getattr(execution, "side", "?"),
            float(getattr(execution, "shares", 0) or 0),
            float(getattr(execution, "price", 0) or 0),
            redact_account(getattr(execution, "acctNumber", "")),
        )

    def _on_commission(self, trade, fill, report) -> None:
        record_id = self._record_for(trade)
        if not record_id:
            self._stash_unmatched("commission", trade, fill, report)
            return
        self.store.append_event(
            record_id,
            "commission",
            {
                "exec_id": getattr(report, "execId", ""),
                "commission": float(getattr(report, "commission", 0) or 0),
                "realized_pnl": getattr(report, "realizedPNL", None),
            },
        )

    def halt(self, reason: str) -> Dict[str, Any]:
        """§9.7 全局熔断:停新单 + 撤未成交单。"""
        state = self.killswitch.engage(reason)
        cancelled = self.router.cancel_all_open() if self.router else 0
        self.pending_triggers.clear()
        # 托管单也被 cancel_all_open 撤掉了,缓存跟着清;熔断解除后由对账循环
        # 按闸门决定要不要重挂(熔断未解除时闸门会拦住)。
        self._hosted.clear()
        self._hosted_index.clear()
        self.store.audit("user", "halt", {"reason": reason, "cancelled": cancelled})
        self.notifier.breaker("%s(已撤销 %d 笔未成交单)" % (reason, cancelled))
        return {"engaged": state.engaged, "cancelled": cancelled}

    # ---- 落库 -----------------------------------------------------------
    def _base_record(
        self, instruction: str, channel: str, response: Optional[LLMResponse]
    ) -> Dict[str, Any]:
        return {
            "input": {
                "raw_instruction": instruction,
                "reason": "",
                "input_channel": channel,
            },
            "llm": {
                "model": response.model if response else "",
                "prompt_version": response.prompt_version if response else "",
                "prompt_fingerprint": response.prompt_fingerprint if response else "",
                "intent_summary": "",
                "confidence": None,
                "warnings": [],
                "raw_response": response.text if response else "",
                "usage": response.usage if response else {},
            },
            "execution_type": None,
            "trigger": None,
            "triggered_at": None,
            "account": {},
            "contract": {},
            "order": {},
            "ibkr": {"order_id": None, "perm_id": None, "status_timeline": [], "fills": [],
                      "avg_fill_price": None, "total_commission": None, "realized_pnl": None},
            "final_status": None,
            "error_detail": None,
            "signature": "",
        }

    def _record_approved(
        self, instruction: str, channel: str, response: LLMResponse, approved: ApprovedOrder
    ) -> str:
        order = approved.order
        record = self._base_record(instruction, channel, response)
        record["input"]["reason"] = order.reason
        record["llm"].update(
            {
                "intent_summary": order.intent_summary,
                "confidence": order.confidence,
                "warnings": approved.warnings,
            }
        )
        record["execution_type"] = order.execution_type
        record["trigger"] = order.trigger.model_dump() if order.trigger else None
        record["account"] = {
            "alias": approved.account.alias,
            "account_id": approved.account.account_id,
            "is_paper": approved.account.is_paper,
        }
        record["contract"] = order.contract.model_dump(exclude_none=True)
        record["order"] = order.order.model_dump(exclude_none=True)
        record["notional_estimate"] = round(approved.notional, 2)
        record["signature"] = approved.signature
        return self.store.create_record(record)

    def _record_rejection(
        self,
        instruction: str,
        channel: str,
        response: LLMResponse,
        rejection: Rejection,
        final_status: str,
    ) -> str:
        record = self._base_record(instruction, channel, response)
        record["llm"]["intent_summary"] = rejection.original_text
        record["rejection"] = rejection.model_dump()
        record_id = self.store.create_record(record)
        self.store.set_final_status(record_id, final_status, rejection.message)
        return record_id

    def _record_validator_rejection(
        self, instruction: str, channel: str, response: LLMResponse, rejected: RejectedOrder
    ) -> str:
        order = rejected.order
        record = self._base_record(instruction, channel, response)
        record["input"]["reason"] = order.reason
        record["llm"].update(
            {"intent_summary": order.intent_summary, "confidence": order.confidence}
        )
        record["execution_type"] = order.execution_type
        record["trigger"] = order.trigger.model_dump() if order.trigger else None
        record["contract"] = order.contract.model_dump(exclude_none=True)
        record["order"] = order.order.model_dump(exclude_none=True)
        record["rejection"] = {
            "code": rejected.primary_code,
            "message": rejected.message(),
            "issues": [{"code": i.code, "message": i.message} for i in rejected.issues],
        }
        record_id = self.store.create_record(record)
        self.store.set_final_status(record_id, "rejected_by_validator", rejected.message())
        return record_id
