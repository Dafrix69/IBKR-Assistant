/** K 线的日盘与夜盘两条线(ibBars.ts):哪条开着、关着的留多久、怎么拼。离线,钟点由测试给。 */
import { describe, expect, it } from "vitest";

import {
  OVERNIGHT_EXCHANGE, OVERNIGHT_RETRY_MS, SessionBars, barTimestamp, legClosedSince, legOpen, mergeSessionBars, overnightContract, toSessionBar,
} from "../src/ibBars.js";
import type { SessionBar } from "../src/ibBars.js";
import type { IbContract, IbSession, RawBar } from "../src/ibTypes.js";
import { stockContract } from "../src/ibContracts.js";
import { DELAYED_FEED_MAX_MS } from "../src/marketdata.js";
import { ET, wallToEpoch } from "../src/tz.js";

/** 美东墙钟 → 时刻。2026-10-12 是周一(夏令时);2026-01-12 也是周一(冬令时)。 */
function et(date: string, hhmm: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return wallToEpoch({ year: y, month: m, day: d, hour, minute, second: 0 }, ET);
}

describe("哪条线开着", () => {
  it.each([
    ["2026-10-12", "03:00", false, true, "周一凌晨:夜盘"],
    ["2026-10-12", "03:59", false, true, "夜盘最后一分钟"],
    ["2026-10-12", "04:00", true, false, "04:00 起日盘(盘前)"],
    ["2026-10-12", "10:00", true, false, "周一盘中"],
    ["2026-10-12", "19:59", true, false, "盘后最后一分钟"],
    ["2026-10-12", "20:00", false, true, "20:00 起夜盘"],
    ["2026-10-15", "23:30", false, true, "周四夜里"],
    ["2026-10-16", "03:30", false, true, "周五凌晨仍是周四那一夜"],
    ["2026-10-16", "21:00", false, false, "周五晚上两条都关"],
    ["2026-10-17", "12:00", false, false, "周六"],
    ["2026-10-18", "19:00", false, false, "周日傍晚"],
    ["2026-10-18", "20:00", false, true, "周日 20:00 夜盘开"],
    ["2026-01-12", "10:00", true, false, "冬令时的周一盘中"],
    ["2026-01-12", "02:00", false, true, "冬令时的周一凌晨"],
  ])("%s %s → 日盘 %s 夜盘 %s(%s)", (date, hhmm, day, night) => {
    const now = et(date, hhmm);
    expect(legOpen("day", now)).toBe(day);
    expect(legOpen("overnight", now)).toBe(night);
  });
});

describe("关着的那条从几点起关着", () => {
  it("开着是 null", () => {
    expect(legClosedSince("day", et("2026-10-12", "10:00"))).toBeNull();
    expect(legClosedSince("overnight", et("2026-10-12", "02:00"))).toBeNull();
  });
  it("日盘:周一凌晨关着的是上周五 20:00 起;周二晚上是当天 20:00 起", () => {
    expect(legClosedSince("day", et("2026-10-12", "02:00"))).toBe(et("2026-10-09", "20:00"));
    expect(legClosedSince("day", et("2026-10-13", "21:00"))).toBe(et("2026-10-13", "20:00"));
    expect(legClosedSince("day", et("2026-10-17", "12:00"))).toBe(et("2026-10-16", "20:00"));
  });
  it("夜盘:白天关着的是当天 04:00 起;周末是周五 04:00 起;周五晚上也是周五 04:00 起", () => {
    expect(legClosedSince("overnight", et("2026-10-12", "10:00"))).toBe(et("2026-10-12", "04:00"));
    expect(legClosedSince("overnight", et("2026-10-17", "12:00"))).toBe(et("2026-10-16", "04:00"));
    expect(legClosedSince("overnight", et("2026-10-16", "21:00"))).toBe(et("2026-10-16", "04:00"));
  });
});

