// 生成 ib_session.json:engine-ts 的 ibSession.ts(createIbApiNextSession 跑在真的 @stoqey/ib IBApiNext 上)现跑,
// 给 C++ 的 native/engine/execution/ib_session.* 对拍(tests/tst_ib_session.cpp)。
//
// 两部分:
//   · 纯函数(tickerKey / applyPositionUpdate / tradeFromOrderStatus / fillFromExecDetails / execForwarder / realNumber / applyTicks
//     / candidatesOf / pickContractDetail / toIbOrder):原模块的导出直接调;后三个没导出,从 dist 里的同一份源码现拼一个
//     data: 模块把它们导出来(不改 engine-ts 的任何文件)。
//   · 会话:一个个脚本(scenarios)。脚本里只有"调会话的哪个方法 / TWS 那头接受、拒绝、送哪几条、关了 / 时间往前走多少"。
//     假 TWS 在 socket 这一层:net.connect 换成一个假 socket(事件同 Node 的 net.Socket:connect / data / end / error / close),
//     计时器换成假钟(setTimeout / clearTimeout / Date.now),所以每一步都是确定的。每一步之后记下:客户端写给 TWS 的每一条消息
//     (按字段)、socket 层的动作(连、end、destroy)、回调(onConnectivity / onLink / onOrderStatus / onFill / onCommission / onError)、
//     方法的结果或抛的话、stderr 上的日志、这一步里到点的计时器。C++ 那边把同样的脚本放给 ib_session,逐步比。
//     TWS 回话里的请求号用占位串 "$f:<消息号>:<格>[:<倒数第几条>]" 指向客户端已经发过的请求(按收到的请求回话,不按时刻)。
//   假 socket 的事件次序先在真的回环 net.Server 上量过(socketCalibration,只连自己开的端口),对不上就不生成。
//
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     native/tests/fixtures/gen_ib_session.mjs <engine-ts 目录>
//
// 报文全是合成的:账号是 U1234567 / DU7654321 这种样子的假号。
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给 engine-ts 目录');
const require = createRequire(join(engine, 'package.json'));
const net = require('net');
const ib = require('@stoqey/ib');
const { Decoder } = require('@stoqey/ib/dist/core/io/decoder.js');
const libVersion = require('@stoqey/ib/package.json').version;
const distDir = join(engine, 'dist/src/');
const S = await import(pathToFileURL(join(distDir, 'ibSession.js')).href);
// 没导出的三个:同一份 dist 源码,相对 import 换成绝对路径,末尾补一句 export
const P = await (async () => {
  let src = readFileSync(join(distDir, 'ibSession.js'), 'utf8');
  src = src.replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${pathToFileURL(join(distDir, f)).href}"`);
  src += '\nexport { pickContractDetail, candidatesOf, toIbOrder };\n';
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
})();

let seed = 0x1b5e_5510;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));

// ================================================================ socket 事件次序的标定(真的回环,在换掉计时器之前)
async function calibrate() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = net.createServer();
  let onConn = () => undefined;
  const conns = [];
  server.on('connection', (s) => { conns.push(s); s.on('error', () => undefined); onConn(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const watch = (sock, log) => {
    for (const ev of ['connect', 'end', 'close']) sock.on(ev, () => log.push(ev));
    sock.on('error', (e) => log.push(`error:${e.code}`));
    sock.on('data', () => log.push('data'));
  };
  const out = {};
  const run = async (name, serverAct, clientAct) => {
    const log = [];
    onConn = (s) => serverAct(s);
    const c = net.connect({ host: '127.0.0.1', port });
    watch(c, log);
    await wait(80);
    if (clientAct) { clientAct(c, log); await wait(80); }
    out[name] = [...log];
    c.destroy();
    for (const s of conns.splice(0)) s.destroy();
  };
  await run('serverEnd', (s) => setTimeout(() => s.end(), 20));
  await run('serverReset', (s) => setTimeout(() => s.resetAndDestroy(), 20));
  await run('serverData', (s) => setTimeout(() => s.write('x'), 20));
  await run('clientEndDestroy', () => undefined, (c) => { c.end(); c.destroy(); });
  await run('writeAfterDestroy', () => undefined, (c) => { c.end(); c.destroy(); c.write('late'); });
  await new Promise((r) => server.close(r));
  // 没人听的端口
  const log = [];
  const c = net.connect({ host: '127.0.0.1', port });
  watch(c, log);
  await wait(80);
  out.refused = log;
  const model = {
    serverEnd: ['connect', 'end', 'close'], serverReset: ['connect', 'error:ECONNRESET', 'close'], serverData: ['connect', 'data'],
    clientEndDestroy: ['connect', 'close'], writeAfterDestroy: ['connect', 'close'], refused: ['error:ECONNREFUSED', 'close'],
  };
  for (const k of Object.keys(model)) {
    if (JSON.stringify(model[k]) !== JSON.stringify(out[k])) throw new Error(`假 socket 的模型与真的 Node 不一致:${k} 真的是 ${JSON.stringify(out[k])}`);
  }
  return out;
}
const socketCalibration = await calibrate();
// 标定之后,真的 socket 一律不许再连(假 TWS 在下面换掉 net.connect;漏网的真连接当场炸,绝不碰 7496/7497/4001/4002)
net.Socket.prototype.connect = function realConnectForbidden() { throw new Error('生成器里不许开真的 socket 连接'); };
net.createConnection = () => { throw new Error('生成器里不许开真的 socket 连接'); };

// ================================================================ 假钟
const T0 = 1_760_000_000_000;
let now = 0;
let timers = [];
let timerSeq = 0;
const nodeDelay = (ms) => { const n = Number(ms); return n >= 1 && n <= 2147483647 ? Math.trunc(n) : 1; };
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = { seq: ++timerSeq, ms: nodeDelay(ms), due: 0, fn: () => fn(...args), cleared: false };
  t.due = now + t.ms;
  timers.push(t);
  return t;
};
globalThis.clearTimeout = (t) => { if (t && typeof t === 'object') t.cleared = true; };
globalThis.setInterval = () => { throw new Error('setInterval 不该被用到(看门狗没开)'); };
Date.now = () => T0 + now;

// stderr(pickContractDetail 的那一行日志)
let stderrLines = [];
process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

// ================================================================ 假 socket
let ioQueue = [];
let sockets = [];
let frames = [];       // 客户端写给 TWS 的每一条(跨连接,按先后)
let stepRec = null;    // 这一步的记录
let unmodelled = null;
const rec = (k, v) => { (stepRec[k] ??= []).push(v); };

class FakeSocket extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.destroyed = false;
    this.ended = false;
    this.remoteEnded = false;
    this.buf = Buffer.alloc(0);
    this.handshaken = false;
    sockets.push(this);
    rec('io', ['connect', String(opts.host), Number(opts.port)]);
  }
  write(data) {
    if (this.remoteEnded && !this.localDestroyed) unmodelled = 'write after remote end';
    if (this.destroyed) return false;
    if (this.ended) unmodelled = 'write after end';
    this.buf = Buffer.concat([this.buf, Buffer.from(data)]);
    for (;;) {
      if (!this.handshaken) {
        if (this.buf.length < 8) return true;
        const n = this.buf.readUInt32BE(4);
        if (this.buf.length < 8 + n) return true;
        const f = ['HS', this.buf.subarray(0, 4).toString('latin1'), this.buf.subarray(8, 8 + n).toString('utf8')];
        this.buf = this.buf.subarray(8 + n);
        this.handshaken = true;
        frames.push(f);
        rec('sent', f);
        continue;
      }
      if (this.buf.length < 4) return true;
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) return true;
      const fields = this.buf.subarray(4, 4 + n).toString('utf8').split('\0');
      if (fields[fields.length - 1] === '') fields.pop();
      else unmodelled = 'frame without trailing NUL';
      this.buf = this.buf.subarray(4 + n);
      frames.push(fields);
      rec('sent', fields);
    }
  }
  end() { this.ended = true; rec('io', ['end']); }
  destroy() {
    rec('io', ['destroy']);
    this.destroyed = true;
    this.localDestroyed = true;
    this.closeSoon(false);
  }
  /// 'close' 只来一次,在下一轮事件里(Node 的 handle 关完才发)
  closeSoon(hadError) {
    if (this.closeQueued) return;
    this.closeQueued = true;
    ioQueue.push(() => this.emit('close', hadError));
  }
}
net.connect = (opts, cb) => {
  const s = new FakeSocket(opts);
  if (cb) s.once('connect', cb);
  return s;
};
const live = () => sockets[sockets.length - 1];

// ================================================================ TWS 回话
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const frameBytes = (fields) => { const p = Buffer.from(fields.map((x) => `${x}\0`).join(''), 'utf8'); return Buffer.concat([be32(p.length), p]); };
function resolveField(x) {
  if (typeof x !== 'string' || !x.startsWith('$f:')) return String(x);
  const [, msg, idx, k] = x.split(':');
  const hits = frames.filter((f) => f[0] === msg);
  const f = hits[hits.length - 1 - Number(k ?? 0)];
  if (!f) throw new Error(`占位 ${x} 指向的请求还没发过`);
  return f[Number(idx)];
}

// 复杂消息(合约详情、成交、未成交单)的格位:拿解码器现量——每格换成记号,看它落到事件参数的哪个键上
function recordLayout(version, msgId) {
  const log = [String(msgId)];
  const kinds = [''];
  let kind = 'readStr';
  const d = new Decoder({ serverVersion: version, emitEvent() {}, emitError() {}, emitInfo() {} });
  for (const m of ['readBool', 'readDouble', 'readDoubleOrUndefined', 'readDecimal', 'readInt', 'readIntOrUndefined']) {
    const orig = d[m].bind(d);
    d[m] = () => { const prev = kind; kind = m; try { return orig(); } finally { kind = prev; } };
  }
  d.readStr = () => {
    if (log.length > 400) throw new Error('stop');
    const t = kind === 'readStr' ? '' : '0';
    log.push(t);
    kinds.push(kind);
    return t;
  };
  d.processMsg(msgId);
  return { tokens: log, kinds };
}
function decodeEvents(version, tokens) {
  const emits = [];
  const d = new Decoder({
    serverVersion: version,
    emitEvent: (name, ...args) => emits.push({ name, args }),
    emitError: (msg, code) => emits.push({ name: 'error', args: [msg, code] }),
    emitInfo: (msg, code) => emits.push({ name: 'info', args: [msg, code] }),
  });
  d.enqueueMessage(tokens);
  d.process();
  return emits;
}
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const layoutCache = new Map();
function slotOf(version, msgId, event, path) {
  const key = `${version}|${msgId}|${path}`;
  if (layoutCache.has(key)) return layoutCache.get(key);
  const { tokens } = recordLayout(version, msgId);
  let found = -1;
  for (const [mark, want] of [['987654', '987654'], ['C', 'C'], ['1', 'true']]) {
    for (let i = 1; i < tokens.length && found < 0; i += 1) {
      const t = [...tokens];
      t[i] = mark;
      let ev;
      try { ev = decodeEvents(version, t).find((e) => e.name === event); } catch { continue; }
      if (ev && String(getPath(ev.args, path)) === want) found = i;
    }
  }
  if (found < 0) throw new Error(`量不出 ${msgId} 的 ${path}`);
  layoutCache.set(key, found);
  return found;
}
const resolveFieldLater = (x) => (typeof x === 'string' && x.startsWith('$f:') ? '1' : x);
function complexMsg(version, msgId, event, values) {
  const t = [...recordLayout(version, msgId).tokens];
  for (const [path, v] of Object.entries(values)) t[slotOf(version, msgId, event, path)] = v;
  const ev = decodeEvents(version, t.map(resolveFieldLater)).find((e) => e.name === event);
  for (const [path, v] of Object.entries(values)) {
    const got = getPath(ev?.args, path);
    const sentinel = String(v).startsWith('1.79769');
    if (String(got) !== String(v) && Number(got) !== Number(v) && !(typeof got === 'boolean' && got === (v === '1')) && !(sentinel && (got === undefined || got === Number.MAX_VALUE)) && !String(v).startsWith('$f:') && !(v === '' && got === undefined))
      throw new Error(`${msgId} 的 ${path} 造出来是 ${got},要的是 ${v}`);
  }
  return t;
}

