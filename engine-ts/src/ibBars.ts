/**
 * K 线从 IBKR 出来的那一段:日盘与夜盘两条线怎么取、怎么拼、闲着的那条怎么留着不重取。
 *
 * IBKR 的历史数据按交易所给。SMART 那条(useRTH=0)是盘前 04:00 → 盘后 20:00(美东);夜盘 20:00 → 次日 03:50 是另一个
 * 交易所(OVERNIGHT),要单独再要一次,按时间拼在一起才是整夜不断的 K 线。指数没有夜盘;只看常规时段、日线(夜盘不另成一天)
 * 也不要夜盘。
 *
 * 为什么要记住闲着的那条:界面每 20 秒刷一次 K 线,IBKR 把 10 分钟内超过 60 次历史请求算作超频、会掐行情连接,两条线各要一次
 * 就是翻倍。日盘开着的时候夜盘那条不会有新 K 线(反过来也一样),它上一次取回来的那份照用——前提是那份是在它收盘之后、
 * 再过了延迟档最多晚到的 20 分钟才取的(延迟档的最后一根要等那么久才到齐)。开着的那条每次都重取;两条都关着(周末)
 * 按同一条规矩,两条都留着。
 *
 * 夜盘那条要不到(这个标的没有夜盘、被拒、超时)不毁掉整次取数:只给日盘那条,半小时内不再去要夜盘。
 * 这一层只认合约与钟点,不认识交易日历:节假日的日盘按工作日对待,只是多取几次,不会把开着的线当成关着的。
 */
import type { IbContract, IbSession, RawBar } from "./ibTypes.js";
import { DELAYED_FEED_MAX_MS } from "./marketdata.js";
import { ET, pad2, wallParts, wallToEpoch, weekdayOfDate } from "./tz.js";

export type SessionLeg = "day" | "overnight";

/** IBKR 夜盘的交易所代码(界面上叫 IBEOS / Overnight Trading)。 */
export const OVERNIGHT_EXCHANGE = "OVERNIGHT";
/** 日盘(盘前 → 盘后)的起止,美东的分钟数;夜盘就是它关着的那一段。 */
const DAY_OPEN_MIN = 4 * 60;
const DAY_CLOSE_MIN = 20 * 60;
/** 夜盘要不到之后隔多久再试。 */
export const OVERNIGHT_RETRY_MS = 30 * 60_000;
/** 闲着的那条最多留多少份(标的 × 周期 × 时长各一份)。 */
const IDLE_MAX = 64;

