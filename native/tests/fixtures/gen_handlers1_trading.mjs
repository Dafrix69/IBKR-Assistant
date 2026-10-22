// 生成 handlers1_trading.json:engine-ts 的 rpc/handlers/trading.ts(instruction.submit / records.* / pending.* / breaker.*,钱路径)。C++ 一半:tests/tst_h1_trading.cpp。
import { Builder, call, finish, setup } from './gen_handlers1_common.mjs';

const { mods, tk } = await setup();
const b = new Builder(mods, tk);
const stock = (o) => b.stock(o);
const live = { policies: { auto_execute: true } };
const RESULT = { submitted: [{ record_id: 'r1', status: 'Submitted' }], queued: [], validated_only: [], rejections: [], warnings: ['w'], llm: { model: 'm' } };
const eng = (over = {}) => ({ results: { handleInstruction: [{ value: RESULT }], ...over } });

// ---------------------------------------------------------------- instruction.submit
b.add('instruction.submit:指令为空(缺 / null / 空白 / NBSP+BOM)→ -32602,引擎没碰', {
  engine: eng(),
  steps: [
    call('a', 'instruction.submit', {}), call('b', 'instruction.submit', { text: null }), call('c', 'instruction.submit', { text: '   \t\n' }),
    call('d', 'instruction.submit', { text: ' ﻿ ' }), call('e', 'instruction.submit', { text: '\u0085' }),
  ],
});
b.add('instruction.submit:schema 拒(text 不是串、未知键、channel 不是串)', {
  engine: eng(),
  steps: [call('a', 'instruction.submit', { text: 5 }), call('b', 'instruction.submit', { text: 'x', bogus: 1 }), call('c', 'instruction.submit', { text: 'x', channel: 5 }), call('d', 'instruction.submit', 'x')],
});
b.add('instruction.submit:execute 但自动执行没开 → -32003;开了但没连券商 → -32004(带网关名)', {
  engine: eng(),
  steps: [
    call('a', 'instruction.submit', { text: '买入 AAPL', execute: true }),
    { op: 'config', patch: { policies: { auto_execute: true } } },
    call('b', 'instruction.submit', { text: '买入 AAPL', execute: true }),
    call('c', 'instruction.submit', { text: '买入 AAPL', execute: 'false' }),
  ],
});
b.add('instruction.submit:解析模式(execute 缺省 / false)不碰券商检查,引擎收到 dryRun=true', {
  engine: eng({ handleInstruction: [{ value: RESULT }, { value: { submitted: [] } }] }),
  steps: [call('a', 'instruction.submit', { text: '  买入 AAPL 100股  ' }), call('b', 'instruction.submit', { text: '买入', execute: false, channel: 'follow' }), call('c', 'instruction.submit', { text: '买入', execute: 0 })],
});
b.add('instruction.submit:execute 且条件都满足 → dryRun=false;事件 result 带 executed', {
  settings: live, router: b.router([]), engine: eng(),
  steps: [call('a', 'instruction.submit', { text: '买入 AAPL', execute: true, channel: 'manual' }), call('b', 'instruction.submit', { text: '买入 AAPL', execute: 1, accounts: ['模拟'] })],
});
b.add('instruction.submit:accounts 校验——不是数组 / 项不是串 / 别名不在表里 / DEFAULT / 去重去空白 / 空数组', {
  engine: eng({ handleInstruction: [{ value: { submitted: [] } }] }),
  steps: [
    call('a', 'instruction.submit', { text: 'x', accounts: '模拟' }), call('b', 'instruction.submit', { text: 'x', accounts: [1] }), call('c', 'instruction.submit', { text: 'x', accounts: {} }),
    call('d', 'instruction.submit', { text: 'x', accounts: ['长线'] }), call('e', 'instruction.submit', { text: 'x', accounts: ['模拟', 'DEFAULT'] }),
    call('f', 'instruction.submit', { text: 'x', accounts: [' 模拟 ', '模拟', '', '主账户'] }), call('g', 'instruction.submit', { text: 'x', accounts: [] }),
    call('h', 'instruction.submit', { text: 'x', accounts: null }), call('i', 'instruction.submit', { text: 'x', accounts: ['  '] }),
  ],
});
b.add('instruction.submit:引擎出错——RpcError 原样、别的错 -32000;出错时不推 result 事件', {
  engine: eng({ handleInstruction: [{ error: '解析炸了' }, { error: '被拒', cls: 'RpcError', code: -32003 }, { value: { submitted: [] }, delay: 2000 }] }),
  steps: [call('a', 'instruction.submit', { text: 'x' }), call('b', 'instruction.submit', { text: 'x' }), call('c', 'instruction.submit', { text: 'x' }), { op: 'advance', ms: 2000 }],
});

