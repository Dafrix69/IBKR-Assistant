// 生成 ib_bars.json:engine-ts 的 ibBars.ts(原模块现跑)。
// 纯函数部分:K 线时间的归一化(各种写法与时区)、各条线开没开着 / 上一次收盘(整周的每个边界前后一分钟,加夏令时切换周)、
// 两条线拼起来、指数按期货推算(随机的几天几根)、取数报错的翻译。
// SessionBars:每个场景是一份脚本(execsupport_world.mjs 的假会话按交易所回 K 线、可带延迟 / 报错 / quoteDelayed),
// 期望是会话上每一次调用(日志)、各步取回的 K 线与它旁边记的两笔(feed / proxy)、夜盘与期货最近一次要不到的原因。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_ib_bars.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, norm, outcome, rng, runToDone, track } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (f) => import(pathToFileURL(join(engine, `dist/src/${f}.js`)).href);
const X = await imp('ibBars');
const C = await imp('ibContracts');
const M = await imp('marketdata');
const TZ = await imp('tz');
const { World, tickerKey } = await loadWorld(engine);
const r = rng(0xb4a2_5e11);

/** 美东墙钟 → 时刻 */
const et = (date, hhmm) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  return TZ.wallToEpoch({ year: y, month: m, day: d, hour, minute, second: 0 }, TZ.ET);
};
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };

const out = { stamp: [], toBar: [], open: [], merge: [], proxy: [], error: [], scenarios: [] };

// ---------------------------------------------------------------- barTimestamp
{
  const dates = ['20261012', '20260101', '20261231', '20260229', '20261301', '20261232', '00000101', '2026101', '202610120', '2026-10-12', '2026 10 12', 'abcdefgh', '2026101a', '', '１２３４５６７８'];
  const times = ['03:30:00', '033000', '3:30:00', '03:30', '0330', '03:30:00.5', '24:00:00', '25:61:61', '00:00:00', '23:59:59', '12:3:0', 'xx:yy:zz', '0330zz', '033', '03300', '03-30-00', '04:30:00:7'];
  const zones = ['', 'US/Eastern', 'US/Central', 'America/Chicago', 'America/New_York', 'Asia/Shanghai', 'Europe/London', 'UTC', 'EST', 'Bad/Zone', 'US/Pacific', 'Pacific/Auckland', 'America/', '/'];
  const pads = ['', ' ', '  ', '\t', ' ', '﻿', '\n', ' ', '　', '\u0085', '​'];
  const cases = new Set();
  for (const d of dates.slice(0, 3)) for (const t of times) for (const z of zones) cases.add(`${d} ${t} ${z}`.trimEnd());
  for (let i = 0; i < 900; i += 1) {
    const sep = r.pick([' ', '  ', ' ', '\t', ' ', ' \n ']);
    const parts = [r.pick(dates), r.pick(times), r.pick(zones)].filter(() => r.chance(0.9));
    cases.add(r.pick(pads) + parts.join(sep) + r.pick(pads));
  }
  for (const s of ['20261012', '20261012 ', ' 20261012 03:30:00 US/Eastern', '2026-10-12 03:30:00 US/Eastern', '20261012 03:30:00 US/Eastern extra words', '20261012 US/Eastern 03:30:00',
    '20261012 033000 US/Eastern 20261013', 'garbage', '   ', '20261012-03:30:00', '20261012  03:30:00', '20261012 03:30:00 America/Chicago', '20260308 02:30:00 US/Eastern', '20261101 01:30:00 US/Eastern',
    '20260308 02:30:00 America/Chicago', '20261101 01:30:00 America/Chicago', '20261012 03:30:00 a/b/c', '- 20261012 03:30:00 US/Eastern', ': 20261012', '-:- 20261012 033000', '20261012 - 03:30:00 US/Eastern', '20261012 03:30:00 -', '-', '--', '- -', '20261012 03:30 US/Central']) cases.add(s);
  for (const s of cases) out.stamp.push({ s: enc(s), ...run(() => X.barTimestamp(s)) });
}
for (const v of [undefined, null, 0, -1, 5, 123456789, 1e9, NaN, -0, 0.5, Infinity]) {
  const bar = { date: '20261012 03:30:00 US/Eastern', open: 1, high: 2, low: 0.5, close: 1.5 };
  if (v !== undefined) bar.volume = v;
  out.toBar.push({ bar: enc(bar), ...run(() => X.toSessionBar(bar)) });
}

