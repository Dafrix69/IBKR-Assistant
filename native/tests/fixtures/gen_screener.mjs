// 生成 screener.json:「扫描」(desktop/renderer-react/src/pages/Screener.tsx + lib/screenerRows.ts、ScanTable.tsx、DeviationSection.tsx、LeadersSection.tsx)。
//   · pages:SSR 把原页面渲染出来抽字。板块读 store/sectors(window.dafri.listSectors);扫描的选项与结果、排序、极值偏离、强势股
//     由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值;选中的股票池读 localStorage(dafri-screener-sector)。
//     数据底子是预览台的 mock(RS 五只、背离四只、强势股八只、偏离 120 根),外加改出来的边角。
//   · charts:极值偏离那两张图的 spec(DeviationSection 里 useMemo 拼的,照原文切出来跑)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_screener.mjs <装好依赖的 desktop 目录>
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
let sectors = null;
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => (name === 'listSectors' ? async () => ({ sectors }) : mock[name] ?? (async () => ({}))) }),
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
/** 表里的行:data-row-key 与 class(row-open / dim) */
const rows = (html) => [...html.matchAll(/<tr[^>]*class="([^"]*)"[^>]*data-row-key="([^"]*)"/g)].map((m) => ({ key: decode(m[2]), open: /row-open/.test(m[1]), dim: /\bdim\b/.test(m[1]) }));
/** RS 格:class(pos / neg / dim)、--heat、悬停提示 */
const rsCells = (html) => [...html.matchAll(/<td[^>]*class="([^"]*rs-cell[^"]*)"([^>]*)>/g)].map((m) => ({
  cls: m[1].replace(/ant-table-cell\S*/g, '').replace(/\s+/g, ' ').trim(), heat: /--heat:(\d+)/.exec(m[2])?.[1] ?? null, title: decode(/title="([^"]*)"/.exec(m[2])?.[1] ?? '') }));
/** 信号胶囊:class 与悬停 */
const sigs = (html) => [...html.matchAll(/<span class="(sig [^"]*)"(?: title="([^"]*)")?/g)].map((m) => ({ cls: m[1], title: decode(m[2] ?? '') }));
const sortOrders = (html) => [...html.matchAll(/<th[^>]*aria-sort="(ascending|descending)"/g)].map((m) => m[1]);
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
const tfChecked = (html) => [...html.matchAll(/class="ant-tag ant-tag-checkable([^"]*)"/g)].map((m) => /checked/.test(m[1]));
const dots = (html) => [...html.matchAll(/<i class="(ok|no|na)"><\/i>/g)].map((m) => m[1]);
const bars = (html) => [...html.matchAll(/<b class="(pos|neg)" style="height:([\d.]+)%"/g)].map((m) => ({ cls: m[1], h: Number(m[2]) }));
const selects = (html) => [...html.matchAll(/<span class="ant-select-selection-(item|placeholder)"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ kind: m[1], text: texts(m[2]).join('') }));

// ---- 数据 ------------------------------------------------------------------------------------
const baseSectors = [
  { id: 's1', name: 'AI 算力', stocks: [{ symbol: 'NVDA', company: '英伟达' }, { symbol: 'AVGO', company: '博通' }, { symbol: 'AMD', company: '超威' }] },
  { id: 's2', name: '核电', stocks: [{ symbol: 'CEG', company: '星座能源' }, { symbol: 'VST', company: '' }, { symbol: 'NVDA', company: '英伟达' }] },
];
const rs = await mock.screenerRs();
const infl = await mock.screenerInflection();
const leaders = await mock.screenerLeaders();
const dev = await mock.screenerDeviation({ symbol: 'NVDA', timeframe: '1d' });
const clone = (o) => JSON.parse(JSON.stringify(o));

const pages = [];
async function page(name, { seed = {}, local = {}, list = baseSectors } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, local);
  sectors = clone(list);
  await ui.loadSectors();
  globalThis.__ssrSeed = seed;
  const html = ui.renderScreenerPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed, local, sectors: list, texts: texts(html), buttons: buttons(html), rows: rows(html), rsCells: rsCells(html), sigs: sigs(html), sortOrders: sortOrders(html),
    segments: segments(html), tfChecked: tfChecked(html), dots: dots(html), bars: bars(html), selects: selects(html) });
}

