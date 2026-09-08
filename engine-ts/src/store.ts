/** 交易记录落库(对应 Python store.py,§6 / §9.6)。
 *
 * 审计要求"只增不改":没有 UPDATE 路径,数据库层用触发器把 UPDATE/DELETE
 * 直接 ABORT,状态变化一律 append 成事件,读取时折叠成 §6 的文档。
 * SCHEMA 与 Python 版逐字节相同——旧库文件直接打开是本模块的验收标准。
 *
 * 注:静态加密需要 SQLCipher 构建;better-sqlite3 标准构建不带,与 Python 版
 * 相同地退化为 0600 文件权限(Windows 上是尽力而为)。
 */
import Database from "better-sqlite3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RecentOrder } from "./validator.js";

export const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS broker_fills (
    exec_id     TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    perm_id     TEXT NOT NULL DEFAULT '',
    time        TEXT NOT NULL,
    fill_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_time ON broker_fills(time);
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

-- 想法知识总结(对一批归档想法的 LLM 提炼;保留历史,复盘时能看到认知演化)
CREATE TABLE IF NOT EXISTS idea_digests (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'archived',
    idea_count INTEGER NOT NULL DEFAULT 0,
    idea_ids   TEXT NOT NULL DEFAULT '[]',
    digest     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_idea_digests_created ON idea_digests(created_at);

-- 价位警告(状态要跨重启保留)
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

-- 持仓追踪(peak / fired / enabled 必须跨重启保留)
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
    leg        TEXT NOT NULL DEFAULT '',
    UNIQUE(account, symbol, sec_type, leg)
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
`;

export const TERMINAL_STATUSES = new Set([
  "filled",
  "partially_filled",
  "cancelled",
  "expired_untriggered",
  "rejected_by_validator",
  "rejected_by_llm",
  "ibkr_error",
  "halted_by_breaker", // 熔断挂起时被拦下、从未提交的已批准订单
]);

export const IDEA_STATUSES = ["active", "done", "archived"] as const;

type Rec = Record<string, any>;

export class TradeStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const fresh = !fs.existsSync(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    if (fresh) {
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        // Windows 上尽力而为
      }
    }
  }

  private migrate(): void {
    // 向后兼容的轻量迁移:老库缺列时补上,不动已有数据
    const cols = new Set(
      (this.db.pragma("table_info(ideas)") as Array<{ name: string }>).map((r) => r.name),
    );
    if (cols.size && !cols.has("analysis")) {
      this.db.exec("ALTER TABLE ideas ADD COLUMN analysis TEXT NOT NULL DEFAULT ''");
    }

    // 追踪表加"腿身份"列并把唯一约束改成含腿(与 Python 同一段迁移):
    // 老约束让一只蝴蝶的三条腿只能追踪一条。SQLite 改不了约束,只能整表重建。
    const tcols = new Set(
      (this.db.pragma("table_info(position_tracks)") as Array<{ name: string }>).map((r) => r.name),
    );
    if (tcols.size && !tcols.has("leg")) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE position_tracks_v2 (
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
            leg        TEXT NOT NULL DEFAULT '',
            UNIQUE(account, symbol, sec_type, leg)
        );
        INSERT INTO position_tracks_v2
            (id, created_at, updated_at, account, symbol, sec_type, contract, targets,
             auto_close, enabled, peak, fired_at, fired_state, fired_record, note, leg)
        SELECT id, created_at, updated_at, account, symbol, sec_type, contract, targets,
               auto_close, enabled, peak, fired_at, fired_state, fired_record, note, ''
        FROM position_tracks;
        DROP TABLE position_tracks;
        ALTER TABLE position_tracks_v2 RENAME TO position_tracks;
        COMMIT;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- 写入 -----------------------------------------------------------
  createRecord(record: Rec): string {
    const recordId: string = record["id"] || crypto.randomUUID();
    record["id"] = recordId;
    if (!("created_at" in record)) record["created_at"] = nowIso();
    this.db
      .prepare(
        "INSERT INTO trade_records" +
        " (id, created_at, signature, quantity, symbol, account_id, prompt_version, record_json)" +
        " VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        recordId,
        record["created_at"],
        record["signature"] ?? "",
        Number(record["order"]?.["totalQuantity"] ?? 0) || 0,
        record["contract"]?.["symbol"] ?? "",
        record["account"]?.["account_id"] ?? "",
        record["llm"]?.["prompt_version"] ?? "",
        sortedJson(record),
      );
    return recordId;
  }

  appendEvent(recordId: string, kind: string, payload: Rec): void {
    this.db
      .prepare("INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)")
      .run(recordId, nowIso(), kind, JSON.stringify(payload));
  }

  setFinalStatus(recordId: string, status: string, errorDetail: string | null = null): void {
    if (!TERMINAL_STATUSES.has(status)) throw new Error(`未知终态:${status}`);
    this.appendEvent(recordId, "final", { final_status: status, error_detail: errorDetail });
  }

  /** §9.6:切换账户、改限额、改别名表、开关自动执行等关键操作单独留痕。 */
  // ---- 券商成交:只增不改,按 exec_id 去重 ------------------------------
  /** 把券商报回来的成交行存下来(IBKR 只给当天的,靠这里累积成历史)。返回新增条数。 */
  rememberFills(rows: Rec[]): number {
    let added = 0;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO broker_fills (exec_id, account_id, perm_id, time, fill_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      const execId = String(row["exec_id"] ?? "");
      if (!execId) continue;
      const info = stmt.run(execId, String(row["account_id"] ?? ""), String(row["perm_id"] ?? ""),
        String(row["time"] ?? ""), JSON.stringify(sortKeys(row)));
      added += Number(info.changes ?? 0);
    }
    return added;
  }

  listFills(limit = 5000): Rec[] {
    return (this.db.prepare("SELECT fill_json FROM broker_fills ORDER BY time ASC, exec_id ASC LIMIT ?").all(limit) as Rec[])
      .map((r) => JSON.parse(String(r["fill_json"])));
  }

  audit(actor: string, action: string, detail: Rec | null = null): void {
    this.db
      .prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)")
      .run(nowIso(), actor, action, JSON.stringify(detail ?? {}));
  }

  // ---- 价位警告 --------------------------------------------------------
  addWatch(symbol: string, step = 5.0): Rec {
    symbol = (symbol || "").trim().toUpperCase();
    if (!symbol) throw new Error("标的代码为空");
    if (!(step > 0 && step <= 1000)) throw new Error("整数关口步长必须在 0~1000 之间");
    const watch: Rec = {
      id: crypto.randomUUID(),
      created_at: nowIso(),
      updated_at: nowIso(),
      symbol,
      step,
      enabled: 1,
      expiry: "",
      levels: [],
      states: {},
      last_price: null,
      wall: null,
      events: [],
    };
    try {
      this.db
        .prepare(
          "INSERT INTO alert_watches (id, created_at, updated_at, symbol, step) VALUES (?,?,?,?,?)",
        )
        .run(watch["id"], watch["created_at"], watch["updated_at"], symbol, step);
    } catch (exc) {
      if (isUniqueViolation(exc)) throw new Error(`已经在盯 ${symbol} 了`);
      throw exc;
    }
    return watch;
  }

  listWatches(): Rec[] {
    return (this.db.prepare("SELECT * FROM alert_watches ORDER BY created_at").all() as Rec[]).map(
      watchRow,
    );
  }

  getWatch(watchId: string): Rec | null {
    const row = this.db.prepare("SELECT * FROM alert_watches WHERE id=?").get(watchId) as
      | Rec
      | undefined;
    return row ? watchRow(row) : null;
  }

  /** 只允许改这几列。列名是白名单,不接受任意字段拼 SQL。 */
  updateWatch(watchId: string, fields: Rec): boolean {
    const allowed = new Set([
      "step", "enabled", "expiry", "levels", "states", "last_price", "wall", "events",
    ]);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, rawValue] of Object.entries(fields)) {
      if (!allowed.has(key)) throw new Error(`不允许修改的字段:${key}`);
      let value = rawValue;
      if (["levels", "states", "wall", "events"].includes(key)) {
        value = rawValue !== null && rawValue !== undefined ? JSON.stringify(rawValue) : "";
      }
      if (key === "enabled") value = rawValue ? 1 : 0;
      sets.push(`${key}=?`);
      values.push(value);
    }
    if (!sets.length) return false;
    sets.push("updated_at=?");
    values.push(nowIso());
    values.push(watchId);
    const cur = this.db
      .prepare(`UPDATE alert_watches SET ${sets.join(", ")} WHERE id=?`)
      .run(...(values as never[]));
    return cur.changes > 0;
  }

  deleteWatch(watchId: string): boolean {
    return this.db.prepare("DELETE FROM alert_watches WHERE id=?").run(watchId).changes > 0;
  }

  // ---- 持仓追踪 -------------------------------------------------------
  /** 同一个账户的同一个合约只能有一条追踪。 */
  addTrack(track: Rec): Rec {
    const row: Rec = {
      id: crypto.randomUUID(),
      created_at: nowIso(),
      updated_at: nowIso(),
      account: track["account"],
      symbol: track["symbol"],
      sec_type: track["sec_type"] ?? "STK",
      contract: track["contract"] ?? {},
      targets: track["targets"] ?? {},
      auto_close: track["auto_close"] ?? {},
      enabled: 1,
      peak: track["peak"] ?? null,
      fired_at: null,
      fired_state: "",
      fired_record: "",
      note: track["note"] ?? "",
      leg: track["leg"] || "",
    };
    try {
      this.db
        .prepare(
          "INSERT INTO position_tracks" +
          " (id, created_at, updated_at, account, symbol, sec_type, contract," +
          "  targets, auto_close, peak, note, leg)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          row["id"], row["created_at"], row["updated_at"], row["account"], row["symbol"],
          row["sec_type"], JSON.stringify(row["contract"]), JSON.stringify(row["targets"]),
          JSON.stringify(row["auto_close"]), row["peak"], row["note"], row["leg"],
        );
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        const what = row["leg"] ? `${row["symbol"]} ${row["leg"]}` : row["symbol"];
        throw new Error(`已经在追踪 ${row["account"]} 的 ${what} 了`);
      }
      throw exc;
    }
    return row;
  }

  listTracks(): Rec[] {
    return (
      this.db.prepare("SELECT * FROM position_tracks ORDER BY created_at DESC").all() as Rec[]
    ).map(trackRow);
  }

  getTrack(trackId: string): Rec | null {
    const row = this.db.prepare("SELECT * FROM position_tracks WHERE id=?").get(trackId) as
      | Rec
      | undefined;
    return row ? trackRow(row) : null;
  }

  /** 只允许改这几列。peak / fired_* 是引擎写的,targets / enabled 是用户写的。 */
  updateTrack(trackId: string, fields: Rec): boolean {
    const allowed = new Set([
      "targets", "auto_close", "enabled", "peak", "fired_at", "fired_state", "fired_record", "note",
    ]);
    const unknown = Object.keys(fields).filter((k) => !allowed.has(k)).sort();
    if (unknown.length) throw new Error(`不允许修改的字段:${unknown.join(", ")}`);
    if (!Object.keys(fields).length) return false;
    const sets = ["updated_at=?"];
    const values: unknown[] = [nowIso()];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key}=?`);
      if (key === "targets" || key === "auto_close") values.push(JSON.stringify(value ?? {}));
      else if (key === "enabled") values.push(value ? 1 : 0);
      else values.push(value);
    }
    values.push(trackId);
    const cur = this.db
      .prepare(`UPDATE position_tracks SET ${sets.join(", ")} WHERE id=?`)
      .run(...(values as never[]));
    return cur.changes > 0;
  }

  deleteTrack(trackId: string): boolean {
    return this.db.prepare("DELETE FROM position_tracks WHERE id=?").run(trackId).changes > 0;
  }

  // ---- 自定义板块 ------------------------------------------------------
  addSector(name: string): Rec {
    name = (name || "").trim();
    if (!name) throw new Error("板块名称为空");
    if (name.length > 50) throw new Error("板块名称太长(超过 50 字)");
    const sector: Rec = {
      id: crypto.randomUUID(),
      created_at: nowIso(),
      updated_at: nowIso(),
      name,
      stocks: [],
    };
    try {
      this.db
        .prepare("INSERT INTO sectors (id, created_at, updated_at, name, stocks) VALUES (?,?,?,?,?)")
        .run(sector["id"], sector["created_at"], sector["updated_at"], name, "[]");
    } catch (exc) {
      if (isUniqueViolation(exc)) throw new Error(`板块已存在:${name}`);
      throw exc;
    }
    return sector;
  }

  getSector(sectorId: string): Rec | null {
    const row = this.db.prepare("SELECT * FROM sectors WHERE id=?").get(sectorId) as Rec | undefined;
    return row ? sectorRow(row) : null;
  }

  listSectors(): Rec[] {
    return (this.db.prepare("SELECT * FROM sectors ORDER BY created_at").all() as Rec[]).map(
      sectorRow,
    );
  }

  setSectorStocks(sectorId: string, stocks: Rec[]): boolean {
    return (
      this.db
        .prepare("UPDATE sectors SET stocks=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(stocks), nowIso(), sectorId).changes > 0
    );
  }

  deleteSector(sectorId: string): boolean {
    return this.db.prepare("DELETE FROM sectors WHERE id=?").run(sectorId).changes > 0;
  }

  // ---- 想法备忘 --------------------------------------------------------
  addIdea(text: string, symbols?: string[] | null): Rec {
    text = (text || "").trim();
    if (!text) throw new Error("想法内容为空");
    const idea: Rec = {
      id: crypto.randomUUID(),
      created_at: nowIso(),
      updated_at: nowIso(),
      text,
      symbols: [...(symbols ?? [])],
      status: "active",
      analysis: null,
    };
    this.db
      .prepare(
        "INSERT INTO ideas (id, created_at, updated_at, text, symbols, status) VALUES (?,?,?,?,?,?)",
      )
      .run(
        idea["id"], idea["created_at"], idea["updated_at"], idea["text"],
        JSON.stringify(idea["symbols"]), idea["status"],
      );
    return idea;
  }

  listIdeas(status: string | null = null, limit = 200): Rec[] {
    if (status !== null && !(IDEA_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`未知想法状态:${status}`);
    }
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM ideas WHERE status=? ORDER BY created_at DESC LIMIT ?")
          .all(status, limit) as Rec[])
      : (this.db
          .prepare("SELECT * FROM ideas ORDER BY created_at DESC LIMIT ?")
          .all(limit) as Rec[]);
    return rows.map(ideaRow);
  }

  getIdea(ideaId: string): Rec | null {
    const row = this.db.prepare("SELECT * FROM ideas WHERE id=?").get(ideaId) as Rec | undefined;
    return row ? ideaRow(row) : null;
  }

  setIdeaSymbols(ideaId: string, symbols: string[]): boolean {
    return (
      this.db
        .prepare("UPDATE ideas SET symbols=?, updated_at=? WHERE id=?")
        .run(JSON.stringify([...symbols]), nowIso(), ideaId).changes > 0
    );
  }

  setIdeaAnalysis(ideaId: string, analysis: Rec): boolean {
    return (
      this.db
        .prepare("UPDATE ideas SET analysis=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(analysis), nowIso(), ideaId).changes > 0
    );
  }

  setIdeaStatus(ideaId: string, status: string): boolean {
    if (!(IDEA_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`未知想法状态:${status}`);
    }
    return (
      this.db
        .prepare("UPDATE ideas SET status=?, updated_at=? WHERE id=?")
        .run(status, nowIso(), ideaId).changes > 0
    );
  }

  // ---- 想法知识总结 ----------------------------------------------------
  addIdeaDigest(scope: string, ideaIds: string[], digest: Rec): Rec {
    const row = {
      id: crypto.randomUUID(),
      created_at: nowIso(),
      scope,
      idea_count: ideaIds.length,
      idea_ids: [...ideaIds],
      digest: { ...digest },
    };
    this.db
      .prepare(
        "INSERT INTO idea_digests (id, created_at, scope, idea_count, idea_ids, digest)" +
        " VALUES (?,?,?,?,?,?)",
      )
      .run(
        row.id, row.created_at, row.scope, row.idea_count,
        JSON.stringify(row.idea_ids), JSON.stringify(row.digest),
      );
    return row;
  }

  listIdeaDigests(limit = 20): Rec[] {
    const rows = this.db
      .prepare("SELECT * FROM idea_digests ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Rec[];
    return rows.map((raw) => {
      const digest = { ...raw };
      for (const [key, empty] of [["idea_ids", []], ["digest", {}]] as const) {
        try {
          digest[key] = JSON.parse((digest[key] as string) || "null") ?? empty;
        } catch {
          digest[key] = empty;
        }
      }
      return digest;
    });
  }

  // ---- 读取 -----------------------------------------------------------
  getRecord(recordId: string): Rec | null {
    const row = this.db
      .prepare("SELECT record_json FROM trade_records WHERE id=?")
      .get(recordId) as { record_json: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.record_json) as Rec;
    return this.foldEvents(recordId, record);
  }

  listRecords(limit = 50): Rec[] {
    const rows = this.db
      .prepare("SELECT id FROM trade_records ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ id: string }>;
    const out: Rec[] = [];
    for (const row of rows) {
      const record = this.getRecord(row.id);
      if (record) out.push(record);
    }
    return out;
  }

  private foldEvents(recordId: string, record: Rec): Rec {
    if (!record["ibkr"] || typeof record["ibkr"] !== "object") record["ibkr"] = {};
    const ibkr = record["ibkr"] as Rec;
    if (!Array.isArray(ibkr["status_timeline"])) ibkr["status_timeline"] = [];
    if (!Array.isArray(ibkr["fills"])) ibkr["fills"] = [];
    const timeline = ibkr["status_timeline"] as Rec[];
    const fills = ibkr["fills"] as Rec[];

    const rows = this.db
      .prepare("SELECT at, kind, payload FROM record_events WHERE record_id=? ORDER BY seq")
      .all(recordId) as Array<{ at: string; kind: string; payload: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Rec;
      const kind = row.kind;
      if (kind === "status") {
        timeline.push({ status: payload["status"] ?? null, at: row.at });
        for (const key of ["order_id", "perm_id"]) {
          if (payload[key] !== null && payload[key] !== undefined) ibkr[key] = payload[key];
        }
      } else if (kind === "fill") {
        fills.push({ ...payload, time: payload["time"] || row.at });
      } else if (kind === "commission") {
        if (!Array.isArray(record["commissions"])) record["commissions"] = [];
        (record["commissions"] as Rec[]).push({ ...payload, at: row.at });
      } else if (kind === "trigger") {
        record["triggered_at"] = row.at;
        record["trigger_snapshot"] = payload;
      } else if (kind === "final") {
        record["final_status"] = payload["final_status"] ?? null;
        record["error_detail"] = payload["error_detail"] ?? null;
      } else if (kind === "warning") {
        if (!Array.isArray(record["post_warnings"])) record["post_warnings"] = [];
        (record["post_warnings"] as Rec[]).push({ ...payload, at: row.at });
      }
    }

    if (fills.length) {
      const totalQty = fills.reduce((acc, f) => acc + (Number(f["qty"]) || 0), 0) || 0;
      if (totalQty) {
        ibkr["avg_fill_price"] =
          fills.reduce((acc, f) => acc + (Number(f["price"]) || 0) * (Number(f["qty"]) || 0), 0) /
          totalQty;
      }
    }
    const commissions = (record["commissions"] as Rec[]) ?? [];
    if (fills.length || commissions.length) {
      ibkr["total_commission"] = [...fills, ...commissions].reduce(
        (acc, f) => acc + (Number(f["commission"]) || 0),
        0,
      );
    }
    const realized = commissions
      .map((c) => c["realized_pnl"])
      .filter((v) => v !== null && v !== undefined) as number[];
    if (realized.length) ibkr["realized_pnl"] = realized.reduce((a, b) => a + b, 0);
    return record;
  }

  /** 重复防抖候选集:只统计真正提交过或进过盯盘队列的记录(ValidatedOnly 不算)。
   * 时间过滤在代码里做,不在 SQL 里做字符串比较——混合时区偏移下字典序不是时间序。 */
  recentOrders(windowMinutes: number, nowMs: number): RecentOrder[] {
    const windowMs = windowMinutes * 60_000;
    const rows = this.db
      .prepare(
        "SELECT signature, quantity, created_at FROM trade_records t" +
        " WHERE signature != ''" +
        " AND EXISTS (" +
        "   SELECT 1 FROM record_events e" +
        "   WHERE e.record_id = t.id AND e.kind = 'status'" +
        "   AND e.payload NOT LIKE '%ValidatedOnly%'" +
        " )" +
        " ORDER BY rowid DESC LIMIT 1000",
      )
      .all() as Array<{ signature: string; quantity: number; created_at: string }>;
    const out: RecentOrder[] = [];
    for (const row of rows) {
      // Date.parse:带偏移的 ISO 直接换算;naive 字符串按本机时区解释,
      // 与 Python 版"老记录若是 naive 按本机时钟补全"的语义一致
      const created = Date.parse(row.created_at);
      if (Number.isNaN(created)) continue;
      const delta = nowMs - created;
      if (delta > windowMs || delta < -windowMs) continue;
      out.push({ signature: row.signature, quantity: row.quantity, createdAtMs: created });
    }
    return out;
  }

  // ---- 导出 / 删除(§9.3 可携带权与删除权)------------------------------
  exportAll(): Rec {
    return {
      exported_at: nowIso(),
      records: this.listRecords(1_000_000),
      audit_log: this.db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as Rec[],
    };
  }

  /** 彻底删除:唯一被允许的破坏性操作,且必须显式确认口令。 */
  purgeEverything(confirm: string): void {
    if (confirm !== "DELETE ALL MY TRADING DATA") {
      throw new Error("确认口令不正确,已中止。");
    }
    this.db.close();
    fs.rmSync(this.dbPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(this.dbPath + suffix, { force: true });
    }
  }

  /** 测试与诊断用:直接执行 SQL(生产路径不用)。 */
  rawExec(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...(params as never[]));
  }
}

function watchRow(row: Rec): Rec {
  const watch: Rec = { ...row };
  for (const [key, empty] of [
    ["levels", []], ["states", {}], ["events", []], ["wall", null],
  ] as Array<[string, unknown]>) {
    const raw = watch[key];
    try {
      watch[key] = raw ? JSON.parse(raw) : empty;
    } catch {
      watch[key] = empty;
    }
  }
  watch["enabled"] = Boolean(watch["enabled"]);
  return watch;
}

function trackRow(row: Rec): Rec {
  const out: Rec = { ...row };
  for (const key of ["contract", "targets", "auto_close"]) {
    try {
      out[key] = JSON.parse(out[key] || "{}");
    } catch {
      out[key] = {};
    }
  }
  out["enabled"] = Boolean(out["enabled"]);
  return out;
}

function sectorRow(row: Rec): Rec {
  const sector: Rec = { ...row };
  try {
    sector["stocks"] = JSON.parse(sector["stocks"] || "[]");
  } catch {
    sector["stocks"] = [];
  }
  return sector;
}

function ideaRow(row: Rec): Rec {
  const idea: Rec = { ...row };
  try {
    idea["symbols"] = JSON.parse(idea["symbols"] || "[]");
  } catch {
    idea["symbols"] = [];
  }
  const rawAnalysis = idea["analysis"] || "";
  try {
    idea["analysis"] = rawAnalysis ? JSON.parse(rawAnalysis) : null;
  } catch {
    idea["analysis"] = null;
  }
  return idea;
}

/** §9.3 日志脱敏:DU1234567 → DU***567 */
export function redactAccount(accountId: string): string {
  if (!accountId) return "";
  if (accountId.length <= 5) return accountId[0] + "***";
  return `${accountId.slice(0, 2)}***${accountId.slice(-3)}`;
}

/** 统一 UTC,秒级精度,Python isoformat 风格("+00:00" 而不是 "Z")。 */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function isUniqueViolation(exc: unknown): boolean {
  return (
    exc instanceof Error &&
    ((exc as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT") ?? false)
  );
}

/** Python json.dumps(sort_keys=True) 的结构等价物:键排序的稳定序列化。
 * (数值表示走 JS 最短形式;JSON 数值在读回时与 Python 逐位一致。) */
function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Rec = {};
    for (const key of Object.keys(value as Rec).sort()) {
      out[key] = sortKeys((value as Rec)[key]);
    }
    return out;
  }
  return value;
}
