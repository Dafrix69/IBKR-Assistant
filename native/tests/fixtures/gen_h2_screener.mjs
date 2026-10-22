// 生成 h2_screener.json:engine-ts 的 screener.ts(screener.rs / inflection / deviation / leaders,原类现跑)对着 h2_world.mjs 的假 RpcContext;库是真的(临时库)。
// 日线是固定种子的随机游走。C++ 一半:tests/tst_h2_screener.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_screener.mjs <编过的 engine-ts 目录>
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
const DUMP = ['audit_log', 'app_prefs', 'sectors', 'signal_log'];
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: DUMP, h2router: { sessions: 1 }, ...script } });
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';
const stock = (symbol, company = '', tag = '') => ({ symbol, company, reason: '手动添加', tag });
const ROUTER = { op: 'h2router', v: 'make' };

// ---- 数据
function weekdays(end, n) {
  const out = [];
  let d = new Date(`${end}T00:00:00Z`);
  while (out.length < n) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400000); }
  return out.reverse();
}
function walk(seed, n, { end = '2026-10-09', start = 100, drift = 0.0005, vol = 0.015, volume = 1e6, jump = 0 } = {}) {
  const r = rng(seed);
  let c = start;
  return weekdays(end, n).map((date, i) => {
    const o = c * (1 + (r.next() - 0.5) * vol * 0.5);
    let ret = drift + (r.next() + r.next() + r.next() - 1.5) * vol * 1.2;
    if (jump && i === n - 1) ret += jump;
    c = Math.max(1, c * (1 + ret));
    const hi = Math.max(o, c) * (1 + r.next() * vol * 0.5), lo = Math.min(o, c) * (1 - r.next() * vol * 0.5);
    return { date, open: +o.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), close: +c.toFixed(2), volume: Math.round(volume * (0.5 + r.next())) };
  });
}
/** 先横盘 / 阴跌、后拉升的一条:趋势模板更容易过 */
function riser(seed, n, { end = '2026-10-09', flat = 0.55, up = 0.004 } = {}) {
  const r = rng(seed);
  let c = 50;
  return weekdays(end, n).map((date, i) => {
    const drift = i < n * flat ? -0.0002 : up;
    const o = c * (1 + (r.next() - 0.5) * 0.006);
    c = Math.max(1, c * (1 + drift + (r.next() - 0.5) * 0.02));
    const hi = Math.max(o, c) * (1 + r.next() * 0.008), lo = Math.min(o, c) * (1 - r.next() * 0.008);
    return { date, open: +o.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), close: +c.toFixed(2), volume: Math.round(1e6 * (0.5 + r.next() * (i > n - 6 ? 3 : 1))) };
  });
}
/** 前半段阴跌、后半段上行、最后一根跳一下:趋势模板刚好在最后一根转成第二阶段(探针里试出来的种子) */
function ramp(seed, n, { drift, jump, end = '2026-10-09', vol = 0.012 }) {
  const r = rng(seed);
  let c = 50;
  return weekdays(end, n).map((date, i) => {
    const o = c;
    let ret = (i < n * 0.5 ? -0.0004 : drift) + (r.next() - 0.5) * vol * 2;
    if (i === n - 1) ret += jump;
    c = Math.max(1, c * (1 + ret));
    return { date, open: +o.toFixed(2), high: +(Math.max(o, c) * 1.003).toFixed(2), low: +(Math.min(o, c) * 0.997).toFixed(2), close: +c.toFixed(2), volume: Math.round(1e6 * (0.5 + r.next())) };
  });
}
function intraday(seed, nDays, { end = '2026-10-09' } = {}) {
  const r = rng(seed);
  let c = 100;
  const bars = [];
  for (const day of weekdays(end, nDays)) {
    for (let m = 9 * 60 + 30; m < 16 * 60; m += 15) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
      const o = c;
      c = Math.max(1, c * (1 + (r.next() - 0.5) * 0.004));
      bars.push({ time: `${day} ${hh}:${mm}`, open: +o.toFixed(2), high: +(Math.max(o, c) * 1.001).toFixed(2), low: +(Math.min(o, c) * 0.999).toFixed(2), close: +c.toFixed(2), volume: Math.round(2e5 * (0.5 + r.next())) });
    }
  }
  return bars;
}
const pa = (bars, extra = {}) => ({ value: { bars, cached: false, askedAt: 1760000000000, feed: null, ...extra } });
const V = (bars) => ({ value: bars });
const ERR = (error, extra = {}) => ({ error, ...extra });

