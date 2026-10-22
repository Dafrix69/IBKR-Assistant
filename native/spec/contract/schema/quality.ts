/** quality.* 的入参 schema。只管结构;代码形状、上限、阈值越界这些领域校验在 handler 与 anomaly.ts。 */
import { z } from "zod";

import type {
  QualityAddParams, QualityRemoveParams, QualitySetConfigParams, QualityUpdateParams,
} from "../quality.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const QualityAddParamsSchema: ParamsSchema<QualityAddParams> = z.object({
  symbol: z.string(),
  note: optional(z.string()),
  company: optional(z.string()),
});

export const QualityUpdateParamsSchema: ParamsSchema<QualityUpdateParams> = z.object({
  id: z.string(),
  enabled: optional(z.boolean()),
  note: optional(z.string()),
});

export const QualityRemoveParamsSchema: ParamsSchema<QualityRemoveParams> = z.object({
  id: z.string(),
});

/**
 * config 只要求"是个对象":哪几项、各自的范围由 normalizeAnomalyConfig 校验并给中文原因
 * (「窗口只能是 3 / 5 / 10 分钟」这种话 zod 说不出来)。不认识的键它自己会拒。
 */
export const QualitySetConfigParamsSchema: ParamsSchema<QualitySetConfigParams> = z.object({
  config: z.record(z.string(), z.unknown()),
});
