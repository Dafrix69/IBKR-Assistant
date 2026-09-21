/** 扫描页那张表背后的纯逻辑:行的类型、把 RS 与背离合成一行、排序、单元格着色、数字格式。
 *
 * 2026-09-21 从 pages/Screener.tsx 搬出来(函数体逐字未改)。这一层不认识 React,
 * 只把两路结果拼成表里的行——口径(CD 背离 = MACD 快线 DIF、业务标签在成分股上)在 docs/features 里。
 */
import type { InflectionResult, InflectionRow, RsResult, RsRow } from '../bridge';

/** K 线周期的中文名。表头、周期选择、状态行都用这一份,别各写各的 */
export const TF_LABEL: Record<string, string> = { '1w': '周线', '1d': '日线', '1h': '1 小时', '30m': '30 分', '15m': '15 分' };
export const TF_OPTIONS = Object.entries(TF_LABEL).map(([value, label]) => ({ value, label }));

export function num(v: unknown, digits = 2, sign = false): string {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  const text = n.toFixed(digits);
  return sign && n > 0 ? `+${text}` : text;
}

function heat(v: number): string {
  return String(Math.min(40, Math.abs(v) * 1.6).toFixed(0));
}

/** RS 单元格:正绿负红,越大底色越深(--heat 由 styles.css 折成透明度) */
export function rsCellProps(value: number | null | undefined) {
  if (value == null) return { className: 'rs-cell dim' };
  return { className: `rs-cell ${value >= 0 ? 'pos' : 'neg'}`, style: { ['--heat' as string]: heat(value) } };
}

export interface PoolStock {
  symbol: string;
  company?: string;
}

/** 背离那边还没回来时的占位:表里先把这几列占住(格子里是「…」),免得 RS 出来后表再跳一次宽度。 */
export type InflPending = { pending: true; timeframes: string[] };
export type InflState = InflectionResult | InflPending | null;
export const isPending = (x: InflState): x is InflPending => x !== null && "pending" in x;

/** 表格里的一行:RS 那一行打底(契约的 RsRow),拐点筛选里同一只的那一行并进来。 */
export type ScanRow = Omit<RsRow, "company"> & {
  /** 拐点筛选里这只股的那一行;没扫背离(或还没回来)就没有 */
  infl?: InflectionRow;
};

export interface SortState {
  key: string;
  order: 'ascend' | 'descend';
}

/** RS 的行打底(引擎已按综合分排好),背离按标的并进来;只有背离那边有的股接在后面。 */
export function mergeRows(rs: RsResult | null, infl: InflState): ScanRow[] {
  const bySymbol = new Map<string, ScanRow>();
  for (const r of rs?.rows || []) bySymbol.set(r.symbol, { ...r });
  for (const r of (isPending(infl) ? [] : infl?.rows) || []) {
    const base = bySymbol.get(r.symbol);
    if (base) base.infl = r;
    else bySymbol.set(r.symbol, { symbol: r.symbol, tag: r.tag, last: null, bars: 0, error: null, rank: null, score: null, rs: {}, infl: r });
  }
  return [...bySymbol.values()];
}

export function sortValue(row: ScanRow, key: string): number | null {
  if (key === 'score') return row.score;
  // 命中相同的,已确认的排前面(和引擎原来给拐点表排的顺序一致)
  if (key === 'hits') return row.infl ? row.infl.hits * 100 + (row.infl.confirmed || 0) : null;
  const cell = row.rs?.[key.slice(1)];
  return cell ? cell.rs_pct : null;
}

/** 没数的行不管升序降序都沉底;排序是稳定的,并列的保持综合分的先后。 */
export function sortRows(rows: ScanRow[], sort: SortState | null): ScanRow[] {
  if (!sort) return rows;
  const dir = sort.order === 'ascend' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return (va - vb) * dir;
  });
}

export const CONFIRM_LABEL: Record<string, string> = { confirmed: '已确认', waiting: '等确认', failed: '作废', 'n/a': '无均线' };
