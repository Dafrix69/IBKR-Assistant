// 生成 svc_trades.json:engine-ts 的 services/{stockTrips,tradeHistory,similarContext}.ts(原模块现跑)对着脚本驱动的假 router、真的交易库(成交 / 导入的期权 / 入场标的价)、虚拟钟。
// C++ 一半:tests/tst_svc_trades.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_trades.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { MarketDataService } = await mods.imp('services/marketData');
const { StockTripsService } = await mods.imp('services/stockTrips');
const { TradeHistoryService } = await mods.imp('services/tradeHistory');
const { SimilarContextService } = await mods.imp('services/similarContext');
const { groupButterflies } = await mods.imp('ibtrades');

function build(world, host) {
  const market = new MarketDataService(host);
  const stock = new StockTripsService(host);
  const hist = new TradeHistoryService(host, market, stock);
  const sim = new SimilarContextService(host, market);
  sim.backfillGapMs = world.script.backfillGapMs ?? 8000;
  const mapPairs = (m) => [...m.entries()];
  return {
    methods: {
      trips: () => stock.trips(),
      load: (a) => hist.load(a.symbols ?? []).then((r) => (a.full ? r : { facts: r.facts, butterflies: r.butterflies.map((b) => b.id), options: r.options.length, positions: r.positions.length })),
      ledger: () => hist.ledger(),
      spot: (a) => sim.spot(a.symbol),
      fly: (a) => sim.flyEntryUnderlyings(deref(a.butterflies), deref(a.positions), a.symbol).then(mapPairs),
      ranges: (a) => sim.stockRanges(a.symbol, deref(a.facts)).then((r) => ({ query: r.query, byId: mapPairs(r.byId) })),
      idle: () => sim.idle().then(() => null),
    },
    gets: {},
    ops: { gap: (step) => { sim.backfillGapMs = step.ms; } },
  };
}

const SHARED = {};
const deref = (v) => (v && typeof v === 'object' && !Array.isArray(v) && '$ref' in v ? structuredClone(SHARED[v.$ref]) : v);
const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const ACCT = 'U1234567';
const PAPER = 'DU7654321';
let execN = 0;
function fillRow(secType, symbol, side, shares, price, time, perm, c = {}) {
  execN += 1;
  return {
    exec_id: `x${String(execN).padStart(4, '0')}`, time, account_id: c.account ?? ACCT, side, shares, price, order_id: null, perm_id: perm, order_ref: '', commission: c.commission ?? 0,
    contract: { secType, symbol, expiry: c.expiry ?? '', strike: c.strike ?? null, right: c.right ?? '', tradingClass: c.tc ?? '', multiplier: c.mult ?? '', conId: c.conId ?? 1, currency: 'USD', exchange: c.exchange ?? 'SMART' },
  };
}
/** 一张 1:2:1 的蝴蝶一次动作:一条 BAG 行 + 三条腿 */
function fly(side, price, legs, time, perm, expiry, account = ACCT) {
  const opp = side === 'BOT' ? 'SLD' : 'BOT';
  const strikes = [7660, 7680, 7700];
  const out = [fillRow('BAG', 'SPX', side, 1, price, time, perm, { account, conId: 28812380, exchange: 'SMART' })];
  strikes.forEach((strike, i) => out.push(fillRow('OPT', 'SPX', i === 1 ? opp : side, i === 1 ? 2 : 1, legs[i], time, perm,
    { account, expiry, strike, right: 'C', tc: 'SPXW', mult: '100', conId: 800001 + i, exchange: 'CBOE', commission: 1.6 })));
  return out;
}
const stock = (symbol, side, shares, price, time, perm, account = ACCT) => fillRow('STK', symbol, side, shares, price, time, perm, { account, commission: 1 });

