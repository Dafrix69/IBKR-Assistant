// 生成 market-calendar.json:engine-ts/src/marketCalendar.ts(原模块现跑)1990–2070 每年的复活节、休市日、提前收盘日,整段内置日历,并集。
//   node native/tests/fixtures/gen_market_calendar.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mc = await import(pathToFileURL(join(engine, 'dist/src/marketCalendar.js')).href);
const years = [];
for (let y = 1990; y <= 2070; y++) years.push({ y, easter: mc.easterSunday(y), holidays: mc.nyseHolidays(y), early: mc.nyseEarlyCloses(y) });
const b = mc.builtinCalendar();
const merges = [[[], ['2026-01-01']], [['2026-12-31', '2026-01-01', '2026-01-01'], ['2026-07-03', '2026-01-01']], [['2030-02-30', 'x'], ['2026-07-03']]]
  .map(([c, bi]) => ({ c, b: bi, out: mc.mergeCalendar(c, bi) }));
writeFileSync(join(here, 'market-calendar.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_market_calendar.mjs', years, builtin: { holidays: b.holidays, earlyCloses: b.earlyCloses }, merges }, null, 1) + '\n');
console.log(`market-calendar.json:${years.length} 年`);
