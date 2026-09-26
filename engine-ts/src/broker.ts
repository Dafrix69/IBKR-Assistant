/** IBKR 下单层(对应 Python broker.py,§8)。
 *
 * 结构照抄:纯函数(定价数学)不碰网络,可脱机对拍;BrokerRouter 负责连接与
 * 路由,只认 AccountConfig。与 Python 版的差别只有一处:ib_insync 在 TS 世界
 * 没有对应物,这里把"会话"抽成 IbSession 接口(语义与 ib_insync 对齐),
 * 默认实现走 @stoqey/ib 的 IBApiNext(见 ibSession.ts)——现成的 reqId 配对
 * 与订阅管理都用库的,不自己写。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { nowEt } from "./config.js";
import type { AccountConfig, EtNow, IndexConfig, Settings } from "./config.js";
import type { ContractSpec, OrderSpec, TriggerSpec } from "./models.js";
import type { HostedOrderPlan } from "./positions.js";
import { legOf, makeKey, positionLabel } from "./positions.js";
import { MIN_BARS, TIMEFRAMES } from "./marketdata.js";
import type { BookL1, BookLevel, BookLiquidity, BookSnapshot } from "./contract/book.js";
import type { StockQuote } from "./contract/sectors.js";
import type { PositionRow } from "./contract/positions.js";
import type { VolumeSnapshot } from "./marketdata.js";
import type { ApprovedOrder } from "./validator.js";
import { fmtF, pyRound } from "./py.js";
import {
  ET, dateOrdinal, ibEndUtc, ibWallTime, ordinalToDate, pad2, utcIso, wallParts, wallToEpoch, zonedEpoch,
} from "./tz.js";
import {
  describeContract, frontQuarterly, indexContract, optionContract, pickTradingClass, stockContract, streamContract,
} from "./ibContracts.js";
import type {
  IbContract, IbSession, IbSessionFactory, OptChainParam, OrderIntent, PortfolioItemLike, PositionItemLike,
  RawBar, TickerData, TickerHandle,
} from "./ibTypes.js";
import { coveredAccounts, liveSessions, logStderr, redactForLog } from "./ibLink.js";
export { logStderr, redactForLog } from "./ibLink.js";

// IB 适配层的接口住在 ibTypes.ts;这里转出,老的 import 路径不变。
export type {
  IbContract, IbSession, IbSessionFactory, OptChainParam, OrderIntent, PortfolioItemLike, PositionItemLike,
  RawBar, TickerData, TickerHandle, TradeLike,
} from "./ibTypes.js";

type Rec = Record<string, any>;

export class BrokerError extends Error {}

// ======================================================================
// 纯计算部分(黄金对拍钉死)
// ======================================================================

export interface LegQuote {
  action: string; // BUY / SELL
  ratio: number;
  bid: number;
  ask: number;
}

export function legMid(leg: LegQuote): number {
  // NaN 在比较运算里全为 False,必须显式 isFinite
  if (
    !Number.isFinite(leg.bid) || !Number.isFinite(leg.ask) ||
    leg.bid <= 0 || leg.ask <= 0 || leg.ask < leg.bid
  ) {
    throw new BrokerError(
      `盘口不可用(bid=${pyNum(leg.bid)} ask=${pyNum(leg.ask)}),拒绝用坏报价定价`,
    );
  }
  return (leg.bid + leg.ask) / 2.0;
}

function pyNum(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** 价差净价 = Σ(买腿中间价) - Σ(卖腿中间价)。正数=借方,负数=贷方。 */
export function comboMidPrice(legs: LegQuote[]): number {
  if (!legs.length) throw new BrokerError("没有腿报价,无法计算中间价");
  let net = 0.0;
  for (const leg of legs) {
    const sign = leg.action === "BUY" ? 1.0 : -1.0;
    net += sign * legMid(leg) * leg.ratio;
  }
  return pyRound(net, 4);
}

/** 把带符号中间价转成 BAG(以 BUY 提交)可用的带符号限价。
 * 符号约定:正数 = 借方(付权利金),负数 = 贷方(收权利金)。 */
/** 组合净价的最小跳动。IBKR 对 BAG 不给 contractDetails,但每条 SPX 期权腿实测
 * minTick=0.05,组合净价按同一档走。不对齐的后果是**下单当场被拒**:错误 110
 * 「价格不符合该合约的最小价格变动要求」——2026-09-04 实测,AUTO_MID 算出 0.1750
 * (3.5 个 tick),IBKR 直接退单。 */
export const DEFAULT_COMBO_TICK = 0.05;

/** 把限价向上对齐到最小跳动的整数倍。
 *
 * 统一向上,是因为 autoMidLimit 的让价方向本来就是 `+slippage`:借方多付一点、贷方少收
 * 一点,两边都朝**更容易成交**的方向。对齐后仍朝同一方向,不会把本来能成的单改成挂着不动。 */
export function alignTickUp(value: number, tick = DEFAULT_COMBO_TICK): number {
  if (!Number.isFinite(value) || tick <= 0 || !Number.isFinite(tick)) return value;
  // 减一点容差:已经对齐的值不该因浮点误差被推到下一档(0.20/0.05 = 4.000000001 → 5)
  return pyRound(Math.ceil(value / tick - 1e-9) * tick, 4);
}

/** 向下对齐到最小跳动(只给上限夹取用,免得夹完又变成非法档位)。 */
export function alignTickDown(value: number, tick = DEFAULT_COMBO_TICK): number {
  if (!Number.isFinite(value) || tick <= 0 || !Number.isFinite(tick)) return value;
  return pyRound(Math.floor(value / tick + 1e-9) * tick, 4);
}

export function autoMidLimit(
  netMid: number, action: string, slippage: number, strikeWidthValue: number | null = null,
  tick = DEFAULT_COMBO_TICK,
): number {
  if (slippage < 0) throw new BrokerError("滑点上限不能为负");
  if (!Number.isFinite(netMid)) {
    throw new BrokerError(`中间价不是有限数值(${pyNum(netMid)}),拒绝定价`);
  }
  if (action === "SELL" && netMid >= 0) {
    throw new BrokerError(
      `贷方组合的净中间价应为负(收权利金),实际为 ${fmtF(netMid, 4)}——腿方向与订单方向` +
      "不一致,拒绝定价以免反向建仓。",
    );
  }
  if (action === "BUY" && netMid <= 0) {
    throw new BrokerError(
      `借方组合的净中间价应为正(付权利金),实际为 ${fmtF(netMid, 4)}——腿方向与订单方向` +
      "不一致,拒绝定价以免反向建仓。",
    );
  }
  let limit = alignTickUp(netMid + slippage, tick);
  if (action === "BUY") {
    // 净权利金不可能超过翼宽(§5.3a)。夹回来之后再对齐一次,方向朝下。
    if (strikeWidthValue !== null) limit = Math.min(limit, alignTickDown(strikeWidthValue, tick));
    if (limit <= 0) throw new BrokerError(`计算出的买入限价 ${fmtF(limit, 4)} 非正,拒绝下单`);
  } else if (limit >= 0) {
    throw new BrokerError(`贷方限价 ${fmtF(limit, 4)} 已不再为负(滑点吃光了权利金),拒绝下单`);
  }
  return pyRound(limit, 4);
}

/** 把用户口径的组合限价转成 IBKR BAG 的带符号净价。
 * BAG 必须一律以 BUY 提交(SELL 会反转每条腿);贷方限价取负。 */
export function bagSignedLimit(action: string, userLimit: number | null): number | null {
  if (userLimit === null) return null;
  return action === "SELL" ? -userLimit : userLimit;
}

/** 从盘口算流动性指标。挂单可撤,失衡只是即时快照,不是方向预测。 */
export function bookLiquidity(book: Partial<BookSnapshot>): BookLiquidity {
  const l1: Partial<BookL1> = book["l1"] ?? {};
  const bids: BookLevel[] = book["bids"] ?? [];
  const asks: BookLevel[] = book["asks"] ?? [];
  const out: BookLiquidity = {};

  const spreadBps = l1["spread_bps"];
  if (spreadBps !== null && spreadBps !== undefined) {
    out["spread_bps"] = spreadBps;
    out["spread_grade"] =
      spreadBps <= 5 ? "很好" : spreadBps <= 20 ? "尚可" : spreadBps <= 60 ? "偏宽" : "很宽";
  }

  const bidDepth = bids.reduce((acc, x) => acc + (Number(x["size"]) || 0), 0);
  const askDepth = asks.reduce((acc, x) => acc + (Number(x["size"]) || 0), 0);
  if (bids.length || asks.length) {
    out["bid_depth"] = pyRound(bidDepth, 2);
    out["ask_depth"] = pyRound(askDepth, 2);
    out["levels"] = Math.max(bids.length, asks.length);
    const total = bidDepth + askDepth;
    if (total > 0) out["imbalance_pct"] = pyRound(((bidDepth - askDepth) / total) * 100.0, 1);
  } else if (l1["bid_size"] || l1["ask_size"]) {
    const b = Number(l1["bid_size"]) || 0;
    const a = Number(l1["ask_size"]) || 0;
    if (b + a > 0) {
      out["imbalance_pct"] = pyRound(((b - a) / (b + a)) * 100.0, 1);
      out["l1_only"] = true;
    }
  }
  return out;
}

/** 把 IBKR 的取数报错翻译成"下一步该做什么"。 */
export function barsError(symbol: string, label: string, exc: Error): string {
  const text = String(exc.message ?? exc);
  const lowered = text.toLowerCase();
  if (
    text.includes("162") || text.includes("354") ||
    lowered.includes("permission") || lowered.includes("subscri")
  ) {
    return (
      `${symbol} 没有 ${label} 的行情权限。IBKR 的历史数据同样要订阅,连延迟数据也要账户里` +
      "先开通对应交易所。去 IBKR 账户管理 → Settings → User Settings → " +
      "Market Data Subscriptions 里订阅该标的所属交易所(美股至少要一档 Level 1;" +
      `SPX / VIX / RUT 这类指数属于 Cboe,要单独订阅)。原始报错:${text.slice(0, 200)}`
    );
  }
  return `获取 ${symbol} 的 ${label} K 线失败:${text.slice(0, 300)}`;
}

/** IBKR 的 bar.date 归一化成 'YYYY-MM-DD HH:MM'(日线为 'YYYY-MM-DD')。 */
export function barTimestamp(value: unknown): string {
  const text = String(value ?? "").trim();
  const digits = text.replace(/-/g, "").replace(/:/g, "").split(/\s+/).filter(Boolean);
  if (digits.length && digits[0]!.length === 8 && /^\d{8}$/.test(digits[0]!)) {
    const d = digits[0]!;
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (digits.length > 1 && digits[1]!.length >= 4 && /^\d{6}/.test(digits[1]!.slice(0, 6))) {
      // IBKR 的 K 线时间是**交易所时区**(SPX 在 Cboe → 美中,比美东慢一小时),
      // 带时区名时换成美东再落字符串;否则 K 线看起来永远"落后一小时",新鲜度告警误报。
      const tz = digits.length > 2 && digits[2]!.includes("/") ? digits[2]! : null;
      const hour = Number(digits[1]!.slice(0, 2));
      const minute = Number(digits[1]!.slice(2, 4));
      const second = Number(digits[1]!.slice(4, 6));
      if (tz) {
        try {
          const epoch = wallToEpoch({
            year: Number(d.slice(0, 4)), month: Number(d.slice(4, 6)), day: Number(d.slice(6, 8)),
            hour, minute, second,
          }, tz);
          const p = wallParts(epoch, ET);
          return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
        } catch {
          /* 时区名认不出就走下面的老路径,不编 */
        }
      }
      return `${day} ${digits[1]!.slice(0, 2)}:${digits[1]!.slice(2, 4)}`;
    }
    return day;
  }
  return text;
}

