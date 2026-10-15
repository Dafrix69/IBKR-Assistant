/** K 线的日盘与夜盘两条线(ibBars.ts):哪条开着、关着的留多久、怎么拼。离线,钟点由测试给。 */
import { describe, expect, it } from "vitest";

import {
  OVERNIGHT_EXCHANGE, OVERNIGHT_RETRY_MS, SessionBars, barTimestamp, legClosedSince, legOpen, mergeSessionBars, overnightContract,
  proxyIndexBars, toSessionBar,
} from "../src/ibBars.js";
import type { SessionBar } from "../src/ibBars.js";
import type { IbContract, IbSession, RawBar } from "../src/ibTypes.js";
import { indexContract, indexFuturesContract, stockContract } from "../src/ibContracts.js";
import { DELAYED_FEED_MAX_MS, feedOf, proxyOf } from "../src/marketdata.js";
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

// ---------------------------------------------------------------- 指数:盘外按期货推算
describe("指数与期货推算两条线的时段", () => {
  it.each([
    ["2026-10-12", "09:29", false, true, "周一开盘前:期货那段"],
    ["2026-10-12", "09:30", true, false, "09:30 起是指数"],
    ["2026-10-12", "15:59", true, false, "收盘前一分钟"],
    ["2026-10-12", "16:00", false, true, "16:00 起又是期货"],
    ["2026-10-15", "23:00", false, true, "周四夜里"],
    ["2026-10-16", "03:00", false, true, "周五凌晨"],
    ["2026-10-16", "16:30", false, true, "周五收盘后、期货 17:00 收之前"],
    ["2026-10-16", "17:30", false, false, "周五 17:00 后期货也收了"],
    ["2026-10-17", "12:00", false, false, "周六"],
    ["2026-10-18", "17:59", false, false, "周日 18:00 之前"],
    ["2026-10-18", "18:00", false, true, "周日 18:00 期货开"],
  ])("%s %s → 指数 %s 期货推算 %s(%s)", (date, hhmm, index, proxy) => {
    const now = et(date, hhmm);
    expect(legOpen("index", now)).toBe(index);
    expect(legOpen("proxy", now)).toBe(proxy);
  });

  it("关着的那条从几点起关着:指数是上一个 16:00;期货推算是上一个 09:30,周末是周五 17:00", () => {
    expect(legClosedSince("index", et("2026-10-12", "08:00"))).toBe(et("2026-10-09", "16:00"));
    expect(legClosedSince("index", et("2026-10-13", "20:00"))).toBe(et("2026-10-13", "16:00"));
    expect(legClosedSince("proxy", et("2026-10-12", "10:00"))).toBe(et("2026-10-12", "09:30"));
    expect(legClosedSince("proxy", et("2026-10-17", "12:00"))).toBe(et("2026-10-16", "17:00"));
    expect(legClosedSince("proxy", et("2026-10-18", "17:00"))).toBe(et("2026-10-16", "17:00"));
    expect(legClosedSince("index", et("2026-10-12", "10:00"))).toBeNull();
  });
});

describe("指数的盘外按期货推算(proxyIndexBars)", () => {
  const ohlc = (time: string, close: number): SessionBar => ({ time, open: close - 1, high: close + 2, low: close - 3, close, volume: 7 });

  it("基差 = 收盘最后一根的期货 − 指数;收盘之后到下一个开盘之前的期货减去它;常规时段里的不推算", () => {
    const index = [ohlc("2026-10-09 15:50", 7700), ohlc("2026-10-09 15:55", 7710), ohlc("2026-10-12 09:30", 7720), ohlc("2026-10-12 09:35", 7725)];
    const futures = [
      ohlc("2026-10-09 15:55", 7760), ohlc("2026-10-09 16:00", 7765), ohlc("2026-10-11 18:00", 7770),
      ohlc("2026-10-12 09:25", 7775), ohlc("2026-10-12 09:30", 7778),
    ];
    const r = proxyIndexBars(index, futures);
    expect(r.bars.map((b) => [b.time, b.close])).toEqual([
      ["2026-10-09 15:50", 7700], ["2026-10-09 15:55", 7710],
      ["2026-10-09 16:00", 7715], ["2026-10-11 18:00", 7720], ["2026-10-12 09:25", 7725],
      ["2026-10-12 09:30", 7720], ["2026-10-12 09:35", 7725],
    ]);
    expect(r.bars[2]).toEqual({ time: "2026-10-09 16:00", open: 7714, high: 7717, low: 7712, close: 7715, volume: 0 });
    expect(r).toMatchObject({ derived: 3, newestDerived: false, latestBasis: { basis: 50, time: "2026-10-09 15:55" } });
    expect(r.spans).toEqual([{ from: "2026-10-09 16:00", to: "2026-10-12 09:25" }]);
  });

  it("前面没有算得出基差的收盘就不推算:第一个收盘之前的、那一段收盘最后一刻没有期货 K 线的,都不拿别的基差往上套", () => {
    const index = [ohlc("2026-10-08 15:55", 7600), ohlc("2026-10-09 15:55", 7700)];
    const futures = [ohlc("2026-10-08 10:00", 7000), ohlc("2026-10-08 15:55", 7640), ohlc("2026-10-08 16:00", 7650), ohlc("2026-10-09 16:00", 7760)];
    const r = proxyIndexBars(index, futures);
    // 10-08 10:00 在第一个收盘之前;10-09 收盘那一刻没有期货 K 线,10-09 16:00 不推算(不拿 10-08 的 40 往上套)
    expect(r.bars.map((b) => b.time)).toEqual(["2026-10-08 15:55", "2026-10-08 16:00", "2026-10-09 15:55"]);
    expect(r.bars[1]!.close).toBe(7610);
  });

  it("常规时段中间缺了几根不拿期货补;今晚的推算在最后 → newestDerived", () => {
    const index = [ohlc("2026-10-12 09:30", 7720), ohlc("2026-10-12 09:40", 7730)];
    const futures = [ohlc("2026-10-12 09:35", 7790), ohlc("2026-10-12 09:40", 7780), ohlc("2026-10-12 09:45", 7785)];
    const r = proxyIndexBars(index, futures);
    expect(r.bars.map((b) => b.time)).toEqual(["2026-10-12 09:30", "2026-10-12 09:40", "2026-10-12 09:45"]);
    expect(r.bars[2]!.close).toBe(7735);
    expect(r.newestDerived).toBe(true);
    expect(proxyIndexBars(index, []).derived).toBe(0);
  });
});

