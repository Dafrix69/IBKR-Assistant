// 生成 svc_ideasemantic.json:engine-ts 的 services/ideaSemantic.ts(原模块现跑)对着脚本驱动的假大模型 / 假嵌入器、真的交易库(想法向量表):
// llm 模式的缓存与编号核对、embed 模式的懒算向量与门槛、出错一律退回 null。C++ 一半:tests/tst_svc_ideasemantic.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_ideasemantic.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, dec, enc, loadMods, pick, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { IdeaSemanticService } = await mods.imp('services/ideaSemantic');

/** 文本 → 确定的小向量(两边一样的公式) */
const vecOf = (t) => { let sum = 0; for (let i = 0; i < t.length; i += 1) sum += t.charCodeAt(i); return [(t.length % 7) + 1, (sum % 11) + 1, 1, ((t.length * 3) % 5) + 1]; };

function build(world, host) {
  const svc = new IdeaSemanticService(host);
  const counters = { llm: {}, embed: {} };
  svc.mode = world.script.mode;
  svc.embedder = world.script.noEmbedder ? null : {
    model: world.script.model ?? 'qwen3-embedding:8b-q8_0',
    embed: async (texts, timeoutMs) => {
      world.rec('embed', 'call', [texts, timeoutMs]);
      const r = pick(world.script, counters.embed, 'embed', [{}]);
      if (r.hang) await new Promise(() => {});
      if (r.delay) await world.sleep(r.delay);
      if (r.error !== undefined) throw new Error(r.error);
      const vs = texts.map((t) => (r.fixed ? r.fixed : vecOf(t)));
      return r.short ? vs.slice(0, Math.max(0, vs.length - 1)) : vs;
    },
  };
  const llm = async (system, user, schema) => {
    world.rec('llm', 'call', [system, user, schema]);
    const r = pick(world.script, counters.llm, 'llm', [{ value: { ids: [] } }]);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await world.sleep(r.delay);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec(r.value));
  };
  return {
    methods: { rank: (a) => svc.rank(a.query, a.pool, a.useLlm ? llm : undefined).then((m) => (m === null ? null : [...m.entries()])) },
    gets: {},
    ops: { mode: (step) => { svc.mode = step.mode; } },
  };
}

const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const idea = (i, text) => ({ id: `idea-${i}`, text, created_at: 'x', updated_at: 'x', symbols: [], status: 'active', analysis: null });
const POOL = [idea(0, '追高 NVDA 尾盘买入,后悔'), idea(1, '  拆腿 先买回身\n再平另一腿  '), idea(2, 'TSLA 财报前别追高'), idea(3, 'x'.repeat(400)), idea(4, '😀'.repeat(310)), idea(5, '半导体板块轮动'), idea(6, 'SPX 7700 蝶 平仓太早')];
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['idea_vectors'], ...script } });

