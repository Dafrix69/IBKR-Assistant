// 生成 market.json:「行情」(desktop/renderer-react/src/pages/Market.tsx + lib/PaPanel.tsx + lib/PaVerdict.tsx + lib/BookWall.tsx + lib/marketBits.tsx)。
//   · pages:SSR 把原页面渲染出来抽字。K 线读盘的结果(pa.analyze 的回包)、AI 解读、读着 / 出错、周期表、盘口快照与读着的那几只
//     由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值(effect 在 SSR 里不跑);标的、周期、只看正常时段、关注的盘口、参考资料开没开
//     读 localStorage,按场景换。数据底子是预览台 mock 的那一份(NVDA 5 分钟、SPY 盘口),外加改出来的边角。
//   · specs:lib/chart/paSpec.ts 把同一份结果翻成的图(header 回调按每一根求出来)。
//   node native/tests/fixtures/gen_market.mjs <装好依赖的 desktop 目录>
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

const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

function loadMock() {
  const w = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window: w, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  w.window = w;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(repo, 'desktop/tools/mock-bridge.js'), 'utf8'), sandbox);
  return w.dafri;
}
const mock = loadMock();
let store = {};
const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => (name === 'status' ? async () => window.__status : mock[name] ?? (async () => ({}))) }),
  localStorage: storage,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = storage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** 输入框的值与占位、按钮能不能点、开关开没开、参考资料开没开(折叠面板展开的那几块) */
const inputs = (html) => [...html.matchAll(/<input[^>]*>/g)].map((m) => ({ id: /id="([^"]*)"/.exec(m[0])?.[1] ?? null, value: decode(/value="([^"]*)"/.exec(m[0])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[0])?.[1] ?? '') }))
  .filter((i) => i.id === 'pa-symbol' || i.id === 'book-symbol');
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), disabled: /\sdisabled=""/.test(m[1]), loading: /ant-btn-loading/.test(m[1]) }));
const switches = (html) => [...html.matchAll(/<button[^>]*role="switch"[^>]*aria-checked="(true|false)"/g)].map((m) => m[1] === 'true');
const primers = (html) => [...html.matchAll(/<div class="ant-collapse-item([^"]*)"/g)].map((m) => /ant-collapse-item-active/.test(m[1]));
const select = (html) => decode(/<span class="ant-select-selection-item"[^>]*title="([^"]*)"/.exec(html)?.[1] ?? '') || null;

await ui.seedStatus({ ...(await mock.status()), broker_connected: true });

// ---- 数据 ------------------------------------------------------------------------------------
const base = await mock.paAnalyze();
const tfs = (await mock.paTimeframes()).timeframes;
const book = await mock.orderBook();
const clone = (o) => JSON.parse(JSON.stringify(o));
const pa = (patch) => ({ ...clone(base), ...patch });
const comment = { summary: '区间里来回,等一端收盘突破', reading: '下降结构里出现了看涨扫单,但还没收回前高。', watch: ['124.476 上方收盘', '123.9787 失守'], risks: ['延迟行情下最后一根未必到齐'], model: 'claude-x' };
const bookL1 = { symbol: 'QQQ', l1: { bid: 512.1, ask: 512.3, bid_size: 0, ask_size: 3, last: null, spread: 0.2, spread_bps: 3.9 }, bids: [], asks: [], note: '无 Level 2 订阅:只有一档',
  liquidity: { spread_bps: 3.9, spread_grade: '', bid_depth: null, ask_depth: null, imbalance_pct: -42, l1_only: true } };
const bookBare = { symbol: 'TSLA', l1: { bid: null, ask: null, bid_size: null, ask_size: null, last: 301.5, spread: null, spread_bps: null }, bids: [{ price: 301.4, size: 7 }], asks: [], note: '',
  liquidity: { spread_bps: null, spread_grade: null, bid_depth: 7, ask_depth: 0, imbalance_pct: 100, l1_only: false } };
const spy = { ...clone(book) };
const nvdaBook = { ...clone(book), symbol: 'NVDA' };

