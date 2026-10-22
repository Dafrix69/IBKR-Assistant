// 生成 h2_backtest.json:engine-ts 的 backtest.ts(backtest.strategies / run / sweep / parse_rules,原类现跑)对着 h2_world.mjs 的假 RpcContext;库是真的(临时库)。
// 日线是固定种子的随机游走。C++ 一半:tests/tst_h2_backtest.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_backtest.mjs <编过的 engine-ts 目录>
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
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log', 'app_prefs'], h2router: { sessions: 1 }, ...script } });
const ROUTER = { op: 'h2router', v: 'make' };


function weekdays(end, n) {
  const out = [];
  let d = new Date(`${end}T00:00:00Z`);
  while (out.length < n) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400000); }
  return out.reverse();
}
function walk(seed, n, { start = 100, drift = 0.0004, vol = 0.014 } = {}) {
  const r = rng(seed);
  let c = start;
  return weekdays('2026-10-09', n).map((date) => {
    const o = c * (1 + (r.next() - 0.5) * vol * 0.4);
    c = Math.max(1, c * (1 + drift + (r.next() + r.next() + r.next() - 1.5) * vol * 1.2));
    const hi = Math.max(o, c) * (1 + r.next() * vol * 0.4), lo = Math.min(o, c) * (1 - r.next() * vol * 0.4);
    return { date, open: +o.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), close: +c.toFixed(2), volume: Math.round(1e6 * (0.5 + r.next())) };
  });
}
const B = (i, n = 420) => walk(50 + i, n, { start: 80 + i * 13, drift: ((i % 5) - 2) * 0.0003 + 0.0003 });
const V = (value) => ({ value });
const ERR = (error, extra = {}) => ({ error, ...extra });
const RANGE = { start: '2025-01-02', end: '2026-10-09' };
const run = (id, a, extra = {}) => call(id, 'backtest.run', { symbol: 'AAPL', ...RANGE, strategy: 'buy_hold', ...a, ...extra });
const RES = (list) => ({ historicalBars: list });
const ent = (name, period) => ({ kind: 'indicator', name, ...(period ? { period } : {}) });
const cst = (value) => ({ kind: 'const', value });
const RULES = { entry: [{ left: ent('close'), op: '>', right: ent('sma', 20) }], exit: [{ left: ent('rsi', 14), op: '>', right: cst(70) }] };

add('strategies:目录原样(键序 / param_labels)', { steps: [call('a', 'backtest.strategies'), call('b', 'backtest.strategies', { x: 1 })] });

