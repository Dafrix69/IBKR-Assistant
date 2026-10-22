// 生成 backtest_engine.json:engine-ts 的 backtest.ts(原模块现跑)在黄金基线的 11 个场景与合成日线上的回执
// (backtest.json 这个名字是回测页的界面夹具占着的,这里是引擎那一份)。
// 合成的:随机游走的日线(低价、高价、跳空、平盘、日期有空档与写坏的)、五个策略 + 自定义条件(含坏的操作数、坏的比较符、
// Object.prototype 上的名字当策略与参数名)、股票与五种期权结构(dte / 偏移 / 宽度 / 占比有串、有越界)、每边成本;
// 另有 evaluateSegment 按截取 [lo, hi) 与外给的波动率结算,以及各个指标、BS 定价、已实现波动率的逐个输入。
// 定价走 log / exp / erf,要用打包版应用里那个运行时生成:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_backtest_engine.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/backtest.js')).href);

let seed = 0xb7e5_0011;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gauss = () => { const u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
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
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };

const out = { strategies: enc(X.STRATEGIES), optionTypes: enc(X.OPTION_TYPES), barSets: [], runs: [], segments: [], indicators: [], bs: [], vols: [], misc: [] };

// ---------------------------------------------------------------- 日线
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
function synthBars(n, opts) {
  const bars = [];
  let t = Date.UTC(2024, pick([0, 2, 5, 9]), 1 + Math.floor(rnd() * 20));
  let px = opts.start;
  for (let i = 0; i < n; i += 1) {
    t += 86_400_000;
    while ([0, 6].includes(new Date(t).getUTCDay()) || rnd() < opts.holiday) t += 86_400_000;
    const gap = rnd() < opts.gapShare ? gauss() * opts.vol * 4 : gauss() * opts.vol * 0.3;
    const open = px * Math.exp(gap);
    const close = opts.flat && rnd() < 0.5 ? open : open * Math.exp(gauss() * opts.vol + opts.drift);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * opts.vol * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * opts.vol * 0.5);
    const round = (x) => (opts.round ? Math.round(x * 100) / 100 : x);
    bars.push({ date: isoOf(t), open: round(open), high: round(high), low: round(low), close: round(close) });
    px = close;
  }
  if (opts.badDate) bars[Math.floor(rnd() * n)].date = pick(['2024-13-01', '', 'x', '2024-02-30']);
  if (opts.zero) { const b = bars[Math.floor(rnd() * n)]; b[pick(['open', 'close'])] = pick([0, -1, NaN]); }
  if (opts.zeroEarly) bars[Math.min(3, n - 1)].close = 0;
  return bars;
}
const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/backtest.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const resolve = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$bars === 'string' ? store[v.$bars] : v);
const goldenBars = resolve(golden.bars).map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
out.barSets.push(goldenBars);
const opts = () => ({
  start: pick([8, 20, 24.9, 60, 150, 199, 210, 480, 3000]), vol: pick([0.004, 0.01, 0.02, 0.035, 0.06]), drift: pick([0, 0, 0.001, -0.001]),
  gapShare: pick([0, 0.05, 0.2]), holiday: pick([0, 0.03, 0.1]), flat: rnd() < 0.08, round: rnd() < 0.5,
  badDate: rnd() < 0.05, zero: rnd() < 0.06, zeroEarly: rnd() < 0.03,
});
for (let i = 0; i < 30; i += 1) out.barSets.push(synthBars(pick([5, 6, 12, 22, 25, 40, 60, 90, 120, 160, 200]), opts()));
for (const n of [3, 4, 5, 21]) out.barSets.push(synthBars(n, { ...opts(), zero: false, badDate: false, zeroEarly: false }));
// 一路涨、一路跌、横盘(期权在这些上面会到期再开、打不到最小报价单位)
out.barSets.push(Array.from({ length: 80 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 86_400_000), open: 100 + i, high: 101.5 + i, low: 99.5 + i, close: 100.8 + i })));
out.barSets.push(Array.from({ length: 80 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 86_400_000), open: 300 - 2 * i, high: 301 - 2 * i, low: 297 - 2 * i, close: 298 - 2 * i })));
out.barSets.push(Array.from({ length: 70 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 86_400_000), open: 50, high: 50, low: 50, close: 50 })));
out.barSets.push(Array.from({ length: 70 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 86_400_000), open: 0.05 + i * 1e-4, high: 0.06, low: 0.04, close: 0.05 + i * 1e-4 })));

