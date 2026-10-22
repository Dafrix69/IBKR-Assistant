// 生成 account_feeds.json:engine-ts 的 accountFeeds.ts(原模块现跑):账户当日盈亏与净值,哪条会话管这个账号、是不是美元、旧不旧。
// 会话是脚本驱动的假会话(execsupport_world.mjs)。C++ 一半:tests/tst_account_feeds.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_account_feeds.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, rng } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/accountFeeds.js')).href);
const { World, tickerKey } = await loadWorld(engine);
const NOW = Date.parse('2026-10-12T09:40:00-04:00');

async function run(script) {
  const world = new World(script, tickerKey);
  const steps = [];
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (!world.commonStep(step)) {
        const list = step.sessions.map((n) => world.session(n));
        if (step.op === 'daily') rec.result = X.accountDailyPnl(list, step.account, step.now);
        else if (step.op === 'netLiqRead') rec.result = X.accountNetLiquidation(list, step.account);
        else throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      steps.push(rec);
    }
    return { log: world.log, steps };
  } finally {
    world.restore();
  }
}

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: NOW, events: [], ...script } });
const pnl = (daily, currency = 'USD', atMs = NOW, extra = {}) => ({ daily, unrealized: 1, realized: 2, currency, atMs, ...extra });
const caps = ['AccountPnl', 'NetLiquidation'];

add('当日盈亏:美元、新鲜、有值才给', {
  sessions: [{ name: 'A', connected: true, accounts: ['U1'], caps, pnl: { U1: pnl(-123.45) }, netLiq: { U1: { amount: 50000, currency: 'USD' } } }],
  steps: [
    { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 60000 },
    { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 60001 },
    { op: 'daily', sessions: ['A'], account: 'U2', now: NOW },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(null) }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(5, 'EUR') }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(0) }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(NaN) }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(7, 'USD', NaN) }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 99999 },
    { op: 'setPnl', session: 'A', account: 'U1', v: null }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
  ],
});
add('净值:美元且为正才给', {
  sessions: [{ name: 'A', connected: true, accounts: ['U1'], caps, netLiq: { U1: { amount: 50000, currency: 'USD' } } }],
  steps: [
    { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'netLiqRead', sessions: ['A'], account: 'U2' },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: 0, currency: 'USD' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: -5, currency: 'USD' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: 5, currency: 'HKD' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: NaN, currency: 'USD' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: 0.01, currency: 'USD' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
  ],
});
add('币种不是美元:有值也不给(HKD / 空串 / 小写 usd),恰好 60 秒边界', {
  sessions: [{ name: 'A', connected: true, accounts: ['U1'], caps, pnl: { U1: pnl(10, 'HKD') }, netLiq: { U1: { amount: 5, currency: 'HKD' } } }],
  steps: [
    { op: 'daily', sessions: ['A'], account: 'U1', now: NOW }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(10, '') }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: 5, currency: '' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(10, 'usd') }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
    { op: 'setNetLiq', session: 'A', account: 'U1', v: { amount: 5, currency: 'usd' } }, { op: 'netLiqRead', sessions: ['A'], account: 'U1' },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(10, 'USD') },
    { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 59999 }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 60000 }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW + 60001 },
    { op: 'setPnl', session: 'A', account: 'U1', v: pnl(null, 'HKD') }, { op: 'daily', sessions: ['A'], account: 'U1', now: NOW },
  ],
});
add('哪条会话管:连着的、报了这个账号的第一条;会话没有这个方法就不调', {
  sessions: [
    { name: 'A', connected: false, accounts: ['U1'], caps, pnl: { U1: pnl(1) }, netLiq: { U1: { amount: 1, currency: 'USD' } } },
    { name: 'B', connected: true, accounts: ['U2'], caps, pnl: { U1: pnl(2), U2: pnl(22) }, netLiq: { U1: { amount: 2, currency: 'USD' }, U2: { amount: 22, currency: 'USD' } } },
    { name: 'C', connected: true, accounts: ['U1', 'U2'], caps: [], pnl: { U1: pnl(3) } },
    { name: 'D', connected: true, accounts: ['U1'], caps: ['AccountPnl'], pnl: { U1: pnl(4) } },
    { name: 'E', connected: true, accounts: ['U1'], caps: ['NetLiquidation'], netLiq: { U1: { amount: 5, currency: 'USD' } } },
  ],
  steps: [
    { op: 'daily', sessions: ['A', 'B', 'C', 'D', 'E'], account: 'U1', now: NOW },
    { op: 'daily', sessions: ['A', 'B', 'C', 'D', 'E'], account: 'U2', now: NOW },
    { op: 'netLiqRead', sessions: ['A', 'B', 'C', 'D', 'E'], account: 'U1' },
    { op: 'netLiqRead', sessions: ['D', 'E'], account: 'U1' },
    { op: 'daily', sessions: ['E'], account: 'U1', now: NOW },
    { op: 'netLiqRead', sessions: ['D'], account: 'U1' },
    { op: 'daily', sessions: [], account: 'U1', now: NOW },
    { op: 'connected', session: 'A', v: true }, { op: 'daily', sessions: ['A', 'B'], account: 'U1', now: NOW },
  ],
});
{
  const r = rng(0xacc0_f00d);
  for (let n = 0; n < 40; n += 1) {
    const num = () => r.pick([0, 1, -1, 123.45, -9999.5, 1e9, NaN, 0.01]);
    const sessions = ['A', 'B', 'C'].map((nm) => ({
      name: nm, connected: r.chance(0.75), accounts: r.pick([[], ['U1'], ['U1', 'U2'], ['U2']]),
      caps: ['AccountPnl', 'NetLiquidation', 'QuoteDelayed'].filter(() => r.chance(0.8)),
      pnl: { U1: r.chance(0.2) ? null : pnl(r.chance(0.15) ? null : num(), r.pick(['USD', 'USD', 'EUR', 'HKD']), NOW - r.pick([0, 1, 59999, 60000, 60001, 200000, -5000])),
        U2: pnl(num()) },
      netLiq: { U1: r.chance(0.2) ? null : { amount: num(), currency: r.pick(['USD', 'USD', 'EUR']) }, U2: { amount: 10, currency: 'USD' } },
    }));
    const steps = [];
    for (let i = 0; i < 12; i += 1) {
      const subset = ['A', 'B', 'C'].filter(() => r.chance(0.7));
      if (r.chance(0.5)) steps.push({ op: 'daily', sessions: subset, account: r.pick(['U1', 'U2', 'U3']), now: NOW + r.pick([0, 59999, 60000, 60001, 120000, -1]) });
      else if (r.chance(0.7)) steps.push({ op: 'netLiqRead', sessions: subset, account: r.pick(['U1', 'U2', 'U3']) });
      else steps.push({ op: 'connected', session: r.pick(['A', 'B', 'C']), v: r.chance(0.5) });
    }
    add(`随机 ${n}`, { sessions, steps });
  }
}

const out = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) out[i].expected = enc(await run(scenarios[i].script));
const text = JSON.stringify({ scenarios: out });
writeFileSync(join(here, 'account_feeds.json'), text);
console.log(`account_feeds.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
