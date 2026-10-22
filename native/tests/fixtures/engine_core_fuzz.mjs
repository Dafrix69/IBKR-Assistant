// engine_core 簇的随机脚本:种子固定,生成"指令 / 条件单 / 盯盘 / 回报 / 熔断 / 睡眠"交错的脚本,交给原 TS 的 TradingEngine 现跑(见 gen_engine_core_fuzz.mjs)。
// 虚拟钟上的交错:place / positions / modifyHosted 带 delay 时,下一步在它没完成时就开始,两边的完成次序由计时器决定,逐项比较。
import { MIN, T0, baseRouter, condOrder, flyOrder, llm, optOrder, stockOrder, stk, trade, trk } from './engine_core_scenarios.mjs';

const SYMS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD'];
const optRow = (strike, qty, price) => ({
  key: `模拟|SPX|OPT|L${strike}`, account: '模拟', symbol: 'SPX', sec_type: 'OPT', leg: `L${strike}`, quantity: qty, avg_cost: 300, multiplier: 100, currency: 'USD',
  market_price: price, market_value: price * 100 * qty, unrealized_pnl: 0,
  contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: '20260911', strike, right: 'C', multiplier: '100', tradingClass: 'SPXW' },
});
const FLY_LEG = '20260911|+1x7500C,-2x7515C,+1x7530C';
const FLY_CONTRACT = {
  secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', multiplier: '100', combo_strategy: 'BUTTERFLY', label: '买入看涨蝴蝶 7500/7515/7530',
  legs: [7500, 7515, 7530].map((k, i) => ({ lastTradeDateOrContractMonth: '20260911', strike: k, right: 'C', ratio: [1, -2, 1][i] })),
};
const SAT = Date.UTC(2026, 8, 12, 16, 0, 0);

function genOrder(r) {
  const k = r.int(10);
  const sym = r.pick(SYMS);
  if (k < 5) return stockOrder({ intent_summary: `${sym} ${k}`, account: r.chance(0.2) ? r.pick(['主账户', '副账户', '模拟']) : 'DEFAULT', confidence: r.chance(0.1) ? 0.5 : 0.99 },
    { action: r.pick(['BUY', 'SELL']), totalQuantity: r.pick([10, 100, 400, 6000]), lmtPrice: r.pick([100, 230.5, 231]) }, { symbol: sym });
  if (k < 7) return flyOrder({ intent_summary: `蝶 ${k}` }, { totalQuantity: r.pick([1, 2]) });
  if (k < 9) return condOrder({ intent_summary: `条件 ${k}` }, { totalQuantity: r.pick([1, 3]) }, { value: r.pick([7500, 7505, 7512]) });
  return optOrder({ intent_summary: `期权 ${k}` }, { totalQuantity: r.pick([1, 2]), lmtPrice: r.pick([3.2, 3.25]) });
}
function genParse(r) {
  const k = r.int(20);
  if (k === 0) return { error: { cls: 'LLM', msg: '模型挂了' } };
  if (k === 1) return { text: '不是 JSON' };
  if (k === 2) return { error: { cls: 'Error', msg: '非 LLM 错' } };
  const orders = Array.from({ length: 1 + r.int(4) }, () => genOrder(r));
  const rej = r.chance(0.15) ? [{ code: 'UNCLEAR', message: '看不懂', original_text: '??' }] : [];
  return llm(orders, rej);
}
const trade_ = (id, status, filled = 0) => trade(id, status, { orderStatus: { status, filled, remaining: 1 - filled }, contract: { symbol: 'SPX' } });

