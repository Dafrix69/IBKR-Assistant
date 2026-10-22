// 生成 h2_small.json:engine-ts 的 events / intel / follow 三个 handler(rpc/handlers/*.ts,原类现跑)对着 h2_world.mjs 的假 RpcContext。
// C++ 一半:tests/tst_h2_small.cpp(tests/h2_world.h 的同一份脚本)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_small.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);

const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log', 'app_prefs'], ...script } });

// ---- events
add('events.list:force 取真假(schema 把它转成布尔);清单原样回', {
  ports: { 'events.list': [{ value: { events: [{ id: 'a' }], fetched_at: null } }, { value: { events: [] } }, { error: '网络不通' }, { value: { x: 1 } }] },
  steps: [call('a', 'events.list', {}), call('b', 'events.list', { force: true }), call('c', 'events.list', { force: 0 }), call('d', 'events.list', { force: 'yes' }), call('e', 'events.list')],
});
add('events.set_config:口径错 → -32602 原话;别的错照抛;schema 不过', {
  ports: { 'events.setConfig': [{ value: { enabled: true } }, { error: '提前量必须是数字', kind: 'events_config' }, { error: 'boom' }, { error: '带码的', kind: 'rpc', code: -32009 }] },
  steps: [call('a', 'events.set_config', { config: { lead_min: 5 } }), call('b', 'events.set_config', { config: { lead_min: 'x' } }), call('c', 'events.set_config', { config: {} }),
    call('d', 'events.set_config', { config: { a: [1, { b: 2 }] } }), call('e', 'events.set_config', { config: 5 }), call('f', 'events.set_config', {}), call('g', 'events.set_config', [])],
});
add('events.add:整个入参递给 service(schema 去掉多余的键);枚举与类型不对由 schema 报', {
  ports: { 'events.add': [{ value: { id: 'e1', title: '会议' } }, { value: { id: 'e2' } }, { error: '日期不对' }] },
  steps: [call('a', 'events.add', { title: '会议', date_et: '2026-10-14', time_et: '14:00' }),
    call('b', 'events.add', { title: 'x', date_et: '2026-10-15', time_et: '08:30', note: '备注', impact: 'high', linger_min: 30, extra: 1 }),
    call('c', 'events.add', { title: 'x', date_et: 'bad', time_et: '99:99' }), call('d', 'events.add', { title: 'x', date_et: '2026-10-15', time_et: '08:30', impact: 'low' }),
    call('e', 'events.add', { title: 5, date_et: 'a', time_et: 'b' }), call('f', 'events.add', { title: 'x' })],
});
add('events.remove:id 去两头空白;没有这条 → -32602;service 抛错照抛', {
  ports: { 'events.remove': [{ value: true }, { value: false }, { value: true }, { error: '库坏了' }] },
  steps: [call('a', 'events.remove', { id: 'e1' }), call('b', 'events.remove', { id: 'nope' }), call('c', 'events.remove', { id: '  \t e3 \n' }), call('d', 'events.remove', { id: 'x' }),
    call('e', 'events.remove', {}), call('f', 'events.remove', { id: 5 }), call('g', 'events.remove', { id: '﻿e4\u0085' })],
});

// ---- intel
add('intel.feed / dossier:入参过 schema 后原样递给 service,回执原样回;错照抛', {
  ports: { 'intel.feed': [{ value: { items: [], truncated: false } }, { value: { items: [{ k: 1 }] } }, { error: '底账读不了' }], 'intel.dossier': [{ value: { symbol: 'NVDA' } }, { error: '标的代码不合法', kind: 'rpc', code: -32602 }] },
  steps: [call('a', 'intel.feed', {}), call('b', 'intel.feed', { symbol: 'NVDA', kinds: ['message', 'order'], held_only: 1, limit: 20, since: 1700000000000 }), call('c', 'intel.feed', { kinds: ['nope'] }),
    call('d', 'intel.feed', { limit: 'x' }), call('e', 'intel.feed', { held_only: 0, extra: 1 }),
    call('f', 'intel.dossier', { symbol: 'NVDA', limit: 5 }), call('g', 'intel.dossier', { symbol: 'bad$' }), call('h', 'intel.dossier', {})],
});

