// 生成 ib_exec_history.json:engine-ts 的 ibExecHistory.ts(原模块现跑)。
// 编解码:握手、报到、要成交的字节;切消息(一批几条、一条切成几批、长度不像话、空消息、坏的 UTF-8、切在半个汉字上);
// 成交消息的按位读(字段不够、多出字段、千分位、-0、Infinity、看涨看跌的各种写法)。
// 状态机:fetchExecutionHistory 接一个假 socket(同 tests/ib-exec-history.spec.ts 的 FakeTws),setTimeout 换成假的,
// 跑几千条随机的事件序列(连上、来一块字节、出错、关了、到点),每一步之后记下写出去的字节、end / destroy 了几次,最后记结果。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_ib_exec_history.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/ibExecHistory.js')).href);

let seed = 0xe7ec_4157;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
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
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const hex = (b) => Buffer.from(b).toString('hex');

const out = { bytes: {}, frames: [], split: [], decode: [], runs: [] };

// ---------------------------------------------------------------- 发出去的字节
out.bytes.handshake = hex(X.handshakeBytes());
out.bytes.clientIds = [12, 0, -1, 1.5, NaN, -0, 1e21].map((c) => [enc(c), enc(X.historyClientId(c))]);
const fieldSets = [[], [''], ['a', 7], [71, 2, 9012, ''], ['中文', 1.5, -0, NaN, Infinity, 1e21, 1e-7, '\0x', '\ud800', '😀'], [0.1 + 0.2, -1e-300, 5e-324]];
for (const f of fieldSets) out.frames.push({ fields: enc(f), hex: hex(X.frame(f)) });
out.bytes.startApi = [9012, 0, NaN, -0, 1.5].map((c) => [enc(c), hex(X.startApiBytes(c))]);
out.bytes.exec = [[1, 7], [1, 1], [2, NaN], [-0, 3.5], [1, Infinity]].map(([r, d]) => [enc(r), enc(d), hex(X.executionsRequestBytes(r, d))]);

// ---------------------------------------------------------------- 切消息
const be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const rawFrame = (payload) => Buffer.concat([be(payload.length), payload]);
const splitInputs = [
  Buffer.alloc(0), Buffer.from([0, 0]), Buffer.from([0, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 1]), Buffer.from([0x7f, 0, 0, 0, 1]), Buffer.from([1, 0, 0, 0]),
  Buffer.from([1, 0, 0, 1]), be(16 * 1024 * 1024), Buffer.concat([be(3), Buffer.from('a\0b')]), Buffer.concat([be(2), Buffer.from('\0\0')]),
  rawFrame(Buffer.from([0xff, 0xfe, 0x41, 0])), rawFrame(Buffer.from([0xe4, 0xb8, 0])), rawFrame(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0])), rawFrame(Buffer.from([0xed, 0xa0, 0x80, 0])),
  rawFrame(Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0])), rawFrame(Buffer.from([0xc0, 0x80, 0])), rawFrame(Buffer.from([0xf4, 0x90, 0x80, 0x80, 0])), rawFrame(Buffer.from('a\0\0b')),
];
const all = Buffer.concat([X.frame([15, 1, 'U1']), X.frame([4, -1, 2104, '行情连接正常', '', 1]), X.frame([55, 1, 1])]);
for (let i = 0; i <= all.length; i += 1) splitInputs.push(all.subarray(0, i), all.subarray(i));
for (const b of splitInputs) {
  const r = run(() => { const s = X.splitFrames(b); return { frames: s.frames, rest: hex(s.rest) }; });
  out.split.push({ hex: hex(b), ...r });
}

