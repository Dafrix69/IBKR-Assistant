/**
 * K 线从 IBKR 出来的那一段:日盘与夜盘两条线怎么取、怎么拼、闲着的那条怎么留着不重取;指数的盘外怎么按期货推算。
 *
 * IBKR 的历史数据按交易所给。SMART 那条(useRTH=0)是盘前 04:00 → 盘后 20:00(美东);夜盘 20:00 → 次日 03:50 是另一个
 * 交易所(OVERNIGHT),要单独再要一次,按时间拼在一起才是整夜不断的 K 线。只看常规时段、日线(夜盘不另成一天)不要夜盘。
 *
 * 指数只在常规时段计算(SPX 09:30–16:00),没有盘前盘后,也没有夜盘。要的时候(「行情」页)按配置里的期货补上盘外:
 * 每个常规时段最后一根 K 线与同一时刻的期货那根相减得基差,盘外的期货 K 线减去它前面那个收盘的基差。和引擎夜里推算
 * 指数现价是同一个口径(broker.futuresSpot:期货现价 − 上一个收盘同一时刻的基差),所以图的最后一根和蝴蝶测算的现价(options.spot)对得上;顶栏行情带那一格夜里停在昨收,不是这一路。
 *
 * 为什么要记住闲着的那条:界面每 20 秒刷一次 K 线,IBKR 把 10 分钟内超过 60 次历史请求算作超频、会掐行情连接,两条线各要一次
 * 就是翻倍。一条线关着的时候不会有新 K 线,它上一次取回来的那份照用——前提是那份是在它收盘之后、再过了延迟档最多晚到的
 * 20 分钟才取的(延迟档的最后一根要等那么久才到齐)。开着的那条每次都重取;都关着(周末)按同一条规矩,都留着。
 *
 * 第二条线(夜盘 / 期货)要不到(这个标的没有夜盘、没有期货行情权限、被拒、超时)不毁掉整次取数:只给第一条,半小时内不再去要。
 * 这一层只认合约与钟点,不认识交易日历:节假日按工作日对待,只是多取几次,不会把开着的线当成关着的。
 */
import type { PaProxy } from "./contract/priceaction.js";
import type { IbContract, IbSession, RawBar } from "./ibTypes.js";
import { DELAYED_FEED_MAX_MS, tagFeed, tagProxy } from "./marketdata.js";
import { pyRound } from "./py.js";
import { ET, pad2, wallParts, wallToEpoch, weekdayOfDate } from "./tz.js";

/** day:个股的盘前 → 盘后;overnight:个股的夜盘;index:指数的常规时段;proxy:指数关着、期货开着的那一段 */
export type SessionLeg = "day" | "overnight" | "index" | "proxy";

/** IBKR 夜盘的交易所代码(界面上叫 IBEOS / Overnight Trading)。 */
export const OVERNIGHT_EXCHANGE = "OVERNIGHT";
/** 第二条线(夜盘 / 期货)要不到之后隔多久再试。 */
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

const DAY = 1440;
const WEEK = 7 * DAY;
/** 一周里的分钟数(美东墙钟,周一 00:00 = 0)。 */
const at = (weekday: number, hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return weekday * DAY + h * 60 + m;
};
const weekdays = (from: number, to: number, f: (d: number) => [number, number]): Array<[number, number]> =>
  Array.from({ length: to - from + 1 }, (_, i) => f(from + i));

/**
 * 每条线一周里开着的几段 [起, 止)(美东墙钟的分钟数)。跨过周日 → 周一零点的那一段拆成两截,止于 WEEK 的那截不算收盘。
 * - 日盘:周一到周五 04:00–20:00。
 * - 夜盘:周日到周四的 20:00 起、到次日 04:00。
 * - 指数:周一到周五 09:30–16:00。
 * - 期货推算:指数关着、期货开着(CME 股指期货周日 18:00 → 周五 17:00)。期货每天 17:00–18:00 停一小时,
 *   这里不扣:那一小时按开着算,只是多取几次。
 */
