// 生成 svc_events.json:engine-ts 的 services/events.ts(原模块现跑)对着脚本驱动的假取数器 / 假 router、真的交易库(偏好表)、虚拟钟:
// 口径与自定义事件的读写、日历源的陈旧即返与单飞、清单合并与筛选、跨市场窗口里的判断。C++ 一半:tests/tst_svc_events.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_events.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeFetcher, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { EventsService } = await mods.imp('services/events');
const macro = await mods.imp('macro');
const cross = await mods.imp('crossMarket');

function build(world, host) {
  macro.clearMacroCache();
  const svc = new EventsService(host, makeFetcher(world));
  return {
    methods: {
      list: (a) => svc.list(a.force),
      setConfig: (a) => svc.setConfig(a.input),
      config: () => svc.config(),
      add: (a) => svc.add(a.params),
      remove: (a) => svc.remove(a.id),
    },
    gets: { config: () => svc.config() },
    ops: {},
  };
}

const ET = (iso) => Date.parse(iso);
const START = ET('2026-10-12T10:30:00-04:00');
const START_CROSS = ET('2026-10-12T19:40:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const E = (error, extra = {}) => ({ error, ...extra });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log', 'app_prefs'], ...script } });

const ffItem = (title, date, impact, forecast = '', previous = '', country = 'USD') => ({ title, country, date, impact, forecast, previous });
const FEED = [
  ffItem('CPI m/m', '2026-10-14T08:30:00-04:00', 'High', '0.3%', '0.2%'),
  ffItem('Core CPI m/m', '2026-10-14T08:30:00-04:00', 'High', '0.3%', '0.3%'),
  ffItem('FOMC Member Waller Speaks', '2026-10-13T12:00:00-04:00', 'Medium'),
  ffItem('Unemployment Claims', '2026-10-15T08:30:00-04:00', 'Medium', '230K', '225K'),
  ffItem('German Factory Orders', '2026-10-13T02:00:00-04:00', 'High', '', '', 'EUR'),
  ffItem('Some Low Thing', '2026-10-13T10:00:00-04:00', 'Low'),
  ffItem('Fed Chair Powell Speaks', '2026-10-16T13:00:00-04:00', 'High'),
  ffItem('', '2026-10-16T13:00:00-04:00', 'High'),
  ffItem('Bad Date', 'not a date', 'High'),
  ffItem('Bank Holiday', '2026-10-13T00:00:00-04:00', 'Holiday'),
];
const ROUTER_QUOTES = (spx, etf) => ({
  streamQuotes: [R({ 'IND:SPX@CBOE': { last: 7650, change_pct: spx }, 'IND:VIX@CBOE': { last: 21, change_pct: 8.1 } })],
  stockQuotes: [R(Object.fromEntries(cross.CROSS_SYMBOLS.map((s, i) => [s, { last: 20 + i, change_pct: etf[i % etf.length] }])))],
});

