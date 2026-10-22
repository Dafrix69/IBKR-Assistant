// 生成 econ-calendar.json:engine-ts 的 econCalendar.ts(原模块现跑)。内置日程与每周初请在各种时间窗上的事件、美东日期 + 钟点的换算
// (坏日期、2 月 30 日、闰年、0050 年)、联邦假日、标题 → 家族与讲话人、日历源载荷的解析(写坏的形状、各种 Date.parse 认与不认的时刻、
// 大小写与空白的影响档位、同一时刻同一家族合并、other 的 slug)、三路合并、口径校验的每一句报错。本机时区 Asia/Shanghai。
//   TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_econ_calendar.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('日历源上不带时区的时刻按本机时区读:要 TZ=Asia/Shanghai 跑');
const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const C = await import(pathToFileURL(join(engine, 'dist/src/econCalendar.js')).href);

let seed = 0xec0c_a1e7;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
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

const out = {
  tables: { config: C.DEFAULT_EVENTS_CONFIG, linger: C.LINGER_MIN, stars: C.STARS, labels: C.KIND_LABEL, releases: C.BUILTIN_RELEASES },
  problems: C.builtinProblems(), impact: [], etEpoch: [], holiday: [], claims: [], builtin: [], family: [], starsFor: [], feed: [], merge: [], expires: [], config: [],
};
for (const s of [0, 1, 3, 3.99, 4, 4.5, 5, -1, NaN]) out.impact.push({ s: enc(s), out: C.impactOfStars(s) });

// ---------------------------------------------------------------- 美东日期 + 钟点
const dates = ['2026-10-14', '2026-03-08', '2026-11-01', '2026-02-29', '2024-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32',
  '0050-06-01', '0999-01-01', '1000-01-01', '1883-11-18', '9999-12-31', '2026-1-14', '2026-10-14 ', ' 2026-10-14', '2026/10/14', '20261014', '', '2026-10-14\n', 'abcd-ef-gh'];
const times = ['08:30', '8:30', '00:00', '23:59', '24:00', '23:60', '02:30', '01:30', '123:00', '08:3', '0830', '', '08:30 ', '08:30:00', ':30', '9:5'];
for (const d of dates) for (const t of times) out.etEpoch.push({ d, t, out: enc(C.etEpoch(d, t)) });
for (const d of ['2026-01-01', '2026-06-19', '2020-06-19', '2021-06-19', '2026-07-04', '2026-11-11', '2026-11-21', '2026-11-22', '2026-11-28', '2026-11-29', '2026-12-25',
  '2026-12-24', '2026-1-1', '2026-01', '2026', '', 'x-1-1', '2026-11-25-1', '2026-11-2x', ' 2026-07-04']) out.holiday.push({ d, out: C.thursdayIsFederalHoliday(d) });

// ---------------------------------------------------------------- 内置日程与初请
const ms = (s) => Date.parse(s);
const windows = [
  ['2026-10-13T00:00:00Z', '2026-10-20T00:00:00Z'], ['2026-10-01T00:00:00Z', '2027-12-31T00:00:00Z'], ['2026-11-20T00:00:00Z', '2026-12-31T00:00:00Z'],
  ['2027-06-15T00:00:00Z', '2027-07-10T00:00:00Z'], ['2026-10-14T12:30:00Z', '2026-10-14T12:30:00Z'], ['2026-10-14T12:30:00.001Z', '2026-10-14T12:30:00Z'],
  ['2020-12-20T00:00:00Z', '2021-01-10T00:00:00Z'], ['2026-12-28T00:00:00Z', '2027-01-08T00:00:00Z'], ['1999-11-20T00:00:00Z', '1999-12-01T00:00:00Z'],
  ['9999-12-01T00:00:00Z', '+010000-01-20T00:00:00Z'], ['2026-10-20T00:00:00Z', '2026-10-13T00:00:00Z'],
];
for (const [a, b] of windows) {
  const from = ms(a), to = ms(b);
  out.claims.push({ from, to, ...run(() => C.claimsReleases(from, to)) });
  out.builtin.push({ from, to, ...run(() => C.builtinEvents(from, to)) });
}
for (let i = 0; i < 40; i += 1) {
  const from = ms('2026-09-01T00:00:00Z') + rnd() * 500 * 86_400_000;
  const to = from + pick([0, 3600_000, 86_400_000 * 7, 86_400_000 * 40, -1, 86_400_000 * 2.5]);
  out.builtin.push({ from, to, ...run(() => C.builtinEvents(from, to)) });
}
out.builtin.push({ from: '__NaN__', to: 0, ...run(() => C.builtinEvents(NaN, 0)) });
out.builtin.push({ from: 0, to: '__NaN__', ...run(() => C.builtinEvents(0, NaN)) });