// ---------------------------------------------------------------- records
const REC = (n, over = {}) => ({
  id: `rec-${n}`, created_at: `2026-09-11T1${n}:00:00+00:00`, signature: 's', input: { raw_instruction: `买入 ${n}`, reason: '想买', input_channel: 'manual' },
  llm: { model: 'm', prompt_version: 'v1', intent_summary: `买 ${n}`, confidence: 0.95 }, execution_type: 'immediate',
  account: { alias: '模拟', account_id: 'DU7654321', is_paper: true }, contract: { symbol: 'AAPL', secType: 'STK' }, order: { action: 'BUY', totalQuantity: 10 },
  ibkr: { order_id: null }, notional_estimate: 1900, rejection: null, ...over,
});
const seedRecords = [
  { op: 'store', m: 'createRecord', a: [REC(1)] },
  { op: 'store', m: 'appendEvent', a: ['rec-1', 'status', { status: 'Submitted', order_id: 7 }] },
  { op: 'store', m: 'appendEvent', a: ['rec-1', 'status', { status: 'Filled' }] },
  { op: 'store', m: 'appendEvent', a: ['rec-1', 'fill', { exec_id: 'e1', qty: 10, price: 190.5, commission: 1.2 }] },
  { op: 'store', m: 'setFinalStatus', a: ['rec-1', 'filled'] },
  { op: 'store', m: 'createRecord', a: [REC(2, { account: { alias: '主账户', account_id: 'U1234567' }, rejection: { code: 'X', message: '拒' }, order: {}, ibkr: undefined })] },
  { op: 'store', m: 'createRecord', a: [{ id: 'rec-3', created_at: '2026-09-11T13:00:00+00:00', signature: 's' }] },
  { op: 'store', m: 'createRecord', a: [REC(4, { account: { alias: '短号', account_id: 'AB12' }, contract: {}, llm: {}, input: {} })] },
];
b.add('records.list / get:摘要(缺的子对象给空串 / null)、账号打码、limit 的各种写法、记录不存在 → -32005', {
  engine: eng(),
  steps: [
    ...seedRecords,
    call('a', 'records.list', {}), call('b', 'records.list', { limit: 2 }), call('c', 'records.list', { limit: '1' }), call('d', 'records.list', { limit: 2.9 }),
    call('f', 'records.list', { limit: 0 }), call('g', 'records.list', { limit: -1 }), call('h', 'records.list', { limit: null }),
    call('i', 'records.list', { limit: [1] }), call('j', 'records.list', { limit: true }),
    call('k', 'records.get', { id: 'rec-1' }), call('l', 'records.get', { id: 'rec-2' }), call('m', 'records.get', { id: 'rec-3' }), call('n', 'records.get', { id: 'rec-4' }),
    call('o', 'records.get', { id: 'nope' }), call('p', 'records.get', {}), call('q', 'records.get', { id: 5 }), call('r', 'records.get', { id: null }),
  ],
});

// ---------------------------------------------------------------- pending
const PEND = (n, symbol, op, value) => ({ record_id: `rec-${n}`, approved: { order: { intent_summary: `条件单 ${n}` }, account: { alias: '模拟' } }, trigger: { symbol, operator: op, value }, created_at: `2026-09-11T1${n}:00:00+00:00`, fired: false });
b.add('pending.list:空;有条件单时按顺序列出', {
  engine: eng(),
  steps: [call('a', 'pending.list'), { op: 'engineSet', set: { pending: [PEND(1, 'SPX', '>=', 7500), PEND(2, 'AAPL', '<=', 180.5)] } }, call('b', 'pending.list')],
});
b.add('pending.poll:没有条件单——只同步回报;没连券商同理', {
  router: b.router([]), engine: eng({ syncBrokerOrders: [{ value: 0 }, { value: 3 }, { value: 2 }] }),
  steps: [call('a', 'pending.poll'), { op: 'engineSet', set: { pending: [PEND(1, 'SPX', '>=', 7500)] } }, { op: 'router', v: 'null' }, call('b', 'pending.poll')],
});
b.add('pending.poll:每个标的取一次价(null 不进表),触发 / 过期才推事件', {
  router: { sessions: 1, results: { 'indexPrice:SPX': [{ value: 7510 }], 'indexPrice:AAPL': [{ value: null }], 'indexPrice:QQQ': [{ value: 450.5 }] } },
  engine: { pending: [PEND(1, 'SPX', '>=', 7500), PEND(2, 'AAPL', '<=', 180), PEND(3, 'SPX', '<=', 7000), PEND(4, 'QQQ', '>=', 460)], results: { syncBrokerOrders: [{ value: 1 }], firePending: [{ value: [{ record_id: 'rec-1', status: 'Submitted' }] }, { value: [] }, { value: [] }, { value: [] }], expirePending: [{ value: 0 }, { value: 2 }, { value: 0 }, { value: 1 }] } },
  steps: [call('a', 'pending.poll'), call('b', 'pending.poll'), call('c', 'pending.poll'), call('d', 'pending.poll')],
});
b.add('pending.poll:取价抛错 / 触发抛错 → -32000', {
  router: { sessions: 1, results: { indexPrice: [{ error: '行情断了' }, { value: 1 }] } },
  engine: { pending: [PEND(1, 'SPX', '>=', 7500)], results: { firePending: [{ error: '触发炸了' }] } },
  steps: [call('a', 'pending.poll'), call('b', 'pending.poll')],
});

