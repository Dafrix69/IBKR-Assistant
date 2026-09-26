/** 单笔风险预算(riskBudget.ts + 校验层第 10 步):占账户权益的比例,只告警、不拦单。 */
import { describe, expect, it } from "vitest";

import { etNowFromEpoch, fromDict } from "../src/config.js";
import { ParsedOrderSchema } from "../src/models.js";
import { riskBudgetWarning } from "../src/riskBudget.js";
import { Validator } from "../src/validator.js";
import { loadGolden, makeSettings } from "./util.js";

const CFG = { enabled: true, equity_usd: { 主账户: 50_000 }, max_risk_pct: 2, max_position_pct: 25 };

describe("riskBudgetWarning", () => {
  it("期权 / 组合按最坏亏损比:超了说占多少、线在哪,且写明不拦单", () => {
    expect(riskBudgetWarning(CFG, "主账户", "BAG", 1000)).toBeNull(); // 正好 2%
    const w = riskBudgetWarning(CFG, "主账户", "BAG", 1500);
    expect(w).toContain("最坏亏损约 $1500.00");
    expect(w).toContain("3%");
    expect(w).toContain("只提醒,不拦单");
  });

  it("股票按名义金额比仓位上限,并提醒去设止损", () => {
    expect(riskBudgetWarning(CFG, "主账户", "STK", 12_000)).toBeNull();
    expect(riskBudgetWarning(CFG, "主账户", "STK", 20_000)).toContain("占 主账户 权益 $50000.00 的 40%");
  });

  it("没开、没填这个账户的权益、敞口算不出来:一律不说", () => {
    expect(riskBudgetWarning({ ...CFG, enabled: false }, "主账户", "BAG", 9999)).toBeNull();
    expect(riskBudgetWarning(CFG, "别的账户", "BAG", 9999)).toBeNull();
    expect(riskBudgetWarning({ ...CFG, equity_usd: { 主账户: 0 } }, "主账户", "BAG", 9999)).toBeNull();
    expect(riskBudgetWarning(CFG, "主账户", "STK", 0)).toBeNull();
  });
});

describe("配置", () => {
  const g = loadGolden("validator");
  it("默认关;写错了当场报中文原因,不写盘", () => {
    expect(makeSettings(g.base_config).risk_budget).toEqual({ enabled: false, equity_usd: {}, max_risk_pct: 2, max_position_pct: 25 });
    expect(() => makeSettings(g.base_config, { risk_budget: { enable: true } })).toThrowError("risk_budget 里有未知配置项");
    expect(() => makeSettings(g.base_config, { risk_budget: { equity_usd: { 主账户: -1 } } })).toThrowError("risk_budget.equity_usd.主账户 不能小于 0.0");
    expect(() => makeSettings(g.base_config, { risk_budget: { equity_usd: [1] } })).toThrowError("必须是 {账户别名: 金额}");
    expect(() => fromDict({ ...g.base_config, risk_budget: { max_risk_pct: 0 } })).toThrowError("不能小于 0.1");
  });
});

describe("接进校验层", () => {
  const g = loadGolden("validator");
  const stockCase = (g.cases as Array<Record<string, any>>).find((c) => c.name === "stock_ok")!;

  it("超了:照常通过,警告里多一句;没开:警告一字不变", () => {
    const base = makeSettings(g.base_config);
    const alias = base.defaultAccount()!.alias;
    const order = ParsedOrderSchema.parse(stockCase.payload); // 限价 230 × 100 股 = 23000
    const now = etNowFromEpoch(Date.parse(stockCase.now));

    const off = new Validator(base, now, stockCase.snapshot, []).validateOne(order);
    expect(off[1]?.warnings).toEqual([]);

    const on = makeSettings(g.base_config, { risk_budget: { enabled: true, equity_usd: { [alias]: 40_000 } } });
    const [issues, approved] = new Validator(on, now, stockCase.snapshot, []).validateOne(order);
    expect(issues).toEqual([]);
    expect(approved?.warnings).toHaveLength(1);
    expect(approved?.warnings[0]).toContain("57.5%");
  });
});
