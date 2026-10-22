// 生成 fly-plan-engine.json:engine-ts 的 flyPlan.ts(蝴蝶测算的引擎一侧,原模块现跑)。日历是写死的一份(周末、两个休市日、两个提前收盘日,
// C++ 那边照抄);到期日与目标时刻走 planSchedule 的各条路(收盘后、周末、写坏的时刻与日期、提前收盘、认不出的结算方式),
// 测算本身覆盖三种 IV 来源(手动 / IBKR / 盘口反解)、三种 IV 走法(auto / flat / shift)、带 own 的模型、盘口缺腿、买价 0、倒挂、
// 锚定差得大、目标在翼外、隔日到期、目标时刻 = 此刻。
// (fly-plan.json 是界面那一侧的,另一个生成器。)
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_fly_plan_engine.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const F = await import(pathToFileURL(join(engine, 'dist/src/flyPlan.js')).href);
const M = await import(pathToFileURL(join(engine, 'dist/src/flyIvModel.js')).href);
const T = await import(pathToFileURL(join(engine, 'dist/src/tz.js')).href);

let seed = 0x0f1e_9a7d;
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

const HOLIDAYS = ['2026-11-26', '2026-12-25'];
const EARLY = ['2026-11-27', '2026-12-24'];
const calendar = {
  isTradingDay: (d) => { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); return wd !== 0 && wd !== 6 && !HOLIDAYS.includes(d); },
  isEarlyClose: (d) => EARLY.includes(d),
};
const etMs = (date, minute) => {
  const [y, m, d] = date.split('-').map(Number);
  return T.wallToEpoch({ year: y, month: m, day: d, hour: Math.floor(minute / 60), minute: Math.floor(minute % 60), second: Math.round((minute % 1) * 60) }, T.ET);
};

const out = { calendar: { holidays: HOLIDAYS, early: EARLY }, keys: [], session: [], seasonal: [], response: [], schedules: [], plans: [] };

for (const k of [5800, 5800.5, 5800.25, 12345.65, 12345.7, 0.1, 1e6, 123456.5, -5, 7e-5]) out.keys.push({ k, out: F.markKey(k) });

// 带 own 的一份模型(数是编的,只为走到那几条分支)
const ownModel = { ...M.FLY_IV_MODEL, own: {
  period: { from: '2026-01-05', to: '2026-03-30' }, days: 58, rows: 3500, response: { a: -0.02, b: -0.12, c: 0.03 },
  drift: [0, -0.01, -0.02, -0.025, -0.03, -0.03, -0.035, -0.04, -0.05, -0.06, -0.08, -0.1], resid_k: 0.21, resid_move: { base: 0.8, slope: 0.15 },
  fit: { r2_in: 0.3, r2_out: 0.28, r2_out_index: 0.12, coverage_half: 0.51 } } };
const noLong = { ...M.FLY_IV_MODEL, response_long: null };
// 自己那条日内走法陡到乘数碰得到下限 1/3 的一份
const steepOwn = { ...ownModel, own: { ...ownModel.own, drift: [0, -0.2, -0.4, -0.6, -0.8, -1, -1.2, -1.4, -1.6, -1.8, -2, -2.2] } };
const models = [M.FLY_IV_MODEL, ownModel, noLong, steepOwn];
out.models = models;

const days = ['2026-10-19', '2026-10-16', '2026-11-27', '2026-11-25', '2026-03-09', '2026-12-24'];
for (let i = 0; i < 200; i += 1) {
  const day = pick(days);
  const now = etMs(day, pick([500, 575, 600, 700, 900, 959, 960, 1000]) + rnd() * 30);
  const at = now + pick([0, 60_000, 3_600_000, 86_400_000, -60_000]);
  const exp = pick([etMs(day, 960), etMs(day, 780), etMs(day, 570), etMs('2026-10-20', 960), now + 1]);
  out.session.push({ now, exp, out: F.sameSession(now, exp) });
  const mi = Math.floor(rnd() * 3);
  out.seasonal.push({ m: mi, now, at, exp, out: enc(F.seasonalFactor(models[mi], now, at, exp)) });
  const u = pick([0, -1, 2, -4.5, 6, NaN, Infinity, gauss() * 2]);
  const dte = pick([0.2, 1, 1.0001, 3, 9, 30, NaN, 0]);
  const same = rnd() < 0.5;
  out.response.push({ m: mi, u: enc(u), dte: enc(dte), same, out: enc(F.ivResponse(models[mi], u, dte, same)) });
}

