// 生成 h2_quality.json:engine-ts 的 quality.ts 与 alerts.ts 两个 handler(原类现跑)对着 h2_world.mjs 的假 RpcContext;库是真的(临时库)。
// C++ 一半:tests/tst_h2_quality.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_quality.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);
const { DEFAULT_ANOMALY_CONFIG } = await h2.mods.imp('anomaly');
const { DEFAULT_TOUCH_CONFIG } = await h2.mods.imp('maTouch');

const START = Date.parse('2026-10-12T10:30:00-04:00');
const DUMP = ['audit_log', 'app_prefs', 'alert_watches', 'quality_stocks', 'sectors'];
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: DUMP, ...script } });
const ANOM = (patch = {}) => ({ value: { ...DEFAULT_ANOMALY_CONFIG, ...patch } });
const TOUCH = (patch = {}) => ({ value: { ...DEFAULT_TOUCH_CONFIG, ...patch } });
const MONITOR = { value: { running: true, interval_ms: 5000, ticks: 12, last_at: '2026-10-12T14:30:00.000Z', last_ms: 41, last_error: '', delayed: false, market_ref: null } };
const sym = (i) => `S${String(i).padStart(2, '0')}`;
const WATCH_OK = (symbol, extra = {}) => ({ value: { symbol, price_on: false, anomaly_on: true, skipped: [], ...extra }, effects: [{ m: 'addQualityStock', a: [symbol, ''] }] });

// ---- quality
add('quality.list:空库;迁移先跑;配置与监控状态原样', {
  ports: { 'anomaly.config': [ANOM()], 'anomaly.monitor': [MONITOR] },
  steps: [call('a', 'quality.list'), call('b', 'quality.list', { extra: 1 })],
});
add('quality.list:每行并上最近一轮指标与「价位算到哪一步」;没指标是 null', {
  ports: {
    'anomaly.config': [ANOM({ window_min: 10 })], 'anomaly.monitor': [MONITOR],
    'anomaly.metricsOf': [{ value: { metrics: { rvol: 2.5, day_pct: 3.1 }, at: '2026-10-12T14:29:55.000Z', error: null } }, { value: null }, { value: { metrics: null, at: '2026-10-12T14:00:00.000Z', error: '没有行情权限' } }],
    'alerts.levelsStatusOf': [{ value: '正在算价位…' }, { value: null }, { value: 'ok' }],
  },
  steps: [st('addQualityStock', ['NVDA', '观察']), st('addQualityStock', ['AMD', '']), st('addQualityStock', ['TSLA', 'x'.repeat(80)]), call('a', 'quality.list')],
});
add('quality.add:各种拒绝(代码形状 / 指数 / 重复 / 满 30 只)', {
  ports: { 'anomaly.config': [ANOM()], 'anomaly.monitor': [MONITOR] },
  steps: [call('a', 'quality.add', { symbol: 'bad$' }), call('b', 'quality.add', { symbol: ' spx ' }), call('c', 'quality.add', { symbol: '' }),
    st('addQualityStock', ['NVDA', '']), call('d', 'quality.add', { symbol: 'nvda' }), call('e', 'quality.add', { symbol: 'NVDA', note: 5 }),
    ...Array.from({ length: 29 }, (_, i) => st('addQualityStock', [sym(i), ''])), call('f', 'quality.add', { symbol: 'NEWX' }), call('g', 'quality.add', {})],
});
add('quality.add:成功(池子替身开了开关,库里多一行);没开成功时的 skipped 原因 / 缺省原因 / 库里读不回', {
  ports: {
    'anomaly.config': [ANOM()], 'anomaly.metricsOf': [{ value: null }], 'alerts.levelsStatusOf': [{ value: null }],
    'pool.ensureInPool': [{ value: '自选' }, { value: null }],
    'pool.setWatch': [WATCH_OK('NVDA'), { value: { symbol: 'AMD', price_on: false, anomaly_on: false, skipped: ['异动监控已满 30 只'] } }, { value: { symbol: 'TSLA', anomaly_on: false } }, { value: { symbol: 'AAPL', anomaly_on: true, skipped: [] } }, { error: '池子坏了' }],
  },
  steps: [call('a', 'quality.add', { symbol: 'nvda', company: 'NVIDIA', note: '观察' }), call('b', 'quality.add', { symbol: 'AMD' }), call('c', 'quality.add', { symbol: 'TSLA', note: '', company: '' }),
    call('d', 'quality.add', { symbol: 'AAPL' }), call('e', 'quality.add', { symbol: 'MSFT' })],
});
add('quality.update:找不到 / 启停 / 改备注 / 什么都没改(不留审计)/ 停用时通知异动忘掉样本', {
  ports: { 'anomaly.metricsOf': [{ value: null }], 'alerts.levelsStatusOf': [{ value: null }] },
  steps: [st('addQualityStock', ['NVDA', '']), st('addQualityStock', ['AMD', '观察']), call('x', 'quality.update', { id: 'nope', enabled: true }),
    call('a', 'quality.update', { id: '00000000-0000-4000-8000-000000000002', enabled: false }), call('b', 'quality.update', { id: ' 00000000-0000-4000-8000-000000000002 ', enabled: true, note: '回来了' }),
    call('c', 'quality.update', { id: '00000000-0000-4000-8000-000000000005', note: 'x'.repeat(100) }), call('d', 'quality.update', { id: '00000000-0000-4000-8000-000000000002' }),
    call('e', 'quality.update', { id: '00000000-0000-4000-8000-000000000002', enabled: 'yes' }), call('f', 'quality.update', { id: '00000000-0000-4000-8000-000000000002', note: 5 }), call('g', 'quality.update', {})],
});
add('quality.remove:找不到 / 走池子的开关逻辑(不直接删行)', {
  ports: { 'pool.setWatch': [{ value: { symbol: 'NVDA', price_on: false, anomaly_on: false, skipped: [] } }] },
  steps: [st('addQualityStock', ['NVDA', '']), call('a', 'quality.remove', { id: 'nope' }), call('b', 'quality.remove', { id: '  00000000-0000-4000-8000-000000000001 ' }), call('c', 'quality.remove', {})],
});
add('quality.set_config:在当前生效的那份上合并;不合规 → -32602 中文原因;留痕', {
  ports: { 'anomaly.config': [ANOM(), ANOM({ window_min: 10, cooldown_min: 30 }), ANOM()] },
  steps: [call('a', 'quality.set_config', { config: { window_min: 3 } }), call('b', 'quality.set_config', { config: { window_min: 7 } }), call('c', 'quality.set_config', { config: { rvol_tiers: [2, 4, 8], market_adjust: true } }),
    call('d', 'quality.set_config', { config: { rvol_tiers: [1, 2] } }), call('e', 'quality.set_config', { config: { burst_ratio: 0 } }), call('f', 'quality.set_config', { config: { market_adjust: 'yes' } }),
    call('g', 'quality.set_config', { config: { cooldown_min: '15' } }), call('h', 'quality.set_config', { config: { spike_sigma: null, bogus: 1 } }), call('i', 'quality.set_config', { config: {} }),
    call('j', 'quality.set_config', { config: [1] }), call('k', 'quality.set_config', {}), call('l', 'quality.set_config', { config: { day_fixed_tiers: [3, 5, 'x'] } })],
});

