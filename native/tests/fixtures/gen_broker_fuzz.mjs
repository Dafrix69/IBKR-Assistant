// 生成 broker_fuzz_*.json:种子固定的随机脚本——随机的会话脚本(确认 / 下单 / 撤单 / 持仓 / 成交的各种结果与延迟)、随机的盘口补丁事件、
// 随机的调用序列(阻塞的与不等结果的并发着,穿插钟的推进、连接的通断、上游码、托管单的挂改撤认领),交给原 TS 的 BrokerRouter 现跑。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_broker_fuzz.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadBroker, rng, runScenario } from './broker_world.mjs';
import { A_LIVE, A_LIVE2, A_PAPER, builders } from './broker_scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadBroker(engine);
const B = builders(mods);
const C = mods.contracts;
const FILES = Number(process.env.FILES ?? 3), PER = Number(process.env.PER ?? 45);

function genScenario(seed) {
  const r = rng(seed);
  const { stockSpec, optSpec, vertical, butterfly, ord, parsed, trig, approved, hostedItem, sess, call, rawBar, ALLCAPS } = B;
  const stockKey = (sym, g = '') => mods.tickerKey(C.stockContract(sym), g);
  const optKey = (strike, right = 'C', g = '') => mods.tickerKey(C.optionContract('SPX', '20261016', strike, right, 'SMART', 'USD', '100', 'SPXW'), g);
  const idxKey = mods.tickerKey(C.indexContract('SPX', 'CBOE'));
  const start = r.pick([B.RTH, B.RTH, B.NIGHT, B.WEEKEND, B.et('2026-10-12', '17:30'), B.et('2026-10-12', '08:00')]);
  const syms = ['AAA', 'BBB', 'SPY', 'AAPL'];
  const strikes = [7500, 7520, 7525, 7550];
  const patchOf = () => {
    const p = {};
    const f = r.int(6);
    if (f === 0) p.last = r.pick([10, 11.5, 0, null, '__NaN__']);
    else if (f === 1) { p.bid = r.pick([1, 0, -1, '__NaN__', 12.4]); p.ask = r.pick([1.2, 0.05, 13, '__NaN__', 0]); }
    else if (f === 2) p.close = r.pick([9, null, 0]);
    else if (f === 3) p.iv = r.pick([0.2, null, 0]);
    else if (f === 4) p.error = r.pick(['10197 competing', '354 no sub', '']);
    else p.marketPrice = r.pick([5, null]);
    return p;
  };
  const keys = [...syms.map((s) => stockKey(s)), ...syms.map((s) => stockKey(s, '165,104,595')), idxKey, ...strikes.flatMap((k) => [optKey(k, 'C'), optKey(k, 'P')])];
  const initial = {};
  for (const k of keys) if (r.chance(0.5)) initial[k] = { ...patchOf(), ...(r.chance(0.5) ? patchOf() : {}) };
  const seqOf = (mk, n) => Array.from({ length: n }, mk);
  const sessionFor = (name, accounts) => sess(name, {
    accounts, caps: r.shuffle(ALLCAPS).slice(0, 4 + r.int(4)), times: r.chance(0.6), initial,
    qualify: seqOf(() => r.pick([{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }, { kind: 'ok', delay: 300 }, { kind: 'timeout' }, { kind: 'error', message: 'qboom' }, { kind: 'ok', conIds: [null] }, { kind: 'timeoutName' }]), 1 + r.int(5)),
    unknown: r.chance(0.15) ? [r.pick(syms)] : [],
    place: seqOf(() => r.pick([{}, {}, {}, { delay: 200 }, { linkDown: true }, { error: 'rej' }, { orderId: 0, permId: null, status: '' }]), 1 + r.int(4)),
    cancel: seqOf(() => r.pick([{}, {}, { linkDown: true }, { error: 'cx' }]), 1 + r.int(3)),
    openTrades: r.chance(0.5) ? [{ orderId: 7 }, { orderId: 8, throws: r.chance(0.3) }] : [],
    detailed: r.chance(0.6) ? [{ orderId: 301, permId: 7001, orderRef: 'trk:9:tp', account: accounts[0] ?? A_PAPER, action: 'SELL', orderType: 'LMT', totalQuantity: 100, lmtPrice: -12.35, auxPrice: null, trailingPercent: null, status: 'Submitted',
      contract: r.pick([{ secType: 'STK', symbol: 'AAPL', exchange: 'SMART', currency: 'USD', conId: 265598 }, { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD' }]), ocaGroup: r.pick(['oca-9', null]), ocaType: r.pick([1, 2, null]), tif: r.pick(['GTC', '']), outsideRth: r.chance(0.5) }] : [],
    portfolio: seqOf(() => r.pick([{ items: [{ contract: { symbol: r.pick(syms), secType: 'STK' }, position: r.pick([1, -3, 0, 10]), averageCost: 50, marketPrice: r.pick([12, '__NaN__']), marketValue: 100, unrealizedPnL: 5, account: accounts[0] ?? A_PAPER }, { contract: { symbol: 'SPX', secType: 'OPT', lastTradeDateOrContractMonth: '20261016', strike: r.pick(strikes), right: r.pick(['C', 'P']), multiplier: '100', tradingClass: 'SPXW' }, position: r.pick([1, -2]), averageCost: 800, marketPrice: '__NaN__', marketValue: '__NaN__', unrealizedPnL: 0, account: accounts[0] ?? A_PAPER }] }, { items: [] }, { error: 'pushstuck' }]), 1 + r.int(3)),
    positions: seqOf(() => r.pick([{ items: [{ contract: { symbol: r.pick(syms), secType: 'STK' }, position: 4, avgCost: 11, account: accounts[0] ?? A_PAPER }] }, { items: [] }, { error: 'posboom' }, { items: [{ contract: { symbol: 'ZZZ', secType: 'STK' }, position: 1, avgCost: 1, account: 'U0000000' }] }]), 1 + r.int(3)),
    executions: [{ rows: [{ contract: { secType: 'OPT', symbol: 'SPX', strike: 7500, right: 'C', conId: 5 }, execution: { execId: 'e1', time: '20261012  09:35:00', acctNumber: accounts[0] ?? A_PAPER, side: 'BOT', shares: 1, price: 3.2, orderId: 5, permId: 6, orderRef: 'r', commission: 0.65 } }] }],
    hours: [{ ok: r.pick([['t', 'l', 'US/Eastern'], null]) }],
    secDef: [{ params: [{ exchange: 'CBOE', tradingClass: 'SPXW', expirations: ['20261013', '20261016'], strikes: strikes }, { exchange: 'CBOE', tradingClass: 'SPX', expirations: ['20261016'], strikes: [7500, 7550] }] }],
    depth: [{ bids: [{ price: 99, size: 10 }], asks: [{ price: 100, size: 5 }] }, { error: 'nodepth' }],
    hist: { 'AAPL|SMART': [{ bars: [rawBar('20261008', 190), rawBar('20261009', 191)] }, { error: 'nohist' }], 'IREN|SMART': [{ bars: [rawBar('20261009 19:30:00 US/Eastern', 1)] }],
      'SPX|CBOE': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7640)] }], 'ES|CME': [{ bars: [rawBar('20261012 15:59:00 US/Eastern', 7690)] }] },
    errorOnSettle: r.chance(0.2) ? [{ n: 1 + r.int(4), code: r.pick([101, 10197, 2104]), msg: 'md err' }] : [],
    throwCancel: r.chance(0.05), throwMdType: r.chance(0.05) ? [1] : [],
  });
  const sessions = [sessionFor('P', r.chance(0.9) ? [A_PAPER] : [A_LIVE]), sessionFor('L', r.chance(0.9) ? [A_LIVE, A_LIVE2] : []), sessionFor('P2', [A_PAPER])];
  const factory = { paper: r.pick([['P'], ['P', 'P2'], [{ error: 'refused' }, 'P'], ['P', 'P2', 'P']]), live: r.pick([['L'], [{ error: 'refused2', delay: 400 }, 'L'], ['L']]) };
  const events = Array.from({ length: r.int(6) }, () => ({ at: r.int(30000), session: r.pick(['P', 'L']), key: r.pick(keys), patch: patchOf() }));
  const acct = () => r.pick(['模拟', '模拟', '主账户', '副账户']);
  const sym = () => r.pick(syms);
  const hid = () => r.pick([101, 102, 103, 301, 999]);
  const ops = [
    () => call('connect', { name: r.pick(['paper', 'live', 'paper', 'nope']) }),
    () => call('forAccount', { account: acct() }),
    () => call('qualify', { contract: r.pick([stockSpec(sym()), optSpec('SPX', '20261016', r.pick(strikes), 'C', 'SPXW'), vertical('BUY'), butterfly()]), account: acct() }),
    () => call('legQuotes', { contract: r.pick([vertical('BUY'), vertical('SELL', [7520, 7525]), butterfly()]), account: acct() }),
    () => call('place', { recordId: `r${r.int(1000)}`, approved: approved(parsed(r.pick([stockSpec(sym()), vertical(r.pick(['BUY', 'SELL'])), butterfly()]), ord({ orderType: r.pick(['LMT', 'LMT', 'MKT']), lmtPrice: r.pick([230, null, 12.5]), action: r.pick(['BUY', 'SELL']), price_mode: r.pick(['EXPLICIT', 'AUTO_MID']), tif: r.pick(['DAY', 'GTC']), outsideRth: r.chance(0.3) }), r.chance(0.3) ? trig(r.pick([{}, { symbol: 'AAPL', secType: 'STK' }])) : null), acct()), ...(r.chance(0.4) ? { limitOverride: r.pick([7.5, -3.25, '__NaN__']) } : {}) }),
    () => call('placeHosted', { account: acct(), contract: r.pick([stockSpec(sym()), vertical('BUY')]), item: hostedItem({ action: r.pick(['SELL', 'BUY']), lmt_price: r.pick([250, 12.35, null]), ...(r.chance(0.3) ? { order_type: 'TRAIL', lmt_price: null, trailing_percent: 3, trail_stop_seed: r.pick([null, 241.5]) } : {}) }), oca: `oca-${r.int(9)}`, ref: `trk:${r.int(9)}:tp` }),
    () => call('modifyHosted', { orderId: hid(), item: hostedItem({ lmt_price: r.pick([251, 252.5, null]), quantity: r.pick([100, 50]), action: r.pick(['SELL', 'BUY']) }) }),
    () => call('cancelHosted', { orderId: hid() }),
    () => call('listHostedOpen', r.chance(0.3) ? { prefix: r.pick(['', 'trk:', 'x']) } : {}),
    () => call('listOpenOrdersDetailed'),
    () => call('cancelAllOpen'),
    () => call('positions'),
    () => call('optionQuotes', { rows: [B.optRow(r.pick(strikes)), B.optRow(r.pick(strikes), '主账户', 'P')] }),
    () => call('indexPrice', { symbol: r.pick(['SPX', 'AAPL', 'SPX']) }),
    () => call('stockQuotes', { symbols: [sym(), sym()] }),
    () => call('streamQuotes', { symbols: [sym(), r.pick(['SPY', 'CRYPTO:BTC', 'ZZ'])] }),
    () => call('volumeQuotes', { symbols: [sym(), sym()] }),
    () => call('releaseVolumeStreams', { keep: r.chance(0.5) ? [sym()] : [] }),
    () => call('orderBook', { symbol: r.pick([sym(), 'SPX']) }),
    () => call('historicalBars', { symbol: sym(), start: '2026-10-07', end: '2026-10-12' }),
    () => call('intradayBars', { symbol: r.pick(['IREN', 'SPX']), timeframe: r.pick(['5m', '1d', '15m']), rth: r.chance(0.3), indexProxy: r.chance(0.4) }),
    () => call('optionExpiries', { symbol: 'SPX' }),
    () => call('optionChain', { symbol: 'SPX', expiry: r.pick(['20261016', null, '20261013']), width: r.pick([3, 5]), span: r.pick([null, 30]) }),
    () => call('executions'),
    () => call('contractHours', { row: { sec_type: 'OPT', symbol: 'SPX', contract: { lastTradeDateOrContractMonth: '20261016', strike: 7520, right: 'C' } }, account: acct() }),
    () => ({ op: 'sess', session: r.pick(['P', 'L']), set: { connected: r.chance(0.5) } }),
    () => ({ op: 'emitConnectivity', session: r.pick(['P', 'L']), code: r.pick([1100, 1102, 2110, 2104]) }),
    () => ({ op: 'emitLink', session: r.pick(['P', 'L']), up: r.chance(0.5) }),
    () => ({ op: 'patch', session: r.pick(['P', 'L']), key: r.pick(keys), patch: patchOf() }),
    () => ({ op: 'hooks', link: r.chance(0.5), session: r.chance(0.5), sessionThrows: r.chance(0.2) }),
    () => ({ op: 'warm' }),
    () => call('disconnectAll'),
  ];
  const steps = [{ op: 'hooks', link: true, session: true }];
  const pending = [];
  const n = 18 + r.int(24);
  for (let i = 0; i < n; i += 1) {
    const roll = r.next();
    if (roll < 0.12) steps.push({ op: 'advance', ms: r.pick([100, 250, 1500, 5000, 31000, 61000]) });
    else if (roll < 0.2 && pending.length) steps.push({ op: 'await', id: pending.splice(r.int(pending.length), 1)[0] });
    else {
      const s = r.pick(ops)();
      if (s.op === 'call' && r.chance(0.3)) { s.start = true; s.id = `c${i}`; pending.push(s.id); }
      steps.push(s);
    }
  }
  for (const id of pending) steps.push({ op: 'await', id });
  steps.push({ op: 'advance', ms: 70000 }, { op: 'readFile' });
  return { name: `fuzz-${seed}`, script: { start, settings: {}, factory, sessions, events, steps } };
}

let seed = Number(process.env.SEED0 ?? 1000);
for (let f = 1; f <= FILES; f += 1) {
  const list = [];
  for (let i = 0; i < PER; i += 1) {
    const s = genScenario(seed);
    seed += 1;
    list.push({ name: s.name, script: enc(s.script), expected: enc(await runScenario(s.script, mods)) });
  }
  const text = JSON.stringify({ base: BASE_CONFIG, scenarios: list });
  writeFileSync(join(here, `broker_fuzz_${f}.json`), text);
  console.log(`broker_fuzz_${f}.json:${list.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
}
