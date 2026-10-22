// 生成 svc_fillsync.json:engine-ts 的 services/fillSync.ts(原模块现跑)对着真的 BrokerRouter 与脚本驱动的假会话、虚拟钟、真的交易库。
// 场景照 tests/fill-sync.spec.ts(北京午夜翻篇、节流、不重发、断开重连、往回要 7 天……),再加种子固定的随机交错脚本。C++ 一半:tests/tst_svc_fillsync.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_fillsync.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeFactory, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { FillSyncService } = await mods.imp('services/fillSync');

function build(world, host) {
  const svc = new FillSyncService(host);
  return {
    methods: {
      connect: (a) => host.router.connect(a.name).then(() => null),
      tickOnce: (a) => svc.tickOnce(a.now),
      sync: (a) => svc.sync(a.now, a.deep),
    },
    gets: { available: () => svc.available() },
    ops: {
      router: (step) => { host.router = step.v === 'make' ? new mods.broker.BrokerRouter(host.settings, makeFactory(world, host.settings)) : null; },
      start: (step) => svc.start(step.tickMs),
      stop: () => svc.stop(),
    },
    stop: () => svc.stop(),
  };
}

// ---- 数据
const ACCT = 'U1234567';
const START = Date.parse('2026-10-07T23:50:00+08:00');
const stamp = (iso) => iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15).replace(/^(\d{8})-(\d{2})(\d{2})(\d{2})/, '$1-$2:$3:$4');
const SEC = 1000;
function fill(execId, symbol, secType, side, shares, price, time, perm, opt = {}) {
  return {
    contract: { conId: opt.conId ?? 1, symbol, secType, lastTradeDateOrContractMonth: opt.expiry ?? '', strike: opt.strike ?? 0, right: opt.right ?? '', multiplier: opt.multiplier ?? '',
      exchange: 'SMART', currency: 'USD', tradingClass: opt.tradingClass ?? '' },
    execution: { execId, time: stamp(time), acctNumber: ACCT, side, shares, price, permId: perm, orderId: 0, orderRef: '' },
  };
}
const put = (strike) => ({ expiry: '20261007', strike, right: 'P', multiplier: '100', tradingClass: 'SPXW', conId: strike });
const STOCK = [
  fill('s1', 'TTWO', 'STK', 'BOT', 5, 202.48, '2026-10-07T13:50:23+00:00', 11),
  fill('s2', 'TTWO', 'STK', 'BOT', 15, 202.4795, '2026-10-07T13:50:23+00:00', 11),
];
const FLY = [
  fill('f0', 'SPX', 'BAG', 'BOT', 1, 4.25, '2026-10-07T15:59:06+00:00', 22),
  fill('f1', 'SPX', 'OPT', 'BOT', 1, 8.58, '2026-10-07T15:59:06+00:00', 22, put(7790)),
  fill('f2', 'SPX', 'OPT', 'SLD', 2, 2.55, '2026-10-07T15:59:06+00:00', 22, put(7770)),
  fill('f3', 'SPX', 'OPT', 'BOT', 1, 0.77, '2026-10-07T15:59:06+00:00', 22, put(7750)),
];
const held = (conId, position, extra = {}) => ({ contract: { conId, account: ACCT }, position, avgCost: 0, ...extra });
const H0 = [held(6478131, 20)];
const rows = (r, extra = {}) => ({ rows: r, ...extra });
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const sess = (over = {}) => ({ name: 'S', accounts: [ACCT], caps: ['Executions', 'ExecutionHistory'], positions: [rows(H0)], executions: [rows(STOCK)], history: [rows([])], ...over });
const base = [{ op: 'router', v: 'make' }, call('c', 'connect', { name: 'live' })];

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, factory: { live: ['S'] }, dump: ['audit_log', 'broker_fills'], ...script } });

