/** 「设置」页表单的纯逻辑(desktop/renderer-react/src/lib/settingsForm.ts)。
 *
 * 这一页出过的错不是"画错了",是"存错了":输入框清空是 null,`Number(null)` 是 0——开着「日内亏损上限」、
 * 金额空着点保存,引擎收到"开着、上限 0",而它对 0 的处理是跳过这条规则(protections.ts)。
 * 界面上开关亮着,保护其实没有。这里钉:那样的表单存不了;空着的格子绝不变成 0 送出去。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { fromDict } from "../src/config.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
type Form = Record<string, any>;
type Patch = Record<string, any>;
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "settingsForm.ts")).href)) as unknown as {
  toForm(s: unknown): Form;
  formProblems(f: Form): string[];
  toPatch(f: Form, saved: unknown): Patch;
  isDirty(f: Form, saved: unknown): boolean;
};

const BASE = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
const settings = fromDict(BASE);
/** settings.get 回的那个样子(只取这一页用到的几段) */
const SAVED = {
  path: "/x/settings.json",
  llm: { model: "m", effort: "high", max_tokens: 8000 },
  limits: { ...settings.limits },
  policies: { ...settings.policies },
  protections: JSON.parse(JSON.stringify(settings.protections)),
  risk_budget: JSON.parse(JSON.stringify(settings.risk_budget)),
  symbol_aliases: {},
  accounts: [{ alias: "模拟", account_masked: "DU***000", is_paper: true, connection: "paper", broker: "ibkr", default: true }],
  connections: {},
};

describe("保存前的检查", () => {
  it("引擎默认的那份设置:没有问题,也没有未保存的修改", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems(form)).toEqual([]);
    expect(mod.isDirty(form, SAVED)).toBe(false);
  });

  it("开着「日内亏损上限」、金额空着或填 0:存不了", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems({ ...form, dailyOn: true, dailyUsd: null }).join()).toMatch(/日内亏损上限.*这条规则不会生效/);
    expect(mod.formProblems({ ...form, dailyOn: true, dailyUsd: 0 }).join()).toMatch(/日内亏损上限/);
    expect(mod.formProblems({ ...form, dailyOn: true, dailyUsd: 500 })).toEqual([]);
    // 没开的时候那一格空着不算问题
    expect(mod.formProblems({ ...form, dailyOn: false, dailyUsd: null })).toEqual([]);
  });

  it("回撤护栏、止损护栏、冷却、风险预算:开着就得填正数", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems({ ...form, ddGuard: true, ddUsd: 0 }).join()).toMatch(/回撤护栏.*回撤阈值/);
    expect(mod.formProblems({ ...form, ddGuard: true, ddLookback: null }).join()).toMatch(/回撤护栏/);
    expect(mod.formProblems({ ...form, slGuard: true, slCount: 0 }).join()).toMatch(/止损护栏.*至少是 1/);
    expect(mod.formProblems({ ...form, coolOn: true, coolMinutes: null }).join()).toMatch(/同标的冷却/);
    expect(mod.formProblems({ ...form, rbOn: true, rbRisk: null }).join()).toMatch(/按账户权益提醒/);
  });

  it("限额空着:存不了;重复防抖窗口空着要明说(它会变成 0 = 关掉防抖)", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems({ ...form, notional: null }).join()).toMatch(/单笔名义金额上限/);
    expect(mod.formProblems({ ...form, notional: 0 }).join()).toMatch(/单笔名义金额上限/);
    expect(mod.formProblems({ ...form, dupe: null }).join()).toMatch(/重复防抖窗口.*关掉重复单防抖/);
    expect(mod.formProblems({ ...form, dupe: 0 })).toEqual([]); // 明确填了 0 是用户自己的决定
  });

  it("引擎确实把 0 当成「这条规则不生效」:这条检查不是多余的", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "src", "protections.ts"), "utf-8");
    expect(src).toMatch(/daily\.enabled && daily\.max_loss_usd > 0/);
  });
});

