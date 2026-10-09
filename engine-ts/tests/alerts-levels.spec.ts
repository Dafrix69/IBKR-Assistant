/** 价位提醒的纯计算(alerts.ts)里和"口径"有关的几条:
 *  1. 自动步长跟着现价走,而且粗细刚好撑得住滞回:相邻两个关口各自的重新上膛范围不叠;
 *     现价走出上下两个关口之间,这一对跟着换;
 *  2. 均线价位和「反复碰均线」是同一条线:(前 X−1 根完整日线的收盘和 + 现价) / X,收盘和是同一个数;
 *  3. 状态按"这个价位是谁"记,均线换了价不丢状态;
 *  4. 上一笔接不上(换了段、隔了太久)、或者上一笔还没坐实是这一段里的真价,就只登记;
 *  5. 可选的 1 分钟收盘确认:穿过之后第一根还有后续取价的 1 分钟 K 线收在线的另一侧才报。
 * 状态机本身(穿过 → 落防 → 离开 + 冷却 → 上膛)由 golden-analysis 的 walk 钉着。
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_STEP, DEFAULT_BAND_PCT, DEFAULT_COOLDOWN, autoStep, buildLevels, evaluate, levelDict, levelKey,
  levelPriceAt, linkSample, reroundLevels, roundLevels, trendLevels,
} from "../src/alerts.js";
import type { AlertLevel, LevelState, PriceSample } from "../src/alerts.js";
import { DEFAULT_TOUCH_CONFIG, buildTouchBook, evaluateTouches } from "../src/maTouch.js";
import { NVDA } from "./nvdaDaily.js";

const level = (over: Partial<AlertLevel> & Pick<AlertLevel, "price" | "source">): AlertLevel => ({
  label: over.source, kind: "pivot", priority: 0, ...over,
});

describe("自动步长:1 / 2.5 / 5 × 10^k 里刚好够「相邻两个关口的重新上膛范围不叠」的最小一档", () => {
  it("跟着现价走:41 块是 0.25,SPX 是 50,450 上下还是 5", () => {
    const table: Array<[number, number]> = [
      [8, 0.05], [41.2, 0.25], [100, 1], [180, 2.5], [250, 2.5], [452.6, 5], [670, 5], [1000, 10], [6700, 50], [24000, 250],
    ];
    for (const [spot, step] of table) expect(autoStep(spot), String(spot)).toBe(step);
  });

  it("没有现价就没有步长;band 变了步长跟着变(它是从 band 推出来的,不是另一个数)", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(autoStep(bad)).toBe(0);
    // band 0.5%:门槛是现价的 2 × 0.5 / 99.5 = 1.005%。497 块要 4.995,5 够;498 块要 5.005,得 10
    expect(autoStep(497, 0.5)).toBe(5);
    expect(autoStep(498, 0.5)).toBe(10);
    expect(autoStep(100, 0)).toBe(0);
    expect(autoStep(100, 100)).toBe(0);
  });

  it("任何价位上:上下两个关口各自 ± band 的范围不叠;步长又不到门槛的 2.5 倍(阶梯相邻两档最多差 2.5 倍)", () => {
    const b = DEFAULT_BAND_PCT / 100;
    for (let spot = 0.37; spot < 60_000; spot *= 1.07) {
      const step = autoStep(spot);
      const [below, above] = roundLevels(spot, step) as [number, number];
      expect(above - below, String(spot)).toBeGreaterThanOrEqual(b * below + b * above);
      expect(step, String(spot)).toBeLessThan(((spot * 2 * b) / (1 - b)) * 2.5);
      expect(step / spot, String(spot)).toBeGreaterThan(0.006);
      expect(step / spot, String(spot)).toBeLessThan(0.0151);
    }
  });

  it("buildLevels:步长 0 = 自动;给了正数就用那个数(老盯单存的 5 照旧是 5)", () => {
    expect(AUTO_STEP).toBe(0);
    expect(buildLevels(41.2, null, AUTO_STEP).map((l) => l.price)).toEqual([41, 41.25]);
    expect(buildLevels(41.2, null).map((l) => l.price)).toEqual([41, 41.25]);
    expect(buildLevels(41.2, null, 5).map((l) => l.price)).toEqual([40, 45]);
    // SPX:5 美元一档的两个关口挨得比合并容差(0.15%)还近,并成了一个;自动步长是 50,两个都在
    expect(buildLevels(6712, null, 5)).toHaveLength(1);
    expect(buildLevels(6712, null, AUTO_STEP).map((l) => l.price)).toEqual([6700, 6750]);
  });
});

describe("均线价位:和「反复碰均线」同一条线", () => {
  const TODAY = "2026-09-24";
  const SPOT = 222;

  it("收盘和与碰均线的底账是同一个数;今天那根半截的不算完整日线", () => {
    // 券商盘中给回来的日线带着今天那根半截的:它的收盘是抓取那一刻的价,不是今天的收盘
    const bars = [...NVDA.filter((b) => b.date < TODAY), { date: TODAY, open: 221, high: 223, low: 220, close: 221.4 }];
    const book = buildTouchBook(bars, TODAY, { ...DEFAULT_TOUCH_CONFIG, periods: [20, 60] })!;
    const levels = trendLevels(bars, SPOT, [20, 60], 250, TODAY);
    for (const line of book.lines) {
      const lv = levels.find((l) => l.source === `ma${line.period}`)!;
      expect(lv.ma).toEqual({ period: line.period, prior_sum: line.prior_sum });
      expect(lv.price).toBeCloseTo((line.prior_sum + SPOT) / line.period, 4);
    }
    // 碰均线报出来的那条线此刻的值,就是这个价位此刻的值
    const hit = evaluateTouches(book, { ...DEFAULT_TOUCH_CONFIG, periods: [20] }, SPOT, null, TODAY).hits[0]!;
    expect(levelPriceAt(levels.find((l) => l.source === "ma20")!, SPOT)).toBeCloseTo(hit.ma, 4);
  });

  it("凑不满就不给:X 日线要 X−1 根完整日线(第 X 根是今天)", () => {
    const nineteen = NVDA.slice(0, 19);
    expect(trendLevels(nineteen, 200, [20], 250, "2026-12-31").map((l) => l.source)).toContain("ma20");
    expect(trendLevels(NVDA.slice(0, 18), 200, [20], 250, "2026-12-31").map((l) => l.source)).not.toContain("ma20");
  });

  it("存进盯单的价位带着收盘和;和别的价位合并时,赢的是均线才带", () => {
    // 19 根:20 日线刚好凑满,52 周高低(要 20 根)还没有
    const flat = Array.from({ length: 19 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`, open: 100, high: 100, low: 100, close: 100,
    }));
    // 均线 ≈ 100,整数关口 100(步长 5):并成一条,均线的可信度高,赢
    const merged = buildLevels(100.05, null, 5, undefined, undefined, flat, "2026-09-01").find((l) => l.source === "ma20")!;
    expect(merged.label).toContain("整数关口 100");
    expect(levelDict(merged).ma).toEqual({ period: 20, prior_sum: 1900 });
    expect(levelDict(level({ price: 100, source: "round" }))).toEqual({ price: 100, label: "round", source: "round", kind: "pivot" });
  });

  it("穿越按盘中的线判,不按算出来那一刻冻住的价", () => {
    // 前 19 根收盘和 1900:现价 p 的 20 日线在 (1900 + p) / 20,两者在 100 相遇。price 是早上算的,已经旧了
    const ma20 = level({ price: 100.5, source: "ma20", label: "20日均线", ma: { period: 20, prior_sum: 1900 } });
    // 101 → 100.3:跨过了冻住的 100.5,没跨过线本身(此刻在 100.015)
    expect(evaluate([ma20], {}, 101, 100.3, 1000)[0]).toEqual([]);
    const [events] = evaluate([ma20], {}, 100.3, 99.9, 1010);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "ma20", direction: "down", from: 100.3, to: 99.9, price: 99.995 });
    expect(events[0]!.text).toBe("20日均线 下破 99.995(现价 99.9)");
    // 没带收盘和的(升级之前算出来的价位)照旧按那个固定的价判
    const frozen = level({ price: 100.5, source: "ma20", label: "20日均线" });
    expect(evaluate([frozen], {}, 101, 100.3, 1000)[0]).toHaveLength(1);
  });
});

describe("状态按价位是谁来记", () => {
  it("会漂的线按来源;行权价与整数关口按 来源@价", () => {
    expect(levelKey({ price: 221.73, source: "ma20" })).toBe("ma20");
    expect(levelKey({ price: 310, source: "high_52w" })).toBe("high_52w");
    expect(levelKey({ price: 447.3, source: "gamma_flip" })).toBe("gamma_flip");
    expect(levelKey({ price: 450, source: "call_wall" })).toBe("call_wall@450.0000");
    expect(levelKey({ price: 445, source: "round" })).toBe("round@445.0000");
    expect(levelKey({ price: 450, source: "round" })).not.toBe(levelKey({ price: 445, source: "round" }));
  });

  it("均线第二天换了价:报过的那一次还记着(没离开够远、没过冷却就不重报)", () => {
    const fired: Record<string, LevelState> = { ma20: { armed: false, last_fired_at: 1000 } };
    const moved = level({ price: 100.2, source: "ma20", ma: { period: 20, prior_sum: 1904 } }); // 昨天在 100,今天在 100.2 上下
    const [events, states] = evaluate([moved], fired, 100.3, 100.1, 1100);
    expect(events).toEqual([]);
    expect(states).toEqual({ ma20: { armed: false, last_fired_at: 1000 } });
    // 换了行权价的墙是另一个位:老状态不认,也不留
    const wall = level({ price: 455, source: "call_wall" });
    const [, next] = evaluate([wall], { "call_wall@450.0000": { armed: false, last_fired_at: 1000 } }, 454, 454.5, 1100);
    expect(next).toEqual({ "call_wall@455.0000": { armed: true, last_fired_at: null } });
  });

  it("老库里按价格做键的状态:认一次,写回去就是新键", () => {
    const round = level({ price: 450, source: "round" });
    const [events, states] = evaluate([round], { "450.0000": { armed: false, last_fired_at: 1000 } }, 449.9, 450.2, 1100);
    expect(events).toEqual([]);
    expect(states).toEqual({ "round@450.0000": { armed: false, last_fired_at: 1000 } });
  });
});

describe("整数关口跟着现价换(reroundLevels)", () => {
  const round = (price: number) => ({ price, label: `整数关口 ${price}`, source: "round", kind: "pivot" as const });
  const prices = (levels: ReadonlyArray<{ price: number }> | null) => levels?.map((l) => l.price) ?? null;

  it("还在上下两个关口之间:不动;正好压在关口上也不动", () => {
    const pair = [round(130), round(131)];
    expect(reroundLevels(pair, 130.4, 1)).toBeNull();
    expect(reroundLevels(pair, 130.99, 1)).toBeNull();
    expect(reroundLevels(pair, 131, 1)).toBeNull(); // 这时"两侧的一对"是 130 与 132,换了就把刚碰到的 131 丢了
  });

  it("走出去了:换成现价两侧的那一对;刚穿过的那个留着(是同一个对象,状态的键不变),别的价位原样", () => {
    const wall = { price: 135, label: "上方持仓墙", source: "call_wall", kind: "resistance" as const };
    const upper = round(131);
    const next = reroundLevels([round(130), upper, wall], 131.2, 1)!;
    expect(prices(next)).toEqual([131, 132, 135]);
    expect(next[0]).toBe(upper);
    expect(next[2]).toBe(wall);
    expect(next[1]).toEqual({ price: 132, label: "整数关口 132", source: "round", kind: "pivot" });
    expect(levelKey(next[0]!)).toBe("round@131.0000");
    // 一轮里跳过好几档:直接换到现价两侧
    expect(prices(reroundLevels([round(130), round(131)], 136.2, 1))).toEqual([136, 137]);
    expect(prices(reroundLevels([round(130), round(131)], 128.6, 1))).toEqual([128, 129]);
  });

  it("NVDA 从 130.4 一路走到 140.2(自动步长 1):每过一档换一对,每个关口都报得到", () => {
    let levels: AlertLevel[] = buildLevels(130.4, null, AUTO_STEP);
    expect(prices(levels)).toEqual([130, 131]);
    let states: Record<string, LevelState> = {};
    const fired: number[] = [];
    let prev: number | null = null;
    let t = 1000;
    for (let p = 130.4; p <= 140.21; p = Math.round((p + 0.2) * 10) / 10) {
      const [events, next] = evaluate(levels, states, prev, p, (t += 10));
      fired.push(...events.map((e) => e.price));
      states = next;
      const swapped = reroundLevels(levels, p, AUTO_STEP);
      if (swapped) levels = swapped.map((l) => ({ ...l, priority: 0 }));
      prev = p;
    }
    expect(fired).toEqual([131, 132, 133, 134, 135, 136, 137, 138, 139, 140]);
    expect(prices(levels)).toEqual([140, 141]);
  });

  it("新的关口挨着别的价位(0.15% 以内)就不加:和整批重算时并进那个价位是一回事;均线按此刻的线算", () => {
    const wall = { price: 132.1, label: "上方成交墙", source: "call_vol_wall", kind: "resistance" as const };
    expect(prices(reroundLevels([round(130), round(131), wall], 131.3, 1))).toEqual([131, 132.1]);
    // 20 日线此刻在 (2508.1 + 131.3) / 20 = 131.97:132 挨着它,不加
    const ma = { price: 125, label: "20日均线", source: "ma20", kind: "resistance" as const, ma: { period: 20, prior_sum: 2508.1 } };
    expect(prices(reroundLevels([round(130), round(131), ma], 131.3, 1))).toEqual([125, 131]);
    // 两个关口都并在别的价位里、没有要拿掉的:不动
    const at130 = { ...wall, price: 130 };
    const at131 = { ...wall, price: 131, source: "call_wall" };
    expect(reroundLevels([at130, at131], 130.4, 1)).toBeNull();
  });

  it("步长 0 = 按此刻的现价分档;没有现价不动;步长比现价还大时没有「0」这个关口", () => {
    expect(prices(reroundLevels([round(6700), round(6750)], 6762, AUTO_STEP))).toEqual([6750, 6800]);
    expect(prices(reroundLevels([round(5)], 3.2, 5))).toBeNull();
    expect(prices(reroundLevels([round(10)], 3.2, 5))).toEqual([5]);
    expect(buildLevels(3.2, null, 5).map((l) => l.price)).toEqual([5]);
    expect(reroundLevels([round(130), round(131)], 0, 1)).toBeNull();
    expect(reroundLevels([round(130), round(131)], Number.NaN, AUTO_STEP)).toBeNull();
  });
});

describe("上一笔接不接得上(linkSample)", () => {
  const RTH = "2026-09-24|盘中";
  const PRE = "2026-09-24|盘前";
  const sample = (over: Partial<PriceSample>): PriceSample => ({ at: 9_990, price: 99, session: RTH, tradedAt: null, settled: true, ...over });
  const quote = (over: Partial<PriceSample> = {}) => ({ at: 10_000, price: 103, session: RTH, tradedAt: null as number | null, ...over });

  it("同一段里、不超过冷却那么久、上一笔是坐实了的:能比", () => {
    expect(linkSample(sample({}), quote())).toEqual({ sample: { ...quote(), settled: true }, prevPrice: 99 });
    expect(linkSample(sample({ at: 10_000 - DEFAULT_COOLDOWN }), quote()).prevPrice).toBe(99);
  });

  it("没有上一笔、换了段、隔得比冷却还久、时钟倒着走:只登记,而且这一笔自己也还没坐实", () => {
    for (const prev of [
      undefined, null, sample({ session: PRE }), sample({ at: 10_000 - DEFAULT_COOLDOWN - 1 }), sample({ at: 10_010 }),
      sample({ price: 0 }),
    ]) {
      const linked = linkSample(prev, quote());
      expect(linked.prevPrice).toBeNull();
      expect(linked.sample.settled).toBe(false);
    }
  });

  it("没有成交时刻:断过之后要先看到价动过一次。旧价留在换段后的第一笔里,不会被当成基准", () => {
    // 09:29:50 盘前 99.6 → 09:30:00 钟到了盘中,手上还是 99.6(开盘那一笔没进来) → 09:30:10 103 → 09:30:20 101.5
    let s: PriceSample = sample({ at: 0, price: 99.6, session: PRE });
    let step = linkSample(s, quote({ at: 10, price: 99.6 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([null, false]);
    step = linkSample((s = step.sample), quote({ at: 20, price: 103 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([null, true]); // 动了:它是基准,但不拿旧价和它比
    step = linkSample((s = step.sample), quote({ at: 30, price: 101.5 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([103, true]);
    // 价一直不动(停牌、没成交):一直不坐实,第一次动的那一下只登记
    let frozen = linkSample(sample({ session: PRE }), quote({ at: 10_000, price: 99 })).sample;
    for (let at = 10_010; at <= 10_100; at += 10) frozen = linkSample(frozen, quote({ at, price: 99 })).sample;
    expect(frozen.settled).toBe(false);
    expect(linkSample(frozen, quote({ at: 10_110, price: 103 })).prevPrice).toBeNull();
  });

  it("有成交时刻:按成交的那一刻分段。钟过了 09:30、成交还是盘前的,仍算盘前那一段", () => {
    // session 由调用方按 tradedAt 认出来:这里只看接法。盘前 → 盘前(连着,比)→ 盘中第一笔(换段:只登记,但它自己是坐实的)→ 比
    let s: PriceSample = sample({ at: 0, price: 99.6, session: PRE, tradedAt: 100 });
    let step = linkSample(s, quote({ at: 10, price: 99.6, session: PRE, tradedAt: 100 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([99.6, true]);
    step = linkSample((s = step.sample), quote({ at: 20, price: 103, session: RTH, tradedAt: 115 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([null, true]);
    step = linkSample((s = step.sample), quote({ at: 30, price: 101.5, session: RTH, tradedAt: 128 }));
    expect([step.prevPrice, step.sample.settled]).toEqual([103, true]);
  });

  it("有成交时刻:断档之后第一笔的成交时刻没往前走,就是断档之前留下的旧价——不坐实", () => {
    const before = sample({ at: 0, price: 99, tradedAt: 0 });
    const stale = linkSample(before, quote({ at: 1800, price: 99, tradedAt: 0 })); // 睡了半小时,醒来第一笔
    expect([stale.prevPrice, stale.sample.settled]).toEqual([null, false]);
    const fresh = linkSample(stale.sample, quote({ at: 1810, price: 103, tradedAt: 1805 }));
    expect([fresh.prevPrice, fresh.sample.settled]).toEqual([null, true]);
    expect(linkSample(fresh.sample, quote({ at: 1820, price: 101, tradedAt: 1815 })).prevPrice).toBe(103);
    // 醒来第一笔就已经是新成交:它能当基准
    expect(linkSample(before, quote({ at: 1800, price: 103, tradedAt: 1795 })).sample.settled).toBe(true);
  });

  it("指数换了价的出处(期货推算 ↔ 官方指数)也是换段:6651 → 6701.3 → 6694 → 6681,只有最后一步能比", () => {
    const FUT = "2026-09-24|盘前|futures";
    const IDX = "2026-09-24|盘中|index";
    let s: PriceSample = sample({ at: 0, price: 6651, session: FUT });
    const seen: Array<number | null> = [];
    for (const [at, price] of [[10, 6701.3], [20, 6694], [30, 6681]] as Array<[number, number]>) {
      const step = linkSample(s, quote({ at, price, session: IDX }));
      seen.push(step.prevPrice);
      s = step.sample;
    }
    expect(seen).toEqual([null, null, 6694]);
  });
});

describe("1 分钟收盘确认(bar_close)", () => {
  const round = level({ price: 100, source: "round", label: "整数关口 100" });
  const T0 = 60_000; // 正好是某一分钟的开头
  const KEY = "round@100.0000";
  const step = (states: Record<string, LevelState>, prev: number | null, price: number, at: number) =>
    evaluate([round], states, prev, price, at, undefined, undefined, "bar_close");

  it("跨过的那一刻不报;那一分钟里之后取到的最后一笔还在线的另一侧,下一分钟的第一轮报", () => {
    let [events, states] = step({}, 99.8, 100.2, T0 + 20);
    expect(events).toEqual([]);
    expect(states[KEY]).toEqual({ armed: true, last_fired_at: null, pending: { direction: "up", from: 99.8, at: T0 + 20, minute: 1000 } });
    [events, states] = step(states, 100.2, 100.4, T0 + 50); // 同一分钟里:它是目前为止的收盘
    expect(events).toEqual([]);
    expect(states[KEY]!.pending).toMatchObject({ minute: 1000, close: 100.4, close_at: T0 + 50 });
    [events, states] = step(states, 100.4, 100.6, T0 + 60); // 那一分钟收在 100.4,在线上
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "up", from: 99.8, to: 100.4, price: 100, at: T0 + 60 });
    expect(events[0]!.text).toBe("整数关口 100 上穿 100(1 分钟收盘 100.4 确认,现价 100.6)");
    expect(states[KEY]).toEqual({ armed: false, last_fired_at: T0 + 60 });
  });

  it("那一分钟收回到原来那一侧:作废,不报;之后再穿照样重新等", () => {
    let [events, states] = step({}, 99.8, 100.2, T0 + 20);
    [events, states] = step(states, 100.2, 99.9, T0 + 50);
    [events, states] = step(states, 99.9, 99.7, T0 + 60); // 收在 99.9:假突破
    expect(events).toEqual([]);
    expect(states[KEY]).toEqual({ armed: true, last_fired_at: null });
    [events, states] = step(states, 99.7, 100.3, T0 + 70);
    expect(events).toEqual([]);
    expect(states[KEY]!.pending).toEqual({ direction: "up", from: 99.7, at: T0 + 70, minute: 1001 });
  });

  it("正好收在线上不算站稳", () => {
    let [events, states] = step({}, 99.8, 100.2, T0 + 20);
    [events, states] = step(states, 100.2, 100, T0 + 50);
    [events, states] = step(states, 100, 100.3, T0 + 60); // 那一分钟收在 100,正好在线上:不确认
    expect(events).toEqual([]);
    // 这一轮从线上走到 100.3 是一次新的跨过,重新等它自己那一分钟
    expect(states[KEY]!.pending).toEqual({ direction: "up", from: 100, at: T0 + 60, minute: 1001 });
  });

  it("收盘只认穿过之后取到的价:穿在那一分钟最后一轮的,等下一分钟收完;穿过的那一笔自己不能拿来确认自己", () => {
    // 10:00:55 穿过,这一分钟里再没有取价 → 10:01:05 / 10:01:45 是下一分钟的 → 10:02:05 用 10:01 那一分钟的收盘确认
    let [events, states] = step({}, 99.8, 100.2, T0 + 55);
    [events, states] = step(states, 100.2, 100.3, T0 + 65);
    expect(events).toEqual([]);
    expect(states[KEY]!.pending).toMatchObject({ at: T0 + 55, minute: 1001, close: 100.3 });
    [events, states] = step(states, 100.3, 100.5, T0 + 105);
    [events, states] = step(states, 100.5, 100.4, T0 + 125);
    expect(events.map((e) => e.text)).toEqual(["整数关口 100 上穿 100(1 分钟收盘 100.5 确认,现价 100.4)"]);

    // 取价稀:10:00:20 穿过(100.2),下一笔 10:03:00 已经回到 99.1——不能报「1 分钟收盘 100.2 确认」
    [events, states] = step({}, 99.8, 100.2, T0 + 20);
    [events, states] = step(states, 100.2, 99.1, T0 + 180);
    expect(events).toEqual([]);
    expect(states[KEY]!.pending).toMatchObject({ minute: 1003, close: 99.1 }); // 换成 10:03 那一分钟来等
    [events, states] = step(states, 99.1, 99.0, T0 + 240);
    expect(events).toEqual([]);
    expect(states[KEY]).toEqual({ armed: true, last_fired_at: null });
  });

  it("待确认的这一笔自己记着收盘,不看上一笔接不接得上:换了时段(prev = null)照样确认", () => {
    // 15:59:40 穿过 → 15:59:50 → 16:00:00 这一轮换了时段(调用方给的 prev 是 null)
    let [events, states] = step({}, 99.8, 100.2, T0 + 40);
    [events, states] = step(states, 100.2, 100.4, T0 + 50);
    [events, states] = step(states, null, 100.5, T0 + 60);
    expect(events.map((e) => [e.direction, e.to])).toEqual([["up", 100.4]]);
  });

  it("后续取价断了档(隔得比冷却还久):那根 K 线怎么收的不知道,作废", () => {
    let [events, states] = step({}, 99.8, 100.2, T0 + 20);
    [events, states] = step(states, 100.2, 100.4, T0 + 50);
    [events, states] = step(states, null, 100.6, T0 + 50 + DEFAULT_COOLDOWN + 1);
    expect(events).toEqual([]);
    expect(states[KEY]).toEqual({ armed: true, last_fired_at: null });
    // 穿过之后一笔都没再取到就断了档:同样作废
    [events, states] = step({}, 99.8, 100.2, T0 + 20);
    [events, states] = step(states, null, 100.6, T0 + 20 + DEFAULT_COOLDOWN + 1);
    expect(events).toEqual([]);
    expect(states[KEY]).toEqual({ armed: true, last_fired_at: null });
  });

  it("默认(immediate)不等:跨过就报,和以前一样", () => {
    const [events] = evaluate([round], {}, 99.8, 100.2, T0 + 20);
    expect(events.map((e) => e.text)).toEqual(["整数关口 100 上穿 100(现价 100.2)"]);
  });
});
