"""交易记录落库(设计文档 §6 记录结构 / §9.6 审计与可追溯)。

审计要求是"只增不改",所以这里没有 UPDATE 路径——数据库层用触发器把
UPDATE/DELETE 直接 ABORT 掉,状态变化一律 append 成事件,读取时再折叠成
§6 的那份文档。想改历史记录在代码层就没有入口。

注:静态加密需要 SQLCipher 构建的 sqlite3(§9.3);标准库的 sqlite3 不带,
这里退化为 0600 文件权限 + 依赖 FileVault,并在 README 里写清楚这一点。
"""
from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .validator import RecentOrder

SCHEMA = """
CREATE TABLE IF NOT EXISTS trade_records (
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    signature    TEXT NOT NULL,
    quantity     REAL NOT NULL,
    symbol       TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT '',
    record_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_created ON trade_records(created_at);
CREATE INDEX IF NOT EXISTS idx_records_signature ON trade_records(signature, created_at);

CREATE TABLE IF NOT EXISTS record_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id  TEXT NOT NULL REFERENCES trade_records(id),
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON record_events(record_id, seq);

CREATE TABLE IF NOT EXISTS audit_log (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
);

-- append-only:任何修改历史的尝试都直接失败
CREATE TRIGGER IF NOT EXISTS trade_records_no_update
BEFORE UPDATE ON trade_records
BEGIN SELECT RAISE(ABORT, 'trade_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_records_no_delete
BEFORE DELETE ON trade_records
BEGIN SELECT RAISE(ABORT, 'trade_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS record_events_no_update
BEFORE UPDATE ON record_events
BEGIN SELECT RAISE(ABORT, 'record_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS record_events_no_delete
BEFORE DELETE ON record_events
BEGIN SELECT RAISE(ABORT, 'record_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
"""

TERMINAL_STATUSES = {
    "filled",
    "partially_filled",
    "cancelled",
    "expired_untriggered",
    "rejected_by_validator",
    "rejected_by_llm",
    "ibkr_error",
}


class TradeStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        fresh = not self.db_path.exists()
        self._conn = sqlite3.connect(str(self.db_path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        if fresh:
            os.chmod(self.db_path, 0o600)

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        self._conn.execute("BEGIN")
        try:
            yield self._conn
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    # ---- 写入 -----------------------------------------------------------
    def create_record(self, record: Dict[str, Any]) -> str:
        record_id = record.get("id") or str(uuid.uuid4())
        record["id"] = record_id
        record.setdefault("created_at", _now_iso())
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO trade_records"
                " (id, created_at, signature, quantity, symbol, account_id, prompt_version, record_json)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    record_id,
                    record["created_at"],
                    record.get("signature", ""),
                    float(record.get("order", {}).get("totalQuantity") or 0),
                    (record.get("contract") or {}).get("symbol", ""),
                    (record.get("account") or {}).get("account_id", ""),
                    (record.get("llm") or {}).get("prompt_version", ""),
                    json.dumps(record, ensure_ascii=False, sort_keys=True),
                ),
            )
        return record_id

    def append_event(self, record_id: str, kind: str, payload: Dict[str, Any]) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)",
                (record_id, _now_iso(), kind, json.dumps(payload, ensure_ascii=False)),
            )

    def set_final_status(
        self, record_id: str, status: str, error_detail: Optional[str] = None
    ) -> None:
        if status not in TERMINAL_STATUSES:
            raise ValueError("未知终态:%s" % status)
        self.append_event(record_id, "final", {"final_status": status, "error_detail": error_detail})

    def audit(self, actor: str, action: str, detail: Optional[Dict[str, Any]] = None) -> None:
        """§9.6:切换账户、改限额、改别名表、开关自动执行等关键操作单独留痕。"""
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)",
                (_now_iso(), actor, action, json.dumps(detail or {}, ensure_ascii=False)),
            )

    # ---- 读取 -----------------------------------------------------------
    def get_record(self, record_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT record_json FROM trade_records WHERE id=?", (record_id,)
        ).fetchone()
        if row is None:
            return None
        record = json.loads(row["record_json"])
        return self._fold_events(record_id, record)

    def list_records(self, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id FROM trade_records ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        out = []
        for row in rows:
            record = self.get_record(row["id"])
            if record:
                out.append(record)
        return out

    def _fold_events(self, record_id: str, record: Dict[str, Any]) -> Dict[str, Any]:
        ibkr = record.setdefault("ibkr", {})
        timeline: List[Dict[str, Any]] = ibkr.setdefault("status_timeline", [])
        fills: List[Dict[str, Any]] = ibkr.setdefault("fills", [])

        rows = self._conn.execute(
            "SELECT at, kind, payload FROM record_events WHERE record_id=? ORDER BY seq", (record_id,)
        ).fetchall()
        for row in rows:
            payload = json.loads(row["payload"])
            kind = row["kind"]
            if kind == "status":
                timeline.append({"status": payload.get("status"), "at": row["at"]})
                for key in ("order_id", "perm_id"):
                    if payload.get(key) is not None:
                        ibkr[key] = payload[key]
            elif kind == "fill":
                fills.append({**payload, "time": payload.get("time") or row["at"]})
            elif kind == "commission":
                record.setdefault("commissions", []).append({**payload, "at": row["at"]})
            elif kind == "trigger":
                record["triggered_at"] = row["at"]
                record["trigger_snapshot"] = payload
            elif kind == "final":
                record["final_status"] = payload.get("final_status")
                record["error_detail"] = payload.get("error_detail")
            elif kind == "warning":
                record.setdefault("post_warnings", []).append({**payload, "at": row["at"]})

        if fills:
            total_qty = sum(f.get("qty", 0) for f in fills) or 0
            if total_qty:
                ibkr["avg_fill_price"] = (
                    sum(f.get("price", 0) * f.get("qty", 0) for f in fills) / total_qty
                )
        commissions = record.get("commissions") or []
        if fills or commissions:
            ibkr["total_commission"] = sum(
                f.get("commission", 0) or 0 for f in list(fills) + list(commissions)
            )
        realized = [c.get("realized_pnl") for c in commissions if c.get("realized_pnl") is not None]
        if realized:
            ibkr["realized_pnl"] = sum(realized)
        return record

    def recent_orders(self, window_minutes: int, now: datetime) -> List[RecentOrder]:
        cutoff = (now - timedelta(minutes=window_minutes)).isoformat()
        rows = self._conn.execute(
            "SELECT signature, quantity, created_at FROM trade_records"
            " WHERE created_at >= ? AND signature != ''",
            (cutoff,),
        ).fetchall()
        out = []
        for row in rows:
            try:
                created = datetime.fromisoformat(row["created_at"])
            except ValueError:
                continue
            out.append(RecentOrder(row["signature"], float(row["quantity"]), created))
        return out

    # ---- 导出 / 删除(§9.3 可携带权与删除权)------------------------------
    def export_all(self) -> Dict[str, Any]:
        return {
            "exported_at": _now_iso(),
            "records": self.list_records(limit=1_000_000),
            "audit_log": [
                dict(r)
                for r in self._conn.execute("SELECT * FROM audit_log ORDER BY seq").fetchall()
            ],
        }

    def purge_everything(self, confirm: str) -> None:
        """彻底删除:唯一被允许的破坏性操作,且必须显式确认口令。"""
        if confirm != "DELETE ALL MY TRADING DATA":
            raise ValueError("确认口令不正确,已中止。")
        self._conn.close()
        self.db_path.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm"):
            Path(str(self.db_path) + suffix).unlink(missing_ok=True)


def redact_account(account_id: str) -> str:
    """§9.3 日志脱敏:DU1234567 → DU***567"""
    if not account_id:
        return ""
    if len(account_id) <= 5:
        return account_id[0] + "***"
    return "%s***%s" % (account_id[:2], account_id[-3:])


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
