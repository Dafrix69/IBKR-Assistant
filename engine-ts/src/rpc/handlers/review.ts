/** review.*:交易分析——蝴蝶复盘、股票复盘、止盈策略回放。
 *  整个域已经在契约里(contract/review.ts):入参过了 schema 才到这里,返回对着契约类型检查。 */
import { BrokerError } from "../../broker.js";
import { nowEt } from "../../config.js";
import { pyRound } from "../../py.js";
import type {
  ButterflyCandidate, ReviewAnalyzeParams, ReviewAnalyzeResult, ReviewCandidate, ReviewCandidatesParams,
  ReviewCandidatesResult, ReviewPerformanceParams, ReviewPerformanceResult, ReviewSignalsParams, ReviewSignalsResult, StockCandidate,
} from "../../contract/index.js";
import { RpcError } from "../../rpcError.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { contractMethods } from "../contractMethods.js";

export class ReviewHandlers extends HandlerBase {
  methods(): MethodTable {
    return contractMethods({
      "review.candidates": (p) => this.reviewCandidates(p),
      "review.analyze": (p) => this.reviewAnalyze(p),
      "review.performance": (p) => this.reviewPerformance(p),
      "review.signals": (p) => this.reviewSignals(p),
    });
  }

  // ---- 绩效体检 ----------------------------------------------------------
  static readonly PERFORMANCE_MAX_DAYS = 3650;

