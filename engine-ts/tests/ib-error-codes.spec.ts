/** IBKR 错误回调的分级:警告码不能把活着的订单标成终态。
 *
 * 2026-09-08 模拟盘实测:一张卖单收到 399「为了不与相关挂单交叉,您的委托单被拒」之后照样成交了
 * ——399 是"委托单消息"(警告),订单仍然有效。当时引擎把它当拒单,记录停在 ibkr_error,
 * 后面的成交回报全接不上,账户里多出一笔谁也没记的空头。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };

const ORDER = {
  intent_summary: "限价 230 买入 100 股 AAPL",
  contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
  execution_type: "IMMEDIATE",
  trigger: null,
  account: "DEFAULT",
  order: {
    action: "BUY", orderType: "LMT", totalQuantity: 100,
    price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false,
  },
  reason: "回调到位",
  confidence: 0.99,
  warnings: [],
};

class FakeRouter {
  BROKER = "ibkr";
  indexPrice(): number | null { return null; }
  async place(recordId: string) {
    return { record_id: recordId, order_id: 1024, perm_id: 7788, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes() { return []; }
}

async function submitted(): Promise<{ engine: TradingEngine; id: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-iberr-"));
  const settings = makeSettings(gc.base_config, {
    storage: { db_path: path.join(dir, "e.db") },
    policies: { auto_execute: true },
  });
  const parser = {
    async parse(): Promise<LLMResponse> {
      return new LLMResponse(JSON.stringify({ orders: [ORDER], rejections: [] }), "claude-opus-5", "v", "f", 42);
    },
  };
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: new FakeRouter() as any,
  });
  const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, []);
  expect(result.submitted).toHaveLength(1);
  return { engine, id: result.submitted[0]!.record_id as string };
}

describe("IBKR 错误码分级", () => {
  it("399 委托单消息只记警告,订单仍然有效;之后的 201 才落终态", async () => {
    const { engine, id } = await submitted();
    engine.onIbError(1024, 399, "委托单消息: 卖出 3 AAPL 警告:为了不与相关挂单交叉,您的委托单被拒。");
    let record = engine.store.getRecord(id)!;
    expect(record["final_status"]).toBeNull();          // 没有终态:订单还活着
    expect(JSON.stringify(record)).toContain("IBKR 399"); // 但那句话记下来了

    engine.onIbError(1024, 201, "Order rejected - insufficient margin");
    record = engine.store.getRecord(id)!;
    expect(record["final_status"]).toBe("ibkr_error");
    expect(String(record["error_detail"])).toContain("201");
  });

  it("404 股票待借入:订单挂起不是拒单", async () => {
    const { engine, id } = await submitted();
    engine.onIbError(1024, 404, "Order held while securities are located.");
    expect(engine.store.getRecord(id)!["final_status"]).toBeNull();
  });

  it("2104 之类的系统信息照旧只记警告", async () => {
    const { engine, id } = await submitted();
    engine.onIbError(1024, 2104, "Market data farm connection is OK");
    expect(engine.store.getRecord(id)!["final_status"]).toBeNull();
  });

  // 2026-09-12 审出:订单 id 与请求 id 共用一个计数器,而 errorEvent 只给 reqId。
  // 行情订阅被拒(没权限、别处登录占着实时行情)时,配不上记录的错误会被存进 earlyOrderErrors 留 60 秒,
  // 这 60 秒里发出去的单只要 id 撞上就被判成 ibkr_error 终态——异动监控每 60 秒重订一次被拒的流
  // (最多 30 只),撞上的概率不再是理论值。
  it("行情订阅的错误码不算订单错误:不落终态,也不留给下一张同号的单", async () => {
    for (const code of [354, 10197, 10089, 300, 322]) {
      const { engine, id } = await submitted();
      engine.onIbError(1024, code, "行情订阅被拒");
      expect(engine.store.getRecord(id)!["final_status"], `${code} 不该落终态`).toBeNull();
      // 早到的错误也不许留着:同号的下一张单不能被它判死
      engine.onIbError(9999, code, "行情订阅被拒");
      expect((engine as unknown as { earlyOrderErrors: Map<number, unknown> }).earlyOrderErrors.has(9999)).toBe(false);
    }
  });

  it("真的订单错误照旧落终态(别把过滤写宽了)", async () => {
    const { engine, id } = await submitted();
    engine.onIbError(1024, 201, "Order rejected - insufficient margin");
    expect(engine.store.getRecord(id)!["final_status"]).toBe("ibkr_error");
  });
});
