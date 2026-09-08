/** 黄金回归工具:读 golden JSON,深度比较(浮点 1e-9 相对容差,字符串逐字节)。
 *
 * 基线最初由已退役的 Python 参考实现生成,现在是 TS 实现自己的回归快照。有意改了行为时用
 * `npm run golden:update`(UPDATE_GOLDEN=1):expectSame 遇到差异不报错,而是把新值写回 golden
 * 文件,之后审阅 git diff。只有直接传进 expectSame、且是 golden 文档里的对象/数组的期望值能自动
 * 改写;经过转换的副本与 toBe/toEqual 钉住的标量仍要手改。GOLDEN_NORMALIZE=1 则把每个读到的文件
 * 原样重写一遍(只统一格式,不改值)。
 *
 * 落盘格式:OHLC K 线序列抽到 golden/_bars.json 按内容去重,用例里只留 {"$bars": id};叶子容器
 * (里面没有别的对象/数组)写成一行,其余按 1 空格缩进展开。 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Settings, fromDict } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.resolve(HERE, "..", "baseline", "golden");
const BARS_FILE = path.join(GOLDEN_DIR, "_bars.json");

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const NORMALIZE = process.env.GOLDEN_NORMALIZE === "1";

// ---------------------------------------------------------------- 读取与 $bars 展开
let barsStore: Record<string, unknown[]> | null = null;

function loadBarsStore(): Record<string, unknown[]> {
  if (barsStore === null) barsStore = JSON.parse(fs.readFileSync(BARS_FILE, "utf-8"));
  return barsStore!;
}

function goldenBars(id: string): unknown[] {
  const series = loadBarsStore()[id];
  if (!series) throw new Error(`golden: _bars.json 里没有序列 ${id}`);
  return structuredClone(series); // 每处引用各自一份,用例改了输入也不会串
}

function resolveBars(value: any): any {
  if (Array.isArray(value)) return value.map(resolveBars);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$bars" && typeof value.$bars === "string") {
      return goldenBars(value.$bars);
    }
    const out: Record<string, any> = {};
    for (const key of keys) out[key] = resolveBars(value[key]);
    return out;
  }
  return value;
}

/** 已加载的文档(按文件),以及文档里每个容器属于哪个文件——用来判断某个期望值能不能回写。 */
const docs = new Map<string, any>();
const owners = new WeakMap<object, string>();

function track(value: unknown, file: string): void {
  if (value === null || typeof value !== "object") return;
  owners.set(value, file);
  for (const key of Object.keys(value)) track((value as Record<string, unknown>)[key], file);
}

function inGoldenDir(file: string): boolean {
  return path.resolve(path.dirname(file)) === GOLDEN_DIR;
}

/** 读任意基线文件(golden/ 下的会展开 $bars);同一文件只读一次,更新模式下改写的就是这份。 */
export function loadGoldenFile(file: string): any {
  const key = path.resolve(file);
  const cached = docs.get(key);
  if (cached !== undefined) return cached;
  const raw = JSON.parse(fs.readFileSync(key, "utf-8"));
  const doc = inGoldenDir(key) ? resolveBars(raw) : raw;
  docs.set(key, doc);
  track(doc, key);
  if (NORMALIZE) writeDoc(key);
  return doc;
}

export function loadGolden(name: string): any {
  return loadGoldenFile(path.join(GOLDEN_DIR, `${name}.json`));
}

// ---------------------------------------------------------------- 落盘
function isOhlcSeries(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) && value.length >= 5 &&
    value.every((b) => b !== null && typeof b === "object" && !Array.isArray(b) &&
      "open" in b && "high" in b && "low" in b && "close" in b)
  );
}

