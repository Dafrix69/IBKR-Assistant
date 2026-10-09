/** 期权链订哪些行权价(ibContracts.chainStrikes)与它占多少条行情线路(BrokerRouter.optionChain)。
 *
 * 行情线路是有配额的(每个用户约 100 条),持仓盯盘要占它自己的:这条链要看得更宽,只能在原来的档数里抽着取。
 * 这里钉两件事:不给 span 时和原来一模一样;给了 span,同时订着的线路一条也不比原来的上限多。全部离线。
 */
import { describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract, IbSession, TickerData } from "../src/broker.js";
import { chainStrikes, pickTradingClass, strikeRoundness } from "../src/ibContracts.js";
import { loadGolden, makeSettings } from "./util.js";

/** SPX 日到期那样的网格:5 点一档 */
const GRID = Array.from({ length: 401 }, (_, i) => 6000 + i * 5);

/** 改之前写在 optionChain 里的那几行,原样抄在这里当对照 */
function plainWindow(grid: number[], spot: number, width: number): number[] {
  let nearest = 0;
  for (let i = 1; i < grid.length; i++) {
    if (Math.abs((grid[i] ?? 0) - spot) < Math.abs((grid[nearest] ?? 0) - spot)) nearest = i;
  }
  return grid.slice(Math.max(0, nearest - width), nearest + width + 1);
}

describe("一个行权价有多整", () => {
  it.each([
    [6705, 5], [6710, 10], [6725, 25], [6650, 50], [6800, 100], [6750, 250], [6500, 500], [7000, 1000],
    [97.5, 2.5], [98, 1], [100, 100], [452.5, 2.5], [0.5, 0.5],
  ])("%d → %d", (strike, step) => {
    expect(strikeRoundness(strike)).toBe(step);
  });
});

