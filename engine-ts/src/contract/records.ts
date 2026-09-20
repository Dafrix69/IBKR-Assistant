/** records.* 与 pending.*:交易记录、以及排队等待触发的条件单。
 *
 * 两条路给的形状**不一样**,别混:
 *   · `records.list` 给**摘要**(20 项,值是从嵌套结构里摘出来的),记录页与订单看板读它;
 *   · `records.get` 给**整条记录**(嵌套结构原样),详情面板读它。
 * 两条路都只给打码后的账号:`account_id` 换成 `account_masked`,原字段不出现。
 */

/** 记录页那张表的一行。这 20 项是列表接口的全部——要别的字段得走 records.get。 */
export interface TradeRecordSummary {
  id: string | null;
  created_at: string | null;
  intent_summary: string;
  raw_instruction: string;
  reason: string;
  symbol: string;
  secType: string;
  action: string;
  quantity: number | null;
  /** 账户别名,不是账号 */
  account: string;
  /** 打码后的账号(前二后三) */
  account_masked: string;
  is_paper: boolean | null;
  execution_type: string | null;
  final_status: string | null;
  /** 时间线上最后一条的状态;还没有回报时 null */
  status: string | null;
  avg_fill_price: number | null;
  total_commission: number | null;
  confidence: number | null;
  rejection: unknown;
  notional_estimate: number | null;
}

/** 下单那一刻大模型给出的那一份。 */
export interface RecordLlm {
  model?: string;
  prompt_version?: string;
  prompt_fingerprint?: string;
  intent_summary?: string;
  confidence?: number | null;
  warnings?: unknown[];
  raw_response?: string;
  usage?: Record<string, unknown>;
}

export interface RecordInput {
  raw_instruction?: string;
  reason?: string;
  input_channel?: string;
}

/** 记录里的账户块:转出去的那一份**没有** account_id。 */
export interface RecordAccount {
  alias?: string;
  account_masked?: string;
  is_paper?: boolean;
  [extra: string]: unknown;
}

export interface RecordStatusEvent {
  status: string | null;
  at: string;
}

export interface RecordFill {
  exec_id?: string;
  time?: string;
  price?: number;
  qty?: number;
  commission?: number;
  sec_type?: string | null;
  con_id?: number | null;
}

export interface RecordCommission {
  exec_id?: string;
  commission?: number;
  realized_pnl?: number | null;
  at?: string;
}

/** 券商那一面:回报折进来之后的样子(见 store.foldEvents)。 */
export interface RecordIbkr {
  order_id?: number | null;
  perm_id?: number | null;
  status_timeline: RecordStatusEvent[];
  fills: RecordFill[];
  /** 组合单只认 BAG 行;认不出就空着,不拿腿价混出一个错数 */
  avg_fill_price?: number | null;
  total_commission?: number | null;
  realized_pnl?: number | null;
  [extra: string]: unknown;
}

/**
 * 整条交易记录。字段大多可选:同一张表装着五条路各自的产物(校验就停下的、被拒的、
 * 排队等触发的、发出去的、已成交的),不是每条路都填满。
 * 索引签名留着是**如实**:记录是库里的一团 JSON,往后加字段不必先改契约(界面读新字段仍要先在这里登记)。
 */
export interface TradeRecord {
  id?: string;
  created_at?: string;
  input?: RecordInput;
  llm?: RecordLlm;
  account?: RecordAccount;
  contract?: Record<string, unknown>;
  order?: Record<string, unknown>;
  ibkr?: RecordIbkr;
  execution_type?: string | null;
  /** 条件单的触发条件;立即单是 null */
  trigger?: Record<string, unknown> | null;
  triggered_at?: string | null;
  trigger_snapshot?: Record<string, unknown>;
  final_status?: string | null;
  error_detail?: string | null;
  /** 发出去之后才来的那些警告(IBKR 399 之类) */
  post_warnings?: Array<Record<string, unknown>>;
  commissions?: RecordCommission[];
  rejection?: unknown;
  notional_estimate?: number | null;
  signature?: string;
  [extra: string]: unknown;
}

export interface RecordsListParams {
  /** 不给就是 30。数字串照收(界面上是从输入框来的) */
  limit?: number | string;
}

export interface RecordsGetParams {
  /** 不给和对不上说同一句:「记录不存在」 */
  id?: string;
}

/** 排队等待触发的一张条件单(界面只拿到这七项,真账号不在其中)。 */
export interface PendingItem {
  record_id: string;
  intent_summary: string;
  symbol: string;
  operator: string;
  value: number | string;
  /** 账户别名 */
  account: string;
  created_at: string;
}

/**
 * 盯一轮的回执。**盯盘是界面驱动的**:引擎侧没有自己的定时器,`pending.poll` 是
 * firePending / expirePending / syncBrokerOrders 的唯一入口——不发这条,条件单永远不触发、
 * 当日不过期、已提交的单也不会回写成交状态。
 */
export interface PendingPollResult {
  /** 这一轮真发出去的那几张 */
  fired: Array<Record<string, unknown>>;
  /** 这一轮问到的价:每个标的只问一次,问不到的不进来 */
  prices: Record<string, number>;
  /** 收盘后清掉的当日未触发单数。没连券商 / 队列为空的那条早退路径上没有这个字段 */
  expired?: number;
  /** 顺手同步券商回报的结果(富途没有事件流,靠这一口气) */
  synced: unknown;
}
