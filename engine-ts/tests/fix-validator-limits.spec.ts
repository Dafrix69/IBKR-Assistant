/** 校验层审计修复的回归(2026-09-27):每一条都是"解析出来的单和用户要的不是同一张"或"限额被绕过"。
 *
 * V1 名义金额只认真正的价格:TRAIL 的 auxPrice 是回撤额、STP 的触发价与卖出限价都不是成交价上限。
 * V2 期权/组合乘数只认 100:模型给的 multiplier 只有校验层在用,券商那边根本看不到它。
 * V4 不替用户换结算方式:显式 SPXW(PM)在月度那个周四也原样保留;组合各腿交易类必须一致。
 * V7 is_paper 没写 = 按实盘处理(实盘闸门生效),字符串 "false" 不再被当成 true。
 */
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { etNowFromEpoch } from "../src/config.js";
import { ParsedOrderSchema, multiplierValue } from "../src/models.js";
import type { ParsedOrder } from "../src/models.js";
import { Validator } from "../src/validator.js";
import type { ValidationIssue } from "../src/validator.js";
import { loadGolden, makeSettings } from "./util.js";

const gv = loadGolden("validator");
// 限额按默认配置口径钉死,不随黄金基线的 base_config 漂
const LIMITS = { limits: { max_order_notional: 5000, max_option_contracts: 5, max_mkt_shares: 200 } };
const TUESDAY: EtNow = etNowFromEpoch(Date.parse("2026-09-29T15:00:00Z")); // 周二 11:00 美东,盘中
const MONTHLY_THU: EtNow = etNowFromEpoch(Date.parse("2026-10-15T15:00:00Z")); // 10 月第三个周五的前一天

function parse(raw: Record<string, unknown>): ParsedOrder {
  return ParsedOrderSchema.parse({
    intent_summary: "测试", execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
    reason: "回归", confidence: 0.99, ...raw,
  });
}

function check(
  order: ParsedOrder, snapshot: Record<string, number> = {}, now: EtNow = TUESDAY,
  over: Record<string, unknown> = LIMITS,
): { issues: ValidationIssue[]; notional: number | null; warnings: string[] } {
  const v = new Validator(makeSettings(gv.base_config, over), now, snapshot, []);
  const [issues, approved] = v.validateOne(order);
  return { issues, notional: approved?.notional ?? null, warnings: approved?.warnings ?? [] };
}

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);
const stk = (order: Record<string, unknown>): ParsedOrder =>
  parse({ contract: { secType: "STK", symbol: "AAPL" }, order });
const opt = (order: Record<string, unknown>, contract: Record<string, unknown> = {}): ParsedOrder =>
  parse({
    contract: {
      secType: "OPT", symbol: "NVDA", lastTradeDateOrContractMonth: "20261016", strike: 180, right: "C",
      ...contract,
    },
    order,
  });

