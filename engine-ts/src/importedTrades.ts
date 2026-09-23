/**
 * 从外部导出补进来的交易数据,以及为它们算的上下文:只增不改,按键去重。
 *
 * 三张表,都不进 `broker_fills`(那张表只放券商原样的成交行,交易分析页拿它合成蝴蝶):
 *  · imported_option_trades —— 按结构整理的成交导出(没有行权价,结构按同一秒成交推断);
 *  · option_positions       —— Flex 导出按行权价配好的期权仓位,一行 = 一个仓位的完整生命周期(开仓结构、了结方式、盈亏);
 *  · trade_entry_context    —— 历史交易开仓那一刻的标的价(下单页「历史相似交易」比中心离现价用),取一次就存下。
 * 同一段时间两份期权数据都在时,以 option_positions 为准(见 tradeOutcomes / services/tradeHistory)。
 *
 * 表与读写从 store.ts 拆出来(store.ts 快到 1,500 行的预算线),共用 TradeStore 的同一个连接:`store.imports`。
 */
import type Database from "better-sqlite3";

import { utcIso } from "./tz.js";

/** imported_option_trades 的一行(导入时由 optionTradesCsv 整理好)。 */
export interface ImportedOptionTrade {
  account_id: string;
  /** 文件里同一个结构动作的稳定键:时间 + 标的 + 动作 + 订单号 */
  id: string;
  time_et: string;
  date_et: string;
  symbol: string;
  structure: string;
  action: string;
  direction: string;
  /** 结构的份数;拆不开的(多个仓位同时结算、两腿同向……)导出里是空的,就是 null */
  qty: number | null;
  net_price: number | null;
  realized_pnl: number;
  commission: number;
  legs: string;
  note: string;
  source: string;
}

/** option_positions 的一行(导入时由 optionPositionsCsv 整理好)。时间都是美东墙钟 "YYYY-MM-DD HH:MM:SS"。 */
export interface OptionPosition {
  account_id: string;
  /** 稳定键:开仓时间 + 标的 + 开仓各腿 */
  id: string;
  open_et: string;
  symbol: string;
  /** 蝴蝶 / 垂直价差 / 单腿 / 破翼/比例蝴蝶 / 日历/对角 / 秃鹰(condor) / 跨式/宽跨 */
  structure: string;
  /** 买方 / 借方看涨 / 贷方看空 / 买入 …;可以是空 */
  direction: string;
  qty: number | null;
  /** YYYYMMDD */
  expiry: string;
  /** 开仓时距到期(天) */
  dte: number | null;
  /** P / C / CP */
  right: string;
  /** "7410/7425/7440" */
  strikes: string;
  center: number | null;
  width: number | null;
  /** "1:2:1" / "1:3:2" / "" */
  ratio: string;
  /** 每份结构的开仓净价(点,正 = 付) */
  net_price: number | null;
  /** "B1 C7410,S2 C7425,B1 C7440" */
  legs: string;
  /** 整体平仓 / 平仓 / 持有到期 / 拆腿后到期 / 逐腿/拆腿平仓 / 持仓中 */
  exit: string;
  /** 已了结 / 持仓中 */
  status: string;
  /** 最后了结时间;持仓中是空串 */
  closed_et: string;
  hold_min: number | null;
  /** 已实现盈亏,已扣佣金(Flex 的 FifoPnlRealized 按腿分回仓位) */
  realized_pnl: number;
  commission: number;
  source: string;
}

const SCHEMA = `
-- 导入的期权交易(按结构整理的成交导出,一行 = 一个结构的一次动作)。没有行权价 / 到期日,拼不出合约,
-- 所以不进 broker_fills;只增不改,按 (account_id, id) 去重。有了 option_positions 的那段时间就不再用
CREATE TABLE IF NOT EXISTS imported_option_trades (
    account_id   TEXT NOT NULL,
    id           TEXT NOT NULL,
    time_et      TEXT NOT NULL,
    date_et      TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    structure    TEXT NOT NULL,
    action       TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT '',
    qty          REAL,
    net_price    REAL,
    realized_pnl REAL NOT NULL,
    commission   REAL NOT NULL DEFAULT 0,
    legs         TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT '',
    imported_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

-- Flex 导出按行权价配好的期权仓位(开仓结构 + 了结方式 + 盈亏),只增不改
CREATE TABLE IF NOT EXISTS option_positions (
    account_id   TEXT NOT NULL,
    id           TEXT NOT NULL,
    open_et      TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    structure    TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT '',
    qty          REAL,
    expiry       TEXT NOT NULL DEFAULT '',
    dte          REAL,
    right        TEXT NOT NULL DEFAULT '',
    strikes      TEXT NOT NULL DEFAULT '',
    center       REAL,
    width        REAL,
    ratio        TEXT NOT NULL DEFAULT '',
    net_price    REAL,
    legs         TEXT NOT NULL DEFAULT '',
    exit         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT '',
    closed_et    TEXT NOT NULL DEFAULT '',
    hold_min     REAL,
    realized_pnl REAL NOT NULL,
    commission   REAL NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT '',
    imported_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

-- 历史交易开仓那一刻的标的价(下单页「历史相似交易」比蝴蝶中心离现价几个翼宽用)。取一次就存下,
-- 历史不会变;取的时候标的在哪一分钟、从哪来(source)都留着
CREATE TABLE IF NOT EXISTS trade_entry_context (
    trade_id   TEXT PRIMARY KEY,
    symbol     TEXT NOT NULL,
    at         TEXT NOT NULL,
    underlying REAL NOT NULL,
    source     TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL
);
`;

