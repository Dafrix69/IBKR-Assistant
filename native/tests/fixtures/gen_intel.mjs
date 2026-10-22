// 生成 intel.json:「情报」(desktop/renderer-react/src/pages/Intel.tsx + lib/IntelTimeline.tsx)与全站共用的档案抽屉、⌘K 查标的
// (shell/DossierHost.tsx + lib/SymbolDossier.tsx)。
//   · pages:SSR 把情报页渲染出来抽字。时间线、种类、只看持仓、读着 / 读不到在 store/intel 里(场景直接设它的状态);关键字由 SEEDS 灌;
//   · dossiers:档案抽屉(NVDA 全有、SPX 指数价、TSLA 跌、没有时间线的、读着、读不到的);lookups:查标的(空着、敲了代码、敲了中文、有最近查过的)。
//   每个场景记下此刻 store/intel 的快照与券商连没连:C++ 那边拿同样的输入。时钟钉在 2026-10-15 22:30(本机 Asia/Shanghai),预览台的 mock 也用这只钟。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_intel.mjs <装好依赖的 desktop 目录>
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

const NOW = Date.UTC(2026, 9, 15, 14, 30, 0);
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
// 状态快照:seedStatus 把它放在 window.__status,这里回它
let overrides = { status: async () => JSON.parse(JSON.stringify(window.__status)) };
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
const intelApi = (globalThis.__zustandStores || []).find((s) => s.getState() && 'intel' in s.getState());
if (!intelApi) throw new Error('找不到 store/intel');
const setIntel = (part) => intelApi.setState((s) => ({ intel: { ...s.intel, ...part } }));
const flush = () => new Promise((r) => setTimeout(r, 0));

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: texts(m[2]).join(''), loading: /ant-btn-loading/.test(m[1]), disabled: /\sdisabled=""/.test(m[1]) }))
  .filter((b) => b.text);
const inputs = (html) => [...html.matchAll(/<input([^>]*)>/g)].map((m) => ({
  value: decode(/\svalue="([^"]*)"/.exec(m[1])?.[1] ?? ''), placeholder: decode(/placeholder="([^"]*)"/.exec(m[1])?.[1] ?? '') }))
  .filter((i) => i.value || i.placeholder);
