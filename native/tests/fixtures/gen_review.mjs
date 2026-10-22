// 生成 review.json:「交易分析」(desktop/renderer-react/src/pages/Review.tsx + lib/ReviewResult.tsx、reviewCharts.tsx)。
//   · pages:SSR 把原页面渲染出来抽字。候选、附带本地、新鲜度、有没有连 TWS、结果、报错、读着由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值;
//     选中的那一笔、周期、EM、类型读 localStorage(dafri-review-record / -timeframe / -em-manual / -kind)。效果在 SSR 里不跑:
//     读候选、筛选之后退到第一笔这两步由种子给(选中的那一笔总在列表里)。
//     数据底子是预览台的 mock(两张蝶、一笔股票的候选;一张蝶、一笔股票的复盘结果),外加改出来的边角(各种候选的写法、结果的各种形态)。
//   · charts:三张图的 spec(reviewCharts.tsx 里 useMemo 拼的,照原文切出来跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_review.mjs <装好依赖的 desktop 目录>
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

const NOW = Date.UTC(2026, 7, 12, 15, 0, 0);  // 北京时间 08-12 23:00:同一天的只写钟点
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
const inputs = (html) => [...html.matchAll(/<input([^>]*)>/g)].map((m) => ({
  value: decode(/\svalue="([^"]*)"/.exec(m[1])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[1])?.[1] ?? ''), disabled: /\sdisabled=""/.test(m[1]) }));
const selects = (html) => [...html.matchAll(/<span class="ant-select-selection-(item|placeholder)"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ kind: m[1], text: texts(m[2]).join('') }));
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
const switches = (html) => [...html.matchAll(/<button[^>]*role="switch"[^>]*aria-checked="(true|false)"/g)].map((m) => m[1] === 'true');
const cards = (html) => [...html.matchAll(/class="ant-card[^"]*status-card tone-(\w+)/g)].map((m) => m[1]);
const tiles = (html) => [...html.matchAll(/<div class="stat-tile([^"]*)"/g)].map((m) => m[1].trim());
/** 着色的数:.num pos / neg(signed) */
const nums = (html) => [...html.matchAll(/<span class="(num(?: pos| neg)?)">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], text: decode(m[2]) }));
const chartTitles = (html) => [...html.matchAll(/aria-label="([^"]*走势)"/g)].map((m) => m[1]);

// ---- 数据 ------------------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const cand = await mock.reviewCandidates();
const fly = await mock.reviewAnalyze({ id: 'demo-fly' });
const stock = await mock.reviewAnalyze({ id: 'stk:p9001' });
const list = cand.candidates;
const fresh = `本次新增 ${cand.synced} 笔成交 · 库内成交 ${cand.fills_stored} 笔`;
// 候选的各种写法:蝶(IBKR 成交、本地、带平仓、最终状态、限价估算)、股票(平仓、持仓中、减过仓、建仓更早、期初未核对)
const flyBase = clone(list[0]);
const stkBase = clone(list[2]);
const variants = [
  { ...flyBase, id: 'v1', exit: { time: '2026-08-12T15:10:00+00:00', price: 3.45, pnl: 170 } },
  { ...flyBase, id: 'v2', exit: { time: '2026-08-11T15:10:00+00:00', price: null, pnl: -40.5 }, account: null, price: null },
  { ...flyBase, id: 'v3', source: 'local', filled: false, final_status: 'cancelled', price: 2.4, price_estimated: true },
  { ...flyBase, id: 'v4', source: 'local', filled: false, final_status: null, status: null, price: null },
  { ...flyBase, id: 'v5', source: 'local', filled: true, final_status: null },
  { ...flyBase, id: 'v6', source: 'local', filled: false, final_status: 'weird_state' },
  { ...stkBase, id: 'v7', status: 'open', open_qty: 100, exit_qty: 50, avg_exit: 66.1, pnl: null },
  { ...stkBase, id: 'v8', status: 'open', open_qty: 150, exit_qty: 0, account: null, opening_assumed: true },
  { ...stkBase, id: 'v9', carried: true, entry_qty: 0, exit_qty: 80, avg_exit: null, side: 'LONG' },
  { ...stkBase, id: 'v10', carried: true, entry_qty: 0, exit_qty: 30, avg_exit: 12.5, side: 'SHORT', opening_assumed: true },
  { ...stkBase, id: 'v11', side: 'SHORT', pnl: -12.3, avg_exit: null, closed_at: '2026-08-11T17:20:00+00:00' },
  { ...stkBase, id: 'v12', pnl: 0 },
];

