// 生成 svc_marketdata.json:engine-ts 的 services/marketData.ts(原模块现跑)对着脚本驱动的假 router、虚拟钟:期权墙 / 日线历史 / 现价 / K 线的缓存与节流。
// C++ 一半:tests/tst_svc_marketdata.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_marketdata.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { MarketDataService } = await mods.imp('services/marketData');

const orNull = (v) => (v === undefined ? null : v);
function build(world, host) {
  const svc = new MarketDataService(host);
  return {
    methods: {
      wallFor: (a) => svc.wallFor(a.symbol, a.expiry ?? null, a.width, a.span ?? null, a.preferClass),
      dailyHistory: (a) => svc.dailyHistory(a.symbol, a.spanDays),
      spotOf: (a) => svc.spotOf(a.symbol),
      quoteOf: (a) => svc.quoteOf(a.symbol),
      quotesOf: (a) => svc.quotesOf(a.symbols).then((m) => [...m.entries()]),
      paBars: (a) => svc.paBars(a.symbol, a.timeframe, a.rth, a.force, a.indexProxy).then(([bars, cached, askedAt, feed]) => [[...bars], cached, askedAt, feed]),
    },
    gets: { askedAt: (a) => orNull(svc.dailyHistoryAskedAt(a.symbol)) },
  };
}

const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log'], ...script } });

function chain(r, spot = 7750, over = {}) {
  const rows = [];
  for (let k = -6; k <= 6; k += 1) {
    const strike = 7750 + k * 10;
    for (const right of ['C', 'P']) {
      rows.push({ strike, right, oi: Math.round(r.next() * 3000), volume: Math.round(r.next() * 900), gamma: r.chance(0.9) ? Math.round(r.next() * 1e5) / 1e7 : null, iv: r.chance(0.9) ? 0.1 + Math.round(r.next() * 1000) / 10000 : null });
    }
  }
  return { symbol: 'SPX', expiry: '20261012', spot, multiplier: 100, trading_class: 'SPXW', strike_count: 13, grid_count: 13, expiries: ['20261012', '20261013'], spot_source: 'quote', rows, ...over };
}
const bar = (time, close) => ({ time, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000 });
const dbar = (date, close) => ({ date, open: close - 1, high: close + 2, low: close - 2, close, volume: 5000 });
const rr = rng(0xfee1_600d);
const CH = chain(rr);

add('wallFor:取一次、一分钟内走缓存、过了重取;键由 expiry / width / 有无 span / preferClass 决定', {
  router: { results: { optionChain: [R(CH), R(chain(rr, 7755)), R(chain(rr, 7760, { strike_count: 7, grid_count: 41 }))] } },
  steps: [{ op: 'port', v: 'make' },
    call('a', 'wallFor', { symbol: 'SPX', expiry: null }),
    call('b', 'wallFor', { symbol: 'SPX', expiry: null }), { op: 'advance', ms: 59999 },
    call('c', 'wallFor', { symbol: 'SPX', expiry: null }), { op: 'advance', ms: 2 },
    call('d', 'wallFor', { symbol: 'SPX', expiry: null }),
    call('e', 'wallFor', { symbol: 'SPX', expiry: '20261012', width: 6 }),
    call('f', 'wallFor', { symbol: 'SPX', expiry: '20261012', width: 6.9, span: 200 }),
    call('g', 'wallFor', { symbol: 'SPX', expiry: '20261012', width: 6.9, span: 100 }),
    call('h', 'wallFor', { symbol: 'SPX', expiry: '20261012', width: 6.9, span: 300 }),
    call('i', 'wallFor', { symbol: 'SPX', expiry: '20261012', width: 6, span: 0 }),
    call('j', 'wallFor', { symbol: 'SPX', expiry: null, preferClass: 'SPX' }),
  ],
});
add('wallFor:没连 / 没会话 / 链取不到 / 链数据不足 / 别的错', {
  router: { results: { optionChain: [R(null, { error: '没有可用的到期日' }), R(null, { error: 'boom', kind: 'plain' }), R(chain(rr, 7750, { rows: [] })), R(CH)] } },
  steps: [
    call('n0', 'wallFor', { symbol: 'SPX', expiry: null }),
    { op: 'port', v: 'make' }, { op: 'portSet', set: { sessions: 0 } }, call('n1', 'wallFor', { symbol: 'SPX', expiry: null }),
    { op: 'portSet', set: { sessions: 1 } },
    call('e1', 'wallFor', { symbol: 'SPX', expiry: null }), call('e2', 'wallFor', { symbol: 'SPX', expiry: null }), call('e3', 'wallFor', { symbol: 'SPX', expiry: null }),
    call('ok', 'wallFor', { symbol: 'SPX', expiry: null }),
  ],
});
add('wallFor:链没带 multiplier / trading_class / expiries / spot_source;strike_count 缺', {
  router: { results: { optionChain: [R({ symbol: 'SPX', expiry: '20261012', spot: 7750, rows: CH.rows })] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'wallFor', { symbol: 'SPX', expiry: null, width: 5 })],
});
add('wallFor:提示是抽着取的(strike_count < grid_count)', {
  router: { results: { optionChain: [R(chain(rr, 7750, { strike_count: 9, grid_count: 61 })), R(chain(rr, 7750, { strike_count: '9', grid_count: '61' })), R(chain(rr, 7750, { strike_count: 0, grid_count: 3 }))] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'wallFor', { symbol: 'SPX', expiry: '1' }), call('b', 'wallFor', { symbol: 'SPX', expiry: '2' }), call('c', 'wallFor', { symbol: 'SPX', expiry: '3' })],
});

