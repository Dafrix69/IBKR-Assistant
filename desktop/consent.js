'use strict';
/**
 * 条款同意的记录(主进程用)。
 *
 * 这个软件会替人发真实订单。卖出去之前,用户得明确看过并同意三样东西:风险揭示、使用条款、隐私说明
 * (正文在 docs/legal/,界面首次启动时摆出来)。同意的是**某一版**条款:条款改了版本号跟着改,
 * 老用户下次启动要重新看一遍。
 *
 * 记在哪:userData/consent.json(和配置、日志在同一个目录)。只增不改——每同意一次追加一条,
 * 带上条款版本、时刻、当时的应用版本,之后有争议时翻得出来。
 *
 * 管什么:没同意当前这一版之前,主进程不放行任何会发单或授权发单的调用(见 main.js 的 rpc 通道),
 * 也不许打开自动执行、实盘下单、实盘自动平组合单这三个闸门(CONSENT_GATES)。只读的功能(解析、行情、复盘)界面自己挡在同意页后面;
 * 这里挡的是钱路径——界面被绕过也过不去。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 现行条款的版本号。docs/legal/ 三份文档开头写的是同一个(tests/desktop-consent.spec.ts 钉着)。 */
const TERMS_VERSION = '2026-10-08';

/** 没同意条款之前不放行的方法。 */
const CONSENT_REQUIRED_RPC = new Set([
  'instruction.submit',
  'tracker.add',
  'tracker.update',
  'tracker.close_now',
]);

/** 没同意条款之前不许从关变开的闸门(settings.patch 的 policies 里)。 */
const CONSENT_GATES = ['auto_execute', 'allow_live_trading'];

function consentPath(userDataDir) {
  return path.join(userDataDir, 'consent.json');
}

function readLog(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.accepted) ? raw.accepted.filter((e) => e && typeof e.version === 'string') : [];
  } catch {
    return []; // 没有、或读不出来:按没同意过处理(保守的那一侧)
  }
}

/** @returns {{ version: string, accepted: boolean, acceptedAt: string | null }} */
function consentState(userDataDir) {
  const hit = readLog(consentPath(userDataDir)).filter((e) => e.version === TERMS_VERSION).pop();
  return { version: TERMS_VERSION, accepted: Boolean(hit), acceptedAt: hit ? String(hit.at || '') : null };
}

/**
 * 记一次同意。version 必须是现行版本:界面上摆的要是旧文本(缓存、没重载),这一次同意不作数。
 */
function acceptConsent(userDataDir, version, { appVersion = '', now = Date.now() } = {}) {
  if (version !== TERMS_VERSION) {
    throw new Error(`条款版本对不上:界面上是 ${String(version)},现行的是 ${TERMS_VERSION}。请重启应用后重新阅读。`);
  }
  const file = consentPath(userDataDir);
  const accepted = readLog(file);
  accepted.push({ version, at: new Date(now).toISOString(), app_version: String(appVersion) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ accepted }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return consentState(userDataDir);
}

/**
 * 这一次调用在没同意条款时该不该挡。
 * @param {string} method
 * @param {object} params   已经摘掉 __confirmed 的入参
 * @returns {string | null} 要挡就给原因,不挡给 null
 */
function blockedWithoutConsent(method, params) {
  if (CONSENT_REQUIRED_RPC.has(method)) {
    // 只解析不发单(execute: false)不算:那是在看这个软件会怎么理解一句话
    if (method === 'instruction.submit' && !(params && params.execute === true)) return null;
    return '还没有同意《风险揭示与使用条款》,不能发单或授权自动发单。请在应用里阅读并同意后再试。';
  }
  if (method === 'settings.patch') {
    const policies = params && params.patch && typeof params.patch === 'object' ? params.patch.policies : null;
    if (policies && typeof policies === 'object' && CONSENT_GATES.some((g) => policies[g] === true)) {
      return '还没有同意《风险揭示与使用条款》,不能打开自动执行或实盘下单。请在应用里阅读并同意后再试。';
    }
    // 打开 Discord 跟单 = 授权软件不经确认发单
    const follow = params && params.patch && typeof params.patch === 'object' ? params.patch.follow : null;
    if (follow && typeof follow === 'object' && follow.enabled === true) {
      return '还没有同意《风险揭示与使用条款》,不能打开 Discord 自动跟单。请在应用里阅读并同意后再试。';
    }
  }
  return null;
}

module.exports = { TERMS_VERSION, CONSENT_REQUIRED_RPC, consentPath, consentState, acceptConsent, blockedWithoutConsent };
