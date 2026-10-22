// 生成 contract.json:engine-ts 的入参 schema 总表(contract/schema/index.ts 的 PARAMS_SCHEMAS)与 rpc/contractMethods.ts,原模块现跑。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_contract.mjs <编过的 engine-ts 目录>
//
// 期望值走的是引擎真正的那条路:contractMethods({[方法]: p => p})[方法](raw)——过了就是解出来的对象(handler 拿到的),
// 不过就是 RpcError(-32602, `${方法} 的参数不对:${describeIssue}`)。另用 schema.safeParse 记下 zod 的 issue 清单(code / path / message)。
// 输入一律先写成 JSON 文本再 JSON.parse(同 server.ts 的读法),所以 1e999 → Infinity、"-0" → -0、重复的键、"__proto__" 这种自有属性
// 都是真的。输入来源:
//   · 手写的合法载荷(每个 schema 若干种,钱路径方法用 tests/tracker-rpc.spec.ts 的界面真实载荷)与 baseline/rpc/requests.json 里的 96 条真请求;
//   · 对每份合法载荷的每一处:删掉、换成各种错类型 / 边界值(null、''、数字串、1e999、-0、嵌套对象……)、在每一层对象里加不认识的键;
//   · 少量两三处同时改的组合;顶层不是对象的各种值。
// 固定种子;同一台机器上跑两次逐字节相同。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (p) => import(pathToFileURL(join(engine, 'dist/src', p)).href);
const { PARAMS_SCHEMAS, contractMethodNames } = await imp('contract/schema/index.js');
const { SENSITIVE_METHODS } = await imp('contract/index.js');
const { contractMethods } = await imp('rpc/contractMethods.js');

let seed = 0x5eed_c0de;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));

