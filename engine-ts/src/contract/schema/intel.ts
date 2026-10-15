/** intel.* 的入参 schema。两个方法都只读;代码形状、上限是领域校验,在 handler / service(「股票代码不合法」)。 */
import { z } from "zod";

import type { IntelDossierParams, IntelFeedParams } from "../intel.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

const kinds = z.array(z.enum(["message", "signal", "event", "order", "idea"]));

export const IntelFeedParamsSchema: ParamsSchema<IntelFeedParams> = z.object({
  symbol: optional(z.string()),
  kinds: optional(kinds),
  held_only: optional(z.unknown().transform((v): boolean => Boolean(v))),
  limit: optional(z.number()),
  since: optional(z.number()),
});

export const IntelDossierParamsSchema: ParamsSchema<IntelDossierParams> = z.object({
  symbol: z.string(),
  limit: optional(z.number()),
});
