/** 蝴蝶测算的编排:定日程 → 取现价 → 取三条腿的盘口与 IV → 交给 flyPlan.planFly(纯计算)。只读,不下单。
 *
 * 能离线算:现价与 IV 都手动给了,就一条行情都不取——没连券商、休市、想按"假如现价是 X"推演时用。
 * 手动只给了其中一样,另一样照旧去券商取。
 */
import { nowEt } from "../config.js";
import type { FlyPlanParams, FlyPlanResult } from "../contract/options.js";
import { FlyPlanError, markKey, planFly, planSchedule } from "../flyPlan.js";
import type { LegMark } from "../flyPlan.js";
import type { IbSession } from "../ibTypes.js";
import type { IvSample } from "../ivSamples.js";
import { OptionMarkStreams, OptionMarksError } from "../optionMarks.js";
import { pyG } from "../py.js";
import { RpcError } from "../rpcError.js";
import { ServiceBase, gatewayName } from "./host.js";

interface Spot { price: number; source: FlyPlanResult["spot_source"]; note: string }

const RIGHTS: Record<string, "C" | "P"> = { C: "C", CALL: "C", 看涨: "C", P: "P", PUT: "P", 看跌: "P" };

export class FlyPlannerService extends ServiceBase {
  /** 测算的腿订上之后留一分钟(见 optionMarks.ts);留在 service 上,重连换了会话它自己会摘掉旧的 */
  readonly marks = new OptionMarkStreams();
  /** 读到行情时叫一声(IV 记录接在这里)。现价是手动给的那种不叫:那不是市场上同一时刻的现价 */
  onMarks: ((sample: Omit<IvSample, "by">) => unknown) | null = null;

  async planFor(params: FlyPlanParams): Promise<FlyPlanResult> {
    const symbol = String(params.symbol ?? "SPX").trim().toUpperCase() || "SPX";
    const cfg = this.settings.indexConfig(symbol);
    const tradingClass = cfg ? cfg.daily_trading_class : "";
    const now = nowEt();
    try {
      const schedule = planSchedule(
        { symbol, tradingClass, targetTime: params.target_time, targetDate: params.target_date, expiry: params.expiry, nowMs: now.epochMs },
        {
          isTradingDay: (date) => this.settings.isTradingDay(date),
          isEarlyClose: (date) => this.settings.early_close_days.includes(date),
        },
      );
      const warnings = [...schedule.warnings];
      const spot: Spot = params.spot !== undefined
        ? { price: params.spot, source: "input", note: "" }
        : await this.liveSpot(symbol);
      const right = this.rightOf(params, spot.price, warnings);
      const ivInput = params.iv === undefined ? null : params.iv / 100;
      const strikes = [params.center - params.width, params.center, params.center + params.width];
      const marks = await this.liveMarks(
        { symbol, expiry: schedule.expiry, tradingClass, right, strikes },
        { iv: ivInput !== null, cost: params.cost !== undefined }, warnings,
      );
      if (this.onMarks !== null && spot.source !== "input" && Object.keys(marks).length) {
        this.onMarks({
          t: now.epochMs, symbol, expiry: schedule.expiry, trading_class: tradingClass, spot: spot.price, spot_source: spot.source,
          legs: strikes.map((strike) => ({ strike, right, ...marks[markKey(strike)]! })),
        });
      }
      return planFly({
        symbol, expiry: schedule.expiry, tradingClass, right,
        center: params.center, width: params.width, quantity: params.quantity ?? 1, multiplier: 100,
        spot: spot.price, spotSource: spot.source, spotNote: spot.note,
        nowMs: now.epochMs, expiryMs: schedule.expiryMs, targetMs: schedule.targetMs, targetSpot: params.target_spot,
        marks, cost: params.cost ?? null, ivInput,
        ivMode: params.iv_mode ?? "auto", ivShiftPct: params.iv_shift_pct ?? null,
        timelineMs: schedule.timelineMs, warnings,
      });
    } catch (exc) {
      if (exc instanceof FlyPlanError) throw new RpcError(-32602, exc.message);
      if (exc instanceof OptionMarksError) throw new RpcError(-32017, exc.message);
      throw exc;
    }
  }

  private connected(): boolean {
    return this.router !== null && this.router.sessions().length > 0;
  }

