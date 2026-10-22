// 生成 fly-plan.json:交易指令页右栏的「蝴蝶测算」与「日内剧本」两面(desktop/renderer-react/src/lib/FlyPlanner.tsx、FlyPlanResult.tsx、
// FlyPlanChart.tsx、FlySpot.tsx、EventWarning.tsx、flyPlanForm.ts、store/flyPlan.ts、lib/PlaybookPanel.tsx)。
//   · form:flyPlanForm.ts 的纯函数直接跑(formProblems / toParams / etClock / minutesFromNow / instructionFor / 几个格式);toParams 的结果过引擎的
//     zod schema(options.fly_plan 是 .strict() 的——它只算不下单,但入参多一个键引擎当场拒);
//   · store:store/flyPlan.ts 的原函数(打进 SSR 包里的那一份)真跑:测算、自动刷新那一路(quiet)、失败、重置、记录器开关,每一步之后的状态;
//   · pages:SSR 渲染 FlyPlanner / PlaybookPanel 抽字(同 gen_trade_page.mjs),外加盈亏曲线的 SVG 路径、线、标签。
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_fly_plan.mjs <装好依赖的 desktop 目录>  [ENGINE_MODULES=…]
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
if (process.env.TZ !== 'Asia/Shanghai') throw new Error('本机时间的写法进了页面(算于 … / 本地时间 …):要 TZ=Asia/Shanghai 跑');
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
const { FlyPlanParamsSchema } = await import(join(repo, 'engine-ts/src/contract/schema/options.ts'));
const F = await import(join(repo, 'desktop/renderer-react/src/lib/flyPlanForm.ts'));

// 时钟钉死:2026-09-28 14:12 美东(= 18:12Z),和预览台 mock 的那一份测算结果同一天
const NOW = Date.UTC(2026, 8, 28, 18, 12, 30);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.performance.now = () => 0;

const out = mkdtempSync(join(tmpdir(), 'ssr-'));
execFileSync(process.execPath, [join(here, 'ssr/build.mjs'), desktop, out], { stdio: 'inherit' });

// ---- 1. flyPlanForm.ts 的纯函数 ----------------------------------------------------------------
const base = { ...F.EMPTY_FORM };
const forms = {
  '空表单': base,
  '只填中心': { ...base, center: '7750' },
  '齐了': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30' },
  '齐了,全填': { ...base, center: '7750', width: '25', right: 'C', quantity: '2', cost: '5.5', targetSpot: '7745', targetTime: '14:30', targetDate: '2026-09-28', expiry: '2026-09-28', spot: '7718.4', iv: '18', ivMode: 'shift', ivShiftPct: '+30' },
  '不是数字': { ...base, center: 'abc', width: 'x', targetSpot: '7,745', targetTime: '14:30', quantity: '1.5', cost: '-1', spot: '0', iv: '600' },
  '中心不大于翼宽': { ...base, center: '20', width: '25', targetSpot: '7745', targetTime: '14:30' },
  '中心正好等于翼宽': { ...base, center: '25', width: '25', targetSpot: '7745', targetTime: '14:30' },
  '成本超翼宽': { ...base, center: '7750', width: '25', cost: '25', targetSpot: '7745', targetTime: '14:30' },
  '时刻格式': { ...base, center: '7750', targetSpot: '7745', targetTime: '2:30pm', targetDate: '9/28', expiry: '20260928' },
  '时刻 24:00': { ...base, center: '7750', targetSpot: '7745', targetTime: '24:00' },
  '时刻 9:05': { ...base, center: '7750', targetSpot: '7745', targetTime: ' 9:05 ' },
  'IV 变化没填': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30', ivMode: 'shift' },
  'IV 变化 -100': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30', ivMode: 'shift', ivShiftPct: '-100' },
  '张数 0': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30', quantity: '0' },
  '空白当留空': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30', quantity: '  ', cost: '\t', iv: '' },
  '到期日带横线': { ...base, center: '7750', targetSpot: '7745', targetTime: '14:30', expiry: '2026-10-03', targetDate: ' 2026-10-03 ' },
  '看跌 flat': { ...base, center: '7700', right: 'P', targetSpot: '7690', targetTime: '15:45', ivMode: 'flat' },
};
const form = Object.entries(forms).map(([name, f]) => {
  const problems = F.formProblems(f);
  let params = null, schema = null;
  if (!problems.length) {
    params = F.toParams(f);
    const r = FlyPlanParamsSchema.safeParse(params);
    schema = r.success ? 'ok' : r.error.issues.map((i) => i.message).join(';');
  }
  return { name, form: f, problems, params, schema, key: F.formKey ? F.formKey(f) : JSON.stringify(f) };
});
const clocks = [NOW, Date.UTC(2026, 8, 28, 13, 29, 59), Date.UTC(2026, 8, 28, 19, 31), Date.UTC(2026, 8, 28, 20, 0), Date.UTC(2026, 8, 29, 3, 59), Date.UTC(2026, 10, 2, 5, 30), Date.UTC(2026, 10, 2, 6, 30), Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 2, 8, 7, 30)]
  .map((ms) => ({ ms, clock: F.etClock(ms), chips: [30, 60, 120].map((m) => F.minutesFromNow(ms, m)) }));
