// 生成 tradereview.json:engine-ts 的 tradereview.ts(原模块现跑)在合成的蝴蝶记录、平仓单、分钟线 / 日线上的结论:
// 结构识别(1:2:1、同到期、同方向,腿的各种坏法)、时间解析(IB 成交时间三种写法、美东墙钟、带时区的 ISO)、
// 开仓 ↔ 平仓配对(id 撞车、Object.prototype 上的名字、数与串的 id)、整段复盘(平仓 / 到期 / 持仓中、K 线缺值、
// 超过 240 根时的抽稀)与 marketOpportunity 就地改写。输入一律先过一遍 JSON(C++ 读的就是这个),K 线各是各的对象。
// Date.parse 的 V8 旧式写法("Aug 12 2026"、"+0000" 偏移)不在里面:util::jsDateParse 只认 ISO(见报告);
// 不带时区的小数秒 ISO 按本机时区读,单列在 localParse 里,测试只在同一个时区下比。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_tradereview.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const T = await import(pathToFileURL(join(engine, 'dist/src/tradereview.js')).href);

let seed = 0x7e71_e3a5;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
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
const rt = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const pad = (n) => String(n).padStart(2, '0');

const out = { legacyParse: [], runtime: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, fmtExpiry: [], profiles: [], payoff: [], parseWhen: [], localParse: [], etKey: [],
  entryOf: [], findExit: [], pairs: [], barsMisc: [], timeframes: [], reviews: [], market: [] };

// ---------------------------------------------------------------- fmtExpiry
for (const raw of ['20261016', '2026101', '202610160', '2026-10-16', '', null, undefined, 20261016, 2026.1016, true, [2026, 10], { a: 1 }, '２０２６１０１６', '20261016\n', ' 20261016'])
  out.fmtExpiry.push({ raw: enc(raw), out: T.fmtExpiry(raw) });

