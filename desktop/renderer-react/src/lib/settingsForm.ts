/**
 * 「设置」页表单的纯逻辑:设置 ↔ 表单、保存前的检查、拼补丁。不 import 任何运行时的东西(只有类型),
 * 引擎那边的测试直接跑它(tests/desktop-settings-form.spec.ts)。
 *
 * 为什么单拎出来:这一页出过的错都不是"画错了",是"存错了"——
 *  · 输入框清空是 null,`Number(null)` 是 0:开着「日内亏损上限」、金额那一格空着点保存,
 *    引擎收到的是"开着、上限 0",而它对 0 的处理是**跳过这条规则**。界面上开关亮着,保护其实没有。
 *  · 重复防抖窗口同理:清空 = 0 = 关掉重复单防抖。
 * 所以:开着的规则必须填了正数才让存;没开的规则那几格空着,就照原值送回去,不送 0。
 */
import type { AccountLimits, Settings, SettingsPatch, SettingsProtections } from '../bridge';

/** 一个账户能单独覆盖的那几项限额(表单里的样子);空着 = 用全局的 */
export interface AccountLimitFields {
  notional: number | null;
  contracts: number | null;
  openRisk: number | null;
  underlying: number | null;
}

const ACCOUNT_KEYS: Array<[keyof AccountLimitFields, keyof AccountLimits]> = [
  ['notional', 'max_order_notional'], ['contracts', 'max_option_contracts'],
  ['openRisk', 'max_open_risk_usd'], ['underlying', 'max_underlying_contracts'],
];

export interface SettingsForm {
  autoExecute: boolean;
  allowLive: boolean;
  triggerVerify: boolean;
  notional: number | null;
  contracts: number | null;
  mktShares: number | null;
  slippage: number | null;
  dupe: number | null;
  // 账户在手的两条累计上限:空着 = 不设(引擎里是 0)
  openRisk: number | null;
  underlying: number | null;
  /** AUTO_MID 按盘口价差让价的百分比(0–100);空着 = 不用它,照上面的固定滑点 */
  midShare: number | null;
  /** 按账户覆盖的限额:账户别名 → 那几项 */
  byAccount: Record<string, AccountLimitFields>;
  // 保护规则(见 engine-ts/src/protections.ts)。默认全关,老配置升级上来行为不变。
  slGuard: boolean;
  slLookback: number | null;
  slCount: number | null;
  slPause: number | null;
  ddGuard: boolean;
  ddLookback: number | null;
  ddUsd: number | null;
  ddPause: number | null;
  coolOn: boolean;
  coolMinutes: number | null;
  /** 冷却挡什么:这只标的的一切新单,还是只挡同一个结构 */
  coolScope: 'symbol' | 'position';
  dailyOn: boolean;
  dailyUsd: number | null;
  /** 今天亏了多少拿什么算:引擎发的单的已实现盈亏,还是券商报的账户当日盈亏(含浮亏) */
  dailyBasis: 'realized' | 'account';
  // 单笔风险预算(见 engine-ts/src/riskBudget.ts):只告警、不拦单。权益按账户别名填
  rbOn: boolean;
  rbRisk: number | null;
  rbPosition: number | null;
  rbEquity: Record<string, number | null>;
}

