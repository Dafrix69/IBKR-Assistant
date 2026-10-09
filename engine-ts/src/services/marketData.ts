/** 行情缓存:K 线、日线历史、期权墙、现价。
 *
 * 这几样被 K线 PA、扫描器、价位提醒、交易分析四处共用;缓存在这里只有一份——这是**节流**不是性能优化
 * (IBKR 15 秒内的相同历史请求算超频,期权链一次几十条行情线路),各处各缓一份就等于没缓。
 */
import { BrokerError } from "../broker.js";
import { nowEt } from "../config.js";
import type { OptionWall, WallCoverage } from "../contract/options.js";
import { feedOf } from "../marketdata.js";
import type { BarsFeed } from "../marketdata.js";
import { RpcError } from "../rpcError.js";
import { ServiceBase } from "./host.js";
import type { Rec } from "./host.js";

const count = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 这份链取了哪一段:取到数的最低与最高一档、几档;券商另给了「要订几档」与「这一段里链上一共几档」时,
 * 前者比后者少就是抽着取的(个别档合约确认不了、没回数不算抽)。
 */
export function coverageOf(strikes: readonly number[], asked: unknown, gridCount: unknown): WallCoverage {
  const grid = count(gridCount);
  const wanted = count(asked);
  return {
    lower: Math.min(...strikes), upper: Math.max(...strikes), strikes: strikes.length,
    grid_strikes: grid, thinned: grid !== null && wanted !== null && wanted < grid,
  };
}

/** 抽着取的链要说出来:远处没取的档不在净 GEX、最大痛点、墙里 */
export function thinnedWarning(coverage: WallCoverage): string[] {
  if (!coverage.thinned) return [];
  return [
    `行权价是抽着取的:${coverage.lower}–${coverage.upper} 这一段链上有 ${coverage.grid_strikes} 档,行情线路只够取其中一部分——` +
    "现价附近每档都取,越远只取越整的档。墙、净 GEX、翻转位、最大痛点只算了取到的这些。",
  ];
}

/** 一只标的此刻的价,连同它的来历(盯价位判"这一笔和上一笔接不接得上"要用)。 */
export interface SpotQuote {
  price: number;
  /** 这个价是几点成交的(秒)。券商那条报价路带了才有,没带是 null */
  tradedAt: number | null;
  /** 指数的价是哪来的:index = 官方指数,futures = 期货推算,index_stale = 期货推不出来时的上一个收盘;个股是空串 */
  source: string;
}

/** 常驻报价流的一格 → SpotQuote;没有价回 null。last_trade_at 是券商转出来的最后成交时刻(秒),没转就是没有。 */
function spotQuoteOf(quote: Rec | undefined): SpotQuote | null {
  const price = quote?.["last"];
  if (typeof price !== "number" || !(price > 0)) return null;
  const at = quote?.["last_trade_at"];
  return { price, tradedAt: typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null, source: "" };
}

export class MarketDataService extends ServiceBase {
  // (symbol|timeframe|rth) → [取回时刻(单调钟,管 TTL), K 线, 取回时刻(引擎的钟,管"最后一根收没收盘")]
  private readonly paCache = new Map<string, [number, Rec[], number]>();
  // (symbol|expiry|width|给没给 span|点名的交易类) → [取回时刻, 墙, 取的时候要的 span]
  private readonly wallCache = new Map<string, [number, OptionWall, number | null]>();
  // symbol → (取回时刻(单调钟,管 TTL), 日线历史, 取了多少个日历日, 取回时刻(引擎的钟));警报算均线/52周位用,见 dailyHistory
  private readonly histCache = new Map<string, [number, Rec[], number, number]>();

  static readonly PA_MIN_INTERVAL = 15.0; // IBKR 判定 15 秒内的相同历史请求为超频
  static readonly WALL_TTL_MS = 60_000; // 期权链一次要几十条行情线路,别让界面反复拉
  static readonly HIST_TTL_MS = 600_000; // 日线一天才多一根,反复重算不该反复打券商
  static readonly HIST_SPAN_DAYS = 420; // 250 个交易日 ≈ 360 个日历日,留假期余量

