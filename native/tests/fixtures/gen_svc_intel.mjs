// 生成 svc_intel.json:engine-ts 的 services/intel.ts(原模块现跑)对着脚本驱动的假 router、真的交易库(消息底账 / 信号 / 单子 / 想法 / 追踪 / 板块 / 价位 / 异动)、真的 EventsService 与 MarketDataService、虚拟钟。
// C++ 一半:tests/tst_svc_intel.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_intel.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeFetcher, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { MarketDataService } = await mods.imp('services/marketData');
const { EventsService } = await mods.imp('services/events');
const { IntelService } = await mods.imp('services/intel');
const macro = await mods.imp('macro');

function build(world, host) {
  macro.clearMacroCache();
  const market = new MarketDataService(host);
  const events = new EventsService(host, makeFetcher(world));
  const changes = world.script.changePct ?? {};
  const anomaly = { metricsOf: (symbol) => (symbol in changes ? { metrics: { change_pct: changes[symbol] } } : undefined) };
  const intel = new IntelService(host, market, events, anomaly);
  return {
    methods: {
      record: (a) => intel.record(a.message, a.trusted).then(() => null),
      feed: (a) => intel.feed(a.params),
      dossier: (a) => intel.dossier(a.params),
      held: () => intel.heldRows(),
    },
    gets: {},
    ops: {},
  };
}

const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const E = (error, extra = {}) => ({ error, ...extra });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
const msg = (id, content, over = {}) => ({ id, channel_id: 'chan', author_id: 'u1', author_name: 'Charlie', content, sentAtMs: START - 60_000, ...over });
const pos = (symbol, qty, extra = {}) => ({ key: `主账户|${symbol}`, account: '主账户', symbol, sec_type: 'STK', leg: '', quantity: qty, avg_cost: 100, multiplier: 1, currency: 'USD', market_price: 110, market_value: null, unrealized_pnl: null, ...extra });
const NVDA = { secType: 'STK', symbol: 'NVDA', exchange: 'SMART', currency: 'USD' };
const SEEDS = [
  st('addWatch', ['AAPL', 0]), st('addQualityStock', ['TSLA', '观察']), st('addSector', ['半导体']),
  st('addTrack', [{ account: '主账户', symbol: 'NVDA', sec_type: 'STK', contract: NVDA, targets: { take_profit: 250, stop_loss: 160 }, auto_close: { enabled: true, host_at_broker: true }, peak: 220 }]),
  st('addIdea', ['想买 NVDA 的虚值认购,观察 SPX 7700 附近', ['NVDA']]), st('addIdea', ['TSLA 财报前别追高']),
  st('messages.add', [{ at: iso(START - 3600_000), source: 'discord', message_id: 'm-old1', author_id: 'u1', author_name: 'Charlie', text: 'buy NVDA 220c 3.2 limit', symbols: ['NVDA'], guesses: [], trusted: true, prices: { NVDA: 215.5 } }]),
  st('messages.add', [{ at: iso(START - 1800_000), source: 'local', message_id: 'm-old2', author_id: 'u1', author_name: 'Charlie', text: 'SPX 7700 看跌蝶 -1.2', symbols: ['SPX'], guesses: ['TSLA'], trusted: true, prices: {} }]),
  st('follow.add', [{ at: iso(START - 3500_000), message_id: 'm-old1', author_id: 'u1', author_name: 'Charlie', text: 'buy NVDA 220c', outcome: 'sent', detail: 'ok', summary: '跟单 NVDA', record_ids: ['r1'] }]),
  st('signals.log', [[{ at: iso(START - 7200_000), source: 'cross', symbol: 'NVDA', expect: 'up', price: 216, label: '上穿 215', variant: null }, { at: iso(START - 900_000), source: 'spike', symbol: 'TSLA', expect: null, price: 250, label: '放量', variant: 'x' }, { at: iso(START - 600_000), source: 'cross', symbol: 'NVDA', expect: 'down', price: 214, label: '下穿 215', variant: null }]]),
  st('createRecord', [{ created_at: iso(START - 1200_000), account: { alias: '主账户', account_id: 'U1234567', is_paper: false }, contract: { secType: 'STK', symbol: 'NVDA' }, order: { action: 'BUY', quantity: 10, totalQuantity: 10 }, llm: { intent_summary: '买 10 股 NVDA' }, input: { raw_instruction: 'buy 10 nvda', input_channel: 'manual' } }]),
];
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log'], ...script } });
const fetch = { feed: [R([])], yahoo: [E('no')], cboe: [E('no')] };
const router = (extra = {}) => ({
  results: {
    positions: [R([pos('NVDA', 100), pos('AAPL', 0, { quantity: 50 }), pos('SPY', 5, { unrealized_pnl: 12.5 }), pos('QQQ', 5, { market_price: null })])],
    streamQuotes: [R({ NVDA: { last: 216.2, last_trade_at: 1791810000 }, AAPL: { last: 230 }, TSLA: { last: 251 }, SPY: { last: 600 } })],
    indexPrice: [R(7712.5)], historicalBars: [R(Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.parse('2026-08-20') + i * 86400000).toISOString().slice(0, 10), open: 1, high: 2, low: 1, close: 100 + i, volume: 1 })))],
    ...extra,
  },
  spotInfo: { SPX: { source: 'index' } },
});

