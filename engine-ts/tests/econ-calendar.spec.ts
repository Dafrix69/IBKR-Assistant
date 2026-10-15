/** 重要事件的日历(econCalendar.ts):内置日程、日历源的解析与合并、口径的校验。全部离线。
 *
 * 钉四件事:
 *  1. 内置日程每一条都是合法的工作日、同一家族同一天不重复;美东钟点换成 epoch 时夏令时算对(11 月 1 日之后是 EST);
 *     每周四的初请失业金按规则生成,周四是联邦假日就提前到周三。
 *  2. 日历源:只要美国的;同一时刻同一家族合成一条,原文全部带上;星级按家族定死(初请 4 星),认不出的按档位;Holiday / 别国的不要;坏载荷当空的。
 *  3. 合并:内置与日历源撞上同一天同一家族时以日历源为准,但名字与 id 用内置的;其余各自保留;按时间排。
 *  4. 口径:一次只改一两项,在当前那份上合并;越界当场拒。
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_RELEASES, DEFAULT_EVENTS_CONFIG, EventsConfigError, builtinEvents, builtinProblems, etEpoch, expiresAt, familyOf,
  claimsReleases, mergeEvents, normalizeEventsConfig, parseFeed, starsFor, thursdayIsFederalHoliday,
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

  it("窗口里的事按时间排,名字带参考月,FOMC 决议公布之后挂 150 分钟;每周四有初请", () => {
    const from = Date.parse("2026-11-01T00:00:00-04:00");
    const to = Date.parse("2026-11-30T23:59:59-05:00");
    const list = builtinEvents(from, to);
    expect(list.map((e) => `${e.date_et} ${e.time_et} ${e.title} ${e.stars}`)).toEqual([
      "2026-11-05 08:30 初请失业金(截至 10-31 当周) 4",
      "2026-11-06 08:30 非农就业(10月) 5",
      "2026-11-10 08:30 CPI(10月) 5",
      "2026-11-12 08:30 初请失业金(截至 11-07 当周) 4",
      "2026-11-13 08:30 PPI(10月) 4",
      "2026-11-19 08:30 初请失业金(截至 11-14 当周) 4",
      // 11-26 是感恩节:那一周的初请提前到周三
      "2026-11-25 08:30 初请失业金(截至 11-21 当周) 4",
      "2026-11-25 08:30 PCE 物价(10月) 4",
    ]);
    const fomc = builtinEvents(Date.parse("2026-12-01T00:00:00-05:00"), Date.parse("2026-12-31T00:00:00-05:00")).find((e) => e.kind === "fomc");
    expect(fomc?.title).toBe("FOMC 利率决议(含经济预测)");
    expect(fomc?.stars).toBe(5);
    expect(fomc && expiresAt(fomc) - fomc.at).toBe(150 * 60_000);
    expect(list[0]?.id).toBe("builtin:claims:2026-11-05");
    expect(list.every((e) => e.source === "builtin" && e.impact === "high")).toBe(true);
  });

  it("初请碰上周四的联邦假日提前到周三:元旦、六月节、独立日、退伍军人节、感恩节、圣诞", () => {
    const dates = (from: string, to: string): string[] => claimsReleases(Date.parse(`${from}T12:00:00Z`), Date.parse(`${to}T12:00:00Z`)).map((r) => r.date);
    expect(dates("2027-11-08", "2027-11-12")).toContain("2027-11-10"); // 2027-11-11 退伍军人节是周四
    expect(dates("2027-11-08", "2027-11-12")).not.toContain("2027-11-11");
    expect(dates("2025-12-22", "2026-01-02")).toEqual(expect.arrayContaining(["2025-12-24", "2025-12-31"]));
    expect(dates("2025-06-16", "2025-06-20")).toContain("2025-06-18");
    expect(dates("2024-07-01", "2024-07-05")).toContain("2024-07-03");
    expect(thursdayIsFederalHoliday("2026-11-26")).toBe(true);
    expect(thursdayIsFederalHoliday("2026-11-19")).toBe(false);
    expect(thursdayIsFederalHoliday("2020-06-18")).toBe(false); // 六月节 2021 年起才是联邦假日
  });
});

describe("日历源", () => {
  it("只要美国的;同一时刻同一家族合成一条,原文全部带上;星级按家族,认不出的按档位", () => {
    const list = parseFeed(FEED);
    expect(list.map((e) => `${e.date_et} ${e.time_et} ${e.kind} ${e.title} ${e.stars}`)).toEqual([
      "2026-10-12 12:10 fed_speech 美联储讲话(Hammack) 2",
      "2026-10-14 08:30 cpi CPI 5",
      "2026-10-15 08:30 claims 初请失业金 4",
      "2026-10-15 08:30 other Philly Fed Manufacturing Index 3",
      "2026-10-15 08:30 ppi PPI 4",
      "2026-10-15 08:30 retail 零售销售 4",
      "2026-10-15 23:30 fed_speech 美联储讲话(Warsh) 5",
      "2026-10-27 10:00 other CB Consumer Confidence 4",
    ]);
    const cpi = list[1]!;
    expect(cpi.items?.map((i) => `${i.title}=${i.forecast}/${i.previous}`)).toEqual([
      "Core CPI m/m=0.2%/0.3%", "Core CPI y/y=2.5%/2.4%", "CPI m/m=0.6%/0.4%", "CPI y/y=3.6%/3.4%",
    ]);
    expect(cpi.at).toBe(Date.parse("2026-10-14T08:30:00-04:00"));
    expect(cpi.id).toBe(`feed:cpi:${cpi.at}`);
    expect(cpi.source).toBe("feed");
  });

  it("初请在日历源上只是中等影响,按家族定成 4 星;4 星以上是 high,3 星以下是 medium;Holiday 不要", () => {
    const list = parseFeed(FEED);
    const claims = list.find((e) => e.kind === "claims");
    expect(claims).toMatchObject({ stars: 4, impact: "high" });
    expect(list.filter((e) => e.impact === "medium").map((e) => e.title)).toEqual(["美联储讲话(Hammack)", "Philly Fed Manufacturing Index"]);
    expect(list.some((e) => /Holiday/.test(e.title))).toBe(false);
  });

  it("坏载荷当空的:不是数组、条目缺字段、日期解析不了", () => {
    expect(parseFeed(null)).toEqual([]);
    expect(parseFeed({ events: [] })).toEqual([]);
    expect(parseFeed([{ title: "CPI m/m", country: "USD", date: "someday", impact: "High" }, 42, null])).toEqual([]);
  });

  it("家族归类:非农三件套、FOMC 的声明 / 利率 / 发布会、Core PCE、讲话", () => {
    expect(["Non-Farm Employment Change", "Unemployment Rate", "Average Hourly Earnings m/m"].map(familyOf)).toEqual(["nfp", "nfp", "nfp"]);
    expect(["FOMC Statement", "Federal Funds Rate", "FOMC Press Conference", "FOMC Economic Projections"].map(familyOf)).toEqual(["fomc", "fomc", "fomc", "fomc"]);
    expect(familyOf("FOMC Meeting Minutes")).toBe("fomc_minutes");
    expect(familyOf("Core PCE Price Index m/m")).toBe("pce");
    expect(familyOf("Advance GDP q/q")).toBe("gdp");
    expect(familyOf("Fed Chair Powell Testifies")).toBe("fed_speech"); // 作证和讲话一样会动市场
    expect(familyOf("ISM Manufacturing PMI")).toBe("ism");
    expect(familyOf("ADP Non-Farm Employment Change")).toBe("adp"); // 标题里也有 Non-Farm,不能算成非农
    expect(familyOf("JOLTS Job Openings")).toBe("jolts");
  });

  it("星级:家族定死的用家族的,联储主席讲话 5 星,别的官员与认不出的看档位", () => {
    expect(starsFor("claims", "Unemployment Claims", 3)).toBe(4);
    expect(starsFor("cpi", "CPI m/m", 4)).toBe(5);
    expect(starsFor("fed_speech", "Fed Chair Powell Testifies", 4)).toBe(5);
    expect(starsFor("fed_speech", "FOMC Member Hammack Speaks", 2)).toBe(2);
    expect(starsFor("other", "CB Consumer Confidence", 4)).toBe(4);
  });
});

describe("合并", () => {
  it("内置与日历源撞上同一天同一家族:日历源顶上去,名字与 id 用内置的;其余各自保留;按时间排", () => {
    const builtin = builtinEvents(Date.parse("2026-10-13T00:00:00-04:00"), Date.parse("2026-10-31T00:00:00-04:00"));
    const feed = parseFeed(FEED);
    const custom = [{
      id: "custom:abc", kind: "custom" as const, title: "CRWV 发债", at: Date.parse("2026-10-14T07:00:00-04:00"),
      date_et: "2026-10-14", time_et: "07:00", stars: 4, impact: "high" as const, source: "custom" as const, linger_min: 90,
    }];
    const merged = mergeEvents(builtin, feed, custom);
    expect(merged.map((e) => `${e.date_et} ${e.time_et} ${e.title} [${e.source}]`)).toEqual([
      "2026-10-12 12:10 美联储讲话(Hammack) [feed]",
      "2026-10-14 07:00 CRWV 发债 [custom]",
      "2026-10-14 08:30 CPI(9月) [feed]",
      "2026-10-15 08:30 初请失业金(截至 10-10 当周) [feed]",
      "2026-10-15 08:30 PPI(9月) [feed]",
      "2026-10-15 08:30 Philly Fed Manufacturing Index [feed]",
      "2026-10-15 08:30 零售销售 [feed]",
      "2026-10-15 23:30 美联储讲话(Warsh) [feed]",
      "2026-10-22 08:30 初请失业金(截至 10-17 当周) [builtin]",
      "2026-10-27 10:00 CB Consumer Confidence [feed]",
      "2026-10-28 14:00 FOMC 利率决议 [builtin]",
      "2026-10-29 08:30 初请失业金(截至 10-24 当周) [builtin]",
      "2026-10-29 08:30 GDP 初值(三季度) [builtin]",
      "2026-10-29 08:30 PCE 物价(9月) [builtin]",
    ]);
    const cpi = merged[2]!;
    expect(cpi.id).toBe("builtin:cpi:2026-10-14");
    expect(cpi.items?.length).toBe(4);
    expect(merged.filter((e) => e.kind === "cpi").length).toBe(1);
    const claims = merged[3]!;
    expect(claims).toMatchObject({ id: "builtin:claims:2026-10-15", stars: 4, source: "feed" });
    expect(claims.items?.[0]).toEqual({ title: "Unemployment Claims", forecast: "199K", previous: "197K" });
  });
});

describe("口径", () => {
  it("默认开着、拉日历、四星以上、提前 60 与 15 分钟、跨市场 1.5%", () => {
    expect(normalizeEventsConfig(null)).toEqual(DEFAULT_EVENTS_CONFIG);
    expect(DEFAULT_EVENTS_CONFIG.min_stars).toBe(4);
    expect(DEFAULT_EVENTS_CONFIG.lead_minutes).toEqual([60, 15]);
    expect(DEFAULT_EVENTS_CONFIG).toMatchObject({ cross_market: true, cross_market_pct: 1.5, cross_lag_pct: 1 });
  });

  it("一次只改一两项,在当前那份上合并;数字串也认;提前档去重并从大到小排", () => {
    const base = normalizeEventsConfig({ min_stars: "5" }, DEFAULT_EVENTS_CONFIG);
    const next = normalizeEventsConfig({ lead_minutes: ["15", 120, 15], sector_move_pct: "4.5" }, base);
    expect(next).toEqual({ ...DEFAULT_EVENTS_CONFIG, min_stars: 5, lead_minutes: [120, 15], sector_move_pct: 4.5 });
    expect(base.lead_minutes).toEqual([60, 15]); // 没被改
  });

  it("越界当场拒,给中文原因", () => {
    expect(() => normalizeEventsConfig({ lead_minutes: [1, 2, 3, 4, 5] })).toThrow(EventsConfigError);
    expect(() => normalizeEventsConfig({ lead_minutes: [0] })).toThrow("1 ~ 1440");
    expect(() => normalizeEventsConfig({ sector_min_stocks: 1 })).toThrow("2 ~ 30");
    expect(() => normalizeEventsConfig({ sector_share: 1.5 })).toThrow("0.3 ~ 1");
    expect(() => normalizeEventsConfig({ sector_move_pct: "abc" })).toThrow("必须是数字");
    expect(() => normalizeEventsConfig({ cross_market_pct: 12 })).toThrow("0.3% ~ 10%");
    expect(normalizeEventsConfig({ cross_market: 0, cross_market_pct: "2" })).toMatchObject({ cross_market: false, cross_market_pct: 2 });
    expect(() => normalizeEventsConfig({ cross_lag_pct: 0.1 })).toThrow("0.2 ~ 10");
    expect(normalizeEventsConfig({ cross_lag_pct: "1.5" }).cross_lag_pct).toBe(1.5);
    expect(() => normalizeEventsConfig({ min_stars: 0 })).toThrow("1 ~ 5");
    expect(() => normalizeEventsConfig({ min_stars: 3.5 })).toThrow("1 ~ 5");
  });

  it("老口径「中等影响的也算」开着的,读成三星起;新口径写了 min_stars 就以它为准", () => {
    expect(normalizeEventsConfig({ medium: true }).min_stars).toBe(3);
    expect(normalizeEventsConfig({ medium: false }).min_stars).toBe(4);
    expect(normalizeEventsConfig({ medium: true, min_stars: 5 }).min_stars).toBe(5);
  });
});