// ---------------------------------------------------------------- 合法载荷
const UI = { key: '模拟|BE|STK', take_profit: '', stop_loss: '', trail_pct: '', profit_drawdown_pct: '', spot_target: '', auto_close: false, order_type: 'MKT', host_at_broker: false };
const TRACKER_ADD_FULL = {
  key: '模拟|SPX|BAG', take_profit: '140.5', stop_loss: 95, trail_pct: '8', profit_drawdown_pct: '40', profit_drawdown_preset: 'fly',
  profit_drawdown_tiers: [{ above: '0', pct: '35' }, { above: 2, pct: 25 }, { above: null, pct: null }],
  profit_drawdown_late: { after: '15:30', factor: '0.6' }, profit_drawdown_arm_pct: '50', spot_target: '7650', spot_stop_below: '7600', spot_stop_above: 7700,
  spot_stop_confirm_s: '30', exit_at: '15:45', take_profit_tiers: [{ price: '1.5', fraction_pct: '50' }, { price: 2, fraction_pct: 50 }],
  auto_close: true, order_type: 'LMT', slippage_pct: '0.5', close_fraction_pct: '50', host_at_broker: true, chase_max_pct: '0',
  stop_basis: 'mid', stop_chase_grace: '2', stop_chase_step: 1, stop_chase_max_pct: '10', peak_confirm: true, note: '备注',
};
const TRACKER_UPDATE_FULL = {
  id: 'abc123', enabled: false,
  auto_close: { enabled: true, order_type: 'LMT', slippage_pct: 0.5, close_fraction_pct: 50, host_at_broker: false, chase_max_pct: 5, stop_basis: 'natural',
    stop_chase_grace: null, stop_chase_step: 2, stop_chase_max_pct: null, peak_confirm: true },
  take_profit: '140', stop_loss: '96', trail_pct: '', profit_drawdown_pct: '', spot_target: '', profit_drawdown_preset: 'fly',
  profit_drawdown_tiers: '', profit_drawdown_late: { after: '15:30', factor: 0.5 }, profit_drawdown_arm_pct: 20, spot_stop_below: '', spot_stop_above: null,
  spot_stop_confirm_s: 10, exit_at: '', take_profit_tiers: '',
};
const SEEDS = {
  'alerts.create': [{ symbol: 'AAPL' }, { symbol: 'AAPL', step: 5, origin: 'tracker' }, { symbol: 'AAPL', step: '10', origin: null }],
  'alerts.delete': [{ id: 'w1' }],
  'alerts.refresh': [{ id: 'w1' }, { id: 'w1', expiry: '20261016', step: '5' }, { id: 'w1', expiry: null, step: 2.5 }],
  'alerts.set_touch_config': [{ config: { window: 5, tolerance: 0.2 } }, { config: {}, cross_confirm: 'x' }, { config: { a: [1, { b: null }] }, cross_confirm: null }],
  'book.snapshot': [{ symbol: 'AAPL' }],
  'llm.patch': [{ llm: { model: 'x', temperature: 0.1 } }, {}, { llm: null }],
  'llm.test': [{ llm: { model: 'x' }, api_key: 'sk-test' }, {}, { api_key: '' }],
  'macro.board': [{}, { force: true }, { force: 0 }],
  'events.list': [{}, { force: 1 }, { force: null }],
  'events.set_config': [{ config: { popups: true, nested: { a: 1 } } }],
  'events.add': [{ title: '会', date_et: '2026-10-21', time_et: '14:00' }, { title: 'x', date_et: 'd', time_et: 't', note: 'n', impact: 'high', linger_min: 30 }, { title: 'x', date_et: 'd', time_et: 't', note: null, impact: 'medium', linger_min: null }],
  'events.remove': [{ id: 'e1' }],
  'intel.feed': [{}, { symbol: 'SPX', kinds: ['message', 'signal', 'event', 'order', 'idea'], held_only: 1, limit: 50, since: 1700000000000 }, { symbol: null, kinds: [], held_only: false }],
  'intel.dossier': [{ symbol: 'SPX' }, { symbol: 'SPX', limit: 20 }],
  'backtest.run': [{ symbol: 'AAPL', start: '2025-01-01', end: '2025-06-30', strategy: 'ma_cross' }, { symbol: 'AAPL', start: 's', end: 'e', strategy: 'x', params: { fast: 5 }, rules: { a: 1 }, instrument: 'stock', cost_pct: 0.1 }, { symbol: 'AAPL' }],
  'backtest.sweep': [{ symbols: ['AAPL', 'MSFT'], start: 's', end: 'e', strategy: 'x', grid: { fast: [3, '5', 8], slow: [] }, instrument: null, cost_pct: 1, split_pct: 30, folds: 3, objective: 'sharpe' }, { symbols: [] }],
  'backtest.parse_rules': [{ text: '收盘价上穿 20 日均线买入' }, {}],
  'broker.select': [{ provider: 'ibkr' }, {}, { provider: 5 }],
  'broker.connect': [{}, { connections: ['paper', 'live'] }, { connections: null }],
  'tws.diagnose': [{}, { connections: ['paper'] }],
  'tws.launch': [{ app: 'tws' }, {}],
  'futu.unlock': [{}, { connection: 'futu' }],
  'futu.set_password': [{ password: 'secret', already_md5: false }, { already_md5: true }, {}],
  'follow.set_token': [{ token: 'bot-token' }],
  'ideas.add': [{ text: '想法' }],
  'ideas.list': [{}, { status: 'open', limit: 20 }, { status: null, limit: '50' }],
  'ideas.update': [{ id: 'i1', status: 'done' }, { status: 'done' }, { id: null, status: 's' }],
  'ideas.analyze': [{ id: 'i1' }],
  'ideas.digest': [{}, { scope: 'week', focus: { q: 'AI', symbols: ['NVDA', 'AMD'] }, trades: true }, { focus: null, trades: null }],
  'ideas.digests': [{}, { limit: 5 }, { limit: '5' }],
  'ideas.search': [{ q: 'x' }, { q: 'x', symbols: ['A', 'B'], since: '2026-01-01', until: '2026-02-01', status: 'open', limit: 10 }, { symbols: 'A,B', limit: '3' }],
  'ideas.similar_trades': [
    { sec_type: 'OPT', symbol: 'SPX', action: 'BUY' },
    { sec_type: 'BAG', symbol: 'SPX', action: 'BUY', limit_price: 1.5, expiry: '20261016', right: 'C', combo_strategy: 'fly',
      legs: [{ action: 'BUY', ratio: 1, strike: 7640, right: 'C' }, { action: 'SELL', ratio: 2, strike: null, right: null }] },
    { sec_type: 'OPT', symbol: 'SPX', action: 'SELL', limit_price: null, expiry: null, right: null, combo_strategy: null, legs: [] },
  ],
  'instruction.submit': [{ text: '买入 SPX 7650c' }, { text: 't', execute: true, accounts: ['模拟'], channel: 'discord' }, { execute: 0, accounts: 'x' }, { text: null, accounts: null, channel: null }, {}],
  'options.wall': [{ symbol: 'SPX' }, { symbol: 'SPX', expiry: '20261016', width: '10' }, { symbol: 'SPX', expiry: null, width: 5 }],
  'options.fly_plan': [
    { center: 7650, width: 10, target_spot: 7655, target_time: '15:30' },
    { symbol: 'SPX', expiry: '20261016', center: 7650, width: 10, right: 'C', quantity: 2, cost: 1.5, target_spot: 7655, target_time: '15:30', target_date: '2026-10-16', spot: 7640, iv: 0.2, iv_mode: 'shift', iv_shift_pct: -10 },
    { symbol: null, center: 1, width: 2, target_spot: 3, target_time: 't', iv_mode: 'auto' },
  ],
  'options.iv_recorder_set': [{ enabled: true }, { enabled: false }],
  'options.spot': [{}, { symbol: 'SPX' }, { symbol: null }],
  'options.playbook_set': [{ enabled: true }],
  'pa.analyze': [{ symbol: 'AAPL', timeframe: '5m', rth: true, force: false }, { symbol: 'AAPL' }, { symbol: 'AAPL', timeframe: null, rth: 'x', force: 1 }],
  'pool.set_watch': [{ symbol: 'AAPL' }, { symbol: 'AAPL', price: true, anomaly: false }, { symbol: 'AAPL', price: null, anomaly: null }],
  'quality.add': [{ symbol: 'AAPL' }, { symbol: 'AAPL', note: 'n', company: 'Apple' }, { symbol: 'AAPL', note: null, company: null }],
  'quality.update': [{ id: 'q1' }, { id: 'q1', enabled: false, note: 'n' }, { id: 'q1', enabled: null, note: null }],
  'quality.remove': [{ id: 'q1' }],
  'quality.set_config': [{ config: { window: 5 } }],
  'review.candidates': [{}, { limit: 100, include_local: true }, { limit: '100', include_local: 0 }],
  'review.analyze': [{ id: 'r1' }, { id: 'r1', timeframe: '5m', exit: { a: 1 } }, { id: 'r1', timeframe: null, exit: null }],
  'review.performance': [{}, { scope: 'live', kind: 'butterfly', days: 30 }, { scope: 'paper', kind: 'stock' }, { scope: 'all', kind: 'option', days: null }, { kind: 'all' }],
  'review.signals': [{}, { days: 7 }, { days: null }],
  'screener.rs': [{}, { sector: 's1', benchmark: 'SPY' }, { sector: null, benchmark: null }],
  'screener.inflection': [{ timeframes: ['1d', '1h'] }, { sector: 's', timeframes: [], ma_period: '20' }, { timeframes: 'x', ma_period: 20 }, {}],
  'screener.deviation': [{ symbol: 'AAPL' }, { symbol: 'AAPL', timeframe: '1d', period: 20, lookback: '60', smooth: 3, z_extreme: '2' }, { symbol: 'AAPL', period: null }],
  'screener.leaders': [{}, { sector: 's1', benchmark: 'QQQ' }],
  'sectors.add': [{ name: '半导体' }],
  'sectors.delete': [{ id: 's1' }],
  'sectors.add_stock': [{ id: 's1', symbol: 'NVDA' }, { id: 's1', symbol: 'NVDA', company: 'Nvidia', tag: '龙头' }, { id: 's1', symbol: 'NVDA', company: null, tag: null }],
  'sectors.remove_stock': [{ id: 's1', symbol: 'NVDA' }],
  'sectors.set_tag': [{ id: 's1', symbol: 'NVDA', tag: 't' }, { id: 's1', symbol: 'NVDA' }, { id: 's1', symbol: 'NVDA', tag: null }],
  'settings.patch': [{ patch: { policies: { auto_execute: true }, x: [1, 2] } }, {}, { patch: null }],
  'keychain.set': [{ secret: 'sk', provider: 'openai' }, { secret: 'sk' }, { secret: 'sk', provider: null }],
  'data.export': [{ path: '/tmp/x.json' }],
  'records.list': [{}, { limit: 30 }, { limit: '30' }],
  'records.get': [{ id: 'r1' }, {}, { id: null }],
  'breaker.halt': [{}, { reason: '手动' }, { reason: null }, { reason: '' }],
  'tracker.add': [UI, { ...UI, stop_loss: '95', auto_close: true, order_type: 'LMT', close_fraction_pct: '50', chase_max_pct: '0' }, { ...UI, profit_drawdown_preset: 'fly' },
    { ...UI, profit_drawdown_tiers: [{ above: '0', pct: '35' }, { above: 2, pct: 25 }], profit_drawdown_late: { after: '15:30', factor: '0.6' } },
    { ...UI, close_fraction_pct: undefined, chase_max_pct: undefined, profit_drawdown_preset: undefined },
    { ...UI, stop_loss: '95', note: '长'.repeat(300) }, TRACKER_ADD_FULL, { key: 'k', profit_drawdown_tiers: '', take_profit_tiers: '' }],
  'tracker.update': [{ id: 'abc' }, { id: 'abc', enabled: true }, { id: 'abc', auto_close: { close_fraction_pct: 50 } }, { id: 'abc', auto_close: { order_type: null } },
    { id: 'abc', profit_drawdown_tiers: [{ above: 0, pct: 35 }] }, { id: 'abc', stop_loss: '97' }, TRACKER_UPDATE_FULL, { id: 'abc', auto_close: {} },
    { id: 'abc', auto_close: { ...TRACKER_UPDATE_FULL.auto_close, stop_chase_grace: 1, stop_chase_step: null, stop_chase_max_pct: 5 } },
    { id: 'abc', auto_close: { ...TRACKER_UPDATE_FULL.auto_close, stop_chase_grace: null, stop_chase_step: null, stop_chase_max_pct: null } },
    { id: 'abc', auto_close: { ...TRACKER_UPDATE_FULL.auto_close, stop_chase_grace: 3, stop_chase_step: 4, stop_chase_max_pct: 6 } }],
  'tracker.delete': [{ id: 'abc' }],
  'tracker.target_preview': [{ key: 'k', spot_target: '130' }, { key: 'k', spot_target: '130', chase_max_pct: undefined }, { key: 'k', spot_target: '', chase_max_pct: 5 }, { key: 'k' }],
  'tracker.close_now': [{ id: 'abc' }, {}, { id: null }],
};
// 与前面某个方法共用同一个 schema 的:只重放那个方法的前若干条
const ALIAS = { 'pa.comment': 'pa.analyze', 'sectors.pick': 'sectors.delete', 'futu.diagnose': 'tws.diagnose', 'futu.launch': 'tws.launch' };

