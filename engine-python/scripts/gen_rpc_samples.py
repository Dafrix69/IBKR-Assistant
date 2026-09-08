"""生成 RPC 契约样本(阶段 6)。

用 Python 版 RpcServer 在离线条件下(假 LLM 解析器、无券商连接)执行一段
脚本化的请求序列,把归一化后的响应存为期望值。TS 侧用自己的 RpcServer
回放同一序列,逐条对拍——这就是"现有 renderer 不改一行也能对接"的验收。

归一化规则(两侧必须一致,TS 版见 tests/golden-rpc.spec.ts):
  * uuid / ISO 时间戳 / 本机路径 → "<ID>" / "<TS>" / "<PATH>"
  * 掩码键(latency、keychain 有无等机器相关项)→ "<VAR>"
  * tws.scan / futu.scan 的端口探测与应用检测整块掩码(机器相关)
有状态 id 用 $VAR 占位:每一侧用自己捕获到的真实 id 替换后再发请求。
"""
from __future__ import annotations

import copy
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT.parent / "engine-ts" / "baseline" / "rpc"
OUT.mkdir(parents=True, exist_ok=True)

from gen_golden import BASE_CONFIG  # noqa: E402  (同一份基准配置)
from ibkr_agent import rpc as rpc_mod  # noqa: E402
from ibkr_agent.providers import LLMResponse  # noqa: E402

# ---------------------------------------------------------------- 假解析器
FAKE_PARSE_PAYLOAD = {
    "orders": [
        {
            "intent_summary": "限价 230 买入 100 股 AAPL",
            "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
            "execution_type": "IMMEDIATE",
            "trigger": None,
            "account": "DEFAULT",
            "order": {"action": "BUY", "orderType": "LMT", "totalQuantity": 100,
                       "price_mode": "EXPLICIT", "lmtPrice": 230.0, "tif": "DAY", "outsideRth": False},
            "reason": "回调到位",
            "confidence": 0.99,
            "warnings": [],
        }
    ],
    "rejections": [
        {"original_text": "顺便梭哈", "code": "UNCLEAR", "message": "「梭哈」没有明确数量与标的,拒绝。"}
    ],
}

FAKE_JSON_BY_SCHEMA = {
    "stocks": {"stocks": [
        {"symbol": "NVDA", "company": "英伟达", "reason": "AI 芯片份额第一", "tag": "芯片"},
        {"symbol": "AMD", "company": "AMD", "reason": "数据中心第二供应商", "tag": "芯片"},
    ]},
    "entry": {"entry": [{"left": {"kind": "indicator", "name": "macd_hist"},
                          "op": "cross_up", "right": {"kind": "const", "value": 0.0}}],
               "exit": []},
    # "themes" 是 IdeaDigest 独有的键,必须排在 "summary" 前:两个 schema 都有 summary
    "themes": {"summary": "偏好半导体尾盘动量,想法多带明确价位",
                "themes": ["半导体(2 条)"], "lessons": ["想法带价位条件的更可执行"],
                "patterns": ["具体价位 + 条件的想法质量高"],
                "actions": ["把尾盘动量写成可回测的规则"]},
    "summary": {"summary": "回调加仓想法与当前动能匹配度一般",
                 "thesis": "需要价格站回均线之上",
                 "checks": ["财报日期"], "risks": ["波动率偏高"],
                 "suggestion": "等回调到锚点再考虑"},
    "reading": {"summary": "结构偏多", "reading": "高点抬高。", "watch": ["盯 450"], "risks": ["假突破"]},
}


class FakeParser:
    def parse(self, bundle, user_message):
        return LLMResponse(
            text=json.dumps(FAKE_PARSE_PAYLOAD, ensure_ascii=False),
            model="fake-model",
            prompt_version=bundle.version,
            prompt_fingerprint=bundle.fingerprint,
            latency_ms=5,
            usage={"input_tokens": 100, "output_tokens": 50},
        )

    def complete_json(self, system, user, schema):
        props = set((schema.get("properties") or {}).keys())
        for marker, payload in FAKE_JSON_BY_SCHEMA.items():
            if marker in props:
                return copy.deepcopy(payload)
        raise RuntimeError("没有匹配的假响应:%s" % sorted(props))


rpc_mod.build_parser = lambda cfg, api_key=None: FakeParser()  # 模块级替换,reload 后仍生效

# 固定时钟:时段相关的输出(盘前/盘中警告、market_status)必须可回放
from datetime import datetime as _dt
from ibkr_agent.config import ET as _ET
from ibkr_agent import engine as _engine_mod

FIXED_NOW = _dt(2026, 8, 14, 10, 32, tzinfo=_ET)
rpc_mod.now_et = lambda: FIXED_NOW
_engine_mod.now_et = lambda: FIXED_NOW

# ---------------------------------------------------------------- 归一化
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")
PATH_RE = re.compile(r"^([A-Za-z]:[\\/]|/)")

