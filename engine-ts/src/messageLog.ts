/** 消息底账(docs/features/intel.md):信任名单里的人在频道里说的每一句落一行,只增不改——跟单日志只记"像单子的",这里记全部。
 * 不信任的人说的不进这里(隐私说明:频道里其他人的消息只在内存里留最近 30 条)。
 *
 * 一条消息记的是:谁、几点、说了什么、认出了哪几只标的(symbols)、像代码但名单里没有的词(guesses)、发送者在不在信任名单里、
 * 提到那一刻各标的的价(取得到的那几只)。消息 ID 唯一,重连补发、引擎重启都不会记第二次。
 * 认标的是写入那一刻按当时的名单认的;名单之后变了(新开了仓)也不回头改——底账只说当时看到了什么。
 */
import type Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    source      TEXT NOT NULL,
    message_id  TEXT NOT NULL UNIQUE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    symbols     TEXT NOT NULL DEFAULT '[]',
    guesses     TEXT NOT NULL DEFAULT '[]',
    trusted     INTEGER NOT NULL DEFAULT 0,
    prices      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS message_log_at ON message_log(at);
CREATE TRIGGER IF NOT EXISTS message_log_no_update
BEFORE UPDATE ON message_log
BEGIN SELECT RAISE(ABORT, 'message_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS message_log_no_delete
BEFORE DELETE ON message_log
BEGIN SELECT RAISE(ABORT, 'message_log is append-only'); END;
`;

/** 原文留多长:够看清整句单子与前后几句评论,不把整段长文存下来。 */
export const MESSAGE_TEXT_MAX = 300;

export interface MessageRow {
  seq: number;
  /** ISO 8601(UTC) */
  at: string;
  source: "discord" | "local";
  message_id: string;
  author_id: string;
  author_name: string;
  text: string;
  symbols: string[];
  guesses: string[];
  trusted: boolean;
  /** 提到那一刻的价:标的 → 价 */
  prices: Record<string, number>;
}

export type MessageInput = Omit<MessageRow, "seq">;

interface RawRow {
  seq: number;
  at: string;
  source: string;
  message_id: string;
  author_id: string;
  author_name: string;
  text: string;
  symbols: string;
  guesses: string;
  trusted: number;
  prices: string;
}

const COLUMNS = "seq, at, source, message_id, author_id, author_name, text, symbols, guesses, trusted, prices";

function strings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function numbers(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function rowOf(r: RawRow): MessageRow {
  return {
    seq: r.seq, at: r.at, source: r.source === "local" ? "local" : "discord", message_id: r.message_id, author_id: r.author_id,
    author_name: r.author_name, text: r.text, symbols: strings(r.symbols), guesses: strings(r.guesses), trusted: r.trusted === 1,
    prices: numbers(r.prices),
  };
}

/** 按标的筛:symbols 列是 JSON 数组,代码带着引号整个出现,LIKE 不会把 NVDA 当成 NVDAX。 */
const symbolLike = (symbol: string): string => `%"${symbol.toUpperCase().replace(/[%_"]/g, "")}"%`;

export class MessageLogStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  has(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM message_log WHERE message_id = ?").get(messageId) !== undefined;
  }

  /** 落一行;同一条消息已经有了就不落,返回 false。 */
  add(entry: MessageInput): boolean {
    const symbols = [...new Set(entry.symbols.map((s) => s.toUpperCase()))];
    const guesses = [...new Set(entry.guesses.map((s) => s.toUpperCase()))].filter((s) => !symbols.includes(s));
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO message_log (at, source, message_id, author_id, author_name, text, symbols, guesses, trusted, prices)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.at, entry.source, entry.message_id, entry.author_id, entry.author_name.slice(0, 80), entry.text.slice(0, MESSAGE_TEXT_MAX),
        JSON.stringify(symbols), JSON.stringify(guesses), entry.trusted ? 1 : 0, JSON.stringify(entry.prices ?? {}),
      );
    return info.changes > 0;
  }

  /** 最近的几条,新的在前。symbol 给了就只要提到它的;since(ISO)给了就只要之后的。 */
  recent(opts: { limit?: number; symbol?: string | null; since?: string | null } = {}): MessageRow[] {
    const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 200)));
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.symbol) {
      where.push("symbols LIKE ?");
      args.push(symbolLike(opts.symbol));
    }
    if (opts.since) {
      where.push("at >= ?");
      args.push(opts.since);
    }
    const sql = `SELECT ${COLUMNS} FROM message_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as RawRow[]).map(rowOf);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM message_log").get() as { n: number };
    return Number(row.n) || 0;
  }

  /** since(ISO)之后提到某只标的的消息有几条;不给 symbol 就是全部。 */
  countSince(since: string, symbol: string | null = null): number {
    const row = (symbol
      ? this.db.prepare("SELECT COUNT(*) AS n FROM message_log WHERE at >= ? AND symbols LIKE ?").get(since, symbolLike(symbol))
      : this.db.prepare("SELECT COUNT(*) AS n FROM message_log WHERE at >= ?").get(since)) as { n: number };
    return Number(row.n) || 0;
  }
}
