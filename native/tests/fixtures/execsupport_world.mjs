// execsupport 簇(accountFeeds / autoMid / qualifyGate / heldStreams / ibLink / optionMarks / ibBars)对拍用的"世界":
// 一个脚本驱动的假 IbSession、一只虚拟的钟、一张按时刻排的事件表。生成器(gen_*.mjs)把同一份脚本(JSON)交给原 TS 模块跑,
// 记下会话上被调用的每一次(方法、参数、虚拟时刻、先后次序)与各步的结果;C++ 那边(tests/execsupport_world.h)读同一份脚本、
// 解释得一模一样,逐项精确比较。两边的假会话、钟、事件表必须逐句对得上——改这个文件就要同时改 execsupport_world.h。
//
// 脚本(scenario)的形状:
//   { name, start, sessions: [会话脚本…], events: [{at, session, key, patch}…], steps: [步…] }
// 会话脚本:
//   { name, caps: ["QuoteDelayed", "AccountPnl", "NetLiquidation", "OnLink"],   // 这一台"有"哪些可选方法(缺的就是 TS 里没有这个方法)
//     connected, accounts, times, throwCancel,                                   // throwCancel:cancelTicker 记完调用就抛                                                // times:订阅时记 requestedAt(真会话会记)
//     pnl: {账号: null | {daily, unrealized, realized, currency, atMs}}, netLiq: {账号: null | {amount, currency}},
//     delayed: {tickerKey(无 generic): true | false | null},                     // quoteDelayed 的答案,没列的是 null
//     qualify: [结果…], hist: {"标的|交易所": [结果…]}, initial: {完整键: patch} }
//   qualify 结果:{kind: "ok", conIds?, delay?} | {kind: "timeout"|"timeoutName"|"error", message?, delay?};按调用先后各取一个,用完重复最后一个
//   hist 结果:{bars: [{date, open, high, low, close, volume?}], delay?} | {error, delay?}
//   patch:盘口字段的覆盖(bid ask last quotedAt requestedAt error iv(→ modelGreeks.impliedVol));error 一出现,这条流像真会话一样从缓存里摘掉
// 事件:at 是相对 start 的毫秒;作用在那一刻该会话该键上的流(没有就当没发生)。
// 钟:Date.now() 被换成虚拟钟;只有 settle(ms) 与 advance 步让它走;走过的每个时刻按先后触发事件、计时器。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

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

const CONTRACT_KEYS = ['secType', 'symbol', 'exchange', 'currency', 'lastTradeDateOrContractMonth', 'strike', 'right', 'multiplier', 'tradingClass', 'conId'];
/** 合约在日志里的样子:只留有值的键,键序固定(C++ 那边按同一个次序写) */
export function norm(c) {
  const o = {};
  for (const k of CONTRACT_KEYS) if (c[k] !== undefined && c[k] !== null) o[k] = c[k];
  return o;
}

export async function loadWorld(engineDir) {
  const ibSession = await import(pathToFileURL(join(engineDir, 'dist/src/ibSession.js')).href);
  return { World, tickerKey: ibSession.tickerKey };
}

class World {
  constructor(scenario, tickerKey) {
    this.tickerKey = tickerKey;
    this.T = scenario.start;
    this.log = [];
    this.timers = [];
    this.counter = 0;
    this.handleSeq = 0;
    this.sessions = new Map();
    this.cbs = new Map(); // 会话名 → {conn: [], link: []}
    this.origNow = Date.now;
    this.origWrite = process.stderr.write;
    Date.now = () => this.T;
    process.stderr.write = (chunk) => { this.rec(null, 'stderr', [String(chunk).replace(/\n$/, '')]); return true; };
    for (const cfg of scenario.sessions ?? []) this.sessions.set(cfg.name, new FakeSession(this, cfg));
    for (const e of scenario.events ?? []) {
      this.schedule(scenario.start + e.at - this.T, () => this.patchStream(e.session, e.key, e.patch));
    }
  }

  restore() {
    Date.now = this.origNow;
    process.stderr.write = this.origWrite;
  }

  session(name) { return this.sessions.get(name); }