// ---------------------------------------------------------------- 记录
const EXP = ['20261016', '20261017', '20261023', '2026-10-16', '20261016 ', 'abc', '', '20260230'];
function flyRecord(o = {}) {
  const k = o.center ?? 5800, w = o.wing ?? 10, wu = o.wingUpper ?? w, right = o.right ?? 'C', exp = o.expiry ?? '20261016';
  const wingAct = o.action === 'SELL' ? 'SELL' : 'BUY', bodyAct = wingAct === 'BUY' ? 'SELL' : 'BUY';
  const legs = [
    { conId: 1, strike: k - w, action: wingAct, ratio: 1, right, lastTradeDateOrContractMonth: exp, tradingClass: o.tc ?? 'SPXW', multiplier: o.legMult ?? '100' },
    { conId: 2, strike: k, action: bodyAct, ratio: 2, right, lastTradeDateOrContractMonth: exp, tradingClass: 'SPXW' },
    { conId: 3, strike: k + wu, action: wingAct, ratio: 1, right, lastTradeDateOrContractMonth: exp },
  ];
  if (o.shuffle) legs.reverse();
  const rec = {
    id: o.id ?? `r${int(1, 99999)}`,
    created_at: o.created_at,
    contract: { secType: 'BAG', symbol: o.symbol ?? 'SPX', exchange: 'SMART', currency: 'USD', multiplier: o.mult, legs },
    order: { action: o.action ?? 'BUY', totalQuantity: o.qty ?? 1, lmtPrice: o.limit ?? null },
    ibkr: { avg_fill_price: o.fill ?? null, fills: o.fills ?? [] },
    final_status: o.status ?? 'filled',
  };
  if (o.mutate) o.mutate(rec);
  return rt(rec);
}
// IB 成交时间的几种写法(同一个时刻:美东墙钟 day hh:mm:ss)
function ibTime(day, hh, mm, ss, style, epoch) {
  const d = day.replace(/-/g, '');
  switch (style) {
    case 'utc': { const t = new Date(epoch); return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; }
    case 'central': return `${d} ${pad(hh - 1)}:${pad(mm)}:${pad(ss)} US/Central`;
    case 'eastern': return `${d} ${pad(hh)}:${pad(mm)}:${pad(ss)} US/Eastern`;
    case 'plain': return `${d}  ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    case 'wall': return `${day} ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    case 'wallT': return `${day}T${pad(hh)}:${pad(mm)}`;
    case 'iso': return new Date(epoch).toISOString();
    case 'isoOff': return new Date(epoch).toISOString().replace('Z', '+00:00').replace('T', ' ');
    case 'num': return epoch;
    case 'shanghai': { const t = new Date(epoch + 8 * 3600e3); return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} Asia/Shanghai`; }
    default: return `${day} ${pad(hh)}:${pad(mm)}`;
  }
}
const STYLES = ['utc', 'central', 'eastern', 'plain', 'wall', 'wallT', 'iso', 'isoOff', 'num', 'shanghai', 'min'];
const etMs = (day, hh, mm, ss = 0) => T.parseWhen(`${day} ${pad(hh)}:${pad(mm)}:${pad(ss)}`);

// ---------------------------------------------------------------- butterflyProfile:坏法
const badRecords = [
  null, undefined, 5, 'x', [], {}, { contract: null }, { contract: 5 }, { contract: { secType: 'BAG' } }, { contract: { secType: 'OPT', legs: [] } },
  { contract: { secType: 'BAG', legs: 'abc' } }, { contract: { secType: 'BAG', legs: 'abcd' } }, { contract: { secType: 'BAG', legs: 7 } }, { contract: { secType: 'BAG', legs: {} } },
  { contract: { secType: 'BAG', legs: true } }, { contract: { secType: 'BAG', legs: null } }, { contract: { secType: 'BAG', legs: [1, 2, 3] } },
  { contract: { secType: 'BAG', legs: [null, 1, 2] } }, { contract: { secType: 'BAG', legs: [{ strike: '' }, null, 2] } }, { contract: { secType: 'BAG', legs: [{ strike: 1 }, null, 2] } },
  { contract: { secType: 'bag', legs: [] } }, { contract: [] },
];
for (const r of badRecords) out.profiles.push({ record: enc(r), ...run(() => T.butterflyProfile(r)) });
const legMutations = [
  (r) => { r.contract.legs[1].ratio = 1; }, (r) => { r.contract.legs[1].ratio = '2'; }, (r) => { r.contract.legs[1].ratio = 2.9; }, (r) => { r.contract.legs[0].ratio = 0; },
  (r) => { r.contract.legs[0].ratio = null; }, (r) => { r.contract.legs[0].ratio = 'x'; }, (r) => { r.contract.legs[0].ratio = -1; }, (r) => { r.contract.legs[2].action = 'SELL'; },
  (r) => { r.contract.legs[1].action = 'BUY'; }, (r) => { r.contract.legs[0].right = 'P'; }, (r) => { r.contract.legs[0].lastTradeDateOrContractMonth = '20261017'; },
  (r) => { delete r.contract.legs[0].right; delete r.contract.legs[1].right; delete r.contract.legs[2].right; }, (r) => { r.contract.legs[0].strike = '5790'; },
  (r) => { r.contract.legs[0].strike = ' '; }, (r) => { r.contract.legs[0].strike = 'abc'; }, (r) => { r.contract.legs[0].strike = [5790]; }, (r) => { r.contract.legs[0].strike = true; },
  (r) => { r.contract.legs[0].strike = 5810; }, (r) => { r.contract.legs.push({ strike: 1 }); }, (r) => { r.contract.legs.pop(); },
  (r) => { r.order = null; }, (r) => { r.order = 5; }, (r) => { r.order.action = 'sell'; }, (r) => { delete r.order.action; }, (r) => { r.order.action = 7; },
  (r) => { r.order.totalQuantity = 0; }, (r) => { r.order.totalQuantity = 0.5; }, (r) => { r.order.totalQuantity = -0.5; }, (r) => { r.order.totalQuantity = '3'; }, (r) => { r.order.totalQuantity = 2.7; },
  (r) => { r.order.totalQuantity = ''; }, (r) => { r.order.lmtPrice = '1.25'; }, (r) => { r.order.lmtPrice = ''; }, (r) => { r.ibkr = null; }, (r) => { r.ibkr = 'x'; },
  (r) => { r.ibkr.avg_fill_price = 0; }, (r) => { r.ibkr.avg_fill_price = '2.5'; }, (r) => { r.contract.multiplier = '10'; }, (r) => { r.contract.multiplier = 0; },
  (r) => { r.contract.multiplier = 'x'; r.contract.legs.forEach((l) => { l.multiplier = 50; }); }, (r) => { delete r.contract.symbol; }, (r) => { r.contract.symbol = 5; },
  (r) => { r.contract.legs.forEach((l) => { l.lastTradeDateOrContractMonth = 20261016; }); }, (r) => { r.contract.legs[0].tradingClass = null; },
  (r) => { r.contract.legs[0].strike = -0; r.contract.legs[1].strike = 5; r.contract.legs[2].strike = 10; },
];
for (let i = 0; i < 260; i += 1) {
  const o = { center: pick([5800, 5812.5, 100, 7.25, 0]), wing: pick([5, 10, 20, 25, 0.5, 2.5]), wingUpper: rnd() < 0.15 ? pick([5, 15, 30]) : undefined, right: pick(['C', 'P', 'c', '']),
    expiry: pick(EXP), action: pick(['BUY', 'SELL', 'buy']), qty: pick([1, 2, 3, 10]), fill: rnd() < 0.6 ? pick([1.25, 2.5, 3.1, 0.05, 7]) : undefined,
    limit: rnd() < 0.5 ? pick([1.2, 2.45, null]) : undefined, mult: pick([undefined, '100', 100, '10']), legMult: pick(['100', undefined, '50']), shuffle: rnd() < 0.4, tc: pick(['SPXW', 'SPX', '']) };
  if (rnd() < 0.5) o.mutate = pick(legMutations);
  const r = flyRecord(o);
  const res = run(() => T.butterflyProfile(r));
  out.profiles.push({ record: r, ...res });
  if (res.out && res.out !== null && typeof res.out === 'object') {
    const p = T.butterflyProfile(r);
    const ss = [p.lower - 5, p.lower, p.center, p.upper, p.upper + 5, (p.lower + p.center) / 2, p.center + gauss() * 10, 0, -1e9];
    out.payoff.push({ profile: p, s: ss, payoff: enc(ss.map((s) => T.payoffPerUnit(p, s))), pnl: enc(ss.map((s) => T.pnlAt(p, s))), zone: enc(T.zone(p)) });
  }
}
// sameButterfly / zone 的边角:卖出、debit 为 0
for (const tweak of [{ debit: 0 }, { action: 'SELL' }, { debit: 12 }, { qty: 0 }, { multiplier: 10 }, { width_upper: 5 }]) {
  const p = { ...T.butterflyProfile(flyRecord({ fill: 2 })), ...tweak };
  const ss = [5790, 5795, 5800, 5805, 5810];
  out.payoff.push({ profile: p, s: ss, payoff: enc(ss.map((s) => T.payoffPerUnit(p, s))), pnl: enc(ss.map((s) => T.pnlAt(p, s))), zone: enc(T.zone(p)) });
}

// ---------------------------------------------------------------- parseWhen / etKey
const whenInputs = [
  null, undefined, 0, -1, 1.5, NaN, Infinity, 1789000000000, 8.64e15, true, false, [], {}, [2026], '', '   ', '\t2026-10-16 10:00\n',
  '20261016-14:00:01', '20261016-24:00:01', '20261016-14:60:01', '20261316-14:00:01', '20260230-14:00:01', '20261016 09:00:01 US/Central', '20261016 09:00:01 US/Mountain',
  '20261016 09:00:01 US/Pacific', '20261016 09:00:01 US/Eastern', '20261016 09:00:01 Europe/London', '20261016 09:00:01 Foo/Bar', '20261016 09:00:01', '20261016   09:00:01',
  '20261016 9:00:01', '20261016 09:00:01 ', '20261016 09:00:01 US/Central extra', '20261101 01:30:00', '20261101 01:30:00 US/Eastern', '20260308 02:30:00', '20260308 02:30:00 US/Eastern',
  '2026-10-16', '2026-10-16 10:00', '2026-10-16T10:00', '2026-10-16 10:00:05', '2026-10-16T10:00:05', '2026-10-16 24:00', '2026-10-16 23:59:59', '2026-13-01', '2026-02-29', '2028-02-29',
  '2026-02-31 10:00', '2026-10-16 10:61', '0000-01-01', '0099-12-31 10:00', '1883-01-01', '2026-11-01 01:30', '2026-03-08 02:30', '2026-10-16  10:00', '2026-10-16 10:00 ',
  '2026-10-16T14:00:00Z', '2026-10-16T14:00:00+00:00', '2026-10-16 14:00:00+00:00', '2026-10-16 14:00:00Z', '2026-10-16T14:00:00.123Z', '2026-10-16T14:00:00.5+08:00',
  '2026-10-16T14:00:00-05:00', '2026-10-16T14:00:00.123456+00:00', '2026-10-16T24:00:00Z', '2026-10-16T14:00Z', '2026-10-16T14Z', '2026-10Z', '2026Z', '2026', '2026-10',
  '+002026-10-16T14:00:00Z', '2026-10-16T14:00:00.000+00:00Z', 'ZZ', 'garbage', '2026-10-16T14:00:00+0000Z',
  '2026-10-16 14:00:00 Z', '1970-01-01T00:00:00Z', '2026-10-16T14:00:60Z',
];
for (const v of whenInputs) {
  const r = run(() => T.parseWhen(v));
  const row = { v: enc(v), ...r };
  if (r.out !== undefined && typeof r.out === 'number') {
    row.key = run(() => T.etKey(r.out, false));
    row.day = run(() => T.etKey(r.out, true));
  }
  out.parseWhen.push(row);
}
for (const v of ['2026-10-16T14:00:00.5', '2026-10-16 14:00:00.25', '2026-10-16T14:00:00.000']) out.localParse.push({ v, ...run(() => T.parseWhen(v)) });
// V8 的 Date.parse 旧式写法:TS 读得出,util::jsDateParse 只认 ISO 读不出——已知的差别,测试核对它仍是这个样子
out.legacyParse = ['Aug 12 2026', '2026-10-16T14:00:00+0000', '２０２６-10-16', '2026-10-16T14:00:00z', '-000001-01-01T00:00:00Z', '275760-09-13']
  .map((v) => ({ v, ...run(() => T.parseWhen(v)) }));
for (let i = 0; i < 300; i += 1) {
  const ms = pick([Date.UTC(2026, int(0, 11), int(1, 28), int(0, 23), int(0, 59), int(0, 59)) + int(0, 999), Date.UTC(int(1950, 2100), 0, 1) + rnd() * 3e10,
    Date.UTC(2026, 2, 8, 6, int(0, 59)), Date.UTC(2026, 10, 1, 5, int(0, 59)), -int(1, 1e6) * 1000, int(0, 1e12) + 0.75]);
  out.etKey.push({ ms, key: T.etKey(ms, false), day: T.etKey(ms, true) });
}
for (const ms of [NaN, Infinity, 8.64e15 + 1, -Infinity]) out.etKey.push({ ms: enc(ms), ...run(() => T.etKey(ms, false)) });

// ---------------------------------------------------------------- entryOf / findExit / pairButterflies
const entryCases = [
  null, {}, { created_at: '2026-10-16 10:00' }, { created_at: 'x' }, { created_at: 1789000000000 }, { ibkr: null, created_at: '2026-10-16' }, { ibkr: 5 },
  { ibkr: { fills: 5 } }, { ibkr: { fills: {} } }, { ibkr: { fills: 'ab' } }, { ibkr: { fills: true } }, { ibkr: { fills: null }, created_at: '2026-10-16 10:00' },
  { ibkr: { fills: [null] } }, { ibkr: { fills: [5, 'x'] }, created_at: '2026-10-16 10:00' }, { ibkr: { fills: [{ time: 'bad' }, { time: '20261016-14:00:01' }, { time: '20261016-13:59:59' }] } }, { ibkr: { fills: [{ time: '20261016-13:00:00' }, { time: '20261016-14:00:01' }] } },
  { ibkr: { fills: [{}, { time: null }] }, created_at: '2026-10-16T14:00:00Z' }, { ibkr: { fills: [{ time: 1789000000000.5 }] } },
];
for (const r of entryCases) out.entryOf.push({ record: enc(r), ...run(() => T.entryOf(r)) });

function scenarioRecords(day, entryMin, n) {
  // 一张开仓 + 若干反向单与干扰单
  const base = { center: pick([5800, 5810]), wing: pick([10, 20]), right: pick(['C', 'P']), expiry: day.replace(/-/g, ''), symbol: 'SPX' };
  const entryAction = pick(['BUY', 'SELL']);
  const opposite = entryAction === 'BUY' ? 'SELL' : 'BUY';
  const recs = [];
  const tFor = (m) => { const hh = Math.floor(m / 60), mm = m % 60, ss = int(0, 59); const style = pick(STYLES); return ibTime(day, hh, mm, ss, style, etMs(day, hh, mm, ss)); };
  const entry = flyRecord({ ...base, id: 'E', action: entryAction, fill: rnd() < 0.8 ? 2.5 : undefined, limit: 2.4, fills: rnd() < 0.85 ? [{ time: tFor(entryMin) }] : [], created_at: `${day} ${pad(Math.floor(entryMin / 60))}:${pad(entryMin % 60)}` });
  recs.push(entry);
  for (let i = 0; i < n; i += 1) {
    const m = entryMin + int(-30, 200);
    const kind = pick(['exit', 'exit', 'same', 'other', 'unfilled', 'nofill']);
    const o = { ...base, id: pick([`X${i}`, `X${i}`, i, String(i), null, undefined]), action: kind === 'same' ? entryAction : opposite, created_at: `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}` };
    if (kind === 'other') o.center = base.center + 5;
    if (kind === 'exit') { o.fill = pick([3.2, 1.1, 0.4, 5]); o.fills = rnd() < 0.7 ? [{ time: tFor(m) }, { time: tFor(m + 1) }] : []; }
    if (kind === 'unfilled') { o.status = 'cancelled'; }
    if (kind === 'nofill') { o.status = 'filled'; }
    const r = flyRecord(o);
    if (o.id === undefined) delete r.id;
    recs.push(r);
  }
  return recs;
}
for (let i = 0; i < 40; i += 1) {
  const day = pick(['2026-10-16', '2026-10-15']);
  const recs = scenarioRecords(day, int(570, 900), int(0, 6));
  const p = T.butterflyProfile(recs[0]);
  const t = int(0, 1) ? T.entryOf(recs[0]).time : etMs(day, 9, 30);
  out.findExit.push({ profile: p, t, others: recs, exclude: enc(recs[0].id), ...run(() => T.findExit(p, t, recs, recs[0].id)) });
  if (i < 8) out.findExit.push({ profile: p, t, others: recs, exclude: '__undefined__', ...run(() => T.findExit(p, t, recs, undefined)) });
}
// pairButterflies:多张蝶混在一起,id 撞车 / 原型上的名字 / 平仓先于开仓
for (let i = 0; i < 40; i += 1) {
  const day = pick(['2026-10-16', '2026-10-15']);
  let recs = [...scenarioRecords(day, int(570, 700), int(1, 4)), ...scenarioRecords(day, int(600, 800), int(0, 4))];
  if (rnd() < 0.3) recs = recs.map((r, j) => ({ ...r, id: pick([r.id, 'toString', 'constructor', '__proto__', 'hasOwnProperty', '0', 7, 'X1', 'valueOf', null]) }));
  if (rnd() < 0.15) recs.push({ id: 'bad' }, { id: 'noProfile', contract: { secType: 'STK' } });
  recs = rt(recs);
  out.pairs.push({ trades: recs, ...run(() => T.pairButterflies(recs)) });
}
{
  // entryOf 抛的 TypeError 要穿出 pairButterflies;ReviewError 被吞
  const r0 = flyRecord({ id: 'A', fill: 2 }); r0.ibkr.fills = 5;
  const r1 = flyRecord({ id: 'B', fill: 2 }); delete r1.created_at;
  out.pairs.push({ trades: [r1], ...run(() => T.pairButterflies([r1])) });
  out.pairs.push({ trades: [r1, r0], ...run(() => T.pairButterflies([r1, r0])) });
  out.pairs.push({ trades: [null], ...run(() => T.pairButterflies([null])) });
}

// ---------------------------------------------------------------- K 线小件
const barSets = [[], [{ time: '2026-10-16' }], [{ date: '2026-10-16 10:00' }], [{ time: null, date: '2026-10-16' }], [{ time: 20261016 }], [{}], [5], ['x'], [{ time: '2026-10-16 10:00:00' }],
  [{ time: '2026-10-16 09:30' }, { time: '2026-10-16 09:31' }, { time: '2026-10-16 09:32' }], [{ time: '2026-10-16 09:30' }, { time: '2026-10-16 09:29' }, { time: '2026-10-16 09:31' }],
  [{ time: '2026-10-15' }, { time: '2026-10-16' }, { time: '2026-10-17' }], [{ time: '2026-10-16 09:30' }, null], [null]];
for (const bars of barSets) {
  for (const when of [etMs('2026-10-16', 9, 30), etMs('2026-10-16', 9, 31, 30), etMs('2026-10-15', 12, 0), etMs('2026-10-18', 0, 0)]) {
    out.barsMisc.push({ bars: enc(bars), when, isDaily: run(() => T.isDaily(bars)), idx: run(() => T.indexAt(bars, when, false)), idxD: run(() => T.indexAt(bars, when, true)),
      barTime: bars.length ? run(() => T.barTime(bars[0])) : null });
  }
}
for (const tf of ['1m', '5m', '15m', '1h', '1d', '2d', '0m', '10M', 'm', '', ' 5m', '5m ', '1000000h', '٣m', '5mm', 'x'])
  out.timeframes.push({ tf, s: T.barSeconds(tf, false), d: T.barSeconds(tf, true) });
for (const age of [0, 1, 1.5, 1.6, 4.5, 4.51, 9.5, 9.6, 28, 28.1, -5, NaN, 1000]) out.timeframes.push({ age: enc(age), pick: T.pickTimeframe(0, age * 86400000) });

// ---------------------------------------------------------------- 整段复盘
function minuteBars(day, fromMin, toMin, step, center, opts = {}) {
  const bars = [];
  let s = center + (opts.offset ?? 0);
  for (let m = fromMin; m <= toMin; m += step) {
    s += gauss() * (opts.vol ?? 1.5) + (opts.drift ?? 0);
    const c = Math.round(s * 100) / 100;
    const bar = { time: `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`, high: Math.round((c + rnd() * 2) * 100) / 100, low: Math.round((c - rnd() * 2) * 100) / 100, close: c };
    if (opts.holes && rnd() < 0.05) bar.high = null;
    if (opts.holes && rnd() < 0.05) delete bar.low;
    if (opts.holes && rnd() < 0.03) bar.close = null;
    if (opts.strings && rnd() < 0.1) bar.close = String(c);
    bars.push(bar);
  }
  return bars;
}
function dailyBars(fromOrd, n, center) {
  const bars = [];
  let s = center;
  for (let i = 0; i < n; i += 1) {
    s += gauss() * 20;
    const dt = new Date((fromOrd + i) * 86400000);
    const c = Math.round(s * 100) / 100;
    bars.push({ date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`, high: c + 10, low: c - 10, close: c });
  }
  return bars;
}
const reviewCases = [];
for (let i = 0; i < 84; i += 1) {
  const day = pick(['2026-10-16', '2026-10-15', '2026-10-14']);
  const entryMin = int(575, 900);
  const recs = scenarioRecords(day, entryMin, int(0, 5));
  const p = T.butterflyProfile(recs[0]);
  const long = rnd() < 0.06;
  const step = pick([1, 1, 1, 5]);
  const from = Math.max(570, entryMin - int(0, 60)), to = long ? Math.min(960, from + int(300, 390)) : Math.min(960, entryMin + int(5, 90));
  let bars = minuteBars(day, from, to, step, p.center, { offset: pick([0, 5, -15, 30]), vol: pick([0.5, 1.5, 3]), drift: pick([0, 0.05, -0.05]), holes: rnd() < 0.2, strings: rnd() < 0.1 });
  if (rnd() < 0.05) bars = minuteBars(day, entryMin + 30, entryMin + 60, 1, p.center); // 窗口在开仓之后
  if (rnd() < 0.04) bars[0].close = null;
  const tf = pick(['1m', '1m', '5m', '15m', '1h', 'zz']);
  const expClose = T.expiryClose(p);
  const now = pick([expClose - 3600e3, expClose, expClose + 86400e3, expClose - 1]);
  reviewCases.push({ name: `m${i}`, record: recs[0], others: recs, bars, tf, now });
}
// 日线复盘(几天前开的、已到期)
for (let i = 0; i < 12; i += 1) {
  const day = '2026-10-05';
  const r = flyRecord({ id: 'D', fill: 3, expiry: pick(['20261009', '20261016', '20261030']), fills: [{ time: '20261005-15:00:00' }], center: 5800 });
  const bars = dailyBars(T.parseWhen('2026-09-01') / 86400000, int(30, 80), 5800);
  reviewCases.push({ name: `d${i}`, record: r, others: [r], bars, tf: '1d', now: T.parseWhen(pick(['2026-10-12 12:00', '2026-11-01 12:00', '2026-10-07 10:00'])) });
  void day;
}
// 写明的几种
{
  const day = '2026-10-16';
  const r = flyRecord({ id: 'N', fill: 2 });
  const bars = minuteBars(day, 570, 600, 1, 5800);
  reviewCases.push({ name: 'notFly', record: { id: 'x', contract: { secType: 'STK' } }, others: [], bars, tf: '1m', now: 0 });
  reviewCases.push({ name: 'noBars', record: r, others: [], bars: [], tf: '1m', now: 0 });
  reviewCases.push({ name: 'noTime', record: { ...r, ibkr: { fills: [] }, created_at: undefined }, others: [], bars, tf: '1m', now: 0 });
  reviewCases.push({ name: 'nullRecord', record: null, others: [], bars, tf: '1m', now: 0 });
  const rB = flyRecord({ id: 'B', fill: 2, fills: [{ time: '2026-10-16 09:45' }] });
  reviewCases.push({ name: 'badExpiry', record: flyRecord({ id: 'B', fill: 2, fills: [{ time: '2026-10-16 09:45' }], expiry: 'abc' }), others: [], bars, tf: '1m', now: 2e12 });
  reviewCases.push({ name: 'nanNow', record: rB, others: [], bars, tf: '1m', now: NaN });
  reviewCases.push({ name: 'nullBarInHold', record: rB, others: [], bars: [...bars, null], tf: '1m', now: 0 });
  reviewCases.push({ name: 'stale', record: rB, others: [], bars: minuteBars('2026-10-15', 570, 600, 1, 5800), tf: '1m', now: 0 });
  reviewCases.push({ name: 'staleDaily', record: rB, others: [], bars: dailyBars(T.parseWhen('2026-09-01') / 86400000, 30, 5800), tf: '1d', now: 0 });
  const zeroW = flyRecord({ id: 'Z', fill: 0.5, fills: [{ time: '2026-10-16 09:45' }], center: 5800, wing: 0.0001 });
  reviewCases.push({ name: 'tinyWing', record: zeroW, others: [], bars, tf: '1m', now: 0 });
  const noPrice = flyRecord({ id: 'P', fills: [{ time: '2026-10-16 09:45' }] });
  reviewCases.push({ name: 'noPrice', record: noPrice, others: [], bars, tf: '1m', now: 2e12 });
  reviewCases.push({ name: 'noHighLow', record: rB, others: [], bars: bars.map((b) => ({ time: b.time, close: b.close })), tf: '1m', now: 0 });
  // 抽稀:600 根、开平仓都不在步长上
  const longBars = minuteBars(day, 0, 760, 1, 5800).map((b, j) => ({ ...b, time: `${day} ${pad(Math.floor(j / 60))}:${pad(j % 60)}${j % 2 ? ':30' : ''}` }));
  const rL = flyRecord({ id: 'L', fill: 2, fills: [{ time: `${day} 01:41` }] });
  const xL = flyRecord({ id: 'LX', action: 'SELL', fill: 3, fills: [{ time: `${day} 11:53` }] });
  reviewCases.push({ name: 'thin', record: rL, others: [rL, xL], bars: longBars, tf: '1m', now: 0 });
  const unsorted = [...longBars.slice(0, 300)].reverse().concat(longBars.slice(300, 760));
  reviewCases.push({ name: 'thinUnsorted', record: rL, others: [rL, xL], bars: unsorted, tf: '1m', now: 0 });
  // 边角:恰好半个翼宽、翼宽为 0、debit 为 0、到期日早于开仓、平仓那一分钟的组合价
  const flat = (closes, from = 585) => closes.map((c, j) => ({ time: `${day} ${pad(Math.floor((from + j) / 60))}:${pad((from + j) % 60)}`, high: c + 1, low: c - 1, close: c }));
  const rH = flyRecord({ id: 'H', fill: 2, fills: [{ time: `${day} 09:45` }] });
  reviewCases.push({ name: 'halfWidth', record: rH, others: [], bars: flat([5805, 5805, 5806, 5807, 5803, 5802, 5801, 5800]), tf: '1m', now: 0 });
  const rW0 = flyRecord({ id: 'W0', fill: 2, center: 5800, wing: 0, wingUpper: 10, fills: [{ time: `${day} 09:45` }] });
  reviewCases.push({ name: 'zeroWidth', record: rW0, others: [], bars: flat([5805, 5806, 5807]), tf: '1m', now: 0 });
  const rD0 = flyRecord({ id: 'D0', fill: 0, fills: [{ time: `${day} 09:45` }] });
  const xD0 = flyRecord({ id: 'XD0', action: 'SELL', fill: 1, fills: [{ time: `${day} 09:47` }] });
  reviewCases.push({ name: 'zeroDebit', record: rD0, others: [rD0, xD0], bars: flat([5805, 5806, 5807, 5808]), tf: '1m', now: 0 });
  const rEx = flyRecord({ id: 'EX', fill: 2, expiry: '20261015', fills: [{ time: `${day} 09:47` }] });
  reviewCases.push({ name: 'expiredBefore', record: rEx, others: [], bars: [...minuteBars('2026-10-15', 900, 960, 1, 5800), ...flat([5805, 5806, 5807, 5808])], tf: '1m', now: 2e12 });
  const rM = flyRecord({ id: 'M', fill: 2, fills: [{ time: `${day} 09:45` }] });
  const xM = flyRecord({ id: 'XM', action: 'SELL', fill: 3.2, fills: [{ time: `${day} 09:50` }] });
  reviewCases.push({ name: 'marketEdge', record: rM, others: [rM, xM], bars: flat([5800, 5801, 5802, 5803, 5804, 5805, 5806, 5807]), tf: '1m', now: 0, fly: [
    { time: `${day} 09:46`, close: 3.2 }, { time: `${day} 09:50`, close: 9 }] });
  reviewCases.push({ name: 'marketBelow', record: rM, others: [rM, xM], bars: flat([5800, 5801, 5802, 5803, 5804, 5805, 5806, 5807]), tf: '1m', now: 0, fly: [
    { time: `${day} 09:46`, close: 2.1 }] });
  // 4 条腿:前 3 条是一张蝶也不认
  const r4 = flyRecord({ id: 'F4', fill: 2, mutate: (r) => { r.contract.legs.push({ strike: 99999, ratio: 1, action: 'BUY', right: 'C', lastTradeDateOrContractMonth: '20261016' }); } });
  out.profiles.push({ record: r4, ...run(() => T.butterflyProfile(r4)) });
  const rAs = flyRecord({ id: 'AS', fill: 2, wing: 10, wingUpper: 10 + 1e-11 });
  out.profiles.push({ record: rAs, ...run(() => T.butterflyProfile(rAs)) });
  // 合约与每条腿都没有 multiplier:按默认 100 算(进 pnlAt 与平仓盈亏)
  const noMult = (r) => { delete r.contract.multiplier; r.contract.legs.forEach((l) => { delete l.multiplier; }); };
  for (const o of [{ id: 'NM', fill: 2 }, { id: 'NMS', fill: 2, action: 'SELL', shuffle: true }, { id: 'NMQ', fill: 1.5, qty: 3, right: 'P' }, { id: 'NM0', fill: 2, legZero: true }]) {
    const r = flyRecord({ ...o, mutate: (x) => { noMult(x); if (o.legZero) x.contract.legs.forEach((l) => { l.multiplier = '0'; }); } });
    out.profiles.push({ record: r, ...run(() => T.butterflyProfile(r)) });
    const p = T.butterflyProfile(r);
    const ss = [p.lower - 5, p.lower, p.center, p.upper, p.center + 3];
    out.payoff.push({ profile: p, s: ss, payoff: enc(ss.map((x) => T.payoffPerUnit(p, x))), pnl: enc(ss.map((x) => T.pnlAt(p, x))), zone: enc(T.zone(p)) });
  }
  const rNM = flyRecord({ id: 'NM1', fill: 2, fills: [{ time: `${day} 09:45` }], mutate: noMult });
  const xNM = flyRecord({ id: 'NM2', action: 'SELL', fill: 3.1, fills: [{ time: `${day} 09:52` }], mutate: noMult });
  reviewCases.push({ name: 'noMultClosed', record: rNM, others: [rNM, xNM], bars: flat([5800, 5801, 5802, 5803, 5804, 5805, 5806, 5807, 5808, 5809]), tf: '1m', now: 0 });
  reviewCases.push({ name: 'noMultOpen', record: rNM, others: [rNM], bars: flat([5800, 5803, 5806, 5809]), tf: '1m', now: 0 });
  reviewCases.push({ name: 'noMultExpired', record: rNM, others: [rNM], bars: flat([5800, 5803, 5806, 5809]), tf: '1m', now: 2e12 });
  reviewCases.push({ name: 'thinNull', record: rL, others: [rL, xL], bars: [...longBars.slice(0, 740), null, ...longBars.slice(740)], tf: '1m', now: 0 });
}
for (const c of reviewCases) {
  const record = rt(c.record), others = rt(c.others), bars = rt(c.bars);
  const res = run(() => T.review(record, others, bars, c.tf, c.now));
  out.reviews.push({ name: c.name, record: enc(record), others, bars, tf: c.tf, now: enc(c.now), ...res });
  // marketOpportunity:多头蝶、有 debit 的那些
  if (res.out && (c.fly || rnd() < 0.7)) {
    const result = T.review(record, others, bars, c.tf, c.now);
    const entryBar = result.entry.bar_time;
    const day = entryBar.slice(0, 10);
    const fly = [];
    for (let m = 570; m <= 960; m += pick([1, 2, 5])) {
      if (rnd() < 0.5) continue;
      fly.push({ time: `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`, close: rnd() < 0.05 ? null : Math.round((0.2 + rnd() * pick([2, 5, 9])) * 20) / 20 });
    }
    if (c.fly) fly.splice(0, fly.length, ...c.fly);
    if (rnd() < 0.1) fly.push({ time: '2026-10-17 10:00', close: 50 }, { close: 9 }, { time: `${day} 23:00`, close: 99 });
    const tweak = c.fly ? null : pick([null, null, null, 'noFindings', 'noStats', 'noTitle', 'stringPnl', 'findingsObj', 'nullFinding', 'sell', 'open', 'noDebit']);
    const res2 = rt(result);
    if (tweak === 'noFindings') delete res2.findings;
    if (tweak === 'noStats') delete res2.stats;
    if (tweak === 'noTitle') res2.findings = res2.findings.filter((f) => f.title !== '曾有的机会');
    if (tweak === 'stringPnl') res2.outcome.pnl = '5';
    if (tweak === 'findingsObj') res2.findings = { a: 1 };
    if (tweak === 'nullFinding') res2.findings.splice(1, 0, null);
    if (tweak === 'sell') res2.profile.action = 'SELL';
    if (tweak === 'open') res2.outcome.kind = 'open';
    if (tweak === 'noDebit') res2.profile.debit = null;
    delete res2.series.bars; // marketOpportunity 不碰 series,K 线不进夹具
    const input = rt(res2);
    // 只改 stats 与 findings:夹具里只记这两样,别的键测试那边核对没动
    const r3 = run(() => { T.marketOpportunity(res2, fly, entryBar); return { stats: res2.stats, findings: res2.findings }; });
    out.market.push({ name: c.name, tweak, result: input, fly, entryBar, ...r3 });
  }
}

out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'tradereview.json'), JSON.stringify(out) + '\n');
console.log('tradereview.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
