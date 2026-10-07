/**
 * 跟单日志(docs/features/follow.md):信任的发送者发来的每一条像单子的消息落一行,只增不改。
 * 消息 ID 唯一:同一条消息处理过一次就不再处理第二次(重连补发、引擎重启都一样);
 * 「今天跟了几单」从这里数,不另存计数——计数存在内存里,引擎一重建就归零。
 */
import type Database from "better-sqlite3";

import type { FollowEntry, FollowOutcome } from "./contract/follow.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS follow_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    record_ids  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS follow_log_at ON follow_log(at);
CREATE TRIGGER IF NOT EXISTS follow_log_no_update
BEFORE UPDATE ON follow_log
BEGIN SELECT RAISE(ABORT, 'follow_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS follow_log_no_delete
BEFORE DELETE ON follow_log
BEGIN SELECT RAISE(ABORT, 'follow_log is append-only'); END;
`;

const OUTCOMES = new Set<FollowOutcome>(["sent", "held", "observed", "stale", "unparsed", "capped", "blocked", "rejected"]);

/** 原文与说明各留多长:够看清是哪一条,不把整段闲聊存下来。 */
export const FOLLOW_TEXT_MAX = 200;

interface FollowRow {
  at: string;
  message_id: string;
  author_id: string;
  author_name: string;
  text: string;
  outcome: string;
  detail: string;
  summary: string;
  record_ids: string;
}

export class FollowLogStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /** 这条消息处理过没有。 */
  has(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM follow_log WHERE message_id = ?").get(messageId) !== undefined;
  }

  /** 落一行;同一条消息已经有了就不落,返回 false。 */
  add(entry: FollowEntry): boolean {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO follow_log (at, message_id, author_id, author_name, text, outcome, detail, summary, record_ids)" +
        " VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.at, entry.message_id, entry.author_id, entry.author_name.slice(0, 80), entry.text.slice(0, FOLLOW_TEXT_MAX),
        entry.outcome, entry.detail.slice(0, 400), entry.summary.slice(0, 400), JSON.stringify(entry.record_ids),
      );
    return info.changes > 0;
  }

  /** `since`(ISO)起发出去了几单。 */
  sentSince(since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM follow_log WHERE outcome = 'sent' AND at >= ?")
      .get(since) as { n: number };
    return Number(row.n) || 0;
  }

  /** 最近的几条,新的在前;不认识的下场(更新版本的软件写的)跳过。 */
  recent(limit = 30): FollowEntry[] {
    const rows = this.db
      .prepare(
        "SELECT at, message_id, author_id, author_name, text, outcome, detail, summary, record_ids" +
        " FROM follow_log ORDER BY seq DESC LIMIT ?",
      )
      .all(limit) as FollowRow[];
    return rows.flatMap((r) => (OUTCOMES.has(r.outcome as FollowOutcome)
      ? [{
        at: r.at, message_id: r.message_id, author_id: r.author_id, author_name: r.author_name, text: r.text,
        outcome: r.outcome as FollowOutcome, detail: r.detail, summary: r.summary, record_ids: recordIds(r.record_ids),
      }]
      : []));
  }
}

function recordIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
