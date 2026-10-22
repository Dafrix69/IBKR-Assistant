// 生成 handlers1_tracker_ops.json:tracker.update / close_now / poll / reconcile 与追踪锁的先后(钱路径)。C++ 一半:tests/tst_h1_tracker.cpp。
import { Builder, call, finish, setup, SEC } from './gen_handlers1_common.mjs';

const { mods, tk } = await setup();
const b = new Builder(mods, tk);
const stock = (o) => b.stock(o);
const KEY = stock().key;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = (o = {}) => tk.makeTargets(o);
const A = (o = {}) => tk.makeAutoClose(o);
/** 往库里种一条追踪(行的形状同 store.addTrack 的入参) */
const seed = (row, targets, auto = {}, extra = {}) => ({
  op: 'store', m: 'addTrack',
  a: [{ account: row.account, symbol: row.symbol, sec_type: row.sec_type, leg: row.leg ?? '', contract: row.contract, targets, auto_close: auto, peak: row.market_price ?? null, note: '', ...extra }],
});
const patch = (n, fields) => ({ op: 'store', m: 'updateTrack', a: [id(n), fields] });
const REC = (n, final) => [
  { op: 'store', m: 'createRecord', a: [{ id: `rec-${n}`, signature: 's', order: { totalQuantity: 50 }, contract: { symbol: 'BE' }, account: { alias: '模拟', account_id: 'DU7654321' }, llm: { prompt_version: 'v1' }, input: { raw_instruction: 'x' } }] },
  ...(final ? [{ op: 'store', m: 'setFinalStatus', a: [`rec-${n}`, final] }] : []),
];
const rowsOf = (...r) => b.router(r);
const upd = (n, over = {}) => ({ id: id(n), ...over });

