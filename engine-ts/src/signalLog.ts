/**
 * 信号日志(docs/features/signal-scorecard.md):价位提醒与盯异动每发出一条,落一行,只增不改。
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
    label   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS signal_log_at ON signal_log(at);
CREATE TRIGGER IF NOT EXISTS signal_log_no_update
BEFORE UPDATE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS signal_log_no_delete
BEFORE DELETE ON signal_log
BEGIN SELECT RAISE(ABORT, 'signal_log is append-only'); END;
`;

const SOURCES = new Set<SignalSource>(["cross", "touch", "spike", "day_move", "rvol", "burst"]);

interface SignalRow {
  at: string;
  source: string;
  symbol: string;
  expect: string | null;
  price: number | null;
  label: string;
}

export class SignalLogStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /** 一轮发出的几条一起落。价取不到的存 null,不编。 */
  log(entries: readonly SignalEntry[]): void {
    if (!entries.length) return;
    const stmt = this.db.prepare("INSERT INTO signal_log (at, source, symbol, expect, price, label) VALUES (?,?,?,?,?,?)");
    const tx = this.db.transaction((rows: readonly SignalEntry[]) => {
      for (const e of rows) {
        stmt.run(e.at, e.source, e.symbol.toUpperCase(), e.expect, e.price !== null && Number.isFinite(e.price) ? e.price : null, e.label.slice(0, 200));
      }
    });
    tx(entries);
  }

  /** `since`(ISO)之后的,从早到晚;不认识的来源(老版本 / 手改过的库)跳过。 */
  list(since: string | null = null, limit = 20_000): SignalEntry[] {
    const rows = (since === null
      ? this.db.prepare("SELECT at, source, symbol, expect, price, label FROM signal_log ORDER BY seq LIMIT ?").all(limit)
      : this.db.prepare("SELECT at, source, symbol, expect, price, label FROM signal_log WHERE at >= ? ORDER BY seq LIMIT ?").all(since, limit)
    ) as SignalRow[];
    return rows.flatMap((r) => (SOURCES.has(r.source as SignalSource)
      ? [{
        at: r.at, source: r.source as SignalSource, symbol: r.symbol,
        expect: r.expect === "up" || r.expect === "down" ? r.expect : null,
        price: r.price, label: r.label,
      }]
      : []));
  }
}
