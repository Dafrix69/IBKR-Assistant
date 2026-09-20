/** screener.*:RS 强度 / 拐点筛选 / 极值偏离。
 *  整个域已经在契约里(contract/screener.ts):入参过了 schema 才到这里,返回对着契约类型检查。 */
import { nowEt } from "../../config.js";
import type {
  RpcResult, ScreenerDeviationParams, ScreenerInflectionParams, ScreenerRsParams,
} from "../../contract/index.js";
import { RpcError, errText } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { contractMethods } from "../contractMethods.js";
import { optFloat, optInt, symbolOrRaise } from "../params.js";

export class ScreenerHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "screener.rs": (p) => this.screenerRs(p),
      "screener.inflection": (p) => this.screenerInflection(p),
      "screener.deviation": (p) => this.screenerDeviation(p),
    });
  }

  // ---- 扫描器:RS 强度 / 拐点筛选 / 极值偏离(纯代码计算,只读)------------
  // 三个方法都只是"拉 K 线 → 交给 screener.ts 算 → 原样返回"。K 线走与价位提醒 /
  // K线 PA 共用的缓存:日线 10 分钟一拉,日内周期按 PA 的节流规则。
  static readonly SCREEN_TIMEFRAMES: readonly string[] = ["1w", "1d", "1h", "30m", "15m"];
  static readonly SCREEN_INTRADAY_CAP = 40; // 日内周期一次最多拉这么多个 (标的×周期)

  /** 按板块 id 取成分股;"all" / 空 = 所有板块并集(同一只股以先出现的板块为准)。 */
  private screenMembers(params: { sector?: string }): [string, Rec[]] {
    const sectorId = String(params["sector"] ?? "").trim();
    let sectors = this.engine.store.listSectors();
    if (sectorId && sectorId !== "all") {
      sectors = sectors.filter((s) => s["id"] === sectorId);
      if (!sectors.length) throw new RpcError(-32602, `板块不存在:${sectorId}`);
    }
    const seen = new Set<string>();
    const members: Rec[] = [];
    for (const sector of sectors) {
      for (const stock of sector["stocks"] as Rec[]) {
        const symbol = String(stock["symbol"] ?? "").toUpperCase();
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        members.push({ symbol, tag: stock["tag"] || "", company: stock["company"] || "" });
      }
    }
    if (!members.length) throw new RpcError(-32602, "股票池是空的:先在「板块」页加成分股");
    const label = sectors.length !== 1 ? "全部板块" : String(sectors[0]!["name"]);
    return [label, members];
  }

  private async screenBars(symbol: string, timeframe: string): Promise<Rec[]> {
    const { resampleWeekly } = await import("../../screener.js");
    if (timeframe === "1d") return this.ctx.market.dailyHistory(symbol);
    if (timeframe === "1w") return resampleWeekly(await this.ctx.market.dailyHistory(symbol));
    const [bars] = await this.ctx.market.paBars(symbol, timeframe, false);
    return bars;
  }

  async screenerRs(params: ScreenerRsParams): Promise<RpcResult<"screener.rs">> {
    const { RS_BENCHMARKS, RS_WINDOWS, rsStrength } = await import("../../screener.js");
    const benchmark = String(params["benchmark"] ?? "SPY").trim().toUpperCase();
    if (!RS_BENCHMARKS.includes(benchmark)) {
      throw new RpcError(-32602, `基准只能是 ${RS_BENCHMARKS.join(" / ")}`);
    }
    const [label, members] = this.screenMembers(params);
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32018, "RS 强度扫描");
    }
    let bench: Rec[];
    try {
      bench = await this.ctx.market.dailyHistory(benchmark);
    } catch (exc) {
      throw new RpcError(-32018, `拿不到基准 ${benchmark} 的日线:${errText(exc)}`);
    }
    for (const member of members) {
      try {
        member["bars"] = await this.ctx.market.dailyHistory(member["symbol"]);
      } catch (exc) {
        member["bars"] = [];
        member["error"] = errText(exc);
      }
    }
    return {
      ...rsStrength(members, bench, benchmark, RS_WINDOWS),
      sector: label,
      fetched_at: new Date(nowEt().epochMs).toISOString(),
    };
  }

  async screenerInflection(params: ScreenerInflectionParams): Promise<RpcResult<"screener.inflection">> {
    const { screenInflections } = await import("../../screener.js");
    const rawTfs = params["timeframes"] || ["1d", "1w"];
    if (!Array.isArray(rawTfs) || !rawTfs.length) throw new RpcError(-32602, "timeframes 要是非空数组");
    const timeframes: string[] = [];
    for (const raw of rawTfs) {
      const tf = String(raw);
      if (!ScreenerHandlers.SCREEN_TIMEFRAMES.includes(tf)) {
        throw new RpcError(-32602, `未知周期:${tf}(可选:${ScreenerHandlers.SCREEN_TIMEFRAMES.join("、")})`);
      }
      if (!timeframes.includes(tf)) timeframes.push(tf);
    }
    const maPeriod = optInt(params["ma_period"]);
    if (maPeriod !== null && !(maPeriod >= 2 && maPeriod <= 250)) {
      throw new RpcError(-32602, "确认均线周期要在 2~250 之间");
    }
    const [label, members] = this.screenMembers(params);
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32018, "拐点筛选");
    }

    const intraday = timeframes.filter((tf) => tf !== "1d" && tf !== "1w");
    let budget = ScreenerHandlers.SCREEN_INTRADAY_CAP;
    for (const member of members) {
      member["frames"] = {};
      member["errors"] = {};
      for (const tf of timeframes) {
        if (intraday.includes(tf)) {
          if (budget <= 0) {
            member["errors"][tf] = `本次日内请求已达上限 ${ScreenerHandlers.SCREEN_INTRADAY_CAP},稍后再扫`;
            continue;
          }
          budget -= 1;
        }
        try {
          member["frames"][tf] = await this.screenBars(member["symbol"], tf);
        } catch (exc) {
          member["errors"][tf] = errText(exc);
        }
      }
    }
    return {
      ...screenInflections(members, timeframes, maPeriod),
      sector: label,
      fetched_at: new Date(nowEt().epochMs).toISOString(),
    };
  }

  async screenerDeviation(params: ScreenerDeviationParams): Promise<RpcResult<"screener.deviation">> {
    const sc = await import("../../screener.js");
    const symbol = symbolOrRaise(params);
    const timeframe = String(params["timeframe"] ?? "1d");
    if (!ScreenerHandlers.SCREEN_TIMEFRAMES.includes(timeframe)) {
      throw new RpcError(-32602, `未知周期:${timeframe}(可选:${ScreenerHandlers.SCREEN_TIMEFRAMES.join("、")})`);
    }
    const period = optInt(params["period"]) ?? sc.DEFAULT_DEV_PERIOD;
    const lookback = optInt(params["lookback"]) ?? sc.DEFAULT_DEV_LOOKBACK;
    const smooth = optInt(params["smooth"]) ?? sc.DEFAULT_PRESSURE_SMOOTH;
    const zExtreme = optFloat(params["z_extreme"]) || sc.DEFAULT_Z_EXTREME;
    if (!(period >= 2 && period <= 250) || !(lookback >= 10 && lookback <= 500) || !(smooth >= 1 && smooth <= 50)) {
      throw new RpcError(-32602, "参数越界:均线 2~250、历史 10~500、平滑 1~50");
    }
    if (!(zExtreme >= 0.5 && zExtreme <= 5.0)) throw new RpcError(-32602, "极值阈值要在 0.5~5 个标准差之间");
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32018, "极值偏离");
    }
    let bars: Rec[];
    try {
      bars = await this.screenBars(symbol, timeframe);
    } catch (exc) {
      throw new RpcError(-32018, `拿不到 ${symbol} 的 ${timeframe} K 线:${errText(exc)}`);
    }
    return {
      ...sc.deviationReview(bars, period, lookback, smooth, zExtreme),
      symbol,
      timeframe,
      fetched_at: new Date(nowEt().epochMs).toISOString(),
    };
  }
}
