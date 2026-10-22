/** follow.* 的入参 schema。follow.set_token 写系统凭证库,顶层 strict。 */
import { z } from "zod";

import type { FollowSetTokenParams } from "../follow.js";
import type { ParamsSchema } from "./kit.js";

export const FollowSetTokenParamsSchema: ParamsSchema<FollowSetTokenParams> = z.object({
  token: z.string(),
}).strict();
