/** 合约确认遇到多条匹配(2026-09-27 审计 V5):绝不默默取第一条。
 *
 * 股票期权下单时不带交易类(提示词让模型省略),IBKR 对 "AAPL 20260918 230C" 可能同时回
 * 标准类 AAPL 和调整期权类 2AAPL(交割物不同)。以前取 details[0],谁排在前面就下到谁头上。
 * 现在:同一 conId 的重复行合并;多条时先认请求里写明的交易类,再认与标的同名的那条;
 * 还分不出来就确认失败(conId=0,路由那边照常拦截),不猜。
 */
import { describe, expect, it } from "vitest";

import type { IbContract } from "../src/ibTypes.js";
import { createIbApiNextSession } from "../src/ibSession.js";

type Detail = { contract: { conId: number; tradingClass: string; exchange: string } };

/** 最小的 IBApiNext 替身:连上即可,getContractDetails 按测试给定的行回。 */
function fakeMod(rows: Detail[]) {
  class FakeApiNext {
    readonly api = { on: () => undefined };
    readonly errorSubject = { subscribe: () => ({ unsubscribe: () => undefined }) };
    readonly connectionState = { subscribe: () => ({ unsubscribe: () => undefined }) };
    connect(): void {}
    disconnect(): void {}
    getManagedAccounts(): Promise<string[]> { return Promise.resolve(["DU7654321"]); }
    setMarketDataType(): void {}
    getContractDetails(): Promise<Detail[]> { return Promise.resolve(rows); }
  }
  return { IBApiNext: FakeApiNext, ConnectionState: { Disconnected: 0, Connecting: 1, Connected: 2 }, EventName: {} };
}

const CFG = { host: "127.0.0.1", port: 7497, clientId: 11, readonly: false };
const row = (conId: number, tradingClass: string): Detail => ({ contract: { conId, tradingClass, exchange: "SMART" } });

async function qualifyWith(rows: Detail[], contract: Partial<IbContract> = {}): Promise<IbContract> {
  const session = await createIbApiNextSession(CFG, { mod: fakeMod(rows) });
  const target: IbContract = {
    secType: "OPT", symbol: "AAPL", exchange: "SMART", currency: "USD",
    lastTradeDateOrContractMonth: "20260918", strike: 230, right: "C", multiplier: "100",
    tradingClass: "", conId: 0, ...contract,
  };
  await session.qualifyContracts([target], 1000);
  return target;
}

describe("V5 合约确认:多条匹配不取第一条", () => {
  it("标准类与调整期权类同时匹配:认与标的同名的 AAPL,不管谁排前面", async () => {
    const got = await qualifyWith([row(111, "2AAPL"), row(222, "AAPL")]);
    expect(got.conId).toBe(222);
    expect(got.tradingClass).toBe("AAPL");
  });

  it("请求里写明了交易类:认写明的那条", async () => {
    const got = await qualifyWith([row(1, "SPX"), row(2, "SPXW")], { symbol: "SPX", tradingClass: "SPXW" });
    expect(got.conId).toBe(2);
  });

  it("分不出来(没有同名类):确认失败,conId 留 0,不猜", async () => {
    const got = await qualifyWith([row(111, "XYZ1"), row(222, "XYZ2")], { symbol: "XYZ" });
    expect(got.conId).toBe(0);
  });

  it("同一 conId 的重复行不算歧义", async () => {
    const got = await qualifyWith([row(333, "AAPL"), row(333, "AAPL")]);
    expect(got.conId).toBe(333);
  });

  it("只有一条:照常确认(对照)", async () => {
    const got = await qualifyWith([row(444, "2AAPL")]);
    expect(got.conId).toBe(444);
  });
});