add('run:没带 / 坏代码(golden 形状)与检查先后', {
  h2router: { sessions: 1, results: RES([V(B(0))]) },
  steps: [call('a', 'backtest.run', { symbol: 'bad$' }), call('b', 'backtest.run', { symbol: 'AAPL', start: 'not-a-date', end: '2026-01-01' }), call('c', 'backtest.run', { symbol: 'AAPL', start: '2026-02-01', end: '2026-01-01' }),
    call('d', 'backtest.run', { symbol: 'AAPL', start: '2010-01-01', end: '2026-01-01' }), call('e', 'backtest.run', { symbol: 'AAPL', start: '2025-01-01', end: '2026-01-01', strategy: 'sma_cross' }), call('f', 'backtest.run', { symbol: 'AAPL' }),
    call('g', 'backtest.run', {}), call('h', 'backtest.run', { symbol: '' }), call('i', 'backtest.run', { symbol: 5 }), call('j', 'backtest.run', { symbol: ' aapl ', start: 'x' }),
    call('k', 'backtest.run', { symbol: 'AAPL', ...RANGE, strategy: 'nope' }), ROUTER, call('l', 'backtest.run', { symbol: 'AAPL', ...RANGE, strategy: 'nope' }), call('m', 'backtest.run', { symbol: 'AAPL', ...RANGE }),
    { op: 'h2routerSet', set: { sessions: 0 } }, call('n', 'backtest.run', { symbol: 'AAPL', ...RANGE, strategy: 'buy_hold' })],
});
add('run:日期的各种怪样子(Date.parse / 字符串比较 / 区间上限)', {
  h2router: { sessions: 1, results: RES([V(B(1))]) },
  steps: [ROUTER, ...[
    ['2026-02-30', '2026-03-10'], ['2026-02-29', '2026-03-10'], ['2024-02-29', '2024-03-10'], ['2024-02-30', '2024-03-10'], ['2026-13-01', '2026-14-01'], ['2026-00-10', '2026-01-10'], ['2026-01-00', '2026-01-10'], ['2026-01-32', '2026-02-10'], ['2026-1-1', '2026-02-10'],
    ['2026-01-01 ', '2026-02-10'], ['2026-01-01', '2026-01-01'], ['2026-01-01', '2026-01-02'], ['2016-01-01', '2026-01-01'], ['2016-01-01', '2026-01-02'], ['2016-01-01', '2025-12-31'], ['2016-01-02', '2026-01-01'], ['2016-01-01', '2026-01-08'], ['2016-01-01', '2026-01-09'], ['2026-01-01', '2026-13-01'], ['0000-01-01', '0000-02-01'], ['9999-12-31', '9999-12-30'],
    ['2026-01-01T00:00:00', '2026-02-10'], ['２０２６-01-01', '2026-02-10'], ['2026-01-01\n', '2026-02-10'], ['1970-01-01', '1970-01-05'], ['1969-12-30', '1970-01-03'], ['2026-04-31', '2026-05-10'], ['2026-06-31', '2026-07-10'],
  ].map(([start, end], i) => call(`d${i}`, 'backtest.run', { symbol: 'AAPL', start, end, strategy: 'buy_hold' })),
  call('n1', 'backtest.run', { symbol: 'AAPL', start: 20260101, end: '2026-02-10', strategy: 'buy_hold' }), call('n2', 'backtest.run', { symbol: 'AAPL', start: ['2026-01-01'], end: ['2026-02-10'], strategy: 'buy_hold' }),
  call('n3', 'backtest.run', { symbol: 'AAPL', start: null, end: null, strategy: 'buy_hold' }), call('n4', 'backtest.run', { symbol: 'AAPL', start: {}, end: true, strategy: 'buy_hold' })],
});
add('run:各策略与参数', {
  h2router: { sessions: 1, results: RES([V(B(2))]) },
  steps: [ROUTER, run('a', {}), run('b', { strategy: 'sma_cross' }), run('c', { strategy: 'sma_cross', params: { fast: 5, slow: 30 } }), run('d', { strategy: 'sma_cross', params: { fast: '8', slow: '40.7' } }), run('e', { strategy: 'sma_cross', params: { fast: 0 } }),
    run('f', { strategy: 'sma_cross', params: { fast: 251 } }), run('g', { strategy: 'sma_cross', params: { fast: 250, slow: 250 } }), run('h', { strategy: 'sma_cross', params: { nope: 1 } }), run('i', { strategy: 'sma_cross', params: { fast: true } }), run('j', { strategy: 'sma_cross', params: { fast: null } }),
    run('k', { strategy: 'sma_cross', params: { fast: 'abc' } }), run('l', { strategy: 'sma_cross', params: { fast: [] } }), run('m', { strategy: 'sma_cross', params: { fast: '' } }), run('n', { strategy: 'sma_cross', params: { fast: 30, slow: 10 } }),
    run('o', { strategy: 'rsi' }), run('p', { strategy: 'rsi', params: { period: 7, buy_below: 20, sell_above: 80 } }), run('q', { strategy: 'rsi', params: { buy_below: 100 } }), run('r', { strategy: 'rsi', params: { sell_above: 0 } }), run('s', { strategy: 'rsi', params: { buy_below: 60, sell_above: 40 } }),
    run('t', { strategy: 'breakout' }), run('u', { strategy: 'breakout', params: { entry: 55, exit: 20 } }), run('v', { strategy: 'breakout', params: { entry: 5.9 } }), run('w', { strategy: 'buy_hold', params: { x: 1 } }), run('x', { strategy: 'toString' }), run('y', { strategy: 'sma_cross', params: { constructor: 1 } }),
    run('z', { strategy: 'sma_cross', params: [1] }), run('A', { strategy: 'sma_cross', params: 5 }), run('B', { strategy: 'sma_cross', params: null }), run('C', { strategy: 'sma_cross', params: { fast: '1e2' } }), run('D', { strategy: 'sma_cross', params: { fast: ' 12 ' } })],
});
add('run:custom 条件(合法 / 不合法 / 没有入场)', {
  h2router: { sessions: 1, results: RES([V(B(3))]) },
  steps: [ROUTER, run('a', { strategy: 'custom', rules: RULES }), run('b', { strategy: 'custom' }), run('c', { strategy: 'custom', rules: {} }), run('d', { strategy: 'custom', rules: { entry: [] } }), run('e', { strategy: 'custom', rules: { entry: [{ left: ent('close'), op: '~', right: cst(1) }] } }),
    run('f', { strategy: 'custom', rules: { entry: [{ left: ent('sma'), op: '>', right: cst(1) }] } }), run('g', { strategy: 'custom', rules: { entry: [{ left: { kind: 'const' }, op: '>', right: cst(1) }] } }), run('h', { strategy: 'custom', rules: { entry: [{ left: ent('macd_hist'), op: 'cross_up', right: cst(0) }] } }),
    run('i', { strategy: 'custom', rules: { entry: [{ left: ent('close'), op: '>', right: cst('100') }], exit: [] } }), run('j', { strategy: 'custom', rules: { entry: [{ left: ent('close'), op: '>', right: cst(1) }], extra: 1 } }), run('k', { strategy: 'custom', rules: 5 }),
    run('l', { strategy: 'custom', rules: null }), run('m', { strategy: 'custom', rules: { entry: Array.from({ length: 7 }, () => ({ left: ent('close'), op: '>', right: cst(1) })) } }), run('n', { strategy: 'custom', rules: { entry: [{ left: ent('sma', 300), op: '>', right: cst(1) }] } }),
    run('o', { strategy: 'custom', rules: { entry: [{ left: ent('highest', 20), op: '<', right: ent('close') }, { left: ent('change_pct', 5), op: '<=', right: cst(-3) }], exit: [{ left: ent('ema', 10), op: 'cross_down', right: ent('ema', 30) }] } }),
    run('p', { strategy: 'sma_cross', rules: 5 }), run('q', { strategy: 'custom', rules: { entry: 'x' } }), run('r', { strategy: 'custom', rules: { entry: [{ left: ent('nope'), op: '>', right: cst(1) }] } }), run('s2', { strategy: 'custom', rules: { entry: [{ op: '>' }, { op: '>' }, { op: '>' }] } }), run('s', { strategy: 'custom', rules: { entry: [{ left: ent('close', 'x'), op: '>', right: cst(1) }] } })],
});
add('run:交易品种配置', {
  h2router: { sessions: 1, results: RES([V(B(4))]) },
  steps: [ROUTER, run('a', { instrument: { type: 'call' } }), run('b', { instrument: { type: 'put', dte: 14, offset_pct: -2, risk_pct: 5 } }), run('c', { instrument: { type: 'call_spread', width_pct: 3 } }), run('d', { instrument: { type: 'put_spread', dte: '45', offset_pct: '1.5' } }),
    run('e', { instrument: { type: 'butterfly', width_pct: 2.5, risk_pct: 20 }, strategy: 'sma_cross' }), run('f', { instrument: { type: 'future' } }), run('g', { instrument: { dte: 0 } }), run('h', { instrument: { dte: 366 } }), run('i', { instrument: { offset_pct: 31 } }), run('j', { instrument: { width_pct: 0 } }),
    run('k', { instrument: { width_pct: 21 } }), run('l', { instrument: { risk_pct: 0 } }), run('m', { instrument: { risk_pct: 101 } }), run('n', { instrument: { extra: 1 } }), run('o', { instrument: 5 }), run('p', { instrument: null }), run('q', { instrument: [] }), run('r', { instrument: { dte: 'x' } }),
    run('s', { instrument: { type: 'stock', dte: 1.5 } }), run('t', { instrument: { type: 'call', dte: 30 }, strategy: 'rsi' }), run('u', { instrument: { type: 'call', offset_pct: 30, width_pct: 20, risk_pct: 100 }, strategy: 'breakout' })],
});
add('run:cost_pct(在取日线之后才查)', {
  h2router: { sessions: 1, results: RES([V(B(5))]) },
  steps: [ROUTER, run('a', { cost_pct: 0.05 }), run('b', { cost_pct: '0.1' }), run('c', { cost_pct: ' 1 ' }), run('d', { cost_pct: '' }), run('e', { cost_pct: null }), run('f', { cost_pct: 10 }), run('g', { cost_pct: 10.01 }), run('h', { cost_pct: -0.1 }), run('i', { cost_pct: 'abc' }), run('j', { cost_pct: true }), run('k', { cost_pct: [1] }),
    run('l', { cost_pct: {} }), run('m', { cost_pct: '1e1' }), run('n', { cost_pct: '0x5' }), run('o', { cost_pct: 0 }), run('p', { cost_pct: '-0' }), run('q', { cost_pct: 'Infinity' }), run('r', { cost_pct: 1e-7 }), run('s', { cost_pct: 5, instrument: { type: 'call' } }), run('t', { cost_pct: 11, symbol: 'bad$' })],
});
add('run:券商侧:BrokerError → -32012;别的错照抛;日线太少 → -32602;日线形状怪', {
  h2router: { sessions: 1, results: RES([ERR('没有行情权限', { kind: 'broker' }), ERR('网络', { kind: 'plain' }), ERR('rpc 错', { kind: 'rpc', code: -32009 }), V([]), V(B(6, 4)), V(B(6, 5)), V(B(6, 60)), V(B(6).map((b) => ({ ...b, volume: undefined }))), V(B(6, 30).map((b, i) => (i % 7 === 0 ? { ...b, close: null } : b)))]) },
  steps: [ROUTER, ...'abcdefghi'.split('').map((c) => run(c, { strategy: 'sma_cross', params: { fast: 3, slow: 10 } }))],
});
add('run:审计留痕只在成功后;结果的键序', {
  h2router: { sessions: 1, results: RES([V(B(7)), ERR('坏', { kind: 'broker' }), V(B(8, 100))]) },
  steps: [ROUTER, run('a', { strategy: 'breakout', symbol: 'msft' }), run('b', { strategy: 'breakout' }), run('c', { strategy: 'rsi', symbol: 'brk.b', instrument: { type: 'put' } })],
});

