// 生成 event-rules.json:重要事件的判定(desktop/renderer-react/src/lib/eventRules.ts)对一组输入现算的结果,
// C++ 的 shell/event_rules 逐条对。每条 = { fn, args, out };时区一律写明(Asia/Shanghai 与 America/New_York),不跟跑的机器走。
//   node native/tests/fixtures/gen_event_rules.mjs      (Node ≥ 23 直接跑 .ts)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const R = await import(join(repo, 'desktop/renderer-react/src/lib/eventRules.ts'));

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-10-14 08:30 美东(夏令时,= 12:30Z)公布的 CPI;2026-11-02 08:30(冬令时,= 13:30Z)换时那一周也测
const CPI_AT = Date.UTC(2026, 9, 14, 12, 30);
const NOV_AT = Date.UTC(2026, 10, 2, 13, 30);
const ev = (o) => ({ id: 'e', kind: 'econ', title: 'CPI(9月)', at: CPI_AT, date_et: '2026-10-14', time_et: '08:30', impact: 'high', stars: 5, source: 'builtin', linger_min: 120, ...o });
const cpi = ev({ id: 'cpi', items: [{ title: 'CPI 月率', forecast: '0.3%', previous: '0.4%' }, { title: '核心 CPI 年率', forecast: '', previous: '3.1%' }, { title: '没数的', forecast: '', previous: '' }], note: '指数常跳空' });
const fomc = ev({ id: 'fomc', title: 'FOMC 利率决议', at: CPI_AT + 5.5 * HOUR, time_et: '14:00', stars: 4.6 });
const claims = ev({ id: 'claims', title: '初请失业金', impact: 'medium', stars: 3, at: CPI_AT, linger_min: 60 });
const tomorrow = ev({ id: 'ppi', title: 'PPI', at: CPI_AT + 24 * HOUR, date_et: '2026-10-15', stars: undefined });
const farMed = ev({ id: 'far', title: '远的中等', impact: 'medium', at: CPI_AT + 30 * HOUR, date_et: '2026-10-15' });
const cross = ev({ id: 'x1', kind: 'cross', title: '美股 −2.5%,韩股 ETF 没跟跌', at: CPI_AT + 60 * HOUR, date_et: '2026-10-16', linger_min: 600,
  cross: { direction: 'down', us_pct: -2.5, markets: [{ key: 'kr', name: '韩股', symbol: 'EWY', etf_pct: -0.4, gap: 2.1, open_at: CPI_AT + 61 * HOUR, instruments: [{ symbol: 'KORU', change_pct: -1.2, last: 10.5 }] }] } });
const nov = ev({ id: 'nov', at: NOV_AT, date_et: '2026-11-02' });
const custom = ev({ id: 'c1', source: 'custom', title: 'CRWV 发债', impact: 'high', stars: 0, at: CPI_AT + 2 * 24 * HOUR + 3 * HOUR, date_et: '2026-10-16', time_et: '11:30' });

const cases = [];
const add = (fn, args, out) => cases.push({ fn, args, out: out === undefined ? null : out });

