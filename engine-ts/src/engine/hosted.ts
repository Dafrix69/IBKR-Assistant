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
import type { Notifier } from "../notify.js";
import { finiteOrNull } from "../py.js";
import type { TradeStore } from "../store.js";
import type { Rec } from "../store.js";
import * as tk from "../tracker.js";
import { nowIsoSecondsEt } from "./clock.js";

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
  /** 被券商拒掉的:track_id|kind → {到期时刻, 原因}。退避期内不重挂也不再改价 */
  private readonly hostedRetryAt = new Map<string, { at: number; reason: string }>();

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

  /** 熔断撤了全部单:缓存跟着清。 */
  clear(): void {
    this.hosted.clear();
    this.hostedIndex.clear();
  }
  // ---- 券商托管的止盈/止损:对账循环 -----------------------------------
  /** 把"追踪设置"和"券商侧挂着的托管单"对齐(挂缺的、改变了的、撤多余的)。
   *
   * 由界面按秒驱动。软件盯盘怕的三件事——轮询漏插针、软件必须开着、我们
   * 这头行情延迟——托管单都不怕:触发发生在券商服务器的实时行情上。 */
  async syncHosted(rows?: Rec[] | null): Promise<Rec> {
    const out: Rec = { hosted: [], blocked: [], quote_maybe_delayed: false };
    const router = this.router;
    if (router === null || !router.SUPPORTS_HOSTED_CLOSE) return out;
    const tracks = this.store.listTracks();
    const wantsHosting = tracks.some((t) => Boolean((t["auto_close"] ?? {})["host_at_broker"]));
    if (!wantsHosting && this.hosted.size === 0) return out;
    if (!this.hostedAdopted) await this.adoptHosted();

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
        breakerEngaged: breaker.engaged,
        marketStatus: "盘中",
        alreadyFired: Boolean(track["fired_at"]) && !sweeping,
        comboLiveOk: this.settings.policies.allow_combo_live,
      });
      if (blockers.length) {
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
      const desired = new Set(plan.map((item) => item.kind));
      // 只守不挂的这一轮,止盈单"不在计划里"不等于"该撤":撤掉一张站岗的单比停在旧价危险得多
      if (hold) desired.add(tk.HOSTED_KIND_TP);
      for (const kind of [...current.keys()].filter((k) => !desired.has(k))) {
        await this.cancelHostedOne(tid, kind, "该目标已移除");
      }
      const oca = `dafri-trk-${tid.slice(0, 8)}`;
      for (const item of plan) {
        const cur = current.get(item.kind);
        const retry = this.hostedRetryAt.get(`${tid}|${item.kind}`);
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
          // 单张失败不拖垮整轮
          this.store.audit("engine", "hosted_place_failed", {
            track: tid, kind: item.kind, error: String((exc as Error).message).slice(0, 300),
          });
          this.killswitch.recordFailure((exc as Error).message, "broker");
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

  /** 这条追踪在券商那边挂着的托管单(给界面看的那几个字段)。 */
  private hostedRows(tid: string): Rec[] {
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
    if (code !== 202 && entry["pending"] === "modify" && entry["accepted"]) {
      Object.assign(entry, entry["accepted"] as Rec, { pending: null });
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
    try {
      rows = await lister.call(this.router);
    } catch (exc) {
      // 下一轮再试
      this.store.audit("engine", "hosted_adopt_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return;
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
        record_id: null,
        quantity: row["quantity"] ?? null,
        lmt_price: row["lmt_price"] ?? null,
        aux_price: row["aux_price"] ?? null,
        trailing_percent: row["trailing_percent"] ?? null,
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

    const result = await this.router!.placeHosted!(account, contractSpec, item, oca, ref);
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
      try {
        await this.router!.cancelHosted!(Number(orderId));
      } catch (exc) {
        // 撤单失败要让人知道,但不炸循环
        this.store.audit("engine", "hosted_cancel_failed", {
          track: trackId, kind, error: String((exc as Error).message).slice(0, 300),
        });
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
    take_profit: "止盈", stop_loss: "止损", profit_trail: "利润回撤",
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
      this.notifier.notify("托管单已成交", `${symbol}:${entry["label"] ?? kind}`);
      // 整组落闩:OCA 兄弟单券商会自己撤,这里直接清缓存
      for (const k of [...(this.hosted.get(tid)?.keys() ?? [])]) {
        this.dropHostedEntry(tid, k);
      }
    } else if (["Cancelled", "ApiCancelled", "Inactive"].includes(status)) {
      this.dropHostedEntry(tid, kind);
    } else if (["Submitted", "PreSubmitted"].includes(status)) {
      // 券商接受了这一版(新挂的或改过价的):之后再来的错误就不是"刚才那一下被拒"
      const entry = this.hosted.get(tid)?.get(kind);
      if (entry) {
        entry["pending"] = null;
        // 部分成交:记住已成交的数量,对账改总量时不把剩下的再砍一截(见 syncHosted)
        const filled = finiteOrNull(trade?.orderStatus?.filled ?? null);
        if (filled !== null && filled > 0) entry["filled"] = filled;
      }
    }
  }
}
