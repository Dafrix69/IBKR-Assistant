// 生成 tracker-rules.json:engine-ts 的 trackerExits.ts、trackerDrawdown.ts、trackerSpotStop.ts(原模块现跑)在随机输入上的结论。
// 这几条在钱路径上:到点平仓、分批止盈各档、追价节奏、止损确认秒数、利润回撤三道闸、标的止损价。值池里有字符串、null、负数、0、
// 小数、不合法的钟点,时刻落在美东日界与夏令时那几天。
//   node native/tests/fixtures/gen_tracker_rules.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/trackerExits.js')).href);
const D = await import(pathToFileURL(join(engine, 'dist/src/trackerDrawdown.js')).href);
const S = await import(pathToFileURL(join(engine, 'dist/src/trackerSpotStop.js')).href);

let seed = 0x2468ace1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const U = '__undefined__';
const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined ? U : typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v)));
const und = (v) => (v === U ? undefined : v);
const deU = (o) => (Array.isArray(o) ? o.map(deU) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== U).map(([k, v]) => [k, deU(v)])) : o === '__NaN__' ? NaN : und(o));

const clocks = ['15:45', '9:30', '09:30', '24:00', '23:59', '0:00', '15:60', ' 15:45 ', '1545', '', null, undefined, 5, '3:5', 'a:bc', '15:45:00'];
const instants = ['2026-10-16T19:44:59Z', '2026-10-16T19:45:00Z', '2026-10-17T03:59:59Z', '2026-10-17T04:00:00Z', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:30:00Z',
  '2026-11-01T06:30:00Z', '2026-10-16T13:30:00Z'].map((s) => Date.parse(s));
