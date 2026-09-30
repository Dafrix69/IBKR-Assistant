/** TWS 与 IBKR 服务器断开(1100 / 2110)要让 router 知道(2026-09-30 读 @stoqey/ib 1.6.10 时发现)。
 *
 * TWS 的 1100 / 1101 / 1102 / 2110 不带 id(= −1)。库的解码器把这种 ERR_MSG 发成 `info` 事件,不进 error$;
 * 会话层以前只订了 error$,这几个码一次都没转出来过,`BrokerRouter.upstreamOk` 永远是 true,
 * 合约确认卡住时也从来说不出「TWS 与 IBKR 服务器的连接已中断」。
 * 另一半是标志什么时候变回"通":库一收到 1100 / 2110 就把本机 socket 断掉、5 秒后重连,
 * 新 socket 上未必再有 1101 / 1102——只认这两个码的话,转出 1100 之后标志会永远停在"断"。
 *
 * 用真的 IBApiNext(只把 socket 控制器换成假的,tests/fakeController.ts)+ 真的路由。全部离线。
 */
import { Decoder } from "@stoqey/ib/dist/core/io/decoder.js";
import { IN_MSG_ID } from "@stoqey/ib/dist/core/io/enum/in-msg-id.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract, IbSession } from "../src/ibTypes.js";
import { LIVE_ACCOUNT, realSession } from "./fakeController.js";
import type { Emitter, SessionCfg } from "./fakeController.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const PAPER_ACCOUNT = "DU7654321";
const LOST = "Connectivity between IB and Trader Workstation has been lost.";
const BROKEN = "Connectivity between Trader Workstation and server is broken. It will be restored automatically.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-09-30T23:45:00-04:00")); // 每晚服务器重置前后
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("库:TWS 不带 id 的消息走 info,不走 error", () => {
  it("解码器:id = −1 的 ERR_MSG → emitInfo;带订单号的才 → emitError", () => {
    const info: unknown[][] = [];
    const errors: unknown[][] = [];
    const decoder = new Decoder({
      serverVersion: 176,
      emitEvent: () => undefined,
      emitError: (...args: unknown[]) => { errors.push(args); },
      emitInfo: (...args: unknown[]) => { info.push(args); },
    });
    // 版本 2:id、码、原文、advancedOrderReject(服务器版本 ≥ 166 才有,这里是空串)
    const errMsg = (id: number, code: number, text: string): string[] =>
      [String(IN_MSG_ID.ERR_MSG), "2", String(id), String(code), text, ""];
    decoder.enqueueMessage(errMsg(-1, 1100, LOST));
    decoder.enqueueMessage(errMsg(-1, 2110, BROKEN));
    decoder.enqueueMessage(errMsg(-1, 1102, "Connectivity between IB and Trader Workstation has been restored - data maintained."));
    decoder.enqueueMessage(errMsg(42, 201, "Order rejected - reason:"));
    decoder.process();
    expect(info.map((a) => a[1])).toEqual([1100, 2110, 1102]);
    expect(errors.map((a) => [a[1], a[2]])).toEqual([[201, 42]]);
  });
});

