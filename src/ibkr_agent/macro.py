"""宏观行情带(大盘 / 波动率 / 利率 / 商品 / 美元 / 加密)。

两个来源混着用,界面上分得清哪格是哪个:

  * **TWS 流式** —— 已连接、且账户对该标的有实时权限时走这条,秒级更新。
    指数(SPX / NDX / VIX)和商品期货(GC / CL)在 IBKR 都要单独订阅,多数账户
    没有,所以这里用**流动性最好的对应 ETF** 顶上:SPY / QQQ / GLD / USO / UUP / IBIT。
    ETF 不是指数:涨跌幅几乎同步,绝对价位差一个量级(比如 IBIT 几十美元、
    比特币几万美元),所以每格都会标出实际读的是哪个标的。
  * **公开数据源** —— TWS 没连、或该标的拿不到实时数据时的兜底,分钟级。

**VIX 与美债10Y 永远走公开源**,这是刻意的:它们没有不失真的 ETF 替身。
VIXY 有 contango 损耗、长期偏离 VIX;TLT 是价格,和收益率**反向**——
换上去会让人把「利率下行」读成「利率上行」。宁可慢一格,不可错一格。

只读、只用于展示,绝不参与订单定价——定价永远走 TWS 的实时盘口(§8.1)。

出网边界(§9.1):公开源那条发出去的只有固定的公开代码常量,不含任何账号、
持仓、指令文本。任何一格失败都只是少一格,不影响其他标的与整个应用。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

_ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=5d"

# 固定清单:代码写死在软件里,界面不可注入任意符号(避免变成任意出网通道)。
# live = 已连 TWS 时改读的那个 ETF;None 表示这一格永远走公开源。
MACRO_SYMBOLS: List[Dict[str, Any]] = [
    {"key": "^GSPC", "label": "标普500", "fmt": "price", "live": "SPY"},
    {"key": "^NDX", "label": "纳指100", "fmt": "price", "live": "QQQ"},
    {"key": "^VIX", "label": "VIX", "fmt": "plain", "live": None},        # VIXY 会失真
    {"key": "^TNX", "label": "美债10Y", "fmt": "pct", "live": None},      # TLT 方向相反
    {"key": "GC=F", "label": "黄金", "fmt": "price", "live": "GLD"},
    {"key": "CL=F", "label": "原油", "fmt": "price", "live": "USO"},
    {"key": "DX-Y.NYB", "label": "美元指数", "fmt": "plain", "live": "UUP"},
    {"key": "BTC-USD", "label": "比特币", "fmt": "price", "live": "IBIT"},
]

# 按标的分开缓存:哪一格新、哪一格旧要能分别判断,整条一起过期会让
# 已经拿到的数据被一个失败的标的连累。
_CACHE: Dict[str, Dict[str, Any]] = {}

_TTL_IDLE = 60.0   # 没连 TWS:8 格全走公开源,慢一点,别把公共接口打爆
_TTL_LIVE = 10.0   # 连了 TWS:只剩 VIX 和 10Y 走公开源,可以刷快些


def live_tickers() -> List[str]:
    """要建常驻流式订阅的 ETF 清单。"""
    return [item["live"] for item in MACRO_SYMBOLS if item.get("live")]


def macro_board(
    timeout: float = 6.0, force: bool = False, router: Optional[Any] = None
) -> Dict[str, Any]:
    """整条宏观行情带。router 给了且连着,就优先走 TWS 流式。"""
    quotes: Dict[str, Dict[str, Any]] = {}
    if router is not None:
        try:
            quotes = router.stream_quotes(live_tickers()) or {}
        except Exception:  # noqa: BLE001 - 行情带永远不该把界面搞崩
            quotes = {}

    ttl = 0.0 if force else (_TTL_LIVE if quotes else _TTL_IDLE)
    rows: List[Dict[str, Any]] = []
    for item in MACRO_SYMBOLS:
        quote = quotes.get(item.get("live") or "") or {}
        if quote.get("last") is not None:
            rows.append(
                {
                    "key": item["key"], "label": item["label"], "fmt": item["fmt"],
                    "last": quote["last"], "change_pct": quote.get("change_pct"),
                    "source": "tws", "instrument": item["live"],
                }
            )
        else:
            row = _cached_fetch(item, timeout, ttl)
            row["source"] = "public"
            row["instrument"] = None
            rows.append(row)

    return {
        "rows": rows,
        "at": time.time(),
        "live_count": sum(1 for r in rows if r["source"] == "tws"),
    }


def _cached_fetch(item: Dict[str, Any], timeout: float, ttl: float) -> Dict[str, Any]:
    """带缓存的单格取数。取失败时保留上一次的值并标记陈旧,而不是清空——
    公开接口偶发失败很常见,闪成「—」比显示一个旧数字更糟。"""
    now = time.time()
    hit = _CACHE.get(item["key"])
    if hit and now - hit["at"] < ttl:
        return {**hit["row"], "cached": True}

    row = _fetch_one(item, timeout)
    if row.get("last") is not None:
        _CACHE[item["key"]] = {"at": now, "row": row}
        return row
    if hit:
        return {**hit["row"], "cached": True, "stale": True}
    return row


def _fetch_one(item: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "key": item["key"], "label": item["label"], "fmt": item["fmt"],
        "last": None, "change_pct": None,
    }
    try:
        request = urllib.request.Request(
            _ENDPOINT % urllib.parse.quote(item["key"]),
            headers={"User-Agent": "dafri-trading/0.2 (macro board)"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, OSError, ValueError) as exc:
        row["error"] = type(exc).__name__
        return row

    meta = (((payload.get("chart") or {}).get("result") or [{}])[0] or {}).get("meta") or {}
    last = _num(meta.get("regularMarketPrice"))
    prev = _num(meta.get("chartPreviousClose")) or _num(meta.get("previousClose"))
    row["last"] = last
    if last is not None and prev:
        row["change_pct"] = round((last / prev - 1.0) * 100.0, 2)
    return row


def _num(value) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v == v else None   # 排除 NaN
