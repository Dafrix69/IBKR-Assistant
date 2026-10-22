// broker 簇(BrokerRouter)对拍用的"世界"的 JS 一半:脚本驱动的假 IbSession、虚拟的钟、按时刻排的计时器、一台假的会话工厂,
// 以及把一份脚本交给**原 TS 的 BrokerRouter**(engine-ts/dist/src/broker.js)现跑、把会话上被调用的每一次(方法、参数、虚拟时刻、先后次序)
// 与各步的结果记下来的跑法。C++ 那边(tests/broker_world.h)读同一份脚本、解释得一模一样、逐项精确比较。
// 改这个文件就要同时改 broker_world.h。从 execsupport_world.mjs 分叉而来(那份的 World / FakeSession 不导出,也没有下单、持仓这些方法)。
//
// ---- 约定(两边都靠它们对得上)
//  · 假会话**返回**的东西(portfolio / positions / executions / openTradesDetailed / placeOrder 的结果 / 期权链的行)一律写全、缺值写 null,
//    不缺键:C++ 的 optional 分不清 undefined 与 null,而 JSON 里 undefined 的键会消失。
//  · 时间:Date.now() 是虚拟钟;只有 advance 步与 runToDone 让它走。会话的 settle(ms) 与带 delay 的结果都是**计时器上的等待**,
//    钟走到那一刻才继续——所以并发的调用在计时器的节拍上交错,每次只醒一个、跑到下一个阻塞点(同真的 Node:一个计时器一个宏任务,微任务排空)。
//  · 日志 {t, s, m, a}:t 虚拟时刻、s 会话名(或 null)、m 方法、a 参数(enc 过)。读句柄(read)不记。订单意图按固定的键序与"有值才写"记(ORDER_KEYS),
//    合约按 CONTRACT_KEYS(+ comboLegs / includeExpired)。
//
// ---- 脚本(scenario)
//  { name, start, settings: <深合并到基础配置上的补丁>, basisFile?: <index_basis.json 的初始文本>, factory: {连接名: [会话名 | {error, delay?} …]},
//    sessions: [会话脚本…], events: [{at, session, key, patch}…], steps: […] }
//  会话脚本:{ name, caps: ["ContractHours","SetBaselineMarketDataType","QuoteDelayed","OpenTradesDetailed","Executions","OnLink","OnError"],
//    connected, accounts, times, throwCancel, throwBaseline, throwMdType:[类型…], throwDisconnect, disconnectDelay,
//    rewrite:{exchange?, tradingClass?}(确认成功后写回合约), qualify:[{kind:"ok"|"timeout"|"timeoutName"|"error"|"hang", conIds?, message?, delay?}…](用完重复最后一个), unknown:[symbol…](确认了也不给 conId),
//    hist:{"标的|交易所":[{bars|error, delay?}…]}, secDef:[{params|error, delay?}…], depth:[{bids,asks}|{error}…], hours:[{ok:[a,b,c]|null}|{error}|{hang}…],
//    place:[{orderId,permId,status}|{linkDown}|{error}|{hang}…], cancel:[{}|{linkDown}|{error}…], openTrades:[{orderId, throws?}…], detailed:[交易…],
//    portfolio:[{items}|{error}|{hang}…], positions:[…同], executions:[{rows}|{error}…], errorOnSettle:[{n, code, msg}…], initial:{完整键:patch},
//    delayed:{ticker 键:true|false} }
//  patch:盘口字段的覆盖(bid ask last close bidSize askSize marketPrice open high low volume avgVolume histVol vol3m vol5m vol10m lastTradeAt
//    callOpenInterest putOpenInterest callVolume putVolume delayed quotedAt requestedAt error iv gamma);error 一出现,这条流像真会话一样从缓存里摘掉
//  步:{op:"call", m, a, id?, start?} | {op:"await", id} | {op:"advance", ms} | {op:"sess", session, set:{…覆盖会话脚本的键}} | {op:"patch", session, key, patch} |
//    {op:"emitConnectivity", session, code} | {op:"emitLink", session, up} | {op:"get", what, …} | {op:"hooks", link?, session?, sessionThrows?} |
//    {op:"warm"} | {op:"file", content} | {op:"readFile"} | {op:"drainBg"}
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NAN = Number.NaN;