// ---------------------------------------------------------------- tracker.update
b.add('tracker.update:没有这个追踪;schema 拒(缺 id / 未知键 / 类型 / auto_close 里的未知键与类型)', {
  router: rowsOf(stock()),
  steps: [
    call('a', 'tracker.update', { id: 'nope', enabled: true }), call('b', 'tracker.update', {}), call('c', 'tracker.update', { id: 'x', stoploss: 1 }),
    call('d', 'tracker.update', { id: 'x', enabled: 'yes' }), call('e', 'tracker.update', { id: 'x', auto_close: { order_type: 'LMT', bogus: 1 } }),
    call('f', 'tracker.update', { id: 'x', auto_close: { slippage_pct: '0.5' } }), call('g', 'tracker.update', { id: 'x', auto_close: { stop_chase_grace: null, stop_chase_step: null, stop_chase_max_pct: null, peak_confirm: 1 } }),
    call('h', 'tracker.update', { id: 'x', take_profit: [1] }),
  ],
});
b.add('tracker.update:只带 id → 没有要改的字段', {
  router: rowsOf(stock()),
  steps: [seed(stock(), T({ stop_loss: 95 })), call('a', 'tracker.update', upd(1))],
});
b.add('tracker.update:enabled false / true;重新启用把上次触发的闩解开', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ stop_loss: 95 })),
    patch(1, { fired_at: '2026-09-11T15:00:00+00:00', fired_state: 'stop_loss', fired_record: 'rec-x', enabled: false }),
    call('a', 'tracker.update', upd(1, { enabled: true })),
    call('b', 'tracker.update', upd(1, { enabled: false })),
    call('c', 'tracker.update', upd(1, { enabled: null })),
  ],
});
b.add('tracker.update:重新启用——分批止盈有一档在等成交:单没有终态 → 拒;已成交 → 这一档做完;撤了 → 解开;记录没有了 → 解开', {
  router: rowsOf(stock()),
  engine: {},
  steps: [
    ...REC(1, null), ...REC(2, 'filled'), ...REC(3, 'cancelled'),
    seed(stock(), T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }, { price: 140, fraction_pct: 50 }] })),
    patch(1, { fired_record: 'rec-1', enabled: false }),
    call('a', 'tracker.update', upd(1, { enabled: true })),
    patch(1, { fired_record: 'rec-2' }), call('b', 'tracker.update', upd(1, { enabled: true })),
    patch(1, { enabled: false, fired_record: 'rec-3', targets: T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }, { price: 140, fraction_pct: 50 }] }) }),
    call('c', 'tracker.update', upd(1, { enabled: true })),
    patch(1, { enabled: false, fired_record: 'gone', targets: T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }] }) }),
    call('d', 'tracker.update', upd(1, { enabled: true })),
    patch(1, { enabled: false, fired_record: '', targets: T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }] }) }),
    call('e', 'tracker.update', upd(1, { enabled: true })),
  ],
});
b.add('tracker.update:重新启用——到点平仓的时刻过了 / 没有 / 还没到', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ stop_loss: 95, exit_at: '15:45', exit_at_ms: Date.parse('2026-09-11T11:00:00-04:00') })),
    seed(stock({ symbol: 'AA', key: tk.makeKey('模拟', 'AA', 'STK'), contract: { secType: 'STK', symbol: 'AA' } }), T({ stop_loss: 95, exit_at: '15:45', exit_at_ms: null })),
    seed(stock({ symbol: 'CC', key: tk.makeKey('模拟', 'CC', 'STK'), contract: { secType: 'STK', symbol: 'CC' } }), T({ stop_loss: 95, exit_at: '15:45', exit_at_ms: Date.parse('2026-09-11T15:45:00-04:00') })),
    seed(stock({ symbol: 'DD', key: tk.makeKey('模拟', 'DD', 'STK'), contract: { secType: 'STK', symbol: 'DD' } }), T({ stop_loss: 95, exit_at: '12:00', exit_at_ms: Date.parse('2026-09-11T12:00:00-04:00') })),
    ...[1, 2, 3, 4].map((n) => patch(n, { enabled: false })),
    call('a', 'tracker.update', upd(1, { enabled: true })), call('b', 'tracker.update', upd(2, { enabled: true })),
    call('c', 'tracker.update', upd(3, { enabled: true })), call('d', 'tracker.update', upd(4, { enabled: true })),
  ],
});
// auto_close 合并
const AUTO = A({ enabled: true, order_type: 'LMT', slippage_pct: 0.5, close_fraction_pct: 50, chase_max_pct: 12 });
b.add('tracker.update:auto_close 是合并,没带的键保持原样;全局字段原样合并', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ stop_loss: 95 }), AUTO),
    call('a', 'tracker.update', upd(1, { auto_close: { close_fraction_pct: 25 } })),
    call('b', 'tracker.update', upd(1, { auto_close: { stop_chase_grace: 2, stop_chase_step: null, peak_confirm: false } })),
    call('c', 'tracker.update', upd(1, { auto_close: {} })),
    call('d', 'tracker.update', upd(1, { auto_close: null })),
    call('e', 'tracker.update', upd(1, { auto_close: { stop_chase_grace: 100 } })),
    call('f', 'tracker.update', upd(1, { auto_close: { stop_basis: 'weird' } })),
    call('g', 'tracker.update', upd(1, { auto_close: { enabled: false } })),
  ],
});
b.add('tracker.update:auto_close——托管需要先开自动平仓;只关自动平仓而托管留着也拒', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ stop_loss: 95 }), A({ enabled: false })),
    call('a', 'tracker.update', upd(1, { auto_close: { host_at_broker: true } })),
    call('b', 'tracker.update', upd(1, { auto_close: { host_at_broker: true, enabled: true } })),
    call('c', 'tracker.update', upd(1, { auto_close: { enabled: false } })),
  ],
});
b.add('tracker.update:auto_close 托管——富途账户拒;分批止盈已设 → 拒', {
  settings: { connections: { fut: { broker: 'futu', host: '127.0.0.1', port: 11111 } }, accounts: [{ alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true }, { alias: '富途模拟', account_id: '8801234', is_paper: true, connection: 'fut' }] },
  router: rowsOf(stock(), stock({ account: '富途模拟', key: tk.makeKey('富途模拟', 'BE', 'STK') })),
  steps: [
    seed(stock({ account: '富途模拟', key: tk.makeKey('富途模拟', 'BE', 'STK') }), T({ stop_loss: 95 }), A({ enabled: true })),
    seed(stock({ symbol: 'AA', key: tk.makeKey('模拟', 'AA', 'STK'), contract: { secType: 'STK', symbol: 'AA' } }), T({ take_profit_tiers: [{ price: 130, fraction_pct: 50 }] }), A({ enabled: true })),
    call('a', 'tracker.update', upd(1, { auto_close: { host_at_broker: true } })),
    call('b', 'tracker.update', upd(2, { auto_close: { host_at_broker: true } })),
  ],
});
const FOPROW = b.leg(5000, 'C', 1, 3000, 35, { secType: 'FOP', symbol: 'ES' });
b.add('tracker.update:auto_close 打开时拼不出平仓单的持仓(FOP)→ 拒', {
  router: rowsOf(FOPROW),
  steps: [seed(FOPROW, T({ stop_loss: 25 }), A({ enabled: false })), call('a', 'tracker.update', upd(1, { auto_close: { enabled: true } }))],
});
// 止损口径变了
const OPT = b.leg(7400, 'C', 2, 3000, 32.5, { row: { model_iv: 0.18 } });
b.add('tracker.update:止损口径换成可成交价——峰值按新口径重新起步;通道没有买卖价 → 拒;止损价不在保护侧 → 拒', {
  router: { sessions: 1, optionQuotes: true, results: { positions: [{ value: [OPT] }] } },
  engine: { results: { naturalCloseFor: [{ value: 31 }, { value: 31 }, { value: null }] } },
  steps: [
    seed(OPT, T({ stop_loss: 25 }), A({ enabled: false })),
    call('a', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
    call('b', 'tracker.update', upd(1, { auto_close: { stop_basis: 'mid' } })),
    patch(1, { targets: T({ stop_loss: 31.5 }) }),
    call('c', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
    patch(1, { targets: T({ stop_loss: 25 }) }),
    call('d', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
    { op: 'routerSet', set: { optionQuotes: false } },
    call('e', 'tracker.update', upd(1, { auto_close: { stop_basis: 'mid' } })),
    call('f', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
  ],
});
b.add('tracker.update:止损口径换了但持仓不在了 → 拒;正股换成可成交价 → 拒', {
  router: rowsOf(),
  steps: [
    seed(stock(), T({ stop_loss: 95 }), A({ enabled: false })),
    call('a', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
    { op: 'routerSet', set: { results: { positions: [{ value: [stock()] }] } } },
    call('b', 'tracker.update', upd(1, { auto_close: { stop_basis: 'natural' } })),
  ],
});
// 目标
const TARGET_CASES = [
  ['take_profit', { take_profit: '140' }], ['stop_loss', { stop_loss: '95' }], ['trail_pct', { trail_pct: '5' }], ['profit_drawdown_pct', { profit_drawdown_pct: '30' }],
  ['profit_drawdown_tiers', { stop_loss: '95', profit_drawdown_tiers: [{ above: '0', pct: '40' }, { above: '1', pct: '30' }] }],
  ['profit_drawdown_preset', { stop_loss: '95', profit_drawdown_preset: 'fly' }], ['profit_drawdown_arm_pct', { profit_drawdown_pct: '30', profit_drawdown_arm_pct: '20' }],
  ['spot_target', { spot_target: '130' }], ['spot_stop_confirm_s', { stop_loss: '95', spot_stop_confirm_s: '5' }], ['exit_at', { stop_loss: '95', exit_at: '15:45' }],
  ['take_profit_tiers', { take_profit_tiers: [{ price: '130', fraction_pct: '50' }, { price: '140', fraction_pct: '50' }] }],
  ['spot_stop_below(正股不收)', { stop_loss: '95', spot_stop_below: '100' }], ['spot_stop_above(正股不收)', { stop_loss: '95', spot_stop_above: '200' }],
];
for (const [label, over] of TARGET_CASES) {
  b.add(`tracker.update:目标字段 ${label} 单独出现就整体重算校验`, {
    router: rowsOf(stock()),
    engine: { results: { 'sessionEm.today': [{ value: 45 }] } },
    steps: [seed(stock(), T({ take_profit: 150, stop_loss: 90, trail_pct: 4 }), A({ enabled: true })), call('a', 'tracker.update', upd(1, over))],
  });
}
b.add('tracker.update:exit_at 单独出现也算给了目标(其余清空 → 没有目标被拒)', {
  router: rowsOf(stock()),
  steps: [seed(stock(), T({ stop_loss: 90 }), A({})), call('a', 'tracker.update', upd(1, { exit_at: '15:45' })), call('b', 'tracker.update', upd(1, { exit_at: '' }))],
});
b.add('tracker.update:键在但值是 null / "" 也算"给了目标"(清掉其余);只有 null 一个键 → 目标全空被拒', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ take_profit: 150, stop_loss: 90 }), A({})),
    call('a', 'tracker.update', upd(1, { take_profit: null })),
    call('b', 'tracker.update', upd(1, { take_profit: null, stop_loss: '95' })),
    call('c', 'tracker.update', upd(1, { take_profit: '', stop_loss: '96', exit_at: null })),
    call('d', 'tracker.update', upd(1, { stop_loss: '97', exit_at: '' })),
    call('e', 'tracker.update', upd(1, { enabled: false, note: 'x' })),
  ],
});
b.add('tracker.update:校验次序——数不出来先于方向;spot_target 夹在 profit_drawdown 与 spot_stop 之间', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ stop_loss: 90 }), A({})),
    call('a', 'tracker.update', upd(1, { spot_target: 'zz', take_profit: 'abc' })),
    call('b', 'tracker.update', upd(1, { take_profit: 'abc', spot_target: 'zz' })),
    call('c', 'tracker.update', upd(1, { profit_drawdown_pct: 'x', spot_target: 'zz' })),
    call('d', 'tracker.update', upd(1, { spot_target: 'zz', spot_stop_below: 'y' })),
    call('e', 'tracker.update', upd(1, { stop_loss: '130' })),
    call('f', 'tracker.update', upd(1, { take_profit: '140', spot_target: '130' })),
  ],
});
b.add('tracker.update:分批止盈有一档在等成交时不改目标(改目标之外的字段不受影响)', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }, { price: 140, fraction_pct: 50 }] }), A({ enabled: true })),
    call('a', 'tracker.update', upd(1, { stop_loss: '95' })),
    call('b', 'tracker.update', upd(1, { auto_close: { close_fraction_pct: 30 } })),
    call('c', 'tracker.update', upd(1, { enabled: true })),
  ],
});
b.add('tracker.update:分批止盈档位没变时做完的记号带过去', {
  router: rowsOf(stock()),
  steps: [
    seed(stock(), T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, done: true }, { price: 140, fraction_pct: 50 }] }), A({ enabled: true })),
    call('a', 'tracker.update', upd(1, { take_profit_tiers: [{ price: '130', fraction_pct: '50' }, { price: '140', fraction_pct: '50' }] })),
    call('b', 'tracker.update', upd(1, { take_profit_tiers: [{ price: '131', fraction_pct: '50' }, { price: '140', fraction_pct: '50' }] })),
    call('c', 'tracker.update', upd(1, { take_profit_tiers: '', stop_loss: '95' })),
  ],
});
b.add('tracker.update:改目标时持仓不在了 → 拒;没连券商 → 拒', {
  router: rowsOf(),
  steps: [
    seed(stock(), T({ stop_loss: 95 }), A({})),
    call('a', 'tracker.update', upd(1, { stop_loss: '96' })),
    { op: 'router', v: 'null' }, call('b', 'tracker.update', upd(1, { stop_loss: '96' })),
    call('c', 'tracker.update', upd(1, { enabled: false })),
  ],
});
b.add('tracker.update:期权追踪的标的止损 / 到点平仓 / 标的目标价与托管', {
  router: { sessions: 1, results: { positions: [{ value: [OPT] }], 'indexPrice:SPX': [{ value: 7490 }] } },
  engine: { results: { 'sessionEm.today': [{ value: 45 }] } },
  steps: [
    seed(OPT, T({ stop_loss: 25 }), A({ enabled: true })),
    call('a', 'tracker.update', upd(1, { stop_loss: '25', spot_stop_below: '7500' })),
    call('b', 'tracker.update', upd(1, { stop_loss: '25', spot_stop_below: '7400', spot_stop_confirm_s: '10' })),
    call('c', 'tracker.update', upd(1, { stop_loss: '25', exit_at: '16:30' })),
    call('d', 'tracker.update', upd(1, { spot_target: '7520' })),
    call('e', 'tracker.update', upd(1, { stop_loss: '25', auto_close: { host_at_broker: true } })),
  ],
});
const FLY = b.fly({ row: { model_iv: 0.2 } });
const FKEY = b.bagKey(FLY);
b.add('tracker.update:组合托管需要标的目标价', {
  router: { sessions: 1, results: { positions: [{ value: FLY }], 'indexPrice:SPX': [{ value: 7490 }] } },
  engine: { results: { 'sessionEm.today': [{ value: 45 }], naturalCloseFor: [{ value: null }] } },
  steps: [
    seed({ ...tk.withCombos(FLY).find((r) => r.sec_type === 'BAG') }, T({ stop_loss: 10 }), A({ enabled: true, host_at_broker: true })),
    call('a', 'tracker.update', upd(1, { stop_loss: '10' })),
    call('b', 'tracker.update', upd(1, { spot_target: '7525' })),
  ],
});

