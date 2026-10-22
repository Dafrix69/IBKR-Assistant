// 生成 engine_core_fuzz_1..3.json:engine_core_fuzz.mjs 的随机脚本(种子固定)交给原 TS 的 TradingEngine 现跑的答案。脚本里有抛错的步就丢掉(V8 的报错原文与 C++ 不同,不比)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_core_fuzz.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadCore, runCore } from './engine_core_world.mjs';
import { rng } from './engine_world.mjs';
import { genCore } from './engine_core_fuzz.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadCore(engine);
const LIMIT = Number(process.env.LIMIT ?? 1_000_000);
const files = [{ name: 'engine_core_fuzz_1.json', seed: 1101 }, { name: 'engine_core_fuzz_2.json', seed: 2202 }, { name: 'engine_core_fuzz_3.json', seed: 3303 }];
for (const f of files) {
  const out = [];
  let size = 0, dropped = 0, n = 0;
  while (size < LIMIT && n < 400) {
    n += 1;
    const r = rng(f.seed * 1000 + n);
    const gen = genCore(r, `${f.seed}_${n}`);
    const expected = await runCore(gen.script, mods);
    if (expected.steps.some((s) => s.r && typeof s.r === 'object' && 'error' in s.r && !String(s.r.error).match(/^(非 LLM 错|跟单只认本地速记|发单炸了|改单炸了|读不到|模型挂了)/))) { dropped += 1; continue; }
    const entry = { name: gen.name, script: enc(gen.script), expected: enc(expected) };
    size += JSON.stringify(entry).length;
    out.push(entry);
  }
  const text = JSON.stringify({ base: enc(BASE_CONFIG), scenarios: out });
  writeFileSync(join(here, f.name), text);
  console.log(`${f.name}:${out.length} 个脚本(丢掉 ${dropped} 个会抛错的),${(text.length / 1024).toFixed(0)} KB`);
}