add('那次真机上的事:午夜前 54 秒买的蝴蝶,不用打开交易分析也进了库;TWS 翻篇之后它还在', {
  sessions: [sess({ history: [rows([])] })],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    call('t1', 'tickOnce', { now: 20 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows([...H0, held(101, 1), held(102, -2), held(103, 1)])], executions: [rows([...STOCK, ...FLY])] } },
    call('t2', 'tickOnce', { now: 25 * SEC }),
    { op: 'sess', session: 'S', set: { executions: [rows([])] } },
    call('t3', 'tickOnce', { now: 45 * SEC }),
    call('s1', 'sync', { now: 2 * 3600 * SEC }),
    { op: 'get', what: 'available' },
  ],
});
add('持仓变了之后要两次:头一次要的时候,分几笔成交的后面几笔还没出来', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { positions: [rows([...H0, held(101, 1)])], executions: [rows([...STOCK, FLY[1]])] } },
    call('t1', 'tickOnce', { now: 30 * SEC }),
    { op: 'sess', session: 'S', set: { executions: [rows([...STOCK, ...FLY])] } },
    call('t2', 'tickOnce', { now: 35 * SEC }),
    call('t3', 'tickOnce', { now: 46 * SEC }),
    call('t4', 'tickOnce', { now: 70 * SEC }),
  ],
});
add('持仓没变也隔几分钟要一次;几秒内买进又卖出的指纹看不出来', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { executions: [rows([...STOCK, fill('d1', 'NVO', 'STK', 'BOT', 10, 65, '2026-10-07T14:00:00+00:00', 31), fill('d2', 'NVO', 'STK', 'SLD', 10, 65.2, '2026-10-07T14:00:03+00:00', 32)])] } },
    call('t1', 'tickOnce', { now: 5 * 60 * SEC - SEC }),
    call('t2', 'tickOnce', { now: 5 * 60 * SEC }),
    call('t3', 'tickOnce', { now: 5 * 60 * SEC + 1 }),
  ],
});
add('持仓读不到的那几轮不当成变了,定时那一路照旧', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { positions: [{ error: 'TWS 在 8 秒内没有推送持仓,本轮读不到持仓' }] } },
    call('t1', 'tickOnce', { now: 30 * SEC }),
    call('t2', 'tickOnce', { now: 5 * 60 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows(H0)] } },
    call('t3', 'tickOnce', { now: 5 * 60 * SEC + 30 * SEC }),
  ],
});
add('断开时不动;重连回来先要一次', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { connected: false } },
    { op: 'get', what: 'available' },
    call('t1', 'tickOnce', { now: 60 * SEC }),
    call('s1', 'sync', { now: 61 * SEC }),
    { op: 'sess', session: 'S', set: { connected: true, executions: [rows([...STOCK, ...FLY])] } },
    call('t2', 'tickOnce', { now: 90 * SEC }),
  ],
});
add('连接反复断开时不跟着一遍遍去要:节流不因为断开清零', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    ...[2, 7, 12].flatMap((t) => [
      { op: 'sess', session: 'S', set: { connected: false } }, call(`d${t}`, 'tickOnce', { now: t * SEC }),
      { op: 'sess', session: 'S', set: { connected: true } }, call(`u${t}`, 'tickOnce', { now: (t + 1) * SEC }),
    ]),
    call('t16', 'tickOnce', { now: 16 * SEC }),
  ],
});
add('没有 router / router 上没有会话:什么都不做', {
  sessions: [sess()],
  steps: [
    { op: 'get', what: 'available' }, call('a', 'tickOnce', { now: 0 }), call('b', 'sync', { now: 0 }),
    { op: 'router', v: 'make' }, { op: 'get', what: 'available' }, call('c1', 'tickOnce', { now: 1 * SEC }),
    call('c', 'connect', { name: 'live' }), { op: 'get', what: 'available' }, call('d', 'tickOnce', { now: 2 * SEC }),
    { op: 'router', v: 'null' }, { op: 'get', what: 'available' }, call('e', 'sync', { now: 3 * SEC }),
  ],
});
add('离上一次不到 15 秒不再要;同一时刻的两次只发一次,拿到同一个结果', {
  sessions: [sess({ executions: [rows(STOCK, { delay: 50 })] })],
  steps: [...base,
    call('a', 'sync', { now: 0 }), call('b', 'sync', { now: 0 }),
    { op: 'advance', ms: 100 },
    call('c', 'sync', { now: 14999 }), call('d', 'sync', { now: 15000 }),
    { op: 'advance', ms: 100 },
  ],
});
add('券商报错:这一次作罢、留一条痕,过了节流再来;同一句报错不反复留痕', {
  sessions: [sess({ executions: [{ error: 'Not connected' }] })],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 5 * SEC }), call('t2', 'tickOnce', { now: 20 * SEC }),
    { op: 'sess', session: 'S', set: { executions: [rows(STOCK)] } },
    call('t3', 'tickOnce', { now: 40 * SEC }),
    { op: 'sess', session: 'S', set: { executions: [{ error: 'Not connected' }] } },
    call('t4', 'sync', { now: 60 * SEC }),
    { op: 'sess', session: 'S', set: { executions: [{ error: 'Other' }] } },
    call('t5', 'sync', { now: 80 * SEC }), call('t6', 'sync', { now: 100 * SEC }),
  ],
});
add('券商不答:等满时限就作罢,后面的同步不被它堵住', {
  sessions: [sess({ executions: [{ hang: true }] })],
  steps: [...base,
    call('stuck', 'sync', { now: 0 }),
    { op: 'advance', ms: 9999 }, { op: 'advance', ms: 1 },
    { op: 'sess', session: 'S', set: { executions: [rows(STOCK)] } },
    call('after', 'sync', { now: 30 * SEC }),
  ],
});
add('券商答得慢但赶在时限里;晚到的结果归晚到', {
  sessions: [sess({ executions: [rows(STOCK, { delay: 9999 })] })],
  steps: [...base, call('a', 'sync', { now: 0 }), { op: 'advance', ms: 9998 }, { op: 'advance', ms: 5 }, call('b', 'sync', { now: 20 * SEC })],
});
add('往回要 7 天:软件没开着时买的蝴蝶 TWS 已翻篇,刚连上那一趟往回要,和当天要到的同一笔不重复存', {
  sessions: [sess({ history: [rows([...STOCK, ...FLY])] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 5 * 60 * SEC }), call('t2', 'tickOnce', { now: 10 * 60 * SEC })],
});
add('往回要:平时不要,持仓变了的两趟、每小时一次才要', {
  sessions: [sess()],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 5 * 60 * SEC }), call('t2', 'tickOnce', { now: 10 * 60 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows([...H0, held(101, 1)])] } },
    call('t3', 'tickOnce', { now: 11 * 60 * SEC }), call('t4', 'tickOnce', { now: 11 * 60 * SEC + 20 * SEC }),
    call('t5', 'tickOnce', { now: 20 * 60 * SEC }), call('t6', 'tickOnce', { now: 72 * 60 * SEC }),
  ],
});
add('往回要没要到:当天的照存,留一条痕,下一趟再要;同一句原因不反复留痕,要到了就清', {
  sessions: [sess({ history: [{ error: '往回要成交的连接被 TWS 关了:326 Unable to connect as the client id is already in use.' }] })],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 5 * 60 * SEC }),
    { op: 'sess', session: 'S', set: { history: [rows(FLY)] } },
    call('t2', 'tickOnce', { now: 10 * 60 * SEC }), call('t3', 'tickOnce', { now: 15 * 60 * SEC }),
    { op: 'sess', session: 'S', set: { history: [{ error: 'x' }] } },
    call('t4', 'sync', { now: 20 * 60 * SEC, deep: true }),
  ],
});
add('往回要一直不回话:等满时限作罢,当天的照存', {
  sessions: [sess({ history: [{ hang: true }] })],
  steps: [...base, call('p', 'tickOnce', { now: 0 }), { op: 'advance', ms: 10000 }, call('q', 'tickOnce', { now: 5 * 60 * SEC })],
});
add('TWS 太老给不了:这次连接里不再试;重连之后再试一次', {
  sessions: [sess({ history: [rows(null)] })],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { positions: [rows([...H0, held(101, 1)])] } },
    call('t1', 'tickOnce', { now: 60 * SEC }), call('t2', 'tickOnce', { now: 80 * SEC }), call('t3', 'tickOnce', { now: 3 * 3600 * SEC }),
    { op: 'sess', session: 'S', set: { connected: false } }, call('t4', 'tickOnce', { now: 3 * 3600 * SEC + 20 * SEC }),
    { op: 'sess', session: 'S', set: { connected: true } }, call('t5', 'tickOnce', { now: 3 * 3600 * SEC + 40 * SEC }),
  ],
});
add('人点「同步成交」:这一趟连前 7 天一起要;正赶上节流就记着,循环的下一趟补上', {
  sessions: [sess({ history: [rows([]), rows(FLY)] })],
  steps: [...base,
    call('t0', 'tickOnce', { now: 0 }),
    call('s1', 'sync', { now: 1 * SEC, deep: true }),
    call('t1', 'tickOnce', { now: 20 * SEC }),
    call('t2', 'tickOnce', { now: 60 * SEC }),
    call('s2', 'sync', { now: 90 * SEC, deep: true }),
  ],
});
add('没有往回要的会话(没有 ExecutionHistory 能力):不要,historyOff 也不置', {
  sessions: [sess({ caps: ['Executions'] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 5 * 60 * SEC }), call('t2', 'sync', { now: 10 * 60 * SEC, deep: true })],
});
add('两个会话(两个连接):持仓指纹合起来;其中一个读不到整轮读不到;成交各自要', {
  sessions: [sess(), sess({ name: 'P', accounts: ['DU7654321'], positions: [rows([held(9, 3, { account: 'DU7654321' })])], executions: [rows([fill('p1', 'AAPL', 'STK', 'BOT', 1, 200, '2026-10-07T14:00:00+00:00', 5)])], history: [rows([])] })],
  factory: { live: ['S'], paper: ['P'] },
  steps: [{ op: 'router', v: 'make' }, call('c', 'connect', { name: 'live' }), call('c2', 'connect', { name: 'paper' }),
    call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'P', set: { positions: [{ error: 'no pos' }] } },
    call('t1', 'tickOnce', { now: 30 * SEC }),
    { op: 'sess', session: 'P', set: { positions: [rows([held(9, 4, { account: 'DU7654321' })])] } },
    call('t2', 'tickOnce', { now: 60 * SEC }), call('t3', 'tickOnce', { now: 100 * SEC })],
});
add('指纹:没有 conId 的按合约描述认;账户号在持仓项上也认;数量 0 的不算', {
  sessions: [sess({ positions: [rows([
    { contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: '20261007', strike: 7750, right: 'P' }, position: 1, avgCost: 0, account: ACCT },
    { contract: { symbol: 'AAA', secType: 'STK' }, position: 0, avgCost: 0 },
    { contract: { conId: 5 }, position: '__NaN__', avgCost: 0 }])] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { positions: [rows([{ contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: '20261007', strike: 7770, right: 'P' }, position: 1, avgCost: 0, account: ACCT }])] } },
    call('t1', 'tickOnce', { now: 30 * SEC }), call('t2', 'tickOnce', { now: 70 * SEC }), call('t3', 'tickOnce', { now: 120 * SEC })],
});
add('循环:start 之后按虚拟钟每 tick 一轮,默认 performance.now;stop 之后不再跑;再 start 换了节拍', {
  sessions: [sess()],
  steps: [...base,
    { op: 'start', tickMs: 5000 }, { op: 'start', tickMs: 1 },
    { op: 'advance', ms: 5000 }, { op: 'advance', ms: 5000 },
    { op: 'sess', session: 'S', set: { positions: [rows([...H0, held(101, 1)])], executions: [rows([...STOCK, ...FLY])] } },
    { op: 'advance', ms: 5000 }, { op: 'advance', ms: 5000 }, { op: 'advance', ms: 5000 },
    { op: 'stop' }, { op: 'advance', ms: 60000 },
    { op: 'start', tickMs: 3000 }, { op: 'advance', ms: 10000 }, { op: 'stop' },
  ],
});
add('循环:一轮还在等券商时 stop,回来之后不再排下一轮', {
  sessions: [sess({ executions: [rows(STOCK, { delay: 4000 })] })],
  steps: [...base, { op: 'start', tickMs: 1000 }, { op: 'advance', ms: 1500 }, { op: 'stop' }, { op: 'advance', ms: 10000 }],
});

