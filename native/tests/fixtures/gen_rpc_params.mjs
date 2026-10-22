// 生成 rpc-params.json:engine-ts 的 rpc/params.ts(symbolOrRaise / optFloat / optInt / drawdownArmOf / drawdownTiersOf / exitSettingsOf /
// stopSettingsOf),原模块现跑。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_rpc_params.mjs <编过的 engine-ts 目录>
// 入参先写成 JSON 文本再 JSON.parse(RPC 入参就是这么来的:1e999 → Infinity、"-0" → -0);数字串、空白、Unicode 大小写、各种对象数组
// 都往里放。期望是 {out} 或 {error: "RpcError: …", code}。固定种子。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const P = await import(pathToFileURL(join(engine, 'dist/src/rpc/params.js')).href);

let seed = 0x7a3d_19e5;
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
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}`, code: e.code }; } };
const RAW = (t) => `__RAW:${t}__`;
const text = (v) => JSON.stringify(v).replace(/"__RAW:(.*?)__"/g, '$1');
/** 入参:写成文本再读回来,返回 [文本, 值] */
const input = (v) => { const t = text(v); return [t, JSON.parse(t)]; };

// ---------------------------------------------------------------- 值的池
const NUMS = [0, 1, -1, 2, 5, 0.5, 100, 1000, 1001, 600, 601, 60, 61, 20, 21, 1.5, 12.7, -12.7, -0.5, 1e21, 123456789012345680000, 9007199254740993, RAW('-0'), RAW('1e999'), RAW('-1e999'), RAW('0.1'), RAW('5e-7')];
const STRS = ['', ' ', '0', '5', '-5', '+5', '5.5', '.5', '5.', '1e3', '1E3', '0x1f', '0b11', '0o7', ' 7 ', '\n7\t', ' 7 ', '﻿7', '1_0', '1,5', 'abc', 'NaN', 'Infinity', '-Infinity', 'infinity',
  '00012', '١٢', '12abc', '--5', '+-5', '0.0', '-0', '1e999', '99999999999999999999', '１２', '5 5', '1e', '0x', '- 5', '  5  ', '᠎5'];
const MISC = [null, true, false, [], [5], ['7'], [1, 2], [null], [[]], {}, { a: 1 }];
const VALUES = [...NUMS, ...STRS, ...MISC];

function value() { return pick(VALUES); }

// ---------------------------------------------------------------- 各个函数的入参
const SYMBOLS = ['AAPL', 'aapl', ' spx ', 'BRK.B', 'BF-B', 'A', 'A'.repeat(12), 'A'.repeat(13), 'AB.CD-EF1234', 'AB.CD-EF12345', '1AB', '', ' ', '\t', 'A B', 'AAPL\n', '\nAAPL', 'AAPL ', '﻿AAPL', 'ß', 'ßß', 'ı', 'ıi', 'ſ', 'ﬁ', 'ﬀ', 'ŉ', 'ǰ', 'ΐ', 'é', 'ÀB', 'ＡＢ', 'A_B', 'A/B', 'a.b-c', '$SPX', 'SPX!', '\u0000', 'İ', 'K', 'ǆ', 'ᾳ',
  null, true, false, 5, 0, 1e21, [], ['AAPL'], ['a', 'b'], [['x']], {}, { a: 1 }, 'x'.repeat(40)];
const out = { symbol: [], optFloat: [], optInt: [], arm: [], tiers: [], exit: [], stop: [] };

for (const s of SYMBOLS) {
  for (const key of ['symbol']) { const [t, p] = input({ [key]: s }); out.symbol.push({ p: t, ...run(() => P.symbolOrRaise(p)) }); }
}
for (const t of ['{}', '{"x":1}', '{"symbol":null}']) out.symbol.push({ p: t, ...run(() => P.symbolOrRaise(JSON.parse(t))) });
for (let i = 0; i < 300; i += 1) {
  const n = 1 + Math.floor(rnd() * 14);
  const chars = ['A', 'B', 'Z', 'a', 'z', '0', '9', '.', '-', ' ', '_', 'é', 'ß', 'ı'];
  const s = Array.from({ length: n }, () => pick(chars)).join('');
  const [t, p] = input({ symbol: s });
  out.symbol.push({ p: t, ...run(() => P.symbolOrRaise(p)) });
}

for (const v of VALUES) {
  const [t, p] = input({ v });
  out.optFloat.push({ v: t, ...run(() => P.optFloat(p.v)) });
  out.optInt.push({ v: t, ...run(() => P.optInt(p.v)) });
}
out.optFloat.push({ v: '__undefined__', ...run(() => P.optFloat(undefined)) });
out.optInt.push({ v: '__undefined__', ...run(() => P.optInt(undefined)) });
for (let i = 0; i < 400; i += 1) {
  const sign = pick(['', '+', '-', ' ', '\n']);
  const digits = String(Math.floor(rnd() * pick([10, 1000, 1e9, 1e17, 1e22])));
  const v = `${sign}${digits}${pick(['', '', ' ', '.5', 'e2', 'x', ' '])}`;
  const [t, p] = input({ v });
  out.optFloat.push({ v: t, ...run(() => P.optFloat(p.v)) });
  out.optInt.push({ v: t, ...run(() => P.optInt(p.v)) });
}

const maybe = (obj, key, v) => { if (v !== undefined) obj[key] = v; };
const ARMS = [undefined, null, '', '50', 50, 0, '0', -5, 1000, 1000.0001, '1000', 1001, 0.0001, 5e-324, 'abc', RAW('1e999'), true, [], [5], {}, '  25 ', RAW('-0')];
const PRESETS = [undefined, null, '', 'fly', 'FLY', 'Fly', ' fly', 'fly ', 'flyx', 5, true, [], ['fly'], {}, 'İ'];
const tierItem = () => pick([
  { above: 0, pct: 35 }, { above: '0', pct: '35' }, { above: 2, pct: 25 }, { above: 1.5, pct: 100 }, { above: 0, pct: 0 }, { above: 0, pct: 100.0001 }, { above: -1, pct: 30 }, { above: -0.0001, pct: 30 },
  { above: null, pct: 30 }, { above: 0, pct: null }, { above: '', pct: 30 }, { above: 0, pct: '' }, { above: 'x', pct: 30 }, { above: 0, pct: 'y' }, { above: 0 }, { pct: 30 }, {}, { above: 0, pct: 30, extra: 1 },
  { above: RAW('1e999'), pct: 30 }, { above: 0, pct: RAW('1e999') }, { above: RAW('-1e999'), pct: 30 }, { above: [], pct: 30 }, { above: [1], pct: [30] }, { above: true, pct: true }, { above: 0, pct: false },
  null, 5, 'x', [], [1], true, { above: ' 1 ', pct: ' 40 ' }, { above: '0x10', pct: '0b1' },
]);
const TIERS = () => pick([
  undefined, null, '', [], {}, 'x', 5, true, [tierItem()], [tierItem(), tierItem()], [tierItem(), tierItem(), tierItem()],
  [{ above: 0, pct: 35 }, { above: 2, pct: 25 }], [{ above: '0', pct: '35' }], 0, false,
]);
const LATES = () => pick([
  undefined, null, '', 'x', 5, [], [1], {}, { after: '' }, { after: '15:30' }, { after: '15:30', factor: 0.6 }, { after: '15:30', factor: '0.6' }, { after: '15:30', factor: 0 }, { after: '15:30', factor: 1 },
  { after: '15:30', factor: 1.0001 }, { after: '15:30', factor: null }, { after: '15:30', factor: '' }, { after: '15:30', factor: 'x' }, { after: 15, factor: 0.5 }, { after: true, factor: 0.5 },
  { after: ['a', 'b'], factor: 0.5 }, { after: {}, factor: 0.5 }, { after: 0, factor: 0.5 }, { after: '0', factor: 0.5 }, { after: ' ', factor: 0.5 }, { factor: 0.5 }, { after: '15:30', factor: RAW('1e999') },
  { after: '15:30', factor: [0.5] }, { after: '15:30', factor: RAW('5e-324') },
]);
function tierParams() {
  const p = {};
  maybe(p, 'profit_drawdown_preset', pick(PRESETS));
  maybe(p, 'profit_drawdown_tiers', TIERS());
  maybe(p, 'profit_drawdown_late', LATES());
  maybe(p, 'profit_drawdown_arm_pct', pick(ARMS));
  return p;
}
for (const v of ARMS) { const [t, p] = input({ profit_drawdown_arm_pct: v }); out.arm.push({ p: t, ...run(() => P.drawdownArmOf(p)) }); }
for (const v of ['{}', '{"x":1}']) out.arm.push({ p: v, ...run(() => P.drawdownArmOf(JSON.parse(v))) });
const COSTS = [null, 0, 1, 50, 300, 1500, 3000, -200, 0.5, RAW('1e999'), 1e-9, 199.99, 200, 100];
for (let i = 0; i < 700; i += 1) {
  const [t, p] = input(tierParams());
  const cost = rnd() < 0.3 ? undefined : pick(COSTS);
  const c = cost === undefined ? undefined : JSON.parse(text(cost));
  out.tiers.push({ p: t, cost: cost === undefined ? '__undefined__' : enc(c), ...run(() => (c === undefined ? P.drawdownTiersOf(p) : P.drawdownTiersOf(p, c))) });
}

const CLOCKS = [undefined, null, '', ' ', '15:45', '09:30', '9:30', '24:00', '00:00', '0:00', '12:60', '23:59', '1545', '15:45:00', ' 15:45 ', '15.45', '03:00', '25:00', '15:4', 'ab:cd', 5, true, [], ['15:45'], {}, '15:45\n', '٠٩:٣٠', '16:00', '12:00', '4:05', '-1:00'];
const CONFIRMS = [undefined, null, '', 0, '0', 30, '30', 600, 601, '600', -1, -0.0001, 'abc', RAW('1e999'), RAW('-0'), 0.0001, true, [], [5], {}, ' 12 '];
const TPTIERS = () => pick([
  undefined, null, '', [], {}, 'x', 5, true, 0, false,
  [{ price: 1.5, fraction_pct: 50 }], [{ price: '1.5', fraction_pct: '50' }], [{ price: 1, fraction_pct: 50 }, { price: 2, fraction_pct: 50 }],
  [{ price: 1, fraction_pct: 10 }, { price: 2, fraction_pct: 20 }, { price: 3, fraction_pct: 30 }, { price: 4, fraction_pct: 40 }],
  [{ price: 1, fraction_pct: 10 }, { price: 2, fraction_pct: 20 }, { price: 3, fraction_pct: 30 }, { price: 4, fraction_pct: 40 }, { price: 5, fraction_pct: 40 }],
  [{ price: null, fraction_pct: 50 }], [{ price: 1, fraction_pct: null }], [{ price: '', fraction_pct: 50 }], [{ price: 'x', fraction_pct: 50 }], [{ price: 1, fraction_pct: 'y' }], [{ price: 1 }], [{}], [null], [5], ['x'], [[]], [[1, 2]],
  [{ price: 1, fraction_pct: 50 }, null], [{ price: 'x', fraction_pct: 50 }, 5], [5, { price: 'x', fraction_pct: 50 }], [{ price: RAW('1e999'), fraction_pct: 50 }], [{ price: 1, fraction_pct: 50, extra: 1 }],
]);
const NOWS = [Date.parse('2026-09-11T12:00:00-04:00'), Date.parse('2026-09-11T15:44:59-04:00'), Date.parse('2026-09-11T15:45:00-04:00'), Date.parse('2026-09-11T15:45:01-04:00'), Date.parse('2026-09-11T23:59:59-04:00'),
  Date.parse('2026-09-12T10:00:00-04:00'), Date.parse('2026-03-08T01:30:00-05:00'), Date.parse('2026-03-08T03:30:00-04:00'), Date.parse('2026-11-01T00:30:00-04:00'), Date.parse('2026-11-01T01:30:00-05:00'),
  Date.parse('2026-11-01T12:00:00-05:00'), Date.parse('2026-12-31T23:30:00-05:00'), Date.parse('2024-02-29T23:59:00-05:00'), 0, -1, 1.5e12, NaN, Infinity, -Infinity];
const nowJson = (n) => (Number.isFinite(n) ? n : null);
const GOOD_CLOCKS = [undefined, '', '15:45', '09:30', '9:30', '00:00', '23:59', ' 15:45 ', '03:00', '16:00', '12:00', '4:05'];
const GOOD_CONFIRMS = [undefined, null, '', 0, '0', 30, '30', 600, '600', 0.0001, ' 12 '];
function exitParams() {
  const p = {};
  maybe(p, 'exit_at', rnd() < 0.6 ? pick(GOOD_CLOCKS) : pick(CLOCKS));
  maybe(p, 'spot_stop_confirm_s', rnd() < 0.6 ? pick(GOOD_CONFIRMS) : pick(CONFIRMS));
  let tiers;
  do { tiers = TPTIERS(); } while (rnd() < 0.7 && !(tiers === undefined || tiers === null || tiers === '' || (Array.isArray(tiers) && tiers.length > 0 && tiers.length <= 4 && tiers.every((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.price !== 'undefined' && typeof t.fraction_pct !== 'undefined' && t.price !== null && t.price !== '' && t.price !== 'x' && t.fraction_pct !== null && t.fraction_pct !== '' && t.fraction_pct !== 'y' && typeof t.price !== 'object'))));
  maybe(p, 'take_profit_tiers', tiers);
  return p;
}
for (let i = 0; i < 900; i += 1) {
  const [t, p] = input(exitParams());
  const now = pick(NOWS);
  out.exit.push({ p: t, now: enc(now), ...run(() => P.exitSettingsOf(p, now)) });
}

const BOOLS = [undefined, true, false, 'true', 1, 0, null];
const BASES = [undefined, null, '', 'mid', 'natural', 'MID', ' mid', 'x', 5, true, [], ['mid'], {}, 0];
const RANGEV = (lo, hi) => [undefined, null, '', lo, hi, lo - 1, hi + 1, (lo + hi) / 2, 1.5, String(lo), String(hi), `${hi + 1}`, 'abc', RAW('1e999'), [], [lo], true, {}, -0.5, ' 5 ', 0.0001];
function stopParams() {
  const p = {};
  maybe(p, 'peak_confirm', pick(BOOLS));
  maybe(p, 'stop_basis', pick(BASES));
  if (rnd() < 0.8) maybe(p, 'stop_chase_grace', pick(RANGEV(0, 60)));
  if (rnd() < 0.8) maybe(p, 'stop_chase_step', pick(RANGEV(1, 20)));
  if (rnd() < 0.8) maybe(p, 'stop_chase_max_pct', pick(RANGEV(0, 100)));
  return p;
}
for (let i = 0; i < 900; i += 1) {
  const [t, p] = input(stopParams());
  out.stop.push({ p: t, ...run(() => P.stopSettingsOf(p)) });
}
for (const t of ['{}', '{"x":1}', '{"stop_chase_grace":null}', '{"stop_chase_grace":null,"stop_chase_step":null,"stop_chase_max_pct":null}', '{"stop_chase_step":0}', '{"stop_chase_step":1}', '{"stop_chase_grace":0.5}', '{"stop_chase_max_pct":100.5}'])
  out.stop.push({ p: t, ...run(() => P.stopSettingsOf(JSON.parse(t))) });

const s = JSON.stringify(out);
writeFileSync(join(here, 'rpc-params.json'), s);
console.log(`rpc-params.json: ${Object.entries(out).map(([k, v]) => `${k} ${v.length}`).join(', ')}, ${(s.length / 1048576).toFixed(2)} MB`);