const hhmm = [-5, 0, 59.4, 59.5, 600, 16 * 60, 23 * 60 + 59, 24 * 60 + 10].map((m) => ({ m, text: F.hhmm(m) }));
const mockFly = (await (async () => {
  // 预览台的 mock 在一个沙箱里跑,拿它的 window.dafri
  const w = { localStorage: undefined, addEventListener() {}, setTimeout, clearTimeout };
  const sandbox = { window: w, console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  w.window = w;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(repo, 'desktop/tools/mock-bridge.js'), 'utf8'), sandbox);
  return w.dafri;
})());
const flyResult = await mockFly.flyPlan();
const instr = [
  ['当日', flyResult, '2026-09-28'],
  ['明天(周一)', { ...flyResult, expiry: '20260928' }, '2026-09-25'],
  ['明天(周二)', { ...flyResult, expiry: '20260929' }, '2026-09-28'],
  ['别的日子', { ...flyResult, expiry: '20261003' }, '2026-09-28'],
  ['看跌、带小数', { ...flyResult, right: 'P', center: 7750.5, width: 12.5, cost: 1.125, quantity: 3, lower: 7738, upper: 7763 }, '2026-09-28'],
  ['成本整数', { ...flyResult, cost: 5, expiry: '20261231' }, '2026-09-28'],
  ['跨年周末', { ...flyResult, expiry: '20270104' }, '2027-01-01'],
].map(([name, r, today]) => ({ name, r: { symbol: r.symbol, expiry: r.expiry, right: r.right, center: r.center, width: r.width, cost: r.cost, quantity: r.quantity, lower: r.lower, upper: r.upper }, today, text: F.instructionFor(r, today) }));
const fmt = {
  signedUsd: [1638, -1100, 0, 0.4, -0.5, 2900.5, 1234567].map((v) => [v, F.signedUsd(v)]),
  signedPct: [148.9, -5.5, 0, 0.04, -0.05, 263.64].map((v) => [v, F.signedPct(v), F.signedPct(v, 0)]),
  pct: [0.158, 0.1493, 0, 1, 0.00049].map((v) => [v, F.pct(v)]),
  labels: { PACE_LABEL: F.PACE_LABEL, IV_SOURCE_LABEL: F.IV_SOURCE_LABEL, COST_SOURCE_LABEL: F.COST_SOURCE_LABEL },
};

