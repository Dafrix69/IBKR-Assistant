/** screener.* 的入参 schema。板块存不存在、周期与基准认不认识、参数范围,都是领域校验,在 handler
 *  (那几句原话 golden-rpc 钉着,连检查的先后次序一起)。 */
import { z } from "zod";

import type { ScreenerDeviationParams, ScreenerInflectionParams, ScreenerRsParams } from "../screener.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

// 老 handler 一律过 optInt / optFloat:数字串照收,所以不写死 z.number()
const numberField = optional(z.union([z.number(), z.string()]));

export const ScreenerRsParamsSchema: ParamsSchema<ScreenerRsParams> = z.object({
  sector: optional(z.string()),
  benchmark: optional(z.string()),
});

export const ScreenerInflectionParamsSchema: ParamsSchema<ScreenerInflectionParams> = z.object({
  sector: optional(z.string()),
  // 不是数组、空数组,都由 handler 报「timeframes 要是非空数组」(golden-rpc 钉着),所以这里收 unknown
  timeframes: z.unknown(),
  ma_period: numberField,
});

export const ScreenerDeviationParamsSchema: ParamsSchema<ScreenerDeviationParams> = z.object({
  symbol: z.string(),
  timeframe: optional(z.string()),
  period: numberField,
  lookback: numberField,
  smooth: numberField,
  z_extreme: numberField,
});
