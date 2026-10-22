// BrokerRouter 对拍的场景清单(脚本格式见 broker_world.mjs)。gen_broker_router.mjs 逐个交给原 TS 现跑;gen_broker_fuzz.mjs 用这里的零件拼随机脚本。
export const A_PAPER = 'DU7654321', A_LIVE = 'U1234567', A_LIVE2 = 'U7777777';

export function builders(mods) {
  const TZ = mods.tz;
  /** 美东墙钟 → 时刻 */
  const et = (date, hhmm, sec = 0) => {
    const [y, m, d] = date.split('-').map(Number);
    const [hour, minute] = hhmm.split(':').map(Number);
    return TZ.wallToEpoch({ year: y, month: m, day: d, hour, minute, second: sec }, TZ.ET);
  };
  const RTH = et('2026-10-12', '10:30'); // 周一盘中
  const NIGHT = et('2026-10-13', '02:10'); // 周二夜里
  const WEEKEND = et('2026-10-17', '12:00');

  const stockSpec = (symbol = 'AAPL') => ({ secType: 'STK', symbol, exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: null, strike: null, right: null, multiplier: '100', tradingClass: null, combo_strategy: null, legs: null });
  const optSpec = (symbol, expiry, strike, right, tc = null) => ({ secType: 'OPT', symbol, exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100', tradingClass: tc, combo_strategy: null, legs: null });
  const leg = (action, expiry, strike, right, tc = 'SPXW', ratio = 1) => ({ action, ratio, lastTradeDateOrContractMonth: expiry, strike, right, tradingClass: tc, multiplier: '100' });
  const vertical = (action, strikes = [7520, 7550], exp = '20261016', tc = 'SPXW') => ({
    secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: null, strike: null, right: null, multiplier: '100', tradingClass: null,
    combo_strategy: 'VERTICAL', legs: [leg('BUY', exp, strikes[0], 'C', tc), leg('SELL', exp, strikes[1], 'C', tc)] });
  const butterfly = (strikes = [7600, 7625, 7650], exp = '20261016') => ({
    secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: null, strike: null, right: null, multiplier: '100', tradingClass: null,
    combo_strategy: 'BUTTERFLY', legs: [leg('BUY', exp, strikes[0], 'C'), leg('SELL', exp, strikes[1], 'C', 'SPXW', 2), leg('BUY', exp, strikes[2], 'C')] });
  const ord = (over = {}) => ({ action: 'BUY', orderType: 'LMT', totalQuantity: 100, price_mode: 'EXPLICIT', lmtPrice: 230, auxPrice: null, trailingPercent: null, tif: 'DAY', outsideRth: false, ...over });
  const parsed = (contract, order, trigger = null) => ({ contract, order, trigger });
  const trig = (over = {}) => ({ type: 'PRICE', symbol: 'SPX', secType: 'IND', operator: '>=', value: 7500, ...over });
  const approved = (p, account = '模拟') => ({ order: p, account, notional: 1000, signature: 'sig', warnings: [] });
  const hostedItem = (over = {}) => ({ kind: 'tp', action: 'SELL', order_type: 'LMT', quantity: 100, lmt_price: 250, aux_price: null, trailing_percent: null, trail_stop_seed: null, label: '托管止盈', ...over });

  const sess = (name, over = {}) => ({ name, connected: true, accounts: [], caps: [], ...over });
  const ALLCAPS = ['ContractHours', 'SetBaselineMarketDataType', 'OpenTradesDetailed', 'Executions', 'OnLink', 'OnError', 'QuoteDelayed'];
  const paper = (over = {}) => sess('P', { accounts: [A_PAPER], caps: ALLCAPS, ...over });
  const live = (over = {}) => sess('L', { accounts: [A_LIVE, A_LIVE2], caps: ALLCAPS, ...over });
  const call = (m, a = {}, extra = {}) => ({ op: 'call', m, a, ...extra });
  const rawBar = (stamp, close, extra = {}) => ({ date: stamp, open: close, high: close, low: close, close, volume: 1, ...extra });
  const pos = (symbol, position, avgCost, extra = {}, contract = {}) => ({ contract: { symbol, secType: 'STK', ...contract }, position, avgCost, account: A_PAPER, ...extra });
  const optPos = (strike, position, right = 'C', exp = '20261016', account = A_PAPER) => ({ account, position, avgCost: 40, contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: exp, strike, right, multiplier: '100', tradingClass: 'SPXW' } });
  const optRow = (strike, account = '模拟', right = 'C', exp = '20261016') => {
    const spec = { secType: 'OPT', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: exp, strike, right, multiplier: '100', tradingClass: 'SPXW' };
    return { key: `${account}|SPX|OPT|${exp}|${strike}|${right}`, account, symbol: 'SPX', sec_type: 'OPT', leg: `${exp}|${strike}|${right}`, label: 'x', quantity: 1, multiplier: 100, currency: 'USD', avg_cost: 0, market_price: null, market_value: null, unrealized_pnl: null, contract: spec };
  };
  return { et, RTH, NIGHT, WEEKEND, stockSpec, optSpec, leg, vertical, butterfly, ord, parsed, trig, approved, hostedItem, sess, paper, live, call, rawBar, pos, optPos, optRow, ALLCAPS };
}

export function scenarios(mods) {
  const B = builders(mods);
  const { et, RTH, NIGHT, WEEKEND, stockSpec, optSpec, vertical, butterfly, ord, parsed, trig, approved, hostedItem, sess, paper, live, call, rawBar, pos, optPos, optRow } = B;
  const out = [];
  const add = (name, script) => out.push({ name, script: { start: RTH, settings: {}, factory: { paper: ['P'], live: ['L'] }, sessions: [], events: [], steps: [], ...script } });

  // ---------------------------------------------------------------- 连接与路由
  add('路由:按 managedAccounts 实测改道', { sessions: [sess('P', { accounts: ['U1234567'], caps: ['OnLink'] }), sess('L', { accounts: ['DU7654321'], caps: ['OnLink'] })],
    steps: [call('forAccount', { account: '模拟' }), { op: 'get', what: 'sessions' }, call('forAccount', { account: '模拟' }), call('forAccount', { account: '主账户' })] });
  add('路由:哪条连接都不管 → 明确拒绝', { sessions: [sess('P', { accounts: ['DU0000009'] }), sess('L', { accounts: ['U0000009'] })], steps: [call('forAccount', { account: '模拟' })] });
  add('路由:会话没报账户列表,只对配置的连接放行', { sessions: [sess('P'), sess('L')], steps: [call('forAccount', { account: '模拟' }), call('forAccount', { account: '主账户' }), { op: 'get', what: 'sessions' }] });
  add('路由:账户在后一条连接上;前一条连不上', { factory: { paper: [{ error: 'connect ECONNREFUSED' }], live: ['L'] }, sessions: [sess('L', { accounts: [A_PAPER, A_LIVE] })],
    steps: [call('forAccount', { account: '模拟' }), call('forAccount', { account: '模拟' })] });
  add('路由:全连不上 → 失败原因都带上', { factory: { paper: [{ error: 'boom1' }], live: [{ error: 'boom2' }] }, steps: [call('forAccount', { account: '主账户' })] });
  add('路由:缓存的改道在连接还在配置里时优先;断了之后重新连', { sessions: [sess('P', { accounts: ['U1234567'] }), sess('L', { accounts: ['DU7654321'] }), sess('P2', { accounts: ['U1234567'] })],
    factory: { paper: ['P', 'P2'], live: ['L'] },
    steps: [call('forAccount', { account: '模拟' }), { op: 'sess', session: 'L', set: { connected: false } }, call('forAccount', { account: '模拟' }), { op: 'get', what: 'sessions' }] });
  add('连接:未定义的连接;已连着的原样返回;工厂只被问一次', { sessions: [paper()], steps: [call('connect', { name: 'nope' }), call('connect', { name: 'paper' }), call('connect', { name: 'paper' }), { op: 'get', what: 'connectedNames' }] });
  add('连接:重连断着的旧会话——先把旧的停掉', { sessions: [paper(), paper({ name: 'P2' })], factory: { paper: ['P', 'P2'] },
    steps: [call('connect', { name: 'paper' }), { op: 'sess', session: 'P', set: { connected: false } }, call('connect', { name: 'paper' }), { op: 'get', what: 'sessions' }] });
  add('连接:旧会话 disconnect 抛 → connect 抛原错', { sessions: [paper({ throwDisconnect: true }), paper({ name: 'P2' })], factory: { paper: ['P', 'P2'] },
    steps: [call('connect', { name: 'paper' }), { op: 'sess', session: 'P', set: { connected: false } }, call('connect', { name: 'paper' }), call('connect', { name: 'paper' })] });
  add('连接:纸面连接的会话行情类型基线定 3;实盘不动;设不上也不拦', { sessions: [paper(), live(), paper({ name: 'P2', throwBaseline: true })], factory: { paper: ['P', 'P2'], live: ['L'] },
    steps: [call('connect', { name: 'paper' }), call('connect', { name: 'live' }), { op: 'sess', session: 'P', set: { connected: false } }, call('connect', { name: 'paper' })] });
  add('连接:一条连接上既有纸面又有实盘账户 → 不设基线', { settings: { accounts: [{ alias: '模拟', account_id: A_PAPER, is_paper: true, connection: 'paper', default: true }, { alias: '另一个', account_id: 'U5', is_paper: false, connection: 'paper' }] },
    sessions: [paper()], steps: [call('connect', { name: 'paper' })] });
  add('连接:sessionHook / linkHook 转发;hook 抛不拦连接', { sessions: [paper(), live()],
    steps: [{ op: 'hooks', link: true, session: true, sessionThrows: true }, call('connect', { name: 'paper' }), call('connect', { name: 'live' }),
      { op: 'emitLink', session: 'P', up: false }, { op: 'emitLink', session: 'P', up: true }, { op: 'emitLink', session: 'L', up: false }] });
  add('连接:没有会话没报 OnLink 能力;工厂拒 → 错误文案带端口', { sessions: [sess('P', { accounts: [A_PAPER] })], factory: { paper: [{ error: 'refused' }, 'P'] },
    steps: [call('connect', { name: 'paper' }), call('connect', { name: 'paper' }), { op: 'get', what: 'upstreamOk' }] });
  add('上游:1100 断 → stalled 提示指向 TWS;1102 恢复', { sessions: [paper({ qualify: [{ kind: 'timeout' }] })],
    steps: [call('connect', { name: 'paper' }), { op: 'emitConnectivity', session: 'P', code: 1100 }, { op: 'get', what: 'upstreamOk' },
      call('place', { recordId: 'r1', approved: approved(parsed(stockSpec(), ord())) }), { op: 'emitConnectivity', session: 'P', code: 1102 }, { op: 'get', what: 'upstreamOk' },
      call('place', { recordId: 'r2', approved: approved(parsed(stockSpec(), ord())) })] });
  add('上游:按连接记;换下的旧会话再说什么都不算;disconnectAll 清掉', { sessions: [paper(), live(), paper({ name: 'P2' })], factory: { paper: ['P', 'P2'], live: ['L'] },
    steps: [call('connect', { name: 'paper' }), call('connect', { name: 'live' }), { op: 'emitConnectivity', session: 'L', code: 2110 }, { op: 'get', what: 'upstreamOk' },
      { op: 'emitConnectivity', session: 'P', code: 1100 }, { op: 'emitConnectivity', session: 'P', code: 1102 }, { op: 'get', what: 'upstreamOk' },
      { op: 'sess', session: 'P', set: { connected: false } }, call('connect', { name: 'paper' }), { op: 'emitConnectivity', session: 'P', code: 1100 }, { op: 'get', what: 'upstreamOk' },
      call('disconnectAll'), { op: 'get', what: 'upstreamOk' }, { op: 'get', what: 'sessions' }] });
  add('disconnectAll:撤常驻流、停全部会话(断着的也停)、清路由', { sessions: [paper({ initial: {} }), live()],
    steps: [call('connect', { name: 'paper' }), call('connect', { name: 'live' }), call('streamQuotes', { symbols: ['SPY', 'QQQ'] }), { op: 'sess', session: 'L', set: { connected: false } },
      call('disconnectAll'), { op: 'get', what: 'connectedNames' }, call('forAccount', { account: '模拟' })] });
  add('coveredAccounts / coveredAccountIds / connectedNames / marketSession', { sessions: [paper(), live()],
    steps: [{ op: 'get', what: 'marketSession' }, call('connect', { name: 'paper' }), { op: 'get', what: 'coveredAccounts' }, { op: 'get', what: 'coveredAccountIds' }, call('connect', { name: 'live' }),
      { op: 'get', what: 'coveredAccounts' }, { op: 'get', what: 'coveredAccountIds' }, { op: 'get', what: 'connectedNames' }, { op: 'sess', session: 'P', set: { connected: false } },
      { op: 'get', what: 'coveredAccountIds' }, { op: 'get', what: 'marketSession' }, { op: 'get', what: 'connections' }] });


  // ---------------------------------------------------------------- 合约确认 / 下单
  const K = (c, g = '') => mods.tickerKey(c, g);
  const C = mods.contracts;
  const stockKey = (sym, g = '') => K(C.stockContract(sym), g);
  const optKey = (strike, right = 'C', exp = '20261016', tc = 'SPXW', g = '') => K(C.optionContract('SPX', exp, strike, right, 'SMART', 'USD', '100', tc), g);
  const placeStock = (id = 'r1', over = {}, acct = '模拟') => call('place', { recordId: id, approved: approved(parsed(stockSpec(), ord(over)), acct) });
  add('确认:超时 → stalled 提示(没有上游码时);认不出 → 拦下;确认成功缓存、第二次零往返', { sessions: [paper({ qualify: [{ kind: 'timeout' }, { kind: 'ok', conIds: [null] }, { kind: 'ok' }] })],
    steps: [placeStock('a'), placeStock('b'), placeStock('c'), placeStock('d')] });
  add('确认:会话抛别的错 → 原样冒出;缓存键是改写前的(同一合约第二次零往返)', { sessions: [paper({ qualify: [{ kind: 'error', message: 'qualify exploded' }, { kind: 'ok' }] })],
    steps: [placeStock('a'), placeStock('b'), placeStock('c'), call('qualify', { contract: stockSpec(), account: '模拟' }), call('qualify', { contract: optSpec('SPX', '20261016', 7520, 'C', 'SPXW'), account: '模拟' }), call('qualify', { contract: optSpec('SPX', '20261016', 7520, 'C', 'SPXW'), account: '模拟' })] });
  add('确认:未知标的(会话给不出 conId)', { sessions: [paper({ unknown: ['AAPL'] })], steps: [placeStock('a'), call('qualify', { contract: optSpec('SPX', '20261016', 7520, 'C', 'SPXW'), account: '模拟' })] });
  add('确认:组合一次批量确认、缓存命中的腿不再问;一条腿认不出整单拦下', { sessions: [paper({ qualify: [{ kind: 'ok' }, { kind: 'ok', conIds: [null, 5] }, { kind: 'ok' }] })],
    steps: [call('qualify', { contract: vertical('BUY'), account: '模拟' }), call('qualify', { contract: vertical('BUY'), account: '模拟' }), call('qualify', { contract: vertical('BUY', [7520, 7560]), account: '模拟' }),
      call('qualify', { contract: butterfly(), account: '模拟' }), call('qualify', { contract: butterfly(), account: '模拟' })] });
  add('确认:空的组合腿表、BAG 腿的乘数与交易类', { sessions: [paper()], steps: [call('qualify', { contract: { ...vertical('BUY'), legs: [] }, account: '模拟' }), call('qualify', { contract: { ...vertical('BUY'), legs: null }, account: '模拟' })] });
  add('确认:挂着不回(hang)→ 一直挂起', { sessions: [paper({ qualify: [{ kind: 'hang' }] })], steps: [placeStock('a'), { op: 'advance', ms: 100000 }] });
  add('确认闸:只读的取数超时之后 30 秒内当场答,下单路径照样问;到点放一路试探', { sessions: [paper({ qualify: [{ kind: 'timeout' }, { kind: 'timeout' }, { kind: 'ok' }] })],
    steps: [call('stockQuotes', { symbols: ['AAA', 'BBB'] }), call('stockQuotes', { symbols: ['CCC'] }), placeStock('o1'), { op: 'advance', ms: 31000 }, call('stockQuotes', { symbols: ['DDD', 'EEE'] }), call('stockQuotes', { symbols: ['FFF'] })] });

  // 下单
  add('下单:股票限价单带 orderRef 与账户;会话回执原样带出', { sessions: [paper(), live()], steps: [placeStock('rec-abc'), call('place', { recordId: 'rec-live', approved: approved(parsed(stockSpec('TSLA'), ord({ action: 'SELL', tif: 'GTC', outsideRth: true, lmtPrice: 301.5 })), '主账户') })] });
  add('下单:全部订单类型(MKT / STP / STP LMT / TRAIL 百分比与金额)', { sessions: [paper(), live()], steps: [
    call('place', { recordId: 'm', approved: approved(parsed(stockSpec(), ord({ orderType: 'MKT', lmtPrice: null }))) }),
    call('place', { recordId: 's', approved: approved(parsed(stockSpec(), ord({ orderType: 'STP', lmtPrice: null, auxPrice: 210 }))) }),
    call('place', { recordId: 'sl', approved: approved(parsed(stockSpec(), ord({ orderType: 'STP LMT', lmtPrice: 209, auxPrice: 210 }))) }),
    call('place', { recordId: 't1', approved: approved(parsed(stockSpec(), ord({ orderType: 'TRAIL', lmtPrice: null, trailingPercent: 5 }))) }),
    call('place', { recordId: 't2', approved: approved(parsed(stockSpec(), ord({ orderType: 'TRAIL', lmtPrice: null, auxPrice: 1.5 }))) }),
    call('place', { recordId: 'bad', approved: approved(parsed(stockSpec(), ord({ orderType: 'LMT', lmtPrice: null }))) }),
    call('place', { recordId: 'bad2', approved: approved(parsed(stockSpec(), ord({ orderType: 'FOK' }))) }),
  ] });
  add('下单:AUTO_MID 的覆盖价原样透传(含 NaN / 无穷 / 负);BAG 不再签', { sessions: [paper()], steps: [
    call('place', { recordId: 'a', approved: approved(parsed(vertical('BUY'), ord({ price_mode: 'AUTO_MID', lmtPrice: null }))), limitOverride: 7.95 }),
    call('place', { recordId: 'b', approved: approved(parsed(vertical('SELL'), ord({ action: 'SELL', price_mode: 'AUTO_MID', lmtPrice: null }))), limitOverride: -3.25 }),
    call('place', { recordId: 'c', approved: approved(parsed(stockSpec(), ord({ price_mode: 'AUTO_MID', lmtPrice: null }))), limitOverride: '__NaN__' }),
    call('place', { recordId: 'd', approved: approved(parsed(stockSpec(), ord({ orderType: 'MKT', lmtPrice: null }))), limitOverride: 5 }),
    call('place', { recordId: 'e', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 10 }))), limitOverride: '__Inf__' }),
  ] });
  add('下单:BAG 一律 BUY 提交;贷方限价取负;SELL 的蝶 / 垂直都是', { sessions: [paper()], steps: [
    call('place', { recordId: 'v1', approved: approved(parsed(vertical('BUY'), ord({ lmtPrice: 15 }))) }),
    call('place', { recordId: 'v2', approved: approved(parsed(vertical('SELL'), ord({ action: 'SELL', lmtPrice: 12 }))) }),
    call('place', { recordId: 'v3', approved: approved(parsed(butterfly(), ord({ action: 'BUY', lmtPrice: 3.5 }))) }),
    call('place', { recordId: 'v4', approved: approved(parsed(butterfly(), ord({ action: 'SELL', lmtPrice: 3.5 }))) }),
    call('place', { recordId: 'v5', approved: approved(parsed(vertical('BUY'), ord({ orderType: 'MKT', lmtPrice: null }))) }),
    call('place', { recordId: 'v6', approved: approved(parsed(vertical('SELL'), ord({ action: 'SELL', price_mode: 'AUTO_MID', lmtPrice: null }))) }),
  ] });
  add('下单:显式价的条件单挂原生 PriceCondition;AUTO_MID 不挂;股票触发;未配置的指数落到 CBOE', { sessions: [paper()], steps: [
    call('place', { recordId: 'c1', approved: approved(parsed(vertical('BUY'), ord({ lmtPrice: 15 }), trig())) }),
    call('place', { recordId: 'c2', approved: approved(parsed(vertical('BUY'), ord({ price_mode: 'AUTO_MID', lmtPrice: null }), trig())), limitOverride: 7.5 }),
    call('place', { recordId: 'c3', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'AAPL', secType: 'STK', operator: '<=', value: 190.5 }))) }),
    call('place', { recordId: 'c4', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'NDX', secType: 'IND', operator: '<=', value: 21000 }))) }),
    call('place', { recordId: 'c5', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'VIX', secType: 'IND', operator: '>=', value: 20 }))) }),
    call('place', { recordId: 'c6', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'AAPL', secType: 'STK' }))) }),
  ], });
  add('下单:触发标的认不出 → 在 qualify 上拦;触发那一步 qualify 超时', { sessions: [paper({ unknown: ['ZZZ'] })], steps: [
    call('place', { recordId: 'c1', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'ZZZ', secType: 'STK' }))) }),
    call('place', { recordId: 'c2', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig())) }),
  ] });
  add('下单:会话回执各种形状(orderId 0 / null / 没有 status);断线 → LinkDownError;别的错', { sessions: [paper({ place: [{ orderId: 0, permId: 5, status: '' }, { orderId: null, permId: null, status: 'Submitted' }, { orderId: 77, permId: null, status: 'PreSubmitted' }, { linkDown: true }, { error: 'order rejected' }, { orderId: 9, permId: 1, status: 'Filled' }] })],
    steps: [placeStock('a'), placeStock('b'), placeStock('c'), placeStock('d'), placeStock('e'), placeStock('f')] });
  add('下单:账户在另一条连接上;账户路由不到 → 错误冒出、什么都不发', { sessions: [sess('P', { accounts: ['U1234567'] }), sess('L', { accounts: ['DU7654321'] })], steps: [placeStock('a'), placeStock('b', {}, '主账户'), call('place', { recordId: 'c', approved: approved(parsed(stockSpec(), ord()), '副账户') })] });
  add('下单:期权单腿与账户号只在 approved.account', { sessions: [paper()], steps: [call('place', { recordId: 'o', approved: approved(parsed(optSpec('SPX', '20261016', 7520, 'C', 'SPXW'), ord({ lmtPrice: 12.4 }))) }), call('place', { recordId: 'o2', approved: approved(parsed(optSpec('SPX', '20261016', 7520, 'C'), ord({ lmtPrice: 12.4 }))) })] });
  add('撤全部:已连的会话各撤各的;断着的跳过;撤单抛', { sessions: [paper({ openTrades: [{ orderId: 7 }, { orderId: 8 }] }), live({ openTrades: [{ orderId: 9 }, { orderId: 10, throws: true }, { orderId: 11 }] })],
    steps: [call('cancelAllOpen'), call('connect', { name: 'paper' }), call('connect', { name: 'live' }), call('cancelAllOpen'), { op: 'sess', session: 'P', set: { connected: false } }, call('cancelAllOpen')] });

  // 托管单
  const stockC = stockSpec();
  add('托管:挂单带 OCA 组、GTC、股票 outsideRth;期权不打;BAG 以 BUY 提交、限价按方向签', { sessions: [paper()], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'oca-1', ref: 'trk:1:tp' }),
    call('placeHosted', { account: '模拟', contract: optSpec('SPX', '20261016', 7520, 'C', 'SPXW'), item: hostedItem({ action: 'SELL', lmt_price: 4.5 }), oca: 'oca-2', ref: 'trk:2:tp' }),
    call('placeHosted', { account: '模拟', contract: vertical('BUY'), item: hostedItem({ action: 'SELL', lmt_price: 12.35 }), oca: 'oca-3', ref: 'trk:3:tp' }),
    call('placeHosted', { account: '模拟', contract: vertical('SELL'), item: hostedItem({ action: 'BUY', lmt_price: 6.1, kind: 'sl' }), oca: 'oca-4', ref: 'trk:4:sl' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'STP', lmt_price: null, aux_price: 200, kind: 'sl' }), oca: 'oca-5', ref: 'trk:5:sl' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: 241.5, kind: 'trail' }), oca: 'oca-6', ref: 'trk:6:t' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: null, kind: 'trail' }), oca: 'oca-7', ref: 'trk:7:t' }),
  ] });
  add('托管:改价走同 orderId、同一份原样订单(第二次改看得到第一次的);组合改价照样签;数量、aux、trailing', { sessions: [paper()], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'oca-1', ref: 'trk:1:tp' }),
    call('placeHosted', { account: '模拟', contract: vertical('BUY'), item: hostedItem({ action: 'SELL', lmt_price: 12.35 }), oca: 'oca-3', ref: 'trk:3:tp' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: 241.5 }), oca: 'oca-6', ref: 'trk:6:t' }),
    call('modifyHosted', { orderId: 101, item: hostedItem({ lmt_price: 251, quantity: 90 }) }),
    call('modifyHosted', { orderId: 101, item: hostedItem({ lmt_price: null, aux_price: 3, quantity: 80 }) }),
    call('modifyHosted', { orderId: 102, item: hostedItem({ action: 'SELL', lmt_price: 11.8 }) }),
    call('modifyHosted', { orderId: 103, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 2.5 }) }),
    call('modifyHosted', { orderId: 999, item: hostedItem() }),
  ] });
  add('托管:改价时链路断了(LinkDownError)——订单已改在本地,下一次接着发;撤单没发出去不忘掉', { sessions: [paper({ place: [{}, { linkDown: true }, {}], cancel: [{ linkDown: true }, {}, {}] })], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'oca-1', ref: 'trk:1:tp' }),
    call('modifyHosted', { orderId: 101, item: hostedItem({ lmt_price: 255 }) }),
    call('modifyHosted', { orderId: 101, item: hostedItem({ lmt_price: 256, quantity: 70 }) }),
    call('cancelHosted', { orderId: 101 }), call('cancelHosted', { orderId: 101 }), call('cancelHosted', { orderId: 101 }), call('modifyHosted', { orderId: 101, item: hostedItem() }),
  ] });
  add('托管:撤单按会话撤;撤单抛别的错也不忘掉;并发改单与撤单', { sessions: [paper({ cancel: [{ error: 'cancel rejected' }, {}], place: [{}, { delay: 500 }] })], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'oca-1', ref: 'trk:1:tp' }),
    call('cancelHosted', { orderId: 101 }), call('cancelHosted', { orderId: 101 }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'oca-2', ref: 'trk:2:tp' }),
    call('modifyHosted', { orderId: 102, item: hostedItem({ lmt_price: 260 }) }, { start: true, id: 'm' }), call('cancelHosted', { orderId: 102 }), { op: 'await', id: 'm' },
  ] });
  const detailed = (over = {}) => ({ orderId: 301, permId: 7001, orderRef: 'trk:9:tp', account: A_PAPER, action: 'SELL', orderType: 'LMT', totalQuantity: 100, lmtPrice: 250, auxPrice: null, trailingPercent: null, status: 'Submitted',
    contract: { secType: 'STK', symbol: 'AAPL', exchange: 'SMART', currency: 'USD', conId: 265598 }, ocaGroup: 'oca-9', ocaType: 1, tif: 'GTC', outsideRth: true, ...over });
  add('认领:按 orderRef 前缀;BAG 的带符号净价折回正数;OCA 组与 ocaType 默认;认领后可改单 / 撤单', { sessions: [paper({ detailed: [
    detailed(), detailed({ orderId: 302, permId: 7002, orderRef: 'trk:10:sl', orderType: 'STP', lmtPrice: null, auxPrice: 200, ocaGroup: null, ocaType: null, tif: '', outsideRth: false }),
    detailed({ orderId: 303, permId: null, orderRef: 'trk:11:tp', contract: { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', comboLegs: [{ conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' }, { conId: 2, ratio: 1, action: 'SELL', exchange: 'SMART' }] }, lmtPrice: -12.35, action: 'BUY' }),
    detailed({ orderId: 0, orderRef: 'trk:12:tp' }), detailed({ orderId: null, permId: null, orderRef: 'trk:13:tp' }), detailed({ orderId: 304, orderRef: 'manual-1', ocaGroup: null, ocaType: 2 }),
    detailed({ orderId: 305, orderRef: 'trk:14:tp', ocaType: null, contract: { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD' }, lmtPrice: null }),
  ] }), live({ detailed: [detailed({ orderId: 401, account: A_LIVE, orderRef: 'trk:20:tp' })] })], steps: [
    call('listHostedOpen'), call('connect', { name: 'paper' }), call('listHostedOpen'), call('connect', { name: 'live' }), call('listHostedOpen'), call('listHostedOpen', { prefix: 'manual' }), call('listOpenOrdersDetailed'),
    call('modifyHosted', { orderId: 303, item: hostedItem({ action: 'SELL', lmt_price: 12.1 }) }), call('modifyHosted', { orderId: 301, item: hostedItem({ lmt_price: 251 }) }), call('modifyHosted', { orderId: 302, item: hostedItem({ order_type: 'STP', lmt_price: null, aux_price: 205 }) }),
    call('cancelHosted', { orderId: 401 }), call('cancelHosted', { orderId: 304 }),
    { op: 'sess', session: 'L', set: { connected: false } }, call('listHostedOpen'),
  ] });
  add('认领:会话没有 openTradesDetailed 能力 → 跳过', { sessions: [sess('P', { accounts: [A_PAPER], detailed: [detailed()] })], steps: [call('connect', { name: 'paper' }), call('listHostedOpen')] });
  add('认领:openTradesDetailed 写的是旧的 orderRef 前缀以外的单;空前缀全要', { sessions: [paper({ detailed: [detailed({ orderRef: '' }), detailed({ orderId: 302, orderRef: 'abc' })] })], steps: [call('connect', { name: 'paper' }), call('listHostedOpen', { prefix: '' }), call('listOpenOrdersDetailed')] });


    const addC = (name, script) => add(name, { ...script, steps: [call('connect', { name: 'paper' }), ...(script.steps ?? [])] });
// ---------------------------------------------------------------- 行情
  const idxKey = K(C.indexContract('SPX', 'CBOE'));
  const futKey = K(C.indexFuturesContract({ futures: 'ES', futures_exchange: 'CME' }, '2026-10-13'));
  const T0 = (d) => ({ times: true, ...d });
  addC('indexPrice:盘中官方指数,常驻流读缓存;spotInfo 记来源', { sessions: [paper({ initial: { [idxKey]: { last: 7650.25, close: 7600 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), call('indexPrice', { symbol: 'spx' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'get', what: 'spotInfo', symbol: 'AAPL' }] });
  addC('indexPrice:冷启动没有实时价 → 退到延迟行情;延迟也没有 → null;常驻流断了数据重订', { sessions: [paper()], events: [{ at: 1500, session: 'P', key: idxKey, patch: { last: 7651 } }],
    steps: [call('indexPrice', { symbol: 'SPX' }), call('indexPrice', { symbol: 'SPX' }), { op: 'patch', session: 'P', key: idxKey, patch: { last: null, close: null } }, call('indexPrice', { symbol: 'SPX' })] });
  addC('indexPrice:正股走 idx: 流;认不出 → null;没有会话 → null', { sessions: [paper({ initial: { [stockKey('AAPL')]: { last: 190.5 } }, unknown: ['ZZZ'] })], steps: [call('indexPrice', { symbol: 'AAPL' }), call('indexPrice', { symbol: 'ZZZ' }), call('indexPrice', { symbol: 'AAPL' })] });
  add('indexPrice:没有任何会话', { sessions: [], factory: {}, steps: [call('indexPrice', { symbol: 'SPX' }), call('stockQuotes', { symbols: ['A'] }), call('streamQuotes', { symbols: ['A'] }), call('volumeQuotes', { symbols: ['A'] }), call('orderBook', { symbol: 'A' }), call('historicalBars', { symbol: 'A', start: '2026-01-01', end: '2026-01-31' }), call('intradayBars', { symbol: 'A', timeframe: '5m' }), call('optionExpiries', { symbol: 'A' }), call('comboBars', { symbol: 'SPX', legs: [], day: '2026-10-12' }), call('executions'), call('optionQuotes', { rows: [optRow(7520)] })] });
  const nightHist = (extra = {}) => ({ 'SPX|CBOE': [{ bars: [rawBar('20261012 15:58:00 US/Eastern', 7639), rawBar('20261012 15:59:00 US/Eastern', 7640)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7690), rawBar('20261012 16:00:00 US/Eastern', 7691)] }], ...extra });
  addC('夜盘指数:期货现价 − 基差(同一分钟);基差写文件;第二次读缓存', { start: NIGHT, sessions: [paper({ hist: nightHist(), initial: { [futKey]: { last: 7702.5 }, [idxKey]: { last: 7640 } } })],
    steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'readFile' }, call('indexPrice', { symbol: 'SPX' }), call('indexPrice', { symbol: 'SPX' })] });
  addC('夜盘指数:基差文件在时只读文件(不取历史);坏文件 / [] / null 当没有', { start: NIGHT, basisFile: JSON.stringify({ 'ES202612|2026-10-12': { basis: 50.5, time: '2026-10-12 15:59', index_close: 1, futures_close: 2, session: '2026-10-12' } }),
    sessions: [paper({ initial: { [futKey]: { last: 7702.5 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'readFile' }] });
  for (const [label, content] of [['坏文件', '{not json'], ['数组', '[1,2]'], ['null', 'null'], ['basis 非数', JSON.stringify({ 'ES202612|2026-10-12': { basis: 'x' } })], ['数', '5'], ['basis 为 null', JSON.stringify({ 'ES202612|2026-10-12': { basis: null, time: 't' } })]]) {
    add(`夜盘指数:基差文件内容 ${label}`, { start: NIGHT, basisFile: content, sessions: [paper({ hist: nightHist(), initial: { [futKey]: { last: 7702.5 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'readFile' }] });
  }
  addC('夜盘指数:基差文件只留最近 20 条', { start: NIGHT, basisFile: JSON.stringify(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`K${String(i).padStart(2, '0')}`, { basis: i }]))),
    sessions: [paper({ hist: nightHist(), initial: { [futKey]: { last: 7702.5 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'readFile' }] });
  addC('夜盘指数:期货没有 tick → 退官方指数并说明;之后每次再试', { start: NIGHT, sessions: [paper({ hist: nightHist(), initial: { [idxKey]: { last: 7640 } }, times: true })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, call('indexPrice', { symbol: 'SPX' }), { op: 'advance', ms: 31000 }, call('indexPrice', { symbol: 'SPX' })] });
  addC('夜盘指数:期货订阅被拒(10197)→ 当场重订最多三次,原文进说明', { start: NIGHT, sessions: [paper({ hist: nightHist(), initial: { [futKey]: { error: '10197 competing live session' }, [idxKey]: { last: 7640 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, call('indexPrice', { symbol: 'SPX' })] });
  addC('夜盘指数:取基差的历史被拒 → 一分钟退避;退避内说"稍后重试";过后再试', { start: NIGHT, sessions: [paper({ hist: { 'SPX|CBOE': [{ error: 'no permission' }, { bars: nightHist()['SPX|CBOE'][0].bars }], 'ES|CME': nightHist()['ES|CME'] }, initial: { [futKey]: { last: 7702.5 }, [idxKey]: { last: 7640 } } })],
    steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'advance', ms: 61000 }, call('indexPrice', { symbol: 'SPX' })] });
  addC('夜盘指数:收盘前找不到同一分钟的 K 线 → BrokerError 记在说明里', { start: NIGHT, sessions: [paper({ hist: { 'SPX|CBOE': [{ bars: [rawBar('20261012 15:58:00 US/Eastern', 7639)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7690)] }] }, initial: { [idxKey]: { last: 7640 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('夜盘指数:两周都找不到交易日 → 不是 BrokerError,冒出去', { start: NIGHT, settings: { market_holidays: Array.from({ length: 24 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 25 + i)); return d.toISOString().slice(0, 10); }) }, sessions: [paper()], steps: [call('indexPrice', { symbol: 'SPX' })] });
  addC('夜盘指数:周末与半日市的上一个收盘', { start: WEEKEND, sessions: [paper({ hist: { 'SPX|CBOE': [{ bars: [rawBar('20261016 15:59:00 US/Eastern', 7640)] }], 'ES|CME': [{ bars: [rawBar('20261016 15:59:00 US/Eastern', 7690)] }] }, initial: { [futKey]: { last: 7702.5 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('夜盘指数:半日市(11-27)收在 13:00', { start: et('2026-11-27', '19:00'), sessions: [paper({ hist: { 'SPX|CBOE': [{ bars: [rawBar('20261127 12:59:00 US/Eastern', 7640)] }], 'ES|CME': [{ bars: [rawBar('20261127 12:59:00 US/Eastern', 7690)] }] }, initial: { [K(C.indexFuturesContract({ futures: 'ES', futures_exchange: 'CME' }, '2026-11-27'))]: { last: 7702.5 } } })], steps: [call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('暖机:常规时段外连上后在后台把期货推算暖起来,最多五次、隔三秒', { start: NIGHT, sessions: [paper({ hist: nightHist(), initial: { [idxKey]: { last: 7640 } } })],
    events: [{ at: 7000, session: 'P', key: futKey, patch: { last: 7702.5 } }], steps: [call('connect', { name: 'paper' }), { op: 'warm' }, { op: 'advance', ms: 30000 }, { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('暖机:盘中不暖;没有会话也不抛', { start: RTH, sessions: [paper()], steps: [{ op: 'warm' }, { op: 'advance', ms: 5000 }] });
  addC('暖机:一直暖不起来 → 五轮后放手', { start: NIGHT, sessions: [paper({ hist: nightHist() })], steps: [{ op: 'warm' }, { op: 'advance', ms: 60000 }, { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });

  addC('stockQuotes:涨跌幅、认不出的给空、昨收为 0 不算', { sessions: [paper({ unknown: ['ZZ'], initial: { [stockKey('AAA')]: { last: 110, close: 100 }, [stockKey('BBB')]: { marketPrice: 50.5, close: 51 }, [stockKey('CCC')]: { last: 5, close: 0 }, [stockKey('DDD')]: { close: 9 } } })],
    steps: [call('stockQuotes', { symbols: ['AAA', 'BBB', 'ZZ', 'CCC', 'DDD', 'AAA'] })] });
  addC('streamQuotes:第一次建订阅并等首笔 tick,之后读缓存;认不出的记 null 不再试;三种前缀', { sessions: [paper({ unknown: ['ZZ'], initial: { [stockKey('SPY')]: { last: 600, close: 590, lastTradeAt: 1791815000000 }, [K(C.streamContract('CRYPTO:BTC'))]: { last: 65000.5 }, [K(C.streamContract('CONTFUT:GC@COMEX'))]: { last: 4412, close: 4400 }, [K(C.streamContract('IND:TNX@CBOE'))]: { marketPrice: 41.2 } } })],
    steps: [call('streamQuotes', { symbols: ['SPY', 'CRYPTO:BTC', 'ZZ', 'CONTFUT:GC@COMEX', 'IND:TNX@CBOE', 'QQQ'] }), call('streamQuotes', { symbols: ['SPY', 'ZZ', 'QQQ'] }), { op: 'patch', session: 'P', key: stockKey('SPY'), patch: { last: 601 } }, call('streamQuotes', { symbols: ['SPY'] })] });
  const vol = (over = {}) => ({ last: 100, close: 99, open: 98, high: 101, low: 97, volume: 1e6, avgVolume: 2e6, histVol: 0.3, vol3m: 100, vol5m: 200, vol10m: 300, lastTradeAt: 1791815000000, ...over });
  const vkey = (sym) => stockKey(sym, '165,104,595');
  addC('volumeQuotes:按 generic 订并等首笔;之后只读;非有限 / 非正归 null;没有成交价用 marketPrice;延迟标记', { sessions: [paper({ initial: { [vkey('AAA')]: vol(), [vkey('BBB')]: vol({ last: null, marketPrice: 55, volume: 0, avgVolume: '__NaN__', delayed: true, close: -1 }) } })],
    steps: [call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), { op: 'patch', session: 'P', key: vkey('AAA'), patch: { last: 101 } }, call('volumeQuotes', { symbols: ['AAA', 'CCC'] })] });
  addC('volumeQuotes:认不出 → 未知标的不再试;确认超时 ≠ 认不出,退避期过了再试;被拒的流摘掉重订', { sessions: [paper({ qualify: [{ kind: 'ok' }, { kind: 'timeout' }, { kind: 'ok' }], unknown: [], initial: { [vkey('AAA')]: vol(), [vkey('BBB')]: vol(), [vkey('CCC')]: vol() } })],
    steps: [call('volumeQuotes', { symbols: ['AAA', 'BBB', 'CCC'] }), call('volumeQuotes', { symbols: ['AAA', 'BBB', 'CCC'] }), { op: 'advance', ms: 61000 }, call('volumeQuotes', { symbols: ['AAA', 'BBB', 'CCC'] }),
      { op: 'patch', session: 'P', key: vkey('AAA'), patch: { error: '10197 competing' } }, call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), call('volumeQuotes', { symbols: ['AAA'] }), { op: 'advance', ms: 61000 }, call('volumeQuotes', { symbols: ['AAA'] })] });
  addC('volumeQuotes:未知标的', { sessions: [paper({ unknown: ['ZZ'], initial: { [vkey('AAA')]: vol() } })], steps: [call('volumeQuotes', { symbols: ['ZZ', 'AAA'] }), call('volumeQuotes', { symbols: ['ZZ'] })] });
  addC('volumeQuotes:会话换了(断线重连)→ 旧句柄摘掉(在旧会话上撤)重订;releaseVolumeStreams;disconnectAll 一起撤', { sessions: [paper({ initial: { [vkey('AAA')]: vol(), [vkey('BBB')]: vol() } }), paper({ name: 'P2', initial: { [vkey('AAA')]: vol({ last: 200 }), [vkey('BBB')]: vol() } })], factory: { paper: ['P', 'P2'] },
    steps: [call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), { op: 'sess', session: 'P', set: { connected: false } }, call('connect', { name: 'paper' }), call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), call('releaseVolumeStreams', { keep: ['AAA'] }), call('releaseVolumeStreams', { keep: [] }), call('volumeQuotes', { symbols: ['AAA', 'BBB'] }), call('disconnectAll')] });
  addC('volumeQuotes:撤订阅抛不拦重订;盘口页只撤自己那条(不带 generic)', { sessions: [paper({ throwCancel: true, initial: { [vkey('AAA')]: vol(), [stockKey('AAA')]: { bid: 99, ask: 100, bidSize: 3, askSize: 4, last: 99.5 } } })],
    steps: [call('volumeQuotes', { symbols: ['AAA'] }), { op: 'patch', session: 'P', key: vkey('AAA'), patch: { error: 'x' } }, call('volumeQuotes', { symbols: ['AAA'] }), call('releaseVolumeStreams', { keep: [] })] });

  addC('orderBook:一档 + 深度;失衡;点差', { sessions: [paper({ initial: { [stockKey('AAPL')]: { bid: 99.9, ask: 100.1, bidSize: 300, askSize: 100, last: 100 } }, depth: [{ bids: [{ price: 99.9, size: 300 }, { price: 99.8, size: 200 }], asks: [{ price: 100.1, size: 100 }] }] })], steps: [call('orderBook', { symbol: 'AAPL', rows: 5 })] });
  addC('orderBook:没有深度权限 → 提示;深度为空 → 另一句;只有一档的失衡标 l1_only;指数拒绝', { sessions: [paper({ initial: { [stockKey('AAPL')]: { bid: 99.9, ask: 100.1, bidSize: 300, askSize: 100, last: null, close: 98 }, [stockKey('BBB')]: { bid: 10, ask: 9 }, [stockKey('CCC')]: { bid: '__NaN__', ask: 5, bidSize: 0, askSize: 7 } }, depth: [{ error: 'Requested market data is not subscribed' }, { bids: [], asks: [] }, { bids: [], asks: [] }, { bids: [], asks: [] }] })],
    steps: [call('orderBook', { symbol: 'AAPL' }), call('orderBook', { symbol: 'AAPL' }), call('orderBook', { symbol: 'BBB' }), call('orderBook', { symbol: 'CCC' }), call('orderBook', { symbol: 'SPX' })] });
  addC('orderBook:盘口页订阅被拒(error)照常读出;撤订阅抛不拦', { sessions: [paper({ throwCancel: true, initial: { [stockKey('AAPL')]: { error: '354 no sub' } } })], steps: [call('orderBook', { symbol: 'AAPL' })] });

  const spxParams = [{ exchange: 'CBOE', tradingClass: 'SPXW', expirations: ['20261013', '20261014', '20261016', '20261023'], strikes: [7500, 7510, 7520, 7525, 7530, 7540, 7550, 7560, 7575, 7600] },
    { exchange: 'CBOE', tradingClass: 'SPX', expirations: ['20261016', '20261120'], strikes: [7500, 7525, 7550, 7575, 7600] }, { exchange: 'CBOE', tradingClass: 'OTHER', expirations: ['20271217'], strikes: [7000] }];
  const aaplParams = [{ exchange: 'SMART', tradingClass: '2AAPL', expirations: ['20261016'], strikes: [190, 195] }, { exchange: 'SMART', tradingClass: 'AAPL', expirations: ['20261009', '20261016', '20261023'], strikes: [185, 190, 192.5, 195, 200, 205] }];
  addC('optionExpiries:SPX 只取日 / 月两条链,按交易类分开留;去重排序;AAPL 取全部', { sessions: [paper({ secDef: [{ params: spxParams }, { params: aaplParams }, { params: [] }, { error: 'secdef failed '.repeat(30) }] })],
    steps: [call('optionExpiries', { symbol: 'SPX' }), call('optionExpiries', { symbol: 'AAPL' }), call('optionExpiries', { symbol: 'AAPL' }), call('optionExpiries', { symbol: 'AAPL' })] });
  const chainInit = (cls = 'SPXW', exp = '20261016', strikes = [7500, 7510, 7520, 7525, 7530, 7540]) => Object.fromEntries(strikes.flatMap((k) => ['C', 'P'].map((r) => [optKey(k, r, exp, cls, '100,101,106'), { bid: 1, ask: 2, iv: 0.2, gamma: 0.01, callOpenInterest: r === 'C' ? 100 : null, putOpenInterest: r === 'P' ? 50 : null, callVolume: r === 'C' ? 7 : null, putVolume: r === 'P' ? 0 : null }])));
  addC('optionChain:挑月度还是日到期;span;width 压回上限;oi 没等到是 null;撤的是 100,101,106 那条', { sessions: [paper({ secDef: [{ params: spxParams }], initial: { [idxKey]: { last: 7523 }, ...chainInit('SPXW'), ...chainInit('SPX', '20261016', [7500, 7525, 7550, 7575, 7600]) } })],
    steps: [call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 2 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 2, preferClass: 'SPXW' }), call('optionChain', { symbol: 'SPX', width: 100, span: 40 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 1 }), call('optionChain', { symbol: 'SPX', expiry: '20990101' }), call('optionChain', { symbol: 'SPX', expiry: '' })] });
  addC('optionChain:现价拿不到;合约一个都确认不了;批量确认超时;宽度 NaN', { sessions: [paper({ secDef: [{ params: spxParams }], qualify: [{ kind: 'ok' }, { kind: 'ok', conIds: [null, null] }, { kind: 'timeout' }, { kind: 'ok' }], initial: { [idxKey]: { last: 7523 } } })],
    steps: [call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 3 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 3 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 3 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: '__NaN__' })] });
  addC('optionChain:AAPL(没有指数配置)与空网格', { sessions: [paper({ secDef: [{ params: aaplParams }, { params: [{ exchange: 'SMART', tradingClass: 'AAPL', expirations: ['20261016'], strikes: [] }] }], initial: { [stockKey('AAPL')]: { last: 193 }, ...Object.fromEntries([185, 190, 192.5, 195, 200].flatMap((k) => ['C', 'P'].map((r) => [optKey(k, r, '20261016', 'AAPL', '100,101,106'), { bid: 1, ask: 2 }]))).constructor === Object ? {} : {} } })], steps: [call('optionChain', { symbol: 'AAPL', expiry: '20261016', width: 3 }), call('optionChain', { symbol: 'AAPL', expiry: '20261016', width: 3 })] });
  addC('historicalBars:股票 ADJUSTED_LAST 一路拉到今天本地切片;指数 TRADES;时长按年;失败;没有数据', { sessions: [paper({ hist: { 'AAPL|SMART': [{ bars: [rawBar('20251230', 10), rawBar('20251231', 11, { volume: '__NaN__' }), rawBar('20260102', 12, { volume: -5 }), rawBar('20261001', 13), { date: '20260105', open: 1, high: 1, low: 1, close: 1 }] }, { error: 'no data' }, { bars: [] }, { bars: [rawBar('20200101', 1)] }], 'SPX|CBOE': [{ bars: [rawBar('20251231', 7000)] }] } })],
    steps: [call('historicalBars', { symbol: 'AAPL', start: '2025-12-30', end: '2026-01-05' }), call('historicalBars', { symbol: 'AAPL', start: '2025-12-30', end: '2025-12-31' }), call('historicalBars', { symbol: 'AAPL', start: '2025-12-30', end: '2025-12-31' }), call('historicalBars', { symbol: 'AAPL', start: '2025-12-30', end: '2025-12-31' }), call('historicalBars', { symbol: 'AAPL', start: '2020-01-01', end: '2020-01-02' }), call('historicalBars', { symbol: 'SPX', start: '2025-12-01', end: '2025-12-31' }), call('historicalBars', { symbol: 'AAPL', start: '2026-10-12', end: '2026-10-12' }), call('historicalBars', { symbol: 'AAPL', start: 'garbage', end: '2026-10-12' })] });
  const iren = () => ({ 'IREN|SMART': [{ bars: [rawBar('20261009 19:30:00 US/Eastern', 35.3), rawBar('20261009 19:45:00 US/Eastern', 35.21)] }], 'IREN|OVERNIGHT': [{ bars: [rawBar('20261009 20:00:00 US/Eastern', 35.25), rawBar('20261012 03:30:00 US/Eastern', 38.38)] }] });
  addC('intradayBars:个股默认全时段 SMART + OVERNIGHT 拼好;只看常规时段;日线;未知周期;取不到报错翻译', { start: NIGHT - 6 * 3600000, sessions: [paper({ caps: [...B.ALLCAPS], hist: iren(), delayed: { [stockKey('IREN')]: true } })],
    steps: [call('intradayBars', { symbol: 'IREN', timeframe: '15m' }), call('intradayBars', { symbol: 'IREN', timeframe: '15m', rth: true }), call('intradayBars', { symbol: 'IREN', timeframe: '1d' }), call('intradayBars', { symbol: 'IREN', timeframe: '7m' }), call('intradayBars', { symbol: 'IREN', timeframe: '15m', endDay: '2026-10-09' })] });
  addC('intradayBars:取数失败 → barsError 翻译;根数不够取长的那一档;没有数据', { sessions: [paper({ hist: { 'IREN|SMART': [{ error: 'Error 162: Historical Market Data Service error message:No market data permissions' }, { bars: [rawBar('20261009 19:30:00 US/Eastern', 1)] }, { bars: Array.from({ length: 40 }, (_, i) => rawBar(`20261009 ${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00 US/Eastern`, 10 + i)) }, { bars: [] }, { bars: [] }], 'IREN|OVERNIGHT': [{ error: 'nope' }] } })],
    steps: [call('intradayBars', { symbol: 'IREN', timeframe: '5m', rth: true }), call('intradayBars', { symbol: 'IREN', timeframe: '5m', rth: true }), call('intradayBars', { symbol: 'IREN', timeframe: '5m', rth: true }), call('intradayBars', { symbol: 'IREN', timeframe: '1d' })] });
  addC('intradayBars:指数的盘外按期货推算(「行情」页);不要就不问', { start: NIGHT, sessions: [paper({ caps: [...B.ALLCAPS], hist: { 'SPX|CBOE': [{ bars: [rawBar('20261012 15:55:00 US/Eastern', 7710), rawBar('20261012 15:00:00 US/Central', 7700)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:55:00 US/Eastern', 7760), rawBar('20261013 02:00:00 US/Eastern', 7790)] }] }, delayed: { [idxKey]: false } })],
    steps: [call('intradayBars', { symbol: 'SPX', timeframe: '5m', indexProxy: true }), call('intradayBars', { symbol: 'SPX', timeframe: '5m' }), call('intradayBars', { symbol: 'SPX', timeframe: '5m', indexProxy: true, rth: true })] });
  addC('comboBars:每条腿 includeExpired 确认,BAG 的 MIDPOINT 分钟线;失败翻译;腿缺字段取默认', { sessions: [paper({ hist: { 'SPX|SMART': [{ bars: [rawBar('20261012 09:30:00 US/Eastern', 3.2), rawBar('20261012 09:31:00 US/Eastern', 3.3)] }, { error: 'no hist' }] } })],
    steps: [call('comboBars', { symbol: 'SPX', legs: [{ lastTradeDateOrContractMonth: '20261012', strike: 7600, right: 'C', tradingClass: 'SPXW', ratio: 1, action: 'BUY' }, { lastTradeDateOrContractMonth: '20261012', strike: 7625, right: 'C', ratio: 2.7, action: 'SELL' }, {}], day: '2026-10-12' }), call('comboBars', { symbol: 'SPX', legs: [{ strike: '7600', right: 'P' }], day: '2026-10-12', barSize: '5 mins' })] });


  // ---------------------------------------------------------------- 持仓与成交
  const pf = (contract, position, over = {}) => ({ contract, position, averageCost: 100, marketPrice: '__NaN__', marketValue: '__NaN__', unrealizedPnL: 0, account: A_PAPER, ...over });
  const stk = (symbol, extra = {}) => ({ symbol, secType: 'STK', ...extra });
  const opt = (strike, right = 'C', exp = '20261016', extra = {}) => ({ symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: exp, strike, right, multiplier: '100', tradingClass: 'SPXW', ...extra });
  addC('positions:portfolio 优先、positions 补;别名表外的账户跳过(只提醒一次);零仓过滤;排序', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 11 }, [stockKey('ZZZ')]: { last: 5 } },
    portfolio: [{ items: [pf(stk('AAA'), 100, { marketPrice: 12.5, marketValue: 1250, unrealizedPnL: 250, averageCost: 100 }), pf(stk('ZZZ'), 0), pf(stk('TSLA'), 5, { account: 'U9999999' }), pf(stk('BBB'), -3, { marketPrice: 0, marketValue: 0 }), pf(opt(7520), 1, { marketPrice: 12.4, marketValue: 1240, averageCost: 1150 })] }],
    positions: [{ items: [{ contract: stk('AAA'), position: 100, avgCost: 90, account: A_PAPER }, { contract: stk('CCC'), position: 7, avgCost: 33, account: A_PAPER }, { contract: stk('TSLA'), position: 5, avgCost: 1, account: 'U9999999' }, { contract: opt(7540, 'P'), position: -2, avgCost: 800, account: A_PAPER }] }] })],
    steps: [call('positions'), call('positions')] });
  addC('positions:账号取持仓项 → 合约 → 默认账户;没有账号且没有默认账户;symbol 缺失;secType 缺省', { settings: { accounts: [{ alias: '模拟', account_id: A_PAPER, is_paper: true, connection: 'paper', default: true }] }, sessions: [paper({
    portfolio: [{ items: [{ contract: { symbol: 'AAA', secType: 'STK', account: A_PAPER }, position: 1, averageCost: 5, marketPrice: 6, marketValue: 6, unrealizedPnL: 1 }, { contract: { symbol: 'BBB' }, position: 2, averageCost: 5, marketPrice: 6, marketValue: 6, unrealizedPnL: 1, account: null }, { contract: { secType: 'STK' }, position: 3, averageCost: 5, marketPrice: 6, marketValue: 6, unrealizedPnL: 1 }, { contract: { symbol: 'CCC', secType: '', currency: '', exchange: '', multiplier: 'abc' }, position: '__NaN__', averageCost: '__NaN__', marketPrice: 6, marketValue: 0, unrealizedPnL: '__NaN__' }, pf({ symbol: 'DDD', secType: 'FUT', multiplier: '50', lastTradeDateOrContractMonth: '202612', strike: 0, right: '', tradingClass: '' }, 1)] }], positions: [{ items: [] }] })], steps: [call('positions')] });
  addC('positions:读不到要报错——positions 失败整次报错;portfolio 失败当空;全断了报错', { sessions: [paper({ portfolio: [{ error: 'push stuck' }, { items: [pf(stk('AAA'), 1)] }], positions: [{ items: [{ contract: stk('AAA'), position: 1, avgCost: 2, account: A_PAPER }] }, { error: 'positions boom' }] })],
    steps: [call('positions'), call('positions'), { op: 'sess', session: 'P', set: { connected: false } }, call('positions')] });
  add('positions:一个会话都没连上', { sessions: [], factory: {}, steps: [call('positions')] });
  addC('positions:两个会话,一条断着 → 它那个账户的仓这一轮看不见、不撤订阅、也不报错', { sessions: [paper({ portfolio: [{ items: [pf(stk('AAA'), 10, { marketPrice: 5 })] }], initial: {} }), live({ portfolio: [{ items: [pf(stk('BBB'), 10, { account: A_LIVE, marketPrice: 6 })] }] })],
    steps: [call('connect', { name: 'live' }), call('positions'), { op: 'sess', session: 'L', set: { connected: false } }, call('positions')] });
  addC('持仓价:正股没有现价 → 常驻订阅(纸面类型 3);实盘不切;last → 中间价;昨收只给界面看', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 11, close: 10 }, [stockKey('BBB')]: { bid: 20, ask: 21, close: 19 }, [stockKey('CCC')]: { close: 7 }, [stockKey('DDD')]: { bid: 5, ask: 4 } },
    portfolio: [{ items: [pf(stk('AAA'), 1), pf(stk('BBB'), 1), pf(stk('CCC'), 1), pf(stk('DDD'), 1), pf(stk('EEE'), 1, { marketPrice: 9, marketValue: 9 })] }] })],
    steps: [call('positions'), call('positions')] });
  addC('持仓价:有实盘账户的正股 → 不切延迟', { sessions: [paper({ portfolio: [{ items: [pf(stk('AAA'), 1)] }] }), live({ portfolio: [{ items: [pf(stk('BBB'), 1, { account: A_LIVE })] }], initial: { [stockKey('BBB')]: { last: 9 } } })],
    steps: [call('connect', { name: 'live' }), call('positions')] });
  const legInit = (strike, over, right = 'C') => ({ [optKey(strike, right)]: over });
  addC('持仓价:期权腿中间价、买价 0 照实、只有最新价、只有昨收、模型 IV', { sessions: [paper({ initial: { ...legInit(7520, { bid: 12.4, ask: 12.8, close: 11, iv: 0.21 }), ...legInit(7525, { bid: 0, ask: 0.05, close: 0.4 }), ...legInit(7530, { bid: -1, ask: 0.5, last: 0.3 }), ...legInit(7535, { close: 5 }), ...legInit(7540, { bid: '__neg0__', ask: 0.1, iv: 0.3 }) },
    portfolio: [{ items: [7520, 7525, 7530, 7535, 7540].map((k) => pf(opt(k), 1)) }] })], steps: [call('positions')] });
  addC('持仓价:流连着却半分钟没来盘口 → 撤掉重订(盘中 30 秒);没到不动;休市不判', { sessions: [paper({ times: true, initial: { [optKey(7520)]: { bid: 1, ask: 2, quotedAt: 1791815400000 }, [stockKey('AAA')]: { last: 5, quotedAt: 1791815400000 } }, portfolio: [{ items: [pf(opt(7520), 1), pf(stk('AAA'), 1)] }] })],
    steps: [call('positions'), { op: 'advance', ms: 20000 }, call('positions'), { op: 'advance', ms: 20000 }, call('positions'), { op: 'advance', ms: 20000 }, call('positions')] });
  addC('持仓价:休市时盘外的判断(合约时段缓存);streamStatus 走 cachedContractHours', { start: WEEKEND, sessions: [paper({ times: true, hours: [{ ok: ['20261016:0930-20261016:1600;20261017:CLOSED', '20261016:0930-20261016:1600', 'US/Eastern'] }], initial: { [optKey(7520)]: { bid: 1, ask: 2 } }, portfolio: [{ items: [pf(opt(7520), 1)] }] })],
    steps: [call('contractHours', { row: optRow(7520), account: '模拟' }), { op: 'get', what: 'cachedContractHours', symbol: 'SPX', expiry: '20261016' }, call('positions'), { op: 'advance', ms: 200000 }, call('positions')] });
  addC('释放平掉的订阅:腿与正股;顶栏行情带与标的现价共用的正股流不撤;只撤不带 generic 的', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 5 }, [stockKey('BBB')]: { last: 6 }, [stockKey('CCC')]: { last: 7 }, [optKey(7520)]: { bid: 1, ask: 2 }, [optKey(7525)]: { bid: 1, ask: 2 }, [stockKey('AAA', '165,104,595')]: { last: 5 } },
    portfolio: [{ items: [pf(stk('AAA'), 1), pf(stk('BBB'), 1), pf(stk('CCC'), 1), pf(opt(7520), 1), pf(opt(7525), 1)] }, { items: [pf(stk('AAA'), 1), pf(opt(7520), 1)] }, { items: [] }, { items: [pf(stk('AAA'), 1), pf(stk('BBB'), 1), pf(stk('CCC'), 1)] }] })],
    steps: [call('streamQuotes', { symbols: ['BBB'] }), call('indexPrice', { symbol: 'CCC' }), call('volumeQuotes', { symbols: ['AAA'] }), call('positions'), call('positions'), call('positions'), call('positions')] });
  addC('optionQuotes:共用持仓的常驻订阅;买价 0 照实给;拿不到给 null;重复键', { sessions: [paper({ initial: { ...legInit(7520, { bid: 12.4, ask: 12.8 }), ...legInit(7525, { bid: 0, ask: 0.05 }), ...legInit(7530, {}) } })],
    steps: [call('optionQuotes', { rows: [optRow(7520), optRow(7525), optRow(7530), optRow(7520), { ...optRow(7520), sec_type: 'STK' }] }), call('optionQuotes', { rows: [] }), call('optionQuotes', { rows: [optRow(7520, '主账户')] })] });
  const fillC = (over = {}) => ({ secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261012', strike: 7600, right: 'C', tradingClass: 'SPXW', multiplier: '100', conId: 123, currency: 'USD', exchange: 'SMART', ...over });
  const ex = (over = {}) => ({ execId: 'e1', time: '20261012  09:35:00', acctNumber: A_PAPER, side: 'BOT', shares: 1, price: 3.2, orderId: 5, permId: 600, orderRef: 'rec-1', commission: 0.65, ...over });
  addC('executions:各种成交时间写法、没有 execId 的丢、同 execId 去重、按时间排;失败翻译;没有这个方法的会话跳过', { sessions: [paper({ executions: [{ rows: [{ contract: fillC(), execution: ex() }, { contract: fillC({ strike: 0 }), execution: ex({ execId: 'e2', time: '20261012-14:00:00' }) }, { contract: {}, execution: ex({ execId: 'e3', time: '20261012 09:36:00 US/Central', orderId: 0, permId: null, shares: '__NaN__', price: 0, commission: '__NaN__' }) },
    { contract: fillC(), execution: ex({ execId: '', time: 'x' }) }, { contract: fillC(), execution: ex({ execId: 'e1', price: 9 }) }, { contract: fillC({ conId: 0 }), execution: ex({ execId: 'e4', time: '1791815400' }) }, { contract: null, execution: ex({ execId: 'e5', time: '2026-10-12 09:30:00' }) },
    { contract: fillC(), execution: ex({ execId: 'e6', time: 'garbage' }) }, { contract: fillC(), execution: ex({ execId: 'e7', time: 1791815400000 }) }, { contract: fillC(), execution: ex({ execId: 'e0', time: '20261012  09:35:00' }) }, { contract: fillC(), execution: ex({ execId: 'e8', time: null }) }, { contract: fillC(), execution: ex({ execId: 'e9', time: '20261012' }) }] }, { error: 'exec boom' }] }),
    live({ caps: ['OnLink'], executions: [{ rows: [{ contract: fillC(), execution: ex({ execId: 'zz' }) }] }] }), paper({ name: 'P3', accounts: [A_PAPER] })],
    steps: [call('connect', { name: 'live' }), call('executions'), call('executions')] });
  const row = (secType, over = {}, contract = {}) => ({ sec_type: secType, symbol: 'SPX', contract: { lastTradeDateOrContractMonth: '20261016', strike: 7520, right: 'C', ...contract }, ...over });
  addC('contractHours:OPT / BAG(取第一条腿)/ STK 回空;缓存按日;缺要素回空;会话没有这个方法 / 报错 / 超时都回空', { sessions: [paper({ hours: [{ ok: ['t1', 'l1', 'tz1'] }, { error: 'timeout' }, { ok: null }, { ok: ['t2', 'l2', 'tz2'] }] })],
    steps: [call('contractHours', { row: row('OPT'), account: '模拟' }), call('contractHours', { row: row('OPT'), account: '模拟' }), call('contractHours', { row: row('STK'), account: '模拟' }), call('contractHours', { row: row('BAG', {}, {}), account: '模拟' }),
      call('contractHours', { row: { sec_type: 'BAG', symbol: 'SPX', contract: { legs: [{ lastTradeDateOrContractMonth: '20261023', strike: 7500, right: 'P' }] } }, account: '模拟' }), call('contractHours', { row: { sec_type: 'FOP', symbol: 'ES', contract: { lastTradeDateOrContractMonth: '20261016', strike: 7500, right: 'put' } }, account: '模拟' }),
      call('contractHours', { row: row('OPT', {}, { strike: '' }), account: '模拟' }), call('contractHours', { row: row('OPT', {}, { strike: 0 }), account: '模拟' }), call('contractHours', { row: row('OPT', {}, { right: null }), account: '模拟' }), call('contractHours', { row: row('OPT', {}, { lastTradeDateOrContractMonth: '' }), account: '模拟' }),
      call('contractHours', { row: { sec_type: 'BAG', symbol: 'SPX', contract: { legs: [] } }, account: '模拟' }), call('contractHours', { row: { sec_type: 'OPT', symbol: 'SPX' }, account: '模拟' }), { op: 'advance', ms: 86400000 }, call('contractHours', { row: row('OPT'), account: '模拟' }), { op: 'get', what: 'cachedContractHours', symbol: 'SPX', expiry: '20261016' }] });
  add('contractHours:路由不到账户 → 回空;会话没有 ContractHours 能力 → 回空', { sessions: [sess('P', { accounts: [A_PAPER] }), sess('L', { accounts: ['XX'] })], steps: [call('contractHours', { row: row('OPT'), account: '模拟' }), call('contractHours', { row: row('OPT'), account: '主账户' })] });


  // ---------------------------------------------------------------- 变异检验补上的场景
  add('托管:orderId 为 0 / null 的回执不登记(之后改单 / 撤单回 false)', { sessions: [paper({ place: [{ orderId: 0, permId: 5, status: 'Submitted' }, { orderId: null, permId: null, status: 'Submitted' }, { orderId: 0, permId: 1, status: '' }] })], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'o', ref: 'trk:1:tp' }), call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem(), oca: 'o', ref: 'trk:1:tp' }),
    call('modifyHosted', { orderId: 0, item: hostedItem() }), call('cancelHosted', { orderId: 0 }), placeStock('z'), call('modifyHosted', { orderId: 0, item: hostedItem() }), call('cancelHosted', { orderId: 0 })] });
  add('托管:带 trailing_percent 空、seed 有值时不写 trailStopPrice;trailing 有值、seed 空也不写', { sessions: [paper()], steps: [
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'STP', lmt_price: null, aux_price: 200, trailing_percent: null, trail_stop_seed: 241.5 }), oca: 'o1', ref: 'trk:1:sl' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: null }), oca: 'o2', ref: 'trk:2:t' }),
    call('placeHosted', { account: '模拟', contract: stockC, item: hostedItem({ order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: 240 }), oca: 'o3', ref: 'trk:3:t' })] });
  add('认领后改单:OCA 组默认 ocaType 1 / 原值 2;没有 OCA 组的不带;tif 空回 GTC', { sessions: [paper({ detailed: [
    detailed({ orderId: 501, orderRef: 'trk:1:tp', ocaGroup: 'g1', ocaType: null, tif: '' }), detailed({ orderId: 502, orderRef: 'trk:2:tp', ocaGroup: 'g2', ocaType: 2, tif: 'DAY' }), detailed({ orderId: 503, orderRef: 'trk:3:tp', ocaGroup: null, ocaType: 2, tif: 'GTC', outsideRth: false }),
    detailed({ orderId: 504, orderRef: 'trk:4:tp', ocaGroup: '', ocaType: 1, tif: null })] })], steps: [
    call('connect', { name: 'paper' }), call('listHostedOpen'), ...[501, 502, 503, 504].map((id) => call('modifyHosted', { orderId: id, item: hostedItem({ lmt_price: 255 }) }))] });
  add('条件单的触发合约确认:刚超时过(闸着)下单路径仍然去问', { sessions: [paper({ qualify: [{ kind: 'ok' }, { kind: 'timeout' }, { kind: 'ok' }, { kind: 'ok' }] })], steps: [
    placeStock('warm'), call('stockQuotes', { symbols: ['AAA'] }), call('stockQuotes', { symbols: ['BBB'] }),
    call('place', { recordId: 'c1', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'AAPL', secType: 'STK' }))) }),
    call('place', { recordId: 'c2', approved: approved(parsed(stockSpec(), ord({ lmtPrice: 99 }), trig({ symbol: 'QQQ', secType: 'STK' }))) })] });

  add('确认缓存键在确认之前算:会话把 exchange / tradingClass 写回合约,第二次同一合约仍然零往返', { sessions: [paper({ rewrite: { exchange: 'CBOE', tradingClass: 'SPXW' } })], steps: [
    call('qualify', { contract: optSpec('SPX', '20261016', 7520, 'C', ''), account: '模拟' }), call('qualify', { contract: optSpec('SPX', '20261016', 7520, 'C', ''), account: '模拟' }),
    call('qualify', { contract: { ...vertical('BUY'), legs: vertical('BUY').legs.map((l) => ({ ...l, tradingClass: null })) }, account: '模拟' }), call('qualify', { contract: { ...vertical('BUY'), legs: vertical('BUY').legs.map((l) => ({ ...l, tradingClass: null })) }, account: '模拟' }),
    call('qualify', { contract: stockSpec('QQQ'), account: '模拟' }), call('qualify', { contract: stockSpec('QQQ'), account: '模拟' })] });
  add('disconnectAll 清掉账户路由缓存:重连之后按配置的次序重新找', { sessions: [sess('P', { accounts: [A_LIVE] }), sess('L', { accounts: [A_PAPER] }), sess('P2', { accounts: [A_PAPER] }), sess('L2', { accounts: [A_PAPER] })], factory: { paper: ['P', 'P2'], live: ['L', 'L2'] },
    steps: [call('forAccount', { account: '模拟' }), call('forAccount', { account: '模拟' }), call('disconnectAll'), call('forAccount', { account: '模拟' }), { op: 'get', what: 'sessions' }] });
  const wideGrid = Array.from({ length: 51 }, (_, i) => 7400 + i * 5);
  addC('optionChain:宽网格——width 压回 15 档(31 档 × 看涨看跌),小 width 压到 3;给 span 不超上限', { sessions: [paper({ secDef: [{ params: [{ exchange: 'CBOE', tradingClass: 'SPXW', expirations: ['20261016'], strikes: wideGrid }, { exchange: 'CBOE', tradingClass: 'SPX', expirations: ['20261016'], strikes: wideGrid.filter((k) => k % 25 === 0) }] }], initial: { [idxKey]: { last: 7524 } } })],
    steps: [call('optionChain', { symbol: 'SPX', expiry: '20261016', preferClass: 'SPXW', width: 100 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', preferClass: 'SPXW', width: 1 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', preferClass: 'SPXW', width: 15.9 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', preferClass: 'SPXW', width: 100, span: 200 }), call('optionChain', { symbol: 'SPX', expiry: '20261016', preferClass: 'SPXW', width: 16 })] });
  addC('volumeQuotes:退避期 60 秒——45 秒时还在退避,61 秒才重试(超时与被拒各一次)', { sessions: [paper({ qualify: [{ kind: 'timeout' }, { kind: 'ok' }, { kind: 'ok' }], initial: { [vkey('AAA')]: vol(), [vkey('BBB')]: vol() } })],
    steps: [call('volumeQuotes', { symbols: ['AAA'] }), { op: 'advance', ms: 45000 }, call('volumeQuotes', { symbols: ['AAA'] }), { op: 'advance', ms: 16000 }, call('volumeQuotes', { symbols: ['AAA', 'BBB'] }),
      { op: 'patch', session: 'P', key: vkey('BBB'), patch: { error: '354 no sub' } }, call('volumeQuotes', { symbols: ['BBB'] }), { op: 'advance', ms: 45000 }, call('volumeQuotes', { symbols: ['BBB'] }), { op: 'advance', ms: 16000 }, call('volumeQuotes', { symbols: ['BBB'] })] });
  add('夜盘指数:退避 60 秒——30 秒时仍说"稍后重试",61 秒才再试', { start: NIGHT, sessions: [paper({ hist: { 'SPX|CBOE': [{ error: 'no permission' }, { bars: nightHist()['SPX|CBOE'][0].bars }], 'ES|CME': nightHist()['ES|CME'] }, initial: { [futKey]: { last: 7702.5 }, [idxKey]: { last: 7640 } } })],
    steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'advance', ms: 30000 }, call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'advance', ms: 31000 }, call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  add('夜盘指数:没配期货代理的指数(VIX)照旧取官方指数,不推算', { start: NIGHT, sessions: [paper({ initial: { [K(C.indexContract('VIX', 'CBOE'))]: { last: 17.5 } } })], steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'VIX' }), { op: 'get', what: 'spotInfo', symbol: 'VIX' }] });
  const nBars = (n, base = 10) => Array.from({ length: n }, (_, i) => rawBar(`20261009 ${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00 US/Eastern`, base + i));
  addC('intradayBars:正好 30 根还要取长的那一档(MIN_BARS 含边界);31 根不取', { sessions: [paper({ hist: { 'IREN|SMART': [{ bars: nBars(30) }, { bars: nBars(40, 50) }, { bars: nBars(31) }, { bars: nBars(45, 70) }] } })],
    steps: [call('intradayBars', { symbol: 'IREN', timeframe: '15m', rth: true }), call('intradayBars', { symbol: 'IREN', timeframe: '15m', rth: true })] });
  addC('持仓价:买卖价相等(锁盘)仍按中间价;倒挂退最新价', { sessions: [paper({ initial: { ...legInit(7520, { bid: 2, ask: 2, last: 1.5 }), ...legInit(7525, { bid: 3, ask: 2.5, last: 1.7 }), [stockKey('AAA')]: { bid: 20, ask: 20, last: null }, [stockKey('BBB')]: { bid: 21, ask: 20, last: null } },
    portfolio: [{ items: [pf(opt(7520), 1), pf(opt(7525), 1), pf(stk('AAA'), 1), pf(stk('BBB'), 1)] }] })], steps: [call('positions')] });
  addC('合约时段缓存按日:隔天缓存读不到(回空,退正股表)', { sessions: [paper({ hours: [{ ok: ['t1', 'l1', 'tz1'] }, { ok: ['t2', 'l2', 'tz2'] }] })],
    steps: [call('contractHours', { row: row('OPT'), account: '模拟' }), { op: 'get', what: 'cachedContractHours', symbol: 'SPX', expiry: '20261016' }, { op: 'advance', ms: 86400000 }, { op: 'get', what: 'cachedContractHours', symbol: 'SPX', expiry: '20261016' },
      call('contractHours', { row: row('OPT'), account: '模拟' }), { op: 'get', what: 'cachedContractHours', symbol: 'SPX', expiry: '20261016' }] });
  addC('orderBook:多位小数的买卖价——点差 4 位、bps 1 位的舍入;深度合计 2 位、失衡 1 位', { sessions: [paper({ initial: { [stockKey('AAPL')]: { bid: 100.123456, ask: 100.234567, bidSize: 333, askSize: 777.777, last: 100.2 }, [stockKey('BBB')]: { bid: 1.00004, ask: 1.00009, bidSize: 1, askSize: 2 } }, depth: [{ bids: [{ price: 100.12, size: 100.005 }, { price: 100.11, size: 200.004 }], asks: [{ price: 100.24, size: 333.335 }] }, { bids: [{ price: 1, size: 1 }], asks: [{ price: 1.1, size: 2 }] }] })],
    steps: [call('orderBook', { symbol: 'AAPL' }), call('orderBook', { symbol: 'BBB' })] });
  addC('stockQuotes / streamQuotes:涨跌幅两位小数的舍入', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 100.0049, close: 99.12345 }, [stockKey('BBB')]: { last: 3.14159, close: 2.71828 }, [stockKey('CCC')]: { last: 50.005, close: 49.123 } } })],
    steps: [call('stockQuotes', { symbols: ['AAA', 'BBB', 'CCC'] }), call('streamQuotes', { symbols: ['AAA', 'BBB', 'CCC'] })] });
  const manyExp = Array.from({ length: 25 }, (_, i) => `202610${String(10 + i).padStart(2, '0')}`.replace(/^2026103[2-9]|^2026104/, '202611'));
  addC('optionChain:到期日很多——报错只列最近 5 个;返回的到期日只留 20 个', { sessions: [paper({ secDef: [{ params: [{ exchange: 'CBOE', tradingClass: 'SPXW', expirations: manyExp, strikes: [7500, 7520, 7525, 7540] }] }], initial: { [idxKey]: { last: 7523 }, ...chainInit('SPXW', manyExp[0], [7500, 7520, 7525, 7540]) } })],
    steps: [call('optionChain', { symbol: 'SPX', expiry: '20991231' }), call('optionChain', { symbol: 'SPX', width: 3 })] });
  add('夜盘指数:基差与期货价带多位小数——基差 4 位、说明里 2 位、推算价 2 位的舍入', { start: NIGHT, sessions: [paper({ hist: { 'SPX|CBOE': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7640.12345)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7690.56789)] }] }, initial: { [futKey]: { last: 7702.56789 } } })],
    steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'readFile' }] });
  addC('持仓价:同一只正股两个账户,一个账户推送里有现价、一个没有——有现价的不被行情流覆盖', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 11, close: 10 }, [optKey(7520)]: { bid: 1, ask: 2 } },
    portfolio: [{ items: [pf(stk('AAA'), 1, { marketPrice: 9, marketValue: 9 }), pf(stk('AAA'), 2, { account: A_LIVE }), pf(opt(7520), 1, { marketPrice: 7, marketValue: 7 }), pf(opt(7525), 1)] }] })], steps: [call('positions')] });
  add('optionChain:夜盘推算的现价恰好是 0 → 同样拿不到现价', { start: NIGHT, sessions: [paper({ secDef: [{ params: spxParams }], hist: { 'SPX|CBOE': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7640)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7690.5)] }] }, initial: { [futKey]: { last: 50.5 } } })],
    steps: [call('connect', { name: 'paper' }), call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 3 }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('comboBars:腿比例取整后为 0 / 非数 → 按 1;负比例照留', { sessions: [paper({ hist: { 'SPX|SMART': [{ bars: [rawBar('20261012 09:30:00 US/Eastern', 3.2)] }] } })],
    steps: [call('comboBars', { symbol: 'SPX', legs: [{ strike: 7600, right: 'C', ratio: 0.5, action: 'BUY' }, { strike: 7625, right: 'C', ratio: 0, action: 'SELL' }, { strike: 7650, right: 'C', ratio: '__NaN__', action: 'BUY' }, { strike: 7675, right: 'C', ratio: -2, action: 'SELL' }, { strike: 7700, right: 'C', ratio: null }], day: '2026-10-12' })] });
  add('disconnectAll 之后:期货推算的退避与期货常驻流都清掉,重连后重新取、重新订', { start: NIGHT, factory: { paper: ['P', 'P2', 'P3'] }, sessions: [
    paper({ hist: { 'SPX|CBOE': [{ error: 'no permission' }], 'ES|CME': nightHist()['ES|CME'] }, initial: { [idxKey]: { last: 7640 } } }),
    paper({ name: 'P2', hist: nightHist(), initial: { [futKey]: { last: 7702.5 }, [idxKey]: { last: 7640 } } }),
    paper({ name: 'P3', hist: nightHist(), initial: { [futKey]: { last: 7710.5 }, [idxKey]: { last: 7640 } } })],
  steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, call('disconnectAll'), call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' },
    call('disconnectAll'), call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('optionChain:现价恰好 1(低价股)照常取链', { sessions: [paper({ secDef: [{ params: [{ exchange: 'SMART', tradingClass: 'PENNY', expirations: ['20261016'], strikes: [0.5, 1, 1.5, 2, 2.5] }] }], initial: { [stockKey('PENNY')]: { last: 1 }, ...Object.fromEntries([0.5, 1, 1.5, 2, 2.5].flatMap((k) => ['C', 'P'].map((r) => [mods.tickerKey(C.optionContract('PENNY', '20261016', k, r, 'SMART', 'USD', '100', 'PENNY'), '100,101,106'), { bid: 0.1, ask: 0.2 }]))) } })],
    steps: [call('optionChain', { symbol: 'PENNY', expiry: '20261016', width: 3 })] });
  addC('orderBook:中间价恰好 1 时点差 bps 照算(中间价为 0 的分支够不到:买卖价都清洗成正数)', { sessions: [paper({ initial: { [stockKey('AAA')]: { bid: 0.9, ask: 1.1, bidSize: 1, askSize: 1 } } })], steps: [call('orderBook', { symbol: 'AAA' })] });
  const legInit2 = (strike, over) => ({ [optKey(strike, 'C')]: over });
  add('腿报价:只有一边盘口(只有买价 / 只有卖价)也算缺盘口——随后的行情类错误码照样翻译;盘口被拒的腿原文带出', { sessions: [paper({ errorOnSettle: [{ n: 1, code: 101, msg: 'Max tickers' }], initial: { ...legInit2(7520, { bid: 12.4 }), ...legInit2(7550, { bid: 4.0, ask: 4.2 }) } }),
      paper({ name: 'P2', errorOnSettle: [{ n: 1, code: 10197, msg: 'competing' }], initial: { ...legInit2(7520, { ask: 12.8 }), ...legInit2(7550, { bid: 4.0, ask: 4.2 }) } }), paper({ name: 'P3', initial: { ...legInit2(7520, { bid: 12.4, ask: 12.8 }), ...legInit2(7550, { error: '354 not subscribed' }) } })], factory: { paper: ['P', 'P2', 'P3'] },
    steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' }), { op: 'sess', session: 'P', set: { connected: false } }, call('legQuotes', { contract: vertical('BUY'), account: '模拟' }), { op: 'sess', session: 'P2', set: { connected: false } }, call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
  for (const code of [101, 354, 10089, 10090, 10091, 10167, 10168, 10197, 2104, 200, 10166, 10169]) {
    add(`腿报价:等盘口期间收到错误码 ${code}(在表里的翻译、不在的忽略)`, { sessions: [paper({ errorOnSettle: [{ n: 2, code, msg: `msg ${code}` }] })], steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
  }
  // ---- 变异检验第一轮之后补上的
  addC('orderBook:买卖价相等(点差 0)照算;深度只有一边不写"未收到深度"', { sessions: [paper({ initial: { [stockKey('AAA')]: { bid: 5, ask: 5, bidSize: 1, askSize: 1 } }, depth: [{ bids: [{ price: 5, size: 9 }], asks: [] }, { bids: [], asks: [{ price: 5, size: 9 }] }] })], steps: [call('orderBook', { symbol: 'AAA' }), call('orderBook', { symbol: 'AAA' })] });
  addC('streamQuotes:昨收恰好 1 照算涨跌幅', { sessions: [paper({ initial: { [stockKey('AAA')]: { last: 1.5, close: 1 } } })], steps: [call('streamQuotes', { symbols: ['AAA'] })] });
  add('腿报价:第一条腿订阅被拒 → 当场重订那一条(撤、再订);买卖价恰好 1', { sessions: [paper({ initial: { ...legInit2(7520, { error: '10197 competing' }), ...legInit2(7550, { bid: 1, ask: 1.05 }) } }), paper({ name: 'P2', initial: { ...legInit2(7520, { bid: 1, ask: 1.05 }), ...legInit2(7550, { bid: 1, ask: 1 }) } })], factory: { paper: ['P', 'P2'] },
    steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' }), { op: 'sess', session: 'P', set: { connected: false } }, call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
  add('夜盘指数:退避恰好 60 秒时就重试(<=);期货流恰好 30 秒没价才摘(>)', { start: NIGHT, sessions: [paper({ hist: { 'SPX|CBOE': [{ error: 'no permission' }, { bars: nightHist()['SPX|CBOE'][0].bars }], 'ES|CME': nightHist()['ES|CME'] }, initial: { [idxKey]: { last: 7640 } } })],
    steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'advance', ms: 59999 }, call('indexPrice', { symbol: 'SPX' }), { op: 'advance', ms: 1 }, call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }, { op: 'advance', ms: 28250 }, call('indexPrice', { symbol: 'SPX' }), call('indexPrice', { symbol: 'SPX' }), { op: 'advance', ms: 29500 }, call('indexPrice', { symbol: 'SPX' }), call('indexPrice', { symbol: 'SPX' })] });
  for (const ty of [3, 1]) {
    addC(`行情类型切换抛(${ty}):try 里抛的原样冒出(finally 里抛的盖住它);切回也抛`, { start: NIGHT, sessions: [paper({ throwMdType: [ty], hist: nightHist(), secDef: [{ params: spxParams }], initial: { [idxKey]: { last: 7640 }, [futKey]: { last: 7702.5 }, [stockKey('AAA')]: { last: 5, close: 4 }, [stockKey('IREN')]: { last: 5, close: 4 }, [optKey(7520)]: { bid: 1, ask: 2 } }, portfolio: [{ items: [pf(stk('AAA'), 1)] }] })],
      steps: [call('indexPrice', { symbol: 'SPX' }), call('stockQuotes', { symbols: ['AAA'] }), call('orderBook', { symbol: 'AAA' }), call('intradayBars', { symbol: 'AAA', timeframe: '5m', rth: true }), call('comboBars', { symbol: 'SPX', legs: [{ strike: 7600, right: 'C' }], day: '2026-10-12' }),
        call('optionChain', { symbol: 'SPX', expiry: '20261016', width: 3 }), call('legQuotes', { contract: vertical('BUY'), account: '模拟' }), call('positions'), call('indexPrice', { symbol: 'AAA' })] });
  }
  add('基差缓存:读文件命中之后记在内存里,文件再变也不重读', { start: NIGHT, basisFile: JSON.stringify({ 'ES202612|2026-10-12': { basis: 50.5, time: 't1', index_close: 1, futures_close: 2, session: '2026-10-12' } }), sessions: [paper({ initial: { [futKey]: { last: 7702.5 } } })],
    steps: [call('connect', { name: 'paper' }), call('indexPrice', { symbol: 'SPX' }), { op: 'file', content: JSON.stringify({ 'ES202612|2026-10-12': { basis: 99, time: 't2' } }) }, call('indexPrice', { symbol: 'SPX' }), { op: 'get', what: 'spotInfo', symbol: 'SPX' }] });
  addC('optionExpiries:同一交易类多条记录——到期日去重排序、行权价去重(含 NaN / −0)排序', { sessions: [paper({ secDef: [{ params: [{ exchange: 'CBOE', tradingClass: 'SPXW', expirations: ['20261023', '20261016', '20261016'], strikes: [7550, 7500, 7500, '__NaN__', 0, '__neg0__'] }, { exchange: 'CBOE', tradingClass: 'SPXW', expirations: ['20261013', '20261023'], strikes: ['__NaN__', 7525, 7550, 1e-7] }, { exchange: 'CBOE', tradingClass: 'SPX', expirations: ['20261120', '20261120'], strikes: [7525, 7525] }] }] })], steps: [call('optionExpiries', { symbol: 'SPX' })] });
  addC('historicalBars:K 线时间带时分——按日切(取前 10 位)', { sessions: [paper({ hist: { 'AAPL|SMART': [{ bars: [rawBar('20251230 16:00:00 US/Eastern', 10), rawBar('20251231 09:30:00 US/Eastern', 11), rawBar('20260101 09:30:00 US/Eastern', 12)] }] } })], steps: [call('historicalBars', { symbol: 'AAPL', start: '2025-12-30', end: '2025-12-31' })] });
  addC('intradayBars:连着两次(盘中):日盘每次重取、夜盘那份留着——要靠此刻(nowMs)判断', { sessions: [paper({ hist: iren() })], steps: [call('intradayBars', { symbol: 'IREN', timeframe: '15m' }), call('intradayBars', { symbol: 'IREN', timeframe: '15m' })] });
  add('腿报价:盘口齐了但价低于 1(买 0.5 / 卖 0.75;买 1 / 卖 1)——顺带收到 101 也不拒', { sessions: [paper({ errorOnSettle: [{ n: 1, code: 101, msg: 'x' }], initial: { ...legInit2(7520, { bid: 0.5, ask: 0.75 }), ...legInit2(7550, { bid: 1, ask: 1 }) } })], steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
  // ---- 验收补的两处
  add('路由:一条 IBKR 连接都没有(连接都归别的券商)——所有走账户的入口报同一句,什么都不发、不连', { settings: { connections: { paper: { host: '127.0.0.1', port: 7497, client_id: 11, broker: 'futu' }, live: { host: '127.0.0.1', port: 7496, client_id: 12, broker: 'futu' } }, broker: { provider: 'futu' } }, sessions: [paper(), live()],
    steps: [call('forAccount', { account: '模拟' }), call('forAccount', { account: '主账户' }), placeStock('r1'), placeStock('r2', {}, '主账户'), call('qualify', { contract: stockSpec(), account: '模拟' }),
      call('legQuotes', { contract: vertical('BUY'), account: '模拟' }), call('placeHosted', { account: '模拟', contract: stockSpec(), item: hostedItem(), oca: 'o', ref: 'trk:1:tp' }), call('connect', { name: 'paper' }), { op: 'get', what: 'connections' }, { op: 'get', what: 'sessions' }] });
  const legCases = [['只有买价', { bid: 4 }], ['只有卖价', { ask: 5 }], ['买价 0 卖价有', { bid: 0, ask: 5 }], ['倒挂 买 5 卖 4', { bid: 5, ask: 4 }], ['买价负数', { bid: -1, ask: 5 }], ['卖价 0 买价有', { bid: 4, ask: 0 }], ['齐全', { bid: 4, ask: 5 }], ['齐全但低价 0.5/0.75', { bid: 0.5, ask: 0.75 }], ['买价恰好 1', { bid: 1, ask: 2 }], ['卖价恰好 1', { bid: 0.5, ask: 1 }]];
  for (const [label, q] of legCases) {
    for (const [what, extra2] of [['收到 101', { errorOnSettle: [{ n: 1, code: 101, msg: 'tickers' }] }], ['收到 10197', { errorOnSettle: [{ n: 2, code: 10197, msg: 'competing' }] }]]) {
      add(`腿报价:一条腿${label},${what}`, { sessions: [paper({ ...extra2, initial: { ...legInit2(7520, q), ...legInit2(7550, { bid: 4, ask: 4.2 }) } })], steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
    }
    add(`腿报价:一条腿${label}且订阅被拒(带原文)`, { sessions: [paper({ initial: { ...legInit2(7520, { ...q, error: '354 not subscribed' }), ...legInit2(7550, { bid: 4, ask: 4.2 }) } })], steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
    add(`腿报价:另一条腿${label}且被拒(第二条腿)`, { sessions: [paper({ initial: { ...legInit2(7520, { bid: 4, ask: 4.2 }), ...legInit2(7550, { ...q, error: '10197 competing' }) } })], steps: [call('legQuotes', { contract: vertical('BUY'), account: '模拟' })] });
  }
  return out;
}