// ---------------------------------------------------------------- 整段回测
for (const c of golden.cases) {
  out.runs.push({ name: c.name, set: 0, strategy: c.strategy, params: enc(c.params), rules: enc(c.rules), instrument: enc(c.instrument), cost: 0,
    ...run(() => X.runBacktest(goldenBars, c.strategy, c.params, c.rules, c.instrument)) });
}
const operands = () => pick([
  { kind: 'indicator', name: 'close' }, { kind: 'indicator', name: 'open' }, { kind: 'indicator', name: 'high' }, { kind: 'indicator', name: 'low' },
  { kind: 'indicator', name: 'sma', period: pick([3, 5, 10, 20, 50]) }, { kind: 'indicator', name: 'ema', period: pick([3, 9, 12, 30]) },
  { kind: 'indicator', name: 'rsi', period: pick([2, 7, 14]) }, { kind: 'indicator', name: 'highest', period: pick([1, 5, 20]) },
  { kind: 'indicator', name: 'lowest', period: pick([1, 5, 10]) }, { kind: 'indicator', name: 'change_pct', period: pick([1, 5, 20]) },
  { kind: 'indicator', name: 'macd_hist' }, { kind: 'const', value: pick([0, 30, 70, -2, 2, '50', 100]) },
  { kind: 'indicator', name: 'sma', period: '7.9' }, { kind: 'indicator', name: 'sma', period: pick([0, 300, -3, 'x', null]) },
  { kind: 'indicator', name: 'bogus' }, { kind: 'indicator' }, { kind: 'const', value: pick([null, 'x']) }, { kind: 'const' },
  { kind: 'indicator', name: 5 }, { kind: 'indicator', name: 'rsi', period: 0.5 },
]);
const goodOps = ['>', '<', '>=', '<=', 'cross_up', 'cross_down'];
const cond = () => ({ left: operands(), op: rnd() < 0.04 ? pick(['==', 'x', null, 5]) : pick(goodOps), right: operands() });
const rulePool = () => {
  const r = rnd();
  if (r < 0.03) return pick([null, {}, { entry: [] }, { entry: 'ab' }, { entry: 5 }, { entry: { length: 1 } }]);
  if (r < 0.05) return { entry: [cond()], exit: pick([5, 'x', {}]) };
  if (r < 0.06) return { entry: [null] };
  if (r < 0.07) return { entry: [{ op: '>' }] };
  const rules = { entry: Array.from({ length: 1 + Math.floor(rnd() * 3) }, cond) };
  if (rnd() < 0.8) rules.exit = Array.from({ length: Math.floor(rnd() * 3) }, cond);
  else if (rnd() < 0.5) rules.exit = null;
  return rules;
};
const paramPool = (strategy) => {
  const r = rnd();
  if (r < 0.3) return pick([null, undefined, {}]);
  if (r < 0.36) return pick(['ab', [5], 5, true, '', []]);
  const table = { sma_cross: ['fast', 'slow'], rsi: ['period', 'buy_below', 'sell_above'], breakout: ['entry', 'exit'] };
  const keys = Object.hasOwn(table, strategy) ? table[strategy] : ['fast'];
  const o = {};
  for (const k of keys) if (rnd() < 0.7) o[k] = k === 'buy_below' ? pick([20, 30, 45, '35', 0, 100, 99.5]) : k === 'sell_above' ? pick([55, 70, 80, 30.5])
    : pick([2, 3, 5, 10, 15, 20, 50, 7.8, '12', ' 9 ', 0, 251, 250, -1, null, true, 'x', [4], NaN]);
  if (rnd() < 0.08) o[pick(['toString', 'valueOf', 'constructor', 'bogus', 'hasOwnProperty'])] = pick([3, 'x', 0]);
  if (rnd() < 0.03) Object.defineProperty(o, '__proto__', { value: pick([4, 0, 'x']), enumerable: true });
  return o;
};
const instPool = () => {
  const r = rnd();
  if (r < 0.35) return pick([null, undefined, { type: 'stock' }, {}]);
  if (r < 0.4) return pick([{ type: 'bogus' }, { type: 'toString' }, { type: null, dte: 5 }, { type: ['call'] }, { type: 5 }, 'call', [1]]);
  const o = { type: pick(['call', 'put', 'call_spread', 'put_spread', 'butterfly']) };
  if (rnd() < 0.7) o.dte = pick([1, 2, 5, 7, 21, 30, 45, 90, 365, 0, 366, '14', 7.9, null, 'x']);
  if (rnd() < 0.5) o.offset_pct = pick([0, 1, -1, 5, -5, 30, -30, 31, '2', null, 12.5]);
  if (rnd() < 0.5) o.width_pct = pick([0.1, 1, 2, 3, 5, 20, 21, 0, -1, '4']);
  if (rnd() < 0.5) o.risk_pct = pick([1, 5, 10, 50, 100, 101, 0, '20']);
  return o;
};
const strategyPool = () => pick(['buy_hold', 'sma_cross', 'sma_cross', 'rsi', 'rsi', 'breakout', 'breakout', 'custom', 'custom', 'custom', 'toString', 'nope', '__proto__', 'constructor']);
// 干净的一份:参数、条件、品种都合法,日线也没写坏(结算与统计的每一支都要有足够的成功样本)
const cleanSets = out.barSets.map((b, i) => i).filter((i) => out.barSets[i].length >= 22 && out.barSets[i].every((b) => b.open > 0 && b.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && !Number.isNaN(Date.parse(b.date))));
const cleanOperand = () => pick([
  { kind: 'indicator', name: 'close' }, { kind: 'indicator', name: 'open' }, { kind: 'indicator', name: 'high' }, { kind: 'indicator', name: 'low' },
  { kind: 'indicator', name: 'sma', period: pick([3, 5, 10, 20]) }, { kind: 'indicator', name: 'ema', period: pick([3, 9, 12]) },
  { kind: 'indicator', name: 'rsi', period: pick([2, 7, 14]) }, { kind: 'indicator', name: 'highest', period: pick([1, 5, 20]) },
  { kind: 'indicator', name: 'lowest', period: pick([1, 5, 10]) }, { kind: 'indicator', name: 'change_pct', period: pick([1, 5]) },
  { kind: 'indicator', name: 'macd_hist' }, { kind: 'const', value: pick([0, 30, 70, -2, 2, 50]) },
]);
const cleanCond = () => ({ left: cleanOperand(), op: pick(goodOps), right: cleanOperand() });
const cleanRun = () => {
  const strategy = pick(['buy_hold', 'sma_cross', 'rsi', 'breakout', 'custom', 'custom']);
  let params = null;
  if (strategy === 'sma_cross') { const f = pick([2, 3, 5, 10]); params = { fast: f, slow: f + pick([1, 5, 15, 40]) }; }
  if (strategy === 'rsi') params = { period: pick([2, 5, 14]), buy_below: pick([25, 30, 45]), sell_above: pick([55, 70, 75]) };
  if (strategy === 'breakout') params = { entry: pick([3, 5, 20]), exit: pick([2, 5, 10]) };
  if (params && rnd() < 0.3) params = Object.fromEntries(Object.entries(params).filter(() => rnd() < 0.5));
  const rules = strategy === 'custom' ? { entry: Array.from({ length: 1 + Math.floor(rnd() * 2) }, cleanCond), exit: Array.from({ length: Math.floor(rnd() * 3) }, cleanCond) } : null;
  const instrument = rnd() < 0.4 ? pick([null, { type: 'stock' }]) : {
    type: pick(['call', 'put', 'call_spread', 'put_spread', 'butterfly']), dte: pick([1, 2, 5, 7, 21, 30, 45, 90, 365]),
    offset_pct: pick([0, 1, -1, 5, -5, 30, -30]), width_pct: pick([0.1, 1, 2, 3, 5, 20]), risk_pct: pick([1, 5, 10, 50, 100]),
  };
  return { strategy, params, rules, instrument, cost: pick([0, 0, 0.05, 0.1, 1, 10, 0.001]) };
};
for (let i = 0; i < 90; i += 1) {
  const set = pick(cleanSets);
  const { strategy, params, rules, instrument, cost } = cleanRun();
  out.runs.push({ name: `c${i}`, set, strategy, params: enc(params), rules: enc(rules), instrument: enc(instrument), cost: enc(cost),
    ...run(() => X.runBacktest(out.barSets[set], strategy, params, rules, instrument, cost)) });
}
for (let i = 0; i < 200; i += 1) {
  const set = Math.floor(rnd() * out.barSets.length);
  const strategy = strategyPool();
  const params = paramPool(strategy);
  const rules = strategy === 'custom' || rnd() < 0.05 ? rulePool() : null;
  const instrument = instPool();
  const cost = pick([0, 0, 0, 0.05, 0.1, 1, 10, 10.5, -0.1, NaN, 0.001]);
  out.runs.push({ name: `r${i}`, set, strategy, params: enc(params), rules: enc(rules), instrument: enc(instrument), cost: enc(cost),
    ...run(() => X.runBacktest(out.barSets[set], strategy, params, rules, instrument, cost)) });
}