await page('没扫过');
await page('扫着', { seed: { scanBusy: true, progress: '正在拉日线算 RS…(一个 30 只的板块约 10~30 秒)' } });
await page('RS 加背离', { seed: { rs, infl, devSymbol: 'NVDA', dev, devStatus: '日线 · 290 根 · 09-08 22:00' } });
await page('只有 RS', { seed: { rs, timeframes: [] } });
await page('背离还没回来', { seed: { rs, infl: { pending: true, timeframes: ['1w', '1d'] }, scanBusy: true, progress: '正在找背离…' } });
await page('只有背离', { seed: { infl } });
await page('按 1 月升序', { seed: { rs, infl, sort: { key: 'w20', order: 'ascend' } } });
await page('按综合降序', { seed: { rs, infl, sort: { key: 'score', order: 'descend' } } });
await page('按命中降序', { seed: { rs, infl, sort: { key: 'hits', order: 'descend' } } });
await page('标签都没分', { seed: { rs: { ...clone(rs), tags: [{ tag: '未分类', count: 5, score: 1, symbols: ['NVDA'], rs: {} }] } } });
await page('选了核电、QQQ、四个周期、MA 0', { seed: { benchmark: 'QQQ', timeframes: ['1h', '1w', '15m', '1d'], ma: 0 }, local: { 'dafri-screener-sector': 's2' } });
await page('记着的板块已经删了', { local: { 'dafri-screener-sector': 'gone' } });
await page('偏离:读着', { seed: { devSymbol: 'AMD', devBusy: true, devStatus: '正在拉 AMD 的 K 线…' } });
await page('偏离:数据不够', { seed: { devSymbol: 'VST', dev: { ...clone(dev), symbol: 'VST', last: null, readout: ['只有 12 根 K 线,', '算不出 20 周期均线。'] } } });
await page('偏离:超卖、没有本段', { seed: { devSymbol: 'ZZZ', devFree: 'zzz', dev: { ...clone(dev), symbol: 'ZZZ', extreme: 'oversold', extreme_label: '下方极值(超卖)', window: null,
  last: { ...dev.last, z: -2.4, dev_pct: -6.2, pressure: 0.5, rank_pct: null, volume_ratio: null } }, devStatus: '日线 · 290 根 · 09-08 22:00' } });
await page('偏离:不在极值', { seed: { devSymbol: 'AVGO', dev: { ...clone(dev), symbol: 'AVGO', extreme: null, extreme_label: '在常态区间', last: { ...dev.last, z: null, pressure: 0.1 } } } });
await page('股票池是空的', { list: [] });
await page('强势股:全部', { seed: { leaders } });
await page('强势股:8 条全过', { seed: { leaders, leadersFilter: 'stage2' } });
await page('强势股:有 VCP', { seed: { leaders, leadersFilter: 'vcp' } });
await page('强势股:这个筛选下没有', { seed: { leaders: { ...clone(leaders), rows: clone(leaders.rows).map((r) => ({ ...r, stage2: false })) }, leadersFilter: 'stage2' } });
await page('强势股:没筛成', { seed: { leadersError: '没连券商' } });
await page('强势股:筛着', { seed: { leadersBusy: true } });

// 极值偏离的两张图:照原文切出 DeviationSection 里 useMemo 的那个函数(去掉类型标注)跑
const devSrc = readFileSync(join(repo, 'desktop/renderer-react/src/lib/DeviationSection.tsx'), 'utf8');
const start = devSrc.indexOf('const charts = useMemo(');
const body0 = devSrc.indexOf('{', devSrc.indexOf('=>', start));
const end = devSrc.indexOf('}, [result]);', body0);
if (start < 0 || end < 0) throw new Error('DeviationSection.tsx 里找不到 charts 的 useMemo');
const { stripTypeScriptTypes } = await import('node:module');
const fnSrc = stripTypeScriptTypes(`function charts(result) ${devSrc.slice(body0, end + 1)}`);
const charts = new Function(`${fnSrc}; return charts;`)();
const chartCases = [dev, { ...clone(dev), last: null }, { ...clone(dev), symbol: 'AMD', timeframe: '1h', period: 30, lookback: 200, z_extreme: 2.5,
  series: clone(dev.series).map((p, i) => (i % 17 === 0 ? { ...p, buy_pct: null, z: null } : p)) }].map((r) => ({ input: r, charts: charts(r) }));
writeFileSync(join(here, 'screener.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_screener.mjs', now: NOW, pages, charts: chartCases }, null, 1) + '\n');
console.log(`screener.json: ${pages.length} 个页面场景`);
