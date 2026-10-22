// svc2 簇(engine-ts/src/services/ 第二批)对拍用的"世界"的 JS 一半:虚拟钟与计时器、真的交易库(临时文件)、记录一切的假宿主 / 假引擎 / 假通知器、
// 脚本驱动的假 IbSession 与会话工厂(给真的 BrokerRouter 用),以及把一份脚本交给**原 TS 的 service** 现跑、
// 把宿主与会话上被调用的每一次(方法、参数、虚拟时刻、先后次序)与各步的结果、每步之后库里变了的表记下来的跑法。
// C++ 那边(tests/svc_world.h)读同一份脚本、解释得一模一样、逐项精确比较。改这个文件就要同时改 svc_world.h。
//
// ---- 约定(两边都靠它们对得上)
//  · 时间:Date.now() / new Date() 是虚拟钟 T;performance.now() = T - start + perfBase(perfBase 缺省 1_000_000)。只有 advance 步让它走。
//    setTimeout / setInterval 是虚拟计时器(同刻按排入先后);回调里的 async 链用 setImmediate 排空(= 一个宏任务内的全部微任务)。
//  · 日志 {t, s, m, a}:t 虚拟时刻、s 谁(会话名 / "host" / "engine" / "notifier" / "stderr" / null)、m 方法、a 参数(enc 过)。
//  · 库是真的(better-sqlite3 / C++ 的 TradeStore),库路径在临时目录;id 是 00000000-0000-4000-8000-0000000000NN 依次;
//    每步之后把 script.dump 里列的表(缺省 audit_log / broker_fills / app_prefs)整张读出,和上一步比,变了的才记进 rec.store。
//  · 假会话返回的东西一律写全、缺值写 null。pick(key):按调用先后各取一个,用完重复最后一个。
//
// ---- 脚本(scenario)
//  { name, start, seed?, settings: <深合并到基础配置上的补丁>, factory: {连接名: [会话名 | {error, delay?} …]},
//    sessions: [会话脚本…], dump?: [表名…], steps: […], svc?: {…各 service 自己的} }
//  会话脚本:{ name, caps: ["Executions","ExecutionHistory","OnLink","SetBaselineMarketDataType"], connected, accounts, disconnectDelay, throwDisconnect,
//    positions:[{rows, delay?}|{error, delay?}|{hang}…], executions:[同], history:[{rows|null, delay?}|{error}|{hang}…] }
//  步(通用):{op:"advance", ms} | {op:"sess", session, set:{…覆盖会话脚本的键}} | {op:"emitLink", session, up} | {op:"emitConnectivity", session, code} |
//    {op:"settings", patch} | {op:"port", v:"make"|"null"}(换上 / 拿掉 script.router 那台假 router) | {op:"portSet", set:{sessions?, results?:{…}, spotInfo?, upstreamOk?, marketSession?}} | {op:"store", m, a} | {op:"call", id, m, a} | {op:"get", what, a?}(service 自己的读取) | 各 service 自己的 op
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import cryptoDefault from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BASE_CONFIG, deepMerge, dec, drain, enc, rng } from './broker_world.mjs';

export { BASE_CONFIG, deepMerge, dec, drain, enc, rng };

