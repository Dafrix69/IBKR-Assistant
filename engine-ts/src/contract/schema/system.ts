/** breaker.* 的入参 schema。system.* 两样不收参数,用 NoParamsSchema。 */
import { z } from "zod";

import type { BreakerHaltParams } from "../system.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const BreakerHaltParamsSchema: ParamsSchema<BreakerHaltParams> = z.object({
  // 老 handler 是 String(params["reason"] || 默认句):空串、缺省都退回那句默认的。
  // 这里只管"是不是个串",不替它判空——那是 handler 的事。
  reason: optional(z.string()),
});
