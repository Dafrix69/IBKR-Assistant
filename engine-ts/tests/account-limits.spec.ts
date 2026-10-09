/** 账户级的风控:在手的两条累计上限、按账户覆盖的限额、重复单防抖认"还挂着 / 换了价"、冷却按结构、
 * 日内亏损上限按账户当日盈亏(docs/features/instruction.md「校验」、protections.md、risk-budget.md)。
 *
 * 全部离线:敞口与规则是纯函数;券商那两路数据(reqPnL、账户摘要)用假的 `@stoqey/ib`(fakeTws.ts)垫在真的会话下面。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PNL_STALE_MS, accountDailyPnl, accountNetLiquidation } from "../src/accountFeeds.js";
import type { EtNow } from "../src/config.js";
import { etNowFromEpoch, fromDict } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { AccountGuard, withWorkingOrders } from "../src/engine/accountGuard.js";
import { orderLegId, reducesPositions } from "../src/engine/closing.js";
import { createIbApiNextSession, realNumber } from "../src/ibSession.js";
import { ParsedOrderSchema } from "../src/models.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import type { ParsedOrder, RecentOrder } from "../src/models.js";
import { contractsKey, openRisk } from "../src/openRisk.js";
import { cooldownKey, etDayStart, evaluateProtections, protectionBlock, protectionsSummary } from "../src/protections.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { Validator, orderSignature } from "../src/validator.js";
import type { ValidationIssue, ValidatorExtras } from "../src/validator.js";
import { ACCOUNT, CFG, FakeTws } from "./fakeTws.js";
import { loadGolden, makeSettings } from "./util.js";

const gv = loadGolden("validator");
type Rec = Record<string, any>;
const TUESDAY: EtNow = etNowFromEpoch(Date.parse("2026-09-29T15:00:00Z")); // 周二 11:00 美东,盘中
const EXPIRY = "20260929";
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

function parse(raw: Rec): ParsedOrder {
  return ParsedOrderSchema.parse({
    intent_summary: "测试", execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
    reason: "回归", confidence: 0.99, ...raw,
  });
}

const leg = (action: string, ratio: number, strike: number, right = "C"): Rec =>
  ({ action, ratio, lastTradeDateOrContractMonth: EXPIRY, strike, right, tradingClass: "SPXW" });

/** 买入 qty 张 7725/7750/7775 看涨蝶,净权利金 price */
const fly = (qty: number, price: number, account = "DEFAULT"): ParsedOrder => parse({
  account,
  contract: { secType: "BAG", symbol: "SPX", combo_strategy: "BUTTERFLY", legs: [leg("BUY", 1, 7725), leg("SELL", 2, 7750), leg("BUY", 1, 7775)] },
  order: { action: "BUY", orderType: "LMT", totalQuantity: qty, price_mode: "EXPLICIT", lmtPrice: price, tif: "DAY", outsideRth: false },
});

/** 卖出 7500/7520 看涨价差(贷方):卖低买高,收 credit */
const bearCall = (qty: number, credit: number): ParsedOrder => parse({
  contract: { secType: "BAG", symbol: "SPX", combo_strategy: "VERTICAL", legs: [leg("SELL", 1, 7500), leg("BUY", 1, 7520)] },
  order: { action: "SELL", orderType: "LMT", totalQuantity: qty, price_mode: "EXPLICIT", lmtPrice: credit, tif: "DAY", outsideRth: false },
});

function optRow(account: string, strike: number, right: string, qty: number, avgCost: number, symbol = "SPX", expiry = EXPIRY): Rec {
  const contract = { secType: "OPT", symbol, lastTradeDateOrContractMonth: expiry, strike, right, multiplier: "100" };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey(account, symbol, "OPT", ident), account, symbol, sec_type: "OPT", leg: ident, quantity: qty,
    avg_cost: avgCost, multiplier: 100, currency: "USD", market_price: null, market_value: null, unrealized_pnl: null, contract,
  };
}

/** 模拟账户上以 4.50 买入的 lots 组 7725/7750/7775 看涨蝶 */
const heldFly = (lots: number, account = "模拟"): Rec[] =>
  [optRow(account, 7725, "C", lots, 800), optRow(account, 7750, "C", -2 * lots, 200), optRow(account, 7775, "C", lots, 50)];

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);

function validator(over: Rec, extras?: ValidatorExtras | null, recent: RecentOrder[] = []): Validator {
  return new Validator(makeSettings(gv.base_config, over), TUESDAY, { SPX: 7740 }, recent, null, extras);
}

