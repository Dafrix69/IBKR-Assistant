// 生成 h2_market.json:engine-ts 的 MarketHandlers(rpc/handlers/market.ts,原类现跑)对着 h2_world.mjs 的假 RpcContext。
// C++ 一半:tests/tst_h2_market.cpp(tests/h2_world.h 的同一份脚本)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_h2_market.mjs <编过的 engine-ts 目录>
// 公开源(macro.board 没连券商那一支)走 ports["fetch.get"] 的替身,不联网。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadH2 } from './h2_world.mjs';
import { rng } from './broker_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const h2 = await loadH2(engine);

const START = Date.parse('2026-10-12T10:32:00-04:00'); // 周一
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const router = (v = 'make') => ({ op: 'h2router', v });
const routerSet = (set) => ({ op: 'h2routerSet', set });
const scenarios = [];
const wrapHttp = (script) => {
  const f = script.ports?.['fetch.get'];
  if (f) script.ports['fetch.get'] = f.map((r) => (r.__http ? { value: r } : r));
  return script;
};
const add = (name, script) => scenarios.push({ name, script: wrapHttp({ start: START, dump: ['audit_log', 'signal_log'], ...script }) });

// ---- K 线:美东墙钟。趋势 + 回撤的波形,足够 analyze 找出摆动与突破
const pad = (n) => String(n).padStart(2, '0');
const SEC = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };
function prevWeekday(d) { do { d = new Date(d.getTime() - 86_400_000); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); return d; }
/** 以 endDate(UTC 日期的 00:00 当作美东日历日)那天 endMin(分钟)为最后一根的起点,往回数 n 根。session: 'ext' 04:00–20:00,'rth' 09:30–16:00 */
function barTimes(tf, n, session, endDate = '2026-10-12', endMin = 10 * 60 + 25) {
  const out = [];
  let day = new Date(`${endDate}T00:00:00Z`);
  if (tf === '1d') {
    for (let i = 0; i < n; i += 1) { out.push(`${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`); day = prevWeekday(day); }
    return out.reverse();
  }
  const step = SEC[tf] / 60;
  const lo = session === 'ext' ? 4 * 60 : 9 * 60 + 30;
  const hi = session === 'ext' ? 20 * 60 : 16 * 60;
  let m = endMin;
  while (out.length < n) {
    out.push(`${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    m -= step;
    if (m < lo) { day = prevWeekday(day); m = hi - step; }
  }
  return out.reverse();
}
function makeBars(tf, n, seed, { base = 450, session = 'ext', trend = 0.02, wave = 1.2, endDate, endMin, vol = 1000 } = {}) {
  const r = rng(seed);
  const times = barTimes(tf, n, session, endDate, endMin);
  let prev = base;
  return times.map((time, i) => {
    const target = base + trend * i * 10 + wave * 6 * Math.sin(i / 4.5) + wave * 2 * Math.sin(i / 1.7);
    const close = Math.round((target + (r.next() - 0.5) * wave) * 100) / 100;
    const open = prev;
    const high = Math.round((Math.max(open, close) + r.next() * wave * 0.6) * 100) / 100;
    const low = Math.round((Math.min(open, close) - r.next() * wave * 0.6) * 100) / 100;
    prev = close;
    return { time, open, high, low, close, volume: Math.round(vol * (0.5 + r.next())) };
  });
}
const T0 = START;
const pab = (bars, o = {}) => ({ value: { bars, cached: false, askedAt: T0 - 1500, feed: 'live', proxy: null, ...o } });
const PROXY = { futures: 'ES 202612', derived: 18, note: 'SPX 盘外按 ES 202612 推算(基差 +12.5)', spans: [{ from: '2026-10-12 04:00', to: '2026-10-12 09:25' }] };
const UP = (tf, n = 80, seed = 7, o = {}) => makeBars(tf, n, seed, { trend: 0.06, wave: 1.0, ...o });
const DOWN = (tf, n = 80, seed = 9, o = {}) => makeBars(tf, n, seed, { trend: -0.06, wave: 1.0, ...o });
const COMMENT = { summary: '结构偏多', reading: '价格在 BOS 之上整理', watch: ['盯住 450.5 支撑'], risks: ['跌破 449 则失效'] };

// ---- book.snapshot
add('book.snapshot:没连券商 → -32014;代码不合法先挡;连着:盘口原样回', {
  h2router: { sessions: 1, results: { orderBook: [{ value: { symbol: 'AAPL', bid: 1, ask: 2, levels: [] } }, { value: { symbol: 'X' } }] } },
  steps: [call('a', 'book.snapshot', { symbol: 'AAPL' }), call('b', 'book.snapshot', { symbol: 'bad$' }), call('b2', 'book.snapshot', { symbol: '' }), router(),
    call('c', 'book.snapshot', { symbol: '  aapl ' }), call('d', 'book.snapshot', { symbol: 'brk.b' }), call('e', 'book.snapshot', { symbol: 'TOOLONGSYMBOL1' }), call('f', 'book.snapshot', {}), call('g', 'book.snapshot', { symbol: 5 }), router('null'), call('h', 'book.snapshot', { symbol: 'AAPL' })],
});
add('book.snapshot:BrokerError 包成 -32014 原话;别的错照抛;全断了(0 个会话)→ -32014', {
  h2router: { sessions: 1, results: { orderBook: [{ error: '没有 Level 2 权限', kind: 'broker' }, { error: 'boom' }, { error: '带码', kind: 'rpc', code: -32009 }, { value: { ok: 1 } }] } },
  steps: [router(), call('a', 'book.snapshot', { symbol: 'AAPL' }), call('b', 'book.snapshot', { symbol: 'AAPL' }), call('c', 'book.snapshot', { symbol: 'AAPL' }), call('d', 'book.snapshot', { symbol: 'MSFT' }),
    routerSet({ sessions: 0 }), call('e', 'book.snapshot', { symbol: 'AAPL' })],
});

// ---- options.wall
add('options.wall:symbol 先过 SYMBOL_RE;expiry 去空白空串 = null;width 的各种取法', {
  ports: { 'market.wallFor': [{ value: { spot: 7000, rows: [] } }, { value: null }, { error: '期权链取不到', kind: 'broker' }, { error: 'boom' }] },
  steps: [call('a', 'options.wall', { symbol: 'SPY' }), call('b', 'options.wall', { symbol: ' spy ', expiry: ' 20261016 ', width: 7 }), call('c', 'options.wall', { symbol: 'SPY', expiry: '   ', width: '7.9' }),
    call('d', 'options.wall', { symbol: 'SPY', width: -3.7 }), call('e', 'options.wall', { symbol: 'SPY', width: 'abc' }), call('f', 'options.wall', { symbol: 'SPY', width: '' }), call('g', 'options.wall', { symbol: 'SPY', width: true }),
    call('h', 'options.wall', { symbol: 'bad$' }), call('i', 'options.wall', {}), call('j', 'options.wall', { symbol: 'SPY', expiry: null }), call('k', 'options.wall', { symbol: 'SPY', width: 0.5 }), call('l', 'options.wall', { symbol: 'SPY', width: 1e21 }), call('m', 'options.wall', { symbol: 'SPY', width: null })],
});

// ---- options.fly_plan / spot
add('options.fly_plan:symbol 缺省 SPX、空串也是 SPX、转大写;不合法 -32602;整份入参(含 symbol)递给 planner', {
  ports: { 'flyPlanner.planFor': [{ value: { ok: 1 } }, { value: { ok: 2 } }, { error: '没有期权链', kind: 'broker' }, { value: { ok: 4 } }] },
  steps: [call('a', 'options.fly_plan', { center: 7000, width: 10 }), call('b', 'options.fly_plan', { symbol: '', center: 7000, width: 10 }), call('c', 'options.fly_plan', { symbol: ' spy ', expiry: '20261016', center: 450, width: 5, right: 'C', iv: 0.2 }),
    call('d', 'options.fly_plan', { symbol: 'bad$', center: 1, width: 1 }), call('e', 'options.fly_plan', { symbol: '   ', center: 1, width: 1 }), call('f', 'options.fly_plan', { center: 'x', width: 1 }), call('g', 'options.fly_plan', { symbol: 'SPX' }),
    call('h', 'options.fly_plan', { symbol: 'qqq', center: 400, width: 5, iv_mode: 'flat', spot: 401.5, extra: 1 }), call('i', 'options.fly_plan', { center: 7000, width: 10, iv_mode: 'nope' })],
});
add('options.spot:只认配置里的指数;缺省 SPX;不合法与非指数同一句话', {
  ports: { 'flyPlanner.spotFor': [{ value: { symbol: 'SPX', last: 7001.5 } }, { value: { symbol: 'VIX', last: 18 } }, { error: '行情不通', kind: 'broker' }] },
  steps: [call('a', 'options.spot', {}), call('b', 'options.spot', { symbol: 'vix' }), call('c', 'options.spot', { symbol: ' SPX ' }), call('d', 'options.spot', { symbol: '' }), call('e', 'options.spot', { symbol: 'AAPL' }),
    call('f', 'options.spot', { symbol: 'bad$' }), call('g', 'options.spot', { symbol: 'NDX' }), call('h', 'options.spot', { symbol: 5 }), call('i', 'options.spot', { symbol: 'SPX', x: 1 }), call('j', 'options.spot', { symbol: null })],
});
add('options.spot:配置里加了 NDX 就认;SPX 删不掉但改名后的指数仍按配置', {
  settings: { index_symbols: { NDX: { exchange: 'NASDAQ', daily_trading_class: 'NDXP', monthly_trading_class: 'NDX' } } },
  ports: { 'flyPlanner.spotFor': [{ value: { symbol: 'NDX', last: 25000 } }] },
  steps: [call('a', 'options.spot', { symbol: 'NDX' }), call('b', 'options.spot', { symbol: 'RUT' })],
});

// ---- iv recorder / playbook
add('options.iv_recorder / playbook:状态原样回;set 只收布尔(strict)', {
  ports: { 'ivRecorder.status': [{ value: { enabled: false, samples: 0 } }, { error: 'boom' }], 'ivRecorder.setEnabled': [{ value: { enabled: true } }, { value: { enabled: false } }],
    'playbook.snapshot': [{ value: { enabled: true, bands: [] } }], 'playbook.setEnabled': [{ value: { enabled: false } }, { error: '剧本出错' }] },
  steps: [call('a', 'options.iv_recorder'), call('b', 'options.iv_recorder'), call('c', 'options.iv_recorder_set', { enabled: true }), call('d', 'options.iv_recorder_set', { enabled: false }), call('e', 'options.iv_recorder_set', { enabled: 1 }),
    call('f', 'options.iv_recorder_set', {}), call('g', 'options.iv_recorder_set', { enabled: true, x: 1 }), call('h', 'options.playbook'), call('i', 'options.playbook_set', { enabled: false }), call('j', 'options.playbook_set', { enabled: true }),
    call('k', 'options.playbook_set', { enabled: 'yes' }), call('l', 'options.playbook', { x: 1 })],
});

// ---- pa.timeframes
add('pa.timeframes:周期表原样排,htf 为空写 null,min_interval 15', { steps: [call('a', 'pa.timeframes'), call('b', 'pa.timeframes', { x: 1 })] });

// ---- pa.analyze
const sp = (extra) => ({ h2router: { sessions: 1 }, ...extra });
add('pa.analyze:没连券商 -32015;代码与周期先挡(在检查连接之前)', {
  steps: [call('a', 'pa.analyze', { symbol: 'AAPL' }), call('b', 'pa.analyze', { symbol: 'bad$' }), call('c', 'pa.analyze', { symbol: 'AAPL', timeframe: '3m' }), call('d', 'pa.analyze', { symbol: 'AAPL', timeframe: '' }),
    call('e', 'pa.analyze', {}), call('f', 'pa.analyze', { symbol: 'AAPL', timeframe: '1d' }), router(), call('g', 'pa.analyze', { symbol: 'AAPL', timeframe: 'xx' }), call('h', 'pa.analyze', { symbol: 'AAPL', timeframe: 5 }), routerSet({ sessions: 0 }), call('i', 'pa.analyze', { symbol: 'AAPL' })],
  h2router: { sessions: 1 },
});
add('pa.analyze:个股 5m 默认全时段,高周期 1h 成功;信号落库一次(第二次同段不重记)', sp({
  ports: { 'market.paBars': [pab(UP('5m')), pab(UP('1h', 60, 3, { endMin: 10 * 60 })), pab(UP('5m'), { cached: true }), pab(UP('1h', 60, 3, { endMin: 10 * 60 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL' }), call('b', 'pa.analyze', { symbol: 'aapl', timeframe: '5m', rth: false, force: true })],
}));
add('pa.analyze:个股 rth 真(rth 各种真值),盘外不算;高周期取不到只吞', sp({
  ports: { 'market.paBars': [pab(DOWN('5m', 80, 11, { session: 'rth' })), { error: '高周期没数据', kind: 'broker' }, pab(DOWN('5m', 80, 11, { session: 'rth' })), pab(DOWN('1h', 60, 5, { session: 'rth', endMin: 10 * 60 })),
    pab(DOWN('5m', 80, 11, { session: 'rth' })), { error: 'boom' }] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'MSFT', rth: true }), call('b', 'pa.analyze', { symbol: 'MSFT', rth: 'false' }), call('c', 'pa.analyze', { symbol: 'MSFT', rth: 1 })],
}));
add('pa.analyze:rth 的取法 null / undefined / 0 / "" / [] / {}', sp({
  ports: { 'market.paBars': [pab(UP('15m', 70, 21), { feed: 'delayed' }), pab(UP('1h', 60, 5), { feed: 'unknown' })] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', rth: null }), call('b', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', rth: 0 }), call('c', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', rth: '' }),
    call('d', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', rth: [] }), call('e', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', rth: {} }), call('f', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', force: 0 }), call('g', 'pa.analyze', { symbol: 'NVDA', timeframe: '15m', force: 'x' })],
}));
add('pa.analyze:日线(没有高周期,只取一次);个股日线 extendedSession 真但 intraday 假', sp({
  ports: { 'market.paBars': [pab(UP('1d', 90, 31, { endMin: 0 }), { feed: null })] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL', timeframe: '1d' })],
}));
add('pa.analyze:SPX 指数 + 期货推算(proxy 有、derived>0)→ off_hours proxy,warnings 追加 note', sp({
  ports: { 'market.paBars': [pab(UP('5m', 80, 41, { base: 7000, wave: 8 }), { proxy: PROXY }), pab(UP('1h', 60, 42, { base: 7000, wave: 8 }), { proxy: { ...PROXY, derived: 4, note: '1h 推算' } }),
    pab(UP('5m', 80, 41, { base: 7000, wave: 8 }), { proxy: { ...PROXY, derived: 0, note: '没有对得上的期货 K 线' } }), pab(UP('1h', 60, 42, { base: 7000, wave: 8 })), pab(UP('5m', 80, 43, { base: 7000, wave: 8 })), pab(UP('1h', 60, 42, { base: 7000, wave: 8 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'SPX' }), call('b', 'pa.analyze', { symbol: 'spx', rth: false }), call('c', 'pa.analyze', { symbol: 'SPX' })],
}));
add('pa.analyze:SPX rth 真(off_hours none,没有指数警告);SPX 日线无警告', sp({
  ports: { 'market.paBars': [pab(UP('5m', 80, 51, { base: 7000, wave: 8, session: 'rth' })), pab(UP('1h', 60, 52, { base: 7000, wave: 8, session: 'rth' })), pab(UP('1d', 70, 53, { base: 7000, wave: 30, endMin: 0 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'SPX', rth: true }), call('b', 'pa.analyze', { symbol: 'SPX', timeframe: '1d' })],
}));
add('pa.analyze:配置里 SPX 没有期货 → 指数警告一条(无 proxy)', sp({
  settings: { index_symbols: { SPX: { futures: '', futures_exchange: '' } } },
  ports: { 'market.paBars': [pab(UP('5m', 80, 61, { base: 7000, wave: 8 })), pab(UP('1h', 60, 62, { base: 7000, wave: 8 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'SPX' })],
}));
add('pa.analyze:VIX(指数,配置里没期货)15m;非配置指数 NDX 当个股', sp({
  ports: { 'market.paBars': [pab(UP('15m', 70, 71, { base: 18, wave: 0.3 })), pab(UP('1h', 60, 72, { base: 18, wave: 0.3 })), pab(UP('15m', 70, 73, { base: 25000, wave: 40 })), pab(UP('1h', 60, 74, { base: 25000, wave: 40 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'VIX', timeframe: '15m' }), call('b', 'pa.analyze', { symbol: 'NDX', timeframe: '15m' })],
}));
add('pa.analyze:K 线取不到 / 根数不够 / 别的错 → 前两种 -32015 原话,第三种照抛', sp({
  ports: { 'market.paBars': [{ error: '请求超频(pacing violation)', kind: 'broker' }, pab(UP('5m', 10, 81)), { error: 'unexpected', kind: 'plain' }, { error: '带码', kind: 'rpc', code: -32009 }, pab(UP('5m', 80, 7)), pab(UP('1h', 60, 3, { endMin: 10 * 60 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL' }), call('b', 'pa.analyze', { symbol: 'AAPL' }), call('c', 'pa.analyze', { symbol: 'AAPL' }), call('d', 'pa.analyze', { symbol: 'AAPL' }), call('e', 'pa.analyze', { symbol: 'AAPL' })],
}));
add('pa.analyze:高周期根数不够 → 吞掉,htf null', sp({
  ports: { 'market.paBars': [pab(DOWN('30m', 80, 91)), pab(DOWN('1d', 10, 92, { endMin: 0 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'TSLA', timeframe: '30m' })],
}));
add('pa.analyze:1m / 2m 周期各取 htf 15m / 30m', sp({
  ports: { 'market.paBars': [pab(UP('1m', 120, 101)), pab(UP('15m', 60, 102)), pab(UP('2m', 100, 103)), pab(UP('30m', 60, 104))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AMD', timeframe: '1m' }), call('b', 'pa.analyze', { symbol: 'AMD', timeframe: '2m' })],
}));
// 信号日志:early_close_days 影响进场段起点
const bull = (extra) => sp({
  ports: { 'market.paBars': [pab(UP('5m', 90, 7, { endDate: '2026-11-27', endMin: 12 * 60 + 55 })), pab(UP('1h', 60, 3, { endDate: '2026-11-27', endMin: 12 * 60 })), pab(UP('5m', 90, 7, { endDate: '2026-11-27', endMin: 12 * 60 + 55 })), pab(UP('1h', 60, 3, { endDate: '2026-11-27', endMin: 12 * 60 }))] },
  ...extra,
});
add('pa.analyze:信号日志 since 取决于 early_close_days(11-27 半天市,13:30 收盘后)', {
  ...bull({ start: Date.parse('2026-11-27T13:30:00-05:00') }),
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL' }), { op: 'advance', ms: 60_000 }, call('b', 'pa.analyze', { symbol: 'AAPL', force: true })],
});
add('pa.analyze:early_close_days 清空 → 11-27 当整天', {
  ...bull({ start: Date.parse('2026-11-27T13:30:00-05:00'), settings: { early_close_days: [] } }),
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL' })],
});
add('pa.analyze:周末 / 假日 start(信号 since 跳到上一个交易日)', {
  ...sp({ start: Date.parse('2026-10-17T11:00:00-04:00'), ports: { 'market.paBars': [pab(UP('5m', 90, 7, { endDate: '2026-10-16', endMin: 15 * 60 + 55 })), pab(UP('1h', 60, 3, { endDate: '2026-10-16', endMin: 15 * 60 }))] } }),
  steps: [router(), call('a', 'pa.analyze', { symbol: 'AAPL' })],
});
add('pa.analyze:中性读数不记信号(平盘)', sp({
  ports: { 'market.paBars': [pab(makeBars('5m', 80, 5, { trend: 0, wave: 0.8 })), pab(makeBars('1h', 60, 6, { trend: 0, wave: 0.8 }))] },
  steps: [router(), call('a', 'pa.analyze', { symbol: 'KO' })],
}));

// ---- pa.comment
add('pa.comment:先 paResult 再调模型;成功写审计;model 取配置', sp({
  llm: [{ value: COMMENT }, { value: { summary: '  空白要裁  ' } }],
  ports: { 'market.paBars': [pab(UP('5m')), pab(UP('1h', 60, 3, { endMin: 10 * 60 })), pab(UP('5m')), pab(UP('1h', 60, 3, { endMin: 10 * 60 }))] },
  steps: [router(), call('a', 'pa.comment', { symbol: 'AAPL' }), call('b', 'pa.comment', { symbol: 'AAPL', rth: false })],
}));
add('pa.comment:没连券商 / 代码不合法 → 模型一次不调;模型抛错 / 回包不合 schema → -32016 原话', sp({
  llm: [{ error: '模型限流' }, { value: { reading: 'x' } }, { value: { summary: 'ok', extra: 1 } }, { value: { summary: 'ok', watch: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }, { value: null }, { value: 'text' }, { value: { summary: 5 } }, { value: { summary: 'ok', watch: [1] } }],
  ports: { 'market.paBars': Array.from({ length: 8 }, (_, i) => [pab(UP('5m')), pab(UP('1h', 60, 3, { endMin: 10 * 60 }))]).flat() },
  steps: [call('a', 'pa.comment', { symbol: 'AAPL' }), call('b', 'pa.comment', { symbol: 'bad$' }), router(), call('c', 'pa.comment', { symbol: 'AAPL' }), call('d', 'pa.comment', { symbol: 'AAPL' }), call('e', 'pa.comment', { symbol: 'AAPL' }),
    call('f', 'pa.comment', { symbol: 'AAPL' }), call('g', 'pa.comment', { symbol: 'AAPL' }), call('h', 'pa.comment', { symbol: 'AAPL' }), call('i', 'pa.comment', { symbol: 'AAPL' }), call('j', 'pa.comment', { symbol: 'AAPL' })],
}));
add('pa.comment:K 线取不到 → -32015(模型不调);BrokerError 类模型错也包成 -32016', sp({
  llm: [{ error: '模型 502', kind: 'broker' }],
  ports: { 'market.paBars': [{ error: '没有数据', kind: 'broker' }, pab(UP('5m')), pab(UP('1h', 60, 3, { endMin: 10 * 60 }))] },
  steps: [router(), call('a', 'pa.comment', { symbol: 'AAPL' }), call('b', 'pa.comment', { symbol: 'AAPL' })],
}));
add('pa.comment:指数(SPX)带 proxy,事实文本里含推算说明', sp({
  llm: [{ value: { summary: 'SPX 偏多', reading: '', watch: [], risks: [] } }],
  ports: { 'market.paBars': [pab(UP('5m', 80, 41, { base: 7000, wave: 8 }), { proxy: PROXY }), pab(UP('1h', 60, 42, { base: 7000, wave: 8 }), { proxy: PROXY })] },
  steps: [router(), call('a', 'pa.comment', { symbol: 'SPX' })],
}));

// ---- macro.board
const MQ = { 'IND:SPX@CBOE': { last: 7001.25, change_pct: 0.4 }, 'IND:NDX@NASDAQ': { last: 25100, change_pct: -0.2 }, 'IND:VIX@CBOE': { last: 17.5, change_pct: null }, 'IND:TNX@CBOE': { last: 48.06, change_pct: 0.1 },
  'CONTFUT:GC@COMEX': { last: 4412.5 }, 'CRYPTO:BTC': { last: null } };
const YAHOO = (p, prev) => ({ chart: { result: [{ meta: { regularMarketPrice: p, chartPreviousClose: prev } }] } });
add('macro.board:没连券商 → 全走公开源(取数器替身);force 真假', {
  ports: { 'fetch.get': [{ value: YAHOO(7000, 6950) }, { value: YAHOO(25000, 25100) }, { error: '连接被重置' }, { __http: [429, 'Too Many Requests', ''] }, { value: { data: { current_price: 4400 } } }, { value: YAHOO(4400.5, 4390) }, { value: YAHOO(70.2, 70) }, { value: YAHOO(65000, 64000) }] },
  steps: [call('a', 'macro.board', {}), call('b', 'macro.board', { force: true }), { op: 'advance', ms: 70_000 }, call('c', 'macro.board', { force: false }), call('d', 'macro.board', { force: 'x' }), call('e', 'macro.board', { x: 1 })],
});
add('macro.board:公开源回包不是 JSON / HTTP 错 / 备用 Cboe 救回', {
  ports: { 'fetch.get': [{ __http: [200, 'OK', '<html>被挡了</html>'] }, { value: { data: { current_price: 7001, close: 6990, price_change: 11 } } }, { __http: [403, 'Forbidden', 'x'] }, { value: { data: { current_price: 25100, close: 25000, price_change: 100 } } }, { error: '超时' }, { error: '超时' },
    { __http: [500, '', 'x'] }, { value: { data: { current_price: 17.2, close: 17, price_change: 0.2 } } }, { __http: [200, 'OK', ''] }, { __http: [200, 'OK', '  \n  很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长' ] }] },
  steps: [call('a', 'macro.board', { force: true })],
});
add('macro.board:连着:streamQuotes 回的格走 tws,缺的走公开源;抛错 / 回 null 当没有;0 个会话当没连', {
  h2router: { sessions: 1, results: { streamQuotes: [{ value: MQ }, { error: '行情线路断了' }, { value: null }, { value: {} }, { value: MQ }] } },
  ports: { 'fetch.get': [{ value: YAHOO(1, 1) }] },
  steps: [router(), call('a', 'macro.board', { force: true }), call('b', 'macro.board', { force: true }), call('c', 'macro.board', {}), call('d', 'macro.board', { force: true }), routerSet({ sessions: 0 }), call('e', 'macro.board', { force: true }),
    routerSet({ sessions: 1 }), call('f', 'macro.board', {})],
});
add('macro.board:非强制:缓存命中 / 过期旧值先给后台换新', {
  h2router: { sessions: 1, results: { streamQuotes: [{ value: { 'IND:SPX@CBOE': { last: 7000 } } }] } },
  ports: { 'fetch.get': [{ value: YAHOO(25000, 24900) }, { value: YAHOO(17, 16) }, { value: YAHOO(48, 47) }, { value: YAHOO(4400, 4300) }, { value: YAHOO(70, 69) }, { value: YAHOO(65000, 64000) }] },
  steps: [router(), call('a', 'macro.board', {}), call('b', 'macro.board', {}), { op: 'advance', ms: 30_000 }, call('c', 'macro.board', {}), { op: 'advance', ms: 40_000 }, call('d', 'macro.board', {}), call('e', 'macro.board', { force: true })],
});

// ---- 随机参数
const rand = rng(20261021);
const SYMS = ['AAPL', 'spy', ' msft ', 'SPX', 'vix', 'bad$', '', 'BRK.B', 'NDX', 'qqq', 'x', 'TOOLONGSYMBOL1', 'spx '];
const TFS = [undefined, '1m', '2m', '5m', '15m', '30m', '1h', '1d', 'nope', '', '5M'];
const BOOLS = [undefined, null, true, false, 0, 1, '', 'x', 'false', [], {}];
const WIDTHS = [undefined, 10, 5, 7.9, -2.5, '8', 'abc', '', null, true, 0, 1e3];
const EXPIRIES = [undefined, '20261016', ' 20261016 ', '', '  '];
function barsFor(tf, symbol, sym2) {
  const index = ['SPX', 'VIX'].includes(symbol.trim().toUpperCase());
  const n = rand.chance(0.15) ? 12 : 60 + rand.int(40);
  const session = rand.chance(0.4) ? 'rth' : 'ext';
  const o = { base: index ? 7000 : 100 + rand.int(400), wave: index ? 8 : 1, trend: (rand.next() - 0.5) * 0.14, session, endMin: tf === '1d' ? 0 : 9 * 60 + 40 + 5 * rand.int(10) };
  return makeBars(tf ?? '5m', n, 1000 + sym2, o);
}
for (let k = 0; k < 56; k += 1) {
  const steps = [];
  const ports = { 'market.paBars': [], 'market.wallFor': [{ value: { k } }], 'flyPlanner.planFor': [{ value: { k } }], 'flyPlanner.spotFor': [{ value: { k } }] };
  const llm = [];
  const h2r = { sessions: 1, results: { orderBook: [{ value: { k } }, { error: 'x', kind: 'broker' }], streamQuotes: [{ value: rand.chance(0.5) ? MQ : null }, { error: 'q' }] } };
  const fetchRes = [];
  steps.push(router());
  const nSteps = 3 + rand.int(4);
  for (let i = 0; i < nSteps; i += 1) {
    const id = `s${i}`;
    const which = rand.int(8);
    if (which <= 2) {
      const tf = rand.pick(TFS);
      const symbol = rand.pick(SYMS);
      const p = { symbol };
      if (tf !== undefined) p.timeframe = tf;
      const rth = rand.pick(BOOLS); if (rth !== undefined) p.rth = rth;
      const force = rand.pick(BOOLS); if (force !== undefined) p.force = force;
      const tfName = typeof tf === 'string' && SEC[tf] ? tf : tf === '1d' ? '1d' : '5m';
      const mk = () => (rand.chance(0.12) ? { error: rand.pick(['超频', '没数据']), kind: rand.pick(['broker', 'plain']) } : pab(barsFor(tfName, symbol, k * 10 + i), { feed: rand.pick(['live', 'delayed', 'unknown', null]), proxy: ['SPX'].includes(symbol.trim().toUpperCase()) && rand.chance(0.6) ? PROXY : null, cached: rand.chance(0.3) }));
      ports['market.paBars'].push(mk(), mk());
      if (which === 2) { llm.push(rand.chance(0.6) ? { value: COMMENT } : rand.pick([{ error: '限流' }, { value: { summary: '' } }, { value: { reading: 'x' } }])); steps.push(call(id, 'pa.comment', p)); } else steps.push(call(id, 'pa.analyze', p));
    } else if (which === 3) {
      const p = { symbol: rand.pick(SYMS) }; const w = rand.pick(WIDTHS); if (w !== undefined) p.width = w; const e = rand.pick(EXPIRIES); if (e !== undefined) p.expiry = e;
      steps.push(call(id, 'options.wall', p));
    } else if (which === 4) {
      steps.push(call(id, rand.chance(0.5) ? 'options.spot' : 'book.snapshot', { symbol: rand.pick(SYMS) }));
    } else if (which === 5) {
      const p = { center: 7000 + rand.int(50), width: 5 * (1 + rand.int(4)) }; const s = rand.pick([undefined, 'spx', ' ', 'bad$', 'qqq']); if (s !== undefined) p.symbol = s;
      steps.push(call(id, 'options.fly_plan', p));
    } else if (which === 6) {
      fetchRes.push(...Array.from({ length: 8 }, () => rand.pick([{ value: YAHOO(100 + rand.int(50), 100) }, { error: '断了' }, { __http: [503, 'Unavailable', ''] }, { value: { data: { current_price: 200 + rand.int(9), close: 200 } } }])));
      steps.push(call(id, 'macro.board', { force: rand.pick(BOOLS) }));
    } else {
      steps.push(call(id, rand.pick(['options.iv_recorder', 'options.playbook', 'pa.timeframes']), {}));
    }
    if (rand.chance(0.15)) steps.push(routerSet({ sessions: rand.pick([0, 1]) }));
    if (rand.chance(0.1)) steps.push({ op: 'advance', ms: 1000 * (1 + rand.int(90)) });
  }
  ports['fetch.get'] = fetchRes.length ? fetchRes : [{ value: null }];
  add(`随机 #${k}`, { h2router: h2r, ports, llm: llm.length ? llm : undefined, steps });
}

const out = [];
for (const s of scenarios) {
  const expected = await h2.run(s.script);
  out.push({ name: s.name, script: enc(s.script), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'h2_market.json'), text);
console.log(`h2_market.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
