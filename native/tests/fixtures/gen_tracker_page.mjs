// 生成 tracker-page.json:「持仓追踪」整页(desktop/renderer-react/src/pages/Tracker.tsx)在各种数据下写出来的字。
// 不手写期望值:SSR 把原页面渲染成 HTML、按文档次序抽字(同 gen_track_card.mjs)。数据底子是预览台那份 desktop/tools/mock-bridge.js
// (和 Qt 版 --engine preview 用的同一份),每个场景只改几样:断开、读不到、心跳停了……
//   node native/tests/fixtures/gen_tracker_page.mjs <装好依赖的 desktop 目录,如 /tmp/claude-501/ibkr-qtref/desktop>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

// 预览台的 mock:和 desktop/tools/preview_engine.js 一样在一个沙箱里跑,拿它的 window.dafri
function loadMock() {
  const w = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window: w, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  w.window = w;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(here, '../../../desktop/tools/mock-bridge.js'), 'utf8'), sandbox);
  return w.dafri;
}
const mock = loadMock();
let overrides = {};
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => overrides[name] ?? mock[name] ?? (async () => ({})) }),
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const texts = (html) => html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const status = await mock.status();
const pos = (await mock.listPositions()).positions;
const poll = await mock.pollTrackers();
const fail = (msg) => async () => { throw new Error(msg); };
// store/tracker 只在 ticks 或 last_error 变了时才换心跳(行没变的那些轮):心跳的写法要在页面上看到,ticks 得跟着动
const beat = (n, extra) => async () => ({ ...poll, loop: { ...poll.loop, ticks: poll.loop.ticks + n, ...extra } });
const scenarios = [
  ['预览台的数据', {}],
  ['没连券商', { status: async () => ({ ...status, broker_connected: false }) }],
  ['没连富途', { status: async () => ({ ...status, broker_connected: false, broker_provider: 'futu' }) }],
  ['持仓读不到', { listPositions: fail('positions.list 超时') }],
  ['账户里没有持仓', { listPositions: async () => ({ positions: [] }) }],
  ['还没有追踪', { listTrackers: async () => ({ tracks: [] }) }],
  ['追踪列表读不到', { listTrackers: fail('引擎忙'), __pollFirst: true }],
  ['盯盘读不到', { pollTrackers: fail('不回话'), __pollTimes: 3 }],
  ['节拍器没在跑', { pollTrackers: beat(1, { running: false }) }],
  ['节拍器停了几秒', { pollTrackers: beat(2, { age_ms: 7400 }) }],
  ['这一轮出错', { pollTrackers: async () => ({ ...poll, loop: { ...poll.loop, last_error: '读持仓超时' } }) }],
  ['节拍器在等', { pollTrackers: beat(3, { hold: '休市:盯盘暂停' }) }],
  ['慢过几轮', { pollTrackers: beat(4, { slow_ticks: 3, max_ms: 1850, interval_ms: 1500, last_ms: null }) }],
  ['还没有心跳', { pollTrackers: async () => ({ ...poll, rows: [], loop: null }) }],
  ['贷方组合与休市昨收', { listPositions: async () => ({ positions: [
    { ...pos[0], net_side: 'credit', legs: ['k1', 'k2'], tracked: false },
    { key: 'k1', account: '模拟', symbol: 'SPX', sec_type: 'OPT', label: 'SPX 7725C', quantity: -1, avg_cost: 300, multiplier: 100, market_price: null, unrealized_pnl: null, close_price: 2.1, close_pnl: -15, close_pct: -5.2, tracked: false, contract: {} },
    { key: 'k2', account: '模拟', symbol: 'SPX', sec_type: 'OPT', label: 'SPX 7750C', quantity: 2, avg_cost: 150, multiplier: 100, market_price: 1.2, unrealized_pnl: 0, unrealized_pct: 0, tracked: false, contract: {} },
    { ...pos[1], pnl_source: 'computed' }, { ...pos[3], market_price: null, unrealized_pnl: null, close_price: 6.05, close_pnl: 110, close_pct: 9.1 },
    { ...pos[2], unrealized_pnl: null, unrealized_pct: null, market_price: null }] }) }],
];
const cases = [];
for (const [name, o] of scenarios) {
  const { __pollTimes = 1, ...methods } = o;
  // 上一场留在 store 里的东西先清掉:先用预览台的底子读一遍(失败计数、签名都回到正常),再换上这一场的
  overrides = {};
  await ui.seedStatus(await mock.status());
  await ui.seedTracker();
  overrides = methods;
  await ui.seedStatus(await window.dafri.status());
  await ui.seedAlerts((await window.dafri.listAlerts()).watches || []);
  await ui.seedTracker();
  for (let i = 1; i < __pollTimes; i += 1) await ui.seedTracker();
  const snap = JSON.parse(JSON.stringify(ui.snapshot()));
  cases.push({ name, overrides: Object.keys(methods), tracker: snap.tracker, watches: snap.alerts.watches, busy: snap.alerts.busy,
    connected: Boolean(snap.status?.broker_connected), provider: snap.status?.broker_provider ?? null, texts: texts(ui.renderTrackerPage()) });
}
writeFileSync(join(here, 'tracker-page.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_tracker_page.mjs', cases }, null, 2) + '\n');
console.log(`tracker-page.json: ${cases.length} 个场景`);
