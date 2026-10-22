// 生成 ibtrades.json:engine-ts 的 ibtrades.ts(原模块现跑)把合成的逐腿成交合成蝴蝶:BAG 行 / 只有腿、一条腿分几笔、
// 比例不是 1:2:1、方向不对、到期 / 看涨看跌不一致、数量与价格的坏值、permId / orderId / execId 三级分组、
// 账户在不在别名表里(账号全是假的)、时间串排序。输入先过一遍 JSON。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_ibtrades.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const I = await import(pathToFileURL(join(engine, 'dist/src/ibtrades.js')).href);

let seed = 0x1b7a_de55;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
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
const rt = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const pad = (n) => String(n).padStart(2, '0');

const out = { runtime: '', groupKey: [], groups: [] };
const ACCTS = ['DUTEST001', 'UXTEST123', 'DU1', '', 'dutest9', 'UTEST77777'];
for (const f of [{ perm_id: 123 }, { perm_id: '456' }, { perm_id: 0, order_id: 7 }, { perm_id: null, order_id: '8.9' }, { order_id: 0, exec_id: 'x1' }, {}, { exec_id: 5 },
  { perm_id: 'abc' }, { perm_id: -3.7 }, { perm_id: -0.5 }, { perm_id: true }, { perm_id: [12] }, { perm_id: {} }, { perm_id: 1e21 }, { perm_id: '' , order_id: '', exec_id: null }])
  out.groupKey.push({ fill: f, ...run(() => I.groupKey(f)) });
out.groupKey.push({ fill: null, ...run(() => I.groupKey(null)) });

let execN = 0;
function flyFills(o) {
  const k = o.center ?? 5800, w = o.wing ?? 10;
  const strikes = [k - w, k, k + (o.wingUpper ?? w)];
  const wing = o.action === 'SELL' ? 'SLD' : 'BOT', body = wing === 'BOT' ? 'SLD' : 'BOT';
  const qty = o.qty ?? 1;
  const rows = [];
  const base = { account_id: o.account ?? 'DUTEST001', perm_id: o.perm ?? int(1000, 9999), order_id: o.orderId ?? int(1, 50), order_ref: '' };
  const day = o.day ?? '20261016';
  const t = (m, s) => `${day}-${pad(13 + Math.floor(m / 60))}:${pad(m % 60)}:${pad(s)}`;
  strikes.forEach((strike, i) => {
    const ratio = (o.ratios ?? [1, 2, 1])[i];
    let left = ratio * qty;
    const parts = o.split && rnd() < 0.5 ? 2 : 1;
    for (let p = 0; p < parts; p += 1) {
      const sh = p === parts - 1 ? left : Math.floor(left / 2) || left;
      left -= sh;
      if (sh <= 0) continue;
      const side = (o.sides ?? [wing, body, wing])[i];
      rows.push({ ...base, exec_id: `0000e${(execN += 1)}.01`, time: o.noTime || (o.partialTime && i === 0) ? '' : t(int(0, 30), int(0, 59)), side: o.lower ? side.toLowerCase() : side, shares: sh,
        price: Math.round((rnd() * 10 + (i === 1 ? 3 : 1)) * 100) / 100, commission: o.noComm ? null : pick([0.65, 1.3, '0.5', undefined]),
        contract: { secType: o.secType ?? 'OPT', symbol: o.symbol ?? 'SPX', strike: o.strikeStr ? String(strike) : strike, right: (o.rights ?? ['C', 'C', 'C'])[i],
          expiry: (o.expiries ?? [day, day, day])[i], tradingClass: 'SPXW', multiplier: o.mult ?? '100', conId: i === 2 && o.noConId ? undefined : 100 + i, currency: o.currency ?? 'USD' } });
    }
  });
  if (o.bag) {
    const n = o.bag === 2 ? 2 : 1;
    for (let b = 0; b < n; b += 1)
      rows.push({ ...base, exec_id: `0000b${(execN += 1)}`, time: o.bagNoTime ? undefined : t(int(0, 30), 0), side: wing, shares: n === 2 ? (b === 0 ? 1 : qty - 1 || 1) : qty,
        price: pick([2.35, -2.35, 1.1, 0.05]), contract: { secType: 'BAG', symbol: 'SPX' } });
  }
  return rows;
}
const variants = [
  {}, { bag: 1 }, { bag: 2, qty: 3 }, { split: true, qty: 4 }, { action: 'SELL' }, { qty: 2, split: true, bag: 1 }, { ratios: [1, 1, 1] }, { ratios: [2, 4, 2] }, { ratios: [1, 3, 1] },
  { sides: ['BOT', 'BOT', 'BOT'] }, { sides: ['BOT', 'SLD', 'SLD'] }, { rights: ['C', 'P', 'C'] }, { expiries: ['20261016', '20261017', '20261016'] }, { lower: true },
  { sides: ['BUY', 'SELL', 'BUY'] }, { noTime: true }, { noComm: true }, { mult: '10' }, { mult: '' }, { mult: '12.5' }, { mult: 'x' }, { symbol: 'XSP', center: 580.5, wing: 2.5 },
  { wingUpper: 15 }, { strikeStr: true }, { secType: 'FOP' }, { secType: 'STK' }, { account: 'UXTEST123' }, { account: '' }, { account: 'DU1' }, { account: 'UTEST77777' },
  { perm: 0 }, { perm: 0, orderId: 0 }, { perm: '77' }, { perm: null, orderId: '12' }, { noConId: true }, { currency: '' }, { bagNoTime: true, bag: 1 }, { qty: 0.4, ratios: [1, 2, 1] },
  { center: 0, wing: 0.5 }, { day: '20261015' }, { mult: '0' }, { mult: 0 }, { partialTime: true }, { account: 'dutest9' }, { orderId: 0 }, { orderId: '' },
];
const accountSets = [[], [{ account_id: 'DUTEST001', alias: '模拟一号', is_paper: true }], [{ account_id: 'UXTEST123', alias: '实盘', is_paper: 0 }, { account_id: 'UXTEST123', alias: '后来的', is_paper: 'y' }],
  [{ account_id: 'DUTEST001' }, { alias: '空号' }], [5, { account_id: 'UTEST77777', alias: 7, is_paper: false }]];
