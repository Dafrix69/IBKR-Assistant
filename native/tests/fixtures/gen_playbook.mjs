// 生成 playbook.json:engine-ts 的 playbook.ts 与 sessionEm.ts(原模块现跑)。状态机走长的随机行情(贴着线来回蹭、刺穿又回来、
// 只在取到新一格时判 B2、昨日下沿压过 B2、静默期、加速档换档与上膛),每一笔的状态与事件都记下;外加区间、目标位、
// 加速档、重启后接着判、从底账折回全天 1σ(当天到期与否、盘前盘后、收盘那一刻)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_playbook.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const P = await import(pathToFileURL(join(engine, 'dist/src/playbook.js')).href);
const S = await import(pathToFileURL(join(engine, 'dist/src/sessionEm.js')).href);
const T = await import(pathToFileURL(join(engine, 'dist/src/tz.js')).href);

let seed = 0x9a1b_0c35;
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
const etMs = (date, minute) => {
  const [y, m, d] = date.split('-').map(Number);
  return T.wallToEpoch({ year: y, month: m, day: d, hour: Math.floor(minute / 60), minute: Math.floor(minute % 60), second: Math.round((minute % 1) * 60) }, T.ET);
};

// 一步记成紧凑的一行:[at, price, b3, b2, frame, accelStrike] → [state, trigger, since, lost, accel] 与事件;整台机器(含 fired)只记最后一步
const inRow = (i) => [i.at, i.price, i.b3, i.b2, i.frame, i.accelStrike];
const mRow = (m) => [m.state, m.trigger, m.since, m.lost, m.accel === null ? null : [m.accel.strike, m.accel.side, m.accel.armed]];
const evRow = (e) => [e.at, e.kind, e.state, e.level, e.price];
const out = { mids: [], atm: [], bands: [], today: [], spans: [], keys: [], walks: [], restore: [], targets: [], accel: [], sigma: [], sessions: [] };

const qv = [null, 0, -1, 1.2, 1.25, 3, NaN, Infinity, 2.5];
for (const bid of qv) for (const ask of qv) out.mids.push({ bid: enc(bid), ask: enc(ask), out: enc(P.legMid({ bid, ask })) });
for (const s of [5802.5, 5802.4999, 5797.5, -2.5, 0, 5800, 7.5, NaN, 12.5, -12.5, 1e9 + 2.5]) for (const step of [5, 10, 25, 1]) out.atm.push({ s: enc(s), step, out: enc(P.atmStrike(s, step)) });
for (let i = 0; i < 200; i += 1) {
  const spec = { at: 1760886000000 + i * 1000, anchor: pick([5800, 0, -1, NaN, 5812.37]), strike: 5800, expiry: '20261019', call: pick([10, 0, -1, 12.35, NaN]), put: pick([9, 0, 11.1, NaN]), source: pick(['live', 'backfill']) };
  out.bands.push({ spec: enc(spec), out: enc(P.makeBand(spec)) });
}
const someBand = (src) => P.makeBand({ at: 1760886000000, anchor: 5800 + gauss() * 10, strike: 5800, expiry: '20261019', call: 5 + rnd() * 10, put: 5 + rnd() * 10, source: src });
for (let i = 0; i < 80; i += 1) {
  const anchor = rnd() < 0.15 ? null : { at: 1760880000000, price: pick([5805, 0, -3, 5799.75, NaN]), source: pick(['live', 'backfill']) };
  const current = rnd() < 0.15 ? null : someBand(pick(['live', 'backfill']));
  out.today.push({ anchor: enc(anchor), current: enc(current), out: enc(P.todayBand(anchor, current)) });
}
for (let i = 0; i < 120; i += 1) {
  const spot = pick([5800, NaN, 5810.5]);
  const levels = Array.from({ length: Math.floor(rnd() * 6) }, () => pick([null, undefined, 5790, 5830.25, NaN, Infinity, 5800, '5850']));
  out.spans.push({ spot: enc(spot), levels: enc(levels), out: enc(P.wallSpan(spot, levels)) });
}
for (const e of [{ kind: 'enter', state: 'B2', level: 5850 }, { kind: 'invalid', state: 'B3', level: 5790.5 }, { kind: 'accel', state: 'R', level: 5805 }, { kind: 'accel', state: 'B2', level: 0.1 + 0.2 }])
  out.keys.push({ e, out: P.quietKey(e) });