const VERTICAL_LEGS = [
  { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20261016", strike: 7500, right: "C" },
  { action: "SELL", ratio: 1, lastTradeDateOrContractMonth: "20261016", strike: 7530, right: "C" },
];

describe("V1 名义金额只认真正的价格", () => {
  it("TRAIL 的 auxPrice 是回撤额:BUY 2000 股按现价 230 计 46 万,超限", () => {
    const r = check(stk({ action: "BUY", orderType: "TRAIL", totalQuantity: 2000, auxPrice: 2 }), { AAPL: 230 });
    expect(codes(r.issues)).toEqual(["EXCEEDS_LIMIT"]);
    expect(r.issues[0]?.message).toContain("460000.00");
  });

  it("TRAIL 没有现价快照:不拿回撤额冒充价格,退回股数上限", () => {
    const r = check(stk({ action: "SELL", orderType: "TRAIL", totalQuantity: 1000, auxPrice: 2 }));
    expect(codes(r.issues)).toEqual(["EXCEEDS_LIMIT"]);
    expect(r.issues[0]?.message).toContain("200");
  });

  it("买入止损价低于现价(立刻触发成市价单):按现价算,不按触发价", () => {
    const r = check(stk({ action: "BUY", orderType: "STP", totalQuantity: 4000, auxPrice: 1 }), { AAPL: 230 });
    expect(codes(r.issues)).toEqual(["EXCEEDS_LIMIT"]);
    expect(r.issues[0]?.message).toContain("920000.00");
  });

  it("卖出限价远低于现价(可立即成交):按现价算", () => {
    const r = check(stk({ action: "SELL", orderType: "LMT", totalQuantity: 1000, lmtPrice: 4 }), { AAPL: 230 });
    expect(codes(r.issues)).toEqual(["EXCEEDS_LIMIT"]);
    expect(r.issues[0]?.message).toContain("230000.00");
  });

  it("买入限价是成交价的硬上限:现价更高也按限价算(对照)", () => {
    const r = check(stk({ action: "BUY", orderType: "LMT", totalQuantity: 10, lmtPrice: 230 }), { AAPL: 500 });
    expect(r.issues).toEqual([]);
    expect(r.notional).toBe(2300);
  });

  it("买入 STP LMT 按限价算", () => {
    const r = check(
      stk({ action: "BUY", orderType: "STP LMT", totalQuantity: 10, auxPrice: 250, lmtPrice: 251 }), { AAPL: 230 },
    );
    expect(r.issues).toEqual([]);
    expect(r.notional).toBe(2510);
  });

  it("单腿期权买入 TRAIL / STP 没有限价:拒绝(UNPRICEABLE),不拿回撤额或触发价当权利金", () => {
    for (const order of [
      { action: "BUY", orderType: "TRAIL", totalQuantity: 5, auxPrice: 0.5 },
      { action: "BUY", orderType: "STP", totalQuantity: 1, auxPrice: 2 },
    ]) {
      const r = check(opt(order));
      expect(codes(r.issues), JSON.stringify(order)).toEqual(["UNPRICEABLE"]);
      expect(r.issues[0]?.message).toContain("止损限价");
    }
  });

  it("单腿期权买入 STP LMT 按限价算权利金", () => {
    const r = check(opt({ action: "BUY", orderType: "STP LMT", totalQuantity: 1, auxPrice: 2, lmtPrice: 2.5 }));
    expect(r.issues).toEqual([]);
    expect(r.notional).toBe(250);
  });
});

describe("V2 期权与组合的乘数只认 100", () => {
  it("组合顶层乘数写成 1:拒绝,不按 1 倍算限额", () => {
    const order = parse({
      contract: { secType: "BAG", symbol: "SPX", combo_strategy: "VERTICAL", legs: VERTICAL_LEGS, multiplier: "1" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 5, lmtPrice: 20 },
    });
    const r = check(order);
    expect(codes(r.issues)).toContain("UNSUPPORTED");
    expect(r.issues.map((i) => i.message).join(" ")).toContain("乘数");
    expect(r.notional).toBeNull();
  });

  it("某一条腿的乘数不是 100:拒绝", () => {
    const legs = [VERTICAL_LEGS[0], { ...VERTICAL_LEGS[1], multiplier: "10" }];
    const order = parse({
      contract: { secType: "BAG", symbol: "SPX", combo_strategy: "VERTICAL", legs },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 1, lmtPrice: 2 },
    });
    expect(codes(check(order).issues)).toContain("UNSUPPORTED");
  });

  it("单腿期权乘数空串:归一成 \"100\",按 100 倍算出 3 万超限", () => {
    const order = opt({ action: "BUY", orderType: "LMT", totalQuantity: 5, lmtPrice: 60 }, { multiplier: "" });
    expect(order.contract.multiplier).toBe("100");
    const r = check(order);
    expect(codes(r.issues)).toEqual(["EXCEEDS_LIMIT"]);
    expect(r.issues[0]?.message).toContain("30000.00");
  });

  it("组合腿乘数空串同样归一成 \"100\"(发给券商的腿合约带的就是它)", () => {
    const legs = [VERTICAL_LEGS[0], { ...VERTICAL_LEGS[1], multiplier: " " }];
    const order = parse({
      contract: { secType: "BAG", symbol: "SPX", combo_strategy: "VERTICAL", legs, multiplier: "" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 1, lmtPrice: 2 },
    });
    expect(order.contract.multiplier).toBe("100");
    expect((order.contract.legs ?? []).map((l) => l.multiplier)).toEqual(["100", "100"]);
    expect(check(order).issues).toEqual([]);
  });

  it("卖出 Put 乘数写成 0:拒绝,不会算出 0 敞口", () => {
    const order = opt({ action: "SELL", orderType: "LMT", totalQuantity: 5, lmtPrice: 3 }, { right: "P", multiplier: "0" });
    expect(codes(check(order).issues)).toContain("UNSUPPORTED");
  });

  it("multiplierValue 永远不回 0 或负数", () => {
    for (const m of ["", "0", "-100", "abc"]) expect(multiplierValue({ multiplier: m }), m).toBe(100);
    expect(multiplierValue({ multiplier: "100" })).toBe(100);
  });
});

