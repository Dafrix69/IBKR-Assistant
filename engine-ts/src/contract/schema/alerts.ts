/** alerts.* 的入参 schema。代码形状、步长范围是领域校验,在 handler 与 store。 */
import { z } from "zod";

import type {
  AlertsCreateParams, AlertsDeleteParams, AlertsRefreshParams, AlertsSetTouchConfigParams,
} from "../alerts.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const AlertsCreateParamsSchema: ParamsSchema<AlertsCreateParams> = z.object({
  symbol: z.string(),
  // 老 handler 是 Number(step) || 5:数字串也认,所以这里不写死 z.number()
  step: optional(z.union([z.number(), z.string()])),
});

export const AlertsDeleteParamsSchema: ParamsSchema<AlertsDeleteParams> = z.object({
  id: z.string(),
});

export const AlertsRefreshParamsSchema: ParamsSchema<AlertsRefreshParams> = z.object({
  id: z.string(),
  expiry: optional(z.string()),
});

/**
 * config 只要求"是个对象":哪几项、各自的范围由 normalizeTouchConfig 校验并给中文原因
 * (「10 个交易日里最多只能分出 5 段」这种话 zod 说不出来)。同 quality.set_config。
 */
export const AlertsSetTouchConfigParamsSchema: ParamsSchema<AlertsSetTouchConfigParams> = z.object({
  config: z.record(z.string(), z.unknown()),
});
