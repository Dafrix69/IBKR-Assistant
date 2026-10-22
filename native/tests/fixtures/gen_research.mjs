// 生成 research.json:engine-ts 的 research.ts(原模块现跑)——黄金基线的锚点与摘要,加上合成的:各种说法(上周 / 本周 / 周几 /
// 前天 / 昨天 / 开盘 / 什么都没说)× 各种"今天"(周一到周日、写坏的)、日线长短不一(1、2、16、41、50、200、260 根,含缺字段、
// 串、null、0 价),以及 briefText 的各种 brief(没有、空、带 error、带锚点、值是串 / null)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_research.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const R = await import(pathToFileURL(join(engine, 'dist/src/research.js')).href);

let seed = 0x5e5e_a7c4;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gauss = () => { const u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
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

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/research.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const resolve = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$bars === 'string' ? store[v.$bars] : v);
const gbars = resolve(golden.bars).map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
function synth(n) {
  const bars = [];
  let t = Date.UTC(2026, 0, 2), px = pick([5, 50, 200, 1000]);
  for (let i = 0; i < n; i += 1) {
    t += 86_400_000;
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86_400_000;
    const open = px * Math.exp(gauss() * 0.005), close = open * Math.exp(gauss() * pick([0.005, 0.02]));
    bars.push({ date: isoOf(t), open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close });
    px = close;
  }
  const r = rnd();
  if (n && r < 0.1) bars[Math.floor(rnd() * n)].close = pick(['12.5', null, 'x', 0]);
  else if (n && r < 0.15) delete bars[Math.floor(rnd() * n)].high;
  else if (n && r < 0.2) bars[n - 1].low = 0;
  else if (n && r < 0.23) bars[Math.floor(rnd() * n)].date = pick([20260105, null, '2026-1-5']);
  else if (n && r < 0.25) delete bars[Math.floor(rnd() * n)].date;
  return bars;
}
const out = { golden: { bars: gbars, today: golden.today, anchors: [], brief: null, texts: {} }, sets: [], anchors: [], briefs: [], texts: [] };
for (const c of golden.anchors) out.golden.anchors.push({ text: c.text, ...run(() => R.resolveAnchor(c.text, gbars, golden.today)) });
const brief = R.symbolBrief(gbars);
out.golden.brief = enc(brief);
out.golden.texts = {
  brief: R.briefText('AAPL', { ...brief }), none: R.briefText(null, null), noData: R.briefText('AAPL', null), err: R.briefText('AAPL', { error: 'timeout' }),
  anchor: R.briefText('AAPL', { ...brief, anchor: R.resolveAnchor(golden.anchors[0].text, gbars, golden.today) }), short: enc(R.symbolBrief(gbars.slice(0, 1))),
};

for (const n of [0, 1, 2, 3, 6, 7, 15, 16, 21, 40, 41, 49, 50, 61, 120, 199, 200, 252, 260, 300]) out.sets.push(synth(n));
for (let i = 0; i < 12; i += 1) out.sets.push(synth(pick([16, 45, 70, 210])));
for (const n of [5, 20, 60]) out.sets.push(synth(n));
{ const b = synth(70); b[69].close = 'x'; out.sets.push(b); const c = synth(60); c[10].close = 'x'; out.sets.push(c); }
{ const b = synth(260); b[260 - 252].high = 1e6; out.sets.push(b); const c = synth(260); c[260 - 252].low = 1e-3; out.sets.push(c); }
let nanSet;
{ const b = synth(30); b[29].close = 'x'; b[20].close = 'x'; nanSet = out.sets.push(b) - 1; }
out.sets.push([null, { close: 1 }]);
out.sets.push([{ close: 1 }, 5, { close: 2, high: 3, low: 1 }]);

const texts = ['上周一买的', '上周五尾盘', '上周三开盘价进的', '本周二', '周四开盘', '这周五', '上本周一', '周日', '周六买', '前天', '昨天开盘', '昨日收盘', '前天和昨天',
  '就是想买', '', '周一周三', '上周', '本周三前天', '周五昨天开盘'];
const todays = ['2026-08-14', '2026-08-10', '2026-08-16', '2026-08-15', '2026-03-02', '2026-01-05', '2026-01-01', 'bad', '2026-13-40', '2026-02-30'];
for (let i = 0; i < 500; i += 1) {
  const set = i < 120 ? 0 : Math.floor(rnd() * out.sets.length);
  const bars = set === 0 && i < 120 ? gbars : out.sets[set];
  const text = pick(texts), today = i < 120 ? pick(todays.slice(0, 7)) : pick(todays);
  out.anchors.push({ set: i < 120 ? -1 : set, text, today, ...run(() => R.resolveAnchor(text, bars, today)) });
}
// 选中的那一根收盘价读不出(NaN)
for (const k of [29, 20, 25]) {
  const set = nanSet;
  const today = isoOf(Date.parse(out.sets[set][k].date) + 86_400_000);
  for (const text of ['昨天', '前天', '周五', '上周五']) out.anchors.push({ set, text, today, ...run(() => R.resolveAnchor(text, out.sets[set], today)) });
}
for (let i = 0; i < out.sets.length; i += 1) out.briefs.push({ set: i, ...run(() => R.symbolBrief(out.sets[i])) });
const briefPool = () => {
  const r = rnd();
  if (r < 0.1) return pick([null, {}, undefined]);
  if (r < 0.2) return { error: pick(['timeout', 5, '', 0, null]), last: 3 };
  const b = R.symbolBrief(pick(out.sets.filter((s) => s.length > 1 && s.every((x) => x && typeof x.close === 'number'))));
  if (rnd() < 0.2) b.rsi14 = pick(['弱', null, 50, -0, 1e-5, 1e17]);
  if (rnd() < 0.4) b.anchor = pick([{ label: '上周五(2026-08-07)收盘价', price: 218.61, chg_from_anchor_pct: 1.27 }, { label: 'x', price: 10, chg_from_anchor_pct: null },
    { label: 'y', price: 0.5, chg_from_anchor_pct: 0 }, { label: 'z', price: 12, chg_from_anchor_pct: -3.456 }, null, { label: 'w', price: 1e-5, chg_from_anchor_pct: 1e-9 }, { label: 'v', price: 3 }]);
  return b;
};
for (let i = 0; i < 120; i += 1) {
  const symbol = pick(['AAPL', 'TSLA', null, '', 'BRK.B', '%1']);
  const b = briefPool();
  out.texts.push({ symbol, brief: enc(b), out: R.briefText(symbol, b) });
}

writeFileSync(join(here, 'research.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out, sets: out.sets.map(enc) }) + '\n');
console.log('research.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '-'}`).join(' '));
