// engine_core 簇对拍的命名场景(照 engine-ts/tests 里碰 TradingEngine 的那些用例写:fanout、shorthand、protections、submit-intent、link-engine、
// tracker-loop、tracker-allday、fix-engine-hosted、fix-tracker-*、spot-stop、track-exits、wake-guard、combo-close、close-price……),再加钱路径上的细节
// (熔断的计数、批内熔断、保护规则放行平仓、条件单的闩、追价平仓的认领与终态……)。脚本格式见 engine_core_world.mjs 开头。
// 每个场景可以带 check(out):对 TS 现跑的结果断言头条期望,免得假宿主接错了线、生成出一份自洽但错的夹具。
import { T0, MIN, stk, trk, trade, openRow } from './engine_scenarios.mjs';

export { T0, MIN, stk, trk, trade, openRow };

// ---------------------------------------------------------------- 订单与脚本的积木
export const stockOrder = (over = {}, orderOver = {}, contractOver = {}) => ({
  intent_summary: '限价 230 买入 100 股 AAPL',
  contract: { secType: 'STK', symbol: 'AAPL', exchange: 'SMART', currency: 'USD', ...contractOver },
  execution_type: 'IMMEDIATE', trigger: null, account: 'DEFAULT',
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 100, price_mode: 'EXPLICIT', lmtPrice: 230.0, tif: 'DAY', outsideRth: false, ...orderOver },
  reason: '回调到位', confidence: 0.99, warnings: [], ...over,
});
const leg = (action, ratio, strike, right = 'C', expiry = '20260911') => ({ action, ratio, lastTradeDateOrContractMonth: expiry, strike, right, tradingClass: 'SPXW', multiplier: '100' });
export const flyOrder = (over = {}, orderOver = {}, base = 7500) => ({
  intent_summary: `买入 SPX ${base}/${base + 15}/${base + 30} 蝶`,
  contract: { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', combo_strategy: 'BUTTERFLY', legs: [leg('BUY', 1, base), leg('SELL', 2, base + 15), leg('BUY', 1, base + 30)] },
  execution_type: 'IMMEDIATE', trigger: null, account: 'DEFAULT',
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'AUTO_MID', lmtPrice: null, tif: 'DAY', outsideRth: false, ...orderOver },
  reason: '中心在现价', confidence: 0.99, warnings: [], ...over,
});
export const optOrder = (over = {}, orderOver = {}) => ({
  intent_summary: '限价 3.2 买入 1 张 AAPL 0918 230C',
  contract: { secType: 'OPT', symbol: 'AAPL', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20260918', strike: 230, right: 'C', multiplier: '100' },
  execution_type: 'IMMEDIATE', trigger: null, account: 'DEFAULT',
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'EXPLICIT', lmtPrice: 3.2, tif: 'DAY', outsideRth: false, ...orderOver },
  reason: '', confidence: 0.99, warnings: [], ...over,
});
export const condOrder = (over = {}, orderOver = {}, trig = {}, base = 7500) => flyOrder({
  intent_summary: 'SPX 到 7505 再买入蝶', execution_type: 'CONDITIONAL',
  trigger: { type: 'PRICE', symbol: 'SPX', secType: 'IND', operator: '<=', value: 7505, ...trig }, ...over,
}, orderOver, base);
export const payload = (orders, rejections = []) => ({ orders, rejections });
export const llm = (orders, rejections = [], extra = {}) => ({ payload: payload(orders, rejections), ...extra });

