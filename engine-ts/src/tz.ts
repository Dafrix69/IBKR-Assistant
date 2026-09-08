/** 时区转换(美东 / 北京)。
 *
 * Python 侧用 zoneinfo;Node 没有内建的"墙钟→时刻"转换,这里用 Intl 查表实现。
 * 交易系统的时区错误是真金白银的错误,所以墙钟转换用迭代法精确处理 DST 边界。
 */

export const ET = "America/New_York";
export const BJ = "Asia/Shanghai";

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 某时刻在某时区的墙钟时间。 */
export function wallParts(epochMs: number, tz: string): WallParts {
  const parts = formatter(tz).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // h23 下 24:00 不该出现,保险
    minute: get("minute"),
    second: get("second"),
  };
}

/** 墙钟时间(某时区)→ 时刻。DST 空隙/重叠按"先猜 UTC 再校正"迭代两轮,
 * 与 zoneinfo 对存在的时刻结果一致。 */
export function wallToEpoch(p: WallParts, tz: string): number {
  let guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const want = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = want - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** 'YYYY-MM-DD' 的星期,Python 口径:周一=0 … 周日=6。 */
export function weekdayOfDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** 时刻 → 某时区的 'YYYY-MM-DD'。 */
export function dateStrAt(epochMs: number, tz: string): string {
  const p = wallParts(epochMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 时刻 → 某时区的 'YYYY-MM-DD HH:MM'(strftime "%Y-%m-%d %H:%M")。 */
export function stampAt(epochMs: number, tz: string): string {
  const p = wallParts(epochMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 'YYYY-MM-DD' → 自 1970-01-01 起的天数(纯日期运算用)。 */
export function dateOrdinal(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** 天数 → 'YYYY-MM-DD'。 */
export function ordinalToDate(ordinal: number): string {
  const dt = new Date(ordinal * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 合法公历日期检查(拒绝 20260231)。 */
export function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}
