/**
 * 期权交易导入:按结构整理的成交导出(trades.csv,一行 = 一个结构的一次动作)→ `imported_option_trades` 的行。
 *
 * 这份导出来自 IBKR 账户成交接口,**没有行权价、到期日、看涨看跌**;腿是按「同一标的、同一秒成交」合成结构的,
 * 结构名(蝴蝶 / 垂直 / 单腿……)是推断。所以它不进 `broker_fills`、也拼不出交易分析页那种蝴蝶——只拿来给知识总结
 * 提供每次出场的成败(IBKR 的已实现盈亏,已扣佣金,是准的)。纯函数,不碰库。
 */
import type { ImportedOptionTrade } from "./store.js";

export const OPTION_COLUMNS = [
  "time_et", "date_et", "symbol", "asset", "structure", "action", "direction", "qty", "net_price", "realized_pnl",
  "commission", "legs", "order_ids", "note",
] as const;

type Column = (typeof OPTION_COLUMNS)[number];

export class OptionTradesCsvError extends Error {}

export interface OptionTradesImport {
  rows: ImportedOptionTrade[];
  /** 没收的行:原因 → 条数 */
  skipped: Record<string, number>;
  first: string | null;
  last: string | null;
}

/** RFC 4180 的最小实现:逗号分隔,双引号包裹的字段里可以有逗号、换行,"" 是一个引号。 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); out.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((f) => f.trim() !== ""));
}

function finite(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** 解析 trades.csv,只留期权行。`accountId` 由调用方指明(导出里没有账户号),`source` 记是哪个文件。 */
export function parseOptionTradesCsv(text: string, accountId: string, source: string): OptionTradesImport {
  const [header = [], ...lines] = parseCsv(text.replace(/^\uFEFF/, ""));
  const at = new Map<Column, number>();
  for (const col of OPTION_COLUMNS) {
    const i = header.map((h) => h.trim()).indexOf(col);
    if (i < 0) throw new OptionTradesCsvError(`trades.csv 缺少列:${col}`);
    at.set(col, i);
  }
  const get = (cells: string[], col: Column): string => (cells[at.get(col) ?? -1] ?? "").trim();

  const rows: ImportedOptionTrade[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const cells of lines) {
    if (cells.length !== header.length) { bump(skipped, "列数不对"); continue; }
    if (get(cells, "asset") !== "期权") { bump(skipped, "不是期权(股票走 import-fills)"); continue; }
    const timeEt = get(cells, "time_et");
    const dateEt = get(cells, "date_et");
    const symbol = get(cells, "symbol").toUpperCase();
    const action = get(cells, "action");
    // 份数可以是空的:拆不开的结构(多个仓位同时结算、两腿同向)导出里就没写,盈亏照样是真的
    const qtyRaw = get(cells, "qty");
    const qty = finite(qtyRaw);
    const pnl = finite(get(cells, "realized_pnl"));
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeEt) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEt) || !symbol
      || !action || (qtyRaw !== "" && (qty === null || qty <= 0)) || pnl === null) {
      bump(skipped, "字段不全或不合法"); continue;
    }
    const id = `opt:${timeEt}|${symbol}|${action}|${get(cells, "order_ids")}`;
    if (seen.has(id)) { bump(skipped, "文件内重复"); continue; }
    seen.add(id);
    rows.push({
      account_id: accountId,
      id,
      time_et: timeEt,
      date_et: dateEt,
      symbol,
      structure: get(cells, "structure"),
      action,
      direction: get(cells, "direction"),
      qty,
      net_price: finite(get(cells, "net_price")),
      realized_pnl: pnl,
      commission: finite(get(cells, "commission")) ?? 0,
      legs: get(cells, "legs"),
      note: get(cells, "note"),
      source,
    });
  }
  const times = rows.map((r) => r.time_et).sort();
  return { rows, skipped, first: times[0] ?? null, last: times[times.length - 1] ?? null };
}
