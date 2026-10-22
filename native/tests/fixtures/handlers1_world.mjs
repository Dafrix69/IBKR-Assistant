// handlers1 簇(engine-ts/src/rpc/handlers/{tracker,trading,connection,settings,system}.ts)对拍用的"世界"的 JS 一半。
// C++ 一半:tests/handlers1_world.h。**改这个文件就要同时改那个**。
//
// 做法:**原 TS 的 handler 类**(TrackerHandlers / TradingHandlers / ConnectionHandlers / SettingsHandlers / SystemHandlers)原样 new 出来,
// 喂一个假的 RpcContext:虚拟钟(svc_world.mjs 的 World)、真的交易库(临时文件)、真的熔断开关文件、真的配置文件(patchConfigFile 真写),
// 引擎 / router / alerts / brokerLink / 凭证库是脚本驱动的替身——每一次调用(方法、参数、虚拟时刻、先后)都记下来,返回脚本里写的结果。
// 入口是 handler 的方法表(contractMethods 包过一层 schema),不是 RpcServer:RpcServer 的构造函数要建十六个 service 和一个真引擎;
// 信封(RpcError → {code, message})的映射照 server.ts 的 handleInner 抄在这里,C++ 一半走真的 RpcServer::call。
//
// ---- 脚本
//  { name, start, seed?, settings: <深合并到基础配置上的补丁>,
//    router: null | { sessions: n, results: {方法名 或 方法名:参数键: [结果…]}, spotInfo?: {标的: 对象|null}|undefined, streamQuotes?: bool, optionQuotes?: bool, upstreamOk?: bool, connected?: [名字…] },
//    engine: { results: {方法名: [结果…]}, loop?: {…}, pending?: [{record_id, approved:{order:{intent_summary}, account:{alias}}, trigger:{symbol, operator, value}, created_at}…] },
//    services: { alerts: {results}, brokerLink: {results} }, secrets: { exists: {"service|account": true}, writeError?: "…" },
//    dump?: [表名…], files?: [根目录下的文件名…], steps: […] }
//  结果 {value?, delay?, hang?, error?, cls?: "Error"|"BrokerError"|"RpcError"|"KeychainError", code?}:按调用先后各取一个,用完重复最后一个。
//  步:{op:"advance", ms} | {op:"call", id, m, a} | {op:"config", patch}(外面改了配置文件、引擎重读) | {op:"router", v:"make"|"null"} | {op:"routerSet", set} |
//     {op:"engineSet", set} | {op:"servicesSet", set} | {op:"secrets", set} | {op:"store", m, a} | {op:"killswitch", m, a}(engage / release / recordFailure …) | {op:"file", path, content} | {op:"get", what}
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, BASE_CONFIG, deepMerge, dec, drain, enc, loadMods } from './svc_world.mjs';

export { BASE_CONFIG, deepMerge, dec, enc, loadMods };

const DEFAULT_DUMP = ['audit_log', 'position_tracks'];

function dumpTables(db, tables) {
  const out = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).raw().all();
    out[t] = rows.map((r) => r.map((c) => (Buffer.isBuffer(c) ? { blob: c.toString('hex') } : c)));
  }
  return out;
}

function dumpFiles(root, names) {
  const out = {};
  for (const n of names) {
    const p = join(root, n);
    if (existsSync(p)) out[n] = readFileSync(p, 'utf-8');
  }
  return out;
}