// ---------------------------------------------------------------- 家族与讲话人
const titles = ['CPI m/m', 'Core CPI y/y', 'cpi', 'CPIX', 'xCPI', 'C.P.I', 'PPI m/m', 'ADP Non-Farm Employment Change', 'Non-Farm Employment Change', 'NonFarm Payrolls', 'Non Farm',
  'Unemployment Rate', 'Average Hourly Earnings m/m', 'JOLTS Job Openings', 'job openings', 'FOMC Meeting Minutes', 'FOMC Statement', 'Federal Funds Rate', 'FOMC Press Conference',
  'FOMC Economic Projections', 'Core PCE Price Index m/m', 'Personal Income m/m', 'Personal Spending m/m', 'Advance GDP q/q', 'GDP_x', 'Retail Sales m/m', 'Core Retail Sales m/m',
  'Unemployment Claims', 'Fed Chair Powell Speaks', 'Fed Chairman Powell Testifies', 'FOMC Member Waller Speaks', 'FOMC Member Speaks', 'FOMC Member  Speaks', 'Fed Governor Cook Speaks',
  'Fed Vice Chair Jefferson Speaks', 'FOMC Member Bowman Speaks', 'Fed\nX Speaks', 'Fed X Speaks', 'fed chair', 'ISM Manufacturing PMI', 'ISM', 'ISMx', 'Prelim UoM Consumer Sentiment',
  'Building Permits', 'Bank Holiday', 'Member o\'Neil Speaks', 'Governor Waller-Smith Testifies', 'Chairman X Speaks', 'Chair  Powell   Speaks', 'Member P Speaks', 'Member 1x Speaks',
  'Governor Kugler.Jr testifies', 'Chairmanx Powell Speaks', 'Chair Powell　Speaks', 'FOMC Member Logan Speakers', 'Fed Chair Powell', 'Treasury Sec Bessent Speaks',
  'ＣＰＩ', 'İSM', 'Crude Oil Inventories', '', ' ', 'Fed Chair Powell Speaks (twice)'];
for (const t of titles) out.family.push({ t, out: C.familyOf(t) });
for (const k of ['cpi', 'fed_speech', 'other', 'custom', 'ism', 'cross']) for (const t of ['Fed Chair Powell Speaks', 'FOMC Member Waller Speaks', 'x']) for (const s of [2, 3, 4])
  out.starsFor.push({ k, t, s, out: C.starsFor(k, t, s) });

// ---------------------------------------------------------------- 日历源
const feedDates = ['2026-10-14T08:30:00-04:00', '2026-10-14T08:30:00-04:00', '2026-10-14T14:00:00-04:00', '2026-10-15T08:30:00-04:00', '2026-10-14T12:30:00Z',
  '2026-10-14T08:30:00', '2026-10-14', '2026-10-14 08:30', 'Oct 14 2026 8:30 am EDT', '2026-02-30T08:30:00-05:00', '2026-10-14T08:30:00-0400', 'x', '', '2026-10-14T24:00:00Z',
  '2026-11-01T01:30:00-04:00', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-03-08T07:00:00Z', '1800-01-01T12:00:00Z', '+275760-09-13T00:00:00Z', '-000001-06-01T12:00:00Z',
  '0001-01-01T05:00:00Z', '2026-10-14T03:59:59Z', '2026-10-14T04:00:00Z', '12'];
const feedTitles = ['CPI m/m', 'Core CPI m/m', 'CPI y/y', 'PPI m/m', 'Non-Farm Employment Change', 'Unemployment Rate', 'FOMC Statement', 'Federal Funds Rate', 'FOMC Press Conference',
  'Fed Chair Powell Speaks', 'FOMC Member Waller Speaks', 'Fed Governor Cook Testifies', 'Fed Chair Powell Testifies', 'Fed ChairPowell Speaks', 'Building Permits', 'Building Permits', 'Crude Oil Inventories', 'Retail Sales m/m',
  'Unemployment Claims', '  Prelim UoM Consumer Sentiment  ', 'Empire State Manufacturing Index', 'İstanbul -- Test!!', '---', 'ÄÖÜ ß', '日本 CPI', '', '   ',
  'A very long title that goes on and on past forty characters for sure', '1 2 3', '-x-', 'Ünemployment', 'Bank Holiday', 'GDP Price Index', 'ISM Services PMI'];