add('wallFor:strike_count 恰好 1 算数;缓存里的 span 与这次一样大也算命中;缓存里没有 span 而这次要 0.5 不命中', {
  router: { results: { optionChain: [R(chain(rr, 7750, { strike_count: 1, grid_count: 3 })), R(chain(rr, 7751)), R(chain(rr, 7752)), R(chain(rr, 7753))] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'wallFor', { symbol: 'SPX', expiry: null, width: 5 }),
    call('b', 'wallFor', { symbol: 'SPX', expiry: '1', width: 5, span: 200 }), call('c', 'wallFor', { symbol: 'SPX', expiry: '1', width: 5, span: 200 }),
    call('d', 'wallFor', { symbol: 'SPX', expiry: '2', width: 5 }), call('e', 'wallFor', { symbol: 'SPX', expiry: '2', width: 5, span: 0.5 })],
});
const hist = (n, from = '2025-08-01') => Array.from({ length: n }, (_, i) => dbar(new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), 100 + i));
add('dailyHistory:取一次、十分钟内走缓存、更长的跨度重取、短的从长的里切;日期区间由虚拟日期定', {
  router: { results: { historicalBars: [R(hist(5)), R(hist(8, '2025-07-01')), R([{ time: '2025-12-01 09:30', close: 1 }, { date: '2024-01-01', close: 2 }, { close: 3 }, { date: null, time: '2026-01-01', close: 4 }])] } },
  steps: [{ op: 'port', v: 'make' },
    call('a', 'dailyHistory', { symbol: 'AAPL' }), { op: 'get', what: 'askedAt', a: { symbol: 'AAPL' } },
    call('b', 'dailyHistory', { symbol: 'AAPL' }), call('c', 'dailyHistory', { symbol: 'AAPL', spanDays: 500 }), call('d', 'dailyHistory', { symbol: 'AAPL', spanDays: 500.9 }),
    call('e', 'dailyHistory', { symbol: 'AAPL', spanDays: 420 }), call('f', 'dailyHistory', { symbol: 'AAPL', spanDays: 450 }),
    { op: 'advance', ms: 600000 }, call('g', 'dailyHistory', { symbol: 'AAPL' }), { op: 'get', what: 'askedAt', a: { symbol: 'AAPL' } },
    { op: 'get', what: 'askedAt', a: { symbol: 'NOPE' } },
    call('h', 'dailyHistory', { symbol: 'AAPL', spanDays: -5 }), call('i', 'dailyHistory', { symbol: 'AAPL', spanDays: '__NaN__' }),
  ],
});
add('dailyHistory:没连 / 取不到(券商的错变 RpcError)/ 别的错照抛', {
  router: { results: { historicalBars: [R(null, { error: '历史数据没权限' }), R(null, { error: 'x', kind: 'plain' }), R(hist(2))] } },
  steps: [call('n', 'dailyHistory', { symbol: 'AAPL' }), { op: 'port', v: 'make' }, call('a', 'dailyHistory', { symbol: 'AAPL' }), call('b', 'dailyHistory', { symbol: 'AAPL' }), call('c', 'dailyHistory', { symbol: 'AAPL' }),
    { op: 'portSet', set: { sessions: 0 } }, call('d', 'dailyHistory', { symbol: 'MSFT' })],
});
add('quoteOf / spotOf:指数走 indexPrice 与 spotInfo,个股走 streamQuotes;取不到 null;抛错 null', {
  router: {
    results: {
      indexPrice: [R(7750.5), R(null), R(0), R(7751, { error: 'boom' }), R('__NaN__'), R(7752)],
      streamQuotes: [R({ AAPL: { last: 200.5, last_trade_at: 1791800000 } }), R({ AAPL: { last: 0 } }), R({}), R(null), R({ AAPL: { last: 'x' } }), R(null, { error: 'bad' }), R({ AAPL: { last: 5, last_trade_at: -1 } })],
    },
    spotInfo: { SPX: { source: 'futures', note: 'ES 202612' }, VIX: { source: 7 } },
  },
  steps: [call('n', 'quoteOf', { symbol: 'SPX' }), { op: 'port', v: 'make' },
    call('i1', 'quoteOf', { symbol: 'SPX' }), call('i2', 'quoteOf', { symbol: 'SPX' }), call('i3', 'quoteOf', { symbol: 'SPX' }), call('i4', 'quoteOf', { symbol: 'SPX' }), call('i5', 'quoteOf', { symbol: 'VIX' }), call('i6', 'spotOf', { symbol: 'SPX' }),
    call('s1', 'quoteOf', { symbol: 'AAPL' }), call('s2', 'quoteOf', { symbol: 'AAPL' }), call('s3', 'quoteOf', { symbol: 'AAPL' }), call('s4', 'spotOf', { symbol: 'AAPL' }), call('s5', 'quoteOf', { symbol: 'AAPL' }), call('s6', 'quoteOf', { symbol: 'AAPL' }), call('s7', 'spotOf', { symbol: 'AAPL' }),
    { op: 'portSet', set: { sessions: 0 } }, call('z', 'spotOf', { symbol: 'AAPL' })],
});
add('quotesOf:非指数合成一次 streamQuotes,指数逐只先问;批量抛错退回逐只;去重;没连全是 null', {
  router: {
    results: {
      indexPrice: [R(7750), R(null)],
      'streamQuotes:AAPL,MSFT': [R({ AAPL: { last: 200, last_trade_at: 5 }, MSFT: { last: 400 } }), R(null, { error: 'batch' }), R(null)],
      'streamQuotes:AAPL': [R({ AAPL: { last: 201 } })], 'streamQuotes:MSFT': [R(null, { error: 'one' })],
    },
    spotInfo: { SPX: { source: 'index' } },
  },
  steps: [call('n', 'quotesOf', { symbols: ['AAPL'] }), { op: 'port', v: 'make' },
    call('a', 'quotesOf', { symbols: ['AAPL', 'SPX', 'MSFT', 'AAPL'] }), call('b', 'quotesOf', { symbols: ['AAPL', 'MSFT', 'SPX'] }), call('c', 'quotesOf', { symbols: ['AAPL', 'MSFT'] }),
    call('d', 'quotesOf', { symbols: [] }), call('e', 'quotesOf', { symbols: ['SPX'] }),
    { op: 'portSet', set: { sessions: 0 } }, call('z', 'quotesOf', { symbols: ['SPX', 'AAPL', 'SPX'] })],
});
const bars = (n, feed) => ({ bars: Array.from({ length: n }, (_, i) => bar(`2026-10-12 09:${String(30 + i).padStart(2, '0')}`, 7700 + i)), ...(feed ? { feed } : {}) });
add('paBars:TTL 由周期定(秒数 / 10,夹在 15 到 60 秒),force 一律 15 秒;key 含 rth 与 indexProxy;feed 标记带出', {
  router: { results: { intradayBars: [R(bars(3, 'live')), R(bars(2, 'delayed')), R(bars(4, 'unknown')), R(bars(1)), R(bars(2, 'live')), R(bars(5)), R(null, { error: '未知 K 线周期:3m' })] } },
  steps: [{ op: 'port', v: 'make' },
    call('a', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true }), { op: 'advance', ms: 14999 }, call('b', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true }), { op: 'advance', ms: 2 },
    call('c', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true }),
    call('d', 'paBars', { symbol: 'SPX', timeframe: '5m', rth: false, indexProxy: true }), { op: 'advance', ms: 29999 }, call('e', 'paBars', { symbol: 'SPX', timeframe: '5m', rth: false, indexProxy: true }),
    { op: 'advance', ms: 2 }, call('f', 'paBars', { symbol: 'SPX', timeframe: '5m', rth: false, indexProxy: true, force: true }),
    call('g', 'paBars', { symbol: 'SPX', timeframe: '5m', rth: false, indexProxy: false }),
    call('h', 'paBars', { symbol: 'SPX', timeframe: '1d', rth: true }), { op: 'advance', ms: 59999 }, call('i', 'paBars', { symbol: 'SPX', timeframe: '1d', rth: true }), { op: 'advance', ms: 2 },
    call('j', 'paBars', { symbol: 'SPX', timeframe: '1d', rth: true }),
    call('k', 'paBars', { symbol: 'SPX', timeframe: 'weird', rth: true }), call('l', 'paBars', { symbol: 'SPX', timeframe: 'weird', rth: true, force: true }),
  ],
});
add('paBars:没有 router:TypeError 的原话', {
  steps: [call('a', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true }), call('b', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true, force: true }),
    { op: 'port', v: 'make' }, { op: 'portSet', set: { sessions: 0 } }, call('c', 'paBars', { symbol: 'SPX', timeframe: '1m', rth: true })],
});