// ---------------------------------------------------------------- planSchedule
const symbols = [['SPX', 'SPXW'], ['SPX', 'SPX'], ['SPX', ''], ['NDX', 'NDXP'], ['AAPL', 'AAPL'], ['XSP', 'XSP']];
const nowsFor = () => {
  const day = pick(['2026-10-19', '2026-10-17', '2026-11-26', '2026-11-27', '2026-12-24', '2026-10-16', '2026-12-31']);
  return etMs(day, pick([300, 575, 700, 959, 960, 1000, 1439, 780, 781]));
};
for (let i = 0; i < 300; i += 1) {
  const [symbol, tradingClass] = pick(symbols);
  const args = {
    symbol, tradingClass, nowMs: nowsFor(),
    targetTime: rnd() < 0.7 ? pick(['14:30', ' 9:45 ', '16:00', '09:00', '12:59', '13:01', '23:59', '10:15']) : pick(['9:5', '24:00', '15:60', 'abc', '14:30:00', '1430', '７:30']),
  };
  if (rnd() < 0.5) args.targetDate = pick(['2026-10-19', '2026-10-20', ' 2026-10-21 ', '2026-10-17', '2026-11-26', '2026-11-27', '2026-02-30', '2026-1-5', '', '2026-12-24']);
  if (rnd() < 0.5) args.expiry = pick(['20261019', '20261020', '20261218', '20261017', '20261127', '20261126', '2026-10-19', '20261332', '', ' 20261023 ', '20261224']);
  out.schedules.push({ args: enc(args), ...run(() => F.planSchedule(args, calendar)) });
}

// ---------------------------------------------------------------- planFly
const markOf = (strike, mid, spread) => {
  const r = rnd();
  if (r < 0.03) return undefined;
  const bid = r < 0.12 ? pick([0, -1, NaN, null]) : Math.max(0, Math.round((mid - spread / 2) * 20) / 20);
  const ask = r > 0.94 ? pick([null, 0, -1]) : r > 0.9 ? bid - 0.1 : r > 0.87 ? bid : Math.round((mid + spread / 2) * 20) / 20;
  const iv = rnd() < 0.08 ? pick([null, 0, -0.1, NaN]) : 0.12 + 0.002 * Math.abs(strike - 5800) / 5 + 0.02 * rnd();
  return { bid, ask, iv };
};
for (let i = 0; i < 420; i += 1) {
  const day = pick(['2026-10-19', '2026-10-16', '2026-11-27', '2026-10-20']);
  const nowMs = etMs(day, pick([575, 600, 700, 760, 840, 930, 955]) + rnd() * 5);
  if (day === '2026-11-27' && nowMs > etMs(day, 775) && rnd() < 0.8) continue;
  const sameDay = rnd() < 0.7;
  const expiryMs = sameDay ? etMs(day, day === '2026-11-27' ? 780 : 960) : etMs('2026-10-23', 960);
  const width = pick([5, 10, 20, 25]);
  const spot = 5800 + gauss() * 15;
  const center = pick([5800, 5805, 5790, 5825, 5850]);
  const targetMs = pick([nowMs, nowMs + 3_600_000, Math.min(expiryMs, nowMs + 7_200_000), expiryMs, nowMs + 600_000, expiryMs - 30_000, expiryMs - 1_000]);
  const marks = {};
  for (const k of [center - width, center, center + width]) {
    const intrinsic = Math.max(0, spot - k);
    const m = markOf(k, intrinsic + 3 + 5 * rnd(), pick([0.1, 0.3, 1]));
    if (m) marks[F.markKey(k)] = m;
  }
  marks[F.markKey(center + 50)] = { bid: 1, ask: 1.2, iv: 0.3 };
  const ivMode = pick(['auto', 'auto', 'flat', 'shift']);
  const input = {
    symbol: 'SPX', expiry: day.replace(/-/g, ''), tradingClass: 'SPXW', right: pick(['C', 'P']), center, width,
    quantity: rnd() < 0.92 ? pick([1, 2, 10]) : pick([1.5, 0]), multiplier: 100, spot, spotSource: 'live', spotNote: '', nowMs, expiryMs, targetMs,
    targetSpot: rnd() < 0.97 ? pick([spot, center, center + width * 1.2, spot - 20, spot + 7]) : 0, marks,
    cost: rnd() < 0.35 ? (rnd() < 0.8 ? pick([1.5, 3, 0.05, width / 2]) : pick([width, 0, -1, width + 1])) : null,
    ivInput: rnd() < 0.15 ? (rnd() < 0.85 ? pick([0.15, 0.4, 5]) : pick([6, 0])) : null,
    ivMode, ivShiftPct: ivMode === 'shift' ? (rnd() < 0.9 ? pick([10, -50, 200, 0, -99.9]) : -100) : null,
    timelineMs: Array.from({ length: 14 }, (_, j) => etMs(day, 570 + 30 * j)).concat([targetMs, nowMs - 1]),
  };
  if (rnd() < 0.3) input.warnings = ['上一层的话'];
  const mi = Math.floor(rnd() * 4);
  if (mi > 0) input.model = models[mi];
  out.plans.push({ input: enc({ ...input, model: undefined }), m: mi, ...run(() => F.planFly(input)) });
}

