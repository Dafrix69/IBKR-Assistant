// 生成 backtest.json:「回测」(desktop/renderer-react/src/pages/Backtest.tsx + lib/RuleBuilder.tsx、BacktestResult.tsx、SweepPanel.tsx)。
//   · pages:SSR 把原页面渲染出来抽字。表单、结果、条件搭建器的一句话、参数扫描的表单与结果都由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值
//     (效果在 SSR 里不跑:读策略目录、换策略带出默认参数这两步由种子给)。
//     数据底子是预览台的 mock(三个策略、sma_cross 的回测、真实产出的参数扫描),策略目录补上引擎里另外两个(N 日突破、自定义),外加改出来的边角。
//   · charts:净值曲线那张图的 spec(BacktestResult 里 useMemo 拼的,照原文切出来跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_backtest.mjs <装好依赖的 desktop 目录>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
if (process.env.TZ !== 'Asia/Shanghai') throw new Error('时间按本机时区写:要 TZ=Asia/Shanghai 跑');

const NOW = Date.UTC(2026, 8, 8, 14, 30, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

function loadMock() {
  const w = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window: w, console, setTimeout, clearTimeout, Date: RealDate, Math, JSON, Promise };
  w.window = w;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(repo, 'desktop/tools/mock-bridge.js'), 'utf8'), sandbox);
  return w.dafri;
}
const mock = loadMock();
const store = {};
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => mock[name] ?? (async () => ({})) }),
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), loading: /ant-btn-loading/.test(m[1]), disabled: /\sdisabled=""/.test(m[1]) }));
/** 输入框:值与占位(SSR 里是属性,不是字) */
const inputs = (html) => [...html.matchAll(/<input([^>]*)>/g)].map((m) => ({
  value: decode(/\svalue="([^"]*)"/.exec(m[1])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[1])?.[1] ?? ''), id: /\sid="([^"]*)"/.exec(m[1])?.[1] ?? '' }));
const selects = (html) => [...html.matchAll(/<span class="ant-select-selection-(item|placeholder)"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ kind: m[1], text: texts(m[2]).join('') }));
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
/** 流程图的卡片:种类与两行字 */
const flow = (html) => [...html.matchAll(/<div class="flow-card ([^"]*)"><div class="flow-title">([\s\S]*?)<\/div>(?:<div class="flow-body">([\s\S]*?)<\/div>)?/g)].map((m) => ({ kind: m[1], title: decode(m[2]), body: m[3] === undefined ? null : decode(m[3]) }));
/** 数字瓦片:名、数与着色 */
const tiles = (html) => [...html.matchAll(/<div class="stat-tile([^"]*)"[\s\S]*?<\/div><\/div>/g)].map((m) => ({ cls: m[1].trim(), text: texts(m[0]).join('|') }));
/** 卡片的状态(tone-*) */
const cards = (html) => [...html.matchAll(/class="ant-card[^"]*status-card tone-(\w+)/g)].map((m) => m[1]);
/** 带颜色的数(perf-num pos / neg)与交易明细的状态胶囊 */
const tones = (html) => [...html.matchAll(/<span class="(perf-num[^"]*|status (?:filled|rejected))">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], text: decode(m[2]) }));
const pager = (html) => [...html.matchAll(/<li[^>]*class="ant-pagination-item[^"]*"[^>]*>/g)].length;

// ---- 数据 ------------------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const { strategies: mockStrategies } = await mock.backtestStrategies();
// 引擎的目录(backtest.ts 的 STRATEGIES)比 mock 多两个:N 日突破、自定义
const strategies = [...clone(mockStrategies),
  { key: 'breakout', label: 'N 日突破', desc: '收盘创 N 日新高买入,跌破 M 日低点离场(唐奇安通道)。', params: { entry: 20, exit: 10 }, param_labels: { entry: '入场:创 N 日新高', exit: '出场:跌破 M 日低点' } },
  { key: 'custom', label: '自定义(多条件)', desc: '自己搭条件:全部入场条件同时满足时买入,全部出场条件同时满足时卖出。', params: {}, param_labels: {} }];
const result = await mock.runBacktest();
const sweep = await mock.sweepBacktest();
const base = { strategies, strategyKey: 'sma_cross', params: { fast: 10, slow: 50 }, start: '2025-09-08', end: '2026-09-08' };

const pages = [];
async function page(name, seed = {}) {
  globalThis.__ssrSeed = { ...base, ...seed };
  const html = ui.renderBacktestPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed: { ...base, ...seed }, texts: texts(html), buttons: buttons(html), inputs: inputs(html), selects: selects(html), segments: segments(html),
    flow: flow(html), tiles: tiles(html), cards: cards(html), tones: tones(html), pager: pager(html) });
}