export const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));
export const dec = (o) => {
  if (o === '__NaN__') return Number.NaN;
  if (o === '__Inf__') return Infinity;
  if (o === '__-Inf__') return -Infinity;
  if (o === '__neg0__') return -0;
  if (Array.isArray(o)) return o.map(dec);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dec(v)]));
  return o;
};

/** 种子固定的随机数(xorshift32) */
export function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  return { next, shuffle, pick: (a) => a[Math.floor(next() * a.length)], int: (n) => Math.floor(next() * n), chance: (p) => next() < p };
}

const CONTRACT_KEYS = ['secType', 'symbol', 'exchange', 'currency', 'lastTradeDateOrContractMonth', 'strike', 'right', 'multiplier', 'tradingClass', 'conId'];
/** 合约在日志里的样子:只留有值的键(null / undefined 不留),键序固定 */
export function norm(c) {
  const o = {};
  for (const k of CONTRACT_KEYS) if (c[k] !== undefined && c[k] !== null) o[k] = c[k];
  if (c.includeExpired) o.includeExpired = true;
  if (Array.isArray(c.comboLegs)) o.comboLegs = c.comboLegs.map((l) => ({ conId: l.conId, ratio: l.ratio, action: l.action, exchange: l.exchange }));
  return o;
}
const ORDER_KEYS = ['orderType', 'action', 'totalQuantity', 'lmtPrice', 'auxPrice', 'trailingPercent', 'tif', 'outsideRth', 'account', 'transmit',
  'orderRef', 'conditions', 'conditionsCancelOrder', 'ocaGroup', 'ocaType', 'trailStopPrice', 'orderId'];
const COND_KEYS = ['type', 'conId', 'exchange', 'isMore', 'price'];
/** 订单意图在日志里的样子:固定键序,undefined 不写(null 照写) */
export function canonOrder(order) {
  const o = {};
  for (const k of ORDER_KEYS) {
    let v = order[k];
    if (v === undefined) continue;
    if (k === 'conditions') v = v.map((c) => { const co = {}; for (const ck of COND_KEYS) if (c[ck] !== undefined) co[ck] = c[ck]; return co; });
    o[k] = v;
  }
  return o;
}

const NUM_FIELDS = ['bid', 'ask', 'last', 'close', 'bidSize', 'askSize', 'marketPrice', 'open', 'high', 'low', 'volume', 'avgVolume', 'histVol', 'vol3m',
  'vol5m', 'vol10m', 'lastTradeAt', 'callOpenInterest', 'putOpenInterest', 'callVolume', 'putVolume', 'quotedAt', 'requestedAt'];

export async function loadBroker(engineDir) {
  const imp = (f) => import(pathToFileURL(join(engineDir, `dist/src/${f}.js`)).href);
  const [broker, ibSession, ibLink, config, marketdata, tz, contracts] = await Promise.all(
    ['broker', 'ibSession', 'ibLink', 'config', 'marketdata', 'tz', 'ibContracts'].map(imp));
  return { broker, ibSession, ibLink, config, marketdata, tz, contracts, tickerKey: ibSession.tickerKey };
}