// ---------------------------------------------------------------- 变异
const RAW = (t) => `__RAW:${t}__`;
const POOL = [
  null, '', ' ', 'abc', '5', '0', '-1', '1e3', '0x10', '  12  ', 'true', 0, 1, -1, 1.5, 2147483648, RAW('-0'), RAW('1e999'), RAW('-1e999'), RAW('1e21'), RAW('0.1'),
  true, false, [], [1], ['a'], [null], [[]], {}, { x: 1 }, { a: { b: [1] } }, '中文', '\u0000', 'a\nb',
];
const LEAFPOOL = [null, '', 'abc', '0.5', 0, true, false, [], ['a'], {}, { x: 1 }];
const KEYS = ['x', 'stoploss', 'stop_loss ', 'takeProfit', 'constructor', 'toString', '', '1', '01', 'a\'b', 'a\', \'b', 'a、b', '中', 'note2', '__proto__'];
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** 每个节点的路径 */
function paths(v, prefix = [], out = []) {
  out.push(prefix);
  if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...prefix, i], out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) paths(v[k], [...prefix, k], out);
  return out;
}
const at = (v, p) => p.reduce((o, k) => o[k], v);
function mutate(base, kind) {
  const v = clone(base);
  const ps = paths(v);
  const p = pick(ps);
  if (kind === 'del') {
    if (!p.length) return v;
    const parent = at(v, p.slice(0, -1));
    if (Array.isArray(parent)) parent.splice(p[p.length - 1], 1); else delete parent[p[p.length - 1]];
    return v;
  }
  if (kind === 'put') {
    const x = clone(pick(POOL.map((e) => (typeof e === 'string' && e.startsWith('__RAW:') ? e : e))));
    if (!p.length) return x;
    at(v, p.slice(0, -1))[p[p.length - 1]] = x;
    return v;
  }
  if (kind === 'key') {
    const objs = ps.filter((q) => { const n = at(v, q); return n && typeof n === 'object' && !Array.isArray(n); });
    if (!objs.length) return v;
    const o = at(v, pick(objs));
    setOwn(o, pick(KEYS), pick(POOL.slice(0, 12)));
    return v;
  }
  if (kind === 'dup') {
    const arrs = ps.filter((q) => Array.isArray(at(v, q)));
    if (!arrs.length) return v;
    const a = at(v, pick(arrs));
    a.push(a.length ? clone(a[0]) : 1);
    return v;
  }
  return v;
}
const stringify = (v) => JSON.stringify(v).replace(/"__RAW:(.*?)__"/g, '$1');
const TOP = ['null', '[]', '[1]', '[{}]', '"x"', '""', '5', '0', 'true', 'false', '__undefined__', '1e999', '{"__proto__":{"a":1}}', '{"a":1,"a":2}'];