// 简单消息(v100..193 都一样的那几种;版本 ≥ 156 的期权计算、≥ 150 的 orderStatus 不带版本号)
const M = {
  version: (v = 193) => [String(v), '20261020 10:00:00 Asia/Shanghai'],
  managed: (a = 'U1234567,DU7654321') => ['15', '1', a],
  nextId: (id) => ['9', '1', String(id)],
  err: (id, code, msg, adv = '') => ['4', '2', String(id), String(code), msg, adv],
  tickPrice: (id, type, price, size = '0', mask = '0') => ['1', '6', id, String(type), String(price), String(size), mask],
  tickSize: (id, type, size) => ['2', '6', id, String(type), String(size)],
  tickGeneric: (id, type, v) => ['45', '6', id, String(type), String(v)],
  tickString: (id, type, v) => ['46', '6', id, String(type), String(v)],
  optComp: (id, type, iv, delta, price, pv, gamma, vega, theta, und) => ['21', id, String(type), '0', iv, delta, price, pv, gamma, vega, theta, und].map(String),
  orderStatus: (id, status, filled, remaining, avg, permId, parentId = '0', last = '0', clientId = '0', why = '', cap = '0') =>
    ['3', String(id), status, String(filled), String(remaining), String(avg), String(permId), parentId, last, clientId, why, cap],
  depth: (id, pos, op, side, price, size) => ['12', '1', id, String(pos), String(op), String(side), String(price), String(size)],
  depthL2: (id, pos, mm, op, side, price, size, smart = '1') => ['13', '1', id, String(pos), mm, String(op), String(side), String(price), String(size), smart],
  hist: (id, bars) => ['17', id, '20261019 09:30:00', '20261020 16:00:00', String(bars.length), ...bars.flatMap((b) => b.map(String))],
  cdEnd: (id) => ['52', '1', id],
  ooEnd: () => ['53', '1'],
  execEnd: (id) => ['55', '1', id],
  commission: (execId, comm, cur = 'USD', pnl = '1.7976931348623157E308') => ['59', '1', execId, String(comm), cur, String(pnl), '1.7976931348623157E308', '0'],
  position: (acct, conId, sym, sec, ltd, strike, right, mult, qty, avg, tc = '') =>
    ['61', '3', acct, String(conId), sym, sec, ltd, String(strike), right, mult, '', 'USD', '', tc, String(qty), String(avg)],
  posEnd: () => ['62', '1'],
  summary: (id, acct, tag, value, cur) => ['63', '1', id, acct, tag, String(value), cur],
  summaryEnd: (id) => ['64', '1', id],
  secDef: (id, exch, conId, tc, mult, exps, strikes) => ['75', id, exch, String(conId), tc, String(mult), String(exps.length), ...exps, String(strikes.length), ...strikes.map(String)],
  secDefEnd: (id) => ['76', id],
  pnl: (id, d, u, r) => ['94', id, String(d), String(u), String(r)],
};
const contractDetails = (v, id, c) => complexMsg(v, 10, 'contractDetails', {
  0: id, '1.contract.symbol': c.symbol ?? 'SPX', '1.contract.secType': c.secType ?? 'OPT', '1.contract.conId': String(c.conId),
  '1.contract.exchange': c.exchange ?? 'SMART', '1.contract.tradingClass': c.tradingClass ?? '', '1.contract.currency': 'USD',
  '1.tradingHours': c.tradingHours ?? '20261020:0930-20261020:1615', '1.liquidHours': c.liquidHours ?? '20261020:0930-20261020:1600',
  '1.timeZoneId': c.timeZoneId ?? 'US/Eastern',
});
const execMsg = (v, reqId, e) => complexMsg(v, 11, 'execDetails', {
  0: reqId, '1.symbol': e.symbol ?? 'SPX', '1.secType': e.secType ?? 'OPT', '1.conId': String(e.conId ?? 920693462), '1.strike': String(e.strike ?? 7790),
  '1.right': e.right ?? 'P', '2.orderId': String(e.orderId ?? 0), '2.execId': e.execId, '2.time': e.time ?? '20261020-15:59:06',
  '2.acctNumber': e.acct ?? 'U1234567', '2.side': e.side ?? 'BOT', '2.shares': String(e.shares ?? 1), '2.price': String(e.price ?? 8.58),
  '2.permId': String(e.permId ?? 1165676521), '2.cumQty': String(e.cumQty ?? 1), '2.avgPrice': String(e.avgPrice ?? e.price ?? 8.58),
});
const openOrderMsg = (v, o) => complexMsg(v, 5, 'openOrder', {
  '2.orderId': String(o.orderId), '1.symbol': o.symbol ?? 'SPX', '1.secType': o.secType ?? 'OPT', '1.conId': String(o.conId ?? 920693462),
  '1.strike': String(o.strike ?? 7790), '1.right': o.right ?? 'P', '1.exchange': o.exchange ?? 'SMART', '1.tradingClass': o.tradingClass ?? 'SPXW',
  '1.lastTradeDateOrContractMonth': o.ltd ?? '20261020', '1.multiplier': o.multiplier ?? '100',
  '2.action': o.action ?? 'SELL', '2.totalQuantity': String(o.qty ?? 1), '2.orderType': o.orderType ?? 'LMT', '2.lmtPrice': String(o.lmtPrice ?? 12.5),
  '2.auxPrice': String(o.auxPrice ?? '1.7976931348623157E308'), '2.tif': o.tif ?? 'GTC', '2.ocaGroup': o.ocaGroup ?? '', '2.account': o.account ?? 'U1234567',
  '2.outsideRth': o.outsideRth ?? '0', '2.orderRef': o.orderRef ?? '', '2.permId': String(o.permId ?? 0), '2.ocaType': String(o.ocaType ?? 0),
  '2.trailingPercent': String(o.trailingPercent ?? '1.7976931348623157E308'), '3.status': o.status ?? 'Submitted',
});

// ================================================================ 方法结果的记法(C++ 那边同样的记法)
const tickerOut = (d) => d;
function fmt(m, v, args) {
  switch (m) {
    case 'qualifyContracts': return args[0].map((c) => ({ conId: c.conId ?? null, exchange: c.exchange ?? null, tradingClass: c.tradingClass ?? null }));
    case 'openTrades': return v.map((t) => ({ orderId: t.orderId }));
    case 'read': return tickerOut(v);
    default: return v === undefined ? null : v;
  }
}

// ================================================================ 跑一个脚本
const drain = () => new Promise((r) => setImmediate(r));
async function settle() {
  await drain();
  while (ioQueue.length) {
    ioQueue.shift()();
    await drain();
  }
}

async function runScenario(sc) {
  now = 0; timers = []; timerSeq = 0; ioQueue = []; sockets = []; frames = []; unmodelled = null;
  const trace = [];
  let session = null;
  const handles = new Map();
  const tradeLists = new Map();
  const errTokens = new Map();
  const historyQueue = [...(sc.history ?? [])];
  const fetchHistory = async (req) => {
    rec('io', ['history', req.host, req.port, req.clientId, req.days]);
    const h = historyQueue.shift() ?? { error: '没有准备回话' };
    if (h.error) throw new Error(h.error);
    return h;
  };
  const cb = (...x) => rec('cb', enc(x));
  const result = (id, p, m, args) => {
    Promise.resolve(p).then((v) => rec('res', [id, 'ok', enc(fmt(m, v, args))]), (e) => rec('res', [id, 'err', String(e?.message ?? e)]));
  };
  const call = (st) => {
    const { id, m } = st;
    const a = structuredClone(st.a ?? []);
    if (m === 'create') {
      result(id, S.createIbApiNextSession(a[0], { mod: ib, fetchHistory }).then((s) => {
        session = s;
        s.onConnectivity((c) => cb('conn', c));
        s.onLink((up) => cb('link', up));
        s.onOrderStatus((t) => cb('status', t));
        s.onFill((t, f) => cb('fill', t, f));
        s.onCommission((t, f, r) => cb('comm', t, f, r));
        const f = (r, c, msg) => cb('err', r, c, msg);
        errTokens.set('main', f);
        s.onError(f);
      }), m, a);
      return;
    }
    if (m === 'onSecond') {
      session.onConnectivity((c) => cb('conn2', c));
      session.onLink((up) => cb('link2', up));
      session.onOrderStatus((t) => cb('status2', t));
      session.onFill((t, f) => cb('fill2', t, f));
      session.onCommission((t, f, r) => cb('comm2', t, f, r));
      return;
    }
    if (m === 'onError2') { const f = (r, c, msg) => cb('err2', r, c, msg); errTokens.set('e2', f); session.onError(f); return; }
    if (m === 'offError') { session.offError(errTokens.get(a[0])); return; }
    if (m === 'read') { rec('res', [id, 'ok', enc(handles.get(a[0]).read())]); return; }
    if (m === 'cancelTrade') { tradeLists.get(a[0])[a[1]].cancel(); return; }
    let v;
    try {
      v = session[m](...a);
    } catch (e) {
      rec('res', [id, 'err', String(e?.message ?? e)]);
      return;
    }
    if (m === 'subscribeTicker') { handles.set(id, v); rec('res', [id, 'ok', null]); return; }
    if (m === 'openTrades') { Promise.resolve(v).then((list) => tradeLists.set(id, list), () => undefined); }
    if (v && typeof v.then === 'function') result(id, v, m, a);
    else rec('res', [id, 'ok', enc(fmt(m, v, a))]);
  };
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      timers = timers.filter((t) => !t.cleared);
      let next = null;
      for (const t of timers) if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.due;
      rec('fired', next.ms);
      next.fn();
      await settle();
    }
    now = target;
  };
  for (const st of sc.steps) {
    stepRec = {};
    stderrLines = [];
    switch (st.op) {
      case 'call': call(st); break;
      case 'accept': if (!live().destroyed) live().emit('connect'); break;
      case 'refuse': {
        const s = live();
        s.destroyed = true;
        s.emit('error', Object.assign(new Error(`connect ECONNREFUSED ${s.opts.host}:${s.opts.port}`), { code: 'ECONNREFUSED' }));
        s.closeSoon(true);
        break;
      }
      case 'send': {
        const s = live();
        const bytes = Buffer.concat(st.msgs.map((m) => frameBytes(m.map(resolveField))));
        if (!s.destroyed) s.emit('data', bytes);
        for (const t of st.then ?? []) call(t);  // 同一拍里紧接着再调(中间不让 I/O 落地)
        break;
      }
      case 'multi': for (const t of st.steps) call(t); break;
      case 'sendFill': {
        // 一块 len 字节:开头 4 字节声明一条超大的消息(永远凑不齐),其余是 0——只为把接收缓冲撑到指定的字节数
        const s = live();
        const b = Buffer.alloc(st.len);
        b.writeInt32BE(0x7fffffff, 0);
        if (!s.destroyed) s.emit('data', b);
        break;
      }  // 同一拍里连调几个方法
      case 'sendRaw': {
        // 原样的字节(十六进制):不以 \0 结尾的消息,尾巴留给下一条(socket.js 的 dataFragment)
        const s = live();
        if (!s.destroyed) s.emit('data', Buffer.from(st.hex, 'hex'));
        break;
      }
      case 'end': {
        const s = live();
        if (s.destroyed) break;
        s.remoteEnded = true;
        s.destroyed = true;
        s.emit('end');
        s.closeSoon(false);
        break;
      }
      case 'reset': {
        const s = live();
        if (s.destroyed) break;
        s.destroyed = true;
        s.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
        s.closeSoon(true);
        break;
      }
      case 'advance': await advance(st.ms); break;
      default: throw new Error(`${sc.name}:第 ${sc.steps.indexOf(st)} 步不认识 ${JSON.stringify(st)}`);
    }
    await settle();
    if (stderrLines.length) stepRec.log = stderrLines.map((l) => l.replace(/\n$/, ''));
    if (unmodelled) throw new Error(`${sc.name}:走到了假 socket 没建模的路径(${unmodelled})`);
    trace.push(stepRec);
  }
  return trace;
}

