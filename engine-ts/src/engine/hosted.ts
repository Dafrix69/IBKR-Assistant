/** 券商托管的止盈/止损单:对账循环、认领、挂/改/撤,以及回报进来时的处置。
 *
 * 2026-09-20 从 engine.ts 整块搬出来(函数体逐字未改)。软件盯盘怕的三件事——轮询漏插针、软件必须开着、
 * 我们这头行情延迟——托管单都不怕:触发发生在券商服务器的实时行情上。所以这一块的纪律是**宁可不挂,不可挂错**。
 *
 * 它自己管四样状态(hosted / hostedIndex / hostedRetryAt / hostedAdopted);别的一律从宿主现取——
 * 配置会重载、券商会重连,存一份拷贝就会过期(同 services/ 的规矩)。
 */
import type { EtNow, Settings } from "../config.js";
import { nowEt } from "../config.js";
import { BrokerError } from "../broker.js";
import type { KillSwitch } from "../killswitch.js";
import { ContractSpecSchema } from "../models.js";
import type { HostedOrderRow, TrackerPollTick, TrackerSyncHostedTick } from "../contract/trackerloop.js";
import type { Notifier } from "../notify.js";
import { finiteOrNull } from "../py.js";
import type { TradeStore } from "../store.js";
import type { Rec } from "../store.js";
import * as tk from "../tracker.js";
import { nowIsoSecondsEt } from "./clock.js";

/** 托管单拼不出来(我们这头的错,比如结构没法反转成一张合法的平仓单)。不算券商失败、不计入熔断。 */
export class HostedPlanError extends Error {}

/** 托管单这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝。 */
export interface HostedHost {
  readonly store: TradeStore;
  readonly notifier: Notifier;
  readonly killswitch: KillSwitch;
  readonly settings: Settings;
  readonly router: HostedRouter | null;
  /** 券商 orderId / permId → 记录 id */
  readonly orderIndex: Map<number, string>;
  /** 比 placeOrder 返回还早到的订单错误 */
  readonly earlyOrderErrors: Map<number, [number, string, number]>;
  /** 本会话对哪个单号做过什么、什么时候(形状同 engine/callbacks.ts 的 SentOrder;那边要 import 这边的类型,这里只写结构,免得成环) */
  readonly sentOrders: Map<number, { at: number; kind: "place" | "modify" | "cancel" }>;
  accountIsPaper(alias: string): boolean;
  applySpotTarget(
    track: Rec, raw: Rec, position: tk.Position, targets: tk.Targets,
    positions: Record<string, Rec>, at: EtNow,
  ): Promise<[tk.Targets, tk.SpotTarget | null, boolean]>;
  chaseQuote(
    raw: Rec, position: tk.Position, positions: Record<string, Rec>, auto: tk.AutoClose,
    prev: number | null, rounds: number,
  ): Promise<{ natural: number; limit: number; floor: number } | null>;
  chaseWarnIfStuck(track: Rec, entry: Rec, limit: number, natural: number): void;
  baseRecord(instruction: string, channel: string, response: null): Rec;
  onIbError(reqId: unknown, errorCode: unknown, errorString: unknown): void;
}

/** 托管单要用到的 router 面。 */
export interface HostedRouter {
  /** 只有 IBKR 的 router 有;富途没有可同形托管的 GTC+OCA */
  readonly SUPPORTS_HOSTED_CLOSE?: boolean;
  [method: string]: any;
}

export class HostedOrders {
  constructor(private readonly host: HostedHost) {}

  // ---- 从宿主现取(搬过来的代码里写的还是 this.store / this.router …)----
  private get store(): TradeStore { return this.host.store; }
  private get notifier(): Notifier { return this.host.notifier; }
  private get killswitch(): KillSwitch { return this.host.killswitch; }
  private get settings(): Settings { return this.host.settings; }
  private get router(): HostedRouter | null { return this.host.router; }
  private get orderIndex(): Map<number, string> { return this.host.orderIndex; }
  private get earlyOrderErrors(): Map<number, [number, string, number]> { return this.host.earlyOrderErrors; }
  private accountIsPaper(alias: string): boolean { return this.host.accountIsPaper(alias); }
  private applySpotTarget(...args: Parameters<HostedHost["applySpotTarget"]>): ReturnType<HostedHost["applySpotTarget"]> {
    return this.host.applySpotTarget(...args);
  }
  private chaseQuote(...args: Parameters<HostedHost["chaseQuote"]>): ReturnType<HostedHost["chaseQuote"]> {
    return this.host.chaseQuote(...args);
  }
  private chaseWarnIfStuck(...args: Parameters<HostedHost["chaseWarnIfStuck"]>): void {
    this.host.chaseWarnIfStuck(...args);
  }
  private baseRecord(...args: Parameters<HostedHost["baseRecord"]>): Rec { return this.host.baseRecord(...args); }
  private onIbError(...args: Parameters<HostedHost["onIbError"]>): void { this.host.onIbError(...args); }

