/** SPX 日内剧本的编排:什么时候取哪一条预期波动区间、把现价喂给状态机、事件推给界面。只读行情,不下单。
 *
 * 纯计算在 playbook.ts,底账在 playbookLog.ts;口径见 docs/features/playbook.md。几条规矩:
 * * **三条区间各有各的时刻。** 昨日口径在收盘后十分钟取(那时今天的期权已经收了,取的是下一个交易日到期的跨式),
 *   写进下一个交易日的底账;盘初口径在 09:35 取一次;当前口径从 09:35 起每五分钟取一次。
 * * **没赶上的补。** 软件在 16:10 或 09:35 没开着,就拿那一分钟的历史中间价补一份,标成 backfill。补不到就空着并写明原因,不拿别的时刻的价顶替。
 * * **只在连着 IBKR、常规时段里动。** 别的时候一条行情都不订,原因写在 idle_reason 里。
 * * 出了错吞掉、记进 last_error,循环不停。默认开着;开关存在库的偏好表里。
 */
import * as path from "node:path";

import { barTimestamp } from "../broker.js";
import { etNowFromEpoch, nowEt } from "../config.js";
import type { EtNow } from "../config.js";
import type {
  OptionWall, PlaybookAccel, PlaybookBand, PlaybookEvent, PlaybookSnapshot, PlaybookWall,
} from "../contract/options.js";
import { silenceLimitMs } from "../heldStreams.js";
import { indexContract, optionContract } from "../ibContracts.js";
import type { IbSession } from "../ibTypes.js";
import type { OptionMarkStreams } from "../optionMarks.js";
import { accelerator, atmStrike, legMid, makeBand, newMachine, stepMachine, targets } from "../playbook.js";
import type { PlaybookMachine } from "../playbook.js";
import { PlaybookLog } from "../playbookLog.js";
import { dateOrdinal, ET, ibEndUtc, ordinalToDate, pad2, wallToEpoch } from "../tz.js";
import { ServiceBase } from "./host.js";
import type { ServiceHost } from "./host.js";
import type { MarketDataService } from "./marketData.js";

/** 这里用到的券商那几样(只在生效券商是 IBKR 时才走到) */
interface PlaybookBroker {
  indexPrice(symbol: string): Promise<number | null>;
  spotInfo(symbol: string): Record<string, unknown> | null;
  marketSession(): IbSession;
  historicalBars(symbol: string, start: string, end: string): Promise<Array<Record<string, unknown>>>;
}

type BandKind = "prior" | "open" | "current" | "wall";

interface Day {
  date: string;
  prior: PlaybookBand | null;
  open: PlaybookBand | null;
  current: PlaybookBand | null;
  machine: PlaybookMachine;
  events: PlaybookEvent[];
  wall: PlaybookWall | null;
  accel: PlaybookAccel | null;
  /** 哪一样为什么还没有 */
  notes: Partial<Record<BandKind, string>>;
  /** 当前区间取到了第几个五分钟格 */
  frameSlot: number | null;
  /** 上一次试着取 / 补是什么时候(失败之后别每五秒再来一遍) */
  triedAt: Partial<Record<BandKind, number>>;
}

export class PlaybookService extends ServiceBase {
  static readonly PREF = "playbook";
  static readonly SYMBOL = "SPX";
  /** 循环多久看一眼现价 */
  static readonly TICK_MS = 5_000;
  /** 当前区间多久重取一次(分钟) */
  static readonly FRAME_MIN = 5;
  /** 盘初口径的时刻(美东当日分钟数) */
  static readonly OPEN_MIN = 9 * 60 + 35;
  /** 昨日口径:收盘后多少分钟取,以及这个窗口开多久(SPX 期权比指数晚收一刻钟) */
  static readonly PRIOR_DELAY_MIN = 10;
  static readonly PRIOR_WINDOW_MIN = 5;
  /** 取盘口失败后隔多久再试;补历史价失败后隔多久再试(历史请求有频率限制) */
  static readonly RETRY_MS = 30_000;
  static readonly BACKFILL_RETRY_MS = 10 * 60_000;
  /** 期权墙取现价上下各多少档(券商那边的上限,见 BrokerRouter.CHAIN_MAX_WIDTH) */
  static readonly WALL_WIDTH = 15;
  static readonly MAX_EVENTS = 50;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private running = false;
  private chain: Promise<unknown> = Promise.resolve();
  private day: Day | null = null;
  private price: number | null = null;
  private priceAt: number | null = null;
  private idleReason = "";
  private lastError = "";