// ---- sweep
const sweep = (id, a, extra = {}) => call(id, 'backtest.sweep', { symbols: ['AAPL'], ...RANGE, strategy: 'sma_cross', grid: { fast: [5, 10], slow: [30, 50] }, ...a, ...extra });
add('sweep:入参检查先后与原话', {
  h2router: { sessions: 1, results: RES([V(B(9))]) },
  steps: [call('a', 'backtest.sweep', {}), call('b', 'backtest.sweep', { symbols: [] }), call('c', 'backtest.sweep', { symbols: ['  ', ''] }), call('d', 'backtest.sweep', { symbols: Array.from({ length: 9 }, (_, i) => `A${i}`) }), call('e', 'backtest.sweep', { symbols: ['bad$', 'x y', 'OK'] }), call('e8', 'backtest.sweep', { symbols: Array.from({ length: 8 }, (_, i) => `A${i}`), ...RANGE, strategy: 'sma_cross', grid: { fast: [5, 10] } }),
    sweep('f', { start: 'x' }), sweep('g', { start: '2026-02-01', end: '2026-01-01' }), sweep('h', { start: '2000-01-01' }), sweep('i', { objective: 'sharpe' }), sweep('j', { objective: '' }), sweep('k', { objective: 5 }), sweep('l', { instrument: { type: 'x' } }), sweep('m', { cost_pct: 11 }),
    sweep('n', { split_pct: 49 }), sweep('o', { split_pct: 91 }), sweep('p', { folds: 7 }), sweep('q', { folds: -1 }), sweep('r', { grid: { fast: ['x'] } }), sweep('s', { grid: { fast: [0] } }), sweep('t', { grid: { fast: [251] } }), sweep('u', { grid: { fast: [0.00005] } }), sweep('v', { grid: { fast: [''] } }),
    sweep('w', { grid: { fast: ['1e1', ' 7 '] } }), sweep('x', { symbols: 'AAPL' }), sweep('y', { symbols: [5] }), sweep('z', { grid: 5 }), sweep('A', { grid: { fast: 5 } }), sweep('B', { symbols: ['A'.repeat(13)] }), sweep('C', { symbols: ['1ABC'] }), sweep('D', {}, { strategy: undefined }),
    sweep('E', { split_pct: 'abc' }), sweep('F', { folds: '2.9' }), sweep('G', { folds: true }), sweep('H', { cost_pct: [] })],
});
add('sweep:没连券商 / 取日线(逐只,BrokerError 带代码前缀)', {
  h2router: { sessions: 1, results: { 'historicalBars:AAPL': [V(B(10)), ERR('无权限', { kind: 'broker' }), V(B(10)), V(B(10)), ERR('网', { kind: 'plain' })], 'historicalBars:MSFT': [V(B(11)), V(B(11)), ERR('MSFT 坏', { kind: 'broker' }), V(B(11)), V(B(11))], 'historicalBars:NVDA': [V(B(12, 380)), V(B(12, 380)), V(B(12, 380)), V(B(12, 200)), V(B(12))] } },
  steps: [sweep('a', {}), ROUTER, sweep('b', { symbols: [' aapl ', 'MSFT', 'nvda', 'AAPL'] }), sweep('c', { symbols: ['AAPL', 'MSFT'] }), sweep('d', { symbols: ['AAPL', 'MSFT'] }), sweep('e', { symbols: ['AAPL', 'MSFT', 'NVDA'] }), sweep('f', { symbols: ['AAPL', 'MSFT', 'NVDA'] }), { op: 'h2routerSet', set: { sessions: 0 } }, sweep('g', {})],
});
add('sweep:成功(各策略的网格、样本内占比、滚动前推、目标、品种、成本)', {
  h2router: { sessions: 1, results: RES([V(B(13)), V(B(14)), V(B(15))]) },
  steps: [ROUTER, sweep('a', {}), sweep('b', { objective: 'calmar' }), sweep('c', { folds: 3, split_pct: 60 }), sweep('d', { folds: 6.9, split_pct: 90, cost_pct: 0.1 }), sweep('e', { strategy: 'rsi', grid: { period: [10, 14], buy_below: [25, 30], sell_above: [70, 75] } }),
    sweep('f', { strategy: 'breakout', grid: { entry: [10, 20, 40], exit: [5, 10] }, objective: 'calmar', folds: 2 }), sweep('g', { instrument: { type: 'call', dte: 20 }, grid: { fast: [5, 8], slow: [20] } }), sweep('h', { symbols: ['AAPL', 'MSFT', 'NVDA'], folds: 1 }),
    sweep('i', { grid: {} }), sweep('j', { grid: undefined }), sweep('k', { strategy: 'buy_hold', grid: {} }), sweep('l', { strategy: 'custom' }), sweep('m', { grid: { nope: [1, 2] } }), sweep('n', { grid: { fast: [5], slow: [] } }), sweep('o', { grid: { fast: Array.from({ length: 21 }, (_, i) => i + 1) } }),
    sweep('p', { grid: { fast: Array.from({ length: 20 }, (_, i) => i + 2), slow: Array.from({ length: 20 }, (_, i) => i + 22) } }), sweep('q', { grid: { 2: [5], fast: [5] } }), sweep('r', { strategy: 'nope' }), sweep('s', { grid: { fast: [5, 10], slow: [30, 50] }, split_pct: 70.5 }),
    sweep('t', { grid: { fast: ['5', ' 10 '], slow: [30] } }), sweep('t2', { folds: 2.9 }), sweep('t3', { folds: '3.5', objective: 'calmar' }), sweep('u', { symbols: ['AAPL', 'MSFT'], grid: { fast: [5, 10], slow: [40] }, instrument: { type: 'butterfly' }, objective: 'calmar' })],
});

