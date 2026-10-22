// 生成 alert-rules.json:提醒的判断口径(desktop/renderer-react/src/lib/alertRules.ts)与持仓追踪的关键价位说法
// (lib/trackLevels.ts)现算的结果,C++ 的 shell/alert_rules、shell/track_levels 逐条对。
//   node native/tests/fixtures/gen_alert_rules.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', 'desktop/renderer-react/src/lib');
const A = await import(join(src, 'alertRules.ts'));
const T = await import(join(src, 'trackLevels.ts'));
const cases = [];
const add = (fn, args, out) => cases.push({ fn, args, out: out === undefined ? null : out });

for (const evs of [[], null, [{ kind: 'spike', direction: 'up' }], [{ kind: 'rvol', direction: 'up' }, { kind: 'burst', direction: 'down' }], [{ direction: 'down' }, { trigger: 'touch', direction: 'up' }],
  [{ direction: 'up' }, { direction: 'down' }], [{ kind: 'gap', direction: 'down' }, { kind: 'move', direction: 'down' }], [null, { direction: 'sideways' }, { kind: 5, direction: 'up' }]]) add('toneDirection', [evs], A.toneDirection(evs));
for (const [n, res] of [[0, { shown: 3 }], [3, undefined], [3, { shown: 0 }], [3, { shown: 2 }], [3, { shown: 2, dropped: 5 }], [3, { shown: 9, dropped: 1 }], [2.7, { shown: 1.9 }], [3, { shown: 'x', dropped: 1 }], [-1, {}], [3, { dropped: 1 }]])
  add('popupCounts', [n, res ?? null], A.popupCounts(n, res));
for (const [m, thr] of [[null, 3], [{ burst: null }, 3], [{ burst: 4, block_share: null, basis_volume: 'session_pace' }, 3], [{ burst: 6, block_share: 0.2, basis_volume: 'avg_volume' }, 3],
  [{ burst: 6, block_share: 0.6 }, 3], [{ burst: 4, block_share: 0.4 }, 3], [{ burst: 2, block_share: 0.1 }, 3], [{ burst: 2, block_share: 0.7 }, 3], [{ burst: 5, block_share: 0.3 }, null], [{ burst: 4.04, block_share: 0.25 }, 4]])
  add('burstVerdict', [m, thr], A.burstVerdict(m, thr));

const SHORT = { call_wall: 'C 墙', put_wall: 'P 墙', call_vol_wall: 'C 成交墙', put_vol_wall: 'P 成交墙', max_pain: '痛点', gamma_flip: 'γ 翻转', round: '关口', ma20: 'MA20', ma60: 'MA60', ma120: 'MA120', ma200: 'MA200', low_52w: '52周低', high_52w: '52周高' };
const L = (price, source, label = source) => ({ price, source, label, kind: 'pivot' });
const levels = [L(7700, 'put_wall', 'Put 墙'), L(7650, 'ma20', '20日线'), L(7800, 'call_wall', 'Call 墙'), L(7750, 'round', '整数关口'), L(7725, 'gamma_flip', 'Gamma'), L(0, 'round'), L(7712.4, 'max_pain', '痛点'), L(7690, 'weird', ''), L(7900, 'own:stop', '止损')];
for (const [sec, targets, live] of [['STK', { stop_loss: 210, take_profit: 240 }, null], ['STK', { stop_loss: 210, spot_target: 250 }, { stop_effective: 215.5, profit_trail_stop: 220 }], ['OPT', { spot_stop_below: 7700, spot_stop_above: 7790.5, spot_target: 7750, stop_loss: 2 }, {}], ['BAG', {}, null], ['STK', { stop_loss: -1, take_profit: 'x' }, { stop_effective: null }]])
  add('ownLines', [sec, targets, live], T.ownLines(sec, targets, live));
for (const spot of [7712.4, 7720, 7600, 7900]) {
  add('nearestLevels', [levels, spot], T.nearestLevels(levels, spot));
  add('levelSummary', [levels, spot], T.levelSummary(levels, spot, SHORT));
  for (const mode of ['stop', 'target']) for (const long of [true, false]) for (const deriv of [true, false]) add('pickSides', [levels, spot, mode, long, deriv], T.pickSides(levels, spot, mode, long, deriv));
  for (const line of [L(7690, 'own:stop', '止损'), L(7701, 'own:stop', '止损'), L(7710, 'own:stop', '止损'), L(7760, 'own:tp', '止盈'), L(7810, 'own:tp', '止盈'), L(7712.4, 'own:x', '线'), L(7300, 'own:s', '止损')])
    add('lineContext', [line, levels, spot], T.lineContext(line, levels, spot, SHORT));
}
// 「贴着」的边界:现价 7750 的 0.15% 是 11.625 点,两边各取一条刚好在里、刚好在外的线
const walls = [L(7700, 'put_wall', 'Put 墙'), L(7800, 'call_wall', 'Call 墙')];
for (const p of [7688.3, 7688.4, 7720, 7811.6, 7811.7, 7830]) add('lineContext', [L(p, 'own:stop', '止损'), walls, 7750], T.lineContext(L(p, 'own:stop', '止损'), walls, 7750, SHORT));
for (const v of [7700, 7790.5, 219.744, 0.1 + 0.2]) add('fmtLevel', [v], T.fmtLevel(v));
for (const v of [0.364, -0.29, 0, -0.004, 12.345]) add('fmtGap', [v], T.fmtGap(v));
const tracks = [
  { id: 'a', symbol: 'NVDA', sec_type: 'STK', enabled: true, fired_at: null, targets: { stop_loss: 170 } },
  { id: 'b', symbol: 'SPX', sec_type: 'BAG', enabled: true, fired_at: null, targets: { spot_stop_below: 7700, spot_stop_above: 7790 } },
  { id: 'c', symbol: 'SPX', sec_type: 'OPT', enabled: true, fired_at: null, targets: {} },
  { id: 'd', symbol: 'SPX', sec_type: 'BAG', enabled: false, fired_at: null, targets: { spot_stop_below: 1 } },
  { id: 'e', symbol: 'TSLA', sec_type: 'STK', enabled: true, fired_at: '2026-10-01', targets: { stop_loss: 1 } },
  { id: 'f', symbol: 'AAPL', sec_type: 'STK', enabled: true, fired_at: null, targets: {} },
  { id: 'g', symbol: 'SPX', sec_type: 'BAG', enabled: true, fired_at: null, targets: { spot_stop_below: 7700, spot_stop_above: 7790 } },
];
const rows = { a: { stop_effective: 172.5, price: 180 }, b: { spot_stop: { below: 7700, above: 7790, spot: 7695.25 } }, g: { spot_stop: { below: 7700, above: 7790, spot: 7695.25 } } };
for (const sym of ['NVDA', 'SPX', 'TSLA', 'AAPL', 'QQQ']) add('trackContext', [sym, tracks, rows], T.trackContext(sym, tracks, rows));
add('trackContext', ['NVDA', tracks, {}], T.trackContext('NVDA', tracks, {}));
writeFileSync(join(here, 'alert-rules.json'), JSON.stringify({ generator: 'gen_alert_rules.mjs', blockShareHeavy: A.BLOCK_SHARE_HEAVY, nearPct: T.NEAR_PCT, short: SHORT, cases }, null, 1) + '\n');
console.log(`alert-rules.json: ${cases.length} cases`);
