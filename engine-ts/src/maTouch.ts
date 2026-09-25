/** 短期内反复碰同一条日均线 —— 纯计算,不认识券商、引擎、RPC。口径与校准见 docs/features/ma-touch.md。
 *
 * - 某天「碰到」X 日均线:那天的 [最低, 最高] 进到均线 ± band% 以内。均线是含当天收盘的 X 日简单均线,
 *   和看图软件画的那条是同一条。
 * - 连着几个交易日都碰到算**一段**:贴着线走五天是「粘在线上」,不是「碰了五次」。
 * - 最近 N 个交易日(含今天)里有几段:一段只要有一天落在窗口里就算。
 * - 今天那根还没走完,不用券商给的半根 K 线,拿现价补:均线 = (前 X−1 根收盘和 + 现价) / X;
 *   现价离它 band% 以内、或这一轮和上一轮的价跨过了它,就是今天碰到了。
 * - 今天碰到、窗口里凑够 K 段,报一次;同一段(昨天就在碰、今天接着碰)只报一次。
 */
import type {
  MaTouchConfig, TouchBook, TouchEpisode, TouchLine,
} from "./contract/alerts.js";
import { fmtF, pyRound } from "./py.js";

export const DEFAULT_TOUCH_CONFIG: MaTouchConfig = {
  enabled: true,
  periods: [20, 60, 120, 200], // 和价位条上那几条均线一致
  window_days: 10,
  min_touches: 3,
  band_pct: 0.3, // 和穿越提醒的 band 同一个数
};

export const MAX_TOUCH_PERIODS = 6;
// 日线拉 420 个日历日 ≈ 288 根:250 日线 + 30 天窗口还放得下
const PERIOD_RANGE = [5, 250] as const;
const WINDOW_RANGE = [3, 30] as const;
const TOUCHES_RANGE = [2, 10] as const;
const BAND_RANGE = [0, 2] as const;

export class MaTouchError extends Error {}

/** 一根完整日线里碰均线要用的那几样。 */
export interface DayBar {
  date: string;
  high: number;
  low: number;
  close: number;
}

/** 某一天和某条均线的关系(均线凑得满的那几天才有)。 */
export interface TouchDay {
  date: string;
  ma: number;
  touched: boolean;
  side: "above" | "below";
}

/** 这一轮报出来的一条。 */
export interface TouchHit {
  period: number;
  label: string;
  /** 此刻的均线 */
  ma: number;
  /** 窗口里第几段(含今天这段) */
  count: number;
  /** 今天这一段从哪天开始(昨天就在碰的话是更早) */
  start: string;
  /** 窗口里今天之前的那几段 */
  prior: TouchEpisode[];
  side: "above" | "below";
  direction: "up" | "down";
  text: string;
}

// ---------------------------------------------------------------- 口径
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 数字或数字串都认;布尔、空串、NaN 不认(同 anomaly.ts)。 */
function numberOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function shown(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function intField(raw: Record<string, unknown>, key: string, fallback: number, range: readonly [number, number], what: string): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  const n = numberOf(value);
  if (n === null || !Number.isInteger(n) || n < range[0] || n > range[1]) {
    throw new MaTouchError(`${what}要是 ${range[0]}~${range[1]} 的整数(收到 ${shown(value)})`);
  }
  return n;
}

/** 校验并与 base 合并;越界抛 MaTouchError(中文原因)。未知键忽略,缺的键(或 null)取 base。 */
export function normalizeTouchConfig(raw: unknown, base: MaTouchConfig = DEFAULT_TOUCH_CONFIG): MaTouchConfig {
  const out: MaTouchConfig = { ...base, periods: [...base.periods] };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new MaTouchError("碰均线提醒的设置格式不对,应是一组键值");

  const enabled = raw["enabled"];
  if (enabled !== undefined && enabled !== null) {
    if (typeof enabled !== "boolean") throw new MaTouchError(`开关要是 true / false(收到 ${shown(enabled)})`);
    out.enabled = enabled;
  }
  const periods = raw["periods"];
  if (periods !== undefined && periods !== null) {
    const why = `均线要 1~${MAX_TOUCH_PERIODS} 条、每条 ${PERIOD_RANGE[0]}~${PERIOD_RANGE[1]} 日的整数(收到 ${shown(periods)})`;
    if (!Array.isArray(periods) || periods.length === 0) throw new MaTouchError(why);
    const list: number[] = [];
    for (const item of periods) {
      const n = numberOf(item);
      if (n === null || !Number.isInteger(n) || n < PERIOD_RANGE[0] || n > PERIOD_RANGE[1]) throw new MaTouchError(why);
      if (!list.includes(n)) list.push(n);
    }
    if (list.length > MAX_TOUCH_PERIODS) throw new MaTouchError(why);
    out.periods = list.sort((a, b) => a - b);
  }
  out.window_days = intField(raw, "window_days", out.window_days, WINDOW_RANGE, "「短期内」的交易日数");
  out.min_touches = intField(raw, "min_touches", out.min_touches, TOUCHES_RANGE, "起报次数");
  const band = raw["band_pct"];
  if (band !== undefined && band !== null) {
    const n = numberOf(band);
    if (n === null || n < BAND_RANGE[0] || n > BAND_RANGE[1]) {
      throw new MaTouchError(`贴近均线的容差要在 ${BAND_RANGE[0]}%~${BAND_RANGE[1]}% 之间(收到 ${shown(band)})`);
    }
    out.band_pct = pyRound(n, 4);
  }
  // 两段之间至少隔一天没碰,N 天里最多分出 ⌈N/2⌉ 段——要的次数比这还多,这条提醒永远不会响
  const most = Math.ceil(out.window_days / 2);
  if (out.min_touches > most) {
    throw new MaTouchError(
      `${out.window_days} 个交易日里最多只能分出 ${most} 段触碰(连着几天贴着线只算一次),起报次数 ${out.min_touches} 永远凑不够`,
    );
  }
  return out;
}

