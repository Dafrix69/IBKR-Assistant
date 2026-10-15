/**
 * 持仓追踪里的关键价位:追踪的标的在盯价位(期权墙 / 均线 / 整数关口,引擎的 alert_watches),这里把它们和
 * 用户自己设的那几条线(止损、止盈、标的止损、目标价)摆到一起说清楚——"止损在下方持仓墙之下 0.4%"这种话。
 *
 * **不 import 任何东西、不碰 DOM 的纯模块**(只从 bridge 取类型),引擎那套 vitest 直接跑它(desktop-track-levels.spec)。
 * 价位怎么算、穿越怎么报在引擎(alerts.ts、services/alerts.ts);口径见 docs/features/tracker.md「关键价位」。
 */
import type { Targets, WatchLevel } from '../bridge';

/** 用户自己设的线在价位条上的来源键前缀:LevelStrip 认它,画成另一种颜色、摆在现价那一侧 */
export const OWN_PREFIX = 'own:';

export function isOwnLine(level: Pick<WatchLevel, 'source'>): boolean {
  return String(level.source || '').startsWith(OWN_PREFIX);
}

/** 盯盘那一轮里这里用到的几样(契约 TrackPollRow 的子集) */
export interface LiveBits {
  price?: number | null;
  stop_effective?: number | null;
  profit_trail_stop?: number | null;
  spot_target?: { price?: number | null; spot?: number | null } | null;
  spot_stop?: { below: number | null; above: number | null; spot: number | null } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * 用户自己设的那几条线,按**标的的价**摆:正股的标的就是它自己(止损、止盈 / 目标价、回撤线都在同一根轴上);
 * 期权与组合只有标的止损价与标的目标价是标的的价,持仓自己的止盈止损(期权价)不上这根轴。
 * 跟踪止损跟着峰值走,所以止损取这一轮生效的那条(stop_effective),没有盯盘结果时退回填的止损价。
 */
export function ownLines(secType: string, targets: Partial<Targets>, live?: LiveBits | null): WatchLevel[] {
  const out: WatchLevel[] = [];
  const add = (key: string, label: string, price: unknown): void => {
    const p = num(price);
    if (p !== null) out.push({ price: p, label, source: `${OWN_PREFIX}${key}`, kind: 'pivot' });
  };
  if (secType === 'STK') {
    add('stop', '止损', live?.stop_effective ?? targets.stop_loss);
    add('ptrail', '回撤线', live?.profit_trail_stop);
    add('tp', '止盈', targets.spot_target ?? targets.take_profit);
    return out;
  }
  add('stop_below', '标的止损', targets.spot_stop_below);
  add('stop_above', '标的止损', targets.spot_stop_above);
  add('target', '目标价', targets.spot_target);
  return out;
}

export interface LevelGap {
  level: WatchLevel;
  /** 距现价 %,上方为正 */
  pct: number;
}

/** 现价上下各最近的几个价位(不含用户自己的线),各按离现价由近到远 */
export function nearestLevels(levels: WatchLevel[], spot: number, n = 2): { below: LevelGap[]; above: LevelGap[] } {
  const gaps: LevelGap[] = levels
    .filter((l) => !isOwnLine(l) && Number.isFinite(l.price) && l.price > 0 && l.price !== spot)
    .map((l) => ({ level: l, pct: (l.price / spot - 1) * 100 }));
  const below = gaps.filter((g) => g.level.price < spot).sort((a, b) => b.level.price - a.level.price).slice(0, n);
  const above = gaps.filter((g) => g.level.price > spot).sort((a, b) => a.level.price - b.level.price).slice(0, n);
  return { below, above };
}

/** 价照人看的样子写:7700 不写成 7700.00,219.74 留两位 */
export const fmtLevel = (v: number): string => String(Number(Number(v).toFixed(2)));
/** +0.36% / −0.29% */
export const fmtGap = (pct: number): string => `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(2)}%`;

/** 一个价位的短名(价位条上那种);没登记的来源用它自己的标签 */
export function levelName(level: WatchLevel, short: Record<string, string>): string {
  return short[level.source] || level.label || '价位';
}

/** 一句话:下方最近的两个、上方最近的两个。没有价位回空串 */
export function levelSummary(levels: WatchLevel[], spot: number, short: Record<string, string>): string {
  const { below, above } = nearestLevels(levels, spot);
  const part = (gaps: LevelGap[]): string => gaps.map((g) => `${levelName(g.level, short)} ${fmtLevel(g.level.price)}(${fmtGap(g.pct)})`).join('、');
  const parts: string[] = [];
  if (below.length) parts.push(`下方 ${part(below)}`);
  if (above.length) parts.push(`上方 ${part(above)}`);
  return parts.join(' · ');
}

/** 相邻两个价差不到现价的这么多 % 就算贴着(和引擎合并价位用的是同一个数,alerts.DEFAULT_MERGE_PCT) */
export const NEAR_PCT = 0.15;

/**
 * 用户的一条线和它旁边的价位是什么关系。线在现价下方时看支撑(现价下方的价位),上方时看阻力:
 *  · 贴着(差不到 0.15%):「止损 7700 贴着 P 墙 7700」
 *  · 价位夹在线和现价之间:「止损 7690 在 P 墙 7700 之下 0.13%」——价位先于止损被碰到
 *  · 线夹在价位和现价之间:「止损 7710 在 P 墙 7700 之上 0.13%:墙没破就先出了」——这是最该让人看见的一种
 * 旁边没有价位回 null。
 */
export function lineContext(line: WatchLevel, levels: WatchLevel[], spot: number, short: Record<string, string>): string | null {
  if (!(spot > 0) || !(line.price > 0) || line.price === spot) return null;
  const belowSpot = line.price < spot;
  const side = levels.filter((l) => !isOwnLine(l) && l.price > 0 && (belowSpot ? l.price < spot : l.price > spot));
  if (!side.length) return null;
  // 离这条线最近的那个价位
  const near = side.reduce((best, l) => (Math.abs(l.price - line.price) < Math.abs(best.price - line.price) ? l : best));
  const name = `${levelName(near, short)} ${fmtLevel(near.price)}`;
  const gap = Math.abs(near.price / line.price - 1) * 100;
  const head = `${line.label} ${fmtLevel(line.price)}`;
  if (Math.abs(near.price - line.price) <= (spot * NEAR_PCT) / 100) return `${head} 贴着 ${name}`;
  const outside = belowSpot ? near.price > line.price : near.price < line.price; // 价位在线和现价之间
  if (outside) return `${head} 在 ${name} 之${belowSpot ? '下' : '上'} ${gap.toFixed(2)}%`;
  return `${head} 在 ${name} 之${belowSpot ? '上' : '下'} ${gap.toFixed(2)}%:${belowSpot ? '支撑' : '阻力'}没破就先出了`;
}

export type PickMode = 'stop' | 'target';

/**
 * 表单里点价位填进止损 / 目标时,哪一侧的价位能点。正股只认方向对的那一侧(多头的止损只能在下方,填上方会被引擎拒);
 * 期权与组合的标的止损两侧都有(跌到 / 涨到),目标价也不限方向(看涨看跌由结构定,这里不猜)。
 */
export function pickSides(
  levels: WatchLevel[], spot: number, mode: PickMode, long: boolean, derivative: boolean,
): { below: WatchLevel[]; above: WatchLevel[] } {
  const plain = levels.filter((l) => !isOwnLine(l) && l.price > 0 && l.price !== spot);
  const below = plain.filter((l) => l.price < spot).sort((a, b) => b.price - a.price);
  const above = plain.filter((l) => l.price > spot).sort((a, b) => a.price - b.price);
  if (derivative) return { below, above };
  const wantBelow = mode === 'stop' ? long : !long;
  return wantBelow ? { below, above: [] } : { below: [], above };
}

/** 弹窗里带上的那一句:这只标的在追踪里离止损 / 目标还有多远 */
export interface TrackLike {
  id: string;
  symbol: string;
  sec_type: string;
  enabled: boolean;
  fired_at: string | null;
  targets: Partial<Targets>;
}

/**
 * 价位穿越的弹窗落到持仓追踪页时,正文末尾那一句。没在追踪这只(或追踪都已触发 / 暂停)回 null。
 * 正股说止损(这一轮生效的那条)离现价多少 %;期权与组合说标的止损线离标的现价多少点;都没设就只说在追踪。
 */
export function trackContext(symbol: string, tracks: TrackLike[], rows: Record<string, LiveBits | undefined>): string | null {
  const mine = tracks.filter((t) => t.symbol === symbol && t.enabled && !t.fired_at);
  if (!mine.length) return null;
  const parts = mine.map((t) => {
    const live = rows[t.id];
    if (t.sec_type === 'STK') {
      const stop = num(live?.stop_effective ?? t.targets.stop_loss);
      const price = num(live?.price);
      if (stop === null) return '正股在追踪,没设止损价';
      return price === null ? `止损 ${fmtLevel(stop)}` : `止损 ${fmtLevel(stop)}(距现价 ${fmtGap((stop / price - 1) * 100)})`;
    }
    const stop = live?.spot_stop;
    const below = num(stop?.below ?? t.targets.spot_stop_below);
    const above = num(stop?.above ?? t.targets.spot_stop_above);
    const spot = num(stop?.spot);
    // 离线还有多远;已经越过(在等确认秒数,或这一轮刚越过)就说越过了多少
    const gap = (d: number): string => (d >= 0 ? `(还差 ${d.toFixed(2)} 点)` : `(已越过 ${(-d).toFixed(2)} 点)`);
    const lines: string[] = [];
    if (below !== null) lines.push(`跌到 ${fmtLevel(below)}${spot !== null ? gap(spot - below) : ''}`);
    if (above !== null) lines.push(`涨到 ${fmtLevel(above)}${spot !== null ? gap(above - spot) : ''}`);
    return lines.length ? `标的止损 ${lines.join(' / ')}` : '期权在追踪,没设标的止损';
  });
  return `持仓追踪:${[...new Set(parts)].join(';')}`;
}