/** 把 IBKR 的报价字段清洗成可用数字:NaN / 非正 / 非数字都归 null。 */
export function cleanPrice(value: unknown): number | null {
  const v = Number(value);
  if (value === null || value === undefined || Number.isNaN(v)) return null;
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** 量能流拿不到数时的空快照(字段齐全,全是 null)。 */
function emptyVolumeSnapshot(): VolumeSnapshot {
  return {
    last: null, close: null, open: null, high: null, low: null,
    volume: null, avg_volume: null, hist_vol: null, vol_3m: null, vol_5m: null, vol_10m: null,
    delayed: false, last_trade_at: null,
  };
}

/** 定价链路用:null/NaN/inf 一律归 0(无报价),交给 legMid 的守卫拦截。 */
export function finiteQuote(value: unknown): number {
  const v = Number(value);
  if (value === null || value === undefined || Number.isNaN(v)) return 0.0;
  return Number.isFinite(v) ? v : 0.0;
}

/** 取盘口时值得告诉用户"为什么"的 IBKR 错误码(与 Python 版 _MD_ERROR_CODES 同表)。
 *  101 行情线路配额用完;354/10089/10090/10091/10167/10168 没有订阅;10197 纸面账户争用行情。 */
export const MD_ERROR_CODES = new Set([101, 354, 10089, 10090, 10091, 10167, 10168, 10197]);

/** 把取盘口时 TWS 回的错误码翻译成"下一步做什么"。文案与 Python 版 _quote_error_message 一致。 */
export function quoteErrorMessage(symbol: string, errors: Array<[number, string]>): string {
  const codes = new Set(errors.map(([c]) => c));
  const raw = errors.slice(0, 3).map(([c, m]) => `${c}: ${String(m).slice(0, 120)}`).join("; ");
  if (codes.has(101)) {
    return (
      `TWS 的行情线路已用完(IBKR 默认约 100 条并发),${symbol} 的盘口请求被拒。` +
      "顶栏「断开 TWS」再重连可立即释放全部线路;若反复出现,说明有订阅没撤。" +
      `原始报错:${raw}`
    );
  }
  if (codes.has(10197)) {
    return (
      `${symbol} 的行情被另一个会话占用(IBKR 10197):同一账号同时登着别的 TWS/客户端时,` +
      `行情只发给其中一个。关掉另一个再试。原始报错:${raw}`
    );
  }
  return (
    `该账户没有 ${symbol} 的行情订阅(实时和延迟都没有)。SPX / SPXW / VIX 属 Cboe 指数期权,` +
    "要在 IBKR 账户管理 → Market Data Subscriptions 单独订阅;纸面账户还需在实盘账户里" +
    `开启「与模拟账户共享行情」。原始报错:${raw}`
  );
}

/** AUTO_MID 借方限价的数学上限:垂直价差=行权价差;蝴蝶=翼宽;铁鹰回 null。 */
export function strikeWidth(contract: ContractSpec): number | null {
  const legs = [...(contract.legs ?? [])].sort((a, b) => a.strike - b.strike);
  if (contract.combo_strategy === "BUTTERFLY" && legs.length === 3) {
    return legs[1]!.strike - legs[0]!.strike;
  }
  if (legs.length === 2) return Math.abs(legs[0]!.strike - legs[1]!.strike);
  return null;
}

/** 把 trigger 描述成 PriceCondition 需要的参数(纯数据,便于断言)。 */
export function priceConditionSpec(trigger: TriggerSpec): Record<string, unknown> {
  return {
    symbol: trigger.symbol,
    secType: trigger.secType,
    isMore: trigger.operator === ">=",
    price: trigger.value,
  };
}

/** 按 orderType 构造订单意图。价格为空的组合在这里就报错,不留到 IBKR。 */
export function buildOrderIntent(
  spec: OrderSpec,
  accountId: string,
  limitOverride: number | null = null,
  actionOverride: string | null = null,
): OrderIntent {
  const action = actionOverride ?? spec.action;
  const limitPrice = limitOverride !== null ? limitOverride : spec.lmtPrice;
  const base: OrderIntent = {
    orderType: spec.orderType,
    action,
    totalQuantity: spec.totalQuantity,
    lmtPrice: null,
    auxPrice: null,
    trailingPercent: null,
    tif: spec.tif,
    outsideRth: spec.outsideRth,
    account: accountId,
    transmit: true,
  };
  if (spec.orderType === "MKT") {
    // 市价单不带价格
  } else if (spec.orderType === "LMT") {
    if (limitPrice === null) throw new BrokerError("限价单缺少限价(AUTO_MID 未定价?),拒绝下单");
    base.lmtPrice = limitPrice;
  } else if (spec.orderType === "STP") {
    base.auxPrice = spec.auxPrice;
  } else if (spec.orderType === "STP LMT") {
    base.lmtPrice = limitPrice;
    base.auxPrice = spec.auxPrice;
  } else if (spec.orderType === "TRAIL") {
    if (spec.trailingPercent !== null) base.trailingPercent = spec.trailingPercent;
    else base.auxPrice = spec.auxPrice;
  } else {
    throw new BrokerError(`不支持的订单类型:${spec.orderType}`);
  }
  return base;
}

// ======================================================================
// 会话接口(语义对齐 ib_insync;默认实现见 ibSession.ts)
// ======================================================================

// ======================================================================
// 连接与下单
// ======================================================================

export interface PendingTrigger {
  record_id: string;
  approved: ApprovedOrder;
  trigger: TriggerSpec;
  created_at: string;
  fired: boolean;
}

/** 方式 B:软件侧盯盘队列(AUTO_MID 定价必须走这条路,§8.1)。 */
export function shouldFire(pending: PendingTrigger, price: number): boolean {
  if (pending.trigger.operator === ">=") return price >= pending.trigger.value;
  return price <= pending.trigger.value;
}

export interface PlacementResult {
  record_id: string;
  order_id: number | null;
  perm_id: number | null;
  status: string;
  limit_price: number | null;
  detail: Record<string, unknown>;
}

export class BrokerRouter {
  /** 这个 router 说的是哪家券商的协议。 */
  static readonly BROKER = "ibkr";
  readonly BROKER = "ibkr";
  /** IBKR 支持把触发条件挂在券商服务器上(§8.1 方式 A)。 */
  readonly SUPPORTS_NATIVE_CONDITIONS = true;

  static readonly QUALIFY_TIMEOUT_MS = 12_000;
  /** 组合各腿盘口最多等这么久——所有腿合计,不是每腿。 */
  static readonly QUOTE_WAIT_MS = 4_000;

  readonly settings: Settings;
  private readonly factory: IbSessionFactory;
  private readonly connectionsMap = new Map<string, IbSession>();
  private readonly accountRoute = new Map<string, string>();
  sessionHook: ((session: IbSession) => void) | null = null;
  /** 某条连接断了(false)/ 自动重连回来了(true)。服务层据此提醒用户、留痕。 */
  linkHook: ((connection: string, up: boolean) => void) | null = null;
  private readonly streams = new Map<string, TickerHandle | null>();
  private upstreamOkFlag = true;

  constructor(settings: Settings, factory?: IbSessionFactory) {
    this.settings = settings;
    this.factory = factory ?? defaultFactory;
  }

  // ---- 连接 -----------------------------------------------------------
  get connections(): Record<string, { host: string; port: number; client_id: number; readonly: boolean }> {
    return this.settings.connectionsFor(this.BROKER);
  }

  async connect(connectionName: string): Promise<IbSession> {
    const existing = this.connectionsMap.get(connectionName);
    if (existing && existing.isConnected()) return existing;
    await existing?.disconnect(); // 断着的旧会话先停掉它自己的重连,别和新会话抢同一个 client id
    const cfg = this.connections[connectionName];
    if (cfg === undefined) {
      throw new BrokerError(`未定义的连接:${connectionName}(这里只在 IBKR 连接里查找)`);
    }
    let session: IbSession;
    try {
      session = await this.factory({
        host: cfg.host, port: cfg.port, clientId: cfg.client_id, readonly: cfg.readonly,
      });
    } catch (exc) {
      throw new BrokerError(
        `连接 ${connectionName} (${cfg.host}:${cfg.port}) 失败:${(exc as Error).message}。` +
        "请确认 TWS/IB Gateway 已启动且开启了本机 API。",
      );
    }
    this.upstreamOkFlag = true;
    session.onConnectivity((code) => {
      // 只盯 TWS↔IBKR 那一段的通断(1100 断 / 1101、1102 恢复)
      if (code === 1100) this.upstreamOkFlag = false;
      else if (code === 1101 || code === 1102) this.upstreamOkFlag = true;
    });
    session.onLink?.((up) => this.linkHook?.(connectionName, up));
    this.connectionsMap.set(connectionName, session);
    // 只服务纸面账户的会话,行情类型基线定成 3(有实时权限照样是实时,没有才给延迟)。
    // 行情类型是会话级的全局开关,各处取完价都"切回 1";而纸面会话在实盘 TWS 同时登录时按类型 1
    // 必吃 10197——切回 1 只会制造竞态:连接刚建好时请求实际发出去晚一拍,正好撞上"已切回 1",
    // 那条订阅就死了(2026-09-10 真机:ES 期货与期权腿价都是这样空掉的)。实盘会话不动,仍是 1:
    // 实盘绝不拿延迟价定价。
    const accounts = this.settings.accounts.filter((a) => a.connection === connectionName);
    if (accounts.length && accounts.every((a) => a.is_paper)) {
      try {
        session.setBaselineMarketDataType?.(3);
      } catch {
        /* 设不上就照旧,每个取价点仍会自己切 */
      }
    }
    if (this.sessionHook !== null) {
      try {
        this.sessionHook(session);
      } catch {
        /* 挂监听失败不应阻断连接本身 */
      }
    }
    return session;
  }

  /** 常规时段之外,连上就在后台把期货推算暖起来(订期货、取基差)。
   * 不暖的话,连上后第一笔速记单用的是昨收——拿它推断蝶的看涨看跌、挑行权价都是错的。
   * 不等它、也不让它的失败冒出去:暖不起来,第一次真用到时照样会再推一遍。 */
  warmIndexFutures(): void {
    if (this.settings.marketStatus(nowEt()) === "盘中") return;
    const symbols = Object.values(this.settings.index_symbols).filter((c) => c.futures).map((c) => c.symbol);
    if (!symbols.length) return;
    void (async () => {
      // 首笔 tick 常常赶不上第一次(期货农场慢、10197 时不时来一下):隔三秒再试,最多五次
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let allWarm = true;
        for (const symbol of symbols) {
          try {
            await this.indexPrice(symbol);
          } catch {
            /* 暖机失败不打扰任何人 */
          }
          if (this.spotInfo(symbol)?.["source"] !== "futures") allWarm = false;
        }
        if (allWarm || this.settings.marketStatus(nowEt()) === "盘中") return;
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
  }

  get upstreamOk(): boolean {
    return this.upstreamOkFlag;
  }

  async disconnectAll(): Promise<void> {
    await this.cancelStreams();
    for (const session of this.connectionsMap.values()) {
      if (session.isConnected()) await session.disconnect();
    }
    this.connectionsMap.clear();
    this.accountRoute.clear();
  }

  // 期权腿的常驻订阅:key → 合约(撤订阅要按它自己的合约撤)
  private readonly optionStreams = new Map<string, { handle: TickerHandle | null; contract: IbContract | null }>();

  private async cancelStreams(): Promise<void> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session !== null) {
      for (const symbol of this.streams.keys()) {
        try {
          session.cancelTicker(stockContract(symbol));
        } catch {
          /* 撤不掉也不该拦住断开 */
        }
      }
      for (const { contract } of this.optionStreams.values()) {
        if (!contract) continue;
        try {
          session.cancelTicker(contract);
        } catch {
          /* 同上 */
        }
      }
    }
    this.releaseVolumeStreams([]);
    this.volumeRetry.clear();
    this.streams.clear();
    this.optionStreams.clear();
    this.stockStreams.clear();
    // 期货流挂在旧会话上,断开后句柄就死了;不清掉的话重连后会一直读一个不再更新的价
    this.futStreams.clear();
    this.futuresBackoff.clear();
  }

  /** 找到真正管理该账户的会话。路由永远以会话实况为准。 */
  async forAccount(account: AccountConfig): Promise<IbSession> {
    const order: string[] = [];
    const cached = this.accountRoute.get(account.account_id);
    const connections = this.connections;
    if (cached && cached in connections) order.push(cached);
    if (account.connection in connections && !order.includes(account.connection)) {
      order.push(account.connection);
    }
    for (const name of Object.keys(connections)) if (!order.includes(name)) order.push(name);
    if (!order.length) {
      throw new BrokerError(
        `账户 ${account.alias} 绑的连接 ${account.connection} 不是 IBKR 连接(当前券商接入:IBKR)。` +
        "请在设置里把它改到一条 IBKR 连接,或把券商接入切回对应的那一家。",
      );
    }

    const failures: string[] = [];
    for (const name of order) {
      let session: IbSession;
      try {
        session = await this.connect(name);
      } catch (exc) {
        if (exc instanceof BrokerError) {
          failures.push(exc.message);
          continue;
        }
        throw exc;
      }
      const managed = new Set(session.managedAccounts());
      if (managed.has(account.account_id)) {
        if (name !== account.connection) {
          logStderr(
            `[router] 账户 ${redactForLog(account.account_id)} 实际由连接 ${name} 管理` +
            `(配置写的是 ${account.connection}),已自动改道`,
          );
        }
        this.accountRoute.set(account.account_id, name);
        return session;
      }
      if (!managed.size && name === account.connection) {
        return session; // 会话没报账户列表:只对配置指定的连接放行
      }
      failures.push(`连接 ${name} 的会话不管理该账户(当前登录的可能是另一个账户)`);
    }
    throw new BrokerError(
      `账户 ${account.alias} 在所有已配置连接上都找不到对应会话:` +
      `${failures.join(";") || "无可用连接"}。` +
      "请确认 TWS 当前登录的就是这个账户,或核对配置端口。",
    );
  }

  // ---- 合约 -----------------------------------------------------------
  /** conId 缓存:IBKR 的 conId 是永久标识,同一合约不必反复 reqContractDetails。
   * 每省一次就是省一整个网络往返——这是"输入到下单"链路里最省得动的一段。 */
  private readonly conIdCache = new Map<string, number>();
  /** 合约交易时段缓存:键 "标的|到期日",值 [查询日, tradingHours, liquidHours, tzId]。
   * 追踪轮询每 8 秒一轮,不能每轮都问券商;时段表一天只变一次,按日缓存足够。 */
  private readonly hoursCache = new Map<string, [string, string, string, string]>();

  private conIdKey(c: IbContract): string {
    return [
      c.secType ?? "", c.symbol ?? "", c.lastTradeDateOrContractMonth ?? "",
      c.strike ?? "", c.right ?? "", c.tradingClass ?? "", c.exchange ?? "",
      c.currency ?? "",
    ].join("|");
  }

  async qualify(contract: ContractSpec, account: AccountConfig): Promise<IbContract> {
    const session = await this.forAccount(account);
    if (contract.secType === "STK") {
      const target = stockContract(contract.symbol, contract.exchange, contract.currency);
      await this.qualifyOrRaise(session, target);
      return target;
    }
    if (contract.secType === "OPT") {
      const target = optionContract(
        contract.symbol, contract.lastTradeDateOrContractMonth!, contract.strike!,
        contract.right!, contract.exchange, contract.currency, contract.multiplier,
        contract.tradingClass ?? "",
      );
      await this.qualifyOrRaise(session, target);
      return target;
    }
    return this.buildBag(session, contract);
  }

  private async buildBag(session: IbSession, contract: ContractSpec): Promise<IbContract> {
    const opts = (contract.legs ?? []).map((leg) =>
      optionContract(
        contract.symbol, leg.lastTradeDateOrContractMonth, leg.strike, leg.right,
        contract.exchange, contract.currency, leg.multiplier, leg.tradingClass ?? "",
      ),
    );
    await this.qualifyAllOrRaise(session, opts);
    const legs = contract.legs ?? [];
    return {
      secType: "BAG",
      symbol: contract.symbol,
      currency: contract.currency,
      exchange: contract.exchange,
      comboLegs: opts.map((opt, i) => ({
        conId: opt.conId!, ratio: legs[i]!.ratio, action: legs[i]!.action,
        exchange: contract.exchange,
      })),
    };
  }

  /** 一批合约一次往返确认,而不是逐个串行;缓存命中的连这一次都省掉。 */
  private async qualifyAllOrRaise(session: IbSession, opts: IbContract[]): Promise<void> {
    const need: IbContract[] = [];
    for (const opt of opts) {
      const hit = this.conIdCache.get(this.conIdKey(opt));
      if (hit) opt.conId = hit;
      else need.push(opt);
    }
    if (!need.length) return;
    // 键必须在 qualify 之前算:qualify 会原地改写合约字段,
    // 事后算键与下次查询的"改写前"键对不上,缓存就永远 miss。
    const needKeys = need.map((opt) => this.conIdKey(opt));
    try {
      await session.qualifyContracts(need, BrokerRouter.QUALIFY_TIMEOUT_MS);
    } catch (exc) {
      if (isTimeout(exc)) throw new BrokerError(this.stalledMessage());
      throw exc;
    }
    for (const [i, opt] of need.entries()) {
      if (!opt.conId) {
        throw new BrokerError(
          `IBKR 无法确认该合约(${describeContract(opt)}),` +
          "可能是代码拼错、到期日或行权价不存在。已拦截。",
        );
      }
      this.conIdCache.set(needKeys[i]!, opt.conId);
    }
  }

  /** 合约确认必须有硬超时:TWS 上游断开时 socket 还活着,请求会永远等不到回应。 */
  async qualifyOrRaise(session: IbSession, contract: IbContract): Promise<void> {
    const key = this.conIdKey(contract);
    const hit = this.conIdCache.get(key);
    if (hit) {
      contract.conId = hit;
      return;
    }
    try {
      await session.qualifyContracts([contract], BrokerRouter.QUALIFY_TIMEOUT_MS);
    } catch (exc) {
      if (isTimeout(exc)) throw new BrokerError(this.stalledMessage());
      throw exc;
    }
    if (!contract.conId) {
      throw new BrokerError(
        `IBKR 无法确认该合约(${describeContract(contract)}),` +
        "可能是代码拼错、到期日或行权价不存在。已拦截。",
      );
    }
    this.conIdCache.set(key, contract.conId);
  }

  private stalledMessage(): string {
    if (!this.upstreamOkFlag) {
      return (
        "TWS 与 IBKR 服务器的连接已中断(错误 1100)。本机到 TWS 的连接还在," +
        "所以请求发得出去、但永远等不到回应。等 TWS 自己重连(它会一直重试)," +
        "或检查网络后在「TWS 连接」面板重连引擎。"
      );
    }
    return (
      `TWS 在 ${Math.round(BrokerRouter.QUALIFY_TIMEOUT_MS / 1000)} 秒内没有响应合约确认请求。` +
      "常见原因:TWS 正弹着确认框等你点、或它与 IBKR 的连接刚断开。处理完再试。"
    );
  }

  // ---- 行情 -----------------------------------------------------------
  /** 组合各腿的盘口(AUTO_MID 定价用)。纸面账户退延迟盘口;实盘绝不用延迟定价。
   *
   * 三件事必须一起做(与 Python 版 leg_quotes 同步):
   * 1. 各腿一起订阅、一起轮询——串行等就是腿数 × 上限;
   * 2. 用完立刻 cancelTicker——不撤的订阅占着行情线路配额(约 100 条),漏光后 TWS 对新
   *    请求回 101,所有腿永远 NaN(2026-09-04 纸面账户实测);
   * 3. 接住取盘口期间的行情类错误码,缺盘口时把原因翻译给用户。 */
  async legQuotes(contract: ContractSpec, account: AccountConfig): Promise<LegQuote[]> {
    const session = await this.forAccount(account);
    const legs = contract.legs ?? [];
    if (!legs.length) return [];
    const delayedOk = account.is_paper;
    const opts = legs.map((leg) =>
      optionContract(
        contract.symbol, leg.lastTradeDateOrContractMonth, leg.strike, leg.right,
        contract.exchange, contract.currency, leg.multiplier, leg.tradingClass ?? "",
      ),
    );
    const mdErrors: Array<[number, string]> = [];
    const onError = (_reqId: number, code: number, message: string): void => {
      if (MD_ERROR_CODES.has(Number(code))) mdErrors.push([Number(code), String(message ?? "")]);
    };
    session.onError?.(onError);
    let subscribed = 0;
    let quotes: LegQuote[] = [];
    try {
      if (delayedOk) session.reqMarketDataType(3);
      await this.qualifyAllOrRaise(session, opts);
      const handles = opts.map((opt) => {
        const h = session.subscribeTicker(opt);
        subscribed += 1;
        return h;
      });
      // 轮询而不是固定等待:固定 sleep 会抢跑拿到 NaN,被守卫误判成"盘口不可用"。
      let waited = 0;
      const ready = (): boolean =>
        handles.every((h) => {
          const t = h.read();
          return finiteQuote(t.bid) > 0 && finiteQuote(t.ask) > 0;
        });
      // 某条腿的订阅被拒(实盘会话同时在线时 10197 时不时来一下),当场重订那一条,
      // 而不是干等到超时报「盘口不可用」(2026-09-10 夜盘真机:开蝶就这么被拒过一次)
      const resubscribed = opts.map(() => false);
      while (waited < BrokerRouter.QUOTE_WAIT_MS) {
        await session.settle(250);
        waited += 250;
        if (ready()) break;
        handles.forEach((h, i) => {
          if (!resubscribed[i] && h.read().error) {
            resubscribed[i] = true;
            try {
              session.cancelTicker(opts[i]!);
            } catch {
              /* 撤不掉也要重订 */
            }
            handles[i] = session.subscribeTicker(opts[i]!);
          }
        });
      }
      quotes = legs.map((leg, i) => {
        const t = handles[i]!.read();
        return { action: leg.action, ratio: leg.ratio, bid: finiteQuote(t.bid), ask: finiteQuote(t.ask) };
      });
      // 订阅被拒的腿:把 TWS 原文带出去。只报"盘口不可用"没法排查——是没权限、线路配额漏光(101)
      // 还是实盘会话占着行情(10197),处理办法完全不同
      const legErrors = handles
        .map((h, i) => (h.read().error ? `${legs[i]!.strike}${legs[i]!.right}: ${h.read().error}` : ""))
        .filter(Boolean);
      if (legErrors.length && quotes.some((q) => !(q.bid > 0 && q.ask > 0))) {
        throw new BrokerError(`取不到 ${contract.symbol} 组合盘口,TWS 拒了订阅:${legErrors.join(";")}`);
      }
    } finally {
      for (const opt of opts.slice(0, subscribed)) {
        try {
          session.cancelTicker(opt);   // 不撤会一直占着行情线路配额
        } catch {
          /* 撤订阅失败不该盖住真正的错误 */
        }
      }
      if (delayedOk) session.reqMarketDataType(1);
      session.offError?.(onError);
    }
    const missing = quotes.some((q) => !(q.bid > 0 && q.ask > 0));
    if (missing && mdErrors.length) throw new BrokerError(quoteErrorMessage(contract.symbol, mdErrors));
    return quotes;
  }

  /** IBKR 什么都能报(订阅到位的话),恒回 null。 */
  quoteCapability(_symbol: string): string | null {
    return null;
  }

  /** 最近一次 indexPrice 是怎么得来的:官方指数,还是期货推算。界面要把来源说出来——
   * 夜盘显示一个 7653 却不说是推算的,和显示一个一动不动的 7636 一样会误导人。 */
  private readonly spotInfos = new Map<string, Record<string, unknown>>();
  /** 基差:每个已收盘的常规时段算一次(键 = 期货月份|时段日期)。 */
  private readonly basisCache = new Map<string, Record<string, unknown>>();
  /** 期货常驻流。和指数流分开管:CME 行情首笔 tick 要三四秒(2026-09-10 真机实测),
   * 等不到就撤、下次重订,会永远卡在"刚订上还没来"。所以订上就不撤,下一次调用直接读;
   * 连续 30 秒一个价都没有才当它死了,撤掉重订。 */
  private readonly futStreams = new Map<string, { handle: TickerHandle; target: IbContract; since: number; lastOk: number }>();
  /** 推算失败的退避:盯盘一秒一轮,每轮都重新取 K 线会把交易道卡死。 */
  private readonly futuresBackoff = new Map<string, number>();
  /** 期货这一路最近一次失败的 TWS 原文(10197、101……)。只说"没报价"没法排查。 */
  private lastFuturesError = "";

  spotInfo(symbol: string): Record<string, unknown> | null {
    return this.spotInfos.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * 基差落盘:一个夜盘只需要算一次,重启不该再去取历史 K 线。
   *
   * 历史数据恰恰是最先被挡的那一样:同一 IBKR 用户名在别处登录时,TWS 对历史请求直接回
   * "Trading TWS session is connected from a different IP address",实时行情反而时有时无
   * (2026-09-10 真机)。基差在内存里的话,每次重启都得重取,那一刻被挡住就只能退回昨收。
   * 文件放在数据库旁边,只存最近几条;读写失败都不影响取价,顶多退回重取。
   */
  private basisFile(): string {
    return path.join(path.dirname(this.settings.db_path), "index_basis.json");
  }

  private loadBasis(key: string): Record<string, unknown> | null {
    const hit = this.basisCache.get(key);
    if (hit) return hit;
    try {
      const all = JSON.parse(fs.readFileSync(this.basisFile(), "utf-8")) as Record<string, Record<string, unknown>>;
      const row = all[key];
      if (row && Number.isFinite(Number(row["basis"]))) {
        this.basisCache.set(key, row);
        return row;
      }
    } catch {
      /* 没有文件或坏文件:当作没算过 */
    }
    return null;
  }

  private saveBasis(key: string, row: Record<string, unknown>): void {
    this.basisCache.set(key, row);
    try {
      let all: Record<string, Record<string, unknown>> = {};
      try {
        all = JSON.parse(fs.readFileSync(this.basisFile(), "utf-8"));
      } catch {
        all = {};
      }
      all[key] = row;
      const keep = Object.keys(all).sort().slice(-20); // 只留最近 20 条
      const trimmed = Object.fromEntries(keep.map((k) => [k, all[k]]));
      fs.mkdirSync(path.dirname(this.basisFile()), { recursive: true });
      fs.writeFileSync(this.basisFile(), JSON.stringify(trimmed, null, 1), "utf-8");
    } catch {
      /* 写不下去不影响这一次取价 */
    }
  }

  private async quoteSession(): Promise<IbSession | null> {
    const dflt = this.settings.defaultAccount();
    if (dflt !== null) {
      try {
        return await this.forAccount(dflt);
      } catch (exc) {
        if (!(exc instanceof BrokerError)) throw exc;
      }
    }
    return this.sessions()[0] ?? null;
  }

  /**
   * 指数(或股票)现价。
   *
   * **指数只在常规时段计算。** 夜盘里 SPX 报的是昨收、一动不动,SPXW 期权却照常在跳——
   * 拿昨收去反解波动率、推断蝶的看涨看跌、挑期权链的行权价,全都是错的(2026-09-10 美东
   * 02:10 实测:指数 7636.36 不动,ESU6 推出来的真实现价是 7653.45,差 17 点,足够把
   * 「中心 7650 高于现价 → 看涨蝶」翻成看跌蝶)。所以配了期货代理的指数,常规时段之外改用
   * 「期货现价 − 基差」,见 futuresSpot();推不出来才退回官方指数,并在 spotInfo 里标明是旧价。
   */
  async indexPrice(symbol: string): Promise<number | null> {
    const cfg = this.settings.indexConfig(symbol);
    const session = await this.quoteSession();
    if (session === null) return null;
    const key = symbol.toUpperCase();

    if (cfg && cfg.futures) {
      const now = nowEt();
      if (this.settings.marketStatus(now) !== "盘中") {
        let why = "期货还没报价";
        const futErr = (): string => (this.lastFuturesError ? `期货还没报价:${this.lastFuturesError}` : "期货还没报价");
        if ((this.futuresBackoff.get(key) ?? 0) <= Date.now()) {
          try {
            const derived = await this.futuresSpot(session, cfg, now);
            if (derived !== null) {
              this.spotInfos.set(key, derived);
              return derived["price"] as number;
            }
            why = futErr();
          } catch (exc) {
            if (!(exc instanceof BrokerError)) throw exc;
            why = exc.message;
            this.futuresBackoff.set(key, Date.now() + 60_000); // 取不到基差:一分钟后再试
          }
        } else {
          why = "上一次推算失败,稍后重试";
        }
        // 推不出来:照旧取官方指数,但要让界面知道这是一个不会动的旧价
        const stale = await this.officialPrice(session, symbol, cfg);
        this.spotInfos.set(key, {
          price: stale, source: "index_stale",
          note: `${key} 指数只在常规时段计算,这是上一个收盘价,不是现价(期货推算没成功:${why})`,
        });
        return stale;
      }
    }
    const price = await this.officialPrice(session, symbol, cfg);
    this.spotInfos.set(key, { price, source: "index", note: "" });
    return price;
  }

  private async officialPrice(
    session: IbSession, symbol: string, cfg: IndexConfig | null,
  ): Promise<number | null> {
    const target = cfg ? indexContract(symbol, cfg.exchange) : stockContract(symbol);
    try {
      await this.qualifyOrRaise(session, target);
    } catch (exc) {
      if (exc instanceof BrokerError) return null;
      throw exc;
    }
    return this.streamPrice(session, `idx:${symbol}`, target);
  }

  /**
   * 常驻订阅取一个价:第一次要等首笔 tick,之后每次调用都是读缓存(百毫秒内)。
   * 快照是"输入到下单"链路的第一段,盯盘又是一秒一轮,不能每次都重新订阅再干等一秒。
   */
  private async streamPrice(session: IbSession, streamKey: string, target: IbContract): Promise<number | null> {
    const existing = this.streams.get(streamKey);
    if (existing) {
      const cached = await pollTicker(session, existing, 250);
      if (cached !== null) return cached;
      // 常驻流断了数据:丢掉重订(下面的冷启动路径)
      this.streams.delete(streamKey);
    }
    const handle = session.subscribeTicker(target);
    let price = await pollTicker(session, handle, 1200);
    if (price !== null) {
      this.streams.set(streamKey, handle);
      return price;
    }
    // 没有实时订阅时退到延迟行情。只给方向复核的快照用。
    // 只撤自己订的那条(不带 generic ticks):不传第二个参数是"撤掉这个合约的所有变体",
    // 会把异动监控那条 #165,104,595 的量能流一起撤掉——句柄还在、读到的却是最后一帧,
    // 而且不报错,volumeQuotes 不会重订,那只股的量价就此冻住(2026-09-12 审出)。
    session.cancelTicker(target, "");
    try {
      session.reqMarketDataType(3);
      const delayed = session.subscribeTicker(target);
      price = await pollTicker(session, delayed, 2000);
      if (price !== null) this.streams.set(streamKey, delayed);
    } finally {
      session.reqMarketDataType(1);
    }
    return price;
  }

  /** 期货现价:见 futStreams。按 reqMarketDataType(3) 订——有实时权限就是实时,
   * 没有才给延迟;实时类型下没权限的账户什么都拿不到。 */
  private async futuresPrice(session: IbSession, key: string, fut: IbContract): Promise<number | null> {
    let stream = this.futStreams.get(key);
    let price: number | null = null;
    // 实盘 TWS 同时登录时,IBKR 在两个会话之间仲裁行情,纸面会话的订阅时不时吃一个 10197
    // (2026-09-10 真机:同样的写法,有的进程第一下就到价,有的前两次都被拒)。被拒的流不会
    // 自己活过来,所以同一次调用里当场重订,最多三次;只是没来 tick 就不重订,免得狂刷请求。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (stream !== undefined && stream.handle.read().error) {
        try {
          session.cancelTicker(stream.target);
        } catch {
          /* 撤不掉也要重订 */
        }
        this.futStreams.delete(key);
        stream = undefined;
      }
      if (stream === undefined) {
        // 类型 3 保持到首笔报价到手再切回去:连接刚建好时请求实际发出去会晚一拍
        try {
          session.reqMarketDataType(3);
          stream = { handle: session.subscribeTicker(fut), target: fut, since: Date.now(), lastOk: 0 };
          this.futStreams.set(key, stream);
          price = await pollTicker(session, stream.handle, 1500);
        } finally {
          session.reqMarketDataType(1);
        }
      } else {
        price = await pollTicker(session, stream.handle, 250);
      }
      if (price !== null || !stream.handle.read().error) break;
    }
    if (price !== null) {
      stream!.lastOk = Date.now();
      this.lastFuturesError = "";
      return price;
    }
    if (stream === undefined) return null;
    this.lastFuturesError = stream.handle.read().error || "订上了但一直没有 tick";
    if (Date.now() - Math.max(stream.since, stream.lastOk) > 30_000) {
      // 半分钟一个价都没有:当它死了,下一次重订
      try {
        session.cancelTicker(stream.target);
      } catch {
        /* 撤不掉也要丢掉缓存 */
      }
      this.futStreams.delete(key);
    }
    return null;
  }

  /**
   * 夜盘的指数现价 = 期货现价 − 基差。
   *
   * 期货取**到期日严格晚于今天的最近季月**(frontQuarterly):基差按月份算,离到期越近越小越稳
   * (ESU6 离到期 8 天时基差 7 点,ESZ6 是 73 点)。基差用上一个常规时段**最后同一分钟**的两根
   * K 线相减(contemporaneousBasis),而不是两个收盘价相减:ES 的收盘在 17:00,比指数晚一小时,
   * 那一小时的行情会被当成基差(实测差 1.7 点)。基差一个时段只算一次,缓存到下一个收盘。
   */
  private async futuresSpot(
    session: IbSession, cfg: IndexConfig, now: EtNow,
  ): Promise<Record<string, unknown> | null> {
    const month = frontQuarterly(now.date);
    const fut: IbContract = {
      secType: "FUT", symbol: cfg.futures, exchange: cfg.futures_exchange || "CME",
      currency: "USD", lastTradeDateOrContractMonth: month, conId: 0,
    };
    await this.qualifyOrRaise(session, fut);

    const [sessionDate, closeMin] = lastRthSession(now, this.settings);
    const cacheKey = `${cfg.futures}${month}|${sessionDate}`;
    let basis = this.loadBasis(cacheKey);
    if (basis === null) {
      const endEpoch = wallToEpoch({
        year: Number(sessionDate.slice(0, 4)), month: Number(sessionDate.slice(5, 7)),
        day: Number(sessionDate.slice(8, 10)), hour: Math.floor(closeMin / 60),
        minute: (closeMin % 60) + 5, second: 0,
      }, ET);
      const endUtc = new Date(endEpoch).toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-");
      const opts = { endDateTime: endUtc, durationStr: "1800 S", barSizeSetting: "1 min", whatToShow: "TRADES" };
      const idx = indexContract(cfg.symbol, cfg.exchange);
      await this.qualifyOrRaise(session, idx);
      let idxBars: RawBar[];
      let futBars: RawBar[];
      try {
        idxBars = await session.historicalData(idx, { ...opts, useRTH: true });
        futBars = await session.historicalData(fut, { ...opts, useRTH: false });
      } catch (exc) {
        throw new BrokerError(`取 ${cfg.symbol} / ${cfg.futures} 收盘分钟线失败:${(exc as Error).message}`);
      }
      const matched = contemporaneousBasis(
        idxBars.map((b) => ({ time: barTimestamp(b.date), close: Number(b.close) })),
        futBars.map((b) => ({ time: barTimestamp(b.date), close: Number(b.close) })),
      );
      if (matched === null) {
        throw new BrokerError(`${sessionDate} 收盘前找不到 ${cfg.symbol} 与 ${cfg.futures} 同一分钟的 K 线,算不出基差`);
      }
      basis = { ...matched, session: sessionDate };
      this.saveBasis(cacheKey, basis);
    }

    const futPrice = await this.futuresPrice(session, `${cfg.futures}${month}`, fut);
    if (futPrice === null) return null;
    const b = Number(basis["basis"]);
    const price = pyRound(futPrice - b, 2);
    const label = `${cfg.futures} ${month}`;
    return {
      price, source: "futures", futures: label, futures_price: futPrice, basis: b,
      basis_time: basis["time"],
      note: `${cfg.symbol} 夜盘不计算,按 ${label} ${pyRound(futPrice, 2)} − 基差 ${pyRound(b, 2)} 推算` +
        `(基差取 ${String(basis["time"])} 同一分钟)`,
    };
  }

  /** 批量拉股票/ETF 报价;绝不用于订单定价。 */
  async stockQuotes(symbols: string[]): Promise<Record<string, StockQuote>> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) return {};
    const out: Record<string, StockQuote> = {};
    try {
      session.reqMarketDataType(3);
      const tickers = new Map<string, [IbContract, TickerHandle]>();
      for (const symbol of symbols) {
        const target = stockContract(symbol);
        try {
          await this.qualifyOrRaise(session, target);
        } catch (exc) {
          if (exc instanceof BrokerError) {
            out[symbol] = { last: null, close: null, change_pct: null };
            continue;
          }
          throw exc;
        }
        tickers.set(symbol, [target, session.subscribeTicker(target)]);
      }
      await session.settle(2500);
      for (const [symbol, [, handle]] of tickers) {
        const t = handle.read();
        const last = cleanPrice(t.last) ?? cleanPrice(t.marketPrice);
        const close = cleanPrice(t.close);
        let change: number | null = null;
        if (last !== null && close) change = pyRound(((last - close) / close) * 100.0, 2);
        out[symbol] = { last, close, change_pct: change };
      }
    } finally {
      session.reqMarketDataType(1);
    }
    return out;
  }

  /** 日线历史(回测用)。ADJUSTED_LAST 前复权;指数用 TRADES。 */
  async historicalBars(symbol: string, start: string, end: string): Promise<Array<Record<string, any>>> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) {
      throw new BrokerError("引擎未连接 TWS,无法获取历史数据。请先在「TWS 连接」面板连接引擎。");
    }
    const cfg = this.settings.indexConfig(symbol);
    const target = cfg ? indexContract(symbol, cfg.exchange) : stockContract(symbol);
    await this.qualifyOrRaise(session, target);

    // IBKR 不接受 ADJUSTED_LAST 配非空 endDateTime(错误 321 "End date not supported with
    // adjusted last"),所以结束日在过去时不能靠 endDateTime 截断,只能一路拉到今天再本地切片。
    // 换成 TRADES 倒是能带 endDateTime,但那是不复权价:区间里只要有一次拆股,回测就会
    // 看到一根凭空的跳空。宁可多取几根也不能让价格失真。
    // 今天用美东日期——引擎其它地方(rpc.dailyHistory 的 end)都是美东口径,这里若用 UTC,
    // 美东 20:00 之后两者差一天,"拉到今天" 会被误判成 "结束日在过去"。
    const todayIso = nowEt().date;
    const fetchEnd = end >= todayIso ? end : todayIso;
    const startOrd = Date.parse(start + "T00:00:00Z");
    const days = Math.round((Date.parse(fetchEnd + "T00:00:00Z") - startOrd) / 86_400_000);
    const duration = days <= 360 ? `${days + 5} D` : `${Math.trunc(days / 365) + 1} Y`;

    let raw: RawBar[];
    try {
      raw = await session.historicalData(target, {
        endDateTime: "",
        durationStr: duration,
        barSizeSetting: "1 day",
        whatToShow: cfg ? "TRADES" : "ADJUSTED_LAST",
        useRTH: true,
      });
    } catch (exc) {
      throw new BrokerError(`获取 ${symbol} 历史数据失败:${(exc as Error).message}`);
    }
    const bars: Array<Record<string, any>> = [];
    for (const bar of raw ?? []) {
      const day = barTimestamp(bar.date).slice(0, 10);
      if (start <= day && day <= end) {
        bars.push({ date: day, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      }
    }
    if (!bars.length) {
      throw new BrokerError(
        `${symbol} 在 ${start} ~ ${end} 内没有历史数据(标的代码是否正确?区间是否全是休市日?)`,
      );
    }
    return bars;
  }

  /** 常驻流式报价:第一次调用建订阅,之后每次只读当前值(顶栏宏观带用)。 */
  async streamQuotes(symbols: string[]): Promise<Record<string, Record<string, any>>> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) return {};

    let fresh = false;
    for (const symbol of symbols) {
      if (this.streams.has(symbol)) continue;
      const target = streamContract(symbol);
      try {
        await this.qualifyOrRaise(session, target);
      } catch (exc) {
        if (exc instanceof BrokerError) {
          this.streams.set(symbol, null); // 记下来,不用每次都重试 qualify
          continue;
        }
        throw exc;
      }
      this.streams.set(symbol, session.subscribeTicker(target));
      fresh = true;
    }
    await session.settle(fresh ? 1500 : 150);

    const out: Record<string, Record<string, any>> = {};
    for (const symbol of symbols) {
      const handle = this.streams.get(symbol);
      if (!handle) continue;
      const t = handle.read();
      const last = cleanPrice(t.last) ?? cleanPrice(t.marketPrice);
      const close = cleanPrice(t.close);
      const change = last && close ? pyRound(((last - close) / close) * 100.0, 2) : null;
      if (last === null) continue; // 没订阅/没数据 → 交给公开源兜底
      out[symbol] = { last, close, change_pct: change };
    }
    return out;
  }

  // ---- 异动监控的常驻量能流 -------------------------------------------------
  /** 异动监控订的 generic ticks:165 = 90 日均量(tick 21)、104 = 30 日历史波动率(tick 23)、
   * 595 = 近 3 / 5 / 10 分钟量(tick 63/64/65)。2026-09-11 盘中真机:24 只股全部拿到。 */
  static readonly VOLUME_TICKS = "165,104,595";
  /** 被拒的流(10197 / 354……)或合约确认超时之后,多久再试一次:监控 5 秒一轮,不能每轮都去撞同一个拒绝。 */
  static readonly VOLUME_RETRY_MS = 60_000;
  /** 富途的 router 置 false(它的桥还没真机核对过)。 */
  readonly SUPPORTS_VOLUME_QUOTES = true;
  /** 标的 → 常驻流;qualify 认不出的记 null,不再反复重试。记下订它的会话:撤要撤在同一个会话上,
   * 会话换了(断线重连)旧句柄就是死的。 */
  private readonly volumeStreams = new Map<string, { target: IbContract; handle: TickerHandle; session: IbSession } | null>();
  /** 标的 → [下次重试时刻, 上次失败原因] */
  private readonly volumeRetry = new Map<string, [number, string]>();

  /**
   * 异动监控的行情:当日量 / 90 日均量 / 30 日历史波动率 / 近几分钟量,全部取自**同一条**常驻流。
   * 第一次调用建订阅,之后每次只读当前值。
   *
   * 当日量只能和同一条流里的均量比:历史 TRADES K 线滤掉了部分成交类型,同一时刻比流里少
   * 20%~36%(2026-09-11 真机)。**只用于研究与提醒,绝不用于订单定价。**
   */
  async volumeQuotes(symbols: string[]): Promise<Record<string, VolumeSnapshot & { error?: string }>> {
    const session = this.sessions()[0] ?? null;
    if (session === null) return {};
    const now = Date.now();
    let fresh = false;
    let stalled = false;
    for (const symbol of symbols) {
      const existing = this.volumeStreams.get(symbol);
      if (existing === null) continue;
      if (existing !== undefined) {
        const error = existing.handle.read().error;
        const stale = existing.session !== session || !existing.session.isConnected();
        if (!error && !stale) continue;
        // 被拒的流不会自己活过来,会话换了的句柄也不会再更新:摘掉重订(被拒的按退避来)
        try {
          existing.session.cancelTicker(existing.target, BrokerRouter.VOLUME_TICKS);
        } catch {
          /* 撤不掉也要重订 */
        }
        this.volumeStreams.delete(symbol);
        if (error) {
          this.volumeRetry.set(symbol, [now + BrokerRouter.VOLUME_RETRY_MS, error]);
          continue;
        }
      }
      const retry = this.volumeRetry.get(symbol);
      if (retry !== undefined && now < retry[0]) continue;
      if (stalled) continue; // 这一轮 TWS 已经不回合约确认了,别的也不用排队干等
      const target = stockContract(symbol);
      try {
        await this.qualifyOrRaise(session, target);
      } catch (exc) {
        if (!(exc instanceof BrokerError)) throw exc;
        if (exc.message === this.stalledMessage()) {
          // 超时 ≠ 认不出:TWS 卡住时记成"未知标的"就再也不会重试了
          stalled = true;
          this.volumeRetry.set(symbol, [now + BrokerRouter.VOLUME_RETRY_MS, "TWS 没有响应合约确认,稍后重试"]);
        } else {
          this.volumeStreams.set(symbol, null);
        }
        continue;
      }
      this.volumeStreams.set(symbol, {
        target, handle: session.subscribeTicker(target, BrokerRouter.VOLUME_TICKS), session,
      });
      this.volumeRetry.delete(symbol);
      fresh = true;
    }
    await session.settle(fresh ? 1500 : 100);

    const out: Record<string, VolumeSnapshot & { error?: string }> = {};
    for (const symbol of symbols) {
      const entry = this.volumeStreams.get(symbol);
      if (entry === null) {
        out[symbol] = { ...emptyVolumeSnapshot(), error: "未知标的" };
        continue;
      }
      if (entry === undefined) {
        const retry = this.volumeRetry.get(symbol);
        if (retry !== undefined) out[symbol] = { ...emptyVolumeSnapshot(), error: retry[1] };
        continue;
      }
      const t = entry.handle.read();
      const snap: VolumeSnapshot & { error?: string } = {
        last: cleanPrice(t.last) ?? cleanPrice(t.marketPrice),
        close: cleanPrice(t.close),
        open: cleanPrice(t.open),
        high: cleanPrice(t.high),
        low: cleanPrice(t.low),
        // 量和价一样:非有限 / 非正一律 null(开盘前的 0 量不是"零成交",是还没有数)
        volume: cleanPrice(t.volume),
        avg_volume: cleanPrice(t.avgVolume),
        hist_vol: cleanPrice(t.histVol),
        vol_3m: cleanPrice(t.vol3m),
        vol_5m: cleanPrice(t.vol5m),
        vol_10m: cleanPrice(t.vol10m),
        delayed: Boolean(t.delayed),
        last_trade_at: cleanPrice(t.lastTradeAt),
      };
      if (t.error) snap.error = String(t.error);
      out[symbol] = snap;
    }
    return out;
  }

  /** 撤掉不在 keep 里的量能流,返回撤了几条。移出追踪 / 停用的股不能一直占着行情线路(约 100 条上限)。 */
  releaseVolumeStreams(keep: string[]): number {
    const keepSet = new Set(keep);
    let released = 0;
    for (const [symbol, entry] of [...this.volumeStreams.entries()]) {
      if (keepSet.has(symbol)) continue;
      this.volumeStreams.delete(symbol);
      if (entry === null) continue;
      try {
        entry.session.cancelTicker(entry.target, BrokerRouter.VOLUME_TICKS);
      } catch {
        /* 撤不掉也不该拦住别的 */
      }
      released += 1;
    }
    for (const symbol of [...this.volumeRetry.keys()]) {
      if (!keepSet.has(symbol)) this.volumeRetry.delete(symbol);
    }
    return released;
  }

  /** 按周期拉 K 线(PA 分析用;给了 endDay = 取到那个美东日收盘为止)。历史数据同样要行情权限;先切延迟再切回实时。 */
  async intradayBars(symbol: string, timeframe: string, rth = false, endDay?: string): Promise<Array<Record<string, any>>> {
    const spec = TIMEFRAMES[timeframe];
    if (spec === undefined) {
      throw new BrokerError(`未知 K 线周期:${timeframe}(可选:${Object.keys(TIMEFRAMES).join("、")})`);
    }
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) {
      throw new BrokerError("引擎未连接 TWS,无法获取 K 线。请先在「TWS 连接」面板连接引擎。");
    }
    const cfg = this.settings.indexConfig(symbol);
    const target = cfg ? indexContract(symbol, cfg.exchange) : stockContract(symbol);
    await this.qualifyOrRaise(session, target);

    const daily = spec["bar_size"] === "1 day";
    const show = daily && cfg === null ? "ADJUSTED_LAST" : "TRADES";
    const pull = (duration: string): Promise<RawBar[]> =>
      session.historicalData(target, {
        endDateTime: endDay ? ibEndUtc(endDay) : "",
        durationStr: duration,
        barSizeSetting: spec["bar_size"] as string,
        whatToShow: show,
        useRTH: rth,
      });

    let raw: RawBar[];
    try {
      session.reqMarketDataType(3); // 没订阅退延迟;有订阅仍是实时
      raw = await pull(spec["duration"] as string);
      // IBKR 的 durationStr 数的是交易日,全时段口径下刚翻篇时第一档只有十几根
      if ((raw ?? []).length < MIN_BARS && spec["fallback"]) {
        raw = (await pull(spec["fallback"] as string)) ?? raw;
      }
    } catch (exc) {
      throw new BrokerError(barsError(symbol, spec["label"] as string, exc as Error));
    } finally {
      session.reqMarketDataType(1);
    }

    const bars: Array<Record<string, any>> = [];
    for (const bar of raw ?? []) {
      bars.push({
        time: barTimestamp(bar.date),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        // 指数没有成交量,IBKR 回 -1;归零免得被当成"缩量"读
        volume: Math.max(Number(bar.volume ?? 0) || 0, 0.0),
      });
    }
    if (!bars.length) {
      throw new BrokerError(
        `${symbol} 没有返回 ${spec["label"]} K 线(标的代码是否正确?是否刚好整段休市?)`,
      );
    }
    return bars;
  }

  // ---- 期权链(只读,不进下单链路)---------------------------------------
  static readonly CHAIN_MAX_WIDTH = 15;
  static readonly CHAIN_WAIT_MS = 4000;

  async optionExpiries(symbol: string): Promise<Record<string, any>> {
    const session = this.marketSession();
    const cfg = this.settings.indexConfig(symbol);
    const under = cfg ? indexContract(symbol, cfg.exchange) : stockContract(symbol);
    await this.qualifyOrRaise(session, under);

    let params: OptChainParam[];
    try {
      params = await session.secDefOptParams(under.symbol, cfg ? "IND" : "STK", under.conId!);
    } catch (exc) {
      throw new BrokerError(
        `获取 ${symbol} 的期权链定义失败:${String((exc as Error).message).slice(0, 200)}`,
      );
    }
    if (!params?.length) throw new BrokerError(`${symbol} 没有可用的期权链(标的是否有期权?)`);

    // SPX 的日到期是 SPXW、月到期是 SPX,挑错了拿到的是另一条链
    const wanted = cfg ? new Set([cfg.daily_trading_class, cfg.monthly_trading_class]) : new Set<string>();
    let chosen = params.filter((p) => wanted.has(p.tradingClass));
    if (!chosen.length) chosen = [...params];
    const expiries = [...new Set(chosen.flatMap((p) => p.expirations ?? []))].sort();
    const strikes = [...new Set(chosen.flatMap((p) => (p.strikes ?? []).map(Number)))].sort((a, b) => a - b);
    // 同一个标的会返回多条链,合并成一份会丢掉 "哪个到期日属于哪条链" 这个关键信息:
    // AAPL 的调整期权类 '2AAPL' 只有一个到期日,SPX 的月度类 'SPX' 又只记第三个周五的前一天。
    // 按交易类分开留一份,让 optionChain 能按到期日挑对链(见 pickTradingClass)。
    const byClass: Record<string, { expiries: string[]; strikes: number[] }> = {};
    for (const p of chosen) {
      const tc = p.tradingClass ?? "";
      const slot = (byClass[tc] ??= { expiries: [], strikes: [] });
      slot.expiries.push(...(p.expirations ?? []));
      slot.strikes.push(...(p.strikes ?? []).map(Number));
    }
    for (const slot of Object.values(byClass)) {
      slot.expiries = [...new Set(slot.expiries)].sort();
      slot.strikes = [...new Set(slot.strikes)].sort((a, b) => a - b);
    }
    return {
      symbol,
      expiries,
      strikes,
      by_class: byClass,
      trading_classes: [...new Set(chosen.map((p) => p.tradingClass ?? ""))].sort(),
      exchange: chosen.length ? chosen[0]!.exchange : cfg ? cfg.exchange : "SMART",
    };
  }

  async optionChain(symbol: string, expiry: string | null = null, width = 10): Promise<Record<string, any>> {
    width = Math.max(3, Math.min(Math.trunc(width), BrokerRouter.CHAIN_MAX_WIDTH));
    const meta = await this.optionExpiries(symbol);
    if (!meta["expiries"].length) throw new BrokerError(`${symbol} 没有可用的到期日`);
    const targetExpiry = expiry ?? meta["expiries"][0];
    if (!meta["expiries"].includes(targetExpiry)) {
      throw new BrokerError(
        `${symbol} 没有 ${targetExpiry} 这个到期日。最近的几个:` +
        meta["expiries"].slice(0, 5).join("、"),
      );
    }
    const spot = await this.indexPrice(symbol);
    if (!spot) throw new BrokerError(`拿不到 ${symbol} 的现价,无法判断该取哪些行权价。`);

    const cfg = this.settings.indexConfig(symbol);
    const tradingClass = pickTradingClass(symbol, cfg, meta["by_class"] ?? {}, targetExpiry);
    // 行权价也按挑中的那条链取:两条链的网格粒度不同(SPXW 比 SPX 密),
    // 用并集选出来的价位可能在这条链上根本不存在。
    const grid: number[] =
      (meta["by_class"]?.[tradingClass]?.strikes as number[] | undefined) ?? meta["strikes"];
    if (!grid.length) throw new BrokerError(`${symbol} 的行权价网格为空`);
    let nearest = 0;
    for (let i = 1; i < grid.length; i++) {
      if (Math.abs(grid[i]! - spot) < Math.abs(grid[nearest]! - spot)) nearest = i;
    }
    const band = grid.slice(Math.max(0, nearest - width), nearest + width + 1);

    const session = this.marketSession();
    const exchange = cfg ? cfg.exchange : "SMART";

    const contracts: IbContract[] = [];
    for (const strike of band) {
      for (const right of ["C", "P"]) {
        contracts.push(
          optionContract(symbol, targetExpiry, strike, right, exchange, "USD", "100", tradingClass),
        );
      }
    }

    const rows: Array<Record<string, any>> = [];
    const tickers: Array<[IbContract, TickerHandle]> = [];
    try {
      session.reqMarketDataType(3);
      // 批量 qualify:逐个发会把超时预算乘以合约数
      try {
        await session.qualifyContracts(contracts, BrokerRouter.QUALIFY_TIMEOUT_MS * 2);
      } catch {
        throw new BrokerError(this.stalledMessage());
      }
      const live = contracts.filter((c) => c.conId);
      if (!live.length) {
        throw new BrokerError(
          `${symbol} ${targetExpiry} 这条链一个合约都确认不了(到期日或行权价可能不存在)`,
        );
      }
      // 100=成交量 101=持仓量 106=隐含波动率(带模型 greeks)
      for (const c of live) tickers.push([c, session.subscribeTicker(c, "100,101,106")]);
      await session.settle(BrokerRouter.CHAIN_WAIT_MS);
      for (const [contract, handle] of tickers) {
        const t = handle.read();
        const greeks = t.modelGreeks ?? null;
        const oi = contract.right === "C" ? t.callOpenInterest : t.putOpenInterest;
        const vol = contract.right === "C" ? t.callVolume : t.putVolume;
        rows.push({
          strike: Number(contract.strike),
          right: contract.right,
          oi: cleanPrice(oi) ?? 0.0,
          volume: cleanPrice(vol) ?? 0.0,
          gamma: greeks ? cleanPrice(greeks.gamma) : null,
          iv: greeks ? cleanPrice(greeks.impliedVol) : null,
        });
      }
    } finally {
      session.reqMarketDataType(1);
      for (const [contract] of tickers) {
        try {
          // 只撤期权链自己这条带 greeks 的流:缓存键带上 generic ticks 之后,
          // 同一条腿的普通流(持仓盯盘、追踪用的)是另一条,撤错了盯盘就没价了
          session.cancelTicker(contract, "100,101,106"); // 不撤会一直占着行情线路配额
        } catch {
          /* ignore */
        }
      }
    }
    return {
      symbol,
      expiry: targetExpiry,
      spot,
      expiries: meta["expiries"].slice(0, 20),
      rows,
      multiplier: 100.0,
      strike_count: band.length,
    };
  }

  marketSession(): IbSession {
    const sessions = this.sessions();
    if (!sessions.length) {
      throw new BrokerError("引擎未连接 TWS。请先在「TWS 连接」面板连接引擎。");
    }
    return sessions[0]!;
  }

  /** 一档盘口 + Level 2 深度(若账户有订阅)。只读展示。 */
  async orderBook(symbol: string, rows = 10): Promise<BookSnapshot> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) {
      throw new BrokerError("引擎未连接 TWS,无法读取盘口。请先在「TWS 连接」面板连接引擎。");
    }
    if (this.settings.indexConfig(symbol)) {
      throw new BrokerError("指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。");
    }
    const target = stockContract(symbol);
    await this.qualifyOrRaise(session, target);

    // liquidity 在最后一行补上(它要算完深度才知道);中途这份就是"还没算流动性"的样子
    const out = { symbol, l1: {}, bids: [], asks: [], note: "" } as unknown as BookSnapshot;
    try {
      session.reqMarketDataType(3);
      const ticker = session.subscribeTicker(target);
      await session.settle(1500);
      const t = ticker.read();
      const bid = cleanPrice(t.bid);
      const ask = cleanPrice(t.ask);
      const l1: BookL1 = {
        bid,
        ask,
        bid_size: t.bidSize !== null && !Number.isNaN(t.bidSize) ? cleanPrice(t.bidSize) : null,
        ask_size: t.askSize !== null && !Number.isNaN(t.askSize) ? cleanPrice(t.askSize) : null,
        last: cleanPrice(t.last) ?? cleanPrice(t.close),
      };
      if (bid && ask && ask >= bid) {
        const mid = (bid + ask) / 2.0;
        l1["spread"] = pyRound(ask - bid, 4);
        l1["spread_bps"] = mid ? pyRound(((ask - bid) / mid) * 10_000, 1) : null;
      }
      out["l1"] = l1;
    } finally {
      session.reqMarketDataType(1);
      try {
        // 用完即撤,不撤会占行情线路配额。只撤自己订的那条(不带 generic ticks):不传会连同
        // 异动监控挂在同一只股上的量能流一起撤掉,那条流就再也不更新了
        session.cancelTicker(target, "");
      } catch {
        /* ignore */
      }
    }

    try {
      const depth = await session.mktDepth(target, rows, 2000);
      out["bids"] = depth.bids;
      out["asks"] = depth.asks;
      if (!out["bids"].length && !out["asks"].length) {
        out["note"] =
          "未收到深度数据:Level 2 行情需要单独订阅(如 NASDAQ TotalView)。上方为一档盘口。";
      }
    } catch (exc) {
      out["note"] = `深度不可用(Level 2 需订阅):${String((exc as Error).message).slice(0, 200)}`;
    }
    out["liquidity"] = bookLiquidity(out);
    return out;
  }

  // ---- 持仓 -----------------------------------------------------------
  /** 账户里现在拿着什么。优先 portfolio()(TWS 自己算的口径),退 positions()。 */
  /**
   * 一张组合(BAG)在某一天的分钟中间价——交易分析里的"蝶价走势"。
   * IBKR 对组合合约支持历史数据(MIDPOINT),已到期的腿要带 includeExpired 才能 qualify;
   * 拿的是 endDateTime 往前一整天(含前一晚的全球时段),调用方自己裁。
   */
  async comboBars(symbol: string, legs: Rec[], day: string, barSize = "1 min"): Promise<Rec[]> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) {
      throw new BrokerError("引擎未连接 TWS,无法获取蝶价分钟线。请先在「TWS 连接」面板连接引擎。");
    }
    const comboLegs: Array<{ conId: number; ratio: number; action: string; exchange: string }> = [];
    for (const leg of legs) {
      const opt: IbContract = {
        secType: "OPT", symbol, exchange: "SMART", currency: "USD",
        lastTradeDateOrContractMonth: String(leg["lastTradeDateOrContractMonth"] ?? ""),
        strike: Number(leg["strike"] ?? 0), right: String(leg["right"] ?? ""),
        tradingClass: String(leg["tradingClass"] ?? ""), multiplier: "100", conId: 0, includeExpired: true,
      };
      await this.qualifyOrRaise(session, opt);
      comboLegs.push({ conId: opt.conId ?? 0, ratio: Math.trunc(Number(leg["ratio"] ?? 1)) || 1,
        action: String(leg["action"] ?? "BUY"), exchange: "SMART" });
    }
    const bag: IbContract = { secType: "BAG", symbol, exchange: "SMART", currency: "USD", conId: 0, comboLegs };
    const endUtc = ibEndUtc(String(day));
    let raw: RawBar[];
    try {
      session.reqMarketDataType(3);
      raw = await session.historicalData(bag, {
        endDateTime: endUtc, durationStr: "1 D", barSizeSetting: barSize, whatToShow: "MIDPOINT", useRTH: false,
      });
    } catch (exc) {
      throw new BrokerError(`获取 ${symbol} 组合分钟线失败:${(exc as Error).message}`);
    } finally {
      session.reqMarketDataType(1);
    }
    return (raw ?? []).map((b) => ({
      time: barTimestamp(b.date), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    }));
  }

  /**
   * 本次 TWS 会话(当天)的逐笔成交,归一成本系统的形状,按时间升序。
   * IBKR 的 API 只回当天的;更早的靠 store.rememberFills 一天天累积。
   * 一张组合单会回 1 条 BAG 行 + 每条腿一行,同一订单共用 permId——合成蝴蝶在 ibtrades 里做。
   */
  async executions(): Promise<Array<Record<string, any>>> {
    const out = new Map<string, Record<string, any>>();
    for (const session of this.sessions()) {
      if (typeof session.executions !== "function") continue;
      let details: Array<{ contract: Record<string, any>; execution: Record<string, any> }>;
      try {
        details = await session.executions();
      } catch (exc) {
        throw new BrokerError(`读取成交明细失败:${(exc as Error).message}`);
      }
      for (const d of details ?? []) {
        const row = fillRow(d.contract ?? {}, d.execution ?? {});
        if (row !== null && !out.has(row["exec_id"])) out.set(row["exec_id"], row);
      }
    }
    return [...out.values()].sort((a, b) =>
      (a["time"] < b["time"] ? -1 : a["time"] > b["time"] ? 1 : 0) ||
      (a["exec_id"] < b["exec_id"] ? -1 : a["exec_id"] > b["exec_id"] ? 1 : 0));
  }

  /**
   * 这条持仓所在合约的真实交易时段 [tradingHours, liquidHours, timeZoneId]。
   *
   * **为什么不能用 `Settings.marketStatus`**:那张表是照美股正股写的
   * (4:00 盘前 / 9:30 盘中 / 16:00 盘后 / 20:00 休市)。SPX 期权不是这个时段——
   * IBKR 报的 SPXW 是 `19:15–次日 08:25` 加 `08:30–15:00`(US/Central,即美东
   * 20:15–09:25 与 09:30–16:00)。拿正股的表去判期权,0DTE 蝶在隔夜那一整段会被
   * 当成"休市",追踪止盈整段不设防。
   *
   * 组合(BAG)本身没有时段,取它第一条腿的——同一到期日的腿时段相同。
   * 查不到就回 null,让调用方退回正股那套,而不是把仓位卡死在"休市"。
   */
  /** 同步读已缓存的合约时段(校验链路不是 async,不能在那里等一次网络往返)。
   * 没缓存回 null,调用方退回正股表;缓存由追踪轮询那条路每天填上一次。 */
  cachedContractHours(symbol: string, expiry: string): [string, string, string] | null {
    const hit = this.hoursCache.get(`${symbol}|${expiry}`);
    if (!hit || hit[0] !== nowEt().date) return null;
    return [hit[1], hit[2], hit[3]];
  }

  async contractHours(
    row: Record<string, any>, account: AccountConfig,
  ): Promise<[string, string, string] | null> {
    const secType = String(row["sec_type"] ?? "");
    const contract = (row["contract"] ?? {}) as Record<string, any>;
    let expiry: any, strike: any, right: any;
    if (secType === "BAG") {
      const legs = (contract["legs"] ?? []) as Array<Record<string, any>>;
      if (!legs.length) return null;
      ({ lastTradeDateOrContractMonth: expiry, strike, right } = legs[0]! as any);
    } else if (secType === "OPT" || secType === "FOP") {
      ({ lastTradeDateOrContractMonth: expiry, strike, right } = contract as any);
    } else {
      return null;
    }
    if (!expiry || strike === null || strike === undefined || strike === "" || !right) return null;

    const key = `${row["symbol"]}|${expiry}`;
    const today = nowEt().date;
    const hit = this.hoursCache.get(key);
    if (hit && hit[0] === today) return [hit[1], hit[2], hit[3]];

    let session: IbSession;
    try {
      session = await this.forAccount(account);
    } catch {
      return null;
    }
    if (typeof session.contractHours !== "function") return null;
    const probe: IbContract = {
      secType: "OPT", symbol: String(row["symbol"]), exchange: "SMART", currency: "USD",
      lastTradeDateOrContractMonth: String(expiry), strike: Number(strike),
      right: String(right).slice(0, 1).toUpperCase(), multiplier: "100",
    } as IbContract;
    let out: [string, string, string] | null = null;
    try {
      out = await session.contractHours(probe, BrokerRouter.QUALIFY_TIMEOUT_MS);
    } catch {
      return null;
    }
    if (!out) return null;
    this.hoursCache.set(key, [today, out[0], out[1], out[2]]);
    return out;
  }

  async positions(): Promise<PositionRow[]> {
    const out = new Map<string, PositionRow>();
    const aliasOf = new Map(this.settings.accounts.map((a) => [a.account_id, a.alias]));

    for (const session of liveSessions(this.connectionsMap, (m) => new BrokerError(m))) {
      let items: PortfolioItemLike[] = [];
      try {
        items = await session.portfolio();
      } catch {
        items = []; // 没订阅账户更新时会空手而归
      }
      for (const item of items) {
        // 账号在持仓项上(item.account),不在合约上——否则所有账户的仓都记到默认账户名下
        const row = this.positionRow(item.contract, item.position, aliasOf, item.account ?? "");
        if (row === null) continue;
        row["avg_cost"] = cleanPrice(item.averageCost) ?? 0.0;
        row["market_price"] = cleanPrice(item.marketPrice);
        row["market_value"] = finiteQuote(item.marketValue) || null;
        row["unrealized_pnl"] = finiteQuote(item.unrealizedPnL);
        out.set(row["key"] as string, row);
      }
      // 读不到持仓要**报错**,不能当成空仓:空列表会让盯盘判"持仓已不存在",停掉追踪、撤掉托管单
      // (2026-09-10 真机:持仓推送卡住,BE 的追踪就这么被自动停用了)。多个会话里只要有一个读不到,
      // 整次都算读不到——只回一部分,读不到的那个账户照样会被误判。
      let rawPositions: PositionItemLike[];
      try {
        rawPositions = await session.positions();
      } catch (exc) {
        throw new BrokerError(`读不到持仓:${(exc as Error).message}`);
      }
      for (const pos of rawPositions) {
        const row = this.positionRow(pos.contract, pos.position, aliasOf, pos.account ?? "");
        if (row === null || out.has(row["key"] as string)) continue; // portfolio 更准
        row["avg_cost"] = cleanPrice(pos.avgCost) ?? 0.0;
        out.set(row["key"] as string, row);
      }
    }

    const rows = [...out.values()].filter((r) => r["quantity"]);
    await this.fillPositionPrices(rows);
    return rows.sort((a, b) =>
      String(a["account"]).localeCompare(String(b["account"])) ||
      String(a["symbol"]).localeCompare(String(b["symbol"])),
    );
  }

  private readonly unmappedAccounts = new Set<string>();

  private positionRow(
    contract: Record<string, any>, quantity: number, aliasOf: Map<string, string>,
    accountHint = "",
  ): PositionRow | null {
    const account = String(accountHint || contract["account"] || "");
    let alias = aliasOf.get(account);
    if (alias === undefined) {
      if (account) {
        // 券商报了账号但别名表里没有:不是本软件管的账户,不显示、不追踪(每个账号只提醒一次)
        if (!this.unmappedAccounts.has(account)) {
          this.unmappedAccounts.add(account);
          logStderr(
            `[ibkr] 账户 ${redactForLog(account)} 不在配置的别名表里,它的持仓不显示、不追踪。` +
            "要管这个账户,把它加进 config/settings.json 的 accounts。",
          );
        }
        return null;
      }
      // 券商没报账号(极少见)才退到默认账户
      const dflt = this.settings.defaultAccount();
      if (dflt === null) return null;
      alias = dflt.alias;
    }
    const symbol = String(contract["symbol"] ?? "");
    if (!symbol) return null;
    const secType = String(contract["secType"] ?? "STK") || "STK";
    let multiplier = Number(contract["multiplier"] ?? "") || 1;
    if (!Number.isFinite(multiplier)) multiplier = 1.0;
    const spec = {
      secType,
      symbol,
      exchange: String(contract["exchange"] ?? "") || "SMART",
      currency: String(contract["currency"] ?? "USD") || "USD",
      lastTradeDateOrContractMonth: contract["lastTradeDateOrContractMonth"] || null,
      strike: Number(contract["strike"] ?? 0) || null,
      right: contract["right"] || null,
      multiplier: multiplier ? String(Math.trunc(multiplier)) : "100",
      tradingClass: contract["tradingClass"] || null,
    };
    // 期权按腿区分:一只蝴蝶三条腿都是同一个 symbol/secType,
    // key 不带腿身份就会互相覆盖,界面上只剩一条、追踪也会认错腿
    const leg = legOf(spec);
    return {
      key: makeKey(alias, symbol, secType, leg),
      account: alias,
      symbol,
      sec_type: secType,
      leg,
      label: positionLabel(symbol, secType, spec),
      quantity: Number(quantity ?? 0) || 0,
      multiplier,
      currency: String(contract["currency"] ?? "USD") || "USD",
      avg_cost: 0.0,
      market_price: null,
      market_value: null,
      unrealized_pnl: null,
      contract: spec,
    };
  }

  /** 期权腿的现价:常驻订阅(每腿一条线路,订阅一次留着),读盘口中间价,没盘口退最新价。
   * 不订阅的话组合价格永远是"—",追踪也永远不触发。对应 Python _fill_option_prices。 */
  private async fillOptionPrices(rows: Array<Record<string, any>>): Promise<void> {
    const legs = rows.filter(
      (r) => r["market_price"] === null && (r["sec_type"] === "OPT" || r["sec_type"] === "FOP"),
    );
    if (!legs.length) return;
    const session = this.sessions()[0] ?? null;
    if (session === null) return;
    await this.ensureOptionStreams(session, legs);
    for (const row of legs) {
      const entry = this.optionStreams.get(`opt:${row["key"]}`);
      if (!entry?.handle) continue;
      const t = entry.handle.read();
      const bid = cleanPrice(t.bid);
      const ask = cleanPrice(t.ask);
      if (bid !== null && ask !== null && ask >= bid) row["market_price"] = pyRound((bid + ask) / 2.0, 4);
      else row["market_price"] = cleanPrice(t.last) ?? cleanPrice(t.marketPrice);
      // 休市时 TWS 只报昨收(09-17 真机:USO 115P/120P 只有 close)。昨收只给界面看,绝不填进 market_price——拿昨晚的价判触发、
      // 反解波动率、推托管单的价都是错的。model_iv:IBKR 模型 IV,标的目标价的 ibkr 档用(ivPricing.ts);没有就不带这个键
      const close = cleanPrice(t.close), iv = cleanPrice(t.modelGreeks?.impliedVol);
      if (close !== null) row["close_price"] = close;
      if (iv !== null) row["model_iv"] = iv;
    }
  }

  /**
   * 持仓期权腿此刻的买卖价(按持仓 key)。和 fillOptionPrices 共用同一批常驻订阅:第一次要等首笔 tick,
   * 之后每轮只读缓存。追价平仓每秒要一次「立刻成交价」,legQuotes 那种现订现撤、一等四秒的办法跟不上。
   * 拿不到的腿给 null,不编。
   */
  async optionQuotes(
    rows: Array<Record<string, any>>,
  ): Promise<Record<string, { bid: number | null; ask: number | null }>> {
    const legs = rows.filter((r) => r["sec_type"] === "OPT" || r["sec_type"] === "FOP");
    const out: Record<string, { bid: number | null; ask: number | null }> = {};
    if (!legs.length) return out;
    const session = this.sessions()[0] ?? null;
    if (session === null) return out;
    await this.ensureOptionStreams(session, legs);
    for (const row of legs) {
      const t = this.optionStreams.get(`opt:${row["key"]}`)?.handle?.read();
      out[String(row["key"])] = { bid: t ? cleanPrice(t.bid) : null, ask: t ? cleanPrice(t.ask) : null };
    }
    return out;
  }

  /** 给这些期权腿备好常驻行情订阅(已有的跳过,被拒过的摘掉重订)。 */
  private async ensureOptionStreams(session: IbSession, legs: Array<Record<string, any>>): Promise<void> {
    let fresh = false;
    // 纸面账户按类型 3 订(有实时就是实时,没有给延迟),和 legQuotes 同一条规矩;实盘绝不拿延迟价盯盘。
    // 这台机器上实盘 TWS 占着实时行情,纸面会话按类型 1 订期权必吃 10197——腿价永远是空的,
    // 组合净价跟着没有,追踪器只能退到模型默认波动率(2026-09-10 真机)。
    const paper = legs.every((r) => this.settings.accountByAlias(String(r["account"]))?.is_paper ?? false);
    if (paper) session.reqMarketDataType(3);
    try {
      for (const row of legs) {
        const key = `opt:${row["key"]}`;
        const existing = this.optionStreams.get(key);
        // 被拒过的流不会自己活过来:摘掉重订(认不出的合约 handle 为 null,照旧不重试)
        if (existing?.handle && existing.handle.read().error) {
          if (existing.contract) {
            try {
              session.cancelTicker(existing.contract);
            } catch {
              /* 撤不掉也要重订 */
            }
          }
          this.optionStreams.delete(key);
        } else if (existing) {
          continue;
        }
        const spec = (row["contract"] ?? {}) as Record<string, any>;
        const target = optionContract(
          String(row["symbol"]), String(spec["lastTradeDateOrContractMonth"] ?? ""),
          Number(spec["strike"] ?? 0) || 0, String(spec["right"] ?? ""),
          String(spec["exchange"] || "SMART"), "USD", String(spec["multiplier"] || "100"),
          spec["tradingClass"] ?? null,
        );
        try {
          await this.qualifyOrRaise(session, target);
        } catch (exc) {
          if (exc instanceof BrokerError) {
            this.optionStreams.set(key, { handle: null, contract: null }); // 认不出的合约不反复重试
            continue;
          }
          throw exc;
        }
        this.optionStreams.set(key, { handle: session.subscribeTicker(target), contract: target });
        fresh = true;
      }
      // 首次订阅要等第一笔 tick 落地;之后每轮只是从常驻订阅的缓存里读,泵一下事件循环
      // 就够。追踪轮询按秒跑,这里每多等 100ms 就是 10% 的占用,而 RPC 是单线程的。
      // 类型 3 要保持到这一步结束:连接刚建好时请求实际发出去会晚一拍,切早了就按实时类型发。
      await session.settle(fresh ? 1500 : 50);
    } finally {
      if (paper) session.reqMarketDataType(1);
    }
  }

  /**
   * 持仓正股的现价兜底(账户推送里没有现价时):**常驻订阅**,第一次等首笔 tick,之后每轮读缓存。
   *
   * 以前每一轮都 stockQuotes 一次——订阅、干等 2.5 秒、撤掉。持仓读取在盯盘与托管对账两个
   * 一秒一轮的循环里都要跑,而它们挤在同一条严格顺序的交易道上:2026-09-10 夜盘真机,
   * BE 的账户推送没有现价,tracker.poll 与 tracker.reconcile 每轮各 2.5 秒,整条交易道被占满,
   * 「秒级调价」变成五秒一次,下单也得排在后面。和期权腿价(fillOptionPrices)同一套写法。
   */
  private readonly stockStreams = new Map<string, { handle: TickerHandle | null; contract: IbContract | null }>();

  private async fillPositionPrices(rows: Array<Record<string, any>>): Promise<void> {
    const need = [...new Set(rows
      .filter((r) => r["market_price"] === null && r["sec_type"] === "STK")
      .map((r) => r["symbol"] as string))].sort();
    if (need.length) {
      const session = this.sessions()[0] ?? null;
      if (session !== null) {
        let fresh = false;
        const paper = rows.filter((r) => r["sec_type"] === "STK")
          .every((r) => this.settings.accountByAlias(String(r["account"]))?.is_paper ?? false);
        if (paper) session.reqMarketDataType(3);
        try {
          for (const symbol of need) {
            const existing = this.stockStreams.get(symbol);
            if (existing?.handle && existing.handle.read().error) {
              // 被拒过的流不会自己活过来:摘掉重订(只撤不带 generic 的这条,别误伤异动监控的量能流)
              try {
                if (existing.contract) session.cancelTicker(existing.contract, "");
              } catch {
                /* 撤不掉也要重订 */
              }
              this.stockStreams.delete(symbol);
            } else if (existing) {
              continue;
            }
            const target = stockContract(symbol);
            try {
              await this.qualifyOrRaise(session, target);
            } catch (exc) {
              if (exc instanceof BrokerError) {
                this.stockStreams.set(symbol, { handle: null, contract: null }); // 认不出的不反复重试
                continue;
              }
              throw exc;
            }
            this.stockStreams.set(symbol, { handle: session.subscribeTicker(target), contract: target });
            fresh = true;
          }
          await session.settle(fresh ? 1500 : 50);
        } finally {
          if (paper) session.reqMarketDataType(1);
        }
        for (const row of rows) {
          if (row["market_price"] !== null || row["sec_type"] !== "STK") continue;
          const entry = this.stockStreams.get(String(row["symbol"]));
          if (!entry?.handle) continue;
          const t = entry.handle.read();
          const bid = cleanPrice(t.bid);
          const ask = cleanPrice(t.ask);
          row["market_price"] = cleanPrice(t.last)
            ?? (bid !== null && ask !== null && ask >= bid ? pyRound((bid + ask) / 2.0, 4) : null)
            ?? cleanPrice(t.close);
          if (row["market_price"] !== null) row["price_source"] = "quote";
        }
      }
    }
    await this.fillOptionPrices(rows);
  }

  // ---- 下单 -----------------------------------------------------------
  async place(
    recordId: string, approved: ApprovedOrder, limitOverride: number | null = null,
  ): Promise<PlacementResult> {
    const parsed = approved.order;
    const session = await this.forAccount(approved.account as AccountConfig);
    const contract = await this.qualify(parsed.contract, approved.account as AccountConfig);

    let order: OrderIntent;
    if (parsed.contract.secType === "BAG") {
      // BAG 一律以 BUY 提交:IBKR 对 BAG 的 SELL 会反转每条腿的方向
      const signedLimit =
        limitOverride !== null
          ? limitOverride // AUTO_MID 已是带符号净价
          : bagSignedLimit(parsed.order.action, parsed.order.lmtPrice);
      order = buildOrderIntent(parsed.order, approved.account.account_id, signedLimit, "BUY");
    } else {
      order = buildOrderIntent(parsed.order, approved.account.account_id, limitOverride);
    }
    // 幂等标识:回报、对账、去重都能凭 orderRef 找回这条记录
    order.orderRef = recordId;

    // 方式 A:用户给了明确价格的条件单,条件挂在 IBKR 服务器上,软件掉线也有效
    if (parsed.trigger !== null && parsed.order.price_mode === "EXPLICIT") {
      order.conditions = [await this.priceCondition(session, parsed.trigger)];
      order.conditionsCancelOrder = false;
    }

    // 不再 settle(500):orderId 在 placeOrder 返回时已经确定,状态与成交
    // 由事件回报异步落库——为一个"也许能看到的早期状态"陪 500ms 不值得。
    const trade = await session.placeOrder(contract, order);
    // 记住这张单的会话 / 合约 / 原样订单:追踪的平仓单发出后要按秒改价(modifyHosted),
    // 改单是同 orderId 整张重发,得有原样的那一份
    if (trade.orderId) this.hostedTrades.set(trade.orderId, { session, contract, order });
    return {
      record_id: recordId,
      order_id: trade.orderId ?? null,
      perm_id: trade.permId ?? null,
      status: trade.status || "Submitted",
      limit_price: order.lmtPrice,
      detail: { account: approved.account.account_id },
    };
  }

  private async priceCondition(
    session: IbSession, trigger: TriggerSpec,
  ): Promise<Record<string, unknown>> {
    const spec = priceConditionSpec(trigger);
    const cfg = this.settings.indexConfig(trigger.symbol);
    const target =
      trigger.secType === "IND"
        ? indexContract(trigger.symbol, cfg ? cfg.exchange : "CBOE")
        : stockContract(trigger.symbol);
    await this.qualifyOrRaise(session, target);
    return {
      type: "price",
      conId: target.conId,
      exchange: target.exchange,
      isMore: spec["isMore"],
      price: spec["price"],
    };
  }

  sessions(): IbSession[] {
    return [...this.connectionsMap.values()].filter((s) => s.isConnected());
  }

  /** 此刻读得到持仓的账户别名 / 账户号(见 ibLink.coveredAccounts):不在里面的账户,读不到不等于没有。 */
  coveredAccounts(): Set<string> {
    return coveredAccounts(this.settings.accounts, this.connectionsMap);
  }
  coveredAccountIds(): Set<string> {
    return new Set(this.settings.accounts.filter((a) => this.coveredAccounts().has(a.alias)).map((a) => a.account_id));
  }

  connectedNames(): string[] {
    return [...this.connectionsMap.entries()]
      .filter(([, s]) => s.isConnected())
      .map(([name]) => name)
      .sort();
  }

  /** 熔断用:撤掉全部未成交单(§9.7)。 */
  async cancelAllOpen(): Promise<number> {
    let count = 0;
    for (const session of this.connectionsMap.values()) {
      if (!session.isConnected()) continue;
      for (const trade of await session.openTrades()) {
        trade.cancel();
        count += 1;
      }
    }
    return count;
  }

  // ---- 券商托管的止盈/止损(GTC + OCA,挂在 IBKR 服务器上)---------------
  /** 富途的 router 没有这套(OpenD 不给同形的 OCA/TRAIL),置 false。 */
  readonly SUPPORTS_HOSTED_CLOSE = true;

  /** 托管单:orderId → 会话 + 合约 + 订单意图。改单必须同 id 重发,
   * 认领(listHostedOpen)和挂单(placeHosted)都会往这里登记。 */
  private readonly hostedTrades = new Map<
    number, { session: IbSession; contract: IbContract; order: OrderIntent }
  >();

  /** 挂一张托管单。GTC:软件关掉它也站岗——这正是托管的意义。
   * OCA 组内一张成交,券商自动撤其余,与"触发一次就落闩"同义。 */
  async placeHosted(
    account: AccountConfig,
    contractSpec: ContractSpec,
    item: HostedOrderPlan,
    ocaGroup: string,
    orderRef: string,
  ): Promise<{ order_id: number | null; perm_id: number | null; status: string }> {
    const session = await this.forAccount(account);
    const contract = await this.qualify(contractSpec, account);
    // BAG 一律以 BUY 提交:IBKR 对 BAG 的 SELL 会把每条腿再反转一次,那就把保护翼卖了、
    // 收权腿买了。带符号净价由 bagSignedLimit 换算——托管一张平掉借方蝶的限价单是**收**
    // 权利金,发给 IBKR 的净价必须是负数。与 place() 同一套换算。
    const isBag = (contractSpec as { secType?: string }).secType === "BAG";
    const order: OrderIntent = {
      action: isBag ? "BUY" : item.action,
      orderType: item.order_type,
      totalQuantity: item.quantity,
      lmtPrice: isBag ? bagSignedLimit(item.action, item.lmt_price ?? null) : (item.lmt_price ?? null),
      auxPrice: item.aux_price ?? null,
      trailingPercent: item.trailing_percent ?? null,
      tif: "GTC",
      // 托管止盈/止损同样要全时段站岗:股票开盘外标志,盘前盘后也能触发成交。
      // 期权没有盘外交易(SPX 的全球时段另算),标志对它无意义,不打。
      outsideRth: (contractSpec as { secType?: string }).secType === "STK",
      account: account.account_id,
      transmit: true,
      orderRef,
      ocaGroup,
      ocaType: 1, // 一张成交,整组撤销
    };
    // 用持久化峰值播种 TRAIL 初始停损:重启不把已锁住的利润放开
    if (item.trailing_percent !== null && item.trail_stop_seed !== null) {
      order.trailStopPrice = item.trail_stop_seed;
    }
    const trade = await session.placeOrder(contract, order);
    if (trade.orderId) {
      this.hostedTrades.set(trade.orderId, { session, contract, order });
    }
    return {
      order_id: trade.orderId ?? null,
      perm_id: trade.permId ?? null,
      status: trade.status || "Submitted",
    };
  }

  /** 改一张托管单的价格/数量(同 orderId 重发 = IBKR 的改单语义)。
   * 撤了重挂会留出一段没有保护的窗口,改单没有——所以必须是改,不是换。 */
  async modifyHosted(orderId: number, item: HostedOrderPlan): Promise<boolean> {
    const entry = this.hostedTrades.get(orderId);
    if (entry === undefined) return false;
    entry.order.orderId = orderId;
    entry.order.totalQuantity = item.quantity;
    // 组合改价同样要走带符号净价——挂单时签了、改单时忘了签,第一次调价就会把
    // 一张"收 12.35"的单改成"付 12.35"。
    const isBag = String(entry.contract.secType ?? "") === "BAG";
    if (item.lmt_price !== null) {
      entry.order.lmtPrice = isBag ? bagSignedLimit(item.action, item.lmt_price) : item.lmt_price;
    }
    if (item.aux_price !== null) entry.order.auxPrice = item.aux_price;
    if (item.trailing_percent !== null) entry.order.trailingPercent = item.trailing_percent;
    await entry.session.placeOrder(entry.contract, entry.order);
    return true;
  }

  async cancelHosted(orderId: number): Promise<boolean> {
    const entry = this.hostedTrades.get(orderId);
    if (entry === undefined) return false;
    this.hostedTrades.delete(orderId);
    await entry.session.cancelOrder(orderId);
    return true;
  }

  /** 从券商未成交单里认领托管单(orderRef 前缀匹配)。
   * 重启后的第一件事:先认领再对账,否则同一追踪会被再挂一遍。 */
  async listHostedOpen(refPrefix = "trk:"): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (const session of this.connectionsMap.values()) {
      if (!session.isConnected() || typeof session.openTradesDetailed !== "function") continue;
      for (const trade of await session.openTradesDetailed()) {
        if (!trade.orderRef.startsWith(refPrefix)) continue;
        if (trade.orderId) {
          this.hostedTrades.set(trade.orderId, {
            session,
            contract: trade.contract,
            order: {
              action: trade.action,
              orderType: trade.orderType,
              totalQuantity: trade.totalQuantity,
              lmtPrice: trade.lmtPrice,
              auxPrice: trade.auxPrice,
              trailingPercent: trade.trailingPercent,
              tif: trade.tif || "GTC",
              outsideRth: Boolean(trade.outsideRth),
              account: trade.account,
              transmit: true,
              orderRef: trade.orderRef,
              // 改单要整张重发:不带上原来的 OCA 组,改一次价就可能把它踢出组
              ...(trade.ocaGroup ? { ocaGroup: trade.ocaGroup, ocaType: trade.ocaType ?? 1 } : {}),
            },
          });
        }
        rows.push({
          order_ref: trade.orderRef,
          order_id: trade.orderId,
          perm_id: trade.permId,
          account: trade.account,
          action: trade.action,
          order_type: trade.orderType,
          quantity: trade.totalQuantity,
          // BAG 在券商侧存的是带符号净价(平借方蝶是负数),引擎这边一律用用户口径的正数比较。
          // 不折回来的话,重启认领之后第一轮就会把 −12.35 和 12.35 当成"价变了"去改一次单。
          lmt_price: String(trade.contract?.secType ?? "") === "BAG" && trade.lmtPrice !== null && trade.lmtPrice !== undefined
            ? Math.abs(Number(trade.lmtPrice)) : trade.lmtPrice,
          aux_price: trade.auxPrice,
          trailing_percent: trade.trailingPercent,
          status: trade.status,
          sec_type: String(trade.contract?.secType ?? ""),
        });
      }
    }
    return rows;
  }

  /** 券商侧全部未成交单(不按 orderRef 过滤)。执行对账用:普通单与条件单的 orderRef
   * 就是记录 id,引擎据此重建 orderId → 记录的索引。
   * 顺带把每张单登记进 hostedTrades(listHostedOpen 做的),改单 / 撤单才有原样订单可发。 */
  async listOpenOrdersDetailed(): Promise<Array<Record<string, unknown>>> {
    return this.listHostedOpen("");
  }
}