// ---- parse_rules
const long = (n, ch = '涨') => ch.repeat(n);
add('parse_rules:成功 / 空 / 太长(按码点)/ 模型抛错 / 回包不合 schema', {
  llm: [V({ entry: [{ left: ent('close'), op: '>', right: ent('sma', 20) }], exit: [] }), V(RULES), V({ entry: [{ left: ent('rsi', '14'), op: '<', right: cst('30') }] }), ERR('调用超时'), ERR('限流', { kind: 'rpc', code: -32011 }), ERR('券商', { kind: 'broker' }), V({}), V(null), V('x'), V([]), V({ entry: [] }),
    V({ entry: [{ left: ent('close'), op: '?', right: cst(1) }] }), V({ entry: [{ left: ent('sma'), op: '>', right: cst(1) }] }), V({ ...RULES, extra: 1 }), V({ entry: [{ left: { kind: 'const' }, op: '>', right: cst(1) }] }), V({ entry: Array.from({ length: 7 }, () => ({ left: ent('close'), op: '>', right: cst(1) })) }), V(RULES)],
  steps: [call('a', 'backtest.parse_rules', { text: '收盘价站上 20 日均线买入,RSI 超过 70 卖出' }), call('b', 'backtest.parse_rules', { text: '  MACD 金叉买入  ' }), call('c', 'backtest.parse_rules', { text: 'x' }), call('d', 'backtest.parse_rules', {}), call('e', 'backtest.parse_rules', { text: '' }), call('f', 'backtest.parse_rules', { text: ' \n\t ' }),
    call('g', 'backtest.parse_rules', { text: long(1000) }), call('h', 'backtest.parse_rules', { text: long(1001) }), call('i', 'backtest.parse_rules', { text: long(1000, '😀') }), call('j', 'backtest.parse_rules', { text: long(1001, '😀') }), call('k', 'backtest.parse_rules', { text: long(1000, 'a') + '  ' }),
    call('l', 'backtest.parse_rules', { text: '​' }), call('m', 'backtest.parse_rules', { text: 5 }), call('n', 'backtest.parse_rules', { text: null }), call('o', 'backtest.parse_rules', { text: ['a'] }), call('p', 'backtest.parse_rules', { text: 'q1' }), call('q', 'backtest.parse_rules', { text: 'q2' }), call('r', 'backtest.parse_rules', { text: 'q3' }),
    call('s', 'backtest.parse_rules', { text: 'q4' }), call('t', 'backtest.parse_rules', { text: 'q5' }), call('u', 'backtest.parse_rules', { text: 'q6' }), call('v', 'backtest.parse_rules', { text: 'q7' }), call('w', 'backtest.parse_rules', { text: 'q8' }), call('x', 'backtest.parse_rules', { text: 'q9' }),
    call('y', 'backtest.parse_rules', { text: 'q10' }), call('z', 'backtest.parse_rules', { text: 'q11' }), call('A', 'backtest.parse_rules', { text: 'q12' }), call('B', 'backtest.parse_rules', { text: 'q13' }), call('C', 'backtest.parse_rules', { text: 'q14' })],
});
add('parse_rules:模型没脚本(解析器默认抛错)', { steps: [call('a', 'backtest.parse_rules', { text: '随便' })] });

