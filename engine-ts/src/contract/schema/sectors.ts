/** sectors.* 的入参 schema。板块名的长度与重名、代码形状、单板块 30 只上限,是领域校验,在 handler 与 store。 */
import { z } from "zod";

import type {
  SectorsAddParams, SectorsAddStockParams, SectorsIdParams, SectorsRemoveStockParams, SectorsSetTagParams,
} from "../sectors.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const SectorsAddParamsSchema: ParamsSchema<SectorsAddParams> = z.object({
  name: z.string(),
});

export const SectorsIdParamsSchema: ParamsSchema<SectorsIdParams> = z.object({
  id: z.string(),
});

export const SectorsAddStockParamsSchema: ParamsSchema<SectorsAddStockParams> = z.object({
  id: z.string(),
  symbol: z.string(),
  company: optional(z.string()),
  tag: optional(z.string()),
});

export const SectorsRemoveStockParamsSchema: ParamsSchema<SectorsRemoveStockParams> = z.object({
  id: z.string(),
  symbol: z.string(),
});

export const SectorsSetTagParamsSchema: ParamsSchema<SectorsSetTagParams> = z.object({
  id: z.string(),
  symbol: z.string(),
  tag: optional(z.string()),
});
