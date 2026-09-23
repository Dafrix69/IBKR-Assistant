/**
 * 历史成交导入:IBKR 账户成交导出(fills.csv)→ `broker_fills` 的行,形状与 `broker.fillRow` 一致。
 *
 * TWS 的接口只给当天的成交,库里的历史靠一天天攒(tradereview.md);这里补的是**攒之前**的那一段。
 * 纯函数,不碰库:CLI 读文件、调这里、再交给 `store.rememberFills`(按 exec_id 去重,已有的行不动)。
 *
 * **只收股票。** 这份导出的期权行没有行权价、到期日、看涨看跌——拼不出蝴蝶;更要紧的是,不完整的行一旦进了库,
 * 以后带合约描述的导出(Flex Query)会因为 exec_id 相同被静默忽略,残缺的那份就永远留着了。期权等 Flex。
 * 换汇(CASH)不是交易,也不收。
 */

/** fills.csv 的一行(字段名即表头)。 */
export interface CsvFill {
  trade_time_utc: string;
  symbol: string;
  sec_type: string;
  currency: string;
  side: string;
  size: string;
  price: string;
  exchange: string;
  commission: string;
  order_id: string;
  trade_id: string;
}

/** 写进 broker_fills 的一行:`broker.fillRow` 的形状,拿不到的字段按它的空值写。 */
export type ImportedFill = {
  exec_id: string;
  time: string;
  account_id: string;
  side: "BOT" | "SLD";
  shares: number;
  price: number;
  order_id: null;
  perm_id: number | null;
  order_ref: string;
  commission: number | null;
  contract: {
    secType: "STK";
    symbol: string;
    expiry: string;
    strike: null;
    right: string;
    tradingClass: string;
    multiplier: string;
    conId: null;
    currency: string;
    exchange: string;
  };
};

export interface CsvImport {
  fills: ImportedFill[];
  /** 没收的行:原因 → 条数 */
  skipped: Record<string, number>;
  /** 收下的行覆盖的时间(UTC ISO),没有行时为 null */
  first: string | null;
  last: string | null;
}

export const REQUIRED_COLUMNS: readonly (keyof CsvFill)[] = [
  "trade_time_utc", "symbol", "sec_type", "currency", "side", "size", "price", "exchange", "commission",
  "order_id", "trade_id",
];

export class FillsCsvError extends Error {}

/** "2025-10-31T09:13:36Z" → "2025-10-31T09:13:36+00:00"(库里成交行的时间写法,同 utcIso) */
function isoUtc(raw: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$/.exec(raw.trim());
  return m ? `${m[1]}T${m[2]}+00:00` : null;
}

function finite(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 表头 → 字段下标;缺必需的列直接报,别让一份格式不对的文件半对半错地进库。 */
function columnIndex(header: string[]): Map<keyof CsvFill, number> {
  const at = new Map<keyof CsvFill, number>();
  for (const col of REQUIRED_COLUMNS) {
    const i = header.indexOf(col);
    if (i < 0) throw new FillsCsvError(`fills.csv 缺少列:${col}`);
    at.set(col, i);
  }
  return at;
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/**
 * 解析 fills.csv。`accountId` 是这份导出所属的账户(导出里没有账户号,由调用方指明)。
 * 字段里不会有逗号(代码、交易所、数字、ISO 时间),所以按逗号切;列数不对的行记进 skipped,不猜。
 */
export function parseFillsCsv(text: string, accountId: string): CsvImport {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const at = columnIndex(header);
  const get = (cells: string[], col: keyof CsvFill): string => (cells[at.get(col) ?? -1] ?? "").trim();

  const fills: ImportedFill[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length !== header.length) { bump(skipped, "列数不对"); continue; }
    const secType = get(cells, "sec_type").toUpperCase();
    if (secType === "OPT") { bump(skipped, "期权(没有合约描述,等 Flex 导出)"); continue; }
    if (secType !== "STK") { bump(skipped, `不是股票(${secType || "空"})`); continue; }
    const execId = get(cells, "trade_id");
    const time = isoUtc(get(cells, "trade_time_utc"));
    const shares = finite(get(cells, "size"));
    const price = finite(get(cells, "price"));
    const side = get(cells, "side").toUpperCase();
    if (!execId || time === null || shares === null || shares <= 0 || price === null || price <= 0
      || (side !== "BUY" && side !== "SELL")) {
      bump(skipped, "字段不全或不合法"); continue;
    }
    if (seen.has(execId)) { bump(skipped, "文件内重复"); continue; }
    seen.add(execId);
    const perm = Math.trunc(Number(get(cells, "order_id")));
    fills.push({
      exec_id: execId,
      time,
      account_id: accountId,
      side: side === "BUY" ? "BOT" : "SLD",
      shares,
      price,
      order_id: null,
      perm_id: Number.isFinite(perm) && perm > 0 ? perm : null,
      order_ref: "",
      commission: finite(get(cells, "commission")),
      contract: {
        secType: "STK",
        symbol: get(cells, "symbol").toUpperCase(),
        expiry: "",
        strike: null,
        right: "",
        tradingClass: "",
        multiplier: "",
        conId: null,
        currency: get(cells, "currency").toUpperCase() || "USD",
        exchange: get(cells, "exchange"),
      },
    });
  }
  const times = fills.map((f) => f.time).sort();
  return { fills, skipped, first: times[0] ?? null, last: times[times.length - 1] ?? null };
}