add('list:默认口径、日历源第一次同步等、内置日程合并、再问走缓存;四小时后陈旧即返后台刷新', {
  fetch: { feed: [R(FEED), R(FEED.slice(0, 3), { delay: 300 })] },
  steps: [call('a', 'list'), call('b', 'list'), { op: 'advance', ms: 4 * 3600_000 }, call('c', 'list'), { op: 'advance', ms: 400 }, call('d', 'list'), call('e', 'list', { force: true }), { op: 'advance', ms: 400 }],
});
add('list:日历源挂了(错误 / 非清单 / 慢),半小时后再试;从没拉到过的每次先看节流', {
  fetch: { feed: [E('日历源返回 HTTP 503'), R({ not: 'a list' }), R(FEED, { delay: 9000 }), R(FEED)] },
  steps: [call('a', 'list'), call('b', 'list'), { op: 'advance', ms: 30 * 60_000 }, call('c', 'list'), { op: 'advance', ms: 30 * 60_000 }, call('d', 'list'), { op: 'advance', ms: 9100 }, call('e', 'list'), { op: 'advance', ms: 30 * 60_000 }, call('f', 'list')],
});
add('list:并发两次问只拉一次(单飞)', {
  fetch: { feed: [R(FEED, { delay: 200 })] },
  steps: [call('a', 'list'), call('b', 'list', { force: true }), { op: 'advance', ms: 250 }, call('c', 'list')],
});
add('list:功能关着一条都不给也不拉;feed 关着不拉日历源;最低星级筛(自己记的不筛)', {
  fetch: { feed: [R(FEED)] },
  steps: [call('add', 'add', { params: { title: '自己的事', date_et: '2026-10-13', time_et: '10:00', impact: 'medium' } }),
    call('s1', 'setConfig', { input: { feed: false } }), call('a', 'list'),
    call('s2', 'setConfig', { input: { min_stars: 2, feed: true } }), call('b', 'list'),
    call('s3', 'setConfig', { input: { enabled: false } }), call('c', 'list'), call('d', 'list', { force: true })],
});
add('setConfig / config:在当前口径上合并;不合法的报原话;偏好表里存坏了按默认', {
  steps: [call('c0', 'config'), call('s1', 'setConfig', { input: { min_stars: 3, lead_minutes: [30, 10, 5] } }), call('s2', 'setConfig', { input: { min_stars: 9 } }), call('s3', 'setConfig', { input: { lead_minutes: [1, 2, 3, 4, 5] } }),
    call('s4', 'setConfig', { input: null }), call('s5', 'setConfig', { input: { cross_market_pct: 'x' } }), call('s6', 'setConfig', { input: { medium: true } }), call('c1', 'config'),
    st('setPref', ['events_config', { min_stars: 99 }]), call('c2', 'config'), st('setPref', ['events_config', 'garbage']), call('c3', 'config')],
});
add('add / remove:校验各条的原话;id 来自虚拟时钟与固定随机;最多 50 条;删不存在的 false', {
  steps: [call('a1', 'add', { params: { title: '  CPI 前夜  ', date_et: ' 2026-10-13 ', time_et: ' 20:00 ', note: '  记一下  ' } }),
    call('a2', 'add', { params: { title: '', date_et: '2026-10-13', time_et: '20:00' } }),
    call('a3', 'add', { params: { title: 'x', date_et: '2026-13-13', time_et: '20:00' } }),
    call('a4', 'add', { params: { title: 'x', date_et: '2026-10-13', time_et: '25:00' } }),
    call('a5', 'add', { params: { title: 'x'.repeat(100), date_et: '2026-10-13', time_et: '20:00', linger_min: 4 } }),
    call('a6', 'add', { params: { title: 'y', date_et: '2026-10-13', time_et: '20:00', linger_min: 1441 } }),
    call('a7', 'add', { params: { title: 'z', date_et: '2026-10-14', time_et: '08:30', linger_min: 29.5, impact: 'medium', note: 'n'.repeat(250) } }),
    call('a8', 'add', { params: { title: 'w', date_et: '2026-10-14', time_et: '08:30', linger_min: '__NaN__' } }),
    call('l', 'list'), call('r1', 'remove', { id: 'nope' }), call('r2', 'remove', { id: 'custom:x' }),
    st('setPref', ['events_custom', [{ id: 'custom:bad1', title: 'ok', date_et: '2026-10-13', time_et: '09:00' }, 5, null, [], { id: 1 }, { id: 'c2', title: 't', date_et: 'x', time_et: 'y', linger_min: 'z', impact: 'medium', note: 3 }]]),
    call('l2', 'list'), call('r3', 'remove', { id: 'custom:bad1' }), call('l3', 'list')],
  fetch: { feed: [R([])] },
});
add('add:满 50 条之后拒', {
  fetch: { feed: [R([])] },
  steps: [st('setPref', ['events_custom', Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, title: `e${i}`, date_et: '2026-10-20', time_et: '09:00', note: '', impact: 'high', linger_min: 90 }))]),
    call('a', 'add', { params: { title: 'x', date_et: '2026-10-13', time_et: '20:00' } }), call('r', 'remove', { id: 'c3' }), call('b', 'add', { params: { title: 'x', date_et: '2026-10-13', time_et: '20:00' } })],
});
add('偏好表里的自定义事件:每个字段单独坏了都不收;窗口边界(昨天起、两周止,含两端)', {
  fetch: { feed: [R([])] },
  steps: [st('setPref', ['events_custom', [
    { id: 'c1', title: 3, date_et: '2026-10-13', time_et: '09:00' }, { id: 'c2', title: 't', date_et: 5, time_et: '09:00' }, { id: 'c3', title: 't', date_et: '2026-10-13', time_et: 9 }, { id: 5, title: 't', date_et: '2026-10-13', time_et: '09:00' },
    { id: 'edge-from', title: '恰好昨天', date_et: '2026-10-11', time_et: '10:30', impact: 'medium' }, { id: 'edge-to', title: '恰好两周后', date_et: '2026-10-26', time_et: '10:30' },
    { id: 'edge-out1', title: '早一分', date_et: '2026-10-11', time_et: '10:29' }, { id: 'edge-out2', title: '晚一分', date_et: '2026-10-26', time_et: '10:31' }]]),
    call('l', 'list')],
});
add('日历源陈旧后刷新失败:恰好半小时才再试', {
  fetch: { feed: [R(FEED), E('挂了'), R(FEED)] },
  steps: [call('a', 'list'), { op: 'advance', ms: 4 * 3600_000 }, call('b', 'list'), { op: 'advance', ms: 100 }, { op: 'advance', ms: 30 * 60_000 - 101 }, call('c', 'list'), { op: 'advance', ms: 1 }, call('d', 'list'), { op: 'advance', ms: 10 }],
});

