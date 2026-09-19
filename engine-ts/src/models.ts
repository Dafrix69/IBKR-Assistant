/** 解析结果的严格 schema(对应 Python models.py,pydantic → zod)。
 *
 * 原则不变:LLM 的输出永远是不可信输入。多余字段直接失败(strict),
 * 单条坏订单降级成拒绝,不牵连其他订单。语义/算术复核在 validator.ts。
 */
import { z } from "zod";

import { isValidYmd } from "./tz.js";

export const SEC_TYPES = ["STK", "OPT", "BAG"] as const;
export const RIGHTS = ["C", "P"] as const;
export const ACTIONS = ["BUY", "SELL"] as const;
export const ORDER_TYPES = ["LMT", "MKT", "STP", "STP LMT", "TRAIL"] as const;
export const PRICE_MODES = ["EXPLICIT", "AUTO_MID"] as const;
export const TIFS = ["DAY", "GTC"] as const;
export const EXECUTION_TYPES = ["IMMEDIATE", "CONDITIONAL"] as const;
export const TRIGGER_SEC_TYPES = ["IND", "STK"] as const;
export const OPERATORS = [">=", "<="] as const;

export const REJECTION_CODES = [
  "MISSING_QUANTITY", "MISSING_PRICE", "AMBIGUOUS_SYMBOL", "INCOMPLETE_OPTION",
  "AMBIGUOUS_TRIGGER", "UNKNOWN_ACCOUNT", "EXCEEDS_LIMIT", "UNSUPPORTED", "UNCLEAR",
] as const;

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,11}$/;

// pydantic 的宽松数值:float 字段接受数字与数字字符串;int 字段接受整数值
// 的 float 与整数字符串,拒绝 100.5。
const looseFloat = z.preprocess((v) => {
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v.trim()))) {
    return Number(v.trim());
  }
  return v;
}, z.number().finite());

const looseInt = z.preprocess((v) => {
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  return v;
}, z.number().int());

function checkExpiry(value: string, ctx: z.RefinementCtx): void {
  if (!/^\d{8}$/.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "到期日必须是 YYYYMMDD 8 位数字" });
    return;
  }
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(4, 6));
  const d = Number(value.slice(6, 8));
  if (!isValidYmd(y, m, d)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `到期日不是合法日期: ${value}` });
  }
}

function makeSymbolField(describe: (v: string) => string) {
  return z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .superRefine((v, ctx) => {
      if (!SYMBOL_RE.test(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: describe(v) });
      }
    });
}

const symbolField = makeSymbolField((v) => `标的代码必须是大写字母/数字组成的 ticker: '${v}'`);

const expiryField = z.string().trim().superRefine(checkExpiry);

export const LegSchema = z
  .object({
    action: z.enum(ACTIONS),
    ratio: looseInt.pipe(z.number().min(1).max(2)),
    lastTradeDateOrContractMonth: expiryField,
    strike: looseFloat.pipe(z.number().gt(0)),
    right: z.enum(RIGHTS),
    tradingClass: z.string().trim().nullable().default(null),
    multiplier: z.string().trim().default("100"),
  })
  .strict();
export type Leg = z.infer<typeof LegSchema>;

