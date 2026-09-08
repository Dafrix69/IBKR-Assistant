"""生成 store 兼容性夹具(阶段 3)。

用 Python 版 TradeStore 造一个数据库文件(带完整事件流:status / fill /
commission / trigger / final / warning、watches、tracks、sectors、ideas、audit),
并把 Python 侧的读取结果(折叠后的记录、recent_orders、各列表)序列化成期望值。
TS 侧直接打开同一个 .db 文件对拍——这就是"旧库文件直接打开"的验收。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT.parent / "trade-ts" / "baseline" / "store"
OUT.mkdir(parents=True, exist_ok=True)

from ibkr_agent.store import TradeStore, redact_account  # noqa: E402

DB = OUT / "fixture.db"
for suffix in ("", "-wal", "-shm"):
    p = Path(str(DB) + suffix)
    if p.exists():
        p.unlink()

store = TradeStore(DB)

# ---- 记录 1:完整生命周期(提交 → 部分成交 → 全成 → 佣金 → 终态) ----
rec1 = {
    "instruction": "买入 AAPL 100股 limit 230",
    "intent_summary": "限价 230 买入 100 股 AAPL",
    "signature": "DEFAULT|BUY|STK|AAPL",
    "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
    "order": {"action": "BUY", "orderType": "LMT", "totalQuantity": 100, "lmtPrice": 230.0},
    "account": {"alias": "模拟", "account_id": "DU7654321"},
    "llm": {"prompt_version": "v1.8.0", "prompt_fingerprint": "abc123", "model": "claude-opus-5"},
    "reason": "回调到位",
}
rid1 = store.create_record(dict(rec1))
store.append_event(rid1, "status", {"status": "Submitted", "order_id": 101, "perm_id": 900101})
store.append_event(rid1, "fill", {"qty": 40, "price": 229.98, "exec_id": "e1", "commission": 0.5})
store.append_event(rid1, "fill", {"qty": 60, "price": 230.0, "exec_id": "e2", "commission": 0.7,
                                  "time": "2026-08-14T10:35:00+00:00"})
store.append_event(rid1, "status", {"status": "Filled"})
store.append_event(rid1, "commission", {"commission": 0.2, "realized_pnl": 12.5})
store.set_final_status(rid1, "filled")

# ---- 记录 2:条件单(触发 → 提交 → 警告 → 取消) ----
rec2 = {
    "instruction": "SPX 涨到 7500 买 spread",
    "signature": "DEFAULT|BUY|BAG|SPX|BUY|1|20260814|7520|C|SELL|1|20260814|7550|C",
    "contract": {"secType": "BAG", "symbol": "SPX"},
    "order": {"action": "BUY", "orderType": "LMT", "totalQuantity": 1},
    "account": {"alias": "模拟", "account_id": "DU7654321"},
    "llm": {"prompt_version": "v1.8.0"},
}
rid2 = store.create_record(dict(rec2))
store.append_event(rid2, "status", {"status": "PendingTrigger"})
store.append_event(rid2, "trigger", {"symbol": "SPX", "price": 7500.5, "operator": ">="})
store.append_event(rid2, "status", {"status": "Submitted", "order_id": 102})
store.append_event(rid2, "warning", {"message": "盘口价差偏大"})
store.append_event(rid2, "status", {"status": "Cancelled"})
store.set_final_status(rid2, "cancelled", "用户手动取消")

# ---- 记录 3:仅校验(ValidatedOnly,不进 recent_orders 候选集) ----
rec3 = {
    "instruction": "买入 NVDA 2 张 call",
    "signature": "DEFAULT|BUY|OPT|NVDA|20260821|180|C",
    "contract": {"secType": "OPT", "symbol": "NVDA"},
    "order": {"action": "BUY", "orderType": "LMT", "totalQuantity": 2},
    "account": {"alias": "模拟", "account_id": "DU7654321"},
    "llm": {"prompt_version": "v1.8.0"},
}
rid3 = store.create_record(dict(rec3))
store.append_event(rid3, "status", {"status": "ValidatedOnly"})
store.set_final_status(rid3, "rejected_by_validator", "仅校验,未发送")

# ---- 记录 4:无签名(不进 recent_orders) ----
rid4 = store.create_record({
    "instruction": "看看行情",
    "contract": {"symbol": ""},
    "order": {},
    "account": {"account_id": ""},
})
store.set_final_status(rid4, "rejected_by_llm", "不是交易指令")

# ---- 审计 ----
store.audit("user", "settings.patch", {"path": "limits.max_order_notional", "to": 5000})
store.audit("engine", "breaker.engage", {"reason": "连续失败"})

# ---- watches / tracks / sectors / ideas ----
watch = store.add_watch("IREN", step=5.0)
store.update_watch(watch["id"], levels=[{"price": 40.0, "label": "整数关口 40", "source": "round",
                                         "kind": "pivot"}],
                   states={"40.0000": {"armed": False, "last_fired_at": 1755000000.0}},
                   last_price=41.2, events=[{"price": 40.0, "text": "整数关口 40 上穿 40"}])

track = store.add_track({
    "account": "模拟", "symbol": "AAPL", "sec_type": "STK",
    "contract": {"secType": "STK", "symbol": "AAPL"},
    "targets": {"take_profit": 250.0, "stop_loss": 210.0, "trail_pct": None},
    "auto_close": {"enabled": True, "order_type": "MKT", "slippage_pct": 0.3},
    "note": "财报前的仓",
})
store.update_track(track["id"], peak=245.5)

sector = store.add_sector("AI 算力")
store.set_sector_stocks(sector["id"], [{"symbol": "NVDA", "company": "英伟达", "reason": "龙头"}])

idea = store.add_idea("上周五尾盘买入的 AAPL,考虑加仓", ["AAPL"])
store.set_idea_analysis(idea["id"], {"summary": "回调加仓想法", "risks": ["财报波动"]})
store.set_idea_status(idea["id"], "done")

# ---- 期望值 ----
now = datetime.now(timezone.utc)
expected = {
    "record_ids": [rid1, rid2, rid3, rid4],
    "get_record": {rid: store.get_record(rid) for rid in (rid1, rid2, rid3, rid4)},
    "list_records_limit_2": store.list_records(limit=2),
    "recent_now": now.isoformat(),
    "recent_orders": [
        {"signature": r.signature, "quantity": r.quantity, "created_at": r.created_at.isoformat()}
        for r in store.recent_orders(window_minutes=10, now=now)
    ],
    "watches": store.list_watches(),
    "tracks": store.list_tracks(),
    "sectors": store.list_sectors(),
    "ideas_all": store.list_ideas(),
    "ideas_done": store.list_ideas(status="done"),
    "audit_rows": [dict(r) for r in store._conn.execute("SELECT * FROM audit_log ORDER BY seq")],
    "redact": {
        "DU7654321": redact_account("DU7654321"),
        "U12345": redact_account("U12345"),
        "": redact_account(""),
        "AB": redact_account("AB"),
    },
}
store.close()

(OUT / "expected.json").write_text(
    json.dumps(expected, ensure_ascii=False, indent=1), encoding="utf-8"
)
print("fixture:", DB, DB.stat().st_size, "bytes")
print("expected:", (OUT / "expected.json").stat().st_size, "bytes")
