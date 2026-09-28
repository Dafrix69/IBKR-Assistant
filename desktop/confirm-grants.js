'use strict';
/**
 * 确认凭据(主进程用):把"弹过确认框、用户点了确认"和"放行这一次调用"真的绑在一起。
 *
 * 以前的样子(2026-08 的审计就指出过,C2):preload 给每个敏感调用无条件带上 `__confirmed: true`,
 * 主进程只看这个标记。确认框是界面自觉去弹的——界面里只要跑进一段别人的脚本(某个依赖被投毒),
 * 它直接调 `window.dafri.submit(...)` 就能发单,一个对话框都不会出现。
 *
 * 现在:会发单 / 授权发单 / 打开闸门的调用,主进程要一张**一次性凭据**才放行。凭据只有一个来源:
 * 主进程自己弹的原生对话框,用户点了确认那个按钮。对话框上最显眼的那一行(这是在确认什么)由主进程按用途写,
 * 界面改不了;凭据绑着用途和这一次调用的内容(指令原文、账户、追踪的参数……),内容对不上不放行;
 * 用一次作废,一分钟过期。
 *
 * 这里是纯逻辑(好测):哪些调用要凭据、凭据怎么发、怎么核销。弹框与放行在 main.js。
 */
const crypto = require('node:crypto');

const TTL_MS = 60_000;

/** 用途 → 对话框上由主进程写的那一行。界面只能从这张表里选用途,不能自己起名字。 */
const PURPOSES = {
  'instruction.submit': '发送真实订单',
  'tracker.close_now': '立即平仓',
  'tracker.add': '授权软件自动平仓',
  'broker.select': '切换下单的券商',
  'gate.auto_execute': '打开自动执行',
  'gate.allow_live_trading': '允许实盘账户下单',
  'gate.allow_combo_live': '允许实盘账户自动平组合单',
  'limits.loosen': '放宽风控限额',
};

/** settings.patch 里从关变开要凭据的闸门。 */
const GATES = ['auto_execute', 'allow_live_trading', 'allow_combo_live'];

/**
 * 风控限额里"往松了改"要确认的那几项。up = 调大是放松,down = 调小是放松。
 * 往紧了改不用确认:那是在收风险。
 */
const LIMIT_RULES = {
  max_order_notional: { label: '单笔名义金额上限(USD)', loosen: 'up' },
  max_option_contracts: { label: '期权 / 价差单笔上限(张)', loosen: 'up' },
  max_mkt_shares: { label: '市价单股数上限', loosen: 'up' },
  max_spread_slippage: { label: 'AUTO_MID 滑点上限(美元 / 张)', loosen: 'up' },
  max_orders_per_input: { label: '一条指令最多几笔订单', loosen: 'up' },
  min_confidence: { label: '最低置信度', loosen: 'down' },
  duplicate_window_minutes: { label: '重复防抖窗口(分钟)', loosen: 'down' },
};

/**
 * 补丁里哪些限额比现在松。
 * @returns {{ key: string, label: string, from: number, to: number }[]} 按键名排好序
 */
function loosenedLimits(patchLimits, currentLimits) {
  const next = patchLimits && typeof patchLimits === 'object' ? patchLimits : {};
  const now = currentLimits && typeof currentLimits === 'object' ? currentLimits : {};
  const out = [];
  for (const key of Object.keys(LIMIT_RULES).sort()) {
    if (!(key in next)) continue;
    const to = Number(next[key]);
    const from = Number(now[key]);
    if (!Number.isFinite(to)) continue; // 不是数:引擎的校验会拒,轮不到这里
    // 现在的值读不出来时按"放松了"算:宁可多问一次
    const loosened = !Number.isFinite(from) || (LIMIT_RULES[key].loosen === 'up' ? to > from : to < from);
    if (loosened) out.push({ key, label: LIMIT_RULES[key].label, from, to });
  }
  return out;
}

/** 键排好序的 JSON:同一份内容不管键的先后,指纹一样。undefined 的键当作没有。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(purpose, binding) {
  return crypto.createHash('sha256').update(`${purpose}\n${canonical(binding ?? {})}`).digest('hex');
}

/**
 * 把"绑的是什么"整理成固定的形状:确认框那一头(界面递过来的)和放行那一头(调用的入参)各整理一遍,
 * 同一件事才会得出同一个指纹。
 */
