// 生成 tws_detect.json:engine-ts 的 tws.ts(原模块现跑)。碰外面的几样全换成假的,C++ 那边换成同一套假的:
//   · node:fs 的 globSync / existsSync → 一份虚拟目录表(通配只认 *;模式里有 "[[" 就抛,走 expandGlob 的 catch);
//   · node:os 的 homedir / platform → 固定的家目录、轮着换的平台;
//   · node:child_process 的 spawnSync / spawn → 查表回话,并记下每一次调用(命令、参数、timeout)。
// 端口探测与握手本来就能注入(prober / handshake),这里给的是记下入参、回固定结果的假实现;默认握手一次都不走(不连网)。
// 另记:真的 fs.globSync 在一棵临时目录树上的结果(C++ 建同一棵树比),path.posix 的 join / normalize / basename / dirname。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_tws_detect.mjs <编过的 engine-ts 目录>
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const require = createRequire(import.meta.url);
const T = await import(pathToFileURL(join(engine, 'dist/src/tws.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);

let seed = 0x7e5d_e7ec;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const subset = (a, p) => a.filter(() => rnd() < p);
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
const errText = (e) => `${e.constructor.name}: ${e.message}`;
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: errText(e) }; } };
const runAsync = async (f) => { try { return { out: enc(await f()) }; } catch (e) { return { error: errText(e) }; } };

const out = { constants: {}, real_glob: { tree: [], cases: [] }, posix: [], expand: [], detect: [], launch: [], explain: [], alias: [], scan: [], diagnose: [], guide: [], settings: [] };

// ---------------------------------------------------------------- 常量(未打补丁前)
out.constants = { known: T.KNOWN_ENDPOINTS, apps: T.APP_CANDIDATES, procs: T.PROCESS_PATTERNS, hints: Object.entries(T.IBKR_ERROR_HINTS) };