// ---------------------------------------------------------------- 跑
const reqs = JSON.parse(readFileSync(join(engine, 'baseline/rpc/requests.json'), 'utf-8'));
const goldenOf = (m) => reqs.filter((r) => r.method === m).map((r) => r.params);

const parseText = (t) => (t === '__undefined__' ? undefined : JSON.parse(t));
function run(m, text) {
  const raw = parseText(text);
  const table = contractMethods({ [m]: (p) => p });
  const sp = PARAMS_SCHEMAS[m].safeParse(raw);
  let r;
  try {
    r = { ok: true, out: enc(table[m](raw)) };
  } catch (e) {
    r = { ok: false, code: e.code, msg: e.message };
  }
  const c = { m, t: text };
  if (r.ok) {
    if (!sp.success) throw new Error(`${m}: safeParse 失败而 contractMethods 通过`);
    c.o = r.out;
  } else {
    if (sp.success) throw new Error(`${m}: safeParse 通过而 contractMethods 失败`);
    c.c = r.code;
    c.e = r.msg;
    c.i = sp.error.issues.map((i) => [i.code, i.path.map(String), i.message]);
  }
  return c;
}

const names = contractMethodNames();
const cases = [];
const seen = new Set();
const add = (m, text, lean = false) => {
  const k = `${m}\u0000${text}`;
  if (seen.has(k)) return;
  seen.add(k);
  const c = run(m, text);
  if (lean) delete c.i; // 穷举的叶子用例只比码与话(第一处问题的人话),不存 issue 清单,省体积
  cases.push(c);
};
const MONEY = new Set(['tracker.add', 'tracker.update', 'tracker.close_now', 'tracker.delete', 'tracker.target_preview', 'instruction.submit']);
const strictTop = {};
for (const m of names) {
  const base = ALIAS[m] ?? m;
  const seeds = SEEDS[base] ?? [{}];
  if (m !== base) {
    // 别名:同一个 schema 对象
    if (PARAMS_SCHEMAS[m] !== PARAMS_SCHEMAS[base]) throw new Error(`${m} 与 ${base} 不是同一个 schema`);
  }
  const noParams = !(m in SEEDS) && !(m in ALIAS);
  // 先确认头一份合法载荷真的合法
  const first = run(m, stringify(seeds[0]));
  if (first.e !== undefined && !(m === 'tracker.close_now')) throw new Error(`${m}: 手写的头一份载荷不合法:${first.e}`);
  // 是不是顶层 strict:合法载荷上加一个键看
  const probe = { ...clone(seeds[0]) };
  setOwn(probe, '__probe__', 1);
  strictTop[m] = run(m, stringify(probe)).i?.[0]?.[0] === 'unrecognized_keys';
  for (const s of goldenOf(m)) add(m, stringify(s));
  for (const t of TOP) add(m, t);
  for (const s of seeds) add(m, stringify(s));
  if (noParams) { for (const extra of ['{"x":1}', '{"__proto__":1}']) add(m, extra); continue; }
  if (m !== base) { for (const s of seeds) for (let i = 0; i < 6; i += 1) add(m, stringify(mutate(s, pick(['del', 'put', 'key'])))); continue; }
  // 每个叶子(任意深度、含数组里的)× 每一种错类型的值:穷举,任何类型放宽都会死在这里
  if (m === base) {
    for (const sd of seeds) {
      if (JSON.stringify(sd).length > 1500) continue; // 长备注那份不穷举
      const v0 = clone(sd);
      for (const p of paths(v0)) {
        if (!p.length) continue;
        for (const x of LEAFPOOL) { const v = clone(sd); at(v, p.slice(0, -1))[p[p.length - 1]] = clone(x); add(m, stringify(v), true); }
        // 这一处删掉
        { const v = clone(sd); const parent = at(v, p.slice(0, -1)); if (Array.isArray(parent)) parent.splice(p[p.length - 1], 1); else delete parent[p[p.length - 1]]; add(m, stringify(v), true); }
      }
    }
  }
  const big = MONEY.has(m);
  const each = big ? 60 : 40;
  for (let n = 0; n < each; n += 1) {
    let v = clone(pick(seeds));
    const rounds = rnd() < 0.8 ? 1 : 1 + Math.floor(rnd() * 3);
    for (let r = 0; r < rounds; r += 1) v = mutate(v, pick(['del', 'put', 'put', 'put', 'key', 'key', 'dup']));
    add(m, stringify(v));
  }
  // 钱路径:每一层对象里、每个不认识的键各来一遍(穷举),键名从 KEYS 里取
  if (big) {
    for (const s of seeds) {
      const v0 = clone(s);
      for (const p of paths(v0)) {
        const n = at(v0, p);
        if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
        for (const k of ['stoploss', '__proto__', '', '1', 'a\', \'b']) { const v = clone(s); setOwn(at(v, p), k, 1); add(m, stringify(v), true); }
      }
    }
  }
}
// 文本层面的怪输入:重复的键、深层 __proto__、数字写法
for (const [m, text] of [
  ['tracker.add', '{"key":"A","key":"B"}'], ['tracker.add', '{"key":"A","stop_loss":"1","stop_loss":2}'],
  ['tracker.update', '{"id":"a","auto_close":{"enabled":true,"enabled":false}}'], ['tracker.update', '{"id":"a","auto_close":{"__proto__":1}}'],
  ['tracker.close_now', '{"id":"a","id":"b"}'], ['instruction.submit', '{"text":"a","__proto__":{"x":1}}'], ['instruction.submit', '{"1":1,"text":"a"}'],
  ['settings.patch', '{"patch":{"b":1,"2":2,"a":3,"1":4}}'], ['alerts.set_touch_config', '{"config":{"b":1,"10":2,"9":3,"a":4}}'],
  ['events.set_config', '{"config":{"__proto__":{"x":1},"y":2}}'], ['quality.set_config', '{"config":{"1":1,"0":0}}'],
]) add(m, text);

