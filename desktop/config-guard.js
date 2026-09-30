'use strict';
/**
 * 配置文件的体检与恢复(主进程用)。
 *
 * 账户与连接只能手改 settings.json,所以"手改时少了一个逗号"是迟早会发生的事;磁盘写满、写到一半断电也一样。
 * 以前的结局是:引擎读不进配置 → 退出 → 主进程按"引擎崩了"自动重启 → 再退出,无限循环,
 * 持仓追踪没人盯,界面上只有一段调用栈。现在引擎用专门的退出码(EXIT_CONFIG)说"是配置的问题",
 * 主进程停下重启、把话说清楚,并给一条回到上一份可用配置的路。
 *
 * 备份从哪来:引擎每次从界面改配置之前,把**改之前**那一份存成 settings.json.bak(engine-ts/src/config.ts)。
 *
 * 恢复的口径:
 *  · 只在用户点了「恢复」之后做,从不自动做——自动恢复可能把他刚关掉的开关悄悄打开。
 *  · 恢复出来的配置里,三个执行闸门(自动执行 / 实盘下单 / 实盘组合单)一律是关的:备份比现状旧,
 *    宁可让人再去打开一次,也不替他保留一个"也许已经不想要了"的授权。
 *  · 坏的那一份不删,改名留在旁边(.broken-时间戳):里面可能有他刚手改进去的账户。
 *
 * 这里只认得出 JSON 语法;字段对不对(校验)是引擎的事,恢复之后由引擎启动时再验。
 */
const fs = require('node:fs');

/** 与 engine-ts/src/config.ts 的 EXIT_CONFIG 是同一个数(tests/desktop-config-guard.spec.ts 钉着)。 */
const EXIT_CONFIG = 78;

/** 恢复时一律关上的执行闸门(policies 里的键)。 */
const GATES = ['auto_execute', 'allow_live_trading'];

const GATE_LABEL = {
  auto_execute: '允许自动执行',
  allow_live_trading: '允许实盘账户下单',
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function backupPath(configPath) {
  return `${configPath}.bak`;
}

/** 读一份 JSON。不存在、读不了、语法不对,各有各的说法;从不抛。 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { exists: err && err.code !== 'ENOENT', ok: false, text: null, value: null, error: err && err.code === 'ENOENT' ? '文件不存在' : String(err.message || err) };
  }
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) return { exists: true, ok: false, text, value: null, error: '最外层不是一个 { } 对象' };
    return { exists: true, ok: true, text, value, error: null };
  } catch (err) {
    return { exists: true, ok: false, text, value: null, error: String(err.message || err) };
  }
}

/** 配置与备份各是什么状态。 */
function inspectConfig(configPath) {
  const current = readJson(configPath);
  const backup = readJson(backupPath(configPath));
  let backupAt = null;
  try {
    backupAt = fs.statSync(backupPath(configPath)).mtimeMs;
  } catch {
    /* 没有备份 */
  }
  return {
    exists: current.exists,
    syntaxOk: current.ok,
    syntaxError: current.ok ? null : current.error,
    backup: {
      usable: backup.ok,
      at: backupAt,
      // 备份和现在这份一模一样:恢复它解决不了任何问题,不该把这个按钮摆出来
      sameAsCurrent: backup.ok && current.text !== null && backup.text === current.text,
    },
  };
}

/**
 * 从引擎 stderr 的尾巴里找出那一行 `[fatal:config:<kind>] <话>`。
 * @returns {{ kind: string, message: string } | null}
 */
function fatalLine(detail) {
  const lines = String(detail || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const m = /\[fatal:config:(missing|syntax|invalid)\]\s*(.*)$/.exec(line);
    if (m) return { kind: m[1], message: m[2].trim() };
  }
  return null;
}

function stamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.writeFileSync(target, text, 'utf8');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(target)) throw err;
  }
}

/**
 * 用备份换回配置。坏的那份改名留着,三个执行闸门关上。
 * @returns {{ brokenCopy: string | null, closedGates: string[] }} closedGates 是被这一步关掉的闸门的中文名
 */
function restoreBackup(configPath, { now = Date.now() } = {}) {
  const backup = readJson(backupPath(configPath));
  if (!backup.ok) throw new Error(`没有可用的备份:${backup.error}`);
  let brokenCopy = null;
  if (fs.existsSync(configPath)) {
    brokenCopy = `${configPath}.broken-${stamp(now)}`;
    fs.copyFileSync(configPath, brokenCopy);
  }
  const value = backup.value;
  const closedGates = [];
  if (isObject(value.policies)) {
    for (const gate of GATES) {
      if (value.policies[gate] !== true) continue;
      value.policies[gate] = false;
      closedGates.push(GATE_LABEL[gate]);
    }
  }
  writeAtomic(configPath, JSON.stringify(value, null, 2));
  return { brokenCopy, closedGates };
}

module.exports = { EXIT_CONFIG, GATES, backupPath, inspectConfig, fatalLine, restoreBackup };