export class Handlers1World {
  constructor(script, mods) {
    this.script = script;
    this.mods = mods;
    this.dir = mkdtempSync(join(tmpdir(), 'h1-world-'));
    this.w = new World(script, mods, this.dir);
    this.touched = false;
    this.built = Boolean(script.engineBuilt);
    this.counters = new Map();
    const w = this.w;
    const raw = deepMerge(BASE_CONFIG, script.settings ?? {});
    raw.storage = { db_path: join(this.dir, 'trades.db') };
    this.settingsPath = join(this.dir, 'settings.json');
    this.baseRaw = raw;
    writeFileSync(this.settingsPath, JSON.stringify(raw, null, 2));
    this.settings = mods.config.loadSettings(this.settingsPath);
    this.store = new mods.store.TradeStore(this.settings.db_path);
    this.killswitch = new mods.killswitch.KillSwitch(join(this.dir, 'breaker.json'), this.settings.policies.consecutive_failure_breaker);
    this.bundle = mods.prompts.loadPromptBundle(this.settings);
    this.routerObj = null;
    this.engineObj = this.makeEngine();
    this.services = structuredClone(script.services ?? {});
    this.alerts = this.makeAlerts();
    this.brokerLink = this.makeBrokerLink();
    this.lockChain = Promise.resolve();
    this.ctx = this.makeCtx();
    this.secretsCfg = structuredClone(script.secrets ?? {});
    mods.secrets.useSecretBackend({
      exists: async (service, account) => {
        w.rec('keychain', 'exists', [service, account]);
        return Boolean((this.secretsCfg.exists ?? {})[`${service}|${account}`]);
      },
      read: async (service, account) => { w.rec('keychain', 'read', [service, account]); return null; },
      write: async (service, account, secret) => {
        w.rec('keychain', 'write', [service, account, secret]);
        if (this.secretsCfg.writeError !== undefined) throw new mods.secrets.KeychainError(this.secretsCfg.writeError);
      },
    });
    if (script.router) this.routerObj = this.makeRouter(structuredClone(dec(script.router)));
    this.domains = [
      new mods.trackerH.TrackerHandlers(this.ctx), new mods.tradingH.TradingHandlers(this.ctx), new mods.connectionH.ConnectionHandlers(this.ctx),
      new mods.settingsH.SettingsHandlers(this.ctx), new mods.systemH.SystemHandlers(this.ctx),
    ];
    this.table = Object.create(null);
    for (const d of this.domains) for (const [n, fn] of Object.entries(d.methods())) this.table[n] = fn;
    this.engineSet(script.engine ?? {});
  }

  // ---- 脚本驱动的结果
  /** 取下一个结果(key = 方法名或 方法名:参数键);没写 dflt 的方法没脚本就是脚本写错了 */
  next(owner, cfg, name, key, dflt) {
    const results = cfg ?? {};
    const k = key !== undefined && results[`${name}:${key}`] ? `${name}:${key}` : name;
    if (!results[k] && dflt === undefined) throw new Error(`handlers1_world: ${owner}.${name} 未脚本`);
    const list = results[k] && results[k].length ? results[k] : [{ value: dflt }];
    const id = `${owner}.${k}`;
    const i = this.counters.get(id) ?? 0;
    this.counters.set(id, i + 1);
    return list[Math.min(i, list.length - 1)];
  }

  fail(r) {
    const m = this.mods;
    switch (r.cls ?? 'Error') {
      case 'BrokerError': return new m.broker.BrokerError(r.error);
      case 'RpcError': return new m.rpcError.RpcError(r.code, r.error);
      case 'KeychainError': return new m.secrets.KeychainError(r.error);
      default: return new Error(r.error);
    }
  }

  /** 异步方法:记一条日志,按结果延迟 / 挂住 / 抛错 / 给值 */
  async ask(owner, cfg, name, args, key, dflt) {
    this.w.rec(owner, name, args);
    const r = this.next(owner, cfg, name, key, dflt);
    if (r.hang) await new Promise(() => {});
    if (r.delay) await this.w.sleep(r.delay);
    if (r.error !== undefined) throw this.fail(r);
    return structuredClone(dec(r.value));
  }

  /** 同步方法 */
  askSync(owner, cfg, name, args, key, dflt) {
    this.w.rec(owner, name, args);
    const r = this.next(owner, cfg, name, key, dflt);
    if (r.error !== undefined) throw this.fail(r);
    return structuredClone(dec(r.value));
  }

