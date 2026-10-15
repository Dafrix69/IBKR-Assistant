/** 信息链路的编排(docs/features/intel.md):把消息、信号、事件、单子、想法按标的串起来,给界面一条时间线和一份标的档案。只读、不发单。
 *
 *  · 频道里的每一条消息从跟单服务递过来(onSeen):信任名单里的人说的,认出提到了谁、取一次它们此刻的价、落底账;
 *    提到了自己持仓的标的时推一条 held_mention。别人的话不落盘(隐私说明里写着"只在内存里留最近 30 条")。
 *  · 时间线(feed)现算:底账、信号日志、事件清单、交易记录、想法各折成一条,合成一条线;消息上"此刻的价"按批取一次。
 *  · 档案(dossier)是一只标的此刻的一切:现价、持仓、追踪、在途单、价位、异动、板块、想法、接下来的事件、各来源的信号条数,外加它的时间线。
 *  · 取价只走已经在订着的那几路:指数走 indexPrice,股票池 / 持仓 / 盯价位的那些走常驻流。别的标的不另订行情——
 *    消息里随口提到的票每只占一条行情线路,占满了持仓的腿价就取不到。拿不到价的就没有"此刻",如实空着。
 */
import { withCombos } from "../combos.js";
import type { EconEvent } from "../contract/events.js";
import type { IntelDossier, IntelDossierParams, IntelFeed, IntelFeedParams, IntelQuote, IntelSignalCount } from "../contract/intel.js";
import type { PositionRow } from "../contract/positions.js";
import type { SignalSource } from "../contract/signals.js";
import type { DiscordMessage } from "../discordGateway.js";
import { orderText } from "../follow.js";
import { eventItem, ideaItem, mergeItems, messageItem, recordItem, signalItem } from "../intelItems.js";
import type { FollowVerdict, RecordFacts } from "../intelItems.js";
import { LOCAL_CHANNEL } from "../followInbox.js";
import { RpcError } from "../rpcError.js";
import { looksLikeOrder } from "../shorthand.js";
import { makePosition, unrealized } from "../tracker.js";
import { confidentSymbols, extractMentions, guessedSymbols, makeUniverse } from "../symbolMentions.js";
import type { MentionUniverse } from "../symbolMentions.js";
import { utcIso } from "../tz.js";
import type { AnomalyService } from "./anomaly.js";
import type { EventsService } from "./events.js";
import type { Rec, ServiceHost } from "./host.js";
import { ServiceBase } from "./host.js";
import type { MarketDataService } from "./marketData.js";

const DAY_MS = 24 * 3600_000;
/** 持仓的缓存多久一换:档案与时间线都要它,一秒里问两次不该打两次券商 */
const HELD_TTL_MS = 10_000;
/** 时间线默认往回看多久(信号、单子、想法);消息按条数取 */
const LOOKBACK_MS = 30 * DAY_MS;
const SIGNAL_WINDOW_MS = 90 * DAY_MS;
const FEED_LIMIT_DEFAULT = 150;
const FEED_LIMIT_MAX = 500;
const DOSSIER_TIMELINE_DEFAULT = 80;
/** 一条消息最多给几只标的取价 */
const PRICED_MAX = 3;

export class IntelService extends ServiceBase {
  private heldCache: { at: number; rows: PositionRow[] } | null = null;

  constructor(
    host: ServiceHost, private readonly market: MarketDataService, private readonly events: EventsService,
    private readonly anomaly: Pick<AnomalyService, "metricsOf"> | null = null, private readonly now: () => number = () => Date.now(),
  ) {
    super(host);
  }

  // ---- 持仓 ------------------------------------------------------------------
  /** 此刻的持仓(含折出来的组合行);没连券商、读失败都是空——"读不到"在这里和"没有"一样,档案上只少一节。 */
  async heldRows(): Promise<PositionRow[]> {
    const router = this.router;
    if (router === null || !router.sessions().length) {
      this.heldCache = null;
      return [];
    }
    const t = this.now();
    if (this.heldCache && t - this.heldCache.at < HELD_TTL_MS) return this.heldCache.rows;
    try {
      const rows = (withCombos(await router.positions()) as PositionRow[]).map(withPnl);
      this.heldCache = { at: t, rows };
      return rows;
    } catch {
      return this.heldCache?.rows ?? [];
    }
  }

  private connected(): boolean {
    return this.router !== null && this.router.sessions().length > 0;
  }

