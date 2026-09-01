"""命令行入口。默认全部是"只解析不下单",要真正发单必须显式打开开关。

    python -m ibkr_agent selftest                     # 不联网:渲染提示词 + 自检
    python -m ibkr_agent validate fixture.json        # 不联网:拿现成 JSON 过硬校验
    python -m ibkr_agent parse "买入 AAPL 100股 limit 230"   # 调 LLM,不下单
    python -m ibkr_agent run   "..." --i-understand-this-places-real-orders
    python -m ibkr_agent records / halt / resume / export / set-key
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Optional

from .broker import BrokerRouter
from .config import load_settings, now_et
from .engine import TradingEngine
from .keychain import set_secret
from .killswitch import KillSwitch
from .llm import structured_output_schema
from .models import parse_llm_payload
from .notify import Notifier
from .prompts import load_prompt_bundle, render_user
from .store import TradeStore
from .validator import Validator


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="ibkr_agent", description="IBKR 交易指令解析引擎")
    parser.add_argument("--config", type=Path, default=None, help="配置文件路径")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("selftest", help="离线自检:渲染提示词、导出 schema、检查配置")
    sub.add_parser("rpc", help="以 JSON-RPC 子进程模式运行(供 Electron 主进程拉起)")

    p_validate = sub.add_parser("validate", help="离线:对一份现成的解析 JSON 跑硬校验")
    p_validate.add_argument("payload", type=Path)
    p_validate.add_argument("--snapshot", type=str, default="", help='如 "SPX=7462.35,AAPL=230"')

    p_parse = sub.add_parser("parse", help="调用 LLM 解析并校验,不下单")
    p_parse.add_argument("instruction")
    p_parse.add_argument("--snapshot", type=str, default="")

    p_run = sub.add_parser("run", help="完整流程(需要 TWS/Gateway 在线)")
    p_run.add_argument("instruction")
    p_run.add_argument(
        "--i-understand-this-places-real-orders",
        action="store_true",
        dest="confirmed",
        help="没有这个开关一律只解析不下单",
    )

    p_records = sub.add_parser("records", help="查看最近的交易记录")
    p_records.add_argument("--limit", type=int, default=10)

    p_idea = sub.add_parser("idea", help="记录一条交易想法(备忘,不解析不下单)")
    p_idea.add_argument("text")

    p_ideas = sub.add_parser("ideas", help="查看已记录的想法")
    p_ideas.add_argument("--all", action="store_true", help="包含已完成/已归档")
    p_ideas.add_argument("--limit", type=int, default=20)

    p_halt = sub.add_parser("halt", help="熔断:停止自动执行")
    p_halt.add_argument("--reason", default="用户手动熔断")
    sub.add_parser("resume", help="解除熔断")

    p_export = sub.add_parser("export", help="导出全部本地数据")
    p_export.add_argument("out", type=Path)

    p_key = sub.add_parser("set-key", help="把 LLM API Key 写入 macOS Keychain")
    p_key.add_argument("secret")

    args = parser.parse_args(argv)

    if args.command == "rpc":
        from .rpc import main as rpc_main

        return rpc_main(args.config)

    settings = load_settings(args.config)

    if args.command == "selftest":
        return _selftest(settings)
    if args.command == "validate":
        return _validate(settings, args.payload, _parse_snapshot(args.snapshot))
    if args.command == "parse":
        return _parse(settings, args.instruction, _parse_snapshot(args.snapshot))
    if args.command == "run":
        return _run(settings, args.instruction, args.confirmed)
    if args.command == "records":
        store = TradeStore(settings.db_path)
        print(json.dumps(store.list_records(args.limit), ensure_ascii=False, indent=2))
        return 0
    if args.command == "idea":
        from .market import extract_symbols

        store = TradeStore(settings.db_path)
        idea = store.add_idea(
            args.text, extract_symbols(args.text, settings, default_index=False)
        )
        print("已记下(%s):%s" % (idea["id"][:8], idea["text"]))
        return 0
    if args.command == "ideas":
        store = TradeStore(settings.db_path)
        ideas = store.list_ideas(status=None if args.all else "active", limit=args.limit)
        print(json.dumps(ideas, ensure_ascii=False, indent=2))
        return 0
    if args.command == "halt":
        switch = KillSwitch(settings.db_path.parent / "breaker.json")
        state = switch.engage(args.reason)
        TradeStore(settings.db_path).audit("cli", "halt", {"reason": args.reason})
        print("已熔断:%s" % state.reason)
        return 0
    if args.command == "resume":
        switch = KillSwitch(settings.db_path.parent / "breaker.json")
        switch.release("cli")
        TradeStore(settings.db_path).audit("cli", "resume", {})
        print("熔断已解除。注意:auto_execute 仍受配置控制。")
        return 0
    if args.command == "export":
        data = TradeStore(settings.db_path).export_all()
        args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print("已导出到 %s" % args.out)
        return 0
    if args.command == "set-key":
        set_secret(settings.llm.keychain_service, settings.llm.keychain_account, args.secret)
        print("已写入 Keychain(service=%s)" % settings.llm.keychain_service)
        return 0
    return 1


# ----------------------------------------------------------------------
def _selftest(settings) -> int:
    bundle = load_prompt_bundle(settings)
    moment = now_et()
    user = render_user(bundle, settings, "买入 AAPL 100股 limit 230", moment, snapshot={"AAPL": 230.1})
    print("提示词版本 : %s (%s)" % (bundle.version, bundle.fingerprint))
    print("少样本对数 : %d" % len(bundle.fewshot))
    print("系统提示词 : %d 字" % len(bundle.system_text))
    print("市场状态   : %s" % settings.market_status(moment))
    print("账户别名   : %s" % ", ".join(settings.alias_list()))
    print("自动执行   : %s / 实盘允许:%s" % (
        settings.policies.auto_execute, settings.policies.allow_live_trading))
    print("输出 schema 顶层字段:%s" % ", ".join(sorted(structured_output_schema()["properties"])))
    print("-" * 60)
    print(user)
    return 0


def _validate(settings, payload_path: Path, snapshot: Dict[str, float]) -> int:
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    parsed = parse_llm_payload(payload)
    validator = Validator(settings, now_et(), snapshot=snapshot)
    outcome = validator.validate_all(parsed.orders)
    _print_outcome(parsed, outcome)
    return 0 if not outcome.rejected else 2


def _parse(settings, instruction: str, snapshot: Dict[str, float]) -> int:
    # parse 子命令永不下单,不管配置怎么写
    settings.policies = replace(settings.policies, auto_execute=False)
    engine = TradingEngine(settings, notifier=Notifier(enabled=False))
    result = engine.handle_instruction(instruction, snapshot=snapshot)
    print(json.dumps(result.as_dict(), ensure_ascii=False, indent=2))
    return 0 if not result.rejections else 2


def _run(settings, instruction: str, confirmed: bool) -> int:
    if not confirmed:
        print("拒绝执行:缺少 --i-understand-this-places-real-orders 开关。", file=sys.stderr)
        return 1
    if not settings.policies.auto_execute:
        print("拒绝执行:配置里 policies.auto_execute=false。", file=sys.stderr)
        return 1
    router = build_router(settings)
    engine = TradingEngine(settings, router=router)
    try:
        result = engine.handle_instruction(instruction)
        print(json.dumps(result.as_dict(), ensure_ascii=False, indent=2))
        # 富途没有事件流:同步拉一次回报,否则命令行跑出来的单永远停在 Submitted
        engine.sync_broker_orders()
    finally:
        router.disconnect_all()
    return 0


def build_router(settings):
    """按配置里生效的那家券商建 router(命令行与 RPC 用同一条规则)。"""
    if settings.broker.provider == "futu":
        from .futu_broker import FutuRouter

        return FutuRouter(settings)
    return BrokerRouter(settings)


def _print_outcome(parsed, outcome) -> None:
    for note in parsed.schema_errors:
        print("[schema] %s" % note)
    for rejection in parsed.rejections:
        print("[模型拒绝] %s: %s" % (rejection.code, rejection.message))
    for approved in outcome.approved:
        print(
            "[通过] %s | 账户=%s | 敞口≈%.2f USD"
            % (approved.order.intent_summary, approved.account.alias, approved.notional)
        )
        for warning in approved.warnings:
            print("        ! %s" % warning)
    for rejected in outcome.rejected:
        print("[校验拒绝] %s: %s" % (rejected.primary_code, rejected.message()))


def _parse_snapshot(raw: str) -> Dict[str, float]:
    snapshot: Dict[str, Any] = {}
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        symbol, _, value = chunk.partition("=")
        try:
            snapshot[symbol.strip().upper()] = float(value)
        except ValueError:
            raise SystemExit("行情快照格式应为 SPX=7462.35,AAPL=230,收到:%r" % chunk)
    return snapshot


if __name__ == "__main__":
    raise SystemExit(main())
