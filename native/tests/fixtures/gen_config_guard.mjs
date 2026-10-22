// 生成 config-guard.json:
//   · roundtrip:JSON.stringify(JSON.parse(text), null, 2) 的结果(保序、数的写法、转义),以及哪些 JSON.parse 不认;
//   · scenarios:配置与备份各是什么样时,desktop/config-guard.js 的 inspectConfig / restoreBackup 现算的结果(在临时目录里真的跑)。
//   node native/tests/fixtures/gen_config_guard.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const G = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/config-guard.js'));

const texts = [
  '{"b":1,"a":[1,2,{"z":null,"y":true}],"c":{}}', '{"dup":1,"x":2,"dup":3}', '[]', '{"e":[],"o":{}}', '  {"s":"中文 \\u00e9 \\n \\t \\" \\\\ \\/ \\u2028 \\ud83d\\ude00"}  ',
  '{"n":[1.50,-0,0.1,1e21,1E-7,123456789012345678901234,2.5e-3,-1.0e+2,1e999]}', '{"k":"\u0001"}', '{"a":1,}', '{a:1}', "{'a':1}", '{"a":01}', '{"a":1.}', '{"a":.5}', 'nul', '{"a":1} x', '',
  '﻿{"a":1}', '{"a":"\\x41"}', '[1,[2,[3,[]]],{"deep":{"er":{"est":[{}]}}}]', '"just a string"', '42', 'true',
];
const roundtrip = texts.map((text) => {
  try {
    return { text, ok: true, out: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { text, ok: false };
  }
});

const good = JSON.stringify({ policies: { auto_execute: true, max_order_value: 1000, allow_live_trading: true, allow_combo_live: true }, accounts: [{ alias: '模拟', account_id: 'DU1' }], zeta: 1, alpha: [1.50] }, null, 2);
const scenarios = [
  { name: 'broken+good-backup', current: '{ "a": 1, ', backup: good },
  { name: 'same-as-current', current: good, backup: good },
  { name: 'no-backup', current: '{', backup: null },
  { name: 'backup-not-object', current: '{', backup: '[1,2]' },
  { name: 'backup-broken', current: '{', backup: '{"x":' },
  { name: 'missing-current', current: null, backup: '{"policies":{"auto_execute":false,"allow_live_trading":"yes"},"b":2}' },
  { name: 'policies-not-object', current: '{}', backup: '{"policies":[true],"auto_execute":true}' },
  { name: 'gates-already-off', current: 'x', backup: '{"z":0,"policies":{"allow_live_trading":false}}' },
];
const NOW = Date.UTC(2026, 9, 18, 4, 5, 6);
const out = [];
for (const s of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  const cfg = join(dir, 'settings.json');
  if (s.current !== null) writeFileSync(cfg, s.current);
  if (s.backup !== null) writeFileSync(`${cfg}.bak`, s.backup);
  const inspect = G.inspectConfig(cfg);
  let restore;
  try {
    const r = G.restoreBackup(cfg, { now: NOW });
    restore = { ok: true, closedGates: r.closedGates, brokenCopy: r.brokenCopy ? r.brokenCopy.slice(dir.length + 1) : null, written: readFileSync(cfg, 'utf8') };
  } catch (err) {
    restore = { ok: false, error: String(err.message) };
  }
  out.push({ ...s, inspect: { exists: inspect.exists, syntaxOk: inspect.syntaxOk, hasSyntaxError: inspect.syntaxError !== null, backupUsable: inspect.backup.usable, hasBackupAt: inspect.backup.at !== null, sameAsCurrent: inspect.backup.sameAsCurrent }, restore, files: readdirSync(dir).sort() });
  rmSync(dir, { recursive: true, force: true });
}
// 改名用的时间戳是本机时区:把这次生成用的偏移记下来,C++ 那边按同一个偏移算
writeFileSync(join(here, 'config-guard.json'), JSON.stringify({ generator: 'gen_config_guard.mjs', exitConfig: G.EXIT_CONFIG, now: NOW, tz: process.env.TZ || '', roundtrip, scenarios: out }, null, 1) + '\n');
console.log(`config-guard.json: ${roundtrip.length} roundtrip, ${out.length} scenarios`);
