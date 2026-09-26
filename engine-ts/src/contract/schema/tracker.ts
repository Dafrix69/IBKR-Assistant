/** tracker.* 的入参 schema。**这个域是 strict 的**:不认识的键当场拒。
 *
 * 别的域用 zod 默认的"不认识的键丢掉"没有问题;这里不行——tracker.add / update 是在授权软件自动发单,
 * 键名写错一个字母(stoploss)、或者 schema 漏列一个键,默认行为是追踪照建、那道保护悄悄没设上,用户以为设上了。
 * 所以宁可当场报错。数值字段照界面的实际载荷来:字符串与数字都认,'' / null / 不给 = 不设(见 contract/tracker.ts 的
 * NumberField);"是不是一个数、方向对不对、范围对不对"是领域校验,在 handler 与 tracker.ts,报它们自己那句人话。
 * tests/tracker-rpc.spec.ts 拿界面的原样载荷钉着这一段,改这里的时候它不许改一个断言。
 */
import { z } from "zod";

import type {
  TrackerAddParams, TrackerDeleteParams, TrackerTargetPreviewParams, TrackerUpdateParams,
} from "../tracker.js";
import type { TrackerCloseNowParams } from "../trackerloop.js";
import { optional, requiredButReportedByHandler } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

/** 表单里的一个数:数字或字符串,原样交给 handler 的 optFloat('' → 不设,"abc" → 「不是有效数字」)。 */
const numberField = optional(z.union([z.number(), z.string()]));

const targetsInput = {
  take_profit: numberField,
  stop_loss: numberField,
  trail_pct: numberField,
  profit_drawdown_pct: numberField,
  profit_drawdown_preset: optional(z.string()),
  profit_drawdown_tiers: optional(z.union([
    z.literal(""),
    z.array(z.object({ above: z.union([z.number(), z.string(), z.null()]), pct: z.union([z.number(), z.string(), z.null()]) }).strict()),
  ])),
  profit_drawdown_late: optional(z.object({ after: z.string(), factor: numberField }).strict()),
  profit_drawdown_arm_pct: numberField,
  spot_target: numberField,
};

export const TrackerAddParamsSchema: ParamsSchema<TrackerAddParams> = z.object({
  key: z.string(),
  ...targetsInput,
  // 授权发单的两个开关只收布尔:Boolean("false") 是 true,这种值不能靠"真假"糊过去
  auto_close: optional(z.boolean()),
  order_type: optional(z.string()),
  slippage_pct: numberField,
  close_fraction_pct: numberField,
  host_at_broker: optional(z.boolean()),
  chase_max_pct: numberField,
  note: optional(z.string()),
}).strict();

export const TrackerUpdateParamsSchema: ParamsSchema<TrackerUpdateParams> = z.object({
  id: z.string(),
  enabled: optional(z.boolean()),
  auto_close: optional(z.object({
    enabled: z.boolean(),
    order_type: z.string(),
    slippage_pct: z.number(),
    close_fraction_pct: z.number(),
    host_at_broker: z.boolean(),
    chase_max_pct: z.number(),
  }).partial().strict()),
  ...targetsInput,
}).strict();

export const TrackerDeleteParamsSchema: ParamsSchema<TrackerDeleteParams> = z.object({
  id: z.string(),
}).strict();

export const TrackerTargetPreviewParamsSchema: ParamsSchema<TrackerTargetPreviewParams> = z.object({
  key: z.string(),
  spot_target: numberField,
  chase_max_pct: numberField,
}).strict();

/** 手动平仓:直接发一张平仓单,所以顶层 strict——不认识的键当场拒,不静默丢。
 *  老 handler 是 String(params["id"] ?? ""),不给 id 由它自己报「没有这个追踪」,
 *  所以这里收成必填但不替它报(缺了也走到 handler,由那句人话拒)。 */
export const TrackerCloseNowParamsSchema: ParamsSchema<TrackerCloseNowParams> = z.object({
  id: requiredButReportedByHandler(),
}).strict();