const FLY = (tradingClass: string | null): Record<string, unknown> => ({
  secType: "BAG", symbol: "SPX", combo_strategy: "BUTTERFLY",
  legs: [
    { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20261015", strike: 6600, right: "C", tradingClass },
    { action: "SELL", ratio: 2, lastTradeDateOrContractMonth: "20261015", strike: 6615, right: "C", tradingClass },
    { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20261015", strike: 6630, right: "C", tradingClass },
  ],
});
const FLY_ORDER = { action: "BUY", orderType: "LMT", totalQuantity: 1, lmtPrice: 1.8 };

describe("V4 不替用户换结算方式", () => {
  it("月度那个周四,显式 SPXW(当日 PM 结算)原样保留", () => {
    const order = parse({ contract: FLY("SPXW"), order: FLY_ORDER });
    const r = check(order, {}, MONTHLY_THU);
    expect(r.issues).toEqual([]);
    expect((order.contract.legs ?? []).map((l) => l.tradingClass)).toEqual(["SPXW", "SPXW", "SPXW"]);
    expect(r.warnings.some((w) => w.includes("tradingClass"))).toBe(false);
  });

  it("小写 spxw 也认作日到期类,不被改成月度", () => {
    const order = parse({ contract: FLY("spxw"), order: FLY_ORDER });
    check(order, {}, MONTHLY_THU);
    expect((order.contract.legs ?? []).map((l) => l.tradingClass)).toEqual(["SPXW", "SPXW", "SPXW"]);
  });

  it("没写交易类:照旧按到期日判定(月度那天 → SPX)并告警", () => {
    const order = parse({ contract: FLY(null), order: FLY_ORDER });
    const r = check(order, {}, MONTHLY_THU);
    expect((order.contract.legs ?? []).map((l) => l.tradingClass)).toEqual(["SPX", "SPX", "SPX"]);
    expect(r.warnings.some((w) => w.includes("复核为 'SPX'"))).toBe(true);
  });

  it("月度类写在不可能的日子(第三个周五):照旧纠正为 SPXW 并告警", () => {
    const legs = (FLY("SPX")["legs"] as Array<Record<string, unknown>>)
      .map((l) => ({ ...l, lastTradeDateOrContractMonth: "20261016" }));
    const order = parse({ contract: { ...FLY("SPX"), legs }, order: FLY_ORDER });
    const r = check(order, {}, MONTHLY_THU);
    expect((order.contract.legs ?? []).map((l) => l.tradingClass)).toEqual(["SPXW", "SPXW", "SPXW"]);
    expect(r.warnings.some((w) => w.includes("复核为 'SPXW'"))).toBe(true);
  });

  it("组合各腿交易类不一致(AM/PM 混在一张单里):拒绝", () => {
    const legs = (FLY("SPX")["legs"] as Array<Record<string, unknown>>)
      .map((l, i) => (i === 0 ? { ...l, tradingClass: "SPXW" } : l));
    const order = parse({ contract: { ...FLY("SPX"), legs }, order: FLY_ORDER });
    const r = check(order, {}, MONTHLY_THU);
    expect(codes(r.issues)).toEqual(["BAD_SPREAD"]);
    expect(r.issues[0]?.message).toContain("结算");
  });
});

describe("V7 is_paper 缺省按实盘处理", () => {
  const ACCTS = (live: Record<string, unknown>): Record<string, unknown> => ({
    accounts: [
      { alias: "模拟", account_id: "DU7654321", is_paper: true, connection: "paper", default: true },
      { alias: "主账户", account_id: "U1234567", connection: "live", ...live },
    ],
  });
  const toLive = (): ParsedOrder =>
    parse({ contract: { secType: "STK", symbol: "AAPL" }, account: "主账户",
      order: { action: "BUY", orderType: "LMT", totalQuantity: 10, lmtPrice: 230 } });

  it("没写 is_paper:按实盘处理,实盘闸门拦下,并给出配置提示", () => {
    const settings = makeSettings(gv.base_config, ACCTS({}));
    expect(settings.accountByAlias("主账户")?.is_paper).toBe(false);
    expect(settings.config_warnings.join(" ")).toContain("is_paper");
    const r = check(toLive(), {}, TUESDAY, { ...LIMITS, ...ACCTS({}) });
    expect(codes(r.issues)).toEqual(["LIVE_TRADING_DISABLED"]);
    expect(r.issues[0]?.message).toContain("is_paper");
  });

  it("字符串 \"false\" / \"true\" 按字面意思解析", () => {
    expect(makeSettings(gv.base_config, ACCTS({ is_paper: "false" })).accountByAlias("主账户")?.is_paper).toBe(false);
    expect(makeSettings(gv.base_config, ACCTS({ is_paper: "true" })).accountByAlias("主账户")?.is_paper).toBe(true);
    expect(makeSettings(gv.base_config, ACCTS({ is_paper: false })).accountByAlias("主账户")?.is_paper).toBe(false);
    expect(makeSettings(gv.base_config, ACCTS({ is_paper: false })).config_warnings).toEqual([]);
  });

  it("认不出的值(1、\"yes\")直接报错,不猜", () => {
    expect(() => makeSettings(gv.base_config, ACCTS({ is_paper: 1 }))).toThrowError(/is_paper/);
    expect(() => makeSettings(gv.base_config, ACCTS({ is_paper: "yes" }))).toThrowError(/is_paper/);
  });
});
