// 生成 svc_pool.json:engine-ts 的 services/pool.ts(原模块现跑)对着真的交易库(板块 / 价位监控 / 异动股 / 偏好表)、虚拟钟;
// AlertsService / AnomalyService 换成只记录 forget 的替身(pool 只用它们的常量与 forget)。C++ 一半:tests/tst_svc_pool.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_pool.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { PoolService } = await mods.imp('services/pool');
const { AlertsService } = await mods.imp('services/alerts');
const { AnomalyService } = await mods.imp('services/anomaly');
const PORTS = { maxWatch: AlertsService.MAX_WATCH, originTracker: AlertsService.ORIGIN_TRACKER, maxQuality: AnomalyService.MAX_QUALITY };

function build(world, host) {
  const alerts = { forget: (s) => world.rec('alerts', 'forget', [s]) };
  const anomaly = { forget: (s) => world.rec('anomaly', 'forget', [s]) };
  const pool = new PoolService(host, alerts, anomaly);
  return {
    methods: {
      setWatch: (a) => pool.setWatch(a.symbol, a.patch, a.note),
      ensureInPool: (a) => pool.ensureInPool(a.symbol, a.company),
      dropWatches: (a) => pool.dropWatches(a.symbols),
      migrate: () => { pool.ensureMigrated(); return null; },
    },
    gets: {},
    ops: {},
  };
}

const START = Date.parse('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log', 'app_prefs', 'alert_watches', 'quality_stocks', 'sectors'], ports: PORTS, ...script } });
const sym = (i) => `S${String(i).padStart(2, '0')}`;
const stocks = (list) => list.map((s) => ({ symbol: s, company: '', reason: 'x', tag: '' }));

add('setWatch:两个开关各开各的、幂等;指数只能盯价位;关掉时通知 alerts / anomaly 忘掉', {
  steps: [st('addSector', ['半导体']),
    call('a', 'setWatch', { symbol: 'NVDA', patch: { price: true } }), call('b', 'setWatch', { symbol: 'NVDA', patch: { price: true, anomaly: true }, note: '观察' }), call('c', 'setWatch', { symbol: 'NVDA', patch: { anomaly: true } }),
    call('d', 'setWatch', { symbol: 'SPX', patch: { price: true, anomaly: true } }), call('e', 'setWatch', { symbol: 'NVDA', patch: { price: false } }), call('f', 'setWatch', { symbol: 'NVDA', patch: { price: false, anomaly: false } }),
    call('g', 'setWatch', { symbol: 'NVDA', patch: {} }), call('h', 'setWatch', { symbol: 'bad symbol', patch: { price: true } }), call('i', 'setWatch', { symbol: 'AMD', patch: { anomaly: true } })],
});
add('setWatch:价位 / 异动各 30 只的上限如实进 skipped', {
  steps: [...Array.from({ length: 30 }, (_, i) => st('addWatch', [sym(i), 0])), ...Array.from({ length: 30 }, (_, i) => st('addQualityStock', [sym(i), ''])), st('setPref', ['pool.migrated_v1', { at: 'x' }]),
    call('a', 'setWatch', { symbol: 'NEW1', patch: { price: true, anomaly: true } }), call('b', 'setWatch', { symbol: sym(3), patch: { price: false } }), call('c', 'setWatch', { symbol: 'NEW1', patch: { price: true } })],
});
add('迁移:老库三张表各记一份 → 并成池子;孤儿并进「自选」;追踪自动建的盯单不算孤儿;只跑一次(用户关掉的开关不再被翻开)', {
  steps: [st('addWatch', ['AAA', 0]), st('addWatch', ['TRK', 0, 'tracker']), st('addQualityStock', ['BBB', '']), st('addQualityStock', [' aaa', '']),
    st('addSector', ['科技']),
    call('m', 'migrate'), call('a', 'setWatch', { symbol: 'AAA', patch: { price: false } }), call('m2', 'migrate'), call('b', 'setWatch', { symbol: 'AAA', patch: {} })],
});
add('ensureInPool / dropWatches:并进自选(没有就建);移出后连带清掉;不在池里的不动', {
  steps: [call('a', 'ensureInPool', { symbol: 'NVDA', company: 'x'.repeat(100) }), call('b', 'ensureInPool', { symbol: 'NVDA' }), call('c', 'ensureInPool', { symbol: 'AMD', company: 'AMD Inc' }),
    call('w', 'setWatch', { symbol: 'TSLA', patch: { price: true, anomaly: true } }), call('d', 'dropWatches', { symbols: ['tsla', ' NVDA ', 'NVDA', '', 'ZZZ', 'AMD'] }), call('e', 'dropWatches', { symbols: ['TSLA'] })],
});

{
  const r = rng(0x9001_e5e5);
  const syms = ['NVDA', 'AMD', 'TSLA', 'SPX', 'VIX', 'AAPL', 'x y', 'MSFT'];
  for (let n = 0; n < 40; n += 1) {
    const steps = [];
    const secs = r.int(3);
    for (let i = 0; i < secs; i += 1) steps.push(st('addSector', [r.pick(['自选', '科技', '半导体'])]));
    for (let i = 0; i < r.int(5); i += 1) steps.push(st('addWatch', [r.pick(syms.slice(0, 6)), 0, r.pick([undefined, 'tracker', 'ui'])].filter((x) => x !== undefined)));
    for (let i = 0; i < r.int(4); i += 1) steps.push(st('addQualityStock', [r.pick(syms.slice(0, 6)), '']));
    if (r.chance(0.2)) steps.push(st('setPref', ['pool.migrated_v1', { at: 'x' }]));
    for (let i = 0; i < 14; i += 1) {
      const p = r.next();
      if (p < 0.5) steps.push(call(`w${i}`, 'setWatch', { symbol: r.pick(syms), patch: r.pick([{ price: true }, { anomaly: true }, { price: false }, { anomaly: false }, { price: true, anomaly: true }, { price: false, anomaly: false }, {}]), note: r.pick(['', 'n']) }));
      else if (p < 0.7) steps.push(call(`e${i}`, 'ensureInPool', { symbol: r.pick(syms), company: r.pick(['', 'Co']) }));
      else if (p < 0.9) steps.push(call(`d${i}`, 'dropWatches', { symbols: Array.from({ length: r.int(4) }, () => r.pick(syms)) }));
      else steps.push(call(`m${i}`, 'migrate'));
    }
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, ports: PORTS, dump: ['audit_log', 'app_prefs', 'alert_watches', 'quality_stocks', 'sectors'], steps } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_pool.json'), text);
console.log(`svc_pool.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