// ---------------------------------------------------------------- 状态机的长走法
for (let w = 0; w < 40; w += 1) {
  let m = P.newMachine();
  const steps = [];
  let price = 5800 + gauss() * 5;
  let at = 1760886000000 + Math.floor(rnd() * 1000);
  let b3 = pick([5780, 5790, null, 5795]);
  let b2 = pick([5810, 5820, null, 5805]);
  let accel = pick([5800, 5805, null, 5810]);
  const vol = pick([0.5, 1.5, 3]);
  const n = pick([200, 400, 600]);
  for (let i = 0; i < n; i += 1) {
    at += pick([1000, 5000, 15000, 60000, 300000, 299999, 300001]);
    price += gauss() * vol + (rnd() < 0.02 ? pick([-15, 15]) : 0);
    if (rnd() < 0.03) price = pick([b2 ?? price, b3 ?? price, accel ?? price, (accel ?? price) + 2.5, (accel ?? price) - 2.5]);
    const frame = rnd() < 0.2;
    if (frame && b2 !== null) b2 = Math.round((b2 - 0.2 + gauss() * 0.3) * 100) / 100;
    if (rnd() < 0.01) b3 = pick([null, 5785, 5790]);
    if (rnd() < 0.01) b2 = pick([null, 5815]);
    if (rnd() < 0.02) accel = pick([null, 5800, 5795, 5810]);
    const input = { at, price, b3, b2, frame, accelStrike: accel };
    const { next, events } = P.stepMachine(m, input);
    steps.push(enc([inRow(input), mRow(next), events.map(evRow)]));
    m = next;
  }
  out.walks.push({ start: null, steps, end: enc(m) });
}
// 一台开头就带着状态的(重启接上的)
{
  const steps = [];
  let m = { state: 'B2', trigger: 5810, since: 1, lost: null, accel: { strike: 5805, side: 'above', armed: false }, fired: { 'enter|B2': 1760886000000 } };
  const start = enc(m);
  for (const [price, frame, b2] of [[5812, false, 5811], [5809, false, 5811], [5809, true, 5811], [5812, true, 5811], [5811.5, true, 5811], [5810, true, 5810], [5813, true, 5811], [5780, false, 5811]]) {
    const input = { at: 1760886000000 + steps.length * 400000, price, b3: 5790, b2, frame, accelStrike: 5805 };
    const { next, events } = P.stepMachine(m, input);
    steps.push(enc([inRow(input), mRow(next), events.map(evRow)]));
    m = next;
  }
  out.walks.push({ start, steps, end: enc(m) });
}
// 写明的几条:静默期正好 5 分钟(两步一隔)、现价正好等于丢掉的线、重启接上一台还带着触发线的 R / none
for (const [startM, seq] of [
  [{ state: 'R', trigger: 5810, since: 1, lost: null, accel: null, fired: {} }, [[5800, false, 5811], [5801, true, 5811]]],
  [{ state: 'none', trigger: 5790, since: 1, lost: 5815, accel: null, fired: {} }, [[5815, true, 5811], [5815.01, true, 5811], [5809, true, 5811], [5812, true, 5811]]],
  [{ state: 'R', trigger: null, since: 1, lost: null, accel: null, fired: {} }, [[5812, true, 5811], [5809, true, 5811], [5812, true, 5811], [5809, true, 5811], [5812, true, 5811]]],
]) {
  let m = startM;
  const steps = [];
  for (const [price, frame, b2] of seq) {
    const input = { at: 1760886000000 + steps.length * 150000, price, b3: 5790, b2, frame, accelStrike: null };
    const { next, events } = P.stepMachine(m, input);
    steps.push(enc([inRow(input), mRow(next), events.map(evRow)]));
    m = next;
  }
  out.walks.push({ start: enc(startM), steps, end: enc(m) });
}
// 今日上沿(B2 的线)在昨日下沿(B3 的线)之下:B2 进去以后现价落到两条线之间——被 B3 压过去,B2 悄悄让位(不报失效、不记丢掉的线),
// 回到上面再进 B2 不受「丢掉的线」挡
{
  let m = P.newMachine();
  const steps = [];
  for (const [price, frame, b2, b3] of [[5805, true, 5790, 5800], [5795, false, 5790, 5800], [5796, true, 5790, 5800], [5806, true, 5790, 5800], [5806, true, 5790, 5800]]) {
    const input = { at: 1760886000000 + steps.length * 600000, price, b3, b2, frame, accelStrike: null };
    const { next, events } = P.stepMachine(m, input);
    steps.push(enc([inRow(input), mRow(next), events.map(evRow)]));
    m = next;
  }
  out.walks.push({ start: null, steps, end: enc(m) });
}
for (let i = 0; i < 150; i += 1) {
  const mark = rnd() < 0.3 ? null : { at: pick([100, 200, 300]), state: pick(['B2', 'B3', 'R', 'none']), trigger: pick([null, 5810]), since: pick([null, 50]), lost: pick([null, 5815]) };
  const events = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ at: pick([50, 100, 250, 300, 400]), kind: pick(['enter', 'invalid', 'accel']), state: pick(['B2', 'B3', 'R']), level: pick([5810, 5790, 5805]), price: 5800 }));
  out.restore.push({ mark: enc(mark), events, out: enc(P.restoreMachine(mark, events)) });
}
const strikes = () => Array.from({ length: Math.floor(rnd() * 10) }, () => ({ strike: 5770 + 5 * Math.floor(rnd() * 14), call_oi: 1, put_oi: 1, call_vol: 0, put_vol: 0, net_gex: pick([-5e6, -1e6, 0, 2e6, 8e6, -0, NaN]) }));
// 相等的边:盘初上沿正好等于触发线、某一档正好落在起算的那条线上
for (const [state, trigger, upper, lower] of [['B2', 5810, 5810, 5790], ['B2', 5810, 5815, 5790], ['B3', 5790, 5810, 5790], ['B3', 5790, 5810, 5785], ['B2', 5812.5, 5812.5, 5780]]) {
  const open = { ...someBand('live'), upper, lower };
  const st = [5805, 5810, 5812.5, 5815, 5820].map((k, j) => ({ strike: k, call_oi: 0, put_oi: 0, call_vol: 0, put_vol: 0, net_gex: j % 2 ? 1e6 : 2e6 }));
  out.targets.push({ state, trigger, open: enc(open), strikes: enc(st), out: enc(P.targets(state, trigger, open, st)) });
}
for (let i = 0; i < 200; i += 1) {
  const st = strikes();
  const open = rnd() < 0.2 ? null : someBand('live');
  const state = pick(['B2', 'B3', 'R', 'none']);
  const trigger = pick([null, 5790, 5810, 5795.5, 4, 3]);
  out.targets.push({ state, trigger, open: enc(open), strikes: enc(st), out: enc(P.targets(state, trigger, open, st)) });
  const band = rnd() < 0.15 ? null : someBand('live');
  out.accel.push({ strikes: enc(st), band: enc(band), out: enc(P.accelerator(st, band)) });
}