  private rightOf(params: FlyPlanParams, spot: number, warnings: string[]): "C" | "P" {
    const given = String(params.right ?? "").trim().toUpperCase();
    if (given) {
      const right = RIGHTS[given];
      if (!right) throw new FlyPlanError(`看涨还是看跌要写成 C 或 P,收到「${params.right}」。`);
      return right;
    }
    // 和本地速记同一条规则(shorthand.ts):中心在现价上方看涨,下方看跌,相等按看涨
    const right = params.center >= spot ? "C" : "P";
    const where = params.center > spot ? "高于" : params.center < spot ? "低于" : "等于";
    warnings.push(`中心 ${pyG(params.center)} ${where}现价 ${pyG(spot)},按${right === "C" ? "看涨" : "看跌"}蝶算。`);
    return right;
  }

  private async liveSpot(symbol: string): Promise<Spot> {
    const router = this.router;
    if (router === null || !this.connected()) {
      throw new RpcError(-32017, `没连${this.gatewayLabel()},拿不到现价:先去连接,或者手动填上现价与 IV 再算。`);
    }
    let price: number | null = null;
    try {
      price = this.settings.indexConfig(symbol)
        ? await router.indexPrice(symbol)
        : ((((await router.streamQuotes([symbol])) ?? {})[symbol] ?? {})["last"] as number | undefined) ?? null;
    } catch {
      price = null;
    }
    const info = (router as { spotInfo?: (s: string) => Record<string, unknown> | null }).spotInfo?.(symbol) ?? null;
    // 夜盘推算失败时拿到的是昨收:和盯盘同一条规矩,当作没有现价
    if (info?.["source"] === "index_stale") {
      throw new RpcError(-32017, `${String(info["note"] ?? `${symbol} 拿到的是昨收,不是现价`)}。可以手动填上现价再算。`);
    }
    if (price === null || !(price > 0)) {
      throw new RpcError(-32017, `拿不到 ${symbol} 的现价。可以手动填上现价再算。`);
    }
    return { price, source: info?.["source"] === "futures" ? "futures" : "quote", note: String(info?.["note"] ?? "") };
  }

  private gatewayLabel(): string {
    return ` ${gatewayName(this.settings)}`;
  }

  /** 三条腿的盘口与模型 IV。取不到时:手动给了 IV 就带着一句话接着算,没给就把原因抛给用户 */
  private async liveMarks(
    fly: { symbol: string; expiry: string; tradingClass: string; right: "C" | "P"; strikes: number[] },
    given: { iv: boolean; cost: boolean }, warnings: string[],
  ): Promise<Record<string, LegMark>> {
    const giveUp = (why: string): Record<string, LegMark> => {
      if (!given.iv) throw new RpcError(-32017, `${why}可以手动填上 IV 再算。`);
      // 成本已经填了的,不再催一遍
      warnings.push(given.cost ? why : `${why}成本请自己填,否则用的是模型价。`);
      return {};
    };
    const router = this.router;
    if (router === null || !this.connected()) return giveUp(`没连${this.gatewayLabel()},拿不到盘口与 IV。`);
    if (this.settings.broker.provider !== "ibkr") return giveUp("蝴蝶测算的期权行情目前只从 IBKR 取。");

    const session = (router as unknown as { marketSession(): IbSession }).marketSession();
    const managed = session.managedAccounts();
    const delayedOk = managed.length > 0 && managed.every((id) => id.startsWith("D"));
    const legs = fly.strikes.map((strike) => ({
      symbol: fly.symbol, expiry: fly.expiry, strike, right: fly.right, exchange: "SMART", tradingClass: fly.tradingClass,
    }));
    let got;
    try {
      got = await this.marks.read(session, legs, delayedOk);
    } catch (exc) {
      if (exc instanceof OptionMarksError && given.iv) return giveUp(exc.message);
      throw exc;
    }
    const refused = got.filter((m) => m.error && m.iv === null && m.ask === null);
    if (refused.length) {
      return giveUp(`取不到 ${fly.symbol} 期权行情,TWS 拒了订阅:${refused.map((m) => `${pyG(m.strike)}${m.right} ${m.error}`).join(";")}。`);
    }
    const out: Record<string, LegMark> = {};
    for (const m of got) out[markKey(m.strike)] = { bid: m.bid, ask: m.ask, iv: m.iv };
    return out;
  }
}
