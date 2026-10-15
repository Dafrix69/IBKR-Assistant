/** 持仓追踪里的关键价位怎么说(desktop/renderer-react/src/lib/trackLevels.ts,纯函数)。
 *
 * 钉五件事:
 *  1. 自己设的线按**标的的价**摆:正股是止损(这一轮生效的那条)/ 回撤线 / 止盈或目标价;期权与组合只有标的止损与目标价;
 *  2. 现价上下最近的价位,不含自己的线;
 *  3. 一条线和旁边价位的关系:贴着、价位先被碰到、线先被碰到(这是最该让人看见的一种);
 *  4. 表单里点价位:正股只给方向对的那一侧,期权与组合两侧都给;
 *  5. 价位弹窗末尾那一句:在追踪里才有,说止损离现价多远;已触发、暂停的不算。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
interface Level { price: number; label: string; source: string; kind: string }
type Rec = Record<string, any>;
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "trackLevels.ts")).href)) as unknown as {
  OWN_PREFIX: string;
  NEAR_PCT: number;
  isOwnLine(l: Level): boolean;
  ownLines(secType: string, targets: Rec, live?: Rec | null): Level[];
  nearestLevels(levels: Level[], spot: number, n?: number): { below: Array<{ level: Level; pct: number }>; above: Array<{ level: Level; pct: number }> };
  levelSummary(levels: Level[], spot: number, short: Record<string, string>): string;
  lineContext(line: Level, levels: Level[], spot: number, short: Record<string, string>): string | null;
  pickSides(levels: Level[], spot: number, mode: "stop" | "target", long: boolean, derivative: boolean): { below: Level[]; above: Level[] };
  trackContext(symbol: string, tracks: Rec[], rows: Record<string, Rec | undefined>): string | null;
};

const SHORT = { put_wall: "P 墙", call_wall: "C 墙", call_vol_wall: "C 成交墙", put_vol_wall: "P 成交墙", ma20: "MA20", max_pain: "痛点", round: "关口" };
const L = (price: number, source: string, kind = "pivot"): Level => ({ price, label: source, source, kind });
/** SPX 那一天:现价 7722.35 */
const SPX: Level[] = [
  L(7680, "put_vol_wall", "support"), L(7690.4, "ma20", "support"), L(7700, "put_wall", "support"),
  L(7725, "max_pain"), L(7750, "call_wall", "resistance"), L(7775, "call_vol_wall", "resistance"),
];

describe("自己设的线", () => {
  it("正股:止损取这一轮生效的那条(跟踪止损在上面就是它),再加回撤线与止盈", () => {
    const lines = mod.ownLines("STK", { stop_loss: 200, take_profit: 240 }, { stop_effective: 213.75, profit_trail_stop: 216 });
    expect(lines.map((l) => [l.label, l.price])).toEqual([["止损", 213.75], ["回撤线", 216], ["止盈", 240]]);
    expect(lines.every((l) => mod.isOwnLine(l))).toBe(true);
    // 没有盯盘结果:退回填的止损价;设了目标价(正股的目标价就是止盈价)用它
    expect(mod.ownLines("STK", { stop_loss: 200, spot_target: 250, take_profit: null }).map((l) => [l.label, l.price]))
      .toEqual([["止损", 200], ["止盈", 250]]);
  });

  it("期权与组合:持仓自己的止盈止损是期权价,不上这根轴;标的止损与目标价上", () => {
    const lines = mod.ownLines("BAG", { stop_loss: 2.1, take_profit: 8, spot_stop_below: 7700, spot_stop_above: 7790, spot_target: 7750 });
    expect(lines.map((l) => [l.label, l.price])).toEqual([["标的止损", 7700], ["标的止损", 7790], ["目标价", 7750]]);
    expect(mod.ownLines("OPT", {})).toEqual([]);
  });
});

describe("现价上下最近的价位", () => {
  it("各取最近两个,不含自己的线;一句话写距现价的百分比", () => {
    const own = mod.ownLines("BAG", { spot_stop_below: 7710 });
    const near = mod.nearestLevels([...SPX, ...own], 7722.35);
    expect(near.below.map((g) => g.level.price)).toEqual([7700, 7690.4]);
    expect(near.above.map((g) => g.level.price)).toEqual([7725, 7750]);
    expect(mod.levelSummary(SPX, 7722.35, SHORT)).toBe("下方 P 墙 7700(−0.29%)、MA20 7690.4(−0.41%) · 上方 痛点 7725(+0.03%)、C 墙 7750(+0.36%)");
    expect(mod.levelSummary([], 7722.35, SHORT)).toBe("");
  });
});

