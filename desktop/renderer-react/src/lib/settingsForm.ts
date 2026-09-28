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
import type { Settings, SettingsPatch, SettingsProtections } from '../bridge';

export interface SettingsForm {
  autoExecute: boolean;
  allowLive: boolean;
  triggerVerify: boolean;
  notional: number | null;
  contracts: number | null;
  mktShares: number | null;
  slippage: number | null;
  dupe: number | null;
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
  dailyOn: boolean;
  dailyUsd: number | null;
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
    dailyOn: Boolean(dl.enabled),
    dailyUsd: dl.max_loss_usd ?? null,
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
      cooldown: { enabled: f.coolOn, ...keep(pr?.cooldown, 'minutes', f.coolMinutes) },
      daily_loss: { enabled: f.dailyOn, ...keep(pr?.daily_loss, 'max_loss_usd', f.dailyUsd) },
    },
    risk_budget: {
      enabled: f.rbOn,
      ...keep(rb, 'max_risk_pct', f.rbRisk),
      ...keep(rb, 'max_position_pct', f.rbPosition),
      equity_usd: equity,
    },
  };
}

/** 表单和已保存的那一份不一样(有没存的修改)。 */
export function isDirty(f: SettingsForm, saved: Settings | null): boolean {
  if (!saved) return false;
  return JSON.stringify(f) !== JSON.stringify(toForm(saved));
}
