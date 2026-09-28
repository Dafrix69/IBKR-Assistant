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
// 关 stdin 之后等引擎自己退出的时间:引擎读到 EOF 会把在途请求答完再退(rpc/server.ts 的 serve)。
// 以前 stop() 一上来就 SIGTERM,正在发单的那一步可能被拦腰打断——单已经到了券商,回报还没落库
const DRAIN_MS = 3000;
// 超时之后还记着的调用(只记调用方要求记的,见 call 的 lateReply):引擎迟到的回执靠它认出来
const LATE_KEEP = 32;

class EngineClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.configPath   配置文件路径
   * @param {string} opts.tsEngineRoot 引擎根(含 dist/src/cli.js 与 baseline/)
   * @param {string} [opts.userDataDir] 打包模式的可写目录(引擎子进程的 cwd 放这里)
   * @param {boolean} [opts.packaged]
   */
  constructor({ configPath, userDataDir, packaged, appVersion, tsEngineRoot, drainMs }) {
    super();
    this.configPath = configPath;
    this.userDataDir = userDataDir || null;
    this.packaged = Boolean(packaged);
    this.appVersion = appVersion || '0';
    this.tsEngineRoot = tsEngineRoot || null;
    this.drainMs = Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : DRAIN_MS;
    // 这个时刻之前不拉起引擎(见 holdUntil):主进程的重启退避靠它才拦得住界面的轮询
    this.notBefore = 0;
    this.holdReason = null;
    // 超时了、但结果要紧的调用:id → { method, child, at }。引擎迟到的回执到了就发 late-reply
    this.timedOut = new Map();
    this.child = null;
    this.starting = null;
    // 正在退出的旧引擎:它真的退出之前不拉起新的(见 stop / #doStart)
    this.stopping = null;
    // 应用在退出:stop({ final: true }) 之后不再拉起任何引擎(退出途中界面最后一轮轮询不该再拉起一个)
    this.closed = false;
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

  /**
   * 在这个时刻之前不拉起引擎。引擎意外退出后主进程按退避重启(3 s → 6 s → … 60 s),
   * 但界面每秒都在轮询,每一次 call() 都会顺手 start()——退避等于没有,坏配置下引擎一秒崩一次。
   * 手动重启(restart)不受它管。
   * reason:不是"等一会儿就好"的那种停(配置坏了,要等用户处理)时给一句话,被挡下的调用原样报它。
   */
  holdUntil(epochMs, reason = null) {
    this.notBefore = Number.isFinite(epochMs) ? epochMs : 0;
    this.holdReason = reason ? String(reason) : null;
  }

  start({ force = false } = {}) {
    if (this.closed) return Promise.reject(new Error('应用正在退出,交易引擎已停止'));
    if (this.starting) return this.starting;
    if (!force && !this.child && Date.now() < this.notBefore) {
      if (this.holdReason) return Promise.reject(new Error(this.holdReason));
      const wait = Math.max(1, Math.ceil((this.notBefore - Date.now()) / 1000));
      return Promise.reject(new Error(`交易引擎已退出,${wait} 秒后自动重启`));
    }
    this.notBefore = 0;
    this.holdReason = null;
    this.starting = this.#doStart().catch((err) => {
      this.starting = null;
      this.emit('exit', { code: -1, signal: null, detail: err.message });
      throw err;
    });
    return this.starting;
  }

  async #doStart() {
    // 旧引擎还没退干净就拉新的,两个引擎会同时连 TWS(同一个 client id)、同时写库、同时跑盯盘节拍
    if (this.stopping) await this.stopping;
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
    this.#wireChild(this.child);
  }

  /**
   * stdout(协议)/stderr(日志)/exit 的接线。
   *
   * 每个处理函数都认准**自己那一个**子进程:重启时旧引擎的 exit 事件往往在新引擎已经拉起之后才到。
   * 以前这里直接 `this.child = null`、把在途调用全部拒掉——清掉的其实是新引擎的引用、拒掉的是发给新引擎的调用,
   * 新引擎于是成了没人管的孤儿:照样连着 TWS、照样跑盯盘节拍发平仓单,界面却看不见它,下一次轮询又拉起第三个。
   */
  #wireChild(child) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      this.#handleLine(line, child);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.#log(line));
    // 引擎已经退了还往它的 stdin 写(EPIPE):这是流上的 error 事件,没人接就是主进程的未捕获异常
    child.stdin.on('error', (err) => this.#log(`[engine] 写入引擎失败:${err.message}`));

    // exit 与 error 可能先后都来(比如拉起失败):只结算一次
    let settled = false;
    const settle = (code, signal, detail) => {
      if (settled) return;
      settled = true;
      // 只拒发给这个子进程的调用
      for (const [id, entry] of this.pending) {
        if (entry.child !== child) continue;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error(`交易引擎已退出:${detail}`));
      }
      // 它不会再回话了:超时后还等着它迟到回执的那几条也不用记了
      for (const [id, late] of this.timedOut) if (late.child === child) this.timedOut.delete(id);
      if (this.child !== child) {
        // 已经被 stop() 换下来的旧引擎:它退出是预期之内的,不动当前引擎的状态,也不通知界面
        this.#log(`[engine] 旧引擎进程已退出(${signal || `退出码 ${code}`})`);
        return;
      }
      this.exitInfo = { code, signal };
      this.child = null;
      this.starting = null;
      this.emit('exit', { code, signal, detail });
    };

    child.on('exit', (code, signal) => {
      settle(code, signal, this.stderrTail.slice(-8).join('\n') || `退出码 ${code}`);
    });

    child.on('error', (err) => {
      settle(-1, null, `无法启动引擎:${err.message}`);
    });
  }

  #handleLine(line, child) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#log(`[非 JSON 输出] ${line}`);
      return;
    }
    if (message.method === 'event') {
      // 正在退出的旧引擎发来的事件不转给界面:界面只认当前这一个引擎
      if (child !== this.child) return;
      const { event, data } = message.params || {};
      this.emit('engine-event', { event, data });
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      // 超时之后才到的回执。对发单类调用,这一条就是"那张单到底发没发出去"的答案,不能丢
      const late = this.timedOut.get(message.id);
      if (late && late.child === child) {
        this.timedOut.delete(message.id);
        this.emit('late-reply', {
          method: late.method,
          waitedMs: Date.now() - late.at,
          ok: !message.error,
          result: message.error ? null : message.result,
          error: message.error ? String(message.error.message || '引擎返回错误') : null,
        });
      }
      return;
    }
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

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, lateReply?: boolean }} [opts] 心跳这类探测用短超时,默认 120 秒;
   *   lateReply:超时之后引擎才回话时发 late-reply 事件(发单类调用用:超时不等于没发出去)
   */
  async call(method, params = {}, opts = {}) {
    await this.start();
    // start() 落地到这里之间正好有人 stop / restart:等新引擎起来再发,别报"未运行"
    if (!this.child && this.stopping && !this.closed) await this.start();
    const child = this.child;
    if (!child) throw new Error('交易引擎未运行');
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : CALL_TIMEOUT_MS;
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (opts.lateReply) {
          this.timedOut.set(id, { method, child, at: Date.now() - timeoutMs });
          // Map 按插入顺序:超出就丢最早的
          while (this.timedOut.size > LATE_KEEP) this.timedOut.delete(this.timedOut.keys().next().value);
        }
        const err = new Error(`调用 ${method} 超时(${timeoutMs / 1000}s)`);
        err.code = 'ENGINE_TIMEOUT';
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      child.stdin.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * 停掉当前引擎,三步:关 stdin(引擎答完在途请求自己退出)→ drainMs 内没退发 SIGTERM → 再过 killGraceMs 还没退就 SIGKILL。
   * 返回的 promise 在旧进程**真的退出**之后才落地;在它落地之前 start() 会等着——重启必须是"先死后生",
   * 不能两个引擎同时活着。
   * final:应用在退出,之后 start() / call() 一律拒绝,不再拉起。
   * drainMs = 0:不等,直接 SIGTERM(引擎已经不回话、被心跳判了死刑的时候用)。
   */
  stop({ killGraceMs = 5000, drainMs = this.drainMs, final = false } = {}) {
    if (final) this.closed = true;
    const child = this.child;
    if (!child) return this.stopping || Promise.resolve();
    this.child = null;
    this.starting = null;
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let soft = null;
      let hard = null;
      const terminate = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* 引擎可能已退出 */
        }
        hard = setTimeout(() => {
          this.#log('[engine] 旧引擎 SIGTERM 后仍未退出,强制结束');
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已经退了 */
          }
        }, killGraceMs);
      };
      const done = () => {
        clearTimeout(soft);
        clearTimeout(hard);
        resolve();
      };
      child.once('exit', done);
      child.once('error', done);
      if (drainMs > 0) soft = setTimeout(terminate, drainMs);
      else terminate();
    });
    try {
      child.stdin.end();
    } catch {
      /* 引擎可能已退出 */
    }
    const stopping = exited.finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  /** 先等旧引擎退干净,再拉起新的。opts 原样交给 stop(心跳判死的引擎用 { drainMs: 0 })。 */
  async restart(opts = {}) {
    await this.stop(opts);
    return this.start({ force: true });
  }
}

module.exports = { EngineClient };
