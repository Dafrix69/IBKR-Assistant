// handlers2 簇(engine-ts/src/rpc/handlers/ 的 ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener)
// 对拍用的"世界"的 JS 一半:把**原 TS 的 handler 类**(engine-ts/dist/src/rpc/handlers/*.js)装在一个假的 RpcContext 上现跑——
// 引擎是真的交易库(svc_world.mjs 的 runScript 开的临时库)、券商 router 与各个 service 与解析器都是记录一切、按脚本回话的替身。
// C++ 那边(tests/h2_world.h)读同一份脚本、解释得一模一样、逐项精确比较(回执、每一次替身调用的方法与参数、各步之后库里变了的表)。
// 改这个文件就要同时改 h2_world.h。底座是 svc_world.mjs(虚拟钟、临时库、id 序列、步的通用部分与 errInfo)。
//
// ---- 脚本(scenario):svc_world.mjs 的通用键(name / start / seed / settings / dump / steps)再加
//  ports:  { "<替身>.<方法>": [结果…] },替身 = pool alerts anomaly events intel follow market tradeHistory similarContext stockTrips fillSync ideaSemantic flyPlanner ivRecorder playbook;
//          结果 {value, error?, kind?, code?, effects?: [{m, a}]},按调用先后各取一个,用完重复最后一个;没写的方法回 null(void 方法的正常样子)。effects 是替身被调用时在库上做的事(真 service 会改库,替身不会,脚本演出来)。
//          kind:plain(缺省)| broker(BrokerError)| rpc(RpcError,带 code)| events_config | keychain
//  llm:    [结果…] 解析器的 completeJson,同上(结果也可带 effects)(没写 = 抛"h2_world: llm 未脚本")。每次调用记 {s:"llm", m:"completeJson", a:[system, user, schema]}
//  h2router: { sessions: n, noCombo?: true, results: {方法名 或 方法名:参数键: [结果…]} };步 {op:"h2router", v:"make"|"null"} 换上 / 拿掉,
//          {op:"h2routerSet", set:{sessions?, results?}} 改。方法:historicalBars stockQuotes streamQuotes orderBook comboBars,每次调用记 {s:"router", m, a}
//  步(这里加的):{op:"call", id, m:"ideas.add", a:{…}} 的 m 是 RPC 方法名(走真的 contractMethods 表:入参先过 schema)
// 日志 {t, s, m, a}:s 是替身名("pool" …)/ "router" / "llm" / "host"(emit)。
import { pick, runScript, enc, dec, loadMods, BASE_CONFIG } from './svc_world.mjs';

export { BASE_CONFIG, enc, dec };

const DOMAINS = ['ideas', 'review', 'sectors', 'quality', 'events', 'intel', 'alerts', 'backtest', 'follow', 'market', 'screener'];
const CLASS_OF = {
  ideas: 'IdeasHandlers', review: 'ReviewHandlers', sectors: 'SectorsHandlers', quality: 'QualityHandlers', events: 'EventsHandlers', intel: 'IntelHandlers',
  alerts: 'AlertsHandlers', backtest: 'BacktestHandlers', follow: 'FollowHandlers', market: 'MarketHandlers', screener: 'ScreenerHandlers',
};