export const BASE_CONFIG = {
  prompt_version: 'v1.8.0',
  llm: { model: 'claude-opus-5', effort: 'high', temperature: null },
  limits: { max_order_notional: 50000, max_option_contracts: 10, max_mkt_shares: 200, min_confidence: 0.9, max_spread_slippage: 0.1, max_orders_per_input: 5, duplicate_window_minutes: 10, duplicate_qty_tolerance: 0.2 },
  policies: { auto_execute: false, allow_live_trading: false, require_trigger_price_verification: true, trigger_min_gap_bps: 5, closed_market_policy: 'reject_market_orders' },
  connections: { paper: { host: '127.0.0.1', port: 7497, client_id: 11 }, live: { host: '127.0.0.1', port: 7496, client_id: 12 } },
  accounts: [
    { alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true },
    { alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live' },
    { alias: '副账户', account_id: 'U7777777', is_paper: false, connection: 'live' },
  ],
  symbol_aliases: { 苹果: 'AAPL' },
  index_symbols: { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: 'SPX', futures: 'ES', futures_exchange: 'CME' },
    VIX: { exchange: 'CBOE', daily_trading_class: 'VIXW', monthly_trading_class: 'VIX' } },
  market_holidays: ['2026-09-07'],
  early_close_days: ['2026-11-27'],
};

export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? deepMerge(base[k], v) : v;
  return out;
}

/** 一个宏任务的间隔:让已经排好的微任务(Promise 的后续)都跑完 */
export const drain = () => new Promise((r) => setImmediate(r));

class World {
  constructor(script, mods, dir) {
    this.mods = mods;
    this.tickerKey = mods.tickerKey;
    this.T = script.start;
    this.log = [];
    this.timers = [];
    this.counter = 0;
    this.handleSeq = 0;
    this.sessions = new Map();
    this.factoryIdx = {};
    this.script = script;
    this.dir = dir;
    this.origNow = Date.now;
    this.origWrite = process.stderr.write;
    Date.now = () => this.T;
    // 暖机(warmIndexFutures)是 broker.ts 里唯一用全局 setTimeout 的地方:接到虚拟钟上
    this.origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => this.schedule(ms, fn);
    process.stderr.write = (chunk) => { this.rec(null, 'stderr', [String(chunk).replace(/\n$/, '')]); return true; };
    for (const cfg of script.sessions ?? []) this.sessions.set(cfg.name, new FakeSession(this, cfg));
    for (const e of script.events ?? []) this.schedule(script.start + e.at - this.T, () => this.sessions.get(e.session)?.applyPatch(e.key, e.patch));
  }

  restore() {
    Date.now = this.origNow;
    globalThis.setTimeout = this.origSetTimeout;
    process.stderr.write = this.origWrite;
  }

  rec(session, method, args) { this.log.push({ t: this.T, s: session, m: method, a: enc(args) }); }

  schedule(delay, fn) {
    const e = { at: this.T + delay, seq: this.counter++, fn };
    this.timers.push(e);
    return e;
  }
  sleep(delay) { return new Promise((r) => this.schedule(delay, r)); }

  /** 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发,排空微任务。没有计时器回 false */
  async stepOne(limit = Infinity) {
    let best = null;
    for (const e of this.timers) if (best === null || e.at < best.at || (e.at === best.at && e.seq < best.seq)) best = e;
    if (best === null || best.at > limit) return false;
    this.timers.splice(this.timers.indexOf(best), 1);
    this.T = Math.max(this.T, best.at);
    best.fn();
    await drain();
    return true;
  }
  async advance(ms) {
    const end = this.T + ms;
    while (await this.stepOne(end)) { /* 一个一个到点 */ }
    this.T = end;
  }
}