function nowIso(): string {
  return utcIso(Date.now() - (Date.now() % 1000)); // 同 store.nowIso:到秒,+00:00
}

export class ImportedTradesStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  // ---- 按结构整理的期权交易 --------------------------------------------
  /** 只增不改,已有的 (account_id, id) 不动。返回新增条数。 */
  rememberOptionTrades(rows: readonly ImportedOptionTrade[]): number {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO imported_option_trades (account_id, id, time_et, date_et, symbol, structure, action," +
      " direction, qty, net_price, realized_pnl, commission, legs, note, source, imported_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const at = nowIso();
    let added = 0;
    for (const r of rows) {
      added += Number(stmt.run(
        r.account_id, r.id, r.time_et, r.date_et, r.symbol, r.structure, r.action, r.direction, r.qty,
        r.net_price, r.realized_pnl, r.commission, r.legs, r.note, r.source, at,
      ).changes ?? 0);
    }
    return added;
  }

  listOptionTrades(): ImportedOptionTrade[] {
    return this.db
      .prepare(
        "SELECT account_id, id, time_et, date_et, symbol, structure, action, direction, qty, net_price, realized_pnl," +
        " commission, legs, note, source FROM imported_option_trades ORDER BY time_et ASC, id ASC",
      )
      .all() as ImportedOptionTrade[]; // 库的边界:列就是接口的字段
  }

  // ---- Flex 期权仓位 ----------------------------------------------------
  rememberOptionPositions(rows: readonly OptionPosition[]): number {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO option_positions (account_id, id, open_et, symbol, structure, direction, qty, expiry, dte," +
      " right, strikes, center, width, ratio, net_price, legs, exit, status, closed_et, hold_min, realized_pnl, commission," +
      " source, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const at = nowIso();
    let added = 0;
    for (const r of rows) {
      added += Number(stmt.run(
        r.account_id, r.id, r.open_et, r.symbol, r.structure, r.direction, r.qty, r.expiry, r.dte, r.right, r.strikes,
        r.center, r.width, r.ratio, r.net_price, r.legs, r.exit, r.status, r.closed_et, r.hold_min, r.realized_pnl,
        r.commission, r.source, at,
      ).changes ?? 0);
    }
    return added;
  }

  listOptionPositions(): OptionPosition[] {
    return this.db
      .prepare(
        "SELECT account_id, id, open_et, symbol, structure, direction, qty, expiry, dte, right, strikes, center, width," +
        " ratio, net_price, legs, exit, status, closed_et, hold_min, realized_pnl, commission, source" +
        " FROM option_positions ORDER BY open_et ASC, id ASC",
      )
      .all() as OptionPosition[]; // 库的边界:列就是接口的字段
  }

  // ---- 开仓时标的价 -----------------------------------------------------
  /** 已存下的开仓时标的价:trade_id → 价。 */
  entryUnderlyings(tradeIds: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    const stmt = this.db.prepare("SELECT underlying FROM trade_entry_context WHERE trade_id=?");
    for (const id of tradeIds) {
      const row = stmt.get(id) as { underlying: number } | undefined;
      if (row !== undefined) out.set(id, row.underlying);
    }
    return out;
  }

  rememberEntryUnderlying(tradeId: string, symbol: string, at: string, underlying: number, source: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO trade_entry_context (trade_id, symbol, at, underlying, source, fetched_at) VALUES (?,?,?,?,?,?)",
      )
      .run(tradeId, symbol, at, underlying, source, nowIso());
  }
}