const FILLS = [
  // 已平的蝴蝶:9-21 开,9-21 平
  ...fly('BOT', 3.55, [11, 4.5, 1.55], '2026-09-21T14:05:00+00:00', 5001, '20260921'),
  ...fly('SLD', 5.2, [14, 6, 2.2], '2026-09-21T18:40:00+00:00', 5002, '20260921'),
  // 持有到期的蝴蝶(到期日已过,没有平仓,要按日线收盘结算)
  ...fly('BOT', 4.1, [12, 5, 1.8], '2026-09-30T14:00:00+00:00', 5003, '20260930'),
  // Flex 仓位(p2)覆盖的那一天(10-08)里券商成交合成的蝴蝶:让给仓位,不算两遍
  ...fly('BOT', 4.0, [12, 5, 1.8], '2026-10-08T15:00:00+00:00', 5005, '20261008'),
  ...fly('SLD', 6.0, [15, 6, 2.0], '2026-10-08T18:00:00+00:00', 5006, '20261008'),
  // 模拟账户的一张,今天到期,还没到收盘
  ...fly('BOT', 2.9, [10, 4, 1.2], '2026-10-12T13:45:00+00:00', 5004, '20261012', PAPER),
  // 股票:RKLB 买两次卖一次、NVDA 买入没卖(开着)、AAPL 先卖后买(做空)
  stock('RKLB', 'BOT', 100, 60, '2026-09-15T14:00:00+00:00', 6001), stock('RKLB', 'BOT', 50, 62, '2026-09-16T14:00:00+00:00', 6002),
  stock('RKLB', 'SLD', 150, 66, '2026-09-18T15:00:00+00:00', 6003),
  stock('NVDA', 'BOT', 10, 180, '2026-10-01T14:00:00+00:00', 6004),
  stock('AAPL', 'SLD', 20, 230, '2026-10-02T14:00:00+00:00', 6005), stock('AAPL', 'BOT', 20, 225, '2026-10-05T14:00:00+00:00', 6006),
];
const OPTION_TRADES = [
  { account_id: ACCT, id: 'o1', time_et: '2026-09-10 10:00:00', date_et: '2026-09-10', symbol: 'SPX', structure: '蝴蝶', action: '开仓', direction: '买方', qty: 1, net_price: 3, realized_pnl: 0, commission: 2, legs: '', note: '', source: 'flex' },
  { account_id: ACCT, id: 'o2', time_et: '2026-09-10 15:00:00', date_et: '2026-09-10', symbol: 'SPX', structure: '蝴蝶', action: '平仓', direction: '买方', qty: 1, net_price: 4.5, realized_pnl: 148, commission: 2, legs: '', note: '', source: 'flex' },
  { account_id: ACCT, id: 'o3', time_et: '2026-09-21 10:00:00', date_et: '2026-09-21', symbol: 'SPX', structure: '蝴蝶', action: '开仓', direction: '买方', qty: 1, net_price: 3.5, realized_pnl: 0, commission: 2, legs: '', note: '', source: 'flex' },
];
const OPTION_POSITIONS = [
  { account_id: ACCT, id: 'p1', open_et: '2026-09-22 10:05:00', symbol: 'SPX', structure: '蝴蝶', direction: '买方', qty: 1, expiry: '20260922', dte: 0, right: 'C', strikes: '7600/7620/7640', center: 7620, width: 20, ratio: '1:2:1', net_price: 3.2, legs: 'B1 C7600,S2 C7620,B1 C7640', exit: '整体平仓', status: '已了结', closed_et: '2026-09-22 14:30:00', hold_min: 265, realized_pnl: 180, commission: 4, source: 'flex' },
  { account_id: ACCT, id: 'p2', open_et: '2026-10-08 11:00:00', symbol: 'SPX', structure: '蝴蝶', direction: '买方', qty: 2, expiry: '20261008', dte: 0, right: 'P', strikes: '7700/7720/7740', center: 7720, width: 20, ratio: '1:2:1', net_price: 4, legs: '', exit: '持有到期', status: '已了结', closed_et: '2026-10-08 16:00:00', hold_min: 300, realized_pnl: -310, commission: 8, source: 'flex' },
  { account_id: ACCT, id: 'p3', open_et: '2026-10-09 10:00:00', symbol: 'SPX', structure: '垂直价差', direction: '贷方看空', qty: 1, expiry: '20261009', dte: 0, right: 'C', strikes: '7800/7805', center: null, width: 5, ratio: '', net_price: -1.2, legs: '', exit: '整体平仓', status: '已了结', closed_et: '2026-10-09 12:00:00', hold_min: 120, realized_pnl: 60, commission: 2, source: 'flex' },
  { account_id: PAPER, id: 'p4', open_et: '2026-10-09 10:00:00', symbol: 'SPX', structure: '蝴蝶', direction: '买方', qty: 1, expiry: '20261009', dte: 0, right: 'C', strikes: '7800/7820/7840', center: 7820, width: 20, ratio: '1:2:1', net_price: 3, legs: '', exit: '持仓中', status: '持仓中', closed_et: '', hold_min: null, realized_pnl: 0, commission: 1, source: 'flex' },
];
const planned = (symbol, stop, account = '主账户') => st('audit', ['ui', 'tracker_add', { symbol, account, sec_type: 'STK', targets: { stop_loss: stop } }]);