// ================================================================ 脚本
const scenarios = [];
const V = 193;
const CFG = { host: '127.0.0.1', port: 7497, clientId: 12, readonly: false };
let callId = 0;
const call = (m, ...a) => ({ op: 'call', id: ++callId, m, a });
const send = (...msgs) => ({ op: 'send', msgs });
const advance = (ms) => ({ op: 'advance', ms });
const handshake = (v = V, accounts = 'U1234567,DU7654321') => [
  call('create', CFG), { op: 'accept' }, send(M.version(v)), send(M.managed(accounts)), send(M.nextId(1)), send(M.err(-1, 2104, 'Market data farm connection is OK:usfarm')),
];
function scenario(name, steps, extra = {}) { scenarios.push({ name, steps, ...extra }); }

const SPX_P = { secType: 'OPT', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20261020', strike: 6700, right: 'P', multiplier: '100', tradingClass: 'SPXW' };
const ES = { secType: 'FUT', symbol: 'ES', exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '202612' };
const AAPL = { secType: 'STK', symbol: 'AAPL', exchange: 'SMART', currency: 'USD' };
const LMT = { orderType: 'LMT', action: 'BUY', totalQuantity: 1, lmtPrice: 2.5, auxPrice: null, trailingPercent: null, tif: 'DAY', outsideRth: false, account: 'U1234567', transmit: true };
if (process.argv[3] === 'discover') {
  scenario('discover', [...handshake(), call('subscribeTicker', SPX_P, ''), call('positions'), call('qualifyContracts', [ES], 3000),
    call('historicalData', AAPL, { endDateTime: '', durationStr: '1 D', barSizeSetting: '5 mins', whatToShow: 'TRADES', useRTH: true }),
    call('secDefOptParams', 'SPX', 'IND', 416904), call('mktDepth', ES, 5, 500), call('placeOrder', SPX_P, LMT), call('openTrades'), call('executions'),
    call('accountPnl', 'U1234567'), call('cancelOrder', 7), call('reqMarketDataType', 3), advance(100), advance(100), advance(100), advance(100)]);
}
const rq = {
  mkt: (k = 0) => `$f:1:2:${k}`, cd: (k = 0) => `$f:9:2:${k}`, hist: (k = 0) => `$f:20:1:${k}`, sec: (k = 0) => `$f:78:1:${k}`,
  depth: (k = 0) => `$f:10:2:${k}`, exec: (k = 0) => `$f:7:2:${k}`, sum: (k = 0) => `$f:62:2:${k}`, pnl: (k = 0) => `$f:92:1:${k}`,
};
const tick = () => advance(100);
const ticks = (n) => Array.from({ length: n }, () => tick());
const est = (v = V) => handshake(v);
const sub = (c, g) => (g === undefined ? call('subscribeTicker', c) : call('subscribeTicker', c, g));
const read = (s) => call('read', s.id);
const A = 'U1234567';
const DU = 'DU7654321';
const SPX_P_NOTC = { secType: 'OPT', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20261020', strike: 6700, right: 'P', multiplier: '100' };
const SPX_C = { ...SPX_P, right: 'C', strike: 6750 };
const SPX_IND = { secType: 'IND', symbol: 'SPX', exchange: 'CBOE', currency: 'USD' };
const ES_FOP = { secType: 'FOP', symbol: 'ES', exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '20261020', strike: 6700, right: 'C', multiplier: '50', tradingClass: 'E3A' };
const BAG = { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', comboLegs: [
  { conId: 801, ratio: 1, action: 'BUY', exchange: 'SMART' }, { conId: 802, ratio: 2, action: 'SELL', exchange: 'SMART' }, { conId: 803, ratio: 1, action: 'BUY', exchange: 'SMART' }] };
const posSPX = (acct, conId, strike, qty, avg = 1234.5) => M.position(acct, conId, 'SPX', 'OPT', '20261020', strike, 'P', '100', qty, avg, 'SPXW');
const MKT = { ...LMT, orderType: 'MKT', lmtPrice: null };
const STP = { ...LMT, orderType: 'STP', lmtPrice: null, auxPrice: 6600, action: 'SELL', tif: 'GTC' };

// ---------------------------------------------------------------- 连接
scenario('connect_ok', [...est(), call('isConnected'), call('managedAccounts'), call('managedAccounts')]);
scenario('connect_nextid_first', [call('create', CFG), { op: 'accept' }, send(M.version()), send(M.nextId(1)), send(M.err(-1, 2104, 'Market data farm connection is OK:usfarm')),
  send(M.managed(A)), call('managedAccounts'), tick(), send(M.managed(DU)), call('managedAccounts'), call('isConnected')]);
scenario('connect_one_chunk', [call('create', CFG), { op: 'accept' }, send(M.version()),
  send(M.managed(), M.nextId(1), M.err(-1, 2104, 'Market data farm connection is OK:usfarm'), M.orderStatus(5, 'Submitted', 0, 1, 0, 99)),
  send(M.orderStatus(5, 'Submitted', 0, 1, 0, 99), M.err(-1, 2106, 'HMDS data farm connection is OK:ushmds'))]);
scenario('connect_timeout_silent', [call('create', CFG), { op: 'accept' }, advance(9999), advance(1), advance(20000)]);
scenario('connect_refused', [call('create', CFG), { op: 'refuse' }, advance(5000), advance(300), { op: 'refuse' }, advance(4699), advance(1), advance(20000)]);
scenario('connect_unsupported_version', [call('create', CFG), { op: 'accept' }, send(M.version(99)), advance(5000), { op: 'accept' }, send(M.version(V)),
  send(M.managed(A)), send(M.nextId(3)), call('isConnected'), call('managedAccounts')]);
scenario('connect_version_too_new', [call('create', CFG), { op: 'accept' }, send(M.version(200)), advance(4000), advance(1000), { op: 'accept' }, send(M.version(187)),
  send(M.nextId(3)), send(M.managed(A))]);
scenario('connect_drop_before_accounts', [call('create', CFG), { op: 'accept' }, send(M.version()), { op: 'end' }, advance(5000), { op: 'accept' }, send(M.version()),
  send(M.managed(A), M.nextId(1)), call('isConnected')]);
scenario('connect_reset_then_timeout', [call('create', CFG), { op: 'accept' }, send(M.version()), { op: 'reset' }, advance(5000), { op: 'accept' }, advance(5000)]);

// ---------------------------------------------------------------- 断线与重连
{
  const t1 = sub(SPX_P, '');
  const t2 = sub(AAPL, '165,104,595');
  scenario('reconnect_after_drop', [...est(), call('setBaselineMarketDataType', 3), t1, t2, call('positions'), tick(),
    send(posSPX(A, 920693462, 6700, 2), M.posEnd()), send(M.tickPrice(rq.mkt(1), 1, 12.3, 5), M.tickPrice(rq.mkt(1), 2, 12.6, 7)),
    send(M.tickPrice(rq.mkt(0), 4, 230.5, 100)), read(t1), read(t2), call('quoteDelayed', AAPL), call('accountPnl', A), tick(),
    { op: 'end' }, call('isConnected'), read(t1), call('positions'), call('accountPnl', A), call('netLiquidation', A), call('quoteDelayed', AAPL),
    advance(4999), advance(1), { op: 'accept' }, send(M.version()), send(M.managed()), send(M.nextId(10)), ...ticks(3),
    call('isConnected'), read(t1), p2 = call('positions'), send(posSPX(A, 920693462, 6700, 3), M.posEnd()), call('managedAccounts'),
    send(M.tickPrice(rq.mkt(1), 1, 12.4, 5)), read(t1)]);
  var p2;
}
{
  const t = sub(ES, '');
  scenario('info_1100_2110', [...est(), t, tick(), send(M.tickPrice(rq.mkt(), 4, 6750.25, 2)), send(M.err(-1, 1100, 'Connectivity between IB and Trader Workstation has been lost.')),
    call('isConnected'), read(t), send(M.tickPrice(rq.mkt(), 4, 6751, 1)), advance(5000), { op: 'accept' }, send(M.version()), send(M.managed()), send(M.nextId(20)), tick(),
    read(t), send(M.err(-1, 2110, 'Connectivity between Trader Workstation and server is broken. It will be restored automatically.')), call('isConnected'),
    advance(5000), { op: 'accept' }, send(M.version()), send(M.nextId(21)), send(M.managed(A)), tick(), send(M.err(-1, 1102, 'Connectivity between IB and Trader Workstation has been restored - data maintained.')),
    send(M.err(-1, 1101, 'Connectivity between IB and Trader Workstation has been restored - data lost.')), call('isConnected'), call('managedAccounts')]);
}
scenario('reconnect_refused_loop', [...est(), sub(ES, ''), tick(), { op: 'reset' }, advance(5000), { op: 'refuse' }, advance(5000), { op: 'refuse' }, advance(5000),
  { op: 'accept' }, send(M.version(176)), send(M.nextId(4), M.managed(A)), ...ticks(2), call('isConnected')]);

// ---------------------------------------------------------------- 行情
{
  const t = sub(ES, '');
  const t2 = sub(ES, '');
  scenario('ticker_rejected_10197', [...est(), t, tick(), send(M.err(rq.mkt(), 10197, 'No market data during competing live session')), read(t), t2, tick(), read(t2),
    send(M.tickPrice(rq.mkt(), 1, 6750, 3)), read(t2), read(t), send(M.err(rq.mkt(), 354, `Requested market data is not subscribed.${' Check API status by selecting the Account menu then under Management choose Market Data Subscription Manager.'.repeat(2)}`)), read(t2)]);
}
{
  const t = sub(AAPL, '');
  scenario('ticker_nonfatal', [...est(), t, tick(), send(M.err(rq.mkt(), 10167, 'Requested market data is not subscribed. Displaying delayed market data.')),
    send(M.err(rq.mkt(), 2137, 'The closing order quantity is greater than your current position.')), send(M.err(rq.mkt(), 300, 'Warning: something odd')), send(M.err(rq.mkt(), 2500, 'informational')),
    send(M.tickPrice(rq.mkt(), 68, 230.5, 10)), read(t), call('quoteDelayed', AAPL), send(M.tickPrice(rq.mkt(), 4, 231, 10)), call('quoteDelayed', AAPL),
    call('quoteDelayed', { ...AAPL, exchange: 'NASDAQ' }), call('quoteDelayed', ES), send(M.err(rq.mkt(), 10090, 'Part of requested market data is not subscribed.')), read(t)]);
}
{
  const a = sub(SPX_P, '');
  const b = sub(SPX_P, '');
  const c = sub(SPX_P, '100,101,106');
  const d = sub({ ...SPX_P, tradingClass: 'SPX' }, '');
  const e = sub(SPX_P, '');
  const f = sub(SPX_P);
  scenario('ticker_detached_and_cancel', [...est(), a, b, c, d, tick(), send(M.tickPrice(rq.mkt(2), 1, 10, 1)), read(a), read(b), call('cancelTicker', SPX_P),
    read(a), read(b), read(c), read(d), e, tick(), read(a), read(e), call('cancelTicker', SPX_P, '100,101,106'), call('cancelTicker', { ...SPX_P, tradingClass: 'SPX' }, ''),
    read(d), f, read(f), call('cancelTicker', SPX_P, ''), read(f), call('cancelTicker', ES), tick()]);
}
{
  const o = sub(SPX_P, '');
  const s = sub(AAPL, '165,104,595');
  const tp = (t, p, sz = 0) => M.tickPrice(rq.mkt(1), t, p, sz);
  const ts = (t, v) => M.tickSize(rq.mkt(1), t, v);
  const so = (...x) => M.tickPrice(rq.mkt(0), ...x);
  scenario('ticks_full', [...est(), s, o, tick(),
    send(tp(1, 230.1, 300)), read(s), send(tp(2, 230.3, 200)), read(s), send(tp(1, -1, 0)), read(s), send(tp(66, 229.9, 5)), read(s), send(tp(4, 230.2, 50)), read(s),
    send(tp(68, 229.5, 3)), read(s), send(tp(9, 228), tp(14, 228.5), tp(6, 231), tp(7, 227.5)), read(s), send(ts(8, 7930000), ts(21, 9100000)), read(s),
    send(M.tickGeneric(rq.mkt(1), 23, 0.2834), M.tickSize(rq.mkt(1), 63, 12000), M.tickSize(rq.mkt(1), 64, 21000), M.tickSize(rq.mkt(1), 65, 40000)), read(s),
    send(M.tickString(rq.mkt(1), 45, '1760970000')), read(s), send(M.tickString(rq.mkt(1), 45, 'abc')), read(s), send(M.tickString(rq.mkt(1), 88, '1760970100')), read(s),
    send(ts(27, 1500), ts(28, 1700), ts(29, 300), ts(30, 400)), read(s), send(tp(2, -1)), read(s), send(tp(75, 227), tp(76, 228), tp(72, 232), tp(73, 226), M.tickSize(rq.mkt(1), 74, 5000)), read(s),
    send(so(1, 11.9, 4), so(2, 12.2, 6)), read(o),
    send(M.optComp(rq.mkt(0), 13, 0.182, -0.31, 12.05, 0, 0.0021, 2.1, -1.5, 6750)), read(o),
    send(M.optComp(rq.mkt(0), 83, 0.19, -0.3, 12.1, 0, 0.0022, 2, -1.4, 6751)), read(o),
    send(M.optComp(rq.mkt(0), 10, 0.18, -0.31, 11.9, 0, 0.002, 2, -1.5, 6750)), read(o),
    send(M.optComp(rq.mkt(0), 13, '-1', '-2', '-1', '-1', '-2', '-2', '-2', '-1')), read(o),
    send(so(4, 12, 1), so(9, 11.5)), read(o), send(so(1, 0), so(2, 0)), read(o), advance(250), send(M.tickSize(rq.mkt(0), 0, 5)), read(o)]);
}

// ---------------------------------------------------------------- 持仓
scenario('positions_splice_bug', [...est(), call('positions'), call('positions'), tick(),
  send(posSPX(A, 101, 6700, 1), posSPX(A, 102, 6705, -2), posSPX(A, 103, 6710, 1), posSPX(DU, 104, 6700, 5), M.position(A, 265598, 'AAPL', 'STK', '', 0, '', '', 100, 180.25)),
  send(M.posEnd()), call('positions'), send(posSPX(A, 101, 6700, 0)), call('positions'), send(posSPX(A, 102, 6705, -1)), call('positions'),
  send(posSPX(A, 105, 6720, 3)), call('positions'), send(posSPX(A, 103, 6710, 0)), call('positions'), send(posSPX(DU, 104, 6700, 0), posSPX(DU, 104, 6700, 2)), call('positions')]);
scenario('positions_timeout', [...est(), call('positions'), advance(7999), advance(1), tick(), call('positions'), call('positions'), tick(), advance(3000),
  send(posSPX(A, 101, 6700, 1), M.posEnd()), call('positions'), advance(10000)]);
scenario('positions_empty', [...est(), call('positions'), tick(), send(M.posEnd()), call('positions'), send(posSPX(A, 101, 6700, 0)), call('positions')]);

// ---------------------------------------------------------------- 成交与佣金
{
  const ex = call('executions');
  scenario('exec_dedupe', [...est(),
    send(execMsg(V, '-1', { execId: '0001.01', orderId: 11, permId: 501, price: 8.58 })), send(M.commission('0001.01', 1.05)), send(M.commission('0001.01', 1.05)),
    send(M.commission('9999.99', 2)), ex, tick(),
    send(execMsg(V, rq.exec(), { execId: '0001.01', orderId: 11, permId: 501, price: 8.58 })),
    send(execMsg(V, rq.exec(), { execId: '0002.01', orderId: 12, permId: 502, price: 7.1, side: 'SLD', shares: 2, cumQty: 2 })),
    send(execMsg(V, '-1', { execId: '0003.01', orderId: 13, permId: 0, price: 3 })),
    send(M.commission('0001.01', 1.05), M.commission('0002.01', 0.65)), send(M.commission('0003.01', 0.65)), send(M.execEnd(rq.exec())),
    call('executions'), tick(), send(M.execEnd(rq.exec())),
    send(execMsg(V, '-1', { execId: '', orderId: 0, permId: 0 })), send(execMsg(V, '-1', { execId: '', orderId: 0, permId: 0 })), send(M.commission('', 1)),
    call('executions'), call('executions'), tick(), send(execMsg(V, rq.exec(1), { execId: '0004.01' })), send(M.execEnd(rq.exec(1))), send(M.execEnd(rq.exec(0)))]);
}

// ---------------------------------------------------------------- 下单、改单、撤单
scenario('orders_new_modify_cancel', [...est(), call('placeOrder', SPX_P, LMT), tick(), send(M.nextId(101)), tick(),
  call('placeOrder', SPX_P, { ...LMT, orderId: 101, lmtPrice: 2.45 }), call('cancelOrder', 101), tick(),
  call('placeOrder', ES, MKT), call('placeOrder', AAPL, STP), tick(), send(M.nextId(102)), send(M.nextId(103)), ...ticks(2),
  send(M.err(103, 201, 'Order rejected - reason:The order size exceeds the maximum.')),
  send(openOrderMsg(V, { orderId: 101, permId: 777 })), send(M.orderStatus(101, 'Submitted', 0, 1, 0, 777)),
  send(M.orderStatus(101, 'Filled', 1, 0, 2.45, 777, '0', '2.45')), send(M.orderStatus(555, 'Cancelled', 0, 1, 0, 0)),
  send(M.orderStatus(101, 'Filled', '', '', '', '')), call('placeOrder', SPX_P, { ...LMT, orderId: 0 }), tick(), send(M.nextId(104)), tick(),
  call('cancelOrder', 104), call('cancelOrder', 1e9), tick()]);
scenario('orders_during_disconnect', [...est(), { op: 'end' }, call('placeOrder', SPX_P, { ...LMT, orderId: 300 }), call('cancelOrder', 300), call('placeOrder', ES, MKT),
  advance(5000), { op: 'accept' }, send(M.version()), send(M.managed()), send(M.nextId(301)), ...ticks(3), send(M.nextId(302)), ...ticks(2)]);
{
  const cond = (price, conId, exchange, isMore) => ({ price, conId, exchange, isMore });
  scenario('orders_oca_conditions_trail', [...est(),
    call('placeOrder', SPX_P, { ...LMT, action: 'SELL', lmtPrice: 25, ocaGroup: 'dafri-trk-7', orderRef: 'dafri:trk:7', orderId: 2001, tif: 'GTC' }),
    call('placeOrder', SPX_P, { ...STP, ocaGroup: 'dafri-trk-7', ocaType: 2, orderRef: 'dafri:trk:7', orderId: 2002, outsideRth: true }),
    call('placeOrder', AAPL, { ...LMT, orderType: 'TRAIL', lmtPrice: null, trailingPercent: 5, trailStopPrice: 171.5, orderId: 2003, action: 'SELL', totalQuantity: 100 }),
    call('placeOrder', SPX_P, { ...MKT, orderId: 2004, action: 'SELL', conditions: [cond(6600, 416904, 'CBOE', false)], conditionsCancelOrder: true }), tick(),
    call('placeOrder', BAG, { ...LMT, orderId: 2005, lmtPrice: -1.2, conditions: [cond(6800, 416904, 'CBOE', true), cond(6500, 416904, 'CBOE', false)] }),
    call('placeOrder', ES_FOP, { ...LMT, orderType: 'STP LMT', auxPrice: 20, lmtPrice: 19.5, orderId: 2006, transmit: false, account: DU }),
    call('placeOrder', SPX_IND, { ...LMT, orderType: 'MIDPRICE', orderId: 2007, lmtPrice: null }),
    call('placeOrder', { ...SPX_P, conId: 920693462, includeExpired: true, strike: 0 }, { ...LMT, orderId: 2008, ocaGroup: '', ocaType: 3, trailStopPrice: null }), tick(),
    call('placeOrder', { ...SPX_P, multiplier: 'abc' }, { ...LMT, orderId: 2009, conditions: [{ price: 6600 }] }),
    call('placeOrder', { ...BAG, comboLegs: [] }, { ...LMT, orderId: 2010, orderRef: '中文 ref', conditions: [] }), tick()]);
}

// ---------------------------------------------------------------- 合约确认与交易时段
{
  const AAPL_OPT = { secType: 'OPT', symbol: 'AAPL', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20261120', strike: 230, right: 'C', multiplier: '100' };
  scenario('qualify', [...est(), call('qualifyContracts', [ES, SPX_P_NOTC, AAPL], 5000), tick(),
    send(contractDetails(V, rq.cd(), { conId: 495512563, symbol: 'ES', secType: 'FUT', exchange: 'CME', tradingClass: 'ES' })), send(M.cdEnd(rq.cd())),
    send(contractDetails(V, rq.cd(), { conId: 1001, tradingClass: 'SPX', exchange: 'CBOE' }), contractDetails(V, rq.cd(), { conId: 1002, tradingClass: 'SPXW', exchange: 'CBOE' })),
    send(M.cdEnd(rq.cd())), send(M.err(rq.cd(), 200, 'No security definition has been found for the request')),
    call('qualifyContracts', [AAPL_OPT], 5000), tick(),
    send(contractDetails(V, rq.cd(), { conId: 2001, symbol: 'AAPL', tradingClass: '2AAPL', exchange: '' }), contractDetails(V, rq.cd(), { conId: 2002, symbol: 'AAPL', tradingClass: 'AAPLX' })),
    send(M.cdEnd(rq.cd())),
    call('qualifyContracts', [{ ...AAPL_OPT, tradingClass: 'aaplx ' }, SPX_P], 5000), tick(),
    send(contractDetails(V, rq.cd(), { conId: 2001, tradingClass: '2AAPL' }), contractDetails(V, rq.cd(), { conId: 2002, tradingClass: 'AAPLX', exchange: 'CBOE' })),
    send(M.cdEnd(rq.cd())), send(contractDetails(V, rq.cd(), { conId: 3001, tradingClass: 'SPXW' }), contractDetails(V, rq.cd(), { conId: 3001, tradingClass: 'SPXW' }),
      contractDetails(V, rq.cd(), { conId: 0, tradingClass: 'SPX' })), send(M.cdEnd(rq.cd())),
    call('qualifyContracts', [ES, AAPL], 300), tick(), advance(200), send(contractDetails(V, rq.cd(), { conId: 495512563, tradingClass: 'ES' }), M.cdEnd(rq.cd())), tick(),
    send(M.cdEnd(rq.cd())), call('qualifyContracts', [], 100), call('qualifyContracts', [ES], 0), tick(), advance(5)]);
  scenario('contract_hours', [...est(), call('contractHours', ES, 2000), tick(), send(contractDetails(V, rq.cd(), { conId: 495512563, tradingHours: '20261020:1700-20261021:1600;20261021:CLOSED', liquidHours: '20261020:0930-20261020:1600', timeZoneId: 'US/Central' })),
    send(M.cdEnd(rq.cd())), call('contractHours', SPX_P, 2000), tick(), send(M.err(rq.cd(), 200, 'No security definition')), call('contractHours', SPX_P, 300), advance(300),
    call('contractHours', AAPL, 2000), tick(), send(M.cdEnd(rq.cd()))]);
}

// ---------------------------------------------------------------- K 线、期权链、深度
scenario('historical', [...est(), call('historicalData', AAPL, { endDateTime: '', durationStr: '1 D', barSizeSetting: '5 mins', whatToShow: 'TRADES', useRTH: true }), tick(),
  send(M.hist(rq.hist(), [['20261020 09:30:00', 230.1, 231, 229.5, 230.7, 12000, 230.4, 55], ['20261020 09:35:00', -1, -1, -1, -1, -1, -1, -1], ['20261020 09:40:00', 230.7, 230.9, 230.2, 230.3, 0, 230.5, 0]])),
  call('historicalData', SPX_IND, { endDateTime: '20261019 16:00:00 US/Eastern', durationStr: '2 D', barSizeSetting: '1 min', whatToShow: 'MIDPOINT', useRTH: false }), tick(),
  send(M.err(rq.hist(), 162, 'Historical Market Data Service error message:HMDS query returned no data: SPX@CBOE Midpoint')),
  call('historicalData', ES, { endDateTime: '', durationStr: '1 D', barSizeSetting: '1 day', whatToShow: 'TRADES', useRTH: false }), tick(), send(M.hist(rq.hist(), []))]);
scenario('secdef', [...est(), call('secDefOptParams', 'SPX', 'IND', 416904), tick(),
  send(M.secDef(rq.sec(), 'SMART', 416904, 'SPXW', 100, ['20261020', '20261021'], [6700, 6705.5])), send(M.secDef(rq.sec(), 'CBOE', 416904, 'SPX', '100', ['20261120'], [6700])),
  send(M.secDefEnd(rq.sec())), call('secDefOptParams', 'AAPL', 'STK', 265598), tick(), send(M.secDefEnd(rq.sec())),
  call('secDefOptParams', 'ZZZ', 'STK', 0), tick(), send(M.err(rq.sec(), 321, 'Error validating request.-\'bN\' : cause - Invalid underlying'))]);
scenario('depth', [...est(), call('mktDepth', ES, 5, 500), tick(), send(M.depthL2(rq.depth(), 0, 'NSDQ', 0, 1, 6750.25, 10)), send(M.depthL2(rq.depth(), 0, '', 0, 0, 6750.5, 4)),
  send(M.depthL2(rq.depth(), 1, '', 0, 1, 6750.0, 7)), send(M.depthL2(rq.depth(), 0, '', 0, 1, 6750.5, 1)), send(M.depthL2(rq.depth(), 1, '', 1, 1, 6749.75, 9)),
  send(M.depthL2(rq.depth(), 0, '', 2, 0, 0, 0)), send(M.depth(rq.depth(), 0, 0, 0, 6751, 3)), send(M.depthL2(rq.depth(), 5, '', 0, 1, 0, 5)), send(M.depthL2(rq.depth(), 9, '', 2, 1, 1, 1)),
  send(M.depthL2(rq.depth(), 1, '', 0, 7, 1, 1)), send(M.depthL2(rq.depth(), 1, '', 4, 1, 1, 1)), advance(400),
  call('mktDepth', ES, 5, 300), tick(), send(M.err(rq.depth(), 316, 'Market depth data has been HALTED.')), advance(200),
  call('mktDepth', SPX_IND, 3, 100), call('mktDepth', SPX_IND, 3, 50), advance(100)]);

// ---------------------------------------------------------------- 账户盈亏与净值
scenario('pnl_netliq', [...est(), call('accountPnl', A), call('netLiquidation', A), tick(),
  send(M.summary(rq.sum(), A, 'NetLiquidation', '1234567.89', 'USD')), send(M.summary(rq.sum(), DU, 'NetLiquidation', 'abc', 'USD')), call('netLiquidation', A), send(M.summaryEnd(rq.sum())),
  call('netLiquidation', A), call('netLiquidation', DU), send(M.pnl(rq.pnl(), 120.5, -30.25, '1.7976931348623157E308')), call('accountPnl', A), advance(1000),
  send(M.pnl(rq.pnl(), 130, -31, 2)), call('accountPnl', A), send(M.summary(rq.sum(), A, 'NetLiquidation', '1234600', 'HKD')), call('accountPnl', A),
  send(M.summary(rq.sum(), DU, 'NetLiquidation', '5000', 'USD')), call('netLiquidation', DU), call('accountPnl', DU), tick(), send(M.pnl(rq.pnl(), 7, 8, 9)), call('accountPnl', DU), send(M.err(rq.pnl(), 321, 'Error validating request')),
  call('accountPnl', DU), tick(), send(M.pnl(rq.pnl(), 1, 2, 3)), call('accountPnl', DU),
  { op: 'end' }, call('accountPnl', A), call('netLiquidation', A), advance(5000), { op: 'accept' }, send(M.version()), send(M.managed()), send(M.nextId(5)), ...ticks(2),
  call('accountPnl', A), call('netLiquidation', A), send(M.summary(rq.sum(), A, 'NetLiquidation', '1', 'USD'), M.summaryEnd(rq.sum())), call('netLiquidation', A),
  send(M.pnl(rq.pnl(2), 11, 12, 13)), call('accountPnl', A), call('accountPnl', DU), call('disconnect'), call('accountPnl', A), call('accountPnl', DU), call('netLiquidation', A), tick()]);
scenario('market_data_type', [...est(), call('reqMarketDataType', 1), call('reqMarketDataType', 4), call('setBaselineMarketDataType', 3), call('reqMarketDataType', 1), tick(),
  call('reqMarketDataType', 2), call('setBaselineMarketDataType', 1), call('reqMarketDataType', 1), tick()]);

// ---------------------------------------------------------------- 未成交单
{
  const ot = call('openTrades');
  scenario('open_trades', [...est(), ot, call('openTradesDetailed'), tick(),
    send(openOrderMsg(V, { orderId: 101, permId: 777, ocaGroup: 'dafri-trk-5', ocaType: 1, orderRef: 'dafri:trk:5' })), send(M.orderStatus(101, 'Submitted', 0, 1, 0, 777)),
    send(openOrderMsg(V, { orderId: 0, permId: 888, orderType: 'TRAIL', trailingPercent: 5, auxPrice: 1.5, outsideRth: '1', tif: 'DAY', secType: 'STK', symbol: 'AAPL', strike: '0', right: '', multiplier: '', ltd: '', tradingClass: 'NMS' })),
    send(openOrderMsg(V, { orderId: 101, permId: 777, lmtPrice: 13, status: 'PreSubmitted' })), send(M.orderStatus(101, 'Filled', 1, 0, 13, 777)), send(M.ooEnd()),
    call('cancelTrade', ot.id, 0), call('cancelTrade', ot.id, 1), tick(), call('openTradesDetailed'), tick(), send(M.ooEnd()), call('openTrades'), tick(),
    send(openOrderMsg(V, { orderId: 7, permId: 0, qty: 3, tif: '' })), send(M.ooEnd())]);
}

// ---------------------------------------------------------------- 往回要成交
scenario('exec_history', [...est(), call('executionHistory', 7), call('executionHistory', 3), call('executionHistory', 1), call('executions')], {
  history: [
    { serverVersion: 200, supported: true, details: [{ contract: { symbol: 'SPX', secType: 'OPT' }, execution: { execId: 'x1', price: 8.5 } }] },
    { serverVersion: 187, supported: false, details: [] },
    { error: '往回要成交的连接被 TWS 关了' },
  ] });

// ---------------------------------------------------------------- 主动断开
{
  const a = sub(SPX_P, '');
  scenario('disconnect', [...est(), a, sub(AAPL, '165'), call('positions'), call('accountPnl', A), ...ticks(2), send(posSPX(A, 1, 6700, 1), M.posEnd()), call('disconnect'),
    call('isConnected'), read(a), call('positions'), call('accountPnl', A), call('netLiquidation', A), call('managedAccounts'), send(M.tickPrice(rq.mkt(1), 1, 3, 3)), advance(10000),
    call('disconnect'), tick()]);
}
scenario('rate_burst', [...est(), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => sub({ ...AAPL, symbol: `S${i}` }, '')), call('cancelTicker', { ...AAPL, symbol: 'S10' }),
  call('placeOrder', AAPL, { ...LMT, orderId: 900 }), advance(99), advance(1), advance(50), advance(50), ...ticks(2)]);
scenario('error_callbacks', [...est(), call('onError2'), send(M.err(1001, 202, 'Order Canceled - reason:')), call('offError', 'e2'),
  send(M.err(1002, 110, 'The price does not conform to the minimum price variation for this contract.')), send(M.err(-1, 2106, 'HMDS data farm connection is OK:ushmds')),
  send(M.err(1003, 399, 'Order Message:\nSELL 1 SPX ... Warning: your order will not be placed at the exchange until 2026-10-21 09:30:00 US/Eastern')),
  send(['4', '1', 'old style message']), send(M.err(0, 0, 'zero code')), send(M.err(5, 0, 'zero code')), send(M.err(1004, 201, 'Order rejected', '{"rejectReason":"x"}')),
  send(['999', '1', '2']), send(M.err(0, 200, 'reqId zero')), call('offError', 'main'), send(M.err(1005, 202, 'gone'))]);
// 握手做完了(连上了)却一直不给账户表:超时时库那一头是真的连着的,disconnect() 会 end + destroy
scenario('connect_timeout_after_handshake', [call('create', CFG), { op: 'accept' }, send(M.version()), send(M.nextId(1)), advance(10000), advance(20000)]);
// 重连到一半(socket 连上了、还没握手)时主动断开:库不关这条 socket(它不是 Connected),握手照样完成;之后的通告不再报
{
  const t = sub(ES, '');
  scenario('disconnect_while_reconnecting', [...est(), t, tick(), send(M.err(-1, 1100, 'Connectivity between IB and Trader Workstation has been lost.')),
    advance(5000), { op: 'accept' }, call('disconnect'), send(M.version()), send(M.managed(A), M.nextId(9)), tick(),
    send(M.err(-1, 2104, 'Market data farm connection is OK:usfarm')), call('isConnected'), read(t), advance(10000)]);
}
// 断线之后、重连之前主动断开:到点的重连计时器什么都不做
scenario('disconnect_while_waiting_to_reconnect', [...est(), sub(ES, ''), tick(), { op: 'end' }, call('disconnect'), advance(5000), advance(20000)]);
// 断着的时候撤行情、撤持仓:库在断开时不发撤销(命令缓冲压着的只有请求)
{
  const t = sub(ES, '');
  scenario('cancel_while_disconnected', [...est(), t, sub(AAPL, ''), tick(), { op: 'end' }, call('cancelTicker', ES), read(t), advance(5000), { op: 'accept' },
    send(M.version()), send(M.managed()), send(M.nextId(3)), ...ticks(3)]);
}
// 持仓订阅自己出错(请求号 2:建会话时的账户表用了 1,这是之后的第一个订阅):旧表作废,下一次读持仓重订
scenario('positions_subscription_error', [...est(), call('positions'), tick(), send(posSPX(A, 101, 6700, 1), M.posEnd()), call('positions'),
  send(M.err(2, 321, 'Error validating request')), call('positions'), tick(), send(posSPX(A, 102, 6705, 2), M.posEnd()), call('positions')]);
// 合约的那几个"假值不带"的键:conId 0、到期是空串、includeExpired;它们决定请求的字节与共用订阅的 instanceId
{
  const C0 = { ...AAPL, conId: 0, lastTradeDateOrContractMonth: '' };
  scenario('contract_falsy_keys', [...est(), call('mktDepth', AAPL, 5, 300), call('mktDepth', C0, 5, 300), call('mktDepth', { ...AAPL, includeExpired: false }, 5, 300),
    call('mktDepth', { ...AAPL, conId: 265598 }, 5, 300), tick(), advance(300),
    call('qualifyContracts', [{ ...ES, includeExpired: true }, C0, { ...SPX_P, conId: 0, strike: 0 }], 2000), tick(), send(M.cdEnd(rq.cd())), tick(), send(M.cdEnd(rq.cd())), tick(),
    send(M.cdEnd(rq.cd())), call('placeOrder', C0, { ...LMT, orderId: 4001 }), call('placeOrder', { ...ES, includeExpired: true, conId: 495512563 }, { ...LMT, orderId: 4002 }),
    sub(C0, ''), sub(AAPL, ''), tick(), call('historicalData', { ...ES, includeExpired: true }, { endDateTime: '', durationStr: '1 D', barSizeSetting: '1 day', whatToShow: 'TRADES', useRTH: false }),
    tick(), send(M.hist(rq.hist(), []))]);
}
// 数量是负数 / 零:TS 原样交给库,编码器照写(改单与新单两条路)
scenario('orders_negative_quantity', [...est(),
  call('placeOrder', SPX_P, { ...LMT, totalQuantity: -1, orderId: 3001 }), call('placeOrder', SPX_P, { ...LMT, totalQuantity: -2.5, orderId: 3002, action: 'SELL' }),
  call('placeOrder', AAPL, { ...MKT, totalQuantity: -100 }), tick(), send(M.nextId(3003)), tick(),
  call('placeOrder', ES, { ...LMT, totalQuantity: 0, orderId: 3004 }), call('placeOrder', BAG, { ...LMT, totalQuantity: -3, lmtPrice: -1.2, orderId: 3005 }), tick()]);
// 每种回调挂两个:按挂的先后各调一遍(连通、通断、订单状态、成交、佣金)
scenario('callbacks_two_listeners', [...est(), call('onSecond'), call('onError2'),
  send(execMsg(V, '-1', { execId: 'c.01', orderId: 11, permId: 501 })), send(M.commission('c.01', 1.05)),
  send(execMsg(V, '-1', { execId: 'c.02', orderId: 12, permId: 502, price: 7.1 })), send(M.commission('c.02', 0.65)),
  send(M.orderStatus(11, 'Submitted', 0, 1, 0, 501)), send(M.err(1001, 202, 'Order Canceled - reason:')),
  send(M.err(-1, 1100, 'Connectivity between IB and Trader Workstation has been lost.')), advance(5000), { op: 'accept' }, send(M.version()),
  send(M.managed(A), M.nextId(5)), ...ticks(2), send(M.err(-1, 2104, 'Market data farm connection is OK:usfarm'))]);
// 订阅出错之后再订:账户盈亏 / 净值 / 持仓 / 共用的深度订阅都换新的请求号(请求号:1 账户表、2 摘要、3 盈亏、4 盈亏、5 摘要、6 盈亏、7 持仓、8 持仓)
scenario('subscription_error_resubscribe', [...est(),
  call('accountPnl', A), tick(), send(M.err(rq.pnl(), 321, 'pnl rejected')), call('accountPnl', A), tick(),
  send(M.err(rq.sum(), 321, 'summary rejected')), call('netLiquidation', A), tick(), send(M.pnl(rq.pnl(), 1, 2, 3)), call('accountPnl', A),
  send(M.err(rq.pnl(), 321, 'pnl rejected again')), call('accountPnl', A), tick(), send(M.pnl(rq.pnl(), 4, 5, 6)), call('accountPnl', A),
  call('positions'), tick(), send(M.err(7, 321, 'positions rejected')), call('positions'), tick(), send(posSPX(A, 101, 6700, 1), M.posEnd()), call('positions'),
  call('mktDepth', ES, 5, 500), call('mktDepth', ES, 5, 500), tick(), send(M.err(rq.depth(), 316, 'Market depth data has been HALTED.')), advance(500),
  call('mktDepth', ES, 5, 500), tick(), send(M.depthL2(rq.depth(), 0, '', 0, 1, 6750.25, 10)), advance(500)]);
// 同一拍里连断两次、或者在通告断开的同一拍里主动断开:第二次什么都不再做
scenario('disconnect_twice_same_tick', [...est(), sub(ES, ''), call('positions'), tick(), { op: 'multi', steps: [call('disconnect'), call('disconnect')] },
  call('isConnected'), advance(5000), advance(5000)]);
scenario('disconnect_during_drop_same_tick', [...est(), sub(ES, ''), tick(),
  { op: 'send', msgs: [M.err(-1, 1100, 'Connectivity between IB and Trader Workstation has been lost.')], then: [call('disconnect'), call('disconnect')] },
  call('isConnected'), advance(5000), advance(5000)]);
// 版本不在 100..193 的那一帧之后,同一块字节里还有别的帧(库照样往下读、照样用那个版本编排着的命令;每条命令 503)
for (const v of [194, 200, 99, 60, 55]) {
  scenario(`bad_version_chunk_${v}`, [...est(), sub(ES, ''), tick(), { op: 'reset' },
    call('placeOrder', SPX_P, { ...LMT, orderId: 100 }), call('placeOrder', ES, { ...MKT, orderId: 101 }), call('cancelOrder', 100), call('reqMarketDataType', 3),
    advance(5000), { op: 'accept' }, send(M.version(v), M.nextId(105), M.managed(A), M.err(-1, 2104, 'Market data farm connection is OK:usfarm')),
    advance(5000), { op: 'accept' }, send(M.version(), M.nextId(106), M.managed(A)), ...ticks(3), call('isConnected')]);
}
// ---- 断线时的下单 / 改单 / 撤单:当场抛 LinkDownError,不入队;重连之后什么都不补发,照常的下单照常走
scenario('linkdown_orders_not_queued', [...est(), sub(ES, ''), tick(), { op: 'end' },
  call('placeOrder', SPX_P, LMT), call('placeOrder', SPX_P, { ...LMT, orderId: 700, lmtPrice: 2.45 }), call('cancelOrder', 700),
  call('placeOrder', ES, { ...MKT, orderId: 701 }), call('cancelOrder', 701), call('reqMarketDataType', 3),
  advance(5000), { op: 'accept' }, send(M.version()), send(M.managed(A), M.nextId(40)), ...ticks(4), call('isConnected'),
  call('placeOrder', SPX_P, { ...LMT, orderId: 700, lmtPrice: 2.4 }), call('cancelOrder', 700), call('placeOrder', ES, MKT), tick(), send(M.nextId(41)), tick(),
  { op: 'end' }, call('placeOrder', ES, MKT), call('cancelOrder', 41), advance(5000), { op: 'accept' }, send(M.version()), send(M.managed(A), M.nextId(50)), ...ticks(4)]);
// 新单等 nextValidId 的时候链路断了:TS 原样(不抛、不撤、没有回音;重连后库重发 REQ_IDS,等到了才发 PLACE_ORDER)
scenario('place_pending_drop_reconnect', [...est(), call('placeOrder', SPX_P, LMT), tick(), { op: 'end' }, advance(5000), { op: 'accept' }, send(M.version()),
  send(M.managed(A)), ...ticks(2), send(M.nextId(60)), ...ticks(3), call('isConnected')]);
scenario('place_pending_drop_never_settles', [...est(), call('placeOrder', SPX_P, LMT), call('placeOrder', ES, MKT), tick(), { op: 'end' }, call('disconnect'),
  advance(5000), advance(60000)]);
// ---- 握手回来的版本:100 与 193 收下,99 与 194 拒(506),拒了之后下一次重连照常
{
  const t = sub(ES, '');
  scenario('connect_version_100', [...est(100), call('isConnected'), call('managedAccounts'), t, tick(), send(M.tickPrice(rq.mkt(), 1, 6750, 2)), read(t)]);
}
scenario('connect_version_194_then_193', [call('create', CFG), { op: 'accept' }, send(M.version(194)), advance(5000), { op: 'accept' }, send(M.version(193)),
  send(M.managed(A), M.nextId(1)), call('isConnected')]);
scenario('connect_version_99_then_100', [call('create', CFG), { op: 'accept' }, send(M.version(99)), advance(5000), { op: 'accept' }, send(M.version(100)),
  send(M.managed(A), M.nextId(1)), call('isConnected')]);
// ---- 接收缓冲的上限:恰好 0xffffff 字节收下(留着等凑齐),多一个字节就报错断开
scenario('receive_buffer_cap', [...est(), { op: 'sendFill', len: 0xffffff }, call('isConnected'), { op: 'sendRaw', hex: '00' }, call('isConnected'),
  advance(5000), { op: 'accept' }, send(M.version()), send(M.managed(A), M.nextId(3)), ...ticks(2), call('isConnected')]);
scenario('receive_buffer_cap_single', [...est(), { op: 'sendFill', len: 0x1000000 }, call('isConnected'), advance(5000), { op: 'accept' }, send(M.version()),
  send(M.managed(A), M.nextId(3)), ...ticks(2), call('isConnected')]);
{
  // 一条消息不以 \0 结尾:最后那一格留给下一条消息的开头
  const t = sub(ES, '');
  const raw = (text) => { const p = Buffer.from(text, 'utf8'); return Buffer.concat([be32(p.length), p]).toString('hex'); };
  scenario('message_fragment', [...est(), t, tick(), { op: 'sendRaw', hex: raw('1\x006\x002\x001\x006750.5\x003\x000') },
    { op: 'sendRaw', hex: raw('\x00') }, read(t), { op: 'sendRaw', hex: raw('1\x006\x002\x002\x0067') }, { op: 'sendRaw', hex: raw('51.25\x004\x000\x00') }, read(t),
    { op: 'sendRaw', hex: raw('1\x006\x002\x004\x006751\x002\x000\x00') + raw('1\x006\x002\x009\x006700\x000\x000\x00').slice(0, 20) },
    { op: 'sendRaw', hex: raw('1\x006\x002\x009\x006700\x000\x000\x00').slice(20) }, read(t)]);
}

// ---------------------------------------------------------------- 随机:行情
const priceTypes = [1, 2, 4, 9, 14, 6, 7, 66, 67, 68, 75, 76, 72, 73];
const sizeTypes = [0, 3, 5, 8, 21, 27, 28, 29, 30, 63, 64, 65, 69, 70, 71, 74];
const optTypes = [10, 11, 12, 13, 80, 81, 82, 83];
const rprice = () => pick([String((rnd() * 500).toFixed(2)), '-1', '0', '12.5', '1.7976931348623157E308', String(int(1, 9))]);
const rcomp = () => pick([String(rnd().toFixed(4)), '-1', '-2', '0', String((rnd() - 0.5).toFixed(3)), '1.7976931348623157E308']);
for (let n = 0; n < 12; n += 1) {
  const pool = [[SPX_P, ''], [AAPL, '165,104,595'], [ES, ''], [SPX_C, '100,101,106'], [SPX_IND, '']];
  const chosen = pool.filter(() => chance(0.6));
  if (!chosen.length) chosen.push(pool[0]);
  const subs = chosen.map(([c, g]) => sub(c, g));
  const steps = [...est(), ...subs, ...ticks(2)];
  for (let i = 0; i < 40; i += 1) {
    const k = int(0, subs.length - 1);
    const id = rq.mkt(subs.length - 1 - k);
    const r = rnd();
    let m;
    if (r < 0.35) m = M.tickPrice(id, pick(priceTypes), rprice(), String(int(0, 500)));
    else if (r < 0.55) m = M.tickSize(id, pick(sizeTypes), String(int(0, 100000)));
    else if (r < 0.62) m = M.tickGeneric(id, pick([23, 24, 49]), rcomp());
    else if (r < 0.7) m = M.tickString(id, pick([45, 88, 32]), pick(['1760970000', '', ' ', 'abc', '1e3', '-5', 'Infinity']));
    else if (r < 0.85) m = M.optComp(id, pick(optTypes), rcomp(), rcomp(), rcomp(), rcomp(), rcomp(), rcomp(), rcomp(), rcomp());
    else if (r < 0.9) { steps.push(advance(int(1, 3000))); continue; }
    else { steps.push(read(subs[k])); continue; }
    steps.push(send(m));
    if (chance(0.3)) steps.push(read(subs[k]));
  }
  for (const s of subs) steps.push(read(s));
  for (const [c] of chosen) steps.push(call('quoteDelayed', c));
  if (chance(0.5)) steps.push(call('cancelTicker', chosen[0][0]), read(subs[0]), tick());
  scenario(`random_ticks_${n}`, steps);
}

// ---------------------------------------------------------------- 随机:持仓
for (let n = 0; n < 10; n += 1) {
  const steps = [...est(), call('positions'), tick()];
  const conIds = [101, 102, 103, 104, 105, 106];
  const rpos = () => posSPX(pick([A, A, DU]), pick(conIds), 6700 + 5 * int(0, 5), pick([0, 0, 1, -1, 2, -2, 3, 5]), (rnd() * 3000).toFixed(2));
  const pre = int(0, 6);
  const batch = Array.from({ length: pre }, rpos);
  steps.push(send(...batch, M.posEnd()));
  for (let i = 0; i < 25; i += 1) {
    const r = rnd();
    if (r < 0.55) steps.push(send(rpos()));
    else if (r < 0.65) steps.push(send(rpos(), rpos(), rpos()));
    else if (r < 0.9) steps.push(call('positions'));
    else if (r < 0.95) steps.push(send(M.posEnd()));
    else {
      steps.push({ op: 'end' }, call('positions'), advance(5000), { op: 'accept' }, send(M.version()), send(M.managed()), send(M.nextId(int(1, 50))), ...ticks(2),
        call('positions'), send(...Array.from({ length: int(0, 4) }, rpos), M.posEnd()));
    }
  }
  steps.push(call('positions'));
  scenario(`random_positions_${n}`, steps);
}

// ---------------------------------------------------------------- 随机:成交与佣金
for (let n = 0; n < 10; n += 1) {
  const steps = [...est()];
  const execIds = ['0001.01', '0001.02', '0002.01', '0003.01', '0004.01', ''];
  let pending = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = rnd();
    const e = () => ({ execId: pick(execIds), orderId: int(0, 3) * 10, permId: pick([0, 501, 502]), price: (rnd() * 20).toFixed(2), shares: int(1, 3), side: pick(['BOT', 'SLD']) });
    if (r < 0.35) steps.push(send(execMsg(V, '-1', e())));
    else if (r < 0.5 && pending) steps.push(send(execMsg(V, rq.exec(int(0, pending - 1)), e())));
    else if (r < 0.7) steps.push(send(M.commission(pick(execIds), (rnd() * 2).toFixed(2))));
    else if (r < 0.8) { steps.push(call('executions'), tick()); pending += 1; }
    else if (r < 0.9 && pending) { steps.push(send(M.execEnd(rq.exec(int(0, pending - 1))))); }
    else steps.push(send(M.orderStatus(int(1, 3) * 10, pick(['Submitted', 'Filled', 'Cancelled']), int(0, 2), int(0, 2), (rnd() * 20).toFixed(2), pick([0, 501]))));
  }
  for (let k = 0; k < pending; k += 1) steps.push(send(M.execEnd(rq.exec(k))));
  scenario(`random_execs_${n}`, steps);
}