describe("订哪些档", () => {
  it("不给 span:离现价最近的那一档上下各 width 档,和原来一样(网格两头照样截断)", () => {
    for (const [spot, width] of [[6712, 10], [6712.5, 15], [6002, 15], [7999, 3], [5000, 10], [9000, 10]] as const) {
      expect(chainStrikes(GRID, spot, width)).toEqual(plainWindow(GRID, spot, width));
      expect(chainStrikes(GRID, spot, width, null)).toEqual(plainWindow(GRID, spot, width));
      expect(chainStrikes(GRID, spot, width, 0)).toEqual(plainWindow(GRID, spot, width));
    }
  });

  it("span 落在原来的窗口里:原样用原来的窗口,不因为给了 span 反而变窄", () => {
    expect(chainStrikes(GRID, 6712, 15, 40)).toEqual(plainWindow(GRID, 6712, 15));
    expect(chainStrikes(GRID, 6712, 15, 73)).toEqual(plainWindow(GRID, 6712, 15)); // 6640 – 6785 全在 ±75 那 31 档里
  });

  it("span 比原来的窗口宽:档数不变,近处每档都留,远处只留整的", () => {
    const got = chainStrikes(GRID, 6712, 15, 90);
    expect(got).toHaveLength(31);
    expect(Math.min(...got)).toBe(6625);
    expect(Math.max(...got)).toBe(6800);
    // ±90 里一共 36 档,丢掉的是离得远又不整的那 5 档(只是 5 的倍数)
    const dropped = GRID.filter((k) => Math.abs(k - 6712) <= 90 && !got.includes(k));
    expect(dropped).toEqual([6635, 6645, 6655, 6785, 6795]);
    // 现价附近没有缺档
    const core = GRID.filter((k) => Math.abs(k - 6712) <= 45);
    expect(core.every((k) => got.includes(k))).toBe(true);
  });

  it("越宽抽得越稀,但 25 / 50 / 100 的整数档一直留着:墙就堆在这些档上", () => {
    const got = chainStrikes(GRID, 6712, 15, 150);
    expect(got).toHaveLength(31);
    const inSpan = (step: number): number[] => GRID.filter((k) => Math.abs(k - 6712) <= 150 && k % step === 0);
    expect(inSpan(25).every((k) => got.includes(k))).toBe(true);
    // 只是 5 的倍数的档,留下来的都贴着现价
    const fives = got.filter((k) => strikeRoundness(k) === 5);
    expect(fives.length).toBeGreaterThan(0);
    expect(Math.max(...fives.map((k) => Math.abs(k - 6712)))).toBeLessThan(40);
    // 每一档留不留只看「距离 ÷ 有多整」:留下的最大值不超过丢掉的最小值
    const reach = (k: number): number => Math.abs(k - 6712) / strikeRoundness(k);
    const dropped = GRID.filter((k) => Math.abs(k - 6712) <= 150 && !got.includes(k));
    expect(Math.max(...got.map(reach))).toBeLessThanOrEqual(Math.min(...dropped.map(reach)));
  });

  it("±span 里的档本来就不超过上限:全取(网格稀的那一侧原来的窗口伸得再远也不要)", () => {
    // 下方 5 点一档,上方 25 点一档
    const grid = [...Array.from({ length: 41 }, (_, i) => 6500 + i * 5), 6725, 6750, 6775, 6800, 6825, 6850, 6875, 6900];
    const got = chainStrikes(grid, 6698, 15, 100);
    expect(got).toEqual(grid.filter((k) => Math.abs(k - 6698) <= 100));
    expect(got.length).toBeLessThanOrEqual(31);
  });

  it("不管 span 多大、现价在哪,档数都不超过 2 × width + 1,也都在 ±span 之内或原来的窗口里", () => {
    for (const width of [3, 10, 15]) {
      for (const spot of [6001, 6337.4, 6712, 7250, 7998]) {
        for (const span of [1, 20, 60, 90, 133, 250, 600, 5000]) {
          const got = chainStrikes(GRID, spot, width, span);
          const plain = plainWindow(GRID, spot, width);
          expect(got.length).toBeLessThanOrEqual(2 * width + 1);
          expect(got).toEqual([...got].sort((a, b) => a - b));
          expect(new Set(got).size).toBe(got.length);
          expect(got.every((k) => Math.abs(k - spot) <= span || plain.includes(k))).toBe(true);
          // 离现价最近的那一档永远在
          expect(got).toContain(plain.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a)));
        }
      }
    }
  });

  it("网格乱序、带重复也一样;空网格给空", () => {
    const shuffled = [...GRID.slice(100, 200)].reverse().concat(GRID.slice(120, 130));
    expect(chainStrikes(shuffled, 6712, 5)).toEqual(plainWindow(GRID.slice(100, 200), 6712, 5));
    expect(chainStrikes([], 6712, 5, 90)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 行情线路
class LineCounter {
  open = new Set<string>();
  peak = 0;
  subscribed: string[] = [];
  /** 每条订阅用的交易类 */
  classes = new Set<string>();
  generic = new Set<string>();
  /** "行权价+方向" → 这一条读到的数(没登记的给默认:都到齐了) */
  ticks: Record<string, Record<string, unknown>> = {};
  private key(c: IbContract): string { return `${c.strike}${c.right}`; }
  reqMarketDataType(): void { /* 不关心 */ }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    for (const c of contracts) c.conId = 1_000_000 + Number(c.strike) * 2 + (c.right === "C" ? 1 : 0);
  }
  subscribeTicker(c: IbContract, generic = ""): { read(): TickerData } {
    this.open.add(this.key(c));
    this.peak = Math.max(this.peak, this.open.size);
    this.subscribed.push(this.key(c));
    this.classes.add(String(c.tradingClass ?? ""));
    this.generic.add(generic);
    const data = { callOpenInterest: 100, putOpenInterest: 80, callVolume: 10, putVolume: 8, modelGreeks: { gamma: 0.001, impliedVol: 0.15 } };
    return { read: () => ({ ...data, ...this.ticks[this.key(c)] }) as unknown as TickerData };
  }
  cancelTicker(c: IbContract): void { this.open.delete(this.key(c)); }
  async settle(): Promise<void> { /* 假时钟:不等 */ }
}

function routerWith(spot: number, byClass?: Record<string, { expiries: string[]; strikes: number[] }>): { router: BrokerRouter; lines: LineCounter } {
  const router = new BrokerRouter(makeSettings(loadGolden("config").base_config), async () => { throw new Error("测试里不连券商"); });
  const lines = new LineCounter();
  const patch = router as unknown as {
    marketSession(): IbSession; indexPrice(symbol: string): Promise<number | null>; optionExpiries(symbol: string): Promise<Record<string, unknown>>;
  };
  patch.marketSession = () => lines as unknown as IbSession;
  patch.indexPrice = async () => spot;
  const classes = byClass ?? { SPXW: { expiries: ["20261009"], strikes: GRID } };
  patch.optionExpiries = async () => ({
    symbol: "SPX", expiries: [...new Set(Object.values(classes).flatMap((c) => c.expiries))].sort(), strikes: GRID, exchange: "CBOE",
    trading_classes: Object.keys(classes).sort(), by_class: classes,
  });
  return { router, lines };
}

describe("期权链占的行情线路", () => {
  const CAP = (2 * BrokerRouter.CHAIN_MAX_WIDTH + 1) * 2;

  it("上限没有变:15 档 × 两侧 + 平值 = 31 档,看涨看跌各一条,62 条", () => {
    expect(BrokerRouter.CHAIN_MAX_WIDTH).toBe(15);
    expect(CAP).toBe(62);
  });

  it("不给 span:订的还是原来那些档;读完全部撤掉", async () => {
    const { router, lines } = routerWith(6712);
    const chain = await router.optionChain("SPX", "20261009", 15);
    const strikes = plainWindow(GRID, 6712, 15);
    expect([...new Set(lines.subscribed.map((k) => Number(k.slice(0, -1))))]).toEqual(strikes);
    expect(lines.peak).toBe(CAP);
    expect(lines.open.size).toBe(0);
    expect([...lines.generic]).toEqual(["100,101,106"]); // 带着自己的 generic ticks:不和盯盘的流共用
    expect(chain).toMatchObject({ strike_count: 31, grid_count: 31, trading_class: "SPXW", expiry: "20261009", spot: 6712 });
    expect(chain["rows"]).toHaveLength(62);
  });

  it("给了 span(哪怕大到几百点):同时订着的线路不超过那 62 条,窗口伸到 ±span 里最整的那几档", async () => {
    for (const [span, edge] of [[90, 25], [150, 25], [400, 100]] as const) {
      const { router, lines } = routerWith(6712);
      const chain = await router.optionChain("SPX", "20261009", 15, span);
      expect(lines.peak).toBeLessThanOrEqual(CAP);
      expect(lines.subscribed).toHaveLength(new Set(lines.subscribed).size); // 一条合约只订一次
      expect(lines.open.size).toBe(0);
      const strikes = (chain["rows"] as Array<{ strike: number }>).map((r) => r.strike);
      expect(Math.min(...strikes)).toBeLessThanOrEqual(6712 - span + edge);
      expect(Math.max(...strikes)).toBeGreaterThanOrEqual(6712 + span - edge);
      expect(strikes.every((k) => Math.abs(k - 6712) <= span)).toBe(true);
      // 这一段里链上有多少档也带回来:比取到的多 = 抽着取的
      expect(chain["strike_count"]).toBe(31);
      expect(chain["grid_count"]).toBeGreaterThan(31);
    }
  });

  it("width 写得再大也压回上限;给了 span 也一样", async () => {
    const { router, lines } = routerWith(6712);
    await router.optionChain("SPX", "20261009", 60, 300);
    expect(lines.peak).toBeLessThanOrEqual(CAP);
    const plain = routerWith(6712);
    await plain.router.optionChain("SPX", "20261009", 60);
    expect(plain.lines.peak).toBe(CAP);
  });

  it("width 小的调用方给了 span:线路按它自己的 width 算,不借着 span 涨到上限", async () => {
    const { router, lines } = routerWith(6712);
    await router.optionChain("SPX", "20261009", 10, 200);
    expect(lines.peak).toBeLessThanOrEqual((2 * 10 + 1) * 2);
  });
});

describe("没等到未平仓量那一笔", () => {
  it("是 null,不是 0 张;到了而且就是 0 的还是 0", async () => {
    const { router, lines } = routerWith(6712);
    lines.ticks = {
      "6710C": { callOpenInterest: null }, // 等待的几秒里没推
      "6710P": { putOpenInterest: undefined },
      "6715C": { callOpenInterest: 0 }, // 推了,就是 0 张
    };
    const chain = await router.optionChain("SPX", "20261009", 3);
    const oiOf = (strike: number, right: string): unknown =>
      (chain["rows"] as Array<Record<string, unknown>>).find((r) => r["strike"] === strike && r["right"] === right)?.["oi"];
    expect(oiOf(6710, "C")).toBeNull();
    expect(oiOf(6710, "P")).toBeNull();
    expect(oiOf(6715, "C")).toBe(0);
    expect(oiOf(6715, "P")).toBe(80);
  });
});

describe("挑哪条链:调用方点名要哪一类", () => {
  /** 月度合约记的那个日期(第三个周五的前一个交易日):月度类与日到期类都列着它 */
  const THURSDAY = "20261015";
  const classes = {
    SPX: { expiries: [THURSDAY, "20261119"], strikes: GRID.filter((k) => k % 25 === 0) },
    SPXW: { expiries: ["20261014", THURSDAY, "20261016"], strikes: GRID },
  };
  const cfg = { daily_trading_class: "SPXW", monthly_trading_class: "SPX" };

  it("不点名:同名的月度类优先(用户按到期日要的是它,换成日到期类等于换了结算方式)", () => {
    expect(pickTradingClass("SPX", cfg, classes, THURSDAY)).toBe("SPX");
    expect(pickTradingClass("SPX", cfg, classes, THURSDAY, "")).toBe("SPX");
    expect(pickTradingClass("SPX", cfg, classes, "20261016")).toBe("SPXW");
  });

  it("点名日到期类:两条链都列着这个日期时挑它;它不列这个到期日就当没点", () => {
    expect(pickTradingClass("SPX", cfg, classes, THURSDAY, "SPXW")).toBe("SPXW");
    expect(pickTradingClass("SPX", cfg, classes, "20261119", "SPXW")).toBe("SPX");
    expect(pickTradingClass("SPX", cfg, classes, THURSDAY, "NOPE")).toBe("SPX");
  });

  it("期权链照这个点名去订:不点名订的是月度那条(25 点一档),点名订的是日到期那条(5 点一档)", async () => {
    const plain = routerWith(6712, classes);
    const monthly = await plain.router.optionChain("SPX", THURSDAY, 3);
    expect(monthly["trading_class"]).toBe("SPX");
    expect([...plain.lines.classes]).toEqual(["SPX"]);
    expect((monthly["rows"] as Array<{ strike: number }>).every((r) => r.strike % 25 === 0)).toBe(true);

    const named = routerWith(6712, classes);
    const daily = await named.router.optionChain("SPX", THURSDAY, 3, null, "SPXW");
    expect(daily["trading_class"]).toBe("SPXW");
    expect([...named.lines.classes]).toEqual(["SPXW"]);
    expect([...new Set((daily["rows"] as Array<{ strike: number }>).map((r) => r.strike))]).toEqual([6695, 6700, 6705, 6710, 6715, 6720, 6725]);
  });
});
