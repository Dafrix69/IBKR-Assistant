// 生成 svc_assignment.json:engine-ts 的 services/assignmentWatch.ts(原模块现跑)对着脚本驱动的假 router、真的交易库(审计)、虚拟钟。
// C++ 一半:tests/tst_svc_assignment.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_assignment.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { AssignmentWatchService } = await mods.imp('services/assignmentWatch');

function build(world, host) {
  const svc = new AssignmentWatchService(host);
  return {
    methods: { tickOnce: (a) => svc.tickOnce(a.at) },
    gets: { inWindow: (a) => svc.inWindow(a.at) },
    ops: { start: (step) => svc.start(step.tickMs), stop: () => svc.stop() },
    stop: () => svc.stop(),
  };
}

const ET = (iso) => Date.parse(iso);
const START = ET('2026-10-12T15:40:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const E = (error, extra = {}) => ({ error, ...extra });
const at = (date, minutes) => ({ epochMs: 0, date, minutes, seconds: 0 });
const leg = (symbol, strike, right, qty, expiry = '20261012', extra = {}) => ({
  key: `主账户|${symbol}|OPT|${strike}${right}`, account: '主账户', symbol, sec_type: 'OPT', leg: '', quantity: qty, multiplier: 100, label: `${symbol} ${strike}${right}`,
  contract: { symbol, secType: 'OPT', lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100' }, ...extra,
});
const ROWS = [leg('AAPL', 230, 'C', -2), leg('AAPL', 225, 'C', 1), leg('AAPL', 210, 'P', -1), leg('NVDA', 220, 'P', -3), leg('TSLA', 250, 'C', -1, '20261016'),
  leg('SPX', 7700, 'P', -1), { ...leg('MSFT', 400, 'C', 0), quantity: 0 }, { ...leg('QQQ', 500, 'X', -1) }, { ...leg('IWM', 0, 'C', -1) }, { key: 'k', account: '主账户', symbol: 'AAPL', sec_type: 'STK', quantity: 100 }];
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log'], ...script } });
const quotes = (o) => R(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { last: v }])));

