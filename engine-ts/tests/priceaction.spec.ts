/** 价格行为(priceaction.ts)的规矩,逐条钉住。数值口径在 golden-analysis,这里钉的是三件不许破的事:
 *
 *  1. 判定只用已收盘的 K 线:最后一根没走完时,它长成什么样都改不了分数、事件、扫单、形态(不重绘)。
 *  2. 历史上的事件按当时看得到的东西算:同一段 K 线截短了再算,截断处之前的事件一条不变(没有后见之明)。
 *  3. 打分表每一条的方向说得通:放量算谁的看那一根自己;三个子分只是把同一张权重表分开摆。
 */
import { describe, expect, it } from "vitest";

import type { PaAnalysis, PaEvidence } from "../src/contract/priceaction.js";
import * as pa from "../src/priceaction.js";
import { loadGolden } from "./util.js";

type Row = { time: string; open: number; high: number; low: number; close: number; volume: number };

/** 5 分钟线的时间戳:第 i 根的起点,从 2026-08-12 09:30(美东)起一根接一根。 */
function stamp(i: number): string {
  return new Date(Date.UTC(2026, 7, 12, 9, 30) + i * 300_000).toISOString().slice(0, 16).replace("T", " ");
}
/** 美东墙钟(8 月,夏令时)→ epoch 毫秒。 */
const et = (wall: string): number => Date.parse(`${wall.replace(" ", "T")}:00-04:00`);
const bar = (i: number, open: number, high: number, low: number, close: number, volume = 1000): Row =>
  ({ time: stamp(i), open, high, low, close, volume });

/** 黄金基线里的三段 5 分钟线(各 160 根,最后一根 2026-08-14 09:45)。 */
const GOLDEN: Record<string, Row[]> = Object.fromEntries(
  (loadGolden("priceaction").cases as Array<{ name: string; rows: Row[]; error?: string }>)
    .filter((c) => c.error === undefined)
    .map((c) => [c.name, c.rows]),
);
const LAST_OPEN = et("2026-08-14 09:45");
const ALL = 1e9;

function tolAt(rows: Row[]): (i: number) => number {
  const atrs = pa.atrSeries(rows);
  return (i) => (atrs[i]! > 0 ? atrs[i]! * 0.35 : Math.abs(rows[i]!.close) * 0.0005);
}

/** 只由已收盘的 K 线决定的那些项:除了正在形成的那一根本身、画图用的、现价与新鲜度。 */
const LIVE_KEYS = new Set(["forming", "bars", "ma", "last", "last_bar", "age_seconds", "warnings", "readout"]);
function verdict(result: PaAnalysis): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !LIVE_KEYS.has(key)));
}

