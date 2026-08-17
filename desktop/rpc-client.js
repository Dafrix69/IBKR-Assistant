'use strict';
/**
 * Python 交易引擎 sidecar 的客户端(设计文档 §10.1)。
 *
 * 走 stdio 而不是 localhost 端口:没有监听端口就没有可被本机其他进程连上的
 * 攻击面。stdout 只跑 JSON-RPC,引擎的日志走 stderr,两条流不混。
 *
 * 打包模式下多一步:应用包里只带引擎源码(resources/engine),不带 Python 运行时。
 * 首次启动用系统 Python 在 userData 里建一个专属 venv 并装依赖(pydantic /
 * anthropic / ib_insync),之后每次直接复用。这是 §10.4「打包内嵌」的折中——
 * 真正内嵌整个 Python 要几百 MB,先用"首启引导"换体积。
 */
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const CALL_TIMEOUT_MS = 120000;
const ENGINE_DEPS = ['pydantic>=2.0', 'anthropic>=0.60', 'ib_insync>=0.9.86'];

class EngineClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.repoRoot   引擎代码根(开发=仓库根;打包=resources/engine)
   * @param {string} opts.configPath 配置文件路径
   * @param {string} [opts.userDataDir] 打包模式的可写目录(venv 建在这里)
   * @param {boolean} [opts.packaged]
   */
  constructor({ repoRoot, configPath, userDataDir, packaged, appVersion }) {
    super();
    this.repoRoot = repoRoot;
    this.configPath = configPath;
    this.userDataDir = userDataDir || null;
    this.packaged = Boolean(packaged);
    this.appVersion = appVersion || '0';
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.exitInfo = null;
  }

  #log(line) {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 200) this.stderrTail.shift();
    this.emit('log', line);
  }

  /** 跑一个命令,stdout/stderr 都转成引擎日志。 */
  #run(cmd, args, label) {
    return new Promise((resolve, reject) => {
      this.#log(`[bootstrap] ${label}`);
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      readline.createInterface({ input: child.stdout }).on('line', (l) => this.#log(`[bootstrap] ${l}`));
      readline.createInterface({ input: child.stderr }).on('line', (l) => this.#log(`[bootstrap] ${l}`));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${label} 失败(退出码 ${code})`))
      );
    });
  }

  #venvPython(venvDir) {
    return process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
  }

  /** 引擎依赖是否可用(pydantic + anthropic 是硬需求)。 */
  #depsOk(python) {
    const probe = spawnSync(python, ['-c', 'import pydantic, anthropic'], { timeout: 20000 });
    return probe.status === 0;
  }

  #systemPython() {
    // 从 Finder / 资源管理器启动的 GUI 应用只有极简 PATH(/usr/bin:/bin:…),
    // Homebrew 或 python.org 装的 Python 不在里面——所以除了裸名字,还要探测
    // 各安装方式的固定绝对路径。glob 展开 python.org 的多版本目录。
    const candidates = [];
    if (process.platform === 'win32') {
      candidates.push('python', 'py');
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        const msStore = path.join(localAppData, 'Programs', 'Python');
        for (const dir of this.#globDirs(msStore, /^Python3\d+$/)) {
          candidates.push(path.join(dir, 'python.exe'));
        }
      }
    } else {
      candidates.push(
        '/opt/homebrew/bin/python3',        // Apple Silicon Homebrew
        '/usr/local/bin/python3',           // Intel Homebrew / 手动安装
        ...this.#globDirs('/Library/Frameworks/Python.framework/Versions', /^3\.\d+$/)
          .map((dir) => path.join(dir, 'bin', 'python3')),  // python.org 安装器
        'python3',                          // PATH 里的(终端启动时可用)
        '/usr/bin/python3',                 // 系统 shim(未接受 Xcode 许可时会拒绝执行)
        // shim 背后的真实二进制:shim 被许可协议卡住时它通常仍可直接运行
        '/Library/Developer/CommandLineTools/usr/bin/python3',
        'python'
      );
    }
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
      const probe = spawnSync(
        candidate,
        ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'],
        { timeout: 15000 }
      );
      if (probe.status === 0) return candidate;
      if (probe.stderr && /xcodebuild -license/.test(String(probe.stderr))) {
        this.#log(`[bootstrap] ${candidate} 被 Xcode 许可协议卡住,跳过(可运行 sudo xcodebuild -license 解除)`);
      }
    }
    return null;
  }

  #globDirs(base, pattern) {
    try {
      return fs
        .readdirSync(base)
        .filter((name) => pattern.test(name))
        .sort()
        .reverse() // 新版本优先
        .map((name) => path.join(base, name));
    } catch {
      return [];
    }
  }

  /**
   * 决定用哪个 Python;打包模式下没有现成的就当场建 venv 装依赖。
   */
  async ensurePython() {
    if (process.env.DAFRI_PYTHON) return process.env.DAFRI_PYTHON;

    // 1. 开发模式:仓库自带的 venv
    for (const candidate of [
      path.join(this.repoRoot, '.venv', 'bin', 'python'),
      path.join(this.repoRoot, '.venv', 'Scripts', 'python.exe'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // 2. 打包模式:userData 里的专属 venv
    if (this.packaged && this.userDataDir) {
      const venvDir = path.join(this.userDataDir, 'engine-venv');
      const venvPython = this.#venvPython(venvDir);
      // 依赖标记:升级安装后依赖清单可能变了,旧 venv 缺包会让引擎在深处才报错。
      // 标记不匹配就重跑一次 pip(幂等,已装的秒过),装完再写标记。
      const marker = path.join(venvDir, '.deps.json');
      const wanted = JSON.stringify({ deps: ENGINE_DEPS });
      let markerOk = false;
      try { markerOk = fs.readFileSync(marker, 'utf8') === wanted; } catch { /* 无标记 */ }
      if (fs.existsSync(venvPython) && markerOk && this.#depsOk(venvPython)) return venvPython;
      if (fs.existsSync(venvPython) && !markerOk) {
        this.emit('bootstrap', { phase: 'deps', message: '检测到版本升级,正在核对引擎依赖…' });
        await this.#run(
          venvPython,
          ['-m', 'pip', 'install', '--disable-pip-version-check', ...ENGINE_DEPS],
          '升级依赖'
        );
        if (this.#depsOk(venvPython)) {
          fs.writeFileSync(marker, wanted);
          return venvPython;
        }
        // 旧 venv 坏了(例如指向已卸载的 Python)→ 推倒重建
        this.#log('[bootstrap] 旧 venv 不可用,重建');
        fs.rmSync(venvDir, { recursive: true, force: true });
      }

      const system = this.#systemPython();
      if (!system) {
        throw new Error(
          '找不到 Python 3.9+。交易引擎需要 Python:macOS 可执行 `xcode-select --install` ' +
            '或从 python.org 安装;Windows 从 python.org 安装并勾选 “Add to PATH”,然后重启本应用。'
        );
      }
      this.emit('bootstrap', { phase: 'venv', message: '首次启动:正在创建 Python 环境…' });
      if (!fs.existsSync(venvPython)) {
        await this.#run(system, ['-m', 'venv', venvDir], '创建 venv');
      }
      this.emit('bootstrap', { phase: 'deps', message: '正在安装引擎依赖(需要联网,约 1 分钟)…' });
      await this.#run(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', ...ENGINE_DEPS],
        '安装依赖'
      );
      if (!this.#depsOk(venvPython)) {
        throw new Error('依赖安装完成但导入失败,请查看引擎日志。');
      }
      fs.writeFileSync(path.join(venvDir, '.deps.json'), JSON.stringify({ deps: ENGINE_DEPS }));
      this.emit('bootstrap', { phase: 'done', message: 'Python 环境就绪。' });
      return venvPython;
    }

    // 3. 最后退路:系统 Python(开发者自己装好了依赖的情况)
    return process.platform === 'win32' ? 'python' : 'python3';
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
    const python = await this.ensurePython();
    const args = ['-m', 'ibkr_agent', '--config', this.configPath, 'rpc'];
    this.child = spawn(python, args, {
      // 打包模式 cwd 必须挪出安装目录:Windows 上进程的 cwd 会锁目录,
      // 旧版引擎还活着时新版安装器就删不掉 resources/engine——这正是
      // "旧版存在时新版装不上"的一个根因。引擎自身不依赖 cwd(PYTHONPATH 显式给了)。
      cwd: this.packaged && this.userDataDir ? this.userDataDir : this.repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(this.repoRoot, 'src'),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
      this.emit('exit', { code: -1, signal: null, detail: `无法启动 Python:${err.message}` });
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
