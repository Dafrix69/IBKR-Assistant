'use strict';
/**
 * 诊断包(主进程用):用户遇到问题时,一键导出一份能直接发给支持的文本。
 *
 * 以前的办法是"去「关于」页抄日志路径,把 main.log 发过来":日志里没有版本、没有配置、没有引擎状态,
 * 来回要问好几轮;日志本身也没脱敏。现在这一份里是:版本与系统、引擎此刻的状态、脱敏后的配置、
 * 备份清单、最近的日志——全部过了 redact.js。
 *
 * 不放什么:交易记录、成交、持仓、想法原文、API Key、真实账号。这份文件是要发给别人的。
 *
 * 这里只管把材料拼成文本(纯函数,好测);材料由 main.js 去取。
 */
const fs = require('node:fs');
const { createRedactor, accountsFromConfig, redactConfig } = require('./redact');

/** 日志只带最后这么多行:够看现场,文件又不至于大到发不出去。 */
const LOG_TAIL_LINES = 1500;
const OLD_LOG_TAIL_LINES = 300;
const MAX_LINE_CHARS = 2000;

/** 读一个文本文件的最后 n 行。文件不在、读不了:返回说明那一句,不抛。 */
function tailFile(file, maxLines) {
  try {
    const stat = fs.statSync(file);
    // 日志单份最多 4 MB(main.js 里设的),整个读进来再切没有问题
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { ok: true, bytes: stat.size, total: lines.length, lines: lines.slice(-maxLines) };
  } catch (err) {
    return { ok: false, bytes: 0, total: 0, lines: [], error: err && err.code === 'ENOENT' ? '文件不存在' : String(err && err.message ? err.message : err) };
  }
}

function readConfig(configPath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err && err.code === 'ENOENT' ? '文件不存在' : `读不出来:${String(err && err.message ? err.message : err)}` };
  }
}

function section(title, body) {
  return `\n===== ${title} =====\n${body}\n`;
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function defaultFileName(now = Date.now()) {
  return `IBKR-Assistant-诊断-${stamp(now)}.txt`;
}

/**
 * 把材料拼成一份文本。
 *
 * @param {object} input
 * @param {object} input.app        版本与系统信息
 * @param {string} input.configPath 配置文件路径
 * @param {string} input.logPath    当前日志文件
 * @param {string} [input.oldLogPath] 滚动下来的上一份日志
 * @param {object} [input.engine]   { running, restarts, status, selftest, backups, errors: string[] }
 * @param {object} [input.extra]    其它想带上的小块(同意条款的状态、上次检查更新的结果…)
 * @param {number} [input.now]
 * @returns {string}
 */
function buildReport(input) {
  const now = input.now ?? Date.now();
  const config = readConfig(input.configPath);
  const redact = createRedactor({ accounts: config.ok ? accountsFromConfig(config.value) : [], homedir: input.homedir });
  const clip = (line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …(截断)` : line);

  const parts = [];
  parts.push('IBKR-Assistant 诊断信息');
  parts.push(`生成时间:${new Date(now).toISOString()}`);
  parts.push('这份文件不含交易记录、成交、持仓、API Key;真实账号已打码。发出去之前仍建议自己看一遍。');

  parts.push(section('应用与系统', pretty(input.app || {})));

  const engine = input.engine || {};
  parts.push(section('交易引擎', pretty({
    running: Boolean(engine.running),
    restarts: engine.restarts ?? 0,
    errors: engine.errors || [],
  })));
  if (engine.status) parts.push(section('引擎状态(system.status)', pretty(engine.status)));
  if (engine.selftest) parts.push(section('引擎自检(system.selftest)', pretty(slimSelftest(engine.selftest))));
  if (engine.backups) parts.push(section('交易库与备份(data.backups)', pretty(engine.backups)));

  parts.push(section(
    '配置(已脱敏)',
    config.ok ? pretty(redactConfig(config.value)) : `配置文件 ${input.configPath} ${config.error}`,
  ));

  if (input.extra && Object.keys(input.extra).length) parts.push(section('其它', pretty(input.extra)));

  const log = tailFile(input.logPath, LOG_TAIL_LINES);
  parts.push(section(
    `日志 ${input.logPath}(共 ${log.total} 行,取最后 ${log.lines.length} 行)`,
    log.ok ? log.lines.map(clip).join('\n') : `读不出来:${log.error}`,
  ));
  if (input.oldLogPath) {
    const old = tailFile(input.oldLogPath, OLD_LOG_TAIL_LINES);
    if (old.ok) {
      parts.push(section(`上一份日志 ${input.oldLogPath}(取最后 ${old.lines.length} 行)`, old.lines.map(clip).join('\n')));
    }
  }
  // 整份再过一遍脱敏:状态、配置、日志里任何一处漏出来的账号 / Key / 家目录用户名,都在这里抹掉
  return redact(parts.join('\n'));
}

/** 自检里的别名表可能很长,而且是用户自己的词表:只报条数。 */
function slimSelftest(selftest) {
  if (!selftest || typeof selftest !== 'object') return selftest;
  const { symbol_aliases: aliases, ...rest } = selftest;
  return { ...rest, symbol_alias_count: aliases && typeof aliases === 'object' ? Object.keys(aliases).length : 0 };
}

/** 「复制诊断信息」用的那几行:不带日志,贴进聊天窗口不刷屏。 */
function buildSummary(input) {
  const app = input.app || {};
  const engine = input.engine || {};
  const status = engine.status || {};
  const lines = [
    `IBKR-Assistant ${app.version || '?'}(${app.platform || '?'} ${app.arch || ''},系统 ${app.os || '?'})`,
    `Electron ${app.electron || '?'} · Node ${app.node || '?'}`,
    `引擎:${engine.running ? '运行中' : '未运行'}${engine.restarts ? `,本次启动后自动重启过 ${engine.restarts} 次` : ''}`,
  ];
  if (engine.status) {
    lines.push(
      `券商:${status.broker_provider || '?'} ${status.broker_connected ? '已连接' : '未连接'}` +
        `${status.broker_upstream_ok === false ? '(上游中断)' : ''} · 市场 ${status.market_status || '?'} · 美东 ${status.now_et || '?'}`,
      `自动执行 ${status.auto_execute ? '开' : '关'} · 实盘 ${status.allow_live_trading ? '开' : '关'} · ` +
        `熔断 ${status.breaker && status.breaker.engaged ? `已合上(${status.breaker.reason || ''})` : '未合上'}`,
      `模型 ${status.model || '?'} · 提示词 ${status.prompt_version || '?'}`,
    );
  }
  for (const err of engine.errors || []) lines.push(`引擎报错:${err}`);
  const redact = createRedactor({ homedir: input.homedir });
  return redact(lines.join('\n'));
}

module.exports = { buildReport, buildSummary, defaultFileName, tailFile, LOG_TAIL_LINES };