// ---------------------------------------------------------------- 在手敞口(纯函数)
describe("openRisk:账户在手的期权敞口", () => {
  it("买入的蝶:付出的成本 × 组数;张数按组数记,不按腿数", () => {
    const out = openRisk(heldFly(3));
    expect(out.riskUsd).toEqual({ 模拟: 1350 });                       // 450 × 3
    expect(out.contracts).toEqual({ [contractsKey("模拟", "SPX", EXPIRY)]: 3 });
    expect(out.notes).toEqual([]);
  });

  it("贷方价差:(宽度 × 乘数 − 收到的权利金)× 组数", () => {
    // 卖 7500C 收 1200、买 7520C 付 400:净收 800,宽度 20 → 每组最坏亏 2000 − 800 = 1200
    const rows = [optRow("模拟", 7500, "C", -2, 1200), optRow("模拟", 7520, "C", 2, 400)];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: 2400 });
  });

  it("铁鹰:取两侧里宽的那一侧(两侧不会同时亏)", () => {
    // 买 7400P / 卖 7450P / 卖 7600C / 买 7625C:put 侧宽 50、call 侧宽 25;净收 (300 + 250 − 100 − 80) = 370
    const rows = [
      optRow("模拟", 7400, "P", 1, 100), optRow("模拟", 7450, "P", -1, 300),
      optRow("模拟", 7600, "C", -1, 250), optRow("模拟", 7625, "C", 1, 80),
    ];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: 5000 - 370 });
  });

  it("单腿:买入 = 成本;卖出看跌 = 行权价 × 乘数 − 收到的权利金;卖出看涨没有上限,按行权价计并说明", () => {
    expect(openRisk([optRow("模拟", 180, "C", 2, 550, "NVDA")]).riskUsd).toEqual({ 模拟: 1100 });
    expect(openRisk([optRow("模拟", 170, "P", -1, 300, "NVDA")]).riskUsd).toEqual({ 模拟: 17000 - 300 });
    const naked = openRisk([optRow("模拟", 190, "C", -1, 300, "NVDA")]);
    expect(naked.riskUsd).toEqual({ 模拟: 19000 });
    expect(naked.notes).toEqual([`模拟 的 NVDA ${EXPIRY} 到期有 1 张净卖出的看涨往上没有对冲,亏损没有上限;在手风险里这一段按最高行权价 × 乘数 × 张数计。`]);
  });

  it("比例价差(1:3):往上净卖出 2 张,没有上限;正股不计;账户、标的、到期各记各的", () => {
    const ratio = [optRow("模拟", 7700, "C", 1, 900), optRow("模拟", 7750, "C", -3, 300)];
    const out = openRisk([
      ...ratio, ...heldFly(1, "主账户"), optRow("模拟", 180, "C", 1, 550, "NVDA", "20261016"),
      { key: "模拟|BE|STK", account: "模拟", symbol: "BE", sec_type: "STK", quantity: 100, avg_cost: 100, multiplier: 1, contract: { secType: "STK", symbol: "BE" } },
    ]);
    // 净成本 900 − 900 = 0,有限的那一段不亏;往上每点亏 200,按最高行权价计:200 × 7750
    expect(out.riskUsd).toEqual({ 模拟: 200 * 7750 + 550, 主账户: 450 });
    expect(out.notes).toHaveLength(1);
    expect(out.contracts).toEqual({
      [contractsKey("模拟", "SPX", EXPIRY)]: 4, [contractsKey("主账户", "SPX", EXPIRY)]: 1,
      [contractsKey("模拟", "NVDA", "20261016")]: 1,
    });
  });

  // 下面四例的"真值"是独立写的:把标的从 0 扫到很高,逐点算到期盈亏取最差——不借实现里的任何一步
  const brute = (rows: Rec[]): number => {
    let worst = 0;
    for (let s = 0; s <= 20000; s += 2.5) {
      let pnl = 0;
      for (const r of rows) {
        const k = Number(r["contract"]["strike"]), call = r["contract"]["right"] === "C";
        pnl += Number(r["quantity"]) * 100 * Math.max(0, call ? s - k : k - s) - Number(r["quantity"]) * Number(r["avg_cost"]);
      }
      worst = Math.max(worst, -pnl);
    }
    return worst;
  };

  it("两侧张数不等的「铁鹰」(2 组看跌价差 + 5 组看涨价差):不当成 2 组铁鹰;张数也不少数", () => {
    const rows = [
      optRow("模拟", 7400, "P", 2, 100), optRow("模拟", 7425, "P", -2, 300),
      optRow("模拟", 7600, "C", -5, 250), optRow("模拟", 7625, "C", 5, 80),
    ];
    const out = openRisk(rows);
    expect(out.riskUsd).toEqual({ 模拟: brute(rows) });
    expect(out.riskUsd["模拟"]).toBe(5 * 2500 - (2 * 200 + 5 * 170)); // 看涨那一侧全亏,两侧收的权利金都留着
    expect(out.contracts[contractsKey("模拟", "SPX", EXPIRY)]).toBeGreaterThanOrEqual(7);
  });

  it("贷方看跌价差 + 借方看涨价差,合起来净付钱:照样看得见看跌那一侧的整段宽度", () => {
    const rows = [
      optRow("模拟", 7400, "P", 1, 100), optRow("模拟", 7450, "P", -1, 300),   // 收 200
      optRow("模拟", 7600, "C", 1, 1200), optRow("模拟", 7625, "C", -1, 200),  // 付 1000
    ];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: brute(rows) });
    expect(openRisk(rows).riskUsd["模拟"]).toBe(5000 + 800);
  });

  it("分腿建起来、净成本为正的贷方价差:不因为成本是正的就当成借方", () => {
    // 先买的 7520C 花了 900,后卖的 7500C 只收到 700:净付 200,但它是卖低买高,最坏亏 宽度 + 净付
    const rows = [optRow("模拟", 7500, "C", -1, 700), optRow("模拟", 7520, "C", 1, 900)];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: brute(rows) });
    expect(openRisk(rows).riskUsd["模拟"]).toBe(2000 + 200);
  });

  it("卖出的蝶(中间买、两翼卖),净成本为正:最坏亏在中心", () => {
    const rows = [optRow("模拟", 7725, "C", -1, 800), optRow("模拟", 7750, "C", 2, 450), optRow("模拟", 7775, "C", -1, 50)];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: brute(rows) });
    expect(openRisk(rows).riskUsd["模拟"]).toBe(2500 + 50);
  });

  it("同一到期日的两只蝶:各亏各的成本,加起来", () => {
    const other = [optRow("模拟", 7600, "P", 1, 300), optRow("模拟", 7575, "P", -2, 120), optRow("模拟", 7550, "P", 1, 40)];
    const rows = [...heldFly(2), ...other];
    expect(openRisk(rows).riskUsd).toEqual({ 模拟: brute(rows) });
    expect(openRisk(rows).riskUsd["模拟"]).toBe(900 + 100);
    expect(openRisk(rows).contracts[contractsKey("模拟", "SPX", EXPIRY)]).toBe(3);
  });

  it("空仓:两张表都是空的", () => {
    expect(openRisk([])).toEqual({ riskUsd: {}, contracts: {}, notes: [] });
  });
});

// ---------------------------------------------------------------- 累计上限(校验层)
describe("在手的两条累计上限", () => {
  const exposure = openRisk(heldFly(3)); // 模拟:在手 1350 美元、SPX 当日到期 3 张

  it("没设(默认 0):不查,也不要敞口", () => {
    const [issues] = validator({}).validateOne(fly(1, 2));
    expect(issues).toEqual([]);
  });

  it("在手的 + 这一单没超:放行;超了:拒,话里有三个数", () => {
    const v = validator({ limits: { max_open_risk_usd: 1600 } }, { exposure });
    expect(v.validateOne(fly(1, 2))[0]).toEqual([]);                    // 1350 + 200 = 1550
    const [issues] = validator({ limits: { max_open_risk_usd: 1500 } }, { exposure }).validateOne(fly(1, 2));
    expect(issues).toEqual([{
      code: "EXCEEDS_LIMIT",
      message: "账户 模拟 在手期权的最坏亏损合计约 1350.00 USD,加上这一单 200.00 USD,超过在手风险上限 1500.00 USD。",
    }]);
  });

  it("同一句话里的第二张单把第一张算进去", () => {
    const v = validator({ limits: { max_open_risk_usd: 1700 } }, { exposure });
    const out = v.validateAll([fly(1, 2), { ...fly(1, 2.5), order: { ...fly(1, 2.5).order, totalQuantity: 2 } }], 5);
    expect(out.approved).toHaveLength(1);                                // 第一张 200 进去之后是 1550
    expect(out.rejected[0]!.issues[0]!.message).toContain("合计约 1550.00 USD,加上这一单 500.00 USD");
  });

  it("同一标的同一到期的张数:组合按组数", () => {
    const v = validator({ limits: { max_underlying_contracts: 4 } }, { exposure });
    expect(v.validateOne(fly(1, 2))[0]).toEqual([]);
    const [issues] = validator({ limits: { max_underlying_contracts: 4 } }, { exposure }).validateOne(fly(2, 2));
    expect(issues).toEqual([{
      code: "EXCEEDS_LIMIT",
      message: `账户 模拟 在 SPX ${EXPIRY} 到期上已有 3 张,加上这一单 2 张,超过同一标的同一到期的上限 4 张。`,
    }]);
  });

  it("在减已有持仓的单不拦:账户到线的时候,平仓恰恰该放行", () => {
    const extras: ValidatorExtras = { exposure, isReduction: () => true };
    expect(validator({ limits: { max_open_risk_usd: 100, max_underlying_contracts: 1 } }, extras).validateOne(fly(1, 2))[0]).toEqual([]);
  });

  it("设了上限却读不到持仓:拒——核对不了的上限等于没有", () => {
    const [issues] = validator({ limits: { max_open_risk_usd: 5000 } }, { exposure: null }).validateOne(fly(1, 2));
    expect(codes(issues)).toEqual(["UNPRICEABLE"]);
    expect(issues[0]!.message).toBe("读不到账户 模拟 的持仓,核对不了在手的累计上限(在手风险 / 同标的张数),已拒绝。连上券商后重试。");
  });

  it("正股不受这两条管", () => {
    const stock = parse({
      contract: { secType: "STK", symbol: "AAPL" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 10, price_mode: "EXPLICIT", lmtPrice: 230, tif: "DAY", outsideRth: false },
    });
    expect(validator({ limits: { max_open_risk_usd: 1 } }, { exposure: null }).validateOne(stock)[0]).toEqual([]);
  });

  it("单笔上限已经拒了的单,不再多报一条累计上限", () => {
    const [issues] = validator({ limits: { max_option_contracts: 1, max_open_risk_usd: 1 } }, { exposure }).validateOne(fly(2, 2));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("超过上限 1 张");
  });
});