add('off / 空查询 / 空池子 / llm 模式没给 llm', {
  mode: 'off', steps: [call('a', 'rank', { query: '追高', pool: POOL, useLlm: true }), { op: 'mode', mode: 'llm' }, call('b', 'rank', { query: '   ', pool: POOL, useLlm: true }), call('c', 'rank', { query: 'x', pool: [], useLlm: true }), call('d', 'rank', { query: 'x', pool: POOL, useLlm: false }),
    { op: 'mode', mode: 'embed' }, call('e', 'rank', { query: '', pool: POOL }), call('f', 'rank', { query: 'x', pool: [] })],
});
add('llm:编号核对(编的、重复的、乱写的不认)、最多 8 个、分数 1 往下递减;同一问走缓存;出错不缓存', {
  mode: 'llm',
  llm: [{ value: { ids: ['i0', 'i5', 'i99', ' i2 ', 'i0', 'foo', 'i1'] } }, { error: '模型超时' }, { value: { ids: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i0', 'i0', 'i1', 'i2', 'i3'] } }, { value: { ids: 'bad' } }, { value: { ids: ['i1'], extra: 1 } }, { value: ['i1'] }, { value: { ids: Array.from({ length: 51 }, () => 'i1') } }, { value: { ids: [1] } }, { value: null }],
  steps: [call('a', 'rank', { query: '追高', pool: POOL, useLlm: true }), call('b', 'rank', { query: '追高', pool: POOL, useLlm: true }), call('c', 'rank', { query: '别的', pool: POOL, useLlm: true }), call('d', 'rank', { query: '别的', pool: POOL, useLlm: true }),
    call('e', 'rank', { query: '回包不对 1', pool: POOL, useLlm: true }), call('f', 'rank', { query: '回包不对 2', pool: POOL, useLlm: true }), call('g', 'rank', { query: '回包不对 3', pool: POOL, useLlm: true }), call('h', 'rank', { query: '回包不对 4', pool: POOL, useLlm: true }), call('i', 'rank', { query: '回包不对 5', pool: POOL, useLlm: true }), call('j', 'rank', { query: '回包不对 6', pool: POOL, useLlm: true })],
});
add('llm:缓存 64 组先进先出;池子顺序变了就是另一问', {
  mode: 'llm', llm: [{ value: { ids: ['i0'] } }],
  steps: [...Array.from({ length: 66 }, (_, i) => call(`q${i}`, 'rank', { query: `问${i}`, pool: POOL.slice(0, 3), useLlm: true })), call('again0', 'rank', { query: '问0', pool: POOL.slice(0, 3), useLlm: true }), call('again65', 'rank', { query: '问65', pool: POOL.slice(0, 3), useLlm: true }), call('rev', 'rank', { query: '问65', pool: POOL.slice(0, 3).reverse(), useLlm: true })],
});
add('llm:恰好 50 个编号合格;最多认 8 个(第 9 个起不认)', {
  mode: 'llm', llm: [{ value: { ids: Array.from({ length: 50 }, (_, i) => `i${i % 12}`) } }, { value: { ids: ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10'] } }],
  steps: [call('a', 'rank', { query: '五十', pool: Array.from({ length: 12 }, (_, i) => idea(700 + i, `想法 ${i}`)), useLlm: true }), call('b', 'rank', { query: '八个', pool: Array.from({ length: 12 }, (_, i) => idea(700 + i, `想法 ${i}`)), useLlm: true })],
});
add('llm:池子超过 200 只取前 200;文本折空白、按码点截 300', {
  mode: 'llm', llm: [{ value: { ids: ['i199', 'i200'] } }],
  steps: [call('a', 'rank', { query: '多', pool: [...POOL, ...Array.from({ length: 250 }, (_, i) => idea(100 + i, `想法 ${i}`))], useLlm: true })],
});
add('embed:懒算向量存库、下次不再算;门槛按模型;前 3 名;出错 null;没有嵌入器 null', {
  mode: 'embed', model: 'qwen3-embedding:8b-q8_0',
  steps: [call('a', 'rank', { query: '追高', pool: POOL }), call('b', 'rank', { query: '追高', pool: POOL }), call('c', 'rank', { query: '追高', pool: [...POOL, idea(7, '新来的想法')] })],
});
add('embed:换模型重算;回的向量比文本少;空向量;批量 16 条一批;出错/不回话', {
  mode: 'embed', model: 'qwen3-embedding:0.6b',
  embed: [{}, { short: true }, { error: '本机嵌入服务没开' }, { fixed: [] }, { fixed: [1, 2, 3, 4], delay: 100 }],
  steps: [call('a', 'rank', { query: '追高', pool: POOL }), call('b', 'rank', { query: '追高', pool: Array.from({ length: 20 }, (_, i) => idea(200 + i, `批量 ${i}`)) }), call('c', 'rank', { query: '追高', pool: Array.from({ length: 20 }, (_, i) => idea(300 + i, `批量 ${i}`)) }),
    call('d', 'rank', { query: '追高', pool: POOL.slice(0, 2).map((x) => ({ ...x, id: `z-${x.id}` })) }), call('e', 'rank', { query: '追高', pool: POOL.slice(0, 2).map((x) => ({ ...x, id: `y-${x.id}` })) })],
});
add('embed:没嵌入器(地址不是本机)→ null', {
  mode: 'embed', noEmbedder: true, steps: [call('a', 'rank', { query: '追高', pool: POOL })],
});
{
  const r = rng(0x1de4_5e11);
  for (let n = 0; n < 40; n += 1) {
    const mode = r.pick(['llm', 'embed', 'off']);
    const pool = POOL.filter(() => r.chance(0.8)).concat(Array.from({ length: r.int(4) }, (_, i) => idea(500 + i, r.pick(['新想法', '追高 加仓', '拆腿']))));
    const script = { start: START, seed: n + 1, dump: ['idea_vectors'], mode, model: r.pick(['qwen3-embedding:8b-q8_0', 'qwen3-embedding:0.6b', 'other']), noEmbedder: r.chance(0.1),
      llm: Array.from({ length: 4 }, () => (r.chance(0.2) ? { error: '坏' } : { value: { ids: Array.from({ length: r.int(6) }, () => `i${r.int(9)}`) }, ...(r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}) })),
      embed: Array.from({ length: 4 }, () => (r.chance(0.2) ? { error: '没开' } : { ...(r.chance(0.2) ? { short: true } : {}), ...(r.chance(0.2) ? { delay: 20 } : {}) })) };
    script.steps = Array.from({ length: 8 }, (_, i) => (r.chance(0.8) ? call(`r${i}`, 'rank', { query: r.pick(['追高', '拆腿', ' 轮动 ', '']), pool: r.chance(0.8) ? pool : pool.slice(0, 2), useLlm: r.chance(0.85) }) : { op: 'mode', mode: r.pick(['llm', 'embed', 'off']) }));
    scenarios.push({ name: `随机 ${n}`, script });
  }
}
const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_ideasemantic.json'), text);
console.log(`svc_ideasemantic.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
