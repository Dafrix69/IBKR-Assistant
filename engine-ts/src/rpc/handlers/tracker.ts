/** positions.list 与 tracker.*:持仓、追踪目标的建 / 改 / 删、试算、立即平仓。
 *  positions.list 与 tracker.list / add / update / delete / target_preview 已经在契约里(contract/positions.ts、contract/tracker.ts,
 *  tracker.* 的入参 schema 是 strict 的);tracker.poll / reconcile / close_now 还是老方法——它们的返回是 engine.ts 拼的,等它拆开再标类型。 */
import { BrokerError } from "../../broker.js";
import { nowEt } from "../../config.js";
import type {
  PositionRow, RpcResult, Track, TrackerAddParams, TrackerDeleteParams, TrackerTargetPreviewParams, TrackerUpdateParams,
} from "../../contract/index.js";
import { RpcError } from "../../rpcError.js";
import * as tkMod from "../../tracker.js";
import type { TrackPatch } from "../../store.js";
import { HandlerBase } from "../context.js";
import type { MethodTable, Rec } from "../context.js";
import { contractMethods } from "../contractMethods.js";
import { drawdownTiersOf, optFloat } from "../params.js";

/** 券商没报盈亏(positions() 兜底路径只有成本)时,用追踪器同一套口径本地算(对应 Python _fill_pnl)。 */
function fillPnl(row: PositionRow): void {
  if (row["unrealized_pnl"] !== null && row["unrealized_pnl"] !== undefined) {
    row["pnl_source"] = row["pnl_source"] ?? "broker";
    return;
  }
  if (row["market_price"] === null || row["market_price"] === undefined) {
    row["pnl_source"] = row["pnl_source"] ?? null;
    // 休市没有现价:按昨收另算一份盈亏给界面(close_pnl),不写进 unrealized_pnl——那个字段是"此刻"的口径
    const close = Number(row["close_price"]);
    if (row["close_price"] !== null && row["close_price"] !== undefined && Number.isFinite(close)) {
      const at = tkMod.unrealized(tkMod.makePosition({
        account: String(row["account"]), symbol: String(row["symbol"]),
        sec_type: String(row["sec_type"] ?? "STK"), quantity: Number(row["quantity"] ?? 0) || 0,
        avg_cost: Number(row["avg_cost"] ?? 0) || 0, multiplier: Number(row["multiplier"] ?? 1) || 1,
        currency: String(row["currency"] ?? "USD"), market_price: close,
      }), close);
      row["close_pnl"] = at["unrealized_pnl"] ?? null;
      row["close_pct"] = at["unrealized_pct"] ?? null;
    }
    return;
  }
  const position = tkMod.makePosition({
    account: String(row["account"]), symbol: String(row["symbol"]),
    sec_type: String(row["sec_type"] ?? "STK"), quantity: Number(row["quantity"] ?? 0) || 0,
    avg_cost: Number(row["avg_cost"] ?? 0) || 0, multiplier: Number(row["multiplier"] ?? 1) || 1,
    currency: String(row["currency"] ?? "USD"), market_price: row["market_price"],
  });
  const out = tkMod.unrealized(position, row["market_price"]);
  if (row["market_value"] === null || row["market_value"] === undefined) row["market_value"] = out["market_value"] ?? null;
  row["unrealized_pnl"] = out["unrealized_pnl"] ?? null;
  row["unrealized_pct"] = out["unrealized_pct"] ?? null;
  row["pnl_source"] = "computed";
}

export class TrackerHandlers extends HandlerBase {
  methods(): MethodTable {
    return {
      "tracker.poll": (p) => this.trackerPoll(p),
      "tracker.reconcile": (p) => this.trackerReconcile(p),
      "tracker.close_now": (p) => this.trackerCloseNow(p),
      ...contractMethods({
        "positions.list": () => this.positionsList(),
        "tracker.list": () => this.trackerList(),
        "tracker.add": (p) => this.trackerAdd(p),
        "tracker.update": (p) => this.trackerUpdate(p),
        "tracker.delete": (p) => this.trackerDelete(p),
        "tracker.target_preview": (p) => this.trackerTargetPreview(p),
      }),
    };
  }

