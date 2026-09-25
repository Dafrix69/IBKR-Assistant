/** 短期内反复碰均线(maTouch.ts)的口径。全部离线。
 *
 * 夹具是 NVDA 2026-05-01 ~ 09-24 的真实日线(前复权,Polygon)。默认口径就是拿这类数据定的:
 * 20 日线、容差 0.3%、10 个交易日里第 3 段才报——两年 466 个交易日,AAPL / NVDA / ORCL / SPY 各报 5 / 15 / 12 / 19 次。
 * 这里钉住两件事:引擎的逐日判定和校准时那条 SQL 一致(口径能搬过来),以及两个真实时刻报与不报。
 */
import { describe, expect, it } from "vitest";

import type { MaTouchConfig, TouchBook } from "../src/contract/alerts.js";
import {
  DEFAULT_TOUCH_CONFIG, MaTouchError, bookUsable, buildTouchBook, completedBars, episodesOf, evaluateTouches,
  normalizeTouchConfig, prevTradingDay, touchDays,
} from "../src/maTouch.js";
import { NVDA } from "./nvdaDaily.js";

/** 到某天为止(含)的日线——券商在那天盘中会把当天那根半截的一并给回来 */
const upTo = (day: string) => NVDA.filter((b) => b.date <= day);

const CFG: MaTouchConfig = { ...DEFAULT_TOUCH_CONFIG, periods: [20] };

describe("逐日判定:和校准那条 SQL 一个口径", () => {
  it("NVDA 06-02 ~ 09-24 碰 20 日线(容差 0.3%)的日子,和 SQL 逐日算出来的一模一样", () => {
    // SQL:AVG(close) OVER 20 行、low <= ma*1.003 AND high >= ma*0.997(校准时打印出来的那一段)
    const expected = [
      "06-03", "06-04", "06-18", "06-22", "07-08", "07-09", "07-10", "07-17", "07-20", "07-27", "08-03",
      "08-24", "08-25", "08-28", "08-31", "09-01", "09-02", "09-10", "09-11", "09-17", "09-18", "09-24",
    ];
    const days = touchDays(completedBars(NVDA, "2026-12-31"), 20, 0.3).filter((d) => d.date >= "2026-06-02");
    expect(days.filter((d) => d.touched).map((d) => d.date.slice(5))).toEqual(expected);
    // 均线也对得上(SQL 打印的是两位小数)
    expect(days.find((d) => d.date === "2026-09-24")!.ma).toBeCloseTo(221.9, 1);
  });

  it("连着碰的几天并成一段,side 取这一段最后一天的收盘", () => {
    const days = touchDays(completedBars(NVDA, "2026-12-31"), 20, 0.3).filter((d) => d.date >= "2026-08-20");
    expect(episodesOf(days)).toEqual([
      { start: "2026-08-24", end: "2026-08-25", side: "below" },
      { start: "2026-08-28", end: "2026-09-02", side: "above" },
      { start: "2026-09-10", end: "2026-09-11", side: "below" },
      { start: "2026-09-17", end: "2026-09-18", side: "above" },
      { start: "2026-09-24", end: "2026-09-24", side: "above" },
    ]);
  });

  it("均线凑不满周期的那几天不给", () => {
    const days = touchDays(completedBars(NVDA, "2026-12-31"), 20, 0.3);
    expect(days[0]!.date).toBe(NVDA[19]!.date);
  });
});

