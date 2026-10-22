/** instruction.submit:一句话 → 解析 → 校验 → (可选)发单。交易页那一整条路。
 *
 * 回执按**四个桶**分:发出去的、排队等触发的、只过了校验没发的、被拒的。一条指令可以同时落进几个桶
 * (勾了两个账户就是两份,一个成一个被拒是常事),所以四个都是数组,别写成"要么成功要么失败"。
 */

/** 订单票据:界面画订单与到期损益图用的结构化摘要。**只读展示,不回流到任何决策。** */
export interface OrderTicket {
  sec_type: string;
  symbol: string;
  action: string;
  quantity: number;
  order_type: string;
  /** 限价是怎么定的:用户给的 / 自动中间价 / … */
  price_mode?: string | null;
  limit_price: number | null;
  aux_price: number | null;
  trailing_percent: number | null;
  tif: string | null;
  /** 到期日;正股是 null。组合取第一条腿的 */
  expiry: string | null;
  strike: number | null;
  right: string | null;
  multiplier: number | null;
  /** butterfly / vertical / …;不是组合就是 null */
  combo_strategy: string | null;
  legs: OrderTicketLeg[];
  /** 条件单的触发条件;立即单是 null */
  trigger: OrderTrigger | null;
  [extra: string]: unknown;
}

export interface OrderTicketLeg {
  action: string;
  ratio: number;
  strike: number | null;
  right: string | null;
}

export interface OrderTrigger {
  symbol: string;
  operator: string;
  value: number;
}

/** 一笔订单的回执。`order_id` 那几样只有真发出去(或真排上队)的那条才有。 */
export interface InstructionOrder {
  record_id: string;
  intent_summary: string;
  /** 账户**别名**,不是账号 */
  account: string;
  /** 名义金额 */
  notional: number;
  ticket: OrderTicket;
  /** 排队等触发(没真发出去) */
  queued?: boolean;
  /** software_watch = 软件盯盘;ibkr_condition = 券商原生条件单;immediate = 立即单 */
  mode?: string;
  order_id?: number | null;
  status?: string | null;
  [extra: string]: unknown;
}

/**
 * 被拒的一条。`source` 说明是谁拒的,这决定了界面该怎么劝用户:
 * llm = 模型看不懂;validator = 软件层硬校验(超限、方向不对);engine = 熔断 / 载荷坏了;broker = 券商拒单。
 */
export interface InstructionRejection {
  source: string;
  code: string;
  message: string;
  /** 模型拒的那条带上原话 */
  original_text?: string;
  /** 校验拒的那条带上它读懂了什么 */
  intent_summary?: string;
  /** 已经落了库的那条带上记录 id */
  record_id?: string;
  [extra: string]: unknown;
}

/** 这一次调用的模型用量。走速记(本地解析)时是 null——一个 token 都没花。 */
export interface InstructionLlm {
  model: string;
  prompt_version: string;
  prompt_fingerprint: string;
  latency_ms: number | null;
  usage: Record<string, unknown>;
}

export interface InstructionSubmitParams {
  text: string;
  /** 真发单 = true;只解析只校验 = false / 不给。
   *  自动执行没打开、或没连券商时给 true 会被拒,不会偷偷降级成"只校验" */
  execute?: boolean;
  /** 勾选的目标账户别名;勾两个就同时向两个账户发单。不给 = 按配置里的默认账户 */
  accounts?: string[];
  /** 这条指令从哪来的(manual / …);不给是 manual */
  channel?: string;
}

export interface InstructionSubmitResult {
  /** 真发出去了的 */
  submitted: InstructionOrder[];
  /** 排队等触发的 */
  queued: InstructionOrder[];
  /** 过了校验但没发的(只解析,或"允许自动执行"没开) */
  validated_only: InstructionOrder[];
  rejections: InstructionRejection[];
  warnings: string[];
  /** 速记走本地解析时是 null */
  llm: InstructionLlm | null;
  /** 这次调用是不是真发单了(= 入参的 execute) */
  executed: boolean;
}