  // ---- 引擎替身
  makeEngine() {
    const self = this;
    const results = () => self.engineResults;
    const o = {
      get store() { return self.store; },
      get killswitch() { return self.killswitch; },
      notifier: { warning: (m) => self.w.rec('notifier', 'warning', [m]) },
      get bundle() { return self.bundle; },
      trackerLoop: {},
      pendingTriggers: [],
      sessionEm: { today: (now) => self.askSync('engine', results(), 'sessionEm.today', [now], undefined, null) },
      trackerHeartbeat: () => self.askSync('engine', results(), 'trackerHeartbeat', [], undefined, {}),
      pollTrackers: () => self.ask('engine', results(), 'pollTrackers', []),
      syncHosted: () => self.ask('engine', results(), 'syncHosted', []),
      naturalCloseFor: (raw, position, rows) => self.ask('engine', results(), 'naturalCloseFor', [raw, position, rows]),
      marketStatusFor: (raw, at) => self.ask('engine', results(), 'marketStatusFor', [raw, at]),
      accountIsPaper: (alias) => self.askSync('engine', results(), 'accountIsPaper', [alias]),
      sweepExisting: (track, reason) => self.ask('engine', results(), 'sweepExisting', [track, reason]),
      pendingCloseRecord: (track) => self.askSync('engine', results(), 'pendingCloseRecord', [track], undefined, null),
      closePosition: (track, position, auto, result, status) => self.ask('engine', results(), 'closePosition', [track, position, auto, result, status]),
      handleInstruction: (text, channel, moment, snapshot, accounts, dryRun) =>
        self.ask('engine', results(), 'handleInstruction', [text, channel, moment ?? null, snapshot ?? null, accounts ?? null, dryRun]),
      syncBrokerOrders: () => self.ask('engine', results(), 'syncBrokerOrders', [], undefined, 0),
      firePending: (prices) => self.ask('engine', results(), 'firePending', [prices]),
      expirePending: () => self.askSync('engine', results(), 'expirePending', [], undefined, 0),
      halt: (reason) => self.ask('engine', results(), 'halt', [reason]),
      protectionState: (nowMs) => self.askSync('engine', results(), 'protectionState', [nowMs], undefined, { pause: null, cooldowns: {}, accountPauses: {} }),
    };
    return o;
  }

  engineSet(set) {
    const o = this.engineObj;
    if (set.results !== undefined) {
      this.engineResults = this.engineResults ?? {};
      for (const [k, v] of Object.entries(structuredClone(set.results))) {
        this.engineResults[k] = v;
        this.counters.delete(`engine.${k}`);
      }
    }
    if (this.engineResults === undefined) this.engineResults = {};
    if (set.loop !== undefined) o.trackerLoop = structuredClone(dec(set.loop));
    if (set.pending !== undefined) o.pendingTriggers = structuredClone(dec(set.pending));
  }

  // ---- router 替身
  makeRouter(cfg) {
    const self = this;
    const r = {
      cfg,
      sessions: () => Array.from({ length: r.cfg.sessions ?? 1 }, () => ({})),
      get upstreamOk() { self.w.rec('router', 'upstreamOk', []); return r.cfg.upstreamOk ?? true; },
      connectedNames: () => { self.w.rec('router', 'connectedNames', []); return [...(r.cfg.connected ?? [])]; },
      positions: () => self.ask('router', r.cfg.results, 'positions', []),
      indexPrice: (symbol) => self.ask('router', r.cfg.results, 'indexPrice', [symbol], symbol),
      disconnectAll: () => self.ask('router', r.cfg.results, 'disconnectAll', [], undefined, null),
    };
    // 这三个方法"有没有"随脚本现在的样子(typeof router.x === "function" 要能被 routerSet 改)
    Object.defineProperty(r, 'spotInfo', {
      enumerable: true,
      get() {
        if (r.cfg.spotInfo === undefined) return undefined;
        return (symbol) => {
          self.w.rec('router', 'spotInfo', [symbol]);
          const v = (r.cfg.spotInfo ?? {})[symbol];
          return v === undefined ? null : structuredClone(dec(v));
        };
      },
    });
    Object.defineProperty(r, 'streamQuotes', {
      enumerable: true,
      get() { return r.cfg.streamQuotes ? (symbols) => self.ask('router', r.cfg.results, 'streamQuotes', [symbols], symbols.join(',')) : undefined; },
    });
    Object.defineProperty(r, 'optionQuotes', {
      enumerable: true,
      get() { return r.cfg.optionQuotes ? async () => ({}) : undefined; },
    });
    return r;
  }

