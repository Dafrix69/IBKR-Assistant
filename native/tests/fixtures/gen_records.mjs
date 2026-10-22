// 生成 records.json:「交易记录」(desktop/renderer-react/src/pages/Records.tsx + lib/RecordDetail.tsx)。
//   · pages:SSR 把原页面渲染出来抽字,外加每一行的次序(data-row-key)、打开的那一行、筛选条每一档能不能点、
//     去向分段条每段的份量与着色。数据底子是预览台的 mock 加上几条边角记录;筛选 / 关键词 / 疏密 / 排序 / 打开的详情
//     这些点出来的状态由 ssr/build.mjs 的 SEEDS 灌进 useState 的初值(effect 在 SSR 里不跑)。
//   · tickets:lib/OrderTicket.tsx 的 ticketFromRecord(详情上半张的票据从完整记录里拼)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_records.mjs <装好依赖的 desktop 目录>
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

// 时钟钉在 2026-08-21 21:50 本机(= 13:50Z):和 mock 的记录同一天
const NOW = Date.UTC(2026, 7, 21, 13, 50, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

// 表头排序用的是 localeCompare,跟着系统语言走:Electron 版在中文系统上是 zh-CN 的排序(拼音)。node 默认的语言不一定是它,钉住
const collator = new Intl.Collator('zh-CN');
String.prototype.localeCompare = function localeCompare(that) { return collator.compare(String(this), String(that)); };

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
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => overrides[name] ?? mock[name] ?? (async () => ({})) }),
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const texts = (html) => decode(html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n'))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
// 只认记录表那一张(详情里的成交明细也是一张表,行键是 exec_id)
const rowKeys = (html) => [...html.split('class="detail"')[0].matchAll(/<tr tabindex="0" class="([^"]*)" data-row-key="([^"]*)"/g)].map((m) => ({ id: decode(m[2]), open: /\brow-open\b/.test(m[1]) }));
const segments = (html) => [...html.matchAll(/<label class="ant-segmented-item([^"]*)"/g)].map((m) => ({ selected: /item-selected/.test(m[1]), disabled: /item-disabled/.test(m[1]) }));
const segBar = (html) => {
  const m = html.match(/<span class="seg-bar[^"]*">([\s\S]*?)<\/span>/);
  return m ? [...m[1].matchAll(/<i style="flex-grow:(\d+);background:var\(--(\w+)\)" title="([^"]*)"/g)].map((x) => ({ grow: Number(x[1]), tint: x[2], title: decode(x[3]) })) : null;
};
const titles = (html) => [...html.matchAll(/<span title="([^"]*)">/g)].map((m) => decode(m[1]));
/** 两个 Segmented:疏密、筛选 */
const segGroups = (html) => [...html.matchAll(/<div class="ant-segmented[^"]*"[^>]*>([\s\S]*?)<\/div><\/div>/g)].map((g) => segments(g[1]));

// ---- 记录 ------------------------------------------------------------------------------------
const base = (await mock.listRecords()).records;
const R = (o) => ({ id: 'x', symbol: 'AAPL', action: 'BUY', quantity: 10, account: '模拟', account_masked: 'DU***321', is_paper: true,
  status: 'Submitted', final_status: null, created_at: '2026-08-21T13:41:02Z', intent_summary: '买入 10 股 AAPL', ...o });
// 边角:没终态没在途、各种终态、昨天的、不带时区的、读不出的时间、没标的没方向没账户、实盘、金额是 0 / 小数、原因空、意图空回落到原话
const edge = [
  R({ id: 'e1', final_status: 'partially_filled', status: 'Submitted', notional_estimate: 1234.5, created_at: '2026-08-20T09:15:00Z', is_paper: false, account: '主账户', account_masked: 'U***789' }),
  R({ id: 'e2', final_status: 'cancelled', status: 'Cancelled', notional_estimate: 0, created_at: '2026-08-21T13:45:00', reason: '' }),
  R({ id: 'e3', final_status: 'expired_untriggered', status: null, symbol: 'spy', action: 'SELL', created_at: 'not a date', intent_summary: '', raw_instruction: 'spy 跌破 700 卖' }),
  R({ id: 'e4', final_status: 'halted_by_breaker', status: null, symbol: null, action: null, account: null, created_at: null, intent_summary: null, raw_instruction: null }),
  R({ id: 'e5', final_status: 'rejected_by_llm', status: null, symbol: 'TQQQQQ', reason: '看不懂', created_at: '2026-08-19' }),
  R({ id: 'e6', final_status: null, status: 'NotAtBroker', symbol: 'QQQ', account_masked: null, created_at: '2026-08-21T13:47:59.123Z', notional_estimate: 99.999 }),
  R({ id: 'e7', final_status: null, status: 'PreSubmitted', symbol: 'AMD', action: 'SELL', created_at: '2026-08-20T16:00:05Z' }),
  R({ id: 'e8', final_status: null, status: null, symbol: 'MSFT', created_at: '2026-08-21T13:30:00Z', reason: 'Momentum' }),
  R({ id: 'e9', final_status: 'something_new', status: 'Weird', symbol: 'META', created_at: '2026-08-21T13:30:00Z' }),
];
const all = [...base, ...edge];

// ---- 详情 ------------------------------------------------------------------------------------
const full = (await mock.getRecord('r1')).record;
const fly = {
  id: 'f1', created_at: '2026-08-21T13:39:40Z',
  input: { raw_instruction: '1.8 挂15蝴蝶 15CM', reason: '' },
  llm: { intent_summary: '限价 1.8 买入 1 组 SPX 7600/7615/7630 看跌蝴蝶' },
  account: { alias: '主账户', account_masked: 'U***789', is_paper: false },
  contract: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs: [
    { action: 'BUY', ratio: 1, strike: 7600, right: 'P', lastTradeDateOrContractMonth: '20260821' },
    { action: 'SELL', ratio: 2, strike: 7615, right: 'P', lastTradeDateOrContractMonth: '20260821' },
    { action: 'BUY', ratio: 1, strike: 7630, right: 'P', lastTradeDateOrContractMonth: '20260821' },
    { action: 'BUY', strike: 'x', right: 'P' }, null] },
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'AUTO_MID', lmtPrice: 1.8, tif: 'GTC', outsideRth: true },
  ibkr: { order_id: 0, status_timeline: [{ status: 'PendingSubmit', at: '2026-08-21T13:39:41Z' }, { status: 'Mystery', at: null }, { at: '2026-08-21T13:39:42Z' }],
    fills: [{ exec_id: '', time: '2026-08-21T13:39:43Z', qty: null, price: null, commission: null }], realized_pnl: -12.5, total_commission: 0 },
  trigger: { symbol: 'SPX', operator: '<=', value: 7610 },
  final_status: null, status: 'Submitted', error_detail: 'IBKR 201: 保证金不足', post_warnings: [{}, { message: '第二条提醒' }],
};
const bare = { id: 'b1', created_at: 'nope', contract: { symbol: 'TSLA' }, order: { action: 'SELL', orderType: 'STP', auxPrice: 300, outsideRth: false } };
const stock = { id: 's1', created_at: '2026-08-20T01:02:03Z', contract: { secType: 'STK', symbol: 'AAPL', strike: 0 }, order: { action: 'SELL', totalQuantity: 5, orderType: 'TRAIL', trailingPercent: 2, tif: 'DAY' },
  llm: { model: 'm', confidence: 0, usage: {} }, ibkr: { avg_fill_price: 0, fills: [] }, trigger: { operator: '>=', value: 1 } };
