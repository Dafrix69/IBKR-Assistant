'use strict';
/**
 * 日志脱敏(主进程用)。落盘的日志、交给界面的引擎日志、导出的诊断包,都先过这一遍。
 *
 * 为什么在这一层做:引擎自己打的日志在调用处已经打了码(store.ts 的 redactAccount),但进日志的不只是它——
 * 券商回的错误原文、未捕获异常的调用栈、渲染层的控制台报错、引擎 stdout 上的非 JSON 行,都是原样写进去的。
 * 用户遇到问题会把日志发给别人,所以这里是最后一道:宁可多抹,不可漏。
 *
 * 抹什么:
 *  · 配置里写着的真实账号(逐个精确替换),以及长得像 IBKR 账号的串(U / DU / F / DF / I + 数字);
 *  · API Key 与令牌(sk-…、Bearer …、api_key=… 这类键值、Discord bot token 那样的三段式令牌);
 *  · 家目录路径里的用户名(/Users/张三 → ~);
 *  · 非 macOS 上引擎打到 stderr 的通知行(`[通知] …`):里面是成交与订单摘要,属于交易数据,
 *    "交易数据不进日志"——只留下标题。
 */
const os = require('node:os');

/** 留开头的字母与末三位:DU1234567 → DU***567,U1234567 → U***567,纯数字的富途账号 28190044 → ***044。
 * 引擎的 redactAccount 留的是前两个字符:DU 开头的两边一样,U1234567 在引擎那边是 U1***567、28190044 是 28***044。 */
function maskAccount(id) {
  const text = String(id || '');
  if (text.length <= 5) return '***';
  const head = /^[A-Za-z]+/.exec(text)?.[0] ?? '';
  return `${head}***${text.slice(-3)}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IBKR_ACCOUNT = /\b(DU|DF|U|F|I)(\d{2,6})(\d{3})\b/g;
const SECRET_PATTERNS = [
  // sk-…(Anthropic / OpenAI / DeepSeek 一类)
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // Discord 的 token:三段 base64url 用点连起来(第一段是 ID,后两段各二十多位)。JWT 也是这个样子,一并抹掉
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, '***.***.***'],
  // api_key=… / "apiKey": "…" / x-api-key: … / password=… / token=…
  [/\b(x-api-key|api[_-]?key|apikey|authorization|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)([^\s"',;&]{6,})/gi, '$1$2***'],
];

/**
 * @param {{ accounts?: string[], homedir?: string }} [opts] accounts:配置里的真实账号
 * @returns {(text: unknown) => string}
 */
function createRedactor(opts = {}) {
  const accounts = [...new Set((opts.accounts || []).map((a) => String(a || '').trim()).filter((a) => a.length >= 4))]
    // 长的先换:短账号可能是长账号的一段
    .sort((a, b) => b.length - a.length);
  const accountRules = accounts.map((a) => [new RegExp(escapeRegExp(a), 'g'), maskAccount(a)]);
  const home = String(opts.homedir ?? os.homedir() ?? '');
  const homeRule = home.length > 3 ? new RegExp(escapeRegExp(home), 'g') : null;

  return function redact(input) {
    let text = typeof input === 'string' ? input : String(input ?? '');
    if (!text) return text;
    // 通知行只留标题(标题是固定的那几个:成交回报 / 指令被拒绝 / 下单提醒…)
    text = text.replace(/(\[通知\]\s*[^|\n]*)\|[^\n]*/g, '$1| (内容不进日志)');
    for (const [pattern, to] of accountRules) text = text.replace(pattern, to);
    text = text.replace(IBKR_ACCOUNT, (_m, head, _mid, tail) => `${head}***${tail}`);
    for (const [pattern, to] of SECRET_PATTERNS) text = text.replace(pattern, to);
    if (homeRule) text = text.replace(homeRule, '~');
    return text;
  };
}

/** 从配置(settings.json 的内容)里取出真实账号。读不出来就是空的——那时还有按样子抹的那一道。 */
function accountsFromConfig(config) {
  const list = config && Array.isArray(config.accounts) ? config.accounts : [];
  return list.map((a) => (a && typeof a === 'object' ? String(a.account_id || '') : '')).filter(Boolean);
}

/**
 * 给界面与诊断包看的配置:真实账号打码,其余照旧。配置里本来就没有密钥(Key 在系统凭证库里)。
 */
function redactConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(config));
  if (Array.isArray(copy.accounts)) {
    for (const a of copy.accounts) {
      if (a && typeof a === 'object' && 'account_id' in a) a.account_id = maskAccount(a.account_id);
    }
  }
  const redact = createRedactor({ accounts: accountsFromConfig(config) });
  // 再整体过一遍:别处(备注、别名)里要是也出现了账号或 Key,一样抹掉
  return JSON.parse(redact(JSON.stringify(copy)));
}

module.exports = { createRedactor, accountsFromConfig, redactConfig, maskAccount };