  // ---- 自己的状态 ----
  /** track_id → kind → 挂在券商侧的那张单 */
  private readonly hosted = new Map<string, Map<string, Rec>>();
  /** 券商 orderId → [track_id, kind] */
  private readonly hostedIndex = new Map<number, [string, string]>();
  private hostedAdopted = false;
  /** 上一轮读得到的账户(router 说不清就是 null)。多出一个账户(会话刚连上 / 重连回来)就重新认领:
   * 引擎重建那一刻这个账户的会话没连着,它在券商那边挂着的托管单当时认领不到——不重认,
   * 对账会当成"没挂"再挂一张,两张平仓单各成交一次就是反向开仓。认领按 orderRef 去重,重认是幂等的。 */
  private lastCovered: Set<string> | null = null;
  /** 对账已经替它排过单的追踪(过了闸门、算过计划)。盯盘在同一轮里先于对账跑:刚建的追踪、重启后还没认领的,
   * 缓存里没有单不等于券商侧没有保护——没对过账之前,"负责这一项的单不在"不作数(见 onTriggered)。 */
  private readonly synced = new Set<string>();
  /** 被券商拒掉的:track_id|kind → {到期时刻, 原因}。退避期内不重挂也不再改价。
   * warn:第一次在对账里碰到它时提醒一次(券商主动撤单那一路用它,见 onStatus) */
  private readonly hostedRetryAt = new Map<string, { at: number; reason: string; warn?: boolean }>();

  // ---- 给引擎那头的小窗口 ----
  /** 这条追踪的止盈单(界面要显示上一轮追到的价);没有就是 undefined。 */
  tpEntry(trackId: string): Rec | undefined {
    return this.hosted.get(trackId)?.get(tk.HOSTED_KIND_TP);
  }

  /** 这个 orderId 是不是托管单的;是就交给 onError 处理。 */
  handleError(orderId: number, code: number, message: string): boolean {
    if (!this.hostedIndex.has(orderId)) return false;
    this.onError(orderId, code, message);
    return true;
  }

  /** 这条追踪此刻在券商侧挂着哪几种托管单(tp / sl / trail / ptrail)。 */
  liveKinds(trackId: string): Set<string> {
    return new Set(this.hosted.get(trackId)?.keys() ?? []);
  }

  /** 手动「立即平仓」:这条追踪的退避一律作废,下一轮对账马上挂 / 改。人点了平仓,就不该再等一分钟。 */
  clearBackoff(trackId: string): void {
    for (const key of [...this.hostedRetryAt.keys()]) {
      if (key.startsWith(`${trackId}|`)) this.hostedRetryAt.delete(key);
    }
  }

