// 生成 jsmath.json:Math.log / exp / log10 / log2 / sin / cos / atan 在 40000 个输入上的结果(十六进制的位,逐位比)。
// 要用打包版应用里跑 TS 引擎的那个运行时生成(Electron 以 node 方式跑),不是开发机上的 node:两者的 Math.* 末位不一样。
// 输入里有特殊值(±0、次正规数、±Infinity、NaN、溢出边界、π 的几倍、atan 的分段点)与几种分布;sin / cos 只取 |x| ≤ 2^19·π/2(引擎用到的范围)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_jsmath.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let seed = 4242;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const buf = new DataView(new ArrayBuffer(8));
// NaN 一律写成 7ff8…:V8 给的 NaN 的位随 JIT 档次变,不写死的话每次生成都不一样(测试里 NaN 只比「是不是 NaN」)
const hex = (x) => { if (Number.isNaN(x)) return '7ff8000000000000'; buf.setFloat64(0, x); return buf.getBigUint64(0).toString(16).padStart(16, '0'); };
const specials = [0, -0, 1, -1, 2, 0.5, 1e-320, 5e-324, 1e308, Infinity, -Infinity, NaN, Math.E, 709.78, 709.79, -745.13, -745.14, 710, 1e-30, Math.PI, Math.PI / 2,
  3 * Math.PI / 4, 1.5707963267948966, 2.4375, 0.4375, 1.1875, 0.6875, 1e19, 1e6, 0.3, 0.78125, 1e-9, 823549];
const rows = [];
for (let i = 0; i < 40000; i++) {
  let x;
  const r = rnd();
  if (i < specials.length) x = specials[i];
  else if (r < 0.3) x = Math.exp((rnd() - 0.5) * 60) * (rnd() < 0.2 ? -1 : 1);
  else if (r < 0.6) x = (rnd() - 0.5) * 20;
  else if (r < 0.8) x = (rnd() - 0.5) * 1500;
  else x = 1 + (rnd() - 0.5) * 1e-5;
  const trig = Math.abs(x) <= 823549 || !Number.isFinite(x);
  rows.push([hex(x), hex(Math.log(x)), hex(Math.exp(x)), hex(Math.log10(x)), hex(Math.log2(x)), trig ? hex(Math.sin(x)) : null, trig ? hex(Math.cos(x)) : null, hex(Math.atan(x))]);
}
// Math.pow:指数 2 与 0.5 是 V8 自己挡下的两种,另有 NaN / ±Infinity / ±1 / ±0 与随机的底和指数
const pows = [];
const pspec = [0, -0, 1, -1, 2, 0.5, -0.5, 3, -2, 0.3, 1e-310, 1e308, Infinity, -Infinity, NaN, 10, 256, 1.0000001];
for (const x of pspec) for (const y of pspec) pows.push([hex(x), hex(y), hex(Math.pow(x, y)), hex(x ** y)]);
for (let i = 0; i < 20000; i++) {
  const x = rnd() < 0.5 ? (rnd() - 0.5) * Math.exp((rnd() - 0.5) * 20) : rnd() * 3;
  const y = rnd() < 0.4 ? 2 : rnd() < 0.2 ? 0.5 : rnd() < 0.5 ? Math.floor(rnd() * 9) - 3 : (rnd() - 0.5) * 10;
  pows.push([hex(x), hex(y), hex(Math.pow(x, y)), hex(x ** y)]);
}
writeFileSync(join(here, 'jsmath.json'), JSON.stringify({ node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8, rows, pows }) + '\n');
console.log('jsmath.json', rows.length);