export function toForm(s: Settings): SettingsForm {
  // 少一个字段就整页崩掉、只留一句 JS 报错,不是可交付的失败方式:缺什么就空着那一格,其余照常可用
  const p = s.policies || {};
  const l = s.limits || {};
  const pr: Partial<SettingsProtections> = s.protections || {};
  const sg: Partial<SettingsProtections['stoploss_guard']> = pr.stoploss_guard || {};
  const dd: Partial<SettingsProtections['max_drawdown']> = pr.max_drawdown || {};
  const cd: Partial<SettingsProtections['cooldown']> = pr.cooldown || {};
  const dl: Partial<SettingsProtections['daily_loss']> = pr.daily_loss || {};
  return {
    autoExecute: Boolean(p.auto_execute),
    allowLive: Boolean(p.allow_live_trading),
    triggerVerify: Boolean(p.require_trigger_price_verification),
    notional: l.max_order_notional ?? null,
    contracts: l.max_option_contracts ?? null,
    mktShares: l.max_mkt_shares ?? null,
    slippage: l.max_spread_slippage ?? null,
    dupe: l.duplicate_window_minutes ?? null,
    // 0 = 不设:表单里摆成空格子,不摆一个会被读成"上限 0"的 0
    openRisk: l.max_open_risk_usd ? l.max_open_risk_usd : null,
    underlying: l.max_underlying_contracts ? l.max_underlying_contracts : null,
    midShare: l.auto_mid_spread_share ? Math.round(l.auto_mid_spread_share * 1000) / 10 : null,
    byAccount: Object.fromEntries((s.accounts || []).map((a) => {
      const own = l.by_account?.[a.alias] ?? {};
      return [a.alias, Object.fromEntries(ACCOUNT_KEYS.map(([field, key]) => [field, own[key] ?? null])) as unknown as AccountLimitFields];
    })),
    slGuard: Boolean(sg.enabled),
    slLookback: sg.lookback_minutes ?? null,
    slCount: sg.trigger_count ?? null,
    slPause: sg.pause_minutes ?? null,
    ddGuard: Boolean(dd.enabled),
    ddLookback: dd.lookback_minutes ?? null,
    ddUsd: dd.max_drawdown_usd ?? null,
    ddPause: dd.pause_minutes ?? null,
    coolOn: Boolean(cd.enabled),
    coolMinutes: cd.minutes ?? null,
    coolScope: cd.scope === 'position' ? 'position' : 'symbol',
    dailyOn: Boolean(dl.enabled),
    dailyUsd: dl.max_loss_usd ?? null,
    dailyBasis: dl.basis === 'account' ? 'account' : 'realized',
    rbOn: Boolean(s.risk_budget?.enabled),
    rbRisk: s.risk_budget?.max_risk_pct ?? null,
    rbPosition: s.risk_budget?.max_position_pct ?? null,
    rbEquity: Object.fromEntries((s.accounts || []).map((a) => [a.alias, s.risk_budget?.equity_usd?.[a.alias] ?? null])),
  };
}

const filled = (v: number | null): v is number => v !== null && Number.isFinite(v);
const positive = (v: number | null): v is number => filled(v) && v > 0;

/**
 * 保存前的检查。返回给人看的话,一条一句;空 = 可以存。
 * 只管"这样存下去保护会形同虚设 / 引擎一定会拒"的情况,别的范围校验是引擎的事(它的话更准)。
 */
export function formProblems(f: SettingsForm): string[] {
  const out: string[] = [];
  const need = (ok: boolean, text: string): void => {
    if (!ok) out.push(text);
  };
  need(positive(f.notional), '「单笔名义金额上限」要填一个大于 0 的数');
  need(filled(f.contracts) && f.contracts >= 1, '「期权 / 价差单笔上限」至少是 1 张');
  need(filled(f.mktShares) && f.mktShares >= 1, '「市价单股数上限」至少是 1 股');
  need(filled(f.slippage) && f.slippage >= 0, '「AUTO_MID 滑点上限」要填一个不小于 0 的数');
  need(filled(f.dupe) && f.dupe >= 0, '「重复防抖窗口」不能空着:空着会被存成 0,等于关掉重复单防抖。确实要关就填 0');
  need(f.midShare === null || (f.midShare >= 0 && f.midShare <= 100), '「AUTO_MID 按价差让价」要在 0 到 100 之间(百分比)');
  for (const [alias, own] of Object.entries(f.byAccount)) {
    need(own.notional === null || own.notional > 0, `「${alias}」的单笔名义金额上限要大于 0;想用全局的就空着`);
    need(own.contracts === null || own.contracts >= 1, `「${alias}」的期权 / 价差单笔上限至少是 1 张;想用全局的就空着`);
  }
  if (f.slGuard) {
    need(positive(f.slLookback) && positive(f.slPause), '「止损护栏」开着:往回看与暂停多久都要填大于 0 的分钟数');
    need(filled(f.slCount) && f.slCount >= 1, '「止损护栏」开着:几次止损算数至少是 1');
  }
  if (f.ddGuard) {
    need(positive(f.ddLookback) && positive(f.ddPause), '「回撤护栏」开着:往回看与暂停多久都要填大于 0 的分钟数');
    need(positive(f.ddUsd), '「回撤护栏」开着:回撤阈值要填大于 0 的金额。填 0 或空着,这条规则不会生效');
  }
  if (f.coolOn) need(positive(f.coolMinutes), '「同标的冷却」开着:冷却多久要填大于 0 的分钟数');
  if (f.dailyOn) need(positive(f.dailyUsd), '「日内亏损上限」开着:当天最多亏要填大于 0 的金额。填 0 或空着,这条规则不会生效');
  if (f.rbOn) {
    need(positive(f.rbRisk) && positive(f.rbPosition), '「按账户权益提醒」开着:两个百分比都要填大于 0 的数');
  }
  return out;
}

