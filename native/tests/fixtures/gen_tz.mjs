// 生成 tz.json:engine-ts/src/tz.ts(原模块现跑,用 tsc 编出来的 dist)在 DST 边界、空隙、重叠、不存在的日期、不认识的时区、
// IBKR 成交时间的几种写法上的输出;外加 JS 的 Date.UTC(进位、0–99 年)。
//   node native/tests/fixtures/gen_tz.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const tz = await import(pathToFileURL(join(engine, 'dist/src/tz.js')).href);

let seed = 0x1b873593;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const zones = ['America/New_York', 'Asia/Shanghai', 'America/Chicago', 'UTC', 'Europe/London', 'Mars/Base'];
const enc = (x) => (Number.isNaN(x) ? 'NaN' : x);
const tryIt = (f) => { try { return { ok: f() }; } catch (e) { return { error: e.message }; } };

const epochs = [];
for (const year of [2024, 2025, 2026, 2027]) {
  for (const [m, d] of [[3, 8], [3, 9], [3, 10], [3, 14], [11, 1], [11, 2], [11, 3], [11, 7], [3, 30], [10, 26]]) {
    const base = Date.UTC(year, m - 1, d, 0, 0, 0);
    for (let h = 0; h < 24; h += 1) epochs.push(base + h * 3600000, base + h * 3600000 + 1800000 + 999);
  }
}
for (let i = 0; i < 200; i++) epochs.push(Math.floor(Date.UTC(2020, 0, 1) + rnd() * (Date.UTC(2031, 0, 1) - Date.UTC(2020, 0, 1))));
epochs.push(-1500, 0, 1, -86400001, 1e15, NaN);
const parts = epochs.flatMap((e) => zones.map((z) => ({ e: enc(e), z, r: tryIt(() => tz.wallParts(e, z)) })));
const stamps = epochs.slice(0, 120).flatMap((e) => ['America/New_York', 'Asia/Shanghai'].map((z) => ({ e: enc(e), z, date: tryIt(() => tz.dateStrAt(e, z)), stamp: tryIt(() => tz.stampAt(e, z)) })));

const walls = [];
for (const year of [2025, 2026, 2027]) {
  for (const [m, d] of [[3, 8], [3, 9], [3, 14], [11, 1], [11, 2], [11, 7], [2, 28], [2, 29], [2, 30], [12, 31], [1, 1], [4, 31], [6, 15]]) {
    for (const [h, mi] of [[0, 0], [1, 30], [2, 0], [2, 30], [3, 0], [9, 30], [16, 5], [23, 59], [24, 0]]) walls.push({ year, month: m, day: d, hour: h, minute: mi, second: 0 });
  }
}
walls.push({ year: 2026, month: 13, day: 1, hour: 0, minute: 0, second: 0 }, { year: 2026, month: 0, day: 1, hour: 0, minute: 0, second: 0 },
  { year: 2026, month: 5, day: 32, hour: 0, minute: 0, second: 0 }, { year: 2026, month: 5, day: 0, hour: 0, minute: 0, second: 0 },
  { year: 2026, month: 5, day: 5, hour: 5, minute: 60, second: 0 }, { year: 2026, month: 5, day: 5, hour: 5, minute: 5, second: 61 });
const wallCases = walls.flatMap((w) => zones.map((z) => ({ w, z, toEpoch: tryIt(() => enc(tz.wallToEpoch(w, z))), zoned: tryIt(() => tz.zonedEpoch(w, z)) })));

const ibStrings = ['20260910-10:00:01', '20260910 05:00:01 US/Central', '20260910  05:00:01', '20260910 05:00:01', '20260910 05:00:01 Asia/Hong_Kong',
  '20260910 05:00:01 US/Pacific', '2026-09-10 05:00:01', '20260910-10:00', '', '20261301 05:00:01', '20260910 05:00:01 US/Eastern extra'];
const ib = ibStrings.map((s) => ({ s, r: tz.ibWallTime(s) }));
const dates = ['2026-10-19', '2026-02-29', '2024-02-29', '1970-01-01', '1969-12-31', '2026-1-5', '2026-10', '', 'x', '2026-13-01', '0050-01-01', '9999-12-31'];
const dateCases = dates.map((d) => ({ d, weekday: enc(tz.weekdayOfDate(d)), ordinal: enc(tz.dateOrdinal(d)), endUtc: tryIt(() => tz.ibEndUtc(d)), endUtc2: tryIt(() => tz.ibEndUtc(d, 9, 30)) }));
const ordinals = [0, 1, -1, 20745, 20746, -719162, 2932896, 1.5, NaN].map((o) => ({ o: enc(o), date: tz.ordinalToDate(o) }));
const ymd = [[2026, 2, 29], [2024, 2, 29], [2026, 2, 28], [2026, 4, 31], [2026, 13, 1], [2026, 0, 1], [2026, 1, 0], [50, 1, 1], [2026.5, 1, 1], [2026, 6, 15]]
  .map(([y, m, d]) => ({ y, m, d, ok: tz.isValidYmd(y, m, d) }));
const isoCases = [0, 1, 999, 1000, 1500, -1, -1500, 1792303200123, 1792303200000, 253402300799999, -62198755200000, NaN].map((e) => ({ e: enc(e), utc: tryIt(() => tz.utcIso(e)) }));
const pads = [0, 5, 12, 123, -1, 1.5, NaN].map((n) => ({ n: enc(n), s: tz.pad2(n) }));
const utc = [[2026, 0, 1], [2026, 12, 1], [2026, -1, 1], [2026, 1, 31], [99, 0, 1], [0, 0, 1], [100, 0, 1], [2026, 2, 0, 25, 61, 61], [NaN, 0, 1], [2026.7, 1.9, 2.5]]
  .map((a) => ({ a: a.map(enc), t: enc(Date.UTC(...a)) }));
writeFileSync(join(here, 'tz.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_tz.mjs', parts, stamps, walls: wallCases, ib, dates: dateCases, ordinals, ymd, iso: isoCases, pads, utc }, null, 1) + '\n');
console.log(`tz.json:${parts.length} 个时刻×时区、${wallCases.length} 个墙钟×时区、${ib.length} 个成交时间`);
