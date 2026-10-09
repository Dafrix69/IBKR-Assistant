/** 向 TWS 要最近几天成交的那条只读连接(src/ibExecHistory.ts)。
 *
 * 全部离线:TWS 是一个假 socket,照真机上录到的次序回话(握手 → 账户表 / 下一个订单号 / 数据农场通告 → 成交 → 发完了)。
 * 钉两样:发出去的字节一格不差(发错一格 TWS 就按别的意思读),以及不管 TWS 回什么怪东西,这条连接要么给出完整的一批、
 * 要么明说没要到——不许给半批。
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fillRow } from "../src/broker.js";
import {
  HISTORY_MAX_VERSION, decodeExecution, executionsRequestBytes, fetchExecutionHistory, frame, handshakeBytes, historyClientId,
  splitFrames, startApiBytes,
} from "../src/ibExecHistory.js";
import type { HistorySocket } from "../src/ibExecHistory.js";

/** 一条成交消息的字段(200 版):消息号、请求号、订单号、合约 11 格、成交 13 格、后面还有 6 格这里不读的。 */
function execFields(over: Partial<Record<string, string>> = {}): string[] {
  const v = {
    reqId: "1", orderId: "0", conId: "920693462", symbol: "SPX", secType: "OPT", expiry: "20261007", strike: "7790.0", right: "P",
    multiplier: "100", exchange: "CBOE", currency: "USD", localSymbol: "SPXW  261007P07790000", tradingClass: "SPXW",
    execId: "0002be7b.6ac604b0.02.01", time: "20261007-15:59:06", acct: "U1234567", execExchange: "CBOE", side: "BOT",
    shares: "1", price: "8.58", permId: "1165676521", clientId: "0", liquidation: "0", cumQty: "1", avgPrice: "8.58", orderRef: "",
    ...over,
  };
  return [
    "11", v.reqId, v.orderId, v.conId, v.symbol, v.secType, v.expiry, v.strike, v.right, v.multiplier, v.exchange, v.currency,
    v.localSymbol, v.tradingClass, v.execId, v.time, v.acct, v.execExchange, v.side, v.shares, v.price, v.permId, v.clientId,
    v.liquidation, v.cumQty, v.avgPrice, v.orderRef, "", "", "", "2", "0", "",
  ];
}