class FakeSession {
  constructor(world, cfg) {
    this.w = world;
    this.cfg = cfg;
    this.name = cfg.name;
    this.connected = cfg.connected ?? true;
    this.streams = new Map();
    this.connCbs = [];
    this.linkCbs = [];
    this.errCbs = [];
    this.counters = {};
    this.settleCount = 0;
    this.nextConId = 700000;
    this.nextOrderId = 100;
    const caps = new Set(cfg.caps ?? []);
    const w = world;
    const n = this.name;
    if (caps.has('ContractHours')) {
      this.contractHours = async (contract, timeoutMs) => {
        w.rec(n, 'contractHours', [norm(contract), timeoutMs]);
        const r = this.pick('hours', [{ ok: null }]);
        if (r.hang) await new Promise(() => {});
        if (r.delay) await w.sleep(r.delay);
        if (r.error !== undefined) throw new Error(r.error);
        return r.ok;
      };
    }
    if (caps.has('SetBaselineMarketDataType')) {
      this.setBaselineMarketDataType = (t) => { w.rec(n, 'setBaselineMarketDataType', [t]); if (this.cfg.throwBaseline) throw new Error('baseline boom'); };
    }
    if (caps.has('QuoteDelayed')) {
      this.quoteDelayed = (c) => { w.rec(n, 'quoteDelayed', [norm(c)]); const v = (this.cfg.delayed ?? {})[world.tickerKey(c)]; return v === undefined ? null : v; };
    }
    if (caps.has('OpenTradesDetailed')) {
      this.openTradesDetailed = async () => { w.rec(n, 'openTradesDetailed', []); return structuredClone(dec(this.cfg.detailed ?? [])); };
    }
    if (caps.has('Executions')) {
      this.executions = async () => {
        w.rec(n, 'executions', []);
        const r = this.pick('executions', [{ rows: [] }]);
        if (r.delay) await w.sleep(r.delay);
        if (r.error !== undefined) throw new Error(r.error);
        return structuredClone(dec(r.rows));
      };
    }
    if (caps.has('OnLink')) this.onLink = (cb) => { w.rec(n, 'onLink', []); this.linkCbs.push(cb); };
    if (caps.has('OnError')) {
      this.onError = (cb) => { w.rec(n, 'onError', []); this.errCbs.push(cb); };
      this.offError = (cb) => { w.rec(n, 'offError', []); this.errCbs = this.errCbs.filter((f) => f !== cb); };
    }
  }

  /** 按调用先后各取一个结果,用完重复最后一个 */
  pick(key, dflt) {
    const list = this.cfg[key] && this.cfg[key].length ? this.cfg[key] : dflt;
    const i = this.counters[key] ?? 0;
    this.counters[key] = i + 1;
    return list[Math.min(i, list.length - 1)];
  }

  applyPatch(key, patch) {
    const entry = this.streams.get(key);
    if (!entry) return;
    mergePatch(entry.data, patch);
    if (entry.data.error) this.streams.delete(key);
  }

  isConnected() { this.w.rec(this.name, 'isConnected', []); return this.connected; }
  async disconnect() {
    this.w.rec(this.name, 'disconnect', []);
    this.connected = false;
    if (this.cfg.disconnectDelay) await this.w.sleep(this.cfg.disconnectDelay);
    if (this.cfg.throwDisconnect) throw new Error('disconnect boom');
  }
  managedAccounts() { this.w.rec(this.name, 'managedAccounts', []); return [...(this.cfg.accounts ?? [])]; }
  onConnectivity(cb) { this.w.rec(this.name, 'onConnectivity', []); this.connCbs.push(cb); }
  reqMarketDataType(t) {
    this.w.rec(this.name, 'reqMarketDataType', [t]);
    if ((this.cfg.throwMdType ?? []).includes(t)) throw new Error('mdtype boom');
  }

  async qualifyContracts(contracts, timeoutMs) {
    const out = this.pick('qualify', [{ kind: 'ok' }]);
    this.w.rec(this.name, 'qualifyContracts', [contracts.map(norm), timeoutMs]);
    if (out.delay) await this.w.sleep(out.delay);
    this.w.rec(this.name, 'qualifyDone', [out.kind]);
    if (out.kind === 'hang') await new Promise(() => {});
    if (out.kind === 'ok') {
      contracts.forEach((c, i) => {
        if ((this.cfg.unknown ?? []).includes(c.symbol)) return;
        const v = out.conIds && out.conIds[i] !== undefined ? out.conIds[i] : this.nextConId++;
        if (v !== null) c.conId = v;
        // 真会话确认之后会把 exchange / tradingClass 写回调用方的合约(缓存键必须在确认之前算)
        if (this.cfg.rewrite?.exchange !== undefined) c.exchange = this.cfg.rewrite.exchange;
        if (this.cfg.rewrite?.tradingClass !== undefined) c.tradingClass = this.cfg.rewrite.tradingClass;
      });
      return;
    }
    if (out.kind === 'timeout') throw new Error('timeout');
    if (out.kind === 'timeoutName') throw Object.assign(new Error('qualify slow'), { name: 'TimeoutError' });
    throw new Error(out.message ?? 'qualify failed');
  }