describe("按账户覆盖的限额(limits.by_account)", () => {
  const over = { limits: { max_order_notional: 5000, max_option_contracts: 5, by_account: { 主账户: { max_option_contracts: 1, max_order_notional: 300 } } }, policies: { allow_live_trading: true } };

  it("没覆盖的账户用全局的,覆盖了的用它自己的", () => {
    expect(validator(over).validateOne(fly(3, 2))[0]).toEqual([]);                       // 模拟:5 张以内
    const [issues] = validator(over).validateOne(fly(3, 2, "主账户"));
    expect(issues.map((i) => i.message)).toEqual([
      "本笔风险敞口约 600.00 USD,超过单笔上限 300.00 USD。", "期权/价差单笔 3 张,超过上限 1 张。",
    ]);
  });

  it("limitsFor:没写的、写成 null 的回到全局", () => {
    const s = makeSettings(gv.base_config, { limits: { max_mkt_shares: 200, by_account: { 主账户: { max_mkt_shares: null, max_open_risk_usd: 2000 } } } });
    expect(s.limitsFor("主账户")).toMatchObject({ max_mkt_shares: 200, max_open_risk_usd: 2000 });
    expect(s.limitsFor("模拟").max_open_risk_usd).toBe(0);
    expect(s.limitsFor("不存在的别名")).toEqual(s.limits);
  });

  it("写错了当场报:不认识的项、不是数、低于下限、整段不是对象", () => {
    const load = (by: unknown): string => {
      try {
        makeSettings(gv.base_config, { limits: { by_account: by } });
        return "";
      } catch (exc) {
        return (exc as Error).message;
      }
    };
    expect(load({ 主账户: { min_confidence: 0.5 } })).toBe("limits.by_account.主账户 里有未知配置项:min_confidence");
    expect(load({ 主账户: { max_option_contracts: "abc" } })).toBe("limits.by_account.主账户.max_option_contracts 必须是数字,收到 'abc'");
    expect(load({ 主账户: { max_option_contracts: 0 } })).toBe("limits.by_account.主账户.max_option_contracts 不能小于 1(收到 0)");
    expect(load([1])).toMatch(/^limits\.by_account 必须是 \{账户别名/);
    expect(load({ 主账户: 5 })).toMatch(/^limits\.by_account\.主账户 必须是 \{限额项/);
    expect(load({ 改过名的账户: { max_option_contracts: 2 } })).toBe(""); // 别名不在表里不报错:只是用不上
  });

  it("新加的几项默认都是「不设」;保护规则的两个新键默认是原来的口径", () => {
    const s = fromDict(structuredClone(gv.base_config));
    expect(s.limits).toMatchObject({ max_open_risk_usd: 0, max_underlying_contracts: 0, auto_mid_spread_share: 0, by_account: {} });
    expect(s.protections.cooldown.scope).toBe("symbol");
    expect(s.protections.daily_loss.basis).toBe("realized");
    expect(() => makeSettings(gv.base_config, { protections: { cooldown: { scope: "leg" } } }))
      .toThrowError("protections.cooldown.scope 只能是 symbol、position,收到 'leg'");
    expect(() => makeSettings(gv.base_config, { protections: { daily_loss: { basis: "equity" } } }))
      .toThrowError("protections.daily_loss.basis 只能是 realized、account,收到 'equity'");
  });
});

// ---------------------------------------------------------------- 重复单防抖
describe("重复单防抖:认「还挂着」与「换了价」", () => {
  const order = fly(1, 1.8);
  const signature = orderSignature(order, "DEFAULT");
  const recent = (over: Partial<RecentOrder>): RecentOrder[] =>
    [{ signature, quantity: 1, createdAtMs: TUESDAY.epochMs - 2 * MIN, ...over }];
  const run = (list: RecentOrder[], price = 1.8): ValidationIssue[] => validator({}, null, list).validateOne(fly(1, price))[0];

  it("老形状(不知道限价与终态):和以前一个字不差", () => {
    const issues = run(recent({}), 1.6);
    expect(codes(issues)).toEqual(["DUPLICATE_ORDER"]);
    expect(issues[0]!.message).toMatch(/^10 分钟内已提交过高度相似的订单.*如确需再下一笔,请等待窗口结束或改变数量。$/);
  });

  it("那一张还没有终态:换了价也拦,话里说它可能还挂着", () => {
    const issues = run(recent({ limitPrice: 1.8, finalStatus: null }), 1.6);
    expect(codes(issues)).toEqual(["DUPLICATE_ORDER"]);
    expect(issues[0]!.message).toMatch(/还没有终态:它可能还挂在券商那边,再发一张两张都可能成交。先撤掉那一张/);
  });

  it("那一张已经撤掉,这一次换了价:放行", () => {
    expect(run(recent({ limitPrice: 1.8, finalStatus: "cancelled" }), 1.6)).toEqual([]);
  });

  it("那一张成交了、被拒了、出错了:换了价也照旧拦——成交了的是加仓,被拒与出错的终态有记错的先例", () => {
    for (const finalStatus of ["filled", "partially_filled", "ibkr_error", "rejected_by_validator", ""]) {
      const issues = run(recent({ limitPrice: 1.8, finalStatus }), 1.6);
      expect(codes(issues), finalStatus).toEqual(["DUPLICATE_ORDER"]);
      expect(issues[0]!.message, finalStatus).toMatch(/^10 分钟内已提交过高度相似的订单/);
    }
  });

  it("已经了结、同一个价:照旧拦(手滑点了两下)", () => {
    expect(codes(run(recent({ limitPrice: 1.8, finalStatus: "filled" })))).toEqual(["DUPLICATE_ORDER"]);
    expect(codes(run(recent({ limitPrice: 1.8, finalStatus: "filled" }), 1.804))).toEqual(["DUPLICATE_ORDER"]); // 不到一分钱
  });

  it("任何一边没有写明的限价(AUTO_MID):说不清换没换价,照旧拦", () => {
    expect(codes(run(recent({ limitPrice: null, finalStatus: "cancelled" }), 1.6))).toEqual(["DUPLICATE_ORDER"]);
  });

  it("数量差得多的本来就不算重复", () => {
    expect(validator({}, null, recent({ limitPrice: 1.8, finalStatus: null, quantity: 5 })).validateOne(fly(1, 1.8))[0]).toEqual([]);
  });

  it("库里读出来的那一份带着限价与终态", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-recent-"));
    dirs.push(dir);
    const store = new TradeStore(path.join(dir, "t.db"));
    const record = (limit: number | null): string => store.createRecord({
      signature, order: { totalQuantity: 1, ...(limit === null ? {} : { lmtPrice: limit }) }, contract: { symbol: "SPX" },
      account: { account_id: "DU1" }, llm: {},
    });
    const working = record(1.8), done = record(1.6), auto = record(null);
    for (const id of [working, done, auto]) store.markSubmitIntent(id);
    store.setFinalStatus(done, "cancelled");
    const rows = store.risk.recentOrderDetails(10, Date.now());
    expect(rows.map((r) => [r.limitPrice, r.finalStatus])).toEqual([[null, null], [1.6, "cancelled"], [1.8, null]]);
    // 老接口的形状没变(黄金基线钉着)
    expect(Object.keys(store.recentOrders(10, Date.now())[0]!).sort()).toEqual(["createdAtMs", "quantity", "signature"]);
  });
});

// ---------------------------------------------------------------- 平仓识别与腿身份
describe("平仓识别:组合各腿写的是真实方向", () => {
  const held = [optRow("模拟", 7500, "C", 1, 900), optRow("模拟", 7520, "C", -1, 300)]; // 持有借方看涨价差

  it("卖出同一组行权价的看涨价差(卖低买高):两条腿都在减仓", () => {
    expect(reducesPositions(bearCall(1, 5), "模拟", held)).toBe(true);
  });

  it("数量超过持仓、方向是加仓、另一个账户:都不算平仓", () => {
    expect(reducesPositions(bearCall(2, 5), "模拟", held)).toBe(false);
    expect(reducesPositions(bearCall(1, 5), "主账户", held)).toBe(false);
    const add = parse({
      contract: { secType: "BAG", symbol: "SPX", combo_strategy: "VERTICAL", legs: [leg("BUY", 1, 7500), leg("SELL", 1, 7520)] },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 1, price_mode: "EXPLICIT", lmtPrice: 6, tif: "DAY", outsideRth: false },
    });
    expect(reducesPositions(add, "模拟", held)).toBe(false);
  });

  it("订单的腿身份和持仓行的写法一致(蝶、贷方价差、单腿、正股)", () => {
    const bag = (rows: Rec[]): string => String(tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!["leg"]);
    expect(orderLegId(fly(1, 2))).toBe(bag(heldFly(1)));
    expect(orderLegId(bearCall(1, 5))).toBe(bag([optRow("模拟", 7500, "C", -1, 1200), optRow("模拟", 7520, "C", 1, 400)]));
    const single = parse({
      contract: { secType: "OPT", symbol: "NVDA", lastTradeDateOrContractMonth: "20261016", strike: 180, right: "C", multiplier: "100" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 1, price_mode: "EXPLICIT", lmtPrice: 5.5, tif: "DAY", outsideRth: false },
    });
    expect(orderLegId(single)).toBe(optRow("模拟", 180, "C", 1, 550, "NVDA", "20261016")["leg"]);
    const stock = parse({
      contract: { secType: "STK", symbol: "AAPL" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 10, price_mode: "EXPLICIT", lmtPrice: 230, tif: "DAY", outsideRth: false },
    });
    expect(orderLegId(stock)).toBe("");
  });
});