  // ---- 名单 ------------------------------------------------------------------
  /** 认标的用的名单:指数、别名表、持仓、追踪、股票池、板块、盯价位的。 */
  universe(held: readonly string[]): MentionUniverse {
    const store = this.engine.store;
    const known: string[] = [...Object.keys(this.settings.index_symbols), ...held];
    for (const t of store.listTracks()) known.push(t.symbol);
    for (const q of store.listQualityStocks()) known.push(q.symbol);
    for (const s of store.listSectors()) for (const x of s.stocks) known.push(x.symbol);
    for (const w of store.listWatches()) known.push(w.symbol);
    const implied = Object.keys(this.settings.index_symbols)[0] ?? "SPX";
    return makeUniverse(known, this.settings.symbol_aliases, implied);
  }

  /** 这些标的里哪些已经有行情在订着(取价不另开线路):指数、持仓、股票池、盯价位的。 */
  private streaming(held: readonly string[]): Set<string> {
    const store = this.engine.store;
    const set = new Set<string>([...Object.keys(this.settings.index_symbols), ...held]);
    for (const q of store.listQualityStocks()) if (q.enabled) set.add(q.symbol);
    for (const w of store.listWatches()) if (w.enabled) set.add(w.symbol);
    return set;
  }

  private async pricesOf(symbols: readonly string[], held: readonly string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (!this.connected() || !symbols.length) {
      for (const s of symbols) out.set(s, null);
      return out;
    }
    const ok = this.streaming(held);
    const ask = symbols.filter((s) => ok.has(s));
    for (const s of symbols) if (!ok.has(s)) out.set(s, null);
    if (!ask.length) return out;
    const quotes = await this.market.quotesOf(ask);
    for (const s of ask) out.set(s, quotes.get(s)?.price ?? null);
    return out;
  }

  // ---- 一条消息 ----------------------------------------------------------------
  /**
   * 跟单服务看到频道里的每一条消息都递到这里(信任与否都递)。只有信任名单里的人说的才落底账:频道里别人的话只在跟单服务的内存里
   * 留最近 30 条,不落盘(docs/legal/privacy.md 写着)。落底账、取价、必要时推事件;出错只记 stderr。
   */
  async record(message: DiscordMessage, trusted: boolean): Promise<void> {
    if (!trusted) return;
    try {
      const store = this.engine.store;
      if (store.messages.has(message.id)) return;
      const heldRows = await this.heldRows();
      const held = [...new Set(heldRows.map((r) => r.symbol))];
      const mentions = extractMentions(message.content, this.universe(held));
      const symbols = confidentSymbols(mentions);
      const prices: Record<string, number> = {};
      for (const [s, p] of await this.pricesOf(symbols.slice(0, PRICED_MAX), held)) if (p !== null) prices[s] = p;
      const added = store.messages.add({
        at: utcIso(Math.floor(message.sentAtMs / 1000) * 1000),
        source: message.channel_id === LOCAL_CHANNEL ? "local" : "discord",
        message_id: message.id, author_id: message.author_id, author_name: message.author_name, text: message.content,
        symbols, guesses: guessedSymbols(mentions), trusted, prices,
      });
      if (!added) return;
      const mine = symbols.filter((s) => held.includes(s));
      if (trusted && mine.length) {
        this.emit("intel", {
          kind: "held_mention", message_id: message.id, at: message.sentAtMs, author_name: message.author_name, text: message.content.slice(0, 200),
          symbols: mine, prices,
        });
      } else {
        this.emit("intel", { kind: "message", message_id: message.id, symbols });
      }
    } catch (exc) {
      process.stderr.write(`[intel] 记消息 ${message.id} 出错:${String((exc as Error).message ?? exc)}\n`);
    }
  }

  // ---- 时间线 ------------------------------------------------------------------
  private verdicts(ids: readonly string[]): Map<string, FollowVerdict> {
    return this.engine.store.follow.verdictsFor(ids);
  }