// ---------------------------------------------------------------- tracker.close_now
const closeSettings = { policies: { auto_execute: true, allow_live_trading: true } };
const eng = (over = {}) => ({ results: { marketStatusFor: [{ value: '盘中' }], accountIsPaper: [{ value: true }], sweepExisting: [{ value: false }], pendingCloseRecord: [{ value: null }], closePosition: [{ value: { id: 'x', symbol: 'BE', state: 'manual', reason: '手动平仓' } }], naturalCloseFor: [{ value: 31 }], ...over } });
b.add('close_now:没有这个追踪 / schema / 持仓不在 / 没连券商', {
  settings: closeSettings, router: rowsOf(), engine: eng(),
  steps: [
    call('a', 'tracker.close_now', { id: 'nope' }), call('b', 'tracker.close_now', {}), call('c', 'tracker.close_now', { id: 'x', fast: true }),
    seed(stock(), T({ stop_loss: 95 }), A({})), call('d', 'tracker.close_now', { id: id(1) }),
    { op: 'router', v: 'null' }, call('e', 'tracker.close_now', { id: id(1) }),
  ],
});
b.add('close_now:正股一键平仓——手动不看"自动平仓"开关;result 里 state=manual、price=现价', {
  settings: closeSettings, router: rowsOf(stock()), engine: eng(),
  steps: [seed(stock(), T({ stop_loss: 95 }), A({ enabled: false, order_type: 'LMT', close_fraction_pct: 50 })), call('a', 'tracker.close_now', { id: id(1) })],
});
for (const [label, setting, engineOver, extra] of [
  ['没开自动执行', { policies: { auto_execute: false, allow_live_trading: true } }, {}, []],
  ['实盘账户没开 allow_live_trading', { policies: { auto_execute: true, allow_live_trading: false } }, { accountIsPaper: [{ value: false }] }, []],
  ['模拟账户不看 allow_live_trading', { policies: { auto_execute: true, allow_live_trading: false } }, { accountIsPaper: [{ value: true }] }, []],
  ['休市', closeSettings, { marketStatusFor: [{ value: '休市' }] }, []],
  ['盘外(全时段:盘外自动转限价,放行)', closeSettings, { marketStatusFor: [{ value: '盘外' }] }, []],
  ['手动熔断挡平仓', closeSettings, {}, [{ op: 'killswitch', m: 'engage', a: ['手动'] }]],
  ['自动熔断不挡平仓(那是在减仓)', closeSettings, {}, [{ op: 'killswitch', m: 'engage', a: ['连续失败', true] }]],
  ['多个原因一起报', { policies: { auto_execute: false, allow_live_trading: false } }, { accountIsPaper: [{ value: false }], marketStatusFor: [{ value: '休市' }] }, [{ op: 'killswitch', m: 'engage', a: ['手动'] }]],
]) {
  b.add(`close_now:闸门——${label}`, {
    settings: setting, router: rowsOf(stock()), engine: eng(engineOver),
    steps: [seed(stock(), T({ stop_loss: 95 }), A({})), ...extra, call('a', 'tracker.close_now', { id: id(1) })],
  });
}
b.add('close_now:持仓数量为零 → 没得平', {
  settings: closeSettings, router: rowsOf(stock({ quantity: 0 })), engine: eng(),
  steps: [seed(stock(), T({ stop_loss: 95 }), A({})), call('a', 'tracker.close_now', { id: id(1) })],
});
b.add('close_now:分批止盈某档在追价成交——只平这一档,等它成交再点;托管的不挡;非追价不挡', {
  settings: closeSettings, router: rowsOf(stock()), engine: eng(),
  steps: [
    seed(stock(), T({ take_profit_tiers: [{ price: 130, fraction_pct: 50, pending: true, pending_qty: 100 }] }), A({})),
    patch(1, { fired_state: 'sweep:take_profit' }),
    call('a', 'tracker.close_now', { id: id(1) }),
    patch(1, { fired_state: 'take_profit' }),
    call('b', 'tracker.close_now', { id: id(1) }),
    patch(1, { fired_state: 'sweep:take_profit', auto_close: A({ host_at_broker: true }) }),
    call('c', 'tracker.close_now', { id: id(1) }),
  ],
});
b.add('close_now:券商那边已有这条追踪的单 → 改成追价,不另发', {
  settings: closeSettings, router: rowsOf(stock()), engine: eng({ sweepExisting: [{ value: true }] }),
  steps: [seed(stock(), T({ stop_loss: 95 }), A({})), call('a', 'tracker.close_now', { id: id(1) })],
});
b.add('close_now:托管追踪改追价——对一轮账,挂不出去要当场说;挂出去了说明原因;id 数字也认', {
  settings: closeSettings, router: rowsOf(stock()),
  engine: eng({ sweepExisting: [{ value: true }], syncHosted: [{ value: { blocked: [{ id: id(1), blockers: ['休市', '没开自动执行'] }], placed: 0 } }, { value: { blocked: [{ id: 'other', blockers: ['x'] }] } }, { value: { blocked: [{ id: 5, blockers: [] }] } }] }),
  steps: [
    seed(stock(), T({ stop_loss: 95 }), A({ host_at_broker: true, enabled: true })),
    call('a', 'tracker.close_now', { id: id(1) }), call('b', 'tracker.close_now', { id: id(1) }), call('c', 'tracker.close_now', { id: id(1) }),
  ],
});
b.add('close_now:上一次的平仓单还挂着 → 拒(两张各平一次)', {
  settings: closeSettings, router: rowsOf(stock()), engine: eng({ pendingCloseRecord: [{ value: '12345678-aaaa-bbbb' }, { value: 'abc' }] }),
  steps: [seed(stock(), T({ stop_loss: 95 }), A({})), call('a', 'tracker.close_now', { id: id(1) }), call('b', 'tracker.close_now', { id: id(1) })],
});
const OPT2 = b.leg(7400, 'C', 2, 3000, 32.5, { expiry: '20260918', row: { model_iv: 0.18 } });
b.add('close_now:期权 / 组合 / FOP 取可成交价当限价;拿不到才用现价;closePosition 没发出去 → 拒;抛错原样冒', {
  settings: closeSettings,
  router: { sessions: 1, results: { positions: [{ value: [OPT2, ...FLY, FOPROW, stock()] }] } },
  engine: eng({ naturalCloseFor: [{ value: 31 }, { value: null }, { value: 4.4 }, { value: 33 }], closePosition: [{ value: { id: 'x', symbol: 'SPX', state: 'manual', reason: '手动平仓' } }, { value: null }, { error: 'boom' }, { value: false }, { value: { id: 'y' } }] }),
  steps: [
    seed(OPT2, T({ stop_loss: 25 }), A({ enabled: true })),
    seed(tk.withCombos(FLY).find((r) => r.sec_type === 'BAG'), T({ stop_loss: 1 }), A({ enabled: true })),
    seed(FOPROW, T({ stop_loss: 25 }), A({})),
    seed(stock(), T({ stop_loss: 95 }), A({})),
    call('a', 'tracker.close_now', { id: id(1) }), call('b', 'tracker.close_now', { id: id(1) }), call('c', 'tracker.close_now', { id: id(2) }),
    call('d', 'tracker.close_now', { id: id(3) }), call('e', 'tracker.close_now', { id: id(4) }),
  ],
});
b.add('close_now:持仓行没有现价——result 里不带 price', {
  settings: closeSettings, router: rowsOf(stock({ market_price: undefined })), engine: eng(),
  steps: [seed(stock(), T({ stop_loss: 95 }), A({})), call('a', 'tracker.close_now', { id: id(1) })],
});

