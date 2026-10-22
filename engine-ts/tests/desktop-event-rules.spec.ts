/** 重要事件的界面规则(desktop/renderer-react/src/lib/eventRules.ts):挂顶、倒计时、提前提醒、板块联动、对冲指令。
 *
 * 钉住:
 *  1. 挂顶:没过期的、今天的或 18 小时内要来的;中等影响的只在一小时内才上;最多三条,其余报个数。
 *  2. 阶段与倒计时:公布前一小时"快到了",公布后一刻钟"正在公布",之后到过期"刚公布",过期就不挂。
 *  3. 提前提醒:每档只在到点后 90 秒的窗口里报一次;错过的不补;中等影响的只报公布那一刻。
 *  4. 板块联动:有行情的只数够、同向超线的比例够才算;单只急跌不算;同一个板块只报多数方向。
 *  5. 对冲指令:两种结构的行权价与写法;SPX 当日一张 bear call 走本地速记的写法;缺现价、坏到期日当场说。
 *  6. 盘前拉涨:09:30 之前的集体上涨换成"开盘后大概率回吐"的说法;10:00 那一眼按中位掉没掉一半判回吐 / 守住。
 *  7. 时段提醒:欧盘按伦敦钟点算(欧美夏令时不同步的那一周照样对),美股的钟点美股不开不报,周末不报,每天只报一次。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
interface Ev {
  id: string; kind: string; title: string; at: number; date_et: string; time_et: string; impact: "high" | "medium";
  source: "builtin" | "feed" | "custom"; linger_min: number; items?: Array<{ title: string; forecast: string; previous: string }>; note?: string;
}
interface Move { sector: string; direction: "up" | "down"; count: number; total: number; median: number; movers: Array<{ symbol: string; pct: number }> }
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "eventRules.ts")).href)) as unknown as {
  PIN_MAX: number;
  phaseOf(e: Ev, now: number): string;
  pinnedEvents(events: Ev[], now: number): { events: Ev[]; more: number };
  countdownText(e: Ev, now: number): string;
  whenText(at: number, now: number, tz?: string): string;
  leadsDue(events: Ev[], now: number, leads: number[], fired: ReadonlySet<string>): Array<{ key: string; lead: number; event: Ev }>;
  leadTitle(e: Ev, lead: number): string;
  leadBody(e: Ev, lead: number, now: number, tz?: string): string;
  sectorMoves(sectors: Array<{ name: string; symbols: string[] }>, changes: Record<string, number | null | undefined>, rule: { min_stocks: number; share: number; move_pct: number }): Move[];
  sectorMoveBody(m: Move, movePct: number): string;
  SECTOR_FRESH_MS: number;
  freshChanges(stocks: Array<{ symbol: string; change_pct: number | null | undefined; at: string | null | undefined }>, now: number, maxAgeMs?: number): Record<string, number | null>;
  hedgeInstruction(spec: { symbol: string; spot: number | null; kind: "put_spread" | "bear_call" | "short_stock"; width: number; qty: number; expiry: string; todayEt: string; reason: string; price?: number | null; outside?: boolean }): { text: string; legs: string; problem: string | null };
  hedgeExpiryFor(e: { date_et: string }, todayEt: string): string;
  strikeStep(symbol: string, spot: number): number;
  isPremarket(at: number): boolean;
  sectorMoveTitle(m: Move, premarket?: boolean): string;
  sectorMoveBody(m: Move, movePct: number, premarket?: boolean): string;
  sectorMedian(symbols: string[], changes: Record<string, number | null | undefined>, minStocks?: number): number | null;
  fadeVerdict(pre: number, now: number): "faded" | "held";
  fadeBody(pre: number, now: number, verdict: "faded" | "held"): string;
  SESSION_MARKS: Array<{ id: string; tz: string; time: string; us: boolean }>;
  londonNyGap(at: number): number;
  sessionMarksDue(now: number, fired: ReadonlySet<string>, usOpen: boolean): Array<{ key: string; mark: { id: string } }>;
  sessionMarkBody(mark: { id: string; tz: string; time: string; title: string; body: string; us: boolean }, now: number): string;
};

const CPI_AT = Date.parse("2026-10-14T08:30:00-04:00");
function ev(over: Partial<Ev> = {}): Ev {
  return {
    id: "builtin:cpi:2026-10-14", kind: "cpi", title: "CPI(9月)", at: CPI_AT, date_et: "2026-10-14", time_et: "08:30",
    impact: "high", source: "feed", linger_min: 90,
    items: [{ title: "CPI m/m", forecast: "0.6%", previous: "0.4%" }, { title: "CPI y/y", forecast: "3.6%", previous: "3.4%" }],
    ...over,
  };
}
const MIN = 60_000;

describe("阶段与倒计时", () => {
  it("公布前一小时起算快到了,公布后一刻钟内正在公布,90 分钟后过期", () => {
    const e = ev();
    expect(mod.phaseOf(e, CPI_AT - 61 * MIN)).toBe("upcoming");
    expect(mod.phaseOf(e, CPI_AT - 60 * MIN)).toBe("soon");
    expect(mod.phaseOf(e, CPI_AT)).toBe("live");
    expect(mod.phaseOf(e, CPI_AT + 14 * MIN)).toBe("live");
    expect(mod.phaseOf(e, CPI_AT + 15 * MIN)).toBe("after");
    expect(mod.phaseOf(e, CPI_AT + 90 * MIN)).toBe("expired");
  });

  it("倒计时的一句话", () => {
    const e = ev();
    expect(mod.countdownText(e, CPI_AT - 133 * MIN)).toBe("还有 2 小时 13 分");
    expect(mod.countdownText(e, CPI_AT - 120 * MIN)).toBe("还有 2 小时");
    expect(mod.countdownText(e, CPI_AT - 8 * MIN)).toBe("还有 8 分钟");
    expect(mod.countdownText(e, CPI_AT - 30 * 60 * MIN)).toBe("还有 1 天 6 小时");
    expect(mod.countdownText(e, CPI_AT + 3 * MIN)).toBe("正在公布");
    expect(mod.countdownText(e, CPI_AT + 25 * MIN)).toBe("已公布 25 分钟");
    expect(mod.countdownText(e, CPI_AT + 200 * MIN)).toBe("已过去");
  });

  it("本机钟点:北京时间看美东 08:30 是今晚 20:30;隔天说明天;一周内说周几;更远给日期", () => {
    const bj = "Asia/Shanghai";
    const morning = Date.parse("2026-10-14T09:00:00+08:00");
    expect(mod.whenText(CPI_AT, morning, bj)).toBe("今天 20:30");
    expect(mod.whenText(CPI_AT, Date.parse("2026-10-13T22:00:00+08:00"), bj)).toBe("明天 20:30");
    expect(mod.whenText(CPI_AT, Date.parse("2026-10-11T22:00:00+08:00"), bj)).toBe("周三 20:30");
    expect(mod.whenText(CPI_AT, Date.parse("2026-10-01T22:00:00+08:00"), bj)).toBe("10-14 20:30");
    expect(mod.whenText(CPI_AT, Date.parse("2026-10-15T09:00:00+08:00"), bj)).toBe("昨天 20:30");
  });
});

describe("挂在顶上", () => {
  it("今天的高影响整天挂;明早的也提前挂(18 小时内);过期的不挂;中等的只在一小时内上", () => {
    const now = Date.parse("2026-10-13T20:00:00-04:00"); // 美东 13 日晚 = 北京 14 日早上
    const cpi = ev();
    const ppi = ev({ id: "builtin:ppi:2026-10-15", title: "PPI(9月)", at: Date.parse("2026-10-15T08:30:00-04:00"), date_et: "2026-10-15" });
    const claims = ev({ id: "feed:claims", title: "初请失业金", impact: "medium", at: CPI_AT, date_et: "2026-10-14" });
    const old = ev({ id: "old", title: "昨天的", at: now - 100 * MIN, date_et: "2026-10-13" });
    const { events, more } = mod.pinnedEvents([ppi, old, claims, cpi], now);
    expect(events.map((e) => e.title)).toEqual(["CPI(9月)"]);
    expect(more).toBe(0);
    expect(mod.pinnedEvents([claims], CPI_AT - 30 * MIN).events.map((e) => e.title)).toEqual(["初请失业金"]);
  });

  it("跨市场跟跌(P0)只要没过期就挂:周五盘中就挂着周一开盘的那条", () => {
    const now = Date.parse("2026-10-16T11:00:00-04:00");
    const cross = ev({ id: "cross:2026-10-16:down", kind: "cross", title: "美股 −2.5%,韩股 ETF 没跟跌:开盘可能补跌", at: Date.parse("2026-10-19T09:00:00+09:00"), date_et: "2026-10-18", time_et: "20:00", linger_min: 150 });
    expect(mod.pinnedEvents([cross], now).events.map((e) => e.id)).toEqual(["cross:2026-10-16:down"]);
    expect(mod.pinnedEvents([cross], Date.parse("2026-10-18T23:00:00-04:00")).events).toEqual([]);
  });

  it("最多三条,其余报个数,按时间排", () => {
    const now = Date.parse("2026-10-14T06:00:00-04:00");
    const list = [4, 3, 2, 1].map((h) => ev({ id: `e${h}`, title: `e${h}`, at: now + h * 60 * MIN }));
    const { events, more } = mod.pinnedEvents(list, now);
    expect(events.map((e) => e.title)).toEqual(["e1", "e2", "e3"]);
    expect(more).toBe(1);
    expect(mod.PIN_MAX).toBe(3);
  });
});

describe("提前提醒", () => {
  it("每档只在到点后 90 秒内报一次;报过的不再报;错过的不补", () => {
    const e = ev();
    const fired = new Set<string>();
    expect(mod.leadsDue([e], CPI_AT - 61 * MIN, [60, 15], fired)).toEqual([]);
    const at60 = mod.leadsDue([e], CPI_AT - 60 * MIN + 20_000, [60, 15], fired);
    expect(at60.map((d) => `${d.key}:${d.lead}`)).toEqual(["builtin:cpi:2026-10-14:60:60"]);
    fired.add(at60[0]!.key);
    expect(mod.leadsDue([e], CPI_AT - 60 * MIN + 40_000, [60, 15], fired)).toEqual([]);
    // 60 分钟那一档错过了窗口(电脑睡了):不补
    expect(mod.leadsDue([e], CPI_AT - 50 * MIN, [60, 15], new Set())).toEqual([]);
    expect(mod.leadsDue([e], CPI_AT + 10_000, [60, 15], fired).map((d) => d.lead)).toEqual([0]);
  });

  it("中等影响的只报公布那一刻", () => {
    const e = ev({ impact: "medium" });
    expect(mod.leadsDue([e], CPI_AT - 60 * MIN + 10_000, [60], new Set())).toEqual([]);
    expect(mod.leadsDue([e], CPI_AT + 10_000, [60], new Set()).map((d) => d.lead)).toEqual([0]);
  });

  it("提醒的话:标题带分钟数,正文带本机时间、美东钟点、预期与前值", () => {
    const e = ev();
    const now = CPI_AT - 60 * MIN;
    expect(mod.leadTitle(e, 60)).toBe("60 分钟后公布 CPI(9月)");
    expect(mod.leadTitle(e, 0)).toBe("正在公布 CPI(9月)");
    const body = mod.leadBody(e, 60, now, "Asia/Shanghai");
    expect(body).toContain("今天 20:30(美东 08:30)");
    expect(body).toContain("CPI m/m:预期 0.6%,前值 0.4%");
    expect(body).toContain("跳空");
  });
});

describe("板块联动", () => {
  const sectors = [
    { name: "数据中心", symbols: ["CRWV", "IREN", "NBIS", "APLD", "WULF", "CIFR"] },
    { name: "芯片", symbols: ["NVDA", "AMD", "AVGO"] },
    { name: "小板块", symbols: ["A", "B"] },
  ];
  const rule = { min_stocks: 3, share: 0.6, move_pct: 3 };

  it("六只里五只跌超 3%:报集体下跌,带只数、中位与走得最远的几只", () => {
    const changes = { CRWV: -12.1, IREN: -8.3, NBIS: -6.0, APLD: -4.4, WULF: -3.0, CIFR: 0.5, NVDA: -1.2, AMD: -0.8, AVGO: 0.3, A: -9, B: -9 };
    const moves = mod.sectorMoves(sectors, changes, rule);
    expect(moves).toHaveLength(1);
    const m = moves[0]!;
    expect(m).toMatchObject({ sector: "数据中心", direction: "down", count: 5, total: 6, median: -5.2 });
    expect(m.movers.map((x) => x.symbol)).toEqual(["CRWV", "IREN", "NBIS", "APLD", "WULF"]);
    expect(mod.sectorMoveBody(m, 3)).toContain("6 只里 5 只跌超 3%,中位 −5.2%:CRWV −12.1%、IREN −8.3%");
  });

  it("一只股暴跌、别的不动不算;没行情的不算分母;只数不够的板块不看", () => {
    expect(mod.sectorMoves(sectors, { CRWV: -15, IREN: -0.5, NBIS: 0.2, APLD: null, WULF: undefined, CIFR: 0.1 }, rule)).toEqual([]);
    // 有行情的只剩 3 只(CRWV、IREN、NBIS),2 只超线:要 max(3, ceil(3×0.6)=2) = 3 只,不够
    expect(mod.sectorMoves(sectors, { CRWV: -5, IREN: -4, NBIS: 0 }, rule)).toEqual([]);
    expect(mod.sectorMoves(sectors, { CRWV: -5, IREN: -4, NBIS: -3 }, rule)).toHaveLength(1);
  });

  it("只认 3 分钟之内算出来的涨跌幅:收盘后留着的旧数、没有时刻的、坏时刻的都当没有", () => {
    const now = Date.parse("2026-10-15T04:05:00-04:00"); // 第二天盘前:异动循环昨天 16:20 就停了
    const yesterday = "2026-10-14T20:19:55.000Z";
    const fresh = new Date(now - 60_000).toISOString();
    const out = mod.freshChanges([
      { symbol: "CRWV", change_pct: -12.1, at: yesterday },
      { symbol: "IREN", change_pct: -8.3, at: fresh },
      { symbol: "NBIS", change_pct: -6.0, at: null },
      { symbol: "APLD", change_pct: -4.4, at: "not a time" },
      { symbol: "WULF", change_pct: null, at: fresh },
    ], now);
    expect(out).toEqual({ CRWV: null, IREN: -8.3, NBIS: null, APLD: null, WULF: null });
    expect(mod.SECTOR_FRESH_MS).toBe(3 * 60_000);
    // 昨天的集体下跌第二天盘前不再报
    const sectors = [{ name: "数据中心", symbols: ["CRWV", "IREN", "NBIS", "APLD"] }];
    const stale = mod.freshChanges(["CRWV", "IREN", "NBIS", "APLD"].map((symbol) => ({ symbol, change_pct: -8, at: yesterday })), now);
    expect(mod.sectorMoves(sectors, stale, { min_stocks: 3, share: 0.6, move_pct: 3 })).toEqual([]);
  });

  it("两个方向都看,同一个板块只报多数的那个", () => {
    const moves = mod.sectorMoves(sectors, { NVDA: 4, AMD: 5, AVGO: 3.5 }, rule);
    expect(moves.map((m) => `${m.sector}:${m.direction}:${m.count}/${m.total}`)).toEqual(["芯片:up:3/3"]);
  });
});

describe("对冲指令", () => {
  const base = { symbol: "SPX", spot: 7718.4, width: 25, qty: 1, expiry: "2026-10-14", todayEt: "2026-10-14", reason: "CPI 前对冲" };

  it("买 put 价差:买现价下方最近一档、卖再低一个宽度;今天到期写「今天的」", () => {
    const out = mod.hedgeInstruction({ ...base, kind: "put_spread" });
    expect(out.problem).toBeNull();
    expect(out.text).toBe("开一张 SPX 今天的 7690 7715 put spread,理由:CPI 前对冲");
    expect(out.legs).toContain("买 7715 put、卖 7690 put");
  });

  it("卖 call 价差:SPX 当日一张走本地速记;别的写给大模型;到期日在后面时写明日期与张数", () => {
    expect(mod.hedgeInstruction({ ...base, kind: "bear_call" }).text).toBe("7720 7745 bear call");
    expect(mod.hedgeInstruction({ ...base, kind: "bear_call", spot: 7720 }).text).toBe("7725 7750 bear call");
    const llm = mod.hedgeInstruction({ ...base, kind: "bear_call", qty: 2, expiry: "2026-10-15" });
    expect(llm.text).toBe("卖出2 张 SPX 2026-10-15 到期的 7720 7745 call spread,理由:CPI 前对冲");
    const stock = mod.hedgeInstruction({ ...base, symbol: "iren", spot: 61.3, width: 5, kind: "put_spread", reason: "" });
    expect(stock.text).toBe("开一张 IREN 今天的 56 61 put spread");
  });

  it("档距:指数 5 点,正股按价位", () => {
    expect(mod.strikeStep("SPX", 7700)).toBe(5);
    expect(mod.strikeStep("NVDA", 180)).toBe(5);
    expect(mod.strikeStep("IREN", 61)).toBe(1);
    expect(mod.strikeStep("WULF", 12)).toBe(0.5);
  });

  it("缺现价、坏到期日、过期的到期日当场说", () => {
    expect(mod.hedgeInstruction({ ...base, kind: "put_spread", spot: null }).problem).toMatch(/现价/);
    expect(mod.hedgeInstruction({ ...base, kind: "put_spread", expiry: "10/14" }).problem).toMatch(/YYYY-MM-DD/);
    expect(mod.hedgeInstruction({ ...base, kind: "put_spread", expiry: "2026-10-13" }).problem).toMatch(/过了/);
    expect(mod.hedgeInstruction({ ...base, kind: "put_spread", qty: 0 }).problem).toMatch(/张数/);
  });

  it("默认到期日:事件那天,不早于今天", () => {
    expect(mod.hedgeExpiryFor({ date_et: "2026-10-14" }, "2026-10-13")).toBe("2026-10-14");
    expect(mod.hedgeExpiryFor({ date_et: "2026-10-14" }, "2026-10-14")).toBe("2026-10-14");
    expect(mod.hedgeExpiryFor({ date_et: "2026-10-13" }, "2026-10-14")).toBe("2026-10-14");
  });
});

describe("卖空正股 / ETF", () => {
  const base = { symbol: "koru", spot: null, width: 0, qty: 100, expiry: "2026-10-14", todayEt: "2026-10-14", reason: "美股大跌,亚洲开盘前跟跌" };

  it("限价卖出,常规时段之外加「盘外」;没写价当场说", () => {
    const out = mod.hedgeInstruction({ ...base, kind: "short_stock", price: 28.5, outside: true });
    expect(out.problem).toBeNull();
    expect(out.text).toBe("盘外 限价 28.5 卖出 100 股 KORU,理由:美股大跌,亚洲开盘前跟跌");
    expect(out.legs).toContain("亏损没有上限");
    expect(mod.hedgeInstruction({ ...base, kind: "short_stock", price: 28.5, outside: false, reason: "" }).text).toBe("限价 28.5 卖出 100 股 KORU");
    expect(mod.hedgeInstruction({ ...base, kind: "short_stock", price: null, outside: true }).problem).toMatch(/限价/);
    expect(mod.hedgeInstruction({ ...base, kind: "short_stock", price: 28.5, qty: 0 }).problem).toMatch(/股数/);
  });
});

describe("盘前拉涨", () => {
  const up: Move = { sector: "数据中心", direction: "up", count: 4, total: 5, median: 4.2, movers: [{ symbol: "CRWV", pct: 6.1 }, { symbol: "IREN", pct: 4.4 }] };

  it("09:30 之前算盘前,换成会回吐的说法;开盘后照旧", () => {
    const pre = Date.parse("2026-10-22T09:25:00-04:00");
    const open = Date.parse("2026-10-22T09:30:00-04:00");
    expect(mod.isPremarket(pre)).toBe(true);
    expect(mod.isPremarket(open)).toBe(false);
    expect(mod.sectorMoveTitle(up, true)).toBe("盘前联动:数据中心 集体上涨");
    expect(mod.sectorMoveBody(up, 3, true)).toContain("开盘后涨幅大概率回吐");
    expect(mod.sectorMoveBody(up, 3, false)).not.toContain("回吐");
    expect(mod.sectorMoveBody({ ...up, direction: "down", median: -4 }, 3, true)).not.toContain("回吐");
  });

  it("10:00 那一眼:中位掉了一半以上是回吐,否则守住;行情不够只数给 null", () => {
    expect(mod.fadeVerdict(4.2, 2.1)).toBe("faded");
    expect(mod.fadeVerdict(4.2, -0.5)).toBe("faded");
    expect(mod.fadeVerdict(4.2, 2.2)).toBe("held");
    expect(mod.fadeBody(4.2, 1, "faded")).toContain("开盘前中位 +4.2%,现在 +1.0%");
    expect(mod.sectorMedian(["A", "B", "C"], { A: 1, B: 3, C: null })).toBe(2);
    expect(mod.sectorMedian(["A", "B", "C"], { A: 1, B: 3, C: null }, 3)).toBeNull();
  });
});

describe("时段提醒", () => {
  const ids = (now: number, usOpen = true, fired = new Set<string>()): string[] => mod.sessionMarksDue(now, fired, usOpen).map((d) => d.mark.id);

  it("欧盘开盘按伦敦 08:00:平常是美东 03:00,欧洲先退夏令时的那一周是美东 04:00", () => {
    // 2026-10-22 周四:两边都在夏令时,伦敦 08:00 = 美东 03:00
    expect(ids(Date.parse("2026-10-22T03:00:10-04:00"))).toEqual(["eu_open"]);
    expect(mod.londonNyGap(Date.parse("2026-10-22T03:00:00-04:00"))).toBe(5);
    // 2026-10-27 周二:欧洲 10-25 已退,美国 11-01 才退——伦敦 08:00 = 美东 04:00
    expect(ids(Date.parse("2026-10-27T03:00:10-04:00"))).toEqual([]);
    const skewed = Date.parse("2026-10-27T04:00:10-04:00");
    expect(ids(skewed)).toEqual(["eu_open"]);
    expect(mod.londonNyGap(skewed)).toBe(4);
    const eu = mod.SESSION_MARKS.find((m) => m.id === "eu_open") as Parameters<typeof mod.sessionMarkBody>[0];
    expect(mod.sessionMarkBody(eu, skewed)).toContain("美东 04:00 · 北京 16:00");
    expect(mod.sessionMarkBody(eu, skewed)).toContain("夏令时没同步");
    expect(mod.sessionMarkBody(eu, Date.parse("2026-10-22T03:00:10-04:00"))).not.toContain("夏令时");
    // 11-03 两边都是冬令时:又回到美东 03:00(北京 16:00)
    expect(ids(Date.parse("2026-11-03T03:00:10-05:00"))).toEqual(["eu_open"]);
  });

  it("美股的钟点:开盘前 5 分钟、欧盘收盘、最后一小时;美股不开不报", () => {
    expect(ids(Date.parse("2026-10-22T09:25:30-04:00"))).toEqual(["us_pre_open"]);
    expect(ids(Date.parse("2026-10-22T11:30:00-04:00"))).toEqual(["eu_close"]);
    expect(ids(Date.parse("2026-10-22T15:00:00-04:00"))).toEqual(["us_last_hour"]);
    expect(ids(Date.parse("2026-10-22T15:00:00-04:00"), false)).toEqual([]);
    // 欧盘开盘不看美股开不开(美东凌晨引擎报的是休市)
    expect(ids(Date.parse("2026-10-22T03:00:10-04:00"), false)).toEqual(["eu_open"]);
  });

  it("窗口 90 秒,过了不补;报过的不再报;周末不报", () => {
    expect(ids(Date.parse("2026-10-22T09:26:31-04:00"))).toEqual([]);
    expect(ids(Date.parse("2026-10-22T09:24:59-04:00"))).toEqual([]);
    const now = Date.parse("2026-10-22T09:25:00-04:00");
    const [due] = mod.sessionMarksDue(now, new Set(), true);
    expect(due?.key).toBe("session:us_pre_open:2026-10-22");
    expect(ids(now + 15_000, true, new Set([due!.key]))).toEqual([]);
    expect(ids(Date.parse("2026-10-24T03:00:10-04:00"))).toEqual([]);
  });
});
