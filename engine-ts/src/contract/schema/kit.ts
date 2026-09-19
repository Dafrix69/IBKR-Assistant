/** 写入参 schema 的小工具。`contract/schema/` 整个目录只有引擎 import——界面只看上一层的类型文件。 */
import { z } from "zod";

import type { NoParams } from "../index.js";

/** 解出来的形状要正好是契约类型 T;解之前是什么都行(外面进来的 JSON)。 */
export type ParamsSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/**
 * 可选字段:JSON 里没有 undefined,调用方表达"这一项不动"时可能干脆不带,也可能带一个 null——
 * 老 handler 两种都认,这里照旧,统一解成 undefined。
 */
export function optional<S extends z.ZodTypeAny>(schema: S) {
  return schema.nullish().transform((v): z.output<S> | undefined => v ?? undefined);
}

/** 不带参数的方法:给什么都收,解出来一律是空对象(多余的键不看,也不传给 handler)。 */
export const NoParamsSchema: ParamsSchema<NoParams> = z.unknown().transform((): NoParams => ({}));

/** 结构不合时给调用方看的一句话:哪个字段、要什么、给了什么。只报第一处——后面的多半是连带的。 */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "参数不对";
  const where = issue.path.length ? issue.path.join(".") : "params";
  if (issue.code === "invalid_type") {
    if (issue.received === "undefined") return `缺少 ${where}`;
    return `${where} 应为 ${issue.expected},收到 ${issue.received}`;
  }
  return `${where}:${issue.message}`;
}
