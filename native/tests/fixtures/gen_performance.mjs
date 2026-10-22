// 生成 performance.json:「绩效体检」(desktop/renderer-react/src/pages/Performance.tsx + lib/PerformanceParts.tsx、PerformanceExtras.tsx、
// SignalScorecard.tsx、PositionSizer.tsx、sizing.ts、ShareCard.tsx / shareCardDraw.ts 的副标题与页脚)。
//   · pages:SSR 把原页面渲染出来抽字。体检结果、报错、算着、保护规则建议在填的那一条、信号成绩单(结果 / 算着 / 报错)、仓位计算器的每份最大亏损
//     由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值;范围 / 品种 / 天数、权益与比例读 localStorage。
//     数据底子是预览台的 mock(40 笔账本、五条结论、两条建议、64 条信号),外加改出来的边角。
//   · charts:平仓权益曲线的 spec(EquitySection 里 useMemo 拼的,照原文切出来跑);
//   · sizing:sizePosition 的输入输出;share:分享卡片的副标题与页脚(cardSubtitle / cardFootnote)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_performance.mjs <装好依赖的 desktop 目录>
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
const inputs = (html) => [...html.matchAll(/<input([^>]*)>/g)].map((m) => ({
  value: decode(/\svalue="([^"]*)"/.exec(m[1])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[1])?.[1] ?? '') }))
  .filter((i) => i.value || i.placeholder);
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
const cards = (html) => [...html.matchAll(/class="ant-card[^"]*status-card tone-(\w+)/g)].map((m) => m[1]);
const tiles = (html) => [...html.matchAll(/<div class="stat-tile([^"]*)"/g)].map((m) => m[1].trim());
/** 着色的数(perf-num pos / neg)与它的悬停提示 */
const nums = (html) => [...html.matchAll(/<span class="(perf-num[^"]*)"(?: title="([^"]*)")?>([^<]*)<\/span>/g)].map((m) => ({ cls: m[1].trim(), title: decode(m[2] ?? ''), text: decode(m[3]) }));
/** 账本 R 一格的悬停提示(没着色的 span 带 title) */
const titles = (html) => [...html.matchAll(/<span title="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ title: decode(m[1]), text: decode(m[2]) }));
const counts = (html) => [...html.matchAll(/class="count-badge[^"]*">([^<]*)</g)].map((m) => m[1]);
const pager = (html) => [...html.matchAll(/<li[^>]*class="ant-pagination-item[^"]*"[^>]*>/g)].length;
const selects = (html) => [...html.matchAll(/<span class="ant-select-content-value"[^>]*>([^<]*)</g)].map((m) => decode(m[1]));

// ---- 数据 ------------------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const perf = await mock.reviewPerformance({ scope: 'all', kind: 'all' });
const signals = await mock.reviewSignals({});

const pages = [];
async function page(name, { seed = {}, local = {} } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, local);
  globalThis.__ssrSeed = seed;
  const html = ui.renderPerformancePage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed, local, texts: texts(html), buttons: buttons(html), inputs: inputs(html), segments: segments(html), cards: cards(html), tiles: tiles(html),
    nums: nums(html), titles: titles(html), counts: counts(html), pager: pager(html), selects: selects(html) });
}

await page('算着(还没有数)', { seed: { loading: true } });
await page('算不出来', { seed: { error: '引擎没起来' } });
await page('这个范围里没有交易', { seed: { data: { ...clone(perf), stats: { ...clone(perf.stats), trades: 0 }, mix: { live: 0, paper: 0 } } }, local: { 'dafri-perf-scope': 'paper', 'dafri-perf-kind': 'option', 'dafri-perf-days': '90' } });
await page('体检结果', { seed: { data: perf } });
await page('重新算着(还留着上一次)', { seed: { data: perf, loading: true }, local: { 'dafri-perf-scope': 'live', 'dafri-perf-kind': 'butterfly', 'dafri-perf-days': '30' } });
await page('建议在填、仓位计算器填了权益', { seed: { data: { ...clone(perf), mix: { live: 40, paper: 0 } }, adviceBusy: perf.protection_advice[0]?.rule }, local: { 'dafri-sizer-equity': '50000', 'dafri-sizer-pct': '1.5' } });
await page('仓位:比例过 2%、一份都做不起', { seed: { data: perf, sizerUnit: 99999 }, local: { 'dafri-sizer-equity': '20000', 'dafri-sizer-pct': '3' } });
await page('仓位:清空了每份最大亏损', { seed: { data: perf, sizerUnit: null }, local: { 'dafri-sizer-equity': 'abc', 'dafri-sizer-pct': '0' } });
// 边角:没有结论与建议、区间都定不出来、R 没盖住、眼下连赚、只有一类品种、凯利与 SQN 空、只算不出的执行损耗、账本翻页与排除的、持有按天、权益只一笔
const edge = clone(perf);
edge.findings = [];
edge.protection_advice = [];
edge.stats = { ...edge.stats, expectancy_ci: null, win_rate_ci: null, wins: 3, losses: 2, largest_loss: null, payoff_ratio: null };
edge.r_stats = { ...edge.r_stats, expectancy_ci: null, expectancy_r: null, kelly: null, sqn: null, payoff_ratio: null, trades: 0 };
edge.r_coverage = { trades: 12, with_r: 0, max_loss: 0, stop: 0, stop_window_minutes: 30, flats: 0, missing: [] };
edge.streak = { kind: 'win', count: 3 };
edge.groups = { ...edge.groups, kind: edge.groups.kind.slice(0, 1), session: [], weekday: [] };
edge.kelly = null;
edge.hold = { win_median_minutes: null, loss_median_minutes: 5 };
edge.recent = null;
edge.per_day = { days: 0, green_days: 0, worst_day: null };
edge.drawdown = { ...edge.drawdown, max: 0, recovery_factor: null };
edge.execution = { ...edge.execution, samples: 0, rows: [], by_sec_type: [], total_usd: null, avg_usd: null, commission_usd: null, paper: 0, missing: 3 };
edge.equity = edge.equity.slice(0, 1);
edge.trades = Array.from({ length: 45 }, (_, i) => ({ ...clone(perf.trades[i % perf.trades.length]), id: `t${i}`, hold_minutes: i === 0 ? 2880 : i === 1 ? null : perf.trades[i % perf.trades.length].hold_minutes,
  r: i === 2 ? null : perf.trades[i % perf.trades.length].r, r_missing: i === 2 ? 'late_stop' : perf.trades[i % perf.trades.length].r_missing }));
edge.excluded = { open: 2, unknown: 1, no_cost: 3 };
await page('边角', { seed: { data: edge } });
const edge2 = clone(perf);
edge2.stats = { ...edge2.stats, expectancy_ci: null, win_rate_ci: null, wins: 1, losses: 0 };
edge2.r_stats = { ...edge2.r_stats, expectancy_ci: null };
edge2.r_coverage = { trades: 0, with_r: 0, max_loss: 0, stop: 0, stop_window_minutes: 30, flats: 0, missing: [] };
edge2.streak = { kind: 'none', count: 0 };
edge2.execution = { ...edge2.execution, by_sec_type: (edge2.execution.by_sec_type || []).map((g, i) => ({ ...g, median_ci: i ? g.median_ci : null, median_pct: i === 1 ? 4.2 : g.median_pct })) };
await page('边角二:区间一个都没有、执行损耗亮黄', { seed: { data: edge2 } });
// 信号成绩单
await page('信号:算着', { seed: { data: perf, signalsLoading: true } });
await page('信号:算不出来', { seed: { data: perf, signalsError: '没连 TWS' } });
await page('信号:还没有记下的', { seed: { data: perf, signals: { ...clone(signals), total: 0, groups: [] } } });
await page('信号:成绩单', { seed: { data: perf, signals } });
await page('信号:取不到的、太早的、没基线的', { seed: { data: perf, signals: { ...clone(signals), missing_symbols: ['ZZZ', 'QQQ'], dropped: { uncovered: 3, no_baseline: 2 }, recent: [] } } });

// 平仓权益曲线:照原文切出 EquitySection 里 useMemo 的那个函数跑
const src = readFileSync(join(repo, 'desktop/renderer-react/src/lib/PerformanceParts.tsx'), 'utf8');
const start = src.indexOf('const chart = useMemo(');
const body0 = src.indexOf('{', src.indexOf('=>', start));
const end = src.indexOf('}, [r]);', body0);
if (start < 0 || end < 0) throw new Error('PerformanceParts.tsx 里找不到 chart 的 useMemo');
const { stripTypeScriptTypes } = await import('node:module');
const chart = new Function(`${stripTypeScriptTypes(`function chart(r) ${src.slice(body0, end + 1)}`)}; return chart;`)();
const charts = [perf, { ...clone(perf), days: 30, scope: 'live' }, { ...clone(perf), equity: perf.equity.slice(0, 1) }].map((r) => ({ input: r, chart: chart(r) ?? null }));

const sizing = [
  { equity: 50000, riskPct: 1, unitRisk: 175, losingStreak: 5 }, { equity: 50000, riskPct: 1.5, unitRisk: 175, losingStreak: 0 }, { equity: 20000, riskPct: 3, unitRisk: 99999, losingStreak: 9 },
  { equity: null, riskPct: 1, unitRisk: 175, losingStreak: 3 }, { equity: 1000, riskPct: 100, unitRisk: 1, losingStreak: 1 }, { equity: 1000, riskPct: 0.25, unitRisk: 2.5, losingStreak: 2.7 },
  { equity: 33333, riskPct: 0.3, unitRisk: 0.1, losingStreak: 1 },
].map((input) => ({ input, output: ui.sizePosition(input) }));
const share = [
  [perf, { scope: 'all', kind: 'all', days: 0 }], [{ ...clone(perf), mix: { live: 3, paper: 0 } }, { scope: 'all', kind: 'butterfly', days: 30 }],
  [{ ...clone(perf), mix: { live: 0, paper: 3 } }, { scope: 'all', kind: 'stock', days: 365 }], [perf, { scope: 'paper', kind: 'option', days: 90 }],
  [{ ...clone(perf), stats: { ...clone(perf.stats), trades: 12 } }, { scope: 'live', kind: 'all', days: 0 }],
].map(([r, o]) => ({ mix: r.mix, trades: r.stats.trades, options: o, subtitle: ui.cardSubtitle(r, o), footnote: ui.cardFootnote(r) }));
writeFileSync(join(here, 'performance.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_performance.mjs', now: NOW, pages, charts, sizing, share }, null, 1) + '\n');
console.log(`performance.json: ${pages.length} 个页面场景`);
