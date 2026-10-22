// 生成 intel-dateparse.json:V8(打包版应用里的 Electron 41)的 Date.parse 在一大堆串上的结果——ISO 的、老写法的、写坏的、
// 拼出来的乱串。intel 组读日历源与底账里的时刻用 util/intel_dateparse(V8 dateparser 的搬法),对着它比。本机时区按 Asia/Shanghai。
//   TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_intel_dateparse.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('不带时区的按本机时区读:要 TZ=Asia/Shanghai 跑');
const here = dirname(fileURLToPath(import.meta.url));
let seed = 0xda7e_9a75;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const enc = (v) => (Number.isNaN(v) ? '__NaN__' : Object.is(v, -0) ? '__neg0__' : v);

const fixed = [
  '2026-10-14T08:30:00-04:00', '2026-10-14T08:30:00Z', '2026-10-14T08:30:00', '2026-10-14T08:30', '2026-10-14', '2026-10', '2026', '+002026-10-14', '-000001-01-01T00:00:00Z',
  '-000000-01-01', '+275760-09-13T00:00:00Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00Z', '-271821-04-19T23:59:59Z', '+275760-09-13', '-271821-04-20T00:00:00',
  '2026-10-14T24:00:00Z', '2026-10-14T24:00:01Z', '2026-10-14T24:01', '2026-10-14T23:60', '2026-10-14T08:30:60Z', '2026-10-14T08:30:00.1Z', '2026-10-14T08:30:00.12Z',
  '2026-10-14T08:30:00.1234567891234Z', '2026-10-14T08:30:00.0001234567891Z', '2026-10-14T08:30:00.Z', '2026-10-14T08:30:00+0530', '2026-10-14T08:30:00+2400',
  '2026-10-14T08:30:00+23:59', '2026-10-14T08:30:00+24:00', '2026-10-14T08:30:00+05', '2026-10-14T08:30:00-0400', '2026-10-14t08:30:00z', '2026-10-14T8:30', '2026-1-14',
  '2026-10-1', '2026-13-01', '2026-00-10', '2026-02-29', '2026-02-30', '2026-02-31', '2024-02-29', '2026-04-31', '2026-10-32', '20261014', '2026/10/14', '10/14/2026',
  '10/14/26', '14/10/2026', '2026-10-14 08:30', '2026-10-14 08:30:15', '2026-10-14 8:30 PM', '2026-10-14 12:00 am', '2026-10-14 13:00 pm', '2026-10-14 08:30 GMT+8',
  '2026-10-14 08:30 UTC', '2026-10-14 08:30 EST', '2026-10-14 08:30 PDT', '2026-10-14 08:30Z', '2026-10-14 08:30 +0800', '2026-10-14 08:30 -5', '2026-10-14 08:30 +12345',
  'Oct 14 2026', 'October 14, 2026', '14 Oct 2026', 'Tue, 14 Oct 2026 12:30:00 GMT', 'Tue Oct 14 2026 08:30:00 GMT-0400 (Eastern Daylight Time)', 'Oct 2026',
  '2026 Oct 14', 'oct-14-2026', '14-oct-2026', 'Octx 14 2026', 'Foo 14 2026', '14 Foo 2026', 'Sept 14 2026', 'Junk', '12', '1', '0', '49', '50', '99', '100', '12/31',
  '1/2/3', '1/2/3/4', '08:30', '08:30 2026-10-14', 'T08:30', '2026-10-14T', '2026-10-14T08', '  2026-10-14', '2026-10-14  ', '2026-10-14\n', '　2026-10-14',
  '(comment) Oct 14 2026', 'Oct 14 2026 (EDT)', 'Oct 14 2026 (unclosed', 'Oct 14 (x(y)z) 2026', '2026-10-14T08:30:00 (z)', '', ' ', 'x', 'NaN', 'Infinity', '-1', '+1',
  '2026-10-14T08:30:00+05:30:00', 'Oct 14 2026 10:20:30.456', 'Oct 14 2026 10:20:30.', 'Oct 14 2026 10:20::', 'Oct 14 2026 10::', '10:20:30:40 Oct 14 2026',
  'Oct 14 2026 10 am', 'Oct 14 2026 am 10', 'Oct 14 2026 GMT', 'GMT Oct 14 2026', 'Oct 14 2026 UTC+100000:00', 'Oct 14 2026 UTC+300000:00', 'Oct 14 2026 UTC+600000:00',
  'Oct 14 2026 UTC-1', 'Oct 14 2026 +01', 'Oct 14 2026 10:00 +01:30', 'Oct 14 2026 10:00 +01 30', 'Oct 14 2026 10:00 -)', '1000000-01-01', '999999999-01-01',
  'Oct 14 999999999', 'Oct 14 275760', 'Oct 14 275761', 'Jan 1 -5', '1970-01-01T00:00:00.000+00:00', '1901-01-01T00:00:00', '1900-01-01T00:00:00', '1800-06-01',
  '1800-06-01T12:00', '1988-04-17T02:30', '1988-09-11T01:30', '1941-03-16T00:30', 'Z', 'T', 'z 2026', '2026 z', 'Oct 14 2026', 'Ｏｃｔ 14 2026', '٢٠٢٦-10-14',
  '2026-10-14\u0000junk', 'May 5 2026 12:00 pm', 'May 5 2026 12:00 am', 'May 5 2026 0:00 pm', 'May 5 2026 13:00 am', '24:00 May 5 2026', '24:01 May 5 2026',
  '+275760-09-13T07:00:00', '+275760-09-13T08:00:00', '+275760-09-13T08:00:01', '-271821-04-20T07:00:00', '-271821-04-20T08:05:43', 'Oct 14 2026 08:30 EDT',
  'Oct 14 2026 08:30 edt', 'Oct 14 2026 08:30 CDT', 'Oct 14 2026 08:30 MDT', 'Oct 14 2026 08:30 MST', 'Oct 14 2026 08:30 PST', 'Oct 14 2026 08:30 CST',
];
const toks = ['2026', '10', '14', '08', '30', '2', '1999', '000', '0', '7', '12345', '-', '+', ':', '.', '/', ',', ' ', ' ', 'T', 't', 'Z', 'z', 'GMT', 'UTC', 'EST',
  'Oct', 'october', 'May', 'Foo', 'am', 'PM', '(', ')', '(x)', ' ', '日', 'a', '+0800', '-05:00', '.123', '24', '60', '99', '1000000'];