  /** 已了结交易的美元账本 → 体检(performance.ts)。账本与想法总结、相似交易是同一批交易、同一套去重。 */
  async reviewPerformance(params: ReviewPerformanceParams): Promise<ReviewPerformanceResult> {
    const days = params.days ?? null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > ReviewHandlers.PERFORMANCE_MAX_DAYS)) {
      throw new RpcError(-32602, `天数要是 1 到 ${ReviewHandlers.PERFORMANCE_MAX_DAYS} 之间的整数,收到:${days}`);
    }
    const { performanceReport } = await import("../../performance.js");
    await this.reviewTrades(); // 连着券商时先把新成交同步进库(15 秒一次),体检看的是库
    const ledger = await this.ctx.tradeHistory.ledger();
    return performanceReport(ledger, { scope: params.scope ?? "all", kind: params.kind ?? "all", days, now: Date.now() }, {
      traces: this.engine.store.closeTraces(),
      protections: this.settings.protections,
    });
  }

  /** 信号成绩单(signalOutcomes.ts):信号日志 × 各标的日线。取不到日线的标的记进 missing_symbols,不让整个请求失败。 */
  async reviewSignals(params: ReviewSignalsParams): Promise<ReviewSignalsResult> {
    const days = params.days ?? null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > ReviewHandlers.PERFORMANCE_MAX_DAYS)) {
      throw new RpcError(-32602, `天数要是 1 到 ${ReviewHandlers.PERFORMANCE_MAX_DAYS} 之间的整数,收到:${days}`);
    }
    const { scoreSignals } = await import("../../signalOutcomes.js");
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
    const signals = this.engine.store.signals.list(since);
    const bars = new Map<string, Array<{ date: string; close: number }>>();
    for (const symbol of new Set(signals.map((s) => s.symbol))) {
      try {
        const rows = await this.ctx.market.dailyHistory(symbol);
        bars.set(symbol, rows
          .map((r) => ({ date: String(r["date"] ?? ""), close: Number(r["close"]) }))
          .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0));
      } catch {
        // 没连券商 / 没有这只的行情权限:这只的信号不进成绩,结果里列出来
      }
    }
    return scoreSignals(signals, bars, days);
  }

  // ---- 交易分析:蝴蝶复盘 ------------------------------------------------
  static readonly REVIEW_SCAN_LIMIT = 500; // 往回翻多少条记录找蝴蝶与它的平仓单

  static readonly REVIEW_FILL_TTL_S = 15.0; // 成交明细多久重新向券商要一次
  private reviewSyncedAt = -Infinity;

  /**
   * 券商成交 → 本地库(只增)→ 合成蝴蝶记录。返回 [记录列表, 本次新增成交数或 null]。
   * 没连券商、或券商不支持成交查询(富途)时只读本地库里已经累积的:交易分析看的是真实成交,
   * 库里没有就是没有,不拿本地记录冒充。
   */
  private async reviewTrades(): Promise<[Rec[], number | null]> {
    const ibt = await import("../../ibtrades.js");
    let synced: number | null = null;
    const router: any = this.router;
    if (router !== null && typeof router.executions === "function" && router.sessions().length) {
      const now = performance.now() / 1000;
      if (now - this.reviewSyncedAt >= ReviewHandlers.REVIEW_FILL_TTL_S) {
        try {
          synced = this.engine.store.rememberFills(await router.executions());
        } catch (exc) {
          if (!(exc instanceof BrokerError)) throw exc;
          this.engine.store.audit("engine", "fills_failed", { error: String(exc.message).slice(0, 300) });
        }
        this.reviewSyncedAt = now;
      }
    }
    const accounts = this.settings.accounts.map((a) => ({ alias: a.alias, account_id: a.account_id, is_paper: a.is_paper }));
    return [ibt.groupButterflies(this.engine.store.listFills(), accounts), synced];
  }

  /** 股票成交 → 一笔笔交易(从空仓到空仓)。期初仓位的反推与持仓缓存在 services/stockTrips(想法总结也用)。 */
  private async reviewStockTrips(): Promise<Rec[]> {
    return this.ctx.stockTrips.trips();
  }

  private static stockCandidate(trip: Rec): StockCandidate {
    return {
      id: trip["id"],
      kind: "stock",
      source: "ibkr",
      created_at: trip["created_at"] ?? null,
      closed_at: trip["closed_at"] ?? null,
      intent_summary: trip["summary"] ?? "",
      account: (trip["account"] ?? {})["alias"] ?? "",
      final_status: "filled",
      status: trip["status"],
      filled: true,
      symbol: trip["symbol"], side: trip["side"], qty: trip["qty"], open_qty: trip["open_qty"],
      entry_qty: trip["entry_qty"], exit_qty: trip["exit_qty"],
      avg_entry: trip["avg_entry"], avg_exit: trip["avg_exit"],
      pnl: trip["status"] === "closed" ? trip["realized_pnl"] : null,
      carried: Boolean(trip["carried"]), opening_assumed: Boolean(trip["opening_assumed"]),
    };
  }

  private static reviewCandidate(record: Rec, profile: Rec, source: string): ButterflyCandidate {
    const ibkr = record["ibkr"] ?? {};
    const timeline: Rec[] = ibkr["status_timeline"] ?? [];
    return {
      id: record["id"] ?? null,
      kind: "butterfly",
      source,
      created_at: record["created_at"] ?? null,
      intent_summary: (record["llm"] ?? {})["intent_summary"] ?? "",
      account: (record["account"] ?? {})["alias"] ?? "",
      final_status: record["final_status"] ?? null,
      status: (timeline.length ? timeline[timeline.length - 1]! : {})["status"] ?? null,
      filled: Boolean((ibkr["fills"] ?? []).length) || record["final_status"] === "filled",
      symbol: profile["symbol"], expiry: profile["expiry"], right: profile["right_label"],
      strikes: [profile["lower"], profile["center"], profile["upper"]],
      width: profile["width"], action: profile["action"], qty: profile["qty"],
      price: profile["debit"], price_estimated: profile["price_estimated"],
    };
  }

  /** 开仓 ↔ 平仓配对:同一张蝴蝶的反向成交。返回 {id: {role, peer}}。算法在 tradereview(想法总结也用)。 */
  private static async reviewPairs(trades: Rec[]): Promise<Record<string, Rec>> {
    const tr = await import("../../tradereview.js");
    return tr.pairButterflies(trades);
  }

  /** 可复盘的蝴蝶:默认只列券商真实成交的(最新在前);include_local 时再附上本地没成交的。
   * 同一张蝴蝶的开仓与平仓成交配成一对:平仓那条标 role=exit,分析它等于分析开仓那条。 */
  async reviewCandidates(params: ReviewCandidatesParams): Promise<ReviewCandidatesResult> {
    const tr = await import("../../tradereview.js");
    const limit = Math.trunc(Number(params["limit"] ?? 200)) || 200;
    const [trades, synced] = await this.reviewTrades();
    const pairs = await ReviewHandlers.reviewPairs(trades);
    const out: ReviewCandidate[] = [];
    for (const record of [...trades].reverse()) {
      const profile = tr.butterflyProfile(record);
      if (profile !== null) {
        const link = pairs[record["id"]];
        if (link && link["role"] === "exit") continue; // 平仓单并进开仓那一行,不单独列
        const row = ReviewHandlers.reviewCandidate(record, profile, "ibkr");
        if (link) {
          const peer = trades.find((t) => t["id"] === link["peer"]) ?? {};
          const exitPrice = (peer["ibkr"] ?? {})["avg_fill_price"] ?? null;
          let pnl: number | null = null;
          if (exitPrice !== null && profile["debit"] !== null && profile["debit"] !== undefined) {
            const sign = profile["action"] === "BUY" ? 1.0 : -1.0;
            pnl = pyRound(sign * (exitPrice - profile["debit"]) * profile["multiplier"] * profile["qty"], 2);
          }
          row["exit"] = { id: link["peer"], time: peer["created_at"] ?? null, price: exitPrice, pnl };
        }
        out.push(row);
      }
    }
    // 股票:一段持仓一行,和蝴蝶按时间混排(新的在前;时间认不出的沉底,同一时刻蝴蝶在前)
    const stocks = (await this.reviewStockTrips()).map((trip) => ReviewHandlers.stockCandidate(trip));
    if (stocks.length) {
      const keyed = [...out, ...stocks].map((row, i) => ({ row, i, when: tr.parseWhen(row["created_at"]) ?? -Infinity }));
      keyed.sort((a, b) => b.when - a.when || a.i - b.i);
      out.length = 0;
      out.push(...keyed.map((k) => k.row));
    }
    if (params["include_local"]) {
      for (const record of this.engine.store.listRecords(ReviewHandlers.REVIEW_SCAN_LIMIT)) {
        const profile = tr.butterflyProfile(record);
        if (profile === null || ((record["ibkr"] ?? {})["fills"] ?? []).length) continue; // 本地已成交的,券商成交里已有
        out.push(ReviewHandlers.reviewCandidate(record, profile, "local"));
      }
    }
    const router: any = this.router;
    return {
      candidates: out.slice(0, limit),
      synced,
      ibkr_available: Boolean(router !== null && typeof router.executions === "function" && router.sessions().length),
      fills_stored: this.engine.store.listFills().length,
    };
  }

  /** 一张蝴蝶 + 标的 K 线 → 复盘。K 线走和 K线 PA 同一条缓存,日线走历史数据接口。 */
  async reviewAnalyze(params: ReviewAnalyzeParams): Promise<ReviewAnalyzeResult> {
    const tr = await import("../../tradereview.js");
    const { TIMEFRAMES } = await import("../../priceaction.js");
    let rid = String(params["id"] ?? "");
    if (rid.startsWith("stk:")) return this.reviewAnalyzeStock(rid, params);
    // 下面这一段的 result 来自 tradereview.review(还是松的),交出去时认成契约类型
    const [trades] = await this.reviewTrades();
    const link = (await ReviewHandlers.reviewPairs(trades))[rid];
    if (link && link["role"] === "exit") rid = link["peer"]; // 选中平仓单 → 复盘它对应的开仓单
    const record = trades.find((t) => t["id"] === rid) ?? this.engine.store.getRecord(rid);
    if (record === null || record === undefined) throw new RpcError(-32005, "记录不存在");
    const profile = tr.butterflyProfile(record);
    if (profile === null) throw new RpcError(-32602, "这条记录不是蝴蝶组合,交易分析目前只支持蝴蝶。");
    let entry: { time: number; estimated: boolean };
    try {
      entry = tr.entryOf(record);
    } catch (exc) {
      if (exc instanceof tr.ReviewError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
    const moment = nowEt();
    const symbol = profile["symbol"];
    const { timeframe, bars } = await this.reviewBars(symbol, String(params["timeframe"] ?? "auto"), entry.time, moment);

    // 平仓单可能在券商成交里,也可能在本地记录里:两边都找
    const others = [...trades, ...this.engine.store.listRecords(ReviewHandlers.REVIEW_SCAN_LIMIT)];
    let result: Rec;
    try {
      result = tr.review(record, others, bars, timeframe, moment.epochMs);
    } catch (exc) {
      if (exc instanceof tr.ReviewError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
    result["record_id"] = record["id"] ?? null;
    result["source"] = record["source"] ?? "local";
    result["intent_summary"] = (record["llm"] ?? {})["intent_summary"] ?? "";
    result["timeframe_label"] = TIMEFRAMES[timeframe]!["label"];
    await this.attachExitPlan(result, record, profile, symbol, bars, timeframe, params);
    return result as unknown as ReviewAnalyzeResult;
  }

  /** 复盘用的标的 K 线:周期 auto 时按开仓离现在多远挑;日内走 K线 PA 那条缓存,日线走历史数据接口。 */
  private async reviewBars(
    symbol: string, requested: string, entryTime: number, moment: ReturnType<typeof nowEt>,
  ): Promise<{ timeframe: string; bars: Rec[] }> {
    const tr = await import("../../tradereview.js");
    const { TIMEFRAMES } = await import("../../priceaction.js");
    const timeframe = requested === "auto" ? tr.pickTimeframe(entryTime, moment.epochMs) : requested;
    if (!(timeframe in TIMEFRAMES)) {
      throw new RpcError(-32602, `未知 K 线周期:${timeframe}(可选:auto、${Object.keys(TIMEFRAMES).join("、")})`);
    }
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32015, "交易分析的 K 线");
    }
    try {
      if (timeframe === "1d") {
        const start = tr.etKey(entryTime - 45 * 86_400_000, true);
        const bars = (await this.router.historicalBars(symbol, start, moment.date)).map((b) => ({
          time: b["date"] ?? b["time"], open: b["open"], high: b["high"], low: b["low"], close: b["close"],
          volume: b["volume"] ?? 0.0,
        }));
        return { timeframe, bars };
      }
      const [bars] = await this.ctx.market.paBars(symbol, timeframe, false);
      return { timeframe, bars };
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32015, exc.message);
      throw exc;
    }
  }

  /** 一笔股票交易(一段持仓)+ 标的 K 线 → 复盘。id 是 review.candidates 给的 `stk:` 开头那个。 */
  private async reviewAnalyzeStock(rid: string, params: ReviewAnalyzeParams): Promise<ReviewAnalyzeResult> {
    const sr = await import("../../stockreview.js");
    const tr = await import("../../tradereview.js");
    const { TIMEFRAMES } = await import("../../priceaction.js");
    const trip = (await this.reviewStockTrips()).find((t) => t["id"] === rid);
    if (trip === undefined) throw new RpcError(-32005, "这笔股票交易不在已同步的成交里(成交有更新,请重新选一笔)");
    const moment = nowEt();
    let result: Rec;
    let timeframe: string;
    try {
      const fetched = await this.reviewBars(trip["symbol"], String(params["timeframe"] ?? "auto"), sr.tripStart(trip), moment);
      timeframe = fetched.timeframe;
      result = sr.reviewStock(trip, fetched.bars, timeframe, moment.epochMs);
    } catch (exc) {
      if (exc instanceof tr.ReviewError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
    result["record_id"] = trip["id"];
    result["source"] = "ibkr";
    result["account"] = (trip["account"] ?? {})["alias"] ?? "";
    result["intent_summary"] = trip["summary"] ?? "";
    result["timeframe_label"] = TIMEFRAMES[timeframe]!["label"];
    // result 来自 stockreview.reviewStock(还是松的),交出去时认成契约类型
    return result as unknown as ReviewAnalyzeResult;
  }

  /** 止盈策略回放:蝶价分钟线(IBKR 组合 MIDPOINT)+ 标的 1 分钟线 → 点位、预计盈利、逐分钟事件。
   * 任何一步拿不到数据都不该毁掉复盘本身:退到模型价并在 notes 里说清楚。 */
  private async attachExitPlan(
    result: Rec, record: Rec, profile: Rec, symbol: string, bars: Rec[], timeframe: string, params: Rec,
  ): Promise<void> {
    const fx = await import("../../flyexit.js");
    const tr = await import("../../tradereview.js");
    const exitParams: Rec = params["exit"] && typeof params["exit"] === "object" ? params["exit"] : {};
    const entryDay = String(result["entry"]["time_et"]).slice(0, 10);
    const notes: string[] = [];
    let spx1m: Rec[] = bars;
    if (timeframe !== "1m") {
      try {
        [spx1m] = await this.ctx.market.paBars(symbol, "1m", false);
        if (!spx1m.some((b) => String(b["time"] ?? "").startsWith(entryDay))) {
          spx1m = bars;
          notes.push(`开仓那天的 1 分钟线已超出 TWS 可取范围,回放按 ${timeframe} K 线走`);
        }
      } catch (exc) {
        if (!(exc instanceof BrokerError) && !(exc instanceof RpcError)) throw exc;
        spx1m = bars;
        notes.push(`拿不到 1 分钟线(${(exc as Error).message}),回放按 ${timeframe} K 线走`);
      }
    }
    let flyBars: Rec[] = [];
    const router: any = this.router;
    if (router !== null && typeof router.comboBars === "function") {
      try {
        flyBars = await router.comboBars(symbol, (record["contract"] ?? {})["legs"] ?? [], entryDay);
      } catch (exc) {
        // 组合历史数据的坑很多,别让它拖垮复盘
        notes.push(`拿不到蝶价分钟线(${String((exc as Error).message).slice(0, 160)}),回放全部用模型价`);
      }
    } else {
      notes.push("当前券商通道不支持组合历史数据,回放全部用模型价");
    }

    const entryWhen = tr.parseWhen(result["entry"]["time"]);
    const idx = entryWhen === null ? null : tr.indexAt(spx1m, entryWhen, false);
    const entryBar = idx === null ? String(result["entry"]["bar_time"]) : String(spx1m[idx]!["time"]);
    const outcome = result["outcome"];
    const actual = { kind: outcome["kind"], price: outcome["price"], pnl: outcome["pnl"], time_et: outcome["time_et"] };
    const plan = fx.plan(profile, entryBar, spx1m, flyBars, exitParams, actual);
    (plan["notes"] as string[]).push(...notes);
    result["exit_plan"] = plan;

    const dayFly = flyBars.filter((b) => String(b["time"] ?? "").slice(0, 10) === entryDay);
    let startI = 0;
    for (let i = 0; i < dayFly.length; i += 1) {
      if (String(dayFly[i]!["time"] ?? "") >= entryBar) { startI = Math.max(i - tr.LOOKBACK_BARS, 0); break; }
    }
    const markers: Rec[] = [{ kind: "entry", time: entryBar, price: profile["debit"] ?? null }];
    if (outcome["kind"] === "closed" && outcome["time"]) {
      const exitWhen = tr.parseWhen(outcome["time"]);
      const j = exitWhen === null ? null : tr.indexAt(spx1m, exitWhen, false);
      if (j !== null) markers.push({ kind: "exit", time: String(spx1m[j]!["time"]), price: outcome["price"] });
    }
    result["fly_series"] = { bars: dayFly.slice(startI), source: flyBars.length ? "ibkr" : "model", markers };
  }
}