// 写明的边:现价正好在两条腿正中、目标正好在翼上、IV 平移离某一档正好半个百分点、要用 2.5 步长的曲线、中心 = 翼宽、到期 = 此刻
{
  const day = '2026-10-19';
  const nowMs = etMs(day, 600), expiryMs = etMs(day, 960);
  const base = (over) => {
    const center = over.center ?? 5800, width = over.width ?? 20;
    const marks = {};
    for (const k of [center - width, center, center + width]) marks[F.markKey(k)] = { bid: 4, ask: 4.4, iv: 0.15 + (k - center) / 5000 };
    return { symbol: 'SPX', expiry: '20261019', tradingClass: 'SPXW', right: 'C', center, width, quantity: 1, multiplier: 100, spot: 5800,
      spotSource: 'live', spotNote: '', nowMs, expiryMs, targetMs: nowMs + 3_600_000, targetSpot: 5800, marks, cost: 3, ivInput: null,
      ivMode: 'auto', ivShiftPct: null, timelineMs: [], ...over };
  };
  const cases = [
    base({ spot: 5810 }), base({ spot: 5790 }), base({ targetSpot: 5820 }), base({ targetSpot: 5780 }),
    base({ ivMode: 'shift', ivShiftPct: 25.5 }), base({ ivMode: 'shift', ivShiftPct: -0.5 }), base({ ivMode: 'shift', ivShiftPct: 49.5 }),
    base({ targetSpot: 5960 }), base({ targetSpot: 5640, width: 25, cost: 4 }), base({ center: 20, width: 20, spot: 30, targetSpot: 30 }),
    base({ center: 25, width: 20, spot: 30, targetSpot: 30, cost: 2 }), base({ expiryMs: nowMs }), base({ expiryMs: nowMs + 1, targetMs: nowMs }),
    base({ targetMs: expiryMs - 60_000 }), base({ targetMs: expiryMs - 60_000, model: steepOwn }), base({ targetMs: expiryMs - 1_000, model: steepOwn }),
    // 非有限数:zod 的 z.number() 放过 Infinity(JSON 里的 1e999),checkInput 只查 > 0
    base({ targetSpot: Infinity }), base({ spot: Infinity }), base({ center: Infinity }), base({ width: Infinity }), base({ cost: Infinity }),
    // markKey 只有 6 位有效数字:翼宽窄的大中心,三条腿可能撞成同一个键
    base({ center: 123456.5, width: 0.5, spot: 123456, targetSpot: 123457, cost: 0.2, ivInput: 0.2 }), base({ center: 1234567, width: 1, spot: 1234567, targetSpot: 1234567, cost: 0.3, ivInput: 0.2 }),
    // 时间线乱序、重复、带 NaN
    base({ timelineMs: [expiryMs - 600_000, nowMs + 1_800_000, nowMs + 1_800_000, NaN, nowMs + 600_000, nowMs + 3_600_000] }),
  ];
  for (const input of cases) {
    const mi = input.model === steepOwn ? 3 : 0;
    out.plans.push({ input: enc({ ...input, model: undefined }), m: mi, ...run(() => F.planFly(input)) });
  }
}

writeFileSync(join(here, 'fly-plan-engine.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('fly-plan-engine.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 1}`).join(' '));
