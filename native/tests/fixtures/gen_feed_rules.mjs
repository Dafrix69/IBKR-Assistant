// 生成 feed-rules.json:日内剧本的人话(desktop/renderer-react/src/lib/playbookFormat.ts)与信息链路的界面规则(lib/intelRules.ts)
// 现算的结果,C++ 的 shell/playbook_format、shell/intel_rules 逐条对。本机时区相关的几样(relTime、groupByDay)按 Asia/Shanghai 算:
//   TZ=Asia/Shanghai node native/tests/fixtures/gen_feed_rules.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('要 TZ=Asia/Shanghai');
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', 'desktop/renderer-react/src/lib');
const P = await import(join(src, 'playbookFormat.ts'));
const I = await import(join(src, 'intelRules.ts'));
const cases = [];
// 回落到 Date.now() 的那几处(没有时刻的消息):钉住"现在",生成的文件才每次一样
const withNow = (t, f) => { const real = Date.now; Date.now = () => t; try { return f(); } finally { Date.now = real; } };
const add = (fn, args, out) => cases.push({ fn, args, out: out === undefined ? null : out });

// ---- 日内剧本
for (const v of [7712.345, 7700, null, undefined, NaN, -0.004]) add('pb.fmtLevel', [v ?? null, v === undefined], P.fmtLevel(v));
for (const [t, p] of [[7725, 7712.4], [7700, 7712.45], [7700, 7700], [null, 1], [1, undefined]]) add('pb.fmtGap', [t, p ?? null], P.fmtGap(t, p));
const at = Date.UTC(2026, 9, 14, 14, 5); // 美东 10:05(夏令时)
for (const t of [at, Date.UTC(2026, 11, 1, 3, 59), null]) add('pb.etTime', [t], P.etTime(t));
const evs = [
  { kind: 'enter', state: 'B2', level: 7745.5, price: 7746.25, at }, { kind: 'enter', state: 'B3', level: 7650, price: 7649.1, at },
  { kind: 'exit', state: 'B2', level: 7745.5, price: 7744, at }, { kind: 'exit', state: 'B3', level: 7650, price: 7651, at },
  { kind: 'accel', state: 'B2', level: 7760, price: 7760, at }, { kind: 'accel', state: 'B3', level: 7630, price: 7629.75, at },
];
for (const e of evs) add('pb.event', [e], { tone: P.eventTone(e), title: P.eventTitle('SPX', e), body: P.eventBody(e) });
const snap = { frame_seconds: 300, bands: { prior: { lo: 1 }, open: null, current: { lo: 2 }, day: undefined } };
add('pb.bandRows', [snap], P.bandRows(snap));
add('pb.bandRows', [{ ...snap, frame_seconds: 89, bands: { ...snap.bands, day: { lo: 3 } } }], P.bandRows({ ...snap, frame_seconds: 89, bands: { ...snap.bands, day: { lo: 3 } } }));
for (const w of [{ regime: 'neutral', gross_gex: 5 }, { regime: 'neutral', gross_gex: 0 }, { regime: 'neutral' }, { regime: 'positive', has_greeks: false },
  { regime: 'positive', has_greeks: false, gross_gex: 3, net_gex_ratio: 0.1234 }, { regime: 'negative', gross_gex: 3, net_gex_ratio: -0.0005 },
  { regime: 'negative', gross_gex: null }, { regime: 'weird', gross_gex: 3 }, { regime: 'positive', gross_gex: 2, net_gex_ratio: null }])
  add('pb.gexText', [w], P.gexText(w));
for (const [c, oi] of [[{ lower: 7500, upper: 7900, strikes: 81, grid_strikes: 120, thinned: true }, 3], [{ lower: 7500, upper: 7900, strikes: 81, grid_strikes: null, thinned: true }, 0],
  [{ lower: 1, upper: 2, strikes: 2, grid_strikes: 9, thinned: false }, null], [null, 0]]) add('pb.coverageText', [c, oi], P.coverageText(c, oi));
for (const v of [7745.5, null]) add('pb.rearmText', [v], P.rearmText(v));

// ---- 信息链路
for (const it of [{ kind: 'signal', source: 'cross' }, { kind: 'event', source: 'fomc' }, { kind: 'message', source: 'Charlie' }, { kind: 'idea', source: 'zzz' }, { kind: 'order', source: '主账户' }])
  add('in.sourceLabel', [it], I.sourceLabel(it));
