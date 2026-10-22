// 生成 h2_review.json:engine-ts 的 review.ts(rpc/handlers/review.ts,原类现跑)对着 h2_world.mjs 的假 RpcContext;库是真的(临时库,成交 / 记录 / 信号 / 审计痕种进去)。
// C++ 一半:tests/tst_h2_review.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_review.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);
const SR = await h2.mods.imp('stockreview');

const START = Date.parse('2026-10-15T14:00:00-04:00'); // 周四 14:00 ET
const DUMP = ['audit_log', 'app_prefs'];
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: DUMP, files: ['playbook'], h2router: { sessions: 1 }, ...script } });
const pad = (n) => String(n).padStart(2, '0');
const etMs = (day, hhmm) => Date.parse(`${day}T${hhmm}:00-04:00`);
const utcStamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const compact = (day) => day.replace(/-/g, '');

// ---------------------------------------------------------------- 造数据
let execN = 0;
/** 一张蝴蝶的券商成交行(三条腿 + 可选 BAG 行)。action BUY = 翼买中间卖;day / hhmm 是美东墙钟 */
function flyFills(o) {
  const day = o.day ?? '2026-10-15', center = o.center ?? 7000, wing = o.wing ?? 10, qty = o.qty ?? 1, action = o.action ?? 'BUY';
  const premium = o.premium ?? 3.2;
  const wingSide = action === 'BUY' ? 'BOT' : 'SLD', bodySide = wingSide === 'BOT' ? 'SLD' : 'BOT';
  const t = etMs(day, o.hhmm ?? '09:50');
  const base = { account_id: o.account ?? 'U1234567', perm_id: o.perm, order_id: o.perm % 100, order_ref: '' };
  const rows = [];
  [[center - wing, 1, wingSide, 14 + premium / 2], [center, 2, bodySide, 12], [center + wing, 1, wingSide, 10 + premium / 2]].forEach(([strike, ratio, side, price], i) => {
    rows.push({ ...base, exec_id: `0000e${(execN += 1)}.01`, time: o.style === 'wall' ? `${day} ${o.hhmm ?? '09:50'}:0${i}` : utcStamp(t + i * 1000), side, shares: ratio * qty,
      price: Math.round(price * 100) / 100, commission: 0.65 * ratio * qty,
      contract: { secType: 'OPT', symbol: o.symbol ?? 'SPX', strike, right: o.right ?? 'C', expiry: compact(o.expiry ?? day), tradingClass: 'SPXW', multiplier: '100', conId: 100 + i, currency: 'USD' } });
  });
  if (o.bag !== false) rows.push({ ...base, exec_id: `0000b${(execN += 1)}`, time: utcStamp(t + 500), side: wingSide, shares: qty, price: premium, commission: 0, contract: { secType: 'BAG', symbol: o.symbol ?? 'SPX' } });
  return rows;
}
/** 本地记录(createRecord 的入参);fills 空 = 本地没成交 */
function localFly(o) {
  const k = o.center ?? 7000, w = o.wing ?? 10, day = o.day ?? '2026-10-15', exp = compact(o.expiry ?? day), right = o.right ?? 'C';
  const wingAct = (o.action ?? 'BUY') === 'BUY' ? 'BUY' : 'SELL', bodyAct = wingAct === 'BUY' ? 'SELL' : 'BUY';
  const leg = (strike, action, ratio, conId) => ({ conId, strike, action, ratio, right, lastTradeDateOrContractMonth: exp, tradingClass: 'SPXW', multiplier: '100' });
  const rec = {
    id: o.id, created_at: o.created_at ?? `${day}T${o.hhmm ?? '09:40'}:00-04:00`,
    contract: { secType: 'BAG', symbol: o.symbol ?? 'SPX', exchange: 'SMART', currency: 'USD', combo_strategy: 'BUTTERFLY', legs: o.noLegs ? [] : [leg(k - w, wingAct, 1, 1), leg(k, bodyAct, 2, 2), leg(k + w, wingAct, 1, 3)] },
    order: { action: o.action ?? 'BUY', totalQuantity: o.qty ?? 1, lmtPrice: o.limit ?? 3.0, orderType: 'LMT' },
    final_status: o.status ?? 'submitted', account: { alias: o.alias ?? '主账户', account_id: 'U1234567' }, llm: { intent_summary: o.summary ?? `买入 1 张 SPX ${k - w}/${k}/${k + w}` },
  };
  if (o.fills) rec.ibkr = { avg_fill_price: o.fillPrice ?? 3.1, fills: o.fills, status_timeline: [{ status: 'Submitted', at: rec.created_at }, { status: 'Filled', at: rec.created_at }] };
  if (o.noTime) { delete rec.created_at; }
  if (o.source) rec.source = o.source;
  return rec;
}
const stockRec = (id) => ({ id, created_at: '2026-10-15T09:41:00-04:00', contract: { secType: 'STK', symbol: 'NVDA' }, order: { action: 'BUY', totalQuantity: 10 }, final_status: 'filled' });

