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
  'limits.loosen': '放宽风控限额',
  'gate.follow': '打开 Discord 自动跟单',
};

/** settings.patch 里从关变开要凭据的闸门。 */
const GATES = ['auto_execute', 'allow_live_trading'];

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

/**
 * Discord 跟单的凭据绑什么:信任谁、读哪个频道、发到哪些账户、三个上限——确认框上摆的就是这几样。
 * 形状固定、名单排好序:界面递来的和放行时由"现在的配置 + 补丁"算出来的,同一件事得出同一个指纹。
 */
function followBinding(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map(String))].sort() : []);
  return {
    channel_id: String(c.channel_id ?? ''),
    author_ids: list(c.author_ids),
    accounts: list(c.accounts),
    max_age_seconds: Number(c.max_age_seconds),
    max_orders_per_day: Number(c.max_orders_per_day),
    max_risk_usd: Number(c.max_risk_usd),
    local_inbox: c.local_inbox === true,
  };
}

/** 跟单的三个上限:调大是放松。 */
const FOLLOW_CAPS = ['max_age_seconds', 'max_orders_per_day', 'max_risk_usd'];

/**
 * 补丁落下去之后,跟单是不是比现在放得更开:从关到开、换了频道、多信任了一个人、发单的账户变了(收窄除外)、上限调大、
 * 多开了本地收件(多了一个消息来源)。
 * 往紧了改(少信任一个人、调小上限)与关掉都不用确认。现在的值读不出来时按"放开了"算:宁可多问一次。
 * @param {object} next  补丁落下去之后的 follow 段
 * @param {object} now   引擎此刻的 follow 段
 */
function followWidened(next, now) {
  if (!next || next.enabled !== true) return false;
  if (!now || now.enabled !== true) return true;
  const a = followBinding(next);
  const b = followBinding(now);
  if (a.channel_id !== b.channel_id) return true;
  if (a.local_inbox && !b.local_inbox) return true;
  if (a.author_ids.some((id) => !b.author_ids.includes(id))) return true;
  // 账户:空 = 默认账户,所以"变成空"不是收窄;只有两边都点了名、新的全在旧的里面才算收窄
  const sameAccounts = a.accounts.length === b.accounts.length && a.accounts.every((x) => b.accounts.includes(x));
  const narrowed = a.accounts.length > 0 && b.accounts.length > 0 && a.accounts.every((x) => b.accounts.includes(x));
  if (!sameAccounts && !narrowed) return true;
  return FOLLOW_CAPS.some((key) => !Number.isFinite(b[key]) || !Number.isFinite(a[key]) || a[key] > b[key]);
}

/**
 * 「打开 Discord 自动跟单」确认框上的正文。binding 是 confirm-grants 的 followBinding 整理过的那一份;
 * accounts 是引擎报的账户表(别名、是不是纸面、是不是默认)。没点名账户 = 发到默认账户。
 */
function followConfirmText(binding, accounts) {
  const byAlias = new Map((accounts || []).map((a) => [String(a.alias), a]));
  const kindOf = (alias) => {
    const acct = byAlias.get(alias);
    return acct ? (acct.is_paper ? '纸面' : '实盘') : '类别未知';
  };
  const fallback = (accounts || []).find((a) => a.default) || (accounts || [])[0];
  const targets = binding.accounts.length ? binding.accounts : fallback ? [String(fallback.alias)] : [];
  const live = targets.some((alias) => kindOf(alias) !== '纸面');
  const money = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
  const detail = [
    '打开之后,下面这些发送者发的蝴蝶单与贷方价差(bull put / bear call),软件不再问你,直接发到券商。',
    '',
    `频道 ID:${binding.channel_id || (binding.local_inbox ? '(没有填,不连 Discord;消息只来自本地收件)' : '(没有填)')}`,
    `本地收件:${binding.local_inbox ? '开着——脚本从你屏幕上的 Discord 窗口抄下来的消息也算;发送者按显示名认,频道里别人改昵称冒充得了' : '关着'}`,
    `信任的发送者 ID:${binding.author_ids.join('、') || '(一个都没有)'}`,
    `发到账户:${targets.map((alias) => `${alias}(${kindOf(alias)})`).join('、') || '(没有可用的账户)'}${binding.accounts.length ? '' : ' —— 默认账户'}`,
    `每单最坏亏损上限:$${money(binding.max_risk_usd)}${targets.length > 1 ? '(每个账户各发一份、各算各的)' : ''}`,
    '  蝴蝶按付出的权利金算;贷方价差按「宽度 − 收到的权利金」算,那是到期时价格穿过两个行权价的亏损。',
    `每天最多跟:${money(binding.max_orders_per_day)} 单`,
    `消息发出超过 ${money(binding.max_age_seconds)} 秒不跟`,
    '',
    '对方发错一条、或者对方的 Discord 账号被盗,都会直接变成你账户里的订单。上面这几个上限,加上「设置」里的限额与保护规则,是仅有的硬保护。',
    '随时可以在「接入 → Discord 跟单」关掉;关是当场生效的。',
  ].join('\n');
  return { live, detail };
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
  if (purpose === 'gate.follow') return followBinding(b);
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
    // Discord 跟单:补丁落下去之后的那一份(引擎也是这么合并的:这一段是平的,名单整个换)
    const followPatch = p.patch && typeof p.patch === 'object' && p.patch.follow && typeof p.patch.follow === 'object' ? p.patch.follow : null;
    if (followPatch) {
      const followNow = current && current.follow && typeof current.follow === 'object' ? current.follow : null;
      const followNext = { ...(followNow || {}), ...followPatch };
      if (followWidened(followNext, followNow)) needs.push({ purpose: 'gate.follow', binding: followBinding(followNext) });
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

module.exports = {
  PURPOSES, GATES, LIMIT_RULES, TTL_MS, GrantBook, requiredGrants, loosenedLimits, normalizeBinding, canonical, followBinding, followWidened, followConfirmText,
};