const BENCH = ramp(1, 262, { drift: 0.0003, jump: 0 });
const FRESH = [[1, 0.002, 0.06], [4, 0.002, 0.06], [5, 0.002, 0.06], [14, 0.0025, 0.03], [17, 0.003, 0.05], [18, 0.0025, 0.03]].map(([sd, drift, jump]) => ramp(sd, 262, { drift, jump }));
const SERIES = Array.from({ length: 24 }, (_, i) => (i % 5 === 0 ? riser(100 + i, 262) : i % 5 === 2 ? FRESH[i % 6] : walk(10 + i, 256 + (i % 4) * 6, { drift: -0.0003 + (i % 7) * 0.0002, start: 30 + i * 7, vol: 0.01 + (i % 3) * 0.006 })));
const SHORT = SERIES.map((x) => x.slice(-130));
const BS = BENCH.slice(-130);
const SYMS = ['NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'MU', 'QCOM', 'INTC', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'ARM', 'ON', 'TXN', 'ADI', 'MSFT', 'ORCL', 'CRM', 'NOW', 'ADBE', 'SNOW', 'PLTR', 'DDOG'];
const seedSectors = (nA = 5, nB = 5) => [
  st('addSector', ['半导体']), st('setSectorStocks', [S1, SYMS.slice(0, nA).map((s, i) => stock(s, `${s} Inc`, i % 2 ? '芯片' : ''))]),
  st('addSector', ['软件']), st('setSectorStocks', [S2, [stock('nvda', '重复', 'X'), ...SYMS.slice(16, 16 + nB).map((s) => stock(s, '', '软件'))]]),
];
const histOf = (list) => list.map((s) => (s && s.error ? s : V(s)));
const bulk = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// ================= screener.rs
add('rs:没连券商 / 基准不认识 / 板块不存在 / 股票池空:检查先后', {
  steps: [call('a', 'screener.rs', {}), st('addSector', ['空']), call('b', 'screener.rs', {}), call('c', 'screener.rs', { sector: S1 }), call('d', 'screener.rs', { benchmark: 'IWM' }), call('e', 'screener.rs', { benchmark: 'IWM', sector: 'nope' }),
    call('f', 'screener.rs', { sector: 'nope', benchmark: 'IWM' }), call('g', 'screener.rs', { sector: 'nope' }), call('h', 'screener.rs', { benchmark: '' }), call('i', 'screener.rs', { sector: 5 }),
    st('setSectorStocks', [S1, [stock('NVDA')]]), call('j', 'screener.rs', { sector: S1 }), ROUTER, call('k', 'screener.rs', { sector: S1, benchmark: 'IWM' }), { op: 'h2routerSet', set: { sessions: 0 } }, call('l', 'screener.rs', { sector: S1 })],
});
add('rs:成功(全部板块并集去重、标签 / 公司名、基准大小写与空白)', {
  ports: { 'market.dailyHistory': [V(BS), ...SHORT.slice(0, 8).map(V), V(BS), ...SHORT.slice(0, 8).map(V), V(BS), ...SHORT.slice(0, 8).map(V)] },
  steps: [...seedSectors(4, 3), ROUTER, call('a', 'screener.rs', {}), call('b', 'screener.rs', { sector: 'all', benchmark: ' qqq ' }), call('c', 'screener.rs', { sector: ` ${S2} ` })],
});
add('rs:单个板块的标签是板块名,多个是「全部板块」;板块只剩一个时 all 也是板块名', {
  ports: { 'market.dailyHistory': [V(BS), ...SHORT.slice(0, 3).map(V), V(BS), ...SHORT.slice(0, 3).map(V)] },
  steps: [st('addSector', ['半导体']), st('setSectorStocks', [S1, SYMS.slice(0, 3).map((s) => stock(s, 'c', 't'))]), ROUTER, call('a', 'screener.rs', { sector: 'all' }), call('b', 'screener.rs', { sector: S1 })],
});
add('rs:基准抛错 → -32018 包装(RpcError 原话 / 普通错截 200);成员抛错记进 member.error', {
  ports: { 'market.dailyHistory': [ERR('网络断了'), ERR('x'.repeat(300)), ERR('带码', { kind: 'rpc', code: -32009 }), ERR('券商拒', { kind: 'broker' }), V(BS), V(SHORT[0]), ERR('成员坏了'), V(SHORT[2]), ERR('y'.repeat(250)), ERR('rpc 成员', { kind: 'rpc', code: -32012 }), V([])] },
  steps: [...seedSectors(3, 2), ROUTER, call('a', 'screener.rs', {}), call('b', 'screener.rs', {}), call('c', 'screener.rs', {}), call('d', 'screener.rs', {}), call('e', 'screener.rs', {})],
});
add('rs:K 线很短 / 空', {
  ports: { 'market.dailyHistory': [V(BENCH.slice(-30)), V(SERIES[1].slice(-10)), V([]), V(SERIES[2].slice(-70)), V(BENCH.slice(-120)), V(SERIES[3].slice(0, 5)), V(SHORT[4])] },
  steps: [...seedSectors(3, 1), ROUTER, call('a', 'screener.rs', {}), call('b', 'screener.rs', { benchmark: 'QQQ', sector: S1 })],
});

// ================= screener.leaders
add('leaders:没连券商 / 基准 / 板块 / 池空', {
  steps: [call('a', 'screener.leaders', {}), st('addSector', ['空']), call('b', 'screener.leaders', {}), call('c', 'screener.leaders', { benchmark: 'IWM' }), call('d', 'screener.leaders', { sector: 'nope' }), ROUTER, st('setSectorStocks', [S1, [stock('NVDA')]]), call('e', 'screener.leaders', { sector: 'nope' }), { op: 'h2routerSet', set: { sessions: 0 } }, call('f', 'screener.leaders', {})],
});
{
    const risers = [0, 1, 2, 3, 4].map((i) => riser(200 + i, 262, { up: 0.003 + i * 0.0004, flat: 0.5 + i * 0.03 }));
  add('leaders:成功(强势股、第二阶段新进的记进信号日志;同一根日线再扫不重复)', {
    ports: { 'market.dailyHistory': [V(BENCH), ...risers.map(V), V(BENCH), ...risers.map(V), V(BENCH), ...risers.map(V)] },
    steps: [st('addSector', ['强势']), st('setSectorStocks', [S1, SYMS.slice(0, 5).map((s, i) => stock(s, `${s} Inc`, i % 2 ? '芯片' : ''))]), ROUTER, call('a', 'screener.leaders', {}), call('b', 'screener.leaders', {})],
  });
  add('leaders:混合(随机游走 + 拉升 + 短线 + 抛错);基准抛错 / 成员抛错', {
    ports: { 'market.dailyHistory': [V(BENCH), ...SERIES.slice(0, 6).map((s, i) => (i === 3 ? ERR('成员坏') : i === 5 ? V(s.slice(-40)) : V(i % 2 ? risers[i % 5] : s))), ERR('基准坏了'), V(BS), ...risers.slice(0, 2).map(V)] },
    steps: [st('addSector', ['混合']), st('setSectorStocks', [S1, SYMS.slice(0, 6).map((s) => stock(s))]), ROUTER, call('a', 'screener.leaders', {}), call('b', 'screener.leaders', {}), call('c', 'screener.leaders', {})],
  });
  add('leaders:今天新进第二阶段的记进 signal_log(同一根日线只记一次);其中混着 RS 池内重排、短线和抛错', {
    ports: { 'market.dailyHistory': [V(BENCH), ...FRESH.map(V), V(risers[0]), V(SERIES[1].slice(-30)), ERR('坏了'), V(BENCH), ...FRESH.map(V), V(risers[0]), V(SERIES[1].slice(-30)), ERR('坏了'), V(BENCH), V(FRESH[0]), V(FRESH[1])] },
    steps: [st('addSector', ['新进']), st('setSectorStocks', [S1, SYMS.slice(0, 9).map((s, i) => stock(s, `${s} Inc`, i % 2 ? '芯片' : ''))]), st('addSector', ['少']), st('setSectorStocks', [S2, [stock('NVDA'), stock('AMD')]]), ROUTER,
      call('a', 'screener.leaders', { sector: S1 }), call('b', 'screener.leaders', { sector: S1 }), { op: 'advance', ms: 3600000 }, call('c', 'screener.leaders', { sector: S2 })],
  });
  // 最后一根日线是周五,周一(START)盘前再扫:同一根只记一次(跨天)
  add('leaders:周末 / 下周一盘前:最新一根还是周五,不重复记', {
    start: Date.parse('2026-10-10T12:00:00-04:00'),
    ports: { 'market.dailyHistory': [V(BENCH), ...risers.map(V), V(BENCH), ...risers.map(V)] },
    steps: [st('addSector', ['强势']), st('setSectorStocks', [S1, SYMS.slice(0, 5).map((s) => stock(s))]), ROUTER, call('a', 'screener.leaders', {}), { op: 'advance', ms: 3 * 86400000 }, call('b', 'screener.leaders', {})],
  });
}

// ================= screener.inflection
add('inflection:入参检查先后(timeframes → ma_period → 板块 → 没连券商)', {
  steps: [call('a', 'screener.inflection', { timeframes: ['3m'] }), call('b', 'screener.inflection', { timeframes: '1d' }), call('c', 'screener.inflection', { ma_period: 1 }), call('d', 'screener.inflection', { ma_period: 'abc' }),
    call('e', 'screener.inflection', { timeframes: [] }), call('f', 'screener.inflection', { timeframes: {} }), call('g', 'screener.inflection', { timeframes: [3] }), call('h', 'screener.inflection', { timeframes: ['1D'] }), call('i', 'screener.inflection', { timeframes: 0 }),
    call('j', 'screener.inflection', { timeframes: '' }), call('k', 'screener.inflection', { timeframes: null }), call('l', 'screener.inflection', { ma_period: 251 }), call('m', 'screener.inflection', { ma_period: 2.9 }), call('n', 'screener.inflection', { ma_period: ' 30 ' }),
    call('o', 'screener.inflection', { ma_period: 0 }), call('p', 'screener.inflection', { ma_period: '' }), call('q', 'screener.inflection', { ma_period: null }), call('r', 'screener.inflection', { ma_period: '1.5' }), call('s', 'screener.inflection', { ma_period: -5 }),
    call('t', 'screener.inflection', { timeframes: ['1d', '3m'], ma_period: 1 }), call('u', 'screener.inflection', { sector: 'nope' }), call('v', 'screener.inflection', {}), st('addSector', ['空']), call('w', 'screener.inflection', {}),
    st('setSectorStocks', [S1, [stock('NVDA')]]), call('x', 'screener.inflection', {}), call('y', 'screener.inflection', { ma_period: 250 }), call('z', 'screener.inflection', { ma_period: 2 })],
});
add('inflection:默认 [1d, 1w]、去重、均线确认;成功', {
  ports: { 'market.dailyHistory': bulk(22, (i) => V(SHORT[i % SHORT.length])) },
  steps: [...seedSectors(5, 4), ROUTER, call('a', 'screener.inflection', {}), call('b', 'screener.inflection', { sector: 'all', timeframes: ['1d', '1w', '1d'], ma_period: 20 }), call('c', 'screener.inflection', { sector: S1, timeframes: ['1w'], ma_period: '50' })],
});
add('inflection:日内周期:paBars 调用 (symbol, tf, false, false, false);抛错记进 errors', {
  ports: { 'market.dailyHistory': bulk(14, (i) => (i === 4 ? ERR('日线坏') : V(SHORT[i % SHORT.length]))), 'market.paBars': bulk(14, (i) => (i % 4 === 1 ? ERR('超频', { kind: 'rpc', code: -32010 }) : pa(intraday(300 + i, 3)))) },
  steps: [...seedSectors(3, 2), ROUTER, call('a', 'screener.inflection', { timeframes: ['1h', '30m', '15m'] }), call('b', 'screener.inflection', { timeframes: ['1d', '15m', '1w', '1h'], ma_period: 10 })],
});
add('inflection:日内预算 40:成员多于预算,超出的格子记「已达上限」', {
  ports: { 'market.dailyHistory': bulk(16, (i) => V(SHORT[i % SHORT.length])), 'market.paBars': bulk(16, (i) => pa(intraday(400 + i, 2))) },
  steps: [st('addSector', ['大']), st('setSectorStocks', [S1, SYMS.slice(0, 14).map((s) => stock(s))]), ROUTER, call('a', 'screener.inflection', { timeframes: ['1d', '1h', '30m', '15m'] }), call('b', 'screener.inflection', { timeframes: ['15m'] }), call('c', 'screener.inflection', { timeframes: ['1w', '15m', '1h'], ma_period: 5 })],
});

// ================= screener.deviation
add('deviation:golden 的坏参数与各范围边界(检查先后)', {
  steps: [call('a', 'screener.deviation', { symbol: 'bad$' }), call('b', 'screener.deviation', { symbol: 'NVDA', timeframe: '5m' }), call('c', 'screener.deviation', { symbol: 'NVDA', period: 1 }), call('d', 'screener.deviation', { symbol: 'NVDA', z_extreme: 9 }),
    call('e', 'screener.deviation', { symbol: 'NVDA' }), call('f', 'screener.deviation', { symbol: 'NVDA', timeframe: '' }), call('g', 'screener.deviation', { symbol: 'NVDA', period: 251 }), call('h', 'screener.deviation', { symbol: 'NVDA', lookback: 9 }),
    call('i', 'screener.deviation', { symbol: 'NVDA', lookback: 501 }), call('j', 'screener.deviation', { symbol: 'NVDA', smooth: 51 }), call('k', 'screener.deviation', { symbol: 'NVDA', smooth: -1 }), call('l', 'screener.deviation', { symbol: 'NVDA', z_extreme: 0.4 }),
    call('m', 'screener.deviation', { symbol: 'NVDA', z_extreme: 5.1 }), call('n', 'screener.deviation', { symbol: 'NVDA', z_extreme: 'abc' }), call('o', 'screener.deviation', { symbol: 'NVDA', period: 'x' }), call('p', 'screener.deviation', { symbol: 'NVDA', z_extreme: -1 }),
    call('q', 'screener.deviation', { symbol: 'NVDA', period: 2, lookback: 10, smooth: 1, z_extreme: 0.5 }), call('r', 'screener.deviation', { symbol: 'NVDA', period: 250, lookback: 500, smooth: 50, z_extreme: 5 }), call('s', 'screener.deviation', { symbol: '  nvda ' }),
    call('t', 'screener.deviation', { symbol: 'NVDA', period: 0, lookback: 0, smooth: 0, z_extreme: 0 }), call('u', 'screener.deviation', { symbol: 'NVDA', z_extreme: '' }), call('v', 'screener.deviation', { symbol: 'NVDA', period: 1, timeframe: '5m' }),
    call('w', 'screener.deviation', { symbol: 'NVDA', z_extreme: 'Infinity' }), call('x', 'screener.deviation', { symbol: 'NVDA', period: 'Infinity' }), call('y', 'screener.deviation', {}), call('z', 'screener.deviation', { symbol: 'NVDA', period: ' 20 ' })],
});
add('deviation:各周期成功;K 线抛错 → -32018;日内用 paBars', {
  ports: { 'market.dailyHistory': [V(SHORT[0]), V(SHORT[1]), V(SHORT[2]), ERR('日线坏了'), ERR('r', { kind: 'rpc', code: -32009 }), ERR('z'.repeat(260)), V(SHORT[6].slice(-15)), V([])],
    'market.paBars': [pa(intraday(500, 8)), pa(intraday(501, 3)), ERR('超频'), pa([])] },
  steps: [ROUTER, call('a', 'screener.deviation', { symbol: 'NVDA' }), call('b', 'screener.deviation', { symbol: 'NVDA', timeframe: '1w', period: 10, lookback: 30, smooth: 3, z_extreme: 1.5 }), call('c', 'screener.deviation', { symbol: 'AMD', period: '30', lookback: '60' }),
    call('d', 'screener.deviation', { symbol: 'AMD' }), call('e', 'screener.deviation', { symbol: 'AMD' }), call('f', 'screener.deviation', { symbol: 'AMD', timeframe: '1w' }), call('g', 'screener.deviation', { symbol: 'AMD' }), call('h', 'screener.deviation', { symbol: 'AMD' }),
    call('i', 'screener.deviation', { symbol: 'TSM', timeframe: '1h' }), call('j', 'screener.deviation', { symbol: 'TSM', timeframe: '30m', period: 5 }), call('k', 'screener.deviation', { symbol: 'TSM', timeframe: '15m' }), call('l', 'screener.deviation', { symbol: 'TSM', timeframe: '15m' })],
});
add('deviation:没连券商(router 空 / 无会话)', {
  steps: [call('a', 'screener.deviation', { symbol: 'NVDA' }), ROUTER, { op: 'h2routerSet', set: { sessions: 0 } }, call('b', 'screener.deviation', { symbol: 'NVDA' })],
});

// ================= 随机参数
const fz = rng(20261021);
const pickOf = (a) => a[fz.int(a.length)];
const rndNum = () => pickOf([null, 0, 1, 2, 5, 10, 20, 30, 50, 120, 250, 251, 500, 501, '20', ' 15 ', '', 'abc', 2.7, -3, '1.5', 0.5, 3, 9]);
const rndTfs = () => pickOf([undefined, ['1d'], ['1w'], ['1d', '1w'], ['1h'], ['15m', '30m'], ['1w', '1d', '1h', '30m', '15m'], [], '1d', ['5m'], ['1d', '1d'], 0, [3]]);
const rndSector = () => pickOf([undefined, 'all', S1, S2, S3, ' ', 'nope', ` ${S1} `]);
for (let k = 0; k < 32; k += 1) {
  const steps = [];
  if (fz.chance(0.9)) steps.push(...seedSectors(2 + fz.int(3), 1 + fz.int(3)));
  if (fz.chance(0.3)) steps.push(st('addSector', ['第三']), st('setSectorStocks', [S3, SYMS.slice(8, 8 + 1 + fz.int(4)).map((s) => stock(s, 'c', 'g'))]));
  if (fz.chance(0.9)) steps.push(ROUTER);
  const nCalls = 2 + fz.int(3);
  for (let c = 0; c < nCalls; c += 1) {
    const m = pickOf(['screener.rs', 'screener.inflection', 'screener.deviation', 'screener.leaders']);
    const a = {};
    if (m === 'screener.deviation') {
      a.symbol = pickOf(['NVDA', 'amd', 'bad$', ' TSM ']);
      if (fz.chance(0.5)) a.timeframe = pickOf(['1d', '1w', '1h', '30m', '15m', '5m', '']);
      for (const key of ['period', 'lookback', 'smooth', 'z_extreme']) if (fz.chance(0.4)) a[key] = rndNum();
    } else {
      const sec = rndSector(); if (sec !== undefined) a.sector = sec;
      if (m === 'screener.inflection') {
        const t = rndTfs(); if (t !== undefined) a.timeframes = t;
        if (fz.chance(0.4)) a.ma_period = rndNum();
      } else if (fz.chance(0.4)) a.benchmark = pickOf(['SPY', 'qqq', ' QQQ ', 'IWM', '']);
    }
    steps.push(call(`c${c}`, m, a));
    if (fz.chance(0.12)) steps.push({ op: 'h2routerSet', set: { sessions: pickOf([0, 1]) } });
  }
  const n = 6;
  add(`随机 #${k}`, {
    ports: {
      'market.dailyHistory': bulk(n, (i) => (fz.chance(0.08) ? ERR(pickOf(['坏了', 'q'.repeat(230)]), fz.chance(0.3) ? { kind: 'rpc', code: -32009 } : {}) : V(fz.chance(0.12) ? SHORT[fz.int(24)].slice(-fz.int(60)) : i % 9 === 0 ? BS.slice(-90) : fz.chance(0.3) ? riser(900 + i, 90) : SHORT[fz.int(24)].slice(-90)))),
      'market.paBars': bulk(n, (i) => (fz.chance(0.1) ? ERR('超频') : pa(intraday(700 + i, 1 + fz.int(3))))),
    },
    steps,
  });
}

const out = [];
for (const s of scenarios) {
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
// -0:analysis/screener 的 C++ 版在 dev_pct / pressure 落在 -0.00 的几处给 +0(JSON.stringify 两边都写 0,界面看不出);共享文件不归本簇改,这里把期望里的 -0 写成 0
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out }).replaceAll('"__neg0__"', '0');
writeFileSync(join(here, 'h2_screener.json'), text);
console.log(`h2_screener.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
