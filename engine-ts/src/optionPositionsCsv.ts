/**
 * 期权仓位导入:Flex 导出按行权价配好的仓位表(option_positions.csv,一行 = 一个期权仓位的完整生命周期)
 * → `option_positions` 的行。
 *
 * 这份表由导出方从 Flex 逐腿成交(Trades 执行级 + 到期记账)配出来:开仓腿按同一标的同一秒成一个仓位,平仓腿按合约先进先出
 * 分回仓位,盈亏与佣金按数量分摊,合计与 Flex 的 FifoPnlRealized 一致。结构(蝴蝶 / 垂直……)是**按行权价认的**,
 * 了结方式分整体平仓 / 持有到期 / 拆腿后到期 / 逐腿平仓——比按结构整理的那份(optionTradesCsv)准,同一段时间以它为准。
 * 纯函数,不碰库。表头是中文,照原样认。
 */
import type { OptionPosition } from "./importedTrades.js";
import { parseCsv } from "./optionTradesCsv.js";

/** 必需的列(表头原文) */
export const POSITION_COLUMNS = {
  open: "开仓时间(美东)",
  symbol: "标的",
  structure: "结构",
  direction: "方向",
  qty: "份数",
  expiry: "到期日",
  dte: "开仓时距到期(天)",
  right: "C/P",
  strikes: "行权价",
  center: "蝴蝶中心",
  width: "翼宽",
  ratio: "比例",
  netPrice: "开仓净价(点,正=付)",
  legs: "开仓各腿",
  exit: "退出方式",
  status: "状态",
  closed: "最后了结时间(美东)",
  holdMin: "持有分钟",
  pnl: "已实现盈亏(已扣佣金)",
  commission: "佣金",
} as const;

type Key = keyof typeof POSITION_COLUMNS;

export class OptionPositionsCsvError extends Error {}

export interface OptionPositionsImport {
  rows: OptionPosition[];
  skipped: Record<string, number>;
  first: string | null;
  last: string | null;
}

const ET_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function finite(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** 解析 option_positions.csv。`accountId` 由调用方指明(导出里删掉了账户号),`source` 记是哪个文件。 */
export function parseOptionPositionsCsv(text: string, accountId: string, source: string): OptionPositionsImport {
  const [header = [], ...lines] = parseCsv(text.replace(/^\uFEFF/, ""));
  const names = header.map((h) => h.trim());
  const at = new Map<Key, number>();
  for (const [key, col] of Object.entries(POSITION_COLUMNS) as Array<[Key, string]>) {
    const i = names.indexOf(col);
    if (i < 0) throw new OptionPositionsCsvError(`option_positions.csv 缺少列:${col}`);
    at.set(key, i);
  }
  const get = (cells: string[], key: Key): string => (cells[at.get(key) ?? -1] ?? "").trim();

  const rows: OptionPosition[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const cells of lines) {
    if (cells.length !== header.length) { bump(skipped, "列数不对"); continue; }
    const open = get(cells, "open");
    const symbol = get(cells, "symbol").toUpperCase();
    const pnl = finite(get(cells, "pnl"));
    const closed = get(cells, "closed");
    if (!ET_TIME.test(open) || !symbol || pnl === null || (closed !== "" && !ET_TIME.test(closed))) {
      bump(skipped, "字段不全或不合法"); continue;
    }
    const legs = get(cells, "legs");
    const id = `pos:${open}|${symbol}|${legs}`;
    if (seen.has(id)) { bump(skipped, "文件内重复"); continue; }
    seen.add(id);
    rows.push({
      account_id: accountId,
      id,
      open_et: open,
      symbol,
      structure: get(cells, "structure"),
      direction: get(cells, "direction"),
      qty: finite(get(cells, "qty")),
      expiry: get(cells, "expiry"),
      dte: finite(get(cells, "dte")),
      right: get(cells, "right").toUpperCase(),
      strikes: get(cells, "strikes"),
      center: finite(get(cells, "center")),
      width: finite(get(cells, "width")),
      ratio: get(cells, "ratio"),
      net_price: finite(get(cells, "netPrice")),
      legs,
      exit: get(cells, "exit"),
      status: get(cells, "status"),
      closed_et: closed,
      hold_min: finite(get(cells, "holdMin")),
      realized_pnl: pnl,
      commission: finite(get(cells, "commission")) ?? 0,
      source,
    });
  }
  const times = rows.map((r) => r.open_et).sort();
  return { rows, skipped, first: times[0] ?? null, last: times[times.length - 1] ?? null };
}
