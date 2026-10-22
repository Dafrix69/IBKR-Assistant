// 生成 ma-touch.json:engine-ts 的 maTouch.ts(原模块现跑)在随机与写明的输入上的结论——设置的校验(数字串、布尔、数组、越界、凑不够段数)、
// 前一个交易日(几种日历)、券商日线的挑拣(缺价、乱序、重复、今天那根、坏日期)、每天碰没碰与分段、底账(凑不满的均线、带过来的 fired)、
// 底账能不能用、盘中这一轮的判定(贴近、跨过、接着昨天那一段、报过的不再报、凑不够次数)。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_ma_touch.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/maTouch.js')).href);

let seed = 0x3a70_0c11;
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

const out = { normalize: [], prevDay: [], completed: [], days: [], books: [], usable: [], evals: [] };

// ---------------------------------------------------------------- 设置
const valuePool = [true, false, 0, 1, 2, 3, 4, 5, 10, 20, 30, 31, '5', ' 7 ', '', ' ', 'x', 2.5, -1, 0.3, '0.3', '1e1', '0x10', 1e-9, 2, 2.00001, 1.99995, 0.123456, '0.12345',
  null, [], [20], [20, 60], ['20', 60, 60], [5, 250, 251], [5, 6, 7, 8, 9, 10, 11], [5, 6, 7, 8, 9, 10, 10], [250, 5, 120], [4], [true], ['a'], {}, { a: 1 },
  NaN, Infinity, 'Infinity', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', '字'.repeat(45), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]];
const keyPool = ['enabled', 'periods', 'window_days', 'min_touches', 'band_pct', 'bogus', 'toString'];
const rawConfig = () => {
  const o = {};
  for (let n = Math.floor(rnd() * 5); n > 0; n -= 1) o[pick(keyPool)] = pick(valuePool);
  return o;
};
const bases = [undefined, { enabled: false, periods: [10, 50], window_days: 6, min_touches: 2, band_pct: 0.5 }, { enabled: true, periods: [200], window_days: 30, min_touches: 10, band_pct: 0 }];
for (const raw of [undefined, null, [], 'abc', 5, true, {}, { window_days: 3, min_touches: 3 }, { window_days: 4, min_touches: 2 }, { window_days: 5, min_touches: 3 }, { window_days: 5, min_touches: 4 },
  { periods: [60, 20, 20, '120'] }, { band_pct: '0.12345' }, { band_pct: 2 }, { band_pct: 2.00001 }, { enabled: 'true' }, { enabled: null, periods: null, window_days: null }]) {
  for (const base of bases) out.normalize.push({ raw: enc(raw), base: enc(base), ...run(() => M.normalizeTouchConfig(raw, base)) });
}
for (let i = 0; i < 700; i += 1) {
  const raw = rawConfig();
  const base = pick(bases);
  out.normalize.push({ raw: enc(raw), base: enc(base), ...run(() => M.normalizeTouchConfig(raw, base)) });
}

// ---------------------------------------------------------------- 前一个交易日
const holidays = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
const weekday = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
const calendars = {
  weekday,
  nyse: (d) => weekday(d) && !holidays.has(d),
  never: () => false,
  always: () => true,
  odd: (d) => Number(d.slice(8, 10)) % 2 === 1,
};
const dayList = ['2026-01-02', '2026-01-05', '2026-01-20', '2026-03-01', '2026-03-09', '2026-04-06', '2026-07-06', '2026-11-27', '2026-12-28', '2026-10-19', '2024-03-01',
  '2000-01-03', '1970-01-01', '2026-02-29', '2026-13-01', '', 'abc', '2026-1-5', '2026-10-15T09:30'];
for (const d of dayList) for (const name of Object.keys(calendars)) out.prevDay.push({ date: d, cal: name, ...run(() => M.prevTradingDay(d, calendars[name])) });

// ---------------------------------------------------------------- 日线
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
function tradingDates(start, n) {
  const list = [];
  let ms = Date.parse(`${start}T00:00:00Z`);
  while (list.length < n) {
    const d = iso(ms);
    if (calendars.nyse(d)) list.push(d);
    ms += 86_400_000;
  }
  return list;
}
/** 收盘随机游走;高低在收盘两边 */
function series(n, opts = {}) {
  const dates = tradingDates(opts.start ?? '2025-01-02', n);
  let c = opts.price ?? 100;
  return dates.map((date) => {
    c = Math.max(1, c * (1 + gauss() * (opts.vol ?? 0.012) + (opts.drift ?? 0)));
    const close = Math.round(c * 100) / 100;
    const high = Math.round((close * (1 + Math.abs(gauss()) * (opts.range ?? 0.008))) * 100) / 100;
    const low = Math.round((close * (1 - Math.abs(gauss()) * (opts.range ?? 0.008))) * 100) / 100;
    return { date: opts.stamp ? `${date} 00:00:00` : date, open: close, high, low, close, volume: 1000 };
  });
}
function dirty(bars) {
  const b = bars.map((x) => ({ ...x }));
  for (let i = 0; i < 6; i += 1) {
    const j = Math.floor(rnd() * b.length);
    const kind = pick(['nullClose', 'strHigh', 'zero', 'nan', 'dup', 'swap', 'noDate', 'numDate', 'inf', 'neg', 'drop']);
    if (!b[j]) continue;
    if (kind === 'nullClose') b[j].close = null;
    else if (kind === 'strHigh') b[j].high = String(b[j].high);
    else if (kind === 'zero') b[j].low = 0;
    else if (kind === 'nan') b[j].close = NaN;
    else if (kind === 'dup' && j > 0) b[j].date = b[j - 1].date;
    else if (kind === 'swap' && j > 0) [b[j], b[j - 1]] = [b[j - 1], b[j]];
    else if (kind === 'noDate') delete b[j].date;
    else if (kind === 'numDate') b[j].date = 20260101;
    else if (kind === 'inf') b[j].high = Infinity;
    else if (kind === 'neg') b[j].close = -b[j].close;
    else if (kind === 'drop') b.splice(j, 1);
  }
  return b;
}
for (let i = 0; i < 80; i += 1) {
  const bars = series(5 + Math.floor(rnd() * 40), { stamp: rnd() < 0.2 });
  const b = rnd() < 0.6 ? dirty(bars) : bars;
  const last = b[b.length - 1]?.date ?? '2025-02-01';
  const today = pick([String(last).slice(0, 10), '2030-01-01', '2025-01-15', '', String(b[Math.floor(b.length / 2)]?.date ?? '').slice(0, 10)]);
  out.completed.push({ bars: enc(b), today, ...run(() => M.completedBars(b, today)) });
}
for (const [bars, today] of [[null, '2026-01-01'], [undefined, '2026-01-01'], [[], '2026-01-01'], [[null], '2026-01-01'], [[5, 'x', [1]], '2026-01-01'],
  [[{ date: '2026-01-02', high: 2, low: 1, close: 1.5 }, { date: '2026-01-02T12', high: 2, low: 1, close: 1.5 }], '2026-01-03']]) {
  out.completed.push({ bars: enc(bars), today, ...run(() => M.completedBars(bars, today)) });
}

// ---------------------------------------------------------------- 每天的触碰与分段
for (let i = 0; i < 60; i += 1) {
  const bars = M.completedBars(series(10 + Math.floor(rnd() * 60), { vol: pick([0.003, 0.01, 0.02]), range: pick([0.002, 0.01, 0.03]) }), '2030-01-01');
  const period = pick([5, 10, 20, 3, 1, 2]), band = pick([0, 0.3, 1, 2, 0.05]);
  const days = M.touchDays(bars, period, band);
  out.days.push({ bars, period, band, days: enc(days), episodes: enc(M.episodesOf(days)) });
}

// 写明的:最低价正好落在均线(容差 0)、最高价正好落在下沿
{
  const dates = tradingDates('2026-01-05', 8);
  const flat = dates.map((date, i) => ({ date, high: i % 2 ? 101 : 100.5, low: i % 3 ? 100 : 99, close: 100 }));
  for (const band of [0, 0.5]) {
    const days = M.touchDays(flat, 3, band);
    out.days.push({ bars: flat, period: 3, band, days: enc(days), episodes: enc(M.episodesOf(days)) });
  }
  const above = dates.map((date) => ({ date, high: 102, low: 100, close: 100 }));
  const days = M.touchDays(above, 2, 0);
  out.days.push({ bars: above, period: 2, band: 0, days: enc(days), episodes: enc(M.episodesOf(days)) });
}

// ---------------------------------------------------------------- 底账
const configs = [M.DEFAULT_TOUCH_CONFIG, M.normalizeTouchConfig({ periods: [5, 10, 20], window_days: 6, min_touches: 2, band_pct: 0.5 }),
  M.normalizeTouchConfig({ periods: [5], window_days: 3, min_touches: 2, band_pct: 2 }), M.normalizeTouchConfig({ periods: [20, 60], window_days: 30, min_touches: 10, band_pct: 1 }),
  M.normalizeTouchConfig({ periods: [5, 250], window_days: 10, min_touches: 3, band_pct: 0 }), M.normalizeTouchConfig({ band_pct: 0.4 }), M.normalizeTouchConfig({ periods: [5, 6, 7, 8, 9, 10], window_days: 20, min_touches: 4, band_pct: 1.2 })];
const firedPool = [undefined, {}, { 20: '2025-03-03', 60: '2025-01-01', 5: '2025-05-05' }, { 10: '2026-01-01', 999: 'x', 5: null }, { 200: '2025-06-01', 20: 7 }];
const bookCases = [];
for (let i = 0; i < 90; i += 1) {
  const cfgIdx = Math.floor(rnd() * configs.length);
  const n = pick([3, 12, 30, 60, 130, 230, 260, 290]);
  const bars = series(n, { vol: pick([0.004, 0.01, 0.02]), range: pick([0.004, 0.01, 0.02]), price: pick([40, 100, 450, 6500]) });
  const b = rnd() < 0.2 ? dirty(bars) : bars;
  const today = rnd() < 0.8 ? tradingDates(String(bars[bars.length - 1].date).slice(0, 10), 2)[1] : String(bars[Math.floor(n / 2)].date).slice(0, 10);
  const fired = pick(firedPool);
  const r = run(() => M.buildTouchBook(b, today, configs[cfgIdx], fired));
  out.books.push({ bars: enc(b), today, cfg: cfgIdx, fired: enc(fired), ...r });
  if (r.out && r.out !== '__undefined__' && r.out !== null) bookCases.push({ book: M.buildTouchBook(b, today, configs[cfgIdx], fired), cfgIdx, today, bars: M.completedBars(b, today) });
}
for (const [bars, fired] of [[[], undefined], [null, undefined], [series(30), null], [series(2), null]]) {
  out.books.push({ bars: enc(bars), today: '2030-01-01', cfg: 1, fired: enc(fired), ...run(() => M.buildTouchBook(bars, '2030-01-01', configs[1], fired)) });
}
out.configs = configs;

// ---------------------------------------------------------------- 底账能不能用
for (const { book, cfgIdx } of bookCases.slice(0, 40)) {
  for (const [ci, prevDay] of [[cfgIdx, book.as_of], [cfgIdx, '2000-01-01'], [(cfgIdx + 1) % configs.length, book.as_of], [cfgIdx === 0 ? 5 : 0, book.as_of]]) {
    out.usable.push({ book, cfg: ci, prevDay, out: M.bookUsable(book, configs[ci], prevDay) });
  }
  const shuffled = { ...book, periods: [...book.periods].reverse() };
  out.usable.push({ book: shuffled, cfg: cfgIdx, prevDay: book.as_of, out: M.bookUsable(shuffled, configs[cfgIdx], book.as_of) });
  const noPeriods = { ...book };
  delete noPeriods.periods;
  out.usable.push({ book: noPeriods, cfg: cfgIdx, prevDay: book.as_of, out: M.bookUsable(noPeriods, configs[cfgIdx], book.as_of) });
}
out.usable.push({ book: null, cfg: 0, prevDay: '2026-01-01', out: M.bookUsable(null, configs[0], '2026-01-01') });
// 库里的 periods 是没检查过的数(含 NaN):排序时 NaN 当相等,不到 8 个是直接的二分插入
for (const periods of [[-45838.4, 6589.1, NaN, 0, 0.2], [200, NaN, 20, 60, 120], [NaN, 20, 60, 120, 200], [120, 60, NaN, 200, 20, NaN]]) {
  const book = { as_of: '2026-10-16', window_days: 10, band_pct: 0.3, periods, lines: [], fired: {} };
  out.usable.push({ book: enc(book), cfg: 0, prevDay: '2026-10-16', out: M.bookUsable(book, configs[0], '2026-10-16') });
}

// ---------------------------------------------------------------- 盘中
for (const { book, cfgIdx, today } of bookCases) {
  const cfg = pick([configs[cfgIdx], configs[cfgIdx], configs[(cfgIdx + 2) % configs.length]]);
  let fired = book;
  for (let step = 0; step < 6; step += 1) {
    const line = pick(book.lines.length ? book.lines : [{ period: 20, prior_sum: 1900 }]);
    const ma = line.prior_sum / (line.period - 1);
    const price = pick([ma, ma * (1 + 0.001 * gauss()), ma * (1 + 0.01 * gauss()), ma * (1 + 0.03 * gauss()), 0, -5, NaN, Math.round(ma)]);
    const prevPrice = pick([null, null, ma * (1 + 0.01 * gauss()), price, 0, -1, ma * 1.05, ma * 0.95]);
    const t = pick([today, today, book.as_of, '2099-01-01']);
    const r = M.evaluateTouches(fired, cfg, price, prevPrice, t);
    out.evals.push({ book: fired, cfg: configs.indexOf(cfg), price: enc(price), prevPrice: enc(prevPrice), today: t, out: enc(r) });
    fired = { ...fired, fired: r.fired };
  }
}
// 写明的:接着昨天那一段(continuing)、凑不够次数、报过的同一段、跨过而不贴近
{
  const book = { as_of: '2026-10-16', window_days: 10, band_pct: 0.3, periods: [20], fired: {},
    lines: [{ period: 20, prior_sum: 1900, episodes: [{ start: '2026-10-06', end: '2026-10-07', side: 'above' }, { start: '2026-10-09', end: '2026-10-09', side: 'below' }, { start: '2026-10-14', end: '2026-10-16', side: 'above' }] }] };
  for (const [price, prev, fired] of [[100, null, {}], [100.2, 99.5, {}], [103, 97, {}], [100, null, { 20: '2026-10-14' }], [100, null, { 20: '2026-10-13' }], [100, null, { 20: 20261014 }], [100, 100, {}], [97, 103, {}]]) {
    const b = { ...book, fired };
    out.evals.push({ book: b, cfg: 0, price, prevPrice: prev, today: '2026-10-19', out: enc(M.evaluateTouches(b, configs[0], price, prev, '2026-10-19')) });
  }
  // 上一轮的价正好压在它那一刻的均线上((1900 + 100) / 20 = 100),这一轮离得远:乘积是 0,算跨过
  for (const [price, prev] of [[110, 100], [90, 100], [110, 100.01]]) {
    out.evals.push({ book, cfg: 0, price, prevPrice: prev, today: '2026-10-19', out: enc(M.evaluateTouches(book, configs[0], price, prev, '2026-10-19')) });
  }
  const fresh = { ...book, lines: [{ ...book.lines[0], episodes: book.lines[0].episodes.slice(0, 2) }] };
  out.evals.push({ book: fresh, cfg: 0, price: 100, prevPrice: null, today: '2026-10-19', out: enc(M.evaluateTouches(fresh, configs[0], 100, null, '2026-10-19')) });
  const one = { ...book, lines: [{ ...book.lines[0], episodes: book.lines[0].episodes.slice(0, 1) }] };
  out.evals.push({ book: one, cfg: 0, price: 100, prevPrice: null, today: '2026-10-19', out: enc(M.evaluateTouches(one, configs[0], 100, null, '2026-10-19')) });
}

writeFileSync(join(here, 'ma-touch.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('ma-touch.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
