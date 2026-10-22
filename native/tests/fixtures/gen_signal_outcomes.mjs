// 生成 signal-outcomes.json:engine-ts 的 signalOutcomes.ts(原模块现跑)。事件折成信号(穿越、碰均线、异动、强势股、K线 PA,带缺键、串的时刻、坏时刻)、
// 美东零点与收盘(提前收盘日、夏令时切换、写坏的日期)、进场时段的起点(几种日历)、进场那一根(收盘那一秒、周末、日线还没覆盖到)、
// 收益与基线、互不重叠的持有期与 t、门槛(类数 × 段数的网格)、整份成绩单(缺日线的标的、比日线还早的信号、没有基线、凑够段数下结论的几类)。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_signal_outcomes.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const S = await import(pathToFileURL(join(engine, 'dist/src/signalOutcomes.js')).href);
const { builtinCalendar } = await import(pathToFileURL(join(engine, 'dist/src/marketCalendar.js')).href);

let seed = 0x5160_0dd5;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gauss = () => { const u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };

const holidays = new Set(builtinCalendar().holidays);
const weekday = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
const calendars = { nyse: (d) => weekday(d) && !holidays.has(d), weekday, always: () => true, never: () => false };
const earlySets = { builtin: undefined, none: new Set(), custom: new Set(['2026-10-16', '2026-10-15', '2026-11-27']) };

const out = { events: [], days: [], sessions: [], entries: [], returns: [], baselines: [], blocks: [], overlap: [], thresholds: [], scores: [] };

// ---------------------------------------------------------------- 事件 → 信号
const atPool = [1_760_000_000, 1_760_000_000.5, '1760000000', 0, null, NaN, undefined, -1, 1e13];
for (let i = 0; i < 200; i += 1) {
  const e = { symbol: pick(['AAPL', 'SPY', undefined]), trigger: pick([undefined, 'touch', 'cross', 'TOUCH']), price: 450, label: pick(['20日均线', undefined]), source: 'ma20', kind: 'support',
    direction: pick(['up', 'down', undefined, 'sideways']), from: 449, to: pick([450.3, NaN, '450', Infinity, null, undefined]), at: pick(atPool), text: 'x' };
  out.events.push({ kind: 'watch', e: enc(e), ...run(() => S.signalFromWatchEvent(e)) });
  const a = { id: 'x', at: pick(atPool), symbol: pick(['NVDA', undefined]), kind: pick(['spike', 'day_move', 'rvol', 'burst', undefined, 'other']), direction: pick(['up', 'down', null, undefined]),
    value: 1, threshold: 1, tier: null, sigma: null, price: pick([123.4, null, undefined, '5']), change_pct: 1, basis: 'x', title: pick(['NVDA 放量 3.1×', undefined]), text: 'y' };
  out.events.push({ kind: 'anomaly', e: enc(a), ...run(() => S.signalFromAnomaly(a)) });
  const atMs = pick([1_760_000_000_000, 0, NaN, 1.5e12]);
  const row = { symbol: pick(['MU', undefined]), close: pick([101.5, null, undefined]), verdict: pick(['趋势模板 8/8 · 第二阶段', undefined]) };
  out.events.push({ kind: 'leader', e: enc(row), atMs: enc(atMs), ...run(() => S.signalFromLeader(row, atMs)) });
  const pa = { symbol: 'SPY', timeframe: pick(['5m', '1d', undefined, 'zz']), timeframe_label: pick(['5 分钟', undefined]), last: pick([450.1, NaN, null, '3']),
    score: pick([62, -40, 0, undefined, 1.5]), bias: pick(['bull', 'lean_bull', 'bear', 'lean_bear', 'neutral', '', 'bullbear']), bias_label: pick(['偏多', '偏空', '中性']) };
  out.events.push({ kind: 'pa', e: enc(pa), atMs: enc(atMs), ...run(() => S.signalFromPa(pa, atMs)) });
}

