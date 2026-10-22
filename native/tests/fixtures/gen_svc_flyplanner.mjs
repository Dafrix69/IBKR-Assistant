// 生成 svc_flyplanner.json:engine-ts 的 services/flyPlanner.ts(原模块现跑)对着脚本驱动的假 router 与假盘口读取、虚拟钟:蝴蝶测算的取价 / 取盘口 / 报错口径 / IV 记录接口。
// C++ 一半:tests/tst_svc_flyplanner.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_flyplanner.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeMarks, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { FlyPlannerService } = await mods.imp('services/flyPlanner');

function build(world, host) {
  const svc = new FlyPlannerService(host);
  svc.marks = makeMarks(world);
  svc.onMarks = world.script.recordMarks ? (s) => world.rec('onMarks', 'call', [s]) : null;
  return {
    methods: { planFor: (a) => svc.planFor(a.params), spotFor: (a) => svc.spotFor(a.symbol) },
    gets: {},
    ops: {},
  };
}

const ET = (iso) => Date.parse(iso);
const START = ET('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const E = (error, extra = {}) => ({ error, ...extra });
const P = (over = {}) => ({ center: 7750, width: 20, target_spot: 7755, target_time: '15:30', ...over });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log'], recordMarks: true, ...script } });
const router = (over = {}) => ({
  results: { indexPrice: [R(7752.5)], streamQuotes: [R({ AAPL: { last: 230 } })] },
  spotInfo: { SPX: { source: 'index', note: '' } }, marketSession: { accounts: ['U1234567'] }, upstreamOk: true, ...over,
});
const MARKS = { dflt: { bid: 5.1, ask: 5.5, iv: 0.12 } };

add('planFor:连着券商,现价与三条腿盘口都取;IV 记录接口被叫;结果交给 planFly', {
  router: router(), marks: [MARKS],
  steps: [{ op: 'port', v: 'make' }, call('a', 'planFor', { params: P() }), call('b', 'planFor', { params: P({ right: 'put', center: 7700 }) }), call('c', 'planFor', { params: P({ right: ' 看跌 ', quantity: 3, cost: 4.2, iv: 14, iv_mode: 'flat' }) })],
});
add('planFor:手动给现价 → 不叫 onMarks;手动给 IV 与成本;盘口取不到/被拒带着一句话接着算,没给 IV 就报原因', {
  router: router(), marks: [E('期权行情订阅超时'), { byLeg: { '7730C': { error: 'TWS 10197', bid: null, ask: null, iv: null }, '7750C': { error: 'x' } } }, E('boom', { kind: 'plain' }), MARKS],
  steps: [{ op: 'port', v: 'make' }, call('a', 'planFor', { params: P({ spot: 7748, iv: 12, cost: 3 }) }), call('b', 'planFor', { params: P({ spot: 7748, iv: 12 }) }), call('c', 'planFor', { params: P({ spot: 7748 }) }),
    call('d', 'planFor', { params: P({ iv: 11 }) }), call('e', 'planFor', { params: P({ iv: 11 }) }), call('f', 'planFor', { params: P({ iv: 11 }) })],
});
add('planFor:没连券商 / 现价取不到 / 夜盘昨收 / 不认识的 right / 日程错 → 各自的话与错误码', {
  router: router({ results: { indexPrice: [R(null), R(7000), E('x')] }, spotInfo: { SPX: { source: 'index_stale', note: '期货推算失败' } } }), marks: [MARKS],
  steps: [call('a', 'planFor', { params: P() }), call('a2', 'planFor', { params: P({ spot: 7748, iv: 10 }) }), { op: 'port', v: 'make' },
    call('b', 'planFor', { params: P() }), { op: 'portSet', set: { spotInfo: { SPX: { source: 'index' } } } }, call('c', 'planFor', { params: P() }), call('d', 'planFor', { params: P() }),
    call('e', 'planFor', { params: P({ right: 'x', spot: 7748, iv: 10 }) }), call('f', 'planFor', { params: P({ target_time: '25:99', spot: 7748, iv: 10 }) }), call('g', 'planFor', { params: P({ expiry: '20200101', spot: 7748, iv: 10 }) }),
    call('h', 'planFor', { params: { ...P(), symbol: 'aapl' } }), call('i', 'planFor', { params: { ...P(), symbol: '  ' , spot: 7748, iv: 10 } })],
});
add('planFor:非 IBKR 券商 / 市场会话取不到', {
  router: router({ marketSession: { error: '没有连着的会话' } }), marks: [MARKS],
  steps: [{ op: 'port', v: 'make' }, call('a', 'planFor', { params: P({ iv: 10 }) }), call('b', 'planFor', { params: P() })],
});
add('planFor:纸面账户(D 开头)允许延迟行情', {
  router: router({ marketSession: { accounts: ['DU1', 'DU2'] } }), marks: [MARKS],
  steps: [{ op: 'port', v: 'make' }, call('a', 'planFor', { params: P() })],
});
add('planFor:cost 给了 null 等于没给;中心恰好等于现价按看涨;现价为 0.5 的指数照样用', {
  router: router({ results: { indexPrice: [R(7750), R(0.5), R(0.5)] } }), marks: [MARKS],
  steps: [{ op: 'port', v: 'make' }, call('a', 'planFor', { params: P({ spot: 7750, iv: 12, cost: null }) }), call('b', 'planFor', { params: P({ center: 7750, spot: 7750, iv: 12 }) }), call('c', 'planFor', { params: P({ center: 7750, iv: 12 }) }), call('d', 'spotFor', { symbol: 'SPX' })],
});
add('spotFor:报价 / 断开 / 昨收 / 没价 / 没连', {
  router: router({ results: { indexPrice: [R(7752.5), R(7752.5), R(null), R(7752.5)], streamQuotes: [R({ AAPL: { last: 230 } }), R({}), E('x')] }, spotInfo: { SPX: { source: 'futures', note: 'ES 202612' } } }),
  steps: [call('n', 'spotFor', { symbol: 'SPX' }), { op: 'port', v: 'make' }, call('a', 'spotFor', { symbol: 'SPX' }),
    { op: 'portSet', set: { upstreamOk: false } }, call('b', 'spotFor', { symbol: 'SPX' }), { op: 'portSet', set: { upstreamOk: true, spotInfo: { SPX: { source: 'index_stale', note: '' } } } }, call('c', 'spotFor', { symbol: 'SPX' }),
    call('d', 'spotFor', { symbol: 'SPX' }), call('e', 'spotFor', { symbol: 'AAPL' }), call('f', 'spotFor', { symbol: 'AAPL' }), call('g', 'spotFor', { symbol: 'AAPL' }), { op: 'portSet', set: { sessions: 0 } }, call('h', 'spotFor', { symbol: 'SPX' })],
});
{
  const r = rng(0xf1f1_a770);
  for (let n = 0; n < 40; n += 1) {
    const marks = Array.from({ length: 3 }, () => (r.chance(0.2) ? E(r.pick(['订阅超时', '拒']), r.chance(0.3) ? { kind: 'plain' } : {}) : { dflt: r.pick([{ bid: 5, ask: 5.4, iv: 0.1 }, { bid: null, ask: null, iv: 0.1 }, {}]), ...(r.chance(0.3) ? { byLeg: { '7730C': { error: 'e', bid: null, ask: null, iv: null } } } : {}), ...(r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}) }));
    const rt = router({ results: { indexPrice: Array.from({ length: 3 }, () => (r.chance(0.1) ? E('x') : R(r.pick([7752.5, 7752.5, 7752.5, null, 0])))), streamQuotes: [R({ AAPL: { last: 230 } })] },
      spotInfo: { SPX: r.pick([{ source: 'index' }, { source: 'futures', note: 'ES' }, { source: 'index_stale', note: 'n' }]) }, marketSession: r.pick([{ accounts: ['U1'] }, { accounts: ['DU1'] }, { accounts: [] }]), upstreamOk: r.chance(0.8) });
    const steps = [{ op: 'port', v: r.chance(0.85) ? 'make' : 'null' }];
    for (let i = 0; i < 10; i += 1) {
      const p = r.next();
      if (p < 0.7) {
        const params = P({ ...(r.chance(0.3) ? { spot: 7740 + r.int(30) } : {}), ...(r.chance(0.4) ? { iv: 8 + r.int(10) } : {}), ...(r.chance(0.3) ? { cost: 2 + r.int(5) } : {}), ...(r.chance(0.4) ? { right: r.pick(['C', 'P', 'x', 'call', '看涨']) } : {}),
          center: r.pick([7700, 7750, 7800]), width: r.pick([10, 20]), target_time: r.pick(['15:30', '11:00', '16:30', '15:30', '11:00', '14:00', '15:45', 'x']), ...(r.chance(0.2) ? { quantity: 2 } : {}), ...(r.chance(0.2) ? { iv_mode: r.pick(['auto', 'flat', 'shift']), iv_shift_pct: 5 } : {}) });
        steps.push(call(`p${i}`, 'planFor', { params }));
      } else if (p < 0.85) steps.push(call(`s${i}`, 'spotFor', { symbol: r.pick(['SPX', 'AAPL']) }));
      else if (p < 0.93) steps.push({ op: 'advance', ms: r.pick([1, 4000]) });
      else steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]), upstreamOk: r.chance(0.5) } });
    }
    scenarios.push({ name: `随机 ${n}`, script: { start: r.pick([START, ET('2026-10-12T15:00:00-04:00'), ET('2026-10-10T10:00:00-04:00')]), seed: n + 1, dump: ['audit_log'], recordMarks: r.chance(0.7), router: rt, marks, steps } });
  }
}
const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_flyplanner.json'), text);
console.log(`svc_flyplanner.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