add('往回要:离上一次往回要满一小时(恰好)的那一趟就要;差一毫秒不要', {
  sessions: [sess()],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }), call('t1', 'tickOnce', { now: 3600000 - 1 }), call('t2', 'tickOnce', { now: 3600000 + 20000 }), call('t3', 'tickOnce', { now: 7200000 + 20000 }), call('t4', 'tickOnce', { now: 10800000 + 20000 })],
});
add('断开重连之后头一回读到持仓不算「变了」(忘掉旧指纹);重连后没变就不再要', {
  sessions: [sess()],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { connected: false } }, call('t1', 'tickOnce', { now: 60 * SEC }),
    { op: 'sess', session: 'S', set: { connected: true, positions: [rows([...H0, held(101, 1)])] } },
    call('t2', 'tickOnce', { now: 90 * SEC }), call('t3', 'tickOnce', { now: 120 * SEC }), call('t4', 'tickOnce', { now: 150 * SEC })],
});
add('指纹:数量 0 的、持仓项的先后、数量是 NaN 的,都不算变', {
  sessions: [sess({ positions: [rows([held(1, 20), held(2, -3)])] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }),
    { op: 'sess', session: 'S', set: { positions: [rows([held(1, 20), held(2, -3), held(9, 0)])] } }, call('t1', 'tickOnce', { now: 30 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows([held(2, -3), held(1, 20)])] } }, call('t2', 'tickOnce', { now: 60 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows([held(2, -3), held(1, 20), held(7, '__NaN__')])] } }, call('t3', 'tickOnce', { now: 90 * SEC }),
    { op: 'sess', session: 'S', set: { positions: [rows([held(2, -3), held(1, 21)])] } }, call('t4', 'tickOnce', { now: 120 * SEC })],
});

