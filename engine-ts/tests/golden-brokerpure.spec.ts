/** 黄金对拍:broker 纯函数(定价数学 / parity 反推 / 助手)。 */
import { describe, expect, it } from "vitest";

import {
  BrokerError, DEFAULT_COMBO_TICK, LegQuote, alignTickDown, alignTickUp, autoMidLimit,
  bagSignedLimit, barTimestamp, barsError, bookLiquidity,
  comboMidPrice, pickTradingClass, priceConditionSpec, strikeWidth,
} from "../src/broker.js";
import {
  ORDER_STATUS, OPEN_STATUS, accId, barTime, durationDays, fieldOf, futuDate, impliedSpot,
  ivOf, plainDate, quoteError,
} from "../src/futuBroker.js";
import { ParsedOrderSchema } from "../src/models.js";
import { expectSame, loadGolden } from "./util.js";

const g = loadGolden("broker");

describe("golden: broker 纯函数", () => {
  it("combo_mid_price(含坏盘口守卫)", () => {
    for (const c of g.combo_mid) {
      const legs: LegQuote[] = c.legs.map(([action, ratio, bid, ask]: any[]) => ({
        action, ratio, bid: bid === null ? NaN : bid, ask: ask === null ? NaN : ask,
      }));
      if (c.error !== undefined) {
        expect(() => comboMidPrice(legs), c.name).toThrowError(BrokerError);
        try {
          comboMidPrice(legs);
        } catch (exc) {
          expect((exc as Error).message, c.name).toBe(c.error);
        }
      } else {
        expect(comboMidPrice(legs), c.name).toBeCloseTo(c.expect, 9);
      }
    }
  });

  it("最小价格变动:限价必须落在合法档位上", () => {
    // 不对齐的后果是下单当场被拒(IBKR 110)。2026-09-04 实测:0.1750 是 3.5 个 tick。
    expect(DEFAULT_COMBO_TICK).toBe(g.combo_tick);
    for (const c of g.align_tick) {
      expect(alignTickUp(c.value), `up ${c.value}`).toBeCloseTo(c.up, 9);
      expect(alignTickDown(c.value), `down ${c.value}`).toBeCloseTo(c.down, 9);
    }
  });

  it("auto_mid_limit(方向守卫与宽度上限)", () => {
    for (const c of g.auto_mid_limit) {
      const [mid, action, slippage, width] = c.args;
      const midValue = mid === "nan" ? NaN : mid;
      if (c.error !== undefined) {
        try {
          autoMidLimit(midValue, action, slippage, width ?? null);
          throw new Error(`${c.name}: 应当拒绝`);
        } catch (exc) {
          expect((exc as Error).message, c.name).toBe(c.error);
        }
      } else {
        expect(autoMidLimit(midValue, action, slippage, width ?? null), c.name).toBeCloseTo(
          c.expect, 9,
        );
      }
    }
  });

  it("bag_signed_limit / book_liquidity / strike_width", () => {
    for (const c of g.bag_signed_limit) {
      expect(bagSignedLimit(c.action, c.limit)).toBe(c.expect);
    }
    for (const c of g.book_liquidity) {
      expectSame(bookLiquidity(c.book), c.expect, `book(${c.name})`);
    }
    for (const c of g.strike_width) {
      const order = ParsedOrderSchema.parse(c.payload);
      expect(strikeWidth(order.contract), c.name).toBe(c.expect);
    }
  });

  it("price_condition_spec / bar_timestamp / bars_error", () => {
    const trig = ParsedOrderSchema.parse({
      ...g.strike_width[0].payload, trigger: g.price_condition.trigger,
    }).trigger!;
    expectSame(priceConditionSpec(trig), g.price_condition.expect, "price_condition");
    for (const c of g.bar_timestamp) {
      expect(barTimestamp(c.raw), c.raw).toBe(c.expect);
    }
    for (const c of g.helpers.bars_error) {
      const symbol = c.in.includes("162") ? "SPX" : "AAPL";
      const label = c.in.includes("162") ? "5 分钟" : "日线";
      expect(barsError(symbol, label, new Error(c.in))).toBe(c.out);
    }
  });

  it("implied_spot:平价拟合精确还原,脏报价/样本不足/零斜率拒绝", () => {
    for (const c of g.parity) {
      const pairs = c.pairs.map((p: number[]) => [p[0], p[1], p[2]] as [number, number, number]);
      if (c.error !== undefined) {
        try {
          impliedSpot(pairs);
          throw new Error(`${c.name}: 应当拒绝`);
        } catch (exc) {
          expect((exc as Error).message, c.name).toBe(c.error);
        }
      } else {
        expectSame(impliedSpot(pairs), c.expect, `parity(${c.name})`);
        // 干净报价必须精确还原到 1e-6(Python 单测同一条断言)
        expect(Math.abs(c.expect.spot - 7500.0)).toBeLessThan(1e-6);
      }
    }
  });

  it("futu 助手:日期/K线时间/额度换算/IV 归一/错误翻译/状态词表", () => {
    const h = g.helpers;
    for (const c of h.futu_date) expect(futuDate(c.in)).toBe(c.out);
    for (const c of h.plain_date) expect(plainDate(c.in)).toBe(c.out);
    for (const c of h.bar_time) expect(barTime(c.in[0], c.in[1])).toBe(c.out);
    for (const c of h.duration_days) expect(durationDays(c.in)).toBe(c.out);
    expect(ivOf({ option_implied_volatility: 32.5 })).toBe(h.iv[0].out);
    expect(ivOf({ option_implied_volatility: 0.32 })).toBe(h.iv[1].out);
    expect(ivOf({})).toBeNull();
    for (const c of h.quote_error) expect(quoteError(c.in)).toBe(c.out);
    expectSame(ORDER_STATUS, h.order_status_map, "order_status_map");
    expect([...OPEN_STATUS].sort()).toEqual([...h.open_status].sort());
    expect(fieldOf({ open_interest: 5 }, "option_open_interest", "open_interest")).toBe(5);
    expect(fieldOf({ option_open_interest: "nan", open_interest: 7 }, "option_open_interest", "open_interest")).toBe(7);
    expect(() => accId("DU7654321")).toThrowError(/富途账号必须是数字/);
    expect(accId("7654321")).toBe(7654321);
  });

  // 下面的链数据是 2026-09-09 从真实 TWS 的 secDefOptParams 抄下来的,不是编的。
  // 曾经按字母序取第一个交易类,AAPL 拿到调整期权类 '2AAPL'、SPX 拿到月度类 'SPX',
  // 两边都是"整条链一个合约都确认不了"。
  const AAPL_CHAIN = {
    "2AAPL": { expiries: ["20260918"] },
    AAPL: { expiries: ["20260909", "20260911", "20260914", "20260916", "20260918", "20260921"] },
  };
  const SPX_CHAIN = {
    SPX: { expiries: ["20260917", "20261015", "20261119", "20261217"] },
    SPXW: { expiries: ["20260909", "20260910", "20260911", "20260917", "20260918"] },
  };
  const SPX_CFG = { daily_trading_class: "SPXW", monthly_trading_class: "SPX" };

  it("挑期权交易类:按到期日在哪条链上,再按标的同名优先", () => {
    // 正股:调整期权类只有一个到期日,那天两条链都在,得挑同名的那条
    expect(pickTradingClass("AAPL", null, AAPL_CHAIN, "20260918")).toBe("AAPL");
    // 只有标准链有的日子,自然只剩它
    expect(pickTradingClass("AAPL", null, AAPL_CHAIN, "20260911")).toBe("AAPL");

    // 第三个周五只存在于 SPXW——挑成 SPX 会建出不存在的合约
    expect(pickTradingClass("SPX", SPX_CFG, SPX_CHAIN, "20260918")).toBe("SPXW");
    // 月度那天两条链都在:同名的 SPX 才是 AM 结算,挑 SPXW 等于偷换结算方式
    expect(pickTradingClass("SPX", SPX_CFG, SPX_CHAIN, "20260917")).toBe("SPX");
    expect(pickTradingClass("SPX", SPX_CFG, SPX_CHAIN, "20261015")).toBe("SPX");

    // 到期日不在任何一条链上时不能空手而归,退回全部候选里排序最靠前的
    expect(pickTradingClass("SPX", SPX_CFG, SPX_CHAIN, "20991231")).toBe("SPX");
    expect(pickTradingClass("AAPL", null, {}, "20260918")).toBe("");
  });
});