  /**
   * 一份期权墙。width = 现价上下各取多少档(也是行情线路的上限:2 × width + 1 档);
   * span = 调用方要看到现价上下各多少点——上下各 width 档盖不住时在同样的档数里抽着取(见 ibContracts.chainStrikes),
   * 不给就只按 width。缓存里那一份取的时候要的 span 不比这次小才算数。
   * preferClass = 点名要哪个交易类(见 ibContracts.pickTradingClass);只有日内剧本给,别处不给。
   */
  async wallFor(
    symbol: string, expiry: string | null, width = 10, span: number | null = null, preferClass = "",
  ): Promise<OptionWall> {
    const { OptionWallError, analyze } = await import("../optionwall.js");

    const want = span !== null && span > 0 ? span : null;
    const key = `${symbol}|${expiry ?? ""}|${Math.trunc(width)}|${want === null ? "" : "span"}|${preferClass}`;
    const now = performance.now();
    const hit = this.wallCache.get(key);
    if (hit && now - hit[0] < MarketDataService.WALL_TTL_MS && (want === null || (hit[2] ?? 0) >= want)) return hit[1];

    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32017, "计算期权墙");
    }
    let result: OptionWall;
    try {
      const chain = await this.router.optionChain(symbol, expiry, width, want, preferClass);
      const core = analyze(
        chain["rows"], chain["spot"], chain["expiry"], symbol,
        chain["multiplier"] ?? 100.0, nowEt().epochMs, String(chain["trading_class"] ?? ""),
      );
      const coverage = coverageOf(core.strikes.map((s) => s.strike), chain["strike_count"], chain["grid_count"]);
      result = {
        ...core, warnings: [...core.warnings, ...thinnedWarning(coverage)],
        expiries: chain["expiries"] ?? [], spot_source: chain["spot_source"] ?? "quote", coverage,
      };
    } catch (exc) {
      if (exc instanceof BrokerError || exc instanceof OptionWallError) {
        throw new RpcError(-32017, (exc as Error).message);
      }
      throw exc;
    }
    this.wallCache.set(key, [now, result, want]);
    return result;
  }

  /** 拉日线历史(警报算均线/52周位用),带 TTL 缓存——也是别把富途的
   * 历史 K 线额度烧在重复请求上。
   * `spanDays`:往回要多少个日历日,缺省 HIST_SPAN_DAYS,只能更长(信号成绩单要信号之前一整年的日线作基线)。
   * 缓存里那份更长时切出要的这一段给回去:要 420 天的调用方拿到的永远是 420 天,不因为别人刚取过更长的而变。 */
  async dailyHistory(symbol: string, spanDays: number = MarketDataService.HIST_SPAN_DAYS): Promise<Rec[]> {
    const span = Math.max(Math.trunc(spanDays) || 0, MarketDataService.HIST_SPAN_DAYS);
    const now = performance.now();
    const end = nowEt().date;
    const start = new Date(Date.parse(end + "T00:00:00Z") - span * 86_400_000).toISOString().slice(0, 10);
    const hit = this.histCache.get(symbol);
    if (hit && now - hit[0] < MarketDataService.HIST_TTL_MS && hit[2] >= span) {
      return hit[2] === span ? hit[1] : hit[1].filter((b) => String(b["date"] ?? b["time"] ?? "").slice(0, 10) >= start);
    }
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32017, "计算均线与52周位");
    }
    const askedAt = nowEt().epochMs;
    let bars: Rec[];
    try {
      bars = await this.router.historicalBars(symbol, start, end);
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32017, exc.message);
      throw exc;
    }
    this.histCache.set(symbol, [now, bars, span, askedAt]);
    return bars;
  }

  /**
   * 缓存里那份日线是几点取的(epoch 毫秒,发出请求的那一刻);没有缓存是 null。
   * 最后一根收没收盘要对着它判,不是对着现在:TTL 用的单调钟在电脑睡着时不走,合盖前取的那份醒来之后照样算"新鲜",
   * 而它的最后一根还是收盘前的半根。
   */
  dailyHistoryAskedAt(symbol: string): number | null {
    return this.histCache.get(symbol)?.[3] ?? null;
  }

  async spotOf(symbol: string): Promise<number | null> {
    return (await this.quoteOf(symbol))?.price ?? null;
  }

  /** 一只标的此刻的价与它的来历。指数走 indexPrice(夜盘要期货推算),出处从 spotInfo 读;取不到回 null。 */
  async quoteOf(symbol: string): Promise<SpotQuote | null> {
    if (this.router === null || !this.router.sessions().length) return null;
    try {
      if (this.settings.indexConfig(symbol)) {
        const price = await this.router.indexPrice(symbol);
        if (!price) return null;
        const info = (this.router as { spotInfo?: (s: string) => Rec | null }).spotInfo?.(symbol) ?? null;
        return { price, tradedAt: null, source: String(info?.["source"] ?? "index") };
      }
      return spotQuoteOf(((await this.router.streamQuotes([symbol])) ?? {})[symbol]);
    } catch {
      return null; // 取价失败只是这一轮不检查
    }
  }

  /**
   * 一批标的的现价与来历(盯价位那一轮用)。非指数的合成**一次** streamQuotes:常驻流建好之后它每次调用都要等一拍
   * (settle 150 ms),逐只问就是每只一拍——23 只 3.5 秒,而且占着交易道(2026-09-23 日志里 alerts.poll 稳定 3.5 秒)。
   * 指数走 indexPrice(夜盘要期货推算,口径同 quoteOf),逐只。批量那一次抛了错就退回逐只问,单只失败还是只影响那一只。
   * 取不到的给 null:这一轮不检查它。
   */
  async quotesOf(symbols: readonly string[]): Promise<Map<string, SpotQuote | null>> {
    const unique = [...new Set(symbols)];
    const out = new Map<string, SpotQuote | null>();
    if (this.router === null || !this.router.sessions().length) {
      for (const s of unique) out.set(s, null);
      return out;
    }
    const plain: string[] = [];
    for (const s of unique) {
      if (this.settings.indexConfig(s)) out.set(s, await this.quoteOf(s));
      else plain.push(s);
    }
    if (!plain.length) return out;
    let quotes: Record<string, Rec>;
    try {
      quotes = (await this.router.streamQuotes(plain)) ?? {};
    } catch {
      for (const s of plain) out.set(s, await this.quoteOf(s));
      return out;
    }
    for (const s of plain) out.set(s, spotQuoteOf(quotes[s]));
    return out;
  }

  /** 带 TTL 的 K 线缓存——这是节流,不是性能优化(IBKR 超频会掐行情连接)。
   *  第三项是这一份 K 线是几点取的(epoch 毫秒,发出请求的那一刻):最后一根收没收盘要对着它判,不是对着现在——
   *  缓存里的那一份取的时候没走完,钟点过了它也还是半根。
   *  第四项是它出自哪一档行情(券商取的时候记的,见 marketdata.tagFeed;没记是 undefined):延迟档的最后一根,
   *  钟点到了数据也未必到齐。 */
  async paBars(
    symbol: string, timeframe: string, rth: boolean, force = false,
  ): Promise<[Rec[], boolean, number, BarsFeed | undefined]> {
    const { TIMEFRAMES } = await import("../priceaction.js");
    const spec = TIMEFRAMES[timeframe]!;
    const ttlS = force
      ? MarketDataService.PA_MIN_INTERVAL
      : Math.max(MarketDataService.PA_MIN_INTERVAL, Math.min((spec["seconds"] as number) / 10.0, 60.0));
    const key = `${symbol}|${timeframe}|${rth}`;
    const now = performance.now();
    const hit = this.paCache.get(key);
    if (hit && now - hit[0] < ttlS * 1000) return [hit[1], true, hit[2], feedOf(hit[1])];
    const askedAt = nowEt().epochMs;
    const bars = await this.router!.intradayBars(symbol, timeframe, rth);
    this.paCache.set(key, [now, bars, askedAt]);
    return [bars, false, askedAt, feedOf(bars)];
  }
}
