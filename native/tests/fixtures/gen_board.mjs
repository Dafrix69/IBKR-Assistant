// 生成 board.json:「订单看板」(desktop/renderer-react/src/pages/Board.tsx + lib/OrderStatus.tsx + lib/labels.ts 的状态词表)。
//   · status:lib/OrderStatus.tsx 的 statusBucket / BUCKET_TINT / BUCKET_LABEL 与 labels.ts 的 statusLabel、阶段路径停在哪一步(SSR 里 StagePath 的 done / now);
//   · pages:SSR 把原页面渲染出来抽字,数据底子是预览台的 mock(条件单、交易记录、通知流各自 store 的读法灌进去);
// store/records.ts、store/pending.ts 的读法(读不到留着上一份、回包不是数组当空的、在途不重发、pending 事件重读)不在这里:
// 那是行为,对着假引擎测(tests/tst_order_stores.cpp)。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_board.mjs <装好依赖的 desktop 目录>
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
if (process.env.TZ !== 'Asia/Shanghai') throw new Error('「入队」的钟点按本机时区写:要 TZ=Asia/Shanghai 跑');
const labels = await import(join(repo, 'desktop/renderer-react/src/lib/labels.ts'));

// 时钟钉在 2026-08-21 21:50 本机(= 13:50Z):和 mock 的记录同一天,「入队」只写时分
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
globalThis.window = {
  dafri: new Proxy({}, { get: (_t, name) => overrides[name] ?? mock[name] ?? (async () => ({})) }),
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const ui = await import(pathToFileURL(join(out, 'entry.mjs')).href);

const texts = (html) => html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** 每条 StagePath 的样子:每一段是 done / now / 空,外加 --tile(哪个色) */
const stages = (html) => [...html.matchAll(/<span class="stage-path" style="--tile:var\(--(\w+)\)">((?:<span class="stage[^"]*"><i><\/i><em>[^<]*<\/em><\/span>)+)<\/span>/g)]
  .map((m) => ({ tile: m[1], steps: [...m[2].matchAll(/<span class="stage( done| now)?">/g)].map((x) => (x[1] || '').trim()) }));
/** 每颗 Pill 的着色(状态胶囊、买卖) */
const pills = (html) => [...html.matchAll(/<span class="pill[^"]*" style="--tile:var\(--(\w+)\)"/g)].map((m) => m[1]);

// ---- 1. 状态的口径 ------------------------------------------------------------------------
const finals = ['', 'filled', 'partially_filled', 'cancelled', 'expired_untriggered', 'rejected_by_validator', 'rejected_by_llm', 'ibkr_error', 'halted_by_breaker', 'something_new'];
const lives = ['', 'ValidatedOnly', 'PendingSubmit', 'PreSubmitted', 'Submitted', 'ApiPending', 'PendingCancel', 'Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'Unknown', 'NotAtBroker', 'Weird'];
// statusBucket 与阶段路径没有导出成纯函数,摆一张记录卡片从 SSR 里读(OrderStages / StatusPill 是原组件)
const statusCases = [];
for (const f of finals) for (const s of lives) {
  const record = { id: `x-${f}-${s}`, symbol: 'AAPL', action: 'BUY', quantity: 1, account: '模拟', final_status: f || null, status: s || null, intent_summary: 'x', created_at: '2026-08-21T13:41:02Z' };
  const o = ui.orderStatus(record);
  statusCases.push({ final_status: record.final_status, status: record.status, label: labels.statusLabel(record, '—'), bucket: o.bucket, tint: o.tint,
    bucketLabel: o.bucketLabel, stages: stages(o.stagesHtml)[0], pill: pills(o.pillHtml)[0], pillText: texts(o.pillHtml).join(' ') });
}

// ---- 2. 整页 --------------------------------------------------------------------------------
const recs = (await mock.listRecords()).records;
const pend = (await mock.listPending()).pending;
const R = (o) => ({ id: `r-${Math.random().toString(36).slice(2, 8)}`, symbol: 'AAPL', action: 'BUY', quantity: 10, account: '模拟', account_masked: 'DU***321', is_paper: true, created_at: '2026-08-21T13:41:02Z', intent_summary: '买入 10 股 AAPL', ...o });
const everyStatus = [];
let n = 0;
for (const f of finals) for (const s of ['', 'Submitted', 'ValidatedOnly', 'NotAtBroker', 'Filled', 'Inactive', 'Cancelled', 'PreSubmitted']) {
  everyStatus.push(R({ id: `e${n++}`, final_status: f || null, status: s || null, intent_summary: `状态 ${f || '—'} / ${s || '—'}`, action: n % 2 ? 'SELL' : 'BUY' }));
}
const fail = (msg) => async () => { throw new Error(msg); };
const scenarios = [
  ['预览台的数据', {}],
  ['什么都没有', { listRecords: async () => ({ records: [] }), listPending: async () => ({ pending: [] }) }],
  ['条件单读不到', { listPending: fail('引擎忙') }],
  ['记录读不到', { listRecords: fail('records.list 超时') }],
  ['两样都读不到', { listPending: fail('a'), listRecords: fail('b') }],
  ['回包不是数组', { listRecords: async () => ({ records: null }), listPending: async () => ({}) }],
  ['各种状态(只摆前 8 张)', { listRecords: async () => ({ records: everyStatus }) }],
  ['被拒的不算在途', { listRecords: async () => ({ records: [
    R({ id: 'a', status: 'Submitted', rejection: { code: 'X' } }), R({ id: 'b', status: null, final_status: 'rejected_by_llm' }),
    R({ id: 'c', status: 'Filled', final_status: 'filled', avg_fill_price: 201.255, quantity: null, intent_summary: '' , raw_instruction: '原话' }),
    R({ id: 'd', status: 'PreSubmitted', action: null, symbol: null, account: null, intent_summary: null, raw_instruction: null }),
    R({ id: 'e', status: 'Submitted', avg_fill_price: 0 }),
  ] }) }],
  ['条件单的各种比较符', { listPending: async () => ({ pending: [
    ...pend, { ...pend[0], record_id: 'p2', operator: '<=', value: 7500.5, symbol: 'SPX', created_at: '2026-08-20T23:10:00Z' },
    { ...pend[0], record_id: 'p3', operator: '==', value: 10, symbol: '', intent_summary: '' }, { ...pend[0], record_id: 'p4', operator: 'crosses', value: 1, created_at: null },
    { ...pend[0], record_id: 'p5', operator: null, value: null, symbol: null, created_at: 'not a date' },
  ] }) }],
];
const pages = [];
for (const [name, methods] of scenarios) {
  // 上一场留下的先清掉:先用预览台的底子读一遍
  overrides = {};
  await ui.seedBoard();
  overrides = methods;
  await ui.seedBoard();
  const snap = JSON.parse(JSON.stringify(ui.boardSnapshot()));
  const html = ui.renderBoardPage();
  pages.push({ name, overrides: Object.keys(methods), ...snap, texts: texts(html), stages: stages(html), pills: pills(html) });
}
// 通知流:pushNotification 写进去的样子(带 body / 不带),最多留 60 条
for (let i = 0; i < 62; i += 1) ui.pushNotification(`第 ${i} 条`, i % 2 ? `说明 ${i}` : undefined);
overrides = {};
await ui.seedBoard();
const feedHtml = ui.renderBoardPage();
const feedSnap = JSON.parse(JSON.stringify(ui.boardSnapshot()));
pages.push({ name: '通知流满了', overrides: [], ...feedSnap, texts: texts(feedHtml), stages: stages(feedHtml), pills: pills(feedHtml) });

writeFileSync(join(here, 'board.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_board.mjs', now: NOW,
  labels: { FINAL_STATUS_LABEL: labels.FINAL_STATUS_LABEL, LIVE_STATUS_LABEL: labels.LIVE_STATUS_LABEL, TRIGGER_OP_LABEL: labels.TRIGGER_OP_LABEL, ACTION_LABEL: labels.ACTION_LABEL },
  status: statusCases, pages }, null, 2) + '\n');
console.log(`board.json: ${statusCases.length} 个状态组合、${pages.length} 个页面场景`);