  routerSet(set) {
    const r = this.routerObj;
    if (!r) return;
    for (const [k, v] of Object.entries(structuredClone(dec(set)))) {
      if (k === 'results') for (const [rk, rv] of Object.entries(v)) { (r.cfg.results ??= {})[rk] = rv; this.counters.delete(`router.${rk}`); }
      else r.cfg[k] = v;
    }
  }

  // ---- 服务替身
  makeAlerts() {
    const self = this;
    const cfg = () => self.services.alerts?.results ?? {};
    return {
      adoptTracked: (symbols) => self.askSync('alerts', cfg(), 'adoptTracked', [symbols], undefined, []),
      adoptForTrack: (symbol) => self.askSync('alerts', cfg(), 'adoptForTrack', [symbol], undefined, null),
      releaseForTrack: (set) => self.askSync('alerts', cfg(), 'releaseForTrack', [[...set].sort()], undefined, []),
    };
  }

  makeBrokerLink() {
    const self = this;
    const cfg = () => self.services.brokerLink?.results ?? {};
    return {
      connect: (names) => self.ask('brokerLink', cfg(), 'connect', [names ?? null]),
      disconnect: () => self.ask('brokerLink', cfg(), 'disconnect', [], undefined, null),
      forget: () => { self.w.rec('brokerLink', 'forget', []); },
    };
  }

  // ---- 上下文
  makeCtx() {
    const self = this;
    const w = this.w;
    return {
      get settings() { return self.settings; },
      set settings(v) { w.rec('ctx', 'setSettings', []); self.settings = v; },
      get router() { return self.routerObj; },
      set router(v) { w.rec('ctx', 'setRouter', [v === null ? null : 'router']); self.routerObj = v; },
      get engine() { self.touched = true; self.built = true; return self.engineObj; },
      get engineBuilt() { return self.built ? self.engineObj : null; },
      parserFactory: () => { throw new Error('handlers1_world: parserFactory 不该被碰'); },
      reload() {
        w.rec('ctx', 'reload', []);
        self.settings = self.mods.config.loadSettings(self.settingsPath);
        w.rec('ctx', 'dropEngine', []);
      },
      dropEngine() { w.rec('ctx', 'dropEngine', []); },
      trackerLock(fn) {
        const run = self.lockChain.then(fn, fn);
        self.lockChain = run.then(() => undefined, () => undefined);
        return run;
      },
      emit: (event, payload) => w.rec('ctx', 'emit', [event, payload]),
      alerts: this.alerts,
      brokerLink: this.brokerLink,
      market: null,
    };
  }

  /** server.ts handleInner 的信封映射 */
  async dispatch(method, params) {
    const m = this.mods;
    try {
      const fn = this.table[method];
      if (typeof fn !== 'function') throw new m.rpcError.RpcError(-32601, `未知方法:${method}`);
      return { result: enc(await fn(params)) };
    } catch (exc) {
      if (exc instanceof m.rpcError.RpcError) return { error: { code: exc.code, message: exc.message } };
      if (exc instanceof m.secrets.KeychainError) return { error: { code: -32008, message: exc.message } };
      return { error: { code: -32000, message: `${exc.constructor.name}: ${exc.message}` } };
    }
  }

  close() {
    this.mods.secrets.useSecretBackend(null);
    try { this.store.db.close(); } catch { /* 已关 */ }
    this.w.restore();
  }
}