// ---------------------------------------------------------------- 开没开着 / 上次收盘
{
  const legs = ['day', 'overnight', 'index', 'proxy'];
  const mondays = ['2026-10-12', '2026-03-02', '2026-03-09', '2026-10-26', '2026-11-02', '2026-01-12', '2026-12-28'];
  const cases = {};
  for (const leg of legs) cases[leg] = [];
  const point = (t) => { for (const leg of legs) cases[leg].push([t, X.legOpen(leg, t) ? 1 : 0, enc(X.legClosedSince(leg, t))]); };
  for (const monday of mondays) {
    const m0 = et(monday, '00:00');
    // 每个整点与半点,再加每个边界前后一分钟(整周):以天为单位走 ET 墙钟,免得夏令时的一天长度不对
    for (let d = -1; d < 8; d += 1) {
      const date = new Date(Date.UTC(...monday.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), 12) + d * 86400000);
      const ds = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      for (const hhmm of ['00:00', '03:59', '04:00', '04:01', '09:29', '09:30', '09:31', '15:59', '16:00', '16:01', '16:59', '17:00', '17:01', '17:59', '18:00', '18:01', '19:59', '20:00', '20:01', '23:59', '12:00', '01:30', '02:30']) {
        point(et(ds, hhmm));
      }
    }
    void m0;
  }
  for (let t = et('2026-10-05', '00:00'); t < et('2026-10-26', '00:00'); t += 37 * 60000) point(t);
  out.open = legs.map((leg) => ({ leg, rows: cases[leg] }));
}

// ---------------------------------------------------------------- 拼 / 推算
const clock = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const sbar = (time, close) => ({ time, open: close - 1, high: close + 2, low: close - 3, close, volume: r.pick([0, 7, 120]) });
{
  const times = ['2026-10-09 19:30', '2026-10-09 19:45', '2026-10-09 20:00', '2026-10-12 03:30', '2026-10-12 04:00', '2026-10-12 09:30', 'x', 'y', '2026-10-12', '2026-10-13'];
  for (let i = 0; i < 120; i += 1) {
    const pickBars = () => Array.from({ length: r.int(6) }, () => sbar(r.pick(times), r.pick([1, 2.5, 100, 7700])));
    const day = pickBars(), night = pickBars();
    out.merge.push({ day: enc(day), night: enc(night), ...run(() => X.mergeSessionBars(day, night)) });
  }
  const sessionTimes = (date, from = '09:30', to = '15:55', stepMin = 5) => {
    const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
    const res = [];
    for (let t = fh * 60 + fm; t <= th * 60 + tm; t += stepMin) res.push(`${date} ${clock(Math.floor(t / 60), t % 60)}`);
    return res;
  };
  const days = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'];
  for (let i = 0; i < 90; i += 1) {
    const index = [], futSet = new Map();
    let level = 7600 + r.int(200);
    const basisChoices = [50, 48.25, 52.5, 0, -12.5];
    for (const d of days) {
      if (r.chance(0.2)) continue;
      const step = r.pick([30, 60, 60]);
      const times = sessionTimes(d, r.pick(['09:30', '09:35', '10:00']), r.pick(['15:55', '15:00', '16:00']), step).filter(() => r.chance(0.9));
      const basis = r.pick(basisChoices);
      for (const t of times) {
        level += r.int(7) - 3;
        index.push(sbar(t, r.chance(0.03) ? 0 : level));
        if (r.chance(0.85)) futSet.set(t, sbar(t, level + basis + (r.chance(0.1) ? 1 : 0)));
      }
      // 盘外:收盘后到夜里、第二天开盘前
      for (const t of [...sessionTimes(d, '16:00', '17:00', step), ...sessionTimes(d, '18:00', '23:55', 120), ...sessionTimes(d, '02:00', '09:25', 180)]) {
        if (r.chance(0.5)) futSet.set(t, sbar(t, level + basis + r.int(20) - 10));
      }
    }
    if (r.chance(0.1)) futSet.set('abc', sbar('abc', 1));
    const futures = r.shuffle([...futSet.values()]);
    const idx = r.shuffle(index);
    out.proxy.push({ index: enc(idx), futures: enc(futures), ...run(() => X.proxyIndexBars(idx, futures)) });
  }
  out.proxy.push({ index: [], futures: [], ...run(() => X.proxyIndexBars([], [])) });
  {
    // 同一时刻的重复 K 线(指数、期货各有):TS 的 first / last 判断是严格比较
    const b = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
    const idx = [b('2026-10-09 15:55', 7710), b('2026-10-09 15:55', 7720), b('2026-10-09 15:50', 7705), b('2026-10-09 15:50', 7706)];
    const fut = [b('2026-10-09 15:55', 7760), b('2026-10-09 15:55', 7770), b('2026-10-09 16:00', 7765), b('2026-10-09 16:00', 7775)];
    out.proxy.push({ index: enc(idx), futures: enc(fut), ...run(() => X.proxyIndexBars(idx, fut)) });
    out.merge.push({ day: enc([b('2026-10-09 15:55', 1), b('2026-10-09 15:55', 2)]), night: enc([b('2026-10-09 15:55', 3), b('2026-10-09 15:55', 4), b('2026-10-09 15:50', 5)]), ...run(() => X.mergeSessionBars([b('2026-10-09 15:55', 1), b('2026-10-09 15:55', 2)], [b('2026-10-09 15:55', 3), b('2026-10-09 15:55', 4), b('2026-10-09 15:50', 5)])) });
  }
  {
    const idx = [{ time: '2026-10-09 15:55', open: 7710.1234, high: 7711.2345, low: 7709.0004, close: 7710.1234, volume: 3 }];
    const fut = [{ time: '2026-10-09 15:55', open: 7760.6436, high: 7760.6436, low: 7760.6436, close: 7760.6436, volume: 5 },
      { time: '2026-10-09 16:00', open: 7761.0090, high: 7762.4444, low: 7759.9996, close: 7761.0049, volume: 9 }];
    out.proxy.push({ index: enc(idx), futures: enc(fut), ...run(() => X.proxyIndexBars(idx, fut)) });
  }
}

