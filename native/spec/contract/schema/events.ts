/** events.* 的入参 schema。都是本地偏好与一份只读清单,不发单;自定义事件的日期钟点对不对由 handler 报(给中文原因)。 */
import { z } from "zod";

import type { EventsAddParams, EventsListParams, EventsRemoveParams, EventsSetConfigParams } from "../events.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const EventsListParamsSchema: ParamsSchema<EventsListParams> = z.object({
  force: optional(z.unknown().transform((v): boolean => Boolean(v))),
});

export const EventsSetConfigParamsSchema: ParamsSchema<EventsSetConfigParams> = z.object({
  config: z.record(z.string(), z.unknown()),
});

export const EventsAddParamsSchema: ParamsSchema<EventsAddParams> = z.object({
  title: z.string(),
  date_et: z.string(),
  time_et: z.string(),
  note: optional(z.string()),
  impact: optional(z.enum(["high", "medium"])),
  linger_min: optional(z.number()),
});

export const EventsRemoveParamsSchema: ParamsSchema<EventsRemoveParams> = z.object({
  id: z.string(),
});
