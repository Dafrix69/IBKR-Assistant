/** 内置休市日历(marketCalendar.ts):按 NYSE 规则推算的休市日与提前收盘日。
 *
 * 对的是交易所公布过的日历,不是对着实现抄一遍规则:2026 年那一张就是 config/settings.example.json 里手写的那张,
 * 2022 / 2023 / 2024 / 2025 是已经过完的年份。离线、不读时钟。
 */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fromDict } from "../src/config.js";
import { builtinCalendar, easterSunday, mergeCalendar, nyseEarlyCloses, nyseHolidays } from "../src/marketCalendar.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "settings.example.json"), "utf-8"));

describe("内置休市日历", () => {
  it("2026 年:和示例配置里手写的那张表逐日相同", () => {
    expect(nyseHolidays(2026)).toEqual(example.market_holidays);
    expect(nyseEarlyCloses(2026)).toEqual(example.early_close_days);
  });

  it("已经过完的年份:和交易所当年公布的一致", () => {
    // 2022:元旦落在周六,不补休;六月节第一年
    expect(nyseHolidays(2022)).toEqual([
      "2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20",
      "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26",
    ]);
    expect(nyseEarlyCloses(2022)).toEqual(["2022-11-25"]);
    expect(nyseHolidays(2023)).toEqual([
      "2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29", "2023-06-19",
      "2023-07-04", "2023-09-04", "2023-11-23", "2023-12-25",
    ]);
    // 2023:7 月 3 日周一提前收盘;平安夜是周日,不算
    expect(nyseEarlyCloses(2023)).toEqual(["2023-07-03", "2023-11-24"]);
    expect(nyseHolidays(2024)).toEqual([
      "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19",
      "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
    ]);
    expect(nyseEarlyCloses(2024)).toEqual(["2024-07-03", "2024-11-29", "2024-12-24"]);
    // 2025:1 月 9 日卡特国葬是临时休市,规则算不出来,在那张已发生的表里
    expect(nyseHolidays(2025)).toEqual([
      "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19",
      "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    ]);
    expect(nyseEarlyCloses(2025)).toEqual(["2025-07-03", "2025-11-28", "2025-12-24"]);
  });

  it("2027 / 2028:示例配置没写到的年份", () => {
    // 2027:六月节周六 → 周五休;独立日周日 → 周一休;圣诞周六 → 周五(平安夜)休,所以那天不是提前收盘
    expect(nyseHolidays(2027)).toEqual([
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
      "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    ]);
    expect(nyseEarlyCloses(2027)).toEqual(["2027-11-26"]);
    // 2028:元旦周六,不补休
    expect(nyseHolidays(2028)).toEqual([
      "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
      "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
    ]);
    expect(nyseEarlyCloses(2028)).toEqual(["2028-07-03", "2028-11-24"]);
  });

  it("六月节 2022 年之前不是假日;2021 年独立日周日顺延、圣诞周六提前", () => {
    expect(nyseHolidays(2021)).not.toContain("2021-06-18");
    expect(nyseHolidays(2021)).toContain("2021-07-05");
    expect(nyseHolidays(2021)).toContain("2021-12-24");
    // 2020:独立日周六 → 7 月 3 日周五休市,所以没有 7 月 3 日提前收盘
    expect(nyseHolidays(2020)).toContain("2020-07-03");
    expect(nyseEarlyCloses(2020)).toEqual(["2020-11-27", "2020-12-24"]);
  });

  it("复活节", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2038)).toBe("2038-04-25");
  });

  it("休市日都落在工作日,一年九到十一个", () => {
    for (let y = 2000; y <= 2060; y += 1) {
      const days = nyseHolidays(y);
      expect(days.length, `${y} 年`).toBeGreaterThanOrEqual(8);
      expect(days.length, `${y} 年`).toBeLessThanOrEqual(13);
      for (const d of days) {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        expect(dow === 0 || dow === 6, `${d} 落在周末`).toBe(false);
        expect(d.startsWith(`${y}-`), `${d} 不在 ${y} 年`).toBe(true);
      }
      for (const d of nyseEarlyCloses(y)) expect(days, `${d} 既休市又提前收盘`).not.toContain(d);
    }
  });

  it("mergeCalendar:并集、去重、排序", () => {
    expect(mergeCalendar(["2027-03-01", "2027-01-01"], ["2027-01-01", "2027-01-18"])).toEqual([
      "2027-01-01", "2027-01-18", "2027-03-01",
    ]);
  });
});

describe("配置与内置日历", () => {
  const base = { accounts: [], connections: {} };

  it("默认:配置里没写的年份也认得假日", () => {
    const s = fromDict({ ...base, market_holidays: ["2026-09-07"], early_close_days: ["2026-11-27"] });
    expect(s.isTradingDay("2027-01-01")).toBe(false); // 2027 年元旦,周五
    expect(s.isTradingDay("2027-11-25")).toBe(false); // 感恩节
    expect(s.isTradingDay("2027-11-26")).toBe(true);
    expect(s.early_close_days).toContain("2027-11-26");
    expect(s.isTradingDay("2026-09-07")).toBe(false);
    expect(s.isTradingDay("2026-09-08")).toBe(true);
  });

  it("配置里写的临时休市照样算数", () => {
    const s = fromDict({ ...base, market_holidays: ["2027-03-10"] });
    expect(s.isTradingDay("2027-03-10")).toBe(false);
    expect(s.market_holidays).toContain("2027-03-10");
    expect(s.market_holidays).toEqual([...s.market_holidays].sort());
  });

  it("config_only:退回只认配置里写的", () => {
    const s = fromDict({ ...base, market_calendar: "config_only", market_holidays: ["2026-09-07"] });
    expect(s.market_holidays).toEqual(["2026-09-07"]);
    expect(s.isTradingDay("2027-01-01")).toBe(true);
    expect(s.early_close_days).toEqual([]);
  });

  it("market_calendar 写错了当场报", () => {
    expect(() => fromDict({ ...base, market_calendar: "nyse" })).toThrow(/market_calendar 只能是 builtin 或 config_only/);
  });

  it("内置日历只算一次", () => {
    expect(builtinCalendar()).toBe(builtinCalendar());
  });
});
