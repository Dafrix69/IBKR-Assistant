// 生成 handlers1_tracker.json:engine-ts 的 rpc/handlers/tracker.ts(positions.list / tracker.list / target_preview / add / delete / poll / reconcile)
// 原 handler 对着脚本驱动的假引擎 / router / alerts、真的交易库、虚拟钟现跑。C++ 一半:tests/tst_h1_tracker.cpp。
import { Builder, call, finish, setup, START } from './gen_handlers1_common.mjs';

const { mods, tk } = await setup();
const b = new Builder(mods, tk);
const stock = (o) => b.stock(o);
const KEY = stock().key;
const ACCOUNTS = [
  { alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true },
  { alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live' },
  { alias: '副账户', account_id: 'U7777777', is_paper: false, connection: 'live' },
];
const ui = (over = {}) => ({
  key: KEY, take_profit: '', stop_loss: '', trail_pct: '', profit_drawdown_pct: '', spot_target: '', auto_close: false, order_type: 'MKT', host_at_broker: false, ...over,
});

// ---------------------------------------------------------------- positions.list / tracker.list
b.add('positions.list:没连券商 → -32018;连着但 0 个会话也是', {
  steps: [call('a', 'positions.list'), { op: 'router', v: 'make' }, { op: 'routerSet', set: { sessions: 0 } }, call('b', 'positions.list')],
  router: b.router([stock()]),
});
b.add('positions.list:盈亏补算(券商没报 / 有现价 / 休市只有昨收)、tracked 标记、BrokerError 与别的错', {
  router: b.router([
    stock(),
    stock({ symbol: 'AA', key: tk.makeKey('模拟', 'AA', 'STK'), unrealized_pnl: null, market_value: null, avg_cost: 10, quantity: 50, market_price: 12.5, contract: { secType: 'STK', symbol: 'AA' } }),
    stock({ symbol: 'CC', key: tk.makeKey('模拟', 'CC', 'STK'), unrealized_pnl: null, market_price: null, close_price: 8, avg_cost: 10, quantity: -20, contract: { secType: 'STK', symbol: 'CC' } }),
    stock({ symbol: 'DD', key: tk.makeKey('模拟', 'DD', 'STK'), unrealized_pnl: null, market_price: null, contract: { secType: 'STK', symbol: 'DD' } }),
    stock({ symbol: 'EE', key: tk.makeKey('模拟', 'EE', 'STK'), unrealized_pnl: null, market_price: 5, quantity: 0, multiplier: 0, avg_cost: null, pnl_source: 'x', contract: { secType: 'STK', symbol: 'EE' } }),
  ]),
  steps: [
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'AA', sec_type: 'STK', leg: '', contract: { secType: 'STK', symbol: 'AA' }, targets: {}, auto_close: {} }] },
    call('a', 'positions.list'),
    { op: 'routerSet', set: { results: { positions: [{ error: '行情断了', cls: 'BrokerError' }] } } }, call('b', 'positions.list'),
    { op: 'routerSet', set: { results: { positions: [{ error: 'boom' }] } } }, call('c', 'positions.list'),
  ],
});
b.add('positions.list:close_price 为 null / 不是有限数不补 close_pnl', {
  router: b.router([
    stock({ symbol: 'GG', key: tk.makeKey('模拟', 'GG', 'STK'), unrealized_pnl: null, market_price: null, close_price: null, contract: { secType: 'STK', symbol: 'GG' } }),
    stock({ symbol: 'HH', key: tk.makeKey('模拟', 'HH', 'STK'), unrealized_pnl: null, market_price: null, close_price: 'abc', contract: { secType: 'STK', symbol: 'HH' } }),
    stock({ symbol: 'II', key: tk.makeKey('模拟', 'II', 'STK'), unrealized_pnl: null, market_price: null, close_price: '9.5', contract: { secType: 'STK', symbol: 'II' } }),
  ]),
  steps: [call('a', 'positions.list')],
});
b.add('positions.list:期权腿折成组合行', {
  router: b.router([...b.fly(), stock()]),
  steps: [call('a', 'positions.list')],
});
b.add('tracker.list:空库;有追踪时 adoptTracked 有话就提醒第一句', {
  services: { alerts: { results: { adoptTracked: [{ value: [] }, { value: ['已为 BE 盯上价位', '第二句'] }, { value: [] }] } } },
  steps: [
    call('a', 'tracker.list'),
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'BE', sec_type: 'STK', leg: '', contract: { secType: 'STK', symbol: 'BE' }, targets: { stop_loss: 95 }, auto_close: { enabled: false } }] },
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'AA', sec_type: 'STK', leg: '', contract: {}, targets: {}, auto_close: {}, note: 'x' }] },
    call('b', 'tracker.list'), call('c', 'tracker.list'),
  ],
});
b.add('tracker.delete:没有这个追踪;删了之后把剩下的标的集合交给 alerts', {
  services: { alerts: { results: { releaseForTrack: [{ value: [] }] } } },
  steps: [
    call('a', 'tracker.delete', { id: 'nope' }),
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'BE', sec_type: 'STK', leg: '', contract: {}, targets: {}, auto_close: {} }] },
    { op: 'store', m: 'addTrack', a: [{ account: '模拟', symbol: 'AA', sec_type: 'STK', leg: '', contract: {}, targets: {}, auto_close: {} }] },
    { op: 'store', m: 'addTrack', a: [{ account: '主账户', symbol: 'BE', sec_type: 'STK', leg: '', contract: {}, targets: {}, auto_close: {} }] },
    call('b', 'tracker.delete', { id: '00000000-0000-4000-8000-000000000002' }),
    call('c', 'tracker.delete', { id: '00000000-0000-4000-8000-000000000001' }),
    call('d', 'tracker.delete', { id: '00000000-0000-4000-8000-000000000001' }),
    call('e', 'tracker.delete', {}),
    call('f', 'tracker.delete', { id: '1', extra: 1 }),
  ],
});