const bar = (time, close) => ({ time, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 });
const dbar = (date, close) => ({ date, open: close - 1, high: close + 2, low: close - 2, close, volume: 5000 });
const dailySpx = [dbar('2026-09-21', 7650), dbar('2026-09-30', 7688), dbar('2026-10-01', 7700), dbar('2026-10-12', 7755)];
const dailyRkLB = Array.from({ length: 30 }, (_, i) => dbar(new Date(Date.parse('2026-08-20') + i * 86400000).toISOString().slice(0, 10), 55 + (i % 9) * 2));
const dailySpike = dailyRkLB.map((b) => (b.date === '2026-09-15' ? { ...b, close: 500, high: 502 } : b));

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log'], ...script } });
const pos = (symbol, qty, account = '主账户', secType = 'STK') => ({ key: `${account}|${symbol}`, account, symbol, sec_type: secType, leg: '', quantity: qty, avg_cost: 10 });

add('stockTrips:没连券商不核对期初;连上按当前持仓反推,15 秒缓存;券商报错回到不核对;换账户映射', {
  router: { results: { positions: [R([pos('RKLB', 0), pos('NVDA', 10), pos('NVDA', 5), pos('XYZ', 3, '不认识的账户'), pos('AAPL', -20, '主账户', 'OPT')]), R(null, { error: '读不到持仓' }), R([pos('NVDA', 10)])] } },
  steps: [st('rememberFills', [FILLS]), call('a', 'trips'), { op: 'port', v: 'make' }, call('b', 'trips'), call('c', 'trips'), { op: 'advance', ms: 14999 }, call('d', 'trips'), { op: 'advance', ms: 2 }, call('e', 'trips'),
    { op: 'advance', ms: 15001 }, call('f', 'trips'), { op: 'portSet', set: { sessions: 0 } }, call('g', 'trips'), { op: 'portSet', set: { sessions: 1 } }, call('h', 'trips')],
});
add('stockTrips:positions 抛的不是券商的错照抛', {
  router: { results: { positions: [R(null, { error: 'boom', kind: 'plain' }), R([pos('NVDA', 10)])] } },
  steps: [st('rememberFills', [FILLS]), { op: 'port', v: 'make' }, call('a', 'trips'), call('b', 'trips')],
});
add('tradeHistory.load:成交合成的蝴蝶 + 持有到期的按日线收盘结算 + 股票段 + 导入的期权;Flex 仓位覆盖的日子让给仓位', {
  router: { results: { historicalBars: [R(dailySpx), R(dailySpx)] }, spotInfo: {} },
  steps: [st('rememberFills', [FILLS]), st('imports.rememberOptionTrades', [OPTION_TRADES]), st('imports.rememberOptionPositions', [OPTION_POSITIONS]),
    call('noRouter', 'load'), { op: 'port', v: 'make' }, call('all', 'load', { full: true }), call('spx', 'load', { symbols: ['spx'] }), call('rk', 'load', { symbols: ['RKLB', 'NVDA'] })],
});
add('tradeHistory.load:没有导入的数据、历史取不到(结果不明)', {
  router: { results: { historicalBars: [R(null, { error: '没权限' })] } },
  steps: [st('rememberFills', [FILLS]), { op: 'port', v: 'make' }, call('a', 'load')],
});
add('tradeHistory.ledger:账本;计划止损来自审计表;Flex 覆盖的 (账户,日期) 上的导入期权让位', {
  router: { results: { historicalBars: [R(dailySpx)] } },
  steps: [st('rememberFills', [FILLS]), st('imports.rememberOptionTrades', [OPTION_TRADES]), st('imports.rememberOptionPositions', [OPTION_POSITIONS]),
    planned('RKLB', 58), planned('nvda', 170), st('audit', ['ui', 'tracker_add', { symbol: 'BAD', targets: { stop_loss: -1 } }]), st('audit', ['ui', 'tracker_add', { symbol: '', targets: { stop_loss: 5 } }]),
    { op: 'port', v: 'make' }, call('l', 'ledger'), { op: 'portSet', set: { sessions: 0 } }, call('l2', 'ledger')],
});

