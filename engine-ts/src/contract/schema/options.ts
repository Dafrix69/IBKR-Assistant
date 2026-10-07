/** options.* 的入参 schema。代码形状、数值范围是领域校验,在 handler 与 flyPlan。 */
import { z } from "zod";

import type { FlyPlanParams, IvRecorderSetParams, OptionsSpotParams, OptionsWallParams } from "../options.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const OptionsWallParamsSchema: ParamsSchema<OptionsWallParams> = z.object({
  symbol: z.string(),
  expiry: optional(z.string()),
  // 老 handler 是 Math.trunc(Number(width ?? 10)):数字串也认
  width: optional(z.union([z.number(), z.string()])),
});

// 新方法,数值一律是数字(界面自己把输入框里的字符串转好)。strict:键名写错了(iv_shift 少了 _pct)当场拒,
// 不然就是"IV 变化没设上,结果看着还挺正常"。
export const FlyPlanParamsSchema: ParamsSchema<FlyPlanParams> = z.object({
  symbol: optional(z.string()),
  expiry: optional(z.string()),
  center: z.number(),
  width: z.number(),
  right: optional(z.string()),
  quantity: optional(z.number()),
  cost: optional(z.number()),
  target_spot: z.number(),
  target_time: z.string(),
  target_date: optional(z.string()),
  spot: optional(z.number()),
  iv: optional(z.number()),
  iv_mode: optional(z.enum(["auto", "flat", "shift"])),
  iv_shift_pct: optional(z.number()),
}).strict();

export const IvRecorderSetParamsSchema: ParamsSchema<IvRecorderSetParams> = z.object({
  enabled: z.boolean(),
}).strict();

export const OptionsSpotParamsSchema: ParamsSchema<OptionsSpotParams> = z.object({
  symbol: optional(z.string()),
}).strict();
