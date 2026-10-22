// 生成 handlers1_tracker_opt.json:tracker.add / target_preview 的期权与组合那一半(标的取价、可成交价、到点平仓的到期、托管、结构认不出……)。
import { Builder, call, finish, setup } from './gen_handlers1_common.mjs';

const { mods, tk } = await setup();
const b = new Builder(mods, tk);
const opt = (strike = 7500, right = 'C', over = {}) => b.leg(strike, right, 2, 3000, 32.5, { row: { model_iv: 0.18, ...(over.row ?? {}) }, ...over });
const ui = (key, over = {}) => ({ key, take_profit: '', stop_loss: '', trail_pct: '', profit_drawdown_pct: '', spot_target: '', auto_close: false, order_type: 'MKT', host_at_broker: false, ...over });
const OK = opt().key;
const spx = (price, extra = {}) => ({ results: { positions: [{ value: [opt()] }], 'indexPrice:SPX': [{ value: price }] }, ...extra });
const withOpt = (rows, extra = {}) => ({ sessions: 1, results: { positions: [{ value: rows }], 'indexPrice:SPX': [{ value: 7490 }] }, ...extra });
const engineNat = (...values) => ({ results: { naturalCloseFor: values.map((v) => ({ value: v })), 'sessionEm.today': [{ value: 45 }] } });

