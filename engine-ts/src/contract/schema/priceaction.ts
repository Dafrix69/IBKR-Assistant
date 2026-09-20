/** pa.* 的入参 schema。代码形状、周期认不认识,是领域校验,在 handler(那两句原话 golden-rpc 钉着)。 */
import { z } from "zod";

import type { PaAnalyzeParams } from "../priceaction.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

/** pa.analyze 与 pa.comment 同一份。rth / force 老 handler 都是 Boolean(x) / 三值判断:给什么都收,照旧。 */
export const PaAnalyzeParamsSchema: ParamsSchema<PaAnalyzeParams> = z.object({
  symbol: z.string(),
  timeframe: optional(z.string()),
  rth: z.unknown(),
  force: z.unknown(),
});