// ---------------------------------------------------------------- 随机:合约确认
for (let n = 0; n < 8; n += 1) {
  const steps = [...est()];
  const req = () => {
    // exchange 永远在(IbContract 的 exchange 是必填的串,C++ 那边表达不了 undefined)
    return structuredClone(pick([SPX_P, SPX_P_NOTC, AAPL, ES, ES_FOP, { ...SPX_P_NOTC, symbol: 'spx' }, { ...SPX_P_NOTC, tradingClass: ' SPXW ' }]));
  };
  for (let q = 0; q < 3; q += 1) {
    const cs = Array.from({ length: int(1, 3) }, req);
    steps.push(call('qualifyContracts', cs, pick([5000, 5000, 2000]))); steps.push(tick());
    for (let i = 0; i < cs.length; i += 1) {
      const rows = int(0, 4);
      const msgs = [];
      for (let k = 0; k < rows; k += 1) msgs.push(contractDetails(V, rq.cd(), { conId: pick([0, 7001, 7002, 7003, 7001]), tradingClass: pick(['SPX', 'SPXW', 'spxw', '', '2SPX', 'ES']), exchange: pick(['CBOE', '', 'SMART']) }));
      if (msgs.length) steps.push(send(...msgs));
      steps.push(send(chance(0.15) ? M.err(rq.cd(), 200, 'No security definition has been found for the request') : M.cdEnd(rq.cd())));
      steps.push(tick());
    }
  }
  scenario(`random_qualify_${n}`, steps);
}