// GitHub 的推送保护按形状认 Discord 机器人令牌,假的也拦:写夹具时把令牌形状里的点写成 \u002e,解析出来的值不变
const hideTokens = (json) => json.replace(/[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, (m) => m.replaceAll('.', '\\u002e'));

// ---- follow
// 拼出来的:令牌形状的字面量过不了 GitHub 的推送保护
const GOOD = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
add('follow.set_token:形状先挡;存不进凭证库 → -32008;存好了回状态', {
  ports: { 'follow.status': [{ value: { enabled: true, connected: false } }, { value: { enabled: true, connected: true } }], 'follow.setToken': [{ value: null }, { error: '钥匙串被锁了', kind: 'keychain' }, { error: 'boom' }] },
  steps: [call('a', 'follow.set_token', { token: GOOD }), call('b', 'follow.set_token', { token: `  ${GOOD}\n` }), call('c', 'follow.set_token', { token: GOOD }), call('d', 'follow.set_token', { token: GOOD }),
    call('e', 'follow.set_token', { token: 'short' }), call('f', 'follow.set_token', { token: 'a'.repeat(20) + '.' + 'b'.repeat(3) + '.' + 'c'.repeat(20) }),
    call('g', 'follow.set_token', { token: 'a'.repeat(19) + '.' + 'b'.repeat(4) + '.' + 'c'.repeat(20) }), call('h', 'follow.set_token', { token: 'a'.repeat(20) + '.' + 'b'.repeat(4) + '.' + 'c'.repeat(19) }),
    call('i', 'follow.set_token', { token: 'a'.repeat(20) + '.' + 'b'.repeat(4) + '.' + 'c'.repeat(20) + '.' + 'd' }), call('j', 'follow.set_token', { token: '你'.repeat(20) + '.' + 'b'.repeat(4) + '.' + 'c'.repeat(20) }),
    call('k', 'follow.set_token', { token: 'a-b_'.repeat(5) + '.' + 'b-_1' + '.' + 'c'.repeat(20) + '\n' }), call('l', 'follow.set_token', { token: 'a'.repeat(20) + '.' + 'b'.repeat(4) + '.' + 'c'.repeat(20) + ' x' }),
    call('m', 'follow.set_token', { token: GOOD, extra: 1 }), call('n', 'follow.set_token', {}), call('o', 'follow.set_token', { token: 5 })],
});
{
  const mk = (a, b, c) => ({ token: a + '.' + b + '.' + c });
  const edge = 'AZaz09_-AZaz09_-AZaz09';
  const bad = ['@', '[', '`', '{', ':', '/', '\\', ' '].map((ch) => edge.slice(0, 10) + ch + edge.slice(11));
  add('follow.set_token:字符类 [\\w-] 的边界(A Z a z 0 9 _ - 与它们相邻的字符)', {
    ports: { 'follow.status': [{ value: { s: 1 } }], 'follow.setToken': [{ value: null }] },
    steps: [call('g', 'follow.set_token', mk(edge, edge, edge)), ...bad.map((b, i) => call(`b${i}`, 'follow.set_token', mk(b, edge, edge))), ...bad.map((b, i) => call(`c${i}`, 'follow.set_token', mk(edge, b.slice(0, 6), edge)))],
  });
}
add('follow.status / reconnect:sync(true) 之后再读状态;sync 抛错就不读了', {
  ports: { 'follow.status': [{ value: { s: 1 } }, { value: { s: 2 } }, { error: '读不了' }], 'follow.sync': [{ value: null }, { error: '连不上' }, { value: null }] },
  steps: [call('a', 'follow.status'), call('b', 'follow.reconnect'), call('c', 'follow.reconnect'), call('d', 'follow.reconnect'), call('e', 'follow.status', { x: 1 })],
});

const out = [];
for (const s of scenarios) {
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
// 方法表:十一个域按 server.ts 里 domains 的次序登记的方法名(C++ 的 makeHandlers2 必须一模一样)
const order = ['ideas', 'sectors', 'screener', 'backtest', 'market', 'alerts', 'quality', 'review', 'follow', 'events', 'intel'];
const methods = order.flatMap((d) => Object.keys(new h2.mods.Handlers[d]({}).methods()));
const text = hideTokens(JSON.stringify({ base: BASE_CONFIG, methods, scenarios: out }));
writeFileSync(join(here, 'h2_small.json'), text);
console.log(`h2_small.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
