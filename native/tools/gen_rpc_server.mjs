// 生成 tests/fixtures/rpc-server.json:引擎 RPC 服务(engine-ts 的 rpc/server.ts)的线上行为——原模块现跑,记下每一行输出。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tools/gen_rpc_server.mjs <编过的 engine-ts 目录>
//
// 怎么跑:真的 RpcServer(dist/src/rpc/server.js),真的 serve(),喂一条 PassThrough 流(同 tests/rpc-lanes.spec.ts);
//   · 配置 = baseline/rpc/base_config.json + 临时目录里的库,IBKR_USER_DATA_DIR 指到临时目录;从不用真配置、真库,不连任何券商(没人调 main()
//     所以 brokerLink / follow / fillSync / assignmentWatch 都不起;broker.auto_connect 本来也是关的);
//   · serve() 里会起的三个行情循环(anomaly / ivRecorder / playbook)换成空的,全局 fetch 换成立即失败(serve 起来会预热 SPX 的公开现价);
//   · 两类场景:
//       wire  = 用 server 自带的真方法表。只走不进引擎的路径:没有这个方法、解析不了的行、各种 id / method / params、入参过不了 schema(-32602)。
//       stub  = 把 methods() 换成合成的方法(睡几毫秒、抛各种错、回各种值),只看调度与回执的样子;道表里的方法名照真的(同 rpc-lanes.spec.ts)。
//   · 每个场景:输入是原始字节(base64),一次 write 进去(= 一个 chunk;各行在 readline 里同步派发,同 C++ 那边挨个 handleLine 的做法),
//     输出是 out() 收到的每一整行原文(JSON.stringify 的键序、数的写法、转义都在内),再加 serve() 返回的退出码。
//   · crash:收到的行让 TS 的 line 监听抛了(null["method"]、WeakMap 不收原始值作键)= 整个进程 uncaughtException。记下抛了什么;
//     C++ 不照搬(不会为一行输入把引擎打死,按"未知方法"答),见交付报告。
// 固定输入、无随机;时间用的是睡眠的先后(间隔 ≥ 30 ms),不是毫秒数本身。同一台机器上输出逐字节相同(时间只影响先后,先后留足了余量)。
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (p) => import(pathToFileURL(join(engine, 'dist/src', p)).href);

const dir = mkdtempSync(join(tmpdir(), 'rpc-server-oracle-'));
process.env.IBKR_USER_DATA_DIR = dir;
globalThis.fetch = () => Promise.reject(new Error('offline'));  // serve() 预热公开现价:不联网

const base = JSON.parse(readFileSync(join(engine, 'baseline', 'rpc', 'base_config.json'), 'utf-8'));
const settingsPath = join(dir, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: join(dir, 't.db') } }));