/**
 * 上一个已经收盘的常规时段:[日期, 收盘分钟]。今天是交易日且已过收盘就是今天,
 * 否则往回找最近的交易日。半日市收在 13:00,基差得取那一分钟,不是 16:00。
 */
export function lastRthSession(now: EtNow, settings: Settings): [string, number] {
  const closeOf = (d: string): number => (settings.early_close_days.includes(d) ? 13 * 60 : 16 * 60);
  if (settings.isTradingDay(now.date) && now.seconds >= closeOf(now.date) * 60) {
    return [now.date, closeOf(now.date)];
  }
  let ordinal = dateOrdinal(now.date);
  for (let i = 0; i < 14; i += 1) {
    ordinal -= 1;
    const d = ordinalToDate(ordinal);
    if (settings.isTradingDay(d)) return [d, closeOf(d)];
  }
  throw new Error(`${now.date} 往前两周都找不到交易日`);
}

/**
 * 指数与期货在**同一分钟**的收盘差,取两边都有的最后那一分钟。
 * 对不上同一分钟就回 null:拿两个错开的价相减,等于把中间那段行情当成了基差。
 */
export function contemporaneousBasis(
  indexBars: Array<{ time: string; close: number }>,
  futuresBars: Array<{ time: string; close: number }>,
): { basis: number; time: string; index_close: number; futures_close: number } | null {
  const fut = new Map(
    futuresBars.filter((b) => Number.isFinite(b.close) && b.close > 0).map((b) => [b.time, b.close]),
  );
  const idx = indexBars.filter((b) => Number.isFinite(b.close) && b.close > 0);
  for (let i = idx.length - 1; i >= 0; i -= 1) {
    const f = fut.get(idx[i]!.time);
    if (f !== undefined) {
      return {
        basis: pyRound(f - idx[i]!.close, 4), time: idx[i]!.time,
        index_close: idx[i]!.close, futures_close: f,
      };
    }
  }
  return null;
}







