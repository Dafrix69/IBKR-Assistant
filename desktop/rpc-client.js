'use strict';
/**
 * 交易引擎 sidecar 的客户端(设计文档 §10.1)。
 *
 * 走 stdio 而不是 localhost 端口:没有监听端口就没有可被本机其他进程连上的
 * 攻击面。stdout 只跑 JSON-RPC,引擎的日志走 stderr,两条流不混。
 *
 * 引擎是 engine-ts 编译出的 dist(开发时 tools/ensure_engine_ts.js 保证它新鲜,
 * 打包版在 resources/engine-ts),用 Node 拉起。运行时选择:开发机优先系统 node
 * (node_modules 按系统 node 的 ABI 编译,better-sqlite3 是原生模块);没有系统 node、
 * 以及打包版,用 Electron 自带的 Node(ELECTRON_RUN_AS_NODE=1),原生模块由
 * electron-builder 按 Electron ABI 重编(见 package.json 注释)。机器上不需要装任何运行时。
 */
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const CALL_TIMEOUT_MS = 120000;

class EngineClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.configPath   配置文件路径
   * @param {string} opts.tsEngineRoot 引擎根(含 dist/src/cli.js 与 baseline/)
   * @param {string} [opts.userDataDir] 打包模式的可写目录(引擎子进程的 cwd 放这里)
   * @param {boolean} [opts.packaged]
   */
  constructor({ configPath, userDataDir, packaged, appVersion, tsEngineRoot }) {
    super();
    this.configPath = configPath;
    this.userDataDir = userDataDir || null;
    this.packaged = Boolean(packaged);
    this.appVersion = appVersion || '0';
    this.tsEngineRoot = tsEngineRoot || null;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.exitInfo = null;
  }

  /** 引擎的启动方式;dist 不在就直接报错,错误文案说清楚该做什么。 */
  #resolveEngine() {
    if (!this.tsEngineRoot) throw new Error('没有配置引擎目录(tsEngineRoot)');
    const entry = path.join(this.tsEngineRoot, 'dist', 'src', 'cli.js');
    if (!fs.existsSync(entry)) {
      throw new Error(
        `找不到引擎入口 ${entry}。开发时在 engine-ts 下执行 npm install && npm run build` +
          '(desktop 的 npm start 会自动做);打包版请重新安装。'
      );
    }
    const args = [entry, 'rpc', '--config', this.configPath];
    if (!this.packaged) {
      const probe = spawnSync('node', ['--version'], { timeout: 8000 });
      if (probe.status === 0) return { cmd: 'node', args, env: {}, label: 'node' };
    }
    return {
      cmd: process.execPath,
      args,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: 'electron-as-node',
    };
  }

  #log(line) {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 200) this.stderrTail.shift();
    this.emit('log', line);
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = this.#doStart().catch((err) => {
      this.starting = null;
      this.emit('exit', { code: -1, signal: null, detail: err.message });
      throw err;
    });
    return this.starting;
  }

  async #doStart() {
    if (this.child) return;
    const engine = this.#resolveEngine();
    this.#log(`[engine] 启动引擎(${engine.label}):${path.join(this.tsEngineRoot, 'dist')}`);
    this.child = spawn(engine.cmd, engine.args, {
      // 打包模式 cwd 必须挪出安装目录:Windows 上进程的 cwd 会锁目录,
      // 旧版引擎还活着时新版安装器就删不掉 resources——这正是
      // "旧版存在时新版装不上"的一个根因。引擎自身不依赖 cwd。
      cwd: this.packaged && this.userDataDir ? this.userDataDir : this.tsEngineRoot,
      env: { ...process.env, ...engine.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.#wireChild();
  }

  /** stdout(协议)/stderr(日志)/exit 的接线。 */
  #wireChild() {
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.#handleLine(line);
    });
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => this.#log(line));

    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      const detail = this.stderrTail.slice(-8).join('\n') || `退出码 ${code}`;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`交易引擎已退出:${detail}`));
      }
      this.pending.clear();
      this.child = null;
      this.starting = null;
      this.emit('exit', { code, signal, detail });
    });

    this.child.on('error', (err) => {
      this.child = null;
      this.starting = null;
      this.emit('exit', { code: -1, signal: null, detail: `无法启动引擎:${err.message}` });
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#log(`[非 JSON 输出] ${line}`);
      return;
    }
    if (message.method === 'event') {
      const { event, data } = message.params || {};
      this.emit('engine-event', { event, data });
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const err = new Error(message.error.message || '引擎返回错误');
      err.code = message.error.code;
      entry.reject(err);
    } else {
      entry.resolve(message.result);
    }
  }

  async call(method, params = {}) {
    await this.start();
    if (!this.child) throw new Error('交易引擎未运行');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${method} 超时(${CALL_TIMEOUT_MS / 1000}s)`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* 引擎可能已退出 */
    }
    this.child.kill('SIGTERM');
    this.child = null;
    this.starting = null;
  }
}

module.exports = { EngineClient };