  constructor(host: ServiceHost, private readonly marks: OptionMarkStreams, private readonly market: MarketDataService) {
    super(host);
  }

  private log(): PlaybookLog {
    return new PlaybookLog(path.join(path.dirname(this.settings.db_path), "playbook"));
  }

  // ---- 开关 ----------------------------------------------------------------
  enabled(): boolean {
    try {
      const raw = this.engine.store.getPref(PlaybookService.PREF) as { enabled?: unknown } | null;
      return raw === null ? true : raw.enabled !== false;
    } catch {
      return true; // 库打不开时别的地方会报;这里不因为它把循环弄挂
    }
  }

  setEnabled(on: boolean): PlaybookSnapshot {
    this.engine.store.setPref(PlaybookService.PREF, { enabled: on });
    if (!on) this.idleReason = "已关闭";
    return this.snapshot();
  }

  // ---- 循环 ----------------------------------------------------------------
  start(tickMs: number = PlaybookService.TICK_MS): void {
    if (this.running) return;
    const gen = ++this.gen;
    this.running = true;
    const schedule = (delay: number): void => {
      const timer = setTimeout(() => void loop(), delay);
      timer.unref?.(); // 界面关了引擎该退就退,不能被它吊着
      this.timer = timer;
    };
    const loop = async (): Promise<void> => {
      await this.tickOnce().catch(() => undefined);
      if (gen !== this.gen || !this.running) return;
      schedule(tickMs);
    };
    schedule(tickMs);
  }