const impacts = ['High', 'high', ' HIGH ', 'Medium', 'Low', 'Holiday', 'Non-Economic', '', 'medium\n', 'Hİgh'];
const countries = ['USD', 'usd', 'Usd', ' USD', 'EUR', 'CNY', '', 'USDX'];
const feedValue = (pool) => {
  const r = rnd();
  if (r < 0.85) return pick(pool);
  return pick([null, undefined, 5, true, ['USD'], ['usd', 'x'], {}, [], 0, '__missing__']);
};
const feedRow = () => {
  const row = {};
  for (const [k, pool] of [['title', feedTitles], ['country', countries], ['date', feedDates], ['impact', impacts], ['forecast', ['0.3%', ' 0.2% ', '', '225K', null]],
    ['previous', ['0.4%', '', '  ', '218K', undefined]]]) {
    const v = k === 'country' && rnd() < 0.6 ? 'USD' : k === 'impact' && rnd() < 0.5 ? 'High' : feedValue(pool);
    if (v !== '__missing__') row[k] = v;
  }
  return row;
};
const payloads = [undefined, null, 5, 'x', {}, { 0: { title: 'CPI m/m' } }, [], [null, 0, '', 'x', 5, true, false, [], {}]];
for (let i = 0; i < 260; i += 1) payloads.push(Array.from({ length: Math.floor(rnd() * 14) }, () => (rnd() < 0.05 ? pick([null, 'row', 3, [1]]) : feedRow())));
// 同一时刻同一家族的两条讲话:5 星的联储主席(High → 5)与 3 星的委员(Medium),先后两种次序都放——整组取较高的那个星级
const chairRow = { title: 'Fed Chair Powell Speaks', country: 'USD', date: '2026-10-21T10:00:00-04:00', impact: 'High', forecast: '', previous: '' };
const memberRow = { title: 'FOMC Member Waller Speaks', country: 'USD', date: '2026-10-21T10:00:00-04:00', impact: 'Medium', forecast: '', previous: '' };
const lowRow = { title: 'Fed Governor Cook Speaks', country: 'USD', date: '2026-10-21T10:00:00-04:00', impact: 'Low', forecast: '', previous: '' };
payloads.push([chairRow, memberRow], [memberRow, chairRow], [chairRow, lowRow, memberRow], [lowRow, memberRow]);
// 一周真样子:同一时刻的 CPI 三条、FOMC 两条、讲话
payloads.push([
  { title: 'Core CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.3%' },
  { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '0.4%' },
  { title: 'CPI y/y', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'Medium', forecast: '2.9%', previous: '2.9%' },
  { title: 'FOMC Statement', country: 'USD', date: '2026-10-28T14:00:00-04:00', impact: 'High', forecast: '', previous: '' },
  { title: 'Federal Funds Rate', country: 'USD', date: '2026-10-28T14:00:00-04:00', impact: 'High', forecast: '4.00%', previous: '4.25%' },
  { title: 'FOMC Member Waller Speaks', country: 'USD', date: '2026-10-16T10:00:00-04:00', impact: 'Medium', forecast: '', previous: '' },
  { title: 'Fed Chair Powell Speaks', country: 'USD', date: '2026-10-16T10:00:00-04:00', impact: 'High', forecast: '', previous: '' },
  { title: 'Unemployment Claims', country: 'USD', date: '2026-10-15T08:30:00-04:00', impact: 'High', forecast: '225K', previous: '218K' },
  { title: 'Building Permits', country: 'USD', date: '2026-10-17T08:30:00-04:00', impact: 'Low', forecast: '1.40M', previous: '1.31M' },
  { title: 'German ZEW', country: 'EUR', date: '2026-10-14T05:00:00-04:00', impact: 'High', forecast: '', previous: '' },
]);
const feedsParsed = [];
for (const p of payloads) {
  const r = run(() => C.parseFeed(p));
  out.feed.push({ payload: enc(p), ...r });
  if (r.out) feedsParsed.push(C.parseFeed(p));
}

// ---------------------------------------------------------------- 合并
const builtinSets = [C.builtinEvents(ms('2026-10-12T00:00:00Z'), ms('2026-11-01T00:00:00Z')), C.builtinEvents(ms('2026-10-01T00:00:00Z'), ms('2027-02-01T00:00:00Z')), []];
// 第四份是手拼的:有 kind = other 的、缺 title / linger_min 的(合并时展开成 undefined)
builtinSets.push([{ id: 'builtin:other:x', kind: 'other', title: 'B', at: ms('2026-10-14T12:30:00Z'), date_et: '2026-10-14', stars: 3, linger_min: 5 },
  { id: 'builtin:cpi:2026-10-14', kind: 'cpi', at: ms('2026-10-14T12:30:00Z'), date_et: '2026-10-14', stars: 5 }]);
