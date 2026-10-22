// 生成 engine_core.json:engine-ts 的 TradingEngine(原模块现跑)对着脚本驱动的假解析器 / 假 router、真的交易库与熔断开关的命名场景
// (见 engine_core_world.mjs 开头的约定与 engine_core_scenarios.mjs)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_core.mjs <编过的 engine-ts 目录>
// ONLY=名字片段 只跑名字里有它的场景;OUT=文件名;SHOW=1 打印每个场景的步骤结果摘要(排错用,不写文件)。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadCore, runCore } from './engine_core_world.mjs';
import { cppScenarios, scenarios } from './engine_core_scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadCore(engine);
const only = process.env.ONLY;
const out = [];
const failures = [];
for (const s of scenarios()) {
  if (only && !s.name.includes(only)) continue;
  const expected = await runCore(s.script, mods);
  if (s.check) {
    try { s.check(expected); } catch (e) { failures.push(`${s.name}: ${e.message}`); }
  }
  if (process.env.SHOW) {
    console.log(`== ${s.name}`);
    const cnt = {}; for (const e of expected.log) if (e.c === 'router') cnt[e.m] = (cnt[e.m] ?? 0) + 1;
    console.log('  router calls:', JSON.stringify(cnt));
    for (const st of expected.steps) console.log(`  [${st.i}] ${st.op}: ${(process.env.FULL ? JSON.stringify(st.r) : JSON.stringify(st.r).slice(0, 300))}`);
  }
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
if (failures.length) { console.log(failures.join('\n')); throw new Error(`${failures.length} 个场景的自检没过`); }
const text = JSON.stringify({ base: enc(BASE_CONFIG), scenarios: out });
if (!process.env.SHOW) writeFileSync(join(here, process.env.OUT ?? 'engine_core.json'), text);
if (!process.env.SHOW && !process.env.ONLY) {
  // C++ 独有的脚本:只存脚本(没有期望值),断言写在 tst_engine_core.cpp 里
  writeFileSync(join(here, 'engine_core_cpp.json'), JSON.stringify({ base: enc(BASE_CONFIG), scenarios: cppScenarios().map((c) => ({ name: c.name, script: enc(c.script) })) }));
}
console.log(`${process.env.OUT ?? 'engine_core.json'}:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