function bar(time: string, close = 1): SessionBar {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("两条线拼成一组", () => {
  it("按时间排;夜盘接在盘后后面、盘前前面", () => {
    const day = [bar("2026-10-09 19:30"), bar("2026-10-09 19:45"), bar("2026-10-12 04:00")];
    const night = [bar("2026-10-09 20:00"), bar("2026-10-12 03:45")];
    expect(mergeSessionBars(day, night).map((b) => b.time)).toEqual([
      "2026-10-09 19:30", "2026-10-09 19:45", "2026-10-09 20:00", "2026-10-12 03:45", "2026-10-12 04:00",
    ]);
  });
  it("同一时刻两边都有留日盘那根;夜盘空着就是日盘自己(拷一份)", () => {
    const day = [bar("2026-10-09 19:45", 10)];
    expect(mergeSessionBars(day, [bar("2026-10-09 19:45", 99)])[0]!.close).toBe(10);
    const alone = mergeSessionBars(day, []);
    expect(alone).toEqual(day);
    expect(alone).not.toBe(day);
  });
  it("原始 K 线归一化:交易所时区换成美东,指数的 -1 成交量归零", () => {
    expect(barTimestamp("20261012 03:30:00 US/Eastern")).toBe("2026-10-12 03:30");
    expect(toSessionBar({ date: "20261012 02:30:00 US/Central", open: 1, high: 2, low: 0.5, close: 1.5, volume: -1 }))
      .toEqual({ time: "2026-10-12 03:30", open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 });
  });
});

/** 只会回历史 K 线的假会话:按交易所给不同的 K 线,记下每次问的是哪个交易所。 */
class FakeSession {
  readonly asked: string[] = [];
  readonly contracts: IbContract[] = [];
  readonly byExchange = new Map<string, RawBar[] | Error>();
  async historicalData(contract: IbContract): Promise<RawBar[]> {
    this.asked.push(contract.exchange);
    this.contracts.push(contract);
    const got = this.byExchange.get(contract.exchange) ?? [];
    if (got instanceof Error) throw got;
    return got;
  }
  as(): IbSession {
    return this as unknown as IbSession;
  }
}

const raw = (stamp: string, close: number): RawBar => ({ date: stamp, open: close, high: close, low: close, close, volume: 1 });

function fakes(): FakeSession {
  const s = new FakeSession();
  s.byExchange.set("SMART", [raw("20261009 19:30:00 US/Eastern", 35.3), raw("20261009 19:45:00 US/Eastern", 35.21)]);
  s.byExchange.set(OVERNIGHT_EXCHANGE, [raw("20261009 20:00:00 US/Eastern", 35.25), raw("20261012 03:30:00 US/Eastern", 38.38)]);
  return s;
}

function request(nowMs: number, overnight = true, extra: Partial<Parameters<SessionBars["fetch"]>[1]> = {}) {
  return {
    target: { ...stockContract("IREN"), conId: 12345 }, endDateTime: "", durationStr: "10 D", barSizeSetting: "15 mins",
    whatToShow: "TRADES", useRTH: false, overnight, nowMs, ...extra,
  };
}

describe("取两条线", () => {
  it("要夜盘:SMART 与 OVERNIGHT 各问一次,夜盘那张合约按代码重拼、不带 conId,拼好按时间排", async () => {
    const s = fakes();
    const bars = await new SessionBars().fetch(s.as(), request(et("2026-10-12", "03:35")));
    expect(s.asked.sort()).toEqual([OVERNIGHT_EXCHANGE, "SMART"]);
    expect(s.contracts.find((c) => c.exchange === OVERNIGHT_EXCHANGE)).toEqual({ secType: "STK", symbol: "IREN", exchange: "OVERNIGHT", currency: "USD" });
    expect(s.contracts.find((c) => c.exchange === "SMART")?.conId).toBe(12345);
    expect(overnightContract({ ...stockContract("SPY"), conId: 7 })).toEqual({ secType: "STK", symbol: "SPY", exchange: "OVERNIGHT", currency: "USD" });
    expect(bars.map((b) => [b.time, b.close])).toEqual([
      ["2026-10-09 19:30", 35.3], ["2026-10-09 19:45", 35.21], ["2026-10-09 20:00", 35.25], ["2026-10-12 03:30", 38.38],
    ]);
  });

  it("不要夜盘:只问 SMART", async () => {
    const s = fakes();
    const bars = await new SessionBars().fetch(s.as(), request(et("2026-10-12", "03:35"), false));
    expect(s.asked).toEqual(["SMART"]);
    expect(bars).toHaveLength(2);
  });

  it("白天:日盘每次重取,夜盘那份留着(关着、而且取的时候已过了延迟档的 20 分钟)", async () => {
    const s = fakes();
    const sb = new SessionBars();
    await sb.fetch(s.as(), request(et("2026-10-12", "10:00")));
    await sb.fetch(s.as(), request(et("2026-10-12", "10:01")));
    expect(s.asked).toEqual([ "SMART", OVERNIGHT_EXCHANGE, "SMART" ]);
    // 拼出来的仍然带着夜盘
    const bars = await sb.fetch(s.as(), request(et("2026-10-12", "10:02")));
    expect(bars.some((b) => b.time === "2026-10-12 03:30")).toBe(true);
  });

  it("夜里:夜盘每次重取,日盘那份留着;周末两条都留着", async () => {
    const s = fakes();
    const sb = new SessionBars();
    await sb.fetch(s.as(), request(et("2026-10-12", "22:00")));
    await sb.fetch(s.as(), request(et("2026-10-12", "22:01")));
    expect(s.asked).toEqual(["SMART", OVERNIGHT_EXCHANGE, OVERNIGHT_EXCHANGE]);

    const w = fakes();
    const weekend = new SessionBars();
    await weekend.fetch(w.as(), request(et("2026-10-17", "12:00")));
    await weekend.fetch(w.as(), request(et("2026-10-17", "12:30")));
    expect(w.asked).toEqual(["SMART", OVERNIGHT_EXCHANGE]);
  });

  it("刚收盘的 20 分钟里不留:延迟档的最后一根还没到齐", async () => {
    const s = fakes();
    const sb = new SessionBars();
    const closed = et("2026-10-12", "20:00");
    await sb.fetch(s.as(), request(closed + 5 * 60_000));
    await sb.fetch(s.as(), request(closed + 10 * 60_000));
    expect(s.asked.filter((x) => x === "SMART")).toHaveLength(2);
    // 过了 20 分钟取的那份才留
    await sb.fetch(s.as(), request(closed + DELAYED_FEED_MAX_MS));
    await sb.fetch(s.as(), request(closed + DELAYED_FEED_MAX_MS + 60_000));
    expect(s.asked.filter((x) => x === "SMART")).toHaveLength(3);
  });

  it("留着的那份是拷贝;换时长是另一份", async () => {
    const s = fakes();
    const sb = new SessionBars();
    const now = et("2026-10-12", "10:00");
    const a = await sb.fetch(s.as(), request(now));
    const b = await sb.fetch(s.as(), request(now + 1000));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    await sb.fetch(s.as(), request(now + 2000, true, { durationStr: "20 D" }));
    expect(s.asked.filter((x) => x === OVERNIGHT_EXCHANGE)).toHaveLength(2);
  });

  it("夜盘要不到:只给日盘,记下原因,半小时内不再问;日盘要不到整次失败", async () => {
    const s = fakes();
    s.byExchange.set(OVERNIGHT_EXCHANGE, new Error("No security definition has been found for the request"));
    const sb = new SessionBars();
    const now = et("2026-10-12", "03:35");
    expect((await sb.fetch(s.as(), request(now))).map((b) => b.time)).toEqual(["2026-10-09 19:30", "2026-10-09 19:45"]);
    expect(sb.overnightErrors.get("IREN")).toContain("No security definition");
    await sb.fetch(s.as(), request(now + 60_000));
    expect(s.asked.filter((x) => x === OVERNIGHT_EXCHANGE)).toHaveLength(1);
    s.byExchange.set(OVERNIGHT_EXCHANGE, [raw("20261012 03:30:00 US/Eastern", 38.38)]);
    const again = await sb.fetch(s.as(), request(now + OVERNIGHT_RETRY_MS));
    expect(again.map((b) => b.time)).toContain("2026-10-12 03:30");
    expect(sb.overnightErrors.has("IREN")).toBe(false);

    s.byExchange.set("SMART", new Error("pacing violation"));
    await expect(sb.fetch(s.as(), request(now + OVERNIGHT_RETRY_MS + 1000))).rejects.toThrow("pacing violation");
  });
});