/** 表单 → 补丁。空着的格子照已保存的值送回去(没有就不送这个键),从不把 null 变成 0。 */
export function toPatch(f: SettingsForm, saved: Settings | null): SettingsPatch {
  const keep = <T extends object>(section: T | undefined, key: keyof T, v: number | null): Partial<T> => {
    if (filled(v)) return { [key]: v } as Partial<T>;
    const old = section?.[key];
    return typeof old === 'number' ? ({ [key]: old } as Partial<T>) : {};
  };
  const l = saved?.limits;
  const pr = saved?.protections;
  const rb = saved?.risk_budget;
  const equity: Record<string, number> = {};
  for (const [alias, v] of Object.entries(f.rbEquity)) equity[alias] = filled(v) && v > 0 ? v : 0; // 0 = 这个账户不提醒(引擎的口径)
  return {
    policies: {
      auto_execute: f.autoExecute,
      allow_live_trading: f.allowLive,
      require_trigger_price_verification: f.triggerVerify,
    },
    limits: {
      ...keep(l, 'max_order_notional', f.notional),
      ...keep(l, 'max_option_contracts', f.contracts),
      ...keep(l, 'max_mkt_shares', f.mktShares),
      ...keep(l, 'max_spread_slippage', f.slippage),
      ...keep(l, 'duplicate_window_minutes', f.dupe),
      // 这三项的格子上写着"空着 = 不设":空就是引擎的 0。和上面那些不一样——它们没有另外的开关,数本身就是开关
      max_open_risk_usd: positive(f.openRisk) ? f.openRisk : 0,
      max_underlying_contracts: positive(f.underlying) ? Math.trunc(f.underlying) : 0,
      auto_mid_spread_share: positive(f.midShare) ? Math.min(f.midShare, 100) / 100 : 0,
      ...accountLimitsPatch(f, l?.by_account),
    },
    protections: {
      stoploss_guard: {
        enabled: f.slGuard,
        ...keep(pr?.stoploss_guard, 'lookback_minutes', f.slLookback),
        ...keep(pr?.stoploss_guard, 'trigger_count', f.slCount),
        ...keep(pr?.stoploss_guard, 'pause_minutes', f.slPause),
      },
      max_drawdown: {
        enabled: f.ddGuard,
        ...keep(pr?.max_drawdown, 'lookback_minutes', f.ddLookback),
        ...keep(pr?.max_drawdown, 'max_drawdown_usd', f.ddUsd),
        ...keep(pr?.max_drawdown, 'pause_minutes', f.ddPause),
      },
      cooldown: { enabled: f.coolOn, scope: f.coolScope, ...keep(pr?.cooldown, 'minutes', f.coolMinutes) },
      daily_loss: { enabled: f.dailyOn, basis: f.dailyBasis, ...keep(pr?.daily_loss, 'max_loss_usd', f.dailyUsd) },
    },
    risk_budget: {
      enabled: f.rbOn,
      ...keep(rb, 'max_risk_pct', f.rbRisk),
      ...keep(rb, 'max_position_pct', f.rbPosition),
      equity_usd: equity,
    },
  };
}

/**
 * 按账户覆盖的那一段。填了的送数;空着的分两种:已保存的那份里本来就没有 → 这个键不送;
 * 本来有 → 送 null(引擎读作"这个账户不再覆盖这一项"。配置是深合并的,不送就清不掉)。从不送 0。
 * 一项都没有时整段不送。
 */
function accountLimitsPatch(f: SettingsForm, saved: Record<string, AccountLimits> | undefined): { by_account?: Record<string, AccountLimits> } {
  const out: Record<string, AccountLimits> = {};
  for (const [alias, own] of Object.entries(f.byAccount)) {
    const one: AccountLimits = {};
    for (const [field, key] of ACCOUNT_KEYS) {
      const value = own[field];
      if (filled(value)) one[key] = value;
      else if (saved?.[alias]?.[key] !== null && saved?.[alias]?.[key] !== undefined) one[key] = null;
    }
    if (Object.keys(one).length) out[alias] = one;
  }
  return Object.keys(out).length ? { by_account: out } : {};
}

/** 表单和已保存的那一份不一样(有没存的修改)。 */
export function isDirty(f: SettingsForm, saved: Settings | null): boolean {
  if (!saved) return false;
  return JSON.stringify(f) !== JSON.stringify(toForm(saved));
}