export const baseRouter = (over = {}, caps = {}) => ({
  caps: { quoteCapability: true, qualify: true, optionQuotes: true, streamQuotes: true, spotInfo: true, coveredAccounts: true, coveredIds: true, listOpenOrders: true, executions: true, connected: true, ...caps },
  rows: [], prices: { AAPL: 229.5, SPX: 7510.25 }, legQuotes: [
    { action: 'BUY', ratio: 1, bid: 22.0, ask: 22.6 }, { action: 'SELL', ratio: 2, bid: 12.4, ask: 12.9 }, { action: 'BUY', ratio: 1, bid: 6.1, ask: 6.5 }],
  covered: ['模拟', '主账户', '副账户'], coveredIds: ['DU7654321', 'U1234567', 'U7777777'], connected: ['paper'], ...over,
});
const live = { policies: { auto_execute: true, allow_live_trading: true } };
const auto = { policies: { auto_execute: true } };
const ins = (text, extra = {}) => ({ op: 'instruction', text, ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const must = (cond, msg) => { if (!cond) throw new Error(`夹具自检失败:${msg}`); };
const routerCalls = (out, m) => out.log.filter((e) => e.c === 'router' && e.m === m);
const notes = (out, text) => out.log.filter((e) => e.c === 'notify' && e.a.join('|').includes(text));
const snap = (out, i) => { for (let k = i; k >= 0; k -= 1) if (out.steps[k].snap) return out.steps[k].snap; throw new Error('没有快照'); };
const res = (out, i) => out.steps[i].r;
const dec = (x) => JSON.parse(JSON.stringify(x));
const lastDump = (out, table) => out.dump[table];

export function scenarios() {
  const S = [];
  const add = (name, script, check) => S.push({ name, script: { start: T0, ...script }, check });

  // ================================================================ 指令:正常路径
  add('instr_stock_submit', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } },
    steps: [ins('买入 AAPL 100股 limit 230')],
  }, (out) => {
    const r = res(out, 0);
    must(r.submitted.length === 1 && r.submitted[0].order_id === 501 && r.submitted[0].mode === 'immediate', '立即单提交');
    must(routerCalls(out, 'place').length === 1, 'place 一次');
    must(r.llm.model === 'claude-opus-5', 'llm 摘要');
    must(Object.keys(snap(out, 0).orderIndex).length >= 1, 'orderIndex 建了');
  });
  add('instr_validated_only_auto_off', {
    settings: { policies: { auto_execute: false } }, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230')],
  }, (out) => { must(res(out, 0).validated_only.length === 1 && routerCalls(out, 'place').length === 0, '自动执行关着不发'); });
  add('instr_dry_run_auto_on', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230', { dryRun: true })],
  }, (out) => { must(res(out, 0).validated_only.length === 1 && routerCalls(out, 'qualify').length === 1, '只校验 + 预热'); });
  add('instr_prewarm_failure_harmless', {
    settings: auto, router: baseRouter({ behaviors: { qualify: [{ error: { cls: 'Error', msg: 'qualify down' } }] } }), parser: { behaviors: { parse: [llm([stockOrder()])] } },
    steps: [ins('买入 AAPL', { dryRun: true })],
  });
  add('instr_prewarm_without_qualify_cap', {
    settings: auto, router: baseRouter({}, { qualify: false }), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL', { dryRun: true })],
  }, (out) => { must(routerCalls(out, 'qualify').length === 0, '没有 qualify 就不预热'); });
  add('instr_no_router_snapshot_skipped', {
    settings: auto, router: null, parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230'), ins('买入 AAPL 100股 limit 230', { dryRun: true })],
  }, (out) => { must(res(out, 0).rejections.length === 1 && res(out, 0).rejections[0].code === 'IBKR_ERROR', '没接券商 → 券商错'); });
  add('instr_snapshot_prices_fetched', {
    settings: auto, router: baseRouter({ prices: { AAPL: 229.5, SPX: 7510.25, NVDA: 0, TSLA: null }, behaviors: { indexPrice: [{}, { error: { cls: 'Error', msg: 'quote down' } }] } }),
    parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230 然后看 NVDA TSLA SPX', { snap: { AAPL: '228.5' } })],
  }, (out) => { must(routerCalls(out, 'indexPrice').length >= 2, '取了行情'); });
  add('instr_explicit_moment', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230', { atMs: T0 + 3 * 60 * MIN })],
  });
  add('instr_option_and_fly_submit', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([optOrder(), flyOrder()])] } }, steps: [ins('买一张 AAPL call 再买 SPX 蝶')],
  }, (out) => { must(res(out, 0).submitted.length + res(out, 0).rejections.length === 2, '两笔都有下文'); });
  add('instr_auto_mid_slippage_mode', {
    settings: { policies: { auto_execute: true }, limits: { auto_mid_spread_share: 0 } }, router: baseRouter(), parser: { behaviors: { parse: [llm([flyOrder()])] } }, steps: [ins('买入 SPX 蝶')],
  }, (out) => { must(routerCalls(out, 'legQuotes').length === 1, '取了腿报价'); });
  add('instr_auto_mid_share_mode', {
    settings: { policies: { auto_execute: true }, limits: { auto_mid_spread_share: 0.5 } }, router: baseRouter(), parser: { behaviors: { parse: [llm([flyOrder()])] } }, steps: [ins('买入 SPX 蝶')],
  }, (out) => { must(routerCalls(out, 'place').length === 1, '定价后发单'); });
  add('instr_auto_mid_bad_book', {
    settings: auto, router: baseRouter({ legQuotes: [{ action: 'BUY', ratio: 1, bid: 0, ask: 3 }] }), parser: { behaviors: { parse: [llm([flyOrder()])] } }, steps: [ins('买入 SPX 蝶')],
  }, (out) => { must(res(out, 0).rejections.some((r) => r.source === 'broker'), '坏盘口 → 券商错'); });
  add('instr_paper_vs_live_note', {
    settings: live, router: baseRouter(), parser: { behaviors: { parse: [llm([flyOrder(), flyOrder({ account: '主账户' })])] } }, steps: [ins('买入 SPX 蝶两个账户')],
  });

  // ================================================================ 指令:解析失败与拒绝
  add('instr_llm_error_trips_breaker', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 2 } }, router: baseRouter(),
    parser: { behaviors: { parse: [{ error: { cls: 'LLM', msg: '调用失败' }, repeat: true }] } },
    steps: [ins('买入 AAPL'), ins('买入 AAPL'), ins('买入 AAPL')],
  }, (out) => {
    must(res(out, 1).rejections[0].code === 'LLM_ERROR', 'LLM_ERROR');
    must(snap(out, 1).breaker.engaged === true, '第二次合上');
    must(res(out, 2).warnings[0].includes('已熔断'), '熔断后不再解析');
  });
  add('instr_bad_payload_variants', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 5 } }, router: baseRouter(),
    parser: { behaviors: { parse: [{ text: '这不是 JSON' }, { text: '[1,2]' }, { text: '{"orders": 3, "rejections": []}' }, { text: '{"orders": [], "rejections": []}' }] } },
    steps: [ins('a'), ins('b'), ins('c'), ins('d')],
  }, (out) => { must(res(out, 0).rejections[0].code === 'BAD_PAYLOAD' && res(out, 3).rejections.length === 0, '坏载荷拒、空载荷放过'); });
  add('instr_parse_success_clears_parse_count', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 2 } }, router: baseRouter(),
    parser: { behaviors: { parse: [{ error: { cls: 'LLM', msg: 'x' } }, llm([stockOrder()]), { error: { cls: 'LLM', msg: 'y' } }] } },
    steps: [ins('a'), ins('b'), ins('c')],
  }, (out) => { must(snap(out, 2).breaker.engaged === false, '成功清了解析计数'); });
  add('instr_non_llm_exception_propagates', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [{ error: { cls: 'Error', msg: 'boom 非 LLM 错' } }] } }, steps: [ins('a'), ins('b')],
  }, (out) => { must(res(out, 0).error === 'boom 非 LLM 错', '原样抛回'); });
  add('instr_llm_rejections_recorded', {
    settings: auto, router: baseRouter(),
    parser: { behaviors: { parse: [llm([stockOrder()], [{ code: 'MISSING_PRICE', message: '没给价格', original_text: '买点 NVDA' }, { code: 'UNCLEAR', message: '看不懂', original_text: '??' }])] } },
    steps: [ins('买入 AAPL 100股 limit 230 另外买点 NVDA ??')],
  }, (out) => { must(res(out, 0).rejections.length === 2 && res(out, 0).submitted.length === 1, '模型拒两个、发一个'); });
  add('instr_validator_rejections', {
    settings: auto, router: baseRouter(),
    parser: { behaviors: { parse: [llm([stockOrder({ confidence: 0.5 }), stockOrder({ intent_summary: '大单' }, { totalQuantity: 5000, lmtPrice: 400 }), stockOrder({ account: '主账户' }), stockOrder({ account: '没有这个账户' })])] } },
    steps: [ins('一堆单')],
  }, (out) => { must(res(out, 0).rejections.filter((r) => r.source === 'validator').length >= 3, '校验拒掉几笔'); });
  add('instr_exceeds_cap_before_fanout', {
    settings: { policies: { auto_execute: true, allow_live_trading: true }, limits: { max_orders_per_input: 2 } }, router: baseRouter(),
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: 'o1' }), stockOrder({ intent_summary: 'o2' }, {}, { symbol: 'MSFT' }), stockOrder({ intent_summary: 'o3' }, { totalQuantity: 10 }, { symbol: 'NVDA' }), stockOrder({ intent_summary: 'o4' }, { totalQuantity: 20 }, { symbol: 'TSLA' })])] } },
    steps: [ins('四单', { accounts: ['模拟', '主账户'] })],
  }, (out) => { must(res(out, 0).rejections.filter((r) => r.code === 'EXCEEDS_LIMIT').length >= 2, '超上限的被拦'); });
  add('instr_duplicate_debounce', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()]), llm([stockOrder()])] } }, steps: [ins('买入 AAPL 100股 limit 230'), adv(30_000), ins('买入 AAPL 100股 limit 230')],
  }, (out) => { must(res(out, 2).rejections.some((r) => r.code === 'DUPLICATE_ORDER'), '重复单被拦'); });

  // ================================================================ 扇出
  add('instr_fanout_two_accounts', {
    settings: live, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder(), stockOrder({ intent_summary: '指明副账户', account: '副账户' })])] } },
    steps: [ins('买入 AAPL', { accounts: ['模拟', '主账户'] })],
  }, (out) => { must(res(out, 0).submitted.length === 3 && res(out, 0).warnings.some((w) => w.includes('已按勾选账户')), '2 账户 + 1 点名 = 3'); });
  add('instr_fanout_single_account', {
    settings: live, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL', { accounts: [' 主账户 ', '主账户', ''] })],
  }, (out) => { must(res(out, 0).submitted.length === 1 && res(out, 0).warnings.length === 0, '去重后只有一个、没有说明'); });
  add('instr_fanout_unknown_alias', {
    settings: live, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL', { accounts: ['模拟', '没有'] }), ins('买入 AAPL', { accounts: ['DEFAULT'] })],
  }, (out) => { must(res(out, 0).error.includes('不在别名表中') && res(out, 1).error.includes('DEFAULT'), '别名表外直接抛'); });
  add('instr_fanout_live_disabled', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL', { accounts: ['模拟', '主账户'] })],
  }, (out) => { must(res(out, 0).rejections.some((r) => r.code === 'LIVE_TRADING_DISABLED'), '实盘没开'); });

  // ================================================================ 券商错误与熔断
  add('instr_broker_error_records_and_trips', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 2 } }, router: baseRouter({ behaviors: { place: [{ error: { cls: 'Broker', msg: '被拒 201' } }, { error: { cls: 'Broker', msg: '又被拒' } }] } }),
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: 'a' }), stockOrder({ intent_summary: 'b' }, { lmtPrice: 231 }, { symbol: 'MSFT' }), stockOrder({ intent_summary: 'c' }, { lmtPrice: 232 }, { symbol: 'NVDA' })])] } },
    steps: [ins('三单')],
  }, (out) => {
    const r = res(out, 0);
    must(r.rejections.filter((x) => x.source === 'broker').length === 2, '两笔券商错');
    must(r.rejections.some((x) => x.code === 'BREAKER_ENGAGED'), '第三笔被批内熔断拦下');
    must(lastDump(out, 'trade_records').length === 3, '三条记录');
  });
  add('instr_broker_success_clears_failures', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 2 } }, router: baseRouter({ behaviors: { place: [{ error: { cls: 'Broker', msg: 'x' } }, {}, { error: { cls: 'Broker', msg: 'y' } }] } }),
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: 'a' }), stockOrder({ intent_summary: 'b' }, { lmtPrice: 231 }, { symbol: 'MSFT' }), stockOrder({ intent_summary: 'c' }, { lmtPrice: 232 }, { symbol: 'NVDA' })])] } },
    steps: [ins('三单')],
  }, (out) => { must(snap(out, 0).breaker.engaged === false, '成功清了券商计数'); });
  add('instr_unknown_exception_in_place', {
    settings: auto, router: baseRouter({ behaviors: { place: [{ error: { cls: 'Error', msg: '连接层炸了' } }] } }), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL')],
  }, (out) => { must(res(out, 0).error === '连接层炸了', '非 BrokerError 原样抛回'); });
  add('instr_link_down_counts_as_error_in_new_order', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 5 } }, router: baseRouter({ behaviors: { place: [{ error: { cls: 'LinkDown' } }] } }), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL')],
  });
  add('instr_place_delay_and_status_events', {
    settings: auto, router: baseRouter({ behaviors: { place: [{ delay: 800, emit: [{ op: 'status', trade: trade(501, 'Submitted', { contract: { symbol: 'AAPL' } }) }] }] } }),
    parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('买入 AAPL'), adv(1000), { op: 'status', trade: trade(501, 'Filled', { orderStatus: { status: 'Filled', filled: 100, remaining: 0 } }) }],
  });
  add('instr_breaker_engaged_blocks', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } },
    steps: [{ op: 'breaker', action: 'engage', reason: '手动停' }, ins('买入 AAPL'), { op: 'breaker', action: 'release' }, ins('买入 AAPL')],
  }, (out) => { must(res(out, 1).warnings[0].includes('手动停') && res(out, 3).submitted.length === 1, '熔断拦、解除后放'); });
  add('instr_breaker_engages_mid_batch', {
    settings: auto, router: baseRouter({ behaviors: { place: [{ emit: [] }] } }), parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: 'a' }), stockOrder({ intent_summary: 'b' }, { lmtPrice: 231 }, { symbol: 'MSFT' })])] } },
    steps: [ins('两单')],
  });

  // ================================================================ 条件单
  add('cond_queue_and_fire', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder()])] } },
    steps: [ins('SPX 到 7505 买蝶'), { op: 'fire', prices: { SPX: 7520 } }, { op: 'fire', prices: { SPX: 7504.5 } }, { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => {
    must(res(out, 0).queued.length === 1 && res(out, 0).queued[0].mode === 'software_watch', '进队列');
    must(res(out, 1).length === 0 && res(out, 2).length === 1 && res(out, 3).length === 0, '到价才发、发过不再发');
    must(routerCalls(out, 'place').length === 1, '只发一张');
  });
  add('cond_fire_breaker_blocks', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder()])] } },
    steps: [ins('SPX 到 7505 买蝶'), { op: 'breaker', action: 'engage', reason: 'x' }, { op: 'fire', prices: { SPX: 7500 } }, { op: 'breaker', action: 'release' }, { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => { must(res(out, 2).length === 0 && res(out, 4).length === 1, '熔断时不触发、解除后触发'); });
  add('cond_fire_broker_error_trips_and_stops', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 1 } }, router: baseRouter({ behaviors: { place: [{ error: { cls: 'Broker', msg: '拒' } }] } }),
    parser: { behaviors: { parse: [llm([condOrder(), condOrder({ intent_summary: '第二张' }, {}, {}, 7600)])] } },
    steps: [ins('两张条件单'), { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => { must(snap(out, 0).pending.length === 2, '两张都进了队列'); must(res(out, 1).length === 0 && routerCalls(out, 'place').length === 1 && snap(out, 1).breaker.engaged === true, '熔断挂起,后面的不触发'); });
  add('cond_fire_unknown_exception', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 5 } }, router: baseRouter({ behaviors: { place: [{ error: { cls: 'Error', msg: '意外' } }] } }),
    parser: { behaviors: { parse: [llm([condOrder()])] } }, steps: [ins('SPX 到 7505 买蝶'), { op: 'fire', prices: { SPX: 7500 } }, { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => { must(snap(out, 1).pending.length === 0, '落闩后不再试'); });
  add('cond_fire_leg_quote_error', {
    settings: auto, router: baseRouter({ legQuotes: [] }), parser: { behaviors: { parse: [llm([condOrder()])] } }, steps: [ins('SPX 到 7505 买蝶'), { op: 'fire', prices: { SPX: 7500 } }],
  });
  add('cond_protection_blocks_then_releases', {
    settings: { policies: { auto_execute: true }, protections: { cooldown: { enabled: true, scope: 'symbol', minutes: 30 } } }, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder()])] } },
    steps: [ins('SPX 到 7505 买蝶'), { op: 'audit', actor: 'engine', action: 'auto_close', detail: { track: 'x', symbol: 'SPX', leg: '', state: 'stop_loss', record: 'r', mark: 1 } }, { op: 'fire', prices: { SPX: 7500 } },
      adv(31 * MIN), { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => { must(res(out, 2).length === 0 && res(out, 4).length === 1, '冷却期内不发、过了发'); });
  add('cond_expire_after_close', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder(), condOrder({ intent_summary: 'GTC 条件' }, { tif: 'GTC' })])] } },
    steps: [ins('两张条件单'), { op: 'expire' }, { op: 'expire', atMs: T0 + 11 * 60 * MIN }],
  }, (out) => { must(res(out, 1) === 0 && res(out, 2) === 1, '盘中不清、收盘后清 DAY 的'); });
  add('cond_quote_capability_refuses', {
    settings: auto, router: baseRouter({ quoteCap: { SPX: '券商报不出 SPX 的价' } }), parser: { behaviors: { parse: [llm([condOrder()])] } }, steps: [ins('SPX 到 7505 买蝶')],
  }, (out) => { must(res(out, 0).rejections[0].source === 'broker', '进队列前拒'); });
  add('cond_native_ibkr_condition', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder({}, { price_mode: 'EXPLICIT', lmtPrice: 6.5 })])] } }, steps: [ins('SPX 到 7505 限价 6.5 买蝶')],
  }, (out) => { must(res(out, 0).queued.length === 1 && res(out, 0).queued[0].mode === 'ibkr_condition', '原生条件单'); });
  add('cond_no_native_conditions_queues', {
    settings: auto, router: baseRouter({}, { native: false }), parser: { behaviors: { parse: [llm([condOrder({}, { price_mode: 'EXPLICIT', lmtPrice: 6.5 })])] } },
    steps: [ins('SPX 到 7505 限价 6.5 买蝶'), { op: 'fire', prices: { SPX: 7500 } }],
  });
  add('cond_halt_clears_queue', {
    settings: auto, router: baseRouter({ cancelCount: 3 }), parser: { behaviors: { parse: [llm([condOrder()])] } },
    steps: [ins('SPX 到 7505 买蝶'), { op: 'halt', reason: '手动' }, { op: 'fire', prices: { SPX: 7500 } }],
  }, (out) => { must(res(out, 1).cancelled === 3 && snap(out, 1).pending.length === 0, '熔断撤单、清队列'); });
  add('halt_no_router', { settings: auto, router: null, steps: [{ op: 'halt', reason: '无券商' }] });

  // ================================================================ 保护规则
  const guarded = (extra = {}) => ({
    settings: { policies: { auto_execute: true }, protections: { stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: 2, pause_minutes: 60 } } },
    router: baseRouter(extra.router ?? {}), parser: { behaviors: { parse: [llm([stockOrder()]), llm([stockOrder()]), llm([stockOrder()])] } }, ...extra.script,
  });
  const closeAudit = (symbol, leg = '') => ({ op: 'audit', actor: 'engine', action: 'auto_close', detail: { track: `t-${symbol}`, symbol, leg, state: 'stop_loss', record: 'r', mark: 1 } });
  add('protect_pause_blocks_new_order', {
    ...guarded(), steps: [closeAudit('TSLA'), closeAudit('NVDA'), ins('买入 AAPL'), { op: 'protection' }],
  }, (out) => { must(res(out, 2).validated_only.length === 1 && routerCalls(out, 'place').length === 0, '保护期停新单'); });
  add('protect_reduce_only_passes', {
    ...guarded({ router: { rows: [stk('AAPL', { account: '模拟', quantity: 100, key: '模拟|AAPL|STK' })] } }),
    steps: [closeAudit('TSLA'), closeAudit('NVDA'), ins('卖出 AAPL', {}), { op: 'protection' }],
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: '卖出' }, { action: 'SELL', totalQuantity: 100, lmtPrice: 231 })])] } },
  }, (out) => { must(res(out, 2).submitted.length === 1, '平仓单照发'); });
  add('protect_positions_unreadable_still_blocks', {
    ...guarded({ router: { behaviors: { positions: [{ error: { cls: 'Error', msg: '读不到' } }] } } }),
    steps: [closeAudit('TSLA'), closeAudit('NVDA'), ins('卖出 AAPL')],
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: '卖出' }, { action: 'SELL', totalQuantity: 100, lmtPrice: 231 })])] } },
  }, (out) => { must(res(out, 2).validated_only.length === 1, '读不到持仓 → 照旧挡'); });
  add('protect_positions_read_once_per_batch', {
    ...guarded({ router: { rows: [stk('AAPL', { account: '模拟', quantity: 100, key: '模拟|AAPL|STK' })] } }),
    steps: [closeAudit('TSLA'), closeAudit('NVDA'), ins('两单')],
    parser: { behaviors: { parse: [llm([stockOrder({ intent_summary: '卖出1' }, { action: 'SELL', totalQuantity: 50, lmtPrice: 231 }), stockOrder({ intent_summary: '买入2' }, { lmtPrice: 229 })])] } },
  }, (out) => { must(routerCalls(out, 'positions').length === 1, '一批只读一次持仓'); });
  add('protect_state_computation_fails_open', {
    settings: { policies: { auto_execute: true }, protections: { stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: 1, pause_minutes: 60 } } },
    router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [{ op: 'audit', actor: 'engine', action: 'auto_close', detail: { track: 'x', symbol: 'T', state: 'take_profit' } }, ins('买入 AAPL'), { op: 'protection' }],
  });
  add('protect_daily_loss_account_latch', {
    settings: { policies: { auto_execute: true, allow_live_trading: true }, protections: { daily_loss: { enabled: true, max_loss_usd: 100, basis: 'realized' } } },
    router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [{ op: 'protection' }, ins('买入 AAPL')],
  });

  // ================================================================ 本地速记与跟单
  add('shorthand_local_fly', {
    settings: auto, router: baseRouter({ prices: { SPX: 7512.4 } }), parser: { behaviors: { parse: [llm([flyOrder()])] } },
    steps: [ins('1.8 挂15蝴蝶 15CM', { snap: { SPX: 7512.4 } })],
  }, (out) => { must(out.log.filter((e) => e.c === 'parser').length === 0, '速记不走大模型'); });
  add('shorthand_local_public_price', {
    settings: auto, router: null, publicPrices: { SPX: 7512.4 }, parser: { behaviors: { parse: [llm([flyOrder()])] } }, steps: [ins('1.8 挂15蝴蝶 15CM')],
  });
  add('shorthand_miss_falls_to_llm', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()])] } }, steps: [ins('帮我看看今天的 AAPL 怎么样')],
  }, (out) => { must(out.log.filter((e) => e.c === 'parser').length === 1, '没接住 → 大模型'); });
  add('follow_local_only_refuses_llm', {
    settings: auto, router: baseRouter({ prices: { SPX: 7512.4 } }), parser: { behaviors: { parse: [llm([stockOrder()])] } },
    steps: [ins('帮我看看今天的 AAPL 怎么样', { localOnly: true }), ins('1.8 挂15蝴蝶 15CM', { localOnly: true, snap: { SPX: 7512.4 } }), ins('帮我看看今天的 AAPL 怎么样')],
  }, (out) => {
    must(res(out, 0).error.includes('跟单只认本地速记'), '跟单那一趟不碰大模型');
    must(snap(out, 2).breaker.consecutive_parse_failures === 0, '不算解析失败');
  });

  // ================================================================ 回报与接线
  add('wire_sessions_idempotent', {
    router: baseRouter({ sessions: [{ name: 's1' }, { name: 's2', caps: { fill: false, commission: false } }, { name: 's3', caps: { status: false } }] }),
    steps: [{ op: 'attach' }, { op: 'attach' }, { op: 'connect', def: { name: 's4' } }, { op: 'wire', session: 0 },
      { op: 'session', session: 0, kind: 'status', trade: trade(77, 'Submitted') }, { op: 'session', session: 1, kind: 'fill', trade: trade(77, 'Submitted'), fill: {} }, { op: 'session', session: 0, kind: 'error', reqId: 77, code: 201, message: '资金不足' }],
  }, (out) => { must(res(out, 0) === 2 && res(out, 1) === 0, '挂两条、第二次不重复'); });
  add('wire_new_session_triggers_reconcile', {
    settings: auto, router: baseRouter({ rows: [stk()], sessions: [{ name: 's1' }] }), setup: [trkSw('A')],
    steps: [tick(), tick(), { op: 'attach' }, tick(), adv(1000), { op: 'connect', def: { name: 's2' } }, tick()],
  }, (out) => { must(snap(out, 5).reconcile.at === 0 && snap(out, 4).reconcile.at > 0, '新会话 → 下一轮重新对账'); });
  add('attach_no_router', { router: null, steps: [{ op: 'attach' }] });
  add('sync_broker_orders_poll', {
    settings: auto, router: baseRouter({ pollUpdates: [['status', trade(11, 'Submitted'), null], ['fill', trade(11, 'Filled'), { execution: { execId: 'e1' } }], ['other', null, null]] }, { poll: true }),
    steps: [{ op: 'syncOrders' }, { op: 'brokerCode' }],
  });
  add('sync_broker_orders_failure_and_absent', {
    router: baseRouter({ behaviors: { pollOrderUpdates: [{ error: { cls: 'Error', msg: '拉取失败' } }] } }, { poll: true }), steps: [{ op: 'syncOrders' }],
  });
  add('sync_broker_orders_not_supported', { router: baseRouter(), steps: [{ op: 'syncOrders' }] });
  add('settings_swap_changes_limits', {
    settings: { policies: { auto_execute: false } }, router: baseRouter(), parser: { behaviors: { parse: [llm([stockOrder()]), llm([stockOrder({ intent_summary: '第二次' })])] } },
    steps: [ins('买入 AAPL'), { op: 'settings', patch: { policies: { auto_execute: true } } }, ins('再买 AAPL')],
  }, (out) => { must(res(out, 0).validated_only.length === 1 && res(out, 2).rejections.length + res(out, 2).submitted.length === 1, '换配置立刻生效'); });

  trackerScenarios(add);
  return S;
}