describe("盘中:拿现价补今天", () => {
  it("NVDA 09-24:10 个交易日里第 3 次碰 20 日线(前两次 09-10~11、09-17~18),报", () => {
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", CFG)!;
    expect(book.as_of).toBe("2026-09-23"); // 当天那根半截的不用
    const { hits, fired } = evaluateTouches(book, CFG, 222.0, null, "2026-09-24");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.count).toBe(3);
    expect(hit.prior.map((e) => [e.start, e.end])).toEqual([
      ["2026-09-10", "2026-09-11"], ["2026-09-17", "2026-09-18"],
    ]);
    expect(hit.ma).toBeCloseTo(221.77, 2); // (前 19 根收盘和 + 222) / 20
    expect(hit.side).toBe("above");
    expect(hit.direction).toBe("down"); // 在线上方贴着 = 回踩
    expect(hit.text).toBe(
      "近 10 个交易日第 3 次碰 20日均线 221.77(之前 09-10~09-11、09-17~09-18,收盘有上有下;今天,现价 222.00)",
    );
    expect(fired).toEqual({ "20": "2026-09-24" });
  });

  it("NVDA 08-03:07-17、07-27、08-03 三段跨了 13 个交易日——窗口 10 天不报,15 天报", () => {
    const ten = buildTouchBook(upTo("2026-08-03"), "2026-08-03", CFG)!;
    expect(evaluateTouches(ten, CFG, 203.5, null, "2026-08-03").hits).toEqual([]);

    const cfg15 = { ...CFG, window_days: 15 };
    const fifteen = buildTouchBook(upTo("2026-08-03"), "2026-08-03", cfg15)!;
    const { hits } = evaluateTouches(fifteen, cfg15, 203.5, null, "2026-08-03");
    expect(hits.map((h) => [h.count, h.prior.map((e) => e.start)])).toEqual([[3, ["2026-07-17", "2026-07-27"]]]);
  });

  it("离均线远就不算碰;同一段只报一次(同一天再碰、第二天接着碰都不重报)", () => {
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", CFG)!;
    expect(evaluateTouches(book, CFG, 226.0, null, "2026-09-24").hits).toEqual([]);

    const first = evaluateTouches(book, CFG, 222.0, null, "2026-09-24");
    const again = evaluateTouches({ ...book, fired: first.fired }, CFG, 221.9, 222.0, "2026-09-24");
    expect(again.hits).toEqual([]);

    // 第二天:09-24 碰了(底账里那一段收在 09-24 = as_of),09-25 接着贴着线 → 同一段,不重报
    const next = buildTouchBook(NVDA, "2026-09-25", CFG, first.fired)!;
    expect(next.as_of).toBe("2026-09-24");
    expect(next.fired).toEqual({ "20": "2026-09-24" });
    // 现价正好压在盘中均线上:p = (前 19 根收盘和 + p) / 20 → p = 和 / 19
    const onLine = next.lines[0]!.prior_sum / 19;
    expect(evaluateTouches(next, CFG, onLine, null, "2026-09-25").hits).toEqual([]);
    // 就算没报过,09-25 也凑不够了:窗口往前滑了一天,09-10~11 那段落到窗口外,只剩 09-17~18 和 09-24 起这段
    expect(evaluateTouches({ ...next, fired: {} }, CFG, onLine, null, "2026-09-25").hits).toEqual([]);
    // 窗口放宽到 12 天、没报过(昨天那会儿应用没开):接着碰的这一段照样算一段、照样报
    const cfg12 = { ...CFG, window_days: 12 };
    const book12 = buildTouchBook(NVDA, "2026-09-25", cfg12)!;
    const fresh = evaluateTouches(book12, cfg12, book12.lines[0]!.prior_sum / 19, null, "2026-09-25");
    expect(fresh.hits.map((h) => [h.count, h.start])).toEqual([[3, "2026-09-24"]]);
    expect(fresh.hits[0]!.text).toContain("09-24 起连着碰到今天");
  });

  it("两轮之间跨过均线也算碰(每 10 秒取一次价,中间一针可能刚好错过);没有同一天的上一轮价就不看跨没跨", () => {
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", CFG)!;
    // 219 → 225:两个价都离均线(≈221.6 / 221.9)0.3% 以外,但中间跨过去了
    expect(evaluateTouches(book, CFG, 225.0, null, "2026-09-24").hits).toEqual([]);
    const crossed = evaluateTouches(book, CFG, 225.0, 219.0, "2026-09-24").hits;
    expect(crossed.map((h) => [h.count, h.direction, h.side])).toEqual([[3, "up", "above"]]);
  });

  it("容差是均线的 %:band 0 时只有正好跨过才算", () => {
    const cfg0 = { ...CFG, band_pct: 0 };
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", cfg0)!;
    expect(evaluateTouches(book, cfg0, 222.0, null, "2026-09-24").hits).toEqual([]);
  });
});