add('record:不信任的不落;信任的取标的、持仓提及推 held_mention,否则推 message;重复的不落', {
  fetch, router: router(), changePct: { NVDA: 1.8 },
  steps: [...SEEDS, { op: 'port', v: 'make' },
    call('r0', 'record', { message: msg('m1', 'NVDA 220c 看涨'), trusted: false }),
    call('r1', 'record', { message: msg('m2', 'NVDA 220c 看涨 3.2'), trusted: true }),
    call('r2', 'record', { message: msg('m2', 'NVDA 220c 看涨 3.2'), trusted: true }),
    call('r3', 'record', { message: msg('m3', 'SPX 7700 蝶 1.2 TSLA AAPL', { channel_id: 'local', sentAtMs: START - 5500 }), trusted: true }),
    call('r4', 'record', { message: msg('m4', '随便聊聊 今天天气', { author_name: 'x'.repeat(100) }), trusted: true }),
    call('r5', 'record', { message: msg('m5', 'NVDA AAPL TSLA SPY QQQ 一起看', { content: 'NVDA AAPL TSLA SPY QQQ 一起看 ' + 'z'.repeat(300) }), trusted: true }),
    call('f', 'feed', { params: {} }), call('f2', 'feed', { params: { symbol: 'nvda', limit: 3 } })],
});
add('feed:参数校验;held_only / kinds / since 筛;没连券商价取不到;持仓读失败回缓存', {
  fetch, router: router({ positions: [R([pos('NVDA', 100)]), E('读不到'), R([pos('NVDA', 100)])] }), changePct: {},
  steps: [...SEEDS, call('n', 'feed', { params: {} }), { op: 'port', v: 'make' },
    call('b1', 'feed', { params: { symbol: 'bad symbol!' } }), call('b2', 'feed', { params: { symbol: '' } }), call('b3', 'feed', { params: { limit: -3 } }), call('b4', 'feed', { params: { limit: '20' } }),
    call('h', 'feed', { params: { held_only: true } }), call('k', 'feed', { params: { kinds: ['message', 'signal'] } }), call('s', 'feed', { params: { since: START - 1000_000 } }),
    { op: 'advance', ms: 10_001 }, call('h2', 'feed', { params: {} }), { op: 'advance', ms: 10_001 }, call('h3', 'feed', { params: {} })],
});
add('dossier:持仓 / 追踪 / 在途 / 板块 / 价位 / 异动 / 想法 / 事件 / 信号条数 / 时间线;指数与没订的票的价', {
  fetch, router: router(), changePct: { NVDA: 1.8, TSLA: -0.7 },
  steps: [...SEEDS, { op: 'port', v: 'make' }, call('d0', 'dossier', { params: { symbol: 'nvda' } }), call('d1', 'dossier', { params: { symbol: 'TSLA', limit: 5 } }),
    call('d2', 'dossier', { params: { symbol: 'SPX' } }), call('d3', 'dossier', { params: { symbol: 'AAPL' } }), call('d4', 'dossier', { params: { symbol: 'ZZZ' } }),
    call('d5', 'dossier', { params: { symbol: '??' } }), call('d6', 'dossier', { params: {} }), { op: 'portSet', set: { sessions: 0 } }, call('d7', 'dossier', { params: { symbol: 'NVDA' } })],
});

