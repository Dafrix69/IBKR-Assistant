/** 标的目标价的 ibkr 档:用 IBKR 推的模型 IV 给每条腿定价(ivPricing.ts + tracker.spotTarget)。
 *
 * 钉的几件事:到期时刻(周度收盘结算 / 月度开盘结算 / 认不出就不给)、IV 换算成点数 σ、
 * 锚在当前报价上、缺一条腿的 IV 就退回按报价反解、到期退化成内在价值、纸面会话的延迟 tick 也读得到 IV、
 * 盯盘与试算用同一个取腿函数,以及不带 IV 时旧路径一字不变。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { legValue } from "../src/flyexit.js";
import { applyTicks } from "../src/ibSession.js";
import { expiryEpochMs, ibkrLegSigmas, legInputsOf } from "../src/ivPricing.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

const EXPIRY = "20260925";
const NOON = Date.parse("2026-09-25T12:00:00-04:00");
const CLOSE = Date.parse("2026-09-25T16:00:00-04:00");
const YEARS_LEFT = (CLOSE - NOON) / (365 * 24 * 3600 * 1000);

describe("到期时刻", () => {
  it("周度 SPXW 与个股期权:到期日 16:00 美东", () => {
    expect(expiryEpochMs("SPX", EXPIRY, "SPXW")).toBe(CLOSE);
    expect(expiryEpochMs("AAPL", EXPIRY, "")).toBe(CLOSE);
  });
  it("月度 SPX(交易类别就是 SPX):开盘价结算,09:30 就到期", () => {
    expect(expiryEpochMs("SPX", EXPIRY, "SPX")).toBe(Date.parse("2026-09-25T09:30:00-04:00"));
  });
  it("SPX / NDX / RUT 没带交易类别:认不出是周度还是月度,不给(退回按报价反解)", () => {
    expect(expiryEpochMs("SPX", EXPIRY, "")).toBeNull();
    expect(expiryEpochMs("NDX", EXPIRY, "")).toBeNull();
  });
  it("日期写法不对:null", () => {
    expect(expiryEpochMs("SPX", "2026-09-25", "SPXW")).toBeNull();
    expect(expiryEpochMs("SPX", "202609", "SPXW")).toBeNull();
  });
});

const key = tk.legPriceKey;
const FLY_LEGS: tk.StructureLeg[] = [
  { strike: 7700, right: "C", ratio: 1 }, { strike: 7720, right: "C", ratio: -2 }, { strike: 7740, right: "C", ratio: 1 },
];
const IVS = { "7700C": 0.14, "7720C": 0.13, "7740C": 0.125 };

describe("IV → 点数 σ", () => {
  it("σ_点 = 标的价 × IV × √剩余年数,每条腿用自己的 IV", () => {
    const s = ibkrLegSigmas(FLY_LEGS, 7715, IVS, CLOSE, NOON, key)!;
    expect(s["7700C"]).toBeCloseTo(7715 * 0.14 * Math.sqrt(YEARS_LEFT), 9);
    expect(s["7740C"]).toBeCloseTo(7715 * 0.125 * Math.sqrt(YEARS_LEFT), 9);
  });
  it("缺一条腿的 IV、IV 不是正数、没有到期时刻:整组不给", () => {
    expect(ibkrLegSigmas(FLY_LEGS, 7715, { "7700C": 0.14, "7720C": 0.13 }, CLOSE, NOON, key)).toBeNull();
    expect(ibkrLegSigmas(FLY_LEGS, 7715, { ...IVS, "7720C": 0 }, CLOSE, NOON, key)).toBeNull();
    expect(ibkrLegSigmas(FLY_LEGS, 7715, IVS, null, NOON, key)).toBeNull();
  });
  it("过了到期:σ = 0(定价退化成内在价值)", () => {
    const s = ibkrLegSigmas(FLY_LEGS, 7715, IVS, CLOSE, CLOSE + 60_000, key)!;
    expect(Object.values(s)).toEqual([0, 0, 0]);
  });
});

/** 一只 7700/7720/7740 看涨蝶,1 组,成本 $500;现价 5.40 */
const FLY_CONTRACT = {
  secType: "BAG", symbol: "SPX",
  legs: FLY_LEGS.map((l) => ({ lastTradeDateOrContractMonth: EXPIRY, strike: l.strike, right: l.right, ratio: l.ratio })),
};
const flyPosition = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 500, multiplier: 100 });
const structure = tk.structureOf("BAG", FLY_CONTRACT)!;
const LEG_PRICES = { "7700C": 20.5, "7720C": 9.9, "7740C": 4.1 }; // 20.5 − 19.8 + 4.1 = 4.8