// ---------------------------------------------------------------- 保护规则
describe("同标的冷却:按标的 / 按结构", () => {
  const NOW = TUESDAY.epochMs;
  const cfg = (scope: string): Rec => makeSettings(gv.base_config, { protections: { cooldown: { enabled: true, minutes: 30, scope } } }).protections;
  const flyLeg = orderLegId(fly(1, 2));
  const closes = [{ atMs: NOW - 5 * MIN, symbol: "SPX", state: "take_profit", leg: flyLeg }];

  it("按标的(默认):这只标的的一切新单都停", () => {
    const state = evaluateProtections(cfg("symbol") as any, closes, [], NOW);
    expect(protectionBlock(state, "SPX", NOW, { leg: "别的结构" })).toMatch(/^SPX 刚平过仓,冷却 30 分钟内不再下新单/);
    expect(protectionBlock(state, "NVDA", NOW)).toBeNull();
  });

  it("按结构:只停和刚平掉的那份持仓同一个结构的单,别的蝶照发", () => {
    const state = evaluateProtections(cfg("position") as any, closes, [], NOW);
    expect(Object.keys(state.cooldowns)).toEqual([cooldownKey("SPX", flyLeg)]);
    expect(protectionBlock(state, "SPX", NOW, { leg: flyLeg })).toMatch(/^SPX 的这一份持仓刚平过,冷却 30 分钟内不再开同样的仓/);
    expect(protectionBlock(state, "SPX", NOW, { leg: orderLegId(bearCall(1, 5)) })).toBeNull();
    expect(protectionBlock(state, "SPX", NOW)).toBeNull();
    // 给界面的摘要里标的还是标的
    expect(protectionsSummary(state, NOW).cooldowns.map((c) => c.symbol)).toEqual(["SPX"]);
  });

  it("带腿身份之前留下的痕(没有 leg):按结构冷却时只对正股那种空身份生效", () => {
    const state = evaluateProtections(cfg("position") as any, [{ atMs: NOW - MIN, symbol: "AAPL", state: "stop_loss" }], [], NOW);
    expect(protectionBlock(state, "AAPL", NOW, { leg: "" })).not.toBeNull();
    expect(protectionBlock(state, "AAPL", NOW, { leg: "20261016|230|C" })).toBeNull();
  });
});

