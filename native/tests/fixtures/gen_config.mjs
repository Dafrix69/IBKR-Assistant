// 生成 config.json:engine-ts/src/config.ts(原模块现跑)在一大把配置上的结果——fromDict 的每一种校验错误(原话)、
// 读进来之后的整份 Settings 与它的方法(limitsFor / marketStatus / accountBroker…)、loadSettings 的三种错、patchConfigFile 与 .bak、
// deepMerge、parseTradingHours / hoursStatus、validateBaseUrl(WHATWG URL 的怪处:127.1、0x7f000001、末尾的点)、latestPromptVersion。
// 配置文本里的 <PROMPTS> / <EMPTY> 是两边各自建的临时提示词目录;家目录在输出里写成 <HOME>,默认提示词目录写成 <DEFAULT>。
//   node native/tests/fixtures/gen_config.mjs <编过的 engine-ts 目录>
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);
const { builtinCalendar } = await import(pathToFileURL(join(engine, 'dist/src/marketCalendar.js')).href);
const base = JSON.parse(readFileSync(join(engine, 'baseline/rpc/base_config.json'), 'utf8'));
const builtin = builtinCalendar();

// 提示词目录:文件名与 C++ 测试里建的一模一样
export const PROMPT_FILES = ['system_v1.0.0.md', 'system_v1.9.3.md', 'system_v1.10.0.md', 'system_v2.0.md', 'system_v1.10.0.md.bak', 'readme.md', 'system_v0.99.1.md'];
const prompts = mkdtempSync(join(tmpdir(), 'cfg-p-'));
for (const f of PROMPT_FILES) writeFileSync(join(prompts, f), 'x');
const empty = mkdtempSync(join(tmpdir(), 'cfg-e-'));
const loadDir = mkdtempSync(join(tmpdir(), 'cfg-l-'));
const subst = (text) => text.replaceAll('<PROMPTS>', prompts.replaceAll('\\', '\\\\')).replaceAll('<EMPTY>', empty.replaceAll('\\', '\\\\'));
const mask = (s) => (typeof s !== 'string' ? s : s.replaceAll(prompts, '<PROMPTS>').replaceAll(empty, '<EMPTY>').replaceAll(C.DEFAULT_PROMPT_DIR, '<DEFAULT>').replaceAll(homedir(), '<HOME>').replaceAll(loadDir, '<DIR>'));
const err = (e) => ({ error: mask(e.message) });

const INSTANTS = ['2026-08-14T03:59:59-04:00', '2026-08-14T04:00:00-04:00', '2026-08-14T09:29:59-04:00', '2026-08-14T09:30:00-04:00', '2026-08-14T15:59:59-04:00',
  '2026-08-14T16:00:00-04:00', '2026-08-14T19:59:59-04:00', '2026-08-14T20:00:00-04:00', '2026-08-15T12:00:00-04:00', '2026-09-07T12:00:00-04:00',
  '2026-11-27T12:59:00-05:00', '2026-11-27T13:00:00-05:00', '2026-12-31T12:00:00-05:00', '2026-01-02T12:00:00-05:00', '2026-05-07T10:00:00-04:00', '2027-01-01T12:00:00-05:00', '2026-03-08T03:30:00-04:00'].map((s) => Date.parse(s));

function dump(s) {
  const extra = (list, b) => list.filter((d) => !b.includes(d));
  const aliases = [...s.aliasList(), 'DEFAULT', 'nobody', 'toString'];
  return {
    prompt_version: s.prompt_version, prompt_follows_latest: s.prompt_follows_latest, prompt_dir: mask(s.prompt_dir),
    llm: s.llm, broker: s.broker, limits: s.limits, policies: s.policies, protections: s.protections, risk_budget: s.risk_budget, follow: s.follow,
    accounts: s.accounts, connections: s.connections, symbol_aliases: s.symbol_aliases, index_symbols: s.index_symbols,
    holidays: [s.market_holidays.length, extra(s.market_holidays, builtin.holidays)], early: [s.early_close_days.length, extra(s.early_close_days, builtin.earlyCloses)],
    db_path: mask(s.db_path), source_path: mask(s.source_path), config_warnings: s.config_warnings, paper_flag_missing: s.paper_flag_missing,
    limitsFor: aliases.map((a) => s.limitsFor(a)),
    byAlias: aliases.map((a) => s.accountByAlias(a)?.alias ?? null),
    defaultAccount: s.defaultAccount()?.alias ?? null,
    connectionsFor: [Object.keys(s.connectionsFor()), Object.keys(s.connectionsFor('futu')), Object.keys(s.connectionsFor('ibkr'))],
    accountBroker: s.accounts.map((a) => s.accountBroker(a) ?? null),
    promptAccountTable: s.promptAccountTable(), promptSymbolTable: s.promptSymbolTable(),
    status: INSTANTS.map((ms) => s.marketStatus(C.etNowFromEpoch(ms))),
    indexConfig: ['spx', 'SPX', 'ndx'].map((x) => s.indexConfig(x)),
  };
}