// ---------------------------------------------------------------- breaker
b.add('breaker.state / resume:默认、合闸后、解除后(审计 + 事件)', {
  engine: eng(),
  steps: [
    call('a', 'breaker.state'), { op: 'killswitch', m: 'engage', a: ['手动测试'] }, call('b', 'breaker.state'),
    { op: 'killswitch', m: 'recordFailure', a: ['券商拒了', 'broker'] },
    call('c', 'breaker.resume'), call('d', 'breaker.state'), call('e', 'breaker.resume', { x: 1 }),
  ],
  files: ['breaker.json'],
});
b.add('breaker.halt:先合闸再撤单;默认原因;自定义原因;非串原因 → schema 拒;事件', {
  engine: eng({ halt: [{ value: { engaged: true, cancelled: 3 } }, { value: { engaged: true, cancelled: 0 } }, { value: { engaged: true, cancelled: 1 } }] }),
  steps: [call('a', 'breaker.halt', {}), call('b', 'breaker.halt', { reason: '契约测试' }), call('c', 'breaker.halt', { reason: '' }), call('d', 'breaker.halt', { reason: 5 }), call('e', 'breaker.halt', { reason: 'x', extra: 1 })],
  files: ['breaker.json'],
});
b.add('breaker.halt:撤单挂住 → 15 秒后放手,闸已合上,警告写明', {
  engine: eng({ halt: [{ hang: true }] }),
  steps: [call('a', 'breaker.halt', { reason: '挂住' }), { op: 'advance', ms: 14999 }, { op: 'get', what: 'breaker' }, { op: 'advance', ms: 1 }],
});
b.add('breaker.halt:撤单刚好在 15 秒前后返回;晚到的结果不影响', {
  engine: eng({ halt: [{ value: { engaged: true, cancelled: 2 }, delay: 14999 }, { value: { engaged: true, cancelled: 9 }, delay: 15000 }] }),
  steps: [call('a', 'breaker.halt', {}), { op: 'advance', ms: 15000 }, call('b', 'breaker.halt', {}), { op: 'advance', ms: 15001 }],
});
b.add('breaker.halt:撤单出 BrokerError → 闸照样合上,回执多一句 warning;别的错冒出来;锁被放开', {
  router: b.router([stock()]),
  engine: eng({ halt: [{ error: '撤单被拒', cls: 'BrokerError' }, { error: '内部错' }, { value: { engaged: true, cancelled: 0 } }] }),
  steps: [call('a', 'breaker.halt', {}), call('b', 'breaker.halt', {}), call('c', 'breaker.halt', {})],
  files: ['breaker.json'],
});
b.add('breaker.halt:与慢的 tracker.add 排队——闸立刻合上,撤单等锁', {
  sortLog: true, settings: live,
  router: { sessions: 1, results: { positions: [{ value: [stock()], delay: 5000 }] } },
  engine: eng({ halt: [{ value: { engaged: true, cancelled: 1 } }] }),
  steps: [
    call('a', 'tracker.add', { key: stock().key, stop_loss: '95', auto_close: false, order_type: 'MKT', host_at_broker: false, take_profit: '', trail_pct: '', profit_drawdown_pct: '', spot_target: '' }),
    call('b', 'breaker.halt', { reason: '排队' }), { op: 'get', what: 'breaker' }, { op: 'advance', ms: 5000 }, { op: 'get', what: 'breaker' },
  ],
});
b.add('breaker.halt:撤单耽搁了一阵才被拒——闸再合一次,时刻跟着走', {
  engine: eng({ halt: [{ error: '撤单被拒', cls: 'BrokerError', delay: 3000 }] }),
  files: ['breaker.json'],
  steps: [call('a', 'breaker.halt', {}), { op: 'advance', ms: 3000 }],
});
b.add('records.list:默认条数是 30', {
  engine: eng(),
  steps: [
    ...Array.from({ length: 35 }, (_, i) => ({ op: 'store', m: 'createRecord', a: [{ id: `r-${String(i).padStart(2, '0')}`, created_at: `2026-09-11T10:${String(i).padStart(2, '0')}:00+00:00`, signature: 's' }] })),
    call('a', 'records.list', {}), call('b', 'records.list', { limit: 31 }),
  ],
});
await finish(b, mods, 'handlers1_trading.json');