describe("日内亏损上限:按账户当日盈亏", () => {
  const NOW = TUESDAY.epochMs;
  const cfg = (basis: string): Rec =>
    makeSettings(gv.base_config, { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis } } }).protections;

  it("只停亏到线的那个账户,停到美东零点;别的账户照发", () => {
    const state = evaluateProtections(cfg("account") as any, [], [], NOW, { 主账户: -620.5, 模拟: -100 });
    expect(state.pause).toBeNull();
    expect(Object.keys(state.accountPauses)).toEqual(["主账户"]);
    expect(state.accountPauses["主账户"]!.untilMs).toBe(etDayStart(NOW, 1));
    expect(protectionBlock(state, "SPX", NOW, { account: "主账户" })).toMatch(
      /^账户 主账户 今天的盈亏\(券商报的,含未平仓\)是 -620\.50 美元,到了日内亏损上限 500,今天这个账户不再下新单/,
    );
    expect(protectionBlock(state, "SPX", NOW, { account: "模拟" })).toBeNull();
    expect(protectionsSummary(state, NOW)).toMatchObject({ paused: false, accounts: [{ account: "主账户", until_ms: etDayStart(NOW, 1) }] });
  });

  it("正好到线算到线;赚着钱不算", () => {
    expect(Object.keys(evaluateProtections(cfg("account") as any, [], [], NOW, { 主账户: -500 }).accountPauses)).toEqual(["主账户"]);
    expect(evaluateProtections(cfg("account") as any, [], [], NOW, { 主账户: 800 }).accountPauses).toEqual({});
  });

  it("一个账户都没报:退回按已实现盈亏算的那一条(全局)", () => {
    const pnl = [{ atMs: NOW - MIN, pnl: -600 }];
    for (const daily of [null, {}]) {
      const state = evaluateProtections(cfg("account") as any, [], pnl, NOW, daily);
      expect(state.pause?.rule).toBe("daily_loss");
      expect(state.accountPauses).toEqual({});
    }
  });

  it("有的账户报了、有的没报:没报的那个退回已实现盈亏,不会两条都不查", () => {
    const pnl = [{ atMs: NOW - MIN, pnl: -900 }];
    // 模拟 报了、只亏 20;主账户 没报(基础货币不是美元 / 订阅还没来 / 数太旧)。引擎今天已实现亏 900
    const state = evaluateProtections(cfg("account") as any, [], pnl, NOW, { 模拟: -20 }, ["模拟", "主账户"]);
    expect(state.pause).toBeNull();
    expect(Object.keys(state.accountPauses)).toEqual(["主账户"]);
    expect(state.accountPauses["主账户"]!.reason).toContain("券商没有报当日盈亏,退回按已实现算");
    expect(protectionBlock(state, "SPX", NOW, { account: "主账户" })).not.toBeNull();
    expect(protectionBlock(state, "SPX", NOW, { account: "模拟" })).toBeNull();
    // 已实现没到线:没报的账户也不停
    expect(evaluateProtections(cfg("account") as any, [], [{ atMs: NOW - MIN, pnl: -100 }], NOW, { 模拟: -20 }, ["模拟", "主账户"]).accountPauses).toEqual({});
    // 都报了:不看已实现
    expect(evaluateProtections(cfg("account") as any, [], pnl, NOW, { 模拟: -20, 主账户: -30 }, ["模拟", "主账户"]).accountPauses).toEqual({});
  });

  it("口径是 realized 时不看券商报的数", () => {
    const state = evaluateProtections(cfg("realized") as any, [], [], NOW, { 主账户: -9999 });
    expect(state.pause).toBeNull();
    expect(state.accountPauses).toEqual({});
  });
});

// ---------------------------------------------------------------- 券商那两路数据
describe("账户当日盈亏与净值:会话(假的 @stoqey/ib)", () => {
  it("券商报的数:哨兵大数、空串、不是数都当没有", () => {
    expect(realNumber(1.7976931348623157e308)).toBeNull();
    expect(realNumber("")).toBeNull();
    expect(realNumber("abc")).toBeNull();
    expect(realNumber(null)).toBeNull();
    expect(realNumber("-12.5")).toBe(-12.5);
    expect(realNumber(0)).toBe(0);
  });

  it("没来第一笔是 null;来了之后带着账户的货币;只在美元时才给", async () => {
    const tws = new FakeTws();
    const session = await createIbApiNextSession(CFG, { mod: tws.mod() });
    const now = Date.now();
    expect(session.accountPnl!(ACCOUNT)).toBeNull();
    expect(session.netLiquidation!(ACCOUNT)).toBeNull();
    tws.pushPnl(ACCOUNT, { dailyPnL: -320.5, unrealizedPnL: -100, realizedPnL: 1.7976931348623157e308 });
    expect(session.accountPnl!(ACCOUNT)).toMatchObject({ daily: -320.5, unrealized: -100, realized: null, currency: "" });
    // 货币还没认出来:不当美元用
    expect(accountDailyPnl([session], ACCOUNT, now)).toBeNull();
    tws.pushNetLiq(ACCOUNT, "USD", "52340.12");
    expect(session.netLiquidation!(ACCOUNT)).toEqual({ amount: 52340.12, currency: "USD" });
    expect(accountNetLiquidation([session], ACCOUNT)).toBe(52340.12);
    expect(accountDailyPnl([session], ACCOUNT, now)).toBe(-320.5);
    // 太久没更新:不再当现在的数
    expect(accountDailyPnl([session], ACCOUNT, now + PNL_STALE_MS + 5000)).toBeNull();
    // 这条会话不管的账号
    expect(accountDailyPnl([session], "U0000000", now)).toBeNull();
    expect(accountNetLiquidation([session], "U0000000")).toBeNull();
  });

  it("基础货币不是美元的账户:两样都不给(拿港币的数去比美元的线是错的)", async () => {
    const tws = new FakeTws();
    const session = await createIbApiNextSession(CFG, { mod: tws.mod() });
    session.accountPnl!(ACCOUNT);
    tws.pushNetLiq(ACCOUNT, "HKD", "400000");
    tws.pushPnl(ACCOUNT, { dailyPnL: -5000 });
    expect(session.accountPnl!(ACCOUNT)).toMatchObject({ daily: -5000, currency: "HKD" });
    expect(accountDailyPnl([session], ACCOUNT, Date.now())).toBeNull();
    expect(accountNetLiquidation([session], ACCOUNT)).toBeNull();
  });
});

