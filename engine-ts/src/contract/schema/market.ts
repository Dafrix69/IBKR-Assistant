/** book.snapshot / macro.board 的入参 schema。代码形状是领域校验,在 handler(那句原话 golden-rpc 钉着)。 */
import { z } from "zod";

import type { BookSnapshotParams } from "../book.js";
import type { MacroBoardParams } from "../macro.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const BookSnapshotParamsSchema: ParamsSchema<BookSnapshotParams> = z.object({
  // 不带 symbol:老 handler 报「股票代码不合法:'undefined'」,golden-rpc 没钉这一条,所以按规矩归 schema 报「缺少 symbol」
  // (同域已迁的 quality.add / alerts.create / sectors.add_stock 都是这样)。给了个非字符串同理。
  symbol: z.string(),
});

export const MacroBoardParamsSchema: ParamsSchema<MacroBoardParams> = z.object({
  // 老 handler 是 Boolean(params["force"]):给什么都收,照旧
  force: optional(z.unknown().transform((v): boolean => Boolean(v))),
});