/** 替身的方法表:sync / async 同真 service 的签名(返回 Promise 的就是 async);defaults 是调用处省掉的参数的缺省值(TS 的默认参数),记日志前补上 */
const PORTS = {
  pool: { sync: ['ensureMigrated', 'setWatch', 'ensureInPool', 'dropWatches'], defaults: { setWatch: [undefined, undefined, ''], ensureInPool: [undefined, ''] } },
  alerts: { sync: ['levelsStatusOf', 'crossConfirm', 'touchConfig', 'touchConfigChanged'], async: ['listWatches', 'refresh', 'poll'] },
  anomaly: { sync: ['config', 'monitor', 'metricsOf', 'forget'] },
  events: { sync: ['setConfig', 'add', 'remove'], async: ['list'] },
  intel: { async: ['feed', 'dossier'] },
  follow: { async: ['status', 'setToken', 'sync'] },
  market: { async: ['wallFor', 'dailyHistory', 'paBars'], sync: ['dailyHistoryAskedAt'], defaults: { dailyHistory: [undefined, 420], paBars: [undefined, undefined, undefined, false, false] },
    // 值 {bars, cached, askedAt, feed?, proxy?} → 真 paBars 的 [bars, cached, askedAt, feed],feed / proxy 记在数组旁边(marketdata.tagFeed / tagProxy)
    transform: { paBars: (v, mods) => {
      const bars = structuredClone(v.bars);
      if (v.feed !== undefined && v.feed !== null) mods.md.tagFeed(bars, v.feed === 'live' ? false : v.feed === 'delayed' ? true : null);
      if (v.proxy !== undefined && v.proxy !== null) mods.md.tagProxy(bars, v.proxy);
      return [bars, v.cached, v.askedAt, v.feed ?? undefined];
    } } },
  tradeHistory: { async: ['load', 'ledger'] },
  similarContext: {
    async: ['spot', 'flyEntryUnderlyings', 'stockRanges'],
    transform: { flyEntryUnderlyings: (v) => new Map(Object.entries(v)), stockRanges: (v) => ({ query: v.query, byId: new Map(Object.entries(v.byId)) }) },
  },
  stockTrips: { async: ['trips'] },
  fillSync: { async: ['sync'], sync: ['available'] },
  ideaSemantic: { async: ['rank'], argsOf: { rank: 2 }, transform: { rank: (v) => (v === null ? null : new Map(Object.entries(v))) } }, // 第三个参数是函数,不记
  flyPlanner: { async: ['planFor', 'spotFor'] },
  ivRecorder: { sync: ['status', 'setEnabled'] },
  playbook: { sync: ['snapshot', 'setEnabled'] },
};

export async function loadH2(engineDir) {
  const mods = await loadMods(engineDir);
  const handlers = {};
  for (const d of DOMAINS) handlers[d] = (await mods.imp(`rpc/handlers/${d}`))[CLASS_OF[d]];
  mods.econ = await mods.imp('econCalendar');
  mods.secrets = await mods.imp('secrets');
  mods.md = await mods.imp('marketdata');
  mods.macro = await mods.imp('macro');
  mods.Handlers = handlers;
  return { mods, run: (script) => runScript(structuredClone(script), mods, (world, host) => build(world, host, mods, script)) };
}

/** 日志要过一道文本往返(C++ 的 Runner::run 末尾),NaN / ±Infinity 会变 null:参数里的非有限数先换成占位串(h2_world.h 的 tagNonFinite 同) */
function tagNonFinite(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? '__NaN__arg' : v > 0 ? '__Inf__arg' : '__-Inf__arg';
  if (Array.isArray(v)) return v.map(tagNonFinite);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tagNonFinite(x)]));
  return v;
}

/** 脚本里 {m, a} 在库上做的事(同 svc_world.mjs 的 store 步:m 可以带点) */
function applyStore(store, step) {
  const parts = step.m.split('.');
  const fn = parts.pop();
  const target = parts.reduce((o, k) => o[k], store);
  return target[fn](...structuredClone(dec(step.a ?? [])));
}

function makeError(mods, r) {
  const msg = r.error;
  switch (r.kind ?? 'plain') {
    case 'broker': return new mods.broker.BrokerError(msg);
    case 'rpc': return new mods.rpcError.RpcError(r.code, msg);
    case 'events_config': return new mods.econ.EventsConfigError(msg);
    case 'keychain': return new mods.secrets.KeychainError(msg);
    default: return new Error(msg);
  }
}