const warnInput = (html) => /ant-input-(?:affix-wrapper-)?status-warning/.test(html);
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => /item-selected/.test(m[1]));
const switches = (html) => [...html.matchAll(/<button([^>]*role="switch"[^>]*)>/g)].map((m) => /aria-checked="true"/.test(m[1]));
/** 时间线的每一行:种类、状态色、和持仓有关没有;标的胶囊(class、悬停字);来源带不带「信任」;时刻与悬停的全写;Pill 的颜色;涨跌 */
const rows = (html) => [...html.matchAll(/<li class="intel-row kind-(\w+) tone-([\w-]*)( held)?">([\s\S]*?)<\/li>/g)].map((m) => {
  const li = m[4];
  return {
    kind: m[1], tone: m[2], held: Boolean(m[3]),
    syms: [...li.matchAll(/<button type="button" class="intel-sym([^"]*)"(?: title="([^"]*)")?>([^<]*)<\/button>/g)].map((s) => ({ cls: s[1].trim(), title: decode(s[2] ?? ''), text: decode(s[3]) })),
    trusted: /intel-trusted/.test(li),
    time: (() => { const t = /<span class="intel-time" title="([^"]*)">([^<]*)</.exec(li); return t ? { title: decode(t[1]), text: decode(t[2]) } : null; })(),
    pills: pills(li),
    move: /<span class="intel-move ([^"]*)">/.exec(li)?.[1] ?? null,
    write: /intel-write/.test(li),
  };
});
/** AntD Tag 的胶囊:chip-tag 后面跟的自己的类(held、level-…),悬停字,里面的字 */
const chips = (html) => [...html.matchAll(/<span(?: title="([^"]*)")? class="ant-tag[^"]*?chip-tag((?: held| level-[\w-]+)*)[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ cls: m[2].trim(), title: decode(m[1] ?? ''), text: texts(m[3]).join(' ') }));
/** ui/graphics 的 Pill:颜色在 --tile 里;带不带圆点;悬停字 */
const pills = (html) => [...html.matchAll(/<span class="pill( solid)?" style="--tile:([^";]*);?"(?: title="([^"]*)")?>(<i class="pill-dot"><\/i>)?/g)].map((m) => ({ tint: m[2], dot: Boolean(m[4]), title: decode(m[3] ?? '') }));
const lis = (html) => [...html.matchAll(/<ul class="dossier-list">([\s\S]*?)<\/ul>/g)].flatMap((m) => [...m[1].matchAll(/<li(?: class="([^"]*)")?>/g)].map((l) => l[1] ?? ''));
const heroes = (html) => [...html.matchAll(/class="(hero-num[^"]*|dossier-chg[^"]*)"/g)].map((m) => m[1].trim());
const notices = (html) => [...html.matchAll(/class="ant-alert ant-alert-(\w+)/g)].map((m) => m[1]);

// ---- 数据 ------------------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const baseFeed = await mock.intelFeed({});
const H = 3600e3;
// 再往前几天的几条:昨天、更早(按月日写)、和事件一样在明天之后的(后天)
const extra = [
  { id: 'message:3', kind: 'message', at: NOW - 26 * H, symbols: ['AAPL'], guesses: [], held: ['AAPL'], title: 'AAPL 财报后跳空,先别追', body: '', tone: 'info', source: 'Charlie', trusted: true, ref: '3' },
  { id: 'order:r2', kind: 'order', at: NOW - 30 * H, symbols: ['SPX'], guesses: [], held: ['SPX'], title: '买入看涨蝴蝶 7725/7750/7775', body: '成交:Filled', tone: 'up', source: '实盘', ref: 'r2' },
  { id: 'idea:i3', kind: 'idea', at: NOW - 3 * 24 * H, symbols: [], guesses: ['XYZW'], held: [], title: '下周看 XYZW 的财报', body: 'XYZW 下周三盘后', tone: 'info', source: 'active', ref: 'i3' },
  { id: 'signal:2', kind: 'signal', at: NOW - 5 * 24 * H, symbols: ['TSLA'], guesses: [], held: ['TSLA'], title: 'TSLA 窗口放量 2.4×', body: '窗口放量 · 不带方向', tone: 'warn', source: 'burst', ref: '2' },
  { id: 'event:custom:x', kind: 'event', at: NOW + 50 * H, symbols: [], guesses: [], held: [], title: '将公布:自己记的', body: '美东 2026-10-17 10:00', tone: 'info', source: 'other', ref: 'x' },
  { id: 'message:2', kind: 'message', at: NOW - 40 * 60e3, symbols: ['SPX'], guesses: [], held: ['SPX'], title: '7700 7725 bear call 2.1', body: '只观察:能发,但跟单开关关着', tone: 'info', source: '路人乙', trusted: false, ref: '2',
    outcome: 'rejected', instruction: '7700 7725 bear call 2.1', move: { symbol: 'SPX', then: 7700, now: null, pct: null } },
  { id: 'message:1', kind: 'message', at: NOW - 41 * 60e3, symbols: ['NVDA'], guesses: [], held: ['NVDA'], title: 'NVDA 平了', body: '没接住:没认出动作', tone: 'info', source: 'Charlie', trusted: true, ref: '1',
    outcome: 'unparsed', move: { symbol: 'NVDA', then: 1219.5, now: 1219.5, pct: 0 } },
];
const richFeed = { ...clone(baseFeed), items: [...clone(baseFeed.items), ...extra].sort((a, b) => b.at - a.at) };

const pages = [];
async function page(name, { feed, feedError = null, loading = false, kinds = [], heldOnly = false, connected = true, query = '' } = {}) {
  await ui.seedStatus({ ...(await mock.status()), broker_connected: connected });
  setIntel({ feed: feed === undefined ? null : clone(feed), feedError, loading, kinds, heldOnly, dossier: null, lookupOpen: false });
  globalThis.__ssrSeed = { query };
  const html = ui.renderIntelPage();
  globalThis.__ssrSeed = undefined;
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  pages.push({ name, state: clone(ui.intelSnapshot()), connected, query, texts: texts(html), buttons: buttons(html), inputs: inputs(html), segments: segments(html), switches: switches(html),
    notices: notices(html), rows: rows(html), chips: chips(html) });
}

await page('读着(还没有时间线)');
await page('读不到、没连券商', { feedError: '引擎没起来', connected: false });
await page('时间线', { feed: baseFeed });
await page('几天的时间线(昨天、更早、后天)', { feed: richFeed });
await page('刷新着', { feed: baseFeed, loading: true });
await page('读到过、这一次没读到', { feed: baseFeed, feedError: '超时' });
await page('筛 NVDA', { feed: richFeed, query: 'NVDA' });
await page('筛原文的字', { feed: richFeed, query: '跟单' });
await page('筛不出来', { feed: richFeed, query: '无此字' });
await page('只看信号', { feed: { ...clone(richFeed), items: richFeed.items.filter((i) => i.kind === 'signal') }, kinds: ['signal'] });
await page('只看持仓相关', { feed: { ...clone(richFeed), items: richFeed.items.filter((i) => i.held.length) }, heldOnly: true });
await page('两种一起(分段落在「全部」)', { feed: richFeed, kinds: ['message', 'order'] });
await page('一条都没有', { feed: { ...clone(baseFeed), items: [], total_messages: 0 } });

// ---- 档案 ------------------------------------------------------------------------------------
const dossiers = [];
async function dossier(name, symbol, { data, error = null, loading = false } = {}) {
  setIntel({ lookupOpen: false, dossier: { symbol, data: data === undefined ? null : clone(data), error, loading } });
  const html = ui.renderDossierHost();
  if (process.env.DUMP_HTML?.startsWith(`d:${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 3), html);
  dossiers.push({ name, state: clone(ui.intelSnapshot()), texts: texts(html), buttons: buttons(html), notices: notices(html), rows: rows(html), chips: chips(html), pills: pills(html), lis: lis(html), heroes: heroes(html) });
}
const nvda = await mock.intelDossier('NVDA');
const spx = await mock.intelDossier('SPX');
const tsla = await mock.intelDossier('TSLA');
await dossier('NVDA 全有', 'NVDA', { data: nvda });
await dossier('SPX 指数价、蝴蝶持仓', 'SPX', { data: spx });
await dossier('TSLA 跌', 'TSLA', { data: tsla });
await dossier('刷新着', 'NVDA', { data: nvda, loading: true });
await dossier('读着', 'AAPL', { loading: true });
await dossier('读不到', 'AAPL', { error: '引擎没起来' });
await dossier('读到过、这一次没读到', 'NVDA', { data: nvda, error: '超时' });
const bare = { ...clone(tsla), symbol: 'ZZZ', held: false, quote: null, connected: false, positions: [], tracks: [], working: [], sectors: [], watch: null, quality: null, ideas: [], events: [], signals: [], mentions_7d: 0, timeline: [] };
await dossier('什么都没有、没连券商', 'ZZZ', { data: bare });
await dossier('连着、不在订行情', 'ZZZ', { data: { ...bare, connected: true } });
const busy = clone(nvda);
busy.quote = { price: 1219.5, change_pct: 0, source: 'futures' };
busy.events = Array.from({ length: 8 }, (_, i) => ({ ...clone(nvda.events[0] ?? spx.events[0]), id: `e${i}`, title: `事件 ${i}`, impact: i % 2 ? 'medium' : 'high', at: NOW + (i + 1) * 5 * H }));
busy.watch = { ...clone(nvda.watch), levels: Array.from({ length: 12 }, (_, i) => ({ price: 200 + i * 2.5, label: `L${i}`, source: `s${i}`, kind: i % 3 === 0 ? 'resistance' : i % 3 === 1 ? 'support' : 'pivot' })) };
busy.quality = { ...clone(nvda.quality), events: Array.from({ length: 7 }, (_, i) => ({ ...clone(nvda.quality.events[0]), id: `q${i}`, title: `异动 ${i}`, at: Math.floor(NOW / 1000) - (i + 1) * 600 })) };
busy.ideas = Array.from({ length: 6 }, (_, i) => ({ ...clone(nvda.ideas[0]), id: `i${i}`, text: `想法 ${i}:${'长'.repeat(i * 10)}` }));
busy.tracks = [...clone(nvda.tracks), { ...clone(nvda.tracks[0]), id: 'tk2', fired_state: 'take_profit' }, { ...clone(nvda.tracks[0]), id: 'tk3', enabled: false }, { ...clone(nvda.tracks[0]), id: 'tk4', auto_close: { ...nvda.tracks[0].auto_close, enabled: false } }];
busy.positions = [...clone(nvda.positions), { ...clone(nvda.positions[0]), key: 'p2', quantity: -3, unrealized_pnl: -120.5, unrealized_pct: null, sec_type: 'OPT', multiplier: 100, avg_cost: 350, label: '' }];
await dossier('各段都多(截断、各种状态)', 'NVDA', { data: busy });

// ---- 查标的 ------------------------------------------------------------------------------------
const lookups = [];
async function lookup(name, { text = '', recent = [], feed = baseFeed } = {}) {
  setIntel({ dossier: null, lookupOpen: true, recent, feed: feed ? clone(feed) : null });
  globalThis.__ssrSeed = { lookupText: text };
  const html = ui.renderDossierHost();
  globalThis.__ssrSeed = undefined;
  lookups.push({ name, state: clone(ui.intelSnapshot()), text, texts: texts(html), inputs: inputs(html), warn: warnInput(html), chips: chips(html) });
}
await lookup('空着');
await lookup('敲了代码', { text: '$nvda' });
await lookup('敲了中文', { text: '英伟达' });
await lookup('有最近查过的', { text: 'X', recent: ['TSLA', 'NVDA', 'SPX'] });
await lookup('没有时间线(持仓一栏不出)', { feed: null, recent: ['AAPL'] });

writeFileSync(join(here, 'intel.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_intel.mjs', now: NOW, pages, dossiers, lookups }, null, 1) + '\n');
console.log(`intel.json:${pages.length} 页、${dossiers.length} 份档案、${lookups.length} 个查标的`);
await flush();
process.exit(0);