function priced(extra: Rec = {}) {
  return tk.spotTarget({
    structure, position: flyPosition, spotTarget: 7722, spot: 7715, markPrice: 4.8,
    legPrices: LEG_PRICES, minute: 12 * 60, ...extra,
  });
}

describe("spotTarget 的 ibkr 档", () => {
  it("IV 齐:来源 ibkr;预计价 = 现价 + (IV 定价在目标价 − IV 定价在现价),和各腿报价反解无关", () => {
    const st = priced({ legIvs: IVS, expiryMs: CLOSE, nowMs: NOON });
    expect(st.sigma_source).toBe("ibkr");
    const sig = ibkrLegSigmas(FLY_LEGS, 7715, IVS, CLOSE, NOON, key)!;
    const v = (s: number) => FLY_LEGS.reduce((acc, l) => acc + l.ratio * legValue(l.right, s, l.strike, sig[key(l)]!), 0);
    expect(st.price).toBeCloseTo(4.8 + v(7722) - v(7715), 3);
    expect(st.leg_ivs).toEqual(IVS);
    expect(tk.MARKET_SIGMA_SOURCES.has("ibkr")).toBe(true); // 市场来源:能拿去挂单、改单
  });

  it("锚定:目标价就是现价时,预计价就是现在的报价(IB 模型价和中间价的偏差不带进挂单价)", () => {
    const st = tk.spotTarget({
      structure, position: flyPosition, spotTarget: 7715, spot: 7715, markPrice: 4.8,
      legPrices: LEG_PRICES, minute: 12 * 60, legIvs: IVS, expiryMs: CLOSE, nowMs: NOON,
    });
    expect(st.price).toBeCloseTo(4.8, 6);
  });

  it("缺一条腿的 IV:退回 smile(按各腿报价反解),不拿别的腿的 IV 去填", () => {
    const st = priced({ legIvs: { "7700C": 0.14, "7720C": 0.13 }, expiryMs: CLOSE, nowMs: NOON });
    expect(st.sigma_source).toBe("smile");
    expect(st.leg_ivs).toBeUndefined();
  });

  it("月度 SPX 认不出结算时刻(expiryMs = null):同样退回 smile", () => {
    expect(priced({ legIvs: IVS, expiryMs: null, nowMs: NOON }).sigma_source).toBe("smile");
  });

  it("到期之后:按内在价值算变化(7722 比 7715 多赚 7 点 × 1,蝶在 7720 以上开始往回吐)", () => {
    const st = priced({ legIvs: IVS, expiryMs: CLOSE, nowMs: CLOSE + 1000 });
    const intrinsic = (s: number) => Math.max(s - 7700, 0) - 2 * Math.max(s - 7720, 0) + Math.max(s - 7740, 0);
    expect(st.price).toBeCloseTo(4.8 + intrinsic(7722) - intrinsic(7715), 6);
  });

  it("不带 IV:和加这一档之前逐字段一样(没有 leg_ivs 键)", () => {
    const before = priced();
    expect(before.sigma_source).toBe("smile");
    expect(priced({ legIvs: null, expiryMs: CLOSE, nowMs: NOON })).toEqual(before);
    expect("leg_ivs" in before).toBe(false);
  });
});