add('指纹:只换了 conId(数量不变)也是变了', {
  sessions: [sess({ positions: [rows([held(1, 20)])] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }), { op: 'sess', session: 'S', set: { positions: [rows([held(2, 20)])] } }, call('t1', 'tickOnce', { now: 30 * SEC }), call('t2', 'tickOnce', { now: 60 * SEC })],
});
add('往回要出错:同一句原因再出错要重新留痕(成功过一趟就清)', {
  sessions: [sess({ history: [{ error: 'E1' }, rows([]), { error: 'E1' }, { error: 'E1' }] })],
  steps: [...base, call('t0', 'tickOnce', { now: 0 }), call('s1', 'sync', { now: 20 * SEC, deep: true }), call('s2', 'sync', { now: 40 * SEC, deep: true }), call('s3', 'sync', { now: 60 * SEC, deep: true })],
});

// ---- 种子固定的随机交错
{
  const r = rng(0x5eed_f111);
  const execPool = [...STOCK, ...FLY, fill('x1', 'NVO', 'STK', 'BOT', 3, 65, '2026-10-08T01:00:00+00:00', 41), fill('x2', 'NVO', 'STK', 'SLD', 3, 65.5, '2026-10-08T01:00:03+00:00', 42), fill('x3', 'AAPL', 'STK', 'BOT', 3, 210, '2026-10-08T01:10:03+00:00', 43)];
  const posPool = [H0, [...H0, held(101, 1)], [...H0, held(101, 1), held(102, -2)], [], [held(7, 5)]];
  const sub = () => execPool.filter(() => r.chance(0.5));
  const execResult = () => {
    const p = r.next();
    if (p < 0.12) return { error: r.pick(['Not connected', 'boom', 'timeout?']) };
    if (p < 0.2) return { hang: true };
    return rows(sub(), r.chance(0.3) ? { delay: r.pick([1, 50, 3000, 9000, 10001]) } : {});
  };
  const posResult = () => (r.chance(0.12) ? { error: 'no positions' } : rows(r.pick(posPool), r.chance(0.2) ? { delay: r.pick([10, 500]) } : {}));
  const histResult = () => {
    const p = r.next();
    if (p < 0.1) return { error: r.pick(['326 client id in use', '往回要出错']) };
    if (p < 0.18) return { hang: true };
    if (p < 0.3) return rows(null);
    return rows(sub(), r.chance(0.3) ? { delay: r.pick([5, 2000, 10001]) } : {});
  };
  for (let n = 0; n < 60; n += 1) {
    const caps = r.chance(0.85) ? ['Executions', 'ExecutionHistory'] : ['Executions'];
    const two = r.chance(0.25);
    const sessions = [sess({ caps, positions: [posResult()], executions: [execResult()], history: [histResult()] })];
    const factory = { live: ['S'] };
    if (two) {
      sessions.push(sess({ name: 'P', accounts: ['DU7654321'], caps, positions: [posResult()], executions: [execResult()], history: [histResult()] }));
      factory.paper = ['P'];
    }
    const steps = [{ op: 'router', v: 'make' }, call('c', 'connect', { name: 'live' })];
    if (two) steps.push(call('c2', 'connect', { name: 'paper' }));
    let t = 0;
    for (let i = 0; i < 26; i += 1) {
      const p = r.next();
      const names = two ? ['S', 'P'] : ['S'];
      if (p < 0.30) { t += r.pick([1, 1000, 5000, 14000, 16000, 60000, 300000, 3600000]); steps.push(call(`t${i}`, 'tickOnce', r.chance(0.7) ? { now: t } : {})); }
      else if (p < 0.40) { t += r.pick([0, 1, 20000]); steps.push(call(`s${i}`, 'sync', { now: t, deep: r.chance(0.3) })); }
      else if (p < 0.52) steps.push({ op: 'advance', ms: r.pick([1, 100, 2000, 9999, 10001, 20000]) });
      else if (p < 0.60) steps.push({ op: 'sess', session: r.pick(names), set: { positions: Array.from({ length: 1 + r.int(2) }, posResult) } });
      else if (p < 0.70) steps.push({ op: 'sess', session: r.pick(names), set: { executions: Array.from({ length: 1 + r.int(2) }, execResult) } });
      else if (p < 0.78) steps.push({ op: 'sess', session: r.pick(names), set: { history: Array.from({ length: 1 + r.int(2) }, histResult) } });
      else if (p < 0.88) steps.push({ op: 'sess', session: r.pick(names), set: { connected: r.chance(0.5) } });
      else if (p < 0.92) steps.push({ op: 'start', tickMs: r.pick([1000, 5000, 20000]) });
      else if (p < 0.95) steps.push({ op: 'stop' });
      else steps.push({ op: 'get', what: 'available' });
    }
    steps.push({ op: 'stop' }, { op: 'advance', ms: 30000 });
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, factory, sessions, steps, dump: ['audit_log', 'broker_fills'] } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_fillsync.json'), text);
console.log(`svc_fillsync.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
