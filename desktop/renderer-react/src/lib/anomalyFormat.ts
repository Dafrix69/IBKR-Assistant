/**
 * 异动与股票池行里那几种数字 / 时间的写法。原来住在 pages/Quality.tsx 里,
 * 那一页并进板块页之后由页面和 lib/ 下的几个子组件共用,搬到这里,口径只有一份。
 */
import type { AnomalyEvent, QualityStock } from '../bridge';

/** 价格:一块钱以上两位小数;仙股给到四位,不然 0.0042 会显示成 0.00。 */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 1 ? 2 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function fmtSigned(v: number, digits = 2): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 事件时间:今天只写时分秒;不是今天的带上月-日——落库的事件跨了日,只写时分会让人以为是刚才。 */
export function fmtWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const now = new Date();
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toMs(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function lastEvent(stock: QualityStock): AnomalyEvent | null {
  let best: AnomalyEvent | null = null;
  for (const e of stock.events || []) if (!best || (Number(e.at) || 0) >= (Number(best.at) || 0)) best = e;
  return best;
}

/** 行里已经有代码了:事件标题去掉打头的代码,只留"放量 3.1×"。 */
export function shortTitle(e: AnomalyEvent, symbol: string): string {
  return e.title.startsWith(`${symbol} `) ? e.title.slice(symbol.length + 1) : e.title;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