  private recordFacts(limit: number): RecordFacts[] {
    const out: RecordFacts[] = [];
    for (const r of this.engine.store.listRecords(limit) as Rec[]) {
      const ibkr = (r["ibkr"] ?? {}) as Rec;
      const timeline = Array.isArray(ibkr["status_timeline"]) ? (ibkr["status_timeline"] as Rec[]) : [];
      const last = timeline[timeline.length - 1];
      out.push({
        id: String(r["id"] ?? ""), created_at: String(r["created_at"] ?? ""), symbol: String((r["contract"] ?? {})["symbol"] ?? "").toUpperCase(),
        action: String((r["order"] ?? {})["action"] ?? ""), quantity: Number((r["order"] ?? {})["quantity"]) || null,
        account: String((r["account"] ?? {})["alias"] ?? ""), intent_summary: String((r["llm"] ?? {})["intent_summary"] ?? ""),
        raw_instruction: String((r["input"] ?? {})["raw_instruction"] ?? ""), final_status: (r["final_status"] as string | null) ?? null,
        last_status: last ? String(last["status"] ?? "") || null : null,
        fills: Array.isArray(ibkr["fills"]) ? (ibkr["fills"] as unknown[]).length : 0,
        avg_fill_price: typeof ibkr["avg_fill_price"] === "number" ? (ibkr["avg_fill_price"] as number) : null,
        channel: String((r["input"] ?? {})["input_channel"] ?? ""),
      });
    }
    return out;
  }

  private async eventRows(): Promise<EconEvent[]> {
    try {
      return (await this.events.list(false)).events;
    } catch {
      return [];
    }
  }

  private eventSymbols(event: EconEvent, universe: MentionUniverse): string[] {
    if (event.source !== "custom") return Object.keys(this.settings.index_symbols).length ? Object.keys(this.settings.index_symbols) : ["SPX"];
    return confidentSymbols(extractMentions(`${event.title} ${event.note ?? ""}`, { ...universe, implied: null }));
  }