// ---------------------------------------------------------------- 盯盘与持仓追踪
const optRow = (strike, qty, price, over = {}) => ({
  key: `模拟|SPX|OPT|L${strike}`, account: '模拟', symbol: 'SPX', sec_type: 'OPT', leg: `L${strike}`, quantity: qty, avg_cost: 300, multiplier: 100, currency: 'USD',
  market_price: price, market_value: price * 100 * qty, unrealized_pnl: 0,
  contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: '20260911', strike, right: 'C', multiplier: '100', tradingClass: 'SPXW' }, ...over,
});
const flyRows = (a = 22, b = 12, c = 6) => [optRow(7500, 1, a), optRow(7515, -2, b), optRow(7530, 1, c)];
const FLY_LEG = '20260911|+1x7500C,-2x7515C,+1x7530C';
const FLY_CONTRACT = {
  secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', multiplier: '100', combo_strategy: 'BUTTERFLY', label: '买入看涨蝴蝶 7500/7515/7530',
  legs: [7500, 7515, 7530].map((k, i) => ({ lastTradeDateOrContractMonth: '20260911', strike: k, right: 'C', ratio: [1, -2, 1][i] })),
};
const sw = { enabled: true, host_at_broker: false };
const swl = { enabled: true, host_at_broker: false, order_type: 'LMT' };
const trkSw = (name, symbol = 'NVDA', over = {}) => trk(name, symbol, { auto_close: sw, ...over });
const optTrack = (name, strike, over = {}) => ({
  op: 'track', name, spec: { account: '模拟', symbol: 'SPX', sec_type: 'OPT', leg: `L${strike}`, contract: optRow(strike, 1, 1).contract, targets: { take_profit: 5 }, auto_close: swl, peak: 3, ...over },
});
const flyTrack = (name, over = {}) => ({
  op: 'track', name, spec: { account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: FLY_CONTRACT, targets: { take_profit: 8 }, auto_close: swl, peak: 5, ...over },
});
const trRouter = (over = {}, caps = {}) => baseRouter({ rows: [stk()], ...over }, caps);
const optQuotes = { '模拟|SPX|OPT|L7500': { bid: 21.8, ask: 22.4 }, '模拟|SPX|OPT|L7515': { bid: 12.2, ask: 12.8 }, '模拟|SPX|OPT|L7530': { bid: 5.9, ask: 6.3 } };
const poll = (extra = {}) => ({ op: 'poll', ...extra });
const tick = (extra = {}) => ({ op: 'tick', ...extra });
const SAT = Date.UTC(2026, 8, 12, 16, 0, 0);