const details = { full, fly, bare, stock };

// ---- 场景 ------------------------------------------------------------------------------------
const pages = [];
async function page(name, { list = all, fail, seed = {}, detail } = {}) {
  overrides = { listRecords: fail ? async () => { throw new Error(fail); } : async () => ({ records: list }) };
  // 先用一份好的读一次,再按场景读:读不到时 store 留着上一份
  if (fail) { overrides.listRecords = async () => ({ records: list }); await ui.seedBoard(); overrides.listRecords = async () => { throw new Error(fail); }; }
  await ui.seedBoard();
  globalThis.__ssrSeed = { ...seed, detail };
  const html = ui.renderRecordsPage();
  globalThis.__ssrSeed = undefined;
  // 排查用:DUMP_HTML=<场景名>:<文件> 把那一场的 HTML 落盘
  if (process.env.DUMP_HTML?.startsWith(`${name}:`)) writeFileSync(process.env.DUMP_HTML.slice(name.length + 1), html);
  const snap = JSON.parse(JSON.stringify(ui.boardSnapshot()));
  pages.push({ name, records: snap.records, recordsError: snap.recordsError, seed, detail: detail ?? null,
    texts: texts(html), rows: rowKeys(html), segments: segGroups(html), segBar: segBar(html), titles: titles(html),
    // 原始记录(JSON)折着,SSR 不画里面;展开后是 JSON.stringify(record, null, 2)
    rawJson: detail?.record ? JSON.stringify(detail.record, null, 2) : null,
    compact: /^[\s\S]*?<div class="ant-table ant-table-(\w+)/.exec(html)?.[1] === 'small' });
}
await page('预览台加边角记录');
await page('预览台的数据', { list: base });
await page('什么都没有', { list: [] });
await page('读不到(留着上一份)', { fail: 'records.list 超时' });
await page('读不到也没有上一份', { list: [], fail: '引擎忙' });
for (const f of ['filled', 'live', 'stale', 'draft', 'rejected', 'failed']) await page(`筛选 ${f}`, { seed: { filter: f } });
await page('筛选到空的一档', { list: base, seed: { filter: 'stale' } });
for (const k of ['nvda', ' 止损 ', 'DU***', 'rejected', '主账户', 'spy 跌破', '没有这个词', 'momentum']) await page(`关键词「${k}」`, { seed: { keyword: k } });
await page('关键词加筛选', { seed: { keyword: 'aapl', filter: 'live' } });
await page('紧凑', { seed: { density: 'compact' } });
for (const [key, order] of [['created_at', 'ascend'], ['created_at', null], ['symbol', 'ascend'], ['symbol', 'descend'], ['final_status', 'ascend'], ['final_status', 'descend']]) {
  await page(`排序 ${key} ${order}`, { seed: { sort: { key, order } } });
}
await page('详情:读着', { seed: { openId: 'r1' }, detail: { state: 'loading' } });
await page('详情:不在了', { seed: { openId: 'r1' }, detail: { state: 'gone' } });
await page('详情:读不到', { seed: { openId: 'r1' }, detail: { state: 'error', error: 'records.get 超时' } });
for (const [k, rec] of Object.entries(details)) await page(`详情:${k}`, { seed: { openId: rec.id === 'f1' ? 'r5' : 'r1' }, detail: { state: 'ok', record: rec } });
await page('详情开着但那一行被筛掉了', { seed: { openId: 'r1', filter: 'draft' }, detail: { state: 'ok', record: full } });

const tickets = Object.entries(details).map(([name, r]) => ({ name, contract: r.contract ?? null, order: r.order ?? null, trigger: r.trigger ?? null,
  ticket: ui.ticketFromRecord(r.contract, r.order, r.trigger) }));
tickets.push({ name: '缺数量', contract: { symbol: 'X' }, order: { action: 'BUY', totalQuantity: 0 }, trigger: null, ticket: ui.ticketFromRecord({ symbol: 'X' }, { action: 'BUY', totalQuantity: 0 }) });
tickets.push({ name: '数量是字符串', contract: { symbol: 'X', strike: '12.5', legs: [{ strike: '7600', right: 'C', ratio: '0', action: 'BUY' }] }, order: { action: 'BUY', totalQuantity: '3' }, trigger: { symbol: '' },
  ticket: ui.ticketFromRecord({ symbol: 'X', strike: '12.5', legs: [{ strike: '7600', right: 'C', ratio: '0', action: 'BUY' }] }, { action: 'BUY', totalQuantity: '3' }, { symbol: '' }) });

writeFileSync(join(here, 'records.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_records.mjs', now: NOW, pages, tickets }, null, 2) + '\n');
console.log(`records.json: ${pages.length} 个页面场景、${tickets.length} 张票据`);
