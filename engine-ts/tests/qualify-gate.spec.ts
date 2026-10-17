/** TWS 不回合约确认时,只读的取数不再每次各等满 12 秒(src/qualifyGate.ts)。
 *
 * 2026-10-05 与 10-12 的 main.log:TWS 卡住的那几个小时里,测算面板两秒一次的 options.spot 有 1,004 次、
 * K 线页的 pa.analyze 有 351 次正好等满 12 秒;读道只有 4 个并发,同一段 positions.list 的第 90 百分位也是 12 秒。
 *
 * 钉的是:
 *  1. 一次超时之后 30 秒内,读的确认当场答"没回应",不发请求;到了间隔只放一路去试探,同时进来的不排队;
 *  2. 下单路径(wait)不受闸:刚超时过也照样去问;问回来了,读的那几路跟着恢复,不用等满间隔;
 *  3. 回了话就清掉(报错也算回了话),只有超时才记。
 *
 * 真的会话 + 真的路由 + 假的 TWS(tests/fakeTws.ts),全部离线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract, IbSession } from "../src/ibTypes.js";
import type { ContractSpec } from "../src/models.js";
import { QUALIFY_RETRY_MS, qualifyGated, takeQualifyGateStats } from "../src/qualifyGate.js";
import { FakeTws, connect } from "./fakeTws.js";

const TIMEOUT = BrokerRouter.QUALIFY_TIMEOUT_MS;
const NO_ANSWER = /没有响应合约确认/;
const stock = (symbol: string): IbContract => ({ secType: "STK", symbol, exchange: "SMART", currency: "USD" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-10-12T09:40:00-04:00"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 让时间走 ms 毫秒,回这一路的结果:"ok"、报错原文,或者 null(还没回) */
async function within(pending: Promise<unknown>, ms: number): Promise<string | null> {
  let out: string | null = null;
  void pending.then(() => { out = "ok"; }, (e: Error) => { out = e.message; });
  await vi.advanceTimersByTimeAsync(ms);
  return out;
}

describe("只读的确认:TWS 卡住时不再各等一个超时", () => {
  it("两秒一次读了半分钟:只发出去一次确认,其余每一次都当场答", async () => {
    const tws = new FakeTws();
    const { router, session } = await connect(tws);
    tws.stalled = true;
    const before = tws.detailRequests;

    expect(await within(router.qualifyOrRaise(session, stock("SPY")), TIMEOUT)).toMatch(NO_ANSWER);
    const answers: Array<string | null> = [];
    for (let i = 0; i < 14; i += 1) {
      answers.push(await within(router.qualifyOrRaise(session, stock("SPY")), 0));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(answers.every((a) => a !== null && NO_ANSWER.test(a)), "每一次都当场答,不等 12 秒").toBe(true);
    expect(tws.detailRequests - before).toBe(1);
  });

  it("到了间隔只放一路去试探;试探还没回,同时进来的当场答", async () => {
    const tws = new FakeTws();
    const { router, session } = await connect(tws);
    tws.stalled = true;
    const before = tws.detailRequests;
    await within(router.qualifyOrRaise(session, stock("SPY")), TIMEOUT);

    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);
    const probe = router.qualifyOrRaise(session, stock("QQQ"));
    expect(await within(router.qualifyOrRaise(session, stock("IWM")), 0)).toMatch(NO_ANSWER);
    expect(await within(probe, TIMEOUT)).toMatch(NO_ANSWER);
    expect(tws.detailRequests - before).toBe(2);
  });

  it("TWS 好了:到了间隔那一次试探就确认得了,之后读的照常", async () => {
    const tws = new FakeTws();
    const { router, session } = await connect(tws);
    tws.stalled = true;
    await within(router.qualifyOrRaise(session, stock("SPY")), TIMEOUT);

    tws.stalled = false;
    expect(await within(router.qualifyOrRaise(session, stock("SPY")), 0)).toMatch(NO_ANSWER);
    await vi.advanceTimersByTimeAsync(QUALIFY_RETRY_MS);
    expect(await within(router.qualifyOrRaise(session, stock("SPY")), 0)).toBe("ok");
    expect(await within(router.qualifyOrRaise(session, stock("QQQ")), 0)).toBe("ok");
  });
});

describe("下单路径不受闸", () => {
  it("刚超时过,下单的确认照样去问;问回来了,读的那几路不用等满间隔", async () => {
    const tws = new FakeTws();
    const { router, session, account } = await connect(tws);
    tws.stalled = true;
    await within(router.qualifyOrRaise(session, stock("SPY")), TIMEOUT);
    tws.stalled = false;
    const before = tws.detailRequests;

    const order = { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" } as ContractSpec;
    expect(await within(router.qualify(order, account), 0)).toBe("ok");
    expect(tws.detailRequests - before).toBe(1);
    expect(await within(router.qualifyOrRaise(session, stock("SPY")), 0)).toBe("ok");
  });

  it("TWS 还卡着:下单照样等满一个超时,报的还是原来那句", async () => {
    const tws = new FakeTws();
    const { router, session, account } = await connect(tws);
    tws.stalled = true;
    await within(router.qualifyOrRaise(session, stock("SPY")), TIMEOUT);
    const before = tws.detailRequests;

    const order = router.qualify({ secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" } as ContractSpec, account);
    expect(await within(order, TIMEOUT - 1_000), "下单不当场拒").toBeNull();
    expect(await within(order, 1_000)).toMatch(NO_ANSWER);
    expect(tws.detailRequests - before).toBe(1);
  });
});

describe("qualifyGated:什么算回了话", () => {
  it("只有超时才记;报错也算回了话,清掉之后下一次立刻去问", async () => {
    let mode: "hang" | "boom" | "ok" = "hang";
    const calls: string[] = [];
    const session = {
      qualifyContracts: async (): Promise<void> => {
        calls.push(mode);
        if (mode === "hang") throw Object.assign(new Error("qualify timeout"), { name: "TimeoutError" });
        if (mode === "boom") throw new Error("连接断了");
      },
    } as unknown as IbSession;
    let t = 0;
    const now = (): number => t;
    takeQualifyGateStats();

    expect(await qualifyGated(session, [], TIMEOUT, false, now)).toBe("stalled");
    expect(await qualifyGated(session, [], TIMEOUT, false, now)).toBe("stalled");
    expect(calls).toEqual(["hang"]);

    t = QUALIFY_RETRY_MS;
    mode = "boom";
    await expect(qualifyGated(session, [], TIMEOUT, false, now)).rejects.toThrow("连接断了");
    mode = "ok";
    expect(await qualifyGated(session, [], TIMEOUT, false, now)).toBe("ok");
    expect(calls).toEqual(["hang", "boom", "ok"]);
    expect(takeQualifyGateStats(), "超时一次、当场答一次、到了间隔试探一次").toEqual({ timeouts: 1, skipped: 1, probes: 1 });
    expect(takeQualifyGateStats()).toEqual({ timeouts: 0, skipped: 0, probes: 0 });
  });
});