/** 按交易所回 K 线的假会话,另带「这张合约的成交价出自哪一档」 */
class IndexSession extends FakeSession {
  readonly feeds = new Map<string, boolean | null>([["IND", true], ["FUT", false]]);
  quoteDelayed(contract: IbContract): boolean | null {
    return this.feeds.get(contract.secType) ?? null;
  }
}

describe("取指数 + 期货推算(SessionBars)", () => {
  const SPX = { ...indexContract("SPX", "CBOE"), conId: 416904 };
  const ES = indexFuturesContract({ futures: "ES", futures_exchange: "CME" }, "2026-10-12");
  function spxSession(): IndexSession {
    const s = new IndexSession();
    s.byExchange.set("CBOE", [raw("20261009 14:55:00 US/Central", 7710)]);
    s.byExchange.set("CME", [raw("20261009 14:55:00 US/Central", 7760), raw("20261012 02:30:00 US/Central", 7790)]);
    return s;
  }
  const req = (nowMs: number, futures: IbContract | null = ES) => ({
    target: SPX, endDateTime: "", durationStr: "5 D", barSizeSetting: "5 mins", whatToShow: "TRADES", useRTH: false,
    overnight: false, futures, nowMs,
  });

  it("夜里:指数与期货各问一次,期货那张是最近季月;拼好的 K 线上记着怎么推算的,档位看期货那条流", async () => {
    expect(ES).toMatchObject({ secType: "FUT", symbol: "ES", exchange: "CME", lastTradeDateOrContractMonth: "202612" });
    const s = spxSession();
    const bars = await new SessionBars().fetch(s.as(), req(et("2026-10-12", "03:35")));
    expect(s.asked.sort()).toEqual(["CBOE", "CME"]);
    expect(bars.map((b) => [b.time, b.close])).toEqual([["2026-10-09 15:55", 7710], ["2026-10-12 03:30", 7740]]);
    const proxy = proxyOf(bars)!;
    expect(proxy).toMatchObject({ futures: "ES 202612", derived: 1, spans: [{ from: "2026-10-12 03:30", to: "2026-10-12 03:30" }] });
    expect(proxy.note).toContain("按 ES 202612 减基差推算");
    expect(proxy.note).toContain("最近一个 50 点(2026-10-09 15:55)");
    expect(feedOf(bars)).toBe("live"); // 最后一根是推算的:看期货(实时),不看指数(延迟)
  });

  it("盘中:指数每次重取,期货那份留着(它关着、而且是开盘 20 分钟后取的);夜里反过来", async () => {
    const s = spxSession();
    s.byExchange.set("CBOE", [raw("20261009 14:55:00 US/Central", 7710), raw("20261012 08:30:00 US/Central", 7745)]);
    const sb = new SessionBars();
    await sb.fetch(s.as(), req(et("2026-10-12", "10:00")));
    const day = await sb.fetch(s.as(), req(et("2026-10-12", "10:01")));
    expect(s.asked).toEqual(["CBOE", "CME", "CBOE"]);
    expect(feedOf(day)).toBe("delayed"); // 最后一根是指数自己的
    const n = spxSession();
    const night = new SessionBars();
    await night.fetch(n.as(), req(et("2026-10-12", "22:00")));
    await night.fetch(n.as(), req(et("2026-10-12", "22:01")));
    expect(n.asked).toEqual(["CBOE", "CME", "CME"]);
  });

  it("期货要不到:只给指数,说明里写原因,半小时内不再问;不给期货就是老样子(不记推算)", async () => {
    const s = spxSession();
    s.byExchange.set("CME", new Error("No market data permissions for CME FUT"));
    const sb = new SessionBars();
    const now = et("2026-10-12", "03:35");
    const bars = await sb.fetch(s.as(), req(now));
    expect(bars.map((b) => b.time)).toEqual(["2026-10-09 15:55"]);
    expect(proxyOf(bars)).toMatchObject({ derived: 0, spans: [] });
    expect(proxyOf(bars)!.note).toContain("没取到期货 K 线(No market data permissions for CME FUT)");
    await sb.fetch(s.as(), req(now + 60_000));
    expect(s.asked.filter((x) => x === "CME")).toHaveLength(1);
    expect(proxyOf(await new SessionBars().fetch(spxSession().as(), req(now, null)))).toBeUndefined();
  });
});