for (const s of [undefined, 0, 0.4, 1, 2.5, 3.49, 4.6, 5, 9, -1]) add('starText', [s ?? null], R.starText(s));
const offsets = [-26 * HOUR, -19 * HOUR, -2 * HOUR, -61 * MIN, -60 * MIN, -59.5 * MIN, -30 * MIN, -1, 0, 1, 14 * MIN, 15 * MIN, 16.5 * MIN, 119 * MIN, 120 * MIN, 3 * HOUR];
for (const e of [cpi, claims, tomorrow, custom]) for (const d of offsets) {
  const now = e.at + d;
  add('phaseOf', [e, now], R.phaseOf(e, now));
  add('countdownText', [e, now], R.countdownText(e, now));
}
for (const d of [-3 * 24 * HOUR - 2 * HOUR, -50 * HOUR, -25 * HOUR, -23 * HOUR, -5 * HOUR, 0, 7 * HOUR, 20 * HOUR, 30 * HOUR, 6 * 24 * HOUR, 8 * 24 * HOUR]) {
  for (const tz of ['Asia/Shanghai', 'America/New_York']) add('whenText', [CPI_AT, CPI_AT + d, tz], R.whenText(CPI_AT, CPI_AT + d, tz));
}
for (const t of [CPI_AT, CPI_AT - 13 * HOUR, NOV_AT, NOV_AT + 11 * HOUR, Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 2, 8, 7, 1)]) add('etDateOf', [t], R.etDateOf(t));
const all = [farMed, fomc, cpi, claims, tomorrow, cross, nov, custom];
for (const d of [-20 * HOUR, -10 * HOUR, -2 * HOUR, -45 * MIN, 0, 30 * MIN, 3 * HOUR, 7 * HOUR, 20 * HOUR, 40 * HOUR, 70 * HOUR]) {
  const now = CPI_AT + d;
  const p = R.pinnedEvents(all, now);
  add('pinnedEvents', [all, now], { ids: p.events.map((e) => e.id), more: p.more });
}
const leadsSets = [[30, 10], [10, 30, 10, 0, -5], []];
for (const leads of leadsSets) for (const d of [-31 * MIN, -30 * MIN, -29 * MIN, -28.4 * MIN, -10 * MIN, -9 * MIN, 0, 1 * MIN, 1.6 * MIN]) {
  const now = CPI_AT + d;
  const fired = d === -9 * MIN ? ['cpi:10'] : [];
  add('leadsDue', [[cpi, claims, fomc], now, leads, fired], R.leadsDue([cpi, claims, fomc], now, leads, new Set(fired)).map((x) => ({ key: x.key, lead: x.lead, id: x.event.id })));
}
for (const lead of [0, 10, 30]) for (const e of [cpi, claims, ev({ id: 'bare', items: undefined, note: undefined })]) {
  add('leadTitle', [e, lead], R.leadTitle(e, lead));
  add('leadBody', [e, lead, CPI_AT - lead * MIN, 'Asia/Shanghai'], R.leadBody(e, lead, CPI_AT - lead * MIN, 'Asia/Shanghai'));
}
const now0 = Date.UTC(2026, 9, 14, 15, 0);
const stocks = [
  { symbol: 'NVDA', change_pct: -3.2, at: '2026-10-14T14:59:00.000Z' },
  { symbol: 'AMD', change_pct: -2.1, at: '2026-10-14T14:58:30Z' },
  { symbol: 'OLD', change_pct: -9, at: '2026-10-14T14:50:00.000Z' },
  { symbol: 'FUT', change_pct: 1, at: '2026-10-14T15:02:00.000Z' },
  { symbol: 'NEAR', change_pct: 1.5, at: '2026-10-14T15:00:59.000Z' },
  { symbol: 'NUL', change_pct: null, at: '2026-10-14T14:59:00.000Z' },
  { symbol: 'NOAT', change_pct: 2, at: null },
  { symbol: 'BAD', change_pct: 2, at: 'not a date' },
  { symbol: 'EDGE', change_pct: 0, at: '2026-10-14T14:57:00.000Z' },
];
add('freshChanges', [stocks, now0, 180000], R.freshChanges(stocks, now0));
add('freshChanges', [stocks, now0, 20 * MIN], R.freshChanges(stocks, now0, 20 * MIN));
const sectors = [
  { name: '半导体', symbols: ['NVDA', 'AMD', 'AVGO', 'MU', 'NVDA', 'TSM'] },
  { name: '数据中心', symbols: ['CRWV', 'NBIS', 'ORCL', 'SMCI'] },
  { name: '少', symbols: ['A', 'B'] },
  { name: '平', symbols: ['P1', 'P2', 'P3', 'P4'] },
  { name: '涨', symbols: ['U1', 'U2', 'U3', 'U4', 'U5'] },
];
const changes = { NVDA: -3.2, AMD: -2.5, AVGO: -2.0, MU: -1.1, TSM: null, CRWV: -12.4, NBIS: -4.4, ORCL: -2.05, SMCI: 0.3, A: -5, B: -5, P1: 2, P2: -2, P3: 2, P4: -2, U1: 2.2, U2: 3.1, U3: 2.0, U4: -0.5, U5: 1.999 };
for (const rule of [{ min_stocks: 3, share: 0.6, move_pct: 2 }, { min_stocks: 2, share: 0.5, move_pct: 2 }, { min_stocks: 4, share: 0.75, move_pct: 1 }]) {
  const out = R.sectorMoves(sectors, changes, rule);
  add('sectorMoves', [sectors, changes, rule], out);
  for (const m of out) {
    add('sectorMoveTitle', [m], R.sectorMoveTitle(m));
    add('sectorMoveBody', [m, rule.move_pct], R.sectorMoveBody(m, rule.move_pct));
  }
}
// 盘前拉涨:09:30 前后、夏令时与冬令时;标题与正文三种说法;中位;回吐判定
for (const t of [Date.UTC(2026, 9, 22, 13, 25), Date.UTC(2026, 9, 22, 13, 29, 59), Date.UTC(2026, 9, 22, 13, 30), Date.UTC(2026, 10, 3, 14, 29), Date.UTC(2026, 10, 3, 14, 30), Date.UTC(2026, 9, 22, 3, 59)]) {
  add('etMinuteOf', [t], R.etMinuteOf(t));
  add('isPremarket', [t], R.isPremarket(t));
}
const upMove = { sector: '数据中心', direction: 'up', count: 4, total: 5, median: 4.25, movers: [{ symbol: 'CRWV', pct: 6.15 }, { symbol: 'IREN', pct: 4.4 }] };
const downMove = { ...upMove, direction: 'down', median: -3.05, movers: [{ symbol: 'CRWV', pct: -12.4 }] };
for (const m of [upMove, downMove]) for (const pre of [false, true]) {
  add('sectorMoveTitle', [m, pre], R.sectorMoveTitle(m, pre));
  add('sectorMoveBody', [m, 3, pre], R.sectorMoveBody(m, 3, pre));
}
const medChanges = { A: 1, B: 3, C: null, D: 2.555, E: -0.004 };
for (const [syms, min] of [[['A', 'B', 'C'], 1], [['A', 'B', 'C'], 3], [['A', 'B', 'D', 'A'], 1], [['E'], 1], [[], 0], [['C'], 1], [['A', 'D', 'E', 'B'], 2]]) add('sectorMedian', [syms, medChanges, min], R.sectorMedian(syms, medChanges, min));
for (const [pre, now] of [[4.2, 2.1], [4.2, 2.11], [4.2, -0.5], [3, 3.5], [2.0, 0]]) {
  const v = R.fadeVerdict(pre, now);
  add('fadeVerdict', [pre, now], v);
  add('fadeTitle', ['数据中心', v], R.fadeTitle('数据中心', v));
  add('fadeBody', [pre, now, v], R.fadeBody(pre, now, v));
}
// 时段提醒:两边夏令时、欧洲先退的那一周(10-25 ~ 11-01)、两边冬令时、春天美国先进的那几周;窗口边上、报过的、周末、美股不开
const stamps = [
  Date.UTC(2026, 9, 22, 7, 0, 10), Date.UTC(2026, 9, 22, 6, 59, 59), Date.UTC(2026, 9, 22, 7, 1, 29), Date.UTC(2026, 9, 22, 7, 1, 30),
  Date.UTC(2026, 9, 27, 7, 0, 10), Date.UTC(2026, 9, 27, 8, 0, 10), Date.UTC(2026, 10, 3, 8, 0, 10),
  Date.UTC(2026, 9, 22, 13, 25, 30), Date.UTC(2026, 9, 22, 15, 30), Date.UTC(2026, 9, 27, 16, 30), Date.UTC(2026, 9, 22, 19, 0), Date.UTC(2026, 10, 3, 20, 0),
  Date.UTC(2026, 9, 24, 7, 0, 10), Date.UTC(2026, 9, 25, 13, 25), Date.UTC(2027, 2, 16, 7, 0, 10), Date.UTC(2027, 2, 16, 8, 0, 10),
];
for (const t of stamps) {
  add('londonNyGap', [t], R.londonNyGap(t));
  for (const usOpen of [true, false]) add('sessionMarksDue', [t, [], usOpen], R.sessionMarksDue(t, new Set(), usOpen).map((d) => ({ key: d.key, id: d.mark.id })));
  for (const d of R.sessionMarksDue(t, new Set(), true)) {
    add('sessionMarksDue', [t, [d.key], true], R.sessionMarksDue(t, new Set([d.key]), true).map((x) => ({ key: x.key, id: x.mark.id })));
    add('sessionMarkBody', [d.mark.id, t], R.sessionMarkBody(d.mark, t));
  }
}
for (const [sym, spot] of [['SPX', 7712], ['spx', 3], ['AAPL', 230], ['XLF', 50], ['XLF', 25], ['F', 12], ['NDX', 20000]]) add('strikeStep', [sym, spot], R.strikeStep(sym, spot));
const base = { symbol: 'SPX', spot: 7712.4, kind: 'put_spread', width: 25, qty: 1, expiry: '2026-10-14', todayEt: '2026-10-14', reason: 'CPI 前对冲' };
const specs = [
  base, { ...base, kind: 'bear_call' }, { ...base, kind: 'bear_call', spot: 7715 }, { ...base, kind: 'bear_call', qty: 2 },
  { ...base, kind: 'bear_call', expiry: '2026-10-15' }, { ...base, qty: 3, expiry: '2026-10-16', reason: '  ' },
  { ...base, symbol: ' aapl ', spot: 231.37, width: 5 }, { ...base, symbol: 'F', spot: 12.26, width: 1.5 }, { ...base, symbol: 'XLF', spot: 49.99, width: 2, kind: 'bear_call' },
  { ...base, symbol: '' }, { ...base, spot: null }, { ...base, spot: 0 }, { ...base, width: 0 }, { ...base, qty: 1.5 }, { ...base, qty: 0 },
  { ...base, expiry: '2026-1-14' }, { ...base, expiry: '2026-10-13' }, { ...base, width: 8000 },
  { ...base, kind: 'short_stock', symbol: 'koru', qty: 100, price: 10.456, outside: true, reason: '跟跌' },
  { ...base, kind: 'short_stock', symbol: 'EWY', qty: 50, price: 61, outside: false, reason: '' },
  { ...base, kind: 'short_stock', symbol: 'EWY', qty: 50, price: null }, { ...base, kind: 'short_stock', symbol: 'EWY', qty: 0.5, price: 3 },
  { ...base, kind: 'short_stock', symbol: 'EWY', qty: 10, price: 0 },
];
for (const s of specs) add('hedgeInstruction', [s], R.hedgeInstruction(s));
for (const [d, t] of [['2026-10-15', '2026-10-14'], ['2026-10-14', '2026-10-14'], ['2026-10-13', '2026-10-14']]) add('hedgeExpiryFor', [{ date_et: d }, t], R.hedgeExpiryFor({ date_et: d }, t));

writeFileSync(join(here, 'event-rules.json'), JSON.stringify({ generator: 'gen_event_rules.mjs', cases }, null, 1) + '\n');
console.log(`event-rules.json: ${cases.length} cases`);
