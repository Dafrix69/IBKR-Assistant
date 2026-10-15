/** 重要事件的日历(econCalendar.ts):内置日程、日历源的解析与合并、口径的校验。全部离线。
 *
 * 钉四件事:
 *  1. 内置日程每一条都是合法的工作日、同一家族同一天不重复;美东钟点换成 epoch 时夏令时算对(11 月 1 日之后是 EST)。
 *  2. 日历源:只要美国的、够档的;同一时刻同一家族合成一条,原文全部带上;Holiday / Low / 别国的不要;坏载荷当空的。
 *  3. 合并:内置与日历源撞上同一天同一家族时以日历源为准,但名字与 id 用内置的;其余各自保留;按时间排。
 *  4. 口径:一次只改一两项,在当前那份上合并;越界当场拒。
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_RELEASES, DEFAULT_EVENTS_CONFIG, EventsConfigError, builtinEvents, builtinProblems, etEpoch, expiresAt, familyOf,
  mergeEvents, normalizeEventsConfig, parseFeed,
} from "../src/econCalendar.js";

const FEED = [
  { title: "Bank Holiday", country: "USD", date: "2026-10-12T07:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
  { title: "FOMC Member Hammack Speaks", country: "USD", date: "2026-10-12T12:10:00-04:00", impact: "Low", forecast: "", previous: "" },
  { title: "PPI y/y", country: "JPY", date: "2026-10-12T19:50:00-04:00", impact: "Low", forecast: "7.6%", previous: "7.6%" },
  { title: "Core CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.2%", previous: "0.3%" },
  { title: "Core CPI y/y", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "2.5%", previous: "2.4%" },
  { title: "CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" },
  { title: "CPI y/y", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "3.6%", previous: "3.4%" },
  { title: "Core PPI m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
  { title: "Core Retail Sales m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "1.4%" },
  { title: "PPI m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" },
  { title: "Retail Sales m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "1.2%" },
  { title: "Philly Fed Manufacturing Index", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "Medium", forecast: "28.2", previous: "37.8" },
  { title: "Unemployment Claims", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "Medium", forecast: "199K", previous: "197K" },
  { title: "Fed Chairman Warsh Speaks", country: "USD", date: "2026-10-15T23:30:00-04:00", impact: "High", forecast: "", previous: "" },
  { title: "CB Consumer Confidence", country: "USD", date: "2026-10-27T10:00:00-04:00", impact: "High", forecast: "95", previous: "94" },
];

describe("内置日程", () => {
  it("每一条都是合法的工作日、同一家族同一天不重复", () => {
    expect(BUILTIN_RELEASES.length).toBeGreaterThan(60);
    expect(builtinProblems()).toEqual([]);
  });

  it("美东钟点换成 epoch:夏令时(10 月)与冬令时(11 月之后)各按各的偏移", () => {
    expect(etEpoch("2026-10-14", "08:30")).toBe(Date.parse("2026-10-14T08:30:00-04:00"));
    expect(etEpoch("2026-11-10", "08:30")).toBe(Date.parse("2026-11-10T08:30:00-05:00"));
    expect(etEpoch("2026-12-09", "14:00")).toBe(Date.parse("2026-12-09T14:00:00-05:00"));
    expect(etEpoch("2027-02-30", "08:30")).toBeNull();
    expect(etEpoch("2026-11-10", "25:00")).toBeNull();
    expect(etEpoch("11/10/2026", "08:30")).toBeNull();
  });

  it("窗口里的事按时间排,名字带参考月,FOMC 决议公布之后挂 150 分钟", () => {
    const from = Date.parse("2026-11-01T00:00:00-04:00");
    const to = Date.parse("2026-11-30T23:59:59-05:00");
    const list = builtinEvents(from, to);
    expect(list.map((e) => `${e.date_et} ${e.time_et} ${e.title}`)).toEqual([
      "2026-11-06 08:30 非农就业(10月)",
      "2026-11-10 08:30 CPI(10月)",
      "2026-11-13 08:30 PPI(10月)",
      "2026-11-25 08:30 PCE 物价(10月)",
    ]);
    const fomc = builtinEvents(Date.parse("2026-12-01T00:00:00-05:00"), Date.parse("2026-12-31T00:00:00-05:00")).find((e) => e.kind === "fomc");
    expect(fomc?.title).toBe("FOMC 利率决议(含经济预测)");
    expect(fomc && expiresAt(fomc) - fomc.at).toBe(150 * 60_000);
    expect(list[0]?.id).toBe("builtin:nfp:2026-11-06");
    expect(list.every((e) => e.source === "builtin" && e.impact === "high")).toBe(true);
  });
});

describe("日历源", () => {
  it("只要美国的、够档的;同一时刻同一家族合成一条,原文全部带上", () => {
    const list = parseFeed(FEED, false);
    expect(list.map((e) => `${e.date_et} ${e.time_et} ${e.kind} ${e.title}`)).toEqual([
      "2026-10-14 08:30 cpi CPI",
      "2026-10-15 08:30 ppi PPI",
      "2026-10-15 08:30 retail 零售销售",
      "2026-10-15 23:30 fed_speech 美联储讲话(Warsh)",
      "2026-10-27 10:00 other CB Consumer Confidence",
    ]);
    const cpi = list[0]!;
    expect(cpi.items?.map((i) => `${i.title}=${i.forecast}/${i.previous}`)).toEqual([
      "Core CPI m/m=0.2%/0.3%", "Core CPI y/y=2.5%/2.4%", "CPI m/m=0.6%/0.4%", "CPI y/y=3.6%/3.4%",
    ]);
    expect(cpi.at).toBe(Date.parse("2026-10-14T08:30:00-04:00"));
    expect(cpi.id).toBe(`feed:cpi:${cpi.at}`);
    expect(cpi.source).toBe("feed");
  });

  it("开了中等影响才带初请与费城联储;Holiday 与 Low 永远不要", () => {
    const list = parseFeed(FEED, true);
    expect(list.filter((e) => e.impact === "medium").map((e) => e.title)).toEqual(["初请失业金", "Philly Fed Manufacturing Index"]);
    expect(list.some((e) => /Holiday|Hammack/.test(e.title))).toBe(false);
  });

  it("坏载荷当空的:不是数组、条目缺字段、日期解析不了", () => {
    expect(parseFeed(null, true)).toEqual([]);
    expect(parseFeed({ events: [] }, true)).toEqual([]);
    expect(parseFeed([{ title: "CPI m/m", country: "USD", date: "someday", impact: "High" }, 42, null], true)).toEqual([]);
  });

  it("家族归类:非农三件套、FOMC 的声明 / 利率 / 发布会、Core PCE、讲话", () => {
    expect(["Non-Farm Employment Change", "Unemployment Rate", "Average Hourly Earnings m/m"].map(familyOf)).toEqual(["nfp", "nfp", "nfp"]);
    expect(["FOMC Statement", "Federal Funds Rate", "FOMC Press Conference", "FOMC Economic Projections"].map(familyOf)).toEqual(["fomc", "fomc", "fomc", "fomc"]);
    expect(familyOf("FOMC Meeting Minutes")).toBe("fomc_minutes");
    expect(familyOf("Core PCE Price Index m/m")).toBe("pce");
    expect(familyOf("Advance GDP q/q")).toBe("gdp");
    expect(familyOf("Fed Chair Powell Testifies")).toBe("fed_speech"); // 作证和讲话一样会动市场
    expect(familyOf("ISM Manufacturing PMI")).toBe("ism");
  });
});

describe("合并", () => {
  it("内置与日历源撞上同一天同一家族:日历源顶上去,名字与 id 用内置的;其余各自保留;按时间排", () => {
    const builtin = builtinEvents(Date.parse("2026-10-13T00:00:00-04:00"), Date.parse("2026-10-31T00:00:00-04:00"));
    const feed = parseFeed(FEED, false);
    const custom = [{
      id: "custom:abc", kind: "custom" as const, title: "CRWV 发债", at: Date.parse("2026-10-14T07:00:00-04:00"),
      date_et: "2026-10-14", time_et: "07:00", impact: "high" as const, source: "custom" as const, linger_min: 90,
    }];
    const merged = mergeEvents(builtin, feed, custom);
    expect(merged.map((e) => `${e.date_et} ${e.time_et} ${e.title} [${e.source}]`)).toEqual([
      "2026-10-14 07:00 CRWV 发债 [custom]",
      "2026-10-14 08:30 CPI(9月) [feed]",
      "2026-10-15 08:30 PPI(9月) [feed]",
      "2026-10-15 08:30 零售销售 [feed]",
      "2026-10-15 23:30 美联储讲话(Warsh) [feed]",
      "2026-10-27 10:00 CB Consumer Confidence [feed]",
      "2026-10-28 14:00 FOMC 利率决议 [builtin]",
      "2026-10-29 08:30 GDP 初值(三季度) [builtin]",
      "2026-10-29 08:30 PCE 物价(9月) [builtin]",
    ]);
    const cpi = merged[1]!;
    expect(cpi.id).toBe("builtin:cpi:2026-10-14");
    expect(cpi.items?.length).toBe(4);
    expect(merged.filter((e) => e.kind === "cpi").length).toBe(1);
  });
});

describe("口径", () => {
  it("默认开着、拉日历、不要中等的、提前 60 与 15 分钟", () => {
    expect(normalizeEventsConfig(null)).toEqual(DEFAULT_EVENTS_CONFIG);
    expect(DEFAULT_EVENTS_CONFIG.lead_minutes).toEqual([60, 15]);
  });

  it("一次只改一两项,在当前那份上合并;数字串也认;提前档去重并从大到小排", () => {
    const base = normalizeEventsConfig({ medium: true }, DEFAULT_EVENTS_CONFIG);
    const next = normalizeEventsConfig({ lead_minutes: ["15", 120, 15], sector_move_pct: "4.5" }, base);
    expect(next).toEqual({ ...DEFAULT_EVENTS_CONFIG, medium: true, lead_minutes: [120, 15], sector_move_pct: 4.5 });
    expect(base.lead_minutes).toEqual([60, 15]); // 没被改
  });

  it("越界当场拒,给中文原因", () => {
    expect(() => normalizeEventsConfig({ lead_minutes: [1, 2, 3, 4, 5] })).toThrow(EventsConfigError);
    expect(() => normalizeEventsConfig({ lead_minutes: [0] })).toThrow("1 ~ 1440");
    expect(() => normalizeEventsConfig({ sector_min_stocks: 1 })).toThrow("2 ~ 30");
    expect(() => normalizeEventsConfig({ sector_share: 1.5 })).toThrow("0.3 ~ 1");
    expect(() => normalizeEventsConfig({ sector_move_pct: "abc" })).toThrow("必须是数字");
  });
});
