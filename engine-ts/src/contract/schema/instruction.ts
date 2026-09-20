/** instruction.submit 的入参 schema。
 *
 * **这是发单方法,所以顶层 strict**:不认识的键当场拒。zod 默认把没列的键静默丢掉——
 * 对别的域无所谓,对这条就是「单发出去了,可某个限定没生效」。
 * 空指令、accounts 里混了非字符串、自动执行没打开,都由 handler 自己那句人话报(golden 钉着)。
 */
import { z } from "zod";

import type { InstructionSubmitParams } from "../instruction.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const InstructionSubmitParamsSchema: ParamsSchema<InstructionSubmitParams> = z.object({
  // 老 handler 是 String(params["text"] ?? "").trim(),空了报「指令为空」——不给也要走到 handler
  text: z.string().nullish().transform((v): string => v ?? ""),
  // Boolean(params["execute"]):给什么都认,只看真假
  execute: optional(z.unknown().transform((v): boolean => Boolean(v))),
  // **不写 z.array()**:golden-rpc 钉着「accounts 必须是账户别名数组」这句话,而且它连"每一项都得是字符串"
  // 一起管。写成 z.array() 就把这句抢过来说成了结构错(2026-09-20 迁移时基线当场红,才发现)。
  // 这一整条(是不是数组、每项是不是字符串、别名在不在表里)都归 handler。
  accounts: optional(z.unknown().transform((v): string[] => v as string[])),
  channel: optional(z.string()),
}).strict();
