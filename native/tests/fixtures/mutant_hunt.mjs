// 找"能把一处边界改动区分出来的输入":把编过的 TS 模块里的一句比较(< 改成 <=、>= 改成 >……)改掉,另存一份,
// 然后在候选输入上同时跑原版和改过的,第一个结果不一样的输入就是这条边界的探针(夹具里留它,C++ 也得在这条边界上一致)。
// 变异测试里"活下来"的改动多半是正好相等才露馅的边界,随机输入很难撞上,这样反过来找。
// 候选由调用方给(整数格点上的价格、整齐的量,相等才常见);找不到的返回空,由调用方在报告里交代。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let counter = 0;
const tmp = mkdtempSync(join(tmpdir(), 'hunt-'));

/** 取编过的模块的一份改过的拷贝。replacements: [[原句, 新句], …],每个原句必须在源码里恰好出现一次 */
export async function mutantOf(engine, moduleName, replacements) {
  const file = join(engine, 'dist/src', `${moduleName}.js`);
  let src = readFileSync(file, 'utf8');
  src = src.replace(/from "\.\/([A-Za-z0-9_]+)\.js"/g, (m, name) => `from "${pathToFileURL(join(engine, 'dist/src', `${name}.js`)).href}"`);
  src = src.replace(/from '\.\/([A-Za-z0-9_]+)\.js'/g, (m, name) => `from "${pathToFileURL(join(engine, 'dist/src', `${name}.js`)).href}"`);
  for (const [from, to] of replacements) {
    const parts = src.split(from);
    if (parts.length !== 2) throw new Error(`变异原句出现 ${parts.length - 1} 次:${from}`);
    src = parts.join(to);
  }
  const out = join(tmp, `${moduleName}-${counter++}.mjs`);
  writeFileSync(out, src);
  return import(pathToFileURL(out).href);
}

/** candidates: 迭代器,产出输入;original / mutant: (输入) => 结果(任意可 JSON 的值,抛错也算结果)。返回最多 want 个区分得出来的输入 */
export function hunt(candidates, original, mutant, want = 1, budget = 20000) {
  const found = [];
  let tried = 0;
  const show = (f, x) => { try { return JSON.stringify(f(x), (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)); } catch (e) { return `throw ${e.message}`; } };
  for (const c of candidates) {
    if (tried++ >= budget) break;
    if (show(original, c) !== show(mutant, c)) {
      found.push(c);
      if (found.length >= want) break;
    }
  }
  return { found, tried };
}