/** 前一个交易日。isTradingDay 由调用方给(假期表在配置里)。 */
export function prevTradingDay(date: string, isTradingDay: (d: string) => boolean): string {
  let ms = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i < 15; i += 1) {
    ms -= 86_400_000;
    const d = new Date(ms).toISOString().slice(0, 10);
    if (isTradingDay(d)) return d;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 日线上的触碰
/** 券商回来的日线 → 今天之前的完整日线(今天那根盘中还没走完)。缺价的整根跳过,不拿别的字段凑。 */
export function completedBars(bars: ReadonlyArray<Record<string, unknown>> | null | undefined, today: string): DayBar[] {
  const out: DayBar[] = [];
  for (const bar of bars ?? []) {
    const date = typeof bar["date"] === "string" ? bar["date"].slice(0, 10) : "";
    const high = bar["high"];
    const low = bar["low"];
    const close = bar["close"];
    if (!date || date >= today) continue;
    if (typeof high !== "number" || typeof low !== "number" || typeof close !== "number") continue;
    if (!(high > 0 && low > 0 && close > 0) || !Number.isFinite(high + low + close)) continue;
    if (out.length && out[out.length - 1]!.date >= date) continue; // 乱序 / 重复的不认
    out.push({ date, high, low, close });
  }
  return out;
}

/** 每一天碰没碰这条均线。均线凑不满周期的那几天不给(拿 12 根算"20 日均线"是撒谎)。 */
export function touchDays(bars: readonly DayBar[], period: number, bandPct: number): TouchDay[] {
  const out: TouchDay[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    sum += bar.close;
    if (i >= period) sum -= bars[i - period]!.close;
    if (i < period - 1) continue;
    const ma = sum / period;
    const tol = (ma * bandPct) / 100;
    out.push({
      date: bar.date,
      ma,
      touched: bar.low <= ma + tol && bar.high >= ma - tol,
      side: bar.close >= ma ? "above" : "below",
    });
  }
  return out;
}

/** 连着碰的几天并成一段;side 取这一段最后一天的收盘。 */
export function episodesOf(days: readonly TouchDay[]): TouchEpisode[] {
  const out: TouchEpisode[] = [];
  let open: TouchEpisode | null = null;
  for (const day of days) {
    if (!day.touched) {
      open = null;
      continue;
    }
    if (open === null) {
      open = { start: day.date, end: day.date, side: day.side };
      out.push(open);
    } else {
      open.end = day.date;
      open.side = day.side;
    }
  }
  return out;
}

/**
 * 从日线算一份底账。今天(美东)那根不用;fired 从旧底账带过来(同一段只报一次要跨天、跨重启记得)。
 * 窗口 = 最近 window_days 个交易日含今天,所以底账里只留落在最近 window_days − 1 根完整日线里的那几段。
 * 某条均线的历史凑不满(上市太短、周期太长)就不给这条,不拿短的凑——底账照给(periods 记着要过哪几条),
 * 否则它会被当成"旧了"每 10 分钟重拉一次日线。一根完整日线都没有才回 null。
 */
export function buildTouchBook(
  bars: ReadonlyArray<Record<string, unknown>> | null | undefined,
  today: string,
  config: MaTouchConfig,
  fired: Record<string, string> = {},
): TouchBook | null {
  const done = completedBars(bars, today);
  const last = done[done.length - 1];
  if (last === undefined) return null;
  const inWindow = config.window_days - 1;
  const windowStart = done[Math.max(0, done.length - inWindow)]!.date;

  const lines: TouchLine[] = [];
  for (const period of config.periods) {
    if (done.length < period + inWindow - 1) continue; // 窗口第一天的均线都凑不满
    const episodes = episodesOf(touchDays(done, period, config.band_pct)).filter((e) => e.end >= windowStart);
    const prior = done.slice(done.length - (period - 1)).reduce((a, b) => a + b.close, 0);
    lines.push({ period, prior_sum: pyRound(prior, 6), episodes });
  }
  const keep: Record<string, string> = {};
  for (const line of lines) {
    const at = fired[String(line.period)];
    if (at !== undefined) keep[String(line.period)] = at;
  }
  return {
    as_of: last.date, window_days: config.window_days, band_pct: config.band_pct,
    periods: [...config.periods], lines, fired: keep,
  };
}

/** 底账能不能拿来判今天:最后一根完整日线得是上一个交易日,算它的口径(窗口、容差、哪几条线)得和现在一样。 */
export function bookUsable(book: TouchBook | null | undefined, config: MaTouchConfig, prevDay: string): book is TouchBook {
  if (!book) return false;
  if (book.as_of !== prevDay) return false;
  if (book.window_days !== config.window_days || book.band_pct !== config.band_pct) return false;
  const want = [...config.periods].sort((a, b) => a - b).join(",");
  return [...(book.periods ?? [])].sort((a, b) => a - b).join(",") === want;
}

// ---------------------------------------------------------------- 盘中
function mmdd(date: string): string {
  return date.slice(5);
}

function money(v: number): string {
  return fmtF(v, 2);
}

function episodeText(e: TouchEpisode): string {
  return e.start === e.end ? mmdd(e.start) : `${mmdd(e.start)}~${mmdd(e.end)}`;
}

function sideNote(prior: readonly TouchEpisode[]): string {
  if (prior.every((e) => e.side === "above")) return ",都收在线上";
  if (prior.every((e) => e.side === "below")) return ",都收在线下";
  return ",收盘有上有下";
}

/**
 * 这一轮的现价碰没碰、该不该报。book 必须是 bookUsable 过的。
 * prevPrice 只给**同一个交易日**上一轮的价:隔夜跳空跨过均线不是"碰"。第一轮给 null,只看离得多近。
 * 回报出来的几条 + 更新过的 fired(调用方写回库里)。
 */
export function evaluateTouches(
  book: TouchBook,
  config: MaTouchConfig,
  price: number,
  prevPrice: number | null,
  today: string,
): { hits: TouchHit[]; fired: Record<string, string> } {
  const fired: Record<string, string> = { ...book.fired };
  const hits: TouchHit[] = [];
  if (!(price > 0)) return { hits, fired };

  for (const line of book.lines) {
    if (!config.periods.includes(line.period)) continue;
    const p = line.period;
    const ma = (line.prior_sum + price) / p;
    const near = Math.abs(price - ma) <= (ma * config.band_pct) / 100;
    let crossed = false;
    if (prevPrice !== null && prevPrice > 0) {
      const maPrev = (line.prior_sum + prevPrice) / p;
      crossed = (prevPrice - maPrev) * (price - ma) <= 0;
    }
    if (!near && !crossed) continue;

    const lastEp = line.episodes[line.episodes.length - 1];
    const continuing = lastEp !== undefined && lastEp.end === book.as_of;
    const start = continuing ? lastEp.start : today;
    const done = fired[String(p)];
    if (done !== undefined && done >= start) continue; // 这一段报过了

    const prior = continuing ? line.episodes.slice(0, -1) : [...line.episodes];
    const count = prior.length + 1;
    if (count < config.min_touches) continue;

    const side: "above" | "below" = price >= ma ? "above" : "below";
    const direction: "up" | "down" =
      crossed && prevPrice !== null && prevPrice !== price
        ? price > prevPrice ? "up" : "down"
        : side === "above" ? "down" : "up"; // 在线上 = 从上方回踩下来
    const label = `${p}日均线`;
    const now = continuing ? `${mmdd(start)} 起连着碰到今天` : "今天";
    hits.push({
      period: p, label, ma: pyRound(ma, 4), count, start, prior, side, direction,
      text:
        `近 ${config.window_days} 个交易日第 ${count} 次碰 ${label} ${money(ma)}` +
        `(之前 ${prior.map(episodeText).join("、")}${sideNote(prior)};${now},现价 ${money(price)})`,
    });
    fired[String(p)] = start;
  }
  return { hits, fired };
}