// ---------------------------------------------------------------- 钱路径:各档接口版本上的单子字节
const orderTypes = ['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL', 'MIDPRICE', 'MOC', 'LOC', 'REL'];
const contracts = [SPX_P, SPX_C, SPX_P_NOTC, AAPL, ES, ES_FOP, SPX_IND, BAG, { ...BAG, comboLegs: [BAG.comboLegs[0]] }, { ...SPX_P, conId: 920693462 }, { ...AAPL, multiplier: '' },
  { ...ES, includeExpired: true }, { ...SPX_P, strike: 6700.5 }];
const rnum = () => pick([0, 1, 2.5, 0.05, 12.35, 6700, -1.2, 100, 1e-7, 123456.789]);
function randomIntent() {
  const o = {
    orderType: pick(orderTypes), action: pick(['BUY', 'SELL']), totalQuantity: pick([1, 2, 10, 100, 0.5, 3]), lmtPrice: chance(0.6) ? rnum() : null,
    auxPrice: chance(0.3) ? rnum() : null, trailingPercent: chance(0.15) ? pick([1, 2.5, 10]) : null, tif: pick(['DAY', 'GTC', 'IOC', 'OPG', '']),
    outsideRth: chance(0.3), account: pick([A, DU, '']), transmit: chance(0.85),
  };
  if (chance(0.5)) o.orderRef = pick(['dafri:trk:12', '', '中文', 'a b']);
  if (chance(0.3)) { o.ocaGroup = pick(['dafri-trk-12', 'x', '']); if (chance(0.5)) o.ocaType = pick([1, 2, 3]); }
  if (chance(0.2)) o.trailStopPrice = pick([null, 171.5, 0, 6650.25]);
  if (chance(0.25)) {
    o.conditions = Array.from({ length: int(0, 3) }, () => ({ price: rnum(), conId: pick([416904, 265598, 0]), exchange: pick(['CBOE', 'SMART', 'CME']), isMore: chance(0.5) }));
    if (chance(0.6)) o.conditionsCancelOrder = chance(0.5);
  }
  return o;
}
for (const ver of [193, 187, 176, 170, 163, 157, 150, 145, 124, 100]) {
  const steps = [...est(ver)];
  let next = 6000;
  for (let i = 0; i < 30; i += 1) {
    const intent = randomIntent();
    if (i % 7 === 6) {
      steps.push(call('placeOrder', pick(contracts), intent), tick(), send(M.nextId(next++)), tick());
    } else {
      intent.orderId = 5000 + i;
      steps.push(call('placeOrder', pick(contracts), intent));
      if (i % 4 === 3) steps.push(tick());
    }
    if (chance(0.15)) steps.push(call('cancelOrder', 5000 + int(0, i)));
  }
  steps.push(...ticks(3));
  scenario(`money_orders_v${ver}`, steps);
}