// ---------------------------------------------------------------- 取数报错
for (const [sym, label, msg] of [
  ['SPX', '1 day', 'Error 162: Historical Market Data Service error message:No market data permissions for CBOE IND'],
  ['IREN', '15 mins', 'permission denied'], ['IREN', '15 mins', 'You need a SUBSCRIBE first'], ['ES', 'x', 'Not subscribed'], ['AAPL', 'y', 'subscription required'],
  ['AAPL', 'y', 'code 354: Requested market data is not subscribed.'], ['AAPL', 'y', 'pacing violation'], ['A', 'b', ''], ['A', 'b', 'code 354 only'], ['A', 'b', 'x'.repeat(400)], ['A', 'b', `162${'y'.repeat(300)}`],
  ['汉字', '标签', '权限 Permission'], ['A', 'b', 'SUBSCRI'], ['A', 'b', 'Subscri'], ['A', 'b', '1620'], ['A', 'b', '35'], ['A', 'b', 'timeout'], ['A', 'b', `${'a'.repeat(195)}162 ${'z'.repeat(50)}`],
]) out.error.push({ sym, label, msg, ...run(() => X.barsError(sym, label, new Error(msg))) });

// ---------------------------------------------------------------- SessionBars 场景
const rawBar = (stamp, close, extra = {}) => ({ date: stamp, open: close, high: close, low: close, close, volume: 1, ...extra });
const stock = (symbol) => ({ ...C.stockContract(symbol), conId: 12345 });
const SPX = { ...C.indexContract('SPX', 'CBOE'), conId: 416904 };
const ES = C.indexFuturesContract({ futures: 'ES', futures_exchange: 'CME' }, '2026-10-12');
const NQ = C.indexFuturesContract({ futures: 'NQ', futures_exchange: 'CME' }, '2026-10-12');
const START = et('2026-10-12', '03:35');

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, events: [], ...script } });
const sess = (hist, extra = {}) => ({ name: 'A', connected: true, accounts: [], hist, ...extra });
const fetchStep = (nowMs, over = {}) => ({
  op: 'fetch', target: norm(stock('IREN')), endDateTime: '', durationStr: '10 D', barSizeSetting: '15 mins', whatToShow: 'TRADES', useRTH: false, overnight: true, nowMs, ...over,
});
const iren = () => ({
  'IREN|SMART': [{ bars: [rawBar('20261009 19:30:00 US/Eastern', 35.3), rawBar('20261009 19:45:00 US/Eastern', 35.21)] }],
  'IREN|OVERNIGHT': [{ bars: [rawBar('20261009 20:00:00 US/Eastern', 35.25), rawBar('20261012 03:30:00 US/Eastern', 38.38)] }],
});
const spx = () => ({
  'SPX|CBOE': [{ bars: [rawBar('20261009 14:55:00 US/Central', 7710)] }],
  'ES|CME': [{ bars: [rawBar('20261009 14:55:00 US/Central', 7760), rawBar('20261012 02:30:00 US/Central', 7790)] }],
});
const delayedKeys = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v]));