// ---------------------------------------------------------------- 美东零点与收盘
for (const d of ['2026-10-16', '2026-11-27', '2026-12-24', '2026-03-08', '2026-11-01', '2026-03-09', '2026-07-03', '2000-01-03', '2026-02-30', '2026-1-5', '2026--05', '', 'abc', '2026-10', '2026-10-16-1']) {
  for (const [name, set] of Object.entries(earlySets)) out.days.push({ date: d, early: name, start: run(() => S.etDayStart(d)), close: run(() => S.closeEpoch(d, set)) });
}
for (let i = 0; i < 300; i += 1) {
  const nowMs = Date.parse('2026-01-01T00:00:00Z') + Math.floor(rnd() * 365 * 86400) * 1000 + pick([0, 0, 500]);
  const cal = pick(Object.keys(calendars)), early = pick(Object.keys(earlySets));
  out.sessions.push({ nowMs, cal, early, ...run(() => S.entrySessionStart(nowMs, calendars[cal], earlySets[early])) });
}
// 正好收盘那一刻、差一毫秒
for (const iso of ['2026-10-16T20:00:00Z', '2026-10-16T19:59:59.999Z', '2026-11-27T18:00:00Z', '2026-11-27T17:59:59Z', '2026-03-09T20:00:00Z']) {
  for (const early of Object.keys(earlySets)) out.sessions.push({ nowMs: Date.parse(iso), cal: 'nyse', early, ...run(() => S.entrySessionStart(Date.parse(iso), calendars.nyse, earlySets[early])) });
}

// ---------------------------------------------------------------- 日线
function tradingDates(start, n) {
  const list = [];
  let ms = Date.parse(`${start}T00:00:00Z`);
  while (list.length < n) {
    const d = new Date(ms).toISOString().slice(0, 10);
    if (calendars.nyse(d)) list.push(d);
    ms += 86_400_000;
  }
  return list;
}
function closes(n, start = '2025-01-02', drift = 0, vol = 0.012, jumpEvery = 0) {
  const ds = tradingDates(start, n);
  let c = 100;
  return ds.map((date, i) => {
    c = c * (1 + drift + gauss() * vol + (jumpEvery && i % jumpEvery === 0 ? 0.03 : 0));
    return { date, close: Math.round(c * 100) / 100 };
  });
}
const seriesPool = [closes(30), closes(300), closes(420, '2025-01-02', 0.001), closes(5, '2026-10-12'), closes(260, '2025-06-02'),
  closes(40, '2026-08-03').map((b, i) => ({ ...b, close: i % 3 === 0 ? 0 : i % 3 === 1 ? -2 : b.close }))];
out.series = seriesPool;
const atFor = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  // 美东(10 月是夏令时 UTC−4,1–3 月是 UTC−5;这里按日期粗分,只是造输入,答案由原模块算)
  const month = Number(date.slice(5, 7));
  const off = month >= 4 && month <= 10 ? 4 : 5;
  return Date.parse(`${date}T00:00:00Z`) + ((h + off) * 60 + m) * 60_000;
};
for (let i = 0; i < 400; i += 1) {
  const si = Math.floor(rnd() * seriesPool.length);
  const bars = seriesPool[si];
  const date = rnd() < 0.8 ? pick(bars).date : pick(['2024-12-31', '2027-01-04', '2026-10-17', '2026-10-18']);
  const atMs = rnd() < 0.05 ? pick([NaN, Infinity]) : atFor(date, pick(['09:00', '10:30', '15:59', '16:00', '16:01', '13:00', '12:59', '23:00', '00:30']));
  const early = pick(Object.keys(earlySets));
  out.entries.push({ s: si, atMs: enc(atMs), early, out: S.entryIndex(bars, atMs, earlySets[early]) });
  const signal = { at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : pick(['', 'garbage']), source: 'cross', symbol: 'X', expect: pick(['up', 'down', null, undefined, 'UP']), price: 1, label: 'x' };
  out.returns.push({ s: si, signal: enc(signal), early, out: enc(S.signalReturns(signal, bars, earlySets[early])) });
}
for (const si of seriesPool.keys()) {
  const bars = seriesPool[si];
  for (const entry of [0, 251, 255, 270, 300, bars.length, bars.length + 1, 120, -1, 300.5]) {
    for (const k of [1, 5, 20]) for (const abs of [false, true]) out.baselines.push({ s: si, entry, k, abs, out: enc(S.baselineReturn(bars, entry, k, abs)) });
  }
}
out.baselines.push({ s: 0, entry: 260, k: 1, abs: false, bars: [{ date: '2026-01-01', close: 0 }], out: enc(S.baselineReturn([{ date: '2026-01-01', close: 0 }], 260, 1, false)) });