// ---------------------------------------------------------------- tracker.poll / reconcile
const POLL = { rows: [{ id: 'a', price: 1 }], fired: [{ id: 'old' }], blocked: [{ id: 'old2' }], loop_tick: 7 };
b.add('tracker.poll:节拍器在跑——回上一轮的行,fired / blocked 清空,心跳另取', {
  router: rowsOf(stock()),
  engine: { loop: { running: true, poll: POLL }, results: { trackerHeartbeat: [{ value: { alive: true, age_ms: 1 } }] } },
  steps: [call('a', 'tracker.poll'), { op: 'engineSet', set: { loop: { running: true, poll: { rows: [] } } } }, call('b', 'tracker.poll'), call('c', 'tracker.poll', { x: 1 })],
});
b.add('tracker.poll:节拍器没在跑 / 没有上一轮 → 排进追踪锁就地盯一轮;有触发 / 被拦才推事件', {
  router: rowsOf(stock()),
  engine: { loop: { running: false, poll: POLL }, results: { pollTrackers: [{ value: { rows: [], fired: [], blocked: [] } }, { value: { rows: [], fired: [{ id: 'f' }], blocked: [] } }, { value: { rows: [], fired: [], blocked: [{ id: 'b' }] } }, { error: 'pollTrackers 炸了' }], trackerHeartbeat: [{ value: { alive: false } }] } },
  steps: [
    call('a', 'tracker.poll'), call('b', 'tracker.poll'), call('c', 'tracker.poll'), call('d', 'tracker.poll'),
    { op: 'engineSet', set: { loop: { running: true, poll: null } } }, { op: 'engineSet', set: { results: { pollTrackers: [{ value: { rows: [1], fired: [], blocked: [] } }] } } }, call('e', 'tracker.poll'),
  ],
});
b.add('tracker.reconcile:节拍器在跑且有托管结果 → 直接回;否则排锁 syncHosted', {
  router: rowsOf(stock()),
  engine: { loop: { running: true, hosted: { placed: 1, blocked: [] } }, results: { syncHosted: [{ value: { placed: 2, blocked: [] } }, { error: 'sync 炸了' }], trackerHeartbeat: [{ value: { alive: true } }] } },
  steps: [
    call('a', 'tracker.reconcile'),
    { op: 'engineSet', set: { loop: { running: true, hosted: null } } }, call('b', 'tracker.reconcile'),
    { op: 'engineSet', set: { loop: { running: false, hosted: { placed: 9 } } } }, call('c', 'tracker.reconcile'),
  ],
});