add('要夜盘:SMART 与 OVERNIGHT 各问一次,拼好按时间排', { sessions: [sess(iren())], steps: [fetchStep(et('2026-10-12', '03:35'))] });
add('不要夜盘:只问 SMART', { sessions: [sess(iren())], steps: [fetchStep(et('2026-10-12', '03:35'), { overnight: false })] });
add('白天:日盘每次重取,夜盘那份留着', { sessions: [sess(iren())], steps: [fetchStep(et('2026-10-12', '10:00')), fetchStep(et('2026-10-12', '10:01')), fetchStep(et('2026-10-12', '10:02'))] });
add('夜里:夜盘每次重取,日盘那份留着', { sessions: [sess(iren())], steps: [fetchStep(et('2026-10-12', '22:00')), fetchStep(et('2026-10-12', '22:01')), fetchStep(et('2026-10-12', '22:02'))] });
add('周末两条都留着', { sessions: [sess(iren())], steps: [fetchStep(et('2026-10-17', '12:00')), fetchStep(et('2026-10-17', '12:30')), fetchStep(et('2026-10-18', '19:59')), fetchStep(et('2026-10-18', '20:01'))] });
{
  const closed = et('2026-10-12', '20:00');
  add('刚收盘的 20 分钟里不留', {
    sessions: [sess(iren())],
    steps: [fetchStep(closed + 5 * 60000), fetchStep(closed + 10 * 60000), fetchStep(closed + 20 * 60000), fetchStep(closed + 21 * 60000), fetchStep(closed + 20 * 60000 - 1), fetchStep(closed + 20 * 60000)],
  });
  add('留着的那份是拷贝;换时长 / 周期 / 结束时间 / RTH 是另一份', {
    sessions: [sess(iren())],
    steps: [fetchStep(et('2026-10-12', '10:00')), fetchStep(et('2026-10-12', '10:00') + 1000), fetchStep(et('2026-10-12', '10:00') + 2000, { durationStr: '20 D' }),
      fetchStep(et('2026-10-12', '10:00') + 3000, { barSizeSetting: '5 mins' }), fetchStep(et('2026-10-12', '10:00') + 4000, { endDateTime: '20261009 16:00:00' }),
      fetchStep(et('2026-10-12', '10:00') + 5000, { useRTH: true }), fetchStep(et('2026-10-12', '10:00') + 6000)],
  });
  const now = et('2026-10-12', '03:35');
  add('夜盘要不到:只给日盘,记下原因,半小时内不再问;之后要到了就清掉;日盘要不到整次失败', {
    sessions: [sess({
      'IREN|SMART': [{ bars: iren()['IREN|SMART'][0].bars }, { bars: iren()['IREN|SMART'][0].bars }, { bars: iren()['IREN|SMART'][0].bars }, { bars: iren()['IREN|SMART'][0].bars }, { error: 'pacing violation' }],
      'IREN|OVERNIGHT': [{ error: 'No security definition has been found for the request' }, { bars: [rawBar('20261012 03:30:00 US/Eastern', 38.38)] }],
    })],
    steps: [fetchStep(now), fetchStep(now + 60000), fetchStep(now + 30 * 60000 - 1), fetchStep(now + 30 * 60000), fetchStep(now + 30 * 60000 + 1000)],
  });
  add('夜盘要不到又要不到:原因换成最新的;日盘与夜盘同时失败', {
    sessions: [sess({
      'IREN|SMART': [{ error: 'day boom' }],
      'IREN|OVERNIGHT': [{ error: 'night boom 1' }, { error: 'night boom 2' }],
    })],
    steps: [fetchStep(now), fetchStep(now + 31 * 60000), fetchStep(now + 62 * 60000)],
  });
  add('夜盘带延迟:日盘先回、夜盘后回', {
    sessions: [sess({ 'IREN|SMART': [{ bars: iren()['IREN|SMART'][0].bars, delay: 100 }], 'IREN|OVERNIGHT': [{ bars: iren()['IREN|OVERNIGHT'][0].bars, delay: 5000 }] })],
    steps: [fetchStep(now, { start: true, id: 'a' }), { op: 'advance', ms: 100 }, { op: 'advance', ms: 4900 }, fetchStep(now + 1000)],
  });
  add('日盘失败时夜盘还在路上:整次失败,夜盘的后续照样记账', {
    sessions: [sess({ 'IREN|SMART': [{ error: 'day boom', delay: 50 }], 'IREN|OVERNIGHT': [{ error: 'night boom', delay: 3000 }] })],
    steps: [fetchStep(now, { start: true, id: 'a' }), { op: 'advance', ms: 100 }, { op: 'advance', ms: 3000 }, fetchStep(now + 1000, { overnight: false })],
  });
  const feedKey = tickerKey(stock('IREN'));
  for (const [label, v] of [['实时', false], ['延迟', true], ['说不准', null]]) {
    add(`档位:${label}`, { sessions: [sess(iren(), { caps: ['QuoteDelayed'], delayed: { [feedKey]: v } })], steps: [fetchStep(et('2026-10-12', '10:00')), fetchStep(et('2026-10-12', '10:01'), { overnight: false })] });
  }
  add('档位:会话没有 quoteDelayed 方法', { sessions: [sess(iren(), { caps: [] })], steps: [fetchStep(et('2026-10-12', '10:00'))] });
  add('档位:没列的合约答 null', { sessions: [sess(iren(), { caps: ['QuoteDelayed'], delayed: {} })], steps: [fetchStep(et('2026-10-12', '10:00'))] });
}
{
  const reqIdx = (nowMs, futures = norm(ES), over = {}) => ({
    op: 'fetch', target: norm(SPX), endDateTime: '', durationStr: '5 D', barSizeSetting: '5 mins', whatToShow: 'TRADES', useRTH: false, overnight: false, futures, nowMs, ...over,
  });
  const feeds = { [tickerKey(SPX)]: true, [tickerKey(ES)]: false };
  add('指数夜里:指数与期货各问一次;K 线上记着怎么推算的,档位看期货那条流', {
    sessions: [sess(spx(), { caps: ['QuoteDelayed'], delayed: feeds })], steps: [reqIdx(et('2026-10-12', '03:35'))],
  });
  add('指数盘中:指数每次重取,期货那份留着;夜里反过来', {
    sessions: [sess({ ...spx(), 'SPX|CBOE': [{ bars: [rawBar('20261009 14:55:00 US/Central', 7710), rawBar('20261012 08:30:00 US/Central', 7745)] }] }, { caps: ['QuoteDelayed'], delayed: feeds })],
    steps: [reqIdx(et('2026-10-12', '10:00')), reqIdx(et('2026-10-12', '10:01')), reqIdx(et('2026-10-12', '22:00')), reqIdx(et('2026-10-12', '22:01')), reqIdx(et('2026-10-17', '12:00')), reqIdx(et('2026-10-17', '12:05'))],
  });
  add('期货要不到:只给指数,说明里写原因,半小时内不再问;不给期货就是老样子', {
    sessions: [sess({ ...spx(), 'ES|CME': [{ error: 'No market data permissions for CME FUT' }, { error: 'x'.repeat(300) }] }, { caps: ['QuoteDelayed'], delayed: feeds })],
    steps: [reqIdx(et('2026-10-12', '03:35')), reqIdx(et('2026-10-12', '03:36')), reqIdx(et('2026-10-12', '04:06')), reqIdx(et('2026-10-12', '04:07'), null)],
  });
  add('期货推算不出来(对不上同一时刻):说明写"没有对得上"', {
    sessions: [sess({ 'SPX|CBOE': [{ bars: [rawBar('20261009 14:55:00 US/Central', 7710)] }], 'ES|CME': [{ bars: [rawBar('20261009 14:50:00 US/Central', 7760), rawBar('20261012 02:30:00 US/Central', 7790)] }] })],
    steps: [reqIdx(et('2026-10-12', '03:35'))],
  });
  add('换一张期货(NQ):留着的那份按合约分', {
    sessions: [sess({ ...spx(), 'NQ|CME': [{ bars: [rawBar('20261009 14:55:00 US/Central', 7760), rawBar('20261012 02:30:00 US/Central', 7790)] }] })],
    steps: [reqIdx(et('2026-10-17', '12:00')), reqIdx(et('2026-10-17', '12:05'), norm(NQ)), reqIdx(et('2026-10-17', '12:10')), reqIdx(et('2026-10-17', '12:15'), norm(NQ))],
  });
  add('指数失败:整次失败;期货还在路上', {
    sessions: [sess({ 'SPX|CBOE': [{ error: 'idx boom', delay: 10 }], 'ES|CME': [{ bars: spx()['ES|CME'][0].bars, delay: 2000 }] })],
    steps: [reqIdx(et('2026-10-12', '03:35'), norm(ES), { start: true, id: 'a' }), { op: 'advance', ms: 2500 }, reqIdx(et('2026-10-12', '03:36'))],
  });
}
{
  // 闲着的那条最多留 64 份:70 个标的在周末各取一次(日盘关着、都留),再回头看谁被挤掉了
  const hist = {};
  const syms = Array.from({ length: 70 }, (_, i) => `S${String(i).padStart(2, '0')}`);
  for (const s of syms) hist[`${s}|SMART`] = [{ bars: [rawBar('20261009 19:30:00 US/Eastern', 10)] }];
  const sat = et('2026-10-17', '12:00');
  const f = (sym, off, over = {}) => fetchStep(sat + off, { target: norm(stock(sym)), overnight: false, ...over });
  add('闲着的那条最多留 64 份:最旧的先挤掉;命中不刷新位置;重取才排到最后', {
    sessions: [sess(hist)],
    steps: [
      ...syms.slice(0, 64).map((s, i) => f(s, i * 60000)),
      f('S00', 70 * 60000), f('S01', 71 * 60000),                      // 命中:不刷新
      f('S64', 72 * 60000),                                            // 挤掉最旧的 S00
      f('S00', 73 * 60000),                                            // S00 要重取(再挤掉 S01)
      f('S01', 74 * 60000), f('S02', 75 * 60000), f('S64', 76 * 60000),
      ...syms.slice(65).map((s, i) => f(s, (80 + i) * 60000)),
      f('S00', 90 * 60000), f('S05', 91 * 60000), f('S20', 92 * 60000), f('S68', 93 * 60000),
      // 重取:同一份刚收盘 20 分钟内取的不留(早于 closedSince + 20 分钟 → 取了又不命中 → delete 再 set 排到最后)
    ],
  });
  const fri = et('2026-10-16', '20:00');
  add('刚收盘取的那份不命中,重取之后位置排到最后', {
    sessions: [sess(hist)],
    steps: [
      ...syms.slice(0, 63).map((s, i) => fetchStep(fri + 25 * 60000 + i * 1000, { target: norm(stock(s)), overnight: false })),
      fetchStep(fri + 5 * 60000, { target: norm(stock('S00')), overnight: false }),
      fetchStep(fri + 26 * 60000, { target: norm(stock('S63')), overnight: false }),
      fetchStep(fri + 26 * 60000, { target: norm(stock('S64')), overnight: false }),
      fetchStep(fri + 27 * 60000, { target: norm(stock('S00')), overnight: false }),
      fetchStep(fri + 28 * 60000, { target: norm(stock('S01')), overnight: false }),
    ],
  });
}