  // ---- 持仓追踪 --------------------------------------------------------
  async positionsList(): Promise<RpcResult<"positions.list">> {
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32018, "读取持仓");
    }
    let rows: PositionRow[];
    try {
      rows = await this.router.positions();
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32018, exc.message);
      throw exc;
    }
    const tracked = new Set(
      this.engine.store.listTracks().map((t) => tkMod.trackKey(t)),
    );
    // 期权腿按账户/标的/到期日认成组合(蝴蝶/价差/铁鹰),折成一条 BAG 虚拟行:
    // 用户盯的是"这只蝴蝶值多少",组合行和腿行都能追踪
    rows = tkMod.withCombos(rows);
    for (const row of rows) {
      row["tracked"] = tracked.has(row["key"]);
      fillPnl(row);
    }
    return { positions: rows };
  }

  trackerList(): RpcResult<"tracker.list"> {
    return { tracks: this.engine.store.listTracks() };
  }

  /**
   * 算一次预计价位与预估收益:标的走到 spot_target 时,这份持仓按当前波动率该值多少。
   * 正股、单腿期权、蝶式/价差走同一条路。只读,不建追踪也不发单——界面在用户填数的
   * 时候就要把这个数摆出来。
   */
  async trackerTargetPreview(params: TrackerTargetPreviewParams): Promise<RpcResult<"tracker.target_preview">> {
    const key = String(params["key"] ?? "");
    const target = optFloat(params["spot_target"]);
    if (target === null) throw new RpcError(-32602, "要给一个标的目标价 spot_target。");
    const rows = Object.fromEntries(tkMod.withCombos(await this.livePositions()).map((r) => [r["key"], r]));
    const raw = rows[key];
    if (raw === undefined) throw new RpcError(-32602, "找不到这个持仓,请刷新持仓列表。");
    const structure = tkMod.structureOf(String(raw["sec_type"] ?? "STK"), raw["contract"] as Rec);
    if (structure === null) {
      throw new RpcError(-32602, "这份持仓认不出结构,用不了标的目标价:"
        + "正股、单腿期权,以及每条腿都带行权价与看涨/看跌的组合才行。");
    }
    const position = this.positionOf(raw);
    const inputs = await this.spotInputs(raw, rows, structure);
    const st = tkMod.spotTarget({ structure, position, spotTarget: target, ...inputs });
    // 设置时会拒的那句(挂上去会立刻成交),试算时就说出来
    const warning = tkMod.fillsNowMessage(position, structure, st, inputs.markPrice);
    if (warning) st.warning = warning;
    // 此刻立刻平掉能拿到多少:和"标的到了目标价挂的价"摆在一起,人才知道追价平仓大概落在哪
    if (structure.kind !== "stock" && this.router !== null) {
      const natural = await this.engine.naturalCloseFor(raw, position, rows);
      if (natural !== null) {
        st.natural = natural;
        // 追价最多让到哪:自然价按 chase_max_pct 让满(界面没传就按默认)
        const auto = tkMod.makeAutoClose({ chase_max_pct: optFloat(params["chase_max_pct"]) ?? undefined });
        st.chase_floor = tkMod.chaseFloor(position, natural, auto);
        st.chase_max_pct = auto.chase_max_pct;
      }
    }
    return { spot_target: st, structure: { kind: structure.kind, label: structure.label } };
  }

  /**
   * 追踪目标的校验,新建与修改共用一份——两处各写一份,日后必然走样。
   *
   *  · 方向(多头止盈在上、止损在下……)
   *  · 止盈价与标的目标价二选一:都填的话,人以为自己定死了止盈价,实际每轮被覆盖
   *  · 组合托管只放开一张按标的目标价的限价止盈单,且不能再设止损类目标(托管一开引擎就不再
   *    自己发单,止损会没人盯)
   *  · 标的目标价要当场算得出、比现价更有利;开了自动平仓或托管的,还得是市场价算出来的
   */
  private async checkTargets(
    raw: Rec, rows: Record<string, Rec>, position: tkMod.Position, targets: tkMod.Targets, auto: tkMod.AutoClose,
  ): Promise<void> {
    const spot = targets.spot_target;
    if (spot !== null && targets.take_profit !== null) {
      throw new RpcError(-32602, "止盈价和标的目标价只能选一个:"
        + "填了标的目标价,止盈价就由引擎按当前波动率每轮现算,不用也不该再自己填。");
    }
    // 组合在券商那边只托管一张限价止盈单,价由标的目标价现算——没有目标价就没有这张单。
    // 止损 / 跟踪止损 / 利润回撤照样能设:由引擎盯,触发时把那张托管单改到立刻成交的价(追价平仓)
    if (raw["sec_type"] === "BAG" && auto.host_at_broker && spot === null) {
      throw new RpcError(-32602, "组合的「托管到券商」要先填标的目标价:"
        + "引擎按当前波动率把它换算成组合净价,挂一张随行情秒级调价的 GTC 限价单。"
        + "止损、利润回撤可以一起设,由引擎盯着,触发时把这张单改到立刻成交的价。");
    }
    try {
      tkMod.validate(position, targets, raw["market_price"]);
      if (spot !== null) {
        // 现在就算一次:算不出来的目标价不设。一条永远算不出止盈位的追踪在界面上
        // 和"还没到价"长得一模一样,用户会以为它在保护自己。
        const structure = tkMod.structureOf(String(raw["sec_type"] ?? "STK"), raw["contract"] as Rec);
        if (structure === null) {
          throw new tkMod.TrackerError(
            "这份持仓认不出结构,用不了标的目标价:正股、单腿期权,"
            + "以及每条腿都带行权价与看涨/看跌的组合才行。",
          );
        }
        const st = tkMod.validateSpotTarget({
          position, contract: raw["contract"] as Rec, spotTarget: spot,
          ...(await this.spotInputs(raw, rows, structure)),
        });
        // 「同意价格后发单」:能拿去发单的只有市场价算出来的数
        if ((auto.enabled || auto.host_at_broker) && !tkMod.MARKET_SIGMA_SOURCES.has(st.sigma_source)) {
          throw new tkMod.TrackerError(
            "现在拿不到市场报价,这个价是按模型默认波动率算的参考值,不能拿它发单。"
            + (st.spot_note ? `(${st.spot_note})` : "") + "等行情来了再设。",
          );
        }
      }
    } catch (exc) {
      if (exc instanceof tkMod.TrackerError) throw new RpcError(-32602, exc.message);
      throw exc;
    }
  }

  private positionOf(raw: Rec): tkMod.Position {
    return tkMod.makePosition({
      account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
      quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
      currency: raw["currency"], market_price: raw["market_price"],
    });
  }

  /** 算预计价位要的三样行情:标的现价、持仓报价、各腿报价。拿不到就是 null,不编。 */
  private async spotInputs(
    raw: Rec, rows: Record<string, Rec>, structure: tkMod.TargetStructure,
  ): Promise<{
    spot: number | null; markPrice: number | null;
    legPrices: Record<string, number | null>; minute: number; spotNote: string;
  }> {
    let spot: number | null = null;
    if (structure.kind === "stock") {
      spot = (raw["market_price"] ?? null) as number | null; // 正股自己就是标的
    } else {
      try {
        spot = this.router === null ? null : await this.router.indexPrice(String(raw["symbol"]));
      } catch {
        spot = null;
      }
    }
    const legPrices: Record<string, number | null> = {};
    for (const legKey of (raw["legs"] ?? []) as string[]) {
      const leg = rows[legKey];
      if (leg === undefined) continue;
      const c = (leg["contract"] ?? {}) as Rec;
      const strike = Number(c["strike"]);
      const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
      if (!Number.isFinite(strike) || !right) continue;
      legPrices[tkMod.legPriceKey({ strike, right })] = (leg["market_price"] ?? null) as number | null;
    }
    const info = structure.kind === "stock" || this.router === null
      ? null
      : (this.router as { spotInfo?: (s: string) => Rec | null }).spotInfo?.(String(raw["symbol"])) ?? null;
    // 夜盘推算失败时拿到的是昨收:当作没有现价,和盯盘那一路同一条规矩
    if (info?.["source"] === "index_stale") spot = null;
    return {
      spot,
      markPrice: (raw["market_price"] ?? null) as number | null,
      legPrices,
      minute: nowEt().minutes,
      spotNote: String(info?.["note"] ?? ""),
    };
  }

  /** 新建一个追踪。方向填反了在这里就拒——等触发了才发现已经晚了。 */
  async trackerAdd(params: TrackerAddParams): Promise<RpcResult<"tracker.add">> {
    return this.ctx.trackerLock(() => this.trackerAddLocked(params));
  }

  private async trackerAddLocked(params: TrackerAddParams): Promise<RpcResult<"tracker.add">> {
    const key = String(params["key"] ?? "");
    const rows = Object.fromEntries(tkMod.withCombos(await this.livePositions()).map((r) => [r["key"], r]));
    const raw = rows[key];
    if (raw === undefined) {
      throw new RpcError(-32602, "找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。");
    }
    const flySpot = optFloat(params["spot_target"]);

    const position = tkMod.makePosition({
      account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
      quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
      currency: raw["currency"], market_price: raw["market_price"],
    });
    const [tiers, late] = drawdownTiersOf(params);
    const targets = tkMod.makeTargets({
      take_profit: optFloat(params["take_profit"]),
      stop_loss: optFloat(params["stop_loss"]),
      trail_pct: optFloat(params["trail_pct"]),
      profit_drawdown_pct: optFloat(params["profit_drawdown_pct"]),
      profit_drawdown_tiers: tiers,
      profit_drawdown_late: late,
      spot_target: flySpot,
    });
    const auto = tkMod.makeAutoClose({
      enabled: Boolean(params["auto_close"]),
      order_type: params["order_type"] === "LMT" ? "LMT" : "MKT",
      slippage_pct: Number(params["slippage_pct"] ?? 0.3) || 0.3,
      close_fraction_pct: Number(params["close_fraction_pct"] ?? 100) || 100,
      host_at_broker: Boolean(params["host_at_broker"]),
      // 追价让价上限:0 也是合法值(至少两跳),所以不能用 || 兜底
      chase_max_pct: optFloat(params["chase_max_pct"]) ?? undefined,
    });
    if (auto.host_at_broker) this.requireHostingSupported(String(raw["account"]));
    await this.checkTargets(raw, rows, position, targets, auto);

    let track: Track;
    try {
      track = this.engine.store.addTrack({
        account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
        leg: raw["leg"] ?? "",
        contract: raw["contract"], targets, auto_close: auto,
        peak: raw["market_price"], note: String(params["note"] ?? "").slice(0, 200),
      });
    } catch (exc) {
      throw new RpcError(-32602, (exc as Error).message);
    }
    this.engine.store.audit("ui", "tracker_add", {
      symbol: raw["symbol"], targets, auto_close: auto,
    });
    return { track };
  }

  async trackerUpdate(params: TrackerUpdateParams): Promise<RpcResult<"tracker.update">> {
    return this.ctx.trackerLock(() => this.trackerUpdateLocked(params));
  }

  private async trackerUpdateLocked(params: TrackerUpdateParams): Promise<RpcResult<"tracker.update">> {
    const trackId = String(params["id"] ?? "");
    const track = this.engine.store.getTrack(trackId);
    if (track === null) throw new RpcError(-32602, "没有这个追踪");
    const fields: TrackPatch = {};
    if ("enabled" in params) {
      fields["enabled"] = Boolean(params["enabled"]);
      // 重新启用等于"再给一次机会":把上一次触发的闩解开
      if (fields["enabled"]) {
        Object.assign(fields, { fired_at: null, fired_state: "", fired_record: "" });
      }
    }
    if ("auto_close" in params) {
      // **合并**,不是整份替换:没带的键保持原样。2026-09-20 之前是替换——只改一个 close_fraction_pct,库里那份就只剩这一个键,
      // 读的那一头 makeAutoClose 补默认值:order_type 从 LMT 悄悄回到 MKT、分批比例回到 100%。在授权自动发单的路径上,
      // "悄悄换了下单方式"比报错危险。过了 schema 的入参里不会有值是 undefined 的键(里面的键不收 null,没带的键 zod 不产出);
      // 这道过滤是给绕过 schema 直接调 handler 的人留的:undefined 盖上去,JSON 落库时那个键就没了,等于又回到"替换"。
      const given = Object.entries(params["auto_close"] ?? {}).filter(([, value]) => value !== undefined);
      fields["auto_close"] = { ...(track["auto_close"] ?? {}), ...Object.fromEntries(given) };
      if ((fields["auto_close"] as Rec)["host_at_broker"]) {
        this.requireHostingSupported(String(track["account"]));
      }
    }
    if (["take_profit", "stop_loss", "trail_pct", "profit_drawdown_pct",
         "profit_drawdown_tiers", "profit_drawdown_preset", "spot_target"].some((k) => k in params)) {
      const [tiers, late] = drawdownTiersOf(params);
      const targets = tkMod.makeTargets({
        take_profit: optFloat(params["take_profit"]),
        stop_loss: optFloat(params["stop_loss"]),
        trail_pct: optFloat(params["trail_pct"]),
        profit_drawdown_pct: optFloat(params["profit_drawdown_pct"]),
        profit_drawdown_tiers: tiers,
        profit_drawdown_late: late,
        spot_target: optFloat(params["spot_target"]),
      });
      // 改目标和新建走**同一套**校验:以前这里什么都不查,改一下目标价就能绕过
      // 「算出来的价比现价还差、挂上去立刻成交」那道拦——等于绕过了「同意价格后发单」。
      const rows = Object.fromEntries(tkMod.withCombos(await this.livePositions()).map((r) => [r["key"], r]));
      const raw = rows[tkMod.trackKey(track)];
      if (raw === undefined) throw new RpcError(-32602, "找不到这个持仓(可能已经平掉了),改不了目标。");
      const auto = tkMod.makeAutoClose((fields["auto_close"] ?? track["auto_close"] ?? {}) as Rec);
      await this.checkTargets(raw, rows, this.positionOf(raw), targets, auto);
      fields["targets"] = targets;
    }
    if (!Object.keys(fields).length) throw new RpcError(-32602, "没有要改的字段");
    this.engine.store.updateTrack(trackId, fields);
    this.engine.store.audit("ui", "tracker_update", { id: trackId, fields: Object.keys(fields) });
    // 整段都在追踪锁里,tracker.delete 也走同一把锁,刚改过的行一定在;真读不回来就是库被别处动了,如实报
    const updated = this.engine.store.getTrack(trackId);
    if (updated === null) throw new RpcError(-32000, "追踪改完了,但库里读不回这一行");
    return { track: updated };
  }

  async trackerDelete(params: TrackerDeleteParams): Promise<RpcResult<"tracker.delete">> {
    return this.ctx.trackerLock(async () => this.trackerDeleteLocked(params));
  }

  private trackerDeleteLocked(params: TrackerDeleteParams): RpcResult<"tracker.delete"> {
    if (!this.engine.store.deleteTrack(String(params["id"] ?? ""))) {
      throw new RpcError(-32602, "没有这个追踪");
    }
    return { deleted: true };
  }

  /** 盯盘结果。节拍器在跑就读它最新一轮(即答);没在跑(没连券商)才就地算一次。
   * 触发 / 被拦由节拍器当场推送("tracker" 事件),这里的返回只给界面画行。 */
  async trackerPoll(_params: Rec): Promise<Rec> {
    const engine = this.engine;
    const loop = engine.trackerLoop;
    if (loop["running"] && loop["poll"]) {
      return { ...(loop["poll"] as Rec), fired: [], blocked: [], loop: engine.trackerHeartbeat() };
    }
    const result = await this.ctx.trackerLock(() => engine.pollTrackers());
    if ((result["fired"] as Rec[]).length || (result["blocked"] as Rec[]).length) {
      this.emit("tracker", result);
    }
    return { ...result, loop: engine.trackerHeartbeat() };
  }

  /** host_at_broker 只有 IBKR 账户能开——富途没有可同形托管的 GTC+OCA。
   * 在设置那一刻就拒,而不是等对账循环静默跳过:用户以为"关机也有保护",
   * 实际什么都没挂,这种落差比直接拒绝危险得多。 */
  private requireHostingSupported(alias: string): void {
    const account = this.settings.accountByAlias(alias);
    const broker = account ? this.settings.accountBroker(account) : "ibkr";
    if (broker !== "ibkr") {
      throw new RpcError(
        -32602,
        "富途账户暂不支持把止盈/止损托管到券商服务器,请用软件盯盘(保持软件开启)。",
      );
    }
  }

  /** 界面按秒驱动:把券商侧托管单和追踪设置对齐。
   * 动态目标(利润回撤)的停损价在这里按秒棘轮调整;软件关掉,
   * 最后一次调整的托管单仍在券商侧站岗。 */
  async trackerReconcile(_params: Rec): Promise<Rec> {
    const engine = this.engine;
    const loop = engine.trackerLoop;
    if (loop["running"] && loop["hosted"]) return { ...(loop["hosted"] as Rec), loop: engine.trackerHeartbeat() };
    const result = await this.ctx.trackerLock(() => engine.syncHosted());
    return { ...result, loop: engine.trackerHeartbeat() };
  }

  /** 手动一键平仓:走和自动平仓完全相同的那条路——包括同样的闸门。 */
  async trackerCloseNow(params: Rec): Promise<Rec> {
    return this.ctx.trackerLock(() => this.trackerCloseNowLocked(params));
  }

  private async trackerCloseNowLocked(params: Rec): Promise<Rec> {
    const track = this.engine.store.getTrack(String(params["id"] ?? ""));
    if (track === null) throw new RpcError(-32602, "没有这个追踪");
    const rows = Object.fromEntries(tkMod.withCombos(await this.livePositions()).map((r) => [r["key"], r]));
    const key = tkMod.trackKey(track);
    const raw = rows[key];
    if (raw === undefined) throw new RpcError(-32602, "这个持仓已经不在了。");

    const position = tkMod.makePosition({
      account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
      quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
      currency: raw["currency"], market_price: raw["market_price"],
    });
    const auto = tkMod.makeAutoClose(track["auto_close"] ?? {});
    auto.enabled = true; // 手动平仓不看"自动平仓"那个开关,是你在点
    const blockers = tkMod.closeBlockers({
      auto, position,
      accountIsPaper: this.engine.accountIsPaper(track["account"]),
      autoExecute: this.settings.policies.auto_execute,
      allowLiveTrading: this.settings.policies.allow_live_trading,
      breakerEngaged: this.engine.killswitch.state().engaged,
      marketStatus: this.settings.marketStatus(nowEt()),
      outsideRth: true, // 手动平仓同样全时段:盘外自动转限价
      alreadyFired: false,
      comboLiveOk: this.settings.policies.allow_combo_live,
    });
    if (blockers.length) throw new RpcError(-32019, `不能平仓:${blockers.join("、")}`);

    // 券商那边已经有这条追踪的单(托管的止盈单、或正在追价的平仓单):改那张去追价,不另发一张——
    // 两张各平一次就是反向开仓
    if (await this.engine.sweepExisting(track, "手动平仓")) {
      return { fired: { id: track["id"], symbol: track["symbol"], state: tkMod.STATE_STOP_LOSS, reason: "手动平仓:现有的单改到立刻成交的价追价" } };
    }
    // 期权 / 组合的限价按各腿买卖价合成的立刻成交价算(拿不到才退回现价让滑点),和到价自动平仓同一口径
    let price = raw["market_price"];
    if (raw["sec_type"] === "BAG" || raw["sec_type"] === "OPT" || raw["sec_type"] === "FOP") {
      const natural = await this.engine.naturalCloseFor(raw, position, rows);
      if (natural !== null) price = natural;
    }
    const result = { state: tkMod.STATE_STOP_LOSS, price, reason: "手动平仓" };
    const fired = await this.engine.closePosition(track, position, auto, result);
    if (!fired) throw new RpcError(-32019, "平仓单没有发出去,详见引擎日志与交易记录。");
    return { fired };
  }

  private async livePositions(): Promise<Rec[]> {
    if (this.router === null || !this.router.sessions().length) {
      throw this.needConnection(-32018, "读取持仓");
    }
    try {
      return await this.router.positions();
    } catch (exc) {
      if (exc instanceof BrokerError) throw new RpcError(-32018, exc.message);
      throw exc;
    }
  }
}
