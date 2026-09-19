/** IB 会话适配层的类型(对应 @stoqey/ib 的那一层的抽象)。
 *
 * 只有类型,没有实现:BrokerRouter 按这些接口调,ibSession.ts 按这些接口实现,
 * 测试用替身也照这份。放在单独文件是为了两边都能 import 它而不互相 import。
 */
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
  /** 订阅被 TWS 拒掉时的错误码与原文(如 10197 实盘会话占着实时行情)。有它就说明这条流已经死了。 */
  error?: string | null;
  // 以下只有异动监控订的那条流(generic "165,104,595")才有;只用于研究与提醒,绝不进订单定价
  open?: number | null;
  high?: number | null;
  low?: number | null;
  /** 当日累计量(流里的口径,不能和历史 K 线的量混比) */
  volume?: number | null;
  /** 同一条流的 90 日日均量(tick 21) */
  avgVolume?: number | null;
  /** 30 日历史波动率,小数(tick 23) */
  histVol?: number | null;
  /** 近 3 / 5 / 10 分钟成交量(tick 63 / 64 / 65) */
  vol3m?: number | null;
  vol5m?: number | null;
  vol10m?: number | null;
  /** 最后成交时间(秒,tick 45 / 88) */
  lastTradeAt?: number | null;
  /** LAST 取自 DELAYED_LAST(延迟行情) */
  delayed?: boolean;
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
  /** 会话的行情类型基线:之后的 reqMarketDataType(1)("切回实时")都回到它。
   * 只服务纸面账户的会话设成 3——见 BrokerRouter.connect。 */
  setBaselineMarketDataType?(type: number): void;
  /** 订阅并保留;返回句柄按需读当前值。同一合约带不同 generic ticks 是不同的流。 */
  subscribeTicker(contract: IbContract, genericTicks?: string): TickerHandle;
  /** 传 genericTicks 只撤那一条流;不传撤这个合约的所有变体(期权链那处靠它不漏撤)。 */
  cancelTicker(contract: IbContract, genericTicks?: string): void;
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
  cancelOrder(orderId: number): void | Promise<void>;
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
    ocaGroup?: string;
    ocaType?: number | null;
    tif?: string;
    outsideRth?: boolean;
  }>>;
  portfolio(): Promise<PortfolioItemLike[]>;
  positions(): Promise<PositionItemLike[]>;
  /** 当天逐笔成交(reqExecutions)。真机适配层实现;测试替身可不实现。 */
  executions?(): Promise<Array<{ contract: Record<string, any>; execution: Record<string, any> }>>;
  /** 连接级事件(1100/1101/1102)回调。 */
  onConnectivity(cb: (code: number) => void): void;
  /** engine 挂订单回报监听用(推式)。 */
  onOrderStatus?(cb: (trade: any) => void): void;
  /** fill.live === false:reqExecutions 补回来的成交,不是实时推送(引擎只落库不通知)。 */
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
