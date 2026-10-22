// engine 簇(engine-ts/src/engine/ 的托管单、回报落库、执行对账、出场状态)对拍用的"世界"的 JS 一半:虚拟的钟与计时器、可复现的 id、
// 真的交易库(TradeStore,临时目录)与真的熔断开关(KillSwitch)、挂了 sink 的通知器、脚本驱动的假 router,以及把一份脚本交给**原 TS 的
// HostedOrders / IbCallbacks / Reconciler / TrackExits**(engine-ts/dist/src/engine/*.js)现跑、把每一次对 router / 库 / 通知 / 熔断 / 宿主的调用
// (方法、参数、虚拟时刻、先后次序)与各步的结果、内部状态记下来的跑法。C++ 那边(tests/engine_world.h)读同一份脚本、解释得一模一样、逐项精确比较。
// 改这个文件就要同时改 engine_world.h。宿主(下面的 host 对象)的接线照 engine.ts:回报 → callbacks → hosted(handleError / onStatus),
// hosted → host.onIbError → callbacks.onIbError,对账重建 orderIndex 之后 host.replayUnmatched → callbacks.replayUnmatched。
//
// ---- 约定(两边都靠它们对得上)
//  · 时间:Date.now() 是虚拟钟 T;setTimeout / clearTimeout 也是虚拟的。只有 advance 步让钟走;假 router 的 delay 是计时器上的等待。
//    每一步先启动,再让一个宏任务(drain:微任务全跑完);没完成的步骤记 {pending:true},以后某次 advance 里完成时在日志里记一条 {c:"done", s:步号, r:结果}。
//  · 日志 {s:步号, t:虚拟时刻, c:类, m:方法, a:参数}:参数按 JSON 的样子记(JSON.parse(JSON.stringify(x)):undefined 的键没有、NaN 是 null)。
//    c = router(假 router 上被调用的每一次)、store(交易库的写入与几个读取)、notify(通知器 sink)、breaker(熔断开关)、host(宿主上被调用的)。
//  · 步骤的结果与内部状态快照用 enc(NaN / ±Inf / -0 / undefined 写成占位串)。
//  · 脚本里字符串里的 `${track:名字}` / `${rec:名字}` 在用之前换成那条追踪 / 记录的 id(id 是 00000000-0000-4000-8000-0000000000NN,按创建先后)。
//
// ---- 脚本(scenario)
//  { name, start, settings: <深合并到基础配置上的补丁>, router: null | {caps, rows, covered, coveredIds, hostedOpen, openOrders, execRows, nextId, perm, placeStatus, behaviors},
//    host: {spotHold:{追踪名:bool}, spotTakeProfit:{追踪名:数}, naturals:{代码:数|null}, noSentLedger, chaseRejected},
//    setup: [步…], steps: [步…] }
//  caps(缺的方法就是 router 上没有那个方法):hosted(SUPPORTS_HOSTED_CLOSE,缺省 true)、coveredAccounts、coveredIds、listHostedOpen(缺省 true)、listOpenOrders、executions
//  behaviors:{方法名: [{emit:[步…], delay:ms, hang:true, error:{cls:"Error"|"Broker"|"LinkDown", msg}, ret:值, res:{order_id,perm_id,status}, repeat:true}…]}
//    每次调用取队列里下一条(用完不重复,除非最后一条 repeat);emit 里的步(status / error / exec / commission)在调用一开始同步执行。
//  步:{op, …}
//    sync{rows?} · track{name, spec} · updateTrack{track, fields} · deleteTrack{track} · row{index, patch} · rows{set} · router{set?, push?} · settings{patch}
//    breaker{action:"engage"|"engageAuto"|"release"|"fail"|"ok", reason?, kind?} · status{trade} · error{reqId, code, message} · exec{trade, fill} · commission{trade, fill, report}
//    reconcile{now?} · reconcileSoon · pending{ids} · closeChase{set?, clear?} · triggered{track, row, state, reason, spotReached?, spotStop?, rowIndex?}
//    record{name, record, events?} · rawEvent{record, kind, payload, at} · fills{rows} · advance{ms} · host{set} · clearBackoff{track} · liveKinds{track} · tpEntry{track}
//    index{map:{券商单号: 记录名}} · sent{orderId, kind, at?} · unsent · finalize{rec} · clear(hosted.clear()) · handleError{orderId, code, message}
import cryptoDefault from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
/** 日志里的参数:按 JSON 的样子(undefined 没有、NaN 是 null) */
const jn = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

