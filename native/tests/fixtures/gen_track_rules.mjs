// 生成 track-rules.json:持仓追踪页的纯逻辑现算的结果,C++ 的 shell/track_rules 逐条对。
//   lib/format.ts(数与时间的写法)、lib/spotStopFormat.ts(标的止损的三句话)、lib/trackExitForm.ts(出场细则:表单 → 载荷、
//   界面这头查出的毛病、确认框里的话、卡片上的摘要)、lib/labels.ts 的 TRACK_STATE_LABEL、lib/TrackCard.tsx 的 legLabel
//   (.tsx 里有 JSX,node 读不了:把那一个函数的源码切出来、去掉类型再求值)。本机时区相关的按 Asia/Shanghai:
//   TZ=Asia/Shanghai [DESKTOP_MODULES=<装好依赖的 desktop/node_modules>] node native/tests/fixtures/gen_track_rules.mjs
// format.ts 引 dayjs:项目在 iCloud 上时 node_modules 常被收走,DESKTOP_MODULES 指一份没被收走的(同 tools/gen_icons.mjs)
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('要 TZ=Asia/Shanghai');
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', 'desktop/renderer-react/src/lib');
if (process.env.DESKTOP_MODULES) {
  const dayjs = pathToFileURL(join(process.env.DESKTOP_MODULES, 'dayjs/dayjs.min.js')).href;
  registerHooks({ resolve: (spec, ctx, next) => (spec === 'dayjs' ? { url: dayjs, shortCircuit: true } : next(spec, ctx)) });
}
const F = await import(join(src, 'format.ts'));
const S = await import(join(src, 'spotStopFormat.ts'));
const X = await import(join(src, 'trackExitForm.ts'));
const L = await import(join(src, 'labels.ts'));
const card = readFileSync(join(src, 'TrackCard.tsx'), 'utf8');
const start = card.indexOf('export function legLabel(');
const body = card.slice(start, card.indexOf('\n}\n', start) + 2)
  .replace('export function legLabel(symbol: string, secType: string, contract?: Record<string, unknown>): string {', 'function legLabel(symbol, secType, contract) {');
if (body.includes(': ')) { /* 剩下的冒号只在模板与三元里 */ }
const legLabel = new Function(`${body}; return legLabel;`)();

const cases = [];
// JSON 里没有 undefined:入参与结果里的 undefined 写成 '__undefined__'(fmtNum(null) 是 0.00,fmtNum(undefined) 是 —)
const U = (v) => (v === undefined ? '__undefined__' : v);
const add = (fn, args, out) => cases.push({ fn, args: args.map(U), out: U(out) });

// ---- format
for (const v of [1.005, 0.05, '12.5', null, undefined, 'x', -0.004, 1e21, 7712.4]) add('fmtNum', [v, 2], F.fmtNum(v));
for (const [v, d] of [[0.05, 4], [3, 0], [2.5, 0]]) add('fmtNum', [v, d], F.fmtNum(v, d));
for (const v of [1234567.891, 0, -12.345, '99.995', null, undefined, 'abc', 1e21, 0.005, -0.004, -0.001]) add('fmtMoney', [v], F.fmtMoney(v));
for (const v of ['20261120', ' 20261120 ', '202611', '', null, 20261120]) add('fmtExpiry', [v], F.fmtExpiry(v));

// ---- 标的止损
for (const [b, a] of [[7700, 7790], [7700.5, null], [null, 7790.256], [null, null], [7700.004, undefined]]) {
  add('spotStopSummary', [b, a], S.spotStopSummary(b, a));
  add('spotStopConfirmLine', [b, a], S.spotStopConfirmLine('SPX', b, a));
}
for (const row of [
  { below: 7700, above: 7790, spot: 7712.456 }, { below: 7700, above: null, spot: 7695.5, spot_note: '盘外按 ES 推算' },
  { below: null, above: 7790, spot: null }, { below: 7700, above: null, spot: null, reason: '标的行情断了' },
  { below: 7700, above: 7790, spot: 7698, pending: { side: 'below', held_s: 4, need_s: 10 } },
  { below: 7700, above: 7790, spot: 7792, pending: { side: 'above', held_s: 1, need_s: 3 } },
]) add('spotStopLine', [row], S.spotStopLine('SPX', row));

