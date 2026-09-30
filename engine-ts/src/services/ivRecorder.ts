/** 当日到期期权 IV 的记录:连着 IBKR、在常规时段里,每五分钟把一圈行权价的盘口与模型 IV 记一笔。
 *
 * 记来做什么:蝴蝶测算里"IV 怎么变"现在是拿 IV 指数校准的;攒够了真的期权 IV,校准脚本就能拿它重估
 * (scripts/calibrate-fly-iv.mjs --samples)。口径见 docs/features/fly-plan.md「自己积攒 IV」。
 *
 * 几条规矩:
 * * **只读行情,不碰交易。** 用的是测算那批自己的行情流(optionMarks.ts),盯盘的流碰不到。
 * * **行权价一整天不换。** 开盘后第一笔的现价取整作锚,围着它取一圈;标的走远了再添一对跟着现价的平值。
 *   同一个行权价从早记到晚,才看得出"这条腿的 IV 在标的走了一段之后变了多少"。
 * * **什么时候不记都说得出原因**(没连券商、不在常规时段、已关闭、现价是昨收……),界面照着显示。
 * * 出了错吞掉、记进 last_error,循环不停。
 * * 默认开着;关掉之后不订任何行情。开关存在库的偏好表里,不进配置文件。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { etNowFromEpoch, nowEt } from "../config.js";
import type { IvRecorderStatus } from "../contract/options.js";
import { silenceLimitMs } from "../heldStreams.js";
import type { IbSession } from "../ibTypes.js";
import { IvSampleStore } from "../ivSamples.js";
import type { IvSample } from "../ivSamples.js";
import type { OptionMarkStreams } from "../optionMarks.js";
import { dateStrAt, ET } from "../tz.js";
import { ServiceBase } from "./host.js";
import type { ServiceHost } from "./host.js";

interface Anchor { date: string; strike: number }

export class IvRecorderService extends ServiceBase {
  static readonly PREF = "fly.iv_recorder";
  static readonly SYMBOL = "SPX";
  /** 循环多久看一眼 */
  static readonly TICK_MS = 30_000;
  /** 多久记一笔 */
  static readonly INTERVAL_MS = 5 * 60_000;
  /** 测算那一路顺带记的,同一只蝶至少隔这么久才再记(开着自动刷新是十秒一次) */
  static readonly PLAN_GAP_MS = 60_000;
  /** 围着锚取的行权价(点)。锚以下记看跌、以上记看涨、锚上两样都记——都是虚值那一侧,报价最实 */
  static readonly OFFSETS = [-75, -50, -25, -10, 0, 10, 25, 50, 75];
  /** 现价离锚多远之后,再添一对跟着现价走的平值 */
  static readonly ROVE_POINTS = 20;
  static readonly STRIKE_STEP = 5;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private running = false;
  private chain: Promise<unknown> = Promise.resolve();
  private anchor: Anchor | null = null;
  private lastLoopAt = 0;
  private lastAt: number | null = null;
  private idleReason = "";
  private lastError = "";
  private readonly lastPlanAt = new Map<string, number>();
  /** 每个文件数过一遍之后记着(按大小认):状态每次都问,不能每次把一年的文件重读一遍 */
  private readonly counted = new Map<string, { bytes: number; samples: number }>();

  constructor(host: ServiceHost, private readonly marks: OptionMarkStreams) {
    super(host);
  }

  private store(): IvSampleStore {
    return new IvSampleStore(path.join(path.dirname(this.settings.db_path), "fly-iv"));
  }

  // ---- 开关 ----------------------------------------------------------------
  enabled(): boolean {
    try {
      const raw = this.engine.store.getPref(IvRecorderService.PREF) as { enabled?: unknown } | null;
      return raw === null ? true : raw.enabled !== false;
    } catch {
      return true; // 库打不开时别的地方会报;这里不因为它把循环弄挂
    }
  }

  setEnabled(on: boolean): IvRecorderStatus {
    this.engine.store.setPref(IvRecorderService.PREF, { enabled: on });
    if (!on) this.idleReason = "已关闭";
    return this.status();
  }

  // ---- 循环 ----------------------------------------------------------------
  start(tickMs: number = IvRecorderService.TICK_MS): void {
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

  /** 看一眼该不该记,该记就记一笔。返回这一轮记下的那一笔;没记是 null(原因在 status().idle_reason) */
  tickOnce(nowMs?: number): Promise<IvSample | null> {
    const run = this.chain.then(() => this.tickInner(nowMs ?? nowEt().epochMs));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private idle(reason: string): null {
    this.idleReason = reason;
    return null;
  }

  private async tickInner(nowMs: number): Promise<IvSample | null> {
    try {
      if (!this.enabled()) return this.idle("已关闭");
      const router = this.router;
      if (router === null || !router.sessions().length) return this.idle("没连券商");
      if (this.settings.broker.provider !== "ibkr") return this.idle("期权行情只从 IBKR 取");
      if (this.settings.marketStatus(etNowFromEpoch(nowMs)) !== "盘中") return this.idle("不在常规交易时段");
      if (nowMs - this.lastLoopAt < IvRecorderService.INTERVAL_MS) return null; // 还没到下一笔的时候,原因不变

      const symbol = IvRecorderService.SYMBOL;
      const cfg = this.settings.indexConfig(symbol);
      if (cfg === null) return this.idle(`配置里没有 ${symbol} 这个指数`);
      const spot = await router.indexPrice(symbol);
      const info = (router as { spotInfo?: (s: string) => Record<string, unknown> | null }).spotInfo?.(symbol) ?? null;
      if (info?.["source"] === "index_stale" || spot === null || !(spot > 0)) return this.idle("拿不到现价");

      const date = dateStrAt(nowMs, ET);
      const anchor = this.anchorFor(date, spot);
      const legs = this.legsFor(anchor, spot);
      const session = (router as unknown as { marketSession(): IbSession }).marketSession();
      const managed = session.managedAccounts();
      const delayedOk = managed.length > 0 && managed.every((id) => id.startsWith("D"));
      const expiry = date.replace(/-/g, "");
      const got = await this.marks.read(
        session,
        legs.map((leg) => ({ symbol, expiry, strike: leg.strike, right: leg.right, exchange: "SMART", tradingClass: cfg.daily_trading_class })),
        delayedOk,
        silenceLimitMs("盘中"), // 只在常规时段记;五分钟一笔、流闲一分钟就撤,多半是新订的,这条只防测算那边一直热着的
      );
      const sample: IvSample = {
        t: nowMs, symbol, expiry, trading_class: cfg.daily_trading_class, spot,
        spot_source: info?.["source"] === "futures" ? "futures" : "quote", by: "loop", anchor,
        legs: got.map((m, i) => ({ strike: m.strike, right: legs[i]!.right, bid: m.bid, ask: m.ask, iv: m.iv })),
      };
      // 到了该记的时候就算记过一轮:行情一条都没来也不紧接着重试,免得每三十秒订一遍
      this.lastLoopAt = nowMs;
      // 一条盘口都没有就不记,哪怕有模型 IV:2026-09-29 电脑合盖睡着,之后只在几秒钟的维护唤醒里跑,那几笔只有模型 IV、
      // 一连三笔一模一样——不是行情,进了校准就是假数据(docs/journal/stale-streams-after-sleep.md)
      if (!sample.legs.some((leg) => leg.ask !== null)) {
        const why = got.find((m) => m.error)?.error;
        const onlyModel = sample.legs.some((leg) => leg.iv !== null);
        return this.idle(why ? `行情订阅被拒:${why}` : onlyModel ? "这一轮只有模型 IV、没有盘口,不记" : "这一轮一条行情都没来");
      }
      this.write(sample);
      this.lastError = "";
      return sample;
    } catch (exc) {
      this.lastError = (exc as Error).message.slice(0, 200);
      this.lastLoopAt = nowMs;
      return this.idle("上一轮出错了");
    }
  }

  private write(sample: IvSample): void {
    const store = this.store();
    store.append(sample);
    this.lastAt = sample.t;
    this.idleReason = "";
    // 新的一天的第一笔:顺手把太老的清掉
    if (store.read(dateStrAt(sample.t, ET)).length === 1) store.prune();
  }

  /** 当天的锚:内存里有就用;没有(引擎重启过)先看今天的文件里记过的,再没有才拿现价取整 */
  private anchorFor(date: string, spot: number): number {
    if (this.anchor?.date === date) return this.anchor.strike;
    const seen = this.store().read(date).find((s) => s.by === "loop" && typeof s.anchor === "number")?.anchor;
    const step = IvRecorderService.STRIKE_STEP;
    this.anchor = { date, strike: seen ?? Math.round(spot / step) * step };
    return this.anchor.strike;
  }

  private legsFor(anchor: number, spot: number): Array<{ strike: number; right: "C" | "P" }> {
    const legs: Array<{ strike: number; right: "C" | "P" }> = [];
    const seen = new Set<string>();
    const add = (strike: number, right: "C" | "P"): void => {
      const key = `${strike}${right}`;
      if (strike > 0 && !seen.has(key)) {
        seen.add(key);
        legs.push({ strike, right });
      }
    };
    for (const offset of IvRecorderService.OFFSETS) {
      if (offset <= 0) add(anchor + offset, "P");
      if (offset >= 0) add(anchor + offset, "C");
    }
    if (Math.abs(spot - anchor) >= IvRecorderService.ROVE_POINTS) {
      const step = IvRecorderService.STRIKE_STEP, atm = Math.round(spot / step) * step;
      add(atm, "P");
      add(atm, "C");
    }
    return legs;
  }

  // ---- 测算那一路顺带记 ------------------------------------------------------
  /** 测算读到了行情:顺带记一笔。只记当日到期的、现价不是手动给的;同一只蝶一分钟最多一笔 */
  recordPlan(sample: Omit<IvSample, "by">): boolean {
    try {
      if (!this.enabled()) return false;
      if (sample.expiry !== dateStrAt(sample.t, ET).replace(/-/g, "")) return false;
      if (!sample.legs.some((leg) => leg.iv !== null)) return false;
      const key = `${sample.symbol}|${sample.legs.map((l) => `${l.strike}${l.right}`).join(",")}`;
      if (sample.t - (this.lastPlanAt.get(key) ?? 0) < IvRecorderService.PLAN_GAP_MS) return false;
      this.lastPlanAt.set(key, sample.t);
      this.write({ ...sample, by: "plan" });
      return true;
    } catch (exc) {
      this.lastError = (exc as Error).message.slice(0, 200);
      return false;
    }
  }

  // ---- 状态 ----------------------------------------------------------------
  status(): IvRecorderStatus {
    const store = this.store();
    let days = 0, samples = 0, first: string | null = null, last: string | null = null;
    try {
      for (const day of store.dates()) {
        const hit = this.counted.get(day);
        const bytes = sizeOf(path.join(store.dir, `${day}.jsonl`));
        const count = hit && hit.bytes === bytes ? hit.samples : store.read(day).length;
        this.counted.set(day, { bytes, samples: count });
        if (!count) continue;
        days += 1;
        samples += count;
        first ??= day;
        last = day;
      }
    } catch (exc) {
      this.lastError = (exc as Error).message.slice(0, 200);
    }
    const enabled = this.enabled();
    return {
      enabled, running: this.running, symbol: IvRecorderService.SYMBOL,
      interval_seconds: IvRecorderService.INTERVAL_MS / 1000, dir: store.dir,
      days, samples, first_date: first, last_date: last,
      last_at: this.lastAt === null ? null : new Date(this.lastAt).toISOString(),
      idle_reason: enabled ? this.idleReason : "已关闭", last_error: this.lastError,
    };
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