// ---- alerts
add('alerts.list:先跑迁移;监控行 / 碰均线口径 / 穿越确认方式原样', {
  ports: { 'alerts.listWatches': [{ value: [{ id: 'w1', symbol: 'NVDA' }] }, { value: [] }], 'alerts.touchConfig': [TOUCH(), TOUCH({ enabled: false, periods: [20] })], 'alerts.crossConfirm': [{ value: 'immediate' }, { value: 'bar_close' }] },
  steps: [call('a', 'alerts.list'), call('b', 'alerts.list')],
});
add('alerts.create:步长怎么读(缺省 / 数 / 数字串 / 0 / 不成数 / 越界 / 负)、origin 只认 tracker、重复、留痕', {
  steps: [call('a', 'alerts.create', { symbol: 'iren', step: 5 }), call('b', 'alerts.create', { symbol: 'IREN' }), call('c', 'alerts.create', { symbol: 'nvda' }), call('d', 'alerts.create', { symbol: 'amd', step: '2.5', origin: 'tracker' }),
    call('e', 'alerts.create', { symbol: 'tsla', step: 0, origin: 'ui' }), call('f', 'alerts.create', { symbol: 'aapl', step: 'abc' }), call('g', 'alerts.create', { symbol: 'msft', step: 1001 }), call('h', 'alerts.create', { symbol: 'goog', step: -1 }),
    call('i', 'alerts.create', { symbol: 'meta', step: 1000, origin: 'tracker' }), call('j', 'alerts.create', { symbol: 'bad$' }), call('k', 'alerts.create', { symbol: 'x'.repeat(13) }), call('l', 'alerts.create', { symbol: 'amzn', step: '' }),
    call('m', 'alerts.create', { symbol: 'nflx', step: ' 7 ' }), call('n', 'alerts.create', {})],
});
add('alerts.delete:找不到 / 去空白 / 删掉', {
  steps: [st('addWatch', ['NVDA', 0]), call('a', 'alerts.delete', { id: 'nope' }), call('b', 'alerts.delete', { id: ' 00000000-0000-4000-8000-000000000002\n' }), call('c', 'alerts.delete', { id: '00000000-0000-4000-8000-000000000002' }), call('d', 'alerts.delete', {})],
});
add('alerts.refresh / poll:原样转给 service(入参过 schema),回执原样回,错照抛', {
  ports: { 'alerts.refresh': [{ value: { watch: { id: 'w' } } }, { error: '重算失败' }, { error: '没有这个警告', kind: 'rpc', code: -32602 }], 'alerts.poll': [{ value: { fired: [] } }, { error: '轮询失败' }] },
  steps: [call('a', 'alerts.refresh', { id: 'w1' }), call('b', 'alerts.refresh', { id: 'w1', expiry: '2026-10-16', step: '5' }), call('c', 'alerts.refresh', { id: 'w1', step: true }), call('d', 'alerts.refresh', { id: 'w1' }), call('e', 'alerts.refresh', { id: 'w1' }),
    call('f', 'alerts.refresh', {}), call('g', 'alerts.poll'), call('h', 'alerts.poll')],
});
add('alerts.set_touch_config:口径合并 / 不合规;穿越确认方式单独改或搭车;认不出的拒在落任何东西之前', {
  ports: { 'alerts.touchConfig': [TOUCH()], 'alerts.crossConfirm': [{ value: 'immediate' }, { value: 'immediate' }, { value: 'bar_close' }] },
  steps: [call('a', 'alerts.set_touch_config', { config: { enabled: false } }), call('b', 'alerts.set_touch_config', { config: { periods: [10, 30], window_days: 5 } }),
    call('c', 'alerts.set_touch_config', { config: {}, cross_confirm: 'bar_close' }), call('d', 'alerts.set_touch_config', { config: {}, cross_confirm: 'bar_close' }), call('e', 'alerts.set_touch_config', { config: { band_pct: 0.5 }, cross_confirm: 'immediate' }),
    call('f', 'alerts.set_touch_config', { config: {}, cross_confirm: 'whenever' }), call('g', 'alerts.set_touch_config', { config: {}, cross_confirm: null }), call('h', 'alerts.set_touch_config', { config: {}, cross_confirm: 5 }),
    call('i', 'alerts.set_touch_config', { config: { periods: [1] } }), call('j', 'alerts.set_touch_config', { config: { periods: [] } }), call('k', 'alerts.set_touch_config', { config: { enabled: 'x' } }),
    call('l', 'alerts.set_touch_config', { config: { min_touches: 11 } }), call('m', 'alerts.set_touch_config', { config: { window_days: 2 } }), call('n', 'alerts.set_touch_config', { config: { band_pct: 'wide' } }),
    call('o', 'alerts.set_touch_config', { config: {} }), call('p', 'alerts.set_touch_config', {}), call('q', 'alerts.set_touch_config', { config: { enabled: null, periods: null } }),
    call('r', 'alerts.set_touch_config', { config: { enabled: null }, cross_confirm: 'bar_close' }), call('s', 'alerts.set_touch_config', { config: { bogus: null }, cross_confirm: 'immediate' })],
});

