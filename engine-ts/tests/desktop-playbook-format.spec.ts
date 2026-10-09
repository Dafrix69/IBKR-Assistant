/** 日内剧本面板的纯函数(desktop/renderer-react/src/lib/playbookFormat.ts):事件写成的那句话、方向、离线多远。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { PlaybookBand, PlaybookEvent, PlaybookSnapshot } from "../src/contract/options.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
const { bandRows, coverageText, etTime, eventBody, eventTitle, eventTone, fmtGap, fmtLevel, gexText, rearmText, GEX_ASSUMPTION, STATE_HINT } =
  (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "playbookFormat.ts")).href)) as unknown as {
    bandRows(snap: PlaybookSnapshot): Array<{ key: string; label: string; when: string; band: PlaybookBand | null; derived: boolean }>;
    coverageText(c: { lower: number; upper: number; strikes: number; grid_strikes: number | null; thinned: boolean } | null | undefined, oiMissing?: number | null): string;
    rearmText(lost: number | null | undefined): string;
    gexText(wall: { regime: string; net_gex_ratio?: number | null; gross_gex?: number | null; has_greeks?: boolean }): string;
    GEX_ASSUMPTION: string;
    STATE_HINT: Record<string, string>;
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

describe("区间的行", () => {
  it("顺序是昨日、盘初、当前、今日;没有的那一条照列,带着它该在什么时候取;今日区间标成拼出来的", () => {
    const snap = { frame_seconds: 300, bands: { prior: null, open: null, current: null, day: null } } as unknown as PlaybookSnapshot;
    expect(bandRows(snap).map((r) => [r.key, r.label, r.when, r.band, r.derived])).toEqual([
      ["prior", "昨日定价", "上一个收盘后 10 分钟", null, false],
      ["open", "盘初定价", "09:35", null, false],
      ["current", "当前剩余", "每 5 分钟", null, false],
      ["day", "今日区间", "09:35 的锚 ± 当前剩余", null, true],
    ]);
  });

  it("老引擎给的快照没有今日区间那一格:照列,当它还没有", () => {
    const snap = { frame_seconds: 300, bands: { prior: null, open: null, current: null } } as unknown as PlaybookSnapshot;
    expect(bandRows(snap)[3]).toMatchObject({ key: "day", band: null });
  });

  it("B2 的说明写的是今日区间,不是每五分钟围着现价重取的那一条;也写明每取到新一格才判一次", () => {
    expect(STATE_HINT["B2"]).toContain("今日区间的上沿");
    expect(STATE_HINT["B2"]).toContain("剩余的预期波动");
    expect(STATE_HINT["B2"]).toContain("每 5 分钟取到新一格时判一次");
    expect(STATE_HINT["B3"]).toContain("每一笔现价都判");
  });

  it("B2 失效之后那句话带着丢掉的那条线;没在等就不写", () => {
    expect(rearmText(7743.466)).toBe("B2 已失效:取到新一格时回到这条线下方再站上,或重新站回 7743.47 之上,才算新的一次");
    expect(rearmText(null)).toBe("");
    expect(rearmText(undefined)).toBe("");
  });
});

describe("期权墙的 gamma 环境", () => {
  it("正负旁边带着净额占总量多少;占得再小也照实写,不替人判成中性", () => {
    expect(gexText({ regime: "negative", net_gex_ratio: -0.1028 })).toBe("负 gamma(波动放大) · 净额占总量 10.3%");
    expect(gexText({ regime: "positive", net_gex_ratio: 0.004 })).toBe("正 gamma(波动受压) · 净额占总量 0.4%");
    expect(gexText({ regime: "positive", net_gex_ratio: null })).toBe("正 gamma(波动受压)");
  });

  it("没称出分量是不知道,不是正也不是负,更不是「正好抵消」", () => {
    expect(gexText({ regime: "unknown", net_gex_ratio: null })).toBe("gamma 环境未知(缺隐含波动率或未平仓量)");
    expect(gexText({ regime: "neutral", net_gex_ratio: 0 })).toBe("看涨与看跌的 gamma 正好抵消");
    expect(gexText({ regime: "neutral", net_gex_ratio: 0, gross_gex: 5_000_000 })).toBe("看涨与看跌的 gamma 正好抵消");
    // 盯单上存着的墙:有 gamma 但未平仓量全是 0 时曾被写成 neutral(总量 0)——读成不知道
    expect(gexText({ regime: "neutral", net_gex_ratio: null, gross_gex: 0 })).toBe("gamma 环境未知(缺隐含波动率或未平仓量)");
    expect(gexText({ regime: "positive", net_gex_ratio: 0.2, gross_gex: null })).toBe("gamma 环境未知(缺隐含波动率或未平仓量)");
  });

  it("盯单上存着老版本算的墙(没有隐含波动率却写着 positive):读成不知道;老版本算对的照读", () => {
    expect(gexText({ regime: "positive", has_greeks: false })).toBe("gamma 环境未知(缺隐含波动率或未平仓量)");
    expect(gexText({ regime: "negative", has_greeks: true })).toBe("负 gamma(波动放大)");
    // 新版本:只有券商的模型 gamma、没有隐含波动率,正负是算得出来的
    expect(gexText({ regime: "positive", has_greeks: false, gross_gex: 1200, net_gex_ratio: 0.5 })).toBe("正 gamma(波动受压) · 净额占总量 50.0%");
  });

  it("假设写在数旁边的那几个字", () => {
    expect(GEX_ASSUMPTION).toBe("假设做市商多看涨、空看跌");
  });

  it("取了哪一段:抽着取的说出来", () => {
    expect(coverageText({ lower: 7625, upper: 7800, strikes: 31, grid_strikes: 36, thinned: true })).toBe("7625–7800 共 31 档(链上 36 档,远处只取整数档)");
    expect(coverageText({ lower: 7645, upper: 7795, strikes: 31, grid_strikes: 31, thinned: false })).toBe("7645–7795 共 31 档");
    expect(coverageText({ lower: 7645, upper: 7795, strikes: 31, grid_strikes: null, thinned: false })).toBe("7645–7795 共 31 档");
    // 个别档没回数(合约确认不了):不是抽着取的,不这么写
    expect(coverageText({ lower: 7645, upper: 7795, strikes: 29, grid_strikes: 31, thinned: false })).toBe("7645–7795 共 29 档");
    expect(coverageText(undefined)).toBe("");
    // 有行没等到未平仓量:也写在这一句里
    expect(coverageText({ lower: 7645, upper: 7795, strikes: 31, grid_strikes: 31, thinned: false }, 4)).toBe("7645–7795 共 31 档 · 4 行没等到未平仓量");
    expect(coverageText({ lower: 7625, upper: 7800, strikes: 31, grid_strikes: 36, thinned: true }, 2)).toBe("7625–7800 共 31 档(链上 36 档,远处只取整数档) · 2 行没等到未平仓量");
  });
});