function build(world, host, mods, script) {
  mods.macro.clearMacroCache();
  const counters = {};
  const portResults = script.ports ?? {};
  const state = { router: null };

  /** 一次替身调用:记日志、取下一个脚本结果、抛或回 */
  const answer = (port, method, args, spec) => {
    const defaults = spec.defaults?.[method];
    let shown = args;
    if (defaults) {
      shown = [...args];
      defaults.forEach((d, i) => { if (shown[i] === undefined && d !== undefined) shown[i] = d; });
    }
    if (spec.argsOf?.[method] !== undefined) shown = shown.slice(0, spec.argsOf[method]);
    world.rec(port, method, tagNonFinite(shown));
    const r = pick(portResults, counters, `${port}.${method}`, [{ value: null }]);
    for (const e of r.effects ?? []) applyStore(host.store, e);
    if (r.error !== undefined) throw makeError(mods, r);
    const value = structuredClone(dec(r.value === undefined ? null : r.value));
    const transform = spec.transform?.[method];
    // callLlm: {system, user, schema}(ideaSemantic.rank):替身去调传进来的 llmJson 闭包,记一条 llmResult,再照常回 value(同 h2_world.h 的 IdeaSemanticStub)
    if (r.callLlm && typeof args[2] === 'function') {
      return (async () => {
        const c = structuredClone(dec(r.callLlm));
        let outcome;
        try { outcome = { value: await args[2](c.system, c.user, c.schema ?? null) }; } catch (e) { outcome = { error: String(e?.message ?? e) }; }
        world.rec(port, 'llmResult', [outcome]);
        return transform ? transform(value, mods) : value;
      })();
    }
    return transform ? transform(value, mods) : value;
  };
  const ports = {};
  for (const [port, spec] of Object.entries(PORTS)) {
    const o = {};
    for (const m of spec.sync ?? []) o[m] = (...a) => answer(port, m, a, spec);
    for (const m of spec.async ?? []) o[m] = async (...a) => answer(port, m, a, spec);
    ports[port] = o;
  }

  // ---- 解析器
  const llmCounters = {};
  const parser = {
    completeJson: async (system, user, schema) => {
      world.rec('llm', 'completeJson', [system, user, schema]);
      const r = pick(script, llmCounters, 'llm', [{ error: 'h2_world: llm 未脚本' }]);
      for (const e of r.effects ?? []) applyStore(host.store, e); // 模型"思考"的这几秒里库被别处改了(例:板块被删)
      if (r.error !== undefined) throw makeError(mods, r);
      return structuredClone(dec(r.value));
    },
  };

  // ---- 券商 router 的替身
  const routerCounters = {};
  const makeRouter = (cfg) => {
    const r = { cfg, n: cfg.sessions ?? 1 };
    const ask = async (name, argKey, args) => {
      world.rec('router', name, args);
      const results = r.cfg.results ?? {};
      const key = results[`${name}:${argKey}`] ? `${name}:${argKey}` : name;
      const res = pick(results, routerCounters, key, [{ unscripted: true }]);
      if (res.unscripted) throw new Error(`h2_world: router.${name} 未脚本`);
      if (res.error !== undefined) throw makeError(mods, res);
      return structuredClone(dec(res.value));
    };
    r.sessions = () => Array.from({ length: r.n }, () => ({}));
    r.historicalBars = (symbol, start, end) => ask('historicalBars', symbol, [symbol, start, end]);
    r.stockQuotes = (symbols) => ask('stockQuotes', symbols.join(','), [symbols]);
    r.streamQuotes = (symbols) => ask('streamQuotes', symbols.join(','), [symbols]);
    r.orderBook = (symbol) => ask('orderBook', symbol, [symbol]);
    if (!cfg.noCombo) r.comboBars = (symbol, legs, day) => ask('comboBars', symbol, [symbol, legs, day]);
    return r;
  };

  // ---- 公开源:macro.ts 的 defaultFetcher 用全局 fetch;换成按 ports["fetch.get"] 回话的替身(记 {s:"fetch", m:"get", a:[url]})。
  //      值是对象且带 __http: [状态码, 状态文字, 正文] = 返回这个 HTTP 回包;否则值 = JSON 回包
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const v = answer('fetch', 'get', [String(url)], {});
    if (v !== null && typeof v === 'object' && v.__http) {
      const [status, statusText, text] = v.__http;
      return { ok: status >= 200 && status < 300, status, statusText, text: async () => text };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(v) };
  };

  const ctx = {
    get settings() { return host.settings; },
    get router() { return state.router; },
    get engine() { return host.engineObj; },
    parserFactory: () => parser,
    emit: (event, payload) => host.emit(event, payload),
    ...ports,
  };
  const methods = {};
  for (const d of DOMAINS) {
    const table = new mods.Handlers[d](ctx).methods();
    for (const [name, fn] of Object.entries(table)) methods[name] = (params) => fn(params);
  }
  return {
    methods,
    gets: {},
    ops: {
      h2router: async (step) => { state.router = step.v === 'make' ? makeRouter(structuredClone(dec(script.h2router ?? {}))) : null; },
      h2routerSet: async (step) => {
        const r = state.router;
        if (!r) return;
        const set = structuredClone(dec(step.set));
        for (const [k, v] of Object.entries(set)) {
          if (k === 'results') for (const [rk, rv] of Object.entries(v)) { (r.cfg.results ??= {})[rk] = rv; delete routerCounters[rk]; }
          else if (k === 'sessions') r.n = v;
          else r.cfg[k] = v;
        }
      },
    },
    stop() { globalThis.fetch = realFetch; },
  };
}