function normalizeBinding(purpose, binding) {
  const b = binding && typeof binding === 'object' ? binding : {};
  if (purpose === 'instruction.submit') {
    return { text: String(b.text ?? ''), accounts: (Array.isArray(b.accounts) ? b.accounts : []).map(String) };
  }
  if (purpose === 'tracker.close_now') return { id: String(b.id ?? '') };
  if (purpose === 'broker.select') return { provider: String(b.provider ?? '') };
  if (purpose.startsWith('gate.')) return {};
  if (purpose === 'limits.loosen') {
    const limits = {};
    const given = b.limits && typeof b.limits === 'object' ? b.limits : {};
    for (const key of Object.keys(given).sort()) limits[key] = Number(given[key]);
    return { limits };
  }
  return b;
}

/**
 * 这一次调用要哪些凭据。
 * @param {string} method
 * @param {object} params  已经摘掉 __confirmed 的入参
 * @param {{ policies?: object } | null} current  引擎此刻的设置(settings.get),只有 settings.patch 用得到
 * @returns {{ purpose: string, binding: object }[]}
 */
function requiredGrants(method, params, current = null) {
  const p = params && typeof params === 'object' ? params : {};
  if (method === 'instruction.submit') {
    if (p.execute !== true) return []; // 只解析不发单
    return [{ purpose: 'instruction.submit', binding: normalizeBinding('instruction.submit', p) }];
  }
  if (method === 'tracker.close_now') {
    return [{ purpose: 'tracker.close_now', binding: normalizeBinding('tracker.close_now', p) }];
  }
  if (method === 'tracker.add') {
    // 只设提醒价位、不授权发单的追踪不用确认(界面上也没有那个确认框)
    if (!p.auto_close && !p.host_at_broker) return [];
    return [{ purpose: 'tracker.add', binding: p }];
  }
  if (method === 'broker.select') {
    return [{ purpose: 'broker.select', binding: normalizeBinding('broker.select', p) }];
  }
  if (method === 'settings.patch') {
    const next = p.patch && typeof p.patch === 'object' && p.patch.policies && typeof p.patch.policies === 'object' ? p.patch.policies : {};
    const now = current && current.policies && typeof current.policies === 'object' ? current.policies : {};
    const needs = GATES
      .filter((gate) => next[gate] === true && now[gate] !== true)
      .map((gate) => ({ purpose: `gate.${gate}`, binding: {} }));
    const loosened = loosenedLimits(p.patch && p.patch.limits, current && current.limits);
    if (loosened.length) {
      needs.push({ purpose: 'limits.loosen', binding: { limits: Object.fromEntries(loosened.map((l) => [l.key, l.to])) } });
    }
    return needs;
  }
  return [];
}

class GrantBook {
  constructor({ ttlMs = TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    /** 指纹 → 过期时刻 */
    this.grants = new Map();
  }

  #sweep(now) {
    for (const [key, expiresAt] of this.grants) if (expiresAt <= now) this.grants.delete(key);
  }

  /** 用户在原生对话框里点了确认:发一张凭据。 */
  issue(purpose, binding, now = Date.now()) {
    if (!Object.hasOwn(PURPOSES, purpose)) throw new Error(`未知的确认用途:${String(purpose)}`);
    this.#sweep(now);
    this.grants.set(digest(purpose, normalizeBinding(purpose, binding)), now + this.ttlMs);
  }

  /** 核销一张:有、没过期、内容对得上才是 true;用过就没了。 */
  consume(purpose, binding, now = Date.now()) {
    this.#sweep(now);
    return this.grants.delete(digest(purpose, normalizeBinding(purpose, binding)));
  }

  /**
   * 一次调用要的凭据要么全有、要么一张都不动(差一张就整个拒,不白白烧掉已有的)。
   * @returns {string[]} 缺的那些用途的中文名;空 = 放行(凭据已核销)
   */
  consumeAll(needs, now = Date.now()) {
    this.#sweep(now);
    const missing = needs.filter((n) => !this.grants.has(digest(n.purpose, n.binding)));
    if (missing.length) return missing.map((n) => PURPOSES[n.purpose] || n.purpose);
    for (const n of needs) this.grants.delete(digest(n.purpose, n.binding));
    return [];
  }
}

module.exports = { PURPOSES, GATES, LIMIT_RULES, TTL_MS, GrantBook, requiredGrants, loosenedLimits, normalizeBinding, canonical };
