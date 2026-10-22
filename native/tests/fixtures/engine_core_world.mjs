// engine_core 簇(engine-ts/src/engine.ts 的 TradingEngine 整体)对拍用的"世界"的 JS 一半:虚拟的钟与计时器、可复现的 id、
// 真的交易库(TradeStore,临时目录)与真的熔断开关(KillSwitch)、挂了 sink 的通知器、脚本驱动的假解析器与假 router(含假会话),
// 以及把一份脚本交给**原 TS 的 TradingEngine**(engine-ts/dist/src/engine.js)现跑、把每一次对 router / 解析器 / 库 / 通知 / 熔断的调用
// (方法、参数、虚拟时刻、先后次序)与各步的结果、内部状态、整个库的最终样子记下来的跑法。C++ 那边(tests/engine_core_world.h)读同一份脚本、解释得一模一样、逐项精确比较。
// 改这个文件就要同时改 engine_core_world.h。基础设施(enc / dec / rng / BASE_CONFIG / deepMerge / drain)借 engine_world.mjs 的。
//
// ---- 约定
//  · 时间:Date.now() 是虚拟钟 T;setTimeout / clearTimeout 也是虚拟的。只有 advance / sleep 步让钟走(sleep 让墙钟走、"醒着的钟"不走 = 电脑睡了一觉)。
//    每一步先启动,再让一个宏任务(drain);没完成的步骤记 {pending:true},以后某次 advance 里完成时在日志里记一条 {c:"done", s:步号, r:结果}。
//  · 日志 {s:步号, t:虚拟时刻, c:类, m:方法, a:参数}:c = router / parser / store / notify / breaker / log(stderr 的一行)/ tick(onTrackerTick 回调)。
//  · 脚本字符串里的 `${track:名字}` / `${rec:名字}` 在用之前换成那条追踪 / 记录的 id。
//
// ---- 脚本
//  { name, start, settings: <补丁>, router: null | {caps, rows, prices, legQuotes, cancelCount, quoteCap, optionQuotes, stream, spotInfo, hours, cachedHours, connected,
//      sessions:[{name, caps}], covered, coveredIds, hostedOpen, openOrders, execRows, nextId, perm, placeStatus, pollUpdates, behaviors},
//    parser: {behaviors:{parse:[…]}}, publicPrices: {代码: 价|null}, setup: [步…], steps: [步…] }
//  behaviors:{方法名: [{emit:[步…], delay:ms, hang:true, error:{cls:"Error"|"Broker"|"LinkDown"|"LLM", msg}, ret:值, res:{…}, text, payload, model, usage, latency, repeat:true}…]}
//  步:{op, …} 见 doOp。
import cryptoDefault from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import osDefault from 'node:os';
import { BASE_CONFIG, deepMerge, drain, enc } from './engine_world.mjs';

export { BASE_CONFIG, enc };

/** 日志里的参数:按 JSON 的样子(undefined 没有、NaN 是 null) */
const jn = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

export async function loadCore(engineDir) {
  const imp = (f) => import(pathToFileURL(join(engineDir, `dist/src/${f}.js`)).href);
  const names = ['engine', 'engine/hosted', 'store', 'killswitch', 'notify', 'tracker', 'config', 'broker', 'ibLink', 'py', 'providers', 'prompts', 'protections'];
  const [engine, hosted, store, killswitch, notify, tk, config, broker, ibLink, py, providers, prompts, protections] = await Promise.all(names.map(imp));
  const Database = createRequire(join(engineDir, 'package.json'))('better-sqlite3');
  return { engine, hosted, store, killswitch, notify, tk, config, broker, ibLink, py, providers, prompts, protections, Database };
}

const LOGGED_STORE = new Set(['updateTrack', 'audit', 'createRecord', 'markSubmitIntent', 'appendEvent', 'setFinalStatus', 'rememberFills',
  'listTracks', 'getTrack', 'getRecord', 'listWorkingRecords', 'fillsByOrderRef', 'recentCloses', 'realizedPnlEvents']);
const LOGGED_RISK = new Set(['recentOrderDetails', 'workingOrders', 'dailyLossTrips']);
const DUMP_TABLES = ['trade_records', 'record_events', 'audit_log', 'position_tracks', 'broker_fills'];

