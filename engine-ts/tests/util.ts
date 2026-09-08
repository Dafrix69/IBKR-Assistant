/** 黄金对拍工具:读 golden JSON,深度比较(浮点 1e-9 相对容差,字符串逐字节)。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Settings, fromDict } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.resolve(HERE, "..", "baseline", "golden");

export function loadGolden(name: string): any {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

const REL_TOL = 1e-9;
const ABS_TOL = 1e-12;

export function numbersClose(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isNaN(a) && Number.isNaN(b);
  const diff = Math.abs(a - b);
  return diff <= ABS_TOL || diff <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/** 深度比较,报出第一处差异的路径。expected 来自 Python(null 表示 None)。 */
export function deepCompare(actual: unknown, expected: unknown, at = "$"): string | null {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined
      ? null
      : `${at}: expected null, got ${JSON.stringify(actual)}`;
  }
  if (typeof expected === "number") {
    if (typeof actual !== "number") return `${at}: expected number ${expected}, got ${JSON.stringify(actual)}`;
    return numbersClose(actual, expected) ? null : `${at}: ${actual} !≈ ${expected}`;
  }
  if (typeof expected === "string" || typeof expected === "boolean") {
    return actual === expected
      ? null
      : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected array, got ${JSON.stringify(actual)}`;
    if (actual.length !== expected.length) {
      return `${at}: array length ${actual.length} != ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = deepCompare(actual[i], expected[i], `${at}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  // object
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return `${at}: expected object, got ${JSON.stringify(actual)}`;
  }
  const exp = expected as Record<string, unknown>;
  const act = actual as Record<string, unknown>;
  const expKeys = Object.keys(exp).sort();
  const actKeys = Object.keys(act)
    .filter((k) => act[k] !== undefined)
    .sort();
  if (expKeys.join(",") !== actKeys.join(",")) {
    const missing = expKeys.filter((k) => !actKeys.includes(k));
    const extra = actKeys.filter((k) => !expKeys.includes(k));
    return `${at}: key mismatch (missing: ${missing.join("|") || "-"}; extra: ${extra.join("|") || "-"})`;
  }
  for (const key of expKeys) {
    const diff = deepCompare(act[key], exp[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

export function expectSame(actual: unknown, expected: unknown, label: string): void {
  const diff = deepCompare(actual, expected, label);
  if (diff) throw new Error(diff);
}

export function deepUpdate(
  base: Record<string, any>, overrides: Record<string, any>,
): Record<string, any> {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      base[key] !== null && typeof base[key] === "object" && !Array.isArray(base[key])
    ) {
      deepUpdate(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

export function makeSettings(
  baseConfig: Record<string, any>, overrides?: Record<string, any> | null,
): Settings {
  const raw = structuredClone(baseConfig);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      raw[key] !== null && typeof raw[key] === "object" && !Array.isArray(raw[key])
    ) {
      raw[key] = deepUpdate({ ...raw[key] }, value);
    } else {
      raw[key] = value;
    }
  }
  return fromDict(raw);
}