// ---------------------------------------------------------------- 真的 fs.globSync(临时目录树)
const tree = ['Trader Workstation 10.50/', 'Trader Workstation 10.50/Trader Workstation 10.50.app/', 'Trader Workstation 10.50/Trader Workstation 10.50 Uninstaller.app/',
  'Trader Workstation.app/', 'IB Gateway 10.30/', 'IB Gateway 10.30/IB Gateway 10.30.app/', '.hidden.app/', 'a.app/', 'b.APP/', 'file.app', 'x1.app/', 'sub/', 'sub/in.app/',
  'sub/deep/', 'sub/deep/z.app', 'f.app.txt', '中文.app/', 'Ab?c.app/'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tws-glob-'));
for (const n of tree) {
  if (n.endsWith('/')) fs.mkdirSync(path.join(root, n), { recursive: true });
  else fs.writeFileSync(path.join(root, n), 'x');
}
fs.symlinkSync(path.join(root, 'nope'), path.join(root, 'dangling.app'));
out.real_glob.tree = tree;
out.real_glob.links = [['dangling.app', 'nope']];
const globPats = ['*.app', '*', 'Trader Workstation *.app', 'Trader Workstation */Trader Workstation *.app', 'IB Gateway */IB Gateway *.app', '?.app', 'x[1].app', 'x[0-9].app',
  '[ab].app', '[!a].app', '[^a].app', '*/in.app', 'sub/*', 'sub/**', '**/*.app', '{a,file}.app', '{a,{x1,b}}.APP', 'nope/*', '*.APP', '.*', '.*.app', 'sub/../a.app', './a.app',
  'a.app/', 'sub//in.app', '中*.app', 'Ab\\?c.app', 'Ab?c.app', 'A*', 'trader workstation.app', '*/*/*', 'sub/deep/*.app', '[a-b].app', '*.ap?', '**'];
for (const p of globPats) {
  const r = run(() => fs.globSync(path.join(root, p)).map((m) => m.replace(root, '<ROOT>')).sort());
  out.real_glob.cases.push({ p, ...r });
}
fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- path.posix
const pathPool = ['', '/', '//', 'a', 'a/', '/a/b/', 'a//b', './a', '../a', 'a/../..', '/..', '/a/./b/../c', 'a/b/', '~/x', 'x/.', '/Applications/Trader Workstation */x.app', '..', '.', 'a/..'];
for (const a of pathPool) {
  out.posix.push({ a, normalize: path.posix.normalize(a), basename: path.posix.basename(a), dirname: path.posix.dirname(a),
    join: pathPool.map((b) => path.posix.join(a, b)) });
}

// ---------------------------------------------------------------- 配置(在换掉 fs 之前读)
const connNames = ['paper', 'live', '2', '10', 'a b', 'toString', 'gw', 'futu1'];
const portPool = [7497, 7496, 4001, 4002, 9999, 7497, 0, '-0', 'abc', 1e6, 65536, 4002.7, 11111, 2];
const acctPool = ['DU7654321', 'U1234567', 'U9999999', 'DU1', 'U12', 'DU0000001', 'F1234567', 'DU7654321'];
const settingsList = [];
const makeConfig = () => {
  const connections = {};
  for (const n of subset(connNames, 0.45)) connections[n] = { host: '127.0.0.1', port: pick(portPool), client_id: pick([11, 12, 0, '7', 'x', -3]), ...(rnd() < 0.15 ? { broker: 'futu' } : {}), ...(rnd() < 0.2 ? { readonly: true } : {}) };
  const names = Object.keys(connections);
  const accounts = [];
  const nAcct = names.length ? Math.floor(rnd() * 4) : 0;
  const aliases = ['模拟', '主账户', 'ira', 'B', 'c'];
  for (let k = 0; k < nAcct; k += 1) {
    accounts.push({ alias: aliases[k], account_id: pick(acctPool), is_paper: rnd() < 0.5, connection: pick(names), ...(k === 0 && rnd() < 0.5 ? { default: true } : {}) });
  }
  return { prompt_version: 'v1.8.0', connections, accounts };
};
const baseRaw = JSON.parse(fs.readFileSync.call(fs, join(engine, 'baseline/golden/config.json'), 'utf8')).base_config;
settingsList.push({ raw: baseRaw, s: C.fromDict(structuredClone(baseRaw)) });
while (settingsList.length < 60) {
  const raw = makeConfig();
  try { settingsList.push({ raw, s: C.fromDict(structuredClone(raw)) }); } catch { /* 配置本身不合法:不是这里要测的 */ }
}
out.settings = settingsList.map((x) => x.raw);

// ---------------------------------------------------------------- 假的外界
const HOME = '/Users/fakehome';
let vfs = [];       // 虚拟目录表(globSync 认得的,按这个次序回)
let missing = [];   // 在表里但 existsSync 说没有(断掉的链接)
let platform = 'darwin';
let calls = [];
let spawnTable = {};
const globRe = (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
const fakeGlob = (p) => {
  if (p.includes('[[')) throw new Error(`bad pattern ${p}`);
  const re = globRe(p);
  return vfs.filter((v) => re.test(v));
};
const rfs = require('node:fs'), ros = require('node:os'), rcp = require('node:child_process');
rfs.globSync = fakeGlob;
rfs.existsSync = (p) => vfs.includes(p) && !missing.includes(p);
ros.homedir = () => HOME;
ros.platform = () => platform;
rcp.spawnSync = (cmd, args, opts) => {
  // Node 在起进程之前就校验参数:有 undefined 当场抛,什么也没起
  if (args.some((a) => a === undefined)) throw new TypeError('The "args[1]" argument must be of type string. Received undefined');
  calls.push({ cmd, args: [...args], timeout: opts?.timeout ?? null });
  const key = JSON.stringify([cmd, ...args]);
  const r = spawnTable[key] ?? { status: 1, stdout: '', stderr: '' };
  return { ...r };
};
rcp.spawn = (target, args, opts) => { calls.push({ cmd: '<spawn>', args: [target, opts.cwd], timeout: null }); return { unref() {} }; };
// 保险:这个生成器里任何真的连接都当场抛(默认握手、默认探测都不该走到)
const rnet = require('node:net');
rnet.connect = rnet.createConnection = () => { throw new Error('生成器不许连网'); };
rnet.Socket.prototype.connect = function () { throw new Error('生成器不许连网'); };
syncBuiltinESMExports();
out.home = HOME;

const vfsPool = ['/Applications/Trader Workstation.app', '/Applications/Trader Workstation 10.50/Trader Workstation 10.50.app',
  '/Applications/Trader Workstation 10.50/Trader Workstation 10.50 Uninstaller.app', '/Applications/Trader Workstation 10.50/Trader Workstation 10.50 UNINSTALL.app',
  '/Applications/Trader Workstation 10.50/Trader Workstation 10.50 Unſnstall.app', '/Applications/Trader Workstation 10.19/Trader Workstation 10.19.app',
  '/Applications/IB Gateway.app', '/Applications/IB Gateway 10.30/IB Gateway 10.30.app', '/Applications/IB Gateway 10.30/IB Gateway 10.30 uninstaller.app',
  `${HOME}/Applications/Trader Workstation.app`, `${HOME}/Applications/IB Gateway 10.37/IB Gateway 10.37.app`, `${HOME}/Applications/Trader Workstation 10.40/Trader Workstation 10.40.app`,
  `${HOME}/Jts/tws.exe`, `${HOME}foo/x.app`, '/opt/a.app', '/opt/b.app', '/opt/c.app', '/opt/d.app', '/opt/e.app', '/opt/f.app', '/opt/g.app', '/opt/[[x.app', '/x/y/z.app',
  `${HOME}/uninstall/real.app`];
const randomVfs = () => {
  vfs = subset(vfsPool, 0.55).sort(() => rnd() - 0.5);
  missing = subset(vfs, 0.1);
};
const procNames = ['Trader Workstation', 'ibgateway', 'OpenD', 'x', ''];
const randomSpawnTable = () => {
  spawnTable = {};
  for (const p of procNames) {
    const r = rnd();
    spawnTable[JSON.stringify(['pgrep', '-f', p])] = r < 0.3 ? { status: 0, stdout: '123\n', stderr: '' } : r < 0.4 ? { status: 0, stdout: ' \n\t', stderr: '' }
      : r < 0.5 ? { status: null, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' };
  }
  for (const v of vfsPool) {
    const r = rnd();
    spawnTable[JSON.stringify(['open', '-a', v])] = r < 0.6 ? { status: 0, stdout: '', stderr: '' } : r < 0.75 ? { status: 1, stdout: '', stderr: '  LSOpenURLsWithRole() failed  \n' }
      : r < 0.9 ? { status: 1, stdout: '', stderr: '   ' } : { status: null, stdout: '', stderr: null };
  }
};
const snapshot = (withOpen = false) => ({ vfs: [...vfs], missing: [...missing], platform,
  spawnTable: Object.entries(spawnTable).filter(([k]) => !k.startsWith('["open"') || (withOpen && vfs.includes(JSON.parse(k)[2]))) });

// ---------------------------------------------------------------- expandGlob
const expandPats = ['~/Applications/*.app', '~/Applications/Trader Workstation */Trader Workstation *.app', '~', '~/', '~foo/*.app', '/opt/*.app', '/opt/[[x.app', '/opt/[[y.app',
  '/Applications/Trader Workstation */Trader Workstation *.app', '/Applications/IB Gateway */IB Gateway *.app', '/x/*/*', '/x/*/z.app', 'relative/*.app', '/opt/?.app', '~/Jts/*.exe'];
for (let i = 0; i < 300; i += 1) {
  randomVfs();
  const p = pick(expandPats);
  out.expand.push({ ...snapshot(), p, ...run(() => T.expandGlob(p)) });
}

// ---------------------------------------------------------------- detectApps
const candPats = ['/Applications/Trader Workstation.app', '/Applications/Trader Workstation */Trader Workstation *.app', '~/Applications/Trader Workstation.app',
  '~/Applications/Trader Workstation */Trader Workstation *.app', '/Applications/IB Gateway */IB Gateway *.app', '', '/opt/*.app', '/opt/[[x.app', '~/uninstall/*.app', '/x/*/*'];
for (let i = 0; i < 300; i += 1) {
  randomVfs();
  randomSpawnTable();
  platform = pick(['darwin', 'darwin', 'linux', 'win32', 'freebsd']);
  calls = [];
  const useDefault = rnd() < 0.35;
  let cands, pats;
  if (!useDefault) {
    cands = {};
    for (const k of subset(['tws', 'gateway', 'opend', '2', 'x y'], 0.6)) cands[k] = subset(candPats, 0.4);
    pats = {};
    for (const k of subset(['tws', 'gateway', 'opend', '2'], 0.7)) pats[k] = pick(procNames);
  }
  const r = run(() => (useDefault ? T.detectApps() : T.detectApps(cands, pats)));
  out.detect.push({ ...snapshot(), cands: useDefault ? null : cands, pats: useDefault ? null : pats, ...r, calls });
}

// ---------------------------------------------------------------- launchApp
for (let i = 0; i < 250; i += 1) {
  randomVfs();
  randomSpawnTable();
  platform = pick(['darwin', 'darwin', 'darwin', 'linux', 'win32']);
  calls = [];
  const key = pick(['tws', 'tws', 'gateway', 'gateway', 'evil.exe', '', 'toString', 'constructor', '__proto__', 'TWS', 'opend', 'hasOwnProperty']);
  const r = run(() => T.launchApp(key));
  out.launch.push({ ...snapshot(true), key, ...r, calls });
}
platform = 'darwin';

// ---------------------------------------------------------------- explainConnectError
class TimeoutError extends Error {}
class Weird extends Error { constructor(m) { super(m); this.name = ''; } }
const ctors = [Error, TypeError, TimeoutError, Weird, RangeError];
const messages = ['connect ECONNREFUSED 127.0.0.1:7497', 'Refused by peer', 'REFUSED', 'timeout', 'TIMEOUT', 'timed out', 'Handshake TimeOut', 'API error 326 happened', '15024', '1100 2110',
  '2110', 'error 504', '', 'boom', 'İTIMEOUT', 'ＲＥＦＵＳＥＤ', '502: Couldn\'t connect', '3260', 'x'.repeat(30)];
for (let i = 0; i < 700; i += 1) {
  const Ctor = pick(ctors);
  const e = new Ctor(pick(messages));
  const nameOver = pick([undefined, undefined, 'TimeoutError', '', 'AbortError', 'timeoutish', 'Error']);
  if (nameOver !== undefined) e.name = nameOver;
  const code = pick([undefined, undefined, 'ECONNREFUSED', 'ETIMEDOUT', '']);
  if (code !== undefined) e.code = code;
  const port = pick([7497, 7496, NaN, undefined, 0, -0, 1.5, 1e21]);
  const portOpen = rnd() < 0.5;
  out.explain.push({ name: e.name, ctor: e.constructor.name, message: e.message, code: code ?? '', port: enc(port), portOpen, ...run(() => T.explainConnectError(e, port, portOpen)) });
}

const managedPool = ['DU7654321', 'U1234567', 'U9999999', 'DU0000001', '', 'DU1111111', 'U12', 'AB', 'U9999999'];
for (let i = 0; i < 600; i += 1) {
  const si = Math.floor(rnd() * settingsList.length);
  const managed = subset(managedPool, 0.4).sort(() => rnd() - 0.5);
  const cn = pick([undefined, undefined, 'paper', 'live', '2', 'nope', 'toString', 'gw', '']);
  out.alias.push({ si, managed, cn: enc(cn), ...run(() => T.checkAliasMapping(settingsList[si].s, managed, cn)) });
}

// ---------------------------------------------------------------- scanPorts / scanEndpoints
const probeOf = (port) => {
  const open = Number.isFinite(port) && Math.trunc(port) % 3 === 0;
  return { open, latency_ms: open ? port % 7 : null, error: open ? null : `端口未监听:${port}` };
};
for (let i = 0; i < settingsList.length; i += 1) {
  const probes = [];
  const host = pick(['127.0.0.1', 'localhost', '::1']);
  const r = await runAsync(() => T.scanPorts(settingsList[i].s, host, async (h, p) => { probes.push([h, p]); return probeOf(p); }));
  out.scan.push({ si: i, host, ...r, probes: enc(probes) });
}
for (let i = 0; i < 150; i += 1) {
  const known = subset(T.KNOWN_ENDPOINTS, 0.7);
  const configured = {};
  for (let k = Math.floor(rnd() * 5); k > 0; k -= 1) configured[pick([7497, 4001, 9999, 1, 70000, NaN, 0, -0, 2.5, 1e21, 11111, 3])] = pick(['a', 'b', 'paper', '中']);
  const pairs = Object.entries(configured);
  const probes = [];
  const r = await runAsync(() => T.scanEndpoints(known, configured, '127.0.0.1', async (h, p) => { probes.push([h, p]); return probeOf(p); }));
  out.scan.push({ known: enc(known), configured: pairs, ...r, probes: enc(probes) });
}

// 八个以上的端口:V8 的排序 8 个起先数开头的一段有序(倒序的翻过来)。非整数的键按插入次序(整数键 JS 自己排在前面),
// 所以用小数端口摆出倒序、顺序、夹着 NaN 的各种开头
for (let i = 0; i < 160; i += 1) {
  const n = 8 + Math.floor(rnd() * 8);
  let ports = [];
  const base = 100 + Math.floor(rnd() * 5000);
  for (let k = 0; k < n; k += 1) ports.push(base + k * pick([0.5, 1.5, 2.5]) + 0.25);
  const mode = rnd();
  if (mode < 0.5) ports.reverse();
  else if (mode < 0.7) ports.sort(() => rnd() - 0.5);
  for (let k = Math.floor(rnd() * 3); k > 0; k -= 1) ports.splice(Math.floor(rnd() * (ports.length + 1)), 0, NaN);
  if (rnd() < 0.3) ports.splice(Math.floor(rnd() * ports.length), 0, pick([7497, 4001, 20, 1e21]));
  const configured = {};
  for (const p of ports) configured[p] = pick(['a', 'b', 'c']);
  const known = rnd() < 0.5 ? T.KNOWN_ENDPOINTS : subset(T.KNOWN_ENDPOINTS, 0.5);
  const probes = [];
  const r = await runAsync(() => T.scanEndpoints(known, configured, '127.0.0.1', async (h, p) => { probes.push([h, p]); return probeOf(p); }));
  out.scan.push({ known: enc(known), configured: Object.entries(configured), ...r, probes: enc(probes) });
}

// ---------------------------------------------------------------- diagnose
const errMaker = () => {
  const k = pick(['timeout', 'TimeoutError', '502', 'refused', 'code', 'type', 'empty', '326']);
  if (k === 'timeout') return { name: 'Error', message: 'timeout', code: '' };
  if (k === 'TimeoutError') return { name: 'TimeoutError', message: 'The operation was aborted due to timeout', code: '' };
  if (k === '502') return { name: 'Error', message: '502: connect ECONNREFUSED 127.0.0.1:7497', code: '' };
  if (k === 'refused') return { name: 'Error', message: 'socket refused', code: '' };
  if (k === 'code') return { name: 'Error', message: 'x', code: 'ECONNREFUSED' };
  if (k === 'type') return { name: 'TypeError', message: 'boom', code: '' };
  if (k === '326') return { name: 'Error', message: 'API 326', code: '' };
  return { name: 'Error', message: '', code: '' };
};
const makeErr = (spec) => {
  const e = spec.name === 'TypeError' ? new TypeError(spec.message) : new Error(spec.message);
  if (spec.name !== 'Error' && spec.name !== 'TypeError') e.name = spec.name;
  if (spec.code) e.code = spec.code;
  return e;
};
for (let i = 0; i < 700; i += 1) {
  const si = Math.floor(rnd() * settingsList.length);
  const s = settingsList[si].s;
  const names = [...Object.keys(s.connections), 'nope', 'toString', '__proto__', 'constructor', 'live', 'paper'];
  const name = pick(names);
  const probe = pick([{ open: true, latency_ms: 1, error: null }, { open: true, latency_ms: null, error: null }, { open: false, latency_ms: null, error: '端口未监听' },
    { open: false, latency_ms: null, error: null }, { open: false, latency_ms: null, error: '连接超时' }, { open: false, latency_ms: null, error: 'API 502' }]);
  // 不给 null:diagnose 里是 `options.handshake ?? 默认握手`,null 也会走真的默认握手(去连本机端口)
  const hsKind = pick(['ok', 'ok', 'ok', 'throw']);
  const info = { serverVersion: pick([176, 200, null]), serverTime: pick(['t', null, '20261019 10:00:00']), managedAccounts: subset(managedPool, 0.4) };
  const err = errMaker();
  const options = {};
  const clientId = pick([undefined, undefined, null, 5, NaN, 0]);
  if (clientId !== undefined) options.clientId = clientId;
  const timeoutMs = pick([undefined, 3000]);
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  const probes = [];
  const shakes = [];
  options.prober = async (h, p) => { probes.push([h, p]); return probe; };
  options.handshake = async (args) => { shakes.push({ ...args }); if (hsKind === 'throw') throw makeErr(err); return info; };
  const r = await runAsync(() => T.diagnose(s, name, options));
  out.diagnose.push({ si, name, probe, hsKind, info, err, clientId: enc(clientId), timeoutMs: enc(timeoutMs), ...r, probes: enc(probes), shakes: enc(shakes) });
}

// ---------------------------------------------------------------- 指引
for (let i = 0; i < settingsList.length; i += 1) out.guide.push({ si: i, out: T.connectionGuide(settingsList[i].s) });

writeFileSync(join(here, 'tws_detect.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
function writeFileSync(p, s) { require('node:fs').writeFileSync(p, s); }