const pages = [];
async function page(name, { seed = {}, local = {} } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, local);
  globalThis.__ssrSeed = seed;
  const html = ui.renderReviewPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed, local, texts: texts(html), buttons: buttons(html), inputs: inputs(html), selects: selects(html), segments: segments(html),
    switches: switches(html), cards: cards(html), tiles: tiles(html), nums: nums(html), charts: chartTitles(html) });
}

const base = { candidates: list, available: true, freshness: fresh };
const sel = (id, extra = {}) => ({ 'dafri-review-record': id, ...extra });
await page('读着候选');
await page('没连 TWS、库里也没有', { seed: { available: false, freshness: '未连 TWS,只看本地累积的成交 · 库内成交 0 笔' } });
await page('连着、筛股票却没有', { seed: { available: true, candidates: list.filter((c) => c.kind !== 'stock') }, local: { 'dafri-review-kind': 'stock' } });
await page('连着、筛蝴蝶却没有', { seed: { available: true, candidates: [] }, local: { 'dafri-review-kind': 'butterfly' } });
await page('候选:默认选第一笔', { seed: base, local: sel('demo-fly') });
await page('候选:本地的那张、附带本地、1 小时、EM 40', { seed: { ...base, includeLocal: true }, local: sel('demo-fly-2', { 'dafri-review-timeframe': '1h', 'dafri-review-em-manual': '40' }) });
await page('候选:股票(EM 点不动)', { seed: base, local: sel('stk:p9001', { 'dafri-review-kind': 'stock', 'dafri-review-em-manual': '12.5' }) });
await page('候选:蝴蝶筛选', { seed: base, local: sel('demo-fly', { 'dafri-review-kind': 'butterfly', 'dafri-review-timeframe': '1d' }) });
for (const v of variants) await page(`候选写法:${v.id}`, { seed: { ...base, candidates: [...list, v] }, local: sel(v.id) });
await page('分析着', { seed: { ...base, loading: true }, local: sel('demo-fly') });
await page('分析失败', { seed: { ...base, error: '拉不到 K 线:没连 TWS' }, local: sel('demo-fly') });
await page('蝶:结果', { seed: { ...base, data: fly, freshness: '5 分钟 · 98 根 · 到期' }, local: sel('demo-fly') });
const flyOpen = { ...clone(fly), source: 'local', profile: { ...clone(fly.profile), price_estimated: true, debit: null },
  zone: { ...clone(fly.zone), known: false }, outcome: { ...clone(fly.outcome), kind: 'open', pnl: null, pnl_if_expired_now: 52.5, pnl_pct: null, price: null, time_et: null, record_id: 'r-9' },
  entry: { ...clone(fly.entry), estimated: true }, stats: { ...clone(fly.stats), closest: null, in_zone_bars: null, best_theoretical: null, best_market: { time: '2026-08-12 13:00', mid: 4.1, pnl: 235 }, dist_entry: -3, dist_exit: 0 },
  exit_plan: { ...clone(fly.exit_plan), simulation: { applicable: false, reason: '没有组合分钟线,也算不出模型价' }, actual_exit_mult: null },
  fly_series: { bars: [], source: 'model', markers: [] }, notes: ['K 线只拉到 15:55', '这张是本地记录'] };