// ---- 2. store/flyPlan.ts 真跑 ------------------------------------------------------------------
let overrides = {};
let calls = [];
const store = new Map();
globalThis.window = {
  dafri: new Proxy({}, {
    get: (_t, name) => async (...args) => {
      if (['flyPlan', 'ivRecorder', 'setIvRecorder', 'indexSpot', 'playbook', 'listEvents'].includes(name)) calls.push({ call: name, args: JSON.parse(JSON.stringify(args)) });
      const fn = overrides[name] ?? mockFly[name];
      return fn ? fn(...args) : {};
    },
  }),
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (f) => setTimeout(f, 0),
};
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
const bundle = pathToFileURL(join(out, 'entry.mjs')).href;
const ui = await import(bundle);
const flyApi = () => (globalThis.__zustandStores || []).find((s) => 'plan' in s.getState());
const snapFly = () => JSON.parse(JSON.stringify(flyApi().getState().plan));
const texts = (html) => html
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const good = forms['齐了'];
const storeScenarios = [
  ['表单没齐就按测算', { form: forms['只填中心'], quiet: false, result: flyResult }],
  ['表单没齐、自动刷新那一路', { form: forms['只填中心'], quiet: true, auto: true, result: flyResult }],
  ['测算', { form: good, quiet: false, result: flyResult }],
  ['测算失败', { form: good, quiet: false, result: 'throw:现价拿不到' }],
  ['自动刷新成功', { form: good, quiet: true, auto: true, pre: flyResult, result: { ...flyResult, cost: 5.6 } }],
  ['自动刷新失败:留着上次的结果、关掉自动', { form: good, quiet: true, auto: true, pre: flyResult, result: 'throw:引擎忙' }],
  ['忙着时再按', { form: good, quiet: false, result: flyResult, busy: true }],
];
const storeCases = [];
for (const [name, sc] of storeScenarios) {
  ui.fly.resetFlyPlan();
  ui.fly.patchFlyForm(sc.form);
  overrides = { flyPlan: async () => (typeof sc.pre === 'string' ? Promise.reject(new Error(sc.pre.slice(6))) : JSON.parse(JSON.stringify(sc.pre))) };
  if (sc.pre) await ui.fly.runFlyPlan(false);
  if (sc.auto) flyApi().setState({ plan: { ...flyApi().getState().plan, auto: true } });
  overrides = { flyPlan: async () => { if (typeof sc.result === 'string') throw new Error(sc.result.slice(6)); return JSON.parse(JSON.stringify(sc.result)); } };
  calls = [];
  const states = [];
  const unsub = flyApi().subscribe((s) => states.push(JSON.parse(JSON.stringify(s.plan))));
  const before = snapFly();
  let during = null;
  if (sc.busy) {
    let release;
    overrides = { flyPlan: () => new Promise((r) => { release = () => r(JSON.parse(JSON.stringify(sc.result))); }) };
    const first = ui.fly.runFlyPlan(false);
    await new Promise((r) => setTimeout(r, 0));
    during = snapFly();
    await ui.fly.runFlyPlan(false);
    release();
    await first;
  } else {
    await ui.fly.runFlyPlan(sc.quiet);
  }
  unsub();
  // 流水拷一份:后面的场景还往 calls 那个数组里记
  storeCases.push({ name, form: sc.form, quiet: !!sc.quiet, autoBefore: !!sc.auto, pre: sc.pre ?? null, result: sc.result, before, during, calls: [...calls], states, after: snapFly() });
}
// 记录器:读、开、关、失败
const recorderCases = [];
for (const [name, read, set] of [['读到', flyResult && (await mockFly.ivRecorder()), null], ['读不到', 'throw:引擎没起来', null], ['关掉', null, { ...(await mockFly.ivRecorder()), enabled: false, running: false, idle_reason: '已关闭' }], ['关不掉', null, 'throw:引擎忙']]) {
  flyApi().setState({ plan: { ...flyApi().getState().plan, recorder: null } });
  overrides = { ivRecorder: async () => { if (typeof read === 'string') throw new Error(read.slice(6)); return read; },
    setIvRecorder: async () => { if (typeof set === 'string') throw new Error(set.slice(6)); return set; } };
  calls = [];
  let failed = null;
  if (read !== null) await ui.fly.loadIvRecorder();
  if (set !== null) failed = await ui.fly.setIvRecorder(false);
  recorderCases.push({ name, read, set, calls: [...calls], failed, recorder: snapFly().recorder });
}
// 清空、改表单后结果过期的键
ui.fly.resetFlyPlan();
const resetState = snapFly();