class FakeTws extends EventEmitter {
  sent: Buffer[] = [];
  ended = false;
  destroyed = false;
  write(data: Buffer): boolean {
    this.sent.push(data);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** TWS 回一批消息(一次送达) */
  say(...messages: Array<ReadonlyArray<string | number>>): void {
    this.emit("data", Buffer.concat(messages.map((m) => frame(m))));
  }
  /** 握手之后的那一串:账户表、下一个订单号、一条数据农场通告 */
  greet(version = HISTORY_MAX_VERSION): void {
    this.say([version, "20261009 10:05:01 Asia/Shanghai"]);
    this.say([15, 1, "U1234567"], [9, 1, 1], [4, -1, 2104, "Market data farm connection is OK:usfarm", "", 1791500000000]);
  }
}

function start(days = 7) {
  const tws = new FakeTws();
  const result = fetchExecutionHistory({ host: "127.0.0.1", port: 7496, clientId: historyClientId(12), days, connect: () => tws as unknown as HistorySocket });
  tws.emit("connect");
  return { tws, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("发出去的字节", () => {
  it("握手:API\\0 + 4 字节长度 + v100..200(只谈到带天数的那一版,不往 protobuf 那边谈)", () => {
    expect(handshakeBytes()).toEqual(Buffer.concat([Buffer.from("API\0"), Buffer.from([0, 0, 0, 9]), Buffer.from("v100..200")]));
  });

  it("一条消息:4 字节长度 + 每个字段后面一个 \\0;报到与要成交逐格对着官方客户端的次序", () => {
    expect(frame(["a", 7])).toEqual(Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from("a\x007\0")]));
    expect(startApiBytes(9012).subarray(4).toString()).toBe("71\x002\x009012\0\0");
    // 消息号 7、版本 3、请求号、过滤条件七格(client 0 = 不限,其余空)、最近几天、指定日期的个数
    expect(executionsRequestBytes(1, 7).subarray(4).toString()).toBe("7\x003\x001\x000\0\0\0\0\0\0\x007\x000\0");
    expect(historyClientId(12)).toBe(9012);
  });
});

describe("收进来的字节", () => {
  it("切消息:一批里几条、一条被切成几批、最后半条留着等;中文不被切坏", () => {
    const all = Buffer.concat([frame([15, 1, "U1"]), frame([4, -1, 2104, "行情连接正常", "", 1]), frame([55, 1, 1])]);
    const first = splitFrames(all.subarray(0, 20));
    expect(first.frames).toEqual([["15", "1", "U1"]]);
    const second = splitFrames(Buffer.concat([first.rest, all.subarray(20, all.length - 3)]));
    expect(second.frames).toEqual([["4", "-1", "2104", "行情连接正常", "", "1"]]);
    expect(splitFrames(Buffer.concat([second.rest, all.subarray(all.length - 3)]))).toEqual({ frames: [["55", "1", "1"]], rest: Buffer.alloc(0) });
    expect(splitFrames(Buffer.from([0, 0]))).toEqual({ frames: [], rest: Buffer.from([0, 0]) });
  });

  it("长度不像话(读错了位置):抛,不去等一条永远凑不齐的消息", () => {
    expect(() => splitFrames(Buffer.from([0x7f, 0, 0, 0, 1]))).toThrow(/长度不对/);
  });

  it("成交消息:按位置读合约与成交;和平时那条连接存下来的行长得一样", () => {
    const got = decodeExecution(execFields());
    expect(got?.reqId).toBe(1);
    expect(fillRow(got!.detail.contract, got!.detail.execution)).toEqual({
      exec_id: "0002be7b.6ac604b0.02.01", time: "2026-10-07T15:59:06+00:00", account_id: "U1234567", side: "BOT", shares: 1, price: 8.58,
      order_id: null, perm_id: 1165676521, order_ref: "", commission: 0,
      contract: {
        secType: "OPT", symbol: "SPX", expiry: "20261007", strike: 7790, right: "P", tradingClass: "SPXW", multiplier: "100",
        conId: 920693462, currency: "USD", exchange: "CBOE",
      },
    });
    // 股票:没有行权价、没有看涨看跌(TWS 发的是空或 "?"),乘数空着
    const stock = decodeExecution(execFields({ secType: "STK", symbol: "TTWO", expiry: "", strike: "0", right: "?", multiplier: "", tradingClass: "NMS", shares: "15", price: "202.4795" }));
    expect(fillRow(stock!.detail.contract, stock!.detail.execution)).toMatchObject({
      shares: 15, price: 202.4795, contract: { secType: "STK", strike: null, right: "", multiplier: "0", tradingClass: "NMS" },
    });
  });

  it("后面再多出字段不受影响;前面那一段不够就整条不认", () => {
    expect(decodeExecution([...execFields(), "以后", "加的", "字段"])?.detail.execution["execId"]).toBe("0002be7b.6ac604b0.02.01");
    expect(decodeExecution(execFields().slice(0, 26))).toBeNull();
  });
});

describe("要一趟", () => {
  it("握手 → 报到 → TWS 认了才发请求(只发一次)→ 收成交 → 发完了:给出整批,把连接关掉", async () => {
    const { tws, result } = start();
    expect(tws.sent).toEqual([handshakeBytes()]);
    tws.greet();
    // 账户表与下一个订单号都来了,请求只发一次
    expect(tws.sent.slice(1)).toEqual([startApiBytes(9012), executionsRequestBytes(1, 7)]);
    // 成交被切成两批送达;中间夹着这里不认的消息(佣金回报、别的请求的成交、没见过的消息号)
    const bytes = Buffer.concat([
      frame(execFields()), frame([59, 1, "0002be7b.6ac604b0.02.01", "1.63", "USD", "1.7976931348623157E308", "1.7976931348623157E308", ""]),
      frame(execFields({ reqId: "9", execId: "别人的请求" })), frame([999, "没见过"]),
      frame(execFields({ execId: "0002be7b.6ac604b0.03.01", strike: "7770.0", side: "SLD", shares: "2", price: "2.55" })),
    ]);
    tws.emit("data", bytes.subarray(0, 150));
    tws.emit("data", bytes.subarray(150));
    tws.say([55, 1, 9]);
    expect(tws.ended).toBe(false);
    tws.say([55, 1, 1]);
    const got = await result;
    expect(got.serverVersion).toBe(200);
    expect(got.supported).toBe(true);
    expect(got.details.map((d) => [d.execution["execId"], d.execution["side"], d.execution["shares"], d.contract["strike"]])).toEqual([
      ["0002be7b.6ac604b0.02.01", "BOT", 1, 7790], ["0002be7b.6ac604b0.03.01", "SLD", 2, 7770],
    ]);
    expect(tws.ended).toBe(true);
    // 关掉之后 TWS 那头断开:不再有任何动静
    tws.emit("close");
  });

  it("TWS 太老(谈下来不到 200):不报到、不发请求,回「给不了」", async () => {
    const { tws, result } = start();
    tws.say([187, "20261009 10:05:01 Asia/Shanghai"]);
    expect(await result).toEqual({ serverVersion: 187, supported: false, details: [] });
    expect(tws.sent).toHaveLength(1);
    expect(tws.ended).toBe(true);
  });

  it("往回几天只在 1–7 之间", () => {
    const many = start(30);
    many.tws.greet();
    expect(many.tws.sent[2]).toEqual(executionsRequestBytes(1, 7));
    const none = start(0);
    none.tws.greet();
    expect(none.tws.sent[2]).toEqual(executionsRequestBytes(1, 1));
    for (const s of [many, none]) {
      s.tws.emit("close");
      s.result.catch(() => undefined);
    }
  });

  it("client id 被占着(326)、TWS 把连接关了:明说没要到,带上 TWS 的原话;数据农场的通告不算原因", async () => {
    const { tws, result } = start();
    tws.say([200, "20261009 10:05:01 Asia/Shanghai"]);
    tws.say([4, -1, 2104, "Market data farm connection is OK:usfarm", "", 1], [4, -1, 326, "Unable to connect as the client id is already in use.", "", 2]);
    tws.emit("close");
    await expect(result).rejects.toThrow("往回要成交的连接被 TWS 关了:326 Unable to connect as the client id is already in use.");
    expect(tws.destroyed).toBe(true);
  });

  it("TWS 拒了这个请求:不等超时,带上原话", async () => {
    const { tws, result } = start();
    tws.greet();
    tws.say([4, 1, 321, "Error validating request.-'bN' : cause - Invalid", "", 3]);
    await expect(result).rejects.toThrow(/TWS 拒了往回要成交的请求:321 Error validating request/);
  });

  it("成交发到一半出了怪东西(字段不够):整趟作废,不给半批", async () => {
    const { tws, result } = start();
    tws.greet();
    tws.say(execFields(), execFields().slice(0, 20), [55, 1, 1]);
    await expect(result).rejects.toThrow(/字段不够/);
    expect(tws.destroyed).toBe(true);
  });

  it("连不上、TWS 不答:各说各的,连接关干净", async () => {
    const refused = start();
    refused.tws.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:7496"));
    await expect(refused.result).rejects.toThrow("往回要成交的连接出错:connect ECONNREFUSED 127.0.0.1:7496");

    vi.useFakeTimers();
    const silent = start();
    silent.tws.greet();
    const outcome = silent.result.catch((e: Error) => e.message);
    vi.advanceTimersByTime(8000);
    expect(await outcome).toBe("往回要成交等了 8 秒没有回应");
    expect(silent.tws.destroyed).toBe(true);
    // 超时之后才到的消息不再理
    silent.tws.say(execFields(), [55, 1, 1]);
  });
});
