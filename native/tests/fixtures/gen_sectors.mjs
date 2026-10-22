// 生成 sectors.json:「板块」(desktop/renderer-react/src/pages/Sectors.tsx 与它用到的 lib/PoolStock、MonitorLine、Conditions、TouchConfig、
// CrossConfirm、AlertMethods、anomalyFormat、StepPicker、LevelStrip)。
//   SSR 把原页面渲染出来抽字。板块与行情、价位、异动照各自 store 的读法灌(window.dafri 回场景的那一份);
//   选股着的板块、拨着开关的那一行、正在改标签的那一只由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值。
//   每个场景记下此刻各份 store 的快照:C++ 那边拿同样的输入。时钟钉在 2026-08-21 21:50(本机 Asia/Shanghai)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_sectors.mjs <装好依赖的 desktop 目录>
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

const NOW = Date.UTC(2026, 7, 21, 13, 50, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

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
let overrides = {};
const store = {};
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => overrides[name] ?? mock[name] ?? (async () => ({})) }),
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
globalThis.document = { hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {} } };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** 开关:(aria-label, 开没开, 转圈) */
const switches = (html) => [...html.matchAll(/<button([^>]*role="switch"[^>]*)>/g)].map((m) => ({
  label: decode(/aria-label="([^"]*)"/.exec(m[1])?.[1] ?? ''), checked: /aria-checked="true"/.test(m[1]), loading: /ant-switch-loading/.test(m[1]) }));
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), loading: /ant-btn-loading/.test(m[1]), disabled: /\sdisabled=""/.test(m[1]) }))
  .filter((b) => b.text);
/** 状态点(Badge):success / warning / error / default */
const badges = (html) => [...html.matchAll(/ant-badge-status-(success|warning|error|default|processing)/g)].map((m) => m[1]);
/** 着色的类:行里的数(pos / neg / hot / soft)、异动点(q-dot up / down / info) */
const classes = (html) => [...html.matchAll(/class="(num[^"]*|q-dot [^"]*)"/g)].map((m) => m[1]);
/** 每一行的数据属性(data-symbol)与 focus */
const rows = (html) => [...html.matchAll(/<div class="stock-block([^"]*)" data-symbol="([^"]*)"/g)].map((m) => ({ symbol: decode(m[2]), focus: /\bfocus\b/.test(m[1]) }));
const bars = (html) => [...html.matchAll(/<span class="(delta-bar|meter-bar)[^"]*" style="([^"]*)"[^>]*>(?:<i ([^>]*)>)?/g)].map((m) => ({ kind: m[1], style: decode(m[2]), inner: m[3] ? decode(m[3]) : null }));

// ---- 数据 ------------------------------------------------------------------------------------
const baseSectors = (await mock.listSectors()).sectors;
const baseQuotes = await mock.sectorQuotes();
const baseQuality = await mock.listQuality();
const baseAlerts = await mock.listAlerts();
const clone = (o) => JSON.parse(JSON.stringify(o));
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const touch = { enabled: true, periods: [20, 60, 120, 200], window_days: 10, min_touches: 3, band_pct: 0.3 };

const pages = [];
async function page(name, { sectors = baseSectors, quotes = baseQuotes, quality = baseQuality, alerts = baseAlerts, status = { broker_connected: true }, seed = {}, local = {}, focus = null } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, local);
  overrides = {
    refreshAlert: overrides.refreshAlert,
    listSectors: async () => ({ sectors: clone(sectors) }),
    sectorQuotes: async () => clone(quotes),
    listQuality: quality instanceof Error ? async () => { throw quality; } : async () => clone(quality),
    listAlerts: async () => clone(alerts),
  };
  await ui.seedStatus({ ...(await mock.status()), ...status });
  await ui.seedSectors();
  globalThis.__ssrSeed = seed;
  if (focus) globalThis.__navFocus = focus;
  const html = ui.renderSectorsPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, seed, snapshot: JSON.parse(JSON.stringify(ui.sectorsSnapshot())), texts: texts(html), switches: switches(html), buttons: buttons(html), badges: badges(html),
    classes: classes(html), rows: rows(html), bars: bars(html) });
}