// ---- 场景 ------------------------------------------------------------------------------------
const pages = [];
const specs = [];
async function page(name, { seed = {}, local = {} } = {}) {
  store = { ...local };
  globalThis.__ssrSeed = { timeframes: tfs, ...seed };
  const html = ui.renderMarketPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed: { ...seed, timeframes: undefined }, timeframes: seed.timeframes ?? tfs, local, texts: texts(html), inputs: inputs(html), buttons: buttons(html), switches: switches(html), primers: primers(html), select: select(html) });
}
const withBooks = { local: { 'dafri-book-symbols': JSON.stringify(['SPY', 'QQQ', 'TSLA', 'AMD']), 'dafri-pa-symbol': 'NVDA' },
  seed: { books: { SPY: spy, QQQ: bookL1, TSLA: bookBare, AMD: { error: '读取盘口失败:没有行情权限' }, NVDA: nvdaBook } } };

await page('空(没分析过)');
await page('读着', { seed: { paLoading: true }, local: { 'dafri-pa-symbol': 'NVDA' } });
await page('出错', { seed: { paError: 'K 线读取失败:没有行情权限' }, local: { 'dafri-pa-symbol': 'NVDA', 'dafri-pa-timeframe': '1h', 'dafri-pa-rth': '1' } });
await page('预览台的数据', { seed: { pa: base, books: { NVDA: nvdaBook } }, local: { 'dafri-pa-symbol': 'NVDA' } });
await page('预览台的数据 + 关注四只', { seed: { pa: base, ...withBooks.seed, bookLoading: ['TSLA'] }, local: withBooks.local });
await page('看的就在关注里', { seed: { pa: pa({ symbol: 'SPY' }), books: { SPY: spy } }, local: { 'dafri-book-symbols': '["SPY"]', 'dafri-pa-symbol': 'SPY' } });
await page('盘口读着(还没有快照)', { seed: { pa: base, bookLoading: ['NVDA'] }, local: { 'dafri-pa-symbol': 'NVDA' } });
await page('盘口没读过', { seed: { pa: base }, local: { 'dafri-pa-symbol': 'NVDA' } });
await page('分析着(已有上一份)', { seed: { pa: base, paLoading: true, books: { NVDA: nvdaBook } } });
await page('读数据未到齐(延迟)', { seed: { pa: pa({ forming: { ...base.forming, waiting: 'delayed', hints: [] } }) } });
await page('读数据未到齐(说不准)', { seed: { pa: pa({ forming: { ...base.forming, waiting: 'unknown', closes_at: '' } }) } });
await page('最后一根收了', { seed: { pa: pa({ forming: null, age_seconds: 20 }) } });
await page('只看正常时段 + 引擎缓存', { seed: { pa: pa({ rth: true, cached: true, age_seconds: null, extended_hours: false }) }, local: { 'dafri-pa-rth': '1' } });
await page('指数盘外按期货推算', { seed: { pa: pa({ symbol: 'SPX', off_hours: 'proxy', proxy: { futures: 'ES 202612', spans: [{ from: '2026-08-12 11:10', to: '2026-08-12 12:00' }] } }) } });
await page('指数推不出来', { seed: { pa: pa({ symbol: 'SPX', off_hours: 'none', proxy: null }) } });
await page('个股含夜盘', { seed: { pa: pa({ off_hours: 'stock', overnight: true }) } });
// 「刚刚」的门槛:四舍五入到分钟不到 1(29 秒是刚刚、30 秒已经是 1 分钟前、89 秒还是 1 分钟前)
await page('29 秒前', { seed: { pa: pa({ age_seconds: 29 }) } });
await page('30 秒前', { seed: { pa: pa({ age_seconds: 30 }) } });
await page('89 秒前', { seed: { pa: pa({ age_seconds: 89 }) } });
await page('个股不含夜盘', { seed: { pa: pa({ off_hours: 'stock', overnight: false, age_seconds: 3599 }) } });
await page('看涨 + 高周期同向', { seed: { pa: pa({ score: 46, bias: 'bullish', bias_label: '偏多', agreement: { state: 'aligned', text: '同向' }, htf: { ...base.htf, bias: 'bullish', last_event: '2026-08-13 BOS 上破', support: null, resistance: null, closed_bar: null } }) } });
await page('看跌 + 高周期相反', { seed: { pa: pa({ score: -58, bias: 'lean_bear', bias_label: '偏空', agreement: { state: 'conflict', text: '' }, htf: { ...base.htf, bias: 'lean_bear' } }) } });
await page('没有高周期', { seed: { pa: pa({ htf: null, agreement: null, warnings: [] }) } });
await page('没有子分(依据平铺)', { seed: { pa: pa({ sub_scores: [], score: 0, bias: 'weird' }) } });
await page('结构空', { seed: { pa: pa({ swings: [], events: [], levels: [], fvgs: [], order_block: null, sweeps: [], equal_levels: [], patterns: [], plan: { watch: [], confirm: '', invalidation: { why: '' }, atr_note: '' } }) } });
await page('依据里有 CHoCH 与观察点', { seed: { pa: pa({ events: base.events.slice(0, 2).concat([{ ...base.events[5] }]), order_block: { ...base.order_block, mitigated: true, side: 'bull' },
  patterns: base.patterns.map((p) => ({ ...p, bars_ago: 3 })), plan: { ...base.plan, watch: ['125.4464 等高上方', '跌回 123.9 以下'] } }) } });