  subscribeTicker(contract, generic) {
    this.w.rec(this.name, 'subscribeTicker', [norm(contract), generic ?? '']);
    const key = this.w.tickerKey(contract, generic ?? '');
    let entry = this.streams.get(key);
    if (!entry) {
      entry = { data: emptyData(this.cfg.times, this.w.T) };
      mergePatch(entry.data, (this.cfg.initial ?? {})[key] ?? {});
      if (!entry.data.error) this.streams.set(key, entry);
    }
    const e = entry;
    return {
      id: ++this.w.handleSeq,
      read: () => (this.streams.get(key) === e || e.data.error ? { ...e.data } : { ...emptyData(false, 0), error: '订阅已被撤销' }),
    };
  }

  cancelTicker(contract, generic) {
    this.w.rec(this.name, 'cancelTicker', [norm(contract), generic === undefined ? '*' : generic]);
    if (this.cfg.throwCancel) throw new Error('cancel boom');
    const base = this.w.tickerKey(contract);
    const keys = generic !== undefined ? [this.w.tickerKey(contract, generic)] : [...this.streams.keys()].filter((k) => k === base || k.startsWith(`${base}#`));
    for (const key of keys) this.streams.delete(key);
  }

  async settle(ms) {
    this.w.rec(this.name, 'settle', [ms]);
    await this.w.sleep(ms);
    this.settleCount += 1;
    for (const e of this.cfg.errorOnSettle ?? []) if (e.n === this.settleCount) for (const cb of [...this.errCbs]) cb(7, e.code, e.msg);
  }

  async historicalData(contract, opts) {
    this.w.rec(this.name, 'historicalData', [norm(contract), { endDateTime: opts.endDateTime, durationStr: opts.durationStr, barSizeSetting: opts.barSizeSetting, whatToShow: opts.whatToShow, useRTH: opts.useRTH }]);
    const k = `${contract.symbol}|${contract.exchange}`;
    const list = (this.cfg.hist ?? {})[k] ?? [{ error: `没有脚本:${k}` }];
    const i = this.counters[`hist:${k}`] ?? 0;
    this.counters[`hist:${k}`] = i + 1;
    const out = list[Math.min(i, list.length - 1)];
    if (out.delay) await this.w.sleep(out.delay);
    if (out.error !== undefined) throw new Error(out.error);
    return out.bars.map((b) => ({ ...dec(b) }));
  }