const D30 = 30 * 24 * 3600_000;
add('边界与小样本:时间线回看恰好 30 天;日线只有两根 / 一根;symbol 两头有空白;工作单超过 20 条;盯价位事件超过 10 条;异动没开;想法只靠 symbols 挂上;前一小时的自定义事件', {
  fetch, router: router({ results: { positions: [R([pos('NVDA', 100), pos('XNO', 5, { currency: undefined, sec_type: undefined })])], streamQuotes: [R({ NVDA: { last: 216.2 }, AAPL: { last: 230 }, TSLA: { last: 251 } })], historicalBars: [R([{ date: '2026-10-08', close: 50 }, { date: '2026-10-09', close: 51.5 }]), R([{ date: '2026-10-09', close: 51.5 }]), R([{ date: '2026-10-08', close: 0 }, { date: '2026-10-09', close: 51.5 }])] } }), changePct: { NVDA: 1.8, AAPL: 0.4 },
  steps: [...SEEDS,
    st('createRecord', [{ created_at: iso(START - D30), account: { alias: '主账户', account_id: 'U1234567', is_paper: false }, contract: { secType: 'STK', symbol: 'AAPL' }, order: { action: 'BUY', quantity: 1, totalQuantity: 1 }, llm: { intent_summary: '恰好 30 天' }, input: { raw_instruction: 'x', input_channel: 'manual' } }]),
    st('createRecord', [{ created_at: iso(START - D30 - 1000), account: { alias: '主账户', account_id: 'U1234567', is_paper: false }, contract: { secType: 'STK', symbol: 'AAPL' }, order: { action: 'BUY', quantity: 1, totalQuantity: 1 }, llm: { intent_summary: '早一秒' }, input: { raw_instruction: 'y', input_channel: 'manual' } }]),
    st('signals.log', [[{ at: iso(START - D30 - 3600_000 * 12), source: 'cross', symbol: 'NVDA', expect: 'up', price: 200, label: '三十天半前', variant: null }, { at: iso(START - D30 + 3600_000), source: 'cross', symbol: 'NVDA', expect: 'up', price: 201, label: '三十天内', variant: null }]]),
    ...Array.from({ length: 22 }, (_, i) => st('createRecord', [{ created_at: iso(START - 1000 * (i + 1)), account: { alias: '主账户', account_id: 'U1234567', is_paper: false }, contract: { secType: 'STK', symbol: 'NVDA' }, order: { action: 'BUY', quantity: 1, totalQuantity: 1 }, llm: { intent_summary: `买 ${i}` }, input: { raw_instruction: `w${i}`, input_channel: 'manual' } }])),
    ...Array.from({ length: 1 }, () => st('$updateWatch', [['AAPL', { events: Array.from({ length: 13 }, (_, i) => ({ at: iso(START - i * 1000), kind: 'cross', price: 230 + i })) }]])),
    st('$updateQualityStock', [['TSLA', { enabled: 0 }]]),
    st('addIdea', ['随便写写,没提代码', ['AAPL']]), st('addIdea', ['7700 蝶 平仓太早']),
    st('setPref', ['events_custom', [{ id: 'past', title: 'NVDA 前一小时的事', date_et: '2026-10-12', time_et: '09:30', note: '', impact: 'high', linger_min: 90 }]]),
    { op: 'port', v: 'make' },
    call('d1', 'dossier', { params: { symbol: ' nvda ' } }), call('d2', 'dossier', { params: { symbol: 'AAPL' } }), call('d3', 'dossier', { params: { symbol: 'TSLA' } }), call('d4', 'dossier', { params: { symbol: 'SPX' } }),
    call('d5', 'dossier', { params: { symbol: 'XNO' } }), call('d6', 'dossier', { params: { symbol: 'ZZ1' } }), call('d7', 'dossier', { params: { symbol: 'ZZ2' } }), call('d8', 'dossier', { params: { symbol: 'ZZ3' } }),
    call('f1', 'feed', { params: { symbol: ' nvda ' } }), call('f2', 'feed', { params: {} })],
});

// ---- 随机
{
  const r = rng(0x1417_e101);
  const symbols = ['NVDA', 'AAPL', 'TSLA', 'SPX', 'SPY', 'QQQ', 'ZZZ'];
  const texts = ['NVDA 220c 看涨 3.2', 'SPX 7700 蝶 1.2', '随便聊聊', 'TSLA AAPL 都不错', '$QQQ cashtag', '苹果 财报', 'buy SPY'];
  for (let n = 0; n < 40; n += 1) {
    const results = {
      positions: Array.from({ length: 3 }, () => (r.chance(0.15) ? E('读不到') : R([pos('NVDA', r.pick([0, 100])), pos('AAPL', 5), pos('SPY', 5, { unrealized_pnl: 1 })], r.chance(0.2) ? { delay: r.pick([10, 4000]) } : {}))),
      streamQuotes: Array.from({ length: 3 }, () => (r.chance(0.15) ? E('流断了') : R(Object.fromEntries(symbols.filter(() => r.chance(0.7)).map((s) => [s, { last: 100 + r.int(100) }]))))),
      indexPrice: [R(7700 + r.int(50)), R(null)],
      historicalBars: [R(Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`, open: 1, high: 2, low: 1, close: 100 + i, volume: 1 })))],
    };
    const steps = [...SEEDS.filter(() => r.chance(0.8)), { op: 'port', v: 'make' }];
    for (let i = 0; i < 16; i += 1) {
      const p = r.next();
      if (p < 0.30) steps.push(call(`r${i}`, 'record', { message: msg(`mm${r.int(6)}`, r.pick(texts), { sentAtMs: START - r.int(900000) }), trusted: r.chance(0.8) }));
      else if (p < 0.50) steps.push(call(`f${i}`, 'feed', { params: r.pick([{}, { symbol: r.pick(symbols) }, { held_only: true }, { limit: 2 }, { kinds: ['order', 'idea'] }]) }));
      else if (p < 0.70) steps.push(call(`d${i}`, 'dossier', { params: { symbol: r.pick(symbols), ...(r.chance(0.3) ? { limit: 3 } : {}) } }));
      else if (p < 0.90) steps.push({ op: 'advance', ms: r.pick([1, 500, 5000, 10001, 61000]) });
      else if (p < 0.95) steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]) } });
      else steps.push(call(`h${i}`, 'held'));
    }
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, dump: ['audit_log'], fetch, router: { results, spotInfo: { SPX: { source: 'index' } } }, changePct: { NVDA: 1.2 }, steps } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_intel.json'), text);
console.log(`svc_intel.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