const customs = [[], [{ id: 'custom:abc', kind: 'custom', title: '发债', at: ms('2026-10-14T12:30:00Z'), date_et: '2026-10-14', time_et: '08:30', stars: 4, impact: 'high', source: 'custom', linger_min: 90, note: 'x' }],
  [{ id: 'custom:a', kind: 'cpi', title: 'x', at: ms('2026-10-14T12:30:00Z'), date_et: '2026-10-14', stars: 3, linger_min: 10 }, { id: 'custom:0', at: 0, linger_min: 0, kind: 'other' }]];
for (let i = 0; i < 80; i += 1) {
  const b = i < 12 ? builtinSets[3] : pick(builtinSets), f = pick(feedsParsed), c = pick(customs);
  // 日历源里偶尔放一条和内置撞家族撞日子的,或者 kind 写成 other 的
  const feed = rnd() < 0.3 ? [...f, { id: 'feed:cpi:1', kind: 'cpi', title: 'CPI', at: ms('2026-10-14T12:30:00Z'), date_et: '2026-10-14', time_et: '08:30', stars: pick([3, 4, 5, 6]), impact: 'high', source: 'feed', linger_min: 90, items: [] }]
    : rnd() < 0.2 ? [...f, { id: 'feed:other:1', kind: 'other', title: 'CPI', at: 1, date_et: '2026-10-14', stars: 2, linger_min: 60 }] : f;
  const r = run(() => C.mergeEvents(b, feed, c));
  out.merge.push({ b: builtinSets.indexOf(b), feed: enc(feed), custom: enc(c), ...r });
  if (r.out) for (const e of C.mergeEvents(b, feed, c)) if (rnd() < 0.2) out.expires.push({ e: enc(e), out: enc(C.expiresAt(e)) });
}

// ---------------------------------------------------------------- 口径
const cfgValues = [undefined, null, true, false, 0, 1, 3, '3', ' 4 ', '', '  ', 'x', 2.5, 5, 6, NaN, '1e0', [], {}, '0x3', 30, 31, 0.3, 0.29, 1, 1.01, 10, 10.5, 50, 0.5, 0.2, '0.25'];
const leadValues = [undefined, null, [], [60], [60, 15], [15, 60, 15], [1, 1440], [0], [1441], [1.5], ['30', ' 5 '], ['', 5], [5, 6, 7, 8], [5, 6, 7, 8, 9], '60', 60, [NaN], [true], [null], [-0, 1]];
const cfgKeys = ['enabled', 'feed', 'cross_market', 'min_stars', 'medium', 'sector_min_stocks', 'sector_share', 'sector_move_pct', 'cross_market_pct', 'cross_lag_pct', 'bogus'];
const inputs = [undefined, null, 5, 'x', [], {}, { medium: true }, { medium: 'yes' }, { medium: true, min_stars: 5 }, { lead_minutes: [30, 10, 30] }];
for (let i = 0; i < 400; i += 1) {
  const o = {};
  for (let n = 1 + Math.floor(rnd() * 3); n > 0; n -= 1) o[pick(cfgKeys)] = pick(cfgValues);
  if (rnd() < 0.3) o.lead_minutes = pick(leadValues);
  for (const k of Object.keys(o)) if (o[k] === undefined && rnd() < 0.5) delete o[k];
  inputs.push(o);
}
const bases = [C.DEFAULT_EVENTS_CONFIG, { ...C.DEFAULT_EVENTS_CONFIG, min_stars: 2, lead_minutes: [5], extra: 'kept' }];
for (const input of inputs) for (const [bi, base] of bases.entries()) {
  if (bi === 1 && rnd() < 0.6) continue;
  out.config.push({ input: enc(input), base: bi, ...run(() => (bi === 0 ? C.normalizeEventsConfig(input) : C.normalizeEventsConfig(input, base))) });
}
out.bases = bases;
out.builtin4 = builtinSets[3];

writeFileSync(join(here, 'econ-calendar.json'), JSON.stringify(out) + '\n');
console.log(`econ-calendar.json: ${out.feed.length} 份载荷, ${out.merge.length} 次合并, ${out.config.length} 份口径, ${out.etEpoch.length} 个钟点`);
