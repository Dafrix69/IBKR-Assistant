/** 美股休市日与提前收盘日的内置日历(按 NYSE 的规则推算)。
 *
 * 为什么要有:配置里的 `market_holidays` / `early_close_days` 是一张手写的表,示例只写到 2026 年。
 * 表里没有的年份,每个工作日都算交易日——2027 年元旦起,「休市不发市价单」这条策略、期权到期日
 * 是不是交易日的校验、保护规则按交易日算的那几条,会在每一个假日悄悄错一次。卖出去的软件不能靠
 * 用户每年记得去补一张表。
 *
 * 口径:
 *  · 这里只认**规则算得出来**的那十个假日,加一张已经发生过的临时休市表(国葬、飓风)。以后的临时休市
 *    规则算不出来,照旧写进配置——配置里的日期与内置日历取并集(见 config.ts)。
 *  · 周六的假日提前到周五休、周日的顺延到周一休。唯一的例外是元旦:落在周六时**不补休**
 *    (周五是上一年的最后一个交易日,NYSE Rule 7.2),2022、2028 年都是这样。
 *  · 六月节(Juneteenth)从 2022 年起才是交易所假日。
 *  · 提前收盘(美东 13:00)三种:感恩节次日;平安夜(12 月 24 日是交易日时);7 月 3 日(落在周一到周四时)。
 *
 * 纯函数、零依赖、不读时钟:给年份,出日期。
 */

const DAY_MS = 86_400_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

const iso = (year: number, month: number, day: number): string => `${year}-${pad2(month)}-${pad2(day)}`;

/** 0 = 周日 … 6 = 周六 */
function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function shift(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  const d = new Date(t);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 某月第 n 个星期几(n 从 1 起)。 */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  const first = weekday(year, month, 1);
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  return iso(year, month, day);
}

/** 某月最后一个星期几。 */
function lastWeekday(year: number, month: number, dow: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday(year, month, lastDay);
  return iso(year, month, lastDay - ((last - dow + 7) % 7));
}

/** 复活节(公历,Meeus / Jones / Butcher 算法)。耶稣受难日是它前面那个周五。 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** 固定日期的假日落在周末时挪到哪天休;不休返回 null。 */
function observed(year: number, month: number, day: number, saturdayShifts = true): string | null {
  const dow = weekday(year, month, day);
  const date = iso(year, month, day);
  if (dow === 6) return saturdayShifts ? shift(date, -1) : null;
  if (dow === 0) return shift(date, 1);
  return date;
}

/** 已经发生过的临时休市(规则算不出来的)。只增不改;以后的写进配置。 */
const SPECIAL_CLOSURES: readonly string[] = [
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", // 9·11
  "2004-06-11", // 里根国葬
  "2007-01-02", // 福特国葬
  "2012-10-29", "2012-10-30", // 飓风桑迪
  "2018-12-05", // 老布什国葬
  "2025-01-09", // 卡特国葬
];

/** 六月节成为交易所假日的第一年。 */
const JUNETEENTH_SINCE = 2022;

/** 某一年的休市日(已排序,都是工作日)。 */
export function nyseHolidays(year: number): string[] {
  const out: Array<string | null> = [
    observed(year, 1, 1, false), // 元旦:周六不补休
    nthWeekday(year, 1, 1, 3), // 马丁·路德·金日:一月第三个周一
    nthWeekday(year, 2, 1, 3), // 华盛顿诞辰:二月第三个周一
    shift(easterSunday(year), -2), // 耶稣受难日
    lastWeekday(year, 5, 1), // 阵亡将士纪念日:五月最后一个周一
    year >= JUNETEENTH_SINCE ? observed(year, 6, 19) : null, // 六月节
    observed(year, 7, 4), // 独立日
    nthWeekday(year, 9, 1, 1), // 劳动节:九月第一个周一
    nthWeekday(year, 11, 4, 4), // 感恩节:十一月第四个周四
    observed(year, 12, 25), // 圣诞节
  ];
  // 下一年的元旦落在周日之外不会挪进本年;落在周六不补休——所以本年的表不用看下一年
  const dates = out.filter((d): d is string => d !== null);
  for (const d of SPECIAL_CLOSURES) if (d.startsWith(`${year}-`)) dates.push(d);
  return [...new Set(dates)].sort();
}

/** 某一年提前到美东 13:00 收盘的日子(已排序)。 */
export function nyseEarlyCloses(year: number): string[] {
  const holidays = new Set(nyseHolidays(year));
  const out: string[] = [];
  const open = (date: string): boolean => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !holidays.has(date);
  };
  // 7 月 3 日:只在它落在周一到周四时(独立日是周二到周五)
  const july3 = iso(year, 7, 3);
  const july3Dow = weekday(year, 7, 3);
  if (july3Dow >= 1 && july3Dow <= 4 && open(july3)) out.push(july3);
  // 感恩节次日
  const blackFriday = shift(nthWeekday(year, 11, 4, 4), 1);
  if (open(blackFriday)) out.push(blackFriday);
  // 平安夜
  const eve = iso(year, 12, 24);
  if (open(eve)) out.push(eve);
  return out.sort();
}

/** 内置日历覆盖的年份:早于它的历史日期只在复盘里出现,晚于它的到时候这个软件早该升过级了。 */
export const CALENDAR_FIRST_YEAR = 2000;
export const CALENDAR_LAST_YEAR = 2060;

let cached: { holidays: readonly string[]; earlyCloses: readonly string[] } | null = null;

/** 整段年份的内置日历(算一次,之后复用)。 */
export function builtinCalendar(): { holidays: readonly string[]; earlyCloses: readonly string[] } {
  if (cached === null) {
    const holidays: string[] = [];
    const earlyCloses: string[] = [];
    for (let y = CALENDAR_FIRST_YEAR; y <= CALENDAR_LAST_YEAR; y += 1) {
      holidays.push(...nyseHolidays(y));
      earlyCloses.push(...nyseEarlyCloses(y));
    }
    cached = { holidays, earlyCloses };
  }
  return cached;
}

/** 配置里的日期与内置日历取并集(去重、排序)。配置里写的永远算数——临时休市只能靠它。 */
export function mergeCalendar(configured: readonly string[], builtin: readonly string[]): string[] {
  return [...new Set([...configured, ...builtin])].sort();
}
