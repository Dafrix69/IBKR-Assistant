// svc1 簇(跟单 follow / 价位提醒 alerts / 异动 anomaly / 日内剧本 playbook)对拍用的"世界"的 JS 一半:虚拟的钟与计时器、
// 假宿主(设置、router、引擎、行情都按脚本答、每一次调用都记下来),以及把一份脚本交给**原 TS 的 service**(engine-ts/dist/src/services/*.js)
// 现跑、把各步的结果与整个库的样子记下来的跑法。C++ 那边(tests/svc1_world.h)读同一份脚本、解释得一模一样、逐项精确比较。
// 改这个文件就要同时改 svc1_world.h。仿 broker_world.mjs / gen_store.mjs。
//
// ---- 约定(两边都靠它们对得上)
//  · 时间:Date.now() / new Date() 是虚拟钟(world.T,毫秒整数);domain 的 nowEt() 也跟着它(C++ 那边 setClock 与 setDateNowForTests 一起拨)。
//    钟只在 advance 步里走:一个一个计时器到点(同刻按先后),每个计时器触发之后排空微任务。
//  · 计时器:service 用全局 setTimeout 设的计时器记 {m:"setTimeout", a:[delay]};清掉一个还没到点的记 {m:"clearTimeout"};delay < 1 按 1 排(Node 的规矩)。
//    假宿主自己的"过一会儿才答"(delay)排在同一个队里,但不记。
//  · 假宿主的每一次异步回答都走计时器队(delay 缺省 0 也走),从不当场 resolve:JS 对已完成的 Promise 要让一拍,util::Task 不让,
//    当场 resolve 的话两边交错的次序会不同。
//  · 日志 {t, m, a}:t 虚拟时刻、m 方法、a 参数(enc 过)。纯读(sessions / hasSessions / settings)不记。process.stderr.write 记 {m:"stderr", a:[去掉末尾换行的文本]}。
//  · 库:真的 TradeStore(临时目录里),Date 与 crypto.randomUUID 换成可复现的(id 依次是 00000000-0000-4000-8000-000000000001…);
//    脚本里的 store 步直接调库的方法准备数据;每个场景末了(以及 db 步)把整个库的每张表按 rowid 的全部行记下来。
//    临时目录的路径在所有记下来的文字里换成 <DIR>。
//  · 脚本的假答案队列:{ "键": [条目…] },条目 {ok: 值, delay?} | {err: {kind, message, code?}, delay?};按调用先后各取一个,用完重复最后一个;
//    没有这个键的调用:ok = 缺省值(各 service 的 world 文件里写明)。err.kind:plain / rpc / broker / marks。
//    fake 步 {op:"fake", key, list} 换掉一个键的队列(并从头取)。
//  · 步:{op:"call", m, a, id?, start?}(启动一个调用;不带 start 就一直推进虚拟钟到它落定,回 pending 表示推到没有计时器了还没落定) |
//        {op:"await", id} | {op:"advance", ms} 或 {op:"advance", to} | {op:"store", m, a} | {op:"settings", patch} | {op:"fake", key, list} |
//        {op:"db"} | 各 service 自己的步(见它们的 world 文件)。
import cryptoDefault from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BASE_CONFIG, deepMerge, dec, drain, enc, rng } from './broker_world.mjs';

export { BASE_CONFIG, deepMerge, dec, drain, enc, rng };

