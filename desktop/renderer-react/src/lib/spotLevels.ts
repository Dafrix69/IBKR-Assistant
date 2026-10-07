/**
 * 现价走到关口(25 的整数倍)了没有:现价上下最近的两个关口,以及"这一笔相对上一笔穿过了哪个关口"。
 *
 * 单独放成一个**不 import 任何东西、不碰 DOM 的纯模块**,引擎那套 vitest 直接跑它(desktop-spot-levels.spec)。
 * 轮询与发提醒在 store/spot;口径见 docs/features/fly-plan.md「实时现价与关口提醒」。
 */

/** SPX 的蝶中心都落在 25 的整数倍上(7700 / 7725 / 7750) */
export const LEVEL_STEP = 25;

/** 两笔可用的价隔了这么久(电脑睡过、断线重连),后一笔只登记、不和前一笔比:中间走过哪儿没人看见 */
export const GAP_MS = 30_000;

export interface SpotSample {
  price: number | null;
  /** quote / futures 是会动的现价;stale / none 不拿来判断 */
  source: string;
  /** 读到这个价的时刻(epoch 毫秒) */
  at: number;
}

export interface LevelWatchState {
  /** 上一笔可用的价;还没有是 null */
  last: { price: number; source: string; at: number } | null;
  /** 刚报过的那个关口:价格离开它半个步长之前不再报 */
  muted: number | null;
}

export const EMPTY_WATCH: LevelWatchState = { last: null, muted: null };

export interface LevelHit {
  level: number;
  direction: 'up' | 'down';
  /** 穿过去之后的那一笔价 */
  price: number;
  source: string;
  at: number;
  /** 这一步里在它之前还越过了几个关口(一笔跳过两个关口时只报最后一个) */
  skipped: number;
}

function usable(sample: SpotSample): sample is SpotSample & { price: number } {
  return typeof sample.price === 'number' && Number.isFinite(sample.price) && sample.price > 0
    && (sample.source === 'quote' || sample.source === 'futures');
}

/** 现价上下最近的两个关口。正好踩在关口上时,它算下面那个(距离 0) */
export function nearLevels(price: number, step = LEVEL_STEP): { below: number; above: number } {
  const below = Math.floor(price / step) * step;
  return { below, above: below + step };
}

/**
 * 喂一笔现价,看它相对上一笔穿过了关口没有。
 *
 *  - 碰到就算:上行是「上一笔 < 关口 ≤ 这一笔」,下行反过来。
 *  - 第一笔、隔了太久的一笔、换了来源的一笔(官方指数 ↔ 期货推算,两种量法之间的差不是行情)只登记。
 *  - 报过的关口静音,直到价格离开它半个步长:离得比这更远,最近的关口已经是另一个了,再回来才是"又到了"。
 *    在关口上来回蹭只报一次。
 *  - 没有可用的价(没连上、昨收、断线时的最后一笔):状态原样留着,隔了多久由下一笔可用的价按 GAP_MS 判。
 */
export function stepLevelWatch(
  state: LevelWatchState, sample: SpotSample, step = LEVEL_STEP,
): { state: LevelWatchState; hit: LevelHit | null } {
  if (!usable(sample)) return { state, hit: null };
  const { price, source, at } = sample;
  const last = { price, source, at };
  const prev = state.last;
  const muted = state.muted !== null && Math.abs(price - state.muted) >= step / 2 ? null : state.muted;
  const quiet = { state: { last, muted }, hit: null };
  if (prev === null || prev.source !== source || at < prev.at || at - prev.at > GAP_MS || price === prev.price) return quiet;

  const up = price > prev.price;
  // 这一步越过的关口里离这一笔最近的那个,以及一共越过了几个
  const level = up ? Math.floor(price / step) * step : Math.ceil(price / step) * step;
  const count = up
    ? Math.floor(price / step) - Math.floor(prev.price / step)
    : Math.ceil(prev.price / step) - Math.ceil(price / step);
  if (count <= 0 || level === muted) return quiet;
  return {
    state: { last, muted: level },
    hit: { level, direction: up ? 'up' : 'down', price, source, at, skipped: count - 1 },
  };
}

/** 提醒的标题:和价位提醒用同一对词 */
export function levelHitTitle(symbol: string, hit: LevelHit): string {
  return `${symbol} ${hit.direction === 'up' ? '上穿' : '下破'} ${hit.level}`;
}

/** 提醒的正文:现价、是不是期货推算的、一步越过了几个 */
export function levelHitBody(hit: LevelHit): string {
  const parts = [`现价 ${hit.price.toFixed(2)}${hit.source === 'futures' ? '(按期货推算)' : ''}`];
  if (hit.skipped > 0) parts.push(`这一步越过了 ${hit.skipped + 1} 个关口`);
  return parts.join(' · ');
}