// ---------------------------------------------------------------- 收没收盘
describe("最后一根收没收盘:对着调用方给的时刻算", () => {
  it("日内:时间戳是起点,起点 + 周期才算走完", () => {
    expect(pa.barCloseEpochMs("2026-08-14 09:45", "5m")).toBe(et("2026-08-14 09:50"));
    expect(pa.barCloseEpochMs("2026-08-14 09:45:00", "1m")).toBe(et("2026-08-14 09:46"));
    expect(pa.barCloseEpochMs("2026-08-14 15:00", "1h")).toBe(et("2026-08-14 16:00"));
  });

  it("日线:只看盘中 16:00 走完,含盘前盘后要等到 20:00", () => {
    expect(pa.barCloseEpochMs("2026-08-14", "1d", false)).toBe(et("2026-08-14 16:00"));
    expect(pa.barCloseEpochMs("2026-08-14", "1d", true)).toBe(et("2026-08-14 20:00"));
    // 冬令时那半年也按美东墙钟算
    expect(pa.barCloseEpochMs("2026-12-01", "1d", false)).toBe(Date.parse("2026-12-01T16:00:00-05:00"));
  });

  it("周期不认识、时间戳读不懂:算不出,返回 null", () => {
    expect(pa.barCloseEpochMs("2026-08-14 09:45", "7m")).toBeNull();
    expect(pa.barCloseEpochMs("昨天", "5m")).toBeNull();
  });

  it("日线在盘中是正在形成的那一根,收盘后才进判定", () => {
    const rows: Row[] = [];
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 6, 6) + i * 86_400_000).toISOString().slice(0, 10); // 最后一根 2026-08-14
      const close = 100 + i * 0.5 + 2 * Math.sin(i / 3);
      rows.push({ time: day, open: close - 0.3, high: close + 1, low: close - 1, close, volume: 1e6 });
    }
    expect(rows[rows.length - 1]!.time).toBe("2026-08-14");
    const at = (wall: string, extended: boolean) => pa.analyze(rows, "SPY", "1d", pa.SWING_STRENGTH, et(wall), extended);

    const midday = at("2026-08-14 12:00", false);
    expect(midday.forming).toMatchObject({ time: "2026-08-14", closes_at: "2026-08-14 16:00" });
    expect(midday).toMatchObject({ bar_count: 39, closed_bar: "2026-08-13", last_bar: "2026-08-14" });

    expect(at("2026-08-14 16:00", false).forming).toBeNull(); // 只看盘中:16:00 收盘
    expect(at("2026-08-14 16:00", true).forming?.closes_at).toBe("2026-08-14 20:00"); // 含盘后:还在走
    expect(at("2026-08-14 20:00", true).forming).toBeNull();
    expect(at("2026-08-15 09:00", true)).toMatchObject({ bar_count: 40, closed_bar: "2026-08-14", forming: null });

    // 指数没有盘前盘后:取的是全时段口径(extended_hours 照旧是 true),日线也 16:00 就走完
    const index = pa.analyze(rows, "SPX", "1d", pa.SWING_STRENGTH, { epochMs: et("2026-08-14 16:20"), extendedSession: false }, true);
    expect(index).toMatchObject({ forming: null, closed_bar: "2026-08-14", extended_hours: true });
  });
});