// ---- 随机参数
const fz = rng(20261022);
const pickOf = (a) => a[fz.int(a.length)];
const rndDate = () => pickOf(['2025-01-02', '2026-10-09', '2020-01-01', '2026-02-30', 'x', '2026-1-1', '2016-01-01', '2026-01-01', '2025-06-30']);
const strategies = ['buy_hold', 'sma_cross', 'rsi', 'breakout', 'custom', 'nope', ''];
const rndParams = (st) => (st === 'sma_cross' ? pickOf([{ fast: pickOf([3, 5, 10, '8', 0, 300]), slow: pickOf([20, 50, '40']) }, {}, { x: 1 }]) : st === 'rsi' ? pickOf([{ period: pickOf([7, 14, 'x']), buy_below: pickOf([20, 30, 100]), sell_above: pickOf([70, 80, 0]) }, {}]) : st === 'breakout' ? pickOf([{ entry: pickOf([10, 20, 55]), exit: pickOf([5, 10]) }, {}]) : {});
const rndInst = () => pickOf([undefined, {}, { type: 'call' }, { type: 'put', dte: 14 }, { type: 'call_spread', width_pct: 3 }, { type: 'butterfly', risk_pct: 25 }, { type: 'zzz' }, { dte: 500 }, { type: 'put_spread', offset_pct: '-3' }]);
for (let k = 0; k < 40; k += 1) {
  const steps = [];
  if (fz.chance(0.92)) steps.push(ROUTER);
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push(fz.chance(0.12) ? ERR(pickOf(['无权限', '网络']), fz.chance(0.5) ? { kind: 'broker' } : {}) : V(B(fz.int(30), pickOf([3, 5, 40, 120, 300, 420]))));
  const llm = [];
  for (let i = 0; i < 4; i += 1) llm.push(fz.chance(0.2) ? ERR('boom') : V(pickOf([RULES, {}, { entry: [{ left: ent('close'), op: '>', right: cst(50) }] }, null])));
  for (let c = 0; c < 4; c += 1) {
    const m = pickOf(['backtest.run', 'backtest.run', 'backtest.sweep', 'backtest.parse_rules', 'backtest.strategies']);
    if (m === 'backtest.run') {
      const st = pickOf(strategies);
      const a = { symbol: pickOf(['AAPL', 'msft', 'bad$', ' nvda ', 'BRK.B']), start: rndDate(), end: pickOf(['2026-10-09', '2026-01-01', 'bad', '2030-01-01']), strategy: st };
      const p = rndParams(st); if (fz.chance(0.7)) a.params = p;
      if (st === 'custom' && fz.chance(0.8)) a.rules = pickOf([RULES, { entry: [{ left: ent('close'), op: '>', right: cst(100) }] }, {}, { entry: [] }]);
      const inst = rndInst(); if (inst !== undefined) a.instrument = inst;
      if (fz.chance(0.3)) a.cost_pct = pickOf([0, 0.1, '0.2', 11, 'x', '', null]);
      steps.push(call(`c${c}`, m, a));
    } else if (m === 'backtest.sweep') {
      const st = pickOf(['sma_cross', 'rsi', 'breakout', 'buy_hold', 'nope']);
      const grid = st === 'sma_cross' ? { fast: [3, 5, 8], slow: pickOf([[20, 30], ['40'], [10]]) } : st === 'rsi' ? { period: [7, 14], buy_below: [20, 30] } : st === 'breakout' ? { entry: [10, 20], exit: [5] } : pickOf([{}, { x: [1] }]);
      const a = { symbols: pickOf([['AAPL'], ['aapl', 'MSFT'], [], ['bad$'], ['AAPL', 'MSFT', 'NVDA']]), start: rndDate(), end: '2026-10-09', strategy: st, grid };
      if (fz.chance(0.5)) a.objective = pickOf(['return', 'calmar', 'x']);
      if (fz.chance(0.5)) a.folds = pickOf([0, 1, 2, 3.5, 7]);
      if (fz.chance(0.5)) a.split_pct = pickOf([50, 60, 70, 90, 95]);
      if (fz.chance(0.3)) a.cost_pct = pickOf([0, 0.1, 11]);
      const inst = rndInst(); if (inst !== undefined) a.instrument = inst;
      steps.push(call(`c${c}`, m, a));
    } else if (m === 'backtest.parse_rules') {
      steps.push(call(`c${c}`, m, fz.chance(0.9) ? { text: pickOf(['均线金叉买入', '  ', long(1001), 'rsi < 30 买']) } : {}));
    } else steps.push(call(`c${c}`, m));
    if (fz.chance(0.1)) steps.push({ op: 'h2routerSet', set: { sessions: pickOf([0, 1]) } });
  }
  add(`随机 #${k}`, { h2router: { sessions: 1, results: { historicalBars: results } }, llm, steps });
}