// ---------------------------------------------------------------- sessionEm
const days = ['2026-10-19', '2026-03-09', '2026-11-02'];
for (let i = 0; i < 300; i += 1) {
  const date = pick(days);
  const minute = pick([500, 569, 570, 575, 600, 720, 959, 959.5, 960, 1000, 570 + 390 * rnd()]);
  const at = etMs(date, minute) + pick([0, 0, 123, -1]);
  const expiry = rnd() < 0.85 ? date.replace(/-/g, '') : pick(['20261020', '', date]);
  const band = { at, anchor: 5800, strike: 5800, expiry, call: 10, put: 10, source: 'live', em: pick([25, 0, -1, 17.3, NaN, 40 * rnd()]), lower: 0, upper: 0 };
  const weights = rnd() < 0.2 ? [0.5, 0.5] : undefined;
  out.sigma.push({ band: enc(band), weights: enc(weights), out: enc(S.sessionSigmaOf(band, weights)) });
}
for (let i = 0; i < 120; i += 1) {
  const date = pick(days);
  const ymd = date.replace(/-/g, '');
  const records = [];
  for (let k = Math.floor(rnd() * 7); k > 0; k -= 1) {
    const kind = pick(['open', 'frame', 'prior', 'event', 'anchor', 'machine']);
    const minute = pick([500, 575, 600, 640, 700, 960, 570 + 390 * rnd()]);
    const band = { at: etMs(date, minute), anchor: 5800, strike: 5800, expiry: rnd() < 0.8 ? ymd : '20990101', call: 10, put: 10, source: 'live', em: pick([20, 0, 31.4]), lower: 0, upper: 0 };
    records.push(kind === 'open' || kind === 'frame' || kind === 'prior' ? (rnd() < 0.05 ? { kind } : { kind, band }) : { kind, at: 1 });
  }
  const early = rnd() < 0.1;
  out.sessions.push({ records: enc(records), early, out: enc(S.sessionEmOf(records, early)) });
}

writeFileSync(join(here, 'playbook.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('playbook.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