// ---------------------------------------------------------------- 不重绘
describe("正在形成的那一根不进判定", () => {
  const rows = GOLDEN["range"]!;
  const closed = rows.slice(0, -1);
  const inside = LAST_OPEN + 120_000; // 最后一根走了 2 分钟

  it("最后一根没走完:判定与「只给已收盘那 159 根」逐项相同,它自己单独放在 forming 里", () => {
    const live = pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, inside);
    const settled = pa.analyze(closed, "RANGE", "5m");
    expect(verdict(live)).toEqual(verdict(settled));

    const newest = rows[rows.length - 1]!;
    expect(live.forming).toMatchObject({
      time: "2026-08-14 09:45", closes_at: "2026-08-14 09:50", waiting: null,
      open: newest.open, high: newest.high, low: newest.low, close: newest.close, volume: newest.volume,
    });
    expect(live).toMatchObject({ bar_count: 159, closed_bar: "2026-08-14 09:40", last_bar: "2026-08-14 09:45" });
    expect(live.context.last).toBe(closed[closed.length - 1]!.close); // 判定价是上一根的收盘
    expect(live.last).toBe(newest.close); // 现价照旧是最新那一根
    expect(live.age_seconds).toBe(120);
    // 图照旧画到最新一根,均线跟着
    expect(live.bars[live.bars.length - 1]!.time).toBe("2026-08-14 09:45");
    for (const series of Object.values(live.ma)) expect(series).toHaveLength(live.bars.length);
  });

  it("它长成什么样都改不了分数、事件、扫单与形态", () => {
    const base = verdict(pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, inside));
    const prev = closed[closed.length - 1]!;
    const shapes: Array<Partial<Row>> = [
      { open: prev.close, high: prev.close + 9, low: prev.close - 0.1, close: prev.close + 8, volume: 9e7 }, // 一根放量大阳,越过所有前高
      { open: prev.close, high: prev.close + 0.1, low: prev.close - 9, close: prev.close - 8, volume: 9e7 }, // 一根放量大阴,跌穿所有前低
      { open: prev.close, high: prev.close + 9, low: prev.close - 9, close: prev.close, volume: 1 }, // 上下各扫一遍又回到原地
    ];
    for (const shape of shapes) {
      const mutated = [...closed, { ...rows[rows.length - 1]!, ...shape }];
      expect(verdict(pa.analyze(mutated, "RANGE", "5m", pa.SWING_STRENGTH, inside))).toEqual(base);
    }
  });

  /** 下跌那一段:最后一根收盘在低位,上方留着一个还没被越过的前高。把最后一根换成给定的形状。 */
  const falling = GOLDEN["downtrend"]!.slice(0, -1);
  const fallingPrev = falling[falling.length - 1]!;
  const lastSwingHigh = [...pa.analyze(falling, "DOWN", "5m").swings].reverse().find((s) => s.kind === "high")!;
  const withLast = (shape: Partial<Row>): Row[] => [...falling, { ...GOLDEN["downtrend"]![falling.length]!, ...shape }];

  it("没走完时越过前高只给一句提示;走完了才记成事件,记在同一根上", () => {
    expect(lastSwingHigh.price).toBeGreaterThan(fallingPrev.close);
    const breakout = withLast({ open: fallingPrev.close, high: lastSwingHigh.price + 1.2, low: fallingPrev.close - 0.05, close: lastSwingHigh.price + 1 });
    const index = breakout.length - 1;

    const live = pa.analyze(breakout, "DOWN", "5m", pa.SWING_STRENGTH, inside);
    expect(live.events.some((e) => e.index === index)).toBe(false);
    expect(live.forming!.hints[0]).toBe(
      `若此刻收盘会记一次 CHoCH:现价 ${Math.round((lastSwingHigh.price + 1) * 1e4) / 1e4} 在前高 ${lastSwingHigh.price} 之上`,
    );
    expect(live.bias).toBe(pa.analyze(falling, "DOWN", "5m").bias); // 判断没有被这根没走完的翻过来

    const done = pa.analyze(breakout, "DOWN", "5m", pa.SWING_STRENGTH, LAST_OPEN + 300_000);
    expect(done.forming).toBeNull();
    expect(done.events[done.events.length - 1]).toMatchObject({
      kind: "CHoCH", direction: "up", index, time: "2026-08-14 09:45", level: lastSwingHigh.price,
    });
  });

  it("影线刺穿前高又缩回来:没走完时是提示,不是扫单", () => {
    const wick = withLast({ open: fallingPrev.close, high: lastSwingHigh.price + 1, low: fallingPrev.close - 0.05, close: fallingPrev.close });
    const live = pa.analyze(wick, "DOWN", "5m", pa.SWING_STRENGTH, inside);
    expect(live.sweeps.some((s) => s.index === wick.length - 1)).toBe(false);
    expect(live.forming!.hints).toHaveLength(1);
    expect(live.forming!.hints[0]).toMatch(/^若此刻收盘会记一次扫单:影线上破前高 [\d.]+,现价回到了它下方$/);
    const done = pa.analyze(wick, "DOWN", "5m", pa.SWING_STRENGTH, LAST_OPEN + 300_000);
    expect(done.sweeps[done.sweeps.length - 1]).toMatchObject({ index: wick.length - 1, direction: "bear" });
  });

  it("缓存里的 K 线:取的时候没走完,现在钟点过了它也还是半根(对着取数时刻判)", () => {
    const later = LAST_OPEN + 600_000; // 现在 09:55,那一根按钟点早该收了
    const stale = pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, { epochMs: later, barsAsOfMs: inside });
    expect(stale.forming?.time).toBe("2026-08-14 09:45");
    expect(stale.bar_count).toBe(159);
    expect(stale.age_seconds).toBe(600); // 新鲜度照现在算
    // 同一时刻新取的一份:那一根已经收盘
    expect(pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, later).forming).toBeNull();
  });

  it("不给 now = 一段历史切片,全部按已收盘;给了 now 却算不出几点走完,拿不准就不让它进判定", () => {
    expect(pa.analyze(rows, "RANGE", "5m")).toMatchObject({ bar_count: 160, forming: null, closed_bar: "2026-08-14 09:45" });
    const unknown = pa.analyze(rows, "RANGE", "", pa.SWING_STRENGTH, LAST_OPEN + 86_400_000);
    expect(unknown.bar_count).toBe(159);
    expect(unknown.forming).toMatchObject({ time: "2026-08-14 09:45", closes_at: null });
  });

  it("已收盘的不够 30 根:报错里说的是已收盘的根数", () => {
    const thirty = rows.slice(-30);
    expect(() => pa.analyze(thirty, "X", "5m", pa.SWING_STRENGTH, inside)).toThrowError("只有 29 根已收盘的 K 线");
    expect(pa.analyze(thirty, "X", "5m", pa.SWING_STRENGTH, LAST_OPEN + 300_000).bar_count).toBe(30);
  });

  it("给模型的事实块写明哪一根没收盘、哪几句还没确认;高周期摘要带上算到哪一根", () => {
    const breakout = withLast({ open: fallingPrev.close, high: lastSwingHigh.price + 1.2, low: fallingPrev.close - 0.05, close: lastSwingHigh.price + 1 });
    const live = pa.analyze(breakout, "DOWN", "5m", pa.SWING_STRENGTH, inside);
    const facts = pa.factsText(live);
    expect(facts).toContain("已收盘 K 线 159 根,最后一根 2026-08-14 09:40");
    expect(facts).toContain("正在形成:2026-08-14 09:45 那根还没收盘(2026-08-14 09:50 收盘)");
    expect(facts).toMatch(/\n未确认:若此刻收盘会记一次 CHoCH:.+\(收盘之前不算数\)。\n/);
    expect(pa.htfSummary(live).closed_bar).toBe("2026-08-14 09:40");

    const settled = pa.factsText(pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, LAST_OPEN + 300_000));
    expect(settled).not.toContain("正在形成");
    expect(settled).not.toContain("未确认");
  });
});

