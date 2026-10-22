// engine 簇对拍的随机脚本(种子固定):两族——
//   · hosted:几条追踪(目标、托管开关、峰值各不相同)、持仓价格来回走、券商回报(状态 / 错误码)穿插、router 偶尔失败 / 改价被拒 / 单号对不上、
//     虚拟钟按 1 秒 / 59.999 秒 / 60 秒 / 60.001 秒 / 10 分钟的边界往前走、熔断与授权开关翻动、追价平仓。
//   · cb:几条记录、券商单号与记录的绑定、状态 / 错误 / 成交 / 佣金回报(含重推与认不出的)、发单账本、对账(未成交单、当天成交、覆盖账户、条件单队列)。
// 脚本里不许有会抛的步(抛出来的话 V8 与 C++ 不一样):生成器跑完看有 error 的就丢掉重来。
import { stk, trk, trade, router, openRow, T0, MIN } from './engine_scenarios.mjs';

const SYMS = ['NVDA', 'AMD', 'AAPL'];
const ADV = [250, 1000, 5000, 9_999, 10_000, 30_000, 59_999, 60_000, 60_001, 61_000, 120_000, 600_000, 600_001];
const CODES = [202, 110, 201, 10311, 104, 161, 162, 200, 321, 399, 404, 135, 10148, 2104, 10089, 203, 'x'];
const STATUSES = ['Submitted', 'PreSubmitted', 'Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'PendingSubmit'];

export function genHosted(r, id) {
  const nTracks = r.range(1, 3);
  const names = ['A', 'B', 'C'].slice(0, nTracks);
  const syms = {};
  const rows = [];
  const setup = [];
  const spec = {};
  for (const [i, n] of names.entries()) {
    const symbol = SYMS[i];
    syms[n] = symbol;
    const live = r.chance(0.15);
    const price = r.pick([200, 220, 235.5, 150]);
    const qty = r.pick([100, 50, 200, 1]);
    const avg = r.pick([180, 100, 210]);
    const row = stk(symbol, { quantity: qty, market_price: price, avg_cost: avg, market_value: price * qty, unrealized_pnl: (price - avg) * qty,
      ...(live ? { account: '主账户', key: `主账户|${symbol}|STK` } : {}) });
    if (r.chance(0.92)) rows.push(row);
    const targets = {};
    if (r.chance(0.6)) targets.take_profit = r.pick([250, 240.5, 300, 210]);
    if (r.chance(0.6)) targets.stop_loss = r.pick([160, 150.25, 190]);
    if (r.chance(0.25)) targets.trail_pct = r.pick([5, 10]);
    if (r.chance(0.25)) targets.profit_drawdown_pct = r.pick([30, 50]);
    if (!Object.keys(targets).length) targets.take_profit = 250;
    const auto = { enabled: true, host_at_broker: r.chance(0.92) };
    if (r.chance(0.15)) auto.order_type = 'LMT';
    spec[n] = { account: live ? '主账户' : '模拟', symbol, targets, auto_close: auto, ...(r.chance(0.7) ? { peak: r.pick([price, price + 10, 260]) } : {}) };
    setup.push(trk(n, symbol, spec[n]));
  }
  const alive = new Set(names);
  const covered = r.chance(0.85) ? ['模拟', '主账户'] : [];
  const rt = router({ rows, covered, coveredIds: covered.map((a) => (a === '模拟' ? 'DU7654321' : 'U1234567')), perm: r.chance(0.3), nextId: r.pick([500, 500, 100, 10_000]) }, {
    coveredAccounts: r.chance(0.9), coveredIds: r.chance(0.9), listHostedOpen: r.chance(0.93), listOpenOrders: r.chance(0.9), executions: r.chance(0.8),
  });
  // 认领:一部分脚本开头券商侧就挂着旧单(含重复的)
  if (r.chance(0.3)) {
    const n = r.pick(names);
    rt.hostedOpen = [openRow(`trk:\${track:${n}}:tp`, r.pick([82, 86, 901]), { account: 'DU7654321' })];
    if (r.chance(0.5)) rt.hostedOpen.push(openRow(`trk:\${track:${n}}:tp`, r.pick([83, 85, 902])));
    if (r.chance(0.5)) rt.hostedOpen.push(openRow(`trk:\${track:${n}}:sl`, 903, { order_type: 'STP', lmt_price: null, aux_price: 160 }));
    if (r.chance(0.2)) rt.hostedOpen.push({ order_ref: 'other', order_id: 7 }, { order_ref: 'trk:bad', order_id: 8 }, { order_ref: 'trk:${track:A}:tp:extra', order_id: 9 });
  }
  const settings = {};
  if (r.chance(0.2)) settings.policies = { allow_live_trading: r.chance(0.5) };
  const host = { spotHold: {}, spotTakeProfit: {}, naturals: Object.fromEntries(SYMS.map((s) => [s, r.pick([null, 1.2, 100])])) };
  const steps = [];
  const nSteps = r.range(14, 32);
  const maxId = rt.nextId + 8;
  const orderId = () => rt.nextId + 1 + r.int(9);
  const pickAlive = () => r.pick([...alive]);
  for (let i = 0; i < nSteps; i += 1) {
    const x = r.next();
    if (x < 0.27) steps.push({ op: 'sync' });
    else if (x < 0.36) steps.push({ op: 'advance', ms: r.pick(ADV) });
    else if (x < 0.44) steps.push({ op: 'row', index: r.int(Math.max(1, rows.length)), patch: { market_price: r.pick([150, 159, 200, 220, 235.5, 249.9, 251, 260, 280, 120]) } });
    else if (x < 0.46) steps.push({ op: 'row', index: r.int(Math.max(1, rows.length)), patch: { quantity: r.pick([100, 70, 30, 1, 0]) } });
    else if (x < 0.485) steps.push({ op: 'rows', set: r.chance(0.5) ? [] : structuredClone(rows) });
    else if (x < 0.545 && alive.size) {
      const n = pickAlive();
      const targets = {};
      if (r.chance(0.7)) targets.take_profit = r.pick([250, 255, 260.5, 300, 210]);
      if (r.chance(0.5)) targets.stop_loss = r.pick([160, 170, 150]);
      if (r.chance(0.3)) targets.profit_drawdown_pct = r.pick([30, 40]);
      steps.push({ op: 'updateTrack', track: n, fields: { targets } });
    } else if (x < 0.56 && alive.size) {
      const n = pickAlive();
      steps.push({ op: 'updateTrack', track: n, fields: { auto_close: { enabled: true, host_at_broker: r.chance(0.7) } } });
    } else if (x < 0.575 && alive.size) {
      const n = pickAlive();
      steps.push({ op: 'updateTrack', track: n, fields: r.pick([{ enabled: false }, { enabled: true }, { fired_at: '2026-09-11T16:00:00+00:00', fired_state: 'sweep:stop_loss' }, { fired_at: '2026-09-11T16:00:00+00:00', fired_state: 'take_profit' }, { fired_at: null, fired_state: '' }, { peak: 275 }]) });
    } else if (x < 0.66) steps.push({ op: 'status', trade: trade(r.chance(0.85) ? orderId() : r.pick([1, maxId + 50]), r.pick(STATUSES), { orderStatus: { status: r.pick(STATUSES), filled: r.pick([0, 0, 30, 100]), remaining: r.pick([0, 70, 100]) } }) });
    else if (x < 0.73) steps.push({ op: 'error', reqId: r.chance(0.9) ? orderId() : r.pick([0, -1, 2]), code: r.pick(CODES), message: r.pick(['拒', 'Order rejected - reason: margin', '价格档位', '']) });
    else if (x < 0.8) {
      const method = r.pick(['placeHosted', 'placeHosted', 'modifyHosted', 'cancelHosted']);
      const b = {};
      const y = r.next();
      if (y < 0.4) b.error = { cls: r.pick(['Broker', 'LinkDown', 'Error']), msg: r.pick(['与 TWS 的连接中断', '超时']) };
      else if (y < 0.55 && method === 'modifyHosted') b.ret = false;
      else if (y < 0.65 && method === 'placeHosted') b.res = r.pick([{ order_id: 0 }, { order_id: null }, { perm_id: 5 }, { status: 'Submitted' }]);
      else if (y < 0.8) b.emit = [{ op: 'status', trade: trade(orderId(), r.pick(['Filled', 'Cancelled', 'Submitted']), { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }];
      else if (y < 0.9) b.emit = [{ op: 'error', reqId: orderId(), code: r.pick(CODES), message: '早到的错误' }];
      else b.delay = r.pick([50, 1000]);
      if (r.chance(0.2)) b.repeat = true;
      steps.push({ op: 'router', push: { [method]: [b] } });
    } else if (x < 0.83) steps.push({ op: 'settings', patch: { policies: r.pick([{ auto_execute: false }, { auto_execute: true }, { allow_live_trading: true }, { allow_live_trading: false }]) } });
    else if (x < 0.87) steps.push({ op: 'breaker', action: r.pick(['engage', 'engageAuto', 'release', 'fail', 'fail', 'ok']), kind: r.pick(['broker', 'parse']), reason: 'r' });
    else if (x < 0.89) steps.push({ op: 'router', set: { covered: r.pick([[], ['模拟'], ['模拟', '主账户'], null]) } });
    else if (x < 0.91 && alive.size) {
      const n = pickAlive();
      steps.push({ op: 'router', set: { hostedOpen: [openRow(`trk:\${track:${n}}:tp`, orderId()), openRow(`trk:\${track:${n}}:sl`, orderId(), { order_type: 'STP', lmt_price: null, aux_price: 160 })] } });
    } else if (x < 0.935 && alive.size) {
      const n = pickAlive();
      steps.push({ op: 'triggered', track: n, state: r.pick(['take_profit', 'stop_loss', 'profit_trail', 'manual']), reason: '到价了', spotReached: r.chance(0.3), ...(r.chance(0.2) ? { spotStop: true } : {}), rowIndex: 0, row: {} });
      if (rows.length === 0) steps.pop();
    } else if (x < 0.95) steps.push({ op: 'host', set: r.pick([{ spotHold: { A: r.chance(0.5) } }, { spotTakeProfit: { A: r.pick([251, 255.5]) } }, { spotTakeProfit: {} }]) });
    else if (x < 0.965 && alive.size) {
      const n = pickAlive();
      alive.delete(n);
      steps.push({ op: 'deleteTrack', track: n });
    } else if (x < 0.975 && alive.size) steps.push({ op: 'clearBackoff', track: pickAlive() });
    else if (x < 0.99) steps.push({ op: 'reconcile', now: T0 + r.range(0, 20) * MIN });
    else steps.push({ op: 'reconcileSoon' });
  }
  // 'triggered' 需要至少一行持仓(rowIndex 0 在 router.rows 里);行被清空的脚本里这类步可能抛,生成器会丢掉
  return { name: `hosted_${id}`, script: { start: T0, settings, router: rt, host, setup, steps } };
}

export function genCb(r, id) {
  const nRec = r.range(1, 4);
  const names = ['R1', 'R2', 'R3', 'R4'].slice(0, nRec);
  const iso = (ms) => new Date(ms).toISOString();
  const steps = [];
  const quantities = {};
  for (const n of names) {
    quantities[n] = r.pick([100, 5, 0.3, 1]);
    const events = r.chance(0.1) ? [] : [{ kind: 'status', payload: { status: r.pick(['Submitted', 'PreSubmitted', 'PendingTrigger', '', 'Adjusted']) } }];
    if (r.chance(0.2)) events.push({ kind: 'status', payload: { status: 'Adjusted' } });
    if (r.chance(0.15)) events.push({ kind: 'fill', payload: { exec_id: `K-${n}`, qty: 10, price: 9 } });
    steps.push({
      op: 'record', name: n,
      record: {
        signature: r.chance(0.2) ? `trk:\${track:A}:${r.pick(['tp', 'sl'])}` : r.chance(0.5) ? 'sig' : '',
        created_at: iso(T0 - r.pick([30_000, 5 * MIN, 10 * MIN, 3 * 60 * MIN])),
        account: { alias: r.pick(['模拟', '主账户']), account_id: r.pick(['DU7654321', 'U1234567']), is_paper: true },
        contract: { symbol: r.pick(['AAPL', 'SPX']), secType: r.pick(['STK', 'BAG']) }, order: r.chance(0.8) ? { totalQuantity: quantities[n] } : { quantity: quantities[n] },
      },
      events,
    });
  }
  const setup = [trk('A')];
  const ids = [11, 12, 13, 14, 21, 22];
  const bound = new Set();
  const nSteps = r.range(14, 34);
  const fills = () => {
    const rowsOut = [];
    for (let i = 0; i < r.range(1, 3); i += 1) {
      rowsOut.push({
        exec_id: r.pick(['X1', 'X2', 'X3', 'K-R1', '']), time: '2026-09-11T15:50:00+00:00', account_id: 'DU7654321', shares: r.pick([100, 60, 40, 5, 0.1, 0.2, 'abc']),
        price: r.pick([10, 11.5, 'x']), order_id: r.pick(ids), perm_id: r.pick([0, 31, 41]), order_ref: `\${rec:${r.pick(names)}}`, commission: r.pick([1, 0.5, 'q']),
        contract: r.chance(0.2) ? null : { secType: r.pick(['STK', 'BAG', 'OPT']), symbol: 'AAPL', conId: r.pick([0, 5, 'z']) },
      });
    }
    return rowsOut;
  };
  const rowsForOrders = () => {
    const out = [];
    for (let i = 0; i < r.range(0, 3); i += 1) {
      out.push({ order_ref: r.pick([...names.map((n) => `\${rec:${n}}`), 'trk:${track:A}:tp', 'trk:${track:A}:sl', 'other', '']), order_id: r.pick(ids), perm_id: r.pick([0, 31, null, 41]), status: r.pick(['Submitted', 'PreSubmitted', '']) });
    }
    return out;
  };
  const rt = router({ openOrders: rowsForOrders(), execRows: fills() }, { coveredIds: r.chance(0.9), executions: r.chance(0.85), listOpenOrders: r.chance(0.95) });
  rt.coveredIds = r.pick([['DU7654321'], ['DU7654321', 'U1234567'], [], null]);
  for (let i = 0; i < nSteps; i += 1) {
    const x = r.next();
    if (x < 0.1) {
      const n = r.pick(names);
      const id = r.pick(ids);
      bound.add(id);
      steps.push({ op: 'index', map: { [id]: n } });
    } else if (x < 0.17) steps.push({ op: 'sent', orderId: r.pick(ids), kind: r.pick(['place', 'modify', 'cancel']), ...(r.chance(0.3) ? { at: T0 - 20_000 } : {}) });
    else if (x < 0.19) steps.push({ op: 'unsent' });
    else if (x < 0.34) steps.push({ op: 'status', trade: { order: r.pick([{ orderId: r.pick(ids), permId: 0 }, { orderId: r.pick(ids), permId: r.pick([31, 41]) }, { permId: 31 }, {}, null]), orderStatus: r.pick([{ status: r.pick(STATUSES), filled: r.pick([0, 50, 100, null]), remaining: r.pick([0, 50, null]) }, {}]), contract: { symbol: 'AAPL' } } });
    else if (x < 0.5) steps.push({ op: 'error', reqId: r.pick([...ids, 0, 'x']), code: r.pick(CODES), message: r.pick(['拒', '价格', null]) });
    else if (x < 0.6) {
      steps.push({
        op: 'exec', trade: { order: { orderId: r.pick(ids), permId: r.pick([0, 31]) }, contract: { symbol: 'AAPL' } },
        fill: r.chance(0.1) ? r.pick([{}, null]) : { execution: { execId: r.pick(['E1', 'E2', 'E3', '', undefined]), time: '20260911 12:00:00', price: r.pick([10.5, '11', 'x']), shares: r.pick([5, 100, 'q']), side: r.pick(['BOT', 'SLD', undefined]), acctNumber: r.pick(['DU7654321', 'U1234567', undefined]) },
          contract: r.pick([{ secType: 'STK', conId: 265598 }, { secType: 'BAG' }, null, {}]), ...(r.chance(0.2) ? { live: false } : {}) },
      });
    } else if (x < 0.68) steps.push({ op: 'commission', trade: { order: { orderId: r.pick(ids), permId: r.pick([0, 31]) } }, fill: {}, report: r.chance(0.1) ? null : { execId: r.pick(['E1', 'E2', 'C1', undefined]), commission: r.pick([1.25, '2', 'x', 0]), realizedPNL: r.pick([15.5, null, undefined]) } });
    else if (x < 0.78) steps.push({ op: 'reconcile', now: T0 + r.pick([0, 30_000, 90_000, 2 * MIN, 5 * MIN, 6 * MIN, 11 * MIN, 12 * MIN, 60 * MIN]) });
    else if (x < 0.82) steps.push({ op: 'router', set: { openOrders: rowsForOrders() } });
    else if (x < 0.86) steps.push({ op: 'router', set: { execRows: fills() } });
    else if (x < 0.88) steps.push({ op: 'router', set: { coveredIds: r.pick([['DU7654321'], ['DU7654321', 'U1234567'], [], null]) } });
    else if (x < 0.91) steps.push({ op: 'pending', ids: r.chance(0.5) ? [] : [`\${rec:${r.pick(names)}}`] });
    else if (x < 0.94) steps.push({ op: 'fills', rows: fills() });
    else if (x < 0.96) steps.push({ op: 'router', push: { [r.pick(['listOpenOrdersDetailed', 'executions'])]: [r.pick([{ error: { cls: 'Error', msg: '被节流' } }, { delay: r.pick([1000, 9000, 11_000]) }, { hang: true }])] } });
    else if (x < 0.975) steps.push({ op: 'closeChase', set: { [r.pick(ids)]: 'A' } });
    else if (x < 0.985) steps.push({ op: 'advance', ms: r.pick([1000, 10_000, 30_000, 61_000, 120_000]) });
    else steps.push({ op: 'reconcileSoon' });
  }
  return { name: `cb_${id}`, script: { start: T0, router: rt, host: { chaseRejected: r.chance(0.5), noSentLedger: r.chance(0.15) }, setup, steps } };
}
