/** 重要事件的编排:拉公开日历、读写偏好表里的口径与自定义事件、合成一份清单给界面。只读、不发单。
 *
 * 纯计算在 econCalendar.ts(内置日程、日历源的解析、合并);口径见 docs/features/events.md。
 *  · 日历源(Forex Factory 本周 JSON)陈旧即返、后台刷新:4 小时一拉,失败半小时后再试;从没拉到过的那一次同步等(最多 8 秒)。
 *    它只给本周,所以一天拉几次没有意义;内置日程在断网时照样有。
 *  · 提醒的节拍不在这里:弹窗、声音、倒计时都在界面(store/events.ts),和关口提醒同一扇窗。引擎只负责"有哪些事"。
 */
import type { EconEvent, EventsConfig, EventsCrossStatus, EventsFeedStatus, EventsList } from "../contract/events.js";
import { CROSS_SYMBOLS, crossWindow, evaluateCrossMarket } from "../crossMarket.js";
import type { CrossQuote } from "../crossMarket.js";
import {
  DEFAULT_EVENTS_CONFIG, LINGER_MIN, builtinEvents, etEpoch, impactOfStars, mergeEvents, normalizeEventsConfig, parseFeed,
} from "../econCalendar.js";
import { liveTickers, macroBoard, publicQuotes } from "../macro.js";
import { RpcError } from "../rpcError.js";
import { ServiceBase } from "./host.js";
import type { ServiceHost } from "./host.js";

export type Fetcher = (url: string, timeoutMs: number) => Promise<unknown>;

/** 偏好表里存的自定义事件(不存算出来的 epoch:夏令时规则万一变了,按日期钟点重算) */
interface CustomRow {
  id: string;
  title: string;
  date_et: string;
  time_et: string;
  note: string;
  impact: "high" | "medium";
  linger_min: number;
}