add('在窗口里:有价就报在实值里的空头腿(净变动算上自动行权的多头腿),同一条腿只说一次;没价说一次「看一眼」;有了价再说一次', {
  router: { results: { positions: [R(ROWS)], streamQuotes: [quotes({ AAPL: 232, NVDA: 230 }), quotes({}), quotes({ AAPL: 232, NVDA: 215 }), E('流断了'), quotes({ AAPL: 232, NVDA: 215 })] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce'), call('b', 'tickOnce'), { op: 'advance', ms: 60000 }, call('c', 'tickOnce'), call('d', 'tickOnce'), call('e', 'tickOnce'), call('f', 'tickOnce')],
});
add('不在窗口里 / 没连 / 没有会话 / 读不到持仓 / 没有空头腿:都是 0', {
  start: ET('2026-10-12T14:00:00-04:00'),
  router: { results: { positions: [E('读不到'), R([leg('AAPL', 230, 'C', 2)]), R(ROWS)], streamQuotes: [quotes({ AAPL: 232 })] } },
  steps: [call('o', 'tickOnce'), { op: 'advance', ms: 100 * 60000 }, call('n', 'tickOnce'), { op: 'port', v: 'make' }, { op: 'portSet', set: { sessions: 0 } }, call('s', 'tickOnce'), { op: 'portSet', set: { sessions: 1 } },
    call('p1', 'tickOnce'), call('p2', 'tickOnce'), call('p3', 'tickOnce', { at: at('2026-10-12', 15 * 60 + 29) }), call('p4', 'tickOnce', { at: at('2026-10-12', 16 * 60) })],
});
add('inWindow:提前收盘日按 13:00;边界', {
  steps: [{ op: 'get', what: 'inWindow', a: { at: at('2026-11-27', 12 * 60 + 29) } }, { op: 'get', what: 'inWindow', a: { at: at('2026-11-27', 12 * 60 + 30) } }, { op: 'get', what: 'inWindow', a: { at: at('2026-11-27', 13 * 60) } },
    { op: 'get', what: 'inWindow', a: { at: at('2026-10-12', 15 * 60 + 30) } }, { op: 'get', what: 'inWindow', a: { at: at('2026-10-12', 16 * 60 - 0.5) } }],
});
add('换了一天清空已说过的;同一天两个账户各自的腿', {
  router: { results: { positions: [R([...ROWS, { ...leg('AAPL', 230, 'C', -2), account: '副账户', key: '副账户|AAPL|OPT|230C' }])], streamQuotes: [quotes({ AAPL: 232, NVDA: 230 })] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce', { at: at('2026-10-12', 15 * 60 + 40) }), call('b', 'tickOnce', { at: at('2026-10-12', 15 * 60 + 41) }), call('c', 'tickOnce', { at: at('2026-10-13', 15 * 60 + 40) })],
});
add('换了一天清空已说过的:同样的键、次日到期的腿,再说一次', {
  router: { results: { positions: [R(ROWS), R(ROWS.map((r) => (r.contract ? { ...r, contract: { ...r.contract, lastTradeDateOrContractMonth: '20261013' } } : r)))], streamQuotes: [quotes({ AAPL: 232, NVDA: 215 })] } },
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce', { at: at('2026-10-12', 15 * 60 + 40) }), call('b', 'tickOnce', { at: at('2026-10-13', 15 * 60 + 40) }), call('c', 'tickOnce', { at: at('2026-10-13', 15 * 60 + 41) })],
});
add('循环:start 之后每 tickMs 一轮;stop;再 start', {
  router: { results: { positions: [R(ROWS)], streamQuotes: [quotes({ AAPL: 232, NVDA: 215 })] } },
  steps: [{ op: 'port', v: 'make' }, { op: 'start', tickMs: 60000 }, { op: 'start', tickMs: 5 }, { op: 'advance', ms: 60000 }, { op: 'advance', ms: 120000 }, { op: 'stop' }, { op: 'advance', ms: 120000 }, { op: 'start', tickMs: 1000 }, { op: 'advance', ms: 3000 }, { op: 'stop' }],
});
{
  const r = rng(0xa551_6e0f);
  for (let n = 0; n < 40; n += 1) {
    const rows = ROWS.filter(() => r.chance(0.8));
    const results = {
      positions: Array.from({ length: 3 }, () => (r.chance(0.15) ? E('读不到') : R(rows, r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}))),
      streamQuotes: Array.from({ length: 4 }, () => (r.chance(0.2) ? E('断') : r.chance(0.2) ? R(null) : quotes({ AAPL: r.pick([232, 200, 0]), NVDA: r.pick([230, 215, 'x']), TSLA: 260 }))),
    };
    const steps = [{ op: 'port', v: r.chance(0.9) ? 'make' : 'null' }];
    for (let i = 0; i < 14; i += 1) {
      const p = r.next();
      if (p < 0.45) steps.push(call(`t${i}`, 'tickOnce', r.chance(0.4) ? { at: at(r.pick(['2026-10-12', '2026-10-13', '2026-11-27']), r.pick([14 * 60, 12 * 60 + 40, 15 * 60 + 35, 15 * 60 + 59])) } : {}));
      else if (p < 0.75) steps.push({ op: 'advance', ms: r.pick([1, 60000, 600000, 3600000]) });
      else if (p < 0.82) steps.push({ op: 'start', tickMs: r.pick([1000, 60000]) });
      else if (p < 0.88) steps.push({ op: 'stop' });
      else if (p < 0.94) steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]) } });
      else steps.push({ op: 'port', v: r.pick(['make', 'null']) });
    }
    steps.push({ op: 'stop' });
    scenarios.push({ name: `随机 ${n}`, script: { start: r.pick([START, ET('2026-10-12T15:20:00-04:00'), ET('2026-11-27T12:40:00-05:00')]), seed: n + 1, dump: ['audit_log'], router: { results, spotInfo: {} }, steps } });
  }
}
const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_assignment.json'), text);
console.log(`svc_assignment.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