// ---------------------------------------------------------------- 单腿期权
b.add('tracker.add(期权):止损按中间价判;峰值从现价起步', {
  router: b.router([opt()]),
  steps: [call('a', 'tracker.add', ui(OK, { stop_loss: '25' }))],
});
b.add('tracker.add(期权):止损按可成交价判——通道没有各腿买卖价 → 拒', {
  router: b.router([opt()]),
  steps: [call('a', 'tracker.add', ui(OK, { stop_loss: '25', stop_basis: 'natural' }))],
});
b.add('tracker.add(期权):止损按可成交价判——止损价不在可成交价的保护侧 → 拒;在另一侧 → 放行,峰值取可成交价;拿不到可成交价 → 放行,峰值空', {
  router: b.router([opt(7500, 'C', { symbol: 'SPX' }), opt(7550, 'C')], { optionQuotes: true }),
  engine: engineNat(31, 31, null),
  steps: [
    call('a', 'tracker.add', ui(OK, { stop_loss: '31', stop_basis: 'natural' })),
    call('b', 'tracker.add', ui(OK, { stop_loss: '25', stop_basis: 'natural' })),
    call('c', 'tracker.add', ui(opt(7550, 'C').key, { stop_loss: '25', stop_basis: 'natural' })),
  ],
});
b.add('tracker.add(期权):空头期权按可成交价判的方向', {
  router: b.router([b.leg(7500, 'C', -2, 3000, 32.5, { row: { model_iv: 0.18 } })], { optionQuotes: true }),
  engine: engineNat(33, 33),
  steps: [
    call('a', 'tracker.add', ui(b.leg(7500, 'C', -2, 3000, 32.5).key, { stop_loss: '33', stop_basis: 'natural' })),
    call('b', 'tracker.add', ui(b.leg(7500, 'C', -2, 3000, 32.5).key, { stop_loss: '40', stop_basis: 'natural' })),
  ],
});
b.add('tracker.add(期权):峰值要连续两秒确认可以开', {
  router: b.router([opt()]),
  steps: [call('a', 'tracker.add', ui(OK, { stop_loss: '25', peak_confirm: true }))],
});
b.add('tracker.add(期权):确认秒数需要标的止损价', {
  router: withOpt([opt()]),
  steps: [
    call('a', 'tracker.add', ui(OK, { stop_loss: '25', spot_stop_confirm_s: '5' })),
    call('b', 'tracker.add', ui(OK, { spot_stop_below: '7400', spot_stop_confirm_s: '5' })),
  ],
});
for (const [label, price, over, routerOver] of [
  ['标的止损:跌到的线在现价上方 → 拒', 7490, { spot_stop_below: '7500' }, {}],
  ['标的止损:涨到的线在现价下方 → 拒', 7490, { spot_stop_above: '7480' }, {}],
  ['标的止损:两条线都在保护侧 → 放行', 7490, { spot_stop_below: '7400', spot_stop_above: '7600' }, {}],
  ['标的止损:线正好等于现价', 7490, { spot_stop_below: '7490' }, {}],
  ['标的止损:拿不到标的现价 → 拒', null, { spot_stop_below: '7400' }, {}],
  ['标的止损:夜盘推算失败退回昨收(index_stale)当拿不到', 7490, { spot_stop_below: '7400' }, { spotInfo: { SPX: { source: 'index_stale', note: '推算失败' } } }],
  ['标的止损:夜盘按期货推算,带着来历', 7490, { spot_stop_below: '7400' }, { spotInfo: { SPX: { source: 'futures', note: 'ES 202612 推算' } } }],
  ['标的止损:取价抛错当拿不到', 'ERR', { spot_stop_below: '7400' }, {}],
]) {
  const results = { positions: [{ value: [opt()] }], 'indexPrice:SPX': price === 'ERR' ? [{ error: '行情断了' }] : [{ value: price }] };
  b.add(`tracker.add(期权):${label}`, { router: { sessions: 1, results, ...routerOver }, steps: [call('a', 'tracker.add', ui(OK, over))] });
}
const AAPL_OPT = b.leg(190, 'C', 1, 500, 6, { symbol: 'AAPL', tradingClass: 'AAPL', row: { model_iv: 0.3 } });
b.add('tracker.add(个股期权):标的止损走常驻报价流,拿不到成交价当没有', {
  router: { sessions: 1, streamQuotes: true, results: { positions: [{ value: [AAPL_OPT] }], 'streamQuotes:AAPL': [{ value: { AAPL: { last: 185 } } }, { value: { AAPL: { last: 0 } } }, { value: {} }, { error: 'x' }] } },
  steps: ['a', 'b', 'c', 'd'].map((id) => call(id, 'tracker.add', ui(AAPL_OPT.key, { spot_stop_below: '170' }))),
});
b.add('tracker.add(个股期权):没有报价流的通道退到 indexPrice', {
  router: { sessions: 1, results: { positions: [{ value: [AAPL_OPT] }], 'indexPrice:AAPL': [{ value: 185 }] } },
  steps: [call('a', 'tracker.add', ui(AAPL_OPT.key, { spot_stop_below: '170' }))],
});
b.add('tracker.add(期权):到点平仓要落在合约到期之前(当日到期:16:30 / 15:30 / 次日 00:05)', {
  router: b.router([opt()]),
  steps: [
    call('a', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '16:30' })),
    call('b', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '00:05' })),
    call('c', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '15:30' })),
  ],
});
b.add('tracker.add(期权):到点平仓正好等于到期时刻也拒', {
  router: b.router([opt()]),
  steps: [call('a', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '16:00' })), call('b', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '15:59' }))],
});
b.add('tracker.add(期权):提前收盘日的到期时刻是 13:00', {
  settings: { early_close_days: ['2026-09-11'] },
  router: b.router([opt()]),
  steps: [call('a', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '13:30' })), call('b', 'tracker.add', ui(OK, { stop_loss: '25', exit_at: '12:30' }))],
});
b.add('tracker.add(期权):没带交易类的到期认不出,不查', {
  router: b.router([b.leg(7500, 'C', 2, 3000, 32.5, { tradingClass: '', row: { model_iv: 0.18 } })]),
  steps: [call('a', 'tracker.add', ui(b.leg(7500, 'C', 2, 3000, 32.5, { tradingClass: '' }).key, { stop_loss: '25', exit_at: '16:30' }))],
});
// 标的目标价
const cheap = (over = {}) => b.leg(7500, 'C', 2, 1400, 14, over);
const CK = cheap().key;
b.add('tracker.add(期权):标的目标价——IBKR 模型 IV 算出的价是市场价,可以拿去发单', {
  router: withOpt([cheap({ row: { model_iv: 0.18 } })]),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520', auto_close: true }))],
});
b.add('tracker.add(期权):标的目标价——没有模型 IV:不开自动平仓、不托管放行', {
  router: withOpt([cheap()], { spotInfo: { SPX: { source: 'futures', note: 'ES 202612 推算' } } }),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520' }))],
});
b.add('tracker.add(期权):标的目标价——没有模型 IV:有报价算出的价也是市场价,开自动平仓放行', {
  router: withOpt([cheap()], { spotInfo: { SPX: { source: 'futures', note: 'ES 202612 推算' } } }),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520', auto_close: true }))],
});
const noSpot = (extra = {}) => ({ sessions: 1, results: { positions: [{ value: [cheap()] }], 'indexPrice:SPX': [{ value: null }] }, ...extra });
b.add('tracker.add(期权):拿不到标的现价 → 按钟算的参考值,开自动平仓 → 拒(带现价来历);托管同理(不带来历)', {
  router: noSpot({ spotInfo: { SPX: { source: 'official', note: '无行情' } } }),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520', auto_close: true })), { op: 'routerSet', set: { spotInfo: { SPX: { source: 'official', note: '' } } } }, call('b', 'tracker.add', ui(CK, { spot_target: '7520', host_at_broker: true, auto_close: true }))],
});
b.add('tracker.add(期权):标的目标价——拿不到标的现价,按钟算的参考值(不开自动平仓放行)', {
  router: noSpot(),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520' }))],
});
b.add('tracker.add(期权):标的目标价写在现价这一侧(不有利)', {
  router: withOpt([cheap({ row: { model_iv: 0.18 } })]),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7400' }))],
});
b.add('tracker.add(期权):夜盘 index_stale 当拿不到现价(参考值,开自动平仓 → 拒)', {
  router: withOpt([cheap()], { spotInfo: { SPX: { source: 'index_stale', note: '推算失败' } } }),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520', auto_close: true }))],
});
b.add('tracker.add(期权):标的目标价 + 止盈价二选一(期权)', {
  router: withOpt([cheap({ row: { model_iv: 0.18 } })]),
  steps: [call('a', 'tracker.add', ui(CK, { spot_target: '7520', take_profit: '30' }))],
});

