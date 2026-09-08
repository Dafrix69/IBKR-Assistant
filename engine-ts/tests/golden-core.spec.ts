/** 黄金对拍:config / models / validator / tracker。
 * 期望值由 ../engine-python/scripts/gen_golden.py 从 Python 实现生成。 */
import { describe, expect, it } from "vitest";

import { etNowFromEpoch, hoursStatus, parseTradingHours } from "../src/config.js";
import * as flyexit from "../src/flyexit.js";
import { ParsedOrderSchema, parseLlmPayload } from "../src/models.js";
import {
  RecentOrder, Validator, orderSignature, primaryCode, rejectionMessage,
} from "../src/validator.js";
import { drawdownTiersOf } from "../src/rpc.js";
import * as tracker from "../src/tracker.js";
import { expectSame, loadGolden, makeSettings } from "./util.js";

// ---------------------------------------------------------------- config
describe("golden: config", () => {
  const g = loadGolden("config");

  it("market_status", () => {
    const settings = makeSettings(g.base_config);
    for (const c of g.market_status) {
      const now = etNowFromEpoch(Date.parse(c.now));
      expect(settings.marketStatus(now), c.now).toBe(c.expect);
    }
  });

  it("hours_status / parse_trading_hours", () => {
    // 合约自己的时段:SPX 期权有隔夜段,正股那张表判不出来
    const settings = makeSettings(g.base_config);
    for (const c of g.hours_status) {
      const epoch = Date.parse(c.now);
      expect(hoursStatus(c.spec, c.tz, epoch, c.liquid), `hours ${c.now}`).toBe(c.expect);
      // 顺带确认样例里记的"正股表怎么说"也一致——两张表的差异正是这条路存在的理由
      expect(settings.marketStatus(etNowFromEpoch(epoch)), `stock ${c.now}`).toBe(c.stock_table);
    }
    for (const c of g.parse_trading_hours) {
      // Python 存的是朴素 ISO 时刻,TS 内部用朴素分钟数——转成同一形状再比
      const got = parseTradingHours(c.spec).map(([a, b]) =>
        [a, b].map((m) => new Date(m * 60000).toISOString().slice(0, 19)));
      expectSame(got, c.expect, `parse ${c.spec}`);
    }
  });

  it("errors", () => {
    for (const c of g.errors) {
      let error: string | null = null;
      try {
        makeSettings(g.base_config, c.overrides);
      } catch (exc) {
        error = (exc as Error).message;
      }
      expect(error, c.name).toBe(c.error);
    }
  });

  it("tables and lookups", () => {
    const settings = makeSettings(g.base_config);
    expect(settings.promptAccountTable()).toBe(g.prompt_account_table);
    expect(settings.promptSymbolTable()).toBe(g.prompt_symbol_table);
    expect(settings.aliasList()).toEqual(g.alias_list);
    expect(settings.accountByAlias("DEFAULT")?.account_id).toBe(g.account_by_alias.DEFAULT);
    expect(settings.accountByAlias("主账户")?.account_id).toBe(g.account_by_alias["主账户"]);
    expect(settings.accountByAlias("missing")).toBeNull();
    expect(Object.keys(settings.connectionsFor()).sort()).toEqual(g.connections_for_default);
    for (const [day, expected] of Object.entries(g.is_trading_day)) {
      expect(settings.isTradingDay(day), day).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- models
describe("golden: models", () => {
  const g = loadGolden("models");

  for (const c of g.cases) {
    it(c.name, () => {
      if (c.type_error !== undefined) {
        expect(() => parseLlmPayload(c.payload)).toThrowError(c.type_error);
        return;
      }
      const result = parseLlmPayload(c.payload);
      expectSame(result.orders, c.expect.orders, `${c.name}.orders`);
      expect(result.rejections.map((r) => r.code)).toEqual(c.expect.rejection_codes);
      expect(result.rejections.map((r) => r.original_text)).toEqual(c.expect.rejection_texts);
      expect(result.schema_errors.length).toBe(c.expect.schema_error_count);
    });
  }
});

// ---------------------------------------------------------------- validator
describe("golden: validator", () => {
  const g = loadGolden("validator");

  const toRecents = (recents: any[] | null): RecentOrder[] =>
    (recents ?? []).map((r) => ({
      signature: r.signature,
      quantity: r.quantity,
      createdAtMs: Date.parse(r.created_at),
    }));

  for (const c of g.cases) {
    it(c.name, () => {
      const settings = makeSettings(g.base_config, c.settings_over);
      const parsed = ParsedOrderSchema.safeParse(c.payload);
      if (c.model_error) {
        expect(parsed.success, `${c.name}: 模型层应拒绝`).toBe(false);
        return;
      }
      expect(parsed.success, `${c.name}: 模型层应通过`).toBe(true);
      if (!parsed.success) return;
      const order = parsed.data;
      const v = new Validator(settings, etNowFromEpoch(Date.parse(c.now)), c.snapshot, toRecents(c.recents));
      const [issues, approved] = v.validateOne(order);
      expectSame(
        issues.map((i) => ({ code: i.code, message: i.message })),
        c.expect.issues,
        `${c.name}.issues`,
      );
      expect(orderSignature(order, order.account)).toBe(c.expect.signature);
      if (c.expect.approved) {
        expect(approved, `${c.name}: 应通过`).not.toBeNull();
        expectSame(
          {
            notional: approved!.notional,
            signature: approved!.signature,
            warnings: approved!.warnings,
            account_id: approved!.account.account_id,
          },
          c.expect.approved,
          `${c.name}.approved`,
        );
        expect(order.contract.tradingClass).toBe(c.expect.contract_trading_class);
        expect((order.contract.legs ?? []).map((l) => l.tradingClass)).toEqual(
          c.expect.leg_trading_classes,
        );
      } else {
        expect(approved, `${c.name}: 应拒绝`).toBeNull();
      }
    });
  }

  it("validate_all batch", () => {
    const settings = makeSettings(g.base_config);
    const orders = g.batch.payloads.map((p: unknown) => ParsedOrderSchema.parse(p));
    const v = new Validator(settings, etNowFromEpoch(Date.parse(g.batch.now)), g.batch.snapshot, []);
    const outcome = v.validateAll(orders);
    expectSame(
      outcome.approved.map((a) => ({
        notional: a.notional, signature: a.signature, warnings: a.warnings,
      })),
      g.batch.approved,
      "batch.approved",
    );
    expectSame(
      outcome.rejected.map((r) => ({
        codes: r.issues.map((i) => i.code),
        message: rejectionMessage(r),
      })),
      g.batch.rejected,
      "batch.rejected",
    );
    expect(outcome.rejected.length ? primaryCode(outcome.rejected[0]!) : "").toBeDefined();
  });
});

// ---------------------------------------------------------------- tracker
describe("golden: tracker", () => {
  const g = loadGolden("tracker");
  const P = (name: string) => tracker.makePosition(g.positions[name]);

  it("legs & combos(腿身份 / 标签 / 组合识别)", () => {
    for (const c of g.legs) {
      expect(tracker.legOf(c.contract), `legOf(${c.symbol})`).toBe(c.leg);
      expect(tracker.positionLabel(c.symbol, c.sec_type, c.contract), `label(${c.symbol})`).toBe(c.label);
      expect(tracker.makeKey("模拟", c.symbol, c.sec_type, c.leg), `key(${c.symbol})`).toBe(c.key);
    }
    for (const c of g.track_key) {
      expect(tracker.trackKey(c.track)).toBe(c.expect);
    }
    for (const c of g.group_legs) {
      expectSame(tracker.groupLegs(c.rows), c.expect, `group_legs(${c.name})`);
    }
    for (const c of g.with_combos) {
      expectSame(tracker.withCombos(c.rows), c.expect, `with_combos(${c.name})`);
    }
  });

  it("unrealized", () => {
    for (const c of g.unrealized) {
      expectSame(tracker.unrealized(P(c.position), c.price), c.expect, `unrealized(${c.position})`);
    }
  });

  it("validate", () => {
    for (const [i, c] of g.validate.entries()) {
      let error: string | null = null;
      try {
        tracker.validate(P(c.position), tracker.makeTargets(c.targets), c.price);
      } catch (exc) {
        error = (exc as Error).message;
      }
      if (c.expect.ok) expect(error, `validate[${i}]`).toBeNull();
      else expect(error, `validate[${i}]`).toBe(c.expect.error);
    }
  });

  it("advance_peak / trail_stop", () => {
    for (const c of g.advance_peak) {
      expect(tracker.advancePeak(P(c.position), c.price, c.peak)).toBe(c.expect);
    }
    for (const c of g.trail_stop) {
      const out = tracker.trailStopPrice(P(c.position), c.peak, c.trail_pct);
      if (c.expect === null) expect(out).toBeNull();
      else expect(out).toBeCloseTo(c.expect, 9);
    }
  });

  it("evaluate", () => {
    for (const [i, c] of g.evaluate.entries()) {
      const out = tracker.evaluate(P(c.position), tracker.makeTargets(c.targets), c.price, c.peak,
        c.minute ?? null);
      expectSame(out, c.expect, `evaluate[${i}]`);
    }
  });

  it("split_structures(同一到期日的多张组合要各算各的)", () => {
    for (const c of g.split_structures) {
      const legs = c.rows;                 // 样例自带完整腿数据,不靠 key 查表(会串)
      const got = tracker.splitStructures(legs).map((chunk) => chunk.map((r) => r["key"]));
      expectSame(got, c.expect, `split ${c.name}`);
      const shapes = tracker.splitStructures(legs).map((chunk) => tracker.shapeOf(chunk));
      expectSame(shapes, c.shapes, `shape ${c.name}`);
    }
  });

  it("drawdown_threshold", () => {
    // 档位来自 flyexit(唯一事实源):导出的形状两侧必须逐字段一致
    expectSame(flyexit.drawdownTiers(null), g.fly_tiers.tiers, "fly_tiers");
    expectSame(flyexit.drawdownLate(null), g.fly_tiers.late, "fly_late");
    for (const [i, c] of g.drawdown_threshold.entries()) {
      const targets = tracker.makeTargets(g.drawdown_threshold_targets[c.targets]);
      const out = tracker.drawdownThreshold(targets, c.profit_peak, c.basis, c.minute ?? null);
      expectSame(out, c.expect, `drawdown_threshold[${i}] ${c.targets}`);
    }
  });

  it("close_blockers", () => {
    for (const [i, c] of g.close_blockers.entries()) {
      const out = tracker.closeBlockers({
        auto: tracker.makeAutoClose(c.auto),
        position: P(c.position),
        accountIsPaper: c.account_is_paper,
        autoExecute: c.auto_execute,
        allowLiveTrading: c.allow_live_trading,
        breakerEngaged: c.breaker_engaged,
        marketStatus: c.market_status,
        outsideRth: c.outside_rth,
        alreadyFired: c.already_fired,
        comboLiveOk: c.combo_live_ok ?? false,
      });
      expect(out, `close_blockers[${i}]`).toEqual(c.expect);
    }
  });

  it("close_limit_price / build_close_order", () => {
    for (const c of g.close_limit_price) {
      const out = tracker.closeLimitPrice(P(c.position), c.price, c.slippage_pct);
      if (c.expect === null) expect(out).toBeNull();
      else expect(out).toBeCloseTo(c.expect, 9);
    }
    for (const c of g.build_close_order) {
      const out = tracker.buildCloseOrder(
        P(c.position), tracker.makeAutoClose(c.auto), c.price, c.state,
        { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
        c.market_status ?? "盘中",
      );
      expectSame(out, c.expect, "build_close_order");
    }
    const errExt = g.build_close_order_error_extended;
    expect(() =>
      tracker.buildCloseOrder(
        P(errExt.position), tracker.makeAutoClose(errExt.auto), errExt.price, errExt.state,
        { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
        errExt.market_status,
      ),
    ).toThrowError(errExt.error);
    const err = g.build_close_order_error;
    expect(() =>
      tracker.buildCloseOrder(
        P(err.position), tracker.makeAutoClose(err.auto), err.price, err.state,
        { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
      ),
    ).toThrowError(err.error);
    expect(tracker.closeSide(P("long_stock"))).toBe(g.close_side.long_stock);
    expect(tracker.closeSide(P("short_stock"))).toBe(g.close_side.short_stock);
  });

  it("drawdown_tiers params", () => {
    for (const c of g.drawdown_tiers_params) {
      if (c.error) {
        let thrown: any = null;
        try {
          drawdownTiersOf(c.params);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `${c.name} 应该被拒`).not.toBeNull();
        expect(thrown.code, c.name).toBe(c.error.code);
        expect(thrown.message, c.name).toBe(c.error.message);
      } else {
        const [tiers, late] = drawdownTiersOf(c.params);
        expectSame({ tiers, late }, c.expect, `drawdown_tiers_params ${c.name}`);
      }
    }
  });

  it("close_bag_contract / build_close_order(BAG)", () => {
    for (const c of g.close_bag_contract) {
      expectSame(tracker.closeBagContract(c.contract), c.expect, `close_bag_contract ${c.name}`);
      // closeContract 按 secType 分派到同一条路
      expectSame(tracker.closeContract(c.contract), c.expect, `close_contract ${c.name}`);
    }
    for (const c of g.close_bag_contract_errors) {
      expect(() => tracker.closeBagContract(c.contract), c.name).toThrowError(c.error);
    }
    const contracts: Record<string, any> = {};
    for (const c of g.close_bag_contract) contracts[c.name] = c.contract;
    contracts["fly"] = contracts["butterfly"];
    for (const [i, c] of g.build_close_order_bag.entries()) {
      const out = tracker.buildCloseOrder(
        P(c.position), tracker.makeAutoClose(c.auto), c.price, c.state,
        contracts[c.contract], c.market_status ?? "盘中",
      );
      expectSame(out, c.expect, `build_close_order_bag[${i}]`);
    }
    const bagErr = g.build_close_order_bag_error;
    expect(() =>
      tracker.buildCloseOrder(
        P(bagErr.position), tracker.makeAutoClose(bagErr.auto), bagErr.price, bagErr.state,
        contracts[bagErr.contract],
      ),
    ).toThrowError(bagErr.error);
  });

  it("profit_trail_stop_price", () => {
    for (const [i, c] of g.profit_trail_stop.entries()) {
      const out = tracker.profitTrailStopPrice(P(c.position), c.peak, c.dd);
      if (c.expect === null) expect(out, `profit_trail_stop[${i}]`).toBeNull();
      else expect(out, `profit_trail_stop[${i}]`).toBeCloseTo(c.expect, 9);
    }
  });

  it("hosted_plan", () => {
    for (const [i, c] of g.hosted_plan.entries()) {
      const out = tracker.hostedPlan(
        P(c.position), tracker.makeTargets(c.targets), tracker.makeAutoClose(c.auto), c.peak,
      );
      expectSame(out, c.expect, `hosted_plan[${i}]`);
    }
  });

  it("hosted_needs_update", () => {
    for (const [i, c] of g.hosted_needs_update.entries()) {
      expect(tracker.hostedNeedsUpdate(c.current, c.desired), `hosted_needs_update[${i}]`)
        .toBe(c.expect);
    }
  });
});