const now = Date.UTC(2026, 9, 18, 6, 0); // 北京 14:00
for (const d of [0, 59_000, -30_000, 60_000, 89_999, 90_000, 3599_000, -3600_000 * 2.5, 3600_000 * 23.6, 3600_000 * 24, 3600_000 * 24 * 40]) add('in.relTime', [now - d, now], I.relTime(now - d, now));
for (const m of [{ symbol: 'SPX', then: 7700, now: 7712.5, pct: 0.1623 }, { symbol: 'NVDA', then: 180.2, now: null, pct: null }, { symbol: 'X', then: 999.999, now: 1000, pct: -0.001 },
  { symbol: 'Y', then: 12, now: 11, pct: -8.333 }, { symbol: 'Z', then: 1234.05, now: 1234.04, pct: 0 }, { symbol: 'W', then: 1000.05, now: 1000, pct: 0.01 }]) add('in.move', [m], { text: I.moveText(m), tone: I.moveTone(m) });
add('in.move', [null], { text: null, tone: I.moveTone(undefined) });
const items = [
  { id: '1', kind: 'message', at: now - 60_000, title: 'Charlie', body: 'SPX 7700 put fly', source: 'Charlie', symbols: ['SPX'], held: ['SPX'] },
  { id: '2', kind: 'signal', at: now - 3600_000 * 20, title: 'NVDA 上穿 180', body: '', source: 'cross', symbols: ['NVDA'], held: [] },
  { id: '3', kind: 'event', at: now + 3600_000 * 20, title: 'CPI', body: '美东 08:30', source: 'cpi', symbols: [], held: [] },
  { id: '4', kind: 'order', at: now - 3600_000 * 30, title: '买入 SPX 蝶', body: 'Filled', source: '主账户', symbols: ['SPX', 'SPXW'], held: ['SPX'] },
  { id: '5', kind: 'idea', at: now - 3600_000 * 24 * 5, title: 'AMD 突破', body: 'amd 回踩', source: 'active', symbols: ['AMD', 'NVDA'], held: [] },
];
for (const f of [{ kinds: [], heldOnly: false, query: '' }, { kinds: ['message', 'order'], heldOnly: false, query: '' }, { kinds: [], heldOnly: true, query: '' },
  { kinds: [], heldOnly: false, query: ' spx ' }, { kinds: [], heldOnly: false, query: 'filled' }, { kinds: [], heldOnly: false, query: 'cross' }, { kinds: [], heldOnly: false, query: 'sp' }])
  add('in.filter', [items, f], I.filterItems(items, f).map((i) => i.id));
add('in.groupByDay', [items, now], I.groupByDay(items, now).map((g) => ({ label: g.label, ids: g.items.map((i) => i.id) })));
add('in.hot', [items, 8], I.hotSymbols(items));
add('in.hot', [items, 2], I.hotSymbols(items, 2));
for (const d of [{ message_id: 'm1', at: now, author_name: 'Charlie', text: 'NVDA 180c 走了', symbols: ['NVDA', 'AMD'], prices: { NVDA: 180.456 } },
  { message_id: 'm2', at: NaN, author_name: '', text: 'x'.repeat(300), symbols: ['SPX'], prices: { SPX: 7712.25 } },
  { message_id: 'm3', at: now, author_name: 'A', text: 't', symbols: [], prices: {} }, { message_id: 5, symbols: ['A'], text: 't' }, null])
  add('in.heldMention', [d, now], I.isHeldMention(d) ? withNow(now, () => I.heldMentionPopup(d)) : null);
for (const s of [' $nvda ', 'BRK.B', '1ABC', 'ABCDEFGHIJK', '英伟达', '']) add('in.lookupSymbol', [s], I.lookupSymbol(s));
writeFileSync(join(here, 'feed-rules.json'), JSON.stringify({ generator: 'native/tests/fixtures/gen_feed_rules.mjs', tz: 'Asia/Shanghai', stateLabel: P.STATE_LABEL, stateHint: P.STATE_HINT,
  gexAssumption: P.GEX_ASSUMPTION, gexAssumptionHint: P.GEX_ASSUMPTION_HINT, kindLabel: I.KIND_LABEL, kindIcon: I.KIND_ICON, kindTint: I.KIND_TINT, kindOrder: I.KIND_ORDER, cases }, null, 2) + '\n');
console.log(`feed-rules.json: ${cases.length} cases`);
