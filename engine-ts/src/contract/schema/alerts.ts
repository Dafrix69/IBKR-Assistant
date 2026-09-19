/** alerts.* 的入参 schema。代码形状、步长范围是领域校验,在 handler 与 store。 */
import { z } from "zod";

import type { AlertsCreateParams, AlertsDeleteParams, AlertsRefreshParams } from "../alerts.js";
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
