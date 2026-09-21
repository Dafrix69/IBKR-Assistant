// 暂存/打包后的 TS 引擎能不能起来:用指定的 Node(默认 Electron 自带的,和打包版一致)拉起
// cli.js rpc,发一条 system.status,拿到应答就算通过。所有原生模块与依赖的 import 都在这一步暴露。
//
//   node tools/smoke_engine_ts.js [engineRoot=build/engine-ts] [--runner electron|node|<可执行文件路径>]
//
// --runner 给一个可执行文件路径(打包出来的应用本体,如 "IBKR-Assistant.app/Contents/MacOS/IBKR-Assistant"),
// 就用它 + ELECTRON_RUN_AS_NODE 拉引擎——验的是装进安装包的那一份 Electron 与引擎,而不是 node_modules 里的。
// 提示词目录默认取仓库的 prompts/;验安装包时用环境变量 DAFRI_PROMPT_DIR 指到包里那份。
//
// 配置用 config/settings.example.json 的副本,db 指到临时目录——不碰任何真实账号与数据。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const args = process.argv.slice(2);
const flagIdx = args.indexOf('--runner');
const runner = flagIdx >= 0 ? args[flagIdx + 1] : 'electron';
// 不带 --runner 时 flagIdx = -1:不能拿 flagIdx + 1(= 0)去排除,那会把第一个位置参数(引擎目录)吞掉
const runnerValueIdx = flagIdx >= 0 ? flagIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== runnerValueIdx);

const DESKTOP = path.resolve(__dirname, '..');
const engineRoot = path.resolve(positional[0] || path.join(DESKTOP, 'build', 'engine-ts'));
const entry = path.join(engineRoot, 'dist', 'src', 'cli.js');
if (!fs.existsSync(entry)) {
  console.error('找不到引擎入口:', entry);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dafri-smoke-'));
const example = JSON.parse(fs.readFileSync(path.join(DESKTOP, '..', 'config', 'settings.example.json'), 'utf8'));
example.storage = Object.assign({}, example.storage, { db_path: path.join(tmp, 'trades.db') });
const cfg = path.join(tmp, 'settings.json');
fs.writeFileSync(cfg, JSON.stringify(example, null, 2));

let cmd; let env = Object.assign({}, process.env, {
  DAFRI_PROMPT_DIR: process.env.DAFRI_PROMPT_DIR || path.join(DESKTOP, '..', 'prompts'),
});
if (runner === 'node') {
  cmd = 'node';
} else if (runner === 'electron') {
  // 和打包版同一条路:Electron 二进制 + ELECTRON_RUN_AS_NODE
  cmd = require('electron');
  env.ELECTRON_RUN_AS_NODE = '1';
} else {
  // 打包出来的应用本体:同样是 Electron,只是换成安装包里那一份
  if (!fs.existsSync(runner)) {
    console.error('找不到 --runner 指定的可执行文件:', runner);
    process.exit(1);
  }
  cmd = runner;
  env.ELECTRON_RUN_AS_NODE = '1';
}
// 把系统 PATH 里的 node 藏起来,证明引擎不依赖机器上装的 Node
if (runner !== 'node') env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin';

const t0 = Date.now();
const child = spawn(cmd, [entry, 'rpc', '--config', cfg], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const stderr = [];
readline.createInterface({ input: child.stderr }).on('line', (l) => stderr.push(l));
const timer = setTimeout(() => finish(1, '20 秒内没有应答'), 20000);

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const isReady = msg.method === 'ready' || (msg.method === 'event' && msg.params && msg.params.event === 'ready');
  if (isReady) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.status', params: {} }) + '\n');
  } else if (msg.id === 1) {
    if (msg.error) return finish(1, 'system.status 报错:' + JSON.stringify(msg.error));
    const r = msg.result || {};
    finish(0, `system.status 应答正常(${Date.now() - t0} ms,runner=${runner},engine=${r.engine || r.version || 'ok'})`);
  }
});
child.on('exit', (code) => { if (timer) finish(1, `引擎提前退出,退出码 ${code}`); });

function finish(code, why) {
  clearTimeout(timer);
  console.log((code === 0 ? 'PASS ' : 'FAIL ') + why);
  if (code !== 0 && stderr.length) console.log(stderr.slice(-15).join('\n'));
  try { child.kill(); } catch { /* 已退出 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(code);
}