const CROSS_ON = { cross_market: true, feed: false };
add('跨市场:不在窗口里不判;在窗口里同步判一次(连着券商),一分钟内走缓存,过了后台刷新(判出过事)', {
  start: START_CROSS,
  router: { results: ROUTER_QUOTES(-2.4, [0.1, -0.2, 0.0]) },
  fetch: { feed: [R([])] },
  steps: [call('o0', 'list'), { op: 'port', v: 'make' }, call('o1', 'list'), call('o2', 'list'), { op: 'advance', ms: 59999 }, call('o3', 'list'), { op: 'advance', ms: 2 }, call('o4', 'list'), { op: 'advance', ms: 100 }, call('o5', 'list'),
    { op: 'portSet', set: { results: { streamQuotes: [R({ 'IND:SPX@CBOE': { last: 7700, change_pct: 0.2 } })] } } }, { op: 'advance', ms: 70_000 }, call('o6', 'list'), { op: 'advance', ms: 100 }, call('o7', 'list')],
});
add('跨市场:没连券商走公开源;标普取不到报错原因;ETF 报价缺', {
  start: START_CROSS,
  router: { results: ROUTER_QUOTES(-2.4, [0.1]) },
  fetch: {
    feed: [R([])],
    yahoo: [R({ chart: { result: [{ meta: { regularMarketPrice: 7600, chartPreviousClose: 7800 } }] } }), R({ chart: { result: [{ meta: { regularMarketPrice: 20, chartPreviousClose: 20.1 } }] } })],
    cboe: [E('cboe down')],
  },
  steps: [call('a', 'list'), { op: 'advance', ms: 61000 }, call('b', 'list'), { op: 'port', v: 'make' }, { op: 'portSet', set: { results: { streamQuotes: [R({}), E('stream down')], stockQuotes: [R({ KORU: { last: 20 } }), E('quotes down')] } } },
    { op: 'advance', ms: 61000 }, call('c', 'list'), { op: 'advance', ms: 61000 }, call('d', 'list'), { op: 'advance', ms: 61000 }, call('e', 'list')],
});
add('跨市场:功能关着(cross_market false)清掉旧事件;窗口外清掉', {
  start: START_CROSS,
  router: { results: ROUTER_QUOTES(-2.4, [0.1, -0.2, 0.0]) },
  fetch: { feed: [R([])] },
  steps: [{ op: 'port', v: 'make' }, call('a', 'list'), call('s', 'setConfig', { input: { cross_market: false } }), call('b', 'list'), call('s2', 'setConfig', { input: { cross_market: true } }), { op: 'advance', ms: 20 * 3600_000 }, call('c', 'list')],
});