for (let i = 0; i < 160; i += 1) {
  const fills = [];
  const n = int(1, 4);
  for (let j = 0; j < n; j += 1) fills.push(...flyFills({ ...pick(variants), ...(rnd() < 0.3 ? pick(variants) : {}), qty: pick([1, 1, 2, 3, 5]) }));
  if (rnd() < 0.2) fills.push({ account_id: 'DUTEST001', exec_id: 'stk1', side: 'BOT', shares: 10, price: 5, contract: { secType: 'STK', symbol: 'AAPL' } });
  if (rnd() < 0.1) fills.push({ account_id: 'DUTEST001', perm_id: fills[0]?.perm_id, exec_id: 'junk', side: 'BOT', shares: pick([0, -1, 'x', null]), price: 1, contract: { secType: 'OPT', strike: 5800, right: 'C', expiry: '20261016' } });
  if (rnd() < 0.1) fills.push({ account_id: 'DUTEST001', perm_id: fills[0]?.perm_id, exec_id: 'junk2', side: 'BOT', shares: 1, price: '', contract: { secType: 'OPT', strike: 5800, right: 'C', expiry: '20261016' } });
  if (rnd() < 0.1) fills.push({ account_id: 'DUTEST001', perm_id: fills[0]?.perm_id, exec_id: 'junk3', side: 'BOT', shares: 1, price: 1, contract: { secType: 'OPT', strike: null } });
  if (rnd() < 0.3) fills.reverse();
  const accounts = pick(accountSets);
  const f = rt(fills), a = rt(accounts);
  out.groups.push({ fills: f, accounts: a, ...run(() => I.groupButterflies(f, a)) });
}
// 同一 permId 在两个账户:两张记录 id 与时间都一样,次序看分组的先后
{
  const a = flyFills({ perm: 42, account: 'DUTEST001' }), b = flyFills({ perm: 42, account: 'UXTEST123' });
  b.forEach((r, i) => { r.time = a[i]?.time ?? r.time; });
  const f = rt([...b, ...a]);
  out.groups.push({ fills: f, accounts: [], ...run(() => I.groupButterflies(f, [])) });
  const c = flyFills({ perm: 43 }), d = flyFills({ perm: 44 });
  d.forEach((r) => { r.time = c[0].time; }); c.forEach((r) => { r.time = c[0].time; });
  const g = rt([...d, ...c]);
  out.groups.push({ fills: g, accounts: [], ...run(() => I.groupButterflies(g, [])) });
  for (const [acct, accounts] of [['', [0, false, { account_id: 'X' }]], ['UXTEST123', [{ account_id: 'UXTEST123', alias: '先', is_paper: 1 }, { account_id: 'UXTEST123', alias: '后', is_paper: 0 }]], ['', [{ alias: '无号', is_paper: true }]]]) {
    const h = rt(flyFills({ account: acct }));
    out.groups.push({ fills: h, accounts, ...run(() => I.groupButterflies(h, accounts)) });
  }
  // 每种坏法单独来一份(上面的随机组合可能盖掉它)
  const zeroNet = flyFills({ perm: 50 });
  zeroNet.push({ ...zeroNet[0], exec_id: 'zn', side: 'SLD' });
  const four = flyFills({ perm: 58 });
  four.push({ ...four[0], exec_id: 'f4', contract: { ...four[0].contract, strike: 99999 } });
  for (const rows of [flyFills({ perm: 51, expiries: ['20261017', '20261016', '20261016'] }), flyFills({ perm: 52, ratios: [1, 2, 2] }), flyFills({ perm: 53, qty: 0.4 }),
    flyFills({ perm: 54, qty: 0.6 }), zeroNet, four, flyFills({ perm: 55, rights: ['P', 'C', 'C'] }), flyFills({ perm: 56, mult: '0' }), flyFills({ perm: 57, orderId: 0 }), flyFills({ perm: 59, account: 'DU123' }), flyFills({ perm: 60, account: 'UX1234' })]) {
    const h = rt(rows);
    out.groups.push({ fills: h, accounts: [], ...run(() => I.groupButterflies(h, [])) });
  }
  out.groups.push({ fills: [null], accounts: [], ...run(() => I.groupButterflies([null], [])) });
  out.groups.push({ fills: [], accounts: [null], ...run(() => I.groupButterflies([], [null])) });
  out.groups.push({ fills: [{ contract: null }, { contract: 5 }], accounts: [], ...run(() => I.groupButterflies([{ contract: null }, { contract: 5 }], [])) });
}

out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'ibtrades.json'), JSON.stringify(out) + '\n');
console.log('ibtrades.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
