/** 重要事件的编排:拉公开日历、读写偏好表里的口径与自定义事件、合成一份清单给界面。只读、不发单。
 *
 * 纯计算在 econCalendar.ts(内置日程、日历源的解析、合并);口径见 docs/features/events.md。
 *  · 日历源(Forex Factory 本周 JSON)陈旧即返、后台刷新:4 小时一拉,失败半小时后再试;从没拉到过的那一次同步等(最多 8 秒)。
 *    它只给本周,所以一天拉几次没有意义;内置日程在断网时照样有。
 *  · 提醒的节拍不在这里:弹窗、声音、倒计时都在界面(store/events.ts),和关口提醒同一扇窗。引擎只负责"有哪些事"。
 */
import type { EconEvent, EventsConfig, EventsFeedStatus, EventsList } from "../contract/events.js";
import {
  DEFAULT_EVENTS_CONFIG, LINGER_MIN, builtinEvents, etEpoch, mergeEvents, normalizeEventsConfig, parseFeed,
} from "../econCalendar.js";
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
  private feedRaw: unknown = null;
  private feedAt: number | null = null;
  private feedTriedAt: number | null = null;
  private feedError: string | null = null;
  private inflight: Promise<void> | null = null;

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
    // 中等影响的开关变了,日历源那份要重新按新口径解析
    if (this.feedRaw !== null) this.feedRows = parseFeed(this.feedRaw, config.medium);
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
      out.push({
        id: r.id, kind: "custom", title: r.title, at, date_et: r.date_et, time_et: r.time_et, impact: r.impact, source: "custom",
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

  private refreshFeed(medium: boolean): Promise<void> {
    if (this.inflight) return this.inflight; // 单飞
    this.feedTriedAt = this.now();
    this.inflight = (async () => {
      try {
        const payload = await this.fetcher(EventsService.FEED_URL, EventsService.TIMEOUT_MS);
        const rows = parseFeed(payload, medium);
        if (!Array.isArray(payload)) throw new Error("日历源返回的不是清单");
        this.feedRaw = payload;
        this.feedRows = rows;
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

  // ---- 清单 ------------------------------------------------------------------
  async list(force = false): Promise<EventsList> {
    const config = this.config();
    const now = this.now();
    // 整个功能关着:一条都不给(界面上就什么都不挂),日历源也不拉
    if (!config.enabled) return { events: [], config, feed: { at: this.feedAt, error: null, count: 0 }, at: now };
    if (config.feed) {
      if (force || this.feedAt === null) {
        // 用户点了刷新、或从没拉到过:同步等这一次(有时限),让第一眼就有本周的事
        if (force || this.feedStale(now)) await this.refreshFeed(config.medium);
      } else if (this.feedStale(now)) {
        void this.refreshFeed(config.medium); // 旧值先给,新值后台取
      }
    }
    const from = now - EventsService.LOOKBACK_MS;
    const to = now + EventsService.HORIZON_MS;
    const feed = config.feed ? this.feedRows : [];
    const events = mergeEvents(builtinEvents(from, to), feed, this.customEvents()).filter((e) => e.at >= from && e.at <= to);
    const status: EventsFeedStatus = {
      at: this.feedAt,
      error: config.feed ? this.feedError : null,
      count: events.filter((e) => e.source === "feed").length,
    };
    return { events, config, feed: status, at: now };
  }
}