async function defaultFetcher(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "dafri-trading/0.2 (event calendar)" }, signal: controller.signal });
    if (!response.ok) throw new Error(`日历源返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`日历源返回的不是 JSON(前 60 字:${text.slice(0, 60).replace(/\s+/g, " ")})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export class EventsService extends ServiceBase {
  static readonly CONFIG_PREF = "events_config";
  static readonly CUSTOM_PREF = "events_custom";
  /** 公开日历:本周所有国家的宏观事件,带影响档位与预期前值。隐私说明里有它(docs/legal/privacy.md) */
  static readonly FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  static readonly FEED_TTL_MS = 4 * 60 * 60_000;
  static readonly RETRY_MS = 30 * 60_000;
  static readonly TIMEOUT_MS = 8_000;
  /** 清单的窗口:昨天起、两周止 */
  static readonly LOOKBACK_MS = 24 * 60 * 60_000;
  static readonly HORIZON_MS = 14 * 24 * 60 * 60_000;
  static readonly MAX_CUSTOM = 50;

  private feedRows: EconEvent[] = [];
  private feedAt: number | null = null;
  private feedTriedAt: number | null = null;
  private feedError: string | null = null;
  private inflight: Promise<void> | null = null;
  /** 跨市场:最近一次判断的结果与时刻;在窗口里一分钟判一次 */
  private crossEvent: EconEvent | null = null;
  private crossAt: number | null = null;
  private crossError: string | null = null;
  private crossInflight: Promise<void> | null = null;
  static readonly CROSS_TTL_MS = 60_000;

  constructor(host: ServiceHost, public fetcher: Fetcher = defaultFetcher, private readonly now: () => number = () => Date.now()) {
    super(host);
  }

  // ---- 口径 ----------------------------------------------------------------
  config(): EventsConfig {
    try {
      return normalizeEventsConfig(this.engine.store.getPref(EventsService.CONFIG_PREF));
    } catch {
      return { ...DEFAULT_EVENTS_CONFIG, lead_minutes: [...DEFAULT_EVENTS_CONFIG.lead_minutes] }; // 手改坏了的偏好按默认
    }
  }

  setConfig(input: unknown): EventsConfig {
    // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
    const config = normalizeEventsConfig(input, this.config());
    this.engine.store.setPref(EventsService.CONFIG_PREF, config);
    this.engine.store.audit("ui", "events_config", { config });
    return config;
  }

  // ---- 自定义事件 -------------------------------------------------------------
  private customRows(): CustomRow[] {
    const raw = this.engine.store.getPref(EventsService.CUSTOM_PREF);
    if (!Array.isArray(raw)) return [];
    const out: CustomRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Partial<CustomRow>;
      if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.date_et !== "string" || typeof r.time_et !== "string") continue;
      out.push({
        id: r.id, title: r.title, date_et: r.date_et, time_et: r.time_et, note: typeof r.note === "string" ? r.note : "",
        impact: r.impact === "medium" ? "medium" : "high",
        linger_min: typeof r.linger_min === "number" && Number.isFinite(r.linger_min) ? r.linger_min : LINGER_MIN.custom,
      });
    }
    return out;
  }

  private customEvents(): EconEvent[] {
    const out: EconEvent[] = [];
    for (const r of this.customRows()) {
      const at = etEpoch(r.date_et, r.time_et);
      if (at === null) continue;
      const stars = r.impact === "medium" ? 3 : 4;
      out.push({
        id: r.id, kind: "custom", title: r.title, at, date_et: r.date_et, time_et: r.time_et, stars, impact: impactOfStars(stars), source: "custom",
        linger_min: r.linger_min, ...(r.note ? { note: r.note } : {}),
      });
    }
    return out;
  }

  add(params: { title: string; date_et: string; time_et: string; note?: string; impact?: "high" | "medium"; linger_min?: number }): EconEvent {
    const title = params.title.trim().slice(0, 80);
    if (!title) throw new RpcError(-32602, "事件要有个名字");
    const date = params.date_et.trim();
    const time = params.time_et.trim();
    const at = etEpoch(date, time);
    if (at === null) throw new RpcError(-32602, "日期要写成 2026-10-14、钟点要写成美东的 08:30");
    const linger = params.linger_min ?? LINGER_MIN.custom;
    if (!Number.isFinite(linger) || linger < 5 || linger > 24 * 60) throw new RpcError(-32602, "公布后挂多久要在 5 ~ 1440 分钟之间");
    const rows = this.customRows();
    if (rows.length >= EventsService.MAX_CUSTOM) throw new RpcError(-32602, `自定义事件最多 ${EventsService.MAX_CUSTOM} 条,先删几条`);
    const row: CustomRow = {
      id: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title, date_et: date, time_et: time, note: (params.note ?? "").trim().slice(0, 200),
      impact: params.impact === "medium" ? "medium" : "high", linger_min: Math.round(linger),
    };
    this.engine.store.setPref(EventsService.CUSTOM_PREF, [...rows, row]);
    this.engine.store.audit("ui", "events_add", { id: row.id, title: row.title, date_et: row.date_et, time_et: row.time_et });
    const event = this.customEvents().find((e) => e.id === row.id);
    if (!event) throw new RpcError(-32603, "事件没记上");
    return event;
  }

  remove(id: string): boolean {
    const rows = this.customRows();
    const rest = rows.filter((r) => r.id !== id);
    if (rest.length === rows.length) return false;
    this.engine.store.setPref(EventsService.CUSTOM_PREF, rest);
    this.engine.store.audit("ui", "events_remove", { id });
    return true;
  }

  // ---- 日历源 ----------------------------------------------------------------
  private feedStale(now: number): boolean {
    if (this.feedAt === null) return this.feedTriedAt === null || now - this.feedTriedAt >= EventsService.RETRY_MS;
    if (now - this.feedAt < EventsService.FEED_TTL_MS) return false;
    return this.feedTriedAt === null || now - this.feedTriedAt >= EventsService.RETRY_MS;
  }

  private refreshFeed(): Promise<void> {
    if (this.inflight) return this.inflight; // 单飞
    this.feedTriedAt = this.now();
    this.inflight = (async () => {
      try {
        const payload = await this.fetcher(EventsService.FEED_URL, EventsService.TIMEOUT_MS);
        if (!Array.isArray(payload)) throw new Error("日历源返回的不是清单");
        this.feedRows = parseFeed(payload);
        this.feedAt = this.now();
        this.feedError = null;
      } catch (exc) {
        this.feedError = String((exc as Error).message ?? exc).slice(0, 200);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  // ---- 跨市场跟跌套利 --------------------------------------------------------------
  /** 美股当日涨跌从行情带那一路读(连着 TWS 是流式,否则公开源);ETF 的报价连着券商问券商,否则走公开源。都失败时原因记下来,不炸。 */
  private refreshCross(now: number, config: EventsConfig): Promise<void> {
    if (this.crossInflight) return this.crossInflight;
    this.crossInflight = (async () => {
      try {
        const router = this.router !== null && this.router.sessions().length ? this.router : null;
        // macroBoard 的 router 面是同步的:异步的流式报价先取好再交给它(同 handlers/market.macroBoardMethod);取不到就这一轮走公开源
        let live: Record<string, { last?: number | null; change_pct?: number | null }> = {};
        if (router !== null) {
          try {
            live = await router.streamQuotes(liveTickers());
          } catch {
            live = {};
          }
        }
        const board = await macroBoard({ router: router === null ? null : { streamQuotes: () => live }, fetcher: this.fetcher, timeout: 4, now: () => this.now() / 1000 });
        const spx = board.rows.find((r) => r.key === "^GSPC");
        const usPct = spx?.change_pct ?? null;
        const quotes: Record<string, CrossQuote> = {};
        if (router !== null) {
          const got = await router.stockQuotes([...CROSS_SYMBOLS]);
          for (const [symbol, q] of Object.entries(got)) quotes[symbol] = { symbol, last: q.last, change_pct: q.change_pct };
        } else {
          const got = await publicQuotes(CROSS_SYMBOLS, 4, this.fetcher);
          for (const [symbol, q] of Object.entries(got)) quotes[symbol] = { symbol, last: q.last, change_pct: q.change_pct };
        }
        if (usPct === null) throw new Error(spx?.error ? `标普 500 的涨跌取不到:${spx.error}` : "标普 500 的涨跌取不到");
        const missing = CROSS_SYMBOLS.filter((s) => quotes[s]?.change_pct === null || quotes[s]?.change_pct === undefined);
        this.crossEvent = evaluateCrossMarket(usPct, quotes, now, { pct: config.cross_market_pct, lag_pct: config.cross_lag_pct });
        this.crossError = missing.length ? `这几只的报价取不到:${missing.join("、")}` : null;
      } catch (exc) {
        this.crossError = String((exc as Error).message ?? exc).slice(0, 200);
      } finally {
        this.crossAt = this.now();
        this.crossInflight = null;
      }
    })();
    return this.crossInflight;
  }

  private async cross(now: number, config: EventsConfig): Promise<{ event: EconEvent | null; status: EventsCrossStatus }> {
    const inWindow = config.cross_market && crossWindow(now) !== null;
    if (!inWindow) {
      this.crossEvent = null;
      return { event: null, status: { in_window: false, at: this.crossAt, error: null } };
    }
    if (this.crossAt === null || now - this.crossAt >= EventsService.CROSS_TTL_MS) {
      // 还没判过、或上次没判出事:同步等这一次(有时限);判出过事的旧值先给、新值后台取——界面在窗口里一分钟问一次
      if (this.crossAt === null || this.crossEvent === null) await this.refreshCross(now, config);
      else void this.refreshCross(now, config);
    }
    return { event: this.crossEvent, status: { in_window: true, at: this.crossAt, error: this.crossError } };
  }

  // ---- 清单 ------------------------------------------------------------------
  async list(force = false): Promise<EventsList> {
    const config = this.config();
    const now = this.now();
    // 整个功能关着:一条都不给(界面上就什么都不挂),日历源也不拉
    if (!config.enabled) {
      return { events: [], cross: null, cross_status: { in_window: false, at: null, error: null }, config, feed: { at: this.feedAt, error: null, count: 0 }, at: now };
    }
    if (config.feed) {
      if (force || this.feedAt === null) {
        // 用户点了刷新、或从没拉到过:同步等这一次(有时限),让第一眼就有本周的事
        if (force || this.feedStale(now)) await this.refreshFeed();
      } else if (this.feedStale(now)) {
        void this.refreshFeed(); // 旧值先给,新值后台取
      }
    }
    const from = now - EventsService.LOOKBACK_MS;
    const to = now + EventsService.HORIZON_MS;
    const feed = config.feed ? this.feedRows : [];
    // 官方日程与日历源按「最低星级」筛;自己记的不筛——记下来就是要看的
    const events = mergeEvents(builtinEvents(from, to), feed, this.customEvents())
      .filter((e) => e.at >= from && e.at <= to && (e.source === "custom" || e.stars >= config.min_stars));
    const status: EventsFeedStatus = {
      at: this.feedAt,
      error: config.feed ? this.feedError : null,
      count: events.filter((e) => e.source === "feed").length,
    };
    const cross = await this.cross(now, config);
    return { events, cross: cross.event, cross_status: cross.status, config, feed: status, at: now };
  }
}