// 写明的几条:exit 不是数组、条件是 null、比较符坏了但两边全是 null(不抛)
{
  const c0 = { left: { kind: 'indicator', name: 'close' }, op: '>', right: { kind: 'const', value: 1 } };
  const bad = [
    { entry: [c0], exit: 5 }, { entry: [c0], exit: 'x' }, { entry: [c0], exit: {} }, { entry: [null] }, { entry: [c0, 7] },
    { entry: [{ left: { kind: 'indicator', name: 'sma', period: 250 }, op: '==', right: { kind: 'const', value: 1 } }] },
    { entry: [{ left: { kind: 'indicator', name: 'sma', period: 3 }, op: '==', right: { kind: 'const', value: 1 } }] },
    { entry: [c0], exit: [{ left: null, op: '<', right: { kind: 'const', value: 1e9 } }] },
  ];
  for (const [j, rules] of bad.entries()) {
    out.runs.push({ name: `w${j}`, set: 1, strategy: 'custom', params: null, rules: enc(rules), instrument: null, cost: 0,
      ...run(() => X.runBacktest(out.barSets[1], 'custom', null, rules, null, 0)) });
  }
}

// 打平的边界:整数价位的随机游走(均线、RSI、突破、上穿下穿都会正好相等)、横盘、正好 365 天的区间
{
  let px = 100;
  const ints = [];
  for (let i = 0; i < 120; i += 1) {
    const open = px;
    const close = Math.max(90, Math.min(110, open + pick([-1, 0, 1, 1, -1, 2, -2])));
    ints.push({ date: isoOf(Date.UTC(2025, 2, 1) + i * 86_400_000), open, high: Math.max(open, close) + pick([0, 1]), low: Math.min(open, close) - pick([0, 1]), close });
    px = close;
  }
  const intSet = out.barSets.push(ints) - 1;
  const year = Array.from({ length: 53 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 7 * 86_400_000), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
  year.push({ date: '2026-01-01', open: 160, high: 162, low: 158, close: 161 });
  const yearSet = out.barSets.push(year) - 1;
  const year2 = year.map((b) => ({ ...b })); year2[year2.length - 1].date = '2026-01-02';
  const yearSet2 = out.barSets.push(year2) - 1;
  const flatSet = out.barSets.findIndex((b) => b.length === 70 && b.every((x) => x.close === 50));
  // Wilder RSI 正好落在 50 / 75 / 37.5 / 68.75 上(周期 2、涨跌各 1 的序列)
  const steps = [1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1];
  let c0 = 100;
  const tie = Array.from({ length: 60 }, (_, i) => { const open = c0; c0 += steps[i % steps.length]; return { date: isoOf(Date.UTC(2025, 5, 1) + i * 86_400_000), open, high: Math.max(open, c0) + 1, low: Math.min(open, c0) - 1, close: c0 }; });
  const tieSet = out.barSets.push(tie) - 1;
  for (const [b, a] of [[50, 75], [50, 68.75], [37.5, 75], [25, 75], [50, 62.5], [37.5, 68.75], [50, 56.25], [25, 78.125]]) {
    out.runs.push({ name: `t${b}-${a}`, set: tieSet, strategy: 'rsi', params: { period: 2, buy_below: b, sell_above: a }, rules: null, instrument: null, cost: 0,
      ...run(() => X.runBacktest(tie, 'rsi', { period: 2, buy_below: b, sell_above: a }, null, null, 0)) });
  }
  const op = (name, period) => (name === 'const' ? { kind: 'const', value: period } : { kind: 'indicator', name, ...(period ? { period } : {}) });
  const cases = [];
  for (const set of [intSet, flatSet, yearSet]) {
    for (const [f, sl] of [[2, 3], [3, 5], [5, 10]]) cases.push([set, 'sma_cross', { fast: f, slow: sl }, null]);
    for (const [p, b, a] of [[2, 25, 75], [2, 50, 75], [3, 25, 50], [2, 55, 55], [4, 40, 60]]) cases.push([set, 'rsi', { period: p, buy_below: b, sell_above: a }, null]);
    for (const [e, x] of [[2, 1], [3, 2], [5, 3], [1, 1]]) cases.push([set, 'breakout', { entry: e, exit: x }, null]);
    for (const o of ['>', '<', '>=', '<=', 'cross_up', 'cross_down']) {
      cases.push([set, 'custom', null, { entry: [{ left: op('close'), op: o, right: op('sma', 3) }], exit: [{ left: op('close'), op: o === 'cross_up' ? 'cross_down' : '<=', right: op('ema', 3) }] }]);
      cases.push([set, 'custom', null, { entry: [{ left: op('close'), op: o, right: op('const', 100) }], exit: [{ left: op('open'), op: o, right: op('const', 101) }] }]);
      cases.push([set, 'custom', null, { entry: [{ left: op('change_pct', 3), op: o, right: op('const', 0) }], exit: [{ left: op('change_pct', 2), op: '<', right: op('const', 0) }] }]);
      cases.push([set, 'custom', null, { entry: [{ left: op('close'), op: o, right: op('highest', 3) }], exit: [{ left: op('low'), op: o, right: op('lowest', 2) }] }]);
    }
    cases.push([set, 'sma_cross', JSON.parse('{"__proto__": 5, "fast": 3}'), null]);
    cases.push([set, 'sma_cross', { toString: 4, slow: 9 }, null]);
    cases.push([set, 'toString', { valueOf: 4 }, null]);
    cases.push([set, 'buy_hold', null, null]);
  }
  cases.push([yearSet2, 'buy_hold', null, null], [yearSet2, 'sma_cross', { fast: 2, slow: 3 }, null]);
  for (const [j, [set, strategy, params, rules]] of cases.entries()) {
    for (const instrument of [null, { type: 'call', dte: 5 }, { type: 'butterfly', dte: 3, width_pct: 1 }].slice(0, set === intSet && j % 4 === 0 ? 3 : 1)) {
      out.runs.push({ name: `e${j}`, set, strategy, params: enc(params), rules: enc(rules), instrument: enc(instrument), cost: 0,
        ...run(() => X.runBacktest(out.barSets[set], strategy, params, rules, instrument, 0)) });
    }
  }
}

// ---------------------------------------------------------------- 截一段结算(参数扫描、前推的每一折是这么调的)
for (let i = 0; i < 110; i += 1) {
  const set = rnd() < 0.8 ? pick(cleanSets.filter((k) => k > 0)) : 1 + Math.floor(rnd() * (out.barSets.length - 1));
  const bars = out.barSets[set];
  const strategy = pick(['buy_hold', 'sma_cross', 'rsi', 'breakout']);
  let sig;
  try { sig = X.signalPositions(bars, strategy, strategy === 'sma_cross' ? { fast: 3, slow: 8 } : strategy === 'rsi' ? { period: 5 } : strategy === 'breakout' ? { entry: 5, exit: 3 } : {}, null); } catch { continue; }
  const held = X.heldAfterOpen(sig.positions);
  const inst = { type: pick(['stock', 'stock', 'call', 'put', 'call_spread', 'put_spread', 'butterfly', 'bogus']), dte: pick([5, 20, 30]), offset_pct: 0, width_pct: 2, risk_pct: 10 };
  const lo = pick([0, 0, 0, 1, 5, 20, 20, 30, Math.floor(bars.length / 2), Math.floor(bars.length / 3), bars.length - 2, bars.length - 1, -1]);
  const hi = pick([bars.length, bars.length, bars.length, bars.length - 1, bars.length - 3, lo + 2, lo + 30, lo + 1, bars.length + 1, undefined]);
  const withVol = rnd() < 0.6;
  const vol = withVol ? X.trailingVol(bars.map((b) => b.close)) : undefined;
  const share = withVol ? X.trailingSessionShare(bars) : undefined;
  const cost = pick([undefined, 0, 0.2, 0, 0.5, undefined, 0.2, 11]);
  const seg = { bars, held, strategy, params: sig.usedParams, inst, costPct: cost, lo: rnd() < 0.1 ? undefined : lo, hi, vol, sessionShare: share };
  out.segments.push({ set, held, strategy, params: sig.usedParams, inst, cost: enc(cost), lo: enc(seg.lo), hi: enc(hi), withVol, ...run(() => X.evaluateSegment(seg)) });
}

// ---------------------------------------------------------------- 指标
for (let i = 0; i < 150; i += 1) {
  const n = pick([0, 1, 2, 5, 9, 12, 14, 15, 26, 27, 34, 35, 60, 120]);
  let x = pick([10, 100, 1000]);
  const values = Array.from({ length: n }, () => (x *= Math.exp(gauss() * pick([0.001, 0.02, 0.1]))));
  if (rnd() < 0.1 && n) values[Math.floor(rnd() * n)] = x;
  const w = pick([1, 2, 3, 5, 9, 12, 14, 20, 26, 50]);
  const wOdd = pick([0, -2, -5, 0.5]);
  out.indicators.push({ values, w, ema: enc(X.ema(values, w)), sma: enc(X.sma(values, w)), rsi: enc(X.rsi(values, w)), macd: enc(X.macdHist(values)),
    wOdd, smaOdd: enc(X.sma(values, wOdd)) });
}
// ---------------------------------------------------------------- BS
for (let i = 0; i < 3000; i += 1) {
  const s = pick([20, 100, 101.37, 250, 4000]) * Math.exp(gauss() * 0.1);
  const k = s * Math.exp(gauss() * pick([0.01, 0.05, 0.2]));
  const t = pick([0, -1, 1e-8, 1 / 252, 5 / 252, 0.1, 30 / 252, 1, rnd(), NaN]);
  const sigma = pick([0, -0.1, 1e-6, 0.05, 0.2, 0.4, 1.2, 3, rnd(), NaN]);
  const right = pick(['C', 'P', 'C', 'P', 'x']);
  out.bs.push([s, k, enc(t), enc(sigma), right, enc(X.bsPrice(s, k, t, sigma, right))]);
}
for (const p of [0, 1, 25, 25.0001, 199.99, 200, 200.01, -5, NaN, 1e9]) out.misc.push({ p: enc(p), step: X.strikeStep(p) });
// ---------------------------------------------------------------- 已实现波动率
for (let i = 1; i < out.barSets.length; i += 1) {
  const bars = out.barSets[i];
  const closes = bars.map((b) => b.close);
  out.vols.push({ set: i, tv: enc(X.trailingVol(closes)), tv5: enc(X.trailingVol(closes, 5)), ss: enc(X.trailingSessionShare(bars)), ss3: enc(X.trailingSessionShare(bars, 3)),
    rv: enc(X.realizedVol(closes)), rvShort: enc(X.realizedVol(closes.slice(0, 7))), rv6: enc(X.realizedVol(closes.slice(0, 6))), rv5: enc(X.realizedVol(closes.slice(0, 5))),
    held: X.heldAfterOpen(bars.map((_, j) => (j % 3 ? 1 : 0))) });
}
out.extraVol = [];
for (let i = 0; i < 30; i += 1) {
  const closes = Array.from({ length: 30 }, () => 100 * Math.exp(gauss() * 0.02));
  closes[Math.floor(rnd() * 30)] = pick([0, -1, 0]);
  if (rnd() < 0.3) closes[Math.floor(rnd() * 30)] = 0;
  out.extraVol.push({ closes, tv: enc(X.trailingVol(closes)), tv5: enc(X.trailingVol(closes, 5)), rv: enc(X.realizedVol(closes)) });
}
out.vols.push({ set: -1, rvNeg: X.realizedVol([-1, -2, -3, 0, 5, 6, 7]), rvZeros: enc(X.realizedVol([0, 0, 0, 0, 0, 0, 0, 1])) });

writeFileSync(join(here, 'backtest_engine.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out, barSets: out.barSets.map(enc) }) + '\n');
console.log('backtest_engine.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '-'}`).join(' '));
