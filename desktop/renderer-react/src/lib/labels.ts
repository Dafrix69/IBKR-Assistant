/**
 * 内部枚举 → 人话。只在渲染这一层翻译:终态在库里是英文枚举(append-only 的既有词表,不动它),
 * 直接摆给用户看既不好读、又带着券商名——富途用户看到 ibkr_error 会以为软件连错了地方。
 * 查不到就原样显示:露一个英文,好过编一个错的中文。
 */

export const FINAL_STATUS_LABEL: Record<string, string> = {
  filled: '已成交',
  partially_filled: '部分成交',
  cancelled: '已撤单',
  expired_untriggered: '当日未触发',
  rejected_by_validator: '校验拒绝',
  rejected_by_llm: '模型拒绝',
  ibkr_error: '券商报错',
  halted_by_breaker: '熔断拦下',
};

// 在途状态来自券商,是英文枚举(Submitted / PreSubmitted / …)。终态翻了、在途没翻的话,
// 同一列里会中英夹杂——而这一列恰恰是最常扫的一列。
export const LIVE_STATUS_LABEL: Record<string, string> = {
  // 引擎写的,不是券商的:只解析 / 自动执行没开时通过了校验,但这笔单从没发出去
  ValidatedOnly: '仅校验未发送',
  PendingSubmit: '待发送',
  PreSubmitted: '已受理',
  Submitted: '已挂单',
  ApiPending: '发送中',
  PendingCancel: '撤单中',
  Filled: '已成交',
  Cancelled: '已撤单',
  ApiCancelled: '已撤单',
  Inactive: '券商报错',
  Unknown: '状态未知',
  // 引擎写的：对账时券商侧既没有这张单、也查不到它的成交（见 engine.reconcileOrders）
  NotAtBroker: '券商侧查无此单',
};

export const SEC_TYPE_LABEL: Record<string, string> = { STK: '股票', OPT: '期权', BAG: '组合(多腿)', IND: '指数' };
export const ACTION_LABEL: Record<string, string> = { BUY: '买入', SELL: '卖出' };
export const TRIGGER_OP_LABEL: Record<string, string> = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '==': '=' };
export const ORDER_TYPE_LABEL: Record<string, string> = {
  MKT: '市价单',
  LMT: '限价单',
  STP: '止损单',
  'STP LMT': '止损限价单',
  TRAIL: '跟踪止损单',
};
export const PRICE_MODE_LABEL: Record<string, string> = { EXPLICIT: '指定价格', AUTO_MID: '盘口中间价(AUTO_MID)' };
export const TIF_LABEL: Record<string, string> = { DAY: '当日有效', GTC: '撤销前有效' };
export const COMBO_LABEL: Record<string, string> = { VERTICAL: '垂直价差', BUTTERFLY: '蝴蝶', IRON_CONDOR: '铁鹰' };

export function say(map: Record<string, string>, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return map[String(value)] || String(value);
}

export interface StatusLike {
  final_status?: string | null;
  status?: string | null;
}

export function statusLabel(record: StatusLike, fallback: string): string {
  if (record.final_status) return FINAL_STATUS_LABEL[record.final_status] || record.final_status;
  if (record.status) return LIVE_STATUS_LABEL[record.status] || record.status;
  return fallback;
}

/** 状态词的着色档:成了 / 没发出去 / 还在路上。文字着色一律用 *-text 变体(见 styles.css)。 */
export function statusTone(record: StatusLike): 'filled' | 'rejected' | 'pending' {
  const f = String(record.final_status || '');
  if (f === 'filled') return 'filled';
  if (f.startsWith('rejected')) return 'rejected';
  return 'pending';
}