// ---- fromDict:基础配置上逐条改一处(路径 → 值;undefined = 删掉这一键),外加几份整段原文
const set = (obj, path, value) => {
  const out = structuredClone(obj);
  let cur = out;
  for (const k of path.slice(0, -1)) { if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
  if (value === undefined) delete cur[path.at(-1)]; else cur[path.at(-1)] = value;
  return out;
};
const M = [];
const m = (path, ...values) => { for (const v of values) M.push([path, v]); };
m(['llm'], {}, null, 5, 'ab', true, [], { foo: 1, Bar: 2, model: 'x' });
m(['llm', 'provider'], 'openai_compatible', 'toString', 'constructor', 5, 'x', null);
m(['llm', 'effort'], 'ultra', 5, 'max', null);
m(['llm', 'temperature'], '0.5', 'abc', 3, true, -0.1, 2, 0, '1e0', '.5', '5.', ' 1 ', '');
m(['llm', 'max_tokens'], 999, '8000.5', 8000.7, '1e4', '+9000', '-1', 1e21, 1e400, -1e400);
m(['llm', 'timeout_s'], '1e2', 0.5, '0.99', '1.', 'abc', []);
m(['llm', 'model'], '', null, 5, ['a', 'b']);
m(['llm', 'keychain_account'], '', 'me');
m(['llm', 'keychain_service'], null, 0);
for (const [prov, url] of [['openai_compatible', undefined], ['openai_compatible', ''], ['openai_compatible', 'http://example.com'], ['openai_compatible', 'https://api.x.com/v1///'],
  ['openai_compatible', 'http://localhost:8080'], ['openai_compatible', 'ftp://x'], ['openai_compatible', '  https://ok.example  '], ['openai_compatible', 'http://127.1'],
  ['anthropic', 'http://example.com'], ['openai_compatible', 5]]) M.push([['llm'], { provider: prov, base_url: url, model: 'm1' }]);
M.push([['llm'], { provider: 'toString', model: 'm' }]);
const LIM = ['max_order_notional', 'max_option_contracts', 'max_mkt_shares', 'min_confidence', 'max_spread_slippage', 'max_orders_per_input', 'duplicate_window_minutes',
  'duplicate_qty_tolerance', 'max_open_risk_usd', 'max_underlying_contracts', 'auto_mid_spread_share'];
for (const k of LIM) m(['limits', k], 0, -1, '-0.5', 1.5, 2.5, '3', ' 4 ', '0x10', '1e3', null, true, {}, 1e400, '');
m(['limits', 'max_order_notional'], 0.001, 0.01, '.5e1');
m(['limits', 'foo'], 1);
m(['limits'], 'ab', 5, [], null);
m(['limits', 'by_account'], { 模拟: { max_order_notional: 100 } }, null, 'x', [], { a: null }, { a: 5 }, { a: [] }, { a: { foo: 1, bar: 2 } },
  { a: { max_option_contracts: null, max_mkt_shares: '3' } }, { a: {} }, { a: { max_open_risk_usd: -1 } }, { a: { max_underlying_contracts: 0, max_open_risk_usd: '0' } },
  { 主账户: { max_option_contracts: 2.9, max_mkt_shares: 7 }, 模拟: { max_order_notional: '12.5', max_open_risk_usd: 300, max_underlying_contracts: 4 } }, { toString: { max_mkt_shares: 3 } });
m(['policies', 'closed_market_policy'], 'x', 5, 'allow', 'reject_all', null);
m(['policies', 'auto_execute'], 'true', 1, true, null);
m(['policies', 'auto_outside_rth'], false, 'no');
m(['policies', 'trigger_min_gap_bps'], -1, '2.5');
m(['policies', 'consecutive_failure_breaker'], 0, 1, '2');
m(['policies', 'allow_combo_live'], true);
m(['policies', 'review_feature_enabled'], true);
m(['policies', 'zzz'], 1);
m(['policies'], 5, 'x', null, {});
m(['protections'], { stoploss_guard: { enabled: true, trigger_count: 2 } }, { cooldown: 5 }, { cooldown: { scope: 'position', minutes: '15' } }, { cooldown: { scope: 'x' } },
  { daily_loss: { basis: 'account', max_loss_usd: '250.5', enabled: true } }, { daily_loss: { basis: 5 } }, { max_drawdown: { max_drawdown_usd: -1 } },
  { max_drawdown: { lookback_minutes: 0 } }, { foo: {} }, { stoploss_guard: { x: 1 } }, 'ab', null, { stoploss_guard: null });
m(['risk_budget'], { enabled: true, equity_usd: { 模拟: 10000, 主账户: '25000.5' } }, { equity_usd: [] }, { equity_usd: 'x' }, { equity_usd: null }, { equity_usd: { a: -1 } },
  { max_risk_pct: 0.05 }, { max_risk_pct: 101 }, { max_position_pct: 1001 }, { max_position_pct: '1000' }, { x: 1 }, { enabled: 'yes' });
m(['follow'], { enabled: true, channel_id: '123456789012345678', author_ids: ['local:Charlie', '123456789012345', 'local:Charlie', ' 222222222222222 '], accounts: ['模拟', ' 模拟 '] },
  { channel_id: 123 }, { channel_id: ' 123456789012345678 ' }, { channel_id: 'abc' }, { channel_id: null }, { channel_id: '' },
  { author_ids: 'x' }, { author_ids: [5] }, { author_ids: ['local:'] }, { author_ids: ['local:' + 'x'.repeat(80)] }, { author_ids: ['local:' + 'x'.repeat(81)] },
  { author_ids: ['local:a\nb'] }, { author_ids: ['local:😀'.padEnd(86, '😀')] }, { author_ids: null },
  { accounts: [''] }, { accounts: [5] }, { accounts: 'x' }, { max_age_seconds: 0 }, { max_age_seconds: 601 }, { max_age_seconds: 600 }, { max_orders_per_day: 101 },
  { max_risk_usd: 0.5 }, { max_risk_usd: '1.0' }, { local_channel: 'x\ny' }, { local_channel: 'x'.repeat(101) }, { local_channel: ' ' + 'x'.repeat(100) + ' ' }, { local_channel: 5 },
  { local_channel: '  Charlie 的频道 ' }, { track_exit_at: '15:45' }, { track_exit_at: '24:00' }, { track_exit_at: '9:05' }, { track_exit_at: '' }, { track_exit_at: 5 },
  { track_exit_at: ' 15:45 ' }, { track_exit_at: '15:60' }, { track_exit_at: '015:45' }, { track_exit_at: '15:4' }, { track_exit_at: null }, { track_fly: 'true' }, { local_inbox: true }, { zz: 1 });
m(['broker'], { provider: 'futu' }, { provider: 'x' }, { auto_connect: 'yes' }, { auto_connect: false }, { auto_connect: null }, { futu: { trd_market: 'hk' } }, { futu: { trd_market: 'JP' } },
  { futu: { security_firm: 'futuinc' } }, { futu: { security_firm: 'x' } }, { futu: { symbol_map: { 'aapl ': ' US.AAPL ', ß: 'x' } } }, { futu: { symbol_map: { x: '' } } },
  { futu: { symbol_map: 'ab' } }, { futu: { symbol_map: { a: null } } }, { futu: { zz: 1 } }, { futu: null }, { zz: 1 }, 5, { futu: { keychain_account: '', keychain_service: 'svc' } });
m(['connections', 'paper', 'host'], '192.168.1.2', 'localhost', '::1', 5, null);
m(['connections', 'paper', 'broker'], 'futu', 5, 'ibkr', null);
m(['connections', 'paper', 'port'], '7497', 'abc', [7497], [1, 2], 1.9, true, null, '', ' 12 ', {});
m(['connections', 'paper', 'client_id'], 1.9, '-3.5', null);
m(['connections', 'paper', 'readonly'], 'false', 0, '', 1, []);
m(['connections', 'paper'], null, {});
m(['connections'], 'ab', [], {}, null, { paper: { port: 1 }, live: { port: 2 }, f: { broker: 'futu' } });
const acct = (over) => [{ ...base.accounts[0], ...over }, base.accounts[1]];
M.push([['accounts'], [base.accounts[0], { ...base.accounts[1], alias: '模拟' }]]);
for (const over of [{ alias: 'DEFAULT' }, { default: false }, { is_paper: 'TRUE' }, { is_paper: ' false ' }, { is_paper: 'yes' }, { is_paper: 1 }, { is_paper: null },
  { is_paper: undefined }, { account_id: 'U999', is_paper: true }, { account_id: 'df123' }, { connection: 'nowhere' }, { connection: undefined }, { connection: 'constructor' },
  { default: 'false' }, { default: 0 }, { alias: 5 }, { alias: undefined }]) M.push([['accounts'], acct(over)]);
M.push([['accounts'], [base.accounts[0], { ...base.accounts[1], default: true }]]);
m(['accounts'], 'x', 5, {}, [null], [5], ['ab'], [[]], [], null);
M.push([['accounts'], [{ alias: 'F', account_id: '12345', is_paper: true, connection: 'f', default: true }], ['connections', 'f'], { broker: 'futu' }]);
m(['index_symbols'], { spx: {} }, { NDX: { futures: '' } }, { SPX: { futures: '' } }, { SPX: null }, 'ab', { SPX: { exchange: 5, futures: null } }, { NDX: { futures: 'NQ', futures_exchange: null } }, null);
m(['symbol_aliases'], { 苹果: 'aapl', x: 5, y: null, z: { a: 1 }, w: [1, 2], ß: 'straße' }, 'ab', {}, null);
m(['market_calendar'], 'config_only', 'x', 5, null);
m(['market_holidays'], '2026', '😀a😀', 5, ['2026-12-31', '2026-09-07', '2026-12-31'], [], null, {});
m(['early_close_days'], ['2027-07-02'], true);
m(['market_holidays'], [20260102, ['2026-01-02'], '2026-05-07', 5, '5', true, null, {}, ['a'], '2026-05-07', 5]);
m(['early_close_days'], [['2026-05-07'], '2026-05-07']);
M.push([['market_calendar'], 'config_only', ['market_holidays'], ['2026-12-31']]);
m(['storage'], { db_path: '~/x.db' }, { db_path: '~' }, { db_path: '~\\x' }, { db_path: '/abs/t.db' }, { db_path: '' }, { db_path: 0 }, 'ab', null, { db_path: '~x' });
m(['prompt_version'], 'latest', 'v9.9.9', 5, null);
M.push([['prompt_version'], 'latest', ['prompt_dir'], '<PROMPTS>']);
M.push([['prompt_version'], 'latest', ['prompt_dir'], '<EMPTY>']);
M.push([['prompt_version'], 'latest', ['prompt_dir'], '<PROMPTS>/nope']);
m(['prompt_dir'], '', 0, '<PROMPTS>');
m(['unknown_top'], 1);

const caseTexts = [];
for (const entry of M) {
  let cfg = base;
  for (let i = 0; i < entry.length; i += 2) cfg = set(cfg, entry[i], entry[i + 1]);
  caseTexts.push(JSON.stringify(cfg));
}
// 整段原文:重复的键、像下标的键(JS 排到最前)、空配置
caseTexts.push('{}');
caseTexts.push('{"accounts":[{"alias":"a","account_id":"DU1","is_paper":true,"default":true,"connection":"paper"},{"alias":"a","account_id":"DU2","is_paper":true}],"connections":{"paper":{}}}');
caseTexts.push('{"symbol_aliases":{"10":"x","2":"y","b":"z","a":"w","01":"v"},"connections":{"live":{"port":7496},"7":{"port":1},"paper":{}},"accounts":[{"alias":"a","account_id":"DU1","is_paper":true,"default":true,"connection":"7"}]}');
caseTexts.push('{"llm":{"model":"a","model":"b"},"limits":{"max_mkt_shares":5,"max_mkt_shares":"x"}}');
caseTexts.push('{"limits":{"b":1,"a":2,"10":3,"2":4}}');
caseTexts.push('{"index_symbols":{"spx":{"futures":"ES1"},"SPX":{"exchange":"X"}}}');
caseTexts.push('{"connections":{"a":{"host":"10.0.0.1"},"b":{"broker":"x"}}}');
caseTexts.push('{"connections":{"a":{"broker":"x"},"b":{"host":"10.0.0.1"}}}');
caseTexts.push('{"accounts":[{"alias":"x","account_id":"DU1","is_paper":"maybe"}],"connections":{"q":{"broker":"bad"}}}');

const fromDictCases = caseTexts.map((text) => {
  try { return { text, out: dump(C.fromDict(JSON.parse(subst(text)), '/cfg/settings.json')) }; } catch (e) { return { text, ...err(e) }; }
});

// ---- loadSettings:不在、不是 JSON、顶层不是对象、校验不过、好的
const dir = loadDir;
const loadCases = [null, '', '{', 'not json', '\ufeff{}', '{"a":1,}', '{\r\n  "a": 1\r\n  "b": 2\r\n}', '[]', '5', 'null', '"x"', '{"limits":{"max_mkt_shares":0}}', JSON.stringify(base)].map((text, i) => {
  const p = join(dir, `s${i}.json`);
  if (text !== null) writeFileSync(p, text);
  try { C.loadSettings(p); return { text, ok: true }; } catch (e) { return { text, kind: e.kind, path: e.path === p, message: e.message.replaceAll(p, '<P>') }; }
});

// ---- deepMerge 与 patchConfigFile(写盘的文本、.bak 的文本、返回的 Settings 或错)
const merges = [[{ a: 1, b: { c: 1, d: [1] } }, { b: { c: 2, e: null }, f: [] }], [{ a: { b: 1 } }, { a: null }], [{ a: null }, { a: { b: 1 } }], [{ a: [1, 2] }, { a: { 0: 9 } }],
  [{ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }], [{ x: 1, y: 2 }, { y: 3, x: 4, z: 5 }], [{ a: 'str' }, { a: { b: 1 } }]].map(([b, p]) => ({ base: b, patch: p, out: C.deepMerge(b, p) }));
const patches = [{ limits: { max_mkt_shares: 300 } }, { limits: { max_mkt_shares: 0 } }, { accounts: [] }, { llm: { model: 'claude-x', temperature: 0.5 } }, { policies: { auto_execute: true }, extra: { z: 1 } },
  { connections: { live: null } }, { symbol_aliases: { 苹果: 'AAPL', 新: 'NEW' } }];
const original = JSON.stringify(base, null, 4);
const patchCases = patches.map((patch, i) => {
  const p = join(dir, `patch-${i}.json`);
  writeFileSync(p, original);
  let res;
  try { res = { out: dump(C.patchConfigFile(p, patch)) }; } catch (e) { res = err(e); }
  return { patch, ...res, file: readFileSync(p, 'utf8'), bak: existsSync(`${p}.bak`) ? readFileSync(`${p}.bak`, 'utf8') : null };
});
let nullPath;
try { C.patchConfigFile(null, {}); } catch (e) { nullPath = e.message; }

// ---- 交易时段、base_url、提示词版本、~
const hourSpecs = ['20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED', '', '20260904:0930-1600', '20260904:0930-20260904:0930', '20260904:1600-20260904:0930',
  '2026090:0930-20260904:1600', '20260904:093-20260904:1600', '20261304:0930-20260904:1600', '20260932:0930-20261004:1600', '20260904:2400-20260905:0100', '20260904:2359-20260905:0000',
  ' 20260904:0930 - 20260904:1600 ; ; 20260905:CLOSED ', '20260904:0930', '20260904-20260905', '20260931:0930-20261001:1000', '20260904:0930-20260904:1600:00', 'abc;def-ghi',
  '20260904:0930-20260904:1600;20260904:1700-20260904:1800'];
const hours = hourSpecs.map((spec) => ({ spec, out: C.parseTradingHours(spec) }));
const statusCases = [];
const liquid = ['', '20260904:0830-20260904:1500', 'garbage'];
for (const [spec, tz] of [[hourSpecs[0], 'US/Central'], [hourSpecs[0], 'America/New_York'], [hourSpecs[0], ''], ['', 'US/Central'], [hourSpecs[0], 'Not/AZone'], ['20260905:CLOSED', 'US/Central'], ['abc', 'US/Central']]) {
  for (const liq of liquid) for (const iso of ['2026-09-03T20:14:00-05:00', '2026-09-03T20:15:00-05:00', '2026-09-04T08:26:00-05:00', '2026-09-04T08:31:00-05:00', '2026-09-04T14:59:59-05:00', '2026-09-04T15:00:00-05:00', '2026-09-05T10:00:00-05:00'])
    statusCases.push({ spec, tz, liquid: liq, ms: Date.parse(iso), out: C.hoursStatus(spec, tz, Date.parse(iso), liq) });
}
statusCases.push({ spec: hourSpecs[0], tz: 'US/Central', liquid: null, ms: Date.parse('2026-09-04T09:00:00-05:00'), out: C.hoursStatus(hourSpecs[0], 'US/Central', Date.parse('2026-09-04T09:00:00-05:00'), null) });
const URLS = ['', '   ', '/', 'http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://0177.0.0.1', 'http://127.0.0.1.', 'http://[0:0::1]:80/', 'http://[::1]', 'http://[::1]:8080/v1',
  'https://', 'http://LOCALHOST.', 'http://LocalHost:11434/', 'https://a b', 'http:localhost', 'https:\\\\x.com', 'HTTP://localhost', 'http://127.0.0.1:99999', 'http://127.0.0.1:65535',
  'https://1.2.3.256', 'https://a.1', 'https://1.2.3.4.5', 'https://0x', 'https://09.1', 'http://user@localhost', 'http://user:pw@127.0.0.1:1/', 'https://xn--', 'https://例子.com',
  'http://[::ffff:127.0.0.1]', 'http://[::1%25eth0]', 'http://[zz]', 'https://host:abc', 'https://host:', 'http://localhost:/', 'http://ｌｏｃａｌｈｏｓｔ', 'https://a%20b',
  'http://local%68ost', 'https://a<b', 'https://a^b', 'https://a|b', 'https://ok.example/path?q=1#f', 'http:/\\/localhost', 'http:///localhost', 'mailto:x@y', 'javascript:alert(1)',
  'ws://localhost', 'file:///tmp', '127.0.0.1:8080', 'localhost:11434', 'https://@host', 'http://@localhost', 'https://host#', 'http://localhost?x', 'http://\tlocal\nhost', 'http://::1',
  'https://[::1]', 'https://api.openai.com/v1', 'https://.', 'https://..', 'http://127.0.0.1.0', 'https://999999999999', 'http://4294967295', 'https://4294967296', 'http://0x7f.1', 'https://1..2',
  'https://a..b', 'https://-a.com', 'https://a_b.com', 'https://a.b.c.d.e.f', 'http://[::]', 'http://[::0:1]', 'http://[0000:0000:0000:0000:0000:0000:0000:0001]', 'http://[1::1::1]',
  // validateBaseUrl 与实际连接共用 util::whatwg 之后补的:punycode 不合法的主机(旧解析器放行、TS 拒)、反斜杠 / @ / ? / # 夹带第二个主机、IPv6 的压缩写法、控制符
  'http://xn--a', 'https://xn--a', 'http://xn--mnchen-3ya.de', 'https://XN--MNCHEN-3YA.de/v1', 'https://xn--mnchen-3ya', 'http://127.0.0.1:1\\@localhost:2', 'http://127.0.0.1\\@evil.com', 'http://127.0.0.1:1?@evil.com',
  'http://127.0.0.1#@evil.com', 'http://127.0.0.1@evil.com', 'http://evil.com\\@127.0.0.1', 'http://[1:0:3:4:5:6:7:8]', 'http://[1:0:0:2:0:0:3:4]', 'https://[::ffff:7f00:1]', 'http://[::ffff:7f00:1]', 'http://a\u0001b', 'https://a\u007fb',
  'https://api.example.com~x/', 'http://localhost\\@evil.com', 'http://LOCALHOST:1/v1/', 'http://127.0.0.2', 'http://127.0.0.1:0', 'http://0.0.0.0'];
const urls = URLS.map((u) => { try { return { url: u, ok: C.validateBaseUrl(u) }; } catch (e) { return { url: u, error: e.message }; } });
const latest = [prompts, empty, join(prompts, 'nope')].map((d) => mask(C.latestPromptVersion(d)));
const homes = ['~', '~/a/b', '~\\a', '~a', '/~', '', 'a/~', '~/', '~/a/../b', '~/./x//y/', '~/../..', '~/../../../etc', '~/a/b/..', '~\\a\\b'].map((p) => ({ p, out: mask(C.expandHome(p)) }));
const etNow = INSTANTS.map((ms) => ({ ms, out: C.etNowFromEpoch(ms) }));

writeFileSync(join(here, 'config.json'), JSON.stringify({ promptFiles: PROMPT_FILES, base, fromDict: fromDictCases, load: loadCases, merges, original, patches: patchCases, nullPath,
  hours, status: statusCases, urls, latest, homes, etNow, defaults: { exitConfig: C.EXIT_CONFIG, backup: C.configBackupPath('/a/b.json'), brokers: C.BROKER_PROVIDERS, ports: C.DEFAULT_BROKER_PORT } }, null, 1) + '\n');
console.log('fromDict', fromDictCases.length, 'errors', fromDictCases.filter((c) => c.error).length, 'urls', urls.length, 'patches', patchCases.length);
