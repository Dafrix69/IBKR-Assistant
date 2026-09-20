/** llm.* 的入参 schema。
 *
 * llm.patch 会动配置(桌面端要求界面确认过),顶层是 strict 的;但 llm **里面**不在这里校验:哪几项能改由 handler 的白名单说
 * (「不允许修改的字段:bogus」,golden-rpc 钉着),值对不对由 config.fromDict 说——同 settings.patch。
 * llm.test 的 api_key 是一把还没保存的密钥:这里只确认它是字符串;describeIssue 报的是"哪个字段、要什么类型、收到什么类型",
 * 不回显值。
 */
import { z } from "zod";

import type { LlmPatchParams, LlmTestParams } from "../llm.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

const llmInput = optional(z.record(z.string(), z.unknown()));

export const LlmPatchParamsSchema: ParamsSchema<LlmPatchParams> = z.object({
  llm: llmInput,
}).strict();

export const LlmTestParamsSchema: ParamsSchema<LlmTestParams> = z.object({
  llm: llmInput,
  // 老 handler 是 params.api_key || null:空串 = 没给
  api_key: optional(z.string()),
});