describe("一条线和旁边价位的关系", () => {
  const spot = 7722.35;
  const line = (price: number, label = "标的止损"): Level => ({ price, label, source: `${mod.OWN_PREFIX}x`, kind: "pivot" });

  it("贴着(差不到现价的 0.15%,SPX 上约 11.6 点)", () => {
    expect(mod.lineContext(line(7700), SPX, spot, SHORT)).toBe("标的止损 7700 贴着 P 墙 7700");
    expect(mod.lineContext(line(7740), SPX, spot, SHORT)).toBe("标的止损 7740 贴着 C 墙 7750");
    expect(mod.NEAR_PCT).toBe(0.15);
  });

  it("价位夹在线和现价之间:价位先被碰到", () => {
    expect(mod.lineContext(line(7660), SPX, spot, SHORT)).toBe("标的止损 7660 在 P 成交墙 7680 之下 0.26%");
    expect(mod.lineContext(line(7790), SPX, spot, SHORT)).toBe("标的止损 7790 在 C 成交墙 7775 之上 0.19%");
  });

  it("线夹在价位和现价之间:支撑没破就先出了(空头那一侧是阻力)", () => {
    expect(mod.lineContext(line(7712), SPX, spot, SHORT)).toBe("标的止损 7712 在 P 墙 7700 之上 0.16%:支撑没破就先出了");
    expect(mod.lineContext(line(7735), [L(7760, "call_wall", "resistance")], spot, SHORT)).toBe("标的止损 7735 在 C 墙 7760 之下 0.32%:阻力没破就先出了");
  });

  it("那一侧没有价位、线压在现价上:不说", () => {
    expect(mod.lineContext(line(7600), [L(7750, "call_wall", "resistance")], spot, SHORT)).toBeNull();
    expect(mod.lineContext(line(spot), SPX, spot, SHORT)).toBeNull();
  });
});

describe("表单里点价位", () => {
  const spot = 7722.35;
  it("正股多头:止损只给下方,止盈只给上方;空头反过来", () => {
    expect(mod.pickSides(SPX, spot, "stop", true, false)).toMatchObject({ above: [] });
    expect(mod.pickSides(SPX, spot, "stop", true, false).below.map((l) => l.price)).toEqual([7700, 7690.4, 7680]);
    expect(mod.pickSides(SPX, spot, "target", true, false).below).toEqual([]);
    expect(mod.pickSides(SPX, spot, "stop", false, false).below).toEqual([]);
    expect(mod.pickSides(SPX, spot, "stop", false, false).above.map((l) => l.price)).toEqual([7725, 7750, 7775]);
  });

  it("期权与组合:两侧都给(标的止损有跌到 / 涨到两条)", () => {
    const both = mod.pickSides(SPX, spot, "stop", true, true);
    expect(both.below.length).toBe(3);
    expect(both.above.length).toBe(3);
  });
});

describe("价位弹窗末尾那一句", () => {
  const track = (over: Rec): Rec => ({ id: "t", symbol: "SPX", sec_type: "BAG", enabled: true, fired_at: null, targets: {}, ...over });

  it("组合:标的止损线离标的现价多少点", () => {
    const tracks = [track({ targets: { spot_stop_below: 7700, spot_stop_above: 7790 } })];
    const rows = { t: { spot_stop: { below: 7700, above: 7790, spot: 7698.6 } } };
    expect(mod.trackContext("SPX", tracks, rows)).toBe("持仓追踪:标的止损 跌到 7700(已越过 1.40 点) / 涨到 7790(还差 91.40 点)");
  });

  it("正股:止损离现价多少 %;没设止损也说在追踪", () => {
    const tracks = [track({ id: "n", symbol: "NVDA", sec_type: "STK", targets: { stop_loss: 200 } })];
    expect(mod.trackContext("NVDA", tracks, { n: { price: 219.74, stop_effective: 213.75 } }))
      .toBe("持仓追踪:止损 213.75(距现价 −2.73%)");
    expect(mod.trackContext("NVDA", [track({ symbol: "NVDA", sec_type: "STK" })], {})).toBe("持仓追踪:正股在追踪,没设止损价");
  });

  it("不在追踪里、已触发、暂停:null", () => {
    expect(mod.trackContext("SPX", [], {})).toBeNull();
    expect(mod.trackContext("SPX", [track({ fired_at: "2026-10-15T14:00:00Z" })], {})).toBeNull();
    expect(mod.trackContext("SPX", [track({ enabled: false })], {})).toBeNull();
    expect(mod.trackContext("QQQ", [track({})], {})).toBeNull();
  });
});
