// 生成 exec-quality.json:engine-ts 的 execQuality.ts(原模块现跑)。平仓痕随机拼:老痕没有 mark、找不到单、组合的腿行与 BAG 行、
// 成交行缺、数量写在 quantity / totalQuantity、成交价与佣金是串 / 空串 / null、方向小写与乱写、模拟盘、时间窗、品种过滤。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_exec_quality.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/execQuality.js')).href);

let seed = 0x3e9c_51a2;
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

const record = () => {
  if (rnd() < 0.08) return null;
  const sec = pick(['STK', 'BAG', 'OPT', 'FOP', '', undefined]);
  const r = {};
  if (rnd() < 0.95) r.contract = rnd() < 0.05 ? pick([null, 'x']) : { secType: sec, multiplier: pick([undefined, 100, '100', 50, '', null, 'x']) };
  if (rnd() < 0.95) r.order = { action: pick(['SELL', 'BUY', 'sell', 'Buy', 'HOLD', '', undefined]), quantity: pick([undefined, 2, '3', '', null]), totalQuantity: pick([undefined, 1, 5, '2']) };
  if (rnd() < 0.9) r.account = { is_paper: pick([true, false, 0, 1, 'yes', undefined]) };
  if (rnd() < 0.95) {
    const fills = rnd() < 0.15 ? pick([undefined, null, []]) : Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ qty: pick([1, 2, '1', '', null, 'x', -1]), sec_type: pick(['BAG', 'OPT', sec, undefined]) }));
    r.ibkr = { avg_fill_price: pick([2.35, '2.4', 0, -1, '', null, 'x', 105.5, 0.85]), total_commission: pick([1.3, '2.1', null, '', undefined, 0]), fills };
  }
  return r;
};
const days = ['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-15', '2026-10-18', '2026-09-20', 'bad'];
const trace = () => ({
  at: `${pick(days)}T${String(10 + Math.floor(rnd() * 6)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00Z`,
  path: pick(['auto_close', 'hosted_sweep']), symbol: pick(['SPX', 'AAPL', 'QQQ']), state: pick(['take_profit', 'stop_loss', 'time_exit']),
  mark: pick([null, 2.5, 2.4, 0, -1, 105, 0.9, 3.1]), record: record(),
});
const out = { rows: [], costs: [] };
for (let i = 0; i < 600; i += 1) { const t = trace(); out.rows.push({ trace: enc(t), ...run(() => X.executionRow(t)) }); }
out.rows.push({ trace: enc({ at: 'x', path: 'auto_close', symbol: 'S', state: 's', mark: 2, record: { contract: { secType: 'BAG' }, order: { action: 'SELL' }, ibkr: { avg_fill_price: 2, fills: [null] } } }),
  ...run(() => X.executionRow({ at: 'x', path: 'auto_close', symbol: 'S', state: 's', mark: 2, record: { contract: { secType: 'BAG' }, order: { action: 'SELL' }, ibkr: { avg_fill_price: 2, fills: [null] } } })) });
out.rows.push({ trace: enc({ at: 'x', path: 'auto_close', symbol: 'S', state: 's', mark: 2, record: { contract: { secType: 'OPT' }, order: { action: 'SELL' }, ibkr: { avg_fill_price: 2, fills: { a: 1 } } } }),
  ...run(() => X.executionRow({ at: 'x', path: 'auto_close', symbol: 'S', state: 's', mark: 2, record: { contract: { secType: 'OPT' }, order: { action: 'SELL' }, ibkr: { avg_fill_price: 2, fills: { a: 1 } } } })) });
const now = Date.parse('2026-10-19T00:00:00Z');
for (let i = 0; i < 200; i += 1) {
  const traces = Array.from({ length: Math.floor(rnd() * (rnd() < 0.1 ? 80 : 20)) }, trace).filter((t) => {
    // 抛错的痕(成交行是 null)不放进汇总,汇总那一步不该抛
    const f = t.record?.ibkr?.fills; return !Array.isArray(f) || f.every((x) => x !== null);
  });
  const opts = { scope: pick(['all', 'live', 'paper']), kind: pick(['all', 'stock', 'butterfly', 'option']), days: pick([null, 7, 30, 0.5]), now };
  out.costs.push({ traces: enc(traces), opts, ...run(() => X.executionCost(traces, opts)) });
}
// 多半能算出来的痕:一组里 6 笔以上(中位数有区间)、合计超过 50 行(明细截断)、正好落在时间窗边上的那一笔
const good = (sec, i) => ({
  at: new Date(now - (i + 1) * 3_600_000).toISOString(), path: 'auto_close', symbol: 'SPX', state: 'take_profit', mark: 2 + (i % 7) * 0.1,
  record: { contract: { secType: sec, multiplier: sec === 'STK' ? 1 : 100 }, order: { action: i % 3 ? 'SELL' : 'BUY', quantity: 1 + (i % 3) },
    account: { is_paper: i % 4 === 0 }, ibkr: { avg_fill_price: 2 + ((i * 7) % 11) * 0.05, total_commission: i % 5 ? 1.3 : null, fills: [{ qty: 1 + (i % 3), sec_type: sec }] } },
});
for (const [n, secs, days] of [[8, ['BAG'], null], [30, ['BAG', 'OPT'], null], [90, ['BAG', 'STK', 'OPT'], null], [20, ['OPT'], 10 / 24], [7, ['STK'], 5 / 24]]) {
  const traces = Array.from({ length: n }, (_, i) => good(secs[i % secs.length], i));
  const opts = { scope: 'all', kind: 'all', days, now };
  out.costs.push({ traces: enc(traces), opts, ...run(() => X.executionCost(traces, opts)) });
}
writeFileSync(join(here, 'exec-quality.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('exec-quality.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