const customRules = { entry: [{ left: { kind: 'indicator', name: 'rsi', period: 14 }, op: '<', right: { kind: 'const', value: 30 } },
  { left: { kind: 'indicator', name: 'close', period: null }, op: 'cross_up', right: { kind: 'indicator', name: 'sma', period: 200 } }],
  exit: [{ left: { kind: 'indicator', name: 'change_pct', period: 5 }, op: '>=', right: { kind: 'const', value: 8.5 } }] };
const optionResult = { ...clone(result), instrument: { type: 'butterfly', dte: 45, offset_pct: 2, width_pct: 3, risk_pct: 5 },
  trade_list: clone(result.trade_list || []).map((t, i) => ({ ...t, strikes: i === 0 ? [180, 185, 190] : [] })) };
const longSweep = { ...clone(sweep), rows: Array.from({ length: 23 }, (_, i) => ({ ...clone(sweep.rows[i % sweep.rows.length]), params: { fast: 5 + i, slow: 50 }, oos_rank: i + 1 })), ranked: 23, combos: 25,
  skipped: [{ params: { fast: 60, slow: 50 }, reason: '快线不短于慢线' }, { params: { fast: 70, slow: 50 }, reason: '快线不短于慢线' }] };

await page('刚进页(目录还没回来)', { strategies: [], strategyKey: '', params: {} });
await page('均线交叉');
await page('RSI、标的与成本、一项参数清空', { strategyKey: 'rsi', params: { period: 14, buy_below: null, sell_above: 70 }, symbol: 'nvda', cost: 0.1 });
await page('买入持有(没有参数、流程图持有到底、不能扫)', { strategyKey: 'buy_hold', params: {} });
await page('N 日突破', { strategyKey: 'breakout', params: { entry: 20, exit: 10 } });
await page('自定义:默认条件', { strategyKey: 'custom', params: {} });
await page('自定义:三条条件、出场留空、一句话生成着', { strategyKey: 'custom', params: {}, rules: { entry: customRules.entry, exit: [] }, ruleText: 'RSI 跌破 30 且站上 200 日均线买入', generating: true });
await page('自定义:各种算子', { strategyKey: 'custom', params: {}, rules: customRules });
await page('期权:蝴蝶', { instType: 'butterfly', inst: { dte: 45, offset: 2, width: 3, risk: 5 } });
await page('期权:看涨、空着的格子', { instType: 'call', inst: { dte: null, offset: null, width: 2, risk: null }, cost: null });
await page('跑着', { symbol: 'NVDA', running: true });
await page('跑失败', { symbol: 'NVDA', failure: '拉不到 NVDA 的日线:没连券商' });
await page('结果', { symbol: 'NVDA', result });
await page('结果:扣了成本、没有已平仓', { symbol: 'NVDA', result: { ...clone(result), cost_pct: 0.1, closed_trades: 0, win_rate_pct: null, avg_win_pct: null, avg_loss_pct: null, payoff_ratio: null, profit_factor: null, expectancy_pct: null, sharpe: null, sortino: null, volatility_pct: null } });
await page('结果:期权蝴蝶、带行权价', { symbol: 'NVDA', instType: 'butterfly', inst: { dte: 45, offset: 2, width: 3, risk: 5 }, result: optionResult });
await page('结果:自定义条件、出场留空、超额为负', { symbol: 'NVDA', strategyKey: 'custom', params: {}, result: { ...clone(result), strategy: 'custom', rules: { entry: customRules.entry, exit: [] }, excess_return_pct: -4.04 } });
await page('结果:买入持有(不列明细)', { symbol: 'NVDA', strategyKey: 'buy_hold', params: {}, result: { ...clone(result), strategy: 'buy_hold' } });
await page('扫参数:改了网格与几只', { symbol: 'NVDA', swExtra: 'msft, amzn', swGrid: { fast: '5, 10 20' }, swSplit: 80, swFolds: 0, swObjective: 'calmar' });
await page('扫参数:跑着 / 失败', { symbol: 'NVDA', swRunning: true, swFailure: '扫描失败的原因' });
await page('扫参数:结果', { symbol: 'NVDA', swResult: sweep });
await page('扫参数:结果翻页、跳过的组、名次相关为负', { symbol: 'NVDA', swResult: { ...longSweep, rank_corr: -0.21, rank_corr_p: 0.0004, pick_p: 0.4321, walk_forward: null } });
await page('扫参数:没填标的', { symbol: '  ' });
await page('结果:超额正好 0', { symbol: 'NVDA', result: { ...clone(result), excess_return_pct: 0 } });
await page('扫参数:相关为正、挑出来的不如中位数(亮黄)、p 正好 0.001', { symbol: 'NVDA', swResult: { ...clone(sweep), rank_corr: 0.3, rank_corr_p: 0.001,
  best: { ...clone(sweep.best), oos: { ...clone(sweep.best.oos), return_pct: 1 } }, oos_median_return_pct: 2 } });
