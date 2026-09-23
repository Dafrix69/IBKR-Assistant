/** 下单页「历史相似交易」要的几样行情:标的现价、历史蝴蝶开仓那一刻的标的价、股票进场价在近期区间的位置。
 *
 * 全部尽力而为:取不到就不给,那一项不比(tradeSimilar 里没有的项不打分),**绝不让整个请求失败**。
 * 历史蝴蝶开仓时的标的价取一次就存进 trade_entry_context——历史不会变;一次请求最多补 MAX_NEW_DAYS 个交易日
 * (一个日子一次 1 分钟线请求),IBKR 的历史数据有请求频率限制,别在一张订单卡片上烧光。
 */
import { BrokerRouter } from "../broker.js";
import type { IdeaTradeFact } from "../contract/ideas.js";
import { nowEt } from "../config.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";

export class SimilarContextService extends ServiceBase {
  /** 一次最多补几个交易日的开仓标的价 */
  static readonly MAX_NEW_DAYS = 3;

  constructor(host: ServiceHost, private readonly market: MarketDataService) {
    super(host);
  }

  /** 标的现价;没连券商、取不到是 null。 */
  async spot(symbol: string): Promise<number | null> {
    return this.market.spotOf(symbol);
  }

  /**
   * 这个标的的历史蝴蝶开仓那一刻的标的价(id → 价)。先查库;缺的按开仓的美东日取那天的 1 分钟线补上并存库。
   * 只有 IBKR 能按日子取历史分钟线(富途的桥还没核对过),别的券商只用库里已有的。
   */
  async flyEntryUnderlyings(butterflies: readonly Rec[], symbol: string): Promise<Map<string, number>> {
    const tr = await import("../tradereview.js");
    const sim = await import("../tradeSimilar.js");
    const want: Array<{ id: string; when: number; day: string }> = [];
    for (const record of butterflies) {
      const profile = tr.butterflyProfile(record);
      if (profile === null || String(profile["symbol"]).toUpperCase() !== symbol) continue;
      try {
        const when = tr.entryOf(record).time;
        want.push({ id: String(record["id"] ?? ""), when, day: tr.etKey(when, true) });
      } catch (exc) {
        if (!(exc instanceof tr.ReviewError)) throw exc;
      }
    }
    const store = this.engine.store;
    const known = store.entryUnderlyings(want.map((w) => w.id));
    const router = this.router;
    if (!(router instanceof BrokerRouter) || !router.sessions().length) return known;

    const missingDays = [...new Set(want.filter((w) => !known.has(w.id)).map((w) => w.day))]
      .sort().reverse().slice(0, SimilarContextService.MAX_NEW_DAYS); // 新的优先:最近的交易最有参考价值
    for (const day of missingDays) {
      let bars: Rec[];
      try {
        bars = (await router.intradayBars(symbol, "1m", true, day)).filter((b) => String(b["time"] ?? "").startsWith(day));
      } catch {
        continue; // 这一天取不到:下次再试,这次这几笔不比中心离现价
      }
      for (const w of want.filter((x) => x.day === day && !known.has(x.id))) {
        const price = sim.priceAt(bars, w.when);
        if (price === null) continue;
        store.rememberEntryUnderlying(w.id, symbol, new Date(w.when).toISOString(), price, "ibkr 1m RTH");
        known.set(w.id, price);
      }
    }
    return known;
  }

  /**
   * 股票:现价与每段历史持仓的进场价,各自在「那之前 RANGE_LOOKBACK 根日线」高低区间里的位置。
   * 日线走 MarketDataService.dailyHistory(10 分钟缓存,一只股一次请求);只算同标的的,同板块的不算。
   */
  async stockRanges(symbol: string, facts: readonly IdeaTradeFact[]): Promise<{ query: number | null; byId: Map<string, number> }> {
    const sim = await import("../tradeSimilar.js");
    const byId = new Map<string, number>();
    let bars: Rec[];
    try {
      bars = await this.market.dailyHistory(symbol);
    } catch {
      return { query: null, byId };
    }
    const { etKey, parseWhen } = await import("../tradereview.js");
    for (const f of facts) {
      if (f.kind !== "stock" || f.symbol.toUpperCase() !== symbol || f.entry_price === null) continue;
      const when = parseWhen(f.opened_at);
      if (when === null) continue;
      const pos = sim.rangePosition(bars, etKey(when, true), f.entry_price);
      if (pos !== null) byId.set(f.id, pos);
    }
    const spot = await this.market.spotOf(symbol);
    const query = spot === null ? null : sim.rangePosition(bars, nowEt().date, spot);
    return { query, byId };
  }
}