  rec(session, method, args) { this.log.push({ t: this.T, s: session, m: method, a: enc(args) }); }

  schedule(delay, fn, resolveKind = false, period = 0) {
    this.timers.push({ at: this.T + delay, seq: this.counter++, fn, resolveKind, period });
  }
  every(period, fn) {
    const entry = { at: this.T + period, seq: this.counter++, fn, resolveKind: false, period };
    this.timers.push(entry);
    return entry;
  }
  cancel(entry) {
    const i = this.timers.indexOf(entry);
    if (i >= 0) this.timers.splice(i, 1);
  }
  sleep(delay) { return new Promise((r) => this.schedule(delay, r, true)); }

  advance(ms) {
    const end = this.T + ms;
    const pending = [];
    for (;;) {
      let best = null;
      for (const e of this.timers) {
        if (e.at > end) continue;
        if (best === null || e.at < best.at || (e.at === best.at && e.seq < best.seq)) best = e;
      }
      if (best === null) break;
      this.T = Math.max(this.T, best.at);
      if (best.period > 0) { best.at += best.period; best.seq = this.counter++; } else this.timers.splice(this.timers.indexOf(best), 1);
      if (best.resolveKind) pending.push(best.fn); else best.fn();
    }
    this.T = end;
    for (const f of pending) f();
  }

  patchStream(sessionName, key, patch) {
    const s = this.sessions.get(sessionName);
    s?.applyPatch(key, patch);
  }

  /** 各生成器共用的步:不认识的回 false */
  commonStep(step) {
    switch (step.op) {
      case 'advance': this.advance(step.ms); return true;
      case 'connected': this.sessions.get(step.session).connected = step.v; return true;
      case 'patch': this.patchStream(step.session, step.key, step.patch); return true;
      case 'setPnl': this.sessions.get(step.session).cfg.pnl[step.account] = step.v; return true;
      case 'setNetLiq': this.sessions.get(step.session).cfg.netLiq[step.account] = step.v; return true;
      case 'emitConnectivity': for (const cb of this.sessions.get(step.session).connCbs) cb(step.code); return true;
      case 'emitLink': for (const cb of this.sessions.get(step.session).linkCbs) cb(step.up); return true;
      default: return false;
    }
  }
}

/** 一个宏任务的间隔:让已经排好的微任务(Promise 的后续)都跑完 */
export const drain = async () => { for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r)); };

function emptyData(times, T) {
  return { bid: NAN, ask: NAN, last: null, close: null, modelGreeks: null, error: null, quotedAt: null, requestedAt: times ? T : null, delayed: false };
}
function mergePatch(data, patch) {
  for (const [k, v] of Object.entries(dec(patch))) {
    if (k === 'iv') data.modelGreeks = v === null ? null : { gamma: null, impliedVol: v, optPrice: null };
    else data[k] = v;
  }
}

class FakeSession {
  constructor(world, cfg) {
    this.w = world;
    this.cfg = { pnl: {}, netLiq: {}, ...cfg };
    this.name = cfg.name;
    this.connected = cfg.connected ?? true;
    this.streams = new Map(); // 完整键 → {data}
    this.connCbs = [];
    this.linkCbs = [];
    this.qIdx = 0;
    this.hIdx = {};
    const caps = new Set(cfg.caps ?? []);
    const w = world;
    if (caps.has('AccountPnl')) {
      this.accountPnl = (id) => { w.rec(this.name, 'accountPnl', [id]); return this.cfg.pnl[id] === undefined ? null : dec(this.cfg.pnl[id]); };
    }
    if (caps.has('NetLiquidation')) {
      this.netLiquidation = (id) => { w.rec(this.name, 'netLiquidation', [id]); return this.cfg.netLiq[id] === undefined ? null : dec(this.cfg.netLiq[id]); };
    }
    if (caps.has('QuoteDelayed')) {
      this.quoteDelayed = (c) => { w.rec(this.name, 'quoteDelayed', [norm(c)]); const v = (this.cfg.delayed ?? {})[world.tickerKey(c)]; return v === undefined ? null : v; };
    }
    if (caps.has('OnLink')) {
      this.onLink = (cb) => { w.rec(this.name, 'onLink', []); this.linkCbs.push(cb); };
    }
  }