await page('预览台的数据');
await page('没有板块', { sectors: [], quality: { ...baseQuality, stocks: [] }, alerts: { watches: [], cross_confirm: 'immediate' } });
// 心跳一行的各种样子
const mon = (m) => ({ ...baseQuality, monitor: { ...baseQuality.monitor, last_at: at(0.05), ...m } });
await page('监控:等第一轮', { quality: { ...baseQuality, monitor: null } });
await page('监控:没连券商', { status: { broker_connected: false }, quality: mon({ connected: false, note: '' }) });
await page('监控:没连券商(富途)', { status: { broker_connected: false, broker_provider: 'futu' }, quality: mon({ connected: false, note: '未连接富途 OpenD' }) });
await page('监控:不支持', { quality: mon({ supported: false, note: '' }) });
await page('监控:没在跑', { quality: mon({ running: false }) });
await page('监控:这一轮报错', { quality: mon({ last_error: 'reqMktData 超时' }) });
await page('监控:停了 40 秒', { quality: mon({ last_at: at(40 / 60) }) });
await page('监控:没有开着异动的', { quality: { ...mon({}), stocks: baseQuality.stocks.map((s) => ({ ...s, enabled: 0 })) } });
await page('监控:盘前', { quality: mon({ session: 'pre', note: '盘前:开盘后开始检测' }) });
await page('监控:盘中带提醒', { quality: mon({ note: '延迟行情:提醒晚约 15 分钟', interval_ms: 7500 }) });
await page('读不到异动列表', { quality: new Error('quality.list 超时') });
// 行与价位条的各种样子
const rich = [
  { id: 's1', name: 'AI 算力', updated_at: at(30), stocks: [
    { symbol: 'NVDA', company: '英伟达', reason: '龙头', tag: '芯片' },
    { symbol: 'RKLB', company: 'Rocket Lab', reason: '手动添加', tag: '' },
    { symbol: 'UBER', company: '', reason: '出行平台', tag: '出行' },
    { symbol: 'IREN', company: 'Iris', reason: '矿企转 AI' },
    { symbol: 'AAPL', company: '苹果', reason: '手动添加' },
    { symbol: 'XYZ', company: '', reason: '' },
  ] },
  { id: 's2', name: '空板块', stocks: [], updated_at: null },
];
const richQuality = clone(baseQuality);
richQuality.monitor.last_at = at(0.05);
richQuality.stocks.find((s) => s.symbol === 'NVDA').levels_status = 'error:没有期权行情权限';
richQuality.stocks.push({ id: 'q9', symbol: 'XYZ', enabled: 1, events: [], metrics: null, quote_error: '没有这个代码' });
const richAlerts = clone(baseAlerts);
richAlerts.touch_config = touch;
richAlerts.watches.find((w) => w.symbol === 'NVDA').touch = { lines: [{ period: 20, episodes: [{ start: '2026-08-12', end: '2026-08-13' }, { start: '2026-08-18', end: '2026-08-18' }] },
  { period: 60, episodes: [{ start: '2026-08-14', end: '2026-08-14' }] }] };
richAlerts.watches.find((w) => w.symbol === 'NVDA').wall.spot_source = 'parity';
richAlerts.watches.push({ id: 'w9', symbol: 'RKLB', step: 0, enabled: 1, levels: [], last_price: null, wall: null, events: [{ at: NOW / 1000 - 300, text: '上穿 58(整数关口)', price: 58, direction: 'up' }] });
richAlerts.watches.push({ id: 'w10', symbol: 'UBER', step: 2.5, enabled: 1, levels: [], last_price: null, wall: null, expiry: '2026-08-28' });
await page('各种行', { sectors: rich, quality: richQuality, alerts: richAlerts });
await page('各种行:选股着、拨着开关、改标签', { sectors: rich, quality: richQuality, alerts: richAlerts, seed: { picking: ['s1'], busy: { NVDA: 'price', RKLB: 'anomaly' }, editingTag: 'UBER' } });
await page('触发条件:扣大盘但读不到', { quality: { ...mon({ market_ref: false }), config: { ...baseQuality.config, market_adjust: true } } });
await page('触发条件:还没读到', { quality: { ...mon({}), config: null } });
await page('碰均线:关着', { alerts: { ...baseAlerts, touch_config: { ...touch, enabled: false, periods: [5, 250] } } });
await page('碰均线:还没读到', { alerts: { ...baseAlerts, touch_config: null } });
await page('穿越要收盘确认', { alerts: { ...baseAlerts, cross_confirm: 'bar_close' } });
// 最后两场改了本地偏好(弹窗、提示音):放最后,不影响前面
ui.setPopupEnabled(false);
ui.setSoundEnabled(false);
await page('弹窗与提示音都关了');
// 价位在算:refreshAlert 挂起不回(store/alerts 的 busy 一直留着,所以放最后)
overrides.refreshAlert = () => new Promise(() => {});
void ui.refreshWatch('w2');
void ui.refreshWatch('w10');
await new Promise((r) => setTimeout(r, 0));
await page('价位在算(重算墙)', { sectors: rich, quality: richQuality, alerts: richAlerts });

writeFileSync(join(here, 'sectors.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_sectors.mjs', now: NOW, pages }, null, 1) + '\n');
console.log(`sectors.json: ${pages.length} 个页面场景`);