{
  const Fri = et('2026-10-16', '20:00');
  const sym = (i) => `S${String(i).padStart(2, '0')}`;
  const hist = {};
  for (let i = 0; i < 70; i += 1) hist[`${sym(i)}|SMART`] = [{ bars: [rawBar('20261009 19:30:00 US/Eastern', 10)] }];
  const f = (symbol, nowMs) => fetchStep(nowMs, { target: norm(stock(symbol)), overnight: false });
  add('重取之后位置排到最后:挤掉的是别人', {
    sessions: [sess(hist)],
    steps: [f(sym(0), Fri + 5 * 60000), ...Array.from({ length: 63 }, (_, i) => f(sym(i + 1), Fri + 25 * 60000 + i * 1000)),
      f(sym(0), Fri + 27 * 60000), f(sym(64), Fri + 28 * 60000), f(sym(0), Fri + 29 * 60000), f(sym(1), Fri + 30 * 60000)],
  });
  const sat = et('2026-10-17', '12:00');
  const SPXstockLike = { secType: 'STK', symbol: 'SPX', exchange: 'SMART', currency: 'USD' };
  add('开着的线不进闲着的那份:先存一份、再取一堆开着的,最初那份还在', {
    sessions: [sess(hist)],
    steps: [f(sym(69), sat), ...Array.from({ length: 65 }, (_, i) => f(sym(i), et('2026-10-16', '10:00') + i * 1000)), f(sym(69), sat + 30 * 60000)],
  });
  const close = et('2026-10-12', '20:00');
  add('延迟档的 20 分钟边界:19.5 分钟取的那份不留', {
    sessions: [sess(iren())], steps: [fetchStep(close + 19.5 * 60000, { overnight: false }), fetchStep(close + 25 * 60000, { overnight: false })],
  });
  add('周期 / 结束时间 / 交易所 / 类型各是一份', {
    sessions: [sess({ 'IREN|SMART': iren()['IREN|SMART'], 'IREN|ISLAND': iren()['IREN|SMART'] })],
    steps: [fetchStep(sat, { overnight: false }), fetchStep(sat + 1000, { overnight: false, target: { ...norm(stock('IREN')), exchange: 'ISLAND' } }), fetchStep(sat + 2000, { overnight: false }),
      fetchStep(sat + 3000, { overnight: false, target: { ...norm(stock('IREN')), exchange: 'ISLAND' } })],
  });
  add('类型不同(个股 / 指数)、代码与交易所相同:各是各的闲着那份', {
    sessions: [sess({ 'SPX|SMART': [{ bars: iren()['IREN|SMART'][0].bars }] })],
    steps: [fetchStep(sat, { overnight: false, target: { ...SPXstockLike, secType: 'STK' } }), fetchStep(sat + 1000, { overnight: false, target: { ...SPXstockLike, secType: 'IND' } }),
      fetchStep(sat + 2000, { overnight: false, target: { ...SPXstockLike, secType: 'STK' } }), fetchStep(sat + 3000, { overnight: false, target: { ...SPXstockLike, secType: 'IND' } })],
  });
  const ES2 = C.indexFuturesContract({ futures: 'ES', futures_exchange: 'CME' }, '2027-01-12');
  const reqI = (nowMs, futures, over = {}) => ({ op: 'fetch', target: norm(SPX), endDateTime: '', durationStr: '5 D', barSizeSetting: '5 mins', whatToShow: 'TRADES', useRTH: false, overnight: false, futures, nowMs, ...over });
  add('有基差、盘外一根都推不出来(期货只有常规时段的那几根):说明里不写"按期货推算"', {
    sessions: [sess({ 'SPX|CBOE': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7710)] }], 'ES|CME': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7760)] }] })],
    steps: [reqI(et('2026-10-12', '03:35'), norm(ES))],
  });
  add('SessionBars:原始 K 线里同一时刻重复(指数与期货)', {
    sessions: [sess({
      'SPX|CBOE': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7710), rawBar('20261009 15:55:00 US/Eastern', 7720)] }],
      'ES|CME': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7760), rawBar('20261009 15:55:00 US/Eastern', 7770), rawBar('20261009 16:00:00 US/Eastern', 7765), rawBar('20261009 16:00:00 US/Eastern', 7775)] }],
    })],
    steps: [reqI(et('2026-10-12', '03:35'), norm(ES))],
  });
  add('同一个标的、两张不同到期的期货:各是各的闲着那份', {
    sessions: [sess(spx())],
    steps: [reqI(sat, norm(ES)), reqI(sat + 1000, norm(ES2)), reqI(sat + 2000, norm(ES)), reqI(sat + 3000, norm(ES2))],
  });
  add('期货没有到期月:标签去掉尾空格', {
    sessions: [sess(spx())], steps: [reqI(et('2026-10-12', '03:35'), { secType: 'FUT', symbol: 'ES', exchange: 'CME', currency: 'USD' })],
  });
  add('基差带小数、期货收盘价为 0 / 负:基差不算', {
    sessions: [sess({
      'SPX|CBOE': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7710.1234), rawBar('20261008 15:55:00 US/Eastern', 7700), rawBar('20261007 15:55:00 US/Eastern', 7690)] }],
      'ES|CME': [{ bars: [rawBar('20261009 15:55:00 US/Eastern', 7760.6666), rawBar('20261009 16:00:00 US/Eastern', 7761.12345), rawBar('20261008 15:55:00 US/Eastern', 0), rawBar('20261008 16:05:00 US/Eastern', 7705),
        rawBar('20261007 15:55:00 US/Eastern', -5), rawBar('20261007 16:05:00 US/Eastern', 7695)] }],
    })],
    steps: [reqI(et('2026-10-12', '03:35'), norm(ES))],
  });
  const SPXstock = { ...norm(stock('SPX')) };
  add('同一个代码先当个股(夜盘要不到)、再当指数(期货):重试时刻按线分开', {
    sessions: [sess({ 'SPX|SMART': [{ bars: iren()['IREN|SMART'][0].bars }], 'SPX|OVERNIGHT': [{ error: 'no overnight' }], ...spx() })],
    steps: [fetchStep(et('2026-10-12', '03:35'), { target: SPXstock }), reqI(et('2026-10-12', '03:36'), norm(ES))],
  });
  add('重试时刻成功后清掉:时钟往回拨又该去取了', {
    sessions: [sess({ ...iren(), 'IREN|OVERNIGHT': [{ error: 'boom' }, { bars: iren()['IREN|OVERNIGHT'][0].bars }] })],
    steps: [fetchStep(et('2026-10-12', '03:35')), fetchStep(et('2026-10-12', '04:10')), fetchStep(et('2026-10-12', '03:50'))],
  });
}