await page('扫参数:相关为正、挑出来的不比中位数差(不亮黄)', { symbol: 'NVDA', swResult: { ...clone(sweep), rank_corr: 0.5, rank_corr_p: 0.0123,
  best: { ...clone(sweep.best), oos: { ...clone(sweep.best.oos), return_pct: 30 } }, oos_median_return_pct: 2 } });
await page('扫参数:七页(全列出来)', { symbol: 'NVDA', swResult: { ...longSweep, rows: Array.from({ length: 65 }, (_, i) => ({ ...clone(sweep.rows[i % sweep.rows.length]), params: { fast: 1 + i, slow: 200 }, oos_rank: i + 1 })), ranked: 65 } });
await page('扫参数:十二页', { symbol: 'NVDA', swResult: { ...longSweep, rows: Array.from({ length: 115 }, (_, i) => ({ ...clone(sweep.rows[i % sweep.rows.length]), params: { fast: 1 + i, slow: 200 }, oos_rank: i + 1 })), ranked: 115 } });

// 净值曲线那张图:照原文切出 BacktestResult 里 useMemo 的那个函数(去掉类型标注)跑
const src = readFileSync(join(repo, 'desktop/renderer-react/src/lib/BacktestResult.tsx'), 'utf8');
const start = src.indexOf('const chart = useMemo(');
const body0 = src.indexOf('{', src.indexOf('=>', start));
const end = src.indexOf('}, [curve, trades, viewKey]);', body0);
if (start < 0 || end < 0) throw new Error('BacktestResult.tsx 里找不到 chart 的 useMemo');
const { stripTypeScriptTypes } = await import('node:module');
const fnSrc = stripTypeScriptTypes(`function chart(curve, trades, viewKey) ${src.slice(body0, end + 1)}`);
const chart = new Function(`${fnSrc}; return chart;`)();
const viewKey = (r) => `${r.symbol}|${r.strategy}|${r.instrument?.type ?? 'stock'}|${r.start}|${r.end}`;
const chartCases = [{ ...clone(result), symbol: 'NVDA' }, { ...clone(result), symbol: 'NVDA', curve: (result.curve || []).slice(0, 1) }, { ...clone(optionResult), symbol: 'NVDA' },
  { ...clone(result), symbol: 'NVDA', trade_list: [...clone(result.trade_list || []), { entry_date: '1999-01-01', exit_date: null, entry_price: 1, exit_price: null, return_pct: 0 }] }]
  .map((r) => ({ input: r, chart: chart(r.curve || [], r.trade_list || [], viewKey(r)) }));
writeFileSync(join(here, 'backtest.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_backtest.mjs', now: NOW, pages, charts: chartCases }, null, 1) + '\n');
console.log(`backtest.json: ${pages.length} 个页面场景`);