// ---------------------------------------------------------------- 成交消息
function execFields(over = {}) {
  const v = {
    reqId: '1', orderId: '0', conId: '920693462', symbol: 'SPX', secType: 'OPT', expiry: '20261007', strike: '7790.0', right: 'P',
    multiplier: '100', exchange: 'CBOE', currency: 'USD', localSymbol: 'SPXW  261007P07790000', tradingClass: 'SPXW',
    execId: '0002be7b.6ac604b0.02.01', time: '20261007-15:59:06', acct: 'U1234567', execExchange: 'CBOE', side: 'BOT',
    shares: '1', price: '8.58', permId: '1165676521', clientId: '0', liquidation: '0', cumQty: '1', avgPrice: '8.58', orderRef: '',
    ...over,
  };
  return [
    '11', v.reqId, v.orderId, v.conId, v.symbol, v.secType, v.expiry, v.strike, v.right, v.multiplier, v.exchange, v.currency,
    v.localSymbol, v.tradingClass, v.execId, v.time, v.acct, v.execExchange, v.side, v.shares, v.price, v.permId, v.clientId,
    v.liquidation, v.cumQty, v.avgPrice, v.orderRef, '', '', '', '2', '0', '',
  ];
}
const numTokens = ['1', '0', '-0', '1,000', '1,2,3', ',', '', ' 7 ', 'abc', 'Infinity', '-Infinity', '1e400', '0x1f', '1e3', '.5', '5.', '+3', '1_000', 'NaN', ' 12', '0b11', '1.7976931348623157E308'];
const rights = ['C', 'P', '', '?', 'CALL', 'c', 'p', 'PUT', ' C'];
const overKeys = ['reqId', 'orderId', 'conId', 'strike', 'multiplier', 'shares', 'price', 'permId', 'clientId', 'liquidation', 'cumQty', 'avgPrice'];
for (let i = 0; i < 600; i += 1) {
  const over = {};
  for (let n = Math.floor(rnd() * 5); n > 0; n -= 1) over[pick(overKeys)] = pick(numTokens);
  if (rnd() < 0.4) over.right = pick(rights);
  if (rnd() < 0.2) over.symbol = pick(['TTWO', '中文', '']);
  let f = execFields(over);
  const r = rnd();
  if (r < 0.1) f = f.slice(0, 26 + Math.floor(rnd() * 3));
  else if (r < 0.15) f = f.slice(0, Math.floor(rnd() * 26));
  else if (r < 0.25) f = [...f, '以后', '加的'];
  out.decode.push({ fields: f, out: enc(X.decodeExecution(f)) });
}

// ---------------------------------------------------------------- 一趟一趟地跑
// 假的计时器:记下时长,"到点"这个事件来了才调
let timers = [];
globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { if (t) t.cleared = true; };

class FakeTws extends EventEmitter {
  sent = [];
  ended = 0;
  destroyed = 0;
  write(data) { this.sent.push(hex(data)); return true; }
  end() { this.ended += 1; }
  destroy() { this.destroyed += 1; }
}

const versions = ['200', '200', '200', '200', '200', '200', '201', '1e3', '187', '199', '100', '99', 'abc', '', ' 200 ', '1e3', '0x100', '200.9', '-0', '0', 'Infinity', '200abc'];
const errTexts = ['Market data farm connection is OK:usfarm', 'Unable to connect as the client id is already in use.', "Error validating request.-'bN' : cause - Invalid",
  '', '  ', '中文的报错', 'x'.repeat(250), '😀'.repeat(120), `${'a'.repeat(198)}😀tail`];
const randomMessage = () => {
  const r = rnd();
  if (r < 0.12) return [15, 1, pick(['U1234567', 'U1,DU2', ''])];
  if (r < 0.22) return [9, 1, Math.floor(rnd() * 100)];
  if (r < 0.34) return [4, pick([-1, -1, 1, 2, '1', ' 1', '1.0', '']), pick([2104, 2106, 2158, 2100, 2199, 2200, 2099, 326, 321, 1100, 'x', '']), pick(errTexts), '', 1];
  if (r < 0.37) return [4, pick([-1, 1])];
  if (r < 0.6) {
    const o = rnd() < 0.3 ? { reqId: pick(['1', '9', '1.0', ' 1', '', 'x']) } : {};
    if (rnd() < 0.3) o[pick(overKeys)] = pick(numTokens);
    o.execId = `e${Math.floor(rnd() * 1000)}`;
    const f = execFields(o);
    return rnd() < 0.06 ? f.slice(0, 20) : f;
  }
  if (r < 0.7) return [55, 1, pick([1, 1, 9, '1', '1.0', '', 'x'])];
  if (r < 0.75) return [55, 1];
  if (r < 0.8) return [59, 1, 'e1', '1.63', 'USD'];
  if (r < 0.84) return [pick([999, '', ' 9 ', '0x0b', '11.0', '0b1111', '9e0', 'NaN']), 1, 1];
  if (r < 0.86) return [];
  return [pick([9, 15]), 1, 'x'];
};
const chunked = (buf) => {
  const parts = [];
  let at = 0;
  while (at < buf.length) {
    const r = rnd();
    const n = r < 0.5 ? buf.length - at : Math.max(1, Math.floor(rnd() * (buf.length - at + 1)));
    parts.push(buf.subarray(at, at + n));
    at += n;
  }
  return parts;
};