// ---------------------------------------------------------------- 组合
const FLY = b.fly();
const FKEY = b.bagKey(FLY);
const FLYIV = b.fly({ row: { model_iv: 0.2 } });
b.add('tracker.add(组合):托管要先填标的目标价;填了就放行;分批止盈与托管不并存', {
  router: withOpt(FLYIV),
  engine: engineNat(null, null),
  steps: [
    call('a', 'tracker.add', ui(FKEY, { stop_loss: '10', auto_close: true, host_at_broker: true })),
    call('b', 'tracker.add', ui(FKEY, { spot_target: '7525', auto_close: true, host_at_broker: true })),
    call('c', 'tracker.add', ui(FKEY, { take_profit_tiers: [{ price: '40', fraction_pct: '50' }], auto_close: true, host_at_broker: true, spot_target: '7525' })),
  ],
});
b.add('tracker.add(组合):蝶式预设按每组成本起算;激活线;到点平仓用第一条腿的到期', {
  router: withOpt(FLY),
  steps: [
    call('a', 'tracker.add', ui(FKEY, { profit_drawdown_preset: 'fly', exit_at: '15:30' })),
    call('b', 'tracker.add', ui(FKEY, { profit_drawdown_pct: '30', exit_at: '16:45' })),
  ],
});
const ZERO = [b.leg(7500, 'C', 1, 3000, 35), b.leg(7525, 'C', -2, 1500, 18), b.leg(7550, 'C', 1, 0, 6)];
const CREDIT = [b.leg(7500, 'C', 1, 1000, 35), b.leg(7525, 'C', -2, 1500, 18), b.leg(7550, 'C', 1, 300, 6)];
for (const [label, rows] of [['成本为零(不换算,仍按比例)', ZERO], ['贷方(成本为负,取绝对值)', CREDIT]]) {
  b.add(`tracker.add(组合):蝶式预设——每组成本${label}`, { router: withOpt(rows), steps: [call('a', 'tracker.add', ui(b.bagKey(rows), { profit_drawdown_preset: 'fly' }))] });
}
b.add('tracker.add(组合):拼不出平仓单的结构开自动平仓 → 拒(建的时候就说)', {
  router: withOpt([b.leg(7500, 'C', 1, 3000, 35), b.leg(7525, 'C', -3, 1200, 18), b.leg(7550, 'C', 1, 300, 6), b.leg(7575, 'P', 1, 100, 2)]),
  steps: [(() => { const rows = [b.leg(7500, 'C', 1, 3000, 35), b.leg(7525, 'C', -3, 1200, 18), b.leg(7550, 'C', 1, 300, 6), b.leg(7575, 'P', 1, 100, 2)]; return call('a', 'tracker.add', ui(b.bagKey(rows), { take_profit: '60', auto_close: true })); })()],
});
b.add('tracker.add(FOP):拼不出平仓单,开自动平仓 → 拒;不开 → 放行', {
  router: withOpt([b.leg(5000, 'C', 1, 3000, 35, { secType: 'FOP', symbol: 'ES' })]),
  steps: [
    call('a', 'tracker.add', ui(b.leg(5000, 'C', 1, 3000, 35, { secType: 'FOP', symbol: 'ES' }).key, { stop_loss: '25', auto_close: true })),
    call('b', 'tracker.add', ui(b.leg(5000, 'C', 1, 3000, 35, { secType: 'FOP', symbol: 'ES' }).key, { stop_loss: '25' })),
  ],
});
b.add('tracker.add(组合):标的目标价——蝶式 ibkr 档市场价放行', {
  router: withOpt(FLYIV),
  engine: engineNat(null),
  steps: [call('a', 'tracker.add', ui(FKEY, { spot_target: '7525', auto_close: true }))],
});

