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
  return describeOne(issue);
}

function describeOne(issue: z.ZodIssue): string {
  const where = issue.path.length ? issue.path.join(".") : "params";
  if (issue.code === "invalid_union") {
    // "数字或字符串"这种字段:每个分支各有各的不满意。都停在同一处、都是类型不对 → 合成一句「应为 A 或 B」;
    // 有一个分支走得更深(数组里某一档缺了 pct)→ 它最接近调用方的本意,报它
    const firsts = issue.unionErrors.map((e) => e.issues[0]).filter((i): i is z.ZodIssue => i !== undefined);
    const deepest = firsts.reduce<z.ZodIssue | null>((best, i) => (best === null || i.path.length > best.path.length ? i : best), null);
    if (deepest !== null && deepest.path.length > issue.path.length) return describeOne(deepest);
    const types = firsts.filter((i) => i.code === "invalid_type");
    const received = types[0]?.code === "invalid_type" ? types[0].received : null;
    if (types.length && received !== null) {
      const expected = [...new Set(types.map((i) => (i.code === "invalid_type" ? i.expected : "")))].join(" 或 ");
      return received === "undefined" ? `缺少 ${where}` : `${where} 应为 ${expected},收到 ${received}`;
    }
    return `${where} 的形状不对`;
  }
  if (issue.code === "invalid_type") {
    if (issue.received === "undefined") return `缺少 ${where}`;
    return `${where} 应为 ${issue.expected},收到 ${issue.received}`;
  }
  if (issue.code === "unrecognized_keys") {
    // 只有 strict 的 schema 会走到这里(tracker.*):键名写错了、或者这个键契约里还没登记
    const at = issue.path.length ? `${issue.path.join(".")} 里` : "";
    return `${at}有不认识的键:${issue.keys.join("、")}(这个方法不收没登记的键,没有照单全收)`;
  }
  return `${where}:${issue.message}`;
}