await page('readout 拆不开的行', { seed: { pa: pa({ readout: ['首句:就算有冒号也留着', '没有冒号的一行', '一个特别特别特别长的字段名字:后面', '字段: 带空格的值 ', '全角:冒号'] }) } });
await page('AI 解读', { seed: { pa: base, comment } });
await page('AI 解读(空清单、没写模型)', { seed: { pa: base, comment: { summary: '只有一句', reading: '', watch: [], risks: [], model: '' } } });
await page('解读着', { seed: { pa: base, commenting: true } });
await page('解读着(已有一份)', { seed: { pa: base, comment, commenting: true } });
await page('周期表里没有存的那个', { seed: { pa: base }, local: { 'dafri-pa-timeframe': '3m' } });
await page('周期表没取到', { seed: { pa: base, timeframes: [] } });
await page('参考资料都展开', { seed: { pa: base }, local: { 'dafri-primer-intro-pa': '1', 'dafri-primer-pa-legend-primer': '1', 'dafri-book-symbols': '["SPY"]', 'dafri-primer-book-primer': '1' } });
await page('关注了还硬要展开读盘常识以外都收起', { seed: { pa: base }, local: { 'dafri-book-symbols': '[]', 'dafri-primer-book-primer': '0' } });
await page('关注表坏了', { local: { 'dafri-book-symbols': '{"x":1}' } });
await page('关注表里是数字', { local: { 'dafri-book-symbols': '[1, "spy"]' } });

for (const [name, r] of [['预览台', base], ['指数盘外按期货推算', pages.find((p) => p.name === '指数盘外按期货推算').seed.pa], ['只看正常时段', pages.find((p) => p.name === '只看正常时段 + 引擎缓存').seed.pa],
  ['结构空', pages.find((p) => p.name === '结构空').seed.pa], ['依据里有 CHoCH 与观察点', pages.find((p) => p.name === '依据里有 CHoCH 与观察点').seed.pa],
  ['没有均线', pa({ ma: {} })], ['一条均线是别的周期', pa({ ma: { 7: base.ma[5], 20: base.ma[20] } })], ['未到齐', pa({ forming: { ...base.forming, waiting: 'delayed' } })], ['空', null]]) {
  const s = ui.paSpec(r);
  const h = { fmt: (v) => Number(v).toFixed(2), col: (c) => c };
  const n = (r?.bars || []).length;
  specs.push({ name, input: r, spec: { ...s, header: undefined }, header: s.header ? Array.from({ length: n }, (_, i) => s.header(i, h)) : null });
}

writeFileSync(join(here, 'market.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_market.mjs', pages, specs }, null, 1) + '\n');
console.log(`market.json: ${pages.length} 个页面场景、${specs.length} 份图`);