// ================================================================ 纯函数
const looseVals = [undefined, null, 0, -0, 1, 5, 7.5, '7', '', ' ', 'abc', NaN, Infinity, true, false, '1e3', '0x10', -1, 1.7976931348623157e308];
const lv = () => pick(looseVals);
const pure = { tickerKey: [], realNumber: [], tradeFromOrderStatus: [], fillFromExecDetails: [], execForwarder: [], applyPositionUpdate: [], applyTicks: [],
  candidatesOf: [], pickContractDetail: [], toIbOrder: [] };
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const randContract = () => {
  const c = { secType: pick(['OPT', 'FOP', 'STK', 'FUT', 'IND', 'BAG']), symbol: pick(['SPX', 'ES', 'AAPL', '', '中']), exchange: pick(['SMART', 'CBOE']), currency: 'USD' };
  if (chance(0.6)) c.lastTradeDateOrContractMonth = pick(['20261020', '', '202612']);
  if (chance(0.6)) c.strike = pick([6700, 0, 6700.5, 1e21, 0.1, -0]);
  if (chance(0.6)) c.right = pick(['P', 'C', '']);
  if (chance(0.5)) c.tradingClass = pick(['SPXW', '', 'SPX']);
  if (chance(0.3)) c.multiplier = pick(['100', '', '50']);
  if (chance(0.3)) c.conId = pick([0, 416904]);
  return c;
};
for (let i = 0; i < 200; i += 1) {
  const c = randContract();
  const g = pick([undefined, '', '165,104,595', '100']);
  pure.tickerKey.push({ c, g: enc(g), ...run(() => (g === undefined ? S.tickerKey(c) : S.tickerKey(c, g))) });
}
for (const v of [...looseVals, '1.7976931348623157E308', '-1e300', '1e299', '  12  ', '1,000', [], [5], {}, -1e300, 1e300, 9.99e299]) pure.realNumber.push({ v: enc(v), ...run(() => S.realNumber(v)) });
for (let i = 0; i < 120; i += 1) {
  const args = [lv(), pick(['Submitted', 'Filled', '', undefined, null, 7]), lv(), lv(), lv(), lv(), chance(0.7) ? { conId: 1, symbol: 'SPX' } : pick([undefined, {}])];
  pure.tradeFromOrderStatus.push({ args: enc(args), ...run(() => S.tradeFromOrderStatus(...args)) });
}
const randExec = () => {
  const e = {};
  for (const k of ['execId', 'time', 'price', 'shares', 'side', 'acctNumber', 'orderId', 'permId', 'cumQty', 'avgPrice']) if (chance(0.7)) e[k] = k === 'execId' ? pick(['0001.01', '', '0002.01', 7]) : lv();
  return e;
};
for (let i = 0; i < 120; i += 1) {
  const args = [chance(0.8) ? { conId: 1, symbol: 'SPX' } : undefined, chance(0.9) ? randExec() : undefined, chance(0.8) ? pick([-1, '-1', 3, '3', -1.0, undefined, null, NaN]) : undefined];
  pure.fillFromExecDetails.push({ args: enc(args), ...run(() => S.fillFromExecDetails(...args)) });
}
for (let i = 0; i < 30; i += 1) {
  const events = [];
  for (let k = 0; k < 15; k += 1) {
    if (chance(0.6)) events.push(['exec', pick([-1, 5, '-1', undefined]), chance(0.9) ? { conId: 1 } : undefined, chance(0.9) ? { execId: pick(['a', 'b', 'c', '', 1]), orderId: pick([1, 2]), permId: pick([0, 9]) } : undefined]);
    else events.push(['comm', chance(0.9) ? { execId: pick(['a', 'b', 'c', '', 1, undefined]), commission: 1.25 } : pick([undefined, null])]);
  }
  const calls = [];
  const fw = S.execForwarder(
    [(t, f) => calls.push(enc(['fill', t, f])), (t, f) => calls.push(enc(['fill2', t, f]))],
    [(t, f, r) => calls.push(enc(['comm', t, f, r])), (t, f, r) => calls.push(enc(['comm2', t, f, r]))]);
  for (const ev of events) {
    if (ev[0] === 'exec') fw.onExecDetails(ev[1], ev[2], ev[3]);
    else fw.onCommissionReport(ev[1]);
  }
  pure.execForwarder.push({ events: enc(events), calls });
}
const accountsMap = (entries) => new Map(entries.map(([a, list]) => [a, list]));
const randPosEntries = () => Array.from({ length: int(0, 2) }, () => [pick([A, DU, '']), Array.from({ length: int(0, 3) }, () => ({
  account: 'x', contract: chance(0.85) ? { conId: pick([1, 2, 3, 0]), symbol: pick(['SPX', 'ES']) } : { symbol: pick(['SPX', 'ES']) },
  pos: pick([0, 1, -2, 3, NaN, -0, 0.5]), avgCost: pick([0, 12.5, NaN, undefined]) }))]);