describe("AccountGuard:数从哪来、拿不到怎么办", () => {
  /** 一条假会话:管着配置里的两个账号,当日盈亏与净值照给 */
  const session = (pnl: Rec, equity: Rec): Rec => ({
    isConnected: () => true,
    managedAccounts: () => ["DU7654321", "U1234567"],
    accountPnl: (id: string) => (id in pnl ? { daily: pnl[id], unrealized: null, realized: null, currency: "USD", atMs: Date.now() } : null),
    netLiquidation: (id: string) => (id in equity ? { amount: equity[id], currency: "USD" } : null),
  });
  /** 一个假库:审计只记在内存里,在途单由测试塞 */
  const fakeStore = (working: Rec[] = []) => {
    const audits: Array<{ at: number; action: string; detail: Rec }> = [];
    return {
      audits, working,
      audit: (_actor: string, action: string, detail: Rec | null) => { audits.push({ at: clock.now, action, detail: detail ?? {} }); },
      risk: {
        workingOrders: () => working as any,
        dailyLossTrips: (sinceMs: number, nowMs: number) => audits
          .filter((a) => a.action === "daily_loss_trip" && a.at >= sinceMs && a.at <= nowMs)
          .map((a) => ({ alias: String(a.detail["alias"]), reason: String(a.detail["reason"]), untilMs: Number(a.detail["until_ms"]) })),
      },
    };
  };
  const clock = { now: TUESDAY.epochMs };
  const guard = (over: Rec, router: Rec | null, store = fakeStore()): AccountGuard =>
    new AccountGuard({ settings: makeSettings(gv.base_config, over), router: router as any, store });

  it("两条累计上限一条都没设:不读持仓;单笔风险预算没开:不问净值", async () => {
    let reads = 0;
    const router = { positions: async () => { reads += 1; return []; }, sessions: () => [session({}, { DU7654321: 50000 })] };
    expect(await guard({}, router).validatorExtras()).toEqual({});
    expect(reads).toBe(0);
  });

  it("设了上限(哪怕只在某个账户的覆盖里):读一次持仓,给出敞口与平仓识别", async () => {
    const router = { positions: async () => heldFly(2), sessions: () => [] };
    const extras = await guard({ limits: { by_account: { 模拟: { max_open_risk_usd: 2000 } } } }, router).validatorExtras();
    expect(extras.exposure!.riskUsd).toEqual({ 模拟: 900 });
    expect(typeof extras.isReduction).toBe("function");
  });

  it("读持仓报错 / 没连券商:敞口是 null(校验层据此拒)", async () => {
    const failing = { positions: async () => { throw new Error("读不到持仓"); }, sessions: () => [] };
    expect((await guard({ limits: { max_open_risk_usd: 2000 } }, failing).validatorExtras()).exposure).toBeNull();
    expect((await guard({ limits: { max_open_risk_usd: 2000 } }, null).validatorExtras()).exposure).toBeNull();
  });

  it("这一次读不到持仓:开仓的单照拒,平仓的单拿上一次读到的持仓认,照发", async () => {
    const state = { fail: false };
    const longSpread = [optRow("模拟", 7500, "C", 2, 1200), optRow("模拟", 7520, "C", -2, 400)];
    const router = { positions: async () => { if (state.fail) throw new Error("TWS 在 8 秒内没有推送持仓"); return longSpread; }, sessions: () => [] };
    const g = guard({ limits: { max_open_risk_usd: 5000 } }, router);
    await g.validatorExtras();                       // 先读到过一次
    state.fail = true;
    const extras = await g.validatorExtras();
    expect(extras.exposure).toBeNull();
    const v = validator({ limits: { max_open_risk_usd: 5000 } }, extras);
    expect(v.validateOne(bearCall(2, 8))[0]).toEqual([]);                         // 卖出持有的那 2 组价差:平仓
    expect(codes(validator({ limits: { max_open_risk_usd: 5000 } }, extras).validateOne(fly(1, 2))[0])).toEqual(["UNPRICEABLE"]);
    // 从没读到过持仓的引擎:认不出平仓,一律按读不到拒
    const cold = await guard({ limits: { max_open_risk_usd: 5000 } }, { ...router }).validatorExtras();
    expect(cold.isReduction).toBeUndefined();
  });

  it("今天发出去还没有终态的开仓单算进在手:连发两张各自合规的单,第二张看得见第一张", async () => {
    const resting = { alias: "模拟", contract: fly(1, 2).contract, order: fly(1, 2).order, notional: 200 };
    const router = { positions: async () => [], sessions: () => [] };
    const caps = { limits: { max_open_risk_usd: 300, max_underlying_contracts: 1 } };
    const extras = await guard(caps, router, fakeStore([resting])).validatorExtras();
    expect(extras.exposure!.riskUsd).toEqual({ 模拟: 200 });
    expect(extras.exposure!.contracts).toEqual({ [contractsKey("模拟", "SPX", EXPIRY)]: 1 });
    const issues = validator(caps, extras).validateOne(fly(1, 2))[0];
    expect(codes(issues)).toEqual(["EXCEEDS_LIMIT", "EXCEEDS_LIMIT"]);
    // 没有在途单时同一张单是过的
    expect(validator(caps, await guard(caps, router).validatorExtras()).validateOne(fly(1, 2))[0]).toEqual([]);
  });

  it("在途的平仓单不算进在手(它在减仓,不是加仓);正股的在途单也不算", async () => {
    const longSpread = [optRow("模拟", 7500, "C", 2, 1200), optRow("模拟", 7520, "C", -2, 400)];
    const closing = { alias: "模拟", contract: bearCall(2, 8).contract, order: bearCall(2, 8).order, notional: 2400 };
    const stock = { alias: "模拟", contract: { secType: "STK", symbol: "BE" }, order: { action: "BUY", totalQuantity: 100 }, notional: 9000 };
    const out = withWorkingOrders(openRisk(longSpread), [closing, stock] as any, longSpread);
    expect(out.riskUsd).toEqual({ 模拟: 1600 });
    expect(out.contracts).toEqual({ [contractsKey("模拟", "SPX", EXPIRY)]: 2 });
  });

  it("同一句话里两张减仓的单:第二张对着扣过的持仓判——持有 2 组,卖 2 组再卖 1 组,后一张不是平仓", async () => {
    const longSpread = [optRow("模拟", 7500, "C", 2, 1200), optRow("模拟", 7520, "C", -2, 400)];
    const router = { positions: async () => longSpread, sessions: () => [] };
    const caps = { limits: { max_open_risk_usd: 1700, max_underlying_contracts: 2 } };
    const v = validator(caps, await guard(caps, router).validatorExtras());
    expect(v.validateOne(bearCall(2, 8))[0]).toEqual([]);                 // 平掉全部 2 组
    const second = v.validateOne(bearCall(1, 8.2))[0];                    // 再卖 1 组:这是新开一组贷方价差
    expect(codes(second)).toEqual(["EXCEEDS_LIMIT", "EXCEEDS_LIMIT"]);
    expect(longSpread.map((r) => r["quantity"])).toEqual([2, -2]);        // 传进去的持仓行没有被改
  });

  it("富途:读不出期权持仓,累计上限不查,订单的警告里照实说", async () => {
    let reads = 0;
    const router = { BROKER: "futu", positions: async () => { reads += 1; return []; }, sessions: () => [] };
    const caps = { limits: { max_open_risk_usd: 100 } };
    const extras = await guard(caps, router).validatorExtras();
    expect(reads).toBe(0);
    expect(extras.exposure).toBeUndefined();
    const [issues, approved] = validator(caps, extras).validateOne(fly(1, 2));
    expect(issues).toEqual([]);
    expect(approved!.warnings.join("")).toContain("富途通道读不出期权持仓,这个账户的累计上限(在手风险 / 同标的张数)没有核对。");
  });

  it("单笔风险预算开着:券商报了净值的账户带上;富途的会话不问", async () => {
    const router = { positions: async () => [], sessions: () => [session({}, { DU7654321: 50000 })] };
    expect((await guard({ risk_budget: { enabled: true } }, router).validatorExtras()).equity).toEqual({ 模拟: 50000 });
    expect((await guard({ risk_budget: { enabled: true } }, { ...router, BROKER: "futu" }).validatorExtras()).equity).toBeUndefined();
  });

  it("校验层:人填的权益优先,没填的账户用券商报的", () => {
    const over = { risk_budget: { enabled: true, equity_usd: { 模拟: 0 }, max_risk_pct: 2 } };
    const [, approved] = validator(over, { equity: { 模拟: 5000 } }).validateOne(fly(1, 2));
    expect(approved!.warnings.join("")).toContain("占 模拟 权益 $5000.00 的 4%");
    const manual = { risk_budget: { enabled: true, equity_usd: { 模拟: 100000 }, max_risk_pct: 2 } };
    expect(validator(manual, { equity: { 模拟: 5000 } }).validateOne(fly(1, 2))[1]!.warnings.join("")).not.toContain("单笔风险");
  });

  it("当日盈亏:规则没开、口径不是 account、没人报:null;报了的按别名给", () => {
    const router = { positions: async () => [], sessions: () => [session({ U1234567: -620 }, {})] };
    const on = { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis: "account" } } };
    expect(guard(on, router).dailyPnl(Date.now())).toEqual({ 主账户: -620 });
    expect(guard({ protections: { daily_loss: { enabled: true, max_loss_usd: 500 } } }, router).dailyPnl(Date.now())).toBeNull();
    expect(guard({ protections: { daily_loss: { enabled: false, basis: "account" } } }, router).dailyPnl(Date.now())).toBeNull();
    expect(guard(on, { ...router, sessions: () => [session({}, {})] }).dailyPnl(Date.now())).toBeNull();
    expect(guard(on, null).dailyPnl(Date.now())).toBeNull();
  });

  it("今天到过线的账户:浮亏收回去一点也不放开,过了美东零点才放", () => {
    const NOW = TUESDAY.epochMs;
    const cfg = makeSettings(gv.base_config, { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis: "account" } } }).protections;
    const g = guard({}, null);
    const hit = g.withLatch(evaluateProtections(cfg, [], [], NOW, { 主账户: -600 }), NOW);
    expect(Object.keys(hit.accountPauses)).toEqual(["主账户"]);
    const later = g.withLatch(evaluateProtections(cfg, [], [], NOW + 5 * MIN, { 主账户: -450 }), NOW + 5 * MIN);
    expect(protectionBlock(later, "SPX", NOW + 5 * MIN, { account: "主账户" })).not.toBeNull();
    const tomorrow = etDayStart(NOW, 1) + MIN;
    const next = g.withLatch(evaluateProtections(cfg, [], [], tomorrow, { 主账户: -10 }), tomorrow);
    expect(next.accountPauses).toEqual({});
  });

  it("到过线这件事记在库里:引擎重建(改设置、重连都会重建)之后照样不放开;只记一次", () => {
    const NOW = TUESDAY.epochMs;
    clock.now = NOW;
    const cfg = makeSettings(gv.base_config, { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis: "account" } } }).protections;
    const store = fakeStore();
    const first = guard({}, null, store);
    first.withLatch(evaluateProtections(cfg, [], [], NOW, { 主账户: -600 }), NOW);
    first.withLatch(evaluateProtections(cfg, [], [], NOW + MIN, { 主账户: -620 }), NOW + MIN);
    expect(store.audits.filter((a) => a.action === "daily_loss_trip")).toHaveLength(1);
    // 新的引擎、同一个库:浮亏已经收回去了,仍然停着
    const rebuilt = guard({}, null, store);
    const later = rebuilt.withLatch(evaluateProtections(cfg, [], [], NOW + 5 * MIN, { 主账户: -450 }), NOW + 5 * MIN);
    expect(protectionBlock(later, "SPX", NOW + 5 * MIN, { account: "主账户" })).toContain("到了日内亏损上限");
    expect(protectionBlock(later, "SPX", NOW + 5 * MIN, { account: "模拟" })).toBeNull();
    // 第二天不带过去
    const tomorrow = etDayStart(NOW, 1) + MIN;
    expect(guard({}, null, store).withLatch(evaluateProtections(cfg, [], [], tomorrow, { 主账户: -10 }), tomorrow).accountPauses).toEqual({});
  });
});