const SCHEDULES: Record<SessionLeg, Array<[number, number]>> = {
  day: weekdays(0, 4, (d) => [at(d, "04:00"), at(d, "20:00")]),
  overnight: [[0, at(0, "04:00")], ...weekdays(0, 3, (d) => [at(d, "20:00"), at(d + 1, "04:00")] as [number, number]), [at(6, "20:00"), WEEK]],
  index: weekdays(0, 4, (d) => [at(d, "09:30"), at(d, "16:00")]),
  proxy: [
    [0, at(0, "09:30")], ...weekdays(0, 3, (d) => [at(d, "16:00"), at(d + 1, "09:30")] as [number, number]),
    [at(4, "16:00"), at(4, "17:00")], [at(6, "18:00"), WEEK],
  ],
};

function weekMinute(epochMs: number): { minute: number; monday: { year: number; month: number; day: number } } {
  const p = wallParts(epochMs, ET);
  const weekday = weekdayOfDate(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`); // 周一 = 0 … 周日 = 6
  const m = new Date(Date.UTC(p.year, p.month - 1, p.day) - weekday * 86_400_000);
  return {
    minute: weekday * DAY + p.hour * 60 + p.minute,
    monday: { year: m.getUTCFullYear(), month: m.getUTCMonth() + 1, day: m.getUTCDate() },
  };
}

/** 这条线此刻开着吗(各条线的时段见 SCHEDULES)。 */
export function legOpen(leg: SessionLeg, epochMs: number): boolean {
  const { minute } = weekMinute(epochMs);
  return SCHEDULES[leg].some(([from, to]) => minute >= from && minute < to);
}

/** 这条线上一次收盘的时刻(epoch 毫秒);此刻开着是 null。 */
export function legClosedSince(leg: SessionLeg, epochMs: number): number | null {
  if (legOpen(leg, epochMs)) return null;
  const { minute, monday } = weekMinute(epochMs);
  const wraps = SCHEDULES[leg].some(([from]) => from === 0);
  let last = Number.NEGATIVE_INFINITY;
  for (const [, to] of SCHEDULES[leg]) {
    if (to === WEEK && wraps) continue; // 周日夜里那一截接着周一零点,不是收盘
    if (to <= minute) last = Math.max(last, to);
    last = Math.max(last, to - WEEK); // 上一周的
  }
  const dayOffset = Math.floor(last / DAY);
  const inDay = last - dayOffset * DAY;
  const d = new Date(Date.UTC(monday.year, monday.month - 1, monday.day) + dayOffset * 86_400_000);
  return wallToEpoch({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: Math.floor(inDay / 60), minute: inDay % 60, second: 0,
  }, ET);
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

export interface IndexProxyResult {
  /** 指数自己的 K 线 + 推算出来的盘外 K 线,按时间排 */
  bars: SessionBar[];
  /** 推算出来的有几根 */
  derived: number;
  /** 推算段:连着的推算 K 线的首尾时刻 */
  spans: Array<{ from: string; to: string }>;
  /** 最后一根是不是推算的 */
  newestDerived: boolean;
  /** 用到的最近一个基差(期货 − 指数)与它取自哪一刻;一个都没算出来是 null */
  latestBasis: { basis: number; time: string } | null;
}

/**
 * 指数的盘外按期货推算(纯函数)。
 * - 每个常规时段(按日期分组)最后一根指数 K 线,与同一时刻的期货那根相减得这一段收盘的基差;同一时刻没有期货 K 线 → 这一段没有基差。
 * - 期货 K 线落在某一天指数的首尾之间 → 那是常规时段,用指数自己的,不推算(中间缺了几根也不拿期货补)。
 * - 其余的期货 K 线减去它**前面**最近那个收盘的基差;前面没有算得出基差的收盘,就不推算(不拿后来的基差往回套)。
 * - 推算的 K 线没有成交量(指数本来就没有)。
 */
export function proxyIndexBars(index: readonly SessionBar[], futures: readonly SessionBar[]): IndexProxyResult {
  const futByTime = new Map(futures.map((b) => [b.time, b]));
  const sessions = new Map<string, { first: string; last: SessionBar }>();
  for (const bar of index) {
    const date = bar.time.slice(0, 10);
    const s = sessions.get(date);
    if (s === undefined) sessions.set(date, { first: bar.time, last: bar });
    else {
      if (bar.time < s.first) s.first = bar.time;
      if (bar.time > s.last.time) s.last = bar;
    }
  }
  const closes = [...sessions.values()]
    .map((s) => {
      const fut = futByTime.get(s.last.time);
      const basis = fut !== undefined && fut.close > 0 && s.last.close > 0 ? pyRound(fut.close - s.last.close, 4) : null;
      return { first: s.first, last: s.last.time, basis };
    })
    .sort((a, b) => (a.last < b.last ? -1 : 1));

  const derived: SessionBar[] = [];
  let latestBasis: { basis: number; time: string } | null = null;
  for (const bar of [...futures].sort((a, b) => (a.time < b.time ? -1 : 1))) {
    const own = sessions.get(bar.time.slice(0, 10));
    if (own !== undefined && bar.time >= own.first && bar.time <= own.last.time) continue;
    let before: (typeof closes)[number] | undefined;
    for (const c of closes) {
      if (c.last < bar.time) before = c;
      else break;
    }
    if (before === undefined || before.basis === null) continue;
    const b = before.basis;
    derived.push({
      time: bar.time, open: pyRound(bar.open - b, 2), high: pyRound(bar.high - b, 2), low: pyRound(bar.low - b, 2),
      close: pyRound(bar.close - b, 2), volume: 0,
    });
    latestBasis = { basis: b, time: before.last };
  }

  const isDerived = new Set(derived.map((b) => b.time));
  const bars = mergeSessionBars(index, derived);
  const spans: Array<{ from: string; to: string }> = [];
  bars.forEach((bar, i) => {
    if (!isDerived.has(bar.time)) return;
    const prev = spans[spans.length - 1];
    if (prev !== undefined && i > 0 && bars[i - 1]!.time === prev.to) prev.to = bar.time;
    else spans.push({ from: bar.time, to: bar.time });
  });
  const newest = bars[bars.length - 1];
  return { bars, derived: derived.length, spans, newestDerived: newest !== undefined && isDerived.has(newest.time), latestBasis };
}

export interface SessionBarsRequest {
  /** 已确认的合约(SMART / 指数那张);夜盘那张由这里按代码重拼、交易所填 OVERNIGHT */
  target: IbContract;
  endDateTime: string;
  durationStr: string;
  barSizeSetting: string;
  whatToShow: string;
  useRTH: boolean;
  /** 要不要夜盘那条(个股) */
  overnight: boolean;
  /** 指数的盘外按这张期货推算;不推算是 null / 不给 */
  futures?: IbContract | null;
  /** 此刻(epoch 毫秒):判各条线开没开着 */
  nowMs: number;
}

export class SessionBars {
  /** 闲着的那条上一次取回来的那份 */
  private readonly idle = new Map<string, { bars: SessionBar[]; fetchedAt: number }>();
  /** 第二条线要不到的(标的|线)→ 什么时候再试 */
  private readonly retryAt = new Map<string, number>();
  /** 夜盘最近一次要不到的原因,按标的(给诊断看;要到了就清掉) */
  readonly overnightErrors = new Map<string, string>();
  /** 指数推算用的期货最近一次要不到的原因,按指数代码 */
  readonly proxyErrors = new Map<string, string>();

  /**
   * 取一组 K 线,并在这组 K 线上记两笔(marketdata):出自实时还是延迟档(看最后一根出自哪张合约的行情流),
   * 以及指数的盘外是怎么推算的(只有给了 futures 才记)。
   */
  async fetch(session: IbSession, req: SessionBarsRequest): Promise<SessionBar[]> {
    const futures = req.futures ?? null;
    if (futures !== null) return this.fetchIndex(session, req, futures);
    let bars: SessionBar[];
    if (!req.overnight) bars = await this.leg(session, req, "day", req.target);
    else {
      // 两条一起要,别让图多等一个来回;日盘那条失败整次失败(和以前一样),夜盘那条失败只少夜盘
      const [day, night] = await Promise.all([
        this.leg(session, req, "day", req.target),
        this.optional(session, req, "overnight", overnightContract(req.target), this.overnightErrors),
      ]);
      bars = mergeSessionBars(day, night);
    }
    return tagFeed(bars, session.quoteDelayed?.(req.target)); // 这组 K 线出自实时还是延迟档:看这张合约的行情流(会话记着)
  }

  private async fetchIndex(session: IbSession, req: SessionBarsRequest, futures: IbContract): Promise<SessionBar[]> {
    const symbol = req.target.symbol;
    const label = `${futures.symbol} ${futures.lastTradeDateOrContractMonth ?? ""}`.trim();
    const [index, fut] = await Promise.all([
      this.leg(session, req, "index", req.target),
      this.optional(session, req, "proxy", futures, this.proxyErrors),
    ]);
    const result = proxyIndexBars(index, fut);
    const error = this.proxyErrors.get(symbol) ?? null;
    const note = result.derived > 0 && result.latestBasis !== null
      ? `${symbol} 只在常规时段计算;盘外的 K 线按 ${label} 减基差推算,不是指数本身。` +
        `基差取每个常规时段最后一根 K 线与同一时刻的期货那根之差,最近一个 ${pyRound(result.latestBasis.basis, 2)} 点(${result.latestBasis.time})`
      : error !== null
        ? `${symbol} 只在常规时段计算;盘外本该按 ${label} 推算,这次没取到期货 K 线(${error.slice(0, 160)}),半小时后再试`
        : `${symbol} 只在常规时段计算;盘外本该按 ${label} 推算,这次没有对得上的期货 K 线(常规时段的最后一刻找不到同一时刻的期货那根)`;
    const proxy: PaProxy = { futures: label, derived: result.derived, note, spans: result.spans };
    tagProxy(result.bars, proxy);
    // 最后一根是推算的:它出自实时还是延迟档看期货那条行情流(引擎夜里推算现价时订着它)
    return tagFeed(result.bars, session.quoteDelayed?.(result.newestDerived ? futures : req.target));
  }

  /** 第二条线:要不到只记下原因、回空,半小时内不再去要。 */
  private async optional(
    session: IbSession, req: SessionBarsRequest, kind: SessionLeg, contract: IbContract, errors: Map<string, string>,
  ): Promise<SessionBar[]> {
    const symbol = req.target.symbol;
    const key = `${symbol}|${kind}`;
    const retryAt = this.retryAt.get(key);
    if (retryAt !== undefined && req.nowMs < retryAt) return [];
    try {
      const bars = await this.leg(session, req, kind, contract);
      this.retryAt.delete(key);
      errors.delete(symbol);
      return bars;
    } catch (exc) {
      this.retryAt.set(key, req.nowMs + OVERNIGHT_RETRY_MS);
      errors.set(symbol, String((exc as Error)?.message ?? exc));
      return [];
    }
  }

  private async leg(session: IbSession, req: SessionBarsRequest, kind: SessionLeg, contract: IbContract): Promise<SessionBar[]> {
    const c = contract;
    const key = `${c.secType}|${c.symbol}|${c.exchange}|${c.lastTradeDateOrContractMonth ?? ""}|` +
      `${req.barSizeSetting}|${req.durationStr}|${req.endDateTime}|${req.useRTH}|${kind}`;
    const closedSince = legClosedSince(kind, req.nowMs);
    const hit = this.idle.get(key);
    if (closedSince !== null && hit !== undefined && hit.fetchedAt >= closedSince + DELAYED_FEED_MAX_MS) return [...hit.bars];
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

/** 把 IBKR 的取数报错翻译成"下一步该做什么"。 */
export function barsError(symbol: string, label: string, exc: Error): string {
  const text = String(exc.message ?? exc);
  const lowered = text.toLowerCase();
  if (
    text.includes("162") || text.includes("354") ||
    lowered.includes("permission") || lowered.includes("subscri")
  ) {
    return (
      `${symbol} 没有 ${label} 的行情权限。IBKR 的历史数据同样要订阅,连延迟数据也要账户里` +
      "先开通对应交易所。去 IBKR 账户管理 → Settings → User Settings → " +
      "Market Data Subscriptions 里订阅该标的所属交易所(美股至少要一档 Level 1;" +
      `SPX / VIX / RUT 这类指数属于 Cboe,要单独订阅)。原始报错:${text.slice(0, 200)}`
    );
  }
  return `获取 ${symbol} 的 ${label} K 线失败:${text.slice(0, 300)}`;
}
