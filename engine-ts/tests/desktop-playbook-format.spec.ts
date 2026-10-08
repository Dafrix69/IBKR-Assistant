/** 日内剧本面板的纯函数(desktop/renderer-react/src/lib/playbookFormat.ts):事件写成的那句话、方向、离线多远。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { PlaybookBand, PlaybookEvent, PlaybookSnapshot } from "../src/contract/options.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
const { bandRows, etTime, eventBody, eventTitle, eventTone, fmtGap, fmtLevel } =
  (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "playbookFormat.ts")).href)) as unknown as {
    bandRows(snap: PlaybookSnapshot): Array<{ key: string; label: string; when: string; band: PlaybookBand | null }>;
    etTime(epochMs: number | null | undefined): string;
    eventBody(event: PlaybookEvent): string;
    eventTitle(symbol: string, event: PlaybookEvent): string;
    eventTone(event: PlaybookEvent): "up" | "down";
    fmtGap(target: number | null | undefined, price: number | null | undefined): string;
    fmtLevel(value: number | null | undefined): string;
  };

const event = (kind: PlaybookEvent["kind"], state: PlaybookEvent["state"], level: number, price: number): PlaybookEvent =>
  ({ at: Date.parse("2026-09-28T10:02:00-04:00"), kind, state, level, price });

describe("事件写成的那句话", () => {
  it.each([
    [event("enter", "B2", 7813.92, 7814.5), "SPX 站上 7813.92,进入 B2 上沿扩展", "up"],
    [event("invalid", "B2", 7813.92, 7813), "SPX 跌回 7813.92 下方,B2 失效", "down"],
    [event("enter", "B3", 7780.98, 7780), "SPX 跌破 7780.98,进入 B3 失守续探", "down"],
    [event("invalid", "B3", 7780.98, 7782), "SPX 收回 7780.98 上方,B3 失效", "up"],
    [event("accel", "R", 7790, 7789), "SPX 下破加速档 7790", "down"],
    [event("accel", "B2", 7790, 7791), "SPX 上穿加速档 7790", "up"],
  ])("%#", (e, title, tone) => {
    expect(eventTitle("SPX", e)).toBe(title);
    expect(eventTone(e)).toBe(tone);
  });

  it("正文带现价与美东时刻(不跟着电脑的时区变)", () => {
    expect(eventBody(event("enter", "B3", 7780.98, 7780))).toBe("现价 7780.00 · 美东 10:02");
    expect(etTime(null)).toBe("");
  });
});

describe("数字", () => {
  it("价位两位小数,没有就是一条横线", () => {
    expect(fmtLevel(7813.917)).toBe("7813.92");
    expect(fmtLevel(null)).toBe("—");
    expect(fmtLevel(NaN)).toBe("—");
  });

  it("离线多远:目标减现价,带正负号;缺一边就不写", () => {
    expect(fmtGap(7813.92, 7791.61)).toBe("+22.3");
    expect(fmtGap(7780.98, 7791.61)).toBe("−10.6");
    expect(fmtGap(7790, 7790)).toBe("0.0");
    expect(fmtGap(null, 7790)).toBe("");
  });
});

describe("三条区间的行", () => {
  it("顺序是昨日、盘初、当前;没有的那一条照列,带着它该在什么时候取", () => {
    const snap = { frame_seconds: 300, bands: { prior: null, open: null, current: null } } as unknown as PlaybookSnapshot;
    expect(bandRows(snap).map((r) => [r.key, r.label, r.when, r.band])).toEqual([
      ["prior", "昨日定价", "上一个收盘后 10 分钟", null],
      ["open", "盘初定价", "09:35", null],
      ["current", "当前剩余", "每 5 分钟", null],
    ]);
  });
});
