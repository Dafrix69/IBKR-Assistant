/**
 * 信号日志(docs/features/signal-scorecard.md):价位提醒、盯异动、强势股新入选、K线 PA 的方向,每发出一条落一行,只增不改。
 * 成绩在读的时候现算(signalOutcomes.ts),这里不存——之后的行情每天都在变,存下来的成绩第二天就旧了。
 */
import type Database from "better-sqlite3";

import type { SignalEntry, SignalSource } from "./contract/signals.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signal_log (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    source  TEXT NOT NULL,
    symbol  TEXT NOT NULL,
    expect  TEXT,
    price   REAL,
    label   TEXT NOT NULL DEFAULT '',
    variant TEXT
);
CREATE INDEX IF NOT EXISTS signal_log_at ON signal_log(at);
CREATE TRIGGER IF NOT EXISTS signal_log_no_update
BEFORE UPDATE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS signal_log_no_delete
BEFORE DELETE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
`;

const SOURCES = new Set<SignalSource>(["cross", "touch", "spike", "day_move", "rvol", "burst", "leaders", "pa"]);

const INSERT = "INSERT INTO signal_log (at, source, symbol, expect, price, label, variant) VALUES (?,?,?,?,?,?,?)";
const COLUMNS = "at, source, symbol, expect, price, label, variant";

interface SignalRow {
  at: string;
  source: string;
  symbol: string;
  expect: string | null;
  price: number | null;
  label: string;
  variant: string | null;
}

function values(e: SignalEntry): [string, string, string, string | null, number | null, string, string | null] {
  return [
    e.at, e.source, e.symbol.toUpperCase(), e.expect,
    e.price !== null && Number.isFinite(e.price) ? e.price : null, e.label.slice(0, 200), e.variant ?? null,
  ];
}

export class SignalLogStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    // 小类这一列是后加的:老库补上,老行是 NULL(= 没有分小类),照常打分
    const cols = (db.pragma("table_info(signal_log)") as Array<{ name: string }>).map((r) => r.name);
    if (!cols.includes("variant")) db.exec("ALTER TABLE signal_log ADD COLUMN variant TEXT");
  }

  /** 一轮发出的几条一起落。价取不到的存 null,不编。 */
  log(entries: readonly SignalEntry[]): void {
    if (!entries.length) return;
    const stmt = this.db.prepare(INSERT);
    const tx = this.db.transaction((rows: readonly SignalEntry[]) => {
      for (const e of rows) stmt.run(...values(e));
    });
    tx(entries);
  }

  /**
   * 同一件事只记一次的那种信号(强势股新入选、K线 PA 的方向):`since`(ISO)之后,同一个来源 + 标的 + 押的方向 + 小类
   * 已经记过的不再记。`since` 由调用方定:强势股是那根日线那天的零点,K线 PA 是上一个收盘(见 signalOutcomes.ts)。
   * 查与写在同一个事务里;返回这次真落了几条。
   */
  logOnce(entries: readonly SignalEntry[], since: string): number {
    if (!entries.length) return 0;
    const seen = this.db.prepare(
      "SELECT 1 FROM signal_log WHERE at >= ? AND source = ? AND symbol = ? AND expect IS ? AND variant IS ? LIMIT 1",
    );
    const stmt = this.db.prepare(INSERT);
    const tx = this.db.transaction((rows: readonly SignalEntry[]): number => {
      let written = 0;
      for (const e of rows) {
        const v = values(e);
        if (seen.get(since, v[1], v[2], v[3], v[6]) !== undefined) continue;
        stmt.run(...v);
        written += 1;
      }
      return written;
    });
    return tx(entries);
  }

  /** `since`(ISO)之后的,从早到晚;超过 `limit` 条时留最新的那些。不认识的来源(更新的版本写的 / 手改过的库)跳过。 */
  list(since: string | null = null, limit = 20_000): SignalEntry[] {
    const rows = (since === null
      ? this.db.prepare(`SELECT ${COLUMNS} FROM signal_log ORDER BY seq DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT ${COLUMNS} FROM signal_log WHERE at >= ? ORDER BY seq DESC LIMIT ?`).all(since, limit)
    ) as SignalRow[];
    rows.reverse();
    return rows.flatMap((r) => (SOURCES.has(r.source as SignalSource)
      ? [{
        at: r.at, source: r.source as SignalSource, symbol: r.symbol,
        expect: r.expect === "up" || r.expect === "down" ? r.expect : null,
        price: r.price, label: r.label, variant: r.variant,
      }]
      : []));
  }
}