// ---------------------------------------------------------------- tracker.add:界面的载荷
b.add('tracker.add:止损 "95",其余 "" 是不设;回执与库一致', {
  router: b.router([stock()]),
  steps: [call('a', 'tracker.add', ui({ stop_loss: '95' }))],
});

// ---- 更多正股载荷
b.add('tracker.add:四个数一起填;分档回撤;自动平仓字段(LMT / 滑点 / 比例 / 追价上限 0)', {
  router: b.router([stock()]),
  steps: [
    call('a', 'tracker.add', ui({ take_profit: '140.5', stop_loss: '95', trail_pct: '8', profit_drawdown_pct: '40' })),
  ],
});
b.add('tracker.add:自动平仓字段原样进库(order_type LMT、滑点、比例、追价上限 0、止损节奏)', {
  router: b.router([stock(), stock({ symbol: 'AA', key: tk.makeKey('模拟', 'AA', 'STK'), contract: { secType: 'STK', symbol: 'AA' } })]),
  services: { alerts: { results: { adoptForTrack: [{ value: null }, { value: '已盯上 AA 的价位' }] } } },
  steps: [
    call('a', 'tracker.add', ui({ stop_loss: '95', auto_close: true, order_type: 'LMT', slippage_pct: '0.5', close_fraction_pct: '50', chase_max_pct: '0', stop_chase_grace: '3', stop_chase_step: 2, stop_chase_max_pct: '15', note: '备注'.repeat(120) })),
    call('b', 'tracker.add', ui({ key: tk.makeKey('模拟', 'AA', 'STK'), stop_loss: 10, order_type: 'XYZ', slippage_pct: 'abc', close_fraction_pct: '0', chase_max_pct: '' })),
  ],
});
for (const [label, over] of [
  ['数不出来的字符串:spot_target 先于 take_profit 报', { spot_target: 'zz', take_profit: 'abc', stop_loss: 'qq' }],
  ['take_profit "abc"', { take_profit: 'abc' }],
  ['stop_loss 空格串 " "', { stop_loss: ' ' }],
  ['trail_pct 在 stop_loss 后面报', { trail_pct: 'x', stop_loss: 'y' }],
  ['profit_drawdown_pct "x" 先于 spot_stop_below 报', { profit_drawdown_pct: 'x', spot_stop_below: 'y' }],
  ['spot_stop_above "x"', { spot_stop_above: 'x' }],
  ['chase_max_pct "x" 在 auto 字面量里报', { chase_max_pct: 'x', slippage_pct: 'abc' }],
  ['stop_chase_grace 范围错', { stop_chase_grace: '-1' }],
  ['stop_basis 不认识', { stop_basis: 'bid' }],
]) {
  b.add(`tracker.add:${label}`, { router: b.router([stock()]), steps: [call('a', 'tracker.add', ui(over))] });
}
for (const [label, over] of [
  ['多头止损高于现价', { stop_loss: '130' }],
  ['多头止盈低于现价', { take_profit: '110' }],
  ['止损等于现价', { stop_loss: '120' }],
  ['跟踪止损 150%', { trail_pct: '150' }],
  ['止盈价和标的目标价二选一', { take_profit: '140', spot_target: '130' }],
  ['什么目标都没填', {}],
  ['利润回撤 0', { profit_drawdown_pct: '0' }],
  ['分批止盈:一档比一档有利', { take_profit_tiers: [{ price: '130', fraction_pct: '50' }, { price: '125', fraction_pct: '50' }] }],
  ['分批止盈合法两档', { take_profit_tiers: [{ price: 130, fraction_pct: 30 }, { price: '140', fraction_pct: 100 }] }],
  ['分批止盈第一档不在有利侧', { take_profit_tiers: [{ price: '110', fraction_pct: '50' }] }],
  ['分批止盈超过四档', { take_profit_tiers: [1, 2, 3, 4, 5].map((i) => ({ price: String(120 + i * 5), fraction_pct: '10' })) }],
  ['分批止盈 + 托管', { take_profit_tiers: [{ price: '130', fraction_pct: '50' }], auto_close: true, host_at_broker: true, spot_target: '' }],
  ['到点平仓 15:45', { stop_loss: '95', exit_at: '15:45' }],
  ['到点平仓 24:00 非法', { stop_loss: '95', exit_at: '24:00' }],
  ['到点平仓 3:45 写法', { stop_loss: '95', exit_at: '3:45' }],
  ['确认秒数:正股没有止损价', { take_profit: '140', spot_stop_confirm_s: '5' }],
  ['确认秒数:正股有止损价', { stop_loss: '95', spot_stop_confirm_s: '5' }],
  ['确认秒数:正股有跟踪止损', { trail_pct: '5', spot_stop_confirm_s: '5' }],
  ['确认秒数:正股托管', { stop_loss: '95', spot_stop_confirm_s: '5', auto_close: true, host_at_broker: true }],
  ['确认秒数负数', { stop_loss: '95', spot_stop_confirm_s: '-1' }],
  ['峰值确认:正股不收', { stop_loss: '95', peak_confirm: true }],
  ['止损按可成交价判:正股不收', { stop_loss: '95', stop_basis: 'natural' }],
  ['标的止损价:正股不给设', { stop_loss: '95', spot_stop_below: '100' }],
  ['托管不开自动平仓', { stop_loss: '95', host_at_broker: true }],
  ['托管 + 自动平仓 + 止损', { stop_loss: '95', host_at_broker: true, auto_close: true }],
  ['自动平仓 + 标的目标价(正股,模型价不算市价)', { spot_target: '130', auto_close: true }],
  ['标的目标价(正股,不发单)', { spot_target: '130' }],
  ['标的目标价比现价还差', { spot_target: '110' }],
  ['利润回撤预设 fly(非组合,按比例)', { profit_drawdown_preset: 'fly' }],
  ['分档回撤自己列:above / pct', { profit_drawdown_tiers: [{ above: '0', pct: '40' }, { above: '1', pct: '30' }], profit_drawdown_late: { after: '15:00', factor: '0.5' } }],
  ['分档回撤:pct 空', { profit_drawdown_tiers: [{ above: '0', pct: '' }] }],
  ['激活线 arm_pct', { profit_drawdown_pct: '30', profit_drawdown_arm_pct: '20' }],
]) {
  b.add(`tracker.add:${label}`, { router: b.router([stock()]), engine: { results: { 'sessionEm.today': [{ value: 45 }] } }, steps: [call('a', 'tracker.add', ui(over))] });
}
b.add('tracker.add:模式错误——未知键 / 类型不对由 schema 拒', {
  router: b.router([stock()]),
  steps: [call('a', 'tracker.add', ui({ stoploss: '95' })), call('b', 'tracker.add', ui({ auto_close: 'true' })), call('c', 'tracker.add', ui({ host_at_broker: 1 })), call('d', 'tracker.add', { stop_loss: '95' }),
    call('e', 'tracker.add', 'x'), call('f', 'tracker.add', ui({ key: 5 })), call('g', 'tracker.add', ui({ take_profit: true }))],
});
b.add('tracker.add:没连券商 / 0 会话 / 找不到持仓 / 券商出错', {
  router: b.router([stock()]),
  steps: [
    call('a', 'tracker.add', ui({ key: 'nope', stop_loss: '95' })),
    { op: 'routerSet', set: { sessions: 0 } }, call('b', 'tracker.add', ui({ stop_loss: '95' })),
    { op: 'router', v: 'null' }, call('c', 'tracker.add', ui({ stop_loss: '95' })),
    { op: 'router', v: 'make' }, { op: 'routerSet', set: { results: { positions: [{ error: '断了', cls: 'BrokerError' }] } } }, call('d', 'tracker.add', ui({ stop_loss: '95' })),
    { op: 'routerSet', set: { results: { positions: [{ error: 'boom' }] } } }, call('e', 'tracker.add', ui({ stop_loss: '95' })),
  ],
});
b.add('tracker.add:同一持仓第二次建 → 库拒(-32602);已建好的行不动', {
  router: b.router([stock()]),
  steps: [call('a', 'tracker.add', ui({ stop_loss: '95' })), call('b', 'tracker.add', ui({ stop_loss: '96' }))],
});
b.add('tracker.add:持仓里同一个 key 出现两次,后来的盖前面的', {
  router: b.router([stock(), stock({ market_price: 130 })]),
  steps: [call('a', 'tracker.add', ui({ stop_loss: '125' }))],
});
b.add('tracker.add:方向校验先于出场细则(两样都不合,先说方向)', {
  router: b.router([stock()]),
  steps: [call('a', 'tracker.add', ui({ stop_loss: '130', peak_confirm: true }))],
});
b.add('tracker.add:空头正股的方向', {
  router: b.router([stock({ quantity: -100, unrealized_pnl: -2000, market_value: -12000 })]),
  steps: [call('a', 'tracker.add', ui({ stop_loss: '110' })), call('b', 'tracker.add', ui({ stop_loss: '130' })), call('c', 'tracker.add', ui({ take_profit: '100' }))],
});
b.add('tracker.add:富途账户托管被拒;IBKR 账户托管放行', {
  settings: { connections: { fut: { broker: 'futu', host: '127.0.0.1', port: 11111 } }, accounts: [...ACCOUNTS, { alias: '富途模拟', account_id: '8801234', is_paper: true, connection: 'fut' }] },
  router: b.router([stock({ account: '富途模拟', key: tk.makeKey('富途模拟', 'BE', 'STK') }), stock()]),
  steps: [
    call('a', 'tracker.add', ui({ key: tk.makeKey('富途模拟', 'BE', 'STK'), stop_loss: '95', auto_close: true, host_at_broker: true })),
    call('b', 'tracker.add', ui({ stop_loss: '95', auto_close: true, host_at_broker: true })),
  ],
});
await finish(b, mods, 'handlers1_tracker.json');
