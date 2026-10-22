// engine 簇对拍的命名场景(照 engine-ts/tests 里碰托管单 / 回报落库 / 执行对账的那些用例写:hosted.spec、fix-engine-hosted.spec、
// fix-reconcile-audit.spec、reconcile.spec、fix-callbacks-errors.spec、fix-callbacks-rewire.spec、link-engine.spec、track-exits.spec),再加钱路径上的细节
// (退避的边界、熔断的计数、重复撤单、迟到的回报、部分成交……)。脚本格式见 engine_world.mjs 开头。
// 每个场景可以带 check(out):对 TS 现跑的结果断言 spec 里的头条期望,免得假宿主接错了线、生成出一份自洽但错的夹具。
export const T0 = Date.UTC(2026, 8, 11, 16, 0, 0); // 2026-09-11(周五)美东 12:00,盘中
export const MIN = 60_000;

export const stk = (symbol = 'NVDA', over = {}) => ({
  key: `模拟|${symbol}|STK`, account: '模拟', symbol, sec_type: 'STK', leg: '', quantity: 100, avg_cost: 180, multiplier: 1, currency: 'USD',
  market_price: 220, market_value: 22000, unrealized_pnl: 4000, contract: { secType: 'STK', symbol, exchange: 'SMART', currency: 'USD' }, ...over,
});
export const trk = (name, symbol = 'NVDA', over = {}) => ({
  op: 'track', name,
  spec: {
    account: '模拟', symbol, sec_type: 'STK', contract: { secType: 'STK', symbol, exchange: 'SMART', currency: 'USD' },
    targets: { take_profit: 250, stop_loss: 160 }, auto_close: { enabled: true, host_at_broker: true }, peak: 220, ...over,
  },
});
export const trade = (orderId, status, over = {}) => ({
  order: { orderId, permId: null }, orderStatus: { status, filled: 0, remaining: 100 }, contract: { symbol: 'NVDA' }, ...over,
});
export const router = (over = {}, caps = {}) => ({
  caps: { coveredAccounts: true, coveredIds: true, listOpenOrders: true, executions: true, ...caps },
  rows: [stk()], covered: ['模拟'], coveredIds: ['DU7654321'], ...over,
});
const sync = (extra = {}) => ({ op: 'sync', ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const kinds = (r) => (r.hosted ?? []).flatMap((h) => h.orders.map((o) => o.kind));
const places = (out) => out.log.filter((e) => e.c === 'router' && e.m === 'placeHosted');
const mods = (out) => out.log.filter((e) => e.c === 'router' && e.m === 'modifyHosted');
const cancels = (out) => out.log.filter((e) => e.c === 'router' && e.m === 'cancelHosted');
const notes = (out, text) => out.log.filter((e) => e.c === 'notify' && e.a[2].includes(text));
const snap = (out, i) => { for (let k = i; k >= 0; k -= 1) if (out.steps[k].snap) return out.steps[k].snap; throw new Error('没有快照'); };
const must = (cond, msg) => { if (!cond) throw new Error(`夹具自检失败:${msg}`); };

/** 一条"已经在券商侧挂着"的托管单行(listHostedOpen / listOpenOrdersDetailed) */
export const openRow = (ref, orderId, over = {}) => ({
  order_ref: ref, order_id: orderId, perm_id: null, account: 'DU7654321', action: 'SELL', order_type: 'LMT', quantity: 100, lmt_price: 250, aux_price: null,
  trailing_percent: null, status: 'PreSubmitted', ...over,
});

export function scenarios() {
  const S = [];
  const add = (name, script, check) => S.push({ name, script: { start: T0, ...script }, check });

  // ================================================================ 挂 / 改 / 撤
  add('place_basic', {
    router: router(), setup: [trk('A')], steps: [sync(), sync(), { op: 'status', trade: trade(501, 'Submitted') }, sync()],
  }, (out) => {
    must(places(out).length === 2, '两张');
    must(JSON.stringify(kinds(out.steps[0].r)) === '["tp","sl"]', 'tp、sl');
    must(places(out)[0].a[5] === 'dafri-trk-00000000', 'oca');
  });
  add('place_rejected_10311', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'error', reqId: 501, code: 10311, message: '该委托单将直接传递至NYSE' }, { op: 'router', set: { hostedOpen: [] } }, sync(), adv(61_000), sync()],
  }, (out) => {
    must(JSON.stringify(out.steps[3].r.blocked).includes('10311'), '退避期内把原因交给界面');
    must(places(out).length === 2, '退避过了才重挂');
  });
  add('adopt_duplicates', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 82), openRow('trk:${track:A}:tp', 86)] }),
    setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })], steps: [sync(), sync()],
  }, (out) => {
    must(JSON.stringify(cancels(out).map((e) => e.a[0])) === '[82]', '撤旧留新');
    must(places(out).length === 0, '不再挂第三张');
  });
  add('modify_rejected_110', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 260 } } }, sync(), { op: 'error', reqId: 501, code: 110, message: '价格不符合最小价格变动' }, sync(), adv(61_000), sync()],
  }, (out) => {
    must(mods(out).length === 2, '60 秒后才改第二次');
    must(out.steps[4].r.hosted[0].orders[0].lmt_price === 250, '缓存恢复成券商那边的价');
  });
  add('ptrail_ratchet', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { profit_drawdown_pct: 30 }, peak: 260 })],
    steps: [sync(), { op: 'row', index: 0, patch: { market_price: 280 } }, sync(), { op: 'row', index: 0, patch: { market_price: 270 } }, sync()],
  }, (out) => {
    must(places(out)[0].a[4].kind === 'ptrail' && places(out)[0].a[4].aux_price === 236, '棘轮初值');
    must(mods(out).length === 1 && mods(out)[0].a[1].aux_price === 250, '峰值上移改单');
  });
  add('restart_adopt_noop', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 901), openRow('trk:${track:A}:sl', 902, { order_type: 'STP', lmt_price: null, aux_price: 160 })] }),
    setup: [trk('A')], steps: [sync(), sync()],
  }, (out) => { must(places(out).length === 0 && mods(out).length === 0, '认领后既不重挂也不改'); });
  add('position_vanishes', {
    router: router(), setup: [trk('A')], steps: [sync(), { op: 'rows', set: [] }, sync()],
  }, (out) => { must(cancels(out).length === 2, '持仓消失全撤'); });
  add('filled_latches', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }, sync()],
  }, (out) => {
    must(snap(out, 1).tracks[0].fired_state === 'take_profit' && snap(out, 1).tracks[0].enabled === false, '落闩');
    must(places(out).length === 2, '不再挂');
  });
  add('router_unsupported', { router: router({}, { hosted: false }), setup: [trk('A')], steps: [sync()] }, (out) => {
    must(JSON.stringify(out.steps[0].r) === JSON.stringify({ hosted: [], blocked: [], quote_maybe_delayed: false }), '空转');
  });
  add('no_router', { router: null, setup: [trk('A')], steps: [sync()] });
  add('no_tracks', { router: router(), steps: [sync(), sync({ rows: [stk()] })] });
  add('not_hosting_cancel', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { auto_close: { enabled: true, host_at_broker: false } } }, sync()],
  }, (out) => { must(cancels(out).length === 2, '托管关掉就撤'); });
  add('target_removed_cancels_one', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 250 } } }, sync()],
  }, (out) => { must(cancels(out).length === 1, '只撤止损'); });
  add('track_deleted_cancels', {
    router: router(), setup: [trk('A')], steps: [sync(), { op: 'deleteTrack', track: 'A' }, sync()],
  }, (out) => { must(cancels(out).length === 2, '追踪删了全撤'); });
  add('spot_hold_keeps_tp', {
    router: router(), host: { spotHold: { A: true } }, setup: [trk('A')],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { stop_loss: 160 } } }, sync()],
  }, (out) => { must(cancels(out).length === 0, '只守不挂时不撤止盈'); });
  add('spot_target_ratchets_tp', {
    router: router(), host: { spotTakeProfit: { A: 255 } }, setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'host', set: { spotTakeProfit: { A: 258.5 } } }, sync(), { op: 'host', set: { spotTakeProfit: { A: 258.5 } } }, sync()],
  });
  add('partial_fill_total', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Submitted', { orderStatus: { status: 'Submitted', filled: 30, remaining: 70 } }) },
      { op: 'rows', set: [stk('NVDA', { quantity: 70 })] }, sync(), { op: 'rows', set: [stk('NVDA', { quantity: 50 })] }, sync()],
  });
  add('paper_flag_and_live_gate', {
    settings: { policies: { allow_live_trading: false } },
    router: router({ rows: [stk('NVDA', { account: '主账户', key: '主账户|NVDA|STK' })], covered: ['主账户'], coveredIds: ['U1234567'] }),
    setup: [trk('A', 'NVDA', { account: '主账户' })],
    steps: [sync(), { op: 'settings', patch: { policies: { allow_live_trading: true } } }, sync(), { op: 'settings', patch: { policies: { auto_execute: false } } }, sync()],
  });
  add('unknown_account_alias', {
    router: router(), setup: [trk('A', 'NVDA', { account: '不存在' })], steps: [sync()],
  });

  // ================================================================ 熔断
  add('breaker_auto_keeps_orders', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'breaker', action: 'fail', kind: 'parse', reason: 'a' }, { op: 'breaker', action: 'fail', kind: 'parse', reason: 'b' }, { op: 'breaker', action: 'fail', kind: 'parse', reason: 'c' }, sync()],
  }, (out) => {
    must(snap(out, 4).breaker.auto === true && snap(out, 4).breaker.engaged === true, '自动熔断');
    must(cancels(out).length === 0 && mods(out).length === 0, '原样留着');
    must(JSON.stringify(out.steps[4].r.blocked).includes('自动熔断'), '说为什么');
  });
  add('breaker_manual_cancels', {
    router: router(), setup: [trk('A')], steps: [sync(), { op: 'breaker', action: 'engage', reason: '用户在界面上按下暂停' }, sync()],
  }, (out) => { must(cancels(out).length === 2, '手动熔断全撤'); });
  add('breaker_release_replaces', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'breaker', action: 'engage' }, sync(), { op: 'breaker', action: 'release' }, sync()],
  }, (out) => { must(places(out).length === 4, '解除后重挂'); });
  add('breaker_counts_broker_failures', {
    router: router({}, {}), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } }), trk('B', 'AMD', { targets: { take_profit: 100 } })],
    steps: [{ op: 'rows', set: [stk('NVDA'), stk('AMD')] },
      { op: 'router', push: { placeHosted: [{ error: { cls: 'Broker', msg: '与 TWS 的连接中断' }, repeat: true }] } }, sync(), adv(61_000), sync(), adv(61_000), sync(), adv(61_000), sync()],
  }, (out) => { must(snap(out, out.steps.length - 1).breaker.engaged === true, '连续失败自动熔断'); });
  add('place_backoff_broker_error', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { placeHosted: [{ error: { cls: 'Broker', msg: '与 TWS 的连接中断' } }] } }, sync(), sync(), sync(), sync(), sync(), adv(60_000), sync(), adv(1), sync()],
  }, (out) => {
    must(places(out).length === 2, '一分钟内不重挂,过了重挂一次');
  });
  add('place_backoff_linkdown_no_breaker', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { placeHosted: [{ error: { cls: 'LinkDown' } }, { error: { cls: 'LinkDown' } }] } }, sync(), sync(), sync(), adv(60_001), sync(), adv(60_001), sync()],
  }, (out) => {
    must(places(out).length === 3, '三次尝试');
    must(snap(out, out.steps.length - 1).breaker.consecutive_failures === 0, 'LinkDown 一次都不计入熔断');
  });
  add('place_unbuildable_contract', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 }, contract: { secType: 'STK', symbol: 'bad sym!' } })],
    steps: [sync(), sync(), adv(61_000), sync(), adv(600_000), sync()],
  }, (out) => {
    must(places(out).length === 0, '不去券商试');
    must(snap(out, out.steps.length - 1).breaker.consecutive_failures === 0, '不计入熔断');
  });
  add('place_account_alias_gone', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'settings', patch: { accounts: [{ alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live', default: true }] } }, { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 251 } } }, sync()],
  });
  add('place_failure_then_success_clears_count', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { placeHosted: [{ error: { cls: 'Broker', msg: 'x' } }] } }, sync(), adv(61_000), sync()],
  }, (out) => { must(snap(out, out.steps.length - 1).breaker.consecutive_failures === 0, '成功清零'); });

  // ================================================================ 对账途中的回报与竞态
  add('fill_during_other_modify', {
    router: router({ rows: [stk('NVDA'), stk('AMD')] }),
    setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } }), { op: 'track', name: 'B', spec: { account: '模拟', symbol: 'AMD', sec_type: 'STK', contract: { secType: 'STK', symbol: 'AMD', exchange: 'SMART', currency: 'USD' }, targets: { take_profit: 250 }, auto_close: { enabled: true, host_at_broker: true }, peak: 220 } }],
    steps: [sync(), { op: 'updateTrack', track: 'B', fields: { targets: { take_profit: 260 } } },
      { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }] }, { emit: [{ op: 'status', trade: trade(502, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }] }] } },
      sync()],
  });
  add('cancelled_by_broker_backoff', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Cancelled') }, sync(), sync(), adv(61_000), sync()],
  }, (out) => {
    must(JSON.stringify(out.steps[2].r.blocked).includes('撤掉了这张托管单'), '退避期说一声');
    must(notes(out, '撤掉了这张托管单').length === 1, '只说一次');
  });
  add('inactive_by_broker', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Inactive') }, sync()],
  }, (out) => { must(notes(out, '置为失效').length === 1, '失效'); });
  add('own_cancel_late_report', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: {} } }, sync(), { op: 'status', trade: trade(501, 'Cancelled') },
      { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 250 } } }, sync()],
  }, (out) => { must(places(out).length === 2, '我们自己撤的不进退避'); });
  add('cancel_failure_keeps_entry', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'rows', set: [] }, { op: 'router', push: { cancelHosted: [{ error: { cls: 'Error', msg: '撤单超时' } }] } }, sync(), sync()],
  });
  add('modify_false_drops_entry', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 260 } } }, { op: 'router', push: { modifyHosted: [{ ret: false }] } }, sync(), sync()],
  }, (out) => { must(places(out).length === 2, '券商不认识就丢缓存重挂'); });
  add('modify_throws_backoff', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 260 } } }, { op: 'router', push: { modifyHosted: [{ error: { cls: 'LinkDown' } }] } }, sync(), sync(), adv(60_001), sync()],
  });
  add('submitted_clears_pending_then_reject_is_modify', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Submitted') }, { op: 'error', reqId: 501, code: 10311, message: '拒' }, sync()],
  });
  add('early_error_before_place_returns', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'error', reqId: 501, code: 10311, message: '拒' }, sync()],
  });
  add('place_with_perm_and_zero_order_id', {
    router: router({ perm: true }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { placeHosted: [{ res: { order_id: 0 } }] } }, sync(), sync()],
  });
  add('place_with_null_order_id', {
    router: router({ perm: true }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { placeHosted: [{ res: { order_id: null } }] } }, sync()],
  });

  // ================================================================ 追价平仓(sweep)
  add('sweep_stop_rejected', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'error', reqId: 502, code: 201, message: 'Order rejected - reason: margin' },
      { op: 'rows', set: [stk('NVDA', { market_price: 150, market_value: 15000 })] },
      { op: 'triggered', track: 'A', state: 'stop_loss', reason: '价格 150 触及止损 160', row: {} }, sync(), sync()],
  }, (out) => {
    must(out.steps[3].r.out.fired[0].state === 'sweep:stop_loss', '追价平仓');
    must(mods(out).at(-1).a[1].lmt_price === 149.55, '149.55');
  });
  add('triggered_before_sync_no_sweep', {
    router: router({ rows: [stk('NVDA', { market_price: 150, market_value: 15000 })] }), setup: [trk('A')],
    steps: [{ op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[0].r.out.fired.length === 0 && out.steps[0].r.row.hosted === true, '没对过账不抢着追'); });
  add('triggered_covered_no_sweep', {
    router: router(), setup: [trk('A')], steps: [sync(), { op: 'triggered', track: 'A', state: 'take_profit', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[1].r.out.fired.length === 0, '有单负责'); });
  add('triggered_spot_stop_always_sweeps', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { stop_loss: 160 } })],
    steps: [sync(), { op: 'triggered', track: 'A', state: 'stop_loss', reason: '标的跌破', spotStop: true, row: {} }, sync()],
  }, (out) => { must(out.steps[1].r.out.fired.length === 1, '标的止损一定追价'); });
  add('triggered_blocked_by_gate', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'error', reqId: 502, code: 201, message: 'x' }, { op: 'breaker', action: 'engage' },
      { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }, { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[3].r.out.blocked.length === 1, '挡住了必须说'); must(notes(out, '但没有平仓').length === 1, '只提醒一次'); });
  add('triggered_combo_stop_sweeps', {
    router: router({ rows: [stk('SPX', { sec_type: 'BAG', key: '模拟|SPX|BAG' })] }), host: { naturals: { SPX: 1.2 } },
    setup: [trk('A', 'SPX', { sec_type: 'BAG', contract: { secType: 'BAG', symbol: 'SPX' } })],
    steps: [{ op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }],
  });
  add('sweep_chase_progress', {
    router: router(), host: {}, setup: [trk('A')],
    steps: [sync(), { op: 'error', reqId: 502, code: 201, message: 'x' }, { op: 'rows', set: [stk('NVDA', { market_price: 150, market_value: 15000 })] },
      { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }, sync(), sync(), sync(), sync(), sync(),
      { op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }, sync()],
  });
  add('sweep_chase_unavailable_quote', {
    router: router({ rows: [stk('SPX', { sec_type: 'OPT', key: '模拟|SPX|OPT' })] }), host: { naturals: { SPX: null } },
    setup: [trk('A', 'SPX', { sec_type: 'OPT', contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7500, right: 'P', exchange: 'SMART', currency: 'USD', multiplier: '100' } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { fired_at: '2026-09-11T16:00:00+00:00', fired_state: 'sweep:stop_loss' } }, sync()],
  });
  add('sweep_chase_warn_stuck', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { fired_at: '2026-09-11T16:00:00+00:00', fired_state: 'sweep:stop_loss' } }, ...Array.from({ length: 36 }, () => sync())],
  }, (out) => { must(notes(out, '仍未成交').length === 1, '追价太久提醒一次'); });
  void 0;
  add('sweep_chase_warn_stuck_pad', {
    router: router(), setup: [trk('A')], steps: [sync()],
  });
  add('clear_backoff_on_manual', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'error', reqId: 501, code: 10311, message: '拒' }, sync(), { op: 'clearBackoff', track: 'A' }, sync()],
  }, (out) => { must(places(out).length === 2, '人点了平仓,退避作废'); });

  // ================================================================ 认领与对账
  add('adopt_wait_hang_timeout', {
    router: router({}, {}), setup: [trk('A')],
    steps: [{ op: 'router', push: { listHostedOpen: [{ hang: true }] } }, sync(), adv(9_999), adv(1), sync()],
  }, (out) => { must(places(out).length === 2, '第二轮认领成功后才挂'); });
  add('adopt_fail_not_adopted_blocks', {
    router: router(), setup: [trk('A')],
    steps: [{ op: 'router', push: { listHostedOpen: [{ error: { cls: 'Error', msg: '读不到' } }] } }, sync(), sync()],
  }, (out) => { must(JSON.stringify(out.steps[1].r.blocked).includes('还没认领上'), '不挂不改'); });
  add('adopt_without_lister', { router: router({}, { listHostedOpen: false }), setup: [trk('A')], steps: [sync()] });
  add('adopt_covered_changes_readopts', {
    router: router({ covered: [], coveredIds: [], hostedOpen: [openRow('trk:${track:A}:tp', 311), openRow('trk:${track:A}:sl', 312, { order_type: 'STP', lmt_price: null, aux_price: 160 })] }),
    setup: [trk('A')],
    steps: [sync(), { op: 'router', set: { covered: ['模拟'] } }, sync(), sync()],
  });
  add('adopt_connects_record', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 901)] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'record', name: 'R', record: { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, events: [{ kind: 'status', payload: { status: 'Submitted', order_id: 901 } }] },
      { op: 'reconcile' }, sync()],
  });
  add('router_without_positions_failure', {
    router: router(), setup: [trk('A')], steps: [{ op: 'router', push: { positions: [{ error: { cls: 'Error', msg: '读持仓失败' } }] } }, sync(), sync()],
  }, (out) => { must(out.log.some((e) => e.c === 'store' && e.m === 'audit' && e.a[1] === 'hosted_positions_failed'), '读不到持仓不炸'); });
  add('account_unreachable_keeps_orders', {
    router: router({ rows: [] }), setup: [trk('A')], steps: [sync(), { op: 'router', set: { covered: [] } }, sync(), sync({ rows: [] })],
  });
  add('stale_snapshot_after_fill', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }] }] } },
      { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 255, stop_loss: 160 } } }, sync(), sync()],
  });
  add('empty_map_identity_after_fill', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 252 } } },
      { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }] }] } }, sync(), sync()],
  });
  add('live_kinds_and_tp_entry', {
    router: router(), setup: [trk('A')], steps: [{ op: 'liveKinds', track: 'A' }, sync(), { op: 'liveKinds', track: 'A' }, { op: 'tpEntry', track: 'A' }, { op: 'handleError', orderId: 999, code: 1, message: 'x' }, { op: 'handleError', orderId: 501, code: 110, message: 'x' }],
  });

  // ================================================================ 回报落库(callbacks)
  const ISO = (ms) => new Date(ms).toISOString();
  const rec = (name, over = {}, status = 'Submitted', events = null) => ({
    op: 'record', name, record: { signature: 'sig', created_at: ISO(T0 - 10 * MIN), account: { alias: '模拟', account_id: 'DU7654321', is_paper: true }, contract: { symbol: 'AAPL', secType: 'STK' }, order: { totalQuantity: 100 }, ...over },
    events: events ?? (status === null ? [] : [{ kind: 'status', payload: { status } }]),
  });
  const tr = (orderId, status, extra = {}) => ({ order: { orderId, permId: extra.permId ?? 0 }, orderStatus: { status, filled: extra.filled ?? 0, remaining: extra.remaining ?? 100 }, contract: { symbol: 'AAPL' } });
  const errOf = (reqId, code, message = '消息') => ({ op: 'error', reqId, code, message });
  const bind = (map) => ({ op: 'index', map });
  const sentNow = (orderId, kind = 'place', at) => ({ op: 'sent', orderId, kind, ...(at === undefined ? {} : { at }) });
  add('cb_error_unbound', {
    router: router(), setup: [],
    steps: [errOf(0, 110), errOf(-3, 110), errOf('x', 110), errOf(7, 110, null), errOf(8, 2104), errOf(9, 399), errOf(10, 404), errOf(11, 10089), errOf(12, 162),
      errOf(13, 200), sentNow(13, 'place'), errOf(13, 200), errOf(14, 110), adv(30_000), errOf(15, 110), adv(31_000), errOf(16, 110), errOf(17, '17', '字符串号'), errOf(18.7, 110.4, '小数')],
  }, (out) => { must(snap(out, out.steps.length - 1).early['16'] !== undefined, '攒着'); });
  add('cb_error_unbound_sent_recently_hosted', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Submitted') }, errOf(501, 110, '改价被拒'), sync(), errOf(501, 202, '撤'), sync()],
  });
  add('cb_error_bound_matrix', {
    router: router(), setup: [],
    steps: [rec('R'), bind({ 7: 'R', 8: 'R', 9: 'R' }), sentNow(7), sentNow(8), sentNow(9),
      errOf(7, 10089), errOf(7, 162), errOf(7, 200), errOf(7, 2104), errOf(7, 2199), errOf(7, 2200), errOf(7, 399), errOf(7, 404),
      errOf(7, 321), sentNow(7, 'place'), errOf(7, 321, '刚发过'), adv(10_001), errOf(7, 200, '过了窗口'),
      errOf(7, 135, '找不到'), errOf(7, 110, '价格档位'), errOf(8, 202, '已撤')],
  });
  add('cb_error_not_sent_by_session', {
    router: router(), setup: [],
    steps: [rec('R'), bind({ 7: 'R' }), sentNow(99), errOf(7, 110, '不是本会话发的'), { op: 'unsent' }, errOf(7, 110, '账本空了')],
  });
  add('cb_error_legacy_no_ledger', {
    router: router(), host: { noSentLedger: true }, setup: [],
    steps: [rec('R'), bind({ 7: 'R' }), errOf(7, 200, '歧义码不宣判'), errOf(7, 110, '旧口径:认得出记录就算'), errOf(7, 110, '已终态再来')],
  });
  add('cb_error_refuses_only', {
    router: router(), setup: [],
    steps: [rec('R1'), rec('R2'), rec('R3', {}, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }, { kind: 'status', payload: { status: 'Adjusted', lmt_price: 1 } }]),
      rec('R4', {}, 'Submitted', [{ kind: 'status', payload: { status: 'Adjusted' } }, { kind: 'status', payload: { status: 'Submitted' } }]), rec('R5', {}, null, []),
      bind({ 1: 'R1', 2: 'R2', 3: 'R3', 4: 'R4', 5: 'R5' }), sentNow(1), sentNow(2), sentNow(3), sentNow(4), sentNow(5),
      errOf(1, 104, '已成交不能改'), errOf(2, 161, '不在可撤状态'), errOf(3, 110, '改价被拒'), errOf(4, 110, '不是改价后的'), errOf(5, 10148, '撤不掉'), errOf(3, 202, '已撤'), errOf(1, 135, '找不到')],
  });
  add('cb_error_chase_hooks', {
    router: router(), host: { chaseRejected: true }, setup: [trk('A')],
    steps: [rec('R'), rec('R2'), bind({ 7: 'R', 8: 'R2' }), sentNow(7), sentNow(8), { op: 'closeChase', set: { 7: 'A', 8: 'A' } },
      errOf(7, 104, '改价被拒'), errOf(7, 104, '一分钟内不重复提醒'), adv(59_000), errOf(7, 161, '还在窗口内'), adv(2_000), errOf(7, 10148, '过了窗口'),
      errOf(8, 202, '追价单被撤'), errOf(8, 110, '追价单被拒')],
  });
  add('cb_error_chase_hooks_no_reject_method', {
    router: router(), host: { chaseRejected: false }, setup: [],
    steps: [rec('R'), bind({ 7: 'R' }), sentNow(7), { op: 'closeChase', set: { 7: 'A' } }, errOf(7, 104, '改价被拒')],
  });
  add('cb_status_flow', {
    router: router(), setup: [],
    steps: [rec('R'), rec('R2'), rec('R3'), rec('R4'), rec('R5'), bind({ 1: 'R', 2: 'R2', 3: 'R3', 4: 'R4', 5: 'R5' }),
      { op: 'status', trade: tr(1, 'Submitted') }, { op: 'status', trade: tr(1, 'Filled', { filled: 100, remaining: 0 }) }, { op: 'status', trade: tr(1, 'Cancelled') },
      { op: 'status', trade: tr(2, 'Filled', { filled: 60, remaining: 40 }) }, { op: 'status', trade: tr(3, 'ApiCancelled') }, { op: 'status', trade: tr(4, 'Inactive') },
      { op: 'status', trade: tr(5, 'PreSubmitted', { filled: null, remaining: null }) }, { op: 'status', trade: { order: { orderId: 5 }, orderStatus: {} } },
      { op: 'status', trade: { order: { permId: 5 } } }, { op: 'status', trade: {} }, { op: 'status', trade: null }, { op: 'status', trade: { order: { orderId: 5, permId: 4 }, orderStatus: { status: 'Filled', remaining: 0 } } }],
  });
  add('cb_status_unmatched_replay', {
    router: router({}, {}), setup: [],
    steps: [rec('R'),
      { op: 'status', trade: tr(21, 'Submitted') }, { op: 'status', trade: tr(21, 'Filled', { filled: 100, remaining: 0 }) },
      { op: 'exec', trade: tr(21, 'Filled'), fill: { execution: { execId: 'E1', time: '20260911 12:00:00', price: 230.5, shares: 100, side: 'BOT', acctNumber: 'DU7654321' }, contract: { secType: 'STK', conId: 265598 }, live: true } },
      { op: 'commission', trade: tr(21, 'Filled'), fill: {}, report: { execId: 'E1', commission: 1.25, realizedPNL: 15.5 } },
      { op: 'status', trade: { order: {}, orderStatus: { status: 'Submitted' } } }, { op: 'status', trade: { orderStatus: { status: 'Submitted' } } },
      bind({ 21: 'R' }), { op: 'reconcile' }],
  });
  add('cb_unmatched_cap_200', {
    router: router({}, {}), setup: [],
    steps: [rec('R'), ...Array.from({ length: 205 }, (_v, i) => ({ op: 'status', trade: tr(1000 + i, 'Submitted') })), bind({ 1204: 'R', 1000: 'R' }), { op: 'reconcile' }],
  });
  add('cb_exec_dedupe_and_variants', {
    router: router(), setup: [],
    steps: [rec('R'), bind({ 1: 'R' }),
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { execId: 'E1', time: '20260911 12:00:00', price: 10.5, shares: 5, side: 'BOT', acctNumber: 'DU7654321' }, contract: { secType: 'OPT', conId: 7 } } },
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { execId: 'E1', time: 'dup', price: 1, shares: 1 }, contract: {} } },
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { execId: 'E2', time: '20260911 12:00:01', price: 11, shares: 5, side: 'SLD' }, contract: { secType: 'BAG' }, live: false } },
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { price: '12', shares: 'abc' }, contract: null } },
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { price: 12, shares: 2 } } }, { op: 'exec', trade: tr(1, 'Filled'), fill: {} }, { op: 'exec', trade: tr(1, 'Filled'), fill: null },
      { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: { execId: 'E1', commission: 1.25, realizedPNL: 15.5 } },
      { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: { execId: 'E1', commission: 9 } }, { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: { commission: '2' } },
      { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: null }, { op: 'exec', trade: tr(5, 'Filled'), fill: { execution: { execId: 'E9' } } }, { op: 'commission', trade: tr(5, 'Filled'), fill: {}, report: { execId: 'C9' } }],
  });

  // ================================================================ 执行对账(reconcile)
  const OLDISO = ISO(T0 - 10 * MIN);
  const later = (min) => T0 + min * MIN;
  const openOf = (recName, orderId, permId, status = 'Submitted') => ({ order_ref: '${rec:' + recName + '}', order_id: orderId, perm_id: permId, status });
  add('rc_adopt_open', {
    router: router(), setup: [],
    steps: [rec('R'), rec('R2'), { op: 'router', set: { openOrders: [openOf('R', 21, 31), openOf('R2', 22, null, ''), { order_ref: '', order_id: 5 }, { order_id: 6 }] } },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(5) }, { op: 'reconcileDue', now: later(5) }, { op: 'reconcileDue', now: later(5) + 59_999 }, { op: 'reconcileDue', now: later(5) + 60_000 }],
  }, (out) => { must(out.steps[3].r.adopted === 2 && out.steps[4].r.adopted === 0, '认领一次'); });
  add('rc_no_lister', { router: router({}, { listOpenOrders: false }), setup: [], steps: [rec('R'), { op: 'reconcile', now: later(5) }] });
  add('rc_no_router', { router: null, setup: [], steps: [rec('R'), { op: 'reconcile', now: later(5) }] });
  add('rc_list_fails', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { listOpenOrdersDetailed: [{ error: { cls: 'Error', msg: '读不到未成交单' } }] } }, { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(6) }],
  });
  add('rc_list_hang_timeout', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { listOpenOrdersDetailed: [{ hang: true }] } }, { op: 'reconcile', now: later(5) }, adv(9_999), adv(1), { op: 'reconcile', now: later(6) }],
  }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'reconcile_failed' && e.a[2].error.includes('10 秒')), '超时'); });
  add('rc_missing_flag_no_executions', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R'), rec('R2', {}, ''), rec('R3', {}, 'PendingTrigger'), rec('R4', {}, null, []), { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(6) }],
  }, (out) => { must(notes(out, '去向不明').length === 3, '三条各说一次'); });
  add('rc_missing_flag_with_executions', {
    router: router(), setup: [],
    steps: [rec('R'), rec('R2'), { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(6) }, { op: 'reconcile', now: later(11) }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'executions').length === 1, '全标过就不用再问'); });
  add('rc_executions_throttle_and_new_session', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'reconcile', now: later(5) }, rec('R2'), { op: 'reconcile', now: later(6) }, { op: 'reconcile', now: later(9) }, rec('R3'), { op: 'reconcile', now: later(10.5) },
      { op: 'reconcileSoon' }, rec('R4'), { op: 'reconcile', now: later(11) }, { op: 'reconcile', now: later(12) }],
  });
  add('rc_executions_fail', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { executions: [{ error: { cls: 'Error', msg: '被节流' } }] } }, { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(6) }, { op: 'reconcile', now: later(11) }],
  }, (out) => { must(notes(out, '去向不明').length === 1, '问到了才下结论'); });
  add('rc_executions_hang', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { executions: [{ hang: true }] } }, { op: 'reconcile', now: later(5) }, adv(10_000), { op: 'reconcile', now: later(11) }],
  });
  add('rc_settle_from_fills_full', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', set: { execRows: [{ exec_id: 'X1', time: '2026-09-11T15:50:00+00:00', account_id: 'DU7654321', shares: 60, price: 10, order_id: 41, perm_id: 51, order_ref: '${rec:R}', commission: 1, contract: { secType: 'STK', symbol: 'AAPL', conId: 5 } },
      { exec_id: 'X2', time: '2026-09-11T15:51:00+00:00', account_id: 'DU7654321', shares: 40, price: 11, order_id: 41, perm_id: 51, order_ref: '${rec:R}', commission: 0.5, contract: { secType: 'STK', symbol: 'AAPL' } }] } },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(11) }],
  }, (out) => { must(out.steps[2].r.filled === 1, '填满'); });
  add('rc_settle_partial', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', set: { execRows: [{ exec_id: 'X1', time: '2026-09-11T15:50:00+00:00', shares: 30, price: 10, order_id: 41, perm_id: 51, order_ref: '${rec:R}', commission: 1, contract: { secType: 'STK' } }] } },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_settle_bag_rows', {
    router: router(), setup: [],
    steps: [rec('R', { contract: { symbol: 'SPX', secType: 'BAG' }, order: { totalQuantity: 2 } }),
      { op: 'router', set: { execRows: [{ exec_id: 'B1', shares: 2, price: -3, order_ref: '${rec:R}', contract: { secType: 'BAG' } }, { exec_id: 'L1', shares: 2, price: 1, order_ref: '${rec:R}', contract: { secType: 'OPT' } }, { exec_id: 'L2', shares: 2, price: 2, order_ref: '${rec:R}', contract: { secType: 'OPT' } }, { exec_id: '', shares: 1, order_ref: '${rec:R}' }] } },
      { op: 'reconcile', now: later(5) }],
  });
  add('rc_settle_known_fills_not_duplicated', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', {}, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }, { kind: 'fill', payload: { exec_id: 'K1', qty: 100, price: 9 } }]),
      { op: 'fills', rows: [{ exec_id: 'K1', shares: 100, price: 9, order_ref: '${rec:R}', contract: { secType: 'STK' } }, { exec_id: 'K1', shares: 1, order_ref: '${rec:R}', contract: { secType: 'STK' } }] },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_settle_quantity_zero_uses_order_quantity', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { order: { quantity: 5 } }), { op: 'fills', rows: [{ exec_id: 'Q1', shares: 5, price: 9, order_ref: '${rec:R}', contract: { secType: 'STK' } }] }, { op: 'reconcile', now: later(5) }],
  });
  add('rc_settle_float_rounding', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { order: { totalQuantity: 0.3 } }), { op: 'fills', rows: [{ exec_id: 'F1', shares: 0.1, order_ref: '${rec:R}', contract: { secType: 'STK' } }, { exec_id: 'F2', shares: 0.2, order_ref: '${rec:R}', contract: { secType: 'STK' } }] },
      { op: 'reconcile', now: later(5) }],
  });
  add('rc_settle_already_finalized', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R'), { op: 'fills', rows: [{ exec_id: 'F1', shares: 100, order_ref: '${rec:R}', contract: { secType: 'STK' } }] }, { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_grace_and_pending_and_covered', {
    router: router({ coveredIds: ['U1234567'] }), setup: [],
    steps: [rec('Fresh', { created_at: ISO(T0 - 30_000) }), rec('Old'), rec('Other', { account: { alias: '主账户', account_id: 'U1234567' } }),
      rec('Pend'), { op: 'pending', ids: ['${rec:Pend}'] },
      { op: 'reconcile', now: T0 }, { op: 'reconcile', now: later(5) }, { op: 'router', set: { coveredIds: null } }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_grace_status_after_now', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { created_at: ISO(T0 - 10 * MIN) }, null, []), { op: 'rawEvent', record: 'R', kind: 'status', payload: { status: 'Submitted' }, at: T0 + 90_000 },
      { op: 'reconcile', now: T0 + 60_000 }, { op: 'reconcile', now: T0 + 200_000 }, { op: 'reconcile', now: T0 + 400_000 }],
  });
  add('rc_grace_status_recent_after_old_created', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { created_at: ISO(T0 - 3 * 3600_000) }, null, []), { op: 'rawEvent', record: 'R', kind: 'status', payload: { status: 'PendingTrigger' }, at: T0 - 3 * 3600_000 + 1000 },
      { op: 'rawEvent', record: 'R', kind: 'status', payload: { status: 'Submitted' }, at: T0 - 30_000 }, { op: 'reconcile', now: T0 }, { op: 'reconcile', now: T0 + 100_000 }],
  });
  add('rc_hosted_records_by_signature', {
    router: router({}, {}), setup: [trk('A')],
    steps: [rec('H1', { signature: 'trk:${track:A}:tp', order: { quantity: 100, action: 'SELL' } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: 901 } }]),
      rec('H2', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: 902 } }]),
      rec('H3', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', order_id: 902, perm_id: 0, status: 'PreSubmitted' }, { order_ref: 'trk:${track:A}:tp', order_id: 905, perm_id: 99, status: 'PreSubmitted' }] } },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_hosted_fills_by_known_ids', {
    router: router({}, { executions: false }), setup: [trk('A')],
    steps: [rec('H1', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: 901, perm_id: 77 } }]),
      rec('H2', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }]),
      { op: 'fills', rows: [{ exec_id: 'A1', shares: 100, order_id: 901, perm_id: 0, order_ref: 'trk:${track:A}:tp', contract: { secType: 'STK' } }, { exec_id: 'A2', shares: 100, order_id: 111, perm_id: 78, order_ref: 'trk:${track:A}:tp', contract: { secType: 'STK' } }] },
      { op: 'reconcile', now: later(5) }],
  });
  add('rc_hosted_adjusted_no_false_alarm', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 255 } } }, sync(), { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', order_id: 501, perm_id: 0, status: 'Submitted' }] } },
      { op: 'reconcile', now: later(5) }, sync(), { op: 'reconcile', now: later(11) }],
  });

  // ================================================================ 变异检验补的用例(幸存者逼出来的)
  const filledTrade = (id) => trade(id, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } });
  add('sweep_auto_breaker_keeps_chasing', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { fired_at: '2026-09-11T16:00:00+00:00', fired_state: 'sweep:stop_loss' } }, { op: 'breaker', action: 'engageAuto' }, { op: 'row', index: 0, patch: { market_price: 149 } }, sync(), sync(), sync(), sync(), sync(), sync()],
  }, (out) => { must(mods(out).length >= 1, '自动熔断不挡追价平仓'); });
  add('triggered_auto_breaker_still_sweeps', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'error', reqId: 502, code: 201, message: 'x' }, { op: 'breaker', action: 'engageAuto' }, { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[3].r.out.fired.length === 1, '自动熔断不挡追价'); });
  add('account_unreachable_keeps_orders_real', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'router', set: { covered: [], rows: [] } }, sync(), sync(), { op: 'router', set: { covered: ['模拟'] } }, sync()],
  }, (out) => { must(cancels(out).length === 2, '读不到不撤,读到了没有才撤'); });
  add('adopt_dup_zero_or_missing_id', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 0), openRow('trk:${track:A}:tp', 5), { order_ref: 'trk:${track:A}:tp', quantity: 100 }] }),
    setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })], steps: [sync()],
  }, (out) => { must(cancels(out).length === 0, '单号为 0 / 没有的重复单不去撤'); });
  add('own_cancel_report_during_cancel', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: {} } }, { op: 'router', push: { cancelHosted: [{ emit: [{ op: 'status', trade: trade(501, 'Cancelled') }] }] } }, sync(),
      { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 250 } } }, sync()],
  }, (out) => { must(places(out).length === 2, '撤单途中到的撤单回报不进退避'); });
  add('triggered_bag_take_profit_unsynced', {
    router: router({ rows: [stk('SPX', { sec_type: 'BAG', key: '模拟|SPX|BAG' })] }), setup: [trk('A', 'SPX', { sec_type: 'BAG', contract: { secType: 'BAG', symbol: 'SPX' } })],
    steps: [{ op: 'triggered', track: 'A', state: 'take_profit', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[0].r.out.fired.length === 0, '组合的止盈有单负责,没对过账也不抢着追'); });
  add('triggered_already_fired_no_sweep', {
    router: router(), setup: [trk('A')],
    steps: [{ op: 'updateTrack', track: 'A', fields: { fired_at: '2026-09-11T15:00:00+00:00', fired_state: 'take_profit' } }, { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', spotStop: true, row: {} }],
  }, (out) => { must(out.steps[1].r.out.fired.length === 0, '已落闩的不再追价'); });
  add('modify_backoff_boundary', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 260 } } }, sync(), { op: 'error', reqId: 501, code: 110, message: '拒' }, adv(59_999), sync(), adv(1), sync()],
  }, (out) => { must(mods(out).length === 2, '退避到点那一刻就改'); });
  add('breaker_auto_plus_other_blocker_cancels', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'breaker', action: 'engageAuto' }, { op: 'settings', patch: { policies: { auto_execute: false } } }, sync()],
  }, (out) => { must(cancels(out).length === 2, '自动熔断之外还有别的闸门就撤'); });
  add('stop_hosting_midway_three_items', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250, stop_loss: 160, profit_drawdown_pct: 30 }, peak: 260 })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 255, stop_loss: 165, profit_drawdown_pct: 40 } } },
      { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'status', trade: filledTrade(501) }] }] } }, sync()],
  }, (out) => { must(places(out).length === 3 && mods(out).length === 1, '落闩之后不再改后面的单'); });
  add('rc_pending_added_during_await', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { listOpenOrdersDetailed: [{ delay: 500 }] } }, { op: 'reconcile', now: later(5) }, { op: 'pending', ids: ['${rec:R}'] }, adv(500)],
  }, (out) => { must(notes(out, '去向不明').length === 0, '等券商回话时才进队列的也算'); });
  add('rc_pending_removed_during_await', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'pending', ids: ['${rec:R}'] }, { op: 'router', push: { listOpenOrdersDetailed: [{ delay: 500 }] } }, { op: 'reconcile', now: later(5) }, { op: 'pending', ids: [] }, adv(500)],
  }, (out) => { must(notes(out, '去向不明').length === 0, '等券商回话时从队列摘掉的也算'); });
  add('rc_settle_epsilon', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { order: { totalQuantity: 0.3 } }), { op: 'fills', rows: [{ exec_id: 'E1', shares: 0.29999999999999993, order_ref: '${rec:R}', contract: { secType: 'STK' } }] }, { op: 'reconcile', now: later(5) }],
  }, (out) => { must(out.steps[2].r.filled === 1, '差一点点算填满'); });
  add('rc_hosted_perm_id_match', {
    router: router({}, {}), setup: [trk('A')],
    steps: [rec('H1', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: 901, perm_id: 77 } }]),
      rec('H2', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: 902 } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', order_id: 555, perm_id: 77, status: 'PreSubmitted' }] } }, { op: 'reconcile', now: later(5) }],
  }, (out) => { must(out.steps[3].r.adopted === 1, '按 permId 认'); });
  add('rc_non_hosted_signature_not_matched', {
    router: router({}, {}), setup: [],
    steps: [rec('R', { signature: 'S1' }), { op: 'router', set: { openOrders: [{ order_ref: 'S1', order_id: 21, perm_id: 31, status: 'Submitted' }] } }, { op: 'reconcile', now: later(5) }],
  }, (out) => { must(out.steps[2].r.adopted === 0, '普通单只按记录 id 认'); });
  add('rc_finalized_set_guard', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R'), { op: 'fills', rows: [{ exec_id: 'F1', shares: 100, order_ref: '${rec:R}', contract: { secType: 'STK' } }] }, { op: 'finalize', rec: 'R' }, { op: 'reconcile', now: later(5) }],
  }, (out) => { must(out.steps[3].r.filled === 0, '已落过终态的不再落'); });

  // ================================================================ 变异检验第二轮补的用例
  const long = (n, ch = '长') => ch.repeat(n);
  const MD = [101, 300, 309, 316, 317, 322, 354, 10089, 10090, 10091, 10167, 10168, 10185, 10197];
  const DR = [162, 165, 166, 366, 420, 430, 10182, 10186, 10187, 10225, 10314];
  add('cb_error_code_tables', {
    router: router(), setup: [],
    steps: [rec('R'), bind({ 7: 'R' }), sentNow(7), ...[...MD, ...DR].flatMap((c) => [c - 1, c, c + 1].map((d) => errOf(7, d, `码 ${d}`))),
      ...[...MD, ...DR].flatMap((c) => [c - 1, c, c + 1].map((d) => errOf(8, d, `未绑 ${d}`)))],
  });
  add('cb_info_range_boundaries', {
    router: router(), setup: [], steps: [rec('R'), bind({ 7: 'R' }), sentNow(7), ...[2099, 2100, 2101, 2150, 2199, 2200].map((c) => errOf(7, c, `信息 ${c}`)), ...[2099, 2100, 2199, 2200].map((c) => errOf(9, c, `未绑 ${c}`))],
  });
  add('cb_window_boundaries', {
    router: router(), setup: [],
    steps: [rec('R'), rec('R2'), bind({ 7: 'R', 8: 'R2' }), sentNow(7, 'place', T0 - 10_000), sentNow(8, 'place', T0 - 10_001), sentNow(9, 'modify', T0 - 10_000), sentNow(10, 'modify', T0 - 10_001),
      errOf(7, 200, '正好 10 秒'), errOf(8, 200, '超 1 毫秒'), errOf(9, 110, '未绑,正好 10 秒'), errOf(10, 110, '未绑,超 1 毫秒')],
  });
  add('cb_chase_refusal_boundary', {
    router: router(), host: { chaseRejected: true }, setup: [trk('A')],
    steps: [rec('R'), bind({ 7: 'R' }), sentNow(7), { op: 'closeChase', set: { 7: 'A' } }, errOf(7, 104, '1'), adv(59_999), errOf(7, 104, '2'), adv(1), errOf(7, 104, '3'), errOf(7, 104, '4')],
  });
  add('cb_early_cleanup_boundary', {
    router: router(), setup: [], steps: [errOf(301, 110, 'a'), adv(59_999), errOf(302, 110, 'b'), adv(1), errOf(303, 110, 'c'), adv(1), errOf(304, 110, 'd')],
  });
  add('cb_unmatched_replay_keeps_200', {
    router: router({}, {}), setup: [], steps: [rec('R'), ...Array.from({ length: 200 }, (_v, i) => ({ op: 'status', trade: tr(2000 + i, 'Submitted') })), { op: 'reconcile' }],
  });
  add('cb_empty_timeline_error', {
    router: router(), setup: [], steps: [rec('R', {}, null, []), bind({ 7: 'R' }), sentNow(7), errOf(7, 110, '时间线空')],
  });
  add('cb_exec_missing_and_unit_fields', {
    router: router(), setup: [],
    steps: [rec('R'), bind({ 1: 'R' }), { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { execId: 'E7' } } },
      { op: 'exec', trade: tr(1, 'Filled'), fill: { execution: { execId: 'E8', shares: 1, price: 1, side: 'BOT' }, contract: { secType: 'STK', conId: 1 } } },
      { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: { execId: 'C8', commission: 1 } }, { op: 'commission', trade: tr(1, 'Filled'), fill: {}, report: { execId: 'C9' } }],
  });
  add('cb_unbound_recently_sent_goes_to_hosted', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 901)] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), sentNow(901, 'modify'), errOf(901, 110, '改价被拒'), sync()],
  }, (out) => { must(out.log.some((e) => e.c === 'notify' && e.a[2].includes('改价被券商拒绝')), '交给托管那一路'); });
  add('hosted_long_error_messages', {
    router: router({}, {}), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { listHostedOpen: [{ error: { cls: 'Error', msg: long(320) } }], positions: [{ error: { cls: 'Error', msg: long(320) } }], placeHosted: [{ error: { cls: 'Broker', msg: long(320) } }] } },
      sync(), sync(), sync()],
  }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'hosted_place_failed' && e.a[2].error.length === 300), '截 300'); });
  add('hosted_cancel_long_error', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'rows', set: [] }, { op: 'router', push: { cancelHosted: [{ error: { cls: 'Error', msg: long(320) } }] } }, sync()],
  }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'hosted_cancel_failed' && e.a[2].error.length === 300), '截 300'); });
  add('hosted_dup_cancel_long_error', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 82), openRow('trk:${track:A}:tp', 86)] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'router', push: { cancelHosted: [{ error: { cls: 'Error', msg: long(260) } }] } }, sync()],
  }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'hosted_duplicate_cancel_failed' && e.a[2].error.length === 200), '截 200'); });
  add('rc_long_error_messages', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'router', push: { listOpenOrdersDetailed: [{ error: { cls: 'Error', msg: long(320) } }], executions: [{ error: { cls: 'Error', msg: long(320) } }] } },
      { op: 'reconcile', now: later(5) }, { op: 'reconcile', now: later(6) }],
  }, (out) => { must(out.log.filter((e) => e.m === 'audit' && String(e.a[1]).endsWith('failed')).every((e) => e.a[2].error.length === 300), '截 300'); });
  for (const [kind, over] of [['sl', { order_type: 'STP', lmt_price: null, aux_price: 160 }], ['trail', { order_type: 'TRAIL', lmt_price: null, trailing_percent: 10 }], ['ptrail', { order_type: 'STP', lmt_price: null, aux_price: 236 }], ['zz', {}]]) {
    add(`hosted_filled_kind_${kind}`, {
      router: router({ hostedOpen: [openRow(`trk:\${track:A}:${kind}`, 91, over)] }), setup: [trk('A')],
      steps: kind === 'sl' ? [sync(), { op: 'status', trade: filledTrade(91) }, sync()] : [{ op: 'router', push: { cancelHosted: [{ emit: [{ op: 'status', trade: filledTrade(91) }] }] } }, sync(), sync()],
    }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'hosted_fill'), '落闩记账'); });
  }
  add('hosted_partial_fraction', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'status', trade: trade(501, 'Submitted', { orderStatus: { status: 'Submitted', filled: 1, remaining: 99 } }) }, { op: 'rows', set: [stk('NVDA', { quantity: 70 })] }, sync()],
  });
  add('hosted_fill_after_track_deleted', {
    router: router(), setup: [trk('A')], steps: [sync(), { op: 'deleteTrack', track: 'A' }, { op: 'status', trade: filledTrade(501) }],
  }, (out) => { must(out.log.some((e) => e.m === 'audit' && e.a[1] === 'hosted_fill' && e.a[2].symbol === '?' && e.a[2].leg === ''), '追踪没了记 ?'); });
  add('triggered_live_gate_blocks', {
    router: router({ rows: [stk('NVDA', { account: '主账户', key: '主账户|NVDA|STK' })], covered: ['主账户'], coveredIds: ['U1234567'] }), setup: [trk('A', 'NVDA', { account: '主账户' })],
    steps: [{ op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', spotStop: true, row: {} }, { op: 'settings', patch: { policies: { allow_live_trading: true } } }, { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', spotStop: true, row: {} }],
  }, (out) => { must(out.steps[0].r.out.blocked.length === 1 && out.steps[2].r.out.fired.length === 1, '实盘闸门'); });
  add('hosted_clear_resets_cache', {
    router: router(), setup: [trk('A')],
    steps: [sync(), { op: 'clear' }, { op: 'status', trade: filledTrade(501) }, { op: 'triggered', track: 'A', state: 'stop_loss', reason: 'r', spotStop: false, row: {} }, sync()],
  });
  add('hosted_track_deleted_midloop', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250, stop_loss: 160 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 255, stop_loss: 165 } } },
      { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'deleteTrack', track: 'A' }] }] } }, sync()],
  }, (out) => { must(mods(out).length === 1, '追踪删了不再改下一张'); });
  add('hosted_modify_false_after_fill', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [sync(), { op: 'updateTrack', track: 'A', fields: { targets: { take_profit: 260 } } },
      { op: 'router', push: { modifyHosted: [{ emit: [{ op: 'status', trade: filledTrade(501) }], ret: false }] } }, sync(), sync()],
  });
  add('triggered_profit_trail_covered', {
    router: router(), setup: [trk('A', 'NVDA', { targets: { profit_drawdown_pct: 30 }, peak: 260 })],
    steps: [sync(), { op: 'triggered', track: 'A', state: 'profit_trail', reason: 'r', row: {} }],
  }, (out) => { must(out.steps[1].r.out.fired.length === 0, '利润回撤有 ptrail 单负责'); });
  const deriv = (sym, secType, over = {}) => ({ ...stk(sym, { sec_type: secType, key: `模拟|${sym}|${secType}` }), ...over });
  add('triggered_derivative_spot_reached', {
    router: router({ rows: [stk('NVDA'), deriv('SPX', 'OPT'), deriv('ES', 'FOP'), deriv('NDX', 'BAG')] }),
    setup: [trk('A'), trk('O', 'SPX', { sec_type: 'OPT', contract: { secType: 'OPT', symbol: 'SPX' } }), trk('F', 'ES', { sec_type: 'FOP', contract: { secType: 'FOP', symbol: 'ES' } }), trk('B', 'NDX', { sec_type: 'BAG', contract: { secType: 'BAG', symbol: 'NDX' } })],
    steps: [{ op: 'triggered', track: 'A', rowIndex: 0, state: 'take_profit', reason: 'r', spotReached: true, row: {} }, { op: 'triggered', track: 'O', rowIndex: 1, state: 'take_profit', reason: 'r', spotReached: true, row: {} },
      { op: 'triggered', track: 'F', rowIndex: 2, state: 'take_profit', reason: 'r', spotReached: true, row: {} }, { op: 'triggered', track: 'B', rowIndex: 3, state: 'take_profit', reason: 'r', spotReached: true, row: {} }],
  }, (out) => { must(out.steps.map((x) => x.r.out.fired.length).join() === '0,1,1,1', '衍生品标的到价追价,正股不追'); });
  add('adopt_dup_missing_id_first', {
    router: router({ hostedOpen: [{ order_ref: 'trk:${track:A}:tp', quantity: 100 }, openRow('trk:${track:A}:tp', 1)] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })], steps: [sync()],
  });
  add('adopt_dup_id_one_cancelled', {
    router: router({ hostedOpen: [openRow('trk:${track:A}:tp', 1), openRow('trk:${track:A}:tp', 5)] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })], steps: [sync()],
  }, (out) => { must(cancels(out).some((e) => e.a[0] === 1), '单号 1 的重复单要撤'); });
  add('rc_settle_epsilon_variants', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { order: { totalQuantity: 1 } }), rec('R2', { order: { totalQuantity: 1 } }),
      { op: 'fills', rows: [{ exec_id: 'E1', shares: 0.9999999995, order_ref: '${rec:R}', contract: { secType: 'STK' } }, { exec_id: 'E2', shares: 0.999999999, order_ref: '${rec:R2}', contract: { secType: 'STK' } }] },
      { op: 'reconcile', now: later(5) }],
  });
  add('rc_minus_one_ids', {
    router: router({}, { executions: false }), setup: [trk('A')],
    steps: [rec('H1', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: -1 } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', status: 'Submitted' }] } }, { op: 'reconcile', now: later(5) },
      { op: 'fills', rows: [{ exec_id: 'M1', shares: 100, order_ref: 'trk:${track:A}:tp', contract: { secType: 'STK' } }] }, { op: 'router', set: { openOrders: [] } }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_hosted_rows_two_missing_ids', {
    router: router({}, {}), setup: [trk('A')],
    steps: [rec('H3', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', perm_id: 5, status: 'Submitted' }, { order_ref: 'trk:${track:A}:tp', perm_id: 6, status: 'PreSubmitted' }, { order_ref: 'trk:${track:A}:tp', order_id: 1, status: 'Inactive' }] } },
      { op: 'reconcile', now: later(5) }],
  });
  add('adopt_dup_two_missing_ids', {
    router: router({ hostedOpen: [{ order_ref: 'trk:${track:A}:tp', quantity: 11 }, { order_ref: 'trk:${track:A}:tp', quantity: 22 }, openRow('trk:${track:A}:sl', 3)] }),
    setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })], steps: [sync()],
  });
  add('rc_minus_one_ids_partial_rows', {
    router: router({}, { executions: false }), setup: [trk('A')],
    steps: [rec('H1', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted', order_id: -1 } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', order_id: 5, status: 'Submitted' }] } }, { op: 'reconcile', now: later(5) },
      { op: 'fills', rows: [{ exec_id: 'M2', shares: 100, order_id: 7, order_ref: 'trk:${track:A}:tp', contract: { secType: 'STK' } }] }, { op: 'router', set: { openOrders: [] } }, { op: 'reconcile', now: later(11) }],
  });
  add('rc_hosted_rows_missing_order_id_sort', {
    router: router({}, {}), setup: [trk('A')],
    steps: [rec('H3', { signature: 'trk:${track:A}:tp', order: { quantity: 100 } }, 'Submitted', [{ kind: 'status', payload: { status: 'Submitted' } }]),
      { op: 'router', set: { openOrders: [{ order_ref: 'trk:${track:A}:tp', perm_id: 5, status: 'Submitted' }, { order_ref: 'trk:${track:A}:tp', order_id: 1, status: 'Submitted' }] } }, { op: 'reconcile', now: later(5) }],
  });
  add('rc_created_recent_status_old', {
    router: router({}, { executions: false }), setup: [],
    steps: [rec('R', { created_at: ISO(T0 - 30_000) }, null, []), { op: 'rawEvent', record: 'R', kind: 'status', payload: { status: 'Submitted' }, at: T0 - 3 * 3600_000 }, { op: 'reconcile', now: T0 }],
  }, (out) => { must(notes(out, '去向不明').length === 0, '创建时间也算宽限的起点'); });
  add('rc_exec_throttle_boundary', {
    router: router(), setup: [],
    steps: [rec('R'), { op: 'reconcile', now: later(5) }, rec('R2'), { op: 'reconcile', now: later(10) - 1 }, { op: 'reconcile', now: later(10) }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'executions').length === 2, '5 分钟整才再问'); });
  const oldIso = (ms) => new Date(ms).toISOString();
  add('rc_fresh_zero_now', {
    router: router(), setup: [],
    steps: [rec('Z1', { created_at: oldIso(-600_000) }), { op: 'reconcile', now: 0 }, rec('Z2', { created_at: oldIso(-600_000) }), { op: 'reconcile', now: 60_000 }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'executions').length === 1, '0 时刻之后 5 分钟内不再问'); });
  add('rc_fresh_negative_now', {
    router: router(), setup: [],
    steps: [rec('N1', { created_at: oldIso(-900_000) }), { op: 'reconcile', now: -100_000 }, rec('N2', { created_at: oldIso(-900_000) }), { op: 'reconcile', now: -90_000 }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'executions').length === 1, '负时刻也只问一次'); });
  add('rc_covered_changes_midway', {
    router: router({ coveredIds: ['U1234567'] }), setup: [],
    steps: [rec('R'), { op: 'reconcile', now: later(5) }, { op: 'router', set: { coveredIds: ['DU7654321'] } }, { op: 'reconcile', now: later(11) }],
  });
  return S;
}