MASK_KEYS = {
    "latency_ms", "port_latency_ms", "now_et", "at", "analyzed_at", "fetched_at",
    "created_at", "updated_at", "exported_at", "fired_at", "last_fired_at",
    "raw_response", "path", "config", "unlock_password_saved", "key_configured",
}
# 机器相关的整块(端口探测、应用检测、sdk 安装状态)
DROP_KEYS = {"ports", "apps", "connected", "sdk_installed", "running", "installed"}


def normalize(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in MASK_KEYS:
                out[key] = "<VAR>"
            elif key in DROP_KEYS:
                out[key] = "<MACHINE>"
            else:
                out[key] = normalize(item)
        return out
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, str):
        value = UUID_RE.sub("<ID>", value)   # 错误文案里也可能内嵌 uuid
        if value == "<ID>":
            return value
        if ISO_RE.match(value):
            return "<TS>"
        if PATH_RE.match(value) and ("\\" in value or "/" in value):
            return "<PATH>"
    return value


def get_path(obj, path: str):
    cur = obj
    for part in path.split("."):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = (cur or {}).get(part)
    return cur


# ---------------------------------------------------------------- 请求脚本
def script(export_path: str):
    S = []

    def step(method, params=None, capture=None):
        S.append({"method": method, "params": params or {}, "capture": capture or {}})

    step("system.selftest")
    step("system.status")
    step("backtest.strategies")
    step("pa.timeframes")
    step("settings.get")
    step("settings.patch", {"patch": {"accounts": []}})
    step("settings.patch", {"patch": {"limits": {"max_order_notional": -1}}})
    step("settings.patch", {"patch": {"limits": {"max_order_notional": 40000.0}}})
    step("llm.patch", {"llm": {"bogus": 1}})
    step("llm.patch", {"llm": {"model": "claude-sonnet-5"}})
    step("llm.catalog")
    step("breaker.state")
    step("breaker.halt", {"reason": "契约测试"})
    step("breaker.state")
    step("breaker.resume")
    step("instruction.submit", {})
    step("instruction.submit", {"text": "买入 AAPL 100股 limit 230", "execute": True})
    step("instruction.submit", {"text": "买入 AAPL 100股 limit 230,顺便梭哈"})
    # 勾选账户扇出:两个账户各一份(模拟那份撞 10 分钟重复防抖,主账户那份撞实盘闸)
    step("instruction.submit", {"text": "买入 MSFT 50股 limit 400", "accounts": ["模拟", "主账户"]})
    step("instruction.submit", {"text": "买入 AAPL 100股 limit 230", "accounts": ["长线"]})
    step("instruction.submit", {"text": "买入 AAPL 100股 limit 230", "accounts": "模拟"})
    step("records.list", {"limit": 10})
    step("records.get", {"id": "nope"})
    step("pending.list")
    step("ideas.add", {"text": "上周五尾盘买入的 AAPL,考虑加仓"},
         capture={"IDEA_ID": "result.idea.id"})
    step("ideas.analyze", {"id": "$IDEA_ID"})
    step("ideas.list")
    step("ideas.update", {"id": "$IDEA_ID", "status": "done"})
    step("ideas.update", {"id": "$IDEA_ID", "status": "nope"})
    step("ideas.update", {"status": "done"})
    step("ideas.digest", {"scope": "archived"})   # 还没归档任何想法:引导文案
    step("ideas.digest", {"scope": "nope"})
    step("ideas.digest", {"scope": "all"})        # done 的想法也算,能出总结
    step("ideas.digests")
    step("sectors.add", {"name": "AI 算力"}, capture={"SECTOR_ID": "result.sector.id"})
    step("sectors.add", {"name": "AI 算力"})
    step("sectors.add_stock", {"id": "$SECTOR_ID", "symbol": "bad$"})
    step("sectors.add_stock", {"id": "$SECTOR_ID", "symbol": "NVDA", "company": "英伟达"})
    step("sectors.remove_stock", {"id": "$SECTOR_ID", "symbol": "NVDA"})
    step("sectors.remove_stock", {"id": "$SECTOR_ID", "symbol": "NVDA"})
    step("sectors.pick", {"id": "$SECTOR_ID"})
    step("sectors.list")
    step("sectors.quotes")
    # 业务标签 + 扫描器(离线:参数校验与"需要连接"的错误文案要两边一致)
    step("sectors.add_stock", {"id": "$SECTOR_ID", "symbol": "VRT", "tag": " 电力设备 "})
    step("sectors.set_tag", {"id": "$SECTOR_ID", "symbol": "amd", "tag": "数据中心"})
    step("sectors.set_tag", {"id": "$SECTOR_ID", "symbol": "TSLA", "tag": "x"})
    step("sectors.set_tag", {"id": "$SECTOR_ID", "symbol": "VRT", "tag": "一二三四五六七八九十一二三四"})
    step("screener.rs", {"benchmark": "IWM"})
    step("screener.rs", {"sector": "nope"})
    step("screener.rs", {"sector": "$SECTOR_ID", "benchmark": "qqq"})
    step("screener.inflection", {"timeframes": ["3m"]})
    step("screener.inflection", {"timeframes": "1d"})
    step("screener.inflection", {"ma_period": 1})
    step("screener.inflection", {"ma_period": "abc"})
    step("screener.inflection", {"sector": "all", "timeframes": ["1d", "1w", "1d"], "ma_period": 20})
    step("screener.deviation", {"symbol": "bad$"})
    step("screener.deviation", {"symbol": "NVDA", "timeframe": "5m"})
    step("screener.deviation", {"symbol": "NVDA", "period": 1})
    step("screener.deviation", {"symbol": "NVDA", "z_extreme": 9})
    step("screener.deviation", {"symbol": "NVDA", "timeframe": "1w"})
    step("sectors.delete", {"id": "$SECTOR_ID"})
    step("sectors.delete", {"id": "$SECTOR_ID"})
    step("alerts.create", {"symbol": "bad$"})
    step("alerts.create", {"symbol": "IREN", "step": 5}, capture={"WATCH_ID": "result.watch.id"})
    step("alerts.create", {"symbol": "IREN"})
    step("alerts.list")
    step("alerts.poll")
    step("alerts.delete", {"id": "$WATCH_ID"})
    step("alerts.delete", {"id": "$WATCH_ID"})
    step("tracker.list")
    step("tracker.update", {"id": "nope", "enabled": True})
    step("tracker.delete", {"id": "nope"})
    # 未连接券商:托管对账应当安静空转,而不是报"需要连接"——界面按秒调它
    step("tracker.reconcile")
    step("positions.list")
    step("book.snapshot", {"symbol": "AAPL"})
    step("book.snapshot", {"symbol": "bad$"})
    step("options.wall", {"symbol": "SPY"})
    step("pa.analyze", {"symbol": "SPY"})
    step("pa.analyze", {"symbol": "SPY", "timeframe": "7m"})
    step("backtest.run", {"symbol": "bad$"})
    step("backtest.run", {"symbol": "AAPL", "start": "not-a-date", "end": "2026-01-01"})
    step("backtest.run", {"symbol": "AAPL", "start": "2026-02-01", "end": "2026-01-01"})
    step("backtest.run", {"symbol": "AAPL", "start": "2010-01-01", "end": "2026-01-01"})
    step("backtest.run", {"symbol": "AAPL", "start": "2025-01-01", "end": "2026-01-01",
                            "strategy": "sma_cross"})
    step("backtest.parse_rules", {})
    step("backtest.parse_rules", {"text": "MACD金叉买入"})
    step("futu.unlock")
    step("futu.set_password", {"password": "xyz", "already_md5": True})
    step("broker.select", {"provider": "schwab"})
    step("broker.select", {"provider": "futu"})
    step("tws.diagnose", {"connections": ["nope"]})
    step("broker.catalog")
    step("futu.scan")
    step("tws.scan")
    step("pending.poll")
    step("data.export", {"path": export_path})
    return S