/** IBKR 成交时间字符串 → epoch 毫秒。认:IB 成交时间的三种写法(实时推送的 'yyyymmdd-hh:mm:ss' 按 UTC、
 * 'yyyymmdd hh:mm:ss Zone'、不带时区的 'yyyymmdd  hh:mm:ss' 按美东,见 tz.ibWallTime)、纯数字(unix 秒)、ISO。
 * 解析不了回 null。 */
export function parseIbTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s) && s.length !== 8) return Number(s) * 1000;
  const ib = ibWallTime(s);
  if (ib) return zonedEpoch(ib.wall, ib.tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (m) {
    return wallToEpoch({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
      hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }, ET);
  }
  const parsed = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

/** ib 的成交明细 → 本系统的成交行(与 Python fill_row 同形)。时间统一成 UTC ISO;没有 execId 的丢掉。 */
export function fillRow(contract: Record<string, any>, execution: Record<string, any>): Record<string, any> | null {
  const execId = String(execution["execId"] ?? "");
  if (!execId) return null;
  const epoch = parseIbTime(execution["time"]);
  const timeIso = epoch === null ? String(execution["time"] ?? "") : utcIso(epoch);
  const strike = finiteQuote(contract["strike"]);
  const conId = Math.trunc(Number(contract["conId"] ?? 0)) || null;
  const orderId = Math.trunc(Number(execution["orderId"] ?? 0)) || null;
  const permId = Math.trunc(Number(execution["permId"] ?? 0)) || null;
  return {
    exec_id: execId,
    time: timeIso,
    account_id: String(execution["acctNumber"] ?? ""),
    side: String(execution["side"] ?? ""),
    shares: Number(execution["shares"] ?? 0) || 0,
    price: Number(execution["price"] ?? 0) || 0,
    order_id: orderId,
    perm_id: permId,
    order_ref: String(execution["orderRef"] ?? ""),
    commission: finiteQuote(execution["commission"]),
    contract: {
      secType: String(contract["secType"] ?? ""),
      symbol: String(contract["symbol"] ?? ""),
      expiry: String(contract["lastTradeDateOrContractMonth"] ?? ""),
      strike: strike || null,
      right: String(contract["right"] ?? ""),
      tradingClass: String(contract["tradingClass"] ?? ""),
      multiplier: String(contract["multiplier"] ?? ""),
      conId,
      currency: String(contract["currency"] ?? ""),
      exchange: String(contract["exchange"] ?? ""),
    },
  };
}

function readPriceFrom(t: TickerData): number | null {
  for (const candidate of [t.last, t.close, t.marketPrice]) {
    if (candidate && !Number.isNaN(candidate)) return Number(candidate);
  }
  return null;
}

/** 轮询而不是死等:价格到了立刻返回,waitMs 只是上限。
 * 固定 settle(1000) 意味着哪怕 tick 在第 80ms 就到了也要陪满一秒。 */
async function pollTicker(
  session: IbSession, ticker: TickerHandle, waitMs: number,
): Promise<number | null> {
  let waited = 0;
  for (;;) {
    const price = readPriceFrom(ticker.read());
    if (price !== null) return price;
    if (waited >= waitMs) return null;
    await session.settle(Math.min(100, waitMs - waited));
    waited += 100;
  }
}

export function isTimeout(exc: unknown): boolean {
  const msg = String((exc as Error)?.message ?? exc).toLowerCase();
  return msg.includes("timeout") || (exc as Error)?.name === "TimeoutError";
}

/** 默认会话工厂:IBApiNext 适配层(真机联调前不会被离线测试触达)。 */
const defaultFactory: IbSessionFactory = async (cfg) => {
  const { createIbApiNextSession } = await import("./ibSession.js");
  return createIbApiNextSession(cfg);
};