// ---------------------------------------------------------------- 延迟行情
describe("延迟行情:钟点到了,数据未必到齐", () => {
  const rows = GOLDEN["downtrend"]!;
  const closed = rows.slice(0, -1);
  /** 取数在 10:02:最新一根(09:45 起)按钟点 09:50 就走完了,过去 12 分钟;延迟档的数据其实只到 09:42–09:47 */
  const fetchedAt = et("2026-08-14 10:02");
  const at = (feed: "live" | "delayed" | "unknown" | undefined, data: Row[] = rows, now = fetchedAt) =>
    pa.analyze(data, "DOWN", "5m", pa.SWING_STRENGTH, { epochMs: now, barsAsOfMs: now, feed });

  it("延迟档:钟点过去不到 20 分钟的那一根不进判定,标成「数据未到齐」;实时档只看钟点", () => {
    const delayed = at("delayed");
    expect(delayed.forming).toMatchObject({ time: "2026-08-14 09:45", closes_at: "2026-08-14 09:50", waiting: "delayed" });
    expect(delayed).toMatchObject({ bar_count: 159, closed_bar: "2026-08-14 09:40" });
    expect(verdict(delayed)).toEqual(verdict(pa.analyze(closed, "DOWN", "5m")));
    expect(delayed.warnings[0]).toContain("行情是延迟的");

    for (const feed of ["live", undefined] as const) {
      const live = at(feed);
      expect(live).toMatchObject({ forming: null, bar_count: 160, closed_bar: "2026-08-14 09:45" });
      expect(live.warnings.join("")).not.toContain("行情是延迟的");
    }
  });

  it("那半根长成一次突破,也改不了延迟档的分数与事件(评审复现的那一例)", () => {
    const prev = closed[closed.length - 1]!;
    const top = Math.max(...closed.slice(-30).map((r) => r.high));
    const breakout = [...closed, { ...rows[rows.length - 1]!, open: prev.close, high: top + 3.2, low: prev.close - 0.05, close: top + 3 }];
    const calm = at("delayed");
    const wild = at("delayed", breakout);
    expect(wild.score).toBe(calm.score);
    expect(wild.events).toEqual(calm.events);
    expect(wild.forming!.hints.some((h) => h.startsWith("若此刻收盘会记一次 CHoCH"))).toBe(true);
    // 同一组 K 线按实时档读,这一根就是收盘的:事件记上了,分数跟着变——延迟档不许这样
    const asLive = at("live", breakout);
    expect(asLive.events[asLive.events.length - 1]).toMatchObject({ kind: "CHoCH", index: breakout.length - 1 });
    expect(asLive.score).not.toBe(calm.score);
  });

  it("钟点过去满 20 分钟(延迟档的上限)才认它收盘;说不准是哪一档的,按延迟对待但不说它是延迟的", () => {
    expect(at("delayed", rows, et("2026-08-14 10:09")).forming?.waiting).toBe("delayed");
    expect(at("delayed", rows, et("2026-08-14 10:10"))).toMatchObject({ forming: null, bar_count: 160 });

    const unknown = at("unknown");
    expect(unknown.forming).toMatchObject({ time: "2026-08-14 09:45", waiting: "unknown" });
    expect(unknown.warnings.join("")).not.toContain("行情是延迟的");
    expect(at("unknown", rows, et("2026-08-14 10:10")).forming).toBeNull();
  });

  it("钟点还没到的那一根是照常的「正在形成」,和哪一档行情无关;事实块按原因写", () => {
    const inside = at("delayed", rows, LAST_OPEN + 120_000);
    expect(inside.forming).toMatchObject({ closes_at: "2026-08-14 09:50", waiting: null });
    expect(pa.factsText(inside)).toContain("正在形成:2026-08-14 09:45 那根还没收盘");
    const facts = pa.factsText(at("delayed"));
    expect(facts).toContain("数据未到齐:2026-08-14 09:45 那根按钟点 2026-08-14 09:50 已经走完,但行情是延迟的");
    expect(pa.factsText(at("unknown"))).toContain("但还说不准行情是不是延迟的");
  });
});