// ---- 种子固定的随机交错
{
  const r = rng(0xda7a_f10e);
  const syms = ['SPX', 'VIX', 'AAPL', 'MSFT', 'NVDA'];
  const tfs = ['1m', '5m', '15m', '1h', '1d', 'weird'];
  const resultFor = () => {
    const p = r.next();
    if (p < 0.12) return { error: r.pick(['券商不理', '没有可用的到期日']) };
    if (p < 0.16) return { error: 'plain boom', kind: 'plain' };
    return null;
  };
  const withErr = (v) => { const e = resultFor(); return e ? R(null, e) : R(v, r.chance(0.15) ? { delay: r.pick([5, 700, 4000]) } : {}); };
  for (let n = 0; n < 60; n += 1) {
    const results = {
      optionChain: Array.from({ length: 4 }, () => withErr(chain(r, 7700 + r.int(100), r.chance(0.3) ? { strike_count: 9, grid_count: 41 } : {}))),
      historicalBars: Array.from({ length: 3 }, () => withErr(hist(2 + r.int(6), r.pick(['2025-08-01', '2025-01-01', '2025-11-20'])))),
      indexPrice: Array.from({ length: 4 }, () => withErr(r.chance(0.2) ? null : 7700 + r.int(100))),
      streamQuotes: Array.from({ length: 4 }, () => withErr(Object.fromEntries(syms.filter(() => r.chance(0.7)).map((s) => [s, { last: r.chance(0.9) ? 100 + r.int(100) : 0, ...(r.chance(0.5) ? { last_trade_at: 1791800000 + r.int(1000) } : {}) }])))),
      intradayBars: Array.from({ length: 4 }, () => withErr(bars(1 + r.int(4), r.pick([undefined, 'live', 'delayed', 'unknown'])))),
    };
    const steps = [{ op: 'port', v: 'make' }];
    for (let i = 0; i < 24; i += 1) {
      const p = r.next();
      const sym = r.pick(syms);
      if (p < 0.12) steps.push(call(`w${i}`, 'wallFor', { symbol: sym, expiry: r.pick([null, '20261012']), width: r.pick([undefined, 5, 10, 6.5]), span: r.pick([null, 0, 100, 300]), preferClass: r.pick(['', 'SPXW']) }));
      else if (p < 0.24) steps.push(call(`h${i}`, 'dailyHistory', { symbol: sym, spanDays: r.pick([undefined, 420, 500, 600, 100]) }));
      else if (p < 0.32) steps.push(call(`q${i}`, 'quoteOf', { symbol: sym }));
      else if (p < 0.38) steps.push(call(`s${i}`, 'spotOf', { symbol: sym }));
      else if (p < 0.50) steps.push(call(`Q${i}`, 'quotesOf', { symbols: Array.from({ length: 1 + r.int(4) }, () => r.pick(syms)) }));
      else if (p < 0.64) steps.push(call(`p${i}`, 'paBars', { symbol: sym, timeframe: r.pick(tfs), rth: r.chance(0.5), force: r.pick([undefined, true, false]), indexProxy: r.pick([undefined, true, false]) }));
      else if (p < 0.88) steps.push({ op: 'advance', ms: r.pick([1, 1000, 14999, 15001, 30000, 59999, 60001, 600001]) });
      else if (p < 0.93) steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1, 1]) } });
      else if (p < 0.97) steps.push({ op: 'get', what: 'askedAt', a: { symbol: sym } });
      else steps.push({ op: 'port', v: r.pick(['make', 'null']) });
    }
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, dump: ['audit_log'], router: { results, spotInfo: { SPX: { source: r.pick(['index', 'futures', 'index_stale']) }, VIX: null } }, steps } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_marketdata.json'), text);
console.log(`svc_marketdata.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
