// 生成 intel-items.json:engine-ts 的 intelItems.ts(原模块现跑)。消息(有无下场、各种下场、提到时的价有无、此刻的价有无 / 为 0 / 为 null、
// 信任与否、显示名为空)、信号(有无 seq、各来源、方向、价为 null / 缺)、事件(将公布 / 已公布、24 小时内、带预期前值、备注)、
// 单子(各种状态、成交、跟单、标题回落)、想法(状态、标的大小写去重、长文截断),以及按标的 / 种类 / 持仓 / 时刻筛、去重、排序、截断的合并。
// 时刻不带时区的按本机读:要 TZ=Asia/Shanghai。
//   TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_intel_items.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('要 TZ=Asia/Shanghai 跑');
const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const I = await import(pathToFileURL(join(engine, 'dist/src/intelItems.js')).href);

let seed = 0x1a7e_1100;
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
const maybe = (o, k, p = 0.1) => { if (rnd() < p) delete o[k]; return o; };

const syms = ['SPX', 'NVDA', 'AAPL', 'TSLA', 'QQQ'];
const times = ['2026-10-14T13:30:00.000Z', '2026-10-14T21:30:05Z', '2026-10-14T08:30:00', '2026-10-14', 'Oct 14 2026 10:00', '', 'bogus', null, undefined, '2026-10-13T23:59:59.999Z'];
const heldSets = [[], ['NVDA'], ['SPX', 'AAPL'], ['nvda', 'TSLA', 'QQQ']];
const nows = [{}, { NVDA: 140 }, { NVDA: null, SPX: 6700.5 }, { NVDA: 0, AAPL: 230, SPX: 6650 }, { TSLA: -1, SPX: '6700' }];
const out = { labels: { outcome: [], signal: [] }, messages: [], signals: [], events: [], records: [], ideas: [], merges: [] };
for (const o of ['sent', 'held', 'observed', 'stale', 'unparsed', 'capped', 'blocked', 'rejected', 'x']) out.labels.outcome.push({ k: o, out: enc(I.outcomeLabel(o)) });
for (const s of ['cross', 'touch', 'spike', 'day_move', 'rvol', 'burst', 'leaders', 'pa', 'x', '']) out.labels.signal.push({ k: s, out: enc(I.signalLabel(s)) });

const all = [];
for (let i = 0; i < 500; i += 1) {
  const symbols = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(syms));
  const prices = {};
  for (const s of symbols) if (rnd() < 0.7) prices[s] = pick([140, 0, -3, 6700.25, '140', null, 230.5]);
  const row = maybe({ seq: i, at: pick(times), source: 'discord', message_id: `m${i % 400}`, author_id: pick(['u1', '', 'u2']), author_name: pick(['Charlie', '', 'Bob']),
    text: pick(['SPX 7700 蝴蝶', '', 'NVDA calls', '长'.repeat(5)]), symbols, guesses: rnd() < 0.3 ? ['XYZ'] : [], trusted: pick([true, false]), prices }, 'trusted');
  if (rnd() < 0.05) delete row.author_name;
  const verdict = rnd() < 0.4 ? null : { outcome: pick(['sent', 'held', 'observed', 'stale', 'unparsed', 'capped', 'blocked', 'rejected', 'weird']), detail: pick(['ok', '', '超了']), summary: 's' };
  const held = pick(heldSets), now = pick(nows), instruction = pick([null, '', 'buy 1 SPX 7700/7725 bear call']);
  const r = run(() => I.messageItem(row, verdict, new Set(held), new Map(Object.entries(now)), instruction));
  out.messages.push({ row: enc(row), verdict, held, now, instruction, ...r });
  if (r.out) all.push(r.out);
}
out.messages.push({ row: { message_id: 'z', symbols: ['NVDA'], guesses: [] }, verdict: null, held: [], now: {}, instruction: null,
  ...run(() => I.messageItem({ message_id: 'z', symbols: ['NVDA'], guesses: [] }, null, new Set(), new Map(), null)) });