// ---------------------------------------------------------------- 行情停了的告警
describe("「行情停了」从最新一根走完那一刻起算", () => {
  const rows = GOLDEN["range"]!;
  const stale = (r: PaAnalysis): string[] => r.warnings.filter((w) => w.includes("可能是休市"));

  it("还在走的那一根不报:1 小时线走到第 45 分钟,起点离现在 45 分钟不说明行情停了", () => {
    // 同一组时间戳当成 1 小时线读:09:45 起的那根 10:45 才走完
    const r = pa.analyze(rows, "RANGE", "1h", pa.SWING_STRENGTH, LAST_OPEN + 45 * 60_000);
    expect(r.forming?.closes_at).toBe("2026-08-14 10:45");
    expect(r.age_seconds).toBe(2700);
    expect(stale(r)).toEqual([]);
  });

  it("走完之后 30 分钟还没有新的 K 线才报,分钟数从走完那一刻数", () => {
    expect(stale(pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, LAST_OPEN + 35 * 60_000))).toEqual([]); // 走完才 30 分钟整
    const r = pa.analyze(rows, "RANGE", "5m", pa.SWING_STRENGTH, LAST_OPEN + 36 * 60_000);
    expect(stale(r)).toEqual(["最后一根 K 线(2026-08-14 09:45)走完之后已经 31 分钟没有新的 K 线——可能是休市,也可能是行情延迟或订阅缺失。"]);
    expect(r.age_seconds).toBe(2160); // 新鲜度照旧从这一根的起点算
  });

  it("日线不报这一条:盘中它还在走,收盘后隔一夜才有下一根", () => {
    const daily: Row[] = [];
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 6, 6) + i * 86_400_000).toISOString().slice(0, 10);
      const close = 100 + i * 0.5 + 2 * Math.sin(i / 3);
      daily.push({ time: day, open: close - 0.3, high: close + 1, low: close - 1, close, volume: 1e6 });
    }
    for (const wall of ["2026-08-14 10:00", "2026-08-14 17:00", "2026-08-15 08:00"]) {
      expect(stale(pa.analyze(daily, "SPY", "1d", pa.SWING_STRENGTH, et(wall)))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- 没有后见之明
describe("历史事件按当时看得到的摆动点算", () => {
  it("前高被收盘越过之后又被更高的高点顶掉:那次突破仍然记在当时那个前高上", () => {
    // 第 2 根是前高 12(第 4 根确认),第 5 根收盘 12.5 越过它;随后第 7 根走出更高的 14,中间没有确认过低点,
    // 交替序列里 14 顶掉了 12。拿最终那份序列回头走,这次突破就没了。
    const hlc: Array<[number, number, number]> = [
      [10, 9, 9.5], [11, 10, 10.5], [12, 11, 11.5], [11.5, 10.6, 11], [11.4, 10.7, 11.2],
      [12.6, 11.2, 12.5], [13, 12.3, 12.8], [14, 12.7, 13.8], [13.5, 12.9, 13], [13.2, 12.8, 12.9],
    ];
    const rows = hlc.map(([high, low, close], i) => bar(i, i ? hlc[i - 1]![2] : 9.2, high, low, close));
    const history = pa.structureHistory(rows, () => 0.1);
    expect(history.points.map((p) => [p.kind, p.index, p.price])).toEqual([["high", 7, 14]]);
    expect(pa.zigzag(pa.findSwings(rows))).toEqual(history.points); // 截至最后一根的序列,和一次性整理出来的是同一份
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({ kind: "BOS", direction: "up", index: 5, level: 12, close: 12.5, swing_time: stamp(2) });
  });

  it.each(Object.keys(GOLDEN))("%s:截短到任意一根再算,截断处之前的事件与扫单一条不变", (name) => {
    const rows = GOLDEN[name]!;
    const full = pa.structureHistory(rows, tolAt(rows), pa.SWING_STRENGTH, ALL, ALL, ALL);
    expect(full.events.length).toBeGreaterThan(5);
    expect(full.sweeps.length).toBeGreaterThan(0);
    for (let m = 30; m < rows.length; m++) {
      const prefix = rows.slice(0, m);
      const then = pa.structureHistory(prefix, tolAt(prefix), pa.SWING_STRENGTH, ALL, ALL, ALL);
      expect(then.events).toEqual(full.events.filter((e) => e.index < m));
      expect(then.sweeps).toEqual(full.sweeps.filter((s) => s.index < m));
    }
  });

  it("每一根的 ATR 只用到它自己为止;最后一项就是整段的 ATR", () => {
    const rows = GOLDEN["uptrend"]!;
    const series = pa.atrSeries(rows);
    expect(series).toHaveLength(rows.length);
    expect(series[0]).toBe(0);
    expect(series[rows.length - 1]).toBe(pa.atr(rows));
    expect(series[57]).toBe(pa.atr(rows.slice(0, 58)));
  });
});

// ---------------------------------------------------------------- 打分
describe("打分表", () => {
  /** n 根小步走的 K 线,最后一根单独给形状与量。 */
  function drift(step: number, last: { gap: number; body: number; volume: number }, n = 60): Row[] {
    const rows: Row[] = [];
    let prev = 100;
    for (let i = 0; i < n - 1; i++) {
      const close = Math.round((prev + step) * 100) / 100;
      rows.push(bar(i, prev, Math.max(prev, close) + 0.05, Math.min(prev, close) - 0.05, close));
      prev = close;
    }
    const open = prev + last.gap;
    const close = open + last.body;
    rows.push(bar(n - 1, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, last.volume));
    return rows;
  }
  const volumeItem = (rows: Row[]): PaEvidence | undefined =>
    pa.analyze(rows, "X", "5m").evidence.find((e) => e.label === "量能");

  it("放量算谁的,看放量那一根自己收阳还是收阴,不看它在均线哪一边", () => {
    // 一路涨上来、收盘在 EMA20 之上,最后一根放量收阴:是空头的证据
    const bearish = drift(0.1, { gap: 0.3, body: -0.2, volume: 5000 });
    expect(pa.analyze(bearish, "X", "5m").context.vs_ema20_pct).toBeGreaterThan(0);
    expect(volumeItem(bearish)).toMatchObject({ group: "confirm", weight: -8 });
    expect(volumeItem(bearish)!.detail).toContain("收阴");
    // 一路跌下来、收盘在 EMA20 之下,最后一根放量收阳:是多头的证据
    const bullish = drift(-0.1, { gap: -0.3, body: 0.2, volume: 5000 });
    expect(pa.analyze(bullish, "X", "5m").context.vs_ema20_pct).toBeLessThan(0);
    expect(volumeItem(bullish)).toMatchObject({ group: "confirm", weight: 8 });
    // 开收同价:放量,但不记方向
    expect(volumeItem(drift(0.1, { gap: 0.1, body: 0, volume: 5000 }))).toMatchObject({ weight: 0 });
    // 没放量:这一条不出现
    expect(volumeItem(drift(0.1, { gap: 0.3, body: -0.2, volume: 1000 }))).toBeUndefined();
  });

  it.each(Object.keys(GOLDEN))("%s:三个子分是同一张权重表分开加,加起来就是总分夹到 ±100 之前的那个数", (name) => {
    const result = pa.analyze(GOLDEN[name]!, name, "5m");
    expect(result.sub_scores.map((s) => [s.key, s.label, s.max])).toEqual([
      ["structure", "结构", 67], ["location", "位置", 23], ["confirm", "确认", 33],
    ]);
    const groupOf: Record<string, string> = {
      摆动结构: "structure", 最近一次结构事件: "structure", 均线动能: "structure",
      区间位置: "location", 贴近关键位: "location",
      流动性扫单: "confirm", 近端形态: "confirm", 量能: "confirm",
    };
    for (const item of result.evidence) expect(item.group).toBe(groupOf[item.label]);
    for (const sub of result.sub_scores) {
      const items = result.evidence.filter((e) => e.group === sub.key);
      expect(sub.score).toBeCloseTo(items.reduce((acc, e) => acc + e.weight, 0), 9);
      expect(Math.abs(sub.score)).toBeLessThanOrEqual(sub.max);
      expect(sub.mixed).toBe(items.some((e) => e.weight > 0) && items.some((e) => e.weight < 0));
    }
    // 子分不夹,总分夹在 ±100 之内:三个子分加起来可以比总分的绝对值大
    const total = result.sub_scores.reduce((acc, s) => acc + s.score, 0);
    expect(result.score).toBeCloseTo(Math.max(-100, Math.min(100, total)), 9);
    expect(pa.factsText(result)).toContain("子分(各自相加,互不抵消):结构 ");
  });

  it("子分把组内的相反读法标出来:结构向下 + 均线多头排列是 mixed", () => {
    const up = pa.analyze(GOLDEN["uptrend"]!, "UP", "5m");
    const structure = up.sub_scores[0]!;
    expect(up.evidence.filter((e) => e.group === "structure").map((e) => Math.sign(e.weight))).toEqual([-1, -1, 1]);
    expect(structure).toMatchObject({ key: "structure", score: -43, mixed: true });
  });
});

// ---------------------------------------------------------------- 关键位与订单块
describe("关键位与订单块", () => {
  it("关键位:一簇里最高与最低相差不超过容差,不会一个挨一个接成一条宽带", () => {
    // 四个高点两两相隔 0.3,容差 0.35:一个挨一个都够得着,但头尾差 0.9
    const prices = [100, 100.3, 100.6, 100.9];
    const points = prices.map((price, i) => ({ index: i * 3, time: stamp(i * 3), price, kind: "high" as const, label: "" }));
    const rows = prices.map((price, i) => bar(i, price - 1, price, price - 1.5, price - 0.5));
    const levels = pa.clusterLevels(rows, points, 0.35, 99, 9);
    expect(levels.map((l) => [l.price, l.swings])).toEqual([[100.15, 2], [100.75, 2]]);
  });

  it("订单块的回踩从突破之后数起:把价格推出去的那几根不算回来", () => {
    // 第 3 根是突破前最后一根阴线(订单块 9.8 ~ 10.4);第 4、5 根从它的范围里往上推,第 6 根收盘突破
    const rows = [
      bar(0, 10, 10.6, 9.9, 10.5), bar(1, 10.5, 10.9, 10.3, 10.8), bar(2, 10.8, 11, 10.5, 10.6),
      bar(3, 10.3, 10.4, 9.8, 9.9), bar(4, 9.9, 10.5, 9.85, 10.45), bar(5, 10.45, 11.2, 10.3, 11.1),
      bar(6, 11.1, 12, 11, 11.9), bar(7, 11.9, 12.4, 11.7, 12.3), bar(8, 12.3, 12.6, 12.1, 12.5),
    ];
    const event = { kind: "BOS", direction: "up", time: stamp(6), index: 6, level: 11, close: 11.9, swing_time: stamp(2), text: "" };
    expect(pa.orderBlock(rows, event)).toMatchObject({ side: "bull", time: stamp(3), bottom: 9.8, top: 10.4, mitigated: false });
    // 突破之后真的回到它的范围里,才算被回踩
    const back = [...rows, bar(9, 12.5, 12.5, 10.2, 10.6)];
    expect(pa.orderBlock(back, event)).toMatchObject({ time: stamp(3), mitigated: true });
  });
});
