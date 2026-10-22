// 生成 assignment-risk.json:engine-ts 的 assignmentRisk.ts(原模块现跑)。今天到期的实物交割期权腿(现金结算的、别的日子的、到期写法带钟点 / 空格、
// 数量为 0、行权价缺、right 小写、乘数缺、合约缺时抛的话),各账户各标的的指派通知(有无现价、现价是串 / 0 / NaN、平值、多头自动行权抵掉一部分)与给人看的那段话。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_assignment_risk.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const A = await import(pathToFileURL(join(engine, 'dist/src/assignmentRisk.js')).href);

let seed = 0xa551_9e00;
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

const TODAY = '20261016';
const cash = ['SPX', 'NDX', 'XSP'];
let k = 0;
const row = () => {
  const symbol = pick(['NVDA', 'AAPL', 'SPY', 'SPX', 'TSLA']);
  const r = { key: `k${++k}`, account: pick(['A', 'B']), symbol, label: `${symbol} x`, sec_type: pick(['OPT', 'OPT', 'OPT', 'FOP', 'STK', 'BAG']), quantity: pick([-1, -2, 1, 3, -5, 0, -0.5]),
    multiplier: pick([100, 100, '100', 10, 0, null, undefined, -5]),
    contract: { lastTradeDateOrContractMonth: pick([TODAY, TODAY, ` ${TODAY} `, `${TODAY} 16:00`, '20261017', '202610', null, undefined, 20261016]),
      strike: pick([140, 145, 150, 230, 600, 0, '150', null, -1]), right: pick(['C', 'P', 'c', 'p', 'CALL', 'put', '', null, undefined]) } };
  if (rnd() < 0.02) delete r.contract;
  if (rnd() < 0.03) delete r.label;
  return r;
};
const legsCases = [];
const allLegs = [];
for (let i = 0; i < 400; i += 1) {
  const rows = Array.from({ length: Math.floor(rnd() * 8) }, row);
  const r = run(() => A.expiringOptionLegs(rows, TODAY, (s) => cash.includes(s)));
  legsCases.push({ rows: enc(rows), ...r });
  if (r.out) allLegs.push(A.expiringOptionLegs(rows, TODAY, (s) => cash.includes(s)));
}
const spotsPool = [{}, { NVDA: 145, AAPL: 230 }, { NVDA: 150, AAPL: 229.995, TSLA: 0 }, { NVDA: '145', AAPL: NaN, SPY: 600.004 }, { NVDA: 139.5, AAPL: 231, SPY: 599, TSLA: 250 },
  { NVDA: 140, AAPL: 230, SPY: 600, TSLA: null }, { NVDA: Infinity, AAPL: -3 }];
const notices = [];
for (let i = 0; i < 600; i += 1) {
  const legs = rnd() < 0.7 && allLegs.length ? pick(allLegs) : [];
  const extra = rnd() < 0.3 ? [{ key: 'x', account: 'A', symbol: 'NVDA', label: 'NVDA x', quantity: pick([-1, 2, -3]), multiplier: pick([100, 10]), strike: pick([140, 150, 145.123]), right: pick(['C', 'P']) }] : [];
  const all = [...legs, ...extra];
  const spots = pick(spotsPool);
  const r = run(() => A.assignmentNotices(all, spots));
  notices.push({ legs: enc(all), spots: enc(spots), ...r, texts: r.out ? A.assignmentNotices(all, spots).map((n) => A.noticeText(n)) : [] });
}
// 手搭的几组腿:多空相抵(净变动 0)、数量为 0 的腿、通知里 net_shares 是 null 而现价有
const L = (q, strike, right, mult = 100) => ({ key: `h${q}${strike}${right}`, account: 'A', symbol: 'NVDA', label: 'NVDA', quantity: q, multiplier: mult, strike, right });
for (const legs of [[L(-1, 140, 'C'), L(1, 130, 'C')], [L(-2, 150, 'P'), L(2, 155, 'P')], [L(0, 140, 'C'), L(-1, 150, 'P')], [L(0, 140, 'C')], [L(-1, 140, 'C', 10), L(1, 135, 'C', 10), L(-1, 150, 'P')]]) {
  const spots = { NVDA: 145 };
  notices.push({ legs, spots, out: A.assignmentNotices(legs, spots), texts: A.assignmentNotices(legs, spots).map((n) => A.noticeText(n)) });
}
const handTexts = [{ account: 'A', symbol: 'NVDA', spot: 145, legs: [{ ...L(-1, 140, 'C'), itm_by: 5 }], net_shares: null },
  { account: 'A', symbol: 'NVDA', spot: 145, legs: [{ ...L(-1, 140, 'C'), itm_by: 5 }], net_shares: 0 },
  { account: 'A', symbol: 'NVDA', spot: null, legs: [], net_shares: 5 }, { account: 'B', symbol: 'X', spot: 1.005, legs: [{ ...L(-1.234, 2.345, 'P'), itm_by: 0.125 }], net_shares: -123.456 }]
  .map((n) => ({ n, out: A.noticeText(n) }));
const itm = [];
for (const right of ['C', 'P', 'X']) for (const strike of [140, 150]) for (const spot of [139, 140, 145.5, 150, 151]) itm.push({ right, strike, spot, out: A.itmBy({ right, strike }, spot) });
writeFileSync(join(here, 'assignment-risk.json'), JSON.stringify({ generator: 'gen_assignment_risk.mjs', today: TODAY, cash, legsCases, notices, itm, handTexts }) + '\n');
console.log(`assignment-risk.json: ${legsCases.length} 份持仓, ${notices.length} 次通知, 出了 ${notices.reduce((s, n) => s + (n.out?.length ?? 0), 0)} 条`);