// ---- 随机脚本:几只标的 / 指数在一周里的各个钟点取几次,历史数据的回答在成功与失败间随机
{
  const stamp = (date, hhmm, tz = 'US/Eastern') => `${date.replace(/-/g, '')} ${hhmm}:00 ${tz}`;
  const randomBars = (dates) => {
    const bars = [];
    for (const d of dates) {
      for (const hh of ['03:30', '04:15', '09:30', '10:00', '15:55', '16:00', '19:30', '20:00', '20:05', '23:00']) if (r.chance(0.4)) bars.push(rawBar(stamp(d, hh, r.pick(['US/Eastern', 'US/Eastern', 'US/Central', 'America/Chicago'])), 7000 + r.int(900), r.chance(0.2) ? { volume: -1 } : r.chance(0.1) ? { volume: undefined } : {}));
    }
    return bars;
  };
  const outcomeFor = (bars) => (r.chance(0.15) ? { error: r.pick(['boom', 'No security definition', 'pacing violation', 'x'.repeat(200)]) } : { bars: bars() });
  const dates = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'];
  for (let n = 0; n < 36; n += 1) {
    const isIndex = r.chance(0.45);
    const lists = (key) => Array.from({ length: 1 + r.int(4) }, () => outcomeFor(() => randomBars(dates)));
    const hist = isIndex
      ? { 'SPX|CBOE': lists(), 'ES|CME': lists(), 'NQ|CME': lists() }
      : { 'IREN|SMART': lists(), 'IREN|OVERNIGHT': lists(), 'AAPL|SMART': lists(), 'AAPL|OVERNIGHT': lists() };
    const caps = r.chance(0.5) ? ['QuoteDelayed'] : [];
    const delayed = {};
    for (const c of [SPX, ES, NQ, stock('IREN'), stock('AAPL')]) delayed[tickerKey(c)] = r.pick([true, false, null]);
    const steps = [];
    let now = et('2026-10-12', '00:00') + r.int(7 * 24 * 60) * 60000;
    for (let i = 0; i < 10; i += 1) {
      now += r.pick([1000, 60000, 5 * 60000, 25 * 60000, 31 * 60000, 3 * 3600000, 14 * 3600000]);
      const base = isIndex
        ? { target: norm(SPX), futures: r.pick([norm(ES), norm(ES), norm(NQ), null]), overnight: false }
        : { target: norm(stock(r.pick(['IREN', 'AAPL']))), overnight: r.chance(0.8) };
      steps.push(fetchStep(now, { ...base, durationStr: r.pick(['10 D', '10 D', '2 D']), useRTH: r.chance(0.2) }));
    }
    add(`随机 ${n}`, { sessions: [sess(hist, { caps, delayed })], steps });
  }
}
void delayedKeys;

