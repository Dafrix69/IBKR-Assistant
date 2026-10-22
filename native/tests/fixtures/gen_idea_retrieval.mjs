// 生成 idea-retrieval.json:engine-ts 的 ideaRetrieval.ts(原模块现跑)。打分与命中标签、混合检索的合并(候选里已有的打标、池子里补、
// 新的在前、封顶)、按时间分层抽样(段数是小数 / 0 / NaN、时刻全一样、读不出的时刻、配额注水、预算是小数)、知识总结的取数(最近几条无条件进、
// 重复的 id),以及关键词 / 标的 / 焦点 / 日界的整理与报错。时刻不带时区的按本机读:要 TZ=Asia/Shanghai。
//   TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_idea_retrieval.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('要 TZ=Asia/Shanghai 跑');
const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const R = await import(pathToFileURL(join(engine, 'dist/src/ideaRetrieval.js')).href);

let seed = 0x1dea_5eed;
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

const stamps = () => pick([
  `2026-${String(1 + Math.floor(rnd() * 9)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}T${String(Math.floor(rnd() * 24)).padStart(2, '0')}:00:00.000Z`,
  `2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)} 08:00:00`, '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z', '', null, 'bogus',
]);
let nid = 0;
const idea = () => ({ id: pick([`i${nid++}`, `i${Math.floor(rnd() * 30)}`, `I${Math.floor(rnd() * 5)}`, 'a', 'b', 'Z', 'é']), created_at: stamps() });
const cand = (i = idea()) => {
  const c = { idea: i, symbol_hit: rnd() < 0.4, text_hit: rnd() < 0.6 };
  if (rnd() < 0.3) c.semantic_hit = pick([true, false, 1, 0, null]);
  if (rnd() < 0.05) c.symbol_hit = pick([1, 'x', '', null]);
  return c;
};
const out = { scores: [], merge: [], strat: [], digest: [], terms: [], symbols: [], focus: [], days: [] };
for (let i = 0; i < 200; i += 1) { const c = cand(); out.scores.push({ c, score: R.scoreCandidate(c), tags: R.matchTags(c) }); }
for (let i = 0; i < 300; i += 1) {
  const pool = Array.from({ length: Math.floor(rnd() * 12) }, idea);
  const candidates = Array.from({ length: Math.floor(rnd() * 12) }, () => cand(rnd() < 0.3 && pool.length ? pick(pool) : idea()));
  const ids = [...pool, ...candidates.map((c) => c.idea)].map((x) => x.id).filter(() => rnd() < 0.4);
  const limit = pick([5, 10, 100, 0, 3.7, -2, NaN]);
  out.merge.push({ candidates, pool, semantic: ids, limit: enc(limit), ...run(() => R.mergeSemantic(candidates, pool, new Map(ids.map((id) => [id, 0.5])), limit)) });
}
for (let i = 0; i < 400; i += 1) {
  const candidates = Array.from({ length: Math.floor(rnd() * 32) }, () => cand());
  const budget = pick([0, -1, 1, 5, 10, 17, 2.5, 39, 100]);
  const buckets = pick([3, 1, 0, -2, 2.9, 5, NaN, 7]);
  out.strat.push({ candidates, budget, buckets: enc(buckets), ...run(() => R.stratify(candidates, budget, buckets)) });
}
// 预算为 0 时先回 [](不建段):段数大到 Array.from 会抛 Invalid array length 的,TS 也不抛。4294967295 不放——TS 真去建那么长的数组会耗尽内存
for (const buckets of [2 ** 33, Infinity, 1e300, 4294967296]) for (const budget of [0, -1]) {
  const candidates = Array.from({ length: 3 }, () => cand());
  out.strat.push({ candidates, budget, buckets: enc(buckets), ...run(() => R.stratify(candidates, budget, buckets)) });
}
// 段数是小数(2.6 → 2 段,不是 3 段)
for (let i = 0; i < 40; i += 1) {
  const candidates = Array.from({ length: 20 + Math.floor(rnd() * 10) }, () => cand());
  const budget = pick([4, 6, 9]), buckets = pick([2.6, 3.5, 1.7]);
  out.strat.push({ candidates, budget, buckets, ...run(() => R.stratify(candidates, budget, buckets)) });
}
for (let i = 0; i < 300; i += 1) {
  const recentPool = Array.from({ length: Math.floor(rnd() * 30) }, idea);
  const matches = Array.from({ length: Math.floor(rnd() * 45) }, () => cand(rnd() < 0.3 && recentPool.length ? pick(recentPool) : idea()));
  const opts = pick([undefined, R.DIGEST_PICK, { total: 10, recent: 3, buckets: 3 }, { total: 5, recent: 8, buckets: 2 }, { total: 20, recent: 0, buckets: 4 },
    { total: 12, recent: 2.5, buckets: 3 }, { total: 0, recent: 3, buckets: 3 }, { total: 30, recent: NaN, buckets: 3 }]);
  out.digest.push({ matches, recentPool, opts: enc(opts), ...run(() => (opts === undefined ? R.pickForDigest(matches, recentPool) : R.pickForDigest(matches, recentPool, opts))) });
}
const termInputs = [undefined, null, '', ' ', 'SPX', 'spx 蝴蝶,止盈;;回撤', '  a  b  a ', 'a，b、c；d', 'x　y z w', '﻿a', 5, 0, true, ['a', 'b'], {}, 'A a A', ',,,', '😀,😀'];
for (const q of termInputs) out.terms.push({ q: enc(q), out: R.splitTerms(q) });
for (const s of [...termInputs, ['spx', ' aapl ', '', 'SPX', null, 5], ['ß'], 'brk.b, spx']) out.symbols.push({ s: enc(s), out: R.parseSymbols(s) });
for (const f of [undefined, null, 0, '', 'x', {}, { q: '' }, { q: ' a b ' }, { symbols: 'spx' }, { q: 'x', symbols: ['aapl', 'AAPL'] }, { q: null, symbols: [] }, { q: ',', symbols: ' , ' }, [], 5])
  out.focus.push({ f: enc(f), out: enc(R.normalizeFocus(f)) });
for (const d of [undefined, null, '', '  ', '2026-10-14', ' 2026-10-14 ', '2026-02-30', '2024-02-29', '2026-13-01', '0050-01-01', '9999-12-31', '2026-1-14', '20261014', 20261014, 'x', '2026-10-14T00:00'])
  for (const name of ['since', 'until']) out.days.push({ d: enc(d), name, ...run(() => R.dayBound(d, name)) });
out.digestPick = R.DIGEST_PICK;
writeFileSync(join(here, 'idea-retrieval.json'), JSON.stringify(out) + '\n');
console.log(`idea-retrieval.json: ${out.strat.length} 次分层, ${out.digest.length} 次取数, ${out.merge.length} 次合并`);