function trackerScenarios(add) {
  add('tick_no_router_and_no_tracks', {
    router: null, setup: [trkSw('A')], steps: [tick(), { op: 'heartbeat' }],
  });
  add('tick_no_tracks', { router: trRouter(), steps: [tick(), adv(1000), tick(), { op: 'heartbeat' }] });
  add('tick_positions_unreadable', {
    router: trRouter({ behaviors: { positions: [{ error: { cls: 'Error', msg: '读不到持仓 xx' } }] } }), setup: [trkSw('A')], steps: [tick(), tick()],
  }, (out) => { must(snap(out, 0).loop.last_error.includes('读不到持仓'), '记下读不到'); });
  add('poll_stock_take_profit_fires', {
    settings: auto, router: trRouter(), setup: [trkSw('A')],
    steps: [poll(), { op: 'row', index: 0, patch: { market_price: 255 } }, poll(), poll()],
  }, (out) => {
    must(res(out, 0).fired.length === 0 && res(out, 2).fired.length === 1, '到价才平');
    must(res(out, 3).fired.length === 0, '落闩后不再平');
    must(routerCalls(out, 'place').length === 1, '只发一张');
  });
  add('poll_stock_stop_loss_and_peak', {
    settings: auto, router: trRouter(), setup: [trkSw('A', 'NVDA', { targets: { stop_loss: 200, trail_pct: 10 }, peak: 220 })],
    steps: [{ op: 'row', index: 0, patch: { market_price: 240 } }, poll(), { op: 'row', index: 0, patch: { market_price: 214 } }, poll(), { op: 'row', index: 0, patch: { market_price: 199 } }, poll()],
  });
  add('poll_blockers', {
    settings: { policies: { auto_execute: false } }, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trkSw('A')],
    steps: [poll(), poll(), { op: 'settings', patch: { policies: { auto_execute: true } } }, { op: 'breaker', action: 'engage' }, poll(), { op: 'breaker', action: 'release' }, poll({ atMs: SAT })],
  }, (out) => { must(res(out, 0).blocked.length === 1 && res(out, 0).blocked[0].blockers.length >= 1, '自动执行关着挡住'); });
  add('poll_auto_breaker_does_not_block_close', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trkSw('A')], steps: [{ op: 'breaker', action: 'engageAuto' }, poll()],
  }, (out) => { must(res(out, 1).fired.length === 1, '自动熔断不挡平仓'); });
  add('poll_live_account_gate', {
    settings: { policies: { auto_execute: true, allow_live_trading: false } }, router: trRouter({ rows: [stk('NVDA', { account: '主账户', key: '主账户|NVDA|STK', market_price: 255 })], covered: ['主账户'] }),
    setup: [trkSw('A', 'NVDA', { account: '主账户' })], steps: [poll(), { op: 'settings', patch: { policies: { allow_live_trading: true } } }, poll()],
  });
  add('poll_position_gone_stops_track', {
    settings: auto, router: trRouter(), setup: [trkSw('A')], steps: [poll(), { op: 'rows', set: [] }, poll(), poll()],
  }, (out) => { must(snap(out, 2).tracks[0].enabled === false, '追踪停了'); });
  add('poll_unreachable_account', {
    settings: auto, router: trRouter({ rows: [], covered: ['副账户'] }), setup: [trkSw('A')], steps: [poll()],
  });
  add('poll_stock_price_fallback_to_quote', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: null })], stream: { NVDA: { last: 256 } } }), setup: [trkSw('A')], steps: [poll()],
  }, (out) => { must(res(out, 0).fired.length === 1, '行情流补上现价'); });
  add('poll_close_place_failure', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 5 } }, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })], behaviors: { place: [{ error: { cls: 'Error', msg: '发不出' } }] } }),
    setup: [trkSw('A')], steps: [poll(), poll()],
  }, (out) => { must(res(out, 0).fired.length === 0 && snap(out, 0).breaker.consecutive_failures === 1, '记熔断'); });
  add('poll_close_account_missing', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { account: '没有', key: '没有|NVDA|STK', market_price: 255 })], covered: ['没有'] }), setup: [trkSw('A', 'NVDA', { account: '没有' })], steps: [poll()],
  });
  add('poll_close_unbuildable_option', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 9)], optionQuotes: {} }), setup: [optTrack('A', 7500, { contract: {} })], steps: [poll(), poll()],
  });
  add('poll_option_close_chase_lifecycle', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }), setup: [optTrack('A', 7500)],
    steps: [poll(), poll(), poll(), poll(), { op: 'row', index: 0, patch: { market_price: 5.2 } }, { op: 'router', set: { optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.0, ask: 5.4 } } } }, poll(), poll(), poll(),
      { op: 'status', trade: { order: { orderId: 501, permId: null }, orderStatus: { status: 'Filled', filled: 1, remaining: 0 }, contract: { symbol: 'SPX' } } }, poll()],
  }, (out) => {
    must(res(out, 0).fired.length === 1 && routerCalls(out, 'modifyHosted').length >= 1, '发出后追价');
    must(Object.keys(snap(out, 10).closeChase).length === 0, '成交后摘掉');
  });
  add('poll_option_chase_modify_outcomes', {
    settings: { policies: { auto_execute: true, consecutive_failure_breaker: 9 } }, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } },
      behaviors: { modifyHosted: [{ error: { cls: 'LinkDown' } }, { error: { cls: 'Error', msg: '改单炸了' } }, { ret: false }] } }), setup: [optTrack('A', 7500)],
    steps: Array.from({ length: 12 }, () => poll()),
  }, (out) => { must(snap(out, 11).breaker.consecutive_failures === 1, '链路断不记熔断,别的错记'); });
  add('poll_option_chase_no_quotes', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }), setup: [optTrack('A', 7500)],
    steps: [poll(), { op: 'router', set: { optionQuotes: {} } }, poll(), poll()],
  });
  add('poll_chase_modify_rejected_110', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }), setup: [optTrack('A', 7500)],
    steps: [poll(), poll(), poll(), { op: 'error', reqId: 501, code: 110, message: '价格不符合最小价格变动' }, poll()],
  });
  add('poll_chase_cancelled_by_broker', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }), setup: [optTrack('A', 7500)],
    steps: [poll(), poll(), { op: 'status', trade: { order: { orderId: 501 }, orderStatus: { status: 'Cancelled' }, contract: { symbol: 'SPX' } } }, poll()],
  });
  add('poll_chase_warns_when_stuck', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }), setup: [optTrack('A', 7500)],
    steps: [poll(), ...Array.from({ length: 34 }, () => poll())],
  });
  add('poll_fly_close_natural_price', {
    settings: auto, router: trRouter({ rows: flyRows(33, 14, 5), optionQuotes: optQuotes }), setup: [flyTrack('F')], steps: [poll(), poll(), poll()],
  }, (out) => { must(res(out, 0).fired.length === 1, '蝶到价平仓'); });
  add('poll_fly_stop_basis_natural', {
    settings: auto, router: trRouter({ rows: flyRows(10, 14, 5), optionQuotes: optQuotes }), setup: [flyTrack('F', { targets: { stop_loss: 4 }, auto_close: { ...swl, stop_basis: 'natural' } })], steps: [poll(), poll()],
  });
  add('poll_spot_target_fly', {
    settings: auto, router: trRouter({ rows: flyRows(), optionQuotes: optQuotes, spotInfo: {}, stream: { SPX: { last: 7512 } }, prices: { SPX: 7512.5 } }),
    setup: [flyTrack('F', { targets: { spot_target: 7520 } })], steps: [poll(), poll({ atMs: T0 + 2 * 60 * MIN }), { op: 'router', set: { prices: { SPX: null } } }, poll(), poll()],
  });
  add('poll_spot_target_never_priced_holds', {
    settings: auto, router: trRouter({ rows: flyRows(), optionQuotes: optQuotes, prices: { SPX: null } }), setup: [flyTrack('F', { targets: { spot_target: 7520 } })], steps: [poll()],
  });
  add('poll_spot_target_index_stale', {
    settings: auto, router: trRouter({ rows: flyRows(), optionQuotes: optQuotes, prices: { SPX: 7512.5 }, spotInfo: { SPX: { source: 'index_stale', note: '昨收' } } }),
    setup: [flyTrack('F', { targets: { spot_target: 7520 } })], steps: [poll(), poll()],
  });
  add('poll_spot_target_official_index_source', {
    settings: auto, router: trRouter({ rows: flyRows(), optionQuotes: optQuotes, prices: { SPX: 7512.5 }, spotInfo: { SPX: { source: 'index', note: '官方指数' } } }),
    setup: [flyTrack('F', { targets: { spot_target: 7520 } })], steps: [poll(), poll()],
  }, (out) => { must(JSON.stringify(res(out, 0)).includes('"spot":7512.5'), '官方来源的现价照用'); });
  add('poll_spot_target_stock', {
    settings: auto, router: trRouter(), setup: [trkSw('A', 'NVDA', { targets: { spot_target: 240 } })], steps: [poll(), { op: 'row', index: 0, patch: { market_price: 241 } }, poll()],
  });
  add('poll_spot_stop_with_confirm', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], stream: {}, prices: { SPX: 7490 }, optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }),
    setup: [optTrack('A', 7500, { targets: { take_profit: 9, spot_stop_below: 7495, spot_stop_confirm_s: 5 } })], steps: [poll(), adv(3000), poll(), adv(3000), poll()],
  });
  add('poll_peak_confirm_needs_two_rounds', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } } }),
    setup: [optTrack('A', 7500, { targets: { profit_drawdown_pct: 30 }, auto_close: { ...swl, peak_confirm: true }, peak: 6 })],
    steps: [{ op: 'row', index: 0, patch: { market_price: 8 } }, poll(), poll(), { op: 'row', index: 0, patch: { market_price: 9.5 } }, poll(), { op: 'row', index: 0, patch: { market_price: 6 } }, poll(), poll()],
  });
  add('poll_tiers_and_time_exit', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255, quantity: 100 })] }), setup: [trkSw('A', 'NVDA', { targets: { take_profit_tiers: [{ price: 250, fraction_pct: 50 }, { price: 270, fraction_pct: 100 }] } })],
    steps: [poll(), { op: 'rows', set: [stk('NVDA', { market_price: 255, quantity: 50 })] }, poll(), poll()],
  });
  add('poll_hosted_track_goes_to_onTriggered', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trk('A')], steps: [tick(), tick(), { op: 'sweep', track: 'A', reason: '手动' }, tick(), { op: 'pendingClose', track: 'A' }],
  });
  const adoptSetup = [{ op: 'record', name: 'R', record: { input: { raw_instruction: 'x', reason: '', input_channel: 'tracker' }, llm: {}, account: {}, contract: {}, order: {}, ibkr: {}, signature: 'tracker:x' } }];
  const fireTrack = [optTrack('A', 7500), { op: 'updateTrack', track: 'A', fields: { enabled: false, fired_state: 'sweep:take_profit', fired_at: '2026-09-11T15:00:00+00:00', fired_record: '${rec:R}' } }];
  add('poll_adopt_list_fails_then_never_retries', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } }, hostedOpen: [openRow('${rec:R}', 77, { account: 'DU7654321', action: 'SELL', quantity: 1, lmt_price: 6.1 })],
      behaviors: { listHostedOpen: [{ error: { cls: 'Error', msg: '列不出' } }] } }),
    setup: adoptSetup, steps: [...fireTrack, poll(), poll()],
  }, (out) => { must(Object.keys(snap(out, 3).closeChase).length === 0 && snap(out, 3).closeChaseAdopted === true, '列不出就算了、不再试'); });
  add('poll_adopt_picks_the_matching_row', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } },
      hostedOpen: [openRow('别的单', 70, { account: 'DU7654321', quantity: 1, lmt_price: 1 }), openRow('${rec:R}', 0, { account: 'DU7654321', quantity: 2, lmt_price: 2 }),
        openRow('${rec:R}', 78, { account: 'DU7654321', action: 'SELL', quantity: 1, lmt_price: 6.1 })] }),
    setup: adoptSetup, steps: [...fireTrack, poll()],
  }, (out) => { must(snap(out, 2).closeChase && Object.values(snap(out, 2).closeChase)[0].order_id === 78, '按 order_ref 且 order_id 非空认领'); });
  add('sync_hosted_spot_target_last_price_retries_after_reject', {
    settings: auto, router: trRouter({ rows: [optRow(7600, 1, 4)], prices: { SPX: 7512 }, stream: { SPX: { last: 7512 } }, optionQuotes: { '模拟|SPX|OPT|L7600': { bid: 3.9, ask: 4.3 } } }),
    setup: [optTrack('A', 7600, { targets: { spot_target: 7640 }, auto_close: { enabled: true, host_at_broker: true, order_type: 'LMT' } })],
    steps: [{ op: 'sync' }, { op: 'router', set: { prices: { SPX: 7530 }, stream: { SPX: { last: 7530 } } } }, { op: 'sync' },
      { op: 'error', reqId: 501, code: 110, message: '价格不符合最小价格变动' }, { op: 'router', set: { prices: { SPX: null }, stream: {} } }, adv(61_000), { op: 'sync' }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'modifyHosted').length === 2, '行情没了、沿用最后一次的价:被拒过的改单再试'); });
  add('poll_adopt_without_list_capability', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)] }, { listHostedOpen: false }), setup: adoptSetup, steps: [...fireTrack, poll(), poll()],
  });
  add('poll_chase_without_option_quotes_cap', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)] }, { optionQuotes: false }), setup: [optTrack('A', 7500)], steps: [poll(), poll(), poll()],
  });
  add('sync_hosted_spot_target_hold_then_price', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 4)], prices: { SPX: null }, optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 3.9, ask: 4.3 } } }),
    setup: [optTrack('A', 7500, { targets: { spot_target: 7540 }, auto_close: { enabled: true, host_at_broker: true, order_type: 'LMT' } })],
    steps: [{ op: 'sync' }, { op: 'sync' }, { op: 'router', set: { prices: { SPX: 7512 }, stream: { SPX: { last: 7512 } } } }, { op: 'sync' }, { op: 'router', set: { prices: { SPX: null } } }, { op: 'sync' }],
  });
  add('sync_hosted_spot_target_hold_keeps_adopted_tp', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 4)], prices: { SPX: null }, hostedOpen: [openRow('trk:${track:A}:tp', 82, { account: 'DU7654321', action: 'SELL', quantity: 1, lmt_price: 6, order_type: 'LMT' })] }),
    setup: [optTrack('A', 7500, { targets: { spot_target: 7540 }, auto_close: { enabled: true, host_at_broker: true, order_type: 'LMT' } })],
    steps: [{ op: 'sync' }, { op: 'sync' }],
  }, (out) => { must(out.log.filter((e) => e.c === 'router' && e.m === 'cancelHosted').length === 0, '只守不挂时不撤已挂的止盈'); });
  add('poll_stock_spot_target_ignores_spot_info', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 230 })], spotInfo: { NVDA: { source: 'index_stale', note: '昨收' } } }), setup: [trkSw('A', 'NVDA', { targets: { spot_target: 240 } })],
    steps: [poll(), poll()],
  });
  add('poll_adopt_close_chase_after_restart', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 6)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 } },
      hostedOpen: [openRow('${rec:R}', 77, { account: 'DU7654321', action: 'SELL', quantity: 1, lmt_price: 6.1, perm_id: 9077 })] }),
    setup: [{ op: 'record', name: 'R', record: { input: { raw_instruction: 'x', reason: '', input_channel: 'tracker' }, llm: {}, account: {}, contract: {}, order: {}, ibkr: {}, signature: 'tracker:x' } }],
    steps: [optTrack('A', 7500), { op: 'updateTrack', track: 'A', fields: { enabled: false, fired_state: 'sweep:take_profit', fired_at: '2026-09-11T15:00:00+00:00', fired_record: '${rec:R}' } }, poll(), poll(),
      { op: 'pendingClose', track: 'A' }, { op: 'status', trade: { order: { orderId: 77 }, orderStatus: { status: 'Filled' }, contract: { symbol: 'SPX' } } }, poll()],
  }, (out) => { must(Object.keys(snap(out, 3).closeChase).length === 1, '认领后接着追'); });
  add('sweep_existing_variants', {
    settings: auto, router: trRouter(), setup: [trk('H'), trkSw('S', 'AMD')], steps: [{ op: 'sweep', track: 'H', reason: '手动' }, { op: 'sweep', track: 'H', reason: '再点' }, { op: 'sweep', track: 'S', reason: '软件的' }],
  }, (out) => { must(res(out, 0) === true && res(out, 2) === false, '托管的改追价、软件的不管'); });
  add('sweep_no_hosted_support', {
    settings: auto, router: trRouter({}, { hosted: false }), setup: [trk('H')], steps: [{ op: 'sweep', track: 'H', reason: '手动' }],
  });
  add('natural_close_and_market_status', {
    settings: auto, router: baseRouter({ rows: flyRows(), optionQuotes: optQuotes, hours: ['20260911:0930-1600', '20260911:0930-1600', 'America/New_York'] }, { contractHours: true, cachedHours: true }),
    steps: [{ op: 'naturalClose', rowIndex: 0 }, { op: 'marketStatus', rowIndex: 0 }, { op: 'marketStatus', rowIndex: 1, atMs: SAT }],
  });
  add('loop_timers_run_and_stop', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trkSw('A')],
    steps: [{ op: 'startLoop' }, { op: 'startLoop' }, adv(3500), { op: 'heartbeat' }, { op: 'stopLoop' }, adv(5000), { op: 'heartbeat' }, { op: 'startLoop', interval: 500 }, adv(1200), { op: 'stopLoop' }],
  });
  add('loop_slow_round_does_not_overlap', {
    settings: auto, router: trRouter({ behaviors: { positions: [{ delay: 2500 }, { delay: 2500 }] } }), setup: [trkSw('A')],
    steps: [{ op: 'startLoop' }, adv(1000), adv(2000), adv(2000), { op: 'stopLoop' }, adv(4000), { op: 'heartbeat' }],
  });
  add('wake_sleep_hold_and_release', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })], connected: ['paper'] }, {}), setup: [trkSw('A')],
    steps: [tick(), adv(1000), tick(), { op: 'sleep', ms: 600_000 }, tick(), { op: 'router', set: { connected: [] } }, adv(5000), tick(), { op: 'router', set: { connected: ['paper'] } }, adv(5000), tick(), adv(21_000), tick(), adv(21_000), tick(), adv(61_000), tick()],
  });
  add('wake_stall_not_sleep', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trkSw('A')],
    steps: [tick(), { op: 'awake', ms: 90_000 }, tick(), adv(1000), tick()],
  });
  add('tick_runs_reconcile_first', {
    settings: auto, router: trRouter({ rows: [stk()], openOrders: [] }), setup: [trkSw('A'), { op: 'record', name: 'R', record: { input: { raw_instruction: 'x', reason: '', input_channel: 'manual' }, llm: {}, account: { alias: '模拟', account_id: 'DU7654321' }, contract: { symbol: 'AAPL' }, order: { totalQuantity: 10 }, ibkr: {}, signature: 's' } },
      { op: 'rawEvent', record: 'R', kind: 'status', payload: { status: 'Submitted' }, at: T0 - 600_000 }],
    steps: [tick(), tick(), adv(61_000), tick()],
  });
  add('close_now_direct_then_poll_skips_adopt', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 4)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 3.9, ask: 4.3 } } }), setup: [optTrack('A', 7500)],
    steps: [{ op: 'closePosition', track: 'A', state: 'manual', price: 4.1, recName: 'X' },
      { op: 'router', set: { hostedOpen: [openRow('${rec:X}', 501, { account: 'DU7654321', action: 'SELL', quantity: 1, lmt_price: 4.1 })] } }, poll(), poll()],
  }, (out) => { must(res(out, 0) && res(out, 0).order_id === 501, '直接平仓发出'); });
  add('close_now_variants', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 230 }), optRow(7500, 1, 4)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 3.9, ask: 4.3 } },
      behaviors: { place: [{}, { error: { cls: 'Error', msg: 'close 发不出' } }, {}] } }),
    setup: [trkSw('S'), optTrack('O', 7500), trkSw('G', 'AMD', { account: '没有这个账户' })],
    steps: [{ op: 'closePosition', track: 'S', state: 'stop_loss', price: 229 }, { op: 'closePosition', track: 'O', rowIndex: 1, state: 'manual', price: 4.1, marketStatus: '盘中' },
      { op: 'closePosition', track: 'S', state: 'stop_loss', price: 229, marketStatus: '休市' }],
  });
  add('close_now_hosted_backoff_sweep', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 230 })] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'sync' }, { op: 'error', reqId: 501, code: 10311, message: '该委托单将直接传递至NYSE' }, { op: 'router', set: { hostedOpen: [] } }, { op: 'sync' },
      { op: 'closePosition', track: 'A', state: 'manual', price: 229 }, { op: 'sweep', track: 'A', reason: '再点' }, { op: 'sync' }],
  });
  add('sweep_after_direct_close_keeps_backoff', {
    settings: auto, router: trRouter({ rows: [optRow(7500, 1, 4)], optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 3.9, ask: 4.3 } } }),
    setup: [optTrack('A', 7500, { auto_close: { enabled: true, host_at_broker: true, order_type: 'LMT' } })],
    steps: [{ op: 'sync' }, { op: 'error', reqId: 501, code: 10311, message: '该委托单将直接传递至NYSE' }, { op: 'router', set: { hostedOpen: [] } }, { op: 'sync' },
      { op: 'closePosition', track: 'A', state: 'manual', price: 4.1 }, { op: 'sweep', track: 'A', reason: '再点' }, { op: 'sync' }],
  }, (out) => { must(Object.keys(snap(out, 4).closeChase).length === 1 && Object.keys(snap(out, 3).hosted.retryAt).length >= 1, '追价缓存在、退避在'); });
  add('sweep_clears_backoff', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 230 })] }), setup: [trk('A', 'NVDA', { targets: { take_profit: 250 } })],
    steps: [{ op: 'sync' }, { op: 'error', reqId: 501, code: 10311, message: '该委托单将直接传递至NYSE' }, { op: 'router', set: { hostedOpen: [] } }, { op: 'sync' }, { op: 'sweep', track: 'A', reason: '手动' }, { op: 'sync' }],
  });
  add('adopt_skips_hosted_tracks', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 230 })] }),
    setup: [{ op: 'record', name: 'R', record: { input: { raw_instruction: 'x', reason: '', input_channel: 'tracker' }, llm: {}, account: {}, contract: {}, order: {}, ibkr: {}, signature: 'tracker:x' } }],
    steps: [trk('A', 'NVDA'), { op: 'updateTrack', track: 'A', fields: { enabled: false, fired_state: 'sweep:take_profit', fired_at: '2026-09-11T15:00:00+00:00', fired_record: '${rec:R}' } },
      { op: 'router', set: { hostedOpen: [openRow('${rec:R}', 77, { account: 'DU7654321', action: 'SELL', quantity: 100, lmt_price: 231 })] } }, poll(), poll()],
  }, (out) => { must(Object.keys(snap(out, 4).closeChase).length === 0, '托管的不按追价认领'); });
  add('fired_but_enabled_is_blocked', {
    settings: auto, router: trRouter({ rows: [stk('NVDA', { market_price: 255 })] }), setup: [trkSw('A', 'NVDA')],
    steps: [{ op: 'updateTrack', track: 'A', fields: { fired_at: '2026-09-11T15:00:00+00:00', fired_state: 'take_profit' } }, poll(), poll()],
  }, (out) => { must(res(out, 1).blocked.length === 1 && JSON.stringify(res(out, 1).blocked).includes('触发过'), '已触发过的不重复发'); });
  add('place_zero_ids_are_not_indexed', {
    settings: auto, router: baseRouter({ behaviors: { place: [{ res: { order_id: 0, perm_id: 0 } }, { res: { order_id: null, perm_id: 9001 } }] } }),
    parser: { behaviors: { parse: [llm([stockOrder(), stockOrder({ intent_summary: '第二笔' }, {}, { symbol: 'MSFT' })])] } }, steps: [ins('两单')],
  }, (out) => { must(!('0' in snap(out, 0).orderIndex) && !('0' in snap(out, 0).sent), '0 号不入账'); });
  add('tick_callback_receives_poll_and_hosted', {
    settings: auto, router: trRouter({ rows: [stk()] }), setup: [trkSw('A')], steps: [tick()],
  }, (out) => { must(out.log.some((e) => e.c === 'tick'), '回调被叫到'); });
}

