// 生成 perf-log.json:engine-ts 的 rpc/perfLog.ts(quantile / slowLine / RpcTimings),原模块现跑。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_perf_log.mjs <编过的 engine-ts 目录>
// RpcTimings 按脚本跑:记一笔(r)、批量记(gen,值由公式出,两边同算)、看汇总(s)、写一行(f,带 extra);随机数是第 i 次调用
// ((i+1)·2654435761 mod 2^32)/2^32,蓄水池抽样(超过 5000 个样本)两边同序。期望是每个 s / f 的结果。固定种子。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const M = await import(pathToFileURL(join(engine, 'dist/src/rpc/perfLog.js')).href);

let seed = 0x1357_9bdf;
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

const out = { constants: { FLUSH_MS: M.FLUSH_MS, QUEUE_NOTE_MS: M.QUEUE_NOTE_MS, MAX_SAMPLES: M.MAX_SAMPLES }, quantile: [], slow: [], scenarios: [] };

// ---------------------------------------------------------------- quantile
const SORTED = [[], [5], [1, 2], [1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], Array.from({ length: 100 }, (_, i) => i + 1), Array.from({ length: 101 }, (_, i) => i * 0.5), [0, 0, 0, 7], [1, 1, 1, 1, 100], Array.from({ length: 7 }, (_, i) => i * 1.25)];
const QS = [0, 0.001, 0.1, 0.5, 0.9, 0.99, 0.999, 1, 1.5, -0.5, NaN, Infinity, 0.25, 0.75, 1 / 3];
for (const xs of SORTED) for (const q of QS) out.quantile.push({ xs, q: enc(q), ...run(() => M.quantile(xs, q)) });

// ---------------------------------------------------------------- slowLine
const TIMES = [0, 1, 50, 99, 99.5, 99.999, 100, 100.4999, 100.5, 101, 250.5, 499.5, 500, 1234.4, 1e6, 1e21, 1e-7, -0.4, -1, NaN, Infinity, -Infinity, 2.5, 3.5, 0.5, 1.5];
const SLOWS = [0, 1, 100, 500, 1000, NaN, Infinity, -1, 99.5];
const METHODS = ['tracker.add', 'x', '', '中文', 'a b', "q'\""];
for (let i = 0; i < 600; i += 1) {
  const m = pick(METHODS), w = pick(TIMES), r = pick(TIMES), s = pick(SLOWS);
  out.slow.push({ m, w: enc(w), r: enc(r), s: enc(s), ...run(() => M.slowLine(m, w, r, s)) });
}

// ---------------------------------------------------------------- RpcTimings 脚本
const rng = () => { let i = 0; return () => ((++i) * 2654435761 % 4294967296) / 4294967296; };
/** 蓄水池的边界:第一个溢出的样本 n=5001,0.9999 → 槽 5000(不替换);之后轮流 0(槽 0)、0.9996(槽 4999)、0.99999999(槽 n-1)、0.5 */
const edgeRng = () => { let i = 0; const cyc = [0, 0.9996, 0.99999999, 0.5]; return () => (i === 0 ? (i += 1, 0.9999) : cyc[(i++ - 1) % 4]); };
const NAMES = ['a\u00adb', 'ab', 'a\u200bb', 'tracker.poll', 'alerts.list', 'system.status', 'Tracker.add', 'tracker.add', 'a', 'B', 'b', '10', '9', '1', 'é', 'ä', 'z', 'Z', 'a b', 'a-b', 'a.b', '.x', '_x', '中文', 'tws.scan', '0', 'tracker.add ', 'ab', 'a1', 'a10', 'a2'];
const LANES = ['local', 'read', 'trade'];
const WALLS = [1700000000000, 1700000600000, 1790000000000, 0, 253402300799000, -62135596800000, 8.64e15, 8.64e15 + 1, NaN, Infinity, 1e12 + 0.7];
function scenario(kind, rand = 'seq') {
  const now0 = pick(WALLS.slice(0, 5));
  const ops = [];
  const nOps = kind === 'big' ? 6 : 4 + Math.floor(rnd() * 30);
  let t = now0;
  for (let i = 0; i < nOps; i += 1) {
    const roll = rnd();
    if (kind === 'big' && i < 3) {
      ops.push(['gen', pick(NAMES), pick(LANES), 5200 + Math.floor(rnd() * 3000), 1 + Math.floor(rnd() * 2000) * 2, 1 + Math.floor(rnd() * 5000) * 2]);
    } else if (roll < 0.62) {
      const wait = rnd() < 0.2 ? pick(TIMES.filter((x) => !Number.isNaN(x))) : Math.round(rnd() * 600) / 8;
      const run_ = rnd() < 0.2 ? pick(TIMES.filter((x) => !Number.isNaN(x))) : Math.round(rnd() * 3000) / 16;
      ops.push(['r', pick(NAMES), pick(LANES), wait, run_]);
    } else if (roll < 0.74) {
      ops.push(['s']);
    } else if (roll < 0.86) {
      ops.push(['gen', pick(NAMES), pick(LANES), 1 + Math.floor(rnd() * 80), 1 + Math.floor(rnd() * 90), 1 + Math.floor(rnd() * 300)]);
    } else {
      t += pick([1, 1000, 600000, 86400000]);
      const extra = pick([undefined, {}, { a: 1 }, { window: 'x' }, { methods: null }, { '5': 1, b: [1, { c: null }], '1': 'é' }, { q: "a'\"\n" }, { n: NaN, i: Infinity }, { u: undefined, v: 2 }, { window: { from: 1 }, z: 0 }]);
      ops.push(['f', rnd() < 0.08 ? pick(WALLS.slice(5)) : t, extra === undefined ? '__undefined__' : extra]);
    }
  }
  ops.push(['s']);
  ops.push(['f', t + 5000, '__undefined__']);
  ops.push(['f', t + 6000, '__undefined__']);
  // 执行
  const timings = new M.RpcTimings(now0, rand === 'edge' ? edgeRng() : rng());
  const res = [];
  for (const op of ops) {
    if (op[0] === 'r') timings.record(op[1], op[2], op[3], op[4]);
    else if (op[0] === 'gen') {
      for (let i = 0; i < op[3]; i += 1) timings.record(op[1], op[2], ((i * op[4]) % 1013) / 8, ((i * op[5]) % 4999) / 16);
    } else if (op[0] === 's') res.push(run(() => timings.summary()));
    else res.push(run(() => (op[2] === '__undefined__' ? timings.flush(op[1]) : timings.flush(op[1], op[2]))));
  }
  return { now0, rand, ops: ops.map((o) => enc(o)), res };
}
for (let i = 0; i < 120; i += 1) out.scenarios.push(scenario('small'));
for (let i = 0; i < 6; i += 1) out.scenarios.push(scenario('big'));
for (let i = 0; i < 4; i += 1) out.scenarios.push(scenario('big', 'edge'));

const s = JSON.stringify(out);
writeFileSync(join(here, 'perf-log.json'), s);
console.log(`perf-log.json: quantile ${out.quantile.length}, slow ${out.slow.length}, scenarios ${out.scenarios.length}, ${(s.length / 1048576).toFixed(2)} MB`);