/** 把 OHLC 序列换成 {"$bars": id};同内容复用已有 id,新序列按内容哈希起名并登记进 store。 */
function extractBars(value: any, store: Record<string, unknown[]>, byContent: Map<string, string>): any {
  if (isOhlcSeries(value)) {
    const canon = JSON.stringify(value);
    let id = byContent.get(canon);
    if (!id) {
      id = crypto.createHash("sha1").update(canon, "utf-8").digest("hex").slice(0, 12);
      store[id] = JSON.parse(canon);
      byContent.set(canon, id);
    }
    return { $bars: id };
  }
  if (Array.isArray(value)) return value.map((v) => extractBars(v, store, byContent));
  if (value !== null && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) out[key] = extractBars(value[key], store, byContent);
    return out;
  }
  return value;
}

function isLeaf(value: any): boolean {
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.every((x) => x === null || typeof x !== "object");
}

/** 一行内的容器:分隔符与 Python json.dumps 一致(", " 与 ": "),数值走 JS 最短表示。 */
function fmtLeaf(value: any): string {
  if (Array.isArray(value)) return "[" + value.map((x) => JSON.stringify(x)).join(", ") + "]";
  return "{" + Object.keys(value).map((k) => JSON.stringify(k) + ": " + JSON.stringify(value[k])).join(", ") + "}";
}

function fmt(value: any, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  if (empty || isLeaf(value)) return fmtLeaf(value);
  const pad = " ".repeat(depth);
  const inner = " ".repeat(depth + 1);
  if (Array.isArray(value)) {
    return "[\n" + value.map((v) => inner + fmt(v, depth + 1)).join(",\n") + "\n" + pad + "]";
  }
  const body = Object.keys(value)
    .map((k) => inner + JSON.stringify(k) + ": " + fmt(value[k], depth + 1))
    .join(",\n");
  return "{\n" + body + "\n" + pad + "}";
}

function writeDoc(file: string): void {
  const doc = docs.get(file);
  if (doc === undefined) throw new Error(`golden: ${file} 没有加载过`);
  if (inGoldenDir(file)) {
    const store = loadBarsStore();
    const byContent = new Map<string, string>();
    for (const [id, series] of Object.entries(store)) byContent.set(JSON.stringify(series), id);
    const out = extractBars(doc, store, byContent);
    const sorted: Record<string, unknown[]> = {};
    for (const id of Object.keys(store).sort()) sorted[id] = store[id]!;
    fs.writeFileSync(BARS_FILE, fmt(sorted), "utf-8");
    fs.writeFileSync(file, fmt(out), "utf-8");
  } else {
    fs.writeFileSync(file, JSON.stringify(doc, null, 1), "utf-8");
  }
}

/** 更新模式:把 actual 写进 expected 所在的位置并落盘。做不到(标量、或不是文档里的容器)返回 false。 */
function rewrite(actual: unknown, expected: unknown, label: string): boolean {
  if (expected === null || typeof expected !== "object") return false;
  const file = owners.get(expected);
  if (!file) return false;
  const fresh = JSON.parse(JSON.stringify(actual === undefined ? null : actual)); // 去掉 undefined,与落盘一致
  if (Array.isArray(expected)) {
    if (!Array.isArray(fresh)) return false;
    expected.length = 0;
    for (const item of fresh) expected.push(item);
  } else {
    if (fresh === null || typeof fresh !== "object" || Array.isArray(fresh)) return false;
    for (const key of Object.keys(expected)) delete (expected as Record<string, unknown>)[key];
    Object.assign(expected, fresh);
  }
  track(expected, file);
  writeDoc(file);
  console.warn(`[golden] 已改写 ${path.basename(file)}:${label}`);
  return true;
}

// ---------------------------------------------------------------- 比较
const REL_TOL = 1e-9;
const ABS_TOL = 1e-12;

export function numbersClose(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isNaN(a) && Number.isNaN(b);
  const diff = Math.abs(a - b);
  return diff <= ABS_TOL || diff <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/** 深度比较,报出第一处差异的路径(null 与 undefined 视为同一个"空")。 */
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
  if (!diff) return;
  if (UPDATE && rewrite(actual, expected, label)) return;
  throw new Error(UPDATE ? `${diff}(无法自动改写:期望值不是 golden 文档里的对象/数组,请手改)` : diff);
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
