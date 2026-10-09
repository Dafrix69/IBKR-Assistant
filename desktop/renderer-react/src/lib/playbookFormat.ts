/**
 * SPX 日内剧本面板的纯函数:状态与事件怎么写成人话、离触发线还有多远、期权墙的 gamma 环境怎么写。不碰引擎、不碰 DOM
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
  B2: '取到新一格时现价站上了今日区间的上沿:高出 09:35 那个价的幅度已经超过剩余的预期波动。每 5 分钟取到新一格时判一次;那时现价在进入时那条线下方就失效',
  B3: '现价跌破了昨日区间的下沿(每一笔现价都判,压过 B2);收回这条线上方就失效',
  R: '现价在两条触发线之间,没有方向信号',
  none: '昨日区间与今日区间都还没有,判不了',
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
  key: 'prior' | 'open' | 'current' | 'day';
  label: string;
  when: string;
  band: PlaybookBand | null;
  /** 不是另取的价,是别的行拼出来的:取价与跨式那两格不重复写 */
  derived: boolean;
}

export function bandRows(snap: PlaybookSnapshot): BandRow[] {
  return [
    { key: 'prior', label: '昨日定价', when: '上一个收盘后 10 分钟', band: snap.bands.prior, derived: false },
    { key: 'open', label: '盘初定价', when: '09:35', band: snap.bands.open, derived: false },
    { key: 'current', label: '当前剩余', when: `每 ${Math.round(snap.frame_seconds / 60)} 分钟`, band: snap.bands.current, derived: false },
    { key: 'day', label: '今日区间', when: '09:35 的锚 ± 当前剩余', band: snap.bands.day ?? null, derived: true },
  ];
}

// ---------------------------------------------------------------- 期权墙
/** 正负 gamma 是按这个假设算的:写在数旁边,不藏在说明里 */
export const GEX_ASSUMPTION = '假设做市商多看涨、空看跌';
export const GEX_ASSUMPTION_HINT = '净 gamma 的正负建立在「做市商持有看涨、卖出看跌」这个假设上:真实持仓没人看得到,假设反过来结论也反过来。它只用来判断波动会被压住还是放大,不判断方向。';

/** 只要这几样:剧本面板的墙与板块页盯单上存的那份墙都递得进来 */
export interface GexFacts {
  regime: string;
  net_gex_ratio?: number | null;
  gross_gex?: number | null;
  has_greeks?: boolean;
}

/**
 * gamma 环境那一小段。净额占总量多少照实写:占得很小就是两边差不多抵消,要不要当「中性」看的人自己判,这里不设门槛。
 * 盯单上存着的墙可能是老版本算的(没有 gross_gex 这一格):那时没有隐含波动率会把 0 写成 positive,这种一律读成不知道。
 * 没称出分量(总量为 0 或 null)的也一律是不知道。
 */
export function gexText(wall: GexFacts): string {
  const legacyBlind = wall.gross_gex === undefined && wall.has_greeks === false;
  // 总量是 0 的「抵消」是什么都没称出来(没有未平仓量),不是真的抵消
  const weighed = wall.gross_gex === undefined || (typeof wall.gross_gex === 'number' && wall.gross_gex > 0);
  if (wall.regime === 'neutral' && weighed) return '看涨与看跌的 gamma 正好抵消';
  if (legacyBlind || !weighed || (wall.regime !== 'positive' && wall.regime !== 'negative')) return 'gamma 环境未知(缺隐含波动率或未平仓量)';
  const ratio = wall.net_gex_ratio;
  const share = typeof ratio === 'number' && Number.isFinite(ratio) ? ` · 净额占总量 ${(Math.abs(ratio) * 100).toFixed(1)}%` : '';
  return `${wall.regime === 'positive' ? '正 gamma(波动受压)' : '负 gamma(波动放大)'}${share}`;
}

/** 这份链取了哪一段:抽着取的、有行没等到未平仓量的,都要说出来 */
export function coverageText(
  c: { lower: number; upper: number; strikes: number; grid_strikes: number | null; thinned: boolean } | null | undefined,
  oiMissing: number | null | undefined = 0,
): string {
  if (!c) return '';
  const base = `${c.lower}–${c.upper} 共 ${c.strikes} 档`;
  const thin = c.thinned && c.grid_strikes !== null ? `(链上 ${c.grid_strikes} 档,远处只取整数档)` : '';
  return `${base}${thin}${oiMissing ? ` · ${oiMissing} 行没等到未平仓量` : ''}`;
}

/** B2 失效之后、还没重新上膛时面板上那句话 */
export function rearmText(lost: number | null | undefined): string {
  return typeof lost === 'number' ? `B2 已失效:取到新一格时回到这条线下方再站上,或重新站回 ${fmtLevel(lost)} 之上,才算新的一次` : '';
}