// ---- 可复现的钟与 id(要在 import store.js 之前换掉;只有一个活着的世界时读它的 T)
let CURRENT = null;
const RealDate = Date;
const RealNow = Date.now;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(CURRENT ? CURRENT.T : RealNow()); else super(...a); }
  static now() { return CURRENT ? CURRENT.T : RealNow(); }
}
globalThis.Date = FakeDate;
cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++CURRENT.uuidN).padStart(12, '0')}`;
syncBuiltinESMExports();

export async function loadMods(engineDir) {
  const imp = (f) => import(pathToFileURL(join(engineDir, `dist/src/${f}.js`)).href);
  const names = ['broker', 'config', 'store', 'rpcError', 'ibLink'];
  const loaded = await Promise.all(names.map(imp));
  const mods = Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
  mods.imp = imp;
  mods.Database = createRequire(join(engineDir, 'package.json'))('better-sqlite3');
  return mods;
}

export class World {
  constructor(script, mods, dir) {
    this.mods = mods;
    this.script = script;
    this.dir = dir;
    this.T = script.start;
    this.startT = script.start;
    this.perfBase = script.perfBase ?? 1_000_000;
    this.log = [];
    this.timers = [];
    this.counter = 0;
    this.nextTimerId = 1;
    this.uuidN = 0;
    this.sessions = new Map();
    this.factoryIdx = {};
    this.trackEngine = false;
    CURRENT = this;
    this.origWrite = process.stderr.write;
    this.origRandom = Math.random;
    this.origPerfNow = performance.now;
    const w = this;
    process.stderr.write = (chunk) => { w.rec(null, 'stderr', [String(chunk).replace(/\n$/, '')]); return true; };
    const next = rng(script.seed ?? 1).next;
    Math.random = () => next();
    Object.defineProperty(performance, 'now', { value: () => w.T - w.startT + w.perfBase, configurable: true, writable: true });
    this.orig = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
    globalThis.setTimeout = (fn, ms) => w.addTimer(fn, ms, 0);
    globalThis.setInterval = (fn, ms) => w.addTimer(fn, ms, ms < 1 ? 1 : ms);
    globalThis.clearTimeout = (h) => w.clearTimer(h);
    globalThis.clearInterval = (h) => w.clearTimer(h);
    for (const cfg of script.sessions ?? []) this.sessions.set(cfg.name, new FakeSession(this, structuredClone(cfg)));
  }

  restore() {
    CURRENT = null;
    process.stderr.write = this.origWrite;
    Math.random = this.origRandom;
    Object.defineProperty(performance, 'now', { value: this.origPerfNow, configurable: true, writable: true });
    Object.assign(globalThis, this.orig);
  }

  rec(session, method, args) { this.log.push({ t: this.T, s: session, m: method, a: enc(args) }); }

  addTimer(fn, ms, every) {
    const delay = ms === undefined || ms < 1 || Number.isNaN(ms) ? 1 : ms;
    const e = { id: this.nextTimerId++, at: this.T + delay, seq: this.counter++, fn, every, dead: false };
    this.timers.push(e);
    const handle = { _e: e, unref() { return this; }, ref() { return this; }, hasRef() { return true; } };
    return handle;
  }
  clearTimer(h) {
    if (!h || !h._e) return;
    h._e.dead = true;
    const i = this.timers.indexOf(h._e);
    if (i >= 0) this.timers.splice(i, 1);
  }
  sleep(delay) { return new Promise((r) => this.addTimer(r, delay, 0)); }

  /** 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发,排空微任务。没有计时器回 false */
  async stepOne(limit = Infinity) {
    let best = null;
    for (const e of this.timers) if (best === null || e.at < best.at || (e.at === best.at && e.seq < best.seq)) best = e;
    if (best === null || best.at > limit) return false;
    this.timers.splice(this.timers.indexOf(best), 1);
    this.T = Math.max(this.T, best.at);
    best.fn();
    if (best.every && !best.dead) {
      best.at = this.T + best.every;
      best.seq = this.counter++;
      this.timers.push(best);
    }
    await drain();
    return true;
  }
  async advance(ms) {
    const end = this.T + ms;
    while (await this.stepOne(end)) { /* 一个一个到点 */ }
    this.T = end;
  }
}

/** 种子固定的随机数,用来演出"脚本里没写死的东西" */
export function pick(cfg, counters, key, dflt) {
  const list = cfg[key] && cfg[key].length ? cfg[key] : dflt;
  const i = counters[key] ?? 0;
  counters[key] = i + 1;
  return list[Math.min(i, list.length - 1)];
}

class FakeSession {
  constructor(world, cfg) {
    this.w = world;
    this.cfg = cfg;
    this.name = cfg.name;
    this.connected = cfg.connected ?? true;
    this.linkCbs = [];
    this.counters = {};
    const caps = new Set(cfg.caps ?? []);
    const w = world;
    const n = this.name;
    if (caps.has('SetBaselineMarketDataType')) this.setBaselineMarketDataType = (t) => { w.rec(n, 'setBaselineMarketDataType', [t]); };
    if (caps.has('Executions')) {
      this.executions = async () => {
        w.rec(n, 'executions', []);
        const r = this.next('executions', [{ rows: [] }]);
        if (r.hang) await new Promise(() => {});
        if (r.delay) await w.sleep(r.delay);
        if (r.error !== undefined) throw new Error(r.error);
        return structuredClone(dec(r.rows));
      };
    }
    if (caps.has('ExecutionHistory')) {
      this.executionHistory = async (days) => {
        w.rec(n, 'executionHistory', [days]);
        const r = this.next('history', [{ rows: [] }]);
        if (r.hang) await new Promise(() => {});
        if (r.delay) await w.sleep(r.delay);
        if (r.error !== undefined) throw new Error(r.error);
        return r.rows === null ? null : structuredClone(dec(r.rows));
      };
    }
    if (caps.has('OnLink')) this.onLink = (cb) => { w.rec(n, 'onLink', []); this.linkCbs.push(cb); };
  }

  next(key, dflt) { return pick(this.cfg, this.counters, key, dflt); }

  isConnected() { return this.connected; }
  async disconnect() {
    this.w.rec(this.name, 'disconnect', []);
    this.connected = false;
    this.closed = true; // 显式断开之后真会话不再报通断
    if (this.cfg.disconnectDelay) await this.w.sleep(this.cfg.disconnectDelay);
    if (this.cfg.throwDisconnect) throw new Error('disconnect boom');
  }
  managedAccounts() { return [...(this.cfg.accounts ?? [])]; }
  onConnectivity() { this.w.rec(this.name, 'onConnectivity', []); }
  reqMarketDataType(t) { this.w.rec(this.name, 'reqMarketDataType', [t]); }
  subscribeTicker(c, g) { this.w.rec(this.name, 'subscribeTicker', [c.secType, c.symbol, c.exchange, g ?? '']); return { read: () => ({}) }; }
  cancelTicker() { /* 不关心 */ }
  async settle() { /* 不等 */ }
  async qualifyContracts(contracts) { this.w.rec(this.name, 'qualifyContracts', [contracts.map((c) => [c.secType, c.symbol, c.exchange])]); }
  async portfolio() { return []; }
  async positions() {
    this.w.rec(this.name, 'positions', []);
    const r = this.next('positions', [{ rows: [] }]);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await this.w.sleep(r.delay);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec(r.rows));
  }
}

/** 记录一切的假宿主:settings / router 可换,engine 是库 + 记录通知的假引擎 */
export class Host {
  constructor(world, settings, store) {
    this.w = world;
    this.settings = settings;
    this.router = null;
    this.store = store;
    this.attached = world.script.listeners ?? 1;
    const w = world;
    const self = this;
    this.notifier = {
      notify: (...a) => w.rec('notifier', 'notify', a),
      warning: (...a) => w.rec('notifier', 'warning', a),
    };
    this.engineObj = {
      store,
      notifier: this.notifier,
      reconcileSoon: () => w.rec('engine', 'reconcileSoon', []),
      attachListeners: () => { w.rec('engine', 'attachListeners', []); return self.attached; },
    };
  }
  get engine() {
    if (this.w.trackEngine) this.w.rec('host', 'engine', []);
    return this.engineObj;
  }
  emit(event, payload) { this.w.rec('host', 'emit', [event, payload]); }
  dropEngine() { this.w.rec('host', 'dropEngine', []); }
}

export function makeSettings(world, patch) {
  const raw = deepMerge(deepMerge(BASE_CONFIG, world.script.settings ?? {}), patch ?? {});
  raw.storage = { db_path: join(world.dir, 'trades.db') };
  return world.mods.config.fromDict(JSON.parse(JSON.stringify(raw)));
}

/** 给真的 BrokerRouter 用的会话工厂:连接名 → 脚本里按调用先后列的会话 / 失败 */
export function makeFactory(world, settings) {
  const portToConn = Object.fromEntries(Object.entries(settings.connections).map(([c, v]) => [v.port, c]));
  return async (cfg) => {
    const conn = portToConn[cfg.port];
    world.rec(null, 'factory', [{ host: cfg.host, port: cfg.port, clientId: cfg.clientId, readonly: cfg.readonly }]);
    const list = (world.script.factory ?? {})[conn] ?? [];
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
    s.closed = false;
    return s;
  };
}

/**
 * 脚本驱动的假 router(给 RouterPort 那一面的 service 用)。script.router = { sessions: n, results: {方法名 或 方法名:参数键: [结果…]}, spotInfo: {标的: 对象|null},
 *   upstreamOk, marketSession: {accounts:[…]} | {error} }。结果 {value, delay?, hang?, error?, kind?: "broker"|"plain"}:按调用先后各取一个,用完重复最后一个;
 *   参数键 = 第一个参数(标的数组用逗号连起来)。每次调用记一条日志 {s:"router", m, a}。
 */
const RouterBase = (mods) => mods.broker.BrokerRouter;
export function makeScriptedRouter(world, cfg) {
  class ScriptedRouter extends world.mods.broker.BrokerRouter {
  constructor() {
    super(makeSettings(world));
    this.w = world;
    this.cfg = cfg ?? {};
    this.n = this.cfg.sessions ?? 1;
    this.counters = {};
    this.mods = world.mods;
  }
  sessions() { return Array.from({ length: this.n }, () => ({})); }
  get upstreamOk() { this.w.rec('router', 'upstreamOk', []); return this.cfg.upstreamOk ?? true; }
  spotInfo(symbol) {
    this.w.rec('router', 'spotInfo', [symbol]);
    const v = (this.cfg.spotInfo ?? {})[symbol];
    return v === undefined ? null : structuredClone(dec(v));
  }
  marketSession() {
    this.w.rec('router', 'marketSession', []);
    const m = this.cfg.marketSession ?? { accounts: [] };
    if (m.error !== undefined) throw new this.mods.broker.BrokerError(m.error);
    const accounts = [...(m.accounts ?? [])];
    return { managedAccounts: () => accounts, isFake: true };
  }
  async ask(name, argKey, args) {
    this.w.rec('router', name, args);
    const results = this.cfg.results ?? {};
    const key = results[`${name}:${argKey}`] ? `${name}:${argKey}` : name;
    const r = pick(results, this.counters, key, [{ unscripted: true }]);
    if (r.unscripted) throw new Error(`svc_world: ${name} 未脚本`);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await this.w.sleep(r.delay);
    if (r.error !== undefined) throw r.kind === 'plain' ? new Error(r.error) : new this.mods.broker.BrokerError(r.error);
    return r;
  }
  async positions() { return structuredClone(dec((await this.ask('positions', '', [])).value)); }
  async streamQuotes(symbols) { return structuredClone(dec((await this.ask('streamQuotes', symbols.join(','), [symbols])).value)); }
  async stockQuotes(symbols) { return structuredClone(dec((await this.ask('stockQuotes', symbols.join(','), [symbols])).value)); }
  async indexPrice(symbol) { return structuredClone(dec((await this.ask('indexPrice', symbol, [symbol])).value)); }
  async optionChain(symbol, expiry, width, span, preferClass) {
    return structuredClone(dec((await this.ask('optionChain', symbol, [symbol, expiry ?? null, width, span ?? null, preferClass])).value));
  }
  async historicalBars(symbol, start, end) { return structuredClone(dec((await this.ask('historicalBars', symbol, [symbol, start, end])).value)); }
  async intradayBars(symbol, timeframe, rth = false, endDay = undefined, indexProxy = false) {
    const r = await this.ask('intradayBars', `${symbol}|${timeframe}`, [symbol, timeframe, rth, endDay ?? null, indexProxy]);
    const bars = structuredClone(dec(r.value.bars));
    const md = await this.mods.imp('marketdata');
    const feed = r.value.feed;
    return feed === undefined ? bars : md.tagFeed(bars, feed === 'live' ? false : feed === 'delayed' ? true : null);
  }
  }
  return new ScriptedRouter();
}

/**
 * 脚本驱动的取数器(events 的 fetcher):按地址里的字挑一串结果 script.fetch[键]:faireconomy → feed,cboe → cboe,yahoo → yahoo,别的 → other;
 * 结果 {value, delay?, hang?, error?},按调用先后各取一个,用完重复最后一个;没写的键一律「no route to host」。每次调用记一条日志 {s:"fetch", m:"get", a:[地址, 时限]}。
 */
export function makeFetcher(world) {
  const counters = {};
  return async (url, timeoutMs) => {
    world.rec('fetch', 'get', [url, timeoutMs]);
    const key = url.includes('faireconomy') ? 'feed' : url.includes('cboe') ? 'cboe' : url.includes('yahoo') ? 'yahoo' : 'other';
    const r = pick(world.script.fetch ?? {}, counters, key, [{ error: 'no route to host' }]);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await world.sleep(r.delay);
    if (r.error !== undefined) throw new Error(r.error);
    return structuredClone(dec(r.value));
  };
}

/**
 * 脚本驱动的假盘口读取(OptionMarkStreams.read 的替身,给 flyPlanner / ivRecorder 用)。script.marks = [结果…],按调用先后各取一个,用完重复最后一个:
 * {delay?, hang?, error?, kind?: "plain", byLeg?: {"<行权价><C|P>": {bid, ask, iv, error?}}, dflt?: {bid, ask, iv, error?}}。每次调用记一条日志 {s:"marks", m:"read", a:[账户, 腿, delayedOk, 静默时限]}。
 */
export function makeMarks(world) {
  const counters = {};
  return {
    read: async (session, legs, delayedOk, silentLimitMs) => {
      world.rec('marks', 'read', [session.managedAccounts(), legs, delayedOk, silentLimitMs]);
      const r = pick(world.script, counters, 'marks', [{}]);
      if (r.hang) await new Promise(() => {});
      if (r.delay) await world.sleep(r.delay);
      if (r.error !== undefined) {
        const { OptionMarksError } = await world.mods.imp('optionMarks');
        throw r.kind === 'plain' ? new Error(r.error) : new OptionMarksError(r.error);
      }
      return legs.map((l) => {
        const q = (r.byLeg ?? {})[`${l.strike}${l.right}`] ?? r.dflt ?? {};
        const m = { strike: l.strike, right: l.right, bid: q.bid ?? null, ask: q.ask ?? null, iv: q.iv ?? null };
        if (q.error !== undefined) m.error = q.error;
        return m;
      });
    },
  };
}

const DEFAULT_DUMP = ['audit_log', 'broker_fills', 'app_prefs'];

function dumpFiles(root, dirs) {
  const out = {};
  for (const d of dirs) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) out[`${d}/${f}`] = readFileSync(join(dir, f), 'utf-8');
  }
  return out;
}

function dumpTables(db, tables) {
  const out = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).raw().all();
    out[t] = rows.map((r) => r.map((c) => (Buffer.isBuffer(c) ? { blob: c.toString('hex') } : c)));
  }
  return out;
}

export const errInfo = (mods, e) => ({
  error: String(e?.message ?? e),
  cls: e instanceof mods.broker.BrokerError ? 'BrokerError' : e instanceof mods.rpcError.RpcError ? 'RpcError' : 'Error',
  ...(e instanceof mods.rpcError.RpcError ? { code: e.code } : {}),
});

/**
 * 跑一份脚本。build(world, host, mods, ctx) 回 { methods: {名字: (a) => Promise|值}, ops: {名字: async (step, rec) => void}, gets: {名字: (a) => 值}, stop?: () => void }
 * 返回 { log, steps, final }
 */
export async function runScript(script, mods, build) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-world-'));
  const world = new World(script, mods, dir);
  let store = null;
  try {
    const settings = makeSettings(world);
    store = new mods.store.TradeStore(settings.db_path);
    const host = new Host(world, settings, store);
    const svc = build(world, host, mods);
    world.trackEngine = !!script.trackEngine; // 建 service 时不记引擎访问
    const started = new Map();
    const reported = new Set();
    const steps = [];
    const dump = script.dump ?? DEFAULT_DUMP;
    let prev = dumpTables(store.db, dump);
    const fileDirs = script.files ?? [];
    let prevFiles = dumpFiles(dir, fileDirs);
    for (const step of script.steps) {
      const rec = { op: step.op };
      switch (step.op) {
        case 'advance': await world.advance(step.ms); break;
        case 'sess': {
          const s = world.sessions.get(step.session);
          const set = structuredClone(dec(step.set));
          Object.assign(s.cfg, set);
          for (const k of Object.keys(set)) delete s.counters[k]; // 换了一串结果,从头取
          if ('connected' in set) s.connected = set.connected;
          break;
        }
        case 'emitLink': { const s = world.sessions.get(step.session); if (!s.closed) for (const cb of [...s.linkCbs]) cb(step.up); break; }
        case 'settings': host.settings = makeSettings(world, step.patch); break;
        case 'port': host.router = step.v === 'make' ? makeScriptedRouter(world, structuredClone(dec(script.router ?? {}))) : null; break;
        case 'portSet': {
          const r = host.router;
          if (!r) break; // 没有假 router 时空操作
          const set = structuredClone(dec(step.set));
          for (const [k, v] of Object.entries(set)) {
            if (k === 'results') for (const [rk, rv] of Object.entries(v)) { (r.cfg.results ??= {})[rk] = rv; delete r.counters[rk]; }
            else if (k === 'sessions') r.n = v;
            else r.cfg[k] = v;
          }
          break;
        }
        case 'file': { mkdirSync(join(dir, step.path, '..'), { recursive: true }); writeFileSync(join(dir, step.path), step.content); break; }
        case 'store': {
          try {
            if (step.m.startsWith('$')) {
              // 伪方法:按代码找到那一行再改(行 id 是依次发的 uuid,脚本里不好写死)
              const [symbol, fields] = structuredClone(dec(step.a))[0];
              const pick2 = step.m === '$updateWatch' ? store.listWatches() : store.listQualityStocks();
              const row = pick2.find((w) => w.symbol === symbol);
              rec.value = enc(step.m === '$updateWatch' ? store.updateWatch(row.id, fields) : store.updateQualityStock(row.id, fields));
              break;
            }
            const parts = step.m.split('.');
            const fn = parts.pop();
            const target = parts.reduce((o, k) => o[k], store);
            const v = target[fn](...structuredClone(dec(step.a ?? [])));
            rec.value = enc(v === undefined ? null : v instanceof Map ? [...v.entries()] : v);
          } catch (e) { rec.value = errInfo(mods, e); }
          break;
        }
        case 'call': {
          const st = { done: false };
          let p;
          try { p = Promise.resolve(svc.methods[step.m](structuredClone(dec(step.a ?? {})))); } catch (e) { p = Promise.reject(e); }
          p.then((v) => { st.done = true; st.value = v; }, (e) => { st.done = true; st.error = e; });
          started.set(step.id, st);
          break;
        }
        case 'get': { const v = svc.gets[step.what](structuredClone(dec(step.a ?? {}))); rec.value = enc(v === undefined ? null : v); break; }
        default: {
          const fn = svc.ops?.[step.op];
          if (!fn) throw new Error(`不认识的步 ${step.op}`);
          await fn(step, rec);
        }
      }
      await drain();
      const done = [];
      for (const [id, st] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (st.done && !reported.has(id)) {
          reported.add(id);
          done.push({ id, result: st.error !== undefined ? errInfo(mods, st.error) : { ok: enc(st.value === undefined ? null : st.value) } });
        }
      }
      if (done.length) rec.done = done;
      const now = dumpTables(store.db, dump);
      const changed = {};
      for (const t of dump) if (JSON.stringify(now[t]) !== JSON.stringify(prev[t])) changed[t] = now[t];
      if (Object.keys(changed).length) rec.store = enc(changed);
      prev = now;
      const nowFiles = dumpFiles(dir, fileDirs);
      const changedFiles = {};
      for (const [k, v] of Object.entries(nowFiles)) if (prevFiles[k] !== v) changedFiles[k] = v;
      if (Object.keys(changedFiles).length) rec.files = changedFiles;
      prevFiles = nowFiles;
      rec.T = world.T;
      steps.push(rec);
    }
    svc.stop?.();
    // 临时目录的随机名不进对拍
    // sortLog:同一虚拟时刻内的先后不比(BrokerRouter 内部微任务拍数造成的次序差,不是 service 的行为)
    const log = script.sortLog ? [...world.log].sort((a, b) => (a.t - b.t) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)) : world.log;
    return JSON.parse(JSON.stringify({ log, steps }).split(JSON.stringify(dir).slice(1, -1)).join('<DIR>'));
  } finally {
    world.restore();
    try { store?.db.close(); } catch { /* 已关 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}
