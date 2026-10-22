// 生成 accounts-setup.json:账户设置(desktop/accounts-setup.js)对一组改动现算的结果——改完的配置(JSON.stringify 2 格)、
// 确认框上的话、或者拒绝的那句;外加 placeholderAliases / connectionChoices。
//   node native/tests/fixtures/gen_accounts_setup.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const A = createRequire(import.meta.url)(join(here, '..', '..', '..', 'desktop/accounts-setup.js'));
const base = {
  version: 3,
  connections: { paper: { host: '127.0.0.1', port: 7497, client_id: 11 }, live: { port: 7496 }, futu: { broker: 'futu', port: 11111 }, broken: 'x' },
  accounts: [
    { alias: '模拟', account_id: 'DU1234567', is_paper: true, connection: 'paper', default: true, note: '留着的字段' },
    { alias: '实盘', account_id: 'U7654321', is_paper: false, connection: 'live' },
    'not-an-object',
    { alias: '占位', account_id: 'U0000000', is_paper: true, connection: 'paper' },
  ],
  policies: { auto_execute: false },
};
const changes = [
  { action: 'upsert', alias: '新户', account_id: 'DU7777777', is_paper: true, connection: 'paper' },
  { action: 'upsert', alias: '新户', account_id: 'DU7777777', is_paper: true, connection: 'paper', make_default: true },
  { action: 'upsert', alias: '实盘', account_id: 'U7654322', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: '实盘', account_id: 'DU7654321', is_paper: true, connection: 'paper' },
  { action: 'upsert', alias: ' 模拟 ', account_id: ' DU1234567 ', is_paper: true, connection: 'paper' },
  { action: 'upsert', alias: '富途', account_id: '28190044', is_paper: true, connection: 'futu' },
  { action: 'upsert', alias: '错标', account_id: 'U1111111', is_paper: true, connection: 'paper' },
  { action: 'upsert', alias: '撞号', account_id: 'U7654321', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: 'x', account_id: 'ABCD1234', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: 'x', account_id: 'U123', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: 'x', account_id: 'U1234567', is_paper: 'yes', connection: 'live' },
  { action: 'upsert', alias: 'x', account_id: 'U1234568', is_paper: false, connection: 'nope' },
  { action: 'upsert', alias: 'x', account_id: 'U1234568', is_paper: false, connection: '__proto__' },
  { action: 'upsert', alias: 'x', account_id: 'U1234568', is_paper: false, connection: 'broken' },
  { action: 'upsert', alias: 'default', account_id: 'U1234568', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: '', account_id: 'U1234568' },
  { action: 'upsert', alias: '名'.repeat(25), account_id: 'U1234568' },
  { action: 'upsert', alias: '😀'.repeat(24), account_id: 'U1234568', is_paper: false, connection: 'live' },
  { action: 'upsert', alias: 'a"b', account_id: 'U1234568' },
  { action: 'upsert', alias: 'a\tb', account_id: 'U1234568' },
  { action: 'upsert', alias: 42, account_id: 12345678, is_paper: false, connection: 'live' },
  { action: 'remove', alias: '模拟' },
  { action: 'remove', alias: '实盘' },
  { action: 'remove', alias: '没有' },
  { action: 'rename', alias: '模拟' },
  null,
];
const cases = changes.map((change) => {
  try {
    const r = A.applyChange(JSON.parse(JSON.stringify(base)), change);
    return { change, ok: true, headline: r.headline, lines: r.lines, config: JSON.stringify(r.config, null, 2) };
  } catch (err) {
    return { change, ok: false, error: String(err.message) };
  }
});
// 删到一个不剩
const solo = { connections: { paper: { port: 7497 } }, accounts: [{ alias: '唯一', account_id: 'DU1', is_paper: true, connection: 'paper', default: true }] };
const r = A.applyChange(solo, { action: 'remove', alias: '唯一' });
cases.push({ base: solo, change: { action: 'remove', alias: '唯一' }, ok: true, headline: r.headline, lines: r.lines, config: JSON.stringify(r.config, null, 2) });
// 配置里没有 accounts:加在最后
const bare = { connections: { live: { port: 7496 } } };
const r2 = A.applyChange(bare, { action: 'upsert', alias: '甲', account_id: 'U12345678', is_paper: false, connection: 'live' });
cases.push({ base: bare, change: { action: 'upsert', alias: '甲', account_id: 'U12345678', is_paper: false, connection: 'live' }, ok: true, headline: r2.headline, lines: r2.lines, config: JSON.stringify(r2.config, null, 2) });
cases.push({ base: [1], change: { action: 'remove', alias: 'x' }, ok: false, error: (() => { try { A.applyChange([1], {}); } catch (e) { return e.message; } })() });
writeFileSync(join(here, 'accounts-setup.json'), JSON.stringify({ generator: 'gen_accounts_setup.mjs', aliasMax: A.ALIAS_MAX, base, cases,
  placeholders: A.placeholderAliases(base), choices: A.connectionChoices(base) }, null, 1) + '\n');
console.log(`accounts-setup.json: ${cases.length} cases`);