// ---- 种子固定的随机交错
{
  const r = rng(0xe7e4_7501);
  const feedVariants = () => [R(FEED.filter(() => r.chance(0.7)), r.chance(0.3) ? { delay: r.pick([100, 5000, 9000]) } : {}), E('日历源返回 HTTP 500'), R({ x: 1 }), R(FEED)];
  for (let n = 0; n < 40; n += 1) {
    const start = r.pick([START, START_CROSS, ET('2026-10-12T16:30:00-04:00'), ET('2026-10-13T04:30:00-04:00')]);
    const results = ROUTER_QUOTES(r.pick([-2.4, 0.3, 1.9, null]), [r.pick([0.1, -1.2, 0.0]), r.pick([0.2, -0.1]), 0.0]);
    results.streamQuotes = Array.from({ length: 3 }, () => (r.chance(0.2) ? E('stream down') : results.streamQuotes[0]));
    results.stockQuotes = Array.from({ length: 3 }, () => (r.chance(0.2) ? E('quotes down', r.chance(0.5) ? { kind: 'plain' } : {}) : results.stockQuotes[0]));
    const router = { results };
    const steps = [];
    if (r.chance(0.6)) steps.push({ op: 'port', v: 'make' });
    for (let i = 0; i < 20; i += 1) {
      const p = r.next();
      if (p < 0.30) steps.push(call(`l${i}`, 'list', { force: r.chance(0.2) }));
      else if (p < 0.38) steps.push(call(`s${i}`, 'setConfig', { input: r.pick([{ min_stars: r.pick([1, 3, 4, 5]) }, { feed: r.chance(0.5) }, { cross_market: r.chance(0.7) }, { enabled: r.chance(0.8) }, { cross_market_pct: r.pick([0.5, 1.5, 3]) }, { min_stars: 8 }]) }));
      else if (p < 0.46) steps.push(call(`a${i}`, 'add', { params: { title: r.pick(['事', '大事', '']), date_et: r.pick(['2026-10-13', '2026-10-15', 'x']), time_et: r.pick(['08:30', '20:00', '99:00']), impact: r.pick([undefined, 'medium', 'high']), linger_min: r.pick([undefined, 5, 60, 4]) } }));
      else if (p < 0.50) steps.push(call(`r${i}`, 'remove', { id: r.pick(['nope', 'custom:x']) }));
      else if (p < 0.88) steps.push({ op: 'advance', ms: r.pick([1, 150, 5000, 59999, 60001, 1800001, 4 * 3600_000 + 1]) });
      else if (p < 0.94) steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]) } });
      else steps.push({ op: 'port', v: r.pick(['make', 'null']) });
    }
    scenarios.push({ name: `随机 ${n}`, script: { start, seed: n + 1, dump: ['audit_log', 'app_prefs'], router, fetch: { feed: feedVariants(), yahoo: [E('yahoo 403')], cboe: [E('cboe 403')] }, steps } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
// toString(36) / toString(2) / toString(16) 的对拍:V8 的进制转换算法(add 里生成 id 用)
const radix = [];
{
  const r = rng(0x36_36_36);
  const vals = [0, 0.5, 1 / 3, 1 / 36, 35 / 36, 1 - 2 ** -53, 2 ** -30, 123456789, 1791815400000, 2 ** 53, 2 ** 53 + 2, 2 ** 56, 0.1, 0.9999999999];
  for (let i = 0; i < 1500; i += 1) vals.push(r.next());
  for (let i = 0; i < 300; i += 1) vals.push(r.next() * 10 ** r.int(16));
  for (let i = 0; i < 300; i += 1) vals.push(Math.floor(r.next() * 2 ** 53));
  for (let i = 0; i < 200; i += 1) vals.push(Math.round(r.next() * 1e6) / 1e6 + r.int(1000));
  for (const v of vals) for (const base of [36, 16, 2]) radix.push([v, base, v.toString(base)]);
}
const text = JSON.stringify({ base: BASE_CONFIG, radix, scenarios: out });
writeFileSync(join(here, 'svc_events.json'), text);
console.log(`svc_events.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