describe("拼补丁", () => {
  it("空着的格子照已保存的值送回去,绝不送 0", () => {
    const form = { ...mod.toForm(SAVED), dailyOn: false, dailyUsd: null, ddUsd: null, slLookback: null, coolMinutes: null, rbRisk: null };
    const patch = mod.toPatch(form, SAVED);
    expect(patch.protections.daily_loss).toEqual({ enabled: false, basis: "realized", max_loss_usd: SAVED.protections.daily_loss.max_loss_usd });
    expect(patch.protections.max_drawdown.max_drawdown_usd).toBe(SAVED.protections.max_drawdown.max_drawdown_usd);
    expect(patch.protections.stoploss_guard.lookback_minutes).toBe(SAVED.protections.stoploss_guard.lookback_minutes);
    expect(patch.protections.cooldown.minutes).toBe(SAVED.protections.cooldown.minutes);
    expect(patch.risk_budget.max_risk_pct).toBe(SAVED.risk_budget.max_risk_pct);
    expect(JSON.stringify(patch)).not.toMatch(/null|NaN/);
  });

  it("没有已保存的值可退:那个键不送(由引擎的默认值管)", () => {
    const patch = mod.toPatch({ ...mod.toForm(SAVED), coolMinutes: null }, { ...SAVED, protections: { ...SAVED.protections, cooldown: { enabled: false } } });
    expect(patch.protections.cooldown).toEqual({ enabled: false, scope: "symbol" });
  });

  it("新加的三项上限:空着 = 不设(引擎的 0),填了送数;按价差让价的百分比换成份额", () => {
    const empty = mod.toPatch(mod.toForm(SAVED), SAVED);
    expect(empty.limits).toMatchObject({ max_open_risk_usd: 0, max_underlying_contracts: 0, auto_mid_spread_share: 0 });
    expect("by_account" in empty.limits).toBe(false);
    const set = mod.toPatch({ ...mod.toForm(SAVED), openRisk: 2000, underlying: 6, midShare: 50 }, SAVED);
    expect(set.limits).toMatchObject({ max_open_risk_usd: 2000, max_underlying_contracts: 6, auto_mid_spread_share: 0.5 });
    // 读回来:0 摆成空格子,份额摆成百分比
    const back = mod.toForm({ ...SAVED, limits: { ...SAVED.limits, max_open_risk_usd: 2000, max_underlying_contracts: 0, auto_mid_spread_share: 0.25 } });
    expect([back.openRisk, back.underlying, back.midShare]).toEqual([2000, null, 25]);
    expect(mod.formProblems({ ...mod.toForm(SAVED), midShare: 120 })).toEqual(["「AUTO_MID 按价差让价」要在 0 到 100 之间(百分比)"]);
  });

  it("按账户覆盖:填了的送数;空着的不送;已保存的那份里有、这次清空的送 null(深合并里只有这样清得掉)", () => {
    const live = { alias: "主账户", account_masked: "U***567", is_paper: false, connection: "live", broker: "ibkr", default: false };
    const saved = { ...SAVED, accounts: [...SAVED.accounts, live], limits: { ...SAVED.limits, by_account: { 主账户: { max_order_notional: 2000, max_option_contracts: 2 } } } };
    const form = mod.toForm(saved);
    expect(form.byAccount["主账户"]).toEqual({ notional: 2000, contracts: 2, openRisk: null, underlying: null });
    expect(form.byAccount["模拟"]).toEqual({ notional: null, contracts: null, openRisk: null, underlying: null });
    // 原样存回去:只带已经有的那两项,别的账户不出现
    expect(mod.toPatch(form, saved).limits.by_account).toEqual({ 主账户: { max_order_notional: 2000, max_option_contracts: 2 } });
    const edited = { ...form, byAccount: { ...form.byAccount, 主账户: { notional: null, contracts: 3, openRisk: 1500, underlying: null }, 模拟: { notional: 20000, contracts: null, openRisk: null, underlying: null } } };
    expect(mod.toPatch(edited, saved).limits.by_account).toEqual({
      主账户: { max_order_notional: null, max_option_contracts: 3, max_open_risk_usd: 1500 }, 模拟: { max_order_notional: 20000 },
    });
    expect(mod.formProblems({ ...form, byAccount: { ...form.byAccount, 主账户: { notional: 0, contracts: 0, openRisk: null, underlying: null } } })).toEqual([
      "「主账户」的单笔名义金额上限要大于 0;想用全局的就空着", "「主账户」的期权 / 价差单笔上限至少是 1 张;想用全局的就空着",
    ]);
  });

  it("冷却挡什么、日内亏损拿什么算:读得进、存得回", () => {
    const saved = { ...SAVED, protections: { ...SAVED.protections, cooldown: { ...SAVED.protections.cooldown, scope: "position" }, daily_loss: { ...SAVED.protections.daily_loss, basis: "account" } } };
    const form = mod.toForm(saved);
    expect([form.coolScope, form.dailyBasis]).toEqual(["position", "account"]);
    const patch = mod.toPatch(form, saved);
    expect(patch.protections.cooldown.scope).toBe("position");
    expect(patch.protections.daily_loss.basis).toBe("account");
    // 老引擎回的设置里没有这两个键:按原来的口径
    expect([mod.toForm(SAVED).coolScope, mod.toForm(SAVED).dailyBasis]).toEqual(["symbol", "realized"]);
  });

  it("拼出来的补丁引擎收得下(逐段过 config 的校验)", () => {
    const form = { ...mod.toForm(SAVED), autoExecute: true, notional: 8000, dailyOn: true, dailyUsd: 300, rbOn: true, rbEquity: { 模拟: 100000 } };
    expect(mod.formProblems(form)).toEqual([]);
    const patch = mod.toPatch(form, SAVED);
    const merged = fromDict({
      ...BASE,
      policies: { ...BASE.policies, ...patch.policies },
      limits: { ...BASE.limits, ...patch.limits },
      protections: patch.protections,
      risk_budget: patch.risk_budget,
    });
    expect(merged.policies.auto_execute).toBe(true);
    expect(merged.limits.max_order_notional).toBe(8000);
    expect(merged.protections.daily_loss).toEqual({ enabled: true, max_loss_usd: 300, basis: "realized" });
    expect(merged.risk_budget.equity_usd).toEqual({ 模拟: 100000 });
  });

  it("改了一格就是有未保存的修改", () => {
    const form = mod.toForm(SAVED);
    expect(mod.isDirty({ ...form, notional: Number(form["notional"]) + 1 }, SAVED)).toBe(true);
    expect(mod.isDirty({ ...form, autoExecute: !form["autoExecute"] }, SAVED)).toBe(true);
    expect(mod.isDirty(form, null)).toBe(false);
  });
});

describe("页面的接线", () => {
  const page = readFileSync(path.join(SRC, "pages", "Settings.tsx"), "utf-8");

  it("保存走 formProblems 与 toPatch,页面里不再有 Number(form.…)", () => {
    expect(page).toMatch(/formProblems\(form\)/);
    expect(page).toMatch(/toPatch\(form, saved\)/);
    expect(page).not.toMatch(/Number\(form\./);
  });

  it("两个执行闸门:关是当场生效的(不等保存)", () => {
    expect(page).toMatch(/patchSettings\(\{ policies: \{ \[policy\]: false \} \}\)/);
    expect(page.match(/setGate\('(autoExecute|allowLive)'/g)).toHaveLength(2);
  });
});
