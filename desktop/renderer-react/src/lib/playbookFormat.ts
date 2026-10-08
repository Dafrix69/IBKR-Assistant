/**
 * SPX 日内剧本面板的纯函数:状态与事件怎么写成人话、离触发线还有多远。不碰引擎、不碰 DOM
 * (engine-ts/tests/desktop-playbook-format.spec.ts 直接跑它)。
 */
import type { PlaybookBand, PlaybookEvent, PlaybookSnapshot, PlaybookState } from '../bridge';

export const STATE_LABEL: Record<PlaybookState, string> = {
  B2: 'B2 上沿扩展',
  B3: 'B3 失守续探',
  R: '区间内',
  none: '线还不全',
};

export const STATE_HINT: Record<PlaybookState, string> = {
  B2: '现价站上了当前区间的上沿;跌回这条线下方就失效',
  B3: '现价跌破了昨日区间的下沿;收回这条线上方就失效',
  R: '现价在两条触发线之间,没有方向信号',
  none: '昨日区间与当前区间都还没有,判不了',
};

export function fmtLevel(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

/** 带正负号的点数差(目标 − 现价) */
export function fmtGap(target: number | null | undefined, price: number | null | undefined): string {
  if (typeof target !== 'number' || typeof price !== 'number') return '';
  const gap = target - price;
  return `${gap > 0 ? '+' : gap < 0 ? '−' : ''}${Math.abs(gap).toFixed(1)}`;
}

/** 美东的 HH:MM */
export function etTime(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number') return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(epochMs);
}

export function eventTone(event: PlaybookEvent): 'up' | 'down' {
  if (event.kind === 'accel') return event.price >= event.level ? 'up' : 'down';
  // 进 B2 与 B3 失效都是往上走;进 B3 与 B2 失效都是往下走
  return (event.state === 'B2') === (event.kind === 'enter') ? 'up' : 'down';
}

export function eventTitle(symbol: string, event: PlaybookEvent): string {
  const level = fmtLevel(event.level);
  if (event.kind === 'accel') return `${symbol} ${eventTone(event) === 'up' ? '上穿' : '下破'}加速档 ${event.level}`;
  if (event.kind === 'enter') {
    return event.state === 'B2' ? `${symbol} 站上 ${level},进入 B2 上沿扩展` : `${symbol} 跌破 ${level},进入 B3 失守续探`;
  }
  return event.state === 'B2' ? `${symbol} 跌回 ${level} 下方,B2 失效` : `${symbol} 收回 ${level} 上方,B3 失效`;
}

export function eventBody(event: PlaybookEvent): string {
  return `现价 ${fmtLevel(event.price)} · 美东 ${etTime(event.at)}`;
}

export interface BandRow {
  key: 'prior' | 'open' | 'current';
  label: string;
  when: string;
  band: PlaybookBand | null;
}

export function bandRows(snap: PlaybookSnapshot): BandRow[] {
  return [
    { key: 'prior', label: '昨日定价', when: '上一个收盘后 10 分钟', band: snap.bands.prior },
    { key: 'open', label: '盘初定价', when: '09:35', band: snap.bands.open },
    { key: 'current', label: '当前剩余', when: `每 ${Math.round(snap.frame_seconds / 60)} 分钟`, band: snap.bands.current },
  ];
}