// ---------------------------------------------------------------- 接进引擎
describe("接进引擎:一条指令走完整条链", () => {
  /** 模型回的那张单:买入 1 张 7725/7750/7775 看涨蝶,净权利金 price */
  const payload = (price: number): Rec => ({
    intent_summary: "买入 1 张 SPX 7725/7750/7775 看涨蝶", execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
    contract: { secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD", combo_strategy: "BUTTERFLY",
      legs: [leg("BUY", 1, 7725), leg("SELL", 2, 7750), leg("BUY", 1, 7775)] },
    order: { action: "BUY", orderType: "LMT", totalQuantity: 1, price_mode: "EXPLICIT", lmtPrice: price, tif: "DAY", outsideRth: false },
    reason: "回归", confidence: 0.99, warnings: [],
  });

  function build(over: Rec, held: Rec[] = [], pnl: Rec = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-acct-"));
    dirs.push(dir);
    const settings = makeSettings(gv.base_config, {
      storage: { db_path: path.join(dir, "a.db") }, policies: { auto_execute: true }, ...over,
    });
    const state = { price: 2.0, orderId: 500 };
    const parser = {
      async parse(): Promise<LLMResponse> {
        return new LLMResponse(JSON.stringify({ orders: [payload(state.price)], rejections: [] }), "claude-opus-5", "v", "f", 1);
      },
    };
    const placed: Rec[] = [];
    const router = {
      BROKER: "ibkr", SUPPORTS_HOSTED_CLOSE: false, SUPPORTS_NATIVE_CONDITIONS: true,
      indexPrice: async () => 7740,
      place: async (recordId: string, approved: Rec) => {
        placed.push(approved);
        state.orderId += 1;
        return { record_id: recordId, order_id: state.orderId, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
      },
      legQuotes: async () => [],
      positions: async () => held,
      sessions: () => [{
        isConnected: () => true, managedAccounts: () => ["DU7654321"],
        accountPnl: (id: string) => (id in pnl ? { daily: pnl[id], unrealized: null, realized: null, currency: "USD", atMs: Date.now() } : null),
        netLiquidation: () => null,
      }],
      cancelAllOpen: async () => 0,
    };
    const engine = new TradingEngine({
      settings, parser: parser as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any,
    });
    return { engine, placed, state };
  }
  const send = (engine: TradingEngine) => engine.handleInstruction("买入 SPX 7725/7750/7775 看涨蝶 限价", "manual", TUESDAY);

  it("在手风险上限:账户上已经压着 3 组蝶,再来一张超线就拒,不发单", async () => {
    const { engine, placed } = build({ limits: { max_open_risk_usd: 1500 } }, heldFly(3));
    const result = await send(engine);
    expect(placed).toEqual([]);
    expect(result.rejections.map((r) => [r.source, r.code])).toEqual([["validator", "EXCEEDS_LIMIT"]]);
    expect(result.rejections[0]!.message).toContain("在手期权的最坏亏损合计约 1350.00 USD");
  });

  it("在手风险上限把还挂着的单算进去:第一张发出去没成交,第二张(换了中心也一样)看得见它", async () => {
    vi.useFakeTimers({ now: TUESDAY.epochMs, toFake: ["Date"] });
    const { engine, placed, state } = build({ limits: { max_open_risk_usd: 300, duplicate_window_minutes: 0 } });
    await send(engine);                                  // 200 美元,挂着
    expect(placed).toHaveLength(1);
    state.price = 1.9;
    const second = await send(engine);
    expect(placed).toHaveLength(1);
    expect(second.rejections[0]!.message).toContain("在手期权的最坏亏损合计约 200.00 USD,加上这一单 190.00 USD");
    // 第一张撤掉之后:不再算在手
    engine.onOrderStatus({ order: { orderId: 501 }, orderStatus: { status: "Cancelled", filled: 0, remaining: 1 } });
    await send(engine);
    expect(placed).toHaveLength(2);
  });

  it("排队中的平仓条件单:日内亏损暂停期间到价照发(保护规则只挡新单);同样排着的开仓单不发", async () => {
    const daily = { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis: "account" } } };
    const longSpread = [optRow("模拟", 7500, "C", 1, 1200), optRow("模拟", 7520, "C", -1, 400)];
    const { engine, placed } = build(daily, longSpread, { DU7654321: -640 });
    (engine.router as any).legQuotes = async (contract: Rec) => (contract["legs"] as Rec[]).map((l) => (
      l["action"] === "SELL" ? { action: "SELL", ratio: 1, bid: 12.0, ask: 12.4 } : { action: "BUY", ratio: 1, bid: 4.0, ask: 4.3 }));
    const account = engine.settings.accounts.find((a) => a.alias === "模拟")!;
    const queue = (order: ParsedOrder): string => {
      const recordId = engine.store.createRecord({ signature: "q", account: { alias: "模拟" }, contract: order.contract, order: order.order });
      engine.pendingTriggers.push({
        record_id: recordId, fired: false, created_at: new Date().toISOString(),
        trigger: { symbol: "SPX", operator: "<=", value: 7700 } as any,
        approved: { order, account, notional: 0, signature: "q", warnings: [] } as any,
      });
      return recordId;
    };
    const closing = bearCall(1, 8);        // 卖 7500C、买 7520C:正好平掉持有的那组
    closing.order.price_mode = "AUTO_MID";
    closing.order.lmtPrice = null;
    queue(fly(1, 2));                      // 开仓:该被挡着
    queue(closing);
    const fired = await engine.firePending({ SPX: 7690 });
    expect(fired).toHaveLength(1);
    expect(placed).toHaveLength(1);
    expect(placed[0]!["order"].contract.combo_strategy).toBe("VERTICAL");
    expect(engine.pendingTriggers).toHaveLength(1);       // 开仓的那张还排着
  });

  it("没设上限:照发(引擎不为它读持仓)", async () => {
    const { engine, placed } = build({}, heldFly(3));
    await send(engine);
    expect(placed).toHaveLength(1);
  });

  it("重复单:第一张还挂着时换个价再发,拦;第一张撤了之后换价再发,放行", async () => {
    // 记录的落库时刻用的是真钟:把钟拨到指令的那一刻,防抖窗口才对得上(只假 Date,不动定时器)
    vi.useFakeTimers({ now: TUESDAY.epochMs, toFake: ["Date"] });
    const { engine, placed, state } = build({});
    await send(engine);
    expect(placed).toHaveLength(1);
    state.price = 2.2;
    const blocked = await send(engine);
    expect(blocked.rejections[0]!.code).toBe("DUPLICATE_ORDER");
    expect(blocked.rejections[0]!.message).toContain("还没有终态");
    engine.onOrderStatus({ order: { orderId: 501 }, orderStatus: { status: "Cancelled", filled: 0, remaining: 1 } });
    await send(engine);
    expect(placed).toHaveLength(2);
    expect(placed[1]!["order"].order.lmtPrice).toBe(2.2);
  });

  it("冷却按结构:刚平掉的是同一只蝶 → 停在仅校验;刚平掉的是别的结构 → 照发", async () => {
    const cool = { protections: { cooldown: { enabled: true, minutes: 30, scope: "position" } } };
    const same = build(cool);
    same.engine.store.audit("engine", "auto_close", { track: "t1", symbol: "SPX", leg: orderLegId(fly(1, 2)), state: "take_profit" });
    const held = await send(same.engine);
    expect(same.placed).toEqual([]);
    expect(held.validated_only).toHaveLength(1);

    const other = build(cool);
    other.engine.store.audit("engine", "auto_close", { track: "t1", symbol: "SPX", leg: orderLegId(bearCall(1, 5)), state: "take_profit" });
    await send(other.engine);
    expect(other.placed).toHaveLength(1);
  });

  it("日内亏损上限按账户当日盈亏:券商报这个账户今天亏到线 → 新单停在仅校验", async () => {
    const daily = { protections: { daily_loss: { enabled: true, max_loss_usd: 500, basis: "account" } } };
    const hit = build(daily, [], { DU7654321: -640 });
    const result = await send(hit.engine);
    expect(hit.placed).toEqual([]);
    expect(result.validated_only).toHaveLength(1);
    expect(JSON.stringify(hit.engine.store.listRecords(5)[0]!["post_warnings"])).toContain("账户 模拟 今天的盈亏(券商报的,含未平仓)是 -640.00 美元");

    const fine = build(daily, [], { DU7654321: -120 });
    await send(fine.engine);
    expect(fine.placed).toHaveLength(1);
  });
});
