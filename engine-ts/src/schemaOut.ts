/** 给 structured outputs 用的 JSON Schema 清洗(对应 Python schema.py)。
 *
 * 各家实现都不支持数值/长度约束,这里统一剥掉——语义约束由 models.ts 在本地
 * 复校验,剥掉的是"给 API 看的那一份"。
 */

export const UNSUPPORTED_KEYWORDS = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
] as const;

export function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  strip(clone);
  return clone;
}

function strip(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) strip(item);
    return;
  }
  if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    for (const key of UNSUPPORTED_KEYWORDS) delete rec[key];
    if (rec["type"] === "object" && !("additionalProperties" in rec)) {
      rec["additionalProperties"] = false;
    }
    for (const value of Object.values(rec)) strip(value);
  }
}
