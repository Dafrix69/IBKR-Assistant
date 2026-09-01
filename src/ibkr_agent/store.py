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
from datetime import datetime, timedelta, timezone
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

-- 自定义板块(名称 + AI 选出的成分股快照;展示用数据,不进下单链路)
CREATE TABLE IF NOT EXISTS sectors (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    stocks     TEXT NOT NULL DEFAULT '[]'
);

-- 想法备忘(不是交易记录,不受 append-only 审计约束;只允许改 status)
CREATE TABLE IF NOT EXISTS ideas (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    text       TEXT NOT NULL,
    symbols    TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'active',
    analysis   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ideas_created ON ideas(created_at);

-- 价位警告(不是交易记录,可增删改;状态要跨重启保留,否则重开一次
-- 应用就会把现价附近的价位全部重报一遍)
CREATE TABLE IF NOT EXISTS alert_watches (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    symbol     TEXT NOT NULL UNIQUE,
    step       REAL NOT NULL DEFAULT 5.0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    expiry     TEXT NOT NULL DEFAULT '',
    levels     TEXT NOT NULL DEFAULT '[]',
    states     TEXT NOT NULL DEFAULT '{}',
    last_price REAL,
    wall       TEXT NOT NULL DEFAULT '',
    events     TEXT NOT NULL DEFAULT '[]'
);

-- 持仓追踪(盯住账户里的一个持仓,到价自动平仓)。
-- 三样东西必须跨重启保留,否则重开一次应用就等于把保护松开:
--   peak    跟踪止损的"最有利价"——重新起算等于把已锁住的利润放开;
--   fired   已经触发过一次的标记——不然价格在触发价附近抖动会反复发单;
--   enabled 用户主动停掉的追踪不该因为重启又活过来。
CREATE TABLE IF NOT EXISTS position_tracks (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account    TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    sec_type   TEXT NOT NULL DEFAULT 'STK',
    contract   TEXT NOT NULL DEFAULT '{}',
    targets    TEXT NOT NULL DEFAULT '{}',
    auto_close TEXT NOT NULL DEFAULT '{}',
    enabled    INTEGER NOT NULL DEFAULT 1,
    peak       REAL,
    fired_at   TEXT,
    fired_state TEXT NOT NULL DEFAULT '',
    fired_record TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    UNIQUE(account, symbol, sec_type)
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
    "halted_by_breaker",   # 熔断挂起时被拦下、从未提交的已批准订单
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
        self._migrate()
        if fresh:
            os.chmod(self.db_path, 0o600)

    def _migrate(self) -> None:
        """向后兼容的轻量迁移:老库缺列时补上,不动已有数据。"""
        cols = {row["name"] for row in self._conn.execute("PRAGMA table_info(ideas)")}
        if cols and "analysis" not in cols:
            self._conn.execute("ALTER TABLE ideas ADD COLUMN analysis TEXT NOT NULL DEFAULT ''")

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

    # ---- 价位警告 --------------------------------------------------------
    def add_watch(self, symbol: str, step: float = 5.0) -> Dict[str, Any]:
        symbol = (symbol or "").strip().upper()
        if not symbol:
            raise ValueError("标的代码为空")
        if not (0 < float(step) <= 1000):
            raise ValueError("整数关口步长必须在 0~1000 之间")
        watch = {
            "id": str(uuid.uuid4()),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "symbol": symbol,
            "step": float(step),
            "enabled": 1,
            "expiry": "",
            "levels": [], "states": {}, "last_price": None, "wall": None, "events": [],
        }
        try:
            with self._tx() as conn:
                conn.execute(
                    "INSERT INTO alert_watches (id, created_at, updated_at, symbol, step)"
                    " VALUES (?,?,?,?,?)",
                    (watch["id"], watch["created_at"], watch["updated_at"], symbol, watch["step"]),
                )
        except sqlite3.IntegrityError:
            raise ValueError("已经在盯 %s 了" % symbol)
        return watch

    def list_watches(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM alert_watches ORDER BY created_at"
        ).fetchall()
        return [self._watch_row(row) for row in rows]

    def get_watch(self, watch_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM alert_watches WHERE id=?", (watch_id,)
        ).fetchone()
        return self._watch_row(row) if row else None

    def update_watch(self, watch_id: str, **fields) -> bool:
        """只允许改这几列。列名是白名单,不接受任意字段拼 SQL。"""
        allowed = {"step", "enabled", "expiry", "levels", "states", "last_price",
                   "wall", "events"}
        sets, values = [], []
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError("不允许修改的字段:%s" % key)
            if key in ("levels", "states", "wall", "events"):
                value = json.dumps(value, ensure_ascii=False) if value is not None else ""
            sets.append("%s=?" % key)
            values.append(value)
        if not sets:
            return False
        sets.append("updated_at=?")
        values.append(_now_iso())
        values.append(watch_id)
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE alert_watches SET %s WHERE id=?" % ", ".join(sets), values
            )
        return cur.rowcount > 0

    def delete_watch(self, watch_id: str) -> bool:
        with self._tx() as conn:
            cur = conn.execute("DELETE FROM alert_watches WHERE id=?", (watch_id,))
        return cur.rowcount > 0

    @staticmethod
    def _watch_row(row: sqlite3.Row) -> Dict[str, Any]:
        watch = dict(row)
        for key, empty in (("levels", []), ("states", {}), ("events", []), ("wall", None)):
            raw = watch.get(key)
            try:
                watch[key] = json.loads(raw) if raw else empty
            except (json.JSONDecodeError, TypeError):
                watch[key] = empty
        watch["enabled"] = bool(watch.get("enabled"))
        return watch

    # ---- 自定义板块 ------------------------------------------------------
    # ---- 持仓追踪 -------------------------------------------------------
    def add_track(self, track: Dict[str, Any]) -> Dict[str, Any]:
        """新建一个追踪。同一个账户的同一个合约只能有一条——重复设置只会让
        两条追踪各自发一次平仓单,把仓位平成反向。"""
        row = {
            "id": str(uuid.uuid4()),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "account": track["account"],
            "symbol": track["symbol"],
            "sec_type": track.get("sec_type", "STK"),
            "contract": track.get("contract") or {},
            "targets": track.get("targets") or {},
            "auto_close": track.get("auto_close") or {},
            "enabled": 1,
            "peak": track.get("peak"),
            "fired_at": None,
            "fired_state": "",
            "fired_record": "",
            "note": track.get("note", ""),
        }
        try:
            with self._tx() as conn:
                conn.execute(
                    "INSERT INTO position_tracks"
                    " (id, created_at, updated_at, account, symbol, sec_type, contract,"
                    "  targets, auto_close, peak, note)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (row["id"], row["created_at"], row["updated_at"], row["account"],
                     row["symbol"], row["sec_type"],
                     json.dumps(row["contract"], ensure_ascii=False),
                     json.dumps(row["targets"], ensure_ascii=False),
                     json.dumps(row["auto_close"], ensure_ascii=False),
                     row["peak"], row["note"]),
                )
        except sqlite3.IntegrityError:
            raise ValueError("已经在追踪 %s 的 %s 了" % (row["account"], row["symbol"]))
        return row

    def list_tracks(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM position_tracks ORDER BY created_at DESC"
        ).fetchall()
        return [self._track_row(r) for r in rows]

    def get_track(self, track_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM position_tracks WHERE id=?", (track_id,)
        ).fetchone()
        return self._track_row(row) if row else None

    def update_track(self, track_id: str, **fields) -> bool:
        """只允许改这几列。peak / fired_* 是引擎写的,targets / enabled 是用户写的。"""
        allowed = {"targets", "auto_close", "enabled", "peak",
                   "fired_at", "fired_state", "fired_record", "note"}
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError("不允许修改的字段:%s" % ", ".join(sorted(unknown)))
        if not fields:
            return False
        sets, values = ["updated_at=?"], [_now_iso()]
        for key, value in fields.items():
            sets.append("%s=?" % key)
            if key in ("targets", "auto_close"):
                values.append(json.dumps(value or {}, ensure_ascii=False))
            elif key == "enabled":
                values.append(1 if value else 0)
            else:
                values.append(value)
        values.append(track_id)
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE position_tracks SET %s WHERE id=?" % ", ".join(sets), values
            )
        return cur.rowcount > 0

    def delete_track(self, track_id: str) -> bool:
        with self._tx() as conn:
            cur = conn.execute("DELETE FROM position_tracks WHERE id=?", (track_id,))
        return cur.rowcount > 0

    @staticmethod
    def _track_row(row: sqlite3.Row) -> Dict[str, Any]:
        out = dict(row)
        for key in ("contract", "targets", "auto_close"):
            try:
                out[key] = json.loads(out.get(key) or "{}")
            except json.JSONDecodeError:
                out[key] = {}
        out["enabled"] = bool(out.get("enabled"))
        return out

    def add_sector(self, name: str) -> Dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise ValueError("板块名称为空")
        if len(name) > 50:
            raise ValueError("板块名称太长(超过 50 字)")
        sector = {
            "id": str(uuid.uuid4()),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "name": name,
            "stocks": [],
        }
        try:
            with self._tx() as conn:
                conn.execute(
                    "INSERT INTO sectors (id, created_at, updated_at, name, stocks)"
                    " VALUES (?,?,?,?,?)",
                    (sector["id"], sector["created_at"], sector["updated_at"], name, "[]"),
                )
        except sqlite3.IntegrityError:
            raise ValueError("板块已存在:%s" % name)
        return sector

    def get_sector(self, sector_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute("SELECT * FROM sectors WHERE id=?", (sector_id,)).fetchone()
        return self._sector_row(row) if row else None

    def list_sectors(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute("SELECT * FROM sectors ORDER BY created_at").fetchall()
        return [self._sector_row(row) for row in rows]

    def set_sector_stocks(self, sector_id: str, stocks: List[Dict[str, Any]]) -> bool:
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE sectors SET stocks=?, updated_at=? WHERE id=?",
                (json.dumps(stocks, ensure_ascii=False), _now_iso(), sector_id),
            )
        return cur.rowcount > 0

    def delete_sector(self, sector_id: str) -> bool:
        with self._tx() as conn:
            cur = conn.execute("DELETE FROM sectors WHERE id=?", (sector_id,))
        return cur.rowcount > 0

    @staticmethod
    def _sector_row(row: sqlite3.Row) -> Dict[str, Any]:
        sector = dict(row)
        try:
            sector["stocks"] = json.loads(sector.get("stocks") or "[]")
        except json.JSONDecodeError:
            sector["stocks"] = []
        return sector

    # ---- 想法备忘 --------------------------------------------------------
    IDEA_STATUSES = ("active", "done", "archived")

    def add_idea(self, text: str, symbols: Optional[List[str]] = None) -> Dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValueError("想法内容为空")
        idea = {
            "id": str(uuid.uuid4()),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "text": text,
            "symbols": list(symbols or []),
            "status": "active",
            "analysis": None,
        }
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO ideas (id, created_at, updated_at, text, symbols, status)"
                " VALUES (?,?,?,?,?,?)",
                (
                    idea["id"], idea["created_at"], idea["updated_at"], idea["text"],
                    json.dumps(idea["symbols"], ensure_ascii=False), idea["status"],
                ),
            )
        return idea

    def list_ideas(self, status: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
        if status is not None and status not in self.IDEA_STATUSES:
            raise ValueError("未知想法状态:%s" % status)
        if status:
            rows = self._conn.execute(
                "SELECT * FROM ideas WHERE status=? ORDER BY created_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM ideas ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        out = []
        for row in rows:
            out.append(self._idea_row(row))
        return out

    def get_idea(self, idea_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute("SELECT * FROM ideas WHERE id=?", (idea_id,)).fetchone()
        return self._idea_row(row) if row else None

    def set_idea_symbols(self, idea_id: str, symbols: List[str]) -> bool:
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE ideas SET symbols=?, updated_at=? WHERE id=?",
                (json.dumps(list(symbols), ensure_ascii=False), _now_iso(), idea_id),
            )
        return cur.rowcount > 0

    def set_idea_analysis(self, idea_id: str, analysis: Dict[str, Any]) -> bool:
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE ideas SET analysis=?, updated_at=? WHERE id=?",
                (json.dumps(analysis, ensure_ascii=False), _now_iso(), idea_id),
            )
        return cur.rowcount > 0

    @staticmethod
    def _idea_row(row: sqlite3.Row) -> Dict[str, Any]:
        idea = dict(row)
        try:
            idea["symbols"] = json.loads(idea.get("symbols") or "[]")
        except json.JSONDecodeError:
            idea["symbols"] = []
        raw_analysis = idea.get("analysis") or ""
        try:
            idea["analysis"] = json.loads(raw_analysis) if raw_analysis else None
        except json.JSONDecodeError:
            idea["analysis"] = None
        return idea

    def set_idea_status(self, idea_id: str, status: str) -> bool:
        if status not in self.IDEA_STATUSES:
            raise ValueError("未知想法状态:%s" % status)
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE ideas SET status=?, updated_at=? WHERE id=?",
                (status, _now_iso(), idea_id),
            )
        return cur.rowcount > 0

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
        """重复防抖候选集:只统计真正提交过或进过盯盘队列的记录。

        「解析并校验」也会落一条 ValidatedOnly 记录(审计需要),但它从未出手,
        不能算作"已下过的单"——否则"先校验、再发送"这个界面引导的自然流程
        必然被防抖误杀。判据:存在 ValidatedOnly 之外的 status 事件
        (PendingTrigger / Submitted / …)才进入候选集;熔断拦下的单同样不算。

        必须在 Python 里按"解析后的时间"过滤,不能在 SQL 里做字符串比较:
        历史记录带的是本机时区偏移(如 +08:00),截止时间是美东(-04:00),
        ISO 字符串的字典序在混合偏移下不是时间序——之前的写法在非美东机器上
        会放过真正的重复单(双倍下单)或误杀正常单。
        """
        window = timedelta(minutes=window_minutes)
        rows = self._conn.execute(
            "SELECT signature, quantity, created_at FROM trade_records t"
            " WHERE signature != ''"
            " AND EXISTS ("
            "   SELECT 1 FROM record_events e"
            "   WHERE e.record_id = t.id AND e.kind = 'status'"
            "   AND e.payload NOT LIKE '%ValidatedOnly%'"
            " )"
            " ORDER BY rowid DESC LIMIT 1000",
        ).fetchall()
        out = []
        for row in rows:
            try:
                created = datetime.fromisoformat(row["created_at"])
            except ValueError:
                continue
            if created.tzinfo is None:
                # 老记录若是 naive,写入方就是本机时钟:按本机时区补全后再比较
                created = created.astimezone()
            delta = now - created
            if delta > window or delta < -window:
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
    # 统一 UTC:落库时间戳只做机器比较(去重窗口、排序),展示层自己转时区。
    # 本机时区(如 +08:00)与美东混用时,ISO 字符串比较不是时间序,踩过坑。
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
