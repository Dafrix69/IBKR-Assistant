/** IBKR 下单层(对应 Python broker.py,§8)。
 *
 * 结构照抄:纯函数(定价数学)不碰网络,可脱机对拍;BrokerRouter 负责连接与
 * 路由,只认 AccountConfig。与 Python 版的差别只有一处:ib_insync 在 TS 世界
 * 没有对应物,这里把"会话"抽成 IbSession 接口(语义与 ib_insync 对齐),
 * 默认实现走 @stoqey/ib 的 IBApiNext(见 ibSession.ts)——现成的 reqId 配对
 * 与订阅管理都用库的,不自己写。
 */
import { nowEt } from "./config.js";
import type { AccountConfig, Settings } from "./config.js";
import type { ContractSpec, OrderSpec, ParsedOrder, TriggerSpec } from "./models.js";
import type { HostedOrderPlan } from "./tracker.js";
import { legOf, makeKey, positionLabel } from "./tracker.js";
import { MIN_BARS, TIMEFRAMES } from "./priceaction.js";
import { utcIso } from "./tradereview.js";
import type { ApprovedOrder } from "./validator.js";
import { fmtF, pyRound } from "./py.js";
import { ET, pad2, wallParts, wallToEpoch } from "./tz.js";

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
export function bookLiquidity(book: Record<string, any>): Record<string, any> {
  const l1 = book["l1"] ?? {};
  const bids: Array<Record<string, any>> = book["bids"] ?? [];
  const asks: Array<Record<string, any>> = book["asks"] ?? [];
  const out: Record<string, any> = {};

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

/** 日志里的账号一律掩码(§9.3)。 */
export function redactForLog(accountId: string): string {
  return accountId.length > 5 ? `${accountId.slice(0, 2)}***${accountId.slice(-3)}` : "***";
}

export function logStderr(message: string): void {
  try {
    process.stderr.write(message + "\n");
  } catch {
    /* 日志失败绝不影响交易路径 */
  }
}

/** 把 IBKR 的报价字段清洗成可用数字:NaN / 非正 / 非数字都归 null。 */
export function cleanPrice(value: unknown): number | null {
  const v = Number(value);
  if (value === null || value === undefined || Number.isNaN(v)) return null;
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
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

/** 订单意图(与券商无关的纯数据)。IbSession 适配层再翻成 @stoqey/ib 的 Order。 */
export interface OrderIntent {
  orderType: string;
  action: string;
  totalQuantity: number;
  lmtPrice: number | null;
  auxPrice: number | null;
  trailingPercent: number | null;
  tif: string;
  outsideRth: boolean;
  account: string;
  transmit: boolean;
  orderRef?: string;
  conditions?: Array<Record<string, unknown>>;
  conditionsCancelOrder?: boolean;
  /** 托管单(sync_hosted 那条路)用:OCA 组、TRAIL 初始停损、改单时的原 id。 */
  ocaGroup?: string;
  ocaType?: number;
  trailStopPrice?: number;
  orderId?: number;
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

export interface IbContract {
  secType: string;
  symbol: string;
  exchange: string;
  currency: string;
  lastTradeDateOrContractMonth?: string;
  strike?: number;
  right?: string;
  multiplier?: string;
  tradingClass?: string;
  conId?: number;
  comboLegs?: Array<{ conId: number; ratio: number; action: string; exchange: string }>;
  /** 已到期合约(蝶价历史要用到昨天的 0DTE 腿)要带这个才能 qualify */
  includeExpired?: boolean;
}

export interface TickerData {
  bid: number;
  ask: number;
  last: number | null;
  close: number | null;
  bidSize: number | null;
  askSize: number | null;
  marketPrice: number | null;
  callOpenInterest?: number | null;
  putOpenInterest?: number | null;
  callVolume?: number | null;
  putVolume?: number | null;
  modelGreeks?: { gamma: number | null; impliedVol: number | null } | null;
}

export interface TickerHandle {
  read(): TickerData;
}

export interface RawBar {
  date: string; // IBKR formatDate=1 文本
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface OptChainParam {
  exchange: string;
  tradingClass: string;
  expirations: string[];
  strikes: number[];
}

export interface PortfolioItemLike {
  contract: Record<string, any>;
  position: number;
  averageCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  account?: string; // 账号在持仓项上,不在合约上
}

export interface PositionItemLike {
  contract: Record<string, any>;
  position: number;
  avgCost: number;
  account?: string;
}

export interface TradeLike {
  orderId: number | null;
  permId: number | null;
  status: string;
}

export interface IbSession {
  isConnected(): boolean;
  disconnect(): void | Promise<void>;
  managedAccounts(): string[];
  /** qualify:失败 resolve 时 conId 仍为 0;超时 reject(TimeoutError 语义)。 */
  qualifyContracts(contracts: IbContract[], timeoutMs: number): Promise<void>;
  /** 合约详情里的交易时段(tradingHours / liquidHours / timeZoneId)。拿不到回 null。 */
  contractHours?(contract: IbContract, timeoutMs: number): Promise<[string, string, string] | null>;
  reqMarketDataType(type: number): void;
  /** 订阅并保留;返回句柄按需读当前值。 */
  subscribeTicker(contract: IbContract, genericTicks?: string): TickerHandle;
  cancelTicker(contract: IbContract): void;
  /** 事件泵(对应 ib.sleep):等行情落地。 */
  settle(ms: number): Promise<void>;
  historicalData(contract: IbContract, opts: {
    endDateTime: string;
    durationStr: string;
    barSizeSetting: string;
    whatToShow: string;
    useRTH: boolean;
  }): Promise<RawBar[]>;
  secDefOptParams(symbol: string, secType: string, conId: number): Promise<OptChainParam[]>;
  mktDepth(contract: IbContract, rows: number, waitMs: number): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }>;
  placeOrder(contract: IbContract, order: OrderIntent): Promise<TradeLike>;
  openTrades(): Promise<Array<{ orderId: number | null; cancel(): void }>>;
  /** 托管单撤单(按 orderId)。真机适配层实现;测试替身也要实现。 */
  cancelOrder?(orderId: number): void | Promise<void>;
  /** 托管单认领用:带 orderRef 与价格字段的未成交单明细。 */
  openTradesDetailed?(): Promise<Array<{
    orderId: number | null;
    permId: number | null;
    orderRef: string;
    account: string;
    action: string;
    orderType: string;
    totalQuantity: number;
    lmtPrice: number | null;
    auxPrice: number | null;
    trailingPercent: number | null;
    status: string;
    contract: IbContract;
  }>>;
  portfolio(): Promise<PortfolioItemLike[]>;
  positions(): Promise<PositionItemLike[]>;
  /** 当天逐笔成交(reqExecutions)。真机适配层实现;测试替身可不实现。 */
  executions?(): Promise<Array<{ contract: Record<string, any>; execution: Record<string, any> }>>;
  /** 连接级事件(1100/1101/1102)回调。 */
  onConnectivity(cb: (code: number) => void): void;
  /** engine 挂订单回报监听用(推式)。 */
  onOrderStatus?(cb: (trade: any) => void): void;
  onFill?(cb: (trade: any, fill: any) => void): void;
  onCommission?(cb: (trade: any, fill: any, report: any) => void): void;
  /** 订单级错误(reqId = orderId):200 证券定义、110 跳动、201 拒单等 */
  onError?(cb: (reqId: number, code: number, message: string) => void): void;
  /** 摘掉 onError 挂上的回调(legQuotes 的临时监听用)。 */
  offError?(cb: (reqId: number, code: number, message: string) => void): void;
}

export type IbSessionFactory = (cfg: {
  host: string;
  port: number;
  clientId: number;
  readonly: boolean;
}) => Promise<IbSession>;

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
    this.connectionsMap.set(connectionName, session);
    if (this.sessionHook !== null) {
      try {
        this.sessionHook(session);
      } catch {
        /* 挂监听失败不应阻断连接本身 */
      }
    }
    return session;
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
    this.streams.clear();
    this.optionStreams.clear();
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
      while (waited < BrokerRouter.QUOTE_WAIT_MS) {
        await session.settle(250);
        waited += 250;
        if (ready()) break;
      }
      quotes = legs.map((leg, i) => {
        const t = handles[i]!.read();
        return { action: leg.action, ratio: leg.ratio, bid: finiteQuote(t.bid), ask: finiteQuote(t.ask) };
      });
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

  async indexPrice(symbol: string): Promise<number | null> {
    const cfg = this.settings.indexConfig(symbol);
    let session: IbSession | null = null;
    const dflt = this.settings.defaultAccount();
    if (dflt !== null) {
      try {
        session = await this.forAccount(dflt);
      } catch (exc) {
        if (!(exc instanceof BrokerError)) throw exc;
        session = null;
      }
    }
    if (session === null) {
      const sessions = this.sessions();
      session = sessions[0] ?? null;
    }
    if (session === null) return null;
    const target = cfg ? indexContract(symbol, cfg.exchange) : stockContract(symbol);
    try {
      await this.qualifyOrRaise(session, target);
    } catch (exc) {
      if (exc instanceof BrokerError) return null;
      throw exc;
    }
    // 常驻订阅:第一次要等首笔 tick,之后每次调用都是读缓存(百毫秒内)。
    // 快照是"输入到下单"链路的第一段,不能每单都重新订阅再干等一秒。
    const streamKey = `idx:${symbol}`;
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
    // 没有实时订阅时退到 15 分钟延迟行情。只给方向复核的快照用。
    session.cancelTicker(target);
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

  /** 批量拉股票/ETF 报价;绝不用于订单定价。 */
  async stockQuotes(symbols: string[]): Promise<Record<string, Record<string, number | null>>> {
    const sessions = this.sessions();
    const session = sessions[0] ?? null;
    if (session === null) return {};
    const out: Record<string, Record<string, number | null>> = {};
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

    const startOrd = Date.parse(start + "T00:00:00Z");
    const endOrd = Date.parse(end + "T00:00:00Z");
    const days = Math.round((endOrd - startOrd) / 86_400_000);
    const duration = days <= 360 ? `${days + 5} D` : `${Math.trunc(days / 365) + 1} Y`;
    const todayIso = new Date().toISOString().slice(0, 10);
    const endDt =
      end >= todayIso
        ? ""
        : new Date(endOrd + 86_400_000).toISOString().slice(0, 10).replace(/-/g, "") + " 00:00:00";

    let raw: RawBar[];
    try {
      raw = await session.historicalData(target, {
        endDateTime: endDt,
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
      const crypto = cryptoSymbol(symbol);
      const target = crypto ? cryptoContract(crypto) : stockContract(symbol);
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

  /** 按周期拉 K 线(PA 分析用)。历史数据同样要行情权限;先切延迟再切回实时。 */
  async intradayBars(symbol: string, timeframe: string, rth = false): Promise<Array<Record<string, any>>> {
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
        endDateTime: "",
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
    return {
      symbol,
      expiries,
      strikes,
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

    const grid: number[] = meta["strikes"];
    if (!grid.length) throw new BrokerError(`${symbol} 的行权价网格为空`);
    let nearest = 0;
    for (let i = 1; i < grid.length; i++) {
      if (Math.abs(grid[i]! - spot) < Math.abs(grid[nearest]! - spot)) nearest = i;
    }
    const band = grid.slice(Math.max(0, nearest - width), nearest + width + 1);

    const session = this.marketSession();
    const cfg = this.settings.indexConfig(symbol);
    const tradingClass = meta["trading_classes"][0] ?? "";
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
          session.cancelTicker(contract); // 不撤会一直占着行情线路配额
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
  async orderBook(symbol: string, rows = 10): Promise<Record<string, any>> {
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

    const out: Record<string, any> = { symbol, l1: {}, bids: [], asks: [], note: "" };
    try {
      session.reqMarketDataType(3);
      const ticker = session.subscribeTicker(target);
      await session.settle(1500);
      const t = ticker.read();
      const bid = cleanPrice(t.bid);
      const ask = cleanPrice(t.ask);
      const l1: Record<string, any> = {
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
        session.cancelTicker(target); // 用完即撤,不撤会占行情线路配额
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
    const [y, m, d] = String(day).split("-").map(Number) as [number, number, number];
    const endEpoch = wallToEpoch({ year: y, month: m, day: d, hour: 16, minute: 5, second: 0 }, ET);
    const endUtc = new Date(endEpoch).toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-");
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

  async positions(): Promise<Array<Record<string, any>>> {
    const out = new Map<string, Record<string, any>>();
    const aliasOf = new Map(this.settings.accounts.map((a) => [a.account_id, a.alias]));

    for (const session of this.sessions()) {
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
      let rawPositions: PositionItemLike[] = [];
      try {
        rawPositions = await session.positions();
      } catch {
        rawPositions = [];
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
  ): Record<string, any> | null {
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
    let fresh = false;
    for (const row of legs) {
      const key = `opt:${row["key"]}`;
      if (this.optionStreams.has(key)) continue;
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
    await session.settle(fresh ? 1500 : 50);
    for (const row of legs) {
      const entry = this.optionStreams.get(`opt:${row["key"]}`);
      if (!entry?.handle) continue;
      const t = entry.handle.read();
      const bid = cleanPrice(t.bid);
      const ask = cleanPrice(t.ask);
      if (bid !== null && ask !== null && ask >= bid) row["market_price"] = pyRound((bid + ask) / 2.0, 4);
      else row["market_price"] = cleanPrice(t.last) ?? cleanPrice(t.marketPrice);
    }
  }

  private async fillPositionPrices(rows: Array<Record<string, any>>): Promise<void> {
    const need = rows
      .filter((r) => r["market_price"] === null && r["sec_type"] === "STK")
      .map((r) => r["symbol"] as string);
    if (!need.length) {
      await this.fillOptionPrices(rows);
      return;
    }
    let quotes: Record<string, Record<string, number | null>> = {};
    try {
      quotes = await this.stockQuotes([...new Set(need)].sort());
    } catch (exc) {
      if (!(exc instanceof BrokerError)) throw exc;
    }
    await this.fillOptionPrices(rows);
    for (const row of rows) {
      const quote = quotes[row["symbol"] as string] ?? {};
      if (row["market_price"] === null && row["sec_type"] === "STK") row["market_price"] = quote["last"] ?? null;
    }
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
    const order: OrderIntent = {
      action: item.action,
      orderType: item.order_type,
      totalQuantity: item.quantity,
      lmtPrice: item.lmt_price ?? null,
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
    if (item.lmt_price !== null) entry.order.lmtPrice = item.lmt_price;
    if (item.aux_price !== null) entry.order.auxPrice = item.aux_price;
    if (item.trailing_percent !== null) entry.order.trailingPercent = item.trailing_percent;
    await entry.session.placeOrder(entry.contract, entry.order);
    return true;
  }

  async cancelHosted(orderId: number): Promise<boolean> {
    const entry = this.hostedTrades.get(orderId);
    if (entry === undefined) return false;
    this.hostedTrades.delete(orderId);
    await entry.session.cancelOrder?.(orderId);
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
              tif: "GTC",
              outsideRth: false,
              account: trade.account,
              transmit: true,
              orderRef: trade.orderRef,
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
          lmt_price: trade.lmtPrice,
          aux_price: trade.auxPrice,
          trailing_percent: trade.trailingPercent,
          status: trade.status,
        });
      }
    }
    return rows;
  }
}

// ---------------------------------------------------------------- 合约构造
export function stockContract(symbol: string, exchange = "SMART", currency = "USD"): IbContract {
  return { secType: "STK", symbol, exchange, currency, conId: 0 };
}

export function indexContract(symbol: string, exchange: string): IbContract {
  return { secType: "IND", symbol, exchange, currency: "USD", conId: 0 };
}

/** 加密货币现货(IBKR 走 PAXOS,行情免订阅;2026-09-08 真机实测 BTC 两秒内到价)。 */
export function cryptoContract(symbol: string): IbContract {
  return { secType: "CRYPTO", symbol, exchange: "PAXOS", currency: "USD", conId: 0 };
}

/** 流式报价里的加密标记:`CRYPTO:BTC` → `BTC`;不是这个形状回 null。
 * 宏观带用它把比特币这一格接到 PAXOS 现货上;富途通道见到它直接跳过。 */
export function cryptoSymbol(symbol: string): string | null {
  const m = /^CRYPTO:([A-Z]{2,10})$/.exec((symbol ?? "").trim().toUpperCase());
  return m ? m[1]! : null;
}

export function optionContract(
  symbol: string, expiry: string, strike: number, right: string,
  exchange: string, currency = "USD", multiplier = "100", tradingClass = "",
): IbContract {
  return {
    secType: "OPT", symbol, exchange, currency,
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier, tradingClass, conId: 0,
  };
}

const IB_TZ_ALIASES: Record<string, string> = {
  "US/Eastern": "America/New_York", "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver", "US/Pacific": "America/Los_Angeles",
};

/** IBKR 成交时间字符串 → epoch 毫秒。四种形态:'yyyymmdd hh:mm:ss Zone'、'yyyymmdd  hh:mm:ss'(按美东)、
 * 纯数字(unix 秒)、ISO。解析不了回 null。 */
export function parseIbTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s) && s.length !== 8) return Number(s) * 1000;
  let m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?$/.exec(s);
  if (m) {
    const zone = m[7] ? (IB_TZ_ALIASES[m[7]] ?? m[7]) : ET;
    try {
      return wallToEpoch({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
        hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }, zone);
    } catch {
      return null;
    }
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(s);
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

async function tickerPrice(
  session: IbSession, target: IbContract, waitMs = 1000,
): Promise<number | null> {
  return pollTicker(session, session.subscribeTicker(target), waitMs);
}

function describeContract(contract: IbContract): string {
  const parts = [contract.symbol || "?", contract.secType || "?"];
  for (const attr of ["lastTradeDateOrContractMonth", "strike", "right", "tradingClass"] as const) {
    const value = contract[attr];
    if (value) parts.push(String(value));
  }
  return parts.join(" ");
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