export const ContractSpecSchema = z
  .object({
    secType: z.enum(SEC_TYPES),
    symbol: symbolField,
    exchange: z.string().trim().default("SMART"),
    currency: z.literal("USD").default("USD"),
    lastTradeDateOrContractMonth: expiryField.nullable().default(null),
    strike: looseFloat.pipe(z.number().gt(0)).nullable().default(null),
    right: z.enum(RIGHTS).nullable().default(null),
    multiplier: z.string().trim().default("100"),
    tradingClass: z.string().trim().nullable().default(null),
    combo_strategy: z.enum(["VERTICAL", "BUTTERFLY", "IRON_CONDOR"]).nullable().default(null),
    legs: z.array(LegSchema).nullable().default(null),
  })
  .strict()
  .superRefine((c, ctx) => {
    const optFields = [c.lastTradeDateOrContractMonth, c.strike, c.right];
    if (c.secType === "STK") {
      if (optFields.some((f) => f !== null) || (c.legs && c.legs.length) || c.combo_strategy) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "STK 合约不得携带期权/组合字段" });
      }
    } else if (c.secType === "OPT") {
      if (optFields.some((f) => f === null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "期权四要素缺失(到期日/行权价/Call-Put)" });
      }
      if ((c.legs && c.legs.length) || c.combo_strategy) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "单腿期权不得携带 legs/combo_strategy" });
      }
    } else {
      if (optFields.some((f) => f !== null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "BAG 合约的期权要素必须写在 legs 里" });
      }
      const expected = ({ VERTICAL: 2, BUTTERFLY: 3, IRON_CONDOR: 4 } as Record<string, number>)[
        c.combo_strategy ?? ""
      ];
      if (expected === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "combo_strategy 仅支持 VERTICAL / BUTTERFLY / IRON_CONDOR",
        });
      } else if (!c.legs || c.legs.length !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${c.combo_strategy} 必须正好 ${expected} 条腿`,
        });
      }
    }
  });
export type ContractSpec = z.infer<typeof ContractSpecSchema>;

export function multiplierValue(contract: { multiplier: string }): number {
  const v = Number(contract.multiplier);
  return Number.isFinite(v) ? v : 100.0;
}

export const TriggerSpecSchema = z
  .object({
    type: z.literal("PRICE").default("PRICE"),
    symbol: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .superRefine((v, ctx) => {
        if (!SYMBOL_RE.test(v)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `触发标的必须是 ticker: '${v}'` });
        }
      }),
    secType: z.enum(TRIGGER_SEC_TYPES),
    operator: z.enum(OPERATORS),
    value: looseFloat.pipe(z.number().gt(0)),
  })
  .strict();
export type TriggerSpec = z.infer<typeof TriggerSpecSchema>;

export const OrderSpecSchema = z
  .object({
    action: z.enum(ACTIONS),
    orderType: z.enum(ORDER_TYPES),
    totalQuantity: looseInt.pipe(z.number().gt(0)),
    price_mode: z.enum(PRICE_MODES).default("EXPLICIT"),
    lmtPrice: looseFloat.pipe(z.number().gt(0)).nullable().default(null),
    auxPrice: looseFloat.pipe(z.number().gt(0)).nullable().default(null),
    trailingPercent: looseFloat.pipe(z.number().gt(0).max(100)).nullable().default(null),
    tif: z.enum(TIFS).default("DAY"),
    outsideRth: z.boolean().default(false),
  })
  .strict()
  .superRefine((o, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const t = o.orderType;
    if (t === "MKT") {
      if (o.lmtPrice !== null) bad("市价单不得带 lmtPrice");
    } else if (t === "LMT") {
      if (o.price_mode === "EXPLICIT" && o.lmtPrice === null) bad("限价单缺少 lmtPrice(铁律 3)");
      if (o.price_mode === "AUTO_MID" && o.lmtPrice !== null) bad("AUTO_MID 时 lmtPrice 必须为 null");
    } else if (t === "STP") {
      if (o.auxPrice === null) bad("止损单缺少 auxPrice 触发价");
      if (o.lmtPrice !== null) bad("STP 不得带 lmtPrice,需要限价请用 STP LMT");
    } else if (t === "STP LMT") {
      if (o.auxPrice === null || o.lmtPrice === null) bad("STP LMT 需要同时给出 auxPrice 与 lmtPrice");
    } else if (t === "TRAIL") {
      const hasAux = o.auxPrice !== null;
      const hasPct = o.trailingPercent !== null;
      if (hasAux === hasPct) bad("TRAIL 必须且只能给 auxPrice 或 trailingPercent 其一");
    }
    if (o.price_mode === "AUTO_MID" && t !== "LMT") bad("AUTO_MID 只适用于 LMT");
    if (o.trailingPercent !== null && t !== "TRAIL") bad("trailingPercent 只适用于 TRAIL");
  });
export type OrderSpec = z.infer<typeof OrderSpecSchema>;

export const ParsedOrderSchema = z
  .object({
    intent_summary: z.string().trim().min(1),
    contract: ContractSpecSchema,
    execution_type: z.enum(EXECUTION_TYPES),
    trigger: TriggerSpecSchema.nullable().default(null),
    account: z.string().trim().default("DEFAULT"),
    order: OrderSpecSchema,
    reason: z.string().trim().default(""),
    confidence: looseFloat.pipe(z.number().min(0).max(1)),
    warnings: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((o, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // §2 铁律 7b:execution_type 与 trigger 必须一致
    if (o.execution_type === "CONDITIONAL" && o.trigger === null) bad("CONDITIONAL 订单缺少 trigger");
    if (o.execution_type === "IMMEDIATE" && o.trigger !== null) bad("IMMEDIATE 订单不得带 trigger");
    // §2 铁律 3:AUTO_MID 只有期权组合可用
    if (o.order.price_mode === "AUTO_MID" && o.contract.secType !== "BAG") {
      bad("AUTO_MID 仅适用于期权组合(BAG),单腿期权与股票缺价必须拒绝");
    }
    if (!o.account.trim()) bad("account 不得为空,未指定时应为 DEFAULT");
  });
export type ParsedOrder = z.infer<typeof ParsedOrderSchema>;

export function isOptionLike(order: ParsedOrder): boolean {
  return order.contract.secType === "OPT" || order.contract.secType === "BAG";
}

export const RejectionSchema = z
  .object({
    original_text: z.string().trim(),
    code: z.enum(REJECTION_CODES),
    message: z.string().trim(),
  })
  .strict();
export type Rejection = z.infer<typeof RejectionSchema>;

export const MAX_TAG_LEN = 12; // 业务标签最长(界面上要塞进一个小胶囊)

export const StockPickSchema = z
  .object({
    symbol: makeSymbolField((v) => `选股结果里的标的不合法: '${v}'`),
    company: z.string().trim().default(""),
    reason: z.string().trim().default(""),
    // 业务标签(如"芯片""数据中心"):RS 强度按它汇总强弱
    tag: z.string().default("").transform((v) => v.trim().slice(0, MAX_TAG_LEN)),
  })
  .strict();

export const SectorPicksSchema = z
  .object({ stocks: z.array(StockPickSchema).min(1).max(15) })
  .strict();

export const RULE_INDICATORS = [
  "close", "open", "high", "low", "sma", "ema", "rsi", "highest", "lowest", "change_pct",
  "macd_hist",
] as const;
export const RULE_OPS = [">", "<", ">=", "<=", "cross_up", "cross_down"] as const;
const NEEDS_PERIOD = new Set(["sma", "ema", "rsi", "highest", "lowest", "change_pct"]);

export const RuleOperandSchema = z
  .object({
    kind: z.enum(["indicator", "const"]),
    name: z.enum(RULE_INDICATORS).nullable().default(null),
    period: looseInt.pipe(z.number().min(1).max(250)).nullable().default(null),
    value: looseFloat.nullable().default(null),
  })
  .strict()
  .superRefine((o, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (o.kind === "indicator") {
      if (!o.name) bad("指标操作数缺少 name");
      else if (NEEDS_PERIOD.has(o.name) && !o.period) bad(`指标 ${o.name} 需要 period`);
    } else if (o.value === null) {
      bad("常数操作数缺少 value");
    }
  });

export const RuleConditionSchema = z
  .object({ left: RuleOperandSchema, op: z.enum(RULE_OPS), right: RuleOperandSchema })
  .strict();

export const CustomRulesSchema = z
  .object({
    entry: z.array(RuleConditionSchema).min(1).max(6),
    exit: z.array(RuleConditionSchema).max(6).default([]),
  })
  .strict();

export const BacktestInstrumentSchema = z
  .object({
    type: z.enum(["stock", "call", "put", "call_spread", "put_spread", "butterfly"]).default("stock"),
    dte: looseInt.pipe(z.number().min(1).max(365)).default(30),
    offset_pct: looseFloat.pipe(z.number().min(-30).max(30)).default(0.0),
    width_pct: looseFloat.pipe(z.number().gt(0).max(20)).default(2.0),
    risk_pct: looseFloat.pipe(z.number().gt(0).max(100)).default(10.0),
  })
  .strict();

export const IdeaAnalysisSchema = z
  .object({
    summary: z.string().trim().min(1),
    thesis: z.string().trim().default(""),
    checks: z.array(z.string()).max(8).default([]),
    risks: z.array(z.string()).max(8).default([]),
    suggestion: z.string().trim().default(""),
  })
  .strict();

export const IdeaDigestSchema = z
  .object({
    summary: z.string().trim().min(1),
    themes: z.array(z.string()).max(8).default([]),
    lessons: z.array(z.string()).max(10).default([]),
    patterns: z.array(z.string()).max(8).default([]),
    actions: z.array(z.string()).max(6).default([]),
  })
  .strict();

export const PACommentSchema = z
  .object({
    summary: z.string().trim().min(1),
    reading: z.string().trim().default(""),
    watch: z.array(z.string()).max(6).default([]),
    risks: z.array(z.string()).max(6).default([]),
  })
  .strict();

export const ParseResultSchema = z
  .object({
    orders: z.array(ParsedOrderSchema).default([]),
    rejections: z.array(RejectionSchema).default([]),
  })
  .strict();

export interface LenientParseResult {
  orders: ParsedOrder[];
  rejections: Rejection[];
  schema_errors: string[];
}

/** 把 LLM 原始 dict 解析成结果对象。单条订单的结构错误降级成拒绝,不牵连其他订单。 */
export function parseLlmPayload(payload: unknown): LenientParseResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("LLM 输出不是 JSON 对象");
  }
  const raw = payload as Record<string, unknown>;
  const orders: ParsedOrder[] = [];
  const rejections: Rejection[] = [];
  const schemaErrors: string[] = [];

  const rawOrders = raw["orders"] ?? [];
  if (!Array.isArray(rawOrders)) throw new TypeError("orders 字段不是数组");
  rawOrders.forEach((item, idx) => {
    const parsed = ParsedOrderSchema.safeParse(item);
    if (parsed.success) {
      orders.push(parsed.data);
    } else {
      const detail = briefZodError(parsed.error);
      schemaErrors.push(`orders[${idx}]: ${detail}`);
      rejections.push({
        original_text: excerpt(item),
        code: "UNCLEAR",
        message:
          `解析结果未通过软件层结构校验,已拦截(orders[${idx}]):${detail}。` +
          "请把指令写得更明确后重试。",
      });
    }
  });

  const rawRejections = raw["rejections"] ?? [];
  if (!Array.isArray(rawRejections)) throw new TypeError("rejections 字段不是数组");
  rawRejections.forEach((item, idx) => {
    const parsed = RejectionSchema.safeParse(item);
    if (parsed.success) {
      rejections.push(parsed.data);
    } else {
      schemaErrors.push(`rejections[${idx}]: ${briefZodError(parsed.error)}`);
      rejections.push({
        original_text: excerpt(item),
        code: "UNCLEAR",
        message: "模型给出的拒绝条目本身格式不合法,已按拒绝处理。",
      });
    }
  });

  const unknownTop = Object.keys(raw)
    .filter((k) => k !== "orders" && k !== "rejections")
    .sort();
  if (unknownTop.length) {
    schemaErrors.push(`顶层多余字段已忽略: ${unknownTop.join(", ")}`);
  }
  return { orders, rejections, schema_errors: schemaErrors };
}

function briefZodError(error: z.ZodError): string {
  const text = error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ")
    .replace(/\n/g, " ");
  return text.slice(0, 300);
}

function excerpt(item: unknown): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const rec = item as Record<string, unknown>;
    for (const key of ["intent_summary", "original_text", "symbol"]) {
      const v = rec[key];
      if (typeof v === "string" && v) return v.slice(0, 200);
    }
  }
  try {
    return JSON.stringify(item).slice(0, 200);
  } catch {
    return String(item).slice(0, 200);
  }
}

/** 重复单防抖看的"最近一笔"(store 存、validator 查)。 */
export interface RecentOrder {
  signature: string;
  quantity: number;
  createdAtMs: number;
}
