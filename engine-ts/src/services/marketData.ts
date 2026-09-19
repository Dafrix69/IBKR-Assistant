/** 行情缓存:K 线、日线历史、期权墙、现价。
 *
 * 这几样被 K线 PA、扫描器、价位提醒、交易分析四处共用;缓存在这里只有一份——这是**节流**不是性能优化
 * (IBKR 15 秒内的相同历史请求算超频,期权链一次几十条行情线路),各处各缓一份就等于没缓。
 */
import { BrokerError } from "../broker.js";
import { nowEt } from "../config.js";
import { RpcError } from "../rpcError.js";
import { ServiceBase } from "./host.js";
import type { Rec } from "./host.js";

export class MarketDataService extends ServiceBase {
  // (symbol|timeframe|rth) → [取回时刻, K 线]
  private readonly paCache = new Map<string, [number, Rec[]]>();
  private readonly wallCache = new Map<string, [number, Rec]>();
  // symbol → (取回时刻, 日线历史);警报算均线/52周位用,见 dailyHistory
  private readonly histCache = new Map<string, [number, Rec[]]>();

  static readonly PA_MIN_INTERVAL = 15.0; // IBKR 判定 15 秒内的相同历史请求为超频
  static readonly WALL_TTL_MS = 60_000; // 期权链一次要几十条行情线路,别让界面反复拉
  static readonly HIST_TTL_MS = 600_000; // 日线一天才多一根,反复重算不该反复打券商
  static readonly HIST_SPAN_DAYS = 420; // 250 个交易日 ≈ 360 个日历日,留假期余量

  async wallFor(symbol: string, expiry: string | null, width = 10): Promise<Rec> {
    const { OptionWallError, analyze } = await import("../optionwall.js");

    const key = `${symbol}|${expiry ?? ""}|${Math.trunc(width)}`;
    const now = performance.now();
    const hit = this.wallCache.get(key);
    if (hit && now - hit[0] < MarketDataService.WALL_TTL_MS) return hit[1];

    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32017, "计算期权墙");
    }
    let result: Rec;
    try {
      const chain = await this.router.optionChain(symbol, expiry, width);
      result = analyze(
        chain["rows"], chain["spot"], chain["expiry"], symbol,
        chain["multiplier"] ?? 100.0, nowEt().epochMs,
      );
      result["expiries"] = chain["expiries"] ?? [];
      result["spot_source"] = chain["spot_source"] ?? "quote";
    } catch (exc) {
      if (exc instanceof BrokerError || exc instanceof OptionWallError) {
        throw new RpcError(-32017, (exc as Error).message);
      }
      throw exc;
    }
    this.wallCache.set(key, [now, result]);
    return result;
  }

  /** 拉日线历史(警报算均线/52周位用),带 TTL 缓存——也是别把富途的
   * 历史 K 线额度烧在重复请求上。 */
  async dailyHistory(symbol: string): Promise<Rec[]> {
    const now = performance.now();
    const hit = this.histCache.get(symbol);
    if (hit && now - hit[0] < MarketDataService.HIST_TTL_MS) return hit[1];
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32017, "计算均线与52周位");
    }
    const end = nowEt().date;
    const startMs = Date.parse(end + "T00:00:00Z") - MarketDataService.HIST_SPAN_DAYS * 86_400_000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    let bars: Rec[];
    try {
      bars = await this.router.historicalBars(symbol, start, end);
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32017, exc.message);
      throw exc;
    }
    this.histCache.set(symbol, [now, bars]);
    return bars;
  }

  async spotOf(symbol: string): Promise<number | null> {
    if (this.router === null || !this.router.sessions().length) return null;
    try {
      if (this.settings.indexConfig(symbol)) return await this.router.indexPrice(symbol);
      const quote = ((await this.router.streamQuotes([symbol])) ?? {})[symbol] ?? {};
      return (quote["last"] as number | undefined) ?? null;
    } catch {
      return null; // 取价失败只是这一轮不检查
    }
  }

  /** 带 TTL 的 K 线缓存——这是节流,不是性能优化(IBKR 超频会掐行情连接)。 */
  async paBars(
    symbol: string, timeframe: string, rth: boolean, force = false,
  ): Promise<[Rec[], boolean]> {
    const { TIMEFRAMES } = await import("../priceaction.js");
    const spec = TIMEFRAMES[timeframe]!;
    const ttlS = force
      ? MarketDataService.PA_MIN_INTERVAL
      : Math.max(MarketDataService.PA_MIN_INTERVAL, Math.min((spec["seconds"] as number) / 10.0, 60.0));
    const key = `${symbol}|${timeframe}|${rth}`;
    const now = performance.now();
    const hit = this.paCache.get(key);
    if (hit && now - hit[0] < ttlS * 1000) return [hit[1], true];
    const bars = await this.router!.intradayBars(symbol, timeframe, rth);
    this.paCache.set(key, [now, bars]);
    return [bars, false];
  }
}