// ---------------------------------------------------------------- 追踪锁
b.add('追踪锁:add(券商慢)与 delete / close_now / poll 排成一队;前一个失败后一个照样跑', {
  settings: closeSettings, sortLog: true,
  router: { sessions: 1, results: { positions: [{ value: [stock()], delay: 3000 }, { error: '断了', cls: 'BrokerError' }, { value: [stock()], delay: 1000 }] } },
  engine: { loop: { running: false }, results: { pollTrackers: [{ value: { rows: [], fired: [], blocked: [] }, delay: 500 }], trackerHeartbeat: [{ value: {} }], marketStatusFor: [{ value: '盘中' }], accountIsPaper: [{ value: true }], sweepExisting: [{ value: false }], pendingCloseRecord: [{ value: null }], closePosition: [{ value: { id: 'x' } }] } },
  steps: [
    seed(stock(), T({ stop_loss: 90 }), A({})),
    call('a', 'tracker.add', { key: KEY, stop_loss: '95', auto_close: false, order_type: 'MKT', host_at_broker: false, take_profit: '', trail_pct: '', profit_drawdown_pct: '', spot_target: '' }),
    call('b', 'tracker.close_now', { id: id(1) }), call('c', 'tracker.poll'), call('d', 'tracker.delete', { id: id(1) }),
    { op: 'advance', ms: 2000 }, { op: 'advance', ms: 1000 }, { op: 'advance', ms: 1000 }, { op: 'advance', ms: 1000 },
  ],
});
await finish(b, mods, 'handlers1_tracker_ops.json');
