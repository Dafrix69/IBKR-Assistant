/**
 * 跟单日志(docs/features/follow.md):信任的发送者发来的每一条像单子的消息落一行,只增不改。
 * 消息 ID 唯一:同一条消息处理过一次就不再处理第二次(重连补发、引擎重启都一样);
 * 「今天跟了几单」从这里数,不另存计数——计数存在内存里,引擎一重建就归零。
 *
 * 处理完之后取的那一次盘口(对方写的价、当时的中间价与立刻成交的价)另存一张表 follow_quotes:日志那一行落下去的时候
 * 报价还没取(取报价排在发单之后,而且可能取不到),日志表又不许改,所以不加列、另起一张,同样只增不改,读的时候按消息 ID 接上。
 */
import type Database from "better-sqlite3";

import type { FollowEntry, FollowOutcome, FollowQuote } from "./contract/follow.js";

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
CREATE TABLE IF NOT EXISTS follow_quotes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    side        TEXT NOT NULL,
    leader      REAL NOT NULL,
    mid         REAL NOT NULL,
    natural     REAL NOT NULL,
    lag_s       REAL NOT NULL,
    paper       INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS follow_quotes_no_update
BEFORE UPDATE ON follow_quotes
BEGIN SELECT RAISE(ABORT, 'follow_quotes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS follow_quotes_no_delete
BEFORE DELETE ON follow_quotes
BEGIN SELECT RAISE(ABORT, 'follow_quotes is append-only'); END;
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
  q_side: string | null;
  q_leader: number | null;
  q_mid: number | null;
  q_natural: number | null;
  q_lag_s: number | null;
  q_paper: number | null;
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

  /**
   * 给一条已经落了日志的消息补上那一次盘口;同一条消息只记第一次,返回 false = 没落(已经有了、这条消息没有日志、数不是正经数)。
   * `at` 是取到报价的时刻(ISO)。
   */
  addQuote(messageId: string, at: string, quote: FollowQuote): boolean {
    const numbers = [quote.leader, quote.mid, quote.natural, quote.lag_s];
    if (!numbers.every((v) => Number.isFinite(v)) || (quote.side !== "debit" && quote.side !== "credit")) return false;
    if (!this.has(messageId)) return false;
    const info = this.db
      .prepare("INSERT OR IGNORE INTO follow_quotes (at, message_id, side, leader, mid, natural, lag_s, paper) VALUES (?,?,?,?,?,?,?,?)")
      .run(at, messageId, quote.side, quote.leader, quote.mid, quote.natural, quote.lag_s, quote.paper ? 1 : 0);
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
        "SELECT l.at, l.message_id, l.author_id, l.author_name, l.text, l.outcome, l.detail, l.summary, l.record_ids," +
        " q.side AS q_side, q.leader AS q_leader, q.mid AS q_mid, q.natural AS q_natural, q.lag_s AS q_lag_s, q.paper AS q_paper" +
        " FROM follow_log l LEFT JOIN follow_quotes q ON q.message_id = l.message_id ORDER BY l.seq DESC LIMIT ?",
      )
      .all(limit) as FollowRow[];
    return rows.flatMap((r) => {
      if (!OUTCOMES.has(r.outcome as FollowOutcome)) return [];
      const entry: FollowEntry = {
        at: r.at, message_id: r.message_id, author_id: r.author_id, author_name: r.author_name, text: r.text,
        outcome: r.outcome as FollowOutcome, detail: r.detail, summary: r.summary, record_ids: recordIds(r.record_ids),
      };
      const quote = quoteOf(r);
      // 没取到报价的那些条不带这个键:和加这张表之前读出来的一字不差
      if (quote !== null) entry.quote = quote;
      return [entry];
    });
  }
}

function quoteOf(r: FollowRow): FollowQuote | null {
  if (r.q_side !== "debit" && r.q_side !== "credit") return null;
  if (r.q_leader === null || r.q_mid === null || r.q_natural === null || r.q_lag_s === null) return null;
  return { side: r.q_side, leader: r.q_leader, mid: r.q_mid, natural: r.q_natural, lag_s: r.q_lag_s, paper: r.q_paper === 1 };
}

function recordIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