  applyPatch(key, patch) {
    const entry = this.streams.get(key);
    if (!entry) return;
    mergePatch(entry.data, patch);
    // 被拒的流(error 一出现)像真会话一样从缓存里摘掉;句柄仍读得到那条 error
    if (entry.data.error) this.streams.delete(key);
  }

  isConnected() { this.w.rec(this.name, 'isConnected', []); return this.connected; }
  managedAccounts() { this.w.rec(this.name, 'managedAccounts', []); return [...(this.cfg.accounts ?? [])]; }
  onConnectivity(cb) { this.w.rec(this.name, 'onConnectivity', []); this.connCbs.push(cb); }
  reqMarketDataType(t) { this.w.rec(this.name, 'reqMarketDataType', [t]); }

  async qualifyContracts(contracts, timeoutMs) {
    const list = this.cfg.qualify ?? [{ kind: 'ok' }];
    const out = list[Math.min(this.qIdx, list.length - 1)];
    this.qIdx += 1;
    this.w.rec(this.name, 'qualifyContracts', [contracts.map(norm), timeoutMs]);
    if (out.delay) await this.w.sleep(out.delay);
    this.w.rec(this.name, 'qualifyDone', [out.kind]);
    if (out.kind === 'ok') {
      contracts.forEach((c, i) => { const v = out.conIds && out.conIds[i] !== undefined ? out.conIds[i] : 700000 + i; if (v !== null) c.conId = v; });
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
      if (entry.data.error) { /* 订的那一刻就带着 error:不进缓存 */ } else this.streams.set(key, entry);
    }
    const e = entry;
    return {
      id: ++this.w.handleSeq,
      read: () => (this.streams.get(key) === e || e.data.error
        ? { ...e.data }
        : { ...emptyData(false, 0), error: '订阅已被撤销' }),
    };
  }

  cancelTicker(contract, generic) {
    this.w.rec(this.name, 'cancelTicker', [norm(contract), generic === undefined ? '*' : generic]);
    if (this.cfg.throwCancel) throw new Error('cancel boom');
    const base = this.w.tickerKey(contract);
    const keys = generic !== undefined ? [this.w.tickerKey(contract, generic)] : [...this.streams.keys()].filter((k) => k === base || k.startsWith(`${base}#`));
    for (const key of keys) this.streams.delete(key);
  }

  async settle(ms) { this.w.rec(this.name, 'settle', [ms]); this.w.advance(ms); }

  async historicalData(contract, opts) {
    this.w.rec(this.name, 'historicalData', [norm(contract), { endDateTime: opts.endDateTime, durationStr: opts.durationStr, barSizeSetting: opts.barSizeSetting, whatToShow: opts.whatToShow, useRTH: opts.useRTH }]);
    const k = `${contract.symbol}|${contract.exchange}`;
    const list = (this.cfg.hist ?? {})[k] ?? [{ error: `没有脚本:${k}` }];
    const i = this.hIdx[k] ?? 0;
    this.hIdx[k] = i + 1;
    const out = list[Math.min(i, list.length - 1)];
    if (out.delay) await this.w.sleep(out.delay);
    if (out.error !== undefined) throw new Error(out.error);
    return out.bars.map((b) => ({ ...dec(b) }));
  }
}

/** 在途的 Promise 记成可查的状态 */
export function track(p) {
  const s = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = e; });
  return s;
}
/** 阻塞的步:让钟一次走一秒,直到这一路有结果(最多 70 秒;C++ 那边是同一个循环) */
export async function runToDone(world, s) {
  for (let i = 0; i < 70; i += 1) {
    await drain();
    if (s.done) return;
    world.advance(1000);
  }
  await drain();
  if (!s.done) throw new Error('这一步卡住了:脚本写错');
}
export const outcome = (s, f = (v) => v) => (s.error !== undefined ? { error: String(s.error?.message ?? s.error) } : { ok: f(s.value) });

/** 种子固定的随机数(xorshift32) */
export function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  return { next, shuffle, pick: (a) => a[Math.floor(next() * a.length)], int: (n) => Math.floor(next() * n), chance: (p) => next() < p };
}