// ---------------------------------------------------------------- 跑场景
async function runScenario(script) {
  const world = new World(script, tickerKey);
  const sb = new X.SessionBars();
  const steps = [];
  const started = new Map();
  const reported = new Set();
  const errorsOf = () => ({ overnight: [...sb.overnightErrors.entries()], proxy: [...sb.proxyErrors.entries()] });
  const describeBars = (bars) => {
    const o = { bars };
    const feed = M.feedOf(bars), proxy = M.proxyOf(bars);
    if (feed !== undefined) o.feed = feed;
    if (proxy !== undefined) o.proxy = proxy;
    return o;
  };
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (step.id !== undefined) rec.id = step.id;
      if (!world.commonStep(step)) {
        if (step.op !== 'fetch') throw new Error(`不认识的步 ${step.op}`);
        const req = {
          target: { ...step.target }, endDateTime: step.endDateTime, durationStr: step.durationStr, barSizeSetting: step.barSizeSetting, whatToShow: step.whatToShow,
          useRTH: step.useRTH, overnight: step.overnight, futures: step.futures === undefined ? undefined : (step.futures === null ? null : { ...step.futures }), nowMs: step.nowMs,
        };
        const s = track(sb.fetch(world.session('A'), req));
        if (step.start) started.set(step.id, s);
        else { await runToDone(world, s); rec.result = outcome(s, describeBars); }
      }
      await drain();
      const done = [];
      for (const [id, s] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (s.done && !reported.has(id)) { reported.add(id); done.push({ id, result: outcome(s, describeBars) }); }
      }
      if (done.length) rec.done = done;
      rec.errors = errorsOf();
      rec.T = world.T;
      steps.push(rec);
    }
    return { log: world.log, steps };
  } finally {
    world.restore();
  }
}

const outScenarios = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) outScenarios[i].expected = enc(await runScenario(scenarios[i].script));
out.scenarios = outScenarios;
const text = JSON.stringify(out);
writeFileSync(join(here, 'ib_bars.json'), text);
console.log(`ib_bars.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