/** 1 分钟 / n 分钟线(美东墙钟),随机游走;从 from 起 n 根 */
function bars(r, day, fromHHMM, n, stepMin, base, daily) {
  const out = [];
  let s = base;
  let m = Number(fromHHMM.slice(0, 2)) * 60 + Number(fromHHMM.slice(3));
  for (let i = 0; i < n; i += 1) {
    const o = s;
    s += (r.next() - 0.5) * 2.2;
    const c = Math.round(s * 100) / 100;
    const time = daily ? day : `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    out.push({ time, open: Math.round(o * 100) / 100, high: Math.round((Math.max(o, c) + r.next()) * 100) / 100, low: Math.round((Math.min(o, c) - r.next()) * 100) / 100, close: c, volume: Math.round(1000 + r.next() * 500) });
    m += stepMin;
  }
  return out;
}
const dailyBars = (r, from, to, base) => {
  const out = [];
  let s = base;
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400e3) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    s += (r.next() - 0.5) * 20;
    const c = Math.round(s * 100) / 100;
    out.push({ date: d.toISOString().slice(0, 10), open: c - 3, high: c + 8, low: c - 9, close: c, volume: 1e6 });
  }
  return out;
};
const R0 = rng(0x4e57_1a2b);
const MIN_1 = bars(R0, '2026-10-15', '09:30', 150, 1, 7000);
const MIN_5 = bars(R0, '2026-10-15', '09:30', 78, 5, 7000);
const MIN_1_OLD = bars(R0, '2026-10-13', '09:30', 390, 1, 7000);
const DAILY = dailyBars(R0, '2026-07-01', '2026-10-14', 6900);
const bandAt = (day, hhmm, em) => ({ at: etMs(day, hhmm), anchor: 7000, strike: 7000, expiry: compact(day), call: 20, put: 20, em, lower: 6980, upper: 7020, source: 'live' });
const jsonl = (recs) => recs.map((x) => JSON.stringify(x)).join('\n') + '\n';

const PA = (b, extra = {}) => ({ value: { bars: b, cached: false, askedAt: START, ...extra } });
const FILLED = { value: 3 };
const SYNC = { 'fillSync.sync': [FILLED], 'fillSync.available': [{ value: true }] };
const withFly = [
  ...flyFills({ perm: 1001, hhmm: '09:50', action: 'BUY', premium: 3.2 }),
  ...flyFills({ perm: 1002, hhmm: '10:40', action: 'SELL', premium: 4.1 }),
  ...flyFills({ perm: 1003, hhmm: '11:15', action: 'SELL', center: 7050, premium: 2.6, style: 'wall' }),
  ...flyFills({ perm: 1004, hhmm: '10:20', action: 'BUY', center: 6990, premium: 3.0, qty: 2, bag: false, account: 'DU7654321' }),
  ...flyFills({ perm: 1005, day: '2026-09-02', hhmm: '10:05', action: 'BUY', premium: 5.5 }),
  ...flyFills({ perm: 1006, day: '2026-09-02', hhmm: '15:10', action: 'SELL', premium: 6.0 }),
  ...flyFills({ perm: 1007, hhmm: '12:00', action: 'BUY', center: 7020, premium: 3.2154, qty: 3 }),
  ...flyFills({ perm: 1008, hhmm: '12:30', action: 'SELL', center: 7020, premium: 4.1371, qty: 3 }),
];
const seedFills = st('rememberFills', [withFly]);
const noteIfEmpty = (x) => x;

// 股票持仓段:用原模块切出真的 trip
const stkFills = (day, hhmm, side, shares, price, perm, sym = 'NVDA') => ({ exec_id: `s${(execN += 1)}`, time: utcStamp(etMs(day, hhmm)), account_id: 'U1234567', side, shares, price, perm_id: perm, order_id: perm, commission: 1, contract: { secType: 'STK', symbol: sym, currency: 'USD' } });
const TRIPS = SR.groupStockTrips([
  stkFills('2026-10-15', '09:45', 'BOT', 100, 7000.5, 501), stkFills('2026-10-15', '10:30', 'SLD', 100, 7006.5, 502),
  stkFills('2026-10-15', '11:00', 'BOT', 50, 7001, 503, 'AMD'), stkFills('2026-09-30', '10:00', 'BOT', 10, 150, 504, 'AAPL'), stkFills('2026-09-30', '14:00', 'SLD', 10, 155, 505, 'AAPL'),
], [{ account_id: 'U1234567', alias: '主账户', is_paper: false }], null);
const TRIP_OPEN = TRIPS.find((t) => t.symbol === 'AMD');
const TRIP_CLOSED = TRIPS.find((t) => t.symbol === 'NVDA');
const TRIP_OLD = TRIPS.find((t) => t.symbol === 'AAPL');
if (!TRIP_OPEN || !TRIP_CLOSED || !TRIP_OLD) throw new Error('trip 没切出来');
const noTimeTrip = { ...TRIP_CLOSED, id: 'stk:notime', entries: [{ time: null, shares: 1, price: 1 }], exits: [], created_at: null };

// ---------------------------------------------------------------- review.candidates
add('candidates:没有任何成交与股票:空表;synced 为空(null)、available 假', {
  ports: { 'fillSync.sync': [{ value: null }], 'fillSync.available': [{ value: false }], 'stockTrips.trips': [{ value: [] }] },
  steps: [call('a', 'review.candidates'), call('b', 'review.candidates', { limit: 5, include_local: true }), call('c', 'review.candidates', { extra: 1 }), call('d', 'review.candidates', { limit: [] })],
});
add('candidates:开仓-平仓配对并成一行(role=exit 不单列)、孤立蝴蝶、同价账户别名;股票混排;最新在前', {
  ports: { ...SYNC, 'stockTrips.trips': [{ value: TRIPS }] },
  steps: [seedFills, call('a', 'review.candidates'), call('b', 'review.candidates', { limit: 3 }), call('c', 'review.candidates', { limit: '2' })],
});
add('candidates:limit 的各种写法(Number(x ?? 200) 取整 || 200;负数砍尾)', {
  ports: { ...SYNC, 'stockTrips.trips': [{ value: TRIPS }] },
  steps: [seedFills, ...[0, 1, 1.9, -1, -2.5, '3', ' 4 ', 'abc', '', '0', null, true, false, 1e9, '1e3', 'Infinity', '-Infinity', -100, 0.5, -0.5, '0x10', [], [2], {}].map((l, i) => call(`l${i}`, 'review.candidates', { limit: l }))],
});
add('candidates:include_local:本地没成交的附在后面、本地已成交的不重复、非蝴蝶跳过;真假值', {
  ports: { ...SYNC, 'stockTrips.trips': [{ value: [] }] },
  steps: [seedFills,
    st('createRecord', [localFly({ id: 'L1', fills: [], created_at: '2026-10-15T09:00:00-04:00' })]),
    st('createRecord', [localFly({ id: 'L2', fills: [{ time: '2026-10-15T09:35:00-04:00', price: 3.3, qty: 1 }], final_status: 'filled', status: 'filled' })]),
    st('createRecord', [stockRec('L3')]),
    st('createRecord', [localFly({ id: 'L4', status: 'filled', center: 7010, action: 'SELL' })]),
    st('createRecord', [localFly({ id: 'L5', noLegs: true })]),
    st('createRecord', [localFly({ id: 'L6', source: 'ui', alias: '' })]),
    call('a', 'review.candidates', { include_local: true }), call('b', 'review.candidates', { include_local: 1 }), call('c', 'review.candidates', { include_local: 'no' }),
    call('d', 'review.candidates', { include_local: 0 }), call('e', 'review.candidates', { include_local: '' }), call('f', 'review.candidates', { include_local: null }), call('g', 'review.candidates', { include_local: [] }),
    call('h', 'review.candidates', { include_local: true, limit: 2 })],
});
add('candidates:股票行与蝴蝶行同一时刻 / 时间认不出的沉底;缺字段的 trip', {
  ports: { ...SYNC, 'stockTrips.trips': [{ value: [{ ...TRIP_CLOSED, created_at: '2026-10-15T09:50:00-04:00' }, { ...TRIP_OPEN, created_at: 'nonsense' }, { ...TRIP_OLD, created_at: null }, { id: 'stk:bare' }, { ...TRIP_CLOSED, id: 'stk:nan', created_at: '', account: null, summary: null, status: 'closed' }] }] },
  steps: [seedFills, call('a', 'review.candidates')],
});
add('candidates:fillSync / stockTrips 抛错;记录里 ibkr 缺失', {
  ports: { 'fillSync.sync': [{ error: '券商没连', kind: 'broker' }, { value: 1 }, { value: 2 }], 'fillSync.available': [{ value: false }], 'stockTrips.trips': [{ value: [] }, { error: '持仓取不到' }] },
  steps: [call('a', 'review.candidates'), call('b', 'review.candidates'), call('c', 'review.candidates', { include_local: true })],
});

// ---------------------------------------------------------------- review.analyze
const ANA_PORTS = (extra = {}) => ({ ...SYNC, 'stockTrips.trips': [{ value: TRIPS }], ...extra });
add('analyze:没连券商 / 连过又全断 → needConnection(-32015);先排在周期校验之后', {
  ports: ANA_PORTS(),
  steps: [seedFills, call('a', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }), { op: 'h2router', v: 'make' }, { op: 'h2routerSet', set: { sessions: 0 } }, call('b', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }),
    call('c', 'review.analyze', { id: 'ib:1001', timeframe: '7m' }), call('d', 'review.analyze', { id: 'ib:1001', timeframe: 'toString' }), call('e', 'review.analyze', { id: 'stk:nope' }),
    call('f', 'review.analyze', { id: 'ib:1001', timeframe: '' }), call('g', 'review.analyze', {}), call('h', 'review.analyze', { id: 5 })],
});
add('analyze:记录不存在 -32005 / 非蝴蝶 -32602 / 没有成交时间 -32602(entryOf 的原话)', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5)] }),
  steps: [{ op: 'h2router', v: 'make' }, seedFills, st('createRecord', [stockRec('S1')]), st('createRecord', [localFly({ id: 'N1', noTime: true })]), st('createRecord', [localFly({ id: 'N2', noLegs: true })]),
    call('a', 'review.analyze', { id: 'zzz' }), call('b', 'review.analyze', { id: 'S1' }), call('c', 'review.analyze', { id: 'N1', timeframe: '5m' }), call('d', 'review.analyze', { id: 'N2' }), call('e', 'review.analyze', { id: '' })],
});
add('analyze:5m 日内复盘 + 1 分钟回放 + 蝶价线;平仓单 id 选中 → 复盘它的开仓单', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5), PA(MIN_1)], 'market.dailyHistoryAskedAt': [{ value: null }] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: MIN_1.map((b) => ({ time: b.time, open: 3, high: 3.5, low: 2.8, close: 3.2 + (b.close - 7000) / 100, volume: 5 })) }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, call('a', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }), call('b', 'review.analyze', { id: 'ib:1002', timeframe: '5m' }),
    call('c', 'review.analyze', { id: 'ib:1003', timeframe: '5m', exit: { em: 30 } }), call('d', 'review.analyze', { id: 'ib:1004', timeframe: '5m', exit: { em: '28.5', arm: 50 } })],
});
add('analyze:周期 auto(按开仓离现在多远挑);1m 本身不再取 1 分钟线;各种 em 写法', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_1)] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, call('a', 'review.analyze', { id: 'ib:1001' }), call('b', 'review.analyze', { id: 'ib:1001', timeframe: 'auto' }), call('c', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: 0 } }),
    call('d', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: '' } }), call('e', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: null } }),
    call('f', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: 35.25 } }), call('g', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: [1, 2] }),
    call('h', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: 'x' }), call('i', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: null }), call('j', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: false } })],
});
const PB_OPEN = jsonl([{ kind: 'prior', band: bandAt('2026-10-14', '16:00', 40) }, { kind: 'frame', band: bandAt('2026-10-15', '10:00', 31) }, { kind: 'open', band: bandAt('2026-10-15', '09:35', 33.5) }, 'junk'].filter((x) => typeof x === 'object'));
const PB_FRAME = jsonl([{ kind: 'frame', band: bandAt('2026-10-15', '11:20', 27) }, { kind: 'frame', band: bandAt('2026-10-15', '10:05', 29) }, { kind: 'machine', machine: { at: 1, state: 'x', trigger: null, since: null, lost: null } }]);
add('analyze:EM 取自日内剧本底账(盘初 / 第一条当前区间 / 没有 / 提前收盘日 / 坏行)', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_1)] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: [] }] } },
  settings: { early_close_days: ['2026-11-27', '2026-10-13'] },
  steps: [{ op: 'h2router', v: 'make' }, seedFills,
    call('a', 'review.analyze', { id: 'ib:1001', timeframe: '1m' }),
    { op: 'file', path: 'playbook/2026-10-15.jsonl', content: PB_OPEN }, call('b', 'review.analyze', { id: 'ib:1001', timeframe: '1m' }),
    { op: 'file', path: 'playbook/2026-10-15.jsonl', content: PB_FRAME }, call('c', 'review.analyze', { id: 'ib:1001', timeframe: '1m' }),
    { op: 'file', path: 'playbook/2026-10-15.jsonl', content: 'not json\n{"kind":"open","band":{"at":"x"}}\n' }, call('d', 'review.analyze', { id: 'ib:1001', timeframe: '1m' }),
    { op: 'file', path: 'playbook/2026-10-15.jsonl', content: PB_OPEN }, call('e', 'review.analyze', { id: 'ib:1001', timeframe: '1m', exit: { em: 20 } }),
    st('createRecord', [localFly({ id: 'E1', day: '2026-10-13', hhmm: '09:40', fills: [{ time: '2026-10-13T09:45:00-04:00', price: 3.1, qty: 1 }], final_status: 'filled' })]),
    { op: 'file', path: 'playbook/2026-10-13.jsonl', content: jsonl([{ kind: 'open', band: bandAt('2026-10-13', '09:35', 30) }]) },
    call('f', 'review.analyze', { id: 'E1', timeframe: '5m' }),
  ],
});
add('analyze:1 分钟线的各种失败只记 notes(没有那天 / BrokerError / RpcError);别的错照抛', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5), PA(MIN_1_OLD), PA(MIN_5), { error: 'TWS 没数据', kind: 'broker' }, PA(MIN_5), { error: '被限流', kind: 'rpc', code: -32015 }, PA(MIN_5), { error: '炸了' }, PA(MIN_5), PA([])] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, ...'abcde'.split('').map((c) => call(c, 'review.analyze', { id: 'ib:1001', timeframe: '5m' }))],
});
add('analyze:comboBars 成功 / 失败(长话截 160)/ 空表', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5), PA(MIN_1)] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: MIN_1.slice(0, 90).map((b) => ({ time: b.time, close: 3.3 + (b.close - 7000) / 90 })) }, { error: '组合历史数据没有权限' + '长'.repeat(200), kind: 'broker' }, { error: 'boom' }, { value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, call('a', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }), call('b', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }), call('c', 'review.analyze', { id: 'ib:1001', timeframe: '5m' }),
    call('d', 'review.analyze', { id: 'ib:1001', timeframe: '5m' })],
});
add('analyze:没有 comboBars 的 router(noCombo)', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5), PA(MIN_1)] }),
  h2router: { sessions: 1, noCombo: true },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, call('a', 'review.analyze', { id: 'ib:1001', timeframe: '5m' })],
});
add('analyze:日线(历史数据接口,字段 date / time、volume 缺省 0);已到期的蝴蝶;BrokerError → -32015;别的错照抛', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5)] }),
  h2router: { sessions: 1, results: { historicalBars: [{ value: DAILY }, { value: DAILY.map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close })) }, { error: '没有权限', kind: 'broker' }, { error: 'boom' }, { value: [] }], comboBars: [{ value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, ...'abcde'.split('').map((c) => call(c, 'review.analyze', { id: c === 'e' ? 'ib:1005' : 'ib:1005', timeframe: '1d' })), call('f', 'review.analyze', { id: 'ib:1006' })],
});
add('analyze:5m 取 K 线失败(BrokerError → -32015;其它照抛);ReviewError(K 线不够)→ -32602', {
  ports: ANA_PORTS({ 'market.paBars': [{ error: '延迟行情没权限', kind: 'broker' }, { error: 'x' }, PA([]), PA(MIN_5.slice(0, 2)), PA(MIN_5)] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, seedFills, ...'abcde'.split('').map((c) => call(c, 'review.analyze', { id: 'ib:1001', timeframe: '5m' }))],
});
add('analyze:本地记录(没券商成交、getRecord)和 others 里的本地平仓单', {
  ports: ANA_PORTS({ 'market.paBars': [PA(MIN_5), PA(MIN_1)] }),
  h2router: { sessions: 1, results: { comboBars: [{ value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' },
    st('createRecord', [localFly({ id: 'LO', hhmm: '09:48', fills: [{ time: '2026-10-15T09:50:00-04:00', price: 3.2, qty: 1 }], final_status: 'filled' })]),
    st('createRecord', [localFly({ id: 'LC', hhmm: '10:30', action: 'SELL', fills: [{ time: '2026-10-15T10:40:00-04:00', price: 4.0, qty: 1 }], final_status: 'filled', fillPrice: 4.0 })]),
    st('createRecord', [localFly({ id: 'LP', hhmm: '09:48', source: 'ui', fills: [], status: 'cancelled' })]),
    call('a', 'review.analyze', { id: 'LO', timeframe: '5m' }), call('b', 'review.analyze', { id: 'LP', timeframe: '5m' }), call('c', 'review.analyze', { id: 'LC', timeframe: '5m' })],
});
add('analyze:股票 stk:(不在 → -32005;成功;日线;没时间 → ReviewError → -32602;K 线失败)', {
  ports: ANA_PORTS({ 'stockTrips.trips': [{ value: [...TRIPS, noTimeTrip] }], 'market.paBars': [PA(bars(R0, '2026-10-15', '09:30', 200, 1, 7000)), PA(bars(R0, '2026-10-15', '09:30', 200, 1, 7000)), { error: '没权限', kind: 'broker' }, PA(bars(R0, '2026-10-15', '09:30', 200, 1, 7000))] }),
  h2router: { sessions: 1, results: { historicalBars: [{ value: DAILY.map((b) => ({ ...b, date: b.date })) }, { value: [] }] } },
  steps: [{ op: 'h2router', v: 'make' }, call('a', 'review.analyze', { id: 'stk:nope' }), call('b', 'review.analyze', { id: TRIP_CLOSED.id, timeframe: '1m' }), call('c', 'review.analyze', { id: TRIP_OPEN.id, timeframe: '1m' }),
    call('d', 'review.analyze', { id: TRIP_OLD.id, timeframe: '1d' }), call('e', 'review.analyze', { id: TRIP_OLD.id, timeframe: '1d' }), call('f', 'review.analyze', { id: 'stk:notime' }), call('g', 'review.analyze', { id: TRIP_CLOSED.id, timeframe: '5m' }),
    call('h', 'review.analyze', { id: TRIP_CLOSED.id, timeframe: '9m' }), call('i', 'review.analyze', { id: TRIP_CLOSED.id }), { op: 'h2router', v: 'null' }, call('j', 'review.analyze', { id: TRIP_CLOSED.id, timeframe: '1m' })],
});

// ---------------------------------------------------------------- review.performance
const LT = (i, o = {}) => ({ id: `t${i}`, kind: o.kind ?? 'butterfly', symbol: o.symbol ?? 'SPX', label: `trade ${i}`, opened_at: o.opened_at === undefined ? new Date(START - (30 - i) * 3600e3 * 3).toISOString() : o.opened_at,
  closed_at: new Date(START - (30 - i) * 3600e3 * 3 + 1800e3).toISOString(), pnl: o.pnl ?? ((i * 37) % 11 - 4) * 22.5, net_of_commission: o.net ?? true, risk: o.risk ?? 100, r: o.r ?? (((i * 37) % 11 - 4) * 22.5) / 100,
  risk_basis: o.basis ?? 'max_loss', r_missing: o.rm ?? null, exposure: o.exposure ?? 320, hold_minutes: o.hold ?? 30, paper: o.paper ?? i % 5 === 0 });
const LEDGER = { trades: Array.from({ length: 36 }, (_, i) => LT(i, { kind: i % 3 === 0 ? 'stock' : i % 7 === 0 ? 'option' : 'butterfly', symbol: i % 3 === 0 ? 'NVDA' : 'SPX', rm: i % 9 === 0 ? 'no_stop' : null, r: i % 9 === 0 ? null : undefined, basis: i % 9 === 0 ? null : 'max_loss' })), excluded: { open: 2, unknown: 1, no_cost: 0 } };
add('performance:days 校验(整数、1 到 3650,原话);通过的 days / scope / kind;账本为空', {
  ports: { ...SYNC, 'tradeHistory.ledger': [{ value: { trades: [], excluded: { open: 0, unknown: 0, no_cost: 0 } } }] },
  steps: [...[0, 1.5, 3651, -3, 3650, 1, 7.0, 1e21, null].map((d, i) => call(`d${i}`, 'review.performance', { days: d })), call('e', 'review.performance'), call('f', 'review.performance', { days: 'x' }), call('g', 'review.performance', { scope: 'nope' }),
    call('h', 'review.performance', { kind: 'bond' }), call('i', 'review.performance', { scope: 'paper', kind: 'option', days: 90 })],
});
add('performance:有账本 + 平仓痕 + 保护规则;各种 scope / kind / days;账本取不到抛错', {
  ports: { ...SYNC, 'tradeHistory.ledger': [{ value: LEDGER }, { error: '账本读不了' }, { value: LEDGER }] },
  steps: [st('createRecord', [localFly({ id: 'CT1', fills: [{ time: '2026-10-15T09:50:00-04:00', price: 3.2, qty: 1 }] })]), st('audit', ['engine', 'auto_close', { symbol: 'SPX', state: 'stop_loss', mark: 1.9, record: 'CT1' }]),
    st('audit', ['engine', 'hosted_sweep', { symbol: 'NVDA', state: 'sweep:take_profit', mark: 'x', record: 'nope' }]),
    call('a', 'review.performance'), call('b', 'review.performance', { days: 10 }), call('c', 'review.performance'), call('d', 'review.performance', { scope: 'live', kind: 'stock' }), call('e', 'review.performance', { scope: 'paper', days: 3650 })],
});
add('performance:连着券商的同步被催;fillSync 抛错 → 不出报告', {
  ports: { 'fillSync.sync': [{ error: '同步失败', kind: 'broker' }, { value: 1 }], 'tradeHistory.ledger': [{ value: LEDGER }] },
  steps: [call('a', 'review.performance'), call('b', 'review.performance', { days: 5 })],
});

// ---------------------------------------------------------------- review.signals
const SIG = (at, symbol, o = {}) => ({ at, source: o.source ?? 'cross', symbol, expect: o.expect === undefined ? 'up' : o.expect, price: o.price ?? 100, label: o.label ?? `${symbol} 穿越`, variant: o.variant ?? null });
const dClose = (from, to, base, seedN) => { const r = rng(seedN); return dailyBars(r, from, to, base).map((b) => ({ date: b.date, close: Math.abs(b.close - 6900) / 10 + base / 7 })); };
const NVDA_D = dClose('2025-08-01', '2026-10-15', 700, 11), AMD_D = dClose('2025-08-01', '2026-10-14', 900, 12), TSLA_D = dClose('2025-09-01', '2026-10-15', 800, 13);
const sigRows = [SIG('2026-09-10T14:00:00.000Z', 'NVDA'), SIG('2026-09-21T15:30:00.000Z', 'NVDA', { source: 'touch', expect: 'down' }), SIG('2026-10-01T16:00:00.000Z', 'AMD', { source: 'spike' }), SIG('2026-10-08T13:45:00.000Z', 'TSLA', { source: 'rvol', expect: null }),
  SIG('2026-10-14T19:00:00.000Z', 'NVDA', { source: 'pa', variant: '5m' }), SIG('2026-10-15T15:00:00.000Z', 'TSLA', { source: 'burst' }), SIG('2026-08-20T14:00:00.000Z', 'AMD', { source: 'leaders' })];
const logSigs = st('signals.log', [sigRows]);
add('signals:没有信号;days 校验', {
  ports: { 'market.dailyHistory': [{ value: [] }], 'market.dailyHistoryAskedAt': [{ value: null }] },
  steps: [call('a', 'review.signals'), ...[0, 1.5, 3651, 3650, 5, null].map((d, i) => call(`d${i}`, 'review.signals', { days: d })), call('x', 'review.signals', { days: 'x' }), call('y', 'review.signals', { extra: 1 })],
});
add('signals:各标的日线(最后一根:盘中取的丢、收盘后取的留、没记取回时刻丢);days 截断', {
  ports: { 'market.dailyHistory': [{ value: NVDA_D }, { value: AMD_D }, { value: TSLA_D }], 'market.dailyHistoryAskedAt': [{ value: etMs('2026-10-16', '09:00') }, { value: null }, { value: etMs('2026-10-15', '14:00') }, { value: etMs('2026-10-15', '16:00') }] },
  steps: [logSigs, call('a', 'review.signals'), call('b', 'review.signals', { days: 7 }), call('c', 'review.signals', { days: 400 })],
});
add('signals:日线取不到的标的进 missing_symbols;更长那段失败退回平常那段;垃圾行被过滤', {
  ports: { 'market.dailyHistory': [{ error: '超频', kind: 'broker' }, { value: NVDA_D }, { error: '没权限', kind: 'broker' }, { error: '没权限' }, { value: [{ date: 'x', close: 1 }, { time: '2026-10-14T00:00:00', close: 5 }, { date: '2026-10-13', close: -1 }, { date: '2026-10-12', close: 'a' }, { date: '2026-10-11', close: 0 }, { date: '2026-10-10 09:30', close: 10 }, { close: 3 }, ...TSLA_D.slice(-5)] }],
    'market.dailyHistoryAskedAt': [{ value: etMs('2026-10-16', '09:00') }] },
  steps: [logSigs, call('a', 'review.signals')],
});
add('signals:日线里有 close 为 0 的一行(要滤掉:close > 0)', {
  ports: { 'market.dailyHistory': [{ value: [...NVDA_D.slice(0, 100), { date: '2026-02-03', close: 0 }, ...NVDA_D.slice(100)] }, { value: AMD_D }, { value: TSLA_D }], 'market.dailyHistoryAskedAt': [{ value: etMs('2026-10-16', '09:00') }] },
  steps: [logSigs, call('a', 'review.signals')],
});
add('signals:日线里带 null 行 → 这只整只算取不到(TypeError 被吞)', {
  ports: { 'market.dailyHistory': [{ value: [null] }, { value: NVDA_D }], 'market.dailyHistoryAskedAt': [{ value: etMs('2026-10-16', '09:00') }] },
  steps: [logSigs, call('a', 'review.signals')],
});
add('signals:提前收盘日按设置的日历(最后一根 13:00 收盘)', {
  settings: { early_close_days: ['2026-10-14', '2026-10-15'] },
  ports: { 'market.dailyHistory': [{ value: NVDA_D }, { value: AMD_D }, { value: TSLA_D }], 'market.dailyHistoryAskedAt': [{ value: etMs('2026-10-14', '14:00') }, { value: etMs('2026-10-14', '12:00') }, { value: etMs('2026-10-15', '13:30') }] },
  steps: [logSigs, call('a', 'review.signals'), call('b', 'review.signals', { days: 30 })],
});

// ---------------------------------------------------------------- 固定种子的随机参数
{
  const r = rng(0x7e71_c0de);
  const ids = ['ib:1001', 'ib:1001', 'ib:1001', 'ib:1002', 'ib:1003', 'ib:1004', 'ib:1005', 'ib:1005', 'ib:1006', 'LO', 'LO', 'LP', 'zzz', 'stk:nope', TRIP_CLOSED.id, TRIP_CLOSED.id, TRIP_OPEN.id, TRIP_OLD.id, ''];
  const tfs = ['auto', '1m', '2m', '5m', '15m', '30m', '1h', '1d', '7m', '', 'constructor', undefined];
  const val = (kind) => {
    const ok = () => ({ error: r.pick(['被拒', 'TWS 没数据']), kind: r.pick(['broker', 'rpc', 'plain']), code: -32015 });
    if (kind === 'bars') return r.chance(0.12) ? ok() : PA(r.pick([MIN_1, MIN_5, MIN_5, MIN_1, MIN_1_OLD, [], MIN_5.slice(0, 3)]));
    if (kind === 'hist') return r.chance(0.2) ? ok() : { value: r.pick([DAILY, [], DAILY.slice(-5)]) };
    return r.chance(0.3) ? ok() : { value: r.pick([MIN_1.slice(0, 60).map((b) => ({ time: b.time, close: 3 + r.next() })), []]) };
  };
  for (let n = 0; n < 44; n += 1) {
    const steps = [];
    if (r.chance(0.85)) steps.push({ op: 'h2router', v: 'make' });
    steps.push(st('rememberFills', [r.chance(0.9) ? (r.chance(0.7) ? withFly : withFly.filter(() => r.chance(0.8))) : []]));
    if (r.chance(0.5)) steps.push(st('createRecord', [localFly({ id: 'LO', hhmm: '09:48', fills: r.chance(0.5) ? [{ time: '2026-10-15T09:50:00-04:00', price: 3.2, qty: 1 }] : [], final_status: r.pick(['filled', 'submitted']) })]));
    if (r.chance(0.3)) steps.push(st('createRecord', [localFly({ id: 'LP', hhmm: '09:48', fills: [] })]));
    if (r.chance(0.4)) steps.push({ op: 'file', path: 'playbook/2026-10-15.jsonl', content: r.pick([PB_OPEN, PB_FRAME, 'junk\n']) });
    if (r.chance(0.3)) steps.push(st('signals.log', [sigRows.filter(() => r.chance(0.7))]));
    for (let i = 0; i < 6; i += 1) {
      const m = r.pick(['review.candidates', 'review.analyze', 'review.analyze', 'review.analyze', 'review.performance', 'review.signals']);
      const p = {};
      if (m === 'review.candidates') { if (r.chance(0.6)) p.limit = r.pick([1, 2, 5, 0, -1, '3', 'x', 200]); if (r.chance(0.5)) p.include_local = r.chance(0.7); }
      else if (m === 'review.analyze') { p.id = r.pick(ids); const t = r.pick(tfs); if (t !== undefined) p.timeframe = t; if (r.chance(0.3)) p.exit = r.pick([{ em: 25 }, { em: '' }, {}, null, [], { em: 'x', arm: 10 }]); }
      else { if (r.chance(0.6)) p.days = r.pick([1, 5, 30, 0, 3650, 3651, 2.5, null]); if (m === 'review.performance') { if (r.chance(0.5)) p.scope = r.pick(['all', 'paper', 'live']); if (r.chance(0.5)) p.kind = r.pick(['all', 'stock', 'butterfly', 'option']); } }
      steps.push(call(`c${i}`, m, p));
      if (r.chance(0.15)) steps.push({ op: 'h2routerSet', set: r.pick([{ sessions: 0 }, { sessions: 1 }]) });
    }
    scenarios.push({
      name: `随机 ${n}`,
      script: {
        start: START, seed: n + 1, dump: DUMP, files: ['playbook'], settings: r.chance(0.2) ? { early_close_days: ['2026-10-15'] } : undefined,
        h2router: { sessions: 1, noCombo: r.chance(0.1), results: { historicalBars: [val('hist'), val('hist')], comboBars: [val('fly'), val('fly')] } },
        ports: {
          'fillSync.sync': [r.chance(0.15) ? { error: '同步失败', kind: 'broker' } : r.pick([FILLED, { value: null }, { value: 0 }]), FILLED], 'fillSync.available': [{ value: r.chance(0.5) }],
          'stockTrips.trips': [{ value: r.pick([TRIPS, TRIPS, TRIPS, [], [TRIPS[0]], [...TRIPS, noTimeTrip]]) }],
          'market.paBars': [val('bars'), val('bars'), val('bars')], 'market.dailyHistory': [r.chance(0.2) ? { error: '超频', kind: 'broker' } : { value: r.pick([NVDA_D, AMD_D, TSLA_D, []]) }, { value: NVDA_D }],
          'market.dailyHistoryAskedAt': [{ value: r.pick([null, etMs('2026-10-16', '09:00'), etMs('2026-10-15', '14:00')]) }],
          'tradeHistory.ledger': [r.chance(0.2) ? { error: '账本读不了' } : { value: r.pick([LEDGER, { trades: [], excluded: { open: 0, unknown: 0, no_cost: 0 } }]) }],
        },
        steps,
      },
    });
  }
}

// 回执最后是 JSON.stringify 写给界面的:NaN 与 -0 在线上就是 null 与 0。纯计算模块(flyexit / performance)在这两处的内部表示与 TS 不同(C++ 给 null / +0),
// 线上没有差别,所以期望值按线上的样子写(其余的 enc 标记照旧,别处出现 NaN / -0 的差别仍然会红)。
const wire = (v) => (v === '__NaN__' ? null : v === '__neg0__' ? 0 : Array.isArray(v) ? v.map(wire) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) : v);
const out = [];
for (const s of scenarios) {
  if (s.script.settings === undefined) delete s.script.settings;
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: wire(enc(expected)) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_review.json'), text);
console.log(`h2_review.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
void noteIfEmpty;