// ---------------------------------------------------------------- C++ 独有行为的脚本(不与 TS 比,见 tst_engine_core.cpp 的 cppOnly)
export function cppScenarios() {
  const out = [];
  const add = (name, script) => out.push({ name, script: { start: T0, ...script } });
  add('cppx_reload_keeps_pending', {
    settings: auto, router: baseRouter(), parser: { behaviors: { parse: [llm([condOrder(), condOrder({ intent_summary: '第二张' }, {}, {}, 7600)])] } },
    steps: [ins('两张条件单'), { op: 'reload' }, { op: 'fire', prices: { SPX: 7500 } }, { op: 'fire', prices: { SPX: 7500 } }],
  });
  add('cppx_fire_rechecks_breaker', {
    settings: auto, router: baseRouter({ behaviors: { place: [{ emit: [{ op: 'engage', reason: '并发熔断' }] }] } }),
    parser: { behaviors: { parse: [llm([condOrder(), condOrder({ intent_summary: '第二张' }, {}, {}, 7600)])] } },
    steps: [ins('两张条件单'), { op: 'fire', prices: { SPX: 7500 } }, { op: 'breaker', action: 'release' }, { op: 'fire', prices: { SPX: 7500 } }],
  });
  add('cppx_halt_cancel_throws', {
    settings: auto, router: baseRouter({ rows: [stk()] }), setup: [trk('A')],
    parser: { behaviors: { parse: [llm([condOrder()])] } },
    steps: [{ op: 'sync' }, ins('SPX 到 7505 买蝶'), { op: 'router', push: { cancelAllOpen: [{ error: { cls: 'Error', msg: '撤单炸了' } }] } }, { op: 'halt', reason: '手动' }],
  });
  const filled = { op: 'session', session: 0, kind: 'status', trade: { order: { orderId: 501, permId: null }, orderStatus: { status: 'Filled', filled: 100, remaining: 0 }, contract: { symbol: 'AAPL' } } };
  const retireBase = {
    settings: auto, router: baseRouter({ sessions: [{ name: 's1' }] }), parser: { behaviors: { parse: [llm([stockOrder()])] } },
  };
  add('cppx_retired_engine_forwards_to_new', { ...retireBase, steps: [{ op: 'attach' }, ins('买入 AAPL'), { op: 'reload' }, filled] });
  add('cppx_ledgers_not_carried_to_new_router', { ...retireBase, steps: [{ op: 'attach' }, ins('买入 AAPL'), { op: 'reload', sameRouter: false }, filled] });
  const tr = { order: { orderId: 501, permId: null }, orderStatus: { status: 'Filled', filled: 100, remaining: 0 }, contract: { symbol: 'AAPL' } };
  add('cppx_retired_forwards_the_rest', {
    ...retireBase,
    steps: [{ op: 'attach' }, ins('买入 AAPL'), { op: 'reload' }, { op: 'tick' },
      { op: 'session', session: 0, kind: 'fill', trade: tr, fill: { execution: { execId: 'E1', time: '20260911 12:00:00', price: 230.5, shares: 100, side: 'BOT', acctNumber: 'DU7654321' }, contract: { secType: 'STK', conId: 265598 }, live: true } },
      { op: 'session', session: 0, kind: 'commission', trade: tr, fill: {}, report: { execId: 'E1', commission: 1.25, realizedPNL: 15.5 } },
      { op: 'session', session: 0, kind: 'error', reqId: 501, code: 201, message: '资金不足' }, { op: 'connect', def: { name: 's2' } }],
  });
  return out;
}