  stop(): void {
    this.gen += 1;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 看一眼:该取区间就取,有现价就喂状态机。返回这一轮报出来的事件 */
  tickOnce(nowMs?: number): Promise<PlaybookEvent[]> {
    const run = this.chain.then(() => this.tickInner(nowMs ?? nowEt().epochMs));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private idle(reason: string): PlaybookEvent[] {
    this.idleReason = reason;
    return [];
  }

  private closeMin(date: string): number {
    return this.settings.early_close_days.includes(date) ? 13 * 60 : 16 * 60;
  }

  private nextTradingDay(date: string): string | null {
    let ordinal = dateOrdinal(date);
    for (let i = 0; i < 14; i += 1) {
      ordinal += 1;
      const d = ordinalToDate(ordinal);
      if (this.settings.isTradingDay(d)) return d;
    }
    return null;
  }

  private prevTradingDay(date: string): string | null {
    let ordinal = dateOrdinal(date);
    for (let i = 0; i < 14; i += 1) {
      ordinal -= 1;
      const d = ordinalToDate(ordinal);
      if (this.settings.isTradingDay(d)) return d;
    }
    return null;
  }

  /** 这一天的状态:内存里是它就用;不是(新的一天、引擎重启过)从底账里捡回来 */
  private dayFor(date: string): Day {
    if (this.day?.date === date) return this.day;
    const day: Day = {
      date, prior: null, open: null, current: null, machine: newMachine(), events: [],
      wall: null, accel: null, notes: {}, frameSlot: null, triedAt: {},
    };
    for (const record of this.log().read(date)) {
      if (record.kind === "event") {
        day.events.push(record.event);
        continue;
      }
      if (record.kind === "prior") day.prior = record.band;
      else if (record.kind === "open") day.open = record.band;
      else day.current = record.band;
    }
    // 重启之后接着上一条进入 / 失效往下判,不然每次重启都把同一个「进入 B3」再报一遍
    const last = [...day.events].reverse().find((e) => e.kind !== "accel");
    if (last?.kind === "enter") day.machine = { ...day.machine, state: last.state, trigger: last.level, since: last.at };
    for (const e of day.events) day.machine.fired[`${e.kind}|${e.state}|${e.level}`] = e.at;
    day.events = day.events.slice(-PlaybookService.MAX_EVENTS);
    this.day = day;
    this.price = null;
    this.priceAt = null;
    return day;
  }

  private async tickInner(nowMs: number): Promise<PlaybookEvent[]> {
    try {
      if (!this.enabled()) return this.idle("已关闭");
      const router = this.router;
      if (router === null || !router.sessions().length) return this.idle("没连券商");
      if (this.settings.broker.provider !== "ibkr") return this.idle("期权行情只从 IBKR 取");
      const symbol = PlaybookService.SYMBOL;
      const cfg = this.settings.indexConfig(symbol);
      if (cfg === null) return this.idle(`配置里没有 ${symbol} 这个指数`);
      const et = etNowFromEpoch(nowMs);
      if (!this.settings.isTradingDay(et.date)) return this.idle("今天不是交易日");
      const broker = router as unknown as PlaybookBroker;
      const closeMin = this.closeMin(et.date);

      const afterClose = et.minutes - closeMin;
      if (afterClose >= PlaybookService.PRIOR_DELAY_MIN && afterClose < PlaybookService.PRIOR_DELAY_MIN + PlaybookService.PRIOR_WINDOW_MIN) {
        await this.capturePrior(broker, et);
        return this.idle("不在常规交易时段");
      }
      if (this.settings.marketStatus(et) !== "盘中") return this.idle("不在常规交易时段");

      const day = this.dayFor(et.date);
      if (day.prior === null) await this.backfillPrior(broker, day, nowMs);
      if (et.minutes < PlaybookService.OPEN_MIN) return this.idle("等 09:35 的盘初定价");

      const spot = await broker.indexPrice(symbol);
      const info = broker.spotInfo(symbol);
      if (spot === null || !(spot > 0) || info?.["source"] !== "index") return this.idle("拿不到现价");
      this.price = spot;
      this.priceAt = nowMs;

      const slot = Math.floor(et.minutes / PlaybookService.FRAME_MIN);
      const firstSlot = slot === Math.floor(PlaybookService.OPEN_MIN / PlaybookService.FRAME_MIN);
      if (day.open === null && !firstSlot) await this.backfillOpen(broker, day, nowMs);
      if (day.frameSlot !== slot && this.due(day, "current", nowMs, PlaybookService.RETRY_MS)) {
        const band = await this.liveBand(broker, et.date.replace(/-/g, ""), spot, nowMs, "盘中");
        if (typeof band === "string") {
          day.notes.current = `当前区间没取到:${band}`;
        } else {
          day.frameSlot = slot;
          day.current = band;
          delete day.notes.current;
          this.log().append(day.date, { kind: "frame", band });
          if (day.open === null && firstSlot) {
            day.open = band;
            delete day.notes.open;
            this.log().append(day.date, { kind: "open", band });
          }
          await this.refreshWall(day, nowMs);
        }
      }

      const { next, events } = stepMachine(day.machine, {
        at: nowMs, price: spot, b3: day.prior?.lower ?? null, b2: day.current?.upper ?? null,
        accelStrike: day.accel?.strike ?? null,
      });
      day.machine = next;
      if (events.length) {
        for (const event of events) this.log().append(day.date, { kind: "event", event });
        day.events = [...day.events, ...events].slice(-PlaybookService.MAX_EVENTS);
        this.emit("playbook", { events, snapshot: this.snapshot() });
      }
      this.idleReason = "";
      this.lastError = "";
      return events;
    } catch (exc) {
      this.lastError = (exc as Error).message.slice(0, 200);
      return this.idle("上一轮出错了");
    }
  }

  /** 这一样现在该不该试:上次试过之后要隔够久 */
  private due(day: Day, kind: BandKind, nowMs: number, gapMs: number): boolean {
    if (nowMs - (day.triedAt[kind] ?? -Infinity) < gapMs) return false;
    day.triedAt[kind] = nowMs;
    return true;
  }

  // ---- 当场读盘口 ------------------------------------------------------------
  /** 平值跨式此刻的中间价 → 一条区间。取不到给一句原因 */
  private async liveBand(
    broker: PlaybookBroker, expiry: string, anchor: number, nowMs: number, status: string,
  ): Promise<PlaybookBand | string> {
    const symbol = PlaybookService.SYMBOL;
    const cfg = this.settings.indexConfig(symbol);
    const tradingClass = cfg ? cfg.daily_trading_class : "";
    const strike = atmStrike(anchor);
    const session = broker.marketSession();
    const managed = session.managedAccounts();
    const delayedOk = managed.length > 0 && managed.every((id) => id.startsWith("D"));
    const got = await this.marks.read(
      session,
      (["C", "P"] as const).map((right) => ({ symbol, expiry, strike, right, exchange: "SMART", tradingClass })),
      delayedOk, silenceLimitMs(status),
    );
    const refused = got.find((m) => m.error && m.ask === null)?.error;
    if (refused) return `行情订阅被拒:${refused}`;
    const call = got[0] ? legMid(got[0]) : null, put = got[1] ? legMid(got[1]) : null;
    if (call === null || put === null) return `${strike} 的跨式没有完整的买卖价`;
    return makeBand({ at: nowMs, anchor, strike, expiry, call, put, source: "live" }) ?? `${strike} 的跨式报价不是正数`;
  }

  /** 收盘后十分钟:取下一个交易日到期的平值跨式,记成那一天的昨日口径 */
  private async capturePrior(broker: PlaybookBroker, et: EtNow): Promise<void> {
    const next = this.nextTradingDay(et.date);
    if (next === null) return;
    const log = this.log();
    if (log.read(next).some((r) => r.kind === "prior")) return;
    const today = this.dayFor(et.date);
    if (!this.due(today, "prior", et.epochMs, PlaybookService.RETRY_MS)) return;
    const close = await this.closeOf(broker, et.date);
    if (close === null) return;
    const band = await this.liveBand(broker, next.replace(/-/g, ""), close, et.epochMs, "盘后");
    if (typeof band === "string") return;
    log.append(next, { kind: "prior", band });
    if (log.read(next).length === 1) log.prune();
  }

  /** 某个交易日的官方收盘价(日线那一根);那一根还没有就是 null */
  private async closeOf(broker: PlaybookBroker, date: string): Promise<number | null> {
    const bars = await broker.historicalBars(PlaybookService.SYMBOL, date, date);
    const close = Number(bars.find((b) => b["date"] === date)?.["close"]);
    return Number.isFinite(close) && close > 0 ? close : null;
  }

  // ---- 没赶上的补 ------------------------------------------------------------
  private async backfillPrior(broker: PlaybookBroker, day: Day, nowMs: number): Promise<void> {
    if (!this.due(day, "prior", nowMs, PlaybookService.BACKFILL_RETRY_MS)) return;
    const prev = this.prevTradingDay(day.date);
    if (prev === null) return;
    const minute = this.closeMin(prev) + PlaybookService.PRIOR_DELAY_MIN;
    const stamp = `${prev} ${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
    try {
      const close = await this.closeOf(broker, prev);
      if (close === null) {
        day.notes.prior = `昨日区间补不了:拿不到 ${prev} 的收盘价`;
        return;
      }
      const band = await this.historicBand(broker, day.date.replace(/-/g, ""), close, prev, minute);
      if (band === null) {
        day.notes.prior = `昨日区间补不了:${stamp} 那一分钟没有今天到期的平值跨式的历史价`;
        return;
      }
      day.prior = band;
      delete day.notes.prior;
      this.log().append(day.date, { kind: "prior", band });
    } catch (exc) {
      day.notes.prior = `昨日区间补不了:${(exc as Error).message.slice(0, 120)}`;
    }
  }

  private async backfillOpen(broker: PlaybookBroker, day: Day, nowMs: number): Promise<void> {
    if (!this.due(day, "open", nowMs, PlaybookService.BACKFILL_RETRY_MS)) return;
    const minute = PlaybookService.OPEN_MIN;
    try {
      const cfg = this.settings.indexConfig(PlaybookService.SYMBOL);
      const index = indexContract(PlaybookService.SYMBOL, cfg ? cfg.exchange : "CBOE");
      const anchor = await this.minuteOpen(broker.marketSession(), index, day.date, minute, "TRADES", true);
      const band = anchor === null ? null : await this.historicBand(broker, day.date.replace(/-/g, ""), anchor, day.date, minute);
      if (band === null) {
        day.notes.open = "盘初区间补不了:09:35 那一分钟没有指数或平值跨式的历史价";
        return;
      }
      day.open = band;
      delete day.notes.open;
      this.log().append(day.date, { kind: "open", band });
    } catch (exc) {
      day.notes.open = `盘初区间补不了:${(exc as Error).message.slice(0, 120)}`;
    }
  }

  /** 某一天某一分钟的平值跨式(分钟线的中间价)→ 一条区间 */
  private async historicBand(
    broker: PlaybookBroker, expiry: string, anchor: number, date: string, minute: number,
  ): Promise<PlaybookBand | null> {
    const symbol = PlaybookService.SYMBOL;
    const cfg = this.settings.indexConfig(symbol);
    const strike = atmStrike(anchor);
    const session = broker.marketSession();
    const mids: number[] = [];
    for (const right of ["C", "P"]) {
      const contract = optionContract(symbol, expiry, strike, right, "SMART", "USD", "100", cfg ? cfg.daily_trading_class : "");
      const mid = await this.minuteOpen(session, contract, date, minute, "MIDPOINT", false);
      if (mid === null) return null;
      mids.push(mid);
    }
    const [year, month, dayOfMonth] = date.split("-").map(Number) as [number, number, number];
    const at = wallToEpoch({ year, month, day: dayOfMonth, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 }, ET);
    return makeBand({ at, anchor, strike, expiry, call: mids[0] ?? 0, put: mids[1] ?? 0, source: "backfill" });
  }

  /** 一张合约在某一天某一分钟那根分钟线的开盘价;那一根没有就是 null */
  private async minuteOpen(
    session: IbSession, contract: Parameters<IbSession["historicalData"]>[0], date: string, minute: number,
    whatToShow: string, useRTH: boolean,
  ): Promise<number | null> {
    if (!contract.conId) await session.qualifyContracts([contract], 12_000);
    if (!contract.conId) return null;
    const end = minute + 10;
    const bars = await session.historicalData(contract, {
      endDateTime: ibEndUtc(date, Math.floor(end / 60), end % 60), durationStr: "1800 S", barSizeSetting: "1 min",
      whatToShow, useRTH,
    });
    const want = `${date} ${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
    const open = Number((bars ?? []).find((b) => barTimestamp(b.date) === want)?.open);
    return Number.isFinite(open) && open > 0 ? open : null;
  }

  // ---- 期权墙 ----------------------------------------------------------------
  /** 换了当前区间就顺手换一份期权墙(取不到留着上一份,原因写进 notes) */
  private async refreshWall(day: Day, nowMs: number): Promise<void> {
    try {
      const wall: OptionWall = await this.market.wallFor(PlaybookService.SYMBOL, day.date.replace(/-/g, ""), PlaybookService.WALL_WIDTH);
      day.wall = {
        at: nowMs, expiry: wall.expiry, call_wall: wall.call_wall, put_wall: wall.put_wall, gamma_flip: wall.gamma_flip,
        net_gex: wall.net_gex, regime: wall.regime, strikes: wall.strikes, warnings: wall.warnings,
      };
      delete day.notes.wall;
    } catch (exc) {
      day.notes.wall = `期权墙没取到:${(exc as Error).message.slice(0, 120)}`;
    }
    day.accel = accelerator(day.wall?.strikes ?? [], day.current);
  }

  // ---- 状态 ----------------------------------------------------------------
  snapshot(): PlaybookSnapshot {
    const date = nowEt().date;
    let day: Day | null = null;
    try {
      day = this.dayFor(date);
    } catch (exc) {
      this.lastError = (exc as Error).message.slice(0, 200);
    }
    const enabled = this.enabled();
    const machine = day?.machine ?? newMachine();
    const { t1, t2 } = targets(machine.state, machine.trigger, day?.open ?? null, day?.wall?.strikes ?? []);
    return {
      symbol: PlaybookService.SYMBOL, date, enabled, running: this.running,
      price: this.price, price_at: this.priceAt,
      bands: { prior: day?.prior ?? null, open: day?.open ?? null, current: day?.current ?? null },
      state: machine.state, trigger: machine.trigger, since: machine.since,
      lines: { b2: day?.current?.upper ?? null, b3: day?.prior?.lower ?? null },
      t1, t2, accel: day?.accel ?? null, wall: day?.wall ?? null,
      events: day?.events ?? [],
      notes: Object.values(day?.notes ?? {}),
      idle_reason: enabled ? this.idleReason : "已关闭", last_error: this.lastError,
      frame_seconds: PlaybookService.FRAME_MIN * 60,
    };
  }
}