await page('蝶:本地、持仓中、不能回放、没有蝶价', { seed: { ...base, data: flyOpen }, local: sel('demo-fly') });
const flyNoPlan = { ...clone(fly), exit_plan: null, fly_series: null, findings: [], outcome: { ...clone(fly.outcome), kind: 'closed', pnl: 0, pnl_pct: 0, price: 1.75 } };
await page('蝶:没有止盈策略、平仓不赚不亏', { seed: { ...base, data: flyNoPlan }, local: sel('demo-fly') });
const flyNoEvents = { ...clone(fly), exit_plan: { ...clone(fly.exit_plan), phases: {}, simulation: { ...clone(fly.exit_plan.simulation), events: [], totals: { strategy: null, actual: null, hold_to_settle: 0, best_mid: null, best_mid_pnl: null, profit_peak: 2.5 } } },
  outcome: { ...clone(fly.outcome), kind: 'closed', price: 3.45 } };
await page('蝶:策略没出手、浮盈高水位', { seed: { ...base, data: flyNoEvents }, local: sel('demo-fly') });
await page('股票:结果', { seed: { ...base, data: stock }, local: sel('stk:p9001') });
const stockOpen = { ...clone(stock), profile: { ...clone(stock.profile), side: 'SHORT', side_label: '做空', avg_entry: null, avg_exit: null, entries: [], exits: [] },
  outcome: { ...clone(stock.outcome), kind: 'open', underlying: 66.2, pnl: -50, pnl_pct: -0.5, realized_pnl: 10, unrealized_pnl: null, commission: 0, time_et: null },
  stats: { ...clone(stock.stats), mfe: null, mae: { ...clone(stock.stats.mae), pct: null }, capture_pct: null, entry_position: null, exit_position: null, hold_low: null }, account: null, notes: ['建仓早于已同步的成交'] };
await page('股票:做空、持仓中、建仓更早', { seed: { ...base, data: stockOpen }, local: sel('stk:p9001') });

// 三张图:照原文切出 reviewCharts.tsx 里三个 useMemo 的函数(去掉类型标注)跑
const src = readFileSync(join(repo, 'desktop/renderer-react/src/lib/reviewCharts.tsx'), 'utf8');
const labelsSrc = readFileSync(join(repo, 'desktop/renderer-react/src/lib/labels.ts'), 'utf8');
const { stripTypeScriptTypes } = await import('node:module');
const PHASE_LABEL = new Function(`${stripTypeScriptTypes(labelsSrc.slice(labelsSrc.indexOf('export const PHASE_LABEL'), labelsSrc.indexOf('};', labelsSrc.indexOf('export const PHASE_LABEL')) + 2)).replace('export ', '')}; return PHASE_LABEL;`)();
function cut(component, deps) {
  const startC = src.indexOf(`export function ${component}`);
  const start = src.indexOf('useMemo(', startC);
  const body0 = src.indexOf('{', src.indexOf('=>', start));
  const end = src.indexOf(`}, [${deps}]);`, body0);
  if (startC < 0 || start < 0 || end < 0) throw new Error(`reviewCharts.tsx 里找不到 ${component} 的 useMemo`);
  return new Function('PHASE_LABEL', `return function (r, fs) ${stripTypeScriptTypes(`function f() ${src.slice(body0, end + 1)}`).replace(/^function f\(\) /, '')}`)(PHASE_LABEL);
}
const stockChart = cut('StockChart', 'r');
const underlyingChart = cut('UnderlyingChart', 'r');
const flyChart = cut('FlyChart', 'r, fs');
const charts = [
  ...[stock, stockOpen, { ...clone(stock), series: { ...clone(stock.series), bars: stock.series.bars.slice(0, 1) } }].map((r) => ({ kind: 'stock', input: r, chart: stockChart(r) })),
  ...[fly, flyOpen, flyNoPlan, { ...clone(fly), series: { ...clone(fly.series), levels: fly.series.levels.filter((l) => l.kind !== 'upper_be') } }].map((r) => ({ kind: 'underlying', input: r, chart: underlyingChart(r) })),
  ...[fly, flyOpen, flyNoEvents].map((r) => ({ kind: 'fly', input: r, chart: flyChart(r, r.fly_series) })),
];
writeFileSync(join(here, 'review.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_review.mjs', now: NOW, pages, charts }, null, 1) + '\n');
console.log(`review.json: ${pages.length} 个页面场景、${charts.length} 张图`);