export function genCore(r, tag) {
  const setup = [];
  const steps = [];
  const settings = {
    policies: { auto_execute: r.chance(0.8), allow_live_trading: r.chance(0.5), consecutive_failure_breaker: r.pick([2, 3, 5]) },
    limits: { auto_mid_spread_share: r.chance(0.5) ? 0.5 : 0, max_orders_per_input: r.pick([2, 5]) },
    protections: r.chance(0.5) ? { stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: r.pick([1, 2]), pause_minutes: 30 }, cooldown: { enabled: r.chance(0.5), minutes: 20, scope: r.pick(['symbol', 'position']) } } : {},
  };
  const rows = [stk('NVDA', { market_price: 220 }), optRow(7500, 1, 6), optRow(7515, -2, 12), optRow(7530, 1, 5), optRow(7500, 1, 6)].slice(0, 4);
  const tracks = [];
  if (r.chance(0.7)) tracks.push({ op: 'track', name: 'S', spec: { account: '模拟', symbol: 'NVDA', sec_type: 'STK', contract: { secType: 'STK', symbol: 'NVDA', exchange: 'SMART', currency: 'USD' }, targets: { take_profit: r.pick([230, 250]), stop_loss: r.pick([200, 160]) }, auto_close: { enabled: true, host_at_broker: r.chance(0.3) }, peak: 220 } });
  if (r.chance(0.7)) tracks.push({ op: 'track', name: 'O', spec: { account: '模拟', symbol: 'SPX', sec_type: 'OPT', leg: 'L7500', contract: optRow(7500, 1, 1).contract, targets: { take_profit: r.pick([5, 7]), stop_loss: r.pick([null, 3]), spot_stop_below: r.chance(0.3) ? 7490 : null, spot_stop_confirm_s: r.chance(0.5) ? 4 : null }, auto_close: { enabled: true, host_at_broker: false, order_type: r.pick(['LMT', 'MKT']) }, peak: 6 } });
  if (r.chance(0.5)) tracks.push({ op: 'track', name: 'F', spec: { account: '模拟', symbol: 'SPX', sec_type: 'BAG', leg: FLY_LEG, contract: FLY_CONTRACT, targets: { take_profit: r.pick([4, 8]), spot_target: r.chance(0.4) ? 7520 : null }, auto_close: { enabled: true, host_at_broker: r.chance(0.2), order_type: 'LMT', stop_basis: r.pick(['mid', 'natural']) }, peak: 5 } });
  setup.push(...tracks);
  const nInstr = 3 + r.int(4);
  const parseList = Array.from({ length: nInstr }, () => genParse(r));
  const behaviors = {
    place: Array.from({ length: 6 }, () => (r.chance(0.2) ? { error: { cls: r.pick(['Broker', 'Error', 'LinkDown']), msg: '发单炸了' } } : r.chance(0.15) ? { delay: r.pick([300, 1500]) } : {})),
    modifyHosted: Array.from({ length: 6 }, () => (r.chance(0.2) ? { error: { cls: r.pick(['Error', 'LinkDown']), msg: '改单炸了' } } : r.chance(0.15) ? { ret: false } : {})),
    positions: Array.from({ length: 4 }, () => (r.chance(0.15) ? { error: { cls: 'Error', msg: '读不到' } } : r.chance(0.2) ? { delay: r.pick([400, 1200]) } : {})),
    placeHosted: [{ repeat: true }],
  };
  const router = baseRouter({
    rows, behaviors, optionQuotes: { '模拟|SPX|OPT|L7500': { bid: 5.9, ask: 6.3 }, '模拟|SPX|OPT|L7515': { bid: 12.2, ask: 12.8 }, '模拟|SPX|OPT|L7530': { bid: 4.9, ask: 5.3 } },
    stream: { NVDA: { last: 221 }, SPX: { last: 7510 } }, spotInfo: {}, perm: r.chance(0.5), cancelCount: r.int(4),
  }, { poll: false });
  const hostedTrackPresent = tracks.some((t) => t.spec.auto_close.host_at_broker);
  let instrLeft = nInstr;
  const nSteps = 14 + r.int(16);
  for (let i = 0; i < nSteps; i += 1) {
    const k = r.int(100);
    if (k < 24 && instrLeft > 0) {
      instrLeft -= 1;
      steps.push({ op: 'instruction', text: r.pick(['买入 AAPL 100股', '买蝶 SPX', '1.8 挂15蝴蝶 15CM', '卖出 NVDA']), accounts: r.chance(0.3) ? r.pick([['模拟'], ['模拟', '主账户'], ['主账户']]) : undefined, dryRun: r.chance(0.1), localOnly: r.chance(0.08), snap: { SPX: 7512.4 } });
    } else if (k < 30) steps.push({ op: 'fire', prices: { SPX: r.pick([7500, 7504, 7510, 7520]) } });
    else if (k < 44) steps.push({ op: 'tick' });
    else if (k < 52) steps.push({ op: 'poll', atMs: r.chance(0.1) ? SAT : undefined });
    else if (k < 60) {
      const idx = r.int(rows.length);
      steps.push({ op: 'row', index: idx, patch: { market_price: idx === 0 ? r.pick([190, 215, 225, 235, 255]) : r.pick([2, 4, 6, 8, 12]) } });
    } else if (k < 66) steps.push({ op: 'status', trade: trade_(501 + r.int(8), r.pick(['Submitted', 'Filled', 'Cancelled', 'Inactive', 'PreSubmitted']), r.int(2)) });
    else if (k < 68) steps.push({ op: 'error', reqId: 501 + r.int(8), code: r.pick([110, 201, 10311, 202]), message: '券商错误' });
    else if (k < 82) steps.push({ op: 'advance', ms: r.pick([100, 900, 1000, 2500, 20_000, 65_000]) });
    else if (k < 85) steps.push({ op: 'breaker', action: r.pick(['engage', 'engageAuto', 'release', 'fail', 'ok']), kind: r.pick(['broker', 'parse']) });
    else if (k < 88) steps.push({ op: 'settings', patch: { policies: { auto_execute: r.chance(0.7), allow_live_trading: r.chance(0.5) } } });
    else if (k < 89) steps.push({ op: 'halt', reason: '随机熔断' });
    else if (k < 91) steps.push({ op: 'expire', atMs: r.chance(0.5) ? T0 + 11 * 60 * MIN : undefined });
    else if (k < 93 && tracks.length) steps.push({ op: 'sweep', track: r.pick(tracks).name, reason: '随机手动' });
    else if (k < 95) steps.push({ op: 'sleep', ms: r.pick([40_000, 600_000]) });
    else if (k < 97) steps.push({ op: 'audit', actor: 'engine', action: 'auto_close', detail: { track: 'x', symbol: r.pick(SYMS), leg: '', state: r.pick(['stop_loss', 'take_profit']), record: 'r', mark: 1 } });
    else if (k < 98 && hostedTrackPresent) steps.push({ op: 'sync' });
    else if (k < 99) steps.push({ op: r.pick(['startLoop', 'stopLoop']) });
    else steps.push({ op: 'protection' });
  }
  steps.push({ op: 'stopLoop' }, { op: 'advance', ms: 70_000 });
  return { name: `core_fuzz_${tag}`, script: { start: T0, settings, router, parser: { behaviors: { parse: parseList } }, setup, steps } };
}