// ---------------------------------------------------------------- 合成的 schema(kit 里的对象 / 联合 / optional / describeIssue 的各条路)
// 真实的 schema 里没有"两个分支都走得更深"、"联合套联合"这类形状;这里用 zod 现拼,同一份描述在 C++ 里用 contract/kit.h 的积木再拼一遍(tst_contract.cpp 的 synthetic()),
// 期望是 TS 的 safeParse 与 describeIssue 现跑的结果。
const zmod = await import(pathToFileURL(join(engine, 'node_modules/zod/index.js')).href);
const z = zmod.z ?? zmod;
const K = await imp('contract/schema/kit.js');
const SYN = {
  u2obj: () => z.object({ v: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }),
  uDeep: () => z.object({ v: z.union([z.object({ a: z.string(), c: z.object({ d: z.number() }) }), z.object({ a: z.string(), c: z.object({ d: z.string() }) })]) }),
  uDeepTie: () => z.object({ v: z.union([z.object({ a: z.object({ b: z.string() }) }), z.object({ a: z.object({ b: z.number() }) })]) }),
  uDepths: () => z.object({ v: z.union([z.object({ c: z.object({ d: z.number() }) }), z.object({ c: z.object({ e: z.number() }) }), z.object({ x: z.number() })]) }),
  uArr: () => z.object({ v: z.union([z.array(z.number()), z.number()]) }),
  uNest: () => z.object({ v: z.union([z.union([z.number(), z.string()]), z.boolean()]) }),
  uLit: () => z.object({ v: z.union([z.literal(''), z.literal(5)]) }),
  uEnum: () => z.object({ v: z.union([z.enum(['p', 'q']), z.number()]) }),
  uStrictArr: () => z.object({ v: z.union([z.literal(''), z.array(z.object({ a: z.union([z.number(), z.string(), z.null()]) }).strict())]) }),
  uTop: () => z.union([z.object({ a: z.string() }), z.array(z.number())]),
  strictNested: () => z.object({ x: K.optional(z.object({ y: z.string() }).strict()), z: z.array(z.object({ w: z.number() }).strict()) }).strict(),
  optionals: () => z.object({ a: K.optional(z.string()), b: K.optional(z.union([z.number(), z.string()])), c: K.optional(z.unknown().transform((v) => Boolean(v))), d: K.requiredButReportedByHandler(), e: K.optional(z.number().nullable()), f: K.optional(z.object({ g: z.number() })) }),
  nullableUnion: () => z.object({ v: z.union([z.number().nullable(), z.string()]) }),
  recordU: () => z.object({ r: z.record(z.string(), z.union([z.number(), z.string()])) }),
  partialStrict: () => z.object({ a: z.boolean(), b: z.number().nullable(), c: z.string() }).partial().strict(),
  noParams: () => K.NoParamsSchema,
  literalNum: () => z.object({ v: z.literal(5), w: z.enum(['a', 'b']) }),
};
const SCALARS = [null, true, false, 0, 5, -1.5, '', 'x', 'p', 'a'];
const KEYS2 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'v', 'w', 'x', 'y', 'z', 'r', 'q'];
function genValue(depth) {
  const r = rnd();
  if (depth <= 0 || r < 0.3) return pick(SCALARS);
  if (r < 0.45) return Array.from({ length: Math.floor(rnd() * 3) }, () => genValue(depth - 1));
  const o = {};
  for (let i = Math.floor(rnd() * 4); i > 0; i -= 1) setOwn(o, pick(KEYS2), genValue(depth - 1));
  return o;
}
const synthetic = [];
const synSeen = new Set();
for (const [name, build] of Object.entries(SYN)) {
  const schema = build();
  for (let n = 0; n < 130; n += 1) {
    // 先随机造,再偏向"差一点就合法"的:从 {v: x} / {x:…} 形状里挑
    let v = genValue(4);
    if (rnd() < 0.6 && name !== 'uTop' && name !== 'noParams') v = { v: genValue(3) };
    if (rnd() < 0.3 && v && typeof v === 'object' && !Array.isArray(v)) setOwn(v, pick(KEYS2), genValue(2));
    const t = JSON.stringify(v);
    const key = `${name}\u0000${t}`;
    if (synSeen.has(key)) continue;
    synSeen.add(key);
    const sp = schema.safeParse(JSON.parse(t));
    const c = { s: name, t };
    if (sp.success) c.o = enc(sp.data);
    else { c.d = K.describeIssue(sp.error); c.i = sp.error.issues.map((i) => [i.code, i.path.map(String), i.message]); }
    synthetic.push(c);
  }
}

const out = { names, sensitive: [...SENSITIVE_METHODS], strictTop, cases, synthetic };
const text = JSON.stringify(out);
writeFileSync(join(here, 'contract.json'), text);
console.log(`contract.json: ${cases.length} 个用例 + ${synthetic.length} 个合成 schema 的用例, ${(text.length / 1048576).toFixed(2)} MB, ${cases.filter((c) => c.e !== undefined).length} 个被拒`);
