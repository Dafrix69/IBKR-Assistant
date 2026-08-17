"""编排:输入 → 解析 → 硬校验 → 下单 → 落库 → 通知(设计文档 §1 全流程)。

顺序是有意的:任何一步失败都必须在"发单"之前结束。下单只在最后一步发生,
且要同时满足:校验通过、熔断未触发、auto_execute=true、账户允许。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional

from .broker import BrokerError, BrokerRouter, PendingTrigger, auto_mid_limit, combo_mid_price, strike_width
from .config import Settings, now_et
from .killswitch import KillSwitch
from .llm import LLMError, LLMResponse, build_parser
from .market import build_snapshot, extract_symbols
from .models import LenientParseResult, ParsedOrder, Rejection, parse_llm_payload
from .notify import Notifier
from .prompts import PromptBundle, load_prompt_bundle, render_user
from .store import TradeStore, redact_account
from .validator import ApprovedOrder, RejectedOrder, Validator


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
        # IBKR orderId / permId → 记录 id,回报进来才知道该往哪条记录上追加
        self._order_index: Dict[int, str] = {}
        self._finalized: set = set()

    # ------------------------------------------------------------------
    def handle_instruction(
        self,
        instruction: str,
        channel: str = "manual",
        moment: Optional[datetime] = None,
        snapshot: Optional[Mapping[str, float]] = None,
    ) -> EngineResult:
        result = EngineResult()
        moment = moment or now_et()

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

        user_message = render_user(
            self.bundle, self.settings, instruction, moment, snapshot=snapshot
        )

        try:
            response = self.parser.parse(self.bundle, user_message)
        except LLMError as exc:
            # 调用失败 = 这条指令被拒了,不是"提示"。界面要按拒绝显示,别让用户以为下单了
            self.killswitch.record_failure(str(exc))
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
            self.killswitch.record_failure(str(exc))
            self.notifier.rejection("BAD_PAYLOAD", str(exc))
            self.store.audit("engine", "bad_payload", {"error": str(exc), "raw": response.text[:2000]})
            result.rejections.append(
                {"source": "engine", "code": "BAD_PAYLOAD", "message": str(exc),
                 "original_text": instruction}
            )
            return result

        self.killswitch.record_success()
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

        # 2. 软件层硬校验
        validator = Validator(
            self.settings,
            moment,
            snapshot=snapshot,
            recent_orders=self.store.recent_orders(
                self.settings.limits.duplicate_window_minutes, moment
            ),
        )
        outcome = validator.validate_all(parsed.orders)

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

            try:
                summary.update(self._execute(record_id, approved))
            except BrokerError as exc:
                self.store.set_final_status(record_id, "ibkr_error", str(exc))
                engaged = self.killswitch.record_failure(str(exc))
                self.notifier.rejection("IBKR_ERROR", str(exc))
                if engaged:
                    self.notifier.breaker(engaged.reason)
                result.rejections.append(
                    {"source": "broker", "code": "IBKR_ERROR", "message": str(exc),
                     "record_id": record_id}
                )
                continue

            if summary.get("queued"):
                result.queued.append(summary)
            else:
                result.submitted.append(summary)
        return result

    # ------------------------------------------------------------------
    def _execute(self, record_id: str, approved: ApprovedOrder) -> Dict[str, Any]:
        if self.router is None:
            raise BrokerError("未接入 IBKR 连接(router=None),无法下单。")
        parsed = approved.order

        # 方式 B:条件单 + AUTO_MID 必须由软件盯盘,触发瞬间才能取中间价(§8.1)
        if parsed.trigger is not None and parsed.order.price_mode == "AUTO_MID":
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

        placement = self.router.place(record_id, approved)
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
        for pending in list(self.pending_triggers):
            if pending.fired:
                continue
            price = prices.get(pending.trigger.symbol)
            if price is None or not pending.should_fire(float(price)):
                continue
            try:
                limit = self._auto_mid_limit(pending)
                placement = self.router.place(pending.record_id, pending.approved, limit)
            except BrokerError as exc:
                self.store.set_final_status(pending.record_id, "ibkr_error", str(exc))
                self.notifier.rejection("IBKR_ERROR", str(exc))
                pending.fired = True
                continue
            pending.fired = True
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
        contract = pending.approved.order.contract
        quotes = self.router.leg_quotes(contract, pending.approved.account)
        mid = combo_mid_price(quotes)
        return auto_mid_limit(
            mid,
            pending.approved.order.order.action,
            self.settings.limits.max_spread_slippage,
            strike_width(contract),
        )

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

    def attach_listeners(self) -> int:
        """把每条连接的订单状态与成交回报接到 append-only 存储上。

        没有这一步,记录会停在 Submitted——"自动记录每笔交易"就是空话。
        """
        if self.router is None:
            return 0
        attached = 0
        for ib in self.router.sessions():
            if getattr(ib, "_dafri_wired", False):
                continue
            ib.orderStatusEvent += self._on_order_status
            ib.execDetailsEvent += self._on_exec_details
            ib.commissionReportEvent += self._on_commission
            ib._dafri_wired = True
            attached += 1
        return attached

    _TERMINAL_IB_STATUS = {
        "Filled": "filled",
        "Cancelled": "cancelled",
        "ApiCancelled": "cancelled",
        "Inactive": "ibkr_error",
    }

    def _record_for(self, trade) -> Optional[str]:
        for key in (getattr(trade.order, "permId", None), getattr(trade.order, "orderId", None)):
            if key and key in self._order_index:
                return self._order_index[key]
        return None

    def _on_order_status(self, trade) -> None:
        record_id = self._record_for(trade)
        if not record_id:
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
