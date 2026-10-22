// 生成 open-risk.json:engine-ts 的 openRisk.ts(原模块现跑)。手搭的标准结构(价差、蝶、铁鹰、铁蝶、断翼、两侧不等的铁鹰、分腿建起来的贷方价差、
// 净卖出的看涨、卖出的看跌、日历价差、同一天挤在一起的几只结构)与随机持仓(数量是串 / null / 0、行权价缺、right 小写或写成 CALL、乘数缺、
// 成本为负、FOP、正股、BAG 行、合约缺)的最坏亏损、张数与说明;另有 worstCaseAtExpiry 的随机腿。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_open_risk.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const O = await import(pathToFileURL(join(engine, 'dist/src/openRisk.js')).href);

let seed = 0x09e2_715c;
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

let k = 0;
const row = (account, symbol, expiry, strike, right, qty, cost, extra = {}) => ({
  key: `k${++k}`, account, symbol, sec_type: 'OPT', quantity: qty, avg_cost: cost, multiplier: 100, currency: 'USD',
  contract: { secType: 'OPT', symbol, lastTradeDateOrContractMonth: expiry, strike, right, exchange: 'SMART' }, ...extra,
});
const E = '20261016';
const hand = [
  [row('A', 'SPX', E, 7800, 'C', 2, 520), row('A', 'SPX', E, 7815, 'C', -2, 310)],
  [row('A', 'SPX', E, 7800, 'C', 1, 900), row('A', 'SPX', E, 7815, 'C', -2, 600), row('A', 'SPX', E, 7830, 'C', 1, 350)],
  [row('A', 'SPX', E, 7700, 'P', 1, 200), row('A', 'SPX', E, 7710, 'P', -1, 350), row('A', 'SPX', E, 7800, 'C', -1, 300), row('A', 'SPX', E, 7810, 'C', 1, 150)],
  [row('A', 'SPX', E, 7700, 'P', 2, 200), row('A', 'SPX', E, 7710, 'P', -2, 350), row('A', 'SPX', E, 7800, 'C', -5, 300), row('A', 'SPX', E, 7810, 'C', 5, 150)],
  [row('A', 'SPX', E, 7700, 'P', 1, 100), row('A', 'SPX', E, 7750, 'P', -1, 900), row('A', 'SPX', E, 7750, 'C', -1, 950), row('A', 'SPX', E, 7800, 'C', 1, 120)],
  [row('A', 'NVDA', '20261017', 140, 'C', -3, 250)],
  [row('A', 'NVDA', '20261017', 130, 'P', -2, 180)],
  [row('A', 'NVDA', '20261017', 140, 'C', -3, 250), row('A', 'NVDA', '20261017', 150, 'C', 1, 60)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1, 900), row('A', 'SPX', '20261120', 7800, 'C', -1, 1500)],
  [row('A', 'SPX', E, 7800, 'C', 1, 900), row('A', 'SPX', E, 7815, 'C', -2, 600), row('A', 'SPX', E, 7830, 'C', 1, 350), row('A', 'SPX', E, 7600, 'P', -1, 400), row('A', 'SPX', E, 7590, 'P', 1, 300)],
  [row('B', 'spx', E, 7800, 'C', 1, 900), row('B', 'SPX', E, 7815, 'C', -1, 600, { account: 'B' }), row('2', 'QQQ', '20261016 08:30', 500, 'c', -1, 300), row('1', 'QQQ', E, 500, 'put', -1, 300)],
  [row('A', 'ES', E, 6000, 'C', 1, 2500, { sec_type: 'FOP', multiplier: 50 }), row('A', 'ES', E, 6050, 'C', -1, 1000, { sec_type: 'FOP', multiplier: '50' })],
  [{ key: 's1', account: 'A', symbol: 'NVDA', sec_type: 'STK', quantity: 10, avg_cost: 120 }, row('A', 'NVDA', '20261017', 140, 'C', -1, 250)],
  [row('A', 'SPX', E, 7800, 'C', 1, 900, { contract: null }), row('A', 'SPX', E, 7800, 'C', 1, 900, { contract: undefined }), row('A', 'SPX', E, 7800, 'C', '2', '-900')],
  // 腿的张数和组数差一点点:差 1e-10 算对得上(按组数记),差 2e-9 不算(按腿记)
  [row('A', 'SPX', E, 7800, 'C', 1, 900, { key: 'T1' }), row('A', 'SPX', E, 7815, 'C', -1.0000000001, 600, { key: 'T2' }),
    { key: 'bagT', account: 'A', symbol: 'SPX', sec_type: 'BAG', kind: 'vertical', quantity: 1, legs: ['T1', 'T2'] }],
  [row('A', 'SPX', E, 7800, 'C', 1, 900, { key: 'U1' }), row('A', 'SPX', E, 7815, 'C', -1.000000002, 600, { key: 'U2' }),
    { key: 'bagU', account: 'A', symbol: 'SPX', sec_type: 'BAG', kind: 'vertical', quantity: 1, legs: ['U1', 'U2'] }],
  // 手拼的 BAG 行:组数为 0 且没有腿、两条腿的「蝶」;小数张数的净卖出看涨(说明里的张数要 pyRound)
  [{ key: 'bag0', account: 'A', symbol: 'SPX', sec_type: 'BAG', kind: 'vertical', quantity: 0, legs: [] }],
  [row('A', 'SPX', E, 7800, 'C', 1, 900, { key: 'L1' }), row('A', 'SPX', E, 7815, 'C', -2, 600, { key: 'L2' }),
    { key: 'bag1', account: 'A', symbol: 'SPX', sec_type: 'BAG', kind: 'butterfly', quantity: 1, legs: ['L1', 'L2'] }],
  [row('A', 'SPX', E, 7800, 'C', -0.1, 90), row('A', 'SPX', E, 7815, 'C', -0.2, 60)],
];
const rights = ['C', 'P', 'c', 'p', 'CALL', 'Put', '', null, 'X'];
const rand = () => Array.from({ length: Math.floor(rnd() * 9) }, () => {
  const r = row(pick(['A', 'B', 'IRA']), pick(['SPX', 'NVDA', 'QQQ']), pick([E, E, '20261017', '20261016x', '']), pick([7800, 7815, 7830, 7785, 140, 0, -5, '7800', null, NaN]),
    pick(rights), pick([1, -1, 2, -2, -3, 0, '1', null, 0.5, NaN]), pick([100, 250, -300, 0, null, '50']));
  if (rnd() < 0.1) r.sec_type = pick(['STK', 'FOP', 'BAG', 'opt']);
  if (rnd() < 0.1) r.multiplier = pick([null, 0, '10', 50, -100]);
  if (rnd() < 0.05) delete r.contract;
  if (rnd() < 0.05) r.key = pick(['k1', null, 5]);
  return r;
});
const cases = [];
for (const rows of hand) cases.push({ rows: enc(rows), ...run(() => O.openRisk(rows)) });
for (let i = 0; i < 600; i += 1) { const rows = rand(); cases.push({ rows: enc(rows), ...run(() => O.openRisk(rows)) }); }
const worst = [];
for (let i = 0; i < 400; i += 1) {
  const legs = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ qty: pick([1, -1, 2, -3, 0.5]), mult: pick([100, 50, 10]), strike: pick([7800, 7815, 7830, 100, 0.5]), call: rnd() < 0.5, cost: pick([0, 100, 350.5]) }));
  worst.push({ legs, out: enc(O.worstCaseAtExpiry(legs)) });
}
const keys = [];
for (const [a, s, e] of [['A', 'spx', '20261016'], ['A', 'SPX', '20261016 08:30'], ['', '', ''], ['a', 'ß', '2026']]) keys.push({ a, s, e, out: O.contractsKey(a, s, e) });
writeFileSync(join(here, 'open-risk.json'), JSON.stringify({ generator: 'gen_open_risk.mjs', cases, worst, keys }) + '\n');
console.log(`open-risk.json: ${cases.length} 份持仓, ${worst.length} 组腿`);
