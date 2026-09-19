/** options.wall 的入参 schema。代码形状是领域校验,在 handler。 */
import { z } from "zod";

import type { OptionsWallParams } from "../options.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const OptionsWallParamsSchema: ParamsSchema<OptionsWallParams> = z.object({
  symbol: z.string(),
  expiry: optional(z.string()),
  // 老 handler 是 Math.trunc(Number(width ?? 10)):数字串也认
  width: optional(z.union([z.number(), z.string()])),
});