export const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** 世界:钟、计时器、日志、假答案队列 */
export class World {
  constructor(script) {
    this.script = script;
    this.T = script.start;
    this.log = [];
    this.timers = [];
    this.counter = 0;
    this.uuidN = 0;
    this.queues = new Map();
    this.dir = mkdtempSync(join(tmpdir(), 'svc1-world-'));
    this.RealDate = Date;
    this.origSetTimeout = globalThis.setTimeout;
    this.origClearTimeout = globalThis.clearTimeout;
    this.origWrite = process.stderr.write;
    this.origUUID = cryptoDefault.randomUUID;
    const world = this;
    class FakeDate extends this.RealDate {
      constructor(...a) { if (a.length === 0) super(world.T); else super(...a); }
      static now() { return world.T; }
    }
    globalThis.Date = FakeDate;
    cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++this.uuidN).padStart(12, '0')}`;
    syncBuiltinESMExports();
    globalThis.setTimeout = (fn, delay, ...args) => {
      this.rec('setTimeout', [delay]);
      const d = Number(delay);
      const e = this.schedule(d >= 1 ? d : 1, () => fn(...args));
      return { unref() { return this; }, ref() { return this; }, hasRef() { return false; }, _e: e };
    };
    globalThis.clearTimeout = (t) => {
      const e = t && t._e;
      if (!e) return;
      const i = this.timers.indexOf(e);
      if (i >= 0) {
        this.timers.splice(i, 1);
        this.rec('clearTimeout', []);
      }
    };
    // JS 的调用栈("\n    at …")在 C++ 里没有:只记第一行("<类名>: <话>")
    process.stderr.write = (chunk) => { this.rec('stderr', [String(chunk).replace(/\n$/, '').split('\n    at ')[0]]); return true; };
    for (const [key, list] of Object.entries(script.fakes ?? {})) this.queues.set(key, { list, i: 0 });
  }

  restore() {
    globalThis.Date = this.RealDate;
    globalThis.setTimeout = this.origSetTimeout;
    globalThis.clearTimeout = this.origClearTimeout;
    process.stderr.write = this.origWrite;
    cryptoDefault.randomUUID = this.origUUID;
    syncBuiltinESMExports();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* 库的句柄可能还占着 */ }
  }

  /** 日志里的路径一律换掉临时目录 */
  clean(v) {
    const s = JSON.stringify(v);
    return JSON.parse(s.split(this.dir).join('<DIR>'));
  }
  rec(method, args) { this.log.push({ t: this.T, m: method, a: this.clean(enc(args)) }); }

  schedule(delay, fn) {
    const e = { at: this.T + delay, seq: this.counter++, fn };
    this.timers.push(e);
    return e;
  }
  sleep(delay) { return new Promise((r) => this.schedule(delay, r)); }

  /** 最早的一个计时器(同刻按先后)到点:钟走到那一刻,触发,排空微任务。没有计时器或太晚回 false */
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
    await drain();
    while (await this.stepOne(end)) { /* 一个一个到点 */ }
    this.T = Math.max(this.T, end);
    await drain();
  }

  /** 按调用先后各取一个答案,用完重复最后一个;没有这个键回 dflt */
  next(key, dflt) {
    const q = this.queues.get(key);
    if (!q || !q.list.length) return dflt;
    const v = q.list[Math.min(q.i, q.list.length - 1)];
    q.i += 1;
    return v;
  }
  setFake(key, list) { this.queues.set(key, { list, i: 0 }); }

  /** 一条答案变成 Promise(走计时器队,从不当场 resolve) */
  answer(entry, mods) {
    return new Promise((resolve, reject) => {
      this.schedule(entry.delay ?? 0, () => {
        if (entry.err !== undefined) reject(makeError(entry.err, mods));
        else resolve(clone(dec(entry.ok)));
      });
    });
  }
}

export function makeError(spec, mods) {
  const msg = spec.message ?? '';
  switch (spec.kind) {
    case 'rpc': return new mods.RpcError(spec.code ?? -32017, msg);
    case 'broker': return new mods.BrokerError(msg);
    case 'marks': return new mods.OptionMarksError(msg);
    default: return new Error(msg);
  }
}

/** 错误在结果里的样子:话 + RpcError 的码(不是 RpcError 的是 null) */
export function errOut(e, mods) {
  return { error: String(e?.message ?? e), code: e instanceof mods.RpcError ? e.code : null };
}

export async function loadMods(engineDir, names) {
  const imp = (f) => import(pathToFileURL(join(engineDir, `dist/src/${f}.js`)).href);
  const out = {};
  const loaded = await Promise.all(names.map(imp));
  names.forEach((n, i) => { out[n.replace(/.*\//, '')] ??= loaded[i]; out[n.replace(/\//g, '_')] = loaded[i]; });
  out.RpcError = out.rpcError.RpcError;
  return out;
}

/** 当前虚拟钟下的 Settings:基础配置 + 补丁 + 临时库路径 */
export function makeSettings(config, world, patch) {
  const raw = deepMerge(deepMerge(BASE_CONFIG, world.script.settings ?? {}), patch ?? {});
  raw.storage = { db_path: join(world.dir, 't.db') };
  return config.fromDict(JSON.parse(JSON.stringify(raw)));
}

/** 整个库的样子:每张表按 rowid 的全部行 */
export function dumpDb(engineDir, path, world) {
  const Database = createRequire(join(engineDir, 'package.json'))('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const master = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const tables = {};
    for (const t of master) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('ideas_fts')) continue;
      let stmt;
      try { stmt = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`); } catch { stmt = db.prepare(`SELECT * FROM "${t.name}"`); }
      const rows = stmt.raw().all().map((r) => r.map((c) => (Buffer.isBuffer(c) ? { blob: c.toString('hex') } : c)));
      if (rows.length) tables[t.name] = rows;
    }
    return world.clean(tables);
  } finally {
    db.close();
  }
}