  /** 熔断撤了全部单:缓存跟着清。 */
  clear(): void {
    this.hosted.clear();
    this.hostedIndex.clear();
    this.synced.clear();
  }
  // ---- 券商托管的止盈/止损:对账循环 -----------------------------------
  /** 把"追踪设置"和"券商侧挂着的托管单"对齐(挂缺的、改变了的、撤多余的)。
   *
   * 由界面按秒驱动。软件盯盘怕的三件事——轮询漏插针、软件必须开着、我们
   * 这头行情延迟——托管单都不怕:触发发生在券商服务器的实时行情上。 */
  async syncHosted(rows?: Rec[] | null): Promise<TrackerSyncHostedTick> {
    const out: TrackerSyncHostedTick = { hosted: [], blocked: [], quote_maybe_delayed: false };
    const router = this.router;
    if (router === null || !router.SUPPORTS_HOSTED_CLOSE) return out;
    const tracks = this.store.listTracks();
    const wantsHosting = tracks.some((t) => Boolean((t["auto_close"] ?? {})["host_at_broker"]));
    if (!wantsHosting && this.hosted.size === 0) return out;
    const covered: Set<string> | null = router.coveredAccounts?.() ?? null;
    const prev = this.lastCovered;
    if (covered !== null && prev !== null && [...covered].some((a) => !prev.has(a))) this.hostedAdopted = false;
    this.lastCovered = covered;
    if (!this.hostedAdopted) await this.adoptHosted();
    if (!this.hostedAdopted) {
      // 券商侧已经挂着哪些托管单还没认领上(未成交单列表这一轮没取到):不挂、不改、不撤。
      // 拿一份不知道券商那头有什么的缓存去"补挂",就是给同一个仓再挂一组单(2026-09-27 审计)
      for (const t of tracks) {
        if ((t["auto_close"] ?? {})["host_at_broker"]) {
          out["blocked"].push({ id: t["id"], symbol: t["symbol"], blockers: ["还没认领上券商侧已挂的托管单(未成交单列表没取到),这一轮不挂也不改"] });
        }
      }
      return out;
    }

    let positions: Record<string, Rec>;
    try {
      positions = Object.fromEntries(
        tk.withCombos(rows ?? (await router.positions()) ?? []).map((p) => [p["key"], p]),
      );
    } catch (exc) {
      // 读不到持仓不该炸掉对账
      this.store.audit("engine", "hosted_positions_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return out;
    }

    const breaker = this.killswitch.state();
    const alive = new Set<string>();
    for (const track of tracks) {
      const tid = String(track["id"]);
      const auto = tk.makeAutoClose(track["auto_close"] ?? {});
      if (!auto.host_at_broker) {
        await this.cancelHostedTrack(tid, "托管已关闭");
        continue;
      }
      if (this.accountIsPaper(track["account"])) {
        // 模拟账户常拿延迟行情:动态调整可能滞后(且只会偏松,不会偏紧),
        // 托管单本身仍由券商实时触发——把这件事告诉界面。
        out["quote_maybe_delayed"] = true;
      }
      const key = tk.trackKey(track);
      const raw = positions[key];
      // 账户读不到 ≠ 仓没了:券商侧的托管单原样留着,它们本来就不靠本机盯
      if (raw === undefined && tk.unreachableReason(covered, track["account"]) !== null) continue;
      if (raw === undefined) {
        await this.cancelHostedTrack(tid, "持仓已不存在");
        continue;
      }
      const position = tk.makePosition({
        account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
        quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
        currency: raw["currency"], market_price: raw["market_price"],
        market_value: raw["market_value"], unrealized_pnl: raw["unrealized_pnl"],
      });
      // 托管单只是挂着,不是立刻成交——时段闸门不适用,其余闸门照过:
      // 挂单也是发单,授权(auto_execute/实盘开关)与熔断一个都不能少。
      // 追价平仓中的追踪已经落了闩(fired_at),但它的托管单正是要继续改的那一张,不算"已触发过"
      const sweeping = tk.sweepReason(track) !== null;
      const blockers = tk.closeBlockers({
        auto,
        position,
        accountIsPaper: this.accountIsPaper(track["account"]),
        autoExecute: this.settings.policies.auto_execute,
        allowLiveTrading: this.settings.policies.allow_live_trading,
        // 自动熔断不挡追价平仓:那是在减仓,和软件止损同一口径(见 killswitch.ts 的 auto)
        breakerEngaged: breaker.engaged && !(breaker.auto && sweeping),
        marketStatus: "盘中",
        alreadyFired: Boolean(track["fired_at"]) && !sweeping,
      });
      if (blockers.length) {
        // 挡住它的只有**自动**熔断:券商侧已经挂着的托管单原样留着,只是不再挂新的、不再改价。
        // 它们本来就在保护持仓;在软件接连出错的时候把止损撤掉,等于把保护和毛病一起拿走
        // (2026-09-27 审计:大模型接口超时三次 → 下一轮对账撤光全部托管止损)。手动熔断照旧全撤——那是人说"全部停下"。
        if (breaker.auto && blockers.every((b) => b === tk.BLOCK_BREAKER)) {
          out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: [`${tk.BLOCK_BREAKER}(自动熔断:券商侧已挂的托管单原样保留,不再改价)`] });
          if (this.hosted.has(tid)) out["hosted"].push({ id: tid, symbol: track["symbol"], orders: this.hostedRows(tid) });
          continue;
        }
        await this.cancelHostedTrack(tid, blockers.join("、"));
        out["blocked"].push({ id: tid, symbol: track["symbol"], blockers });
        continue;
      }

      const peak = tk.advancePeak(position, raw["market_price"], track["peak"] ?? null);
      if (peak !== null && peak !== track["peak"]) {
        this.store.updateTrack(tid, { peak });
      }
      // 标的目标价:这一轮的止盈价现算。托管单的价格因此**一秒一变**——
      // 插针那一下扫过来时,挂着的限价必须已经是当时的合理价。
      let [targets, , hold] = await this.applySpotTarget(
        track, raw, position, tk.makeTargets(track["targets"] ?? {}), positions, nowEt(),
      );
      alive.add(tid);
      if (!this.hosted.has(tid)) this.hosted.set(tid, new Map());
      const current = this.hosted.get(tid)!;
      let chase: { natural: number; limit: number; floor: number } | null = null;
      if (sweeping) {
        // 追价平仓:止盈单改到此刻立刻能成交的价,每轮按最新的买卖价再追一次,越等越让(tk.chaseLimit)
        const tp = current.get(tk.HOSTED_KIND_TP);
        chase = await this.chaseQuote(
          raw, position, positions, auto, finiteOrNull(tp?.["chase_limit"] ?? null), Number(tp?.["chase_rounds"] ?? 0),
        );
        if (chase === null) {
          // 拿不到腿的买卖价:这一轮不动那张单(更不能把它改回模型价),下一轮再追
          out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: ["正在追价平仓,但这一轮拿不到腿的买卖价,没改价"] });
          out["hosted"].push({ id: tid, symbol: track["symbol"], sweeping: true, orders: this.hostedRows(tid) });
          continue;
        }
        targets = { ...targets, take_profit: chase.limit };
        hold = false;
      }
      const plan = tk.hostedPlan(position, targets, auto, peak);
      // 已经部分成交的托管单:持仓缩了,按持仓算出的数量也跟着缩,可券商那边的总量含已成交的那部分——
      // 把总量改成"剩余"等于把剩下的再砍一截(3 张成交 1 张、持仓剩 2,总量改 2 就只剩 1 张在挂)。
      // 总量 = 剩余该平的 + 已成交的,且不超过原总量(用户在别处手动平了一部分才会更小)。
      for (const item of plan) {
        const cur = current.get(item.kind);
        const filled = Math.trunc(Number(cur?.["filled"] ?? 0));
        if (cur && filled > 0) {
          item.quantity = Math.min(Math.trunc(Number(cur["quantity"] ?? 0)), item.quantity + filled);
        }
      }
      this.synced.add(tid);
      const desired = new Set(plan.map((item) => item.kind));
      // 只守不挂的这一轮,止盈单"不在计划里"不等于"该撤":撤掉一张站岗的单比停在旧价危险得多
      if (hold) desired.add(tk.HOSTED_KIND_TP);
      for (const kind of [...current.keys()].filter((k) => !desired.has(k))) {
        await this.cancelHostedOne(tid, kind, "该目标已移除");
      }
      const oca = `dafri-trk-${tid.slice(0, 8)}`;
      for (const item of plan) {
        // 上面每一次 await 券商的空档里,回报都可能已经改了这条追踪(托管单成交落了闩)。
        // 拿这一轮开头读的旧快照接着挂,就是给一个刚平掉的仓再挂一组平仓单——止盈价就是刚成交的那个价,
        // 挂上去当场成交,反向开仓(2026-09-27 审计复现)
        if (!this.stillHosting(tid)) break;
        const cur = current.get(item.kind);
        const retry = this.hostedRetryAt.get(`${tid}|${item.kind}`);
        if (retry?.warn) {
          retry.warn = false;
          this.notifier.warning(`${track["symbol"]} 的${item.label}:${retry.reason}。60 秒后再挂,期间这一项没有券商侧的单`);
        }
        if (cur === undefined && retry !== undefined) {
          if (retry.at > Date.now()) {
            // 刚被券商拒过:退避期内不重挂,把原因交给界面
            out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: [`托管单被券商拒绝,没有挂上:${retry.reason}`] });
            continue;
          }
          this.hostedRetryAt.delete(`${tid}|${item.kind}`);
        }
        try {
          if (cur === undefined) {
            await this.placeHostedOne(track, item, oca);
          } else if (tk.hostedNeedsUpdate(cur, item)) {
            if (retry !== undefined && retry.at > Date.now()) {
              // 改价刚被拒:原单还在原价,退避期内不再改
              out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: [`托管单改价被券商拒绝,仍挂在 ${cur["lmt_price"] ?? cur["aux_price"]}:${retry.reason}`] });
            } else {
              if (retry !== undefined) this.hostedRetryAt.delete(`${tid}|${item.kind}`);
              await this.modifyHostedOne(track, cur, item);
            }
          }
        } catch (exc) {
          // 单张失败不拖垮整轮。也不每秒重来:以前挂一次失败下一秒再挂,三秒就把熔断打合上,
          // 连带别的追踪一起停摆。退避一分钟;拼不出合约这类我们自己的错,券商那边永远不会好,退避十分钟且不算券商失败
          const message = String((exc as Error).message).slice(0, 300);
          const own = exc instanceof HostedPlanError;
          this.store.audit("engine", "hosted_place_failed", { track: tid, kind: item.kind, error: message });
          this.hostedRetryAt.set(`${tid}|${item.kind}`, { at: Date.now() + (own ? 600_000 : 60_000), reason: message });
          this.notifier.warning(`${track["symbol"]} 的${item.label}没有挂上:${message}`);
          if (!own) {
            const engaged = this.killswitch.recordFailure(message, "broker");
            if (engaged) this.notifier.breaker(engaged.reason);
          }
        }
      }
      if (chase !== null) {
        // 记下这一轮追到哪了:下一轮从这里接着让,界面也照它显示
        const tp = current.get(tk.HOSTED_KIND_TP);
        if (tp !== undefined) {
          tp["chase_rounds"] = Number(tp["chase_rounds"] ?? 0) + 1;
          tp["chase_limit"] = chase.limit;
          tp["chase_natural"] = chase.natural;
          tp["chase_floor"] = chase.floor;
          tp["rounds"] = tp["chase_rounds"];
          this.chaseWarnIfStuck(track, tp, chase.limit, chase.natural);
        }
      }
      out["hosted"].push({
        id: tid, symbol: track["symbol"], ...(sweeping ? { sweeping: true } : {}), orders: this.hostedRows(tid),
        ...(chase !== null ? { chase: { rounds: current.get(tk.HOSTED_KIND_TP)?.["chase_rounds"] ?? 0, ...chase } } : {}),
      });
    }

    const known = new Set(tracks.map((t) => String(t["id"])));
    for (const tid of [...this.hosted.keys()]) {
      if (!alive.has(tid) && !known.has(tid)) {
        await this.cancelHostedTrack(tid, "追踪已删除");
      }
    }
    return out;
  }

  /** 这一轮对账还该不该接着给这条追踪挂 / 改单:它被删了、或者托管单成交落了闩(不是追价平仓中),就停手。
   * 引擎侧的改动(删追踪、熔断、手动平仓)都和对账共用一把锁,轮中能插进来的只有券商回报——它会先改库。 */
  private stillHosting(tid: string): boolean {
    const fresh = this.store.getTrack(tid);
    if (fresh === null) return false;
    return !fresh["fired_at"] || tk.sweepReason(fresh) !== null;
  }

  /** 触发状态 → 哪几种托管单在券商侧负责它。组合只托管止盈单,止损类在券商侧本来就没有单。 */
  private static readonly COVERING: Record<string, string[]> = {
    [tk.STATE_TAKE_PROFIT]: [tk.HOSTED_KIND_TP],
    [tk.STATE_STOP_LOSS]: [tk.HOSTED_KIND_SL, tk.HOSTED_KIND_TRAIL],
    [tk.STATE_PROFIT_TRAIL]: [tk.HOSTED_KIND_PTRAIL],
  };

  /**
   * 托管的追踪在盯盘里判到了触发:交给券商侧那张单,还是改成追价平仓——把 OCA 组里的止盈单改到(或挂在)
   * 立刻成交的价上、没成交就每秒再追(syncHosted)。追的始终是组里那一张:另发一张组外的平仓单,
   * 和券商侧的止损同时成交就是反向开仓。
   *
   * 2026-09-27 从 engine.pollTrackers 搬过来,补了一条:**该负责这个触发的那张单不在券商侧**时也要追价。
   * 以前这里只认"组合的止损类 / 标的到了目标价",其余一律 continue——被券商拒了正在退避的止损、
   * 分档利润回撤(券商侧根本没有对应的单)、还没来得及挂上的,持仓就在没有任何保护的状态下被标成"已托管"。
   * 回 true 表示这一轮这条追踪归托管这条路处理完了(调用方 continue)。
   */
  onTriggered(args: {
    track: Rec; raw: Rec; position: tk.Position; state: string; reason: string; spotReached: boolean;
    /** 这次触发是标的止损价:券商侧没有任何单看标的(sl / trail 盯的是持仓自己的价),一定要追价 */
    spotStop?: boolean;
    row: Rec; out: TrackerPollTick;
  }): void {
    const { track, raw, position, state, reason, spotReached, row, out } = args;
    const tid = String(track["id"]);
    row["hosted"] = true;
    const secType = String(raw["sec_type"] ?? "");
    // 组合与单腿期权的止盈单挂在模型价(中间价口径)上,标的真到了目标价,买价也未必够得着——那时同样改到立刻成交的价
    const derivative = secType === "BAG" || secType === "OPT" || secType === "FOP";
    const live = this.liveKinds(tid);
    const covered = (HostedOrders.COVERING[state] ?? []).some((k) => live.has(k));
    // 组合只托管止盈单:止损类在券商侧永远没有单,不用等对账就知道。其余品种要对过一次账才作数(见 synced)
    const uncoveredForSure = secType === "BAG" && state !== tk.STATE_TAKE_PROFIT;
    const sweep = (derivative && spotReached) || Boolean(args.spotStop) || uncoveredForSure || (!covered && this.synced.has(tid));
    if (sweep && tk.sweepReason(track) === null && !track["fired_at"]) {
      const breaker = this.killswitch.state();
      const blockers = tk.closeBlockers({
        auto: tk.makeAutoClose(track["auto_close"] ?? {}),
        position,
        accountIsPaper: this.accountIsPaper(track["account"]),
        autoExecute: this.settings.policies.auto_execute,
        allowLiveTrading: this.settings.policies.allow_live_trading,
        breakerEngaged: breaker.engaged && !breaker.auto,
        // 托管单挂着等成交,不是立刻发出去:时段闸门不适用(同 syncHosted)
        marketStatus: "盘中",
        alreadyFired: false,
      });
      if (blockers.length) {
        // 到价了但动不了,必须当场说。只提醒一次,不刷屏(同软件平仓那条路)
        if (!track["fired_state"]) {
          this.store.updateTrack(tid, { fired_state: "blocked" });
          this.notifier.warning(`${track["symbol"]} ${reason},但没有平仓:${blockers.join("、")}`);
        }
        row["blocked"] = blockers;
        out["blocked"].push({ id: track["id"], symbol: track["symbol"], reason, blockers });
        return;
      }
      const firedState = `${tk.SWEEP_PREFIX}${state}`;
      this.store.updateTrack(tid, { fired_at: nowIsoSecondsEt(), fired_state: firedState });
      this.store.audit("engine", "hosted_sweep", { track: tid, symbol: track["symbol"], state, reason, mark: position.market_price, record: this.tpEntry(tid)?.["record_id"] ?? null });
      // 该出手了:上一次被拒留下的退避不再等
      this.clearBackoff(tid);
      this.notifier.notify(
        "追价平仓",
        `${track["symbol"]}:${reason}。${covered ? "托管单改到" : "券商侧没有负责这一项的单,在同一组里挂一张止盈单,挂在"}立刻成交的价,没成交就每秒再追`,
      );
      out["fired"].push({ id: track["id"], symbol: track["symbol"], state: firedState, reason });
    }
    if (tk.sweepReason(this.store.getTrack(tid) ?? track) !== null) {
      row["sweeping"] = true;
      // 托管对账在盯盘之后跑,这里给界面的是上一轮追到的价
      const tp = this.tpEntry(tid);
      if (tp && tp["chase_limit"] !== undefined) {
        row["chase"] = {
          rounds: tp["chase_rounds"] ?? 0, limit: tp["chase_limit"], natural: tp["chase_natural"] ?? null,
          floor: tp["chase_floor"] ?? null,
        };
      }
    }
  }

  /** 这条追踪在券商那边挂着的托管单(给界面看的那几个字段)。 */
  private hostedRows(tid: string): HostedOrderRow[] {
    const entries = this.hosted.get(tid) ?? new Map<string, Rec>();
    return [...entries.values()].map((v) => ({
      kind: v["kind"], label: v["label"], quantity: v["quantity"],
      lmt_price: v["lmt_price"] ?? null, aux_price: v["aux_price"] ?? null,
      trailing_percent: v["trailing_percent"] ?? null, order_id: v["order_id"] ?? null,
    }));
  }

  /**
   * 托管单收到订单级错误:**在这一刻就定**,依据是我们刚对这张单做了什么——
   *  · 202 已撤单:单子没了,摘掉;
   *  · 刚挂的单被拒:券商那边根本没有这张单,摘掉、退避、报原因;
   *  · 改价被拒:原单还在、还是原价,缓存恢复成上一次被接受的价,退避期内不再改。
   * 2026-09-10 真机:托管止盈单吃了 10311 被拒,IBKR 没推 Cancelled,缓存却一直当它在站岗——
   * 券商那边 0 张单,界面上照样显示「已托管」。
   */
  onError(orderId: number, code: number, message: string): void {
    const where = this.hostedIndex.get(orderId);
    if (!where) return;
    const [tid, kind] = where;
    const entry = this.hosted.get(tid)?.get(kind);
    if (entry === undefined) return;
    const reason = `IBKR ${code}: ${message}`;
    const track = this.store.getTrack(tid);
    const symbol = track ? track["symbol"] : "?";
    // 券商接受过这张单(推过 Submitted / PreSubmitted、或是认领回来的)就说明它在券商侧:之后的错误都是在回某一次改单。
    // 只看 pending 不够——晚到的 Submitted 回执会把"改价中"的标记提前清掉,拿它判成"刚挂的单被拒"就会摘掉一张
    // 还活着的单,下一轮再挂一张,两张各成交一次(2026-09-27 审计)
    if (code !== 202 && (entry["pending"] === "modify" || entry["live"])) {
      if (entry["accepted"]) Object.assign(entry, entry["accepted"] as Rec);
      entry["pending"] = null;
      this.hostedRetryAt.set(`${tid}|${kind}`, { at: Date.now() + 60_000, reason });
      this.notifier.warning(`${symbol} 的托管单改价被券商拒绝,仍挂在原价:${reason}`);
      return;
    }
    this.dropHostedEntry(tid, kind);
    if (code !== 202) {
      this.hostedRetryAt.set(`${tid}|${kind}`, { at: Date.now() + 60_000, reason });
      this.store.audit("engine", "hosted_rejected", { track: tid, kind, order_id: orderId, reason });
      this.notifier.warning(`${symbol} 的托管单被券商拒绝,没有挂上:${reason}`);
    }
  }

  /** 重启后按 orderRef 认领券商侧还挂着的托管单——先认领再对账,
   * 否则同一追踪会被再挂一遍。 */
  private async adoptHosted(): Promise<void> {
    const lister = this.router?.listHostedOpen;
    if (typeof lister !== "function") {
      this.hostedAdopted = true;
      return;
    }
    let rows: Rec[];
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      // 未成交单的请求本身没有超时:TWS 挂住时它永远不回,而对账在盯盘锁里——整条盯盘跟着停。10 秒放手,下一轮再认
      rows = await Promise.race([
        lister.call(this.router) as Promise<Rec[]>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("券商 10 秒没有回应未成交单列表")), 10_000); }),
      ]);
    } catch (exc) {
      // 下一轮再试
      this.store.audit("engine", "hosted_adopt_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    // 同一个"追踪 + 单型"在券商那边有多张:以前的 bug(重启认领落空、解析时临时改配置)
    // 留下的重复单。只认单号最新的那一张,其余当场撤掉——两张止盈卖单挂在 3 股持仓上,
    // 一起成交就是反向开仓(2026-09-10 真机:BE 同时挂着 #82 与 #86)。
    const byRef = new Map<string, Rec[]>();
    for (const row of rows) {
      const ref = String(row["order_ref"] ?? "");
      if (!ref.startsWith("trk:")) continue;
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref)!.push(row);
    }
    const keep = new Set<Rec>();
    for (const [ref, group] of byRef) {
      group.sort((a, b) => Number(b["order_id"] ?? 0) - Number(a["order_id"] ?? 0));
      keep.add(group[0]!);
      for (const dup of group.slice(1)) {
        const orderId = Number(dup["order_id"] ?? 0);
        if (!orderId) continue;
        this.host.sentOrders.set(orderId, { at: Date.now(), kind: "cancel" });
        try {
          await this.router!.cancelHosted!(orderId);
          this.store.audit("engine", "hosted_duplicate_cancelled", { order_ref: ref, order_id: orderId, kept: group[0]!["order_id"] });
          this.notifier.warning(`撤掉了一张重复的托管单 #${orderId}(同一追踪只留 #${group[0]!["order_id"]})`);
        } catch (exc) {
          this.store.audit("engine", "hosted_duplicate_cancel_failed", {
            order_ref: ref, order_id: orderId, error: String((exc as Error).message).slice(0, 200),
          });
        }
      }
    }
    for (const row of rows) {
      if (!keep.has(row)) continue;
      const parts = String(row["order_ref"] ?? "").split(":");
      if (parts.length !== 3 || parts[0] !== "trk") continue;
      const [, tid, kind] = parts as [string, string, string];
      const entry: Rec = {
        kind,
        label: tk.HOSTED_LABELS[kind] ?? kind,
        order_id: row["order_id"] ?? null,
        // 执行对账已经按 orderRef 把这张单认回了它的记录的话,接上:之后的改价、成交落闩都记到那条记录上
        record_id: row["order_id"] ? (this.orderIndex.get(Number(row["order_id"])) ?? null) : null,
        quantity: row["quantity"] ?? null,
        lmt_price: row["lmt_price"] ?? null,
        aux_price: row["aux_price"] ?? null,
        trailing_percent: row["trailing_percent"] ?? null,
        // 从券商的未成交单里认领回来的:它就在券商侧
        live: true,
      };
      if (!this.hosted.has(tid)) this.hosted.set(tid, new Map());
      this.hosted.get(tid)!.set(kind, entry);
      if (row["order_id"]) this.hostedIndex.set(Number(row["order_id"]), [tid, kind]);
    }
    this.hostedAdopted = true;
    if (rows.length) this.store.audit("engine", "hosted_adopted", { count: rows.length });
  }

  private async placeHostedOne(track: Rec, item: tk.HostedOrderPlan, oca: string): Promise<void> {
    const account = this.settings.accountByAlias(track["account"]);
    if (account === null) throw new BrokerError(`账户别名 ${track["account"]} 已不存在。`);
    // 持仓行里的合约不能原样下单,和到价自动平仓走同一个 closeContract——两条路必须拼出
    // 同一张单,否则"核对过的"就只是其中一条:
    //  · 正股:TWS 报回来的是 exchange=NYSE/NASDAQ,原样发出去就是直连交易所,API 预防设置
    //    回 10311「该委托单将直接传递至 NYSE」拒单(2026-09-10 真机:托管止盈单就这么没挂上);
    //    closeContract 收敛成四要素走 SMART。
    //  · 组合:每条腿方向全部反转(持仓 +1/−2/+1 → 平仓 SELL 1 / BUY 2 / SELL 1)。
    // 拼不出一张能下的平仓合约(自定义组合这类结构):这是我们这头的事,不是券商失败——不计入熔断(见 syncHosted)
    const issue = tk.closeContractIssue(track);
    if (issue !== null) throw new HostedPlanError(issue);
    const contractSpec = ContractSpecSchema.parse(tk.closeContract((track["contract"] ?? {}) as Rec));
    const ref = `trk:${track["id"]}:${item.kind}`;
    const record: Rec = {
      ...this.baseRecord(
        `${item.label}:${item.action} ${item.quantity} ${track["symbol"]}(GTC,挂在券商服务器)`,
        "tracker", null,
      ),
      account: { alias: account.alias, account_id: account.account_id, is_paper: account.is_paper },
      contract: { ...(track["contract"] ?? {}) },
      order: {
        action: item.action, order_type: item.order_type, quantity: item.quantity,
        lmt_price: item.lmt_price, aux_price: item.aux_price,
        trailing_percent: item.trailing_percent,
      },
      execution_type: "HOSTED",
      signature: ref,
    };
    const recordId = this.store.createRecord(record);
    this.store.markSubmitIntent(recordId);

    const result = await this.router!.placeHosted!(account, contractSpec, item, oca, ref);
    if (result.order_id) this.host.sentOrders.set(Number(result.order_id), { at: Date.now(), kind: "place" });
    const entry: Rec = { ...item, order_id: result.order_id, record_id: recordId, pending: "place" };
    if (!this.hosted.has(String(track["id"]))) this.hosted.set(String(track["id"]), new Map());
    this.hosted.get(String(track["id"]))!.set(item.kind, entry);
    if (result.order_id) {
      this.hostedIndex.set(Number(result.order_id), [String(track["id"]), item.kind]);
      this.orderIndex.set(Number(result.order_id), recordId);
    }
    if (result.perm_id) this.orderIndex.set(Number(result.perm_id), recordId);
    this.store.appendEvent(recordId, "status", {
      status: result.status, order_id: result.order_id,
    });
    const early = result.order_id ? this.earlyOrderErrors.get(Number(result.order_id)) : undefined;
    if (early !== undefined) {
      // 错误比下单返回还早到:现在对上,和晚到的走同一条路
      this.earlyOrderErrors.delete(Number(result.order_id));
      this.onIbError(result.order_id, early[0], early[1]);
      return;
    }
    this.killswitch.recordSuccess("broker");
    this.notifier.notify("托管单已挂出", `${track["symbol"]}:${item.label}`);
  }

  private async modifyHostedOne(track: Rec, current: Rec, item: tk.HostedOrderPlan): Promise<void> {
    const orderId = current["order_id"];
    if (!orderId) return;
    // 改价被拒时券商那边还是这一版:先记下来,拒了就恢复成它(见 hostedOnError)
    current["accepted"] = {
      quantity: current["quantity"], lmt_price: current["lmt_price"], aux_price: current["aux_price"],
      trailing_percent: current["trailing_percent"], label: current["label"],
    };
    current["pending"] = "modify";
    this.host.sentOrders.set(Number(orderId), { at: Date.now(), kind: "modify" });
    const ok = await this.router!.modifyHosted!(Number(orderId), item);
    if (!ok) {
      // 券商侧已经不认识这张单(成交/撤销竞态):丢掉缓存,下一轮重挂
      this.dropHostedEntry(String(track["id"]), String(current["kind"]));
      return;
    }
    const recordId = current["record_id"];
    if (recordId) {
      this.store.appendEvent(String(recordId), "status", {
        status: "Adjusted",
        lmt_price: item.lmt_price,
        aux_price: item.aux_price,
        quantity: item.quantity,
      });
    }
    current["quantity"] = item.quantity;
    current["lmt_price"] = item.lmt_price;
    current["aux_price"] = item.aux_price;
    current["trailing_percent"] = item.trailing_percent;
    current["label"] = item.label;
  }

  private async cancelHostedTrack(trackId: string, reason: string): Promise<void> {
    const entries = this.hosted.get(trackId);
    if (!entries) return;
    for (const kind of [...entries.keys()]) {
      await this.cancelHostedOne(trackId, kind, reason);
    }
  }

  private async cancelHostedOne(trackId: string, kind: string, reason: string): Promise<void> {
    const entry = this.hosted.get(trackId)?.get(kind);
    if (entry === undefined) return;
    const orderId = entry["order_id"];
    if (orderId) {
      // 撤单回报可能在 cancelHosted 返回之前就到(见 onStatus):先记下是我们撤的
      entry["cancelling"] = true;
      this.host.sentOrders.set(Number(orderId), { at: Date.now(), kind: "cancel" });
      try {
        await this.router!.cancelHosted!(Number(orderId));
      } catch (exc) {
        // 撤单失败要让人知道,但不炸循环
        this.store.audit("engine", "hosted_cancel_failed", {
          track: trackId, kind, error: String((exc as Error).message).slice(0, 300),
        });
        entry["cancelling"] = false;
        return;
      }
    }
    const recordId = entry["record_id"];
    if (recordId) {
      this.store.appendEvent(String(recordId), "status", { status: "Cancelled", reason });
    }
    this.dropHostedEntry(trackId, kind);
  }

  private dropHostedEntry(trackId: string, kind: string): void {
    const entries = this.hosted.get(trackId);
    if (entries?.has(kind)) {
      const orderId = entries.get(kind)!["order_id"];
      if (orderId) this.hostedIndex.delete(Number(orderId));
      entries.delete(kind);
    }
    if (entries !== undefined && entries.size === 0) this.hosted.delete(trackId);
  }

  /** 托管单成交 → 追踪落闩时,kind 映射回软件盯盘同一套触发状态。 */
  private static readonly HOSTED_FIRED_STATE: Record<string, string> = {
    tp: "take_profit", sl: "stop_loss", trail: "stop_loss", ptrail: "profit_trail",
  };
  /** 触发状态 → 给人看的名字。追价平仓那一路(还在 engine.ts)也读它。 */
  static readonly STATE_LABEL: Record<string, string> = {
    take_profit: "止盈", stop_loss: "止损", profit_trail: "利润回撤", manual: "手动平仓",
  };

  /** 托管单的终态处理:成交 → 追踪落闩;撤销 → 丢缓存。
   * OCA 的兄弟单由券商自动撤,撤单回报走同一条路清理缓存。 */
  onStatus(trade: any): void {
    const orderId = trade?.order?.orderId;
    if (!orderId || !this.hostedIndex.has(Number(orderId))) return;
    const [tid, kind] = this.hostedIndex.get(Number(orderId))!;
    const status = String(trade?.orderStatus?.status ?? "");
    if (status === "Filled") {
      const entry = this.hosted.get(tid)?.get(kind) ?? {};
      const before = this.store.getTrack(tid);
      // 追价平仓成交的:记当初触发的原因(止损 / 利润回撤 / 标的到了目标价),不是笼统的"托管止盈"
      const sweep = before ? tk.sweepReason(before) : null;
      this.store.updateTrack(tid, {
        fired_at: nowIsoSecondsEt(),
        fired_state: sweep ?? HostedOrders.HOSTED_FIRED_STATE[kind] ?? kind,
        fired_record: entry["record_id"] ?? "",
        enabled: false,
      });
      const track = this.store.getTrack(tid);
      const symbol = track ? track["symbol"] : "?";
      // 保护规则按审计表数"最近几次止损"、算同一标的的冷却(store.recentCloses)。追价平仓触发时已经记过 hosted_sweep,
      // 这里只记券商自己触发的那些——以前一笔都不记,股票最主要的止损路径(券商侧 STP)在保护规则眼里等于不存在
      if (sweep === null) {
        this.store.audit("engine", "hosted_fill", { track: tid, symbol, state: HostedOrders.HOSTED_FIRED_STATE[kind] ?? kind, record: entry["record_id"] ?? null });
      }
      this.notifier.notify("托管单已成交", `${symbol}:${entry["label"] ?? kind}`);
      // 整组落闩:OCA 兄弟单券商会自己撤,这里直接清缓存
      for (const k of [...(this.hosted.get(tid)?.keys() ?? [])]) {
        this.dropHostedEntry(tid, k);
      }
    } else if (["Cancelled", "ApiCancelled", "Inactive"].includes(status)) {
      const entry = this.hosted.get(tid)?.get(kind);
      this.dropHostedEntry(tid, kind);
      // 不是我们撤的(券商撤了、或有人在 TWS 里撤了):以前下一秒原样重挂,撤一次挂一次,还每次报"已挂出"。
      // 退避 60 秒,并在下一轮对账时说一声(那时若是 OCA 兄弟单成交落了闩,这条追踪已经不会再走到这里)
      if (entry !== undefined && !entry["cancelling"]) {
        this.hostedRetryAt.set(`${tid}|${kind}`, {
          at: Date.now() + 60_000, reason: `券商侧${status === "Inactive" ? "把这张托管单置为失效" : "撤掉了这张托管单"}`, warn: true,
        });
      }
    } else if (["Submitted", "PreSubmitted"].includes(status)) {
      // 券商接受了这一版(新挂的或改过价的):之后再来的错误就不是"刚才那一下被拒"
      const entry = this.hosted.get(tid)?.get(kind);
      if (entry) {
        entry["pending"] = null;
        entry["live"] = true;
        // 部分成交:记住已成交的数量,对账改总量时不把剩下的再砍一截(见 syncHosted)
        const filled = finiteOrNull(trade?.orderStatus?.filled ?? null);
        if (filled !== null && filled > 0) entry["filled"] = filled;
      }
    }
  }
}