  async feed(params: IntelFeedParams): Promise<IntelFeed> {
    const limit = clampLimit(params.limit, FEED_LIMIT_DEFAULT);
    const symbol = params.symbol ? params.symbol.trim().toUpperCase() : null;
    if (params.symbol !== undefined && symbol !== null && !/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new RpcError(-32602, "股票代码不合法");
    const nowMs = this.now();
    const heldRows = await this.heldRows();
    const held = [...new Set(heldRows.map((r) => r.symbol))];
    const heldSet = new Set(held);
    const store = this.engine.store;
    const universe = this.universe(held);
    const sinceIso = new Date(nowMs - LOOKBACK_MS).toISOString();

    const rows = store.messages.recent({ limit: Math.min(limit * 2, 1000), symbol });
    const verdicts = this.verdicts(rows.map((r) => r.message_id));
    const priceSymbols = [...new Set(rows.flatMap((r) => (r.symbols[0] && typeof r.prices[r.symbols[0]] === "number" ? [r.symbols[0]] : [])))];
    const nowPrices = await this.pricesOf(priceSymbols, held);
    const messages = rows.map((r) => {
      const text = orderText(r.text);
      return messageItem(r, verdicts.get(r.message_id) ?? null, heldSet, nowPrices, looksLikeOrder(text) ? text : null);
    });
    const signals = store.signals.listWithSeq(sinceIso, 2000).map((s) => signalItem(s, heldSet));
    const events = (await this.eventRows()).map((e) => eventItem(e, this.eventSymbols(e, universe), heldSet, nowMs));
    const orders = this.recordFacts(300).filter((r) => Date.parse(r.created_at) >= nowMs - LOOKBACK_MS).map((r) => recordItem(r, heldSet));
    const ideas = store.listIdeas(null, 200).map((i) => ideaItem(i, confidentSymbols(extractMentions(i.text, { ...universe, implied: null })), heldSet));

    const items = mergeItems([messages, signals, events, orders, ideas], {
      symbol, kinds: params.kinds ?? null, heldOnly: Boolean(params.held_only), since: params.since ?? null, limit,
    });
    return { items, held, total_messages: store.messages.count(), at: nowMs, connected: this.connected() };
  }

  // ---- 档案 --------------------------------------------------------------------
  private async quoteFor(symbol: string, held: readonly string[]): Promise<IntelQuote | null> {
    if (!this.connected()) return null;
    const isIndex = this.settings.indexConfig(symbol) !== null;
    if (isIndex) {
      const q = await this.market.quoteOf(symbol);
      return q ? { price: q.price, change_pct: null, source: q.source || "index" } : null;
    }
    if (!this.streaming(held).has(symbol)) {
      // 没在订的票不另开线路:给最近两根日线的收盘(缓存 10 分钟)
      try {
        const bars = (await this.market.dailyHistory(symbol)).filter((b) => Number(b["close"]) > 0);
        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        if (!last) return null;
        const close = Number(last["close"]);
        const pc = prev ? Number(prev["close"]) : null;
        return { price: close, change_pct: pc ? Math.round(((close - pc) / pc) * 10000) / 100 : null, source: "daily_close" };
      } catch {
        return null;
      }
    }
    const q = await this.market.quoteOf(symbol);
    if (!q) return null;
    const hit = this.anomaly?.metricsOf(symbol);
    const change = hit?.metrics?.change_pct ?? null;
    return { price: q.price, change_pct: typeof change === "number" ? change : null, source: "quote" };
  }

  async dossier(params: IntelDossierParams): Promise<IntelDossier> {
    const symbol = String(params.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new RpcError(-32602, "股票代码不合法");
    const nowMs = this.now();
    const store = this.engine.store;
    const heldRows = await this.heldRows();
    const held = [...new Set(heldRows.map((r) => r.symbol))];
    const positions = heldRows.filter((r) => r.symbol === symbol);
    const tracks = store.listTracks().filter((t) => t.symbol.toUpperCase() === symbol);
    const working = store.listWorkingRecords(7, nowMs).filter((w) => w.symbol.toUpperCase() === symbol).slice(0, 20).map((w) => {
      const r = (store.getRecord(w.id) ?? {}) as Rec;
      return {
        id: w.id, at: w.createdAtMs ? utcIso(w.createdAtMs) : "", status: w.lastStatus,
        summary: String((r["llm"] ?? {})["intent_summary"] ?? (r["input"] ?? {})["raw_instruction"] ?? ""),
        account: String((r["account"] ?? {})["alias"] ?? ""),
      };
    });
    const sectors = store.listSectors().filter((s) => s.stocks.some((x) => x.symbol.toUpperCase() === symbol)).map((s) => s.name);
    const w = store.listWatches().find((x) => x.symbol.toUpperCase() === symbol);
    const watch = w ? { enabled: w.enabled, levels: w.levels, last_price: w.last_price, events: w.events.slice(-10) } : null;
    const q = store.listQualityStocks().find((x) => x.symbol.toUpperCase() === symbol);
    const hit = q ? this.anomaly?.metricsOf(symbol) : undefined;
    const quality = q ? { enabled: q.enabled === 1, events: q.events.slice(-10), change_pct: hit?.metrics?.change_pct ?? null } : null;
    const universe = this.universe(held);
    const ideas = store.listIdeas(null, 500).filter((i) =>
      i.symbols.some((s) => s.toUpperCase() === symbol) || confidentSymbols(extractMentions(i.text, { ...universe, implied: null })).includes(symbol),
    ).slice(0, 20);
    const isIndex = this.settings.indexConfig(symbol) !== null;
    const events = (await this.eventRows()).filter((e) => e.at >= nowMs - 2 * 3600_000 && (isIndex ? e.source !== "custom" : this.eventSymbols(e, universe).includes(symbol)));
    const counts = new Map<SignalSource, IntelSignalCount>();
    for (const s of store.signals.list(new Date(nowMs - SIGNAL_WINDOW_MS).toISOString(), 20_000)) {
      if (s.symbol.toUpperCase() !== symbol) continue;
      const c = counts.get(s.source);
      if (c) {
        c.n += 1;
        if (s.at > c.last_at) c.last_at = s.at;
      } else counts.set(s.source, { source: s.source, n: 1, last_at: s.at });
    }
    const timeline = (await this.feed({ symbol, limit: clampLimit(params.limit, DOSSIER_TIMELINE_DEFAULT) })).items;
    return {
      symbol, quote: await this.quoteFor(symbol, held), held: held.includes(symbol), positions, tracks, working, sectors, watch, quality, ideas,
      events, signals: [...counts.values()].sort((a, b) => b.n - a.n),
      mentions_7d: store.messages.countSince(new Date(nowMs - 7 * DAY_MS).toISOString(), symbol),
      timeline, at: nowMs, connected: this.connected(),
    };
  }
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(FEED_LIMIT_MAX, Math.floor(n));
}

/**
 * 券商没报盈亏、手上有现价时,按追踪器同一套口径本地算一份(positions.list 也这么补):档案上的盈亏和持仓追踪页对得上。
 * 券商报了的照用;没有现价的照旧空着。
 */
function withPnl(row: PositionRow): PositionRow {
  const price = row.market_price ?? null;
  if ((row.unrealized_pnl ?? null) !== null || price === null) return row;
  const out = unrealized(makePosition({
    account: row.account, symbol: row.symbol, sec_type: row.sec_type, quantity: Number(row.quantity) || 0,
    avg_cost: Number(row.avg_cost) || 0, multiplier: Number(row.multiplier) || 1, currency: row.currency, market_price: price,
  }), price);
  return { ...row, unrealized_pnl: out.unrealized_pnl, unrealized_pct: out.unrealized_pct, pnl_source: "computed" };
}