describe("会话层(真的 IBApiNext):info 上的码转给 onConnectivity", () => {
  it("1100 转出来;库自己先断了 socket(onLink(false) 在前),5 秒后连回;别的码原样转,挑哪个是 router 的事", async () => {
    const { session, tws } = await realSession();
    const seen: string[] = [];
    session.onConnectivity((code) => seen.push(`码 ${code}`));
    session.onLink?.((up) => seen.push(up ? "连上" : "断开"));

    tws.emit("info", "Market data farm connection is OK:usfarm", 2104);
    tws.emit("info", LOST, 1100);
    expect(session.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.isConnected()).toBe(true);
    expect(seen).toEqual(["码 2104", "断开", "码 1100", "连上"]);
  });

  it("显式 disconnect() 之后不再转(被 router 换下的旧会话不能再改标志)", async () => {
    const { session, tws } = await realSession();
    const seen: number[] = [];
    session.onConnectivity((code) => seen.push(code));
    session.disconnect();
    tws.emit("info", LOST, 1100);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

interface Wire { session: IbSession; tws: Emitter }

/** 真的路由,会话是真的 IBApiNext:live = 7496 管主账户,paper = 7497 管模拟账户。wires 记着每个端口最新的那条 */
function makeRouter(): { router: BrokerRouter; wires: Map<number, Wire>; links: Array<[string, boolean]> } {
  const wires = new Map<number, Wire>();
  const router = new BrokerRouter(makeSettings(g.base_config), async (cfg: SessionCfg) => {
    const wire = await realSession(cfg, cfg.port === 7497 ? PAPER_ACCOUNT : LIVE_ACCOUNT);
    wires.set(cfg.port, wire);
    return wire.session;
  });
  const links: Array<[string, boolean]> = [];
  router.linkHook = (name, up) => links.push([name, up]);
  return { router, wires, links };
}

const wireOf = (wires: Map<number, Wire>, port: number): Wire => {
  const wire = wires.get(port);
  if (wire === undefined) throw new Error(`端口 ${port} 没连过`);
  return wire;
};

const STOCK: IbContract = { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" };

describe("路由的上游标志(真的会话 + 真的路由)", () => {
  it("1100 → 断;库 5 秒后连回 TWS,新 socket 上没有 1101 / 1102 也算恢复", async () => {
    const { router, wires, links } = makeRouter();
    await router.connect("live");
    const { session, tws } = wireOf(wires, 7496);
    expect(router.upstreamOk).toBe(true);

    tws.emit("info", LOST, 1100);
    expect(router.upstreamOk).toBe(false);
    expect(session.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(router.upstreamOk).toBe(false); // socket 还没连回来
    await vi.advanceTimersByTimeAsync(1);
    expect(session.isConnected()).toBe(true);
    expect(router.upstreamOk).toBe(true);
    expect(links).toEqual([["live", false], ["live", true]]); // 服务层的掉线 / 连回提醒照旧
  });

  it("上游还断着:新 socket 上 TWS 再说一次 2110 → 又记成断;连回来之后的 1102 照样认", async () => {
    const { router, wires } = makeRouter();
    await router.connect("live");
    const { session, tws } = wireOf(wires, 7496);

    tws.emit("info", LOST, 1100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(router.upstreamOk).toBe(true);
    tws.emit("info", BROKEN, 2110);
    expect(router.upstreamOk).toBe(false);
    expect(session.isConnected()).toBe(false); // 库在 2110 上一样断 socket
    await vi.advanceTimersByTimeAsync(5_000);
    expect(router.upstreamOk).toBe(true);
    tws.emit("info", "Connectivity between IB and Trader Workstation has been restored - data maintained.", 1102);
    expect(router.upstreamOk).toBe(true);
    expect(session.isConnected()).toBe(true);
  });

  it("合约确认卡在上游断开里:那句话用 TWS 给的码,不再说「本机到 TWS 的连接还在」", async () => {
    const { router, wires } = makeRouter();
    const session = await router.connect("live");
    const { tws } = wireOf(wires, 7496);

    const message = router.qualifyOrRaise(session, { ...STOCK }).then(() => "确认成功了", (e: Error) => e.message);
    tws.emit("info", LOST, 1100);
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000); // 库连回 TWS,TWS 当场说还断着
      tws.emit("info", BROKEN, 2110);
    }
    await vi.advanceTimersByTimeAsync(BrokerRouter.QUALIFY_TIMEOUT_MS - 10_000);
    expect(await message).toMatch(/^TWS 与 IBKR 服务器的连接已中断\(错误 2110\),请求到不了 IBKR/);
    expect(await message).not.toMatch(/本机到 TWS 的连接还在/);
  });

  it("按连接记:live 断着,paper 新连上、paper 自己断了又连回,都不抹掉 live 的", async () => {
    const { router, wires } = makeRouter();
    await router.connect("live");
    wireOf(wires, 7496).tws.emit("info", LOST, 1100);
    expect(router.upstreamOk).toBe(false);

    await router.connect("paper"); // 以前:connect() 一律把唯一那个标志重置成 true
    expect(router.upstreamOk).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    wireOf(wires, 7497).tws.emit("info", LOST, 1100);
    await vi.advanceTimersByTimeAsync(3_000); // live 先连回
    expect(router.upstreamOk).toBe(false); // paper 还断着
    await vi.advanceTimersByTimeAsync(2_100);
    expect(router.upstreamOk).toBe(true);
  });

  it("换下的旧会话再说什么都不算;disconnectAll 清掉", async () => {
    const { router, wires } = makeRouter();
    await router.connect("live");
    const old = wireOf(wires, 7496);
    old.tws.emit("info", LOST, 1100);
    // socket 断着时有人要用这条连接:router 把旧会话停掉、换一条新的(新会话从"通"算起)
    const fresh = await router.connect("live");
    expect(fresh).not.toBe(old.session);
    expect(router.upstreamOk).toBe(true);
    old.tws.emit("info", LOST, 1100);
    expect(router.upstreamOk).toBe(true);

    wireOf(wires, 7496).tws.emit("info", BROKEN, 2110);
    expect(router.upstreamOk).toBe(false);
    await router.disconnectAll();
    expect(router.upstreamOk).toBe(true);
  });

  it("socket 断着时用户点了断开:库不再自己连回来,掉线 / 连回与上游标志都不再变", async () => {
    const { router, wires, links } = makeRouter();
    await router.connect("live");
    const { session, tws } = wireOf(wires, 7496);
    tws.emit("info", LOST, 1100);
    await router.disconnectAll(); // 以前只停连着的:这一条还在库里等 5 秒后重连
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.isConnected()).toBe(false);
    expect(links).toEqual([["live", false]]);
    tws.emit("info", BROKEN, 2110);
    expect(router.upstreamOk).toBe(true);
  });
});
