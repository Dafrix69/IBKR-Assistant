"""本机 JSON-RPC 服务(设计文档 §10.1 的那条 127.0.0.1 通道)。

用 stdio 而不是监听端口:Electron 主进程把本模块作为子进程拉起,双方走
换行分隔的 JSON-RPC 2.0。没有监听端口就没有可被本机其他程序连上的攻击面,
比开一个 localhost 端口更紧。

约定:
  * **stdout 只跑协议**,任何日志一律走 stderr,否则会污染消息流;
  * 通知(拒绝、警告、成交、熔断)以 JSON-RPC notification 推给 UI,
    与 macOS 通知中心同时发生(§5.6 全量通知)。
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .broker import BrokerError, BrokerRouter
from .config import LLMConfig, Settings, load_settings, now_et, patch_config_file
from .engine import TradingEngine
from .keychain import KeychainError, get_secret, set_secret
from .killswitch import KillSwitch
from .llm import build_parser
from .notify import Notifier
from .prompts import load_prompt_bundle
from .store import TradeStore, redact_account
from . import providers, tws

PROTOCOL_VERSION = "1.0"


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class RpcServer:
    def __init__(self, settings_path: Optional[Path] = None, stdout=None, stdin=None):
        self.settings_path = settings_path
        self.stdout = stdout or sys.stdout
        self.stdin = stdin or sys.stdin
        self.settings: Settings = load_settings(settings_path)
        self.router: Optional[BrokerRouter] = None
        self._engine: Optional[TradingEngine] = None

    # ---- 生命周期 --------------------------------------------------------
    @property
    def engine(self) -> TradingEngine:
        if self._engine is None:
            notifier = Notifier(enabled=True, extra_sinks=[self._notify_sink])
            self._engine = TradingEngine(
                self.settings,
                parser=build_parser(self.settings.llm),
                store=TradeStore(self.settings.db_path),
                notifier=notifier,
                killswitch=KillSwitch(
                    self.settings.db_path.parent / "breaker.json",
                    threshold=self.settings.policies.consecutive_failure_breaker,
                ),
                router=self.router,
            )
        return self._engine

    def _reload(self) -> None:
        """配置变了就整体重建:限额、别名表都会进提示词,必须一起换掉。"""
        self.settings = load_settings(self.settings_path)
        self._engine = None

    def _notify_sink(self, title: str, subtitle: str, body: str) -> None:
        self._emit("notification", {"title": title, "subtitle": subtitle, "body": body})

    # ---- 协议 -----------------------------------------------------------
    def serve(self) -> int:
        self._emit("ready", {"protocol": PROTOCOL_VERSION, "config": str(self.settings.source_path)})
        for line in self.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                self._write({"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32700, "message": "无法解析的 JSON"}})
                continue
            self._handle(request)
        return 0

    def _handle(self, request: Dict[str, Any]) -> None:
        request_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params") or {}
        try:
            handler = self._methods().get(method)
            if handler is None:
                raise RpcError(-32601, "未知方法:%s" % method)
            result = handler(params)
            self._write({"jsonrpc": "2.0", "id": request_id, "result": result})
        except RpcError as exc:
            self._write({"jsonrpc": "2.0", "id": request_id,
                         "error": {"code": exc.code, "message": exc.message}})
        except Exception as exc:  # noqa: BLE001
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            self._write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32000, "message": "%s: %s" % (type(exc).__name__, exc)},
                }
            )

    def _write(self, message: Dict[str, Any]) -> None:
        self.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.stdout.flush()

    def _emit(self, event: str, payload: Dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": "event", "params": {"event": event, "data": payload}})

    # ---- 方法表 ---------------------------------------------------------
    def _methods(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        return {
            "system.status": self.system_status,
            "system.selftest": self.system_selftest,
            "instruction.submit": self.instruction_submit,
            "records.list": self.records_list,
            "records.get": self.records_get,
            "pending.list": self.pending_list,
            "pending.poll": self.pending_poll,
            "breaker.state": self.breaker_state,
            "breaker.halt": self.breaker_halt,
            "breaker.resume": self.breaker_resume,
            "broker.connect": self.broker_connect,
            "broker.disconnect": self.broker_disconnect,
            "tws.scan": self.tws_scan,
            "tws.diagnose": self.tws_diagnose,
            "tws.launch": self.tws_launch,
            "llm.catalog": self.llm_catalog,
            "llm.patch": self.llm_patch,
            "llm.test": self.llm_test,
            "settings.get": self.settings_get,
            "settings.patch": self.settings_patch,
            "keychain.set": self.keychain_set,
            "data.export": self.data_export,
        }

    # ---- 系统 -----------------------------------------------------------
    def system_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        moment = now_et()
        breaker = self.engine.killswitch.state()
        return {
            "protocol": PROTOCOL_VERSION,
            "now_et": moment.strftime("%Y-%m-%d %H:%M:%S"),
            "market_status": self.settings.market_status(moment),
            "prompt_version": self.engine.bundle.version,
            "prompt_fingerprint": self.engine.bundle.fingerprint,
            "model": self.settings.llm.model,
            "auto_execute": self.settings.policies.auto_execute,
            "allow_live_trading": self.settings.policies.allow_live_trading,
            "breaker": {
                "engaged": breaker.engaged,
                "reason": breaker.reason,
                "consecutive_failures": breaker.consecutive_failures,
            },
            "broker_connected": bool(self.router and self.router.sessions()),
            "pending_count": len(self.engine.pending_triggers),
            "accounts": self._accounts(),
            "limits": {
                "max_order_notional": self.settings.limits.max_order_notional,
                "max_option_contracts": self.settings.limits.max_option_contracts,
                "max_mkt_shares": self.settings.limits.max_mkt_shares,
                "min_confidence": self.settings.limits.min_confidence,
                "max_spread_slippage": self.settings.limits.max_spread_slippage,
                "duplicate_window_minutes": self.settings.limits.duplicate_window_minutes,
            },
        }

    def system_selftest(self, params: Dict[str, Any]) -> Dict[str, Any]:
        bundle = load_prompt_bundle(self.settings)
        return {
            "prompt_version": bundle.version,
            "prompt_fingerprint": bundle.fingerprint,
            "system_prompt_chars": len(bundle.system_text),
            "fewshot_pairs": len(bundle.fewshot),
            "symbol_aliases": self.settings.symbol_aliases,
            "accounts": self._accounts(),
        }

    def _accounts(self):
        return [
            {
                "alias": a.alias,
                "account_masked": redact_account(a.account_id),
                "is_paper": a.is_paper,
                "connection": a.connection,
                "default": a.default,
            }
            for a in self.settings.accounts
        ]

    # ---- 指令 -----------------------------------------------------------
    def instruction_submit(self, params: Dict[str, Any]) -> Dict[str, Any]:
        text = (params.get("text") or "").strip()
        if not text:
            raise RpcError(-32602, "指令为空")
        execute = bool(params.get("execute"))
        if execute and not self.settings.policies.auto_execute:
            raise RpcError(-32003, "配置里 auto_execute=false,拒绝执行。请先在设置里打开。")
        if execute and self.router is None:
            raise RpcError(-32004, "尚未连接 TWS / IB Gateway,拒绝执行。")

        engine = self.engine
        if not execute:
            # 解析模式:临时把自动执行关掉,不管配置怎么写
            from dataclasses import replace

            original = engine.settings.policies
            engine.settings = replace(engine.settings, policies=replace(original, auto_execute=False))
            try:
                result = engine.handle_instruction(text, channel=params.get("channel", "manual"))
            finally:
                engine.settings = replace(engine.settings, policies=original)
        else:
            result = engine.handle_instruction(text, channel=params.get("channel", "manual"))

        payload = result.as_dict()
        payload["executed"] = execute
        self._emit("result", payload)
        return payload

    # ---- 记录 -----------------------------------------------------------
    def records_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        limit = int(params.get("limit", 30))
        records = self.engine.store.list_records(limit)
        return {"records": [_summarize(r) for r in records]}

    def records_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        record = self.engine.store.get_record(params.get("id", ""))
        if record is None:
            raise RpcError(-32005, "记录不存在")
        record = dict(record)
        account = dict(record.get("account") or {})
        if account.get("account_id"):
            account["account_masked"] = redact_account(account.pop("account_id"))
        record["account"] = account
        return {"record": record}

    # ---- 条件单队列 ------------------------------------------------------
    def pending_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "pending": [
                {
                    "record_id": p.record_id,
                    "intent_summary": p.approved.order.intent_summary,
                    "symbol": p.trigger.symbol,
                    "operator": p.trigger.operator,
                    "value": p.trigger.value,
                    "account": p.approved.account.alias,
                    "created_at": p.created_at,
                }
                for p in self.engine.pending_triggers
            ]
        }

    def pending_poll(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """UI 定时调用:拉一次触发标的现价,满足条件的就下单(方式 B 盯盘)。"""
        if self.router is None or not self.engine.pending_triggers:
            return {"fired": [], "prices": {}}
        prices: Dict[str, float] = {}
        for pending in self.engine.pending_triggers:
            symbol = pending.trigger.symbol
            if symbol in prices:
                continue
            price = self.router.index_price(symbol)
            if price is not None:
                prices[symbol] = price
        fired = self.engine.fire_pending(prices)
        expired = self.engine.expire_pending()
        if fired or expired:
            self._emit("pending", {"fired": fired, "expired": expired})
        return {"fired": fired, "prices": prices, "expired": expired}

    # ---- 熔断 -----------------------------------------------------------
    def breaker_state(self, params: Dict[str, Any]) -> Dict[str, Any]:
        state = self.engine.killswitch.state()
        return {"engaged": state.engaged, "reason": state.reason, "at": state.at,
                "consecutive_failures": state.consecutive_failures}

    def breaker_halt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        reason = params.get("reason") or "用户在界面上按下暂停"
        try:
            outcome = self.engine.halt(reason)
        except BrokerError as exc:
            self.engine.killswitch.engage(reason)
            outcome = {"engaged": True, "cancelled": 0, "warning": str(exc)}
        self._emit("breaker", outcome)
        return outcome

    def breaker_resume(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.engine.killswitch.release("ui")
        self.engine.store.audit("ui", "resume", {})
        self._emit("breaker", {"engaged": False})
        return {"engaged": False}

    # ---- 券商连接 --------------------------------------------------------
    def broker_connect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if self.router is None:
            self.router = BrokerRouter(self.settings)
        names = params.get("connections") or sorted(self.settings.connections)
        connected, failed = [], {}
        for name in names:
            try:
                self.router.connect(name)
                connected.append(name)
            except BrokerError as exc:
                failed[name] = str(exc)
        self._engine = None  # 让引擎带上 router 重建
        attached = self.engine.attach_listeners()
        self.engine.store.audit("ui", "broker_connect", {"connected": connected, "failed": list(failed)})
        return {"connected": connected, "failed": failed, "listeners": attached}

    def broker_disconnect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if self.router:
            self.router.disconnect_all()
        self.router = None
        self._engine = None
        return {"connected": []}

    # ---- TWS 检测(§9.1:本模块不接触任何 IBKR 凭证)------------------------
    def tws_scan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ports": tws.scan_ports(self.settings),
            "apps": tws.detect_apps(),
            "guide": tws.connection_guide(self.settings),
            "connections": {
                name: {"host": c.host, "port": c.port, "client_id": c.client_id}
                for name, c in self.settings.connections.items()
            },
            "connected": self.router.connected_names() if self.router else [],
        }

    def tws_diagnose(self, params: Dict[str, Any]) -> Dict[str, Any]:
        names = params.get("connections") or sorted(self.settings.connections)
        unknown = [n for n in names if n not in self.settings.connections]
        if unknown:
            raise RpcError(-32602, "未定义的连接:%s" % "、".join(unknown))
        results = []
        for name in names:
            try:
                results.append(tws.diagnose(self.settings, name))
            except Exception as exc:  # noqa: BLE001 - 诊断失败本身就是要展示的结果
                results.append(
                    {"connection": name, "connected": False, "error": str(exc), "hint": None}
                )
        self._emit("tws", {"results": results})
        return {"results": results}

    def tws_launch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        key = params.get("app")
        try:
            result = tws.launch_app(key)
        except (ValueError, FileNotFoundError, RuntimeError) as exc:
            raise RpcError(-32009, str(exc))
        self.engine.store.audit("ui", "tws_launch", {"app": key, "path": result.get("path")})
        return result

    # ---- 大模型接入 ------------------------------------------------------
    def llm_catalog(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """供应商目录 + 当前配置 + 每个供应商的 Key 是否已配(只报有无,不回传密钥)。"""
        cfg = self.settings.llm
        keys = {}
        for name in providers.PROVIDERS:
            try:
                keys[name] = bool(get_secret(cfg.keychain_service, name))
            except KeychainError:
                keys[name] = False
        return {
            "providers": providers.provider_catalog(),
            "current": {
                "provider": cfg.provider,
                "model": cfg.model,
                "base_url": cfg.base_url,
                "effort": cfg.effort,
                "temperature": cfg.temperature,
                "max_tokens": cfg.max_tokens,
                "timeout_s": cfg.timeout_s,
                "keychain_service": cfg.keychain_service,
                "keychain_account": cfg.keychain_account,
            },
            "key_configured": keys,
        }

    def llm_patch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """改模型配置。切供应商时 keychain_account 跟着切,避免用错那把 key。"""
        patch = dict(params.get("llm") or {})
        allowed = {"provider", "model", "base_url", "effort", "temperature", "max_tokens", "timeout_s"}
        unknown = set(patch) - allowed
        if unknown:
            raise RpcError(-32602, "不允许修改的字段:%s" % "、".join(sorted(unknown)))
        if "provider" in patch:
            patch["keychain_account"] = patch["provider"]
        try:
            patch_config_file(self.settings.source_path, {"llm": patch})
        except (ValueError, TypeError) as exc:
            raise RpcError(-32007, "配置校验失败,已回滚:%s" % exc)
        self.engine.store.audit("ui", "llm_patch", {"patch": {k: v for k, v in patch.items()}})
        self._reload()
        self._emit("llm", self.llm_catalog({}))
        return self.llm_catalog({})

    def llm_test(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """真打一次最小请求:验通不通、Key 对不对、模型名存不存在、结构化输出可不可用。

        允许带一把未保存的 key 先试——试通了再保存,省得把错的 key 写进 Keychain。
        """
        cfg = self.settings.llm
        overrides = params.get("llm") or {}
        if overrides:
            merged = {**cfg.__dict__, **{k: v for k, v in overrides.items() if k in cfg.__dict__}}
            if "provider" in overrides:
                merged["keychain_account"] = overrides["provider"]
            cfg = LLMConfig(**merged)
        try:
            parser = providers.build_parser(cfg, params.get("api_key") or None)
            result = parser.test()
        except providers.LLMError as exc:
            return {"ok": False, "error": str(exc), "provider": cfg.provider, "model": cfg.model}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                    "provider": cfg.provider, "model": cfg.model}
        result["provider"] = cfg.provider
        return result

    # ---- 设置 -----------------------------------------------------------
    def settings_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        s = self.settings
        return {
            "path": str(s.source_path),
            "llm": {"model": s.llm.model, "effort": s.llm.effort, "max_tokens": s.llm.max_tokens},
            "limits": s.limits.__dict__,
            "policies": s.policies.__dict__,
            "symbol_aliases": s.symbol_aliases,
            "accounts": self._accounts(),
            "connections": {
                name: {"host": c.host, "port": c.port} for name, c in s.connections.items()
            },
        }

    def settings_patch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        patch = params.get("patch") or {}
        if not isinstance(patch, dict):
            raise RpcError(-32602, "patch 必须是对象")
        forbidden = {"accounts", "connections"} & set(patch)
        if forbidden:
            # 账户与连接牵涉真实账号,只允许人手动改配置文件,不给 UI 通道(§9.6)
            raise RpcError(-32006, "账户与连接配置不允许从界面修改:%s" % ", ".join(sorted(forbidden)))
        try:
            patch_config_file(self.settings.source_path, patch)
        except (ValueError, TypeError) as exc:
            raise RpcError(-32007, "配置校验失败,已回滚:%s" % exc)
        self.engine.store.audit("ui", "settings_patch", {"patch": patch})
        self._reload()
        self._emit("settings", self.settings_get({}))
        return self.settings_get({})

    def keychain_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        secret = params.get("secret") or ""
        try:
            account = params.get("provider") or self.settings.llm.keychain_account
            set_secret(self.settings.llm.keychain_service, account, secret)
        except KeychainError as exc:
            raise RpcError(-32008, str(exc))
        self.engine.store.audit("ui", "keychain_set", {"service": self.settings.llm.keychain_service})
        return {"ok": True}

    def data_export(self, params: Dict[str, Any]) -> Dict[str, Any]:
        target = Path(params.get("path") or "").expanduser()
        if not target:
            raise RpcError(-32602, "缺少导出路径")
        data = self.engine.store.export_all()
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self.engine.store.audit("ui", "export", {"path": str(target)})
        return {"path": str(target), "records": len(data.get("records", []))}


def _summarize(record: Dict[str, Any]) -> Dict[str, Any]:
    account = record.get("account") or {}
    contract = record.get("contract") or {}
    order = record.get("order") or {}
    ibkr = record.get("ibkr") or {}
    return {
        "id": record.get("id"),
        "created_at": record.get("created_at"),
        "intent_summary": (record.get("llm") or {}).get("intent_summary", ""),
        "raw_instruction": (record.get("input") or {}).get("raw_instruction", ""),
        "reason": (record.get("input") or {}).get("reason", ""),
        "symbol": contract.get("symbol", ""),
        "secType": contract.get("secType", ""),
        "action": order.get("action", ""),
        "quantity": order.get("totalQuantity"),
        "account": account.get("alias", ""),
        "account_masked": redact_account(account.get("account_id", "")),
        "is_paper": account.get("is_paper"),
        "execution_type": record.get("execution_type"),
        "final_status": record.get("final_status"),
        "status": (ibkr.get("status_timeline") or [{}])[-1].get("status"),
        "avg_fill_price": ibkr.get("avg_fill_price"),
        "total_commission": ibkr.get("total_commission"),
        "confidence": (record.get("llm") or {}).get("confidence"),
        "rejection": record.get("rejection"),
        "notional_estimate": record.get("notional_estimate"),
    }


def main(settings_path: Optional[Path] = None) -> int:
    return RpcServer(settings_path).serve()