/** 一个调用的跟踪:落定了没有、结果或错误 */
export function track(p) {
  const s = { done: false, ok: false, value: undefined, error: undefined };
  Promise.resolve(p).then((v) => { s.done = true; s.ok = true; s.value = v; }, (e) => { s.done = true; s.error = e; });
  return s;
}
/** 一直推进虚拟钟到它落定;推到没有计时器了还没落定回 false */
export async function runToDone(world, s) {
  await drain();
  while (!s.done) { if (!(await world.stepOne())) break; }
  await drain();
  return s.done;
}

/**
 * 跑一份脚本。ctx:
 *   world, mods, engineDir, store(真库), methods:{名字: (args) => 值|Promise}, extraOps:{op: async (step, rec) => void},
 *   setSettings(patch)(换设置), shape(m, value)(可选:结果整形)
 */
export async function runSteps(ctx) {
  const { world, script, mods, methods } = ctx;
  const steps = [];
  const started = new Map();
  const aliases = new Map();
  ctx.aliases = aliases;
  /** {"$ref": "名字"} → 之前某个 store 步 as 记下的 id(或结果);{"$watch": "代码"} → 此刻库里这个代码的盯单 id(没有就抛);{"$now": n} → 此刻的虚拟时间 + n */
  const resolve = (v) => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      if (typeof v.$now === 'number') return world.T + v.$now;
      if (typeof v.$ref === 'string') {
        if (!aliases.has(v.$ref)) throw new Error(`没有记过 ${v.$ref}`);
        return aliases.get(v.$ref);
      }
      if (typeof v.$watch === 'string') {
        const w = ctx.store.listWatches().find((x) => x.symbol === v.$watch);
        if (!w) throw new Error(`没有这个盯单 ${v.$watch}`);
        return w.id;
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  const outcome = (s, shape) => (s.error !== undefined ? errOut(s.error, mods) : { ok: shape(s.value) });
  for (const step of script.steps) {
    const rec = { op: step.op };
    if (step.id !== undefined) rec.id = step.id;
    switch (step.op) {
      case 'call': {
        rec.m = step.m;
        if (!methods[step.m]) throw new Error(`不认识的方法 ${step.m}`);
        const shape = (v) => enc(ctx.shape ? ctx.shape(step.m, v) : v);
        let p;
        try { p = Promise.resolve(methods[step.m](resolve(dec(step.a ?? [])))); } catch (e) { p = Promise.reject(e); }
        const s = track(p);
        if (step.start) started.set(step.id, { s, shape });
        else rec.result = (await runToDone(world, s)) ? outcome(s, shape) : { pending: true };
        break;
      }
      case 'await': {
        const st = started.get(step.id);
        if (!st) throw new Error(`没有启动过 ${step.id}`);
        rec.result = (await runToDone(world, st.s)) ? outcome(st.s, st.shape) : { pending: true };
        break;
      }
      case 'advance':
        await world.advance(step.ms !== undefined ? step.ms : step.to - world.T);
        break;
      case 'store': {
        rec.m = step.m;
        let out;
        try {
          const target = step.m.startsWith('follow.') ? ctx.store.follow : ctx.store;
          const name = step.m.replace(/^follow\./, '');
          const v = target[name](...resolve(dec(step.a ?? [])));
          if (step.as) aliases.set(step.as, v !== null && typeof v === 'object' && 'id' in v ? v.id : v);
          out = { ok: enc(v === undefined ? null : v) };
        } catch (e) { out = errOut(e, mods); }
        rec.result = out;
        break;
      }
      case 'settings':
        ctx.setSettings(step.patch);
        break;
      case 'router':
        Object.assign(ctx.routerState, step.set);
        ctx.rebuildRouter();
        break;
      case 'fake':
        world.setFake(step.key, step.list);
        break;
      case 'db':
        rec.db = dumpDb(ctx.engineDir, ctx.store.dbPath ?? join(world.dir, 't.db'), world);
        break;
      default: {
        const extra = ctx.extraOps?.[step.op];
        if (!extra) throw new Error(`不认识的步 ${step.op}`);
        await extra(step, rec);
      }
    }
    await drain();
    rec.t = world.T;
    steps.push(rec);
  }
  return world.clean(steps);
}

/**
 * 假 router(BrokerRouter 的鸭子):状态 routerState = {on?, sessions?, volume?, covered?, noSession?};
 * 答案队列 router.<方法>,条目 {ok, delay?} | {err:{kind,message,code?}, delay?}。state.on === false 时宿主交出 null(没连券商)。
 * 异步方法走计时器队;spotInfo / releaseVolumeStreams 是同步的(条目的 err 当场抛)。
 */
export function makeRouter(world, mods, state, sessionGetter) {
  const ans = (key, dflt) => world.answer(world.next(key, { ok: dflt }), mods);
  const syncAns = (key, dflt) => {
    const e = world.next(key, { ok: dflt });
    if (e.err !== undefined) throw makeError(e.err, mods);
    return clone(dec(e.ok));
  };
  const r = {
    BROKER: 'ibkr',
    SUPPORTS_VOLUME_QUOTES: state.volume !== false,
    sessions() { return state.sessions === false ? [] : [{}]; },
    positions() { world.rec('router.positions', []); return ans('router.positions', []); },
    streamQuotes(symbols) { world.rec('router.streamQuotes', [symbols]); return ans('router.streamQuotes', {}); },
    indexPrice(symbol) { world.rec('router.indexPrice', [symbol]); return ans('router.indexPrice', null); },
    spotInfo(symbol) { world.rec('router.spotInfo', [symbol]); return syncAns('router.spotInfo', null); },
    marketSession() {
      world.rec('router.marketSession', []);
      if (state.noSession) throw new mods.BrokerError('没有连着的会话');
      return sessionGetter();
    },
    historicalBars(symbol, start, end) { world.rec('router.historicalBars', [symbol, start, end]); return ans('router.historicalBars', []); },
    volumeQuotes(symbols) { world.rec('router.volumeQuotes', [symbols]); return ans('router.volumeQuotes', {}); },
    releaseVolumeStreams(keep) { world.rec('router.releaseVolumeStreams', [keep]); return syncAns('router.releaseVolumeStreams', 0); },
  };
  if (state.covered != null) {
    r.coveredAccounts = () => { world.rec('router.coveredAccounts', []); return new Set(state.covered); };
  }
  return r;
}

/** 队列键:有 "<base>|<symbol>" 的队列用它,否则 "<base>|*",再否则缺省 */
export function nextFor(world, base, symbol, dflt) {
  return world.queues.has(`${base}|${symbol}`) ? world.next(`${base}|${symbol}`, dflt) : world.next(`${base}|*`, dflt);
}

/** 假 MarketDataService:wallFor / spotOf / dailyHistory / quotesOf */
export function makeMarket(world, mods) {
  return {
    wallFor(symbol, expiry, width, span, preferClass) {
      world.rec('market.wallFor', [symbol, expiry ?? null, width ?? 10, span ?? null, preferClass ?? '']);
      return world.answer(nextFor(world, 'market.wallFor', symbol, { err: { kind: 'rpc', code: -32017, message: '没有脚本化的期权墙' } }), mods);
    },
    spotOf(symbol) {
      world.rec('market.spotOf', [symbol]);
      return world.answer(nextFor(world, 'market.spotOf', symbol, { ok: null }), mods);
    },
    dailyHistory(symbol) {
      world.rec('market.dailyHistory', [symbol]);
      return world.answer(nextFor(world, 'market.dailyHistory', symbol, { ok: [] }), mods);
    },
    async quotesOf(symbols) {
      world.rec('market.quotesOf', [symbols]);
      const obj = await world.answer(world.next('market.quotesOf', { ok: {} }), mods);
      const out = new Map();
      for (const s of new Set(symbols)) out.set(s, obj[s] ?? null);
      return out;
    },
  };
}

/** 假引擎里通知那一面:engine.notifier.notify(title, body, subtitle, opts) */
export function makeNotifier(world) {
  return { notify(title, body, subtitle, opts) { world.rec('notify', [title, body, subtitle ?? '', opts?.os ?? true]); } };
}