const { RpcServer } = await imp('rpc/server.js');
const { RpcError } = await imp('rpcError.js');
const { KeychainError } = await imp('secrets.js');
const { setClock } = await imp('config.js');
setClock(Date.UTC(2026, 7, 14, 14, 32, 0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
const encValue = (v) => JSON.parse(JSON.stringify(v));
const scrub = (s) => s.split(settingsPath).join('<CONFIG>');

// ---------------------------------------------------------------- 合成方法(stub 场景)
const STUB = {
  // 本地道
  'sectors.list': () => ({ lane: 'local', sync: true }),
  'sectors.add': async () => { await sleep(30); return { lane: 'local', slow: true }; },
  'settings.get': () => { throw new RpcError(-32001, '本地道上的拒绝'); },
  'system.status': () => ({ ok: true }),
  // 读道
  'pa.analyze': async () => { await sleep(800); return { lane: 'read', n: 1 }; },
  'backtest.strategies': async () => { await sleep(150); return { lane: 'read', n: 2 }; },
  'book.snapshot': async () => { await sleep(160); return { lane: 'read', n: 3 }; },
  'options.wall': async () => { await sleep(170); return { lane: 'read', n: 4 }; },
  'screener.rs': async () => { await sleep(180); return { lane: 'read', n: 5 }; },
  'screener.inflection': async () => { await sleep(250); return { lane: 'read', n: 6 }; },
  'screener.deviation': async () => { await sleep(60); return { lane: 'read', n: 7 }; },
  'macro.board': async () => { await sleep(30); return { lane: 'read+low', n: 8 }; },
  // 交易道(低优先级的两个:alerts.poll / pending.poll)
  'instruction.submit': async () => { await sleep(100); return { lane: 'trade', n: 1 }; },
  'alerts.poll': async () => { await sleep(60); return { lane: 'low', n: 1 }; },
  'pending.poll': async () => { await sleep(60); return { lane: 'low', n: 2 }; },
  'tracker.add': () => ({ lane: 'trade', sync: true }),
  // 各种出错与各种返回值(都在交易道上)
  'x.throw_rpc': () => { throw new RpcError(-32005, '被拒了:额度不够'); },
  'x.throw_rpc_zero': () => { throw new RpcError(0, ''); },
  'x.throw_type': () => { throw new TypeError('boom'); },
  'x.throw_range': () => { throw new RangeError('远了'); },
  'x.throw_plain': async () => { throw new Error('plain'); },
  'x.throw_keychain': () => { throw new KeychainError('钥匙串被拒:点一下系统弹窗'); },
  'x.throw_async_rpc': async () => { await sleep(20); throw new RpcError(-32004, '等了一会儿才拒'); },
  'x.echo': (p) => ({ echo: p }),
  'x.null': () => null,
  'x.number': () => 42,
  'x.array': () => [1, 'a', null, { k: -0 }],
  'x.string': () => 'text',
  'x.unicode': () => ({ s: '\u2028中文😀\ud800 \u0001"\\/' }),
  'x.nums': () => ({ a: -0, b: 1e21, c: 1e-7, d: 0.1 + 0.2, e: 123456789012345680000, f: Infinity, g: NaN, h: 5e-324, i: 1.7976931348623157e308, j: 100, k: 1.5e300 }),
  'x.slow_trade': async () => { await sleep(300); return { lane: 'trade', slow: true }; },
  'x.fast_trade': () => ({ lane: 'trade', fast: true }),
};

// 无原型的表(同真的方法表):'toString' / 'constructor' 不是登记过的方法
const STUB_TABLE = Object.assign(Object.create(null), STUB);

// ---------------------------------------------------------------- 跑一个场景
async function run(ops, { stub = false } = {}) {
  if (process.env.ORACLE_TRACE) writeSync(2, `run ${JSON.stringify(ops).slice(0, 80)}\n`);
  const out = [];
  const server = new RpcServer(settingsPath, (line) => out.push(scrub(line)));
  for (const name of ['anomaly', 'ivRecorder', 'playbook']) server[name].start = () => {};
  if (stub) server.methods = () => STUB_TABLE;
  const input = new PassThrough();
  let crash = null;
  const onCrash = (e) => { crash = crash ?? `${e?.constructor?.name}: ${e?.message}`; };
  process.on('uncaughtException', onCrash);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;  // 慢请求行、未料到的错的调用栈
  const done = server.serve(input);
  const recorded = [];
  for (const op of ops) {
    if (op.chunk !== undefined) {
      const buf = Buffer.isBuffer(op.chunk) ? op.chunk : Buffer.from(op.chunk, 'utf-8');
      recorded.push(buf.toString('base64'));
      // PassThrough 把 'data' 同步派发给 readline,line 监听抛了就从 write 里冒出来(真的 stdin 上是整个进程 uncaughtException)
      try { input.write(buf); } catch (e) { onCrash(e); break; }
    }
    else if (op.wait !== undefined) { recorded.push({ wait: op.wait }); await sleep(op.wait); }
    else if (op.emit) { recorded.push({ emit: op.emit }); server.emit(op.emit[0], op.emit[1]); }
    else if (op.call) { recorded.push({ call: op.call }); /* 直接调,不走流 */ }
  }
  input.end();
  const code = await Promise.race([done.then((c) => ({ code: c }), (e) => ({ rejected: `${e?.constructor?.name}: ${e?.message}` })), sleep(crash ? 50 : 6000).then(() => ({ timeout: true }))]);
  await sleep(20);
  process.off('uncaughtException', onCrash);
  process.stderr.write = stderrWrite;
  input.destroy();
  const res = { ops: recorded, out };
  if (crash) res.crash = crash;
  if ('code' in code) res.code = code.code;
  else if (!crash) res.end = code;
  return res;
}
const lines = (...ls) => ls.join('\n') + '\n';
const req = (o) => JSON.stringify(o);

const out = { methodNames: null, lanes: {}, sets: {}, wire: [], stub: [], crash: [], misc: {} };

// ---------------------------------------------------------------- 道表
const real = new RpcServer(settingsPath, () => {});
out.sets = {
  local: [...RpcServer.LOCAL_METHODS],
  read: [...RpcServer.READ_METHODS],
  low: [...RpcServer.LOW_PRIORITY_METHODS],
  readConcurrency: RpcServer.READ_CONCURRENCY,
  slowMs: RpcServer.SLOW_MS,
};
out.methodNames = real.methodNames();
for (const n of [...out.methodNames, '', 'nope', 'constructor', '__proto__', 'toString', 'x.throw_rpc', 'tws.scan', 'alerts.poll', 'positions.list'])
  out.lanes[n] = RpcServer.laneOf(n);
out.misc.protocol = (await imp('rpc/context.js')).PROTOCOL_VERSION;

// ---------------------------------------------------------------- wire:真方法表,不进引擎的路径
const W = (name, chunk, opts = {}) => out.wire.push({ name, in: [chunk], ...opts });
const unk = (id) => req({ jsonrpc: '2.0', id, method: 'nope.method' });

W('malformed lines then a good one', lines(
  '{not json', '{"jsonrpc":"2.0","id":1,"method":"nope"', '{"id":1,}', '[1,2', "'single'", '{"a":1}x', '{"a":1}{"b":2}', '{"a":', '}', '{', '', 'nul', 'truee', 'NaN', '-', '+1', '01', '.5', '1.', '1e', '"unterminated',
  '{"id":1,"method":"a"} // comment', '{"a":1,}', '[,]', '{"a" 1}', '{a:1}', '"\\x"', '"\\u00zz"', '"\t"', '"\u0001"',
  unk('after-bad')));
W('blank and whitespace-only lines are skipped', '\n   \n\t\n\u00a0\n\ufeff\n\u2028\n\u3000\n' + unk('after-blank') + '\n');
W('trim removes unicode whitespace around a request', '\ufeff' + unk('bom') + '\n\u00a0' + unk('nbsp') + '\u2003\n\u2028' + unk('ls') + '\n');
W('CRLF and lone CR', unk('crlf-1') + '\r\n' + unk('crlf-2') + '\r\n' + unk('cr-1') + '\r' + unk('cr-2') + '\r' + unk('lf-1') + '\n' + unk('crcrlf') + '\r\r\n');
W('U+2029 and U+2028 as separators, also at the end of a line', unk('ps-1') + '\u2029' + unk('ps-2') + '\u2028' + unk('ps-3') + '\u2029\n' + '\u2029' + unk('ps-4') + '\n' + unk('ps-5') + '\u2029');
// 解析不了的行与本地道(keychain.set / follow.set_token 过不了 schema,同步答 -32602)、读道(backtest.sweep)、交易道混排:
// TS 里先后由微任务队列定(解析不了的行是主循环醒来时直接写),C++ 要一样
{
  const loc = (id) => req({ jsonrpc: '2.0', id, method: 'keychain.set', params: {} });
  const rd = (id) => req({ jsonrpc: '2.0', id, method: 'backtest.sweep', params: {} });
  const tr = (id) => req({ jsonrpc: '2.0', id, method: 'alerts.create', params: {} });
  W('bad json before a local request', lines('{bad', loc('L1')));
  W('bad json after a local request', lines(loc('L1'), '{bad'));
  W('bad json between local requests', lines(loc('L1'), '{bad', loc('L2'), '{bad2', loc('L3')));
  W('trade, bad, local, read in one chunk', lines(tr('T1'), '{bad', loc('L1'), rd('R1'), tr('T2'), '{bad2', rd('R2'), loc('L2')));
  W('local first then trade then bad', lines(loc('L1'), rd('R1'), tr('T1'), '{bad', tr('T2')));
  W('only bad lines and locals alternating', lines('{x', loc('L1'), '{y', loc('L2'), '{z', rd('R1'), '[1', rd('R2')));
}
W('no trailing newline', unk('last-no-newline'));
W('ids of every json type', lines(
  req({ jsonrpc: '2.0', id: 1, method: 'a' }), req({ jsonrpc: '2.0', id: 0, method: 'a' }), req({ jsonrpc: '2.0', id: -1, method: 'a' }), req({ jsonrpc: '2.0', id: 1.5, method: 'a' }),
  req({ jsonrpc: '2.0', id: 'str', method: 'a' }), req({ jsonrpc: '2.0', id: '', method: 'a' }), req({ jsonrpc: '2.0', id: true, method: 'a' }), req({ jsonrpc: '2.0', id: false, method: 'a' }),
  req({ jsonrpc: '2.0', id: null, method: 'a' }), req({ jsonrpc: '2.0', method: 'a' }),
  req({ jsonrpc: '2.0', id: [], method: 'a' }), req({ jsonrpc: '2.0', id: [1, 'x', null, [2], { b: 1, a: 2 }], method: 'a' }),
  req({ jsonrpc: '2.0', id: {}, method: 'a' }), req({ jsonrpc: '2.0', id: { z: 1, a: { y: [1, 2], b: null }, 10: 'ten', 2: 'two', '-1': 'neg', '01': 'lead' }, method: 'a' }),
  '{"jsonrpc":"2.0","id":1e999,"method":"a"}', '{"jsonrpc":"2.0","id":-1e999,"method":"a"}', '{"jsonrpc":"2.0","id":-0,"method":"a"}', '{"jsonrpc":"2.0","id":0.0,"method":"a"}',
  '{"jsonrpc":"2.0","id":1.0,"method":"a"}', '{"jsonrpc":"2.0","id":1E2,"method":"a"}', '{"jsonrpc":"2.0","id":1e-400,"method":"a"}', '{"jsonrpc":"2.0","id":-1e-400,"method":"a"}',
  '{"jsonrpc":"2.0","id":12345678901234567890,"method":"a"}', '{"jsonrpc":"2.0","id":123456789012345678901234567890,"method":"a"}', '{"jsonrpc":"2.0","id":9007199254740993,"method":"a"}',
  '{"jsonrpc":"2.0","id":1e21,"method":"a"}', '{"jsonrpc":"2.0","id":1e-7,"method":"a"}', '{"jsonrpc":"2.0","id":0.1,"method":"a"}', '{"jsonrpc":"2.0","id":5e-324,"method":"a"}', '{"jsonrpc":"2.0","id":1.7976931348623157e308,"method":"a"}',
  '{"jsonrpc":"2.0","id":[1e999,-0,1e-400,{"k":-0}],"method":"a"}', '{"id":1,"id":2,"method":"a","method":"b"}', '{"id":"\\u00e9\\ud83d\\ude00\\ud800\\udc00","method":"a"}', '{"id":"\\ud800","method":"a"}', '{"id":"\\udc00x","method":"a"}',
  '{"id":"\\u2028\\u2029\\u0000\\u001f\\"\\\\\\/\\b\\f\\n\\r\\t","method":"a"}', '{"id":"\u2028 raw ls","method":"a"}', '{"id":"中文 😀","method":"a"}', '{"id":"\u007f\u0080\u00ff","method":"a"}', '{"id":"\\u003c\\u003e\\u0026","method":"a"}',
  '{"id":{"__proto__":1,"constructor":2,"toString":3},"method":"a"}', '{"id":{"a":1,"a":2,"b":3,"a":4},"method":"a"}', '{"id":"' + 'x'.repeat(30000) + '","method":"a"}'));
W('method of every json type (String(method ?? ""))', lines(
  '{"id":1,"method":"plain"}', '{"id":2,"method":""}', '{"id":3}', '{"id":4,"method":null}', '{"id":5,"method":1}', '{"id":6,"method":1.5}', '{"id":7,"method":1e21}', '{"id":8,"method":-0}', '{"id":9,"method":1e999}',
  '{"id":10,"method":true}', '{"id":11,"method":false}', '{"id":12,"method":[]}', '{"id":13,"method":[1,2]}', '{"id":14,"method":[[1],[2,[3]]]}', '{"id":15,"method":[null,1,null]}', '{"id":16,"method":["a","b"]}',
  '{"id":17,"method":{}}', '{"id":18,"method":{"a":1}}', '{"id":19,"method":"constructor"}', '{"id":20,"method":"__proto__"}', '{"id":21,"method":"toString"}', '{"id":22,"method":"hasOwnProperty"}',
  '{"id":23,"method":"中文😀"}', '{"id":24,"method":"\\ud800"}', '{"id":25,"method":"a\\u0000b"}', '{"id":26,"method":" sectors.list "}', '{"id":27,"method":"SYSTEM.STATUS"}', '{"id":28,"method":[true,false]}', '{"id":29,"method":[1e999,-0]}',
  '{"id":30,"method":[[]]}', '{"id":31,"method":[{}]}', '{"id":32,"method":0.000001}', '{"id":33,"method":0.0000001}', '{"id":34,"method":123456789012345680000}', '{"id":35,"method":"x\\/y"}'));
W('requests that are arrays', lines('[]', '[1]', '[{"id":1,"method":"a"}]', '["method"]', '[[],[]]', '[null]', unk('after-arrays')));
W('contract methods: params that fail the schema (-32602)', lines(
  req({ id: 1, method: 'alerts.create' }), req({ id: 2, method: 'alerts.create', params: null }), req({ id: 3, method: 'alerts.create', params: {} }), req({ id: 4, method: 'alerts.create', params: [] }),
  req({ id: 5, method: 'alerts.create', params: 5 }), req({ id: 6, method: 'alerts.create', params: 'x' }), req({ id: 7, method: 'alerts.create', params: true }), req({ id: 8, method: 'alerts.create', params: false }),
  req({ id: 9, method: 'alerts.create', params: 0 }), req({ id: 10, method: 'alerts.create', params: '' }), req({ id: 11, method: 'alerts.create', params: [1, 2] }),
  req({ id: 12, method: 'alerts.create', params: { symbol: 1 } }), req({ id: 13, method: 'alerts.create', params: { symbol: null } }), req({ id: 14, method: 'alerts.create', params: { symbol: 'X', step: true } }),
  req({ id: 15, method: 'alerts.create', params: { symbol: 'X', step: [] } }), req({ id: 16, method: 'alerts.create', params: { symbol: 'X', origin: 5 } }), req({ id: 17, method: 'alerts.delete', params: {} }),
  '{"id":18,"method":"alerts.create","params":{"symbol":1e999}}', '{"id":19,"method":"alerts.create","params":{"symbol":-0}}',
  req({ id: 20, method: 'tracker.add', params: { key: 'k', bogus: 1 } }), req({ id: 21, method: 'tracker.add', params: { key: 'k', take_profit: [] } }), req({ id: 22, method: 'tracker.add', params: {} }),
  req({ id: 23, method: 'tracker.add', params: { key: 'k', profit_drawdown_tiers: [{ above: 'x', pct: {} }] } }), req({ id: 24, method: 'tracker.delete', params: { id: 'x', extra: true } }),
  req({ id: 25, method: 'tracker.update', params: { id: 1 } }), req({ id: 26, method: 'tracker.close_now', params: { key: 5 } }),
  req({ id: 27, method: 'instruction.submit', params: { text: 5 } }), req({ id: 28, method: 'instruction.submit', params: { text: 'x', bogus: 1 } }),
  req({ id: 29, method: 'backtest.sweep', params: { symbols: 'AAPL' } }), req({ id: 30, method: 'settings.patch', params: { patch: 1, x: 2 } }), req({ id: 31, method: 'keychain.set', params: { secret: 1 } }),
  req({ id: 32, method: 'llm.patch', params: { llm: [] } }), req({ id: 33, method: 'follow.set_token', params: { token: {} } }), req({ id: 34, method: 'alerts.refresh', params: { id: 'a', step: 'x', expiry: 5 } })));
W('unknown method then error shapes keep key order', lines(
  req({ method: 'nope', id: 1, jsonrpc: '2.0' }), req({ params: {}, id: 2, method: 'nope' }), req({ id: 3, method: 'nope', params: [1, 2] }), req({ id: 4, method: 'nope', params: { a: -0, b: 1e999 } }), req({ id: 5, jsonrpc: '1.0', method: 'nope' })));
W('unicode in the unknown-method text', lines(req({ id: 1, method: '中文方法' }), req({ id: 2, method: '😀' }), '{"id":3,"method":"\\ud800x"}', '{"id":4,"method":"a\\u2028b"}', '{"id":5,"method":"q\\"uote\\\\back"}', '{"id":6,"method":"\\u0001\\u001f"}'));
W('invalid utf-8 bytes', Buffer.concat([Buffer.from('{"id":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('b","method":"m'), Buffer.from([0xc3]), Buffer.from('"}\n{"id":2,"method":"ok"}\n')]), { raw: true });
W('lines inside one chunk split across writes are joined', '');  // 占位,下面单独做
out.wire.pop();
// 字节层面的拆分:同一行分成几次 write(readline 按行重组);C++ 的读入层是 getline,拼好的行才进 handleLine
out.wire.push({ name: 'one line split across writes', in: ['{"jsonrpc":"2.0","id":"split","me', 'thod":"nope"}\n{"id":2,"meth', 'od":"nope"}\n'] });
W('deeply nested id is echoed', lines('{"id":' + '['.repeat(800) + ']'.repeat(800) + ',"method":"a"}'));
W('deep nesting inside params of a contract method', lines('{"id":1,"method":"alerts.create","params":{"symbol":' + '['.repeat(800) + ']'.repeat(800) + '}}'));

for (const w of out.wire) {
  const ops = w.in.map((c) => ({ chunk: c }));
  const res = await run(ops);
  w.in = res.ops;
  w.out = res.out;
  w.code = res.code;
  if (res.crash) w.crash = res.crash;
  if (res.end) w.end = res.end;
  delete w.raw;
}

// ---------------------------------------------------------------- crash:让 line 监听抛的行
for (const [name, text] of [['null', 'null'], ['number', '42'], ['string', '"x"'], ['true', 'true'], ['false', 'false'], ['zero', '0'], ['empty string', '""'], ['float', '1.5']]) {
  const res = await run([{ chunk: text + '\n' }]);
  out.crash.push({ name, in: res.ops, out: res.out, crash: res.crash ?? null, code: res.code ?? null, end: res.end ?? null });
}

// ---------------------------------------------------------------- stub:调度与回执
const S = (name, ops) => out.stub.push({ name, ops });
const J = (id, method, params) => req(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
S('errors are mapped by class (RpcError / KeychainError / other)', [{ chunk: lines(
  J(1, 'x.throw_rpc', {}), J(2, 'x.throw_rpc_zero', {}), J(3, 'x.throw_type', {}), J(4, 'x.throw_range', {}), J(5, 'x.throw_plain', {}), J(6, 'x.throw_keychain', {}), J(7, 'x.throw_async_rpc', {}),
  J(8, 'settings.get', {}), J('str-id', 'x.throw_type'), J(null, 'x.throw_rpc')) }]);
S('results of every json type and number spelling', [{ chunk: lines(
  J(1, 'x.null'), J(2, 'x.number'), J(3, 'x.array'), J(4, 'x.string'), J(5, 'x.unicode'), J(6, 'x.nums'),
  J(7, 'x.echo', { z: 1, a: [1, { y: 2, b: -0 }], 10: 'ten', 2: 'two', '': 'empty', big: 12345678901234567890 }),
  '{"id":8,"method":"x.echo","params":{"n":-0,"i":1e999,"j":-1e999,"u":1e-400,"s":5e-324,"m":1.7976931348623157e308,"b":123456789012345678901234567890,"e":1E2,"p":0.30000000000000004}}',
  '{"id":9,"method":"x.echo","params":[1e999,-0,"x",null]}', '{"id":10,"method":"x.echo","params":5}', '{"id":11,"method":"x.echo","params":"s"}', '{"id":12,"method":"x.echo","params":null}',
  '{"id":13,"method":"x.echo","params":false}', '{"id":14,"method":"x.echo"}', '{"id":15,"method":"x.echo","params":{"__proto__":{"a":1},"constructor":2,"a":1,"a":2}}',
  '{"id":16,"method":"x.echo","params":{"k\\ud800":"\\ud800v","\\u2028":"\u2028"}}') }]);
S('local lane answers at once, trade lane waits its turn, bad json is answered in trade order', [{ chunk: lines(
  J(1, 'pa.analyze', {}), J(2, 'instruction.submit', {}), J(3, 'alerts.poll', {}), J(4, 'sectors.add', {}), J(5, 'sectors.list', {}), '{bad json', J(6, 'unknown.method', {}), J(7, 'x.fast_trade', {})) }]);
S('read lane runs four at a time', [{ chunk: lines(
  J(1, 'backtest.strategies', {}), J(2, 'book.snapshot', {}), J(3, 'options.wall', {}), J(4, 'screener.rs', {}), J(5, 'screener.inflection', {}), J(6, 'screener.deviation', {}), J(7, 'sectors.list', {})) }]);
S('user requests jump ahead of polling requests on the trade lane', [{ chunk: lines(
  J(1, 'x.slow_trade', {}), J(2, 'alerts.poll', {}), J(3, 'pending.poll', {}), J(4, 'instruction.submit', {}), J(5, 'x.fast_trade', {}), J(6, 'macro.board', {})) }]);
S('requests arriving while the trade lane is busy', [{ chunk: lines(J(1, 'x.slow_trade', {}), J(2, 'alerts.poll', {})) }, { wait: 30 }, { chunk: lines(J(3, 'sectors.list', {}), J(4, 'instruction.submit', {}), J(5, 'x.fast_trade', {})) }, { wait: 30 },
  { chunk: lines('{bad', J(6, 'x.fast_trade', {})) }]);
S('eof waits for requests still in flight on every lane', [{ chunk: lines(J(1, 'pa.analyze', {}), J(2, 'sectors.add', {}), J(3, 'instruction.submit', {})) }]);
// 事件在流里的先后:chunk 之前的、等回执写完之后的(chunk 里本地道的同步回执在 TS 里晚一个微任务才写,所以不在 chunk 之后紧跟着发事件)
S('events are written between replies', [{ emit: ['tracker', { fired: [], blocked: [{ k: -0, n: 1e999 }] }] }, { chunk: lines(J(1, 'sectors.list', {})) }, { wait: 40 }, { emit: ['notification', { title: '中文', subtitle: '', body: 'a"b\n' }] }]);
S('empty server: eof with nothing sent', []);
S('same ids reused and requests with no id', [{ chunk: lines(J(1, 'x.fast_trade', {}), J(1, 'sectors.list', {}), '{"method":"x.fast_trade"}', '{"method":"sectors.list","id":null}', '{"id":1,"method":"x.fast_trade"}') }]);
S('params object with keys that look like array indexes keeps JS key order', [{ chunk: lines('{"id":1,"method":"x.echo","params":{"b":1,"2":2,"a":3,"1":4,"10":5,"01":6,"4294967295":7,"4294967294":8,"-1":9}}') }]);

for (const s of out.stub) {
  const res = await run(s.ops, { stub: true });
  s.ops = res.ops;
  s.out = res.out;
  s.code = res.code;
  if (res.crash) s.crash = res.crash;
  if (res.end) s.end = res.end;
}

// ---------------------------------------------------------------- ready 事件与 call()
{
  const res = await run([], {});
  out.misc.readyOnly = res.out;
  const server = new RpcServer(settingsPath, () => {});
  server.methods = () => STUB_TABLE;
  const direct = {};
  for (const [k, args] of [['x.echo', [{ a: 1 }]], ['x.number', []], ['nope', []], ['constructor', []], ['toString', []], ['x.throw_rpc', []], ['x.throw_type', []], ['x.throw_keychain', []]]) {
    try { direct[k] = { out: JSON.stringify(await server.call(k, ...args)) }; } catch (e) { direct[k] = { error: `${e.constructor.name}: ${e.message}`, code: e.code ?? null }; }
  }
  out.misc.call = direct;
}

// ---------------------------------------------------------------- context.ts / services/host.ts:needConnection、accounts()、追踪锁
{
  const { loadSettings } = await imp('config.js');
  const { needConnection, gatewayName } = await imp('services/host.js');
  const { HandlerBase } = await imp('rpc/context.js');
  const settings = loadSettings(settingsPath);
  class Probe extends HandlerBase { methods() { return {}; } view() { return this.accounts(); } connection(code, what) { return this.needConnection(code, what); } gw() { return this.gateway(); } }
  const probe = new Probe({ settings });
  out.misc.gateway = [];
  for (const provider of ['ibkr', 'futu', 'weird', '']) {
    settings.broker.provider = provider;
    const e = needConnection(settings, -32003, '下单');
    const viaBase = probe.connection(-32004, '「读持仓」');
    out.misc.gateway.push({ provider, gateway: gatewayName(settings), base: probe.gw(), code: e.code, message: e.message, baseCode: viaBase.code, baseMessage: viaBase.message, cls: e.constructor.name,
      accounts: encValue(probe.view()) });
  }
  const lockServer = new RpcServer(settingsPath, () => {});
  const log = [];
  const results = await Promise.allSettled([
    lockServer.trackerLock(async () => { log.push('a start'); await sleep(40); log.push('a end'); return 1; }),
    lockServer.trackerLock(async () => { log.push('b start'); throw new Error('b fail'); }),
    lockServer.trackerLock(async () => { log.push('c start'); await sleep(10); log.push('c end'); return 3; }),
    lockServer.trackerLock(() => { log.push('d sync'); return Promise.resolve(4); }),
    lockServer.trackerLock(() => { log.push('e throws synchronously'); throw new Error('e fail'); }),
    lockServer.trackerLock(async () => { log.push('f start'); return 6; }),
  ]);
  out.misc.lock = { log, results: results.map((r) => (r.status === 'fulfilled' ? { ok: r.value } : { error: r.reason.message })) };
}

writeFileSync(join(here, '..', 'tests', 'fixtures', 'rpc-server.json'), JSON.stringify(out));
console.log(`rpc-server.json:wire ${out.wire.length} 个场景、stub ${out.stub.length} 个、crash ${out.crash.length} 个`);
process.exit(0);