export async function runHandlers(script, mods) {
  const world = new Handlers1World(script, mods);
  const { w } = world;
  try {
    const started = new Map();
    const reported = new Set();
    const steps = [];
    const dump = script.dump ?? DEFAULT_DUMP;
    const fileNames = script.files ?? [];
    let prev = dumpTables(world.store.db, dump);
    let prevFiles = dumpFiles(world.dir, fileNames);
    const sub = (v) => JSON.parse(JSON.stringify(v ?? {}).split('$DIR').join(world.dir));
    for (const step of script.steps) {
      const rec = { op: step.op };
      world.touched = false;
      switch (step.op) {
        case 'advance': await w.advance(step.ms); break;
        case 'call': {
          const st = { done: false };
          const params = sub(step.a);
          const p = world.dispatch(step.m, params);
          p.then((v) => { st.done = true; st.value = v; });
          started.set(step.id, st);
          break;
        }
        case 'config': {
          const raw = deepMerge(JSON.parse(readFileSync(world.settingsPath, 'utf-8')), step.patch);
          writeFileSync(world.settingsPath, JSON.stringify(raw, null, 2));
          world.settings = world.mods.config.loadSettings(world.settingsPath);
          break;
        }
        case 'router': world.routerObj = step.v === 'make' ? world.makeRouter(structuredClone(dec(script.router ?? {}))) : null; break;
        case 'routerSet': world.routerSet(step.set); break;
        case 'engineSet': world.engineSet(step.set); break;
        case 'servicesSet': {
          for (const [svc, set] of Object.entries(step.set)) {
            const cfg = (world.services[svc] ??= { results: {} });
            cfg.results ??= {};
            for (const [k, v] of Object.entries(set.results ?? {})) { cfg.results[k] = v; world.counters.delete(`${svc}.${k}`); }
          }
          break;
        }
        case 'secrets': Object.assign(world.secretsCfg, step.set); break;
        case 'store': {
          try {
            const target = world.store;
            const v = target[step.m](...structuredClone(dec(step.a ?? [])));
            rec.value = enc(v === undefined ? null : v);
          } catch (e) { rec.value = { error: String(e?.message ?? e) }; }
          break;
        }
        case 'killswitch': {
          try { const v = world.killswitch[step.m](...structuredClone(dec(step.a ?? []))); rec.value = enc(v === undefined ? null : v); } catch (e) { rec.value = { error: String(e?.message ?? e) }; }
          break;
        }
        case 'file': writeFileSync(join(world.dir, step.path), step.content); break;
        case 'get': {
          if (step.what === 'breaker') rec.value = enc(world.killswitch.state());
          else throw new Error(`不认识的读取 ${step.what}`);
          break;
        }
        default: throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const done = [];
      for (const [id, st] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (st.done && !reported.has(id)) { reported.add(id); done.push({ id, result: st.value }); }
      }
      if (done.length) rec.done = done;
      const now = dumpTables(world.store.db, dump);
      const changed = {};
      for (const t of dump) if (JSON.stringify(now[t]) !== JSON.stringify(prev[t])) changed[t] = now[t];
      if (Object.keys(changed).length) rec.store = enc(changed);
      prev = now;
      const nowFiles = dumpFiles(world.dir, fileNames);
      const changedFiles = {};
      for (const [k, v] of Object.entries(nowFiles)) if (prevFiles[k] !== v) changedFiles[k] = v;
      if (Object.keys(changedFiles).length) rec.files = changedFiles;
      prevFiles = nowFiles;
      if (world.touched) rec.engine = true;
      rec.T = w.T;
      steps.push(rec);
    }
    // sortLog:同一虚拟时刻内的先后不比(追踪锁交棒时,JS 让上一个调用方的续跑先于下一个持锁者,C++ 的 SerialLock 反过来——见 tracker_handlers.h)
    const log = script.sortLog ? [...w.log].sort((a, b) => (a.t - b.t) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)) : w.log;
    return JSON.parse(JSON.stringify({ log, steps }).split(JSON.stringify(world.dir).slice(1, -1)).join('<DIR>'));
  } finally {
    world.close();
    rmSync(world.dir, { recursive: true, force: true });
  }
}

/** 拉齐要的模块(handler 类、配置、熔断、凭证库、提示词) */
export async function loadHandlerMods(engineDir) {
  const mods = await loadMods(engineDir);
  const names = {
    killswitch: 'killswitch', prompts: 'prompts', secrets: 'secrets', trackerH: 'rpc/handlers/tracker', tradingH: 'rpc/handlers/trading',
    connectionH: 'rpc/handlers/connection', settingsH: 'rpc/handlers/settings', systemH: 'rpc/handlers/system',
  };
  for (const [k, f] of Object.entries(names)) mods[k] = await mods.imp(f);
  return mods;
}