// ---------------------------------------------------------------- tracker.target_preview
b.add('target_preview:缺 spot_target / 不是数 / 找不到 / 没连 / 认不出结构', {
  router: withOpt([opt(), ...b.fly(), b.leg(7500, 'C', 1, 100, 5, { symbol: 'XYZ', contract: { right: 'X' } })]),
  steps: [
    call('a', 'tracker.target_preview', { key: OK }),
    call('b', 'tracker.target_preview', { key: OK, spot_target: 'abc' }),
    call('c', 'tracker.target_preview', { key: 'nope', spot_target: '7520' }),
    call('d', 'tracker.target_preview', { key: b.leg(7500, 'C', 1, 100, 5, { symbol: 'XYZ', contract: { right: 'X' } }).key, spot_target: '7520' }),
    { op: 'router', v: 'null' }, call('e', 'tracker.target_preview', { key: OK, spot_target: '7520' }),
    call('f', 'tracker.target_preview', { key: OK, spot_target: '7520', extra: 1 }),
  ],
});
b.add('target_preview:期权——算出预计价位;自然价与追价下限;比现价还差时带警告', {
  router: withOpt([opt()]),
  engine: engineNat(33.5, null, 33.5),
  steps: [
    call('a', 'tracker.target_preview', { key: OK, spot_target: '7520' }),
    call('b', 'tracker.target_preview', { key: OK, spot_target: '7520', chase_max_pct: '20' }),
    call('c', 'tracker.target_preview', { key: OK, spot_target: '7470', chase_max_pct: 0 }),
  ],
});
b.add('target_preview:正股——不取标的现价,不问自然价', {
  router: b.router([b.stock()]),
  steps: [call('a', 'tracker.target_preview', { key: b.stock().key, spot_target: '130' }), call('b', 'tracker.target_preview', { key: b.stock().key, spot_target: 110 })],
});
b.add('target_preview:组合(蝶式)带模型 IV', {
  router: withOpt(FLYIV),
  engine: engineNat(5.2),
  steps: [call('a', 'tracker.target_preview', { key: FKEY, spot_target: '7525' })],
});
b.add('target_preview:拿不到标的现价 / 报错 / index_stale', {
  router: { sessions: 1, results: { positions: [{ value: [opt()] }], 'indexPrice:SPX': [{ value: null }, { error: 'x' }, { value: 7490 }] } },
  engine: engineNat(null, null, null),
  steps: [
    call('a', 'tracker.target_preview', { key: OK, spot_target: '7520' }), call('b', 'tracker.target_preview', { key: OK, spot_target: '7520' }),
    { op: 'routerSet', set: { spotInfo: { SPX: { source: 'index_stale', note: '推算失败' } } } }, call('c', 'tracker.target_preview', { key: OK, spot_target: '7520' }),
  ],
});
await finish(b, mods, 'handlers1_tracker_opt.json');
