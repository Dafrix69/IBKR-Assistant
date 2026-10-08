/**
 * 标的止损价在界面上的三句话:卡片上那一条摘要、盯盘时"离线还有多远"、确认框里的那一行。
 *
 * 单独放成一个**不 import 任何东西、不碰 DOM 的纯模块**,引擎那套 vitest 直接跑它(desktop-spot-stop-format.spec)。
 * 判定在引擎(trackerSpotStop.ts),这里只管怎么说;口径见 docs/features/tracker.md「标的止损价」。
 */

/** 引擎每一轮给的那一份(契约里的 SpotStop)里这里用到的字段 */
export interface SpotStopView {
  below: number | null;
  above: number | null;
  /** 标的现价;这一轮拿不到是 null */
  spot: number | null;
  spot_note?: string;
  reason?: string;
}

/** 价位照人填的样子写:7700 不写成 7700.00,7790.5 不丢掉那半点 */
const level = (v: number): string => String(Number(Number(v).toFixed(2)));

function lines(below: number | null | undefined, above: number | null | undefined): string[] {
  const out: string[] = [];
  if (below != null) out.push(`跌到 ${level(below)}`);
  if (above != null) out.push(`涨到 ${level(above)}`);
  return out;
}

/** 卡片上的摘要:「标的止损 跌到 7700 / 涨到 7790」;一条没设回空串 */
export function spotStopSummary(below: number | null | undefined, above: number | null | undefined): string {
  const set = lines(below, above);
  return set.length ? `标的止损 ${set.join(' / ')}` : '';
}

/** 盯盘那一行:标的现价、离每条线还差多少点。拿不到现价时照实说这一轮没判,不摆一个旧数 */
export function spotStopLine(symbol: string, row: SpotStopView): string {
  if (row.spot == null) return row.reason || `拿不到 ${symbol} 的现价,标的止损这一轮不判断`;
  const parts: string[] = [];
  if (row.below != null) parts.push(`跌到 ${level(row.below)} 就平(还差 ${(row.spot - row.below).toFixed(2)} 点)`);
  if (row.above != null) parts.push(`涨到 ${level(row.above)} 就平(还差 ${(row.above - row.spot).toFixed(2)} 点)`);
  return `标的止损:${symbol} 现价 ${row.spot.toFixed(2)},${parts.join(',')}${row.spot_note ? ` · ${row.spot_note}` : ''}`;
}

/** 确认框里的那一行(带换行);没设回空串。这条线会让软件自己发平仓单,所以要写在人点「确认」的那个框里 */
export function spotStopConfirmLine(symbol: string, below: number | null | undefined, above: number | null | undefined): string {
  const set = lines(below, above);
  if (!set.length) return '';
  return `标的止损:${symbol} ${set.join('、或')} 就平,记作止损。只看标的现价,不看这份持仓值多少;软件开着时按秒盯。\n`;
}
