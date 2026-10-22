// 生成 broker_router.json:engine-ts 的 BrokerRouter(原模块现跑)对着脚本驱动的假会话的场景(见 broker_world.mjs 开头的约定)。
// 场景照 engine-ts/tests 里碰路由器的那些用例(broker-router / broker-link / broker-autoconnect / volume-stream / option-chain / pa-bars /
// fix-qualify-stall / fix-closed-position-streams / fix-shared-ticker-stream / fix-tracker-quotes / fix-upstream-info / fix-stale-streams)写,再加钱路径上的细节。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_broker_router.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadBroker, runScenario } from './broker_world.mjs';
import { scenarios } from './broker_scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadBroker(engine);
const only = process.env.ONLY;
const out = [];
for (const s of scenarios(mods)) {
  if (only && !s.name.includes(only)) continue;
  const expected = await runScenario(s.script, mods);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, process.env.OUT ?? 'broker_router.json'), text);
console.log(`${process.env.OUT ?? 'broker_router.json'}:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