// ---------------------------------------------------------------- 统计
for (let i = 0; i < 200; i += 1) {
  const days = Array.from({ length: Math.floor(rnd() * 30) }, () => Math.floor(rnd() * pick([10, 60, 300])));
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const k = pick([1, 5, 20, 2]);  // k ≤ 0 时 overlapT 的 while 永远不停(TS 原样;调用方只给 1 / 5 / 20)
  out.blocks.push({ days: enc(days), k, blocks: enc(S.windowBlocks(sorted, k)), independent: enc(S.independentWindows(days, k)) });
  const obs = days.map((day) => ({ day, excess: pick([0.5, 0.5, Math.round(gauss() * 300) / 100, 1e-13, -2]) }));
  out.overlap.push({ obs: enc(obs), k, out: enc(S.overlapT(obs, k)) });
}
// 没检查过的数拿去排(a - b,NaN 当相等):不到 8 个时 V8 是直接的二分插入
for (const days of [[-45838.4, 6589.1, NaN, 0, 0.2], [NaN, 3, 1, NaN, 2], [5, NaN, -0, 0, 1, 1, 7, 2, 9, NaN]]) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  for (const k of [1, 5]) out.blocks.push({ days: enc(days), k, blocks: enc(S.windowBlocks(sorted, k)), independent: enc(S.independentWindows(days, k)) });
}
for (const [days, ex] of [[[1, 2, 3, 4, 5, 6, 7, 8], 1], [[0, 5, 10, 15, 20, 25], 0.3], [[0, 20, 40, 60, 80], 0], [[], 0]]) {
  const obs = days.map((day, i) => ({ day, excess: ex + (i % 2 ? 1e-14 : 0) }));
  for (const k of [1, 5, 20]) out.overlap.push({ obs: enc(obs), k, out: enc(S.overlapT(obs, k)) });
}
for (const m of [0, 1, 2, 3, 5, 8, 13, 0.5, -1]) for (const w of [1, 2, 3, 4, 5, 6, 7, 10, 19, 20, 21, 25.7, 40, 100, 333, 0, -3]) out.thresholds.push({ m, w, out: enc(S.tThreshold(m, w)) });