  async secDefOptParams(symbol, secType, conId) {
    this.w.rec(this.name, 'secDefOptParams', [symbol, secType, conId]);
    const r = this.pick('secDef', [{ params: [] }]);
    if (r.delay) await this.w.sleep(r.delay);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec(r.params));
  }

  async mktDepth(contract, rows, waitMs) {
    this.w.rec(this.name, 'mktDepth', [norm(contract), rows, waitMs]);
    const r = this.pick('depth', [{ bids: [], asks: [] }]);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec({ bids: r.bids, asks: r.asks }));
  }

  async placeOrder(contract, order) {
    this.w.rec(this.name, 'placeOrder', [norm(contract), canonOrder(order)]);
    const r = this.pick('place', [{}]);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await this.w.sleep(r.delay);
    if (r.linkDown) throw new this.w.mods.ibLink.LinkDownError();
    if (r.error !== undefined) throw new Error(r.error);
    if (r.orderId === undefined) { this.nextOrderId += 1; return { orderId: this.nextOrderId, permId: 9000 + this.nextOrderId, status: 'Submitted' }; }
    return { ...r };
  }

  cancelOrder(orderId) {
    this.w.rec(this.name, 'cancelOrder', [orderId]);
    const r = this.pick('cancel', [{}]);
    if (r.linkDown) throw new this.w.mods.ibLink.LinkDownError();
    if (r.error !== undefined) throw new Error(r.error);
  }

  async openTrades() {
    this.w.rec(this.name, 'openTrades', []);
    return (this.cfg.openTrades ?? []).map((o) => ({
      orderId: o.orderId,
      cancel: () => { this.w.rec(this.name, 'tradeCancel', [o.orderId]); if (o.throws) throw new Error('trade cancel boom'); },
    }));
  }

  async portfolio() { return this.listCall('portfolio'); }
  async positions() { return this.listCall('positions'); }
  async listCall(key) {
    this.w.rec(this.name, key, []);
    const r = this.pick(key, [{ items: [] }]);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await this.w.sleep(r.delay);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec(r.items));
  }
}

function emptyData(times, T) {
  return {
    bid: NAN, ask: NAN, last: null, close: null, bidSize: null, askSize: null, marketPrice: null, modelGreeks: null, error: null,
    open: null, high: null, low: null, volume: null, avgVolume: null, histVol: null, vol3m: null, vol5m: null, vol10m: null, lastTradeAt: null,
    callOpenInterest: null, putOpenInterest: null, callVolume: null, putVolume: null, delayed: false, quotedAt: null, requestedAt: times ? T : null,
  };
}
function mergePatch(data, patch) {
  for (const [k, v] of Object.entries(dec(patch))) {
    if (k === 'iv') data.modelGreeks = v === null ? null : { gamma: data.modelGreeks?.gamma ?? null, impliedVol: v, optPrice: null };
    else if (k === 'gamma') data.modelGreeks = v === null ? null : { gamma: v, impliedVol: data.modelGreeks?.impliedVol ?? null, optPrice: null };
    else if (k === 'error' || k === 'delayed' || NUM_FIELDS.includes(k)) data[k] = v;
    else throw new Error(`脚本里不认识的盘口字段 ${k}`);
  }
}

/** 在途的 Promise 记成可查的状态 */
function track(p) {
  const s = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = e; });
  return s;
}
const outcome = (s, f = (v) => v) => {
  if (s.error !== undefined) {
    const cls = s.error?.name === 'LinkDownError' ? 'LinkDownError' : s.error?.constructor?.name === 'BrokerError' ? 'BrokerError' : 'Error';
    return { error: String(s.error?.message ?? s.error), cls };
  }
  return { ok: enc(f(s.value)) };
};

/** 让钟一个计时器一个计时器地走,直到这一路有结果;没有计时器了还没结果就是"挂着"(返回 false) */
async function runToDone(world, s) {
  for (let i = 0; i < 100000; i += 1) {
    await drain();
    if (s.done) return true;
    if (!(await world.stepOne())) { await drain(); return s.done; }
  }
  throw new Error('这一步卡住了:脚本写错');
}