for (let i = 0; i < 300; i += 1) {
  const e = maybe(maybe({ seq: rnd() < 0.3 ? undefined : pick([i, 0, null]), at: pick(times), source: pick(['cross', 'touch', 'spike', 'day_move', 'rvol', 'burst', 'leaders', 'pa', 'weird']),
    symbol: pick(syms), label: pick(['', '上穿 7700', null]), variant: pick(['', 'MA20', null, undefined]), expect: pick(['up', 'down', null, 'flat']), price: pick([null, 7700, 12.5, undefined]) }, 'seq', 0.2), 'symbol', 0.03);
  if (e.seq === undefined) delete e.seq;
  const held = pick(heldSets);
  const r = run(() => I.signalItem(e, new Set(held)));
  out.signals.push({ e: enc(e), held, ...r });
  if (r.out) all.push(r.out);
}
const nowMs = Date.parse('2026-10-14T12:00:00Z');
for (let i = 0; i < 200; i += 1) {
  const at = nowMs + pick([-3600_000, 0, 1, 3600_000, 23.9 * 3600_000, 24 * 3600_000, 30 * 3600_000, -86_400_000 * 3]);
  const ev = maybe(maybe({ id: `feed:cpi:${i}`, kind: pick(['cpi', 'fomc', 'custom', 'cross']), title: pick(['CPI(9月)', 'FOMC 利率决议', '发债']), at, date_et: '2026-10-14', time_et: '08:30',
    stars: 5, impact: pick(['high', 'medium']), source: 'feed', linger_min: 90,
    items: pick([[], [{ title: 'a', forecast: '', previous: '' }, { title: 'b', forecast: '0.3%', previous: '' }], [{ title: 'c', forecast: '', previous: '0.4%' }]]),
    note: pick(['', '备注', undefined]) }, 'items', 0.3), 'note', 0.3);
  if (ev.note === undefined) delete ev.note;
  const symbols = pick([[], ['SPX'], ['SPX', 'NVDA']]), held = pick(heldSets);
  const r = run(() => I.eventItem(ev, symbols, new Set(held), nowMs));
  out.events.push({ ev: enc(ev), symbols, held, nowMs, ...r });
  if (r.out) all.push(r.out);
}
for (let i = 0; i < 300; i += 1) {
  const rec = maybe({ id: `r${i % 250}`, created_at: pick(times), symbol: pick(syms), action: pick(['BUY', 'SELL']), quantity: 1, account: pick(['main', 'ira']),
    intent_summary: pick(['', '买 1 张 SPX 蝶']), raw_instruction: pick(['', 'buy spx fly']),
    final_status: pick([null, 'filled', 'partially_filled', 'cancelled', 'rejected_by_llm', 'weird_status', '']), last_status: pick([null, 'Submitted', '']),
    fills: pick([0, 1, 3]), avg_fill_price: pick([null, 2.35, 0]), channel: pick(['manual', 'discord']) }, 'final_status', 0.05);
  const held = pick(heldSets);
  const r = run(() => I.recordItem(rec, new Set(held)));
  out.records.push({ rec: enc(rec), held, ...r });
  if (r.out) all.push(r.out);
}
for (let i = 0; i < 200; i += 1) {
  const idea = { id: `i${i}`, created_at: pick(times), text: pick(['想法', 'x'.repeat(170), '长'.repeat(200) + '😀', '😀'.repeat(81)]), status: pick(['open', 'done', 'archived', 'weird']),
    symbols: Array.from({ length: Math.floor(rnd() * 3) }, () => pick(['spx', 'NVDA', 'nvda', 'Aapl'])) };
  const symbols = pick([[], ['NVDA'], ['SPX', 'TSLA']]), held = pick(heldSets);
  const r = run(() => I.ideaItem(idea, symbols, new Set(held)));
  out.ideas.push({ idea, symbols, held, ...r });
  if (r.out) all.push(r.out);
}
for (let i = 0; i < 300; i += 1) {
  const groups = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Array.from({ length: Math.floor(rnd() * 14) }, () => pick(all)));
  const filter = { symbol: pick([undefined, null, '', 'nvda', 'SPX', 'XYZ']), kinds: pick([undefined, null, [], ['message'], ['signal', 'order'], ['idea', 'event', 'message']]),
    heldOnly: pick([undefined, false, true]), since: pick([undefined, null, 0, nowMs, nowMs + 3600_000 * 10]), limit: pick([1, 5, 20, 1000, 0, -3, 2.7, NaN, Infinity]) };
  for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
  out.merges.push({ groups, filter: enc(filter), ...run(() => I.mergeItems(groups, filter)) });
}
writeFileSync(join(here, 'intel-items.json'), JSON.stringify(out) + '\n');
console.log(`intel-items.json: ${all.length} 条, ${out.merges.length} 次合并`);