const nums = [null, undefined, 0, -1, 1, 1.5, 2, 3, 4.75, 5, 10, 100, 101, '5', 'abc', '', true, NaN];
const out = { clock: [], next: [], timeExit: [], tiers: [], carry: [], mark: [], chase: [], stock: [], spotConfirm: [], dd: [], spot: [], spotIssue: [] };
for (const c of clocks) out.clock.push({ c: c === undefined ? U : c, out: X.clockMinutes(c) });
for (const c of clocks) for (const t of instants) out.next.push({ c: c === undefined ? U : c, t, out: X.nextOccurrenceMs(c, t) });
for (let i = 0; i < 300; i++) {
  const now = pick(instants) + pick([0, -60000, 60000, 86400000, -86400000]);
  const targets = { exit_at: pick(clocks.filter((c) => typeof c === 'string')), exit_at_ms: pick([pick(instants), pick(instants) + 3600000, null, 'x', undefined]) };
  const result = { state: pick(['holding', 'stop_loss', 'take_profit']), reason: 'r', price: pick([1, null]) };
  out.timeExit.push({ targets: clean(targets), now, due: X.timeExitDue(targets, now), lapsed: X.timeExitLapsed(targets, now), withExit: X.withTimeExit(result, targets, now), result });
}
const tier = () => { const t = { price: pick([1, 2, 3, 4, 5, 6, -1, 0, '3', null]), fraction_pct: pick([25, 50, 100, 0, 101, '50', null]) }; if (rnd() < 0.3) t.done = pick([true, false, 1]); if (rnd() < 0.15) t.pending = pick([true, 0]); if (rnd() < 0.1) t.pending_qty = 2; return t; };
for (let i = 0; i < 400; i++) {
  const n = Math.floor(rnd() * 6);
  const tiers = rnd() < 0.05 ? pick([null, undefined]) : Array.from({ length: n }, tier);
  const long = rnd() < 0.6;
  const price = pick([null, 0.5, 2.5, 3, 4.5, 7, '4']);
  const result = { state: pick(['holding', 'holding', 'stop_loss']), reason: 'r', price: pick([2.5, 4.5, 7, null, 3]) };
  out.tiers.push({ tiers: clean(tiers), long, price, issue: X.tiersIssue(tiers, long, price), due: X.dueTier(tiers, long, price), pending: X.pendingTier(tiers),
    withTier: X.withTier(result, { take_profit_tiers: tiers }, long), result });
  const prev = rnd() < 0.5 ? tiers : Array.from({ length: n }, tier);
  out.carry.push({ next: clean(rnd() < 0.1 || !Array.isArray(tiers) ? null : tiers), prev: clean(prev), out: null });  // next 只会是数组或 null(undefined 在 TS 里抛)
}
out.carry.forEach((c) => { c.out = X.carryTierMarks(deU(c.next), deU(c.prev)); });
for (let i = 0; i < 60; i++) {
  const tiers = Array.from({ length: 3 }, tier);
  const patch = pick([{ pending: true, pending_qty: 2 }, { done: true }, { pending: false, done: true }]);
  out.mark.push({ tiers: clean(tiers), index: Math.floor(rnd() * 4) - 1, patch, out: null });
}
out.mark.forEach((m) => { m.out = X.markTier(deU(m.tiers), m.index, m.patch); });
const reasons = ['stop_loss', 'profit_trail', 'take_profit', 'sweep:stop_loss', 'a:b:profit_trail', 'stop_loss:', '', null, undefined, 'time_exit'];
for (let i = 0; i < 200; i++) {
  const auto = { chase_max_pct: pick(nums), stop_chase_grace: pick(nums), stop_chase_step: pick(nums), stop_chase_max_pct: pick(nums) };
  const reason = pick(reasons);
  out.chase.push({ auto: clean(auto), reason: reason === undefined ? U : reason, isStop: X.isStopReason(reason), out: X.chaseProfile(auto, reason) });
}
out.chase.forEach((c) => { c.out = X.chaseProfile(deU(c.auto), und(c.reason)); c.isStop = X.isStopReason(und(c.reason)); });
for (let i = 0; i < 300; i++) {
  const result = { state: pick(['stop_loss', 'holding', 'take_profit']), price: pick([1.5, null]), reason: '止损触发', extra: 1 };
  const clock = pick([null, { side: 'below', sinceMs: 1000 }, { side: 'above', sinceMs: 1000 }, { side: 'below', sinceMs: 50000 }]);
  const confirm = pick([null, undefined, 0, 5, 10, '10', -1, 2.5]);
  const now = pick([1000, 5000, 11000, 60000, 12500]);
  const long = rnd() < 0.5;
  const [r, c] = X.confirmStockStop(result, long, confirm, clock, now);
  out.stock.push({ result, long, confirm: confirm === undefined ? U : confirm, clock, now, out: [r, c] });
  const row = { below: pick([100, null]), above: pick([200, null]), spot: pick([95, 205, null, 150]), spot_note: '', hit: pick(['below', 'above', null]), reason: '触发' };
  const [r2, c2] = X.confirmSpotStop(row, confirm, clock, now);
  out.spotConfirm.push({ row, confirm: confirm === undefined ? U : confirm, clock, now, out: [r2, c2] });
}
const ddTiers = () => pick([undefined, [], [{ above: 0, pct: 40 }, { above: 0.6, pct: 30 }, { above: 1.5, pct: 20 }], [{ above: '1', pct: 10 }, { above: null, pct: 5 }, { above: 0.5 }], 'ab']);
for (let i = 0; i < 400; i++) {
  const targets = { profit_drawdown_pct: pick(nums), profit_drawdown_tiers: ddTiers(), profit_drawdown_late: pick([undefined, null, { after: '15:00', factor: 0.5 }, { after: '', factor: 2 }, { after: '15', factor: 0.5 },
    { after: ' 9 : 30', factor: '0.5' }, { after: '15:00', factor: null }]), profit_drawdown_arm: pick(nums), profit_drawdown_floor: pick(nums) };
  const peak = pick(nums), basis = pick([...nums, -2, -0.5]), minute = pick([null, undefined, 899, 900, 960, '960']);
  const peakPrice = pick(nums), price = pick([...nums, 4.5, 4.7]);
  out.dd.push({ targets: clean(targets), peak: peak === undefined ? U : peak, basis: basis === undefined ? U : basis, minute: minute === undefined ? U : minute,
    peakPrice: peakPrice === undefined ? U : peakPrice, price: price === undefined ? U : price });
}
out.dd.forEach((c) => {
  const t = deU(c.targets);
  c.threshold = D.drawdownThreshold(t, und(c.peak), und(c.basis), und(c.minute));
  c.armed = D.drawdownArmed(t, und(c.peak), und(c.basis));
  c.floorMet = D.drawdownFloorMet(t, und(c.peakPrice), und(c.price));
});
out.dd.push({ targets: { profit_drawdown_floor: 0.2 }, peak: null, basis: null, minute: null, peakPrice: 4.7, price: 4.5, threshold: null, armed: true, floorMet: D.drawdownFloorMet({ profit_drawdown_floor: 0.2 }, 4.7, 4.5) });
for (const [pk, p] of [[0.3, 0.1], [0.7, 0.5], [1.3, 1.1]]) out.dd.push({ targets: { profit_drawdown_floor: 0.2 }, peak: null, basis: null, minute: null, peakPrice: pk, price: p, threshold: null, armed: true, floorMet: D.drawdownFloorMet({ profit_drawdown_floor: 0.2 }, pk, p) });
{ const t = { profit_drawdown_pct: 50, profit_drawdown_tiers: [{ above: 0.5, pct: 30 }, { above: 0.5, pct: 20 }, { above: 0.2, pct: 40 }] };
  out.dd.push({ targets: t, peak: 1, basis: 1, minute: null, peakPrice: null, price: null, threshold: D.drawdownThreshold(t, 1, 1, null), armed: true, floorMet: true }); }
for (const long of [true, false]) for (const now of [11000, 10999, 11001]) {
  const result = { state: 'stop_loss', price: 1.5, reason: '止损触发' };
  const clock = { side: long ? 'below' : 'above', sinceMs: 1000 };
  out.stock.push({ result, long, confirm: 10, clock, now, out: X.confirmStockStop(result, long, 10, clock, now) });
  const row = { below: 100, above: null, spot: 95, spot_note: '', hit: 'below', reason: '触发' };
  out.spotConfirm.push({ row, confirm: 10, clock: { side: 'below', sinceMs: 1000 }, now, out: X.confirmSpotStop(row, 10, { side: 'below', sinceMs: 1000 }, now) });
}
for (let i = 0; i < 400; i++) {
  const targets = { spot_stop_below: pick([null, undefined, 100, 0, -5, '100', 150, NaN]), spot_stop_above: pick([null, undefined, 200, 150, '200', 99]) };
  const spot = pick([null, undefined, 0, 95, 120, 150, 205, '120', -1]);
  const sec = pick(['OPT', 'BAG', 'STK']);
  out.spot.push({ targets: clean(targets), spot: spot === undefined ? U : spot, sec, has: S.hasSpotStop(targets), stop: S.spotStop(targets, 'SPX', spot, rnd() < 0.5 ? '盘外按 ES 推算' : ''), issue: S.spotStopIssue(targets, sec, 'SPX', spot) });
}
writeFileSync(join(here, 'tracker-rules.json'), JSON.stringify(out, (k, v) => (typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v)) + '\n');
console.log('tracker-rules.json', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