const out = [];
for (const s of fixed) out.push([s, enc(Date.parse(s))]);
for (let i = 0; i < 20000; i += 1) {
  let s = '';
  for (let n = 1 + Math.floor(rnd() * 9); n > 0; n -= 1) s += pick(toks);
  out.push([s, enc(Date.parse(s))]);
}
// ISO 形状的串上随机改一位
const iso = '2026-10-14T08:30:45.678-04:00';
const chars = '0123456789-+:.TZtz /x';
for (let i = 0; i < 6000; i += 1) {
  const a = iso.split('');
  for (let k = 1 + Math.floor(rnd() * 3); k > 0; k -= 1) {
    const at = Math.floor(rnd() * a.length);
    const op = rnd();
    if (op < 0.5) a[at] = pick(chars.split('')); else if (op < 0.75) a.splice(at, 1); else a.splice(at, 0, pick(chars.split('')));
  }
  const s = a.join('').slice(0, Math.floor(rnd() * 40));
  out.push([s, enc(Date.parse(s))]);
}
writeFileSync(join(here, 'intel-dateparse.json'), JSON.stringify({ generator: 'gen_intel_dateparse.mjs', tz: process.env.TZ, cases: out }) + '\n');
console.log(`intel-dateparse.json: ${out.length} 串, 读得出的 ${out.filter((c) => c[1] !== '__NaN__').length}`);
