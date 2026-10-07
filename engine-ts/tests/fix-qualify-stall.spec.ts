/** TWS 没回合约确认 ≠ 合约不存在(2026-10-05 真机,打包版)。
 *
 * 那天电脑睡了四天,唤醒 48 秒后启动应用,TWS 自己还在重连 IBKR:持仓读得到,四张合约(两只正股、一组价差的两条腿)
 * 的确认请求各等满 12 秒没有回音(`main.log`:头两次 positions.list 各 48 秒)。常驻订阅的账本把"超时"和"认不出"
 * 记成同一样东西(handle 为 null,不再重试):TWS 随后就好了,持仓的现价却一直是「—」,盯盘每一轮都是
 * 「拿不到现价,本轮不判断」,直到断开重连。经过见 docs/journal/qualify-timeout-cached-as-unknown.md。
 *
 * 真的会话 + 真的路由 + 假的 TWS(tests/fakeTws.ts),全部离线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import { QUALIFY_RETRY_MS } from "../src/heldStreams.js";
import { FakeTws, connect, optionLeg, positions, priceOf } from "./fakeTws.js";
import type { Held, Row } from "./fakeTws.js";

/** 2026-10-05 是周一;十月初还是夏令时。09:03 = 盘前 */
const et = (hhmm: string): number => Date.parse(`2026-10-05T${hhmm}:00-04:00`);
const TIMEOUT = BrokerRouter.QUALIFY_TIMEOUT_MS;
const EXPIRY = "20261016";

let lines: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(et("09:03"));
  lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stock(tws: FakeTws, symbol: string, last: number): Held {
  const conId = tws.conId(symbol);
  tws.book.set(conId, { bid: last - 0.1, ask: last + 0.1, last });
  return { pos: 100, avgCost: 20, contract: { conId, symbol, secType: "STK" } };
}

/** 那天的持仓:两只正股 + 一组价差的两条腿 */
function book(tws: FakeTws): Held[] {
  const legs = [optionLeg(tws, 115, -5, "SPXW", EXPIRY), optionLeg(tws, 120, 5, "SPXW", EXPIRY)];
  tws.book.set(Number(legs[0]!.contract["conId"]), { bid: 1.0, ask: 1.2 });
  tws.book.set(Number(legs[1]!.contract["conId"]), { bid: 2.0, ask: 2.4 });
  return [stock(tws, "IREN", 44.9), stock(tws, "NVO", 43.1), ...legs];
}

const stockPrice = (rows: Row[], symbol: string): unknown =>
  rows.find((r) => r["symbol"] === symbol && r["sec_type"] === "STK")?.["market_price"];
const prices = (rows: Row[]): unknown[] =>
  [stockPrice(rows, "IREN"), stockPrice(rows, "NVO"), priceOf(rows, 115), priceOf(rows, 120)];

/** 读一次持仓,同时让时间走 ms 毫秒;这么久还没读完就是 null */
async function readWithin(router: BrokerRouter, ms: number): Promise<Row[] | null> {
  let rows: Row[] | null = null;
  const pending = positions(router).then((r) => { rows = r; });
  await vi.advanceTimersByTimeAsync(ms);
  void pending;
  return rows;
}

const stallLines = (): string[] => lines.filter((l) => l.includes("合约确认"));

describe("TWS 不回合约确认时的持仓行情", () => {
  it("这一轮只等一次超时:第一张超时了,剩下的三张不再各等 12 秒", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    const { router } = await connect(tws);
    tws.stalled = true;

    const rows = await readWithin(router, TIMEOUT);
    expect(rows, "12 秒之内要读得完,不是 4 × 12 秒").not.toBeNull();
    expect(prices(rows!)).toEqual([null, null, null, null]);
    expect(tws.detailRequests).toBe(1);
  });

  it("TWS 好了:没到间隔不去撞,到了间隔四张都订上、现价回来", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    const { router } = await connect(tws);
    tws.stalled = true;
    await readWithin(router, TIMEOUT);

    tws.stalled = false;
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS - 1_000);
    expect(prices(await positions(router))).toEqual([null, null, null, null]);
    expect(tws.detailRequests).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(prices(await positions(router))).toEqual([44.9, 43.1, 1.1, 2.2]);
    expect(tws.lines()).toBe(4);
  });

  it("日志头尾各一行:卡住时说一次,恢复时说一次", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    const { router } = await connect(tws);
    tws.stalled = true;
    await readWithin(router, TIMEOUT);
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);
    await readWithin(router, TIMEOUT); // 第二次试探,还是没回话
    expect(stallLines()).toHaveLength(1);
    expect(stallLines()[0]).toContain("没有响应合约确认");

    tws.stalled = false;
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);
    await positions(router);
    expect(stallLines()).toHaveLength(2);
    expect(stallLines()[1]).toContain("恢复");
  });

  it("一直不回:每个间隔只试探一次,中间每秒一轮的读取都不等", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    const { router } = await connect(tws);
    tws.stalled = true;
    await readWithin(router, TIMEOUT);
    expect(tws.detailRequests).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await readWithin(router, 0), "间隔之内的读取当场返回").not.toBeNull();
    }
    expect(tws.detailRequests).toBe(1);

    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);
    expect(await readWithin(router, 0), "到了间隔,这一轮去试探,要等").toBeNull();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(tws.detailRequests).toBe(2);
  });

  it("试探还没出结果时,另一路读取不跟着排队等", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    const { router } = await connect(tws);
    tws.stalled = true;
    await readWithin(router, TIMEOUT);
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);

    const probing = positions(router); // 盯盘那一路先到,去试探
    expect(await readWithin(router, 0), "界面那一路当场返回").not.toBeNull();
    expect(tws.detailRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await probing;
  });

  it("TWS 回了话、查无此合约:照旧记下来不再试,也不算 TWS 卡住——别的合约照常订", async () => {
    const tws = new FakeTws();
    tws.held = book(tws);
    tws.unlisted.add("IREN");
    const { router } = await connect(tws);

    expect(prices(await positions(router))).toEqual([null, 43.1, 1.1, 2.2]);
    const asked = tws.detailRequests;
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS * 3);
    expect(prices(await positions(router))).toEqual([null, 43.1, 1.1, 2.2]);
    expect(tws.detailRequests).toBe(asked);
    expect(stallLines()).toEqual([]);
  });
});