describe("底账", () => {
  it("当天半截的 K 线、缺价的、乱序重复的都不进完整日线", () => {
    const bars = [
      { date: "2026-09-21", high: 2, low: 1, close: 1.5 },
      { date: "2026-09-22", high: 2, low: null, close: 1.5 },
      { date: "2026-09-21", high: 2, low: 1, close: 1.5 },
      { date: "2026-09-23", high: 2, low: 1, close: 1.6 },
      { date: "2026-09-24", high: 2, low: 1, close: 1.7 },
    ];
    expect(completedBars(bars, "2026-09-24").map((b) => b.date)).toEqual(["2026-09-21", "2026-09-23"]);
  });

  it("历史凑不满的那条均线不给,但底账照给(periods 记着要过哪几条),不会被当成旧的反复重算", () => {
    const cfg = { ...DEFAULT_TOUCH_CONFIG }; // 20 / 60 / 120 / 200;夹具只有 102 根
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", cfg)!;
    expect(book.lines.map((l) => l.period)).toEqual([20, 60]);
    expect(book.periods).toEqual([20, 60, 120, 200]);
    expect(bookUsable(book, cfg, "2026-09-23")).toBe(true);
    expect(buildTouchBook([], "2026-09-24", cfg)).toBeNull();
  });

  it("能不能拿来判今天:as_of 得是上一个交易日,窗口 / 容差 / 均线得和现在的设置一样", () => {
    const book = buildTouchBook(upTo("2026-09-24"), "2026-09-24", CFG) as TouchBook;
    expect(bookUsable(book, CFG, "2026-09-23")).toBe(true);
    expect(bookUsable(book, CFG, "2026-09-24")).toBe(false); // 第二天还没重算
    expect(bookUsable(book, { ...CFG, window_days: 15 }, "2026-09-23")).toBe(false);
    expect(bookUsable(book, { ...CFG, band_pct: 0.5 }, "2026-09-23")).toBe(false);
    expect(bookUsable(book, { ...CFG, periods: [20, 60] }, "2026-09-23")).toBe(false);
    expect(bookUsable(null, CFG, "2026-09-23")).toBe(false);
  });

  it("换了均线:没了的那条的「报过」记录跟着丢,留下的照带", () => {
    const next = buildTouchBook(upTo("2026-09-24"), "2026-09-24", { ...CFG, periods: [20, 60] }, { "20": "2026-09-10", "5": "2026-09-01" })!;
    expect(next.fired).toEqual({ "20": "2026-09-10" });
  });

  it("上一个交易日跳过周末和假日", () => {
    const holidays = new Set(["2026-09-07"]);
    const isTradingDay = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0 && !holidays.has(d);
    expect(prevTradingDay("2026-09-24", isTradingDay)).toBe("2026-09-23");
    expect(prevTradingDay("2026-09-21", isTradingDay)).toBe("2026-09-18"); // 周一 → 上周五
    expect(prevTradingDay("2026-09-08", isTradingDay)).toBe("2026-09-04"); // 劳动节
  });
});

describe("设置", () => {
  it("缺的取当前值;数字串也认;均线去重排序", () => {
    const out = normalizeTouchConfig({ periods: ["60", 20, 20], window_days: "12" }, DEFAULT_TOUCH_CONFIG);
    expect(out).toEqual({ ...DEFAULT_TOUCH_CONFIG, periods: [20, 60], window_days: 12 });
    expect(normalizeTouchConfig(null)).toEqual(DEFAULT_TOUCH_CONFIG);
  });

  it("越界给中文原因", () => {
    const why = (raw: unknown): string => {
      try {
        normalizeTouchConfig(raw);
        return "";
      } catch (exc) {
        expect(exc).toBeInstanceOf(MaTouchError);
        return (exc as Error).message;
      }
    };
    expect(why({ periods: [3] })).toContain("5~250");
    expect(why({ periods: [] })).toContain("1~6 条");
    expect(why({ window_days: 2.5 })).toContain("3~30 的整数");
    expect(why({ band_pct: 5 })).toContain("0%~2%");
    expect(why({ enabled: "yes" })).toContain("true / false");
    expect(why("x")).toContain("格式不对");
    // 两段之间至少隔一天:10 天最多分出 5 段
    expect(why({ window_days: 10, min_touches: 6 })).toBe(
      "10 个交易日里最多只能分出 5 段触碰(连着几天贴着线只算一次),起报次数 6 永远凑不够",
    );
    expect(why({ window_days: 10, min_touches: 5 })).toBe("");
  });
});
