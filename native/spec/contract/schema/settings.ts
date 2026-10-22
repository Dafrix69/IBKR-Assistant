/** settings.* / keychain.set / data.export 的入参 schema。
 *
 * settings.patch 与 keychain.set 会动配置与密钥(桌面端要求界面确认过),顶层是 strict 的。但 patch **里面**不在这里校验:
 * config.fromDict 对每一段都拒绝不认识的键、查类型与范围、给中文原因(「policies.auto_execute 必须是 true/false」),
 * 校验不过就不写盘——那是这份配置唯一的校验者,这里再抄一遍只会两边走样。
 */
import { z } from "zod";

import type { DataExportParams, KeychainSetParams, SettingsPatchParams } from "../settings.js";
import { optional } from "./kit.js";
import type { ParamsSchema } from "./kit.js";

export const SettingsPatchParamsSchema: ParamsSchema<SettingsPatchParams> = z.object({
  patch: optional(z.record(z.string(), z.unknown())),
}).strict();

export const KeychainSetParamsSchema: ParamsSchema<KeychainSetParams> = z.object({
  secret: z.string(),
  provider: optional(z.string()),
}).strict();

export const DataExportParamsSchema: ParamsSchema<DataExportParams> = z.object({
  path: z.string(),
});