for (let i = 0; i < 150; i += 1) {
  const tableE = chance(0.3) ? null : Array.from({ length: int(0, 4) }, () => {
    const acct = pick([A, DU]);
    const conId = pick([1, 2, 3]);
    return [`${acct}|${conId}`, { account: acct, contract: { conId, symbol: 'SPX' }, pos: pick([1, -2]), avgCost: 10 }];
  });
  const upd = {};
  for (const k of ['all', 'added', 'changed', 'removed']) if (chance(k === 'all' ? 0.8 : 0.3)) upd[k] = randPosEntries();
  const out = run(() => {
    const table = tableE === null ? null : new Map(tableE.map(([k, v]) => [k, { ...v }]));
    const u = {};
    for (const [k, e] of Object.entries(upd)) u[k] = accountsMap(e);
    return [...S.applyPositionUpdate(table, u).entries()];
  });
  pure.applyPositionUpdate.push({ table: enc(tableE), update: enc(upd), ...out });
}
const allTickNames = ['BID', 'ASK', 'LAST', 'CLOSE', 'BID_SIZE', 'ASK_SIZE', 'LAST_SIZE', 'OPEN', 'HIGH', 'LOW', 'VOLUME', 'AVG_VOLUME', 'OPTION_HISTORICAL_VOL',
  'SHORT_TERM_VOLUME_3_MIN', 'SHORT_TERM_VOLUME_5_MIN', 'SHORT_TERM_VOLUME_10_MIN', 'LAST_TIMESTAMP', 'OPTION_CALL_OPEN_INTEREST', 'OPTION_PUT_OPEN_INTEREST',
  'OPTION_CALL_VOLUME', 'OPTION_PUT_VOLUME', 'MODEL_OPTION_GAMMA', 'MODEL_OPTION_IV', 'MODEL_OPTION_PRICE', 'MODEL_OPTION_DELTA'];
