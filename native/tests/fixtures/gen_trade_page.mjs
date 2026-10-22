// 生成 trade-page.json:「交易指令」页(desktop/renderer-react/src/pages/Trade.tsx + store/trade.ts + lib/OrderTicket.tsx + lib/SimilarTrades.tsx)。
// 三样都不手写期望值:
//   · actions:store/trade.ts 的原函数(打进 SSR 包里的那一份)真跑一遍。submitInstruction 是钱路径(execute = 授权直接发单):
//     每个场景记下确认框上写了什么、调了引擎哪几个方法(入参原样)、store 里的输入框 / 结果一步步怎么变。
//     发出去的那一份入参再拿引擎的 zod schema(engine-ts/src/contract/schema/instruction.ts,.strict())真校验一遍。
//   · picks:lib/accountPick.ts 的 pickAccounts,以及 store/trade 读本机存的勾选(每种存法各起一份新的 store)。
//   · pages:SSR 把原页面渲染成 HTML、按文档次序抽字(同 gen_tracker_page.mjs),外加每张损益图的 SVG 路径与刻度(C++ 算出来要一模一样)。
//   node native/tests/fixtures/gen_trade_page.mjs <装好依赖的 desktop 目录,如 /tmp/claude-501/ibkr-qtref/desktop>
//   [ENGINE_MODULES=<装好依赖的 engine-ts/node_modules>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const desktop = process.argv[2];
if (!desktop) throw new Error('要给装好依赖的 desktop 目录');
const engineModules = process.env.ENGINE_MODULES || join(repo, 'engine-ts/node_modules');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'zod') return { url: pathToFileURL(join(engineModules, 'zod/index.js')).href, shortCircuit: true, format: 'module' };
    if (spec.endsWith('.js') && ctx.parentURL?.includes('/engine-ts/src/')) {
      const ts = fileURLToPath(new URL(spec, ctx.parentURL)).replace(/\.js$/, '.ts');
      if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const { InstructionSubmitParamsSchema } = await import(join(repo, 'engine-ts/src/contract/schema/instruction.ts'));
const { pickAccounts } = await import(join(repo, 'desktop/renderer-react/src/lib/accountPick.ts'));
const labels = await import(join(repo, 'desktop/renderer-react/src/lib/labels.ts'));

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
// 引擎调用的流水:每个场景清一次。名字是 window.dafri 上的方法名,入参原样
let calls = [];
const logged = new Set(['confirm', 'submit', 'status', 'listRecords', 'listPending']);
const store = new Map();
globalThis.window = {
  dafri: new Proxy({}, {
    get: (_t, name) => async (...args) => {
      if (logged.has(name)) calls.push({ call: name, args: JSON.parse(JSON.stringify(args)) });
      const fn = overrides[name] ?? mock[name];
      return fn ? fn(...args) : {};
    },
  }),
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (f) => setTimeout(f, 0),
};
globalThis.localStorage = window.localStorage;
// store/appearance 按 navigator.platform 认 Mac(快捷键写 ⌘ 还是 Ctrl+):Qt 版只在 Mac 上做排版对照,这里按 Mac
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
// 耗时(__elapsedMs)= performance.now() 两次之差:钉死,期望值才不随机器变
let clock = [];
globalThis.performance.now = () => (clock.length ? clock.shift() : 0);

const bundle = pathToFileURL(join(out, 'entry.mjs')).href;
const ui = await import(bundle);

const texts = (html) => html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const composerOf = () => (globalThis.__zustandStores || []).find((s) => s.getState().composer)?.getState().composer;
const snapComposer = () => JSON.parse(JSON.stringify(composerOf()));

// ---- 1. 提交动作 ---------------------------------------------------------------
const okPayload = await mock.submit();
const actionScenarios = [
  // 名字, 输入框, 发送?, 勾的账户, 确认框点什么, 引擎回什么('throw:原因' = 报错), 右栏在哪一面, 耗时两次读数
  ['只解析', '  1.8 挂15蝴蝶 15CM \n', false, ['模拟'], [], okPayload, 'result', [1000, 3456.4]],
  ['只解析:右栏在蝴蝶测算', 'spx 7520 7550 call spread', false, ['模拟'], [], okPayload, 'fly', [10, 20.5]],
  ['空指令', '   \n ', false, ['模拟'], [], okPayload, 'result', []],
  ['没勾账户', '买 1 股 AAPL', false, [], [], okPayload, 'result', []],
  ['没勾账户也要发送', '买 1 股 AAPL', true, [], [true], okPayload, 'result', []],
  ['发送:点了取消', '买 1 股 AAPL 限价 200', true, ['主账户'], [false], okPayload, 'result', []],
  ['发送', '买 1 股 AAPL 限价 200', true, ['主账户'], [true], okPayload, 'result', [5, 1205.5]],
  ['发送到两个账户', '  开一张今天的 7520 7550 call spread  ', true, ['模拟', '主账户'], [true], okPayload, 'playbook', [0, 61000]],
  ['解析失败', '买 1 股 AAPL', false, ['模拟'], [], 'throw:大模型超时', 'result', [0, 1]],
  ['发送被拒', '买 1 股 AAPL', true, ['模拟'], [true], 'throw:引擎拒绝:自动执行未打开', 'result', [0, 1]],
];
const actions = [];
for (const [name, text, execute, accounts, confirms, result, pane, ticks] of actionScenarios) {
  ui.trade.setTradeDraft('');
  ui.trade.setInstruction(text);
  ui.trade.setTradePane(pane);
  // 上一场的结果先清掉(clearResult 不碰输入框)
  ui.trade.clearResult();
  const answers = [...confirms];
  overrides = {
    confirm: async () => answers.shift() ?? false,
    submit: async () => {
      if (typeof result === 'string') throw new Error(result.slice(6));
      return JSON.parse(JSON.stringify(result));
    },
  };
  clock = [...ticks];
  calls = [];
  const states = [];
  const api = (globalThis.__zustandStores || []).find((s) => s.getState().composer);
  const unsub = api.subscribe((s) => states.push(JSON.parse(JSON.stringify(s.composer))));
  // 横幅(store/banner 的 showBanner)也算一步:先清掉上一场的
  const bannerApi = (globalThis.__zustandStores || []).find((st) => { const k = Object.keys(st.getState()); return k.length === 1 && k[0] === 'current'; });
  bannerApi.setState({ current: null });
  const unBanner = bannerApi.subscribe((st) => st.current && calls.push({ call: 'banner', message: st.current.message, info: st.current.info }));
  const before = snapComposer();
  await ui.trade.submitInstruction(execute, accounts);
  unsub();
  unBanner();
  // 发出去的那一份入参(preload.js 的 submit 把它包成 instruction.submit 的 params):拿引擎的 schema 校验
  const sent = calls.find((c) => c.call === 'submit');
  let params = null;
  let schema = null;
  if (sent) {
    const [t, ex, accs] = sent.args;
    params = { text: t, execute: Boolean(ex), accounts: Array.isArray(accs) ? accs.map(String) : [] };
    const parsed = InstructionSubmitParamsSchema.safeParse(params);
    schema = parsed.success ? 'ok' : parsed.error.issues.map((i) => i.message).join(';');
  }
  actions.push({ name, text, execute, accounts, confirms, result, pane, ticks, before, calls: [...calls], states, after: snapComposer(), params, schema });
}
// 正在提交时再按一次:第二下什么都不做(store 里 busy 挡着)
{
  ui.trade.setTradeDraft('买 1 股 AAPL');
  let release;
  overrides = { submit: () => new Promise((r) => { release = () => r(JSON.parse(JSON.stringify(okPayload))); }) };
  clock = [0, 7];
  calls = [];
  const first = ui.trade.submitInstruction(false, ['模拟']);
  await new Promise((r) => setTimeout(r, 0));
  const during = snapComposer();
  await ui.trade.submitInstruction(true, ['模拟']);
  const callsDuring = calls.length;
  release();
  await first;
  // 只看会发单的那两样:第二下要是漏过去了,这里会多一次 confirm / submit
  const sent = calls.filter((c) => c.call === 'confirm' || c.call === 'submit');
  actions.push({ name: '正在解析时又按了发送', text: '买 1 股 AAPL', execute: false, accounts: ['模拟'], during, callsDuring, calls: sent, after: snapComposer() });
  calls = [];
}
// 写进指令(蝴蝶测算的按钮):空着就填,有字另起一行
const appends = [];
for (const [text, line] of [['', '7810/7850/7890 蝴蝶 2.3'], ['  \n', 'x'], ['abc', 'x'], ['abc  \n \t', 'x'], ['a\n', 'b'], ['  lead', 'x']]) {
  ui.trade.setTradeDraft(text);
  ui.trade.appendInstruction(line);
  appends.push({ text, line, result: composerOf().text });
}

// ---- 2. 发单账户 ---------------------------------------------------------------
const A = (alias, def) => ({ alias, ...(def ? { default: true } : {}) });
const pickCases = [
  [[], null], [[], ['a']], [[A('a')], null], [[A('a')], ['b']], [[A('a')], []],
  [[A('a'), A('b', true)], null], [[A('a'), A('b')], null], [[A('a'), A('b', true)], ['a']], [[A('a'), A('b')], ['a', 'b']],
  [[A('a'), A('b')], ['x']], [[A('a'), A('b', true)], ['x', 'y']], [[A('a'), A('b')], []], [[A('a'), A('b'), A('c')], ['c', 'x', 'a']],
  [[A('a', true), A('b', true)], null],
].map(([usable, saved]) => ({ usable, saved, result: pickAccounts(usable, saved) }));
// 本机存的那一份怎么读:每种存法起一份新的 store(模块只在加载时读一次盘)
const stored = [];
const usable2 = [A('模拟', true), A('主账户')];
for (const raw of [null, '["主账户"]', '["模拟","主账户"]', '[]', 'not json', '{"a":1}', '[1,"主账户"]', '"主账户"', 'null']) {
  store.clear();
  if (raw !== null) store.set('dafri-submit-accounts', raw);
  delete globalThis.__zustandStores;
  const fresh = await import(`${bundle}?stored=${stored.length}`);
  const picked = fresh.trade.selectedAccounts(usable2);
  fresh.trade.savePickedAccounts(['主账户', '模拟']);
  stored.push({ raw, picked, afterSave: fresh.trade.selectedAccounts(usable2), written: store.get('dafri-submit-accounts') ?? null });
}
store.clear();
delete globalThis.__zustandStores;
const page = await import(`${bundle}?page`);

// ---- 3. 整页 ---------------------------------------------------------------------
const status = await mock.status();
const llm = await mock.llmCatalog();
const tk = okPayload.validated_only[0].ticket;
const order = (summary, ticket, extra = {}) => ({ intent_summary: summary, account: '模拟', account_masked: 'DU***321', is_paper: true, ticket, warnings: [], ...extra });
const stk = { sec_type: 'STK', symbol: 'AAPL', action: 'BUY', quantity: 10, order_type: 'LMT', price_mode: 'EXPLICIT', limit_price: 201.5, aux_price: null, trailing_percent: null, tif: 'DAY', expiry: null, strike: null, right: null, multiplier: 1, combo_strategy: null, legs: [], trigger: null };
const opt = { ...stk, sec_type: 'OPT', symbol: 'NVDA', action: 'SELL', quantity: 2, limit_price: 3.4, expiry: '20260918', strike: 180, right: 'P', multiplier: 100 };
const vertical = { ...stk, sec_type: 'BAG', symbol: 'SPX', quantity: 1, limit_price: 4.2, price_mode: 'AUTO_MID', expiry: '20260821', multiplier: 100, combo_strategy: 'VERTICAL',
  legs: [{ action: 'BUY', ratio: 1, strike: 7520, right: 'C' }, { action: 'SELL', ratio: 1, strike: 7550, right: 'C' }], trigger: { symbol: 'SPX', operator: '>=', value: 7500 } };
const condor = { ...vertical, action: 'SELL', price_mode: 'EXPLICIT', limit_price: 1.15, combo_strategy: 'IRON_CONDOR', trigger: null, tif: 'GTC',
  legs: [{ action: 'BUY', ratio: 1, strike: 7200, right: 'P' }, { action: 'SELL', ratio: 1, strike: 7250, right: 'P' }, { action: 'SELL', ratio: 1, strike: 7650, right: 'C' }, { action: 'BUY', ratio: 1, strike: 7700, right: 'C' }] };
const llmLocal = { model: 'local-shorthand', prompt_version: 'v7', latency_ms: 0, usage: { input_tokens: 0, output_tokens: 0 } };
const llmCloud = { model: 'claude-opus-5', prompt_version: 'v1.8.0', latency_ms: 2410, usage: { input_tokens: 5120, output_tokens: 312 } };
const similar = {
  kind: 'combo', symbol: 'SPX', basis: ['同标的', '同结构', '限价相近'], count: 6, win: 3, loss: 2, flat: 1, open: 0, unknown: 0,
  exits: [{ exit: '到价止盈', win: 3, loss: 0, flat: 0, open: 0, unknown: 0 }, { exit: '到期', win: 0, loss: 2, flat: 1, open: 0, unknown: 0 }],
  matches: [
    { fact: { id: 'f1', opened_at: '2026-08-14T10:02:00-04:00', label: 'SPX 7600/7615/7630P 蝴蝶', paper: true, result: 'win', return_pct: 85.2, pnl_points: 1.6, note: '午后到价' }, primary: true, reasons: ['同结构', '同标的'] },
    { fact: { id: 'f2', opened_at: '2026-08-12T11:30:00-04:00', label: 'SPX 7550P 蝴蝶', paper: false, result: 'loss', return_pct: -100, pnl_points: null, note: '' }, primary: true, reasons: ['同结构'] },
    { fact: { id: 'f3', opened_at: '2026-08-11T09:45:00-04:00', label: 'NDX 蝴蝶', paper: false, result: 'flat', return_pct: null, pnl_points: 0, note: null }, primary: false, reasons: ['同板块'] },
    { fact: { id: 'f4', opened_at: '2026-08-10', label: 'SPX 价差', paper: false, result: 'open', return_pct: 0, pnl_points: -0.5 }, primary: true, reasons: [] },
    { fact: { id: 'f5', opened_at: '2026-08-09', label: 'SPX 价差2', paper: true, result: 'unknown', return_pct: 12, pnl_points: 2 }, primary: true, reasons: [] },
    { fact: { id: 'f6', opened_at: '2026-08-08', label: '第六笔', paper: false, result: 'win', return_pct: 1, pnl_points: 1 }, primary: true, reasons: [] },
  ],
  lessons: [{ id: 'i1', text: '短' }, { id: 'i2', text: '这一条复盘经验写得很长,'.repeat(9) }],
};
const S = (o) => async () => ({ ...status, ...o });
const one = [status.accounts[0]];
const pageScenarios = [
  ['预览台的数据', {}],
  ['大模型没配 Key', { llmCatalog: async () => ({ ...llm, key_configured: { anthropic: false } }) }],
  ['大模型目录读不到', { llmCatalog: async () => { throw new Error('引擎忙'); } }],
  ['占位账号', { __seed: { placeholders: ['模拟', '主账户'] } }],
  ['没连券商', { status: S({ broker_connected: false }) }],
  ['富途没连', { status: S({ broker_connected: false, broker_provider: 'futu' }) }],
  ['富途连着', { status: S({ broker_provider: 'futu' }) }],
  ['自动执行关着', { status: S({ auto_execute: false }) }],
  ['全都没好', { status: S({ auto_execute: false, broker_connected: false, breaker: { engaged: true, reason: '连续失败' } }), llmCatalog: async () => ({ ...llm, key_configured: {} }), __seed: { placeholders: ['模拟'] } }],
  ['熔断', { status: S({ breaker: { engaged: true, reason: '连续失败 3 次', consecutive_failures: 3 } }) }],
  ['勾了实盘、实盘没放开', { __picked: ['模拟', '主账户'] }],
  ['只勾实盘、实盘没放开', { __picked: ['主账户'] }],
  ['勾了实盘、实盘已放开', { __picked: ['主账户'], status: S({ allow_live_trading: true }) }],
  ['一个账户也没勾', { __picked: [] }],
  ['只有一个实盘账户', { status: S({ accounts: [{ ...status.accounts[1], default: true }] }) }],
  ['只有一个纸面账户', { status: S({ accounts: one }) }],
  ['保护规则暂停', { status: S({ protections: { paused: true, rule: 'daily_loss', reason: '当日亏损达到 2%', until_ms: null, cooldowns: [] } }) }],
  ['保护规则暂停:没写原因', { status: S({ protections: { paused: true, rule: 'x', reason: '', until_ms: null, cooldowns: [] } }) }],
  ['一个账户暂停', { status: S({ protections: { paused: false, accounts: [{ alias: '主账户', reason: '主账户 今日已亏 1.5%' }] } }) }],
  ['两个账户暂停', { status: S({ protections: { paused: false, accounts: [{ alias: '主账户', reason: '甲' }, { alias: '模拟', reason: '乙' }] } }) }],
  ['暂停与账户暂停同时', { status: S({ protections: { paused: true, reason: '全局', accounts: [{ alias: '主账户', reason: '甲' }] } }) }],
  ['没有限额', { status: S({ limits: undefined }) }],
  ['状态读不到', { status: async () => { throw new Error('不回话'); } }],
  ['正在解析', { __pending: false, __text: '1.8 挂15蝴蝶 15CM' }],
  ['正在发送', { __pending: true, __text: '1.8 挂15蝴蝶 15CM' }],
  ['调用失败', { __payload: 'throw:大模型超时(60 s)' }],
  ['预览台的解析结果', { __payload: okPayload, __seed: { similar } }],
  ['各种订单', { __payload: {
    submitted: [order('限价 201.5 买入 10 股 AAPL', stk, { notional: 2015, order_id: 812 }), order('卖出 2 张 NVDA 180P', opt, { account: '' })],
    queued: [order('SPX 突破 7500 时买入 7520/7550 看涨价差', vertical, { mode: 'software_watch', notional: 0 }), order('铁鹰', condor, { mode: 'broker_condition', order_id: 0 })],
    validated_only: [order('老引擎没有票据', undefined, { account: undefined }), order('票据坏了', { symbol: 1 }), order('', { ...stk, order_type: 'MKT', tif: 'GTC' })],
    rejections: [], warnings: [], llm: llmCloud, __elapsedMs: undefined }, __seed: { similar: { ...similar, count: 0, matches: [], exits: [], lessons: [] } } }],
  ['各种价格', { __payload: { submitted: [
    order('跟踪止损百分比', { ...stk, action: 'SELL', order_type: 'TRAIL', trailing_percent: 1.5 }),
    order('跟踪止损金额', { ...stk, action: 'SELL', order_type: 'TRAIL', aux_price: 2.5 }),
    order('止损', { ...stk, action: 'SELL', order_type: 'STP', aux_price: 190 }),
    order('止损限价', { ...stk, order_type: 'STP LMT', limit_price: 195 }),
    order('没见过的类型', { ...stk, order_type: 'MOC', limit_price: null }),
    order('未知组合', { ...vertical, combo_strategy: 'RATIO', price_mode: 'EXPLICIT', legs: [{ action: 'BUY', ratio: 2, strike: 100, right: 'C' }, { action: 'SELL', ratio: 0, strike: 90, right: 'C' }] }),
    order('单腿看涨现价外', { ...opt, action: 'BUY', right: 'C', strike: 0.5, limit_price: null, order_type: 'MKT' }),
  ], queued: [], validated_only: [], rejections: [], warnings: [] }, __seed: { similarErr: '引擎忙' } }],
  ['拒绝与提示', { __payload: { submitted: [], queued: [], validated_only: [],
    rejections: [
      { source: 'validator', code: 'LIVE_TRADING_DISABLED', message: '实盘下单未开启', original_text: '买 1 股 AAPL', intent_summary: '买入 1 股 AAPL' },
      { source: 'llm', code: 'MISSING_PRICE', message: '没写价格', intent_summary: '买入 SPX 蝴蝶' },
      { source: 'nobody', code: 'SOMETHING_NEW', message: '新原因' },
      { source: 'engine', code: '', message: '无码' },
    ],
    warnings: ['用了默认到期日:当日', '数量默认 1 张'], llm: llmLocal, __elapsedMs: 3 } }],
  ['模型没报用量', { __payload: { submitted: [], queued: [], validated_only: [], rejections: [], warnings: [], llm: { model: 'gpt-x', prompt_version: 'v2', latency_ms: 10 } } }],
  ['什么都没解析出来', { __payload: { submitted: [], queued: [], validated_only: [], rejections: [], warnings: [] } }],
  ['回执里缺了几样', { __payload: {} }],
];
// 「发送」按钮的提示与灰不灰(提示里写着发不出去的原因——熔断、没连、自动执行没开;这几样不进页面的字,单拎出来对)
const sendOf = (html) => {
  const m = html.match(/<button[^>]*id="btn-execute"[^>]*>/);
  if (!m) return null;
  const title = m[0].match(/title="([^"]*)"/);
  return { title: title ? title[1].replace(/&amp;/g, '&') : null, disabled: /\sdisabled=""/.test(m[0]), warn: /btn-warn/.test(m[0]) };
};
const pages = [];
const payoffs = [];
for (const [name, o] of pageScenarios) {
  const { __seed, __picked, __pending, __payload, __text, ...methods } = o;
  globalThis.__ssrSeed = __seed || {};
  overrides = {};
  page.trade.setTradeDraft('');
  page.trade.setTradePane('result');
  // 上一场勾的账户清掉,回到"没存过勾选"(store 里只有 savePickedAccounts 一个写口,它写不出 null)
  (globalThis.__zustandStores || []).find((st) => 'picked' in st.getState()).setState({ picked: null });
  overrides = methods;
  await page.seedStatus(await window.dafri.status().catch(() => null));
  await page.seedLlm();
  if (__picked) page.trade.savePickedAccounts(__picked);
  let release = null;
  if (__pending !== undefined) {
    page.trade.setInstruction(__text);
    overrides = { ...methods, confirm: async () => true, submit: () => new Promise((r) => { release = r; }) };
    void page.trade.submitInstruction(__pending, ['模拟']);
    await new Promise((r) => setTimeout(r, 0));
  } else if (__payload !== undefined) {
    page.trade.setInstruction('某条指令');
    overrides = { ...methods, submit: async () => {
      if (typeof __payload === 'string') throw new Error(__payload.slice(6));
      return JSON.parse(JSON.stringify(__payload));
    } };
    clock = [0, 2410.6];
    await page.trade.submitInstruction(false, ['模拟']);
  }
  const html = page.renderTradePage();
  const snap = JSON.parse(JSON.stringify(page.snapshot()));
  // 大模型目录读不到时 store/llm 留着上一份:所以从 store 里取,不另问一遍
  const reg = globalThis.__zustandStores || [];
  const llmNow = reg.find((st) => 'catalog' in st.getState()).getState().catalog;
  const savedPicked = reg.find((st) => 'picked' in st.getState()).getState().picked;
  const usableNow = (snap.status?.accounts || []).filter((a) => (a.broker || 'ibkr') === (snap.status?.broker_provider || 'ibkr'));
  pages.push({ name, overrides: Object.keys(methods), seed: __seed || {}, savedPicked, pickedNow: page.trade.selectedAccounts(usableNow), status: snap.status, llm: JSON.parse(JSON.stringify(llmNow)),
    composer: JSON.parse(JSON.stringify(page.trade.useComposer())), texts: texts(html), send: sendOf(html) });
  // 损益图:每张票据一组 SVG 路径与刻度
  for (const m of html.matchAll(/<svg class="payoff"[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg><div class="payoff-axis"[^>]*>([\s\S]*?)<\/div>/g)) {
    const paths = [...m[2].matchAll(/<path d="([^"]+)"/g)].map((x) => x[1]);
    const lines = [...m[2].matchAll(/<line ([^>]+?)\/?>/g)].map((x) => Object.fromEntries([...x[1].matchAll(/(x1|y1|x2|y2|stroke)="([^"]+)"/g)].map((y) => [y[1], y[2]])));
    const axis = [...m[3].matchAll(/<span(?: class="(\w+)")? style="left:([^"]+)">([\s\S]*?)<\/span>/g)].map((x) => ({ cls: x[1] || '', left: x[2], text: x[3].replace(/<!-- -->/g, '') }));
    payoffs.push({ scenario: name, viewBox: m[1], paths, lines, axis });
  }
  if (release) {
    release(JSON.parse(JSON.stringify(okPayload)));
    await new Promise((r) => setTimeout(r, 0));
  }
}
// 损益图的对照另外直接喂 PayoffChart 的入参(票据之外:带现价、现价太远、只有一个行权价、权利金……)
const payoffInputs = [
  { legs: [{ sign: 1, right: 'C', strike: 7520 }, { sign: -1, right: 'C', strike: 7550 }], premium: 12.5, spot: 7531.2 },
  { legs: [{ sign: 1, right: 'P', strike: 7600 }, { sign: -1, right: 'P', strike: 7615, ratio: 2 }, { sign: 1, right: 'P', strike: 7630 }], premium: 1.8, spot: 7400 },
  { legs: [{ sign: 1, right: 'P', strike: 7600 }, { sign: -1, right: 'P', strike: 7615, ratio: 2 }, { sign: 1, right: 'P', strike: 7630 }], premium: null, spot: 9000 },
  { legs: [{ sign: -1, right: 'P', strike: 180 }], premium: -3.4, spot: 176 },
  { legs: [{ sign: 1, right: 'C', strike: 10 }], premium: 0.35, spot: null },
  { legs: [{ sign: 1, right: 'C', strike: 0.5 }], premium: null, spot: 0.52 },
  { legs: [{ sign: 1, right: 'C', strike: 100, ratio: 2 }, { sign: -1, right: 'C', strike: 90, ratio: 0 }], premium: -0.004, spot: 95 },
  { legs: [{ sign: 1, right: 'C', strike: 50 }, { sign: 1, right: 'P', strike: 50 }], premium: 4, spot: 50 },
];
for (const input of payoffInputs) {
  const html = page.renderPayoff(input);
  const m = html.match(/<svg class="payoff"[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg><div class="payoff-axis"[^>]*>([\s\S]*?)<\/div>/);
  const paths = [...m[2].matchAll(/<path d="([^"]+)"/g)].map((x) => x[1]);
  const lines = [...m[2].matchAll(/<line ([^>]+?)\/?>/g)].map((x) => Object.fromEntries([...x[1].matchAll(/(x1|y1|x2|y2|stroke)="([^"]+)"/g)].map((y) => [y[1], y[2]])));
  const axis = [...m[3].matchAll(/<span(?: class="(\w+)")? style="left:([^"]+)">([\s\S]*?)<\/span>/g)].map((x) => ({ cls: x[1] || '', left: x[2], text: x[3].replace(/<!-- -->/g, '') }));
  payoffs.push({ input, viewBox: m[1], paths, lines, axis });
}

writeFileSync(join(here, 'trade-page.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_trade_page.mjs',
  labels: { REJECT_CODE_LABEL: labels.REJECT_CODE_LABEL, REJECT_SOURCE_LABEL: labels.REJECT_SOURCE_LABEL }, actions, appends, picks: pickCases, stored, pages, payoffs }, null, 2) + '\n');
console.log(`trade-page.json: ${actions.length} 个提交场景、${pickCases.length + stored.length} 个勾选场景、${pages.length} 个页面场景、${payoffs.length} 张损益图`);