export interface SessionBar {
  /** 'YYYY-MM-DD HH:MM'(日线 'YYYY-MM-DD'),美东墙钟 */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** IBKR 的 bar.date 归一化成 'YYYY-MM-DD HH:MM'(日线为 'YYYY-MM-DD')。 */
export function barTimestamp(value: unknown): string {
  const text = String(value ?? "").trim();
  const digits = text.replace(/-/g, "").replace(/:/g, "").split(/\s+/).filter(Boolean);
  if (digits.length && digits[0]!.length === 8 && /^\d{8}$/.test(digits[0]!)) {
    const d = digits[0]!;
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (digits.length > 1 && digits[1]!.length >= 4 && /^\d{6}/.test(digits[1]!.slice(0, 6))) {
      // IBKR 的 K 线时间是**交易所时区**(SPX 在 Cboe → 美中,比美东慢一小时),
      // 带时区名时换成美东再落字符串;否则 K 线看起来永远"落后一小时",新鲜度告警误报。
      const tz = digits.length > 2 && digits[2]!.includes("/") ? digits[2]! : null;
      const hour = Number(digits[1]!.slice(0, 2));
      const minute = Number(digits[1]!.slice(2, 4));
      const second = Number(digits[1]!.slice(4, 6));
      if (tz) {
        try {
          const epoch = wallToEpoch({
            year: Number(d.slice(0, 4)), month: Number(d.slice(4, 6)), day: Number(d.slice(6, 8)),
            hour, minute, second,
          }, tz);
          const p = wallParts(epoch, ET);
          return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
        } catch {
          /* 时区名认不出就走下面的老路径,不编 */
        }
      }
      return `${day} ${digits[1]!.slice(0, 2)}:${digits[1]!.slice(2, 4)}`;
    }
    return day;
  }
  return text;
}

/** IBKR 的一根原始 K 线 → 引擎的样子。指数没有成交量,IBKR 回 -1;归零免得被当成"缩量"读。 */
export function toSessionBar(bar: RawBar): SessionBar {
  return {
    time: barTimestamp(bar.date),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: Math.max(Number(bar.volume ?? 0) || 0, 0.0),
  };
}

function etClock(epochMs: number): { weekday: number; minutes: number; year: number; month: number; day: number } {
  const p = wallParts(epochMs, ET);
  return {
    weekday: weekdayOfDate(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`), // 周一 = 0 … 周日 = 6
    minutes: p.hour * 60 + p.minute,
    year: p.year, month: p.month, day: p.day,
  };
}

/** 这条线此刻开着吗。日盘:周一到周五 04:00–20:00;夜盘:周日到周四的 20:00 起、到次日 04:00。 */
export function legOpen(leg: SessionLeg, epochMs: number): boolean {
  const { weekday, minutes } = etClock(epochMs);
  if (leg === "day") return weekday <= 4 && minutes >= DAY_OPEN_MIN && minutes < DAY_CLOSE_MIN;
  if (minutes >= DAY_CLOSE_MIN) return weekday === 6 || weekday <= 3;
  if (minutes < DAY_OPEN_MIN) return weekday <= 4;
  return false;
}

/** 这条线上一次收盘的时刻(epoch 毫秒);此刻开着是 null。 */
export function legClosedSince(leg: SessionLeg, epochMs: number): number | null {
  if (legOpen(leg, epochMs)) return null;
  const closeHour = (leg === "day" ? DAY_CLOSE_MIN : DAY_OPEN_MIN) / 60;
  const { year, month, day } = etClock(epochMs);
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.UTC(year, month - 1, day) - back * 86_400_000);
    const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    if (weekdayOfDate(`${date.year}-${pad2(date.month)}-${pad2(date.day)}`) > 4) continue;
    const close = wallToEpoch({ ...date, hour: closeHour, minute: 0, second: 0 }, ET);
    if (close <= epochMs) return close;
  }
  return epochMs; // 八天里总有一个工作日,到不了这里;真到了就当刚收盘,不留
}

/** 夜盘那张合约:和日盘同一只股票,只换交易所。按代码重拼、不带 conId:真机上核对过的是这种写法(代码 + OVERNIGHT + USD)。 */
export function overnightContract(t: IbContract): IbContract {
  return { secType: t.secType, symbol: t.symbol, exchange: OVERNIGHT_EXCHANGE, currency: t.currency };
}

/** 两条线按时间拼成一组。同一时刻两边都有时留日盘那根(两边不该重叠,重叠说明交易所的时段表变了)。 */
export function mergeSessionBars(day: readonly SessionBar[], overnight: readonly SessionBar[]): SessionBar[] {
  if (!overnight.length) return [...day];
  const byTime = new Map<string, SessionBar>();
  for (const bar of overnight) byTime.set(bar.time, bar);
  for (const bar of day) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

export interface SessionBarsRequest {
  /** 已确认的合约(SMART 那张);夜盘那张由这里按代码重拼、交易所填 OVERNIGHT */
  target: IbContract;
  endDateTime: string;
  durationStr: string;
  barSizeSetting: string;
  whatToShow: string;
  useRTH: boolean;
  /** 要不要夜盘那条 */
  overnight: boolean;
  /** 此刻(epoch 毫秒):判两条线开没开着 */
  nowMs: number;
}

export class SessionBars {
  /** 闲着的那条上一次取回来的那份 */
  private readonly idle = new Map<string, { bars: SessionBar[]; fetchedAt: number }>();
  /** 夜盘要不到的标的 → 什么时候再试 */
  private readonly overnightRetryAt = new Map<string, number>();
  /** 夜盘最近一次要不到的原因,按标的(给诊断看;要到了就清掉) */
  readonly overnightErrors = new Map<string, string>();

  async fetch(session: IbSession, req: SessionBarsRequest): Promise<SessionBar[]> {
    if (!req.overnight) return this.leg(session, req, "day");
    // 两条一起要,别让图多等一个来回;日盘那条失败整次失败(和以前一样),夜盘那条失败只少夜盘
    const [day, night] = await Promise.all([this.leg(session, req, "day"), this.overnightLeg(session, req)]);
    return mergeSessionBars(day, night);
  }

  private async overnightLeg(session: IbSession, req: SessionBarsRequest): Promise<SessionBar[]> {
    const symbol = req.target.symbol;
    const retryAt = this.overnightRetryAt.get(symbol);
    if (retryAt !== undefined && req.nowMs < retryAt) return [];
    try {
      const bars = await this.leg(session, req, "overnight");
      this.overnightRetryAt.delete(symbol);
      this.overnightErrors.delete(symbol);
      return bars;
    } catch (exc) {
      this.overnightRetryAt.set(symbol, req.nowMs + OVERNIGHT_RETRY_MS);
      this.overnightErrors.set(symbol, String((exc as Error)?.message ?? exc));
      return [];
    }
  }

  private async leg(session: IbSession, req: SessionBarsRequest, leg: SessionLeg): Promise<SessionBar[]> {
    const t = req.target;
    const key = `${t.secType}|${t.symbol}|${t.exchange}|${req.barSizeSetting}|${req.durationStr}|${req.endDateTime}|${req.useRTH}|${leg}`;
    const closedSince = legClosedSince(leg, req.nowMs);
    const hit = this.idle.get(key);
    if (closedSince !== null && hit !== undefined && hit.fetchedAt >= closedSince + DELAYED_FEED_MAX_MS) return [...hit.bars];
    const contract = leg === "day" ? t : overnightContract(t);
    const raw = await session.historicalData(contract, {
      endDateTime: req.endDateTime,
      durationStr: req.durationStr,
      barSizeSetting: req.barSizeSetting,
      whatToShow: req.whatToShow,
      useRTH: req.useRTH,
    });
    const bars = (raw ?? []).map(toSessionBar);
    this.idle.delete(key);
    if (closedSince !== null) {
      this.idle.set(key, { bars, fetchedAt: req.nowMs });
      while (this.idle.size > IDLE_MAX) {
        const oldest = this.idle.keys().next().value;
        if (oldest === undefined) break;
        this.idle.delete(oldest);
      }
    }
    return bars;
  }
}
