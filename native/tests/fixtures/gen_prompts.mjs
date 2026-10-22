// 生成 prompts.json:engine-ts 的 prompts.ts(原模块现跑)。每一版提示词的指纹、渲染后的系统提示词、少样本(业务用的那一份);
// 各种指令 / 快照 / 盘中状态下渲染的用户消息;账号泄漏、缺文件、残留模板变量的报错原话。配置用黄金基线里那一份,改几样再试。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_prompts.mjs <编过的 engine-ts 目录> <prompts 目录>
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2], promptDir = process.argv[3];
if (!engine || !promptDir) throw new Error('要给编过的 engine-ts 目录与 prompts 目录');
const P = await import(pathToFileURL(join(engine, 'dist/src/prompts.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/prompts.json'), 'utf8'));
const run = (f) => { try { return { out: f() }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const PROMPTS = '<PROMPTS>';
const mask = (s) => (typeof s === 'string' ? s.split(promptDir).join(PROMPTS) : s);
const settingsOf = (over, dir = promptDir) => C.fromDict({ ...structuredClone(golden.base_config), prompt_dir: dir, ...over });

const configs = [
  {}, { limits: { ...golden.base_config.limits, max_order_notional: 999.5 } }, { limits: { ...golden.base_config.limits, max_order_notional: 12345.678901 } },
  { symbol_aliases: {} }, { accounts: [{ alias: '唯一', account_id: 'DU1', is_paper: true, connection: 'paper', default: true }] },
];
const versions = readdirSync(promptDir).flatMap((f) => (/^system_(v[\d.]+)\.md$/.exec(f) ?? []).slice(1)).sort();
versions.push('v9.9.9');
const moments = ['2026-08-14T10:32:00-04:00', '2026-08-15T03:00:00-04:00', '2026-11-27T12:59:00-05:00', '2026-12-31T23:59:00-05:00'].map((s) => C.etNowFromEpoch(Date.parse(s)));
const instructions = ['买入 AAPL 100股 limit 230', '  卖出 苹果 50 股  ', '', '把 DU7654321 的仓位平掉', '{{USER_INSTRUCTION}} 混进来', '账户 U1234567 买 1 张', '😀 x y'];
const snaps = [null, undefined, {}, { AAPL: 229.4, SPX: 7462.35 }, { spx: 7000, qqq: 612.123456789 }, { X: 1e21 }, { Y: 0.1 + 0.2 }, { Z: NaN }, { W: -0 }, { V: '7' }, { U: null }];

const out = { bundles: [], users: [] };
for (const [ci, over] of configs.entries()) for (const version of versions) {
  const settings = settingsOf({ ...over, prompt_version: version });
  const res = run(() => P.loadPromptBundle(settings));
  if (res.error) { out.bundles.push({ c: ci, version, error: mask(res.error) }); continue; }
  const b = res.out;
  out.bundles.push({ c: ci, version, out: { fingerprint: P.fingerprint(b), version: b.version, system_text: b.system_text, user_template: b.user_template,
    fewshot: b.fewshot.map((p) => ({ name: p.name, user: p.user, assistant: JSON.stringify(p.assistant) })) } });
  if (ci > 1) continue;
  for (const ins of instructions) for (const m of moments) for (const snap of (version === versions[versions.length - 2] ? snaps : [snaps[3]])) {
    for (const status of [null, '', '盘中(手动)']) {
      const r = run(() => P.renderUser(b, settings, ins, m, status, snap));
      out.users.push({ c: ci, version, ins, m, snap: snap === undefined ? '__undefined__' : JSON.stringify(snap, (k, v) => (v === Infinity ? '__Inf__' : v === -Infinity ? '__-Inf__' : typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : Object.is(v, -0) ? '__neg0__' : v)), status, ...r });
    }
  }
}
// 写坏的提示词目录:残留模板变量、少样本格式不对、少样本不是 JSON
const bad = mkdtempSync(join(tmpdir(), 'prompts-bad-'));
for (const f of readdirSync(promptDir)) copyFileSync(join(promptDir, f), join(bad, f));
writeFileSync(join(bad, 'system_v8.0.0.md'), '限额 {{MAX_ORDER_NOTIONAL}} {{NOT_A_VAR}} {{ALSO_MISSING}} {{NOT_A_VAR}}\r\n');
writeFileSync(join(bad, 'user_message_v8.0.0.md'), 'x');
writeFileSync(join(bad, 'system_v8.1.0.md'), '好的');
writeFileSync(join(bad, 'user_message_v8.1.0.md'), '{{USER_INSTRUCTION}}');
writeFileSync(join(bad, 'fewshot_v8.1.0.json'), '{"pairs": [{"name": "a", "user": 3, "assistant": {}}]}');
writeFileSync(join(bad, 'system_v8.2.0.md'), '好的');
writeFileSync(join(bad, 'user_message_v8.2.0.md'), '{{USER_INSTRUCTION}} {{FOO}}');
writeFileSync(join(bad, 'fewshot_v8.2.0.json'), '{"pairs": [{"user": "u", "assistant": {"b": 1.0, "a": [2, 3.50, "x"], "10": 1, "2": 2}}, 5, {"name": 7, "user": "v", "assistant": null}], "pairs": []}');
writeFileSync(join(bad, 'system_v8.3.0.md'), '账号 DU7654321');
writeFileSync(join(bad, 'user_message_v8.3.0.md'), 'x');
writeFileSync(join(bad, 'system_v8.4.0.md'), '第一行\r\n第二行\r第三行 {{MAX_MKT_SHARES}}\r\n');
writeFileSync(join(bad, 'user_message_v8.4.0.md'), '指令:\r\n{{USER_INSTRUCTION}}\r结尾');
out.bad = [];
const BAD = '<BAD>';
for (const version of ['v8.0.0', 'v8.1.0', 'v8.2.0', 'v8.3.0', 'v8.4.0']) {
  const settings = settingsOf({ prompt_version: version }, bad);
  const res = run(() => P.loadPromptBundle(settings));
  const entry = { version, ...(res.error ? { error: res.error.split(bad).join(BAD) } : { out: { fingerprint: P.fingerprint(res.out), system: res.out.system_text, fewshot: res.out.fewshot.map((p) => ({ name: p.name, user: p.user, assistant: JSON.stringify(p.assistant) })) } }) };
  if (res.out) entry.user = run(() => P.renderUser(res.out, settings, 'hi', moments[0]));
  out.bad.push(entry);
}
// 坏目录的内容也写进夹具,C++ 那边照样摆出来
out.badFiles = Object.fromEntries(readdirSync(bad).filter((f) => f.includes('v8.')).map((f) => [f, readFileSync(join(bad, f), 'utf8')]));
out.config = golden.base_config;
writeFileSync(join(here, 'prompts.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('prompts.json', `bundles=${out.bundles.length} users=${out.users.length} bad=${out.bad.length}`);
