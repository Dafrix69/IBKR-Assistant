/** 下单页「历史相似交易」要的几样行情:标的现价、历史蝴蝶开仓那一刻的标的价、股票进场价在近期区间的位置。
 *
 * 全部尽力而为:取不到就不给,那一项不比(tradeSimilar 里没有的项不打分),**绝不让整个请求失败**。
 * 历史蝴蝶(券商成交合成的,和 Flex 期权仓位里的)开仓时的标的价取一次就存进 trade_entry_context——历史不会变。
 * 一个开仓日一次 1 分钟线请求:这次请求当场补最近的 MAX_NEW_DAYS 天,剩下的交给后台按 backfillGapMs 的间隔慢慢补
 * (IBKR 的历史数据有请求频率限制,不能在一张订单卡片上烧光;Flex 一导进来就是几十个交易日)。
 */
import { BrokerRouter } from "../broker.js";
import type { IdeaTradeFact } from "../contract/ideas.js";
import { nowEt } from "../config.js";
import type { OptionPosition } from "../importedTrades.js";
import { ServiceBase } from "./host.js";
import type { Rec, ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";

/** 要补开仓时标的价的一笔:id、开仓时刻、开仓的美东日 */
interface EntryTarget {
  id: string;
  when: number;
  day: string;
}

export class SimilarContextService extends ServiceBase {
  /** 一次请求当场最多补几个交易日 */
  static readonly MAX_NEW_DAYS = 3;
  /** 后台补的时候两次请求之间隔多久(IBKR 历史数据:同类请求 15 秒内别重复,10 分钟 60 次封顶) */
  backfillGapMs = 8_000;
  private backfilling: Promise<void> | null = null;

  constructor(host: ServiceHost, private readonly market: MarketDataService) {
    super(host);
  }

  /** 标的现价;没连券商、取不到是 null。 */
  async spot(symbol: string): Promise<number | null> {
    return this.market.spotOf(symbol);
  }

  /** 等后台补完(测试用;平时不用等它)。 */
  async idle(): Promise<void> {
    while (this.backfilling !== null) await this.backfilling;
  }

  /**
   * 这个标的的历史蝴蝶开仓那一刻的标的价(id → 价):券商成交合成的蝴蝶 + Flex 仓位里有中心的那些。先查库;
   * 缺的按开仓的美东日取那天的 1 分钟线补上并存库。只有 IBKR 能按日子取历史分钟线(富途的桥还没核对过),别的券商只用库里已有的。
   */
  async flyEntryUnderlyings(
    butterflies: readonly Rec[], positions: readonly OptionPosition[], symbol: string,
  ): Promise<Map<string, number>> {
    const tr = await import("../tradereview.js");
    const want: EntryTarget[] = [];
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
    for (const p of positions) {
      if (p.symbol !== symbol || p.center === null) continue; // 只有带中心的(蝴蝶一类)才比中心离现价
      const when = tr.parseWhen(p.open_et);
      if (when !== null) want.push({ id: p.id, when, day: p.open_et.slice(0, 10) });
    }
    const known = this.engine.store.imports.entryUnderlyings(want.map((w) => w.id));
    const router = this.router;
    if (!(router instanceof BrokerRouter) || !router.sessions().length) return known;

    // 新的优先:最近的交易最有参考价值
    const missingDays = [...new Set(want.filter((w) => !known.has(w.id)).map((w) => w.day))].sort().reverse();
    for (const day of missingDays.slice(0, SimilarContextService.MAX_NEW_DAYS)) {
      await this.fillDay(router, symbol, day, want, known);
    }
    const rest = missingDays.slice(SimilarContextService.MAX_NEW_DAYS);
    if (rest.length && this.backfilling === null) {
      this.backfilling = this.backfill(symbol, rest, want).finally(() => { this.backfilling = null; });
    }
    return known;
  }

  /** 后台一天一天补;券商换了或断了就停,下次打开卡片再接着补。错误一律吞掉(这是锦上添花)。 */
  private async backfill(symbol: string, days: readonly string[], want: readonly EntryTarget[]): Promise<void> {
    for (const day of days) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, this.backfillGapMs); t.unref?.(); });
      const router = this.router;
      if (!(router instanceof BrokerRouter) || !router.sessions().length) return;
      try {
        const known = this.engine.store.imports.entryUnderlyings(want.filter((w) => w.day === day).map((w) => w.id));
        await this.fillDay(router, symbol, day, want, known);
      } catch {
        return;
      }
    }
  }

  /** 取某一天的 1 分钟线,把那天开仓、还没存的几笔补上。取不到就算了,下次再试。 */
  private async fillDay(
    router: BrokerRouter, symbol: string, day: string, want: readonly EntryTarget[], known: Map<string, number>,
  ): Promise<void> {
    const todo = want.filter((w) => w.day === day && !known.has(w.id));
    if (!todo.length) return;
    const sim = await import("../tradeSimilar.js");
    let bars: Rec[];
    try {
      bars = (await router.intradayBars(symbol, "1m", true, day)).filter((b) => String(b["time"] ?? "").startsWith(day));
    } catch {
      return;
    }
    for (const w of todo) {
      const price = sim.priceAt(bars, w.when);
      if (price === null) continue;
      this.engine.store.imports.rememberEntryUnderlying(w.id, symbol, new Date(w.when).toISOString(), price, "ibkr 1m RTH");
      known.set(w.id, price);
    }
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