// ---- 出场细则
const E = X.emptyExitFields;
const forms = [
  E,
  { ...E, exitAt: ' 15:45 ', stopConfirm: 10, stopBasis: 'natural', chaseGrace: 3, chaseStep: 2, chaseMax: 40, peakConfirm: true,
    tiers: [{ price: 7.5, fraction: 50 }, { price: 9, fraction: 25 }, { price: null, fraction: 10 }] },
  { ...E, exitAt: '9:5', tiers: [{ price: 1.2, fraction: null }] },
  { ...E, exitAt: '24:00', stopConfirm: 0, chaseStep: 1 },
  { ...E, stopConfirm: 5, chaseMax: 25.5 },
  { ...E, tiers: [{ price: 0.05, fraction: 100 }], stopConfirm: 3 },
  { ...E, chaseGrace: 0 },
];
for (const f of forms) {
  for (const d of [true, false]) {
    add('exitSpec', [f, d], X.exitSpec(f, d));
    add('exitConfirmLines', [f, d], X.exitConfirmLines(f, d));
  }
  for (const opts of [{ hosted: false, hasSpotStop: false }, { hosted: true, hasSpotStop: true }, { hosted: false, hasSpotStop: false, stock: true, hasStockStop: false },
    { hosted: true, hasSpotStop: false, stock: true, hasStockStop: true }, { hosted: false, hasSpotStop: true, stock: true, hasStockStop: true }])
    add('exitProblems', [f, opts], X.exitProblems(f, opts));
}
for (const [t, i] of [[{ price: 7.5, fraction_pct: 50, done: true }, 0], [{ price: 1.23456, fraction_pct: 33.3333, pending: true }, 1], [{ price: 9, fraction_pct: 25 }, 3]])
  add('tierLabel', [t, i], X.tierLabel(t, i));
for (const ms of [Date.UTC(2026, 9, 19, 19, 45), Date.UTC(2026, 10, 2, 4, 30), Date.UTC(2026, 2, 8, 6, 59)]) add('exitMoment', [ms], X.exitMoment(ms));
for (const [t, a, stock] of [
  [{}, {}, false],
  [{ exit_at: '15:45', exit_at_ms: Date.UTC(2026, 9, 19, 19, 45), take_profit_tiers: [{ price: 1, fraction_pct: 50, done: true }, { price: 2, fraction_pct: 50 }], spot_stop_confirm_s: 10 },
    { stop_basis: 'natural', peak_confirm: true, stop_chase_grace: null, stop_chase_step: 3, stop_chase_max_pct: null }, false],
  [{ exit_at: '15:45', exit_at_ms: null, spot_stop_confirm_s: 5 }, { stop_basis: 'mid', stop_chase_max_pct: 30 }, true],
  [{ spot_stop_confirm_s: 0, take_profit_tiers: [] }, { stop_chase_grace: 4 }, false],
]) add('exitSummary', [t, a, stock], X.exitSummary(t, a, stock));

// ---- 腿的写法
for (const [sym, sec, c] of [['SPX', 'BAG', { label: '7700/7725/7750 看涨蝶' }], ['SPX', 'BAG', {}], ['NVDA', 'STK', {}], ['SPX', 'OPT', { lastTradeDateOrContractMonth: '20261120', strike: 7700, right: 'C' }],
  ['ES', 'FOP', { lastTradeDateOrContractMonth: '202612', strike: '7700.50', right: 'put' }], ['SPX', 'OPT', {}], ['SPX', 'OPT', { strike: 0, right: '' }]])
  add('legLabel', [sym, sec, c], legLabel(sym, sec, c));

writeFileSync(join(here, 'track-rules.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_track_rules.mjs', tz: 'Asia/Shanghai', maxTiers: X.MAX_TIERS,
  emptyExitFields: X.emptyExitFields, trackStateLabel: L.TRACK_STATE_LABEL, cases }, null, 2) + '\n');
console.log(`track-rules.json: ${cases.length} cases`);
