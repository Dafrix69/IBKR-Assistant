/** 历史交易的结局:知识总结(附带交易结果)与下单页「历史相似交易」共用这一份。
 *
 * 库里累积的券商成交 → 每笔交易的结局(交易分析页的同一批记录,同一套算法);再加上导入的期权:
 * Flex 仓位(option_positions,按行权价配好的)优先;它覆盖的 (账户, 日期) 上,按结构整理的期权事件与券商成交合成的蝴蝶都不再用,
 * 免得同一笔算两遍——Flex 仓位认得出拆腿、逐腿平仓,券商成交合成的蝴蝶认不出(会把拆过腿的当成拿到期)。
 * 只读本地库,不向券商同步新成交。没平仓的过期蝴蝶按到期日标的日线收盘结算——要连着券商取日线(10 分钟缓存,
 * 见 MarketDataService.dailyHistory),取不到就是「结果不明」。股票持仓段与交易分析页同一份(StockTripsService)。
 */
import type { IdeaTradeFact } from "../contract/ideas.js";
import type { ImportedOptionTrade, OptionPosition } from "../importedTrades.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";
import type { StockTripsService } from "./stockTrips.js";

export interface TradeHistory {
  /** 每笔的结局,新的在前,按标的筛过、封顶 MAX_TRADE_FACTS */
  facts: IdeaTradeFact[];
  /** 券商成交合成的蝴蝶记录(要比翼宽、到期、时段时用) */
  butterflies: Rec[];
  /** 导入的期权原行(要看结构名时用) */
  options: ImportedOptionTrade[];
  /** Flex 期权仓位(要比行权价、翼宽、到期时用) */
  positions: OptionPosition[];
}

export class TradeHistoryService extends ServiceBase {
  constructor(
    host: ServiceHost,
    private readonly market: MarketDataService,
    private readonly stockTrips: StockTripsService,
  ) {
    super(host);
  }

  /** `symbols` 空 = 全部标的。 */
  async load(symbols: readonly string[] = []): Promise<TradeHistory> {
    const [{ groupButterflies }, outcomes] = await Promise.all([
      import("../ibtrades.js"), import("../tradeOutcomes.js"),
    ]);
    const accounts = this.settings.accounts.map((a) => ({ alias: a.alias, account_id: a.account_id, is_paper: a.is_paper }));
    const fills = this.engine.store.listFills();
    const imports = this.engine.store.imports;
    const positions = imports.listOptionPositions();
    const byPositions = outcomes.positionDays(positions);
    const { etKey, parseWhen } = await import("../tradereview.js");
    // Flex 仓位覆盖的那几天,券商成交合成的蝴蝶让给仓位(同一笔,仓位的了结方式更准)
    const butterflies = groupButterflies(fills, accounts).filter((r) => {
      const when = parseWhen(r["created_at"]);
      return when === null || !byPositions.has(`${String((r["account"] ?? {})["account_id"] ?? "")}|${etKey(when, true)}`);
    });
    const trips = await this.stockTrips.trips(); // 连着券商时按当前持仓反推期初仓位,同交易分析页
    const now = Date.now();

    const want = new Set(symbols.map((s) => s.toUpperCase()));
    const closes = new Map<string, number>();
    const needed = outcomes.settlementsNeeded(butterflies, now).filter((n) => !want.size || want.has(n.symbol));
    for (const symbol of new Set(needed.map((n) => n.symbol))) {
      try {
        for (const bar of await this.market.dailyHistory(symbol)) {
          const close = Number(bar["close"]);
          if (Number.isFinite(close)) closes.set(`${symbol}|${String(bar["date"] ?? "")}`, close);
        }
      } catch {
        // 没连券商 / 取不到日线:这些到期的蝴蝶记成「结果不明」,原因写在每一笔的 note 里
      }
    }
    // 导入的期权(按结构整理的导出,没有行权价):同一账户同一天库里已有完整期权成交的,以完整的为准
    const paper = new Set(this.settings.accounts.filter((a) => a.is_paper).map((a) => a.account_id));
    const options = imports.listOptionTrades();
    const covered = new Set([...outcomes.optionDaysCovered(fills), ...byPositions]);
    const optionFacts = outcomes.optionFacts(options, (id) => paper.has(id), covered);
    const facts = outcomes.collectFacts(
      butterflies, trips, (s, d) => closes.get(`${s}|${d}`) ?? null, now, symbols,
      [...optionFacts, ...outcomes.positionFacts(positions, (id) => paper.has(id))],
    );
    return { facts, butterflies, options, positions };
  }
}