export async function runScenario(script, mods) {
  const dir = mkdtempSync(join(tmpdir(), 'broker-world-'));
  const world = new World(script, mods, dir);
  const { broker, config, marketdata } = mods;
  try {
    const raw = deepMerge(BASE_CONFIG, script.settings ?? {});
    raw.storage = { db_path: join(dir, 'trades.db') };
    const settings = config.fromDict(JSON.parse(JSON.stringify(raw)));
    const byConn = Object.fromEntries(Object.keys(settings.connections).map((c) => [c, c]));
    const portToConn = Object.fromEntries(Object.entries(settings.connections).map(([c, v]) => [v.port, c]));
    void byConn;
    const factory = async (cfg) => {
      const conn = portToConn[cfg.port];
      world.rec(null, 'factory', [{ host: cfg.host, port: cfg.port, clientId: cfg.clientId, readonly: cfg.readonly }]);
      const list = (script.factory ?? {})[conn] ?? [];
      const i = world.factoryIdx[conn] ?? 0;
      world.factoryIdx[conn] = i + 1;
      const item = list[i];
      if (item === undefined) throw new Error('connect ECONNREFUSED');
      if (typeof item === 'object' && item !== null) {
        if (item.delay) await world.sleep(item.delay);
        throw new Error(item.error);
      }
      const s = world.sessions.get(item);
      if (!s) throw new Error(`脚本写错:没有会话 ${item}`);
      s.connected = true;
      return s;
    };
    const router = new broker.BrokerRouter(settings, factory);
    const accountOf = (alias) => settings.accountByAlias(alias);
    const describeBars = (bars) => {
      const o = { bars };
      const feed = marketdata.feedOf(bars), proxy = marketdata.proxyOf(bars);
      if (feed !== undefined) o.feed = feed;
      if (proxy !== undefined) o.proxy = proxy;
      return o;
    };
    const approvedOf = (a) => ({ order: structuredClone(a.order), account: accountOf(a.account), notional: a.notional ?? 0, signature: a.signature ?? '', warnings: a.warnings ?? [] });
    const sessionName = (s) => (s ? s.name : null);
    const methods = {
      connect: (a) => router.connect(a.name).then(sessionName),
      forAccount: (a) => router.forAccount(accountOf(a.account)).then(sessionName),
      qualify: (a) => router.qualify(structuredClone(a.contract), accountOf(a.account)).then(norm),
      qualifyOrRaise: async (a) => { const c = structuredClone(dec(a.contract)); await router.qualifyOrRaise(world.sessions.get(a.session), c, a.wait ?? false); return norm(c); },
      legQuotes: (a) => router.legQuotes(structuredClone(a.contract), accountOf(a.account)),
      indexPrice: (a) => router.indexPrice(a.symbol),
      stockQuotes: (a) => router.stockQuotes(a.symbols),
      historicalBars: (a) => router.historicalBars(a.symbol, a.start, a.end),
      streamQuotes: (a) => router.streamQuotes(a.symbols),
      volumeQuotes: (a) => router.volumeQuotes(a.symbols),
      releaseVolumeStreams: async (a) => router.releaseVolumeStreams(a.keep),
      intradayBars: (a) => router.intradayBars(a.symbol, a.timeframe, a.rth ?? false, a.endDay ?? undefined, a.indexProxy ?? false),
      optionExpiries: (a) => router.optionExpiries(a.symbol),
      optionChain: (a) => router.optionChain(a.symbol, a.expiry ?? null, a.width ?? 10, a.span ?? null, a.preferClass ?? ''),
      orderBook: (a) => router.orderBook(a.symbol, a.rows ?? 10),
      comboBars: (a) => router.comboBars(a.symbol, structuredClone(a.legs), a.day, a.barSize ?? '1 min'),
      positions: () => router.positions(),
      optionQuotes: (a) => router.optionQuotes(structuredClone(a.rows)),
      executions: () => router.executions(),
      contractHours: (a) => router.contractHours(structuredClone(a.row), accountOf(a.account)),
      place: (a) => router.place(a.recordId, approvedOf(a.approved), a.limitOverride === undefined ? null : dec(a.limitOverride)),
      cancelAllOpen: () => router.cancelAllOpen(),
      placeHosted: (a) => router.placeHosted(accountOf(a.account), structuredClone(a.contract), structuredClone(a.item), a.oca, a.ref),
      modifyHosted: (a) => router.modifyHosted(a.orderId, structuredClone(a.item)),
      cancelHosted: (a) => router.cancelHosted(a.orderId),
      listHostedOpen: (a) => router.listHostedOpen(a.prefix === undefined ? undefined : a.prefix),
      listOpenOrdersDetailed: () => router.listOpenOrdersDetailed(),
      disconnectAll: () => router.disconnectAll(),
    };
    const shapes = { intradayBars: describeBars, legQuotes: (v) => v.map((q) => ({ action: q.action, ratio: q.ratio, bid: q.bid, ask: q.ask })) };

    const steps = [];
    const started = new Map();
    const reported = new Set();
    const files = [];
    const basisPath = join(dir, 'index_basis.json');
    if (script.basisFile !== undefined) writeFileSync(basisPath, script.basisFile);
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (step.id !== undefined) rec.id = step.id;
      switch (step.op) {
        case 'call': {
          rec.m = step.m;
          if (!methods[step.m]) throw new Error(`不认识的方法 ${step.m}`);
          const shape = shapes[step.m] ?? ((v) => v);
          let p;
          try { p = Promise.resolve(methods[step.m](dec(step.a ?? {}))); } catch (e) { p = Promise.reject(e); }
          const s = track(p);
          if (step.start) started.set(step.id, { s, shape });
          else { const ok = await runToDone(world, s); rec.result = ok ? outcome(s, shape) : { pending: true }; }
          break;
        }
        case 'await': {
          const st = started.get(step.id);
          const ok = await runToDone(world, st.s);
          rec.result = ok ? outcome(st.s, st.shape) : { pending: true };
          reported.add(step.id);
          break;
        }
        case 'advance': await world.advance(step.ms); break;
        case 'sess': Object.assign(world.sessions.get(step.session).cfg, dec(step.set)); if ('connected' in step.set) world.sessions.get(step.session).connected = step.set.connected; break;
        case 'patch': world.sessions.get(step.session)?.applyPatch(step.key, step.patch); break;
        case 'emitConnectivity': for (const cb of [...world.sessions.get(step.session).connCbs]) cb(step.code); break;
        case 'emitLink': for (const cb of [...world.sessions.get(step.session).linkCbs]) cb(step.up); break;
        case 'hooks':
          router.linkHook = step.link ? (name, up) => world.rec(null, 'linkHook', [name, up]) : null;
          router.sessionHook = step.session ? (s) => { world.rec(null, 'sessionHook', [s.name]); if (step.sessionThrows) throw new Error('hook boom'); } : null;
          break;
        case 'warm': router.warmIndexFutures(); break;
        case 'file': writeFileSync(basisPath, step.content); break;
        case 'readFile': files.push(existsSync(basisPath) ? readFileSync(basisPath, 'utf-8') : null); rec.file = files[files.length - 1]; break;
        case 'get': {
          const g = step;
          const v = {
            upstreamOk: () => router.upstreamOk,
            sessions: () => router.sessions().map((s) => s.name),
            connectedNames: () => router.connectedNames(),
            coveredAccounts: () => [...router.coveredAccounts()],
            coveredAccountIds: () => [...router.coveredAccountIds()],
            spotInfo: () => router.spotInfo(g.symbol),
            cachedContractHours: () => router.cachedContractHours(g.symbol, g.expiry),
            quoteCapability: () => router.quoteCapability(g.symbol),
            connections: () => Object.keys(router.connections),
            marketSession: () => { try { return sessionName(router.marketSession()); } catch (e) { return { error: e.message }; } },
          }[g.what]();
          rec.value = enc(v);
          break;
        }
        case 'drainBg': break;
        default: throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const done = [];
      for (const [id, st] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (st.s.done && !reported.has(id)) { reported.add(id); done.push({ id, result: outcome(st.s, st.shape) }); }
      }
      if (done.length) rec.done = done;
      rec.T = world.T;
      steps.push(rec);
    }
    const finalFile = existsSync(basisPath) ? readFileSync(basisPath, 'utf-8') : null;
    return { log: world.log, steps, basisFile: finalFile };
  } finally {
    world.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}
