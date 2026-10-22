// 生成 engine_fuzz_1..3.json:engine_fuzz.mjs 的随机脚本(种子固定)交给原 TS 模块现跑的答案,每份 ~1.1 MB。
//   1 = hosted 族,2 = cb 族(回报落库 + 对账),3 = 两族各半(另一批种子)。脚本里有抛错的步就丢掉(V8 的报错原文与 C++ 不同,不比)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_fuzz.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadEngine, rng, runScenario } from './engine_world.mjs';
import { genCb, genHosted } from './engine_fuzz.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadEngine(engine);
const LIMIT = Number(process.env.LIMIT ?? 1_150_000);
const files = [
  { name: 'engine_fuzz_1.json', seed: 1001, kinds: ['hosted'] },
  { name: 'engine_fuzz_2.json', seed: 2002, kinds: ['cb'] },
  { name: 'engine_fuzz_3.json', seed: 3003, kinds: ['hosted', 'cb'] },
];
for (const f of files) {
  const out = [];
  let size = 0, dropped = 0, n = 0;
  while (size < LIMIT && n < 400) {
    n += 1;
    const kind = f.kinds[n % f.kinds.length];
    const r = rng(f.seed * 1000 + n);
    const gen = (kind === 'hosted' ? genHosted : genCb)(r, `${f.seed}_${n}`);
    const expected = await runScenario(gen.script, mods);
    if (expected.steps.some((s) => s.r && typeof s.r === 'object' && 'error' in s.r)) { dropped += 1; continue; }
    const entry = { name: gen.name, script: enc(gen.script), expected: enc(expected) };
    size += JSON.stringify(entry).length;
    out.push(entry);
  }
  const text = JSON.stringify({ base: enc(BASE_CONFIG), scenarios: out });
  writeFileSync(join(here, f.name), text);
  console.log(`${f.name}:${out.length} 个脚本(丢掉 ${dropped} 个会抛错的),${(text.length / 1024).toFixed(0)} KB`);
}