// ---- 固定种子的随机参数
{
  const r = rng(0x517a_11ce);
  const junk = () => r.pick(['', ' ', 'NVDA', 'nvda ', 'bad$', 'x'.repeat(14), 0, 1, -1, 5, 1e9, '7', 'abc', true, false, null, [], [1], {}, { a: 1 }, 'é', '﻿AMD', ' 00000000-0000-4000-8000-000000000002 ']);
  for (let n = 0; n < 40; n += 1) {
    const steps = [];
    for (let i = 0; i < r.int(4); i += 1) steps.push(st('addQualityStock', [r.pick(['NVDA', 'AMD', 'TSLA', 'AAPL']), '']));
    for (let i = 0; i < r.int(3); i += 1) steps.push(st('addWatch', [r.pick(['NVDA', 'AMD', 'IREN']), 0]));
    for (let i = 0; i < 12; i += 1) {
      const m = r.pick(['quality.add', 'quality.update', 'quality.remove', 'quality.set_config', 'alerts.create', 'alerts.delete', 'alerts.set_touch_config', 'quality.list', 'alerts.list']);
      const p = {};
      for (const k of r.pick([['symbol'], ['symbol', 'note'], ['symbol', 'company'], ['id'], ['id', 'enabled'], ['id', 'note'], ['config'], ['config', 'cross_confirm'], ['symbol', 'step'], ['symbol', 'step', 'origin'], []])) p[k] = junk();
      steps.push(call(`c${i}`, m, p));
    }
    scenarios.push({
      name: `随机 ${n}`,
      script: {
        start: START, seed: n + 1, dump: DUMP, steps,
        ports: {
          'anomaly.config': [ANOM()], 'anomaly.monitor': [MONITOR], 'anomaly.metricsOf': [{ value: null }], 'alerts.levelsStatusOf': [{ value: null }], 'alerts.touchConfig': [TOUCH()], 'alerts.crossConfirm': [{ value: 'immediate' }],
          'alerts.listWatches': [{ value: [] }], 'pool.setWatch': [{ value: { symbol: 'X', price_on: false, anomaly_on: false, skipped: [] } }, WATCH_OK('NVDA')],
        },
      },
    });
  }
}

const out = [];
for (const s of scenarios) {
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_quality.json'), text);
console.log(`h2_quality.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
