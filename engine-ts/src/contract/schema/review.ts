/** review.* 的入参 schema。id 对不对、周期认不认识,是领域校验,在 handler(「记录不存在」是 -32005,golden-rpc 钉着)。 */
import { z } from "zod";

import type { ReviewPerformanceParams } from "../performance.js";
import type { ReviewAnalyzeParams, ReviewCandidatesParams } from "../review.js";
import type { ReviewSignalsParams } from "../signals.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const ReviewCandidatesParamsSchema: ParamsSchema<ReviewCandidatesParams> = z.object({
  // 老 handler 是 Number(limit ?? 200) || 200:数字串、0 都照收
  limit: optional(z.union([z.number(), z.string()])),
  // 老 handler 只看真假
  include_local: z.unknown(),
});

export const ReviewAnalyzeParamsSchema: ParamsSchema<ReviewAnalyzeParams> = z.object({
  // golden-rpc 没有 review.* 的请求(-32005「记录不存在」钉的是 records.get),所以缺 id 按规矩归 schema 报
  id: z.string(),
  timeframe: optional(z.string()),
  exit: z.unknown(),
});

export const ReviewPerformanceParamsSchema: ParamsSchema<ReviewPerformanceParams> = z.object({
  scope: optional(z.enum(["all", "live", "paper"])),
  kind: optional(z.enum(["all", "butterfly", "stock", "option"])),
  // 天数的范围(正整数、上限)是领域校验,在 handler
  days: optional(z.number()),
});

export const ReviewSignalsParamsSchema: ParamsSchema<ReviewSignalsParams> = z.object({
  // 天数的范围同 review.performance,在 handler
  days: optional(z.number()),
});
