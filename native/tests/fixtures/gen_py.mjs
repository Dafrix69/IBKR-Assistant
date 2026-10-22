// 生成 py.json:engine-ts/src/py.ts 的每个函数在一大把输入上的输出(原模块现跑:用 tsc 编出来的 dist)。
//   node native/tests/fixtures/gen_py.mjs <engine-ts 编过的目录(含 dist/)>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const py = await import(pathToFileURL(join(engine, 'dist/src/py.js')).href);

let seed = 0x2545f491;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const nums = [0, -0, 0.5, 1.5, 2.5, -2.5, 0.125, 0.375, 46.25, 7520.125, 2.675, 1.005, 0.045, 1.15, 0.0001, 0.00012345, 1e-5, 1e-7, 123456, 1234567, 999999.5,
  1e15, 1e16, 1.5e16, 1e21, -1e-5, 3.14159265, 100, -100, 0.1 + 0.2, 1 / 3, 2 / 3, 5e-324, 1.7976931348623157e308, 12.345, -12.345, 0.995, 99.995, 7845.5, -0.0004];
for (let i = 0; i < 400; i++) {
  const mag = Math.floor(rnd() * 16) - 6;
  nums.push((rnd() - 0.5) * 2 * Math.pow(10, mag));
  nums.push(Math.round(rnd() * 400000) / 16 * (rnd() < 0.5 ? -1 : 1));
  nums.push(Math.round(rnd() * 1000000) / 1000);
}
const nds = [0, 1, 2, 3, 4, 6];
const enc = (x) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : Object.is(x, -0) ? '-0' : x);
const numCases = [...nums, NaN, Infinity, -Infinity].map((x) => ({
  x: enc(x),
  round: Object.fromEntries(nds.map((d) => [d, enc(py.pyRound(x, d))])),
  f: Object.fromEntries(nds.map((d) => [d, py.fmtF(x, d)])),
  sf: Object.fromEntries(nds.map((d) => [d, py.fmtSF(x, d)])),
  g: py.pyG(x), float: py.pyFloat(x), d: py.fmtD(x), repr: py.pyRepr(x),
}));
const values = [null, true, false, 0, 1, -1, 2.5, NaN, '', 'abc', "it's", 'say "hi"', 'both \' and "', 'a\\b\nc\td\r', '0', ' 12 ', '1e3', 'x1', [], [1], [1, 2], {}, { a: 1 }];
const valueCases = values.map((v) => ({ v: typeof v === 'number' ? enc(v) : v, isNumber: typeof v === 'number', truthy: py.truthy(v), finite: py.finiteOrNull(v), repr: py.pyRepr(v) }));
writeFileSync(join(here, 'py.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_py.mjs', numbers: numCases, values: valueCases }, null, 1) + '\n');
console.log(`py.json:${numCases.length} 个数、${valueCases.length} 个值`);
