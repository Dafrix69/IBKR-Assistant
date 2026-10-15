/** 信息链路的界面规则(desktop/renderer-react/src/lib/intelRules.ts):时间、涨跌、筛选、分天、热门、持仓提醒的弹窗、⌘K 认代码。
 *
 * 钉住:
 *  1. relTime 的几档;moveText 写清提到时与此刻,此刻没有价就只写提到时;方向按此刻对提到时。
 *  2. 关键字筛:代码整词命中或原文 / 说明 / 发送者里含;种类与只看持仓在这里也照样筛。
 *  3. 分天:今天 / 昨天 / 明天,其余写日期;热门按被提到的次数,持仓的标出来。
 *  4. 持仓提醒:弹窗回情报页、带第一只标的与当时的价;不像 held_mention 的数据不弹。
 *  5. ⌘K:$ 与小写都认,中文与空白不认。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
interface Item {
  id: string; kind: "message" | "signal" | "event" | "order" | "idea"; at: number; symbols: string[]; guesses: string[]; held: string[];
  title: string; body: string; tone: string; source: string; ref: string;
}
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "intelRules.ts")).href)) as unknown as {
  relTime(at: number, now: number): string;
  moveText(m: { symbol: string; then: number; now: number | null; pct: number | null }): string;
  moveTone(m?: { symbol: string; then: number; now: number | null; pct: number | null }): string;
  filterItems(items: Item[], f: { kinds: string[]; heldOnly: boolean; query: string }): Item[];
  groupByDay(items: Item[], now: number): Array<{ label: string; items: Item[] }>;
  hotSymbols(items: Item[], max?: number): Array<{ symbol: string; n: number; held: boolean }>;
  isHeldMention(d: unknown): boolean;
  heldMentionPopup(m: { message_id: string; at: number; author_name: string; text: string; symbols: string[]; prices: Record<string, number> }): Record<string, unknown>;
  lookupSymbol(raw: string): string | null;
};

const NOW = new Date(2026, 9, 15, 15, 0, 0).getTime(); // 本机时间 10-15 15:00
const item = (o: Partial<Item>): Item => ({ id: "x", kind: "message", at: NOW, symbols: [], guesses: [], held: [], title: "", body: "", tone: "info", source: "", ref: "", ...o });

describe("时间与涨跌", () => {
  it("relTime:刚刚 / 分钟 / 小时 / 日期;之后的写「后」", () => {
    expect(mod.relTime(NOW - 20_000, NOW)).toBe("刚刚");
    expect(mod.relTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(mod.relTime(NOW + 90 * 60_000, NOW)).toBe("2 小时后");
    expect(mod.relTime(new Date(2026, 9, 12, 9, 5).getTime(), NOW)).toBe("10-12 09:05");
  });

  it("moveText:提到时 → 此刻(带符号的百分比);此刻没有价只写提到时", () => {
    expect(mod.moveText({ symbol: "SPX", then: 7700, now: 7712.5, pct: 0.16 })).toBe("SPX 提到时 7700 → 此刻 7712.5(+0.16%)");
    expect(mod.moveText({ symbol: "NVDA", then: 185.5, now: 180, pct: -2.96 })).toBe("NVDA 提到时 185.50 → 此刻 180(-2.96%)");
    expect(mod.moveText({ symbol: "NVDA", then: 185.5, now: null, pct: null })).toBe("NVDA 提到时 185.50");
    expect(mod.moveTone({ symbol: "A", then: 1, now: 2, pct: 100 })).toBe("up");
    expect(mod.moveTone({ symbol: "A", then: 2, now: 1, pct: -50 })).toBe("down");
    expect(mod.moveTone(undefined)).toBe("");
  });
});

describe("筛、分天、热门", () => {
  const items = [
    item({ id: "1", symbols: ["NVDA"], held: ["NVDA"], title: "英伟达 放量", source: "老王" }),
    item({ id: "2", kind: "signal", symbols: ["TSLA"], title: "TSLA 下破 MA20" }),
    item({ id: "3", kind: "event", symbols: ["SPX"], held: ["SPX"], title: "将公布:CPI", at: NOW + 20 * 3600_000 }),
    item({ id: "4", symbols: ["NVDA", "AAPL"], held: ["NVDA"], title: "两只都看", at: NOW - 26 * 3600_000 }),
  ];

  it("关键字:代码整词、原文、发送者;种类与只看持仓", () => {
    const f = (o: Partial<{ kinds: string[]; heldOnly: boolean; query: string }>) => mod.filterItems(items, { kinds: [], heldOnly: false, query: "", ...o }).map((i) => i.id);
    expect(f({ query: "nvda" })).toEqual(["1", "4"]);
    expect(f({ query: "老王" })).toEqual(["1"]);
    expect(f({ query: "MA20" })).toEqual(["2"]);
    expect(f({ kinds: ["event"] })).toEqual(["3"]);
    expect(f({ heldOnly: true })).toEqual(["1", "3", "4"]);
    expect(f({})).toEqual(["1", "2", "3", "4"]);
  });

  it("分天:今天、明天、昨天;同一天的连在一起", () => {
    const sorted = [items[2]!, items[0]!, items[1]!, items[3]!];
    expect(mod.groupByDay(sorted, NOW).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["明天", ["3"]], ["今天", ["1", "2"]], ["昨天", ["4"]],
    ]);
  });

  it("热门:按次数,持仓的标出来", () => {
    expect(mod.hotSymbols(items)).toEqual([
      { symbol: "NVDA", n: 2, held: true }, { symbol: "AAPL", n: 1, held: false }, { symbol: "SPX", n: 1, held: true }, { symbol: "TSLA", n: 1, held: false },
    ]);
    expect(mod.hotSymbols(items, 1)).toHaveLength(1);
  });
});

describe("持仓的票被提到", () => {
  const m = { message_id: "42", at: NOW, author_name: "Charlie", text: "英伟达 要涨", symbols: ["NVDA", "AAPL"], prices: { NVDA: 185.25 } };

  it("弹窗回情报页,带第一只标的与当时的价", () => {
    expect(mod.isHeldMention(m)).toBe(true);
    expect(mod.heldMentionPopup(m)).toEqual({
      id: "intel:42", kind: "event", symbol: "NVDA", title: "NVDA、AAPL 被提到(持仓)", body: "Charlie:英伟达 要涨(当时 NVDA 185.25)",
      tone: "info", at: NOW, page: "intel",
    });
  });

  it("不像 held_mention 的不弹", () => {
    expect(mod.isHeldMention(null)).toBe(false);
    expect(mod.isHeldMention({ message_id: "1", symbols: [], text: "x" })).toBe(false);
    expect(mod.isHeldMention({ kind: "message", symbols: ["NVDA"] })).toBe(false);
  });
});

describe("⌘K 认代码", () => {
  it("$ 与小写都认;中文、空白、数字开头不认", () => {
    expect(mod.lookupSymbol(" $nvda ")).toBe("NVDA");
    expect(mod.lookupSymbol("brk.b")).toBe("BRK.B");
    expect(mod.lookupSymbol("英伟达")).toBeNull();
    expect(mod.lookupSymbol("")).toBeNull();
    expect(mod.lookupSymbol("7700")).toBeNull();
  });
});

describe("来源那一格", () => {
  it("信号、事件、想法的代号换成人话;消息与单子照原样", () => {
    const label = (mod as unknown as { sourceLabel(i: { kind: string; source: string }): string }).sourceLabel;
    expect(label({ kind: "signal", source: "cross" })).toBe("价位穿越");
    expect(label({ kind: "event", source: "custom" })).toBe("自己记的");
    expect(label({ kind: "idea", source: "active" })).toBe("进行中");
    expect(label({ kind: "message", source: "cross" })).toBe("cross");
    expect(label({ kind: "order", source: "模拟" })).toBe("模拟");
  });
});