describe("数据链路", () => {
  it("纸面会话的延迟 tick(DELAYED_MODEL_OPTION_IV 10045)也读得到 IV;实时的优先", () => {
    const mod = { IBApiTickType: {}, IBApiNextTickType: { MODEL_OPTION_IV: 10039, DELAYED_MODEL_OPTION_IV: 10045, MODEL_OPTION_PRICE: 10040, DELAYED_MODEL_OPTION_PRICE: 10046 } };
    const data: Rec = { bid: NaN, ask: NaN, last: null, close: null, marketPrice: null, modelGreeks: null };
    applyTicks(mod, data as any, { all: new Map([[10045, { value: 0.131 }], [10046, { value: 9.95 }]]) });
    expect(data["modelGreeks"]).toMatchObject({ impliedVol: 0.131, optPrice: 9.95 });
    applyTicks(mod, data as any, { all: new Map([[10039, { value: 0.129 }], [10045, { value: 0.131 }]]) });
    expect(data["modelGreeks"]["impliedVol"]).toBe(0.129);
  });

  const legRow = (strike: number, qty: number, price: number, iv: number | null, tc = "SPXW"): Rec => {
    const contract = { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY, strike, right: "C", multiplier: "100", tradingClass: tc };
    const ident = tk.legOf(contract);
    return {
      key: tk.makeKey("模拟", "SPX", "OPT", ident), account: "模拟", symbol: "SPX", sec_type: "OPT", leg: ident,
      label: tk.positionLabel("SPX", "OPT", contract), quantity: qty, avg_cost: 100, multiplier: 100,
      currency: "USD", market_price: price, market_value: null, unrealized_pnl: null, contract,
      ...(iv === null ? {} : { model_iv: iv }),
    };
  };
  const legs = () => [legRow(7700, 1, 20.5, 0.14), legRow(7720, -2, 9.9, 0.13), legRow(7740, 1, 4.1, 0.125)];

  it("legInputsOf:组合行按各腿取报价、IV,到期从腿的合约与交易类别算;单腿期权自己就是那条腿", () => {
    const rows = tk.withCombos(legs());
    const fly = rows.find((r) => r["sec_type"] === "BAG")!;
    const byKey = Object.fromEntries(rows.map((r) => [r["key"], r]));
    const got = legInputsOf(fly, byKey, key);
    expect(got.legPrices).toEqual(LEG_PRICES);
    expect(got.legIvs).toEqual(IVS);
    expect(got.expiryMs).toBe(CLOSE);
    const single = legInputsOf(legs()[0]!, byKey, key);
    expect(single).toEqual({ legPrices: { "7700C": 20.5 }, legIvs: { "7700C": 0.14 }, expiryMs: CLOSE });
  });

  it("盯盘(engine.applySpotTarget)真的走 ibkr 档:腿行带 model_iv 就用它", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-iv-"));
    const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "iv.db") } });
    const router = { BROKER: "ibkr", indexPrice: async () => 7715, spotInfo: () => null, sessions: () => [{}] };
    const engine = new TradingEngine({
      settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any,
    });
    const rows = tk.withCombos(legs());
    const fly = rows.find((r) => r["sec_type"] === "BAG")!;
    const byKey = Object.fromEntries(rows.map((r) => [r["key"], r]));
    const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: Number(fly["avg_cost"]), multiplier: 100 });
    const [targets, st] = await engine.applySpotTarget(
      { id: "t1" }, fly, position, tk.makeTargets({ spot_target: 7722 }), byKey, etNowFromEpoch(NOON),
    );
    expect(st?.sigma_source).toBe("ibkr");
    expect(targets.take_profit).toBe(st?.price);
    // 腿上没有 IV(个股期权夜里、10197 时):同一条路退回 smile
    const noIv = tk.withCombos(legs().map(({ model_iv: _iv, ...r }) => r));
    const fly2 = noIv.find((r) => r["sec_type"] === "BAG")!;
    const [, st2] = await engine.applySpotTarget(
      { id: "t2" }, fly2, position, tk.makeTargets({ spot_target: 7722 }),
      Object.fromEntries(noIv.map((r) => [r["key"], r])), etNowFromEpoch(NOON),
    );
    expect(st2?.sigma_source).toBe("smile");
  });
});