const followAls = new AsyncLocalStorage();
class FollowLocalOnlyError extends Error {}

class World {
  constructor(script, mods, dir) {
    this.script = script;
    this.mods = mods;
    this.dir = dir;
    this.T = script.start;
    this.slept = 0;
    this.timers = [];
    this.seq = 0;
    this.log = [];
    this.stepNo = -1;
    this.uuidN = 0;
    this.names = { track: {}, rec: {} };
    this.pendingOps = new Map();
    this.prevSnap = '';
    this.saved = {};
    this.publicPrices = script.publicPrices ?? {};
  }

  get mono() { return 1_000_000 + this.T - this.slept; }

  // ---- 虚拟钟与计时器
  install() {
    const w = this;
    const RealDate = Date;
    const nodeOs = createRequire(import.meta.url)('node:os');
    this.saved = { Date: globalThis.Date, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, uuid: cryptoDefault.randomUUID, cpus: nodeOs.cpus, write: process.stderr.write, nodeOs };
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(w.T); else super(...a); }
      static now() { return w.T; }
    }
    globalThis.Date = FakeDate;
    globalThis.setTimeout = (fn, ms) => { const t = { at: w.T + Math.max(1, Math.trunc(ms)), seq: ++w.seq, fn, dead: false }; w.timers.push(t); return t; };
    globalThis.clearTimeout = (t) => { if (t) t.dead = true; };
    cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++w.uuidN).padStart(12, '0')}`;
    nodeOs.cpus = () => [{ times: { user: w.mono, nice: 0, sys: 0, idle: 0, irq: 0 } }];
    process.stderr.write = (chunk) => { w.rec({ c: 'log', a: [String(chunk).replace(/\n$/, '')] }); return true; };
    syncBuiltinESMExports();
  }

  restore() {
    globalThis.Date = this.saved.Date;
    globalThis.setTimeout = this.saved.setTimeout;
    globalThis.clearTimeout = this.saved.clearTimeout;
    cryptoDefault.randomUUID = this.saved.uuid;
    this.saved.nodeOs.cpus = this.saved.cpus;
    process.stderr.write = this.saved.write;
    syncBuiltinESMExports();
  }

  sleepTimer(ms) { return new Promise((res) => { this.timers.push({ at: this.T + Math.max(1, Math.trunc(ms)), seq: ++this.seq, fn: res, dead: false }); }); }

  async advance(ms) {
    const end = this.T + ms;
    for (;;) {
      const live = this.timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!live.length) break;
      const t = live[0];
      t.dead = true;
      this.T = Math.max(this.T, t.at);
      t.fn();
      await drain();
      this.collectDone();
    }
    this.T = end;
    await drain();
    this.collectDone();
    this.timers = this.timers.filter((t) => !t.dead);
  }

  rec(entry) { this.log.push({ s: this.stepNo, t: this.T, ...entry }); }

  // ---- 搭建
  build() {
    const { mods } = this;
    const raw = deepMerge(BASE_CONFIG, this.script.settings ?? {});
    raw.storage = { db_path: join(this.dir, 'trades.db') };
    this.rawSettings = raw;
    this.settings = mods.config.fromDict(raw);
    const real = new mods.store.TradeStore(this.settings.db_path);
    this.realStore = real;
    const w = this;
    const proxyOf = (target, logged, extraRisk) => new Proxy(target, {
      get(t, prop) {
        const v = t[prop];
        if (extraRisk && prop === 'risk') return proxyOf(v, LOGGED_RISK, false);
        if (typeof v !== 'function') return v;
        if (!logged.has(prop)) return v.bind(t);
        return (...args) => {
          const a = jn(args);
          const r = v.apply(t, args);
          const entry = { c: 'store', m: prop, a };
          if (prop === 'createRecord' || prop === 'updateTrack' || prop === 'rememberFills') entry.r = r;
          w.rec(entry);
          return r;
        };
      },
    });
    this.store = proxyOf(real, LOGGED_STORE, true);
    const ksReal = new mods.killswitch.KillSwitch(join(this.dir, 'breaker.json'), this.settings.policies.consecutive_failure_breaker);
    this.ksReal = ksReal;
    const bs = (s) => ({ engaged: s.engaged, reason: s.reason, consecutive_failures: s.consecutive_failures, consecutive_parse_failures: s.consecutive_parse_failures, auto: s.auto });
    this.bs = bs;
    this.ks = {
      state() { const s = ksReal.state(); w.rec({ c: 'breaker', m: 'state', r: bs(s) }); return s; },
      recordFailure(reason, kind) { const r = ksReal.recordFailure(reason, kind); w.rec({ c: 'breaker', m: 'recordFailure', a: [reason, kind], r: r ? bs(r) : null }); return r; },
      recordSuccess(kind) { ksReal.recordSuccess(kind); w.rec({ c: 'breaker', m: 'recordSuccess', a: [kind] }); },
      engage(reason, auto) { return ksReal.engage(reason, auto); },
      release() { return ksReal.release(); },
    };
    this.notifier = new mods.notify.Notifier(false, [(title, subtitle, body) => w.rec({ c: 'notify', a: [title, subtitle, body] })]);
    this.parser = this.makeParser(this.script.parser ?? {});
    this.router = this.script.router === null || this.script.router === undefined ? null : this.makeRouter(this.script.router);
    this.bundle = mods.prompts.loadPromptBundle(this.settings);
    this.engine = new mods.engine.TradingEngine({ settings: this.settings, parser: this.parser, store: this.store, notifier: this.notifier, killswitch: this.ks, router: this.router, bundle: this.bundle });
    this.engine.publicPriceFn = async (symbol) => { w.rec({ c: 'host', m: 'publicPrice', a: [symbol] }); const v = w.publicPrices[symbol]; return v === undefined ? null : v; };
    this.engine.onTrackerTick = (poll, hosted) => w.rec({ c: 'tick', a: jn([poll, hosted]) });
  }

  behaviorQueue(state) {
    const next = (method) => {
      const q = state.behaviors[method];
      if (!q || !q.length) return {};
      const i = state.cursor[method] ?? 0;
      if (i < q.length) { state.cursor[method] = i + 1; return q[i]; }
      return q[q.length - 1].repeat ? q[q.length - 1] : {};
    };
    const mk = (b) => {
      const { mods } = this;
      if (b.cls === 'LinkDown') return new mods.ibLink.LinkDownError();
      if (b.cls === 'Broker') return new mods.broker.BrokerError(b.msg);
      if (b.cls === 'Plan') return new mods.hosted.HostedPlanError(b.msg);
      if (b.cls === 'LLM') return new mods.providers.LLMError(b.msg);
      return new Error(b.msg);
    };
    const behave = async (b) => {
      if (b.emit) for (const e of b.emit) this.fireEvent(e);
      if (b.delay) await this.sleepTimer(b.delay);
      if (b.hang) await new Promise(() => undefined);
      if (b.error) throw mk(b.error);
    };
    return { next, behave };
  }

  makeParser(cfg) {
    const w = this;
    const state = { behaviors: cfg.behaviors ?? {}, cursor: {} };
    const { next, behave } = this.behaviorQueue(state);
    return {
      async parse(bundle, userMessage) {
        if (followAls.getStore() === true) throw new FollowLocalOnlyError('跟单只认本地速记,这一条没有被完整接住,没有交给大模型');
        w.rec({ c: 'parser', m: 'parse', a: [bundle.version, userMessage] });
        const b = next('parse');
        await behave(b);
        const text = b.text !== undefined ? b.text : JSON.stringify(b.payload ?? { orders: [], rejections: [] });
        return new w.mods.providers.LLMResponse(text, b.model ?? 'claude-opus-5', bundle.version, w.mods.prompts.fingerprint(bundle), b.latency ?? 42, b.usage ?? {}, 'json_schema');
      },
    };
  }

  makeRouter(cfg) {
    const w = this;
    const caps = { hosted: true, listHostedOpen: true, modifyHosted: true, ...(cfg.caps ?? {}) };
    const state = {
      rows: structuredClone(cfg.rows ?? []), covered: cfg.covered ?? null, coveredIds: cfg.coveredIds ?? null, hostedOpen: cfg.hostedOpen ?? [], openOrders: cfg.openOrders ?? [],
      execRows: cfg.execRows ?? [], nextId: cfg.nextId ?? 500, perm: cfg.perm ?? false, placeStatus: cfg.placeStatus ?? 'PreSubmitted', behaviors: cfg.behaviors ?? {}, cursor: {},
      prices: cfg.prices ?? {}, legQuotes: cfg.legQuotes ?? [], cancelCount: cfg.cancelCount ?? 0, quoteCap: cfg.quoteCap ?? {}, optionQuotes: cfg.optionQuotes ?? {},
      stream: cfg.stream ?? {}, spotInfo: cfg.spotInfo ?? {}, hours: cfg.hours ?? null, cachedHours: cfg.cachedHours ?? {}, connected: cfg.connected ?? [], pollUpdates: cfg.pollUpdates ?? [],
      sessionDefs: cfg.sessions ?? [],
    };
    const { next, behave } = this.behaviorQueue(state);
    const sub = (x) => w.subst(x);
    const sessions = state.sessionDefs.map((d) => w.makeSession(d));
    const r = {
      state,
      get SUPPORTS_HOSTED_CLOSE() { return caps.hosted; },
      sessions() { return r.sessionList; },
      sessionList: sessions,
      async positions() { w.rec({ c: 'router', m: 'positions' }); const b = next('positions'); await behave(b); return sub(state.rows).map((x) => ({ ...x })); },
      async indexPrice(symbol) {
        w.rec({ c: 'router', m: 'indexPrice', a: [symbol] }); const b = next('indexPrice'); await behave(b);
        if (b.ret !== undefined) return b.ret;
        const v = state.prices[symbol]; return v === undefined ? null : v;
      },
      async legQuotes(contract, account) {
        w.rec({ c: 'router', m: 'legQuotes', a: jn([contract, account.alias]) }); const b = next('legQuotes'); await behave(b);
        return b.ret !== undefined ? b.ret : structuredClone(state.legQuotes);
      },
      async place(recordId, approved, limitOverride = null) {
        w.rec({ c: 'router', m: 'place', a: jn([recordId, approved.account.alias, approved.account.account_id, approved.account.is_paper, approved.order, approved.notional, approved.signature, approved.warnings, limitOverride]) });
        const b = next('place');
        await behave(b);
        state.nextId += 1;
        const id = state.nextId;
        return { record_id: recordId, order_id: id, perm_id: state.perm ? 9000 + id : null, status: state.placeStatus, limit_price: limitOverride, detail: {}, ...(b.res ?? {}) };
      },
      async cancelAllOpen() { w.rec({ c: 'router', m: 'cancelAllOpen' }); const b = next('cancelAllOpen'); await behave(b); return b.ret !== undefined ? b.ret : state.cancelCount; },
      async placeHosted(account, contract, item, oca, ref) {
        w.rec({ c: 'router', m: 'placeHosted', a: jn([account.alias, account.account_id, account.is_paper, contract, item, oca, ref]) });
        const b = next('placeHosted');
        await behave(b);
        state.nextId += 1;
        const id = state.nextId;
        return { order_id: id, perm_id: state.perm ? 9000 + id : null, status: state.placeStatus, ...(b.res ?? {}) };
      },
      async cancelHosted(orderId) { w.rec({ c: 'router', m: 'cancelHosted', a: [orderId] }); const b = next('cancelHosted'); await behave(b); return b.ret !== undefined ? b.ret : true; },
    };
    if (caps.modifyHosted) r.modifyHosted = async (orderId, item) => { w.rec({ c: 'router', m: 'modifyHosted', a: jn([orderId, item]) }); const b = next('modifyHosted'); await behave(b); return b.ret !== undefined ? b.ret : true; };
    if (caps.native !== undefined) r.SUPPORTS_NATIVE_CONDITIONS = caps.native;
    if (caps.listHostedOpen) r.listHostedOpen = async (refPrefix) => { w.rec({ c: 'router', m: 'listHostedOpen', a: [refPrefix === undefined ? null : refPrefix] }); await behave(next('listHostedOpen')); return sub(state.hostedOpen).map((x) => ({ ...x })); };
    if (caps.listOpenOrders) r.listOpenOrdersDetailed = async () => { w.rec({ c: 'router', m: 'listOpenOrdersDetailed' }); await behave(next('listOpenOrdersDetailed')); return sub(state.openOrders).map((x) => ({ ...x })); };
    if (caps.executions) r.executions = async () => { w.rec({ c: 'router', m: 'executions' }); await behave(next('executions')); return sub(state.execRows).map((x) => ({ ...x })); };
    if (caps.coveredAccounts) r.coveredAccounts = () => (state.covered === null ? null : new Set(state.covered));
    if (caps.coveredIds) r.coveredAccountIds = () => (state.coveredIds === null ? null : new Set(state.coveredIds));
    if (caps.quoteCapability) r.quoteCapability = (symbol) => { w.rec({ c: 'router', m: 'quoteCapability', a: [symbol] }); const v = state.quoteCap[symbol]; return v === undefined ? null : v; };
    if (caps.optionQuotes) r.optionQuotes = async (rows) => {
      w.rec({ c: 'router', m: 'optionQuotes', a: jn([rows.map((x) => x.key)]) }); const b = next('optionQuotes'); await behave(b);
      const out = {};
      for (const row of rows) if (state.optionQuotes[row.key] !== undefined) out[row.key] = { ...state.optionQuotes[row.key] };
      return b.ret !== undefined ? b.ret : out;
    };
    if (caps.qualify) r.qualify = async (contract, account) => { w.rec({ c: 'router', m: 'qualify', a: jn([contract, account.alias]) }); await behave(next('qualify')); return {}; };
    if (caps.spotInfo) r.spotInfo = (symbol) => { const v = state.spotInfo[symbol]; return v === undefined ? null : { ...v }; };
    if (caps.streamQuotes) r.streamQuotes = (symbols) => {
      w.rec({ c: 'router', m: 'streamQuotes', a: [symbols] });
      const out = {};
      for (const s of symbols) if (state.stream[s] !== undefined) out[s] = { ...state.stream[s] };
      return out;
    };
    if (caps.contractHours) r.contractHours = async (row, account) => { w.rec({ c: 'router', m: 'contractHours', a: jn([row.key, account.alias]) }); await behave(next('contractHours')); return state.hours; };
    if (caps.cachedHours) r.cachedContractHours = (symbol, expiry) => { const v = state.cachedHours[`${symbol}|${expiry}`]; return v === undefined ? null : v; };
    if (caps.connected) r.connectedNames = () => [...state.connected];
    if (caps.poll) r.pollOrderUpdates = async () => { w.rec({ c: 'router', m: 'pollOrderUpdates' }); const b = next('pollOrderUpdates'); await behave(b); return structuredClone(state.pollUpdates); };
    return r;
  }

  makeSession(def) {
    const w = this;
    const caps = { status: true, fill: true, commission: true, error: true, ...(def.caps ?? {}) };
    const s = { name: def.name, h: {} };
    if (caps.status) s.onOrderStatus = (cb) => { s.h.status = cb; };
    if (caps.fill) s.onFill = (cb) => { s.h.fill = cb; };
    if (caps.commission) s.onCommission = (cb) => { s.h.commission = cb; };
    if (caps.error) s.onError = (cb) => { s.h.error = cb; };
    s.w = w;
    return s;
  }

  nameOfTrack(id) { for (const [n, v] of Object.entries(this.names.track)) if (v === id) return n; return id; }

  // ---- 回报事件(也是 router 行为里 emit 的步)
  fireEvent(e) {
    const sub = (x) => this.subst(x);
    const eng = this.engine;
    if (e.op === 'status') eng.onOrderStatus(sub(e.trade));
    else if (e.op === 'error') eng.onIbError(sub(e.reqId), sub(e.code), sub(e.message));
    else if (e.op === 'exec') eng.onExecDetails(sub(e.trade), sub(e.fill));
    else if (e.op === 'commission') eng.onCommission(sub(e.trade), sub(e.fill), sub(e.report));
    else if (e.op === 'deleteTrack') this.realStore.deleteTrack(this.names.track[e.track]);
    else if (e.op === 'updateTrack') this.store.updateTrack(this.names.track[e.track], sub(e.fields));
    else if (e.op === 'rows') this.router.state.rows = sub(e.set);
    else throw new Error(`脚本写错:emit 里不认识的步 ${e.op}`);
  }

  subst(x) {
    if (typeof x === 'string') {
      return x.replace(/\$\{(track|rec):([^}]+)\}/g, (_m, kind, name) => {
        const id = this.names[kind][name];
        if (id === undefined) throw new Error(`脚本写错:没有 ${kind} ${name}`);
        return id;
      });
    }
    if (Array.isArray(x)) return x.map((v) => this.subst(v));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.subst(v)]));
    return x;
  }

  // ---- 内部状态快照
  snapshot() {
    const eng = this.engine;
    const ho = eng.hostedOrders;
    const sortedEntries = (m) => [...m.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    const hosted = {};
    for (const [tid, kinds] of ho.hosted) { hosted[tid] = {}; for (const [k, e] of kinds) hosted[tid][k] = e; }
    const retry = {};
    for (const [k, v] of sortedEntries(ho.hostedRetryAt)) retry[k] = v.warn ? { at: v.at, reason: v.reason, warn: true } : { at: v.at, reason: v.reason };
    const index = {};
    for (const [k, v] of [...ho.hostedIndex.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))) index[String(k)] = v;
    const loop = { ...eng.trackerLoop };
    delete loop.lag_last_ms; delete loop.lag_worst_ms;
    const chase = {};
    for (const [k, v] of sortedEntries(eng.closeChase)) chase[k] = v;
    const snap = {
      hosted: { hosted, hostedIndex: index, adopted: ho.hostedAdopted, lastCovered: ho.lastCovered === null ? null : [...ho.lastCovered].sort(), synced: [...ho.synced].sort(), retryAt: retry },
      orderIndex: Object.fromEntries([...eng.orderIndex.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      finalized: [...eng.finalized].sort(),
      seenFills: [...eng.seenFills].sort(),
      seenCommissions: [...eng.seenCommissions].sort(),
      unmatched: eng.unmatchedEvents.map((u) => [u[0], u[1]?.order?.orderId ?? null]),
      early: Object.fromEntries([...eng.earlyOrderErrors.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      sent: Object.fromEntries([...eng.sentOrders.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      pending: eng.pendingTriggers.map((p) => ({ record_id: p.record_id, fired: p.fired, created_at: p.created_at })),
      closeChase: chase,
      closeChaseIndex: Object.fromEntries([...eng.closeChaseIndex.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      closeChaseAdopted: eng.closeChaseAdopted,
      flyMark: Object.fromEntries(sortedEntries(eng.flyMark)),
      loop,
      reconcile: { at: eng.reconciler.reconcileAt, exec: eng.reconciler.execSyncAt === Number.NEGATIVE_INFINITY ? '-Inf' : eng.reconciler.execSyncAt },
      breaker: this.bs(this.ksReal.state()),
      tracks: this.realStore.listTracks(),
    };
    return enc(snap);
  }

  dump() {
    const db = new this.mods.Database(this.settings.db_path, { readonly: true, fileMustExist: true });
    try {
      const out = {};
      for (const name of DUMP_TABLES) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).raw().all().map((r) => r.map((c) => (Buffer.isBuffer(c) ? { blob: c.toString('hex') } : c)));
      return out;
    } finally {
      db.close();
    }
  }

  // ---- 步骤
  collectDone() {
    for (const [i, p] of this.pendingOps) {
      if (!p.done) continue;
      this.pendingOps.delete(i);
      const saved = this.stepNo;
      this.stepNo = i;
      this.rec({ c: 'done', r: p.result });
      this.stepNo = saved;
    }
  }

  async execStep(step, i, record) {
    this.stepNo = i;
    const p = { done: false, result: undefined, record };
    const promise = Promise.resolve().then(() => this.doOp(step));
    promise.then((r) => { p.result = enc(r); p.done = true; }, (e) => { p.result = { error: String(e?.message ?? e) }; p.done = true; });
    if (step.op === 'advance') await promise.catch(() => undefined);
    else await drain();
    if (p.done) return p.result;
    this.pendingOps.set(i, p);
    return { pending: true };
  }

  momentOf(step) { return step.atMs === undefined ? null : this.mods.config.etNowFromEpoch(step.atMs); }

  protectionJson(s) { return { pause: s.pause, cooldowns: s.cooldowns, accountPauses: s.accountPauses }; }

  async doOp(step) {
    const { mods, engine } = this;
    const sub = (x) => this.subst(x);
    switch (step.op) {
      case 'instruction': {
        const run = () => engine.handleInstruction(step.text, step.channel ?? 'manual', this.momentOf(step), step.snap ?? null, step.accounts ?? null, Boolean(step.dryRun));
        return step.localOnly ? followAls.run(true, run) : run();
      }
      case 'fire': return engine.firePending(sub(step.prices));
      case 'expire': return engine.expirePending(this.momentOf(step));
      case 'halt': return engine.halt(step.reason ?? 'x');
      case 'protection': return this.protectionJson(engine.protectionState(step.nowMs));
      case 'tick': await engine.trackerTickOnce(this.momentOf(step)); return null;
      case 'poll': return engine.pollTrackers(this.momentOf(step), step.rows === undefined ? null : sub(step.rows));
      case 'sync': return engine.syncHosted(step.rows === undefined || step.rows === null ? undefined : sub(step.rows));
      case 'startLoop': engine.startTrackerLoop(step.interval); return null;
      case 'stopLoop': engine.stopTrackerLoop(); return null;
      case 'heartbeat': { const h = engine.trackerHeartbeat(); delete h.event_loop_last_ms; delete h.event_loop_worst_ms; return h; }
      case 'sweep': return engine.sweepExisting(this.realStore.getTrack(this.names.track[step.track]), step.reason ?? '手动平仓');
      case 'pendingClose': return engine.pendingCloseRecord(this.realStore.getTrack(this.names.track[step.track]));
      case 'naturalClose': {
        const raw = this.router.state.rows[step.rowIndex ?? 0];
        const position = mods.tk.makePosition({ account: raw.account, symbol: raw.symbol, sec_type: raw.sec_type, quantity: raw.quantity, avg_cost: raw.avg_cost, multiplier: raw.multiplier, currency: raw.currency, market_price: raw.market_price, market_value: raw.market_value, unrealized_pnl: raw.unrealized_pnl });
        return engine.naturalCloseFor(raw, position, Object.fromEntries(mods.tk.withCombos(this.router.state.rows).map((p) => [p.key, p])));
      }
      case 'closePosition': {
        const track = this.realStore.getTrack(this.names.track[step.track]);
        const raw = this.router.state.rows[step.rowIndex ?? 0];
        const position = mods.tk.makePosition({ account: raw.account, symbol: raw.symbol, sec_type: raw.sec_type, quantity: raw.quantity, avg_cost: raw.avg_cost, multiplier: raw.multiplier, currency: raw.currency, market_price: raw.market_price, market_value: raw.market_value, unrealized_pnl: raw.unrealized_pnl });
        const result = { state: step.state ?? 'take_profit', reason: step.reason ?? '手动平仓', price: step.price === undefined ? null : step.price };
        const fired = await engine.closePosition(track, position, mods.tk.makeAutoClose(track.auto_close ?? {}), result, step.marketStatus === undefined ? undefined : step.marketStatus);
        if (fired && step.recName) this.names.rec[step.recName] = fired.record_id;
        return fired;
      }
      case 'marketStatus': return engine.marketStatusFor(this.router.state.rows[step.rowIndex ?? 0], this.momentOf(step) ?? mods.config.nowEt());
      case 'attach': return engine.attachListeners();
      case 'wire': return engine.wireSession(this.router.sessionList[step.session ?? 0]);
      case 'connect': {
        const s = this.makeSession(step.def);
        this.router.sessionList.push(s);
        if (typeof this.router.sessionHook === 'function') this.router.sessionHook(s);
        return null;
      }
      case 'session': {
        const s = this.router.sessionList[step.session ?? 0];
        const h = s.h[step.kind];
        if (!h) return { noHandler: true };
        if (step.kind === 'status') h(sub(step.trade));
        else if (step.kind === 'fill') h(sub(step.trade), sub(step.fill));
        else if (step.kind === 'commission') h(sub(step.trade), sub(step.fill), sub(step.report));
        else h(step.reqId, step.code, step.message);
        return { handled: true };
      }
      case 'syncOrders': return engine.syncBrokerOrders();
      case 'brokerCode': return engine.brokerCode();
      case 'track': {
        const t = this.realStore.addTrack(sub(step.spec));
        this.names.track[step.name] = t.id;
        return { id: t.id };
      }
      case 'updateTrack': return this.store.updateTrack(this.names.track[step.track], sub(step.fields));
      case 'deleteTrack': return this.realStore.deleteTrack(this.names.track[step.track]);
      case 'row': { Object.assign(this.router.state.rows[step.index], step.patch); return null; }
      case 'rows': { this.router.state.rows = sub(step.set); return null; }
      case 'router': {
        for (const [k, v] of Object.entries(step.set ?? {})) this.router.state[k] = sub(v);
        for (const [m, list] of Object.entries(step.push ?? {})) { this.router.state.behaviors[m] = [...(this.router.state.behaviors[m] ?? []), ...list]; }
        return null;
      }
      case 'publicPrices': this.publicPrices = step.set; return null;
      case 'settings': {
        this.rawSettings = deepMerge(this.rawSettings, step.patch);
        this.settings = mods.config.fromDict(this.rawSettings);
        engine.settings = this.settings;
        return null;
      }
      case 'breaker': {
        const k = this.ksReal;
        if (step.action === 'engage') return this.bs(k.engage(step.reason ?? 'x'));
        if (step.action === 'engageAuto') return this.bs(k.engage(step.reason ?? 'x', true));
        if (step.action === 'release') return this.bs(k.release());
        if (step.action === 'fail') { const r = k.recordFailure(step.reason ?? 'x', step.kind ?? 'broker'); return r ? this.bs(r) : null; }
        if (step.action === 'ok') { k.recordSuccess(step.kind ?? 'broker'); return null; }
        throw new Error(`脚本写错:breaker ${step.action}`);
      }
      case 'status': case 'error': case 'exec': case 'commission': this.fireEvent(step); return null;
      case 'reconcile': return engine.reconcileOrders(step.now === undefined ? this.T : step.now);
      case 'reconcileSoon': engine.reconcileSoon(); return null;
      case 'record': {
        const id = this.store.createRecord(sub(step.record));
        this.names.rec[step.name] = id;
        for (const e of step.events ?? []) this.store.appendEvent(id, e.kind, sub(e.payload));
        return { id };
      }
      case 'rawEvent': {
        this.realStore.rawExec('INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)',
          [this.names.rec[step.record], new Date(step.at).toISOString(), step.kind, JSON.stringify(sub(step.payload))]);
        return null;
      }
      case 'fills': return this.store.rememberFills(sub(step.rows));
      case 'audit': this.store.audit(step.actor, step.action, sub(step.detail)); return null;
      case 'finalize': engine.finalized.add(this.names.rec[step.rec]); return null;
      case 'advance': await this.advance(step.ms); return null;
      case 'sleep': this.T += step.ms; return null;
      case 'awake': this.T += step.ms; return null;
      default: throw new Error(`脚本写错:不认识的步 ${step.op}`);
    }
  }

  async run() {
    this.install();
    this.build();
    const steps = [];
    let n = 0;
    for (const s of this.script.setup ?? []) { const r = await this.execStep(s, -1, {}); if (r && r.error) throw new Error(`setup 失败:${JSON.stringify(r)}`); this.stepNo = -1; }
    for (const s of this.script.steps ?? []) {
      const record = { i: n, op: s.op };
      if (s.op === 'sleep') this.slept += s.ms; // 睡着的这一段"醒着的钟"不走
      record.r = await this.execStep(s, n, record);
      const snap = JSON.stringify(this.snapshot());
      if (snap !== this.prevSnap) { record.snap = JSON.parse(snap); this.prevSnap = snap; }
      steps.push(record);
      n += 1;
    }
    this.stepNo = n;
    this.collectDone();
    return { steps, log: this.log, dump: enc(this.dump()) };
  }
}

export async function runCore(script, mods) {
  const dir = mkdtempSync(join(tmpdir(), 'dafri-engc-'));
  const w = new World(structuredClone(script), mods, dir);
  try {
    return await w.run();
  } finally {
    w.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}