const tickIds = [...new Set([...allTickNames, ...allTickNames.map((n) => `DELAYED_${n}`)].map((n) => ib.IBApiTickType[n] ?? ib.IBApiNextTickType[n]).filter((x) => x !== undefined)), 10001, 10002, 13, 83];
const tickVal = () => pick([undefined, 0, 1.5, 230.25, -1, NaN, 12, 1e9, 0.25]);
const tickMap = (n) => Array.from({ length: n }, () => [pick(tickIds), tickVal()]);
for (let i = 0; i < 250; i += 1) {
  const data = { bid: pick([NaN, 10, 0]), ask: pick([NaN, 11, 0]), last: pick([null, 10.5]), close: null, bidSize: null, askSize: null, marketPrice: pick([null, 3]),
    callOpenInterest: null, putOpenInterest: null, callVolume: null, putVolume: null, modelGreeks: pick([null, { gamma: 0.1, impliedVol: 0.2, optPrice: 3 }]), error: null,
    open: null, high: null, low: null, volume: null, avgVolume: null, histVol: null, vol3m: null, vol5m: null, vol10m: null, lastTradeAt: null, delayed: chance(0.3),
    requestedAt: pick([null, T0]), quotedAt: null };
  const upd = { all: tickMap(int(0, 12)) };
  if (chance(0.4)) upd.added = tickMap(int(0, 3));
  if (chance(0.3)) upd.changed = tickMap(int(0, 3));
  const out = run(() => {
    const d = structuredClone(data);
    const toMap = (e) => new Map(e.map(([k, v]) => [k, { value: v, ingressTm: 0 }]));
    const u = { all: toMap(upd.all) };
    if (upd.added) u.added = toMap(upd.added);
    if (upd.changed) u.changed = toMap(upd.changed);
    S.applyTicks(ib, d, u);
    return d;
  });
  pure.applyTicks.push({ data: enc(data), update: enc(upd), ...out });
}
const randDetails = () => Array.from({ length: int(0, 5) }, () => (chance(0.9) ? {
  contract: chance(0.95) ? { conId: pick([1, 2, 3, 0, -1, '4', NaN, undefined]), exchange: pick(['CBOE', '', undefined]), tradingClass: pick(['SPX', 'SPXW', 'spxw', '', undefined, ' SPX']) } : undefined,
} : pick([null, undefined, {}])));
for (let i = 0; i < 150; i += 1) {
  const d = chance(0.1) ? pick([undefined, null, { contract: { conId: 5 } }]) : randDetails();
  pure.candidatesOf.push({ details: enc(d), ...run(() => P.candidatesOf(d)) });
  const rqc = randContract();
  const savedErr = process.stderr.write;
  const lines = [];
  process.stderr.write = (c) => { lines.push(String(c).replace(/\n$/, '')); return true; };
  const r = run(() => P.pickContractDetail(rqc, d));
  process.stderr.write = savedErr;
  pure.pickContractDetail.push({ requested: rqc, details: enc(d), ...r, log: lines });
}
for (let i = 0; i < 400; i += 1) {
  const o = randomIntent();
  if (chance(0.3)) o.orderId = pick([0, 5, 1234]);
  pure.toIbOrder.push({ intent: enc(o), ...run(() => P.toIbOrder(ib, o)) });
}
// 数量是负数 / 零 / 小数:TS 原样交给库(不取绝对值、不取整)
for (const q of [-1, -0.5, -100, -0, 0, 0.25, -1e-7, -2147483648]) {
  const o = { ...randomIntent(), totalQuantity: q };
  pure.toIbOrder.push({ intent: enc(o), ...run(() => P.toIbOrder(ib, o)) });
}

const results = [];
for (const sc of scenarios) results.push({ ...sc, trace: await runScenario(sc) });
if (process.argv[3]) {
  for (const r of results) {
    console.log(`== ${r.name}`);
    r.steps.forEach((st, i) => console.log(JSON.stringify(st), '\n   =>', JSON.stringify(r.trace[i])));
  }
  process.exit(0);
}
const tickTypes = {};
for (const n of [...allTickNames, ...allTickNames.map((x) => `DELAYED_${x}`)]) tickTypes[n] = [ib.IBApiTickType[n] ?? null, ib.IBApiNextTickType[n] ?? null];
const out = {
  generator: 'native/tests/fixtures/gen_ib_session.mjs', library: `@stoqey/ib ${libVersion}`,
  runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`,
  socketCalibration, T0, tickTypes, pure, scenarios: results,
};
writeFileSync(join(here, 'ib_session.json'), JSON.stringify(out) + '\n');
