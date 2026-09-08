# -*- coding: utf-8 -*-
"""给预览台的 mock-bridge.js 生成一份真实形状的 pa.analyze 返回值。

数据来源:黄金基线 engine-ts/baseline/golden/priceaction.json 里的 K 线,交给引擎的纯函数
analyze() / htf_summary() / agreement() 算——和 rpc._pa_result 组装的字段一模一样,只是 K 线
不来自券商。这样 K线 PA 页在预览台里画出来的就是引擎真会给的东西,而不是手编的样子货。

    python tools/gen_pa_mock.py            # 改写 tools/mock-bridge.js 与 tools/mock-bridge-empty.js
"""
import json
import pathlib
import re
import sys
from datetime import datetime

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent                       # 仓库根
sys.path.insert(0, str(ROOT / "src"))
from ibkr_agent.priceaction import TIMEFRAMES, agreement, analyze, htf_summary  # noqa: E402

golden = json.loads((ROOT / "engine-ts" / "baseline" / "golden" / "priceaction.json").read_text(encoding="utf-8"))
names = [a for a in sys.argv[1:] if not a.startswith("--")]
case = next(c for c in golden["cases"] if c["name"] == (names[0] if names else "uptrend"))
rows = case["rows"]
now = datetime.fromisoformat(case["now"])
symbol, timeframe = "NVDA", case["timeframe"]


def aggregate(rows, n):
    """n 根合成 1 根(高周期背景用)。"""
    out = []
    for i in range(0, len(rows) - len(rows) % n, n):
        chunk = rows[i:i + n]
        out.append({
            "time": chunk[0]["time"], "open": chunk[0]["open"],
            "high": max(r["high"] for r in chunk), "low": min(r["low"] for r in chunk),
            "close": chunk[-1]["close"], "volume": sum(r["volume"] for r in chunk),
        })
    return out


result = analyze(rows, symbol, timeframe, now=now, extended_hours=True)
htf_key = TIMEFRAMES[timeframe]["htf"]
factor = max(1, TIMEFRAMES[htf_key]["seconds"] // TIMEFRAMES[timeframe]["seconds"])
# 黄金基线只有 160 根 5 分钟线,合成 1 小时只剩 13 根,不够 analyze 的 30 根门槛;
# 高周期在这里只是背景摘要,合成粒度放宽到"至少凑够 30 根"即可
factor = max(1, min(factor, len(rows) // 30))
higher = htf_summary(analyze(aggregate(rows, factor), symbol, htf_key, now=now, extended_hours=True))
result["htf"] = higher
result["agreement"] = agreement(result, higher)
result["cached"] = False
result["rth"] = False
result["fetched_at"] = now.isoformat()

if "--stress" in sys.argv:
    # 极端样例:开盘第一根巨量(公开源常见)、5 个关键位挤在 0.3% 价格区间、FVG 与订单块重叠
    last = result["last"]
    result["bars"][0]["volume"] = result["bars"][0]["volume"] * 40
    result["levels"] = [
        {"price": round(last * (1 + k), 4), "side": "resistance" if k > 0 else "support",
         "touches": 2, "swings": 1, "distance_pct": round(k * 100, 2)}
        for k in (-0.003, -0.0015, -0.0005, 0.0005, 0.0015, 0.003)
    ]
    t0 = result["bars"][len(result["bars"]) // 2]["time"]
    result["fvgs"] = [
        {"side": "bull", "top": round(last * 0.995, 4), "bottom": round(last * 0.99, 4), "time": t0, "filled_pct": 0},
        {"side": "bear", "top": round(last * 1.004, 4), "bottom": round(last * 1.001, 4),
         "time": result["bars"][-20]["time"], "filled_pct": 30},
    ]
    result["order_block"] = {"top": round(last * 0.997, 4), "bottom": round(last * 0.992, 4), "time": t0}
payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
data_js = HERE / ("mock-bridge-stress.js" if "--stress" in sys.argv else "mock-bridge.js")
src = (HERE / "mock-bridge.js").read_text(encoding="utf-8")
pattern = re.compile(r"paAnalyze:\s*async\s*\(\)\s*=>\s*\((\{\}|\{.*?\})\),", re.S)
assert pattern.search(src), "mock-bridge.js 里找不到 paAnalyze 定义"
src = pattern.sub("paAnalyze: async () => (" + payload + "),", src, count=1)
data_js.write_text(src, encoding="utf-8")

if "--stress" in sys.argv:
    print("stress mock:", data_js.name, "|", len(payload), "chars")
    sys.exit(0)
empty_js = HERE / "mock-bridge-empty.js"
esrc = empty_js.read_text(encoding="utf-8")
empty_pattern = re.compile(r"paAnalyze:\s*async\s*\(\)\s*=>\s*(\(\{\}\)|\{[^}]*\}),", re.S)
assert empty_pattern.search(esrc), "mock-bridge-empty.js 里找不到 paAnalyze 定义"
# 真实 RPC 未连券商时抛 -32015,不会返回空对象;空态 mock 也照抛
esrc = empty_pattern.sub(
    'paAnalyze: async () => { throw new Error("实时 K 线需要 TWS:请先在「TWS 连接」面板连接引擎。"); },',
    esrc, count=1)
empty_js.write_text(esrc, encoding="utf-8")
print("pa mock:", case["name"], len(rows), "bars →", data_js.name, "/", empty_js.name, "|", len(payload), "chars")
