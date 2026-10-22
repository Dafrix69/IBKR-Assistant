// 生成 engine_world.json:engine-ts 的 HostedOrders / IbCallbacks / Reconciler / TrackExits(原模块现跑)对着脚本驱动的假 router、真的交易库的命名场景
// (见 engine_world.mjs 开头的约定与 engine_scenarios.mjs)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_world.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadEngine, runScenario } from './engine_world.mjs';
import { scenarios } from './engine_scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadEngine(engine);
const only = process.env.ONLY;
const out = [];
for (const s of scenarios()) {
  if (only && !s.name.includes(only)) continue;
  const expected = await runScenario(s.script, mods);
  if (s.check) {
    try { s.check(expected); } catch (e) { throw new Error(`${s.name}: ${e.message}`); }
  }
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: enc(BASE_CONFIG), scenarios: out });
writeFileSync(join(here, process.env.OUT ?? 'engine_world.json'), text);
console.log(`${process.env.OUT ?? 'engine_world.json'}:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