// ---------------------------------------------------------------- 整份成绩单
function signalsOn(sym, bars, opts) {
  const list = [];
  for (const [i, b] of bars.entries()) {
    if (rnd() > opts.rate) continue;
    if (opts.every && i % opts.every !== opts.phase) continue;
    list.push({ at: new Date(atFor(b.date, pick(opts.times ?? ['10:00', '15:30', '16:30', '20:00']))).toISOString(), source: opts.source, symbol: sym, expect: opts.expect !== undefined ? opts.expect : pick(['up', 'down', 'up', 'down', undefined]),
      price: b.close, label: `${sym} ${opts.source}`, ...(opts.variant !== undefined ? { variant: typeof opts.variant === 'function' ? opts.variant() : opts.variant } : {}), id: i });
  }
  return list;
}
const scoreCases = [];
{
  // 跳涨每 6 个交易日一次:押在跳涨前一天的 cross 比随手一天好;押跌的 touch 比随手一天差
  const jump = closes(500, '2024-06-03', 0, 0.002, 6);
  const noisy = closes(500, '2024-06-03', 0.0003, 0.015);
  const young = closes(120, '2026-04-01');
  const bars = new Map([['JUMP', jump], ['NOISY', noisy], ['YOUNG', young], ['EMPTY', []]]);
  let sigs = [
    ...signalsOn('JUMP', jump.slice(260), { rate: 1, every: 6, phase: 5, source: 'cross', expect: 'up', times: ['10:00'] }),
    ...signalsOn('JUMP', jump.slice(260), { rate: 1, every: 6, phase: 5, source: 'touch', expect: 'down', times: ['11:00'] }),
    ...signalsOn('JUMP', jump.slice(260), { rate: 1, every: 6, phase: 5, source: 'burst', expect: null, times: ['12:00'] }),
    ...signalsOn('NOISY', noisy.slice(260), { rate: 0.4, source: 'spike' }),
    ...signalsOn('NOISY', noisy.slice(260), { rate: 0.3, source: 'rvol', expect: null }),
    ...signalsOn('NOISY', noisy.slice(260), { rate: 0.15, source: 'pa', variant: () => pick(['5m', '1d', '1h', 'zz', null, undefined, 'constructor']) }),
    ...signalsOn('YOUNG', young, { rate: 0.3, source: 'leaders', expect: 'up' }),
    { at: '2020-01-01T15:00:00.000Z', source: 'cross', symbol: 'NOISY', expect: 'up', price: 1, label: 'old' },
    { at: 'garbage', source: 'day_move', symbol: 'NOISY', expect: 'down', price: 1, label: 'bad', returns: [9] },
    { at: '2026-10-01T14:00:00.000Z', source: 'burst', symbol: 'GONE', expect: null, price: 1, label: 'gone' },
    { at: '2026-10-01T14:00:00.000Z', source: 'burst', symbol: 'EMPTY', expect: null, price: 1, label: 'empty' },
    { at: '2026-10-01T14:00:00.000Z', source: 'nope', symbol: 'NOISY', expect: null, price: 1, label: 'unknown source' },
  ];
  sigs = sigs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  scoreCases.push({ signals: sigs, bars, days: 90, early: 'builtin' });
  scoreCases.push({ signals: sigs.filter((s) => s.source === 'cross'), bars, days: null, early: 'none' });
  scoreCases.push({ signals: sigs.filter((s) => s.source !== 'cross' && s.source !== 'touch'), bars, days: 30, early: 'custom' });
  scoreCases.push({ signals: [], bars, days: null, early: 'builtin' });
  scoreCases.push({ signals: sigs.slice(0, 7), bars: new Map(), days: 7, early: 'builtin' });
  // 每条的超额收益一模一样:一条直线的日线
  const line = tradingDates('2024-06-03', 500).map((date, i) => ({ date, close: 100 + i }));
  const flat = tradingDates('2024-06-03', 500).map((date) => ({ date, close: 50 }));
  const lb = new Map([['LINE', line], ['FLAT', flat]]);
  scoreCases.push({ signals: [...signalsOn('LINE', line.slice(270), { rate: 1, every: 5, phase: 0, source: 'cross', expect: 'up', times: ['10:00'] }),
    ...signalsOn('FLAT', flat.slice(270), { rate: 1, every: 5, phase: 0, source: 'spike', expect: 'down', times: ['10:00'] }),
    ...signalsOn('FLAT', flat.slice(270), { rate: 1, every: 5, phase: 1, source: 'burst', expect: null, times: ['10:00'] }),
    ...signalsOn('LINE', line.slice(270), { rate: 1, every: 5, phase: 2, source: 'burst', expect: null, times: ['10:00'] })], bars: lb, days: null, early: 'builtin' });
}
// t 正好等于门槛 / 负门槛的两份(种子是另找的:跳涨序列里搜到的)
for (const s0 of [860261121, 901552365]) {
  let sd = s0;
  const r2 = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
  const g2 = () => { const u = r2() || 1e-12, v = r2(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const ds = []; let ms = Date.parse('2024-06-03T00:00:00Z'); while (ds.length < 420) { const d = new Date(ms); if (d.getUTCDay() % 6) ds.push(d.toISOString().slice(0, 10)); ms += 864e5; }
  const jump = 0.004 + r2() * 0.01, vol = 0.004 + r2() * 0.01;
  let c = 100;
  const jb = ds.map((date, i) => { c *= 1 + g2() * vol + (i % 6 === 0 ? jump : 0); return { date, close: Math.round(c * 100) / 100 }; });
  const sig = [];
  for (let i = 260; i < 420; i += 6) { r2(); sig.push({ at: `${jb[i - 1].date}T14:00:00.000Z`, source: 'cross', symbol: 'J', expect: 'up', price: 1, label: 'x' }); }
  scoreCases.push({ signals: sig, bars: new Map([['J', jb]]), days: null, early: 'builtin' });
  // 同一批放量(不带方向):看的是之后的波动
  scoreCases.push({ signals: sig.map((x) => ({ ...x, source: 'burst', expect: null })), bars: new Map([['J', jb]]), days: null, early: 'builtin' });
}
for (let r = 0; r < 6; r += 1) {
  const syms = ['A', 'B', 'C', 'D'].slice(0, 2 + (r % 3));
  const bars = new Map(syms.map((s, i) => [s, closes(pick([300, 400, 520]), pick(['2024-06-03', '2024-09-03']), pick([0, 0.0005, -0.0005]), 0.01, pick([0, 0, 7, 9]))]));
  const sigs = [];
  for (const [s, b] of bars) for (const source of ['cross', 'touch', 'spike', 'day_move', 'rvol', 'burst', 'leaders', 'pa']) {
    if (rnd() < 0.4) continue;
    sigs.push(...signalsOn(s, b.slice(250), { rate: pick([0.05, 0.2, 0.5]), source, expect: source === 'rvol' || source === 'burst' ? null : undefined,
      variant: source === 'pa' ? () => pick(['5m', '15m', '1d', null]) : undefined }));
  }
  scoreCases.push({ signals: sigs, bars, days: pick([null, 30, 365]), early: pick(Object.keys(earlySets)) });
}
for (const c of scoreCases) {
  const barsArr = [...c.bars.entries()];
  out.scores.push({ signals: enc(c.signals), bars: barsArr, days: enc(c.days), early: c.early, ...run(() => S.scoreSignals(c.signals, c.bars, c.days, { earlyCloses: earlySets[c.early] })) });
}
out.custom = [...earlySets.custom];

writeFileSync(join(here, 'signal-outcomes.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('signal-outcomes.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
