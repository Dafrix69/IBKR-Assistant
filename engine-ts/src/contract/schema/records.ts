/** records.* 的入参 schema。pending.* 两样不收参数,用 NoParamsSchema。 */
import { z } from "zod";

import type { RecordsGetParams, RecordsListParams } from "../records.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const RecordsListParamsSchema: ParamsSchema<RecordsListParams> = z.object({
  // 老 handler 是 Math.trunc(Number(limit ?? 30)):数字串也认,所以这里不写死 z.number()
  limit: optional(z.union([z.number(), z.string()])),
});

export const RecordsGetParamsSchema: ParamsSchema<RecordsGetParams> = z.object({
  // 缺 id 和 id 对不上由 handler 说同一句「记录不存在」,schema 不替它分开报
  id: optional(z.string()),
});
