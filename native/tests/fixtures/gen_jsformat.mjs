// 生成 jsformat.json:node 现算的 toFixed / toExponential / String(x) / Math.round / Number(string),给 engine/util/jsformat 对拍。
//   node native/tests/fixtures/gen_jsformat.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 可复现的伪随机(xorshift),不用 Math.random
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

const values = [0, -0, 1, -1, 0.5, 1.5, 2.5, -2.5, 0.05, 0.15, 0.25, 0.35, 1.005, 1.15, 2.675, 46.25, 7520.125, 0.1, 0.2, 0.3, 1 / 3, 2 / 3,
  123.456, 999.995, 9.995, 0.0001, 1e-7, 1.23e-7, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1e21, 1e21 - 65536, 123456789012345680000,
  9007199254740993, 4503599627370497.5, 0.49999999999999994, -0.49999999999999994, 1e-5, 0.000123, 1234567, 999999.5, 9999995, 0.00001234567,
  -1234.5678, 1e100, -1e-100, 3.14159, 2.718281828459045, 100, 1e15, 1e16, 1e17, 123e-20];
for (let i = 0; i < 300; i++) {
  const mag = Math.floor(rnd() * 40) - 20;
  const v = (rnd() - 0.5) * 2 * Math.pow(10, mag);
  values.push(v);
  values.push(Math.round(v * 1000) / 1000);  // 价格那种:小数点后几位
  values.push(Math.round(rnd() * 100000) / 8);  // 正好一半的二进制小数
}
const fixedDigits = [0, 1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 55, 75, 100];
const expDigits = [0, 1, 2, 3, 5, 8, 10, 15, 20, 40, 100];
const cases = values.map((x) => ({
  x,
  neg0: Object.is(x, -0),
  str: String(x),
  round: Math.round(x),
  round_neg0: Object.is(Math.round(x), -0),
  fixed: Object.fromEntries(fixedDigits.map((d) => [d, x.toFixed(d)])),
  exp: Object.fromEntries(expDigits.map((d) => [d, x.toExponential(d)])),
  exp_shortest: x.toExponential(),
}));
const strings = ['', '  ', '0', '-0', '12', ' 12 ', '1.5', '.5', '5.', '1e3', '1E-3', '+7', '-7.25', '0x1F', '0o17', '0b101', '0x', '1e', '1e+', '12abc', 'abc',
  'Infinity', '-Infinity', '+Infinity', 'infinity', '1,000', ' 1 ', '﻿3', '1.2.3', '--1', '0001', '1e400', '1e-400', '.', '+', '0X10', '-0x10'];
const numbers = strings.map((s) => { const n = Number(s); return { s, n: Number.isNaN(n) ? 'NaN' : n === Infinity ? 'Infinity' : n === -Infinity ? '-Infinity' : n, neg0: Object.is(n, -0) }; });
writeFileSync(join(here, 'jsformat.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_jsformat.mjs', node: process.version, cases, numbers }, null, 1) + '\n');
console.log(`jsformat.json:${cases.length} 个数、${numbers.length} 个字符串`);