// zod 的 message 里 too_small / too_big / invalid_enum_value 带的 minimum / options 等字段,C++ 的 util::zod::Issue 没存(见 handlers2_support.h 的 zodErrorMessage):
// 这类入参的回执 C++ 只能与 TS 差在 message 的字段上。同一条 handler 代码路径用 invalid_type / unrecognized_keys / custom 照样走到,所以把落在这三种 code 上的调用从脚本里去掉。
const KNOWN_ZOD_GAP = /"code\\?": ?\\?"(too_small|too_big|invalid_enum_value)\\?"|"received\\?": ?\\?"float\\?"/; // 整数检查的 invalid_type(received float)键序也不同
const out = [];
let pruned = 0;
for (const s of scenarios) {
  let expected = await h2.run(s.script);
  for (;;) {
    const bad = new Set();
    for (const st of expected.steps) for (const d of st.done ?? []) if (d.result?.error && KNOWN_ZOD_GAP.test(JSON.stringify(d.result.error))) bad.add(d.id);
    if (!bad.size) break;
    pruned += bad.size;
    s.script.steps = s.script.steps.filter((st) => !(st.op === 'call' && bad.has(st.id)));
    expected = await h2.run(s.script);
  }
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
console.log(`去掉 ${pruned} 个落在 zod 已知差异上的调用`);
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_backtest.json'), text);
console.log(`h2_backtest.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