const timeoutPool = [undefined, undefined, 8000, 1500, 499, 500, 2500, NaN, 0, -1, 1e10, 0.4, 7.5e3];
const dayPool = [7, 7, 1, 3, 30, 0, -2, 3.7, 7.9, NaN, Infinity, -Infinity, 0.5];
const clientPool = [9012, 9000, 0, 1.5, NaN, -0];

for (let i = 0; i < 2000; i += 1) {
  timers = [];
  const tws = new FakeTws();
  const timeoutMs = pick(timeoutPool);
  const days = pick(dayPool);
  const clientId = pick(clientPool);
  const req = { host: '127.0.0.1', port: 7496, clientId, days, connect: () => tws };
  if (timeoutMs !== undefined) req.timeoutMs = timeoutMs;
  let outcome = null;
  X.fetchExecutionHistory(req).then((v) => { outcome = { ok: enc(v) }; }, (e) => { outcome = { error: e.message }; });
  const timer = timers[0];
  const steps = [];
  const doEvent = (ev) => {
    if (ev.t === 'connect') tws.emit('connect');
    else if (ev.t === 'data') tws.emit('data', Buffer.from(ev.hex, 'hex'));
    else if (ev.t === 'error') tws.emit('error', new Error(ev.msg));
    else if (ev.t === 'close') tws.emit('close');
    else if (ev.t === 'timeout') { if (timer && !timer.cleared && !timer.fired) { timer.fired = true; timer.fn(); } }
    steps.push({ ...ev, sent: tws.sent.length, ended: tws.ended, destroyed: tws.destroyed });
  };
  const events = [];
  const style = rnd();
  if (style < 0.05) events.push({ t: pick(['timeout', 'error', 'close']), msg: 'connect ECONNREFUSED 127.0.0.1:7496' });
  events.push({ t: 'connect' });
  // 握手回话
  const ver = pick(versions);
  const msgs = [];
  if (rnd() < 0.9) msgs.push(rnd() < 0.05 ? [] : [ver, '20261009 10:05:01 Asia/Shanghai']);
  const nMsg = Math.floor(rnd() * 10);
  if (rnd() < 0.7) msgs.push([15, 1, 'U1234567'], [9, 1, 1]);
  for (let k = 0; k < nMsg; k += 1) msgs.push(randomMessage());
  if (rnd() < 0.6) msgs.push([55, 1, 1]);
  let bytes = Buffer.concat(msgs.map((m) => X.frame(m)));
  if (rnd() < 0.04) bytes = Buffer.concat([bytes, Buffer.from([0x7f, 0, 0, 0, 0x41])]);
  if (rnd() < 0.04) bytes = Buffer.concat([bytes, rawFrame(Buffer.from([0x34, 0, 0xff, 0x2d, 0x31, 0, 0x33, 0x32, 0x36, 0, 0xe4, 0xb8, 0]))]);
  for (const part of chunked(bytes)) events.push({ t: 'data', hex: hex(part) });
  const tail = rnd();
  if (tail < 0.25) events.push({ t: 'close' });
  else if (tail < 0.35) events.push({ t: 'error', msg: pick(['read ECONNRESET', 'connect ECONNREFUSED 127.0.0.1:7496', '']) });
  else if (tail < 0.5) events.push({ t: 'timeout' });
  if (rnd() < 0.3) events.push(pick([{ t: 'close' }, { t: 'timeout' }, { t: 'data', hex: hex(X.frame([55, 1, 1])) }, { t: 'error', msg: 'late' }]));
  for (const ev of events) doEvent(ev);
  await Promise.resolve();
  await Promise.resolve();
  out.runs.push({ timeoutMs: enc(timeoutMs), days: enc(days), clientId: enc(clientId), timerMs: enc(timer?.ms), timerCleared: timer?.cleared ?? null,
    steps, sent: tws.sent, outcome });
}

writeFileSync(join(here, 'ib_exec_history.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