/** 种子固定的随机数(xorshift32) */
export function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  return {
    next, pick: (a) => a[Math.floor(next() * a.length)], int: (n) => Math.floor(next() * n), chance: (p) => next() < p,
    range: (a, b) => a + Math.floor(next() * (b - a + 1)),
  };
}

export const BASE_CONFIG = {
  prompt_version: 'v1.8.0',
  llm: { model: 'claude-opus-5', effort: 'high', temperature: null },
  limits: { max_order_notional: 50000, max_option_contracts: 10, max_mkt_shares: 200, min_confidence: 0.9, max_spread_slippage: 0.1, max_orders_per_input: 5, duplicate_window_minutes: 10, duplicate_qty_tolerance: 0.2 },
  policies: { auto_execute: true, allow_live_trading: false, require_trigger_price_verification: true, trigger_min_gap_bps: 5, closed_market_policy: 'reject_market_orders' },
  connections: { paper: { host: '127.0.0.1', port: 7497, client_id: 11 }, live: { host: '127.0.0.1', port: 7496, client_id: 12 } },
  accounts: [
    { alias: '模拟', account_id: 'DU7654321', is_paper: true, connection: 'paper', default: true },
    { alias: '主账户', account_id: 'U1234567', is_paper: false, connection: 'live' },
    { alias: '副账户', account_id: 'U7777777', is_paper: false, connection: 'live' },
  ],
  symbol_aliases: { 苹果: 'AAPL' },
  index_symbols: { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: 'SPX', futures: 'ES', futures_exchange: 'CME' } },
  market_holidays: ['2026-09-07'],
  early_close_days: ['2026-11-27'],
};

export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? deepMerge(base[k], v) : v;
  return out;
}

export const drain = () => new Promise((r) => setImmediate(r));

export async function loadEngine(engineDir) {
  const imp = (f) => import(pathToFileURL(join(engineDir, `dist/src/${f}.js`)).href);
  const [hosted, callbacks, reconcile, exits, store, killswitch, notify, tk, config, broker, ibLink, py] = await Promise.all(
    ['engine/hosted', 'engine/callbacks', 'engine/reconcile', 'engine/exits', 'store', 'killswitch', 'notify', 'tracker', 'config', 'broker', 'ibLink', 'py'].map(imp));
  const Database = createRequire(join(engineDir, 'package.json'))('better-sqlite3');
  return { hosted, callbacks, reconcile, exits, store, killswitch, notify, tk, config, broker, ibLink, py, Database };
}

const LOGGED_STORE = new Set(['updateTrack', 'audit', 'createRecord', 'markSubmitIntent', 'appendEvent', 'setFinalStatus', 'rememberFills',
  'listTracks', 'getTrack', 'getRecord', 'listWorkingRecords', 'fillsByOrderRef']);
const DUMP_TABLES = ['trade_records', 'record_events', 'audit_log', 'position_tracks', 'broker_fills'];

class World {
  constructor(script, mods, dir) {
    this.script = script;
    this.mods = mods;
    this.dir = dir;
    this.T = script.start;
    this.timers = [];
    this.seq = 0;
    this.log = [];
    this.stepNo = -1;
    this.uuidN = 0;
    this.names = { track: {}, rec: {} };
    this.pendingOps = new Map();
    this.prevSnap = '';
    this.saved = {};
  }