// ---- 3. 整面 ---------------------------------------------------------------------------------------
const status = await mockFly.status();
const spotQuote = await mockFly.indexSpot('SPX');
const playbookSnap = await mockFly.playbook();
const recorder = await mockFly.ivRecorder();
const S = (o) => async () => ({ ...status, ...o });
const stale = { ...spotQuote, source: 'stale', note: '休市:这是昨收' };
const flyScenarios = [
  ['空表单', {}],
  ['没连券商', { status: S({ broker_connected: false }) }],
  ['现价读不到', { indexSpot: async () => { throw new Error('不回话'); } }],
  ['现价是期货推算', { indexSpot: async () => ({ ...spotQuote, source: 'futures', note: '夜盘按 ES 推算' }) }],
  ['现价不是现价', { indexSpot: async () => stale }],
  ['现价没有', { indexSpot: async () => ({ ...spotQuote, price: null, note: '没有报价' }) }],
  ['填了一半', { __form: forms['只填中心'] }],
  ['填错了', { __form: forms['不是数字'] }],
  ['可以测算', { __form: good }],
  ['正在测算', { __form: good, __busy: true }],
  ['算不出来', { __form: good, __run: 'throw:现价拿不到' }],
  ['有结果', { __form: good, __run: flyResult }],
  ['有结果、表单改过', { __form: good, __run: flyResult, __then: { targetSpot: '7760' } }],
  ['有结果、刷新失败', { __form: good, __run: flyResult, __failAfter: '引擎忙' }],
  ['有结果、自动刷新', { __form: good, __run: flyResult, __auto: true }],
  // 开着自动刷新、这一轮正在算:「测算」不转圈(busy && !auto)
  ['自动刷新这一轮正在算', { __form: good, __run: flyResult, __auto: true, __busyAfter: true }],
  ['手动测算正在算(已有结果)', { __form: good, __run: flyResult, __busyAfter: true }],
  ['IV 不变', { __form: { ...good, ivMode: 'flat' }, __run: { ...flyResult, iv: { ...flyResult.iv, mode: 'flat', change_pct: 0, at_target: flyResult.iv.now, range: null }, target_range: null } }],
  ['自己填的 IV 与现价', { __form: { ...good, ivMode: 'shift', ivShiftPct: '30', spot: '7718', iv: '18' }, __run: { ...flyResult, spot_source: 'input', cost_source: 'mid', iv: { ...flyResult.iv, source: 'input', mode: 'shift', change_pct: 30, seasonal_pct: 0, move_pct: 0, range: null, model: null }, market: { bid: null, mid: null, ask: null }, anchored: false, target_range: null, warnings: [], spot_note: '手动现价,不取行情' } }],
  ['看跌、亏钱、没有盈亏平衡', { __form: { ...good, right: 'P' }, __run: { ...flyResult, right: 'P', target: { ...flyResult.target, pnl: -320, pnl_pct: -29.1, value: 3.9 }, target_flat: { value: 3.8, pnl: -340, pnl_pct: -30.9 }, breakeven: { low: null, high: null }, peak: { ...flyResult.peak, value: 4.2 }, move: { ...flyResult.move, direction: 'down', points: -12, sigmas: null, pace: 'sharp', day_sigmas: -0.34 }, cost_source: 'model', timeline: [flyResult.timeline[0]], iv: { ...flyResult.iv, source: 'quote', model: { ...flyResult.iv.model, own: true, proxy: '' } } } }],
  ['不动、半边盈亏平衡', { __form: good, __run: { ...flyResult, target: { ...flyResult.target, pnl: 0, pnl_pct: 0 }, breakeven: { low: 7724.4, high: null }, move: { ...flyResult.move, direction: 'flat', points: 0, pace: 'brisk', minutes: 60 }, iv: { ...flyResult.iv, seasonal_pct: 0.01, move_pct: -0.02, change_pct: -0.01 } } }],
  // 「动没动」的边界:正好 0.05 算动了(>=),时段与走势同理
  ['IV 正好动了 0.05', { __form: good, __run: { ...flyResult, iv: { ...flyResult.iv, change_pct: 0.05, seasonal_pct: 0.05, move_pct: -0.04 }, scenarios: [{ ...flyResult.scenarios[0], iv_change_pct: 0.05 }, { ...flyResult.scenarios[1], iv_change_pct: -0.0499 }] } }],
  ['IV 差一点没动', { __form: good, __run: { ...flyResult, iv: { ...flyResult.iv, change_pct: -0.0499 } } }],
  ['走了很久', { __form: good, __run: { ...flyResult, move: { ...flyResult.move, minutes: 125 }, warnings: [] } }],
  ['展开「更多」', { __more: true, __form: { ...good, ivMode: 'shift', ivShiftPct: '30' } }],
  ['记录器:没读到', { __more: true, __form: good, __recorder: 'throw:x' }],
  ['记录器:关着、有错', { __more: true, __recorder: { ...recorder, enabled: false, running: false, samples: 0, days: 0, first_date: null, idle_reason: '已关闭', last_error: '订阅失败' } }],
  ['记录器:开着没在记', { __more: true, __recorder: { ...recorder, idle_reason: '不在常规交易时段' } }],
  ['事件提醒:没有事件', { listEvents: async () => ({ events: [], config: { enabled: true, lead_minutes: [] }, status: 'ok' }) }],
  ['事件提醒:关着', { listEvents: async () => ({ ...(await mockFly.listEvents()), config: { ...(await mockFly.listEvents()).config, enabled: false } }) }],
];
const pages = [];
const charts = [];
const extract = (html) => {
  const m = html.match(/<div class="fly-chart-plot"><svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg><div class="fly-chart-labels"[^>]*>([\s\S]*?)<\/div><\/div>/);
  if (!m) return null;
  const paths = [...m[2].matchAll(/<path d="([^"]+)"[^>]*stroke="([^"]*)"/g)].map((x) => ({ d: x[1], stroke: x[2] }));
  const areas = [...m[2].matchAll(/<path d="([^"]+)" fill="var\(--(up|down)\)"/g)].map((x) => ({ d: x[1], fill: x[2] }));
  const lines = [...m[2].matchAll(/<line ([^>]+?)\/?>/g)].map((x) => Object.fromEntries([...x[1].matchAll(/(x1|y1|x2|y2|stroke)="([^"]+)"/g)].map((y) => [y[1], y[2]])));
  const labels = [...m[3].matchAll(/<span class="([^"]+)" style="([^"]+)">([\s\S]*?)<\/span>/g)].map((x) => ({ cls: x[1], style: x[2], text: x[3].replace(/<!-- -->/g, '') }));
  return { viewBox: m[1], areas, paths, lines, labels };
};
for (const [name, o] of flyScenarios) {
  const { __form, __busy, __run, __then, __failAfter, __auto, __recorder, __more, __busyAfter, ...methods } = o;
  overrides = {};
  // 参考资料「更多」折着时里面的字不渲染:要看记录器那一行的场景先把它记成展开(Primer 读 localStorage 的 dafri-primer-fly-more)
  if (__more) store.set('dafri-primer-fly-more', '1');
  else store.delete('dafri-primer-fly-more');
  ui.fly.resetFlyPlan();
  flyApi().setState({ plan: { ...flyApi().getState().plan, recorder: null } });
  overrides = { ...methods, ivRecorder: async () => { if (typeof __recorder === 'string') throw new Error(__recorder.slice(6)); return __recorder ?? recorder; } };
  await ui.seedStatus(await window.dafri.status().catch(() => null));
  await ui.seedPanels();
  await ui.fly.loadIvRecorder();
  if (__form) ui.fly.patchFlyForm(__form);
  let release = null;
  if (__busy) {
    overrides = { ...overrides, flyPlan: () => new Promise((r) => { release = r; }) };
    void ui.fly.runFlyPlan(false);
    await new Promise((r) => setTimeout(r, 0));
  } else if (__run !== undefined) {
    overrides = { ...overrides, flyPlan: async () => { if (typeof __run === 'string') throw new Error(__run.slice(6)); return JSON.parse(JSON.stringify(__run)); } };
    await ui.fly.runFlyPlan(false);
    if (__failAfter) {
      overrides = { ...overrides, flyPlan: async () => { throw new Error(__failAfter); } };
      flyApi().setState({ plan: { ...flyApi().getState().plan, auto: true } });
      await ui.fly.runFlyPlan(true);
    }
    if (__auto) flyApi().setState({ plan: { ...flyApi().getState().plan, auto: true } });
  }
  if (__then) ui.fly.patchFlyForm(__then);
  if (__busyAfter) {
    overrides = { ...overrides, flyPlan: () => new Promise((r) => { release = r; }) };
    void ui.fly.runFlyPlan(!!__auto);
    await new Promise((r) => setTimeout(r, 0));
  }
  const html = ui.renderFlyPlanner();
  const snap = JSON.parse(JSON.stringify(ui.panelSnapshot()));
  // 「测算」按钮转没转圈(这一面只有它会转)
  pages.push({ name, more: !!__more, runLoading: html.includes('ant-btn-loading'), overrides: Object.keys(methods), fly: snap.fly, spot: snap.spot, events: { list: snap.events.list, now: snap.events.now }, status: snap.status, texts: texts(html) });
  const chart = extract(html);
  if (chart) charts.push({ scenario: name, result: snap.fly.result, ...chart });
  if (release) { release(JSON.parse(JSON.stringify(flyResult))); await new Promise((r) => setTimeout(r, 0)); }
}
// 日内剧本那一面
const pb = playbookSnap;
const playbookScenarios = [
  ['预览台的数据', {}],
  ['还没读到', { __none: true }],
  ['读不到', { __none: true, playbook: async () => { throw new Error('引擎忙'); } }],
  ['没连券商', { status: S({ broker_connected: false }) }],
  ['没在跑', { playbook: async () => ({ ...pb, running: false, enabled: false, idle_reason: '已关闭', price: null }) }],
  ['B2 进行中', { playbook: async () => ({ ...pb, state: 'B2', since: pb.price_at - 600000, trigger: 7700, t1: 7712, t2: 7725 }) }],
  ['B3 进行中、没有 T2', { playbook: async () => ({ ...pb, state: 'B3', since: pb.price_at - 60000, trigger: 7730, t1: 7705, t2: null }) }],
  ['B2 失效过', { playbook: async () => ({ ...pb, b2_lost: pb.price_at - 300000 }) }],
  ['没有期权墙、有备注与错', { playbook: async () => ({ ...pb, wall: null, accel: null, notes: ['盘初定价缺', '昨日定价是补的'], last_error: '取跨式超时' }) }],
  ['没有事件', { playbook: async () => ({ ...pb, events: [] }) }],
  ['提醒关着', { __alert: false }],
];
const playbookPages = [];
for (const [name, o] of playbookScenarios) {
  const { __none, __alert, ...methods } = o;
  const pbApi = (globalThis.__zustandStores || []).find((s) => 'playbook' in s.getState());
  pbApi.setState({ playbook: { ...pbApi.getState().playbook, snap: null, failure: null, alertOn: __alert ?? true } });
  overrides = __none ? { ...methods, playbook: methods.playbook ?? (async () => { throw new Error('skip'); }) } : methods;
  await ui.seedStatus(await window.dafri.status().catch(() => null));
  if (!__none || methods.playbook) await ui.seedPanels().catch(() => undefined);
  if (__none && !methods.playbook) pbApi.setState({ playbook: { ...pbApi.getState().playbook, snap: null, failure: null } });
  const snap = JSON.parse(JSON.stringify(ui.panelSnapshot()));
  playbookPages.push({ name, playbook: snap.playbook, status: snap.status, texts: texts(ui.renderPlaybookPanel()) });
}

writeFileSync(join(here, 'fly-plan.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_fly_plan.mjs', now: NOW, form, clocks, hhmm, instr, fmt, store: storeCases, recorder: recorderCases, reset: resetState, pages, charts, playbook: playbookPages }, null, 2) + '\n');
console.log(`fly-plan.json: ${form.length} 份表单、${storeCases.length} 个 store 场景、${pages.length} 面蝴蝶测算、${charts.length} 张曲线、${playbookPages.length} 面日内剧本`);