def main() -> None:
    workdir = OUT / "pywork"
    if workdir.exists():
        import shutil

        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)

    config = copy.deepcopy(BASE_CONFIG)
    config["storage"] = {"db_path": str(workdir / "trades.db")}
    settings_path = workdir / "settings.json"
    settings_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")

    # 两侧共用的原始配置(不带机器相关路径)
    (OUT / "base_config.json").write_text(
        json.dumps(BASE_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    export_path = str(workdir / "export.json")
    steps = script("$EXPORT_PATH")

    sink = io.StringIO()
    server = rpc_mod.RpcServer(settings_path=settings_path, stdout=sink)

    variables = {"EXPORT_PATH": export_path}
    expected = []
    for i, step in enumerate(steps):
        params = json.loads(json.dumps(step["params"]))
        params = substitute(params, variables)
        server._handle({"jsonrpc": "2.0", "id": i, "method": step["method"], "params": params})
        lines = sink.getvalue().strip().splitlines()
        sink.truncate(0)
        sink.seek(0)
        # 最后一行是响应;之前的是 event 通知(不进契约,另行断言条数会太脆)
        response = json.loads(lines[-1])
        raw_result = response.get("result")
        for var, path in (step.get("capture") or {}).items():
            variables[var] = get_path({"result": raw_result}, path)
        expected.append(normalize({k: v for k, v in response.items() if k in ("result", "error")}))

    (OUT / "requests.json").write_text(
        json.dumps(steps, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT / "expected.json").write_text(
        json.dumps(expected, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print("steps:", len(steps))
    print("expected:", (OUT / "expected.json").stat().st_size, "bytes")


def substitute(value, variables):
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    if isinstance(value, str) and value.startswith("$"):
        return variables.get(value[1:], value)
    return value


if __name__ == "__main__":
    main()