  // ---- 虚拟钟与计时器
  install() {
    const w = this;
    const RealDate = Date;
    this.saved = { Date: globalThis.Date, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, uuid: cryptoDefault.randomUUID };
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(w.T); else super(...a); }
      static now() { return w.T; }
    }
    globalThis.Date = FakeDate;
    globalThis.setTimeout = (fn, ms) => { const t = { at: w.T + Math.max(1, Math.trunc(ms)), seq: ++w.seq, fn, dead: false }; w.timers.push(t); return t; };
    globalThis.clearTimeout = (t) => { if (t) t.dead = true; };
    cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++w.uuidN).padStart(12, '0')}`;
    syncBuiltinESMExports();
  }

  restore() {
    globalThis.Date = this.saved.Date;
    globalThis.setTimeout = this.saved.setTimeout;
    globalThis.clearTimeout = this.saved.clearTimeout;
    cryptoDefault.randomUUID = this.saved.uuid;
    syncBuiltinESMExports();
  }

  sleep(ms) { return new Promise((res) => { this.timers.push({ at: this.T + Math.max(1, Math.trunc(ms)), seq: ++this.seq, fn: res, dead: false }); }); }

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
    this.store = new Proxy(real, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== 'function') return v;
        if (!LOGGED_STORE.has(prop)) return v.bind(target);
        return (...args) => {
          const a = jn(args);
          const r = v.apply(target, args);
          const entry = { c: 'store', m: prop, a };
          if (prop === 'createRecord') entry.r = r;
          else if (prop === 'updateTrack') entry.r = r;
          else if (prop === 'rememberFills') entry.r = r;
          w.rec(entry);
          return r;
        };
      },
    });
    const ksReal = new mods.killswitch.KillSwitch(join(this.dir, 'breaker.json'), this.settings.policies.consecutive_failure_breaker);
    const bs = (s) => ({ engaged: s.engaged, reason: s.reason, consecutive_failures: s.consecutive_failures, consecutive_parse_failures: s.consecutive_parse_failures, auto: s.auto });
    this.bs = bs;
    this.ksReal = ksReal;
    this.ks = {
      state() { const s = ksReal.state(); w.rec({ c: 'breaker', m: 'state', r: bs(s) }); return s; },
      recordFailure(reason, kind) { const r = ksReal.recordFailure(reason, kind); w.rec({ c: 'breaker', m: 'recordFailure', a: [reason, kind], r: r ? bs(r) : null }); return r; },
      recordSuccess(kind) { ksReal.recordSuccess(kind); w.rec({ c: 'breaker', m: 'recordSuccess', a: [kind] }); },
    };
    this.notifier = new mods.notify.Notifier(false, [(title, subtitle, body) => w.rec({ c: 'notify', a: [title, subtitle, body] })]);
    this.router = this.script.router === null || this.script.router === undefined ? null : this.makeRouter(this.script.router);
    this.hostCfg = { spotHold: {}, spotTakeProfit: {}, naturals: {}, noSentLedger: false, chaseRejected: false, ...(this.script.host ?? {}) };
    this.orderIndex = new Map();
    this.earlyOrderErrors = new Map();
    this.sentOrders = new Map();
    this.finalized = new Set();
    this.seenFills = new Set();
    this.seenCommissions = new Set();
    this.unmatchedEvents = [];
    this.closeChaseIndex = new Map();
    this.pendingTriggers = [];
    this.exits = new mods.exits.TrackExits({ store: this.store, notifier: this.notifier });
    const host = this.makeHost();
    this.host = host;
    this.hosted = new mods.hosted.HostedOrders(host);
    host.hostedOrders = this.hosted;
    // 回报落库那一块的宿主:发单账本可以"没接"(旧口径),别的块看到的宿主照样有账本
    const cbHost = Object.create(host, { sentOrders: { get: () => (w.hostCfg.noSentLedger ? undefined : w.sentOrders) } });
    this.callbacks = new mods.callbacks.IbCallbacks(cbHost);
    this.reconciler = new mods.reconcile.Reconciler(host);
  }

  makeRouter(cfg) {
    const w = this;
    const caps = { hosted: true, listHostedOpen: true, ...(cfg.caps ?? {}) };
    const state = { rows: structuredClone(cfg.rows ?? []), covered: cfg.covered ?? null, coveredIds: cfg.coveredIds ?? null, hostedOpen: cfg.hostedOpen ?? [], openOrders: cfg.openOrders ?? [],
      execRows: cfg.execRows ?? [], nextId: cfg.nextId ?? 500, perm: cfg.perm ?? false, placeStatus: cfg.placeStatus ?? 'PreSubmitted', behaviors: cfg.behaviors ?? {}, cursor: {} };
    const mk = (b) => {
      if (b.cls === 'LinkDown') return new w.mods.ibLink.LinkDownError();
      if (b.cls === 'Broker') return new w.mods.broker.BrokerError(b.msg);
      if (b.cls === 'Plan') return new w.mods.hosted.HostedPlanError(b.msg);
      return new Error(b.msg);
    };
    const next = (method) => {
      const q = state.behaviors[method];
      if (!q || !q.length) return {};
      const i = state.cursor[method] ?? 0;
      if (i < q.length) { state.cursor[method] = i + 1; return q[i]; }
      return q[q.length - 1].repeat ? q[q.length - 1] : {};
    };
    const behave = async (b) => {
      if (b.emit) for (const e of b.emit) w.fireEvent(e);
      if (b.delay) await w.sleep(b.delay);
      if (b.hang) await new Promise(() => undefined);
      if (b.error) throw mk(b.error);
    };
    const r = {
      state,
      get SUPPORTS_HOSTED_CLOSE() { return caps.hosted; },
      async positions() { w.rec({ c: 'router', m: 'positions' }); await behave(next('positions')); return w.subst(state.rows).map((x) => ({ ...x })); },
      async placeHosted(account, contract, item, oca, ref) {
        w.rec({ c: 'router', m: 'placeHosted', a: jn([account.alias, account.account_id, account.is_paper, contract, item, oca, ref]) });
        const b = next('placeHosted');
        await behave(b);
        state.nextId += 1;
        const id = state.nextId;
        const res = { order_id: id, perm_id: state.perm ? 9000 + id : null, status: state.placeStatus, ...(b.res ?? {}) };
        return res;
      },
      async modifyHosted(orderId, item) {
        w.rec({ c: 'router', m: 'modifyHosted', a: jn([orderId, item]) });
        const b = next('modifyHosted');
        await behave(b);
        return b.ret !== undefined ? b.ret : true;
      },
      async cancelHosted(orderId) {
        w.rec({ c: 'router', m: 'cancelHosted', a: [orderId] });
        const b = next('cancelHosted');
        await behave(b);
        return b.ret !== undefined ? b.ret : true;
      },
    };
    if (caps.listHostedOpen) r.listHostedOpen = async () => { w.rec({ c: 'router', m: 'listHostedOpen' }); await behave(next('listHostedOpen')); return w.subst(state.hostedOpen).map((x) => ({ ...x })); };
    if (caps.listOpenOrders) r.listOpenOrdersDetailed = async () => { w.rec({ c: 'router', m: 'listOpenOrdersDetailed' }); await behave(next('listOpenOrdersDetailed')); return w.subst(state.openOrders).map((x) => ({ ...x })); };
    if (caps.executions) r.executions = async () => { w.rec({ c: 'router', m: 'executions' }); await behave(next('executions')); return w.subst(state.execRows).map((x) => ({ ...x })); };
    if (caps.coveredAccounts) r.coveredAccounts = () => (state.covered === null ? null : new Set(state.covered));
    if (caps.coveredIds) r.coveredAccountIds = () => (state.coveredIds === null ? null : new Set(state.coveredIds));
    return r;
  }

  makeHost() {
    const w = this;
    const tk = this.mods.tk;
    const host = {
      get store() { return w.store; },
      get notifier() { return w.notifier; },
      get killswitch() { return w.ks; },
      get settings() { return w.settings; },
      get router() { return w.router; },
      orderIndex: this.orderIndex,
      earlyOrderErrors: this.earlyOrderErrors,
      get sentOrders() { return w.sentOrders; },
      finalized: this.finalized,
      seenFills: this.seenFills,
      seenCommissions: this.seenCommissions,
      unmatchedEvents: this.unmatchedEvents,
      closeChaseIndex: this.closeChaseIndex,
      exits: this.exits,
      get pendingTriggers() { return w.pendingTriggers; },
      accountIsPaper(alias) {
        const account = w.settings.accountByAlias(alias);
        return account ? Boolean(account.is_paper) : true;
      },
      async applySpotTarget(track, raw, position, targets, positions, at) {
        const name = w.nameOfTrack(track.id);
        w.rec({ c: 'host', m: 'applySpotTarget', a: jn([name, raw.key, position.symbol, position.sec_type, position.quantity, position.market_price, targets, Object.keys(positions), at.epochMs, at.date, at.minutes]) });
        let t = targets;
        const tp = w.hostCfg.spotTakeProfit[name];
        if (tp !== undefined) t = { ...targets, take_profit: tp };
        return [t, null, Boolean(w.hostCfg.spotHold[name])];
      },
      async chaseQuote(raw, position, positions, auto, prev, rounds, reason = null) {
        w.rec({ c: 'host', m: 'chaseQuote', a: jn([raw.symbol, raw.sec_type, prev, rounds, reason]) });
        const natural = String(raw.sec_type ?? '') === 'STK'
          ? tk.closeLimitPrice(position, position.market_price ?? null, auto.slippage_pct)
          : (w.hostCfg.naturals[raw.symbol] ?? null);
        if (natural === null) return null;
        return { natural, limit: tk.chaseLimit(position, natural, prev, rounds, auto, reason), floor: tk.chaseFloor(position, natural, auto, reason) };
      },
      chaseWarnIfStuck(track, entry, limit, natural) {
        w.rec({ c: 'host', m: 'chaseWarnIfStuck', a: jn([track.symbol, limit, natural, entry.rounds]) });
        if (entry.warned || Number(entry.rounds ?? 0) < tk.CHASE_WARN_ROUNDS) return;
        entry.warned = true;
        w.notifier.warning(`${track.symbol} 追价平仓 ${entry.rounds} 秒仍未成交:挂 ${w.mods.py.pyG(limit)},此刻自然价 ${w.mods.py.pyG(natural)}。请留意持仓,必要时手动处理。`);
      },
      baseRecord(instruction, channel) {
        return {
          input: { raw_instruction: instruction, reason: '', input_channel: channel },
          llm: { model: '', prompt_version: '', prompt_fingerprint: '', intent_summary: '', confidence: null, warnings: [], raw_response: '', usage: {} },
          execution_type: null, trigger: null, triggered_at: null, account: {}, contract: {}, order: {},
          ibkr: { order_id: null, perm_id: null, status_timeline: [], fills: [], avg_fill_price: null, total_commission: null, realized_pnl: null },
          final_status: null, error_detail: null, signature: '',
        };
      },
      onIbError(reqId, code, message) {
        w.rec({ c: 'host', m: 'onIbError', a: jn([reqId, code, message]) });
        w.callbacks.onIbError(reqId, code, message);
      },
      replayUnmatched() { w.callbacks.replayUnmatched(); },
      closeChaseOnStatus(trade) { w.rec({ c: 'host', m: 'closeChaseOnStatus', a: jn([trade]) }); },
    };
    if (this.hostCfg.chaseRejected) host.closeChaseModifyRejected = (id) => w.rec({ c: 'host', m: 'closeChaseModifyRejected', a: [id] });
    return host;
  }

  nameOfTrack(id) { for (const [n, v] of Object.entries(this.names.track)) if (v === id) return n; return id; }

  // ---- 回报事件(也是 router 行为里 emit 的步)
  fireEvent(e) {
    const sub = (x) => this.subst(x);
    if (e.op === 'status') this.callbacks.onOrderStatus(sub(e.trade));
    else if (e.op === 'error') this.callbacks.onIbError(sub(e.reqId), sub(e.code), sub(e.message));
    else if (e.op === 'exec') this.callbacks.onExecDetails(sub(e.trade), sub(e.fill));
    else if (e.op === 'commission') this.callbacks.onCommission(sub(e.trade), sub(e.fill), sub(e.report));
    else if (e.op === 'deleteTrack') this.realStore.deleteTrack(this.names.track[e.track]);
    else if (e.op === 'updateTrack') this.store.updateTrack(this.names.track[e.track], sub(e.fields));
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
    const ho = this.hosted;
    const sortedEntries = (m) => [...m.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    const hosted = {};
    for (const [tid, kinds] of ho.hosted) { hosted[tid] = {}; for (const [k, e] of kinds) hosted[tid][k] = e; }
    const retry = {};
    for (const [k, v] of sortedEntries(ho.hostedRetryAt)) retry[k] = v.warn ? { at: v.at, reason: v.reason, warn: true } : { at: v.at, reason: v.reason };
    const index = {};
    for (const [k, v] of [...ho.hostedIndex.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))) index[String(k)] = v;
    const snap = {
      hosted: { hosted, hostedIndex: index, adopted: ho.hostedAdopted, lastCovered: ho.lastCovered === null ? null : [...ho.lastCovered].sort(), synced: [...ho.synced].sort(), retryAt: retry },
      orderIndex: Object.fromEntries([...this.orderIndex.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      finalized: [...this.finalized].sort(),
      seenFills: [...this.seenFills].sort(),
      seenCommissions: [...this.seenCommissions].sort(),
      unmatched: this.unmatchedEvents.map((u) => [u[0], u[1]?.order?.orderId ?? null]),
      early: Object.fromEntries([...this.earlyOrderErrors.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      sent: Object.fromEntries([...this.sentOrders.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      reconcile: { at: this.reconciler.reconcileAt, exec: this.reconciler.execSyncAt === Number.NEGATIVE_INFINITY ? '-Inf' : this.reconciler.execSyncAt },
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

  async doOp(step) {
    const { mods } = this;
    const tk = mods.tk;
    const sub = (x) => this.subst(x);
    switch (step.op) {
      case 'sync': {
        const rows = step.rows === undefined || step.rows === null ? undefined : sub(step.rows);
        return this.hosted.syncHosted(rows);
      }
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
      case 'settings': {
        this.rawSettings = deepMerge(this.rawSettings, step.patch);
        this.settings = mods.config.fromDict(this.rawSettings);
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
      case 'reconcile': return this.reconciler.reconcileOrders(step.now === undefined ? this.T : step.now);
      case 'reconcileDue': return this.reconciler.reconcileDue(step.now === undefined ? this.T : step.now);
      case 'reconcileSoon': this.reconciler.reconcileSoon(); return null;
      case 'pending': this.pendingTriggers = step.ids.map((id) => ({ record_id: sub(id) })); return null;
      case 'closeChase': {
        if (step.clear) this.closeChaseIndex.clear();
        for (const [id, tname] of Object.entries(step.set ?? {})) this.closeChaseIndex.set(Number(id), this.names.track[tname] ?? tname);
        return null;
      }
      case 'host': Object.assign(this.hostCfg, step.set); return null;
      case 'index': { for (const [k, v] of Object.entries(step.map)) this.orderIndex.set(Number(k), this.names.rec[v] ?? sub(v)); return null; }
      case 'sent': { this.sentOrders.set(step.orderId, { at: step.at === undefined ? this.T : step.at, kind: step.kind }); return null; }
      case 'unsent': this.sentOrders.clear(); return null;
      case 'clear': this.hosted.clear(); return null;
      case 'finalize': this.finalized.add(this.names.rec[step.rec]); return null;
      case 'triggered': {
        const track = this.realStore.getTrack(this.names.track[step.track]);
        const raw = this.router.state.rows[step.rowIndex ?? 0];
        const position = tk.makePosition({
          account: raw.account, symbol: raw.symbol, sec_type: raw.sec_type, quantity: raw.quantity, avg_cost: raw.avg_cost, multiplier: raw.multiplier,
          currency: raw.currency, market_price: raw.market_price, market_value: raw.market_value, unrealized_pnl: raw.unrealized_pnl,
        });
        const row = sub(step.row ?? {});
        const out = { rows: [], fired: [], blocked: [] };
        this.hosted.onTriggered({ track, raw, position, state: step.state, reason: step.reason, spotReached: Boolean(step.spotReached), ...(step.spotStop === undefined ? {} : { spotStop: step.spotStop }), row, out });
        return { row, out };
      }
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
      case 'advance': await this.advance(step.ms); return null;
      case 'clearBackoff': this.hosted.clearBackoff(this.names.track[step.track]); return null;
      case 'liveKinds': return [...this.hosted.liveKinds(this.names.track[step.track])].sort();
      case 'tpEntry': return this.hosted.tpEntry(this.names.track[step.track]) ?? null;
      case 'handleError': return this.hosted.handleError(step.orderId, step.code, step.message);
      default: throw new Error(`脚本写错:不认识的步 ${step.op}`);
    }
  }

  async run() {
    this.install();
    this.build();
    const steps = [];
    let n = 0;
    for (const s of this.script.setup ?? []) { const r = await this.execStep(s, -1, {}); if (r && r.error) throw new Error(`setup 失败:${JSON.stringify(r)}`); this.stepNo = -1; n += 0; }
    for (const s of this.script.steps ?? []) {
      const record = { i: n, op: s.op };
      record.r = await this.execStep(s, n, record);
      const snap = JSON.stringify(this.snapshot());
      if (snap !== this.prevSnap) { record.snap = JSON.parse(snap); this.prevSnap = snap; }
      steps.push(record);
      n += 1;
    }
    this.stepNo = n;
    // 没完的:让钟再走一段,看看有没有迟到的完成
    this.collectDone();
    return { steps, log: this.log, dump: enc(this.dump()) };
  }
}

export async function runScenario(script, mods) {
  const dir = mkdtempSync(join(tmpdir(), 'dafri-engw-'));
  const w = new World(structuredClone(script), mods, dir); // 脚本里的行会被 row 步就地改,拷一份免得弄脏要存进夹具的原件
  try {
    return await w.run();
  } finally {
    w.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}