// ---- similarContext
const butterflies = groupButterflies(FILLS, [{ alias: '主账户', account_id: ACCT, is_paper: false }, { alias: '模拟', account_id: PAPER, is_paper: true }]);
const bf = { $ref: 'bf' };
SHARED.bf = JSON.parse(JSON.stringify(butterflies));
const mins = (day, n = 70) => Array.from({ length: n }, (_, i) => { const m = 9 * 60 + 30 + i; return bar(`${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 7600 + (i % 60)); });
const flexPos = { $ref: 'flexPos' };
SHARED.flexPos = OPTION_POSITIONS.map((p) => ({ ...p }));
add('similarContext:没连券商只给库里已有的;连上按开仓日取 1 分钟线补,最近三天当场、其余后台一天一天补', {
  backfillGapMs: 100,
  router: { results: { intradayBars: [R({ bars: mins('2026-09-21') }), R({ bars: mins('2026-09-30') }), R({ bars: mins('2026-10-12') }), R({ bars: mins('2026-10-08') }), R({ bars: mins('2026-10-09') }), R({ bars: [] })] } },
  steps: [st('rememberFills', [FILLS]), st('imports.rememberEntryUnderlying', ['p1', 'SPX', '2026-09-22T14:05:00.000Z', 7633.5, 'seed']),
    call('n', 'fly', { butterflies: bf, positions: flexPos, symbol: 'SPX' }), { op: 'port', v: 'make' },
    call('f', 'fly', { butterflies: bf, positions: flexPos, symbol: 'SPX' }), call('i', 'idle'), { op: 'advance', ms: 250 }, call('i2', 'idle'), { op: 'advance', ms: 1000 },
    call('g', 'fly', { butterflies: bf, positions: flexPos, symbol: 'SPX' }), { op: 'advance', ms: 1000 }, call('i3', 'idle'),
    st('imports.entryUnderlyings', [['p1', 'p2', 'p3']])],
});
add('similarContext:取分钟线出错 / 没有那一刻的价 / 后台补到一半券商断了', {
  backfillGapMs: 50,
  router: { results: { intradayBars: [R(null, { error: '没数据' }), R({ bars: mins('2026-09-30', 3) }), R({ bars: mins('2026-10-12') }), R({ bars: mins('2026-10-08') })] } },
  steps: [st('rememberFills', [FILLS]), { op: 'port', v: 'make' }, call('f', 'fly', { butterflies: bf, positions: flexPos, symbol: 'SPX' }),
    { op: 'portSet', set: { sessions: 0 } }, { op: 'advance', ms: 500 }, call('i', 'idle'), { op: 'portSet', set: { sessions: 1 } }, call('g', 'fly', { butterflies: bf, positions: flexPos, symbol: 'SPX' }), { op: 'advance', ms: 500 }, call('i2', 'idle')],
});
SHARED.factsStock = [
  { id: 'stk:1', kind: 'stock', symbol: 'RKLB', opened_at: '2026-09-15 10:00:00', entry_price: 60 },
  { id: 'stk:2', kind: 'stock', symbol: 'rklb', opened_at: '2026-09-16T14:00:00+00:00', entry_price: null },
  { id: 'stk:3', kind: 'stock', symbol: 'RKLB', opened_at: 'garbage', entry_price: 61 },
  { id: 'stk:4', kind: 'butterfly', symbol: 'RKLB', opened_at: '2026-09-15 10:00:00', entry_price: 60 },
  { id: 'stk:5', kind: 'stock', symbol: 'NVDA', opened_at: '2026-09-15 10:00:00', entry_price: 60 },
  { id: 'stk:6', kind: 'stock', symbol: 'RKLB', opened_at: '2026-09-10 10:00:00', entry_price: 70 },
];
add('similarContext.stockRanges / spot:日线区间位置;日线取不到整体空;现价取不到 query 空', {
  router: { results: { historicalBars: [R(dailyRkLB), R(null, { error: '没权限' }), R(dailyRkLB)], streamQuotes: [R({ RKLB: { last: 66 } }), R({}), R(null, { error: 'x' })] } },
  steps: [call('s0', 'spot', { symbol: 'RKLB' }), { op: 'port', v: 'make' }, call('r1', 'ranges', { symbol: 'RKLB', facts: { $ref: 'factsStock' } }), { op: 'advance', ms: 600001 }, call('r2', 'ranges', { symbol: 'RKLB', facts: { $ref: 'factsStock' } }),
    { op: 'advance', ms: 600001 }, call('r3', 'ranges', { symbol: 'RKLB', facts: { $ref: 'factsStock' } }), call('s1', 'spot', { symbol: 'RKLB' })],
});

add('similarContext.stockRanges:开仓当天的日线不算进「之前」的区间', {
  router: { results: { historicalBars: [R(dailySpike)], streamQuotes: [R({ RKLB: { last: 66 } })] } },
  steps: [{ op: 'port', v: 'make' }, call('r1', 'ranges', { symbol: 'RKLB', facts: { $ref: 'factsStock' } })],
});
add('stockTrips:持仓缓存恰好 15 秒就重取', {
  router: { results: { positions: [R([pos('NVDA', 10)]), R([pos('NVDA', 10)]), R([pos('NVDA', 10)])] } },
  steps: [st('rememberFills', [FILLS]), { op: 'port', v: 'make' }, call('a', 'trips'), { op: 'advance', ms: 15000 }, call('b', 'trips'), { op: 'advance', ms: 14999 }, call('c', 'trips'), call('d', 'trips')],
});
add('tradeHistory.ledger:计划止损在开仓之前建的,按它算 R;盈亏比里的标的对得上', {
  start: Date.parse('2026-09-14T09:00:00-04:00'),
  router: { results: { historicalBars: [R(dailySpx)] } },
  steps: [planned('RKLB', 58), planned('aapl', 232), planned('NVDA', 170), st('rememberFills', [FILLS]), { op: 'port', v: 'make' }, call('l', 'ledger')],
});
// ---- 种子固定的随机交错
{
  const r = rng(0x7a4d_e5e1);
  for (let n = 0; n < 30; n += 1) {
    const results = {
      positions: Array.from({ length: 3 }, () => (r.chance(0.2) ? R(null, { error: r.pick(['读不到', 'boom']), ...(r.chance(0.3) ? { kind: 'plain' } : {}) }) : R([pos('RKLB', r.pick([0, 150, 50])), pos('NVDA', r.pick([0, 10])), pos('AAPL', r.pick([-20, 0]))], r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}))),
      historicalBars: Array.from({ length: 3 }, () => (r.chance(0.2) ? R(null, { error: '没权限' }) : R(r.pick([dailySpx, dailyRkLB]), r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}))),
      streamQuotes: Array.from({ length: 3 }, () => R({ RKLB: { last: 66 }, SPX: { last: 7750 } })),
      indexPrice: [R(7755)],
      intradayBars: Array.from({ length: 4 }, () => (r.chance(0.25) ? R(null, { error: '没数据' }) : R({ bars: mins(r.pick(['2026-09-21', '2026-09-30', '2026-10-12', '2026-10-08', '2026-10-09']), r.pick([3, 70])) }, r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}))),
    };
    const steps = [st('rememberFills', [FILLS.filter(() => r.chance(0.85))])];
    if (r.chance(0.5)) steps.push(st('imports.rememberOptionPositions', [OPTION_POSITIONS.filter(() => r.chance(0.7))]));
    if (r.chance(0.5)) steps.push(st('imports.rememberOptionTrades', [OPTION_TRADES.filter(() => r.chance(0.7))]));
    steps.push({ op: 'port', v: 'make' });
    for (let i = 0; i < 18; i += 1) {
      const p = r.next();
      if (p < 0.12) steps.push(call(`t${i}`, 'trips'));
      else if (p < 0.24) steps.push(call(`l${i}`, 'load', { symbols: r.pick([[], ['SPX'], ['RKLB'], ['spx', 'nvda']]) }));
      else if (p < 0.32) steps.push(call(`g${i}`, 'ledger'));
      else if (p < 0.44) steps.push(call(`f${i}`, 'fly', { butterflies: bf, positions: r.pick([[], flexPos]), symbol: 'SPX' }));
      else if (p < 0.50) steps.push(call(`r${i}`, 'ranges', { symbol: 'RKLB', facts: { $ref: 'factsStock' } }));
      else if (p < 0.55) steps.push(call(`s${i}`, 'spot', { symbol: r.pick(['RKLB', 'SPX']) }));
      else if (p < 0.60) steps.push(call(`i${i}`, 'idle'));
      else if (p < 0.88) steps.push({ op: 'advance', ms: r.pick([1, 60, 200, 5000, 15001, 600001]) });
      else if (p < 0.94) steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]) } });
      else steps.push(planned(r.pick(['RKLB', 'NVDA']), 50 + r.int(100)));
    }
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, dump: ['audit_log'], backfillGapMs: r.pick([50, 500, 8000]), router: { results, spotInfo: { SPX: { source: 'index' } } }, steps } });
  }
}

const out = [];
for (const s of scenarios) {
  execN = 0;
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, shared: enc(SHARED), scenarios: out });
writeFileSync(join(here, 'svc_trades.json'), text);
console.log(`svc_trades.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB;蝴蝶 ${butterflies.length} 条`);
