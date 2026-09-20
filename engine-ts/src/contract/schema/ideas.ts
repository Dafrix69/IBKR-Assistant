/** ideas.* 的入参 schema。字数上限、状态与范围认不认识,是领域校验,在 handler 与 store(那几句原话 golden-rpc 钉着)。 */
import { z } from "zod";

import type {
  IdeasAddParams, IdeasAnalyzeParams, IdeasDigestParams, IdeasDigestsParams, IdeasListParams, IdeasUpdateParams,
} from "../ideas.js";
import { optional, requiredButReportedByHandler } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

// 老 handler 是 Number(limit || 默认值):数字串也认,所以不写死 z.number()
const limit = optional(z.union([z.number(), z.string()]));

export const IdeasAddParamsSchema: ParamsSchema<IdeasAddParams> = z.object({
  text: z.string(),
});

export const IdeasListParamsSchema: ParamsSchema<IdeasListParams> = z.object({
  status: optional(z.string()),
  limit,
});

export const IdeasUpdateParamsSchema: ParamsSchema<IdeasUpdateParams> = z.object({
  // 不带 id 由 handler 报「缺少想法 id」:golden-rpc 钉着这一句
  id: requiredButReportedByHandler(),
  status: z.string(),
});

export const IdeasAnalyzeParamsSchema: ParamsSchema<IdeasAnalyzeParams> = z.object({
  id: z.string(),
});

export const IdeasDigestParamsSchema: ParamsSchema<IdeasDigestParams> = z.object({
  scope: optional(z.string()),
});

export const IdeasDigestsParamsSchema: ParamsSchema<IdeasDigestsParams> = z.object({
  limit,
});
