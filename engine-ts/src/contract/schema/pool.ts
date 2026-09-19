/** pool.set_watch 的入参 schema。"两个开关至少传一个"是领域规矩,在 handler 里说。 */
import { z } from "zod";

import type { PoolSetWatchParams } from "../pool.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const PoolSetWatchParamsSchema: ParamsSchema<PoolSetWatchParams> = z.object({
  symbol: z.string(),
  price: optional(z.boolean()),
  anomaly: optional(z.boolean()),
});
