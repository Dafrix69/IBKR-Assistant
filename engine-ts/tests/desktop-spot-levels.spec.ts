/** SPX 走到 25 的整数倍时提醒(desktop/renderer-react/src/lib/spotLevels.ts):这一笔相对上一笔穿过了哪个关口。
 *
 * 钉四件事:
 *  1. 碰到就算、方向不反:7724 → 7725.0 报上穿,接着 7725.0 → 7724 不报下破。
 *  2. 在关口上来回蹭只报一次;离开半个步长再回来才再报。
 *  3. 不该比的两笔不比:第一笔、隔了太久的、换了来源的(官方指数 ↔ 期货推算)、不会动的价。
 *  4. 一笔跳过几个关口只报最后一个,并说越过了几个。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
interface Sample { price: number | null; source: string; at: number }
interface State { last: { price: number; source: string; at: number } | null; muted: number | null }
interface Hit { level: number; direction: "up" | "down"; price: number; source: string; at: number; skipped: number }
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "spotLevels.ts")).href)) as unknown as {
  LEVEL_STEP: number;
  GAP_MS: number;
  EMPTY_WATCH: State;
  nearLevels(price: number, step?: number): { below: number; above: number };
  stepLevelWatch(state: State, sample: Sample, step?: number): { state: State; hit: Hit | null };
  levelHitTitle(symbol: string, hit: Hit): string;
  levelHitBody(hit: Hit): string;
};

const T0 = Date.parse("2026-09-28T10:00:00-04:00");

/** 两秒一笔地喂一串价,回每一笔报了什么(没报是 null) */
function feed(prices: (number | null | [number | null, string])[], start: State = mod.EMPTY_WATCH): { hits: (string | null)[]; state: State } {
  let state = start;
  const hits = prices.map((p, i) => {
    const [price, source] = Array.isArray(p) ? p : [p, "quote"];
    const out = mod.stepLevelWatch(state, { price, source, at: T0 + i * 2000 });
    state = out.state;
    return out.hit ? `${out.hit.direction} ${out.hit.level}` : null;
  });
  return { hits, state };
}

describe("上下最近的两个关口", () => {
  it("步长是 25;正好踩在关口上时它算下面那个", () => {
    expect(mod.LEVEL_STEP).toBe(25);
    expect(mod.nearLevels(7718.42)).toEqual({ below: 7700, above: 7725 });
    expect(mod.nearLevels(7725)).toEqual({ below: 7725, above: 7750 });
    expect(mod.nearLevels(7749.99)).toEqual({ below: 7725, above: 7750 });
    expect(mod.nearLevels(41.2, 5)).toEqual({ below: 40, above: 45 });
  });
});

describe("穿过关口", () => {
  it("第一笔只登记:一打开不把现价旁边的关口报一遍", () => {
    expect(feed([7725]).hits).toEqual([null]);
    expect(feed([7726, 7727]).hits).toEqual([null, null]);
  });

  it("上穿、下破各报一次,方向跟着走势", () => {
    expect(feed([7722, 7724.5, 7725.3]).hits).toEqual([null, null, "up 7725"]);
    expect(feed([7752, 7750.4, 7749.8]).hits).toEqual([null, null, "down 7750"]);
  });

  it("碰到就算,而且不会掉头再报一次反方向", () => {
    // 上行碰到 7725.00 报上穿;从 7725.00 回落不是"下破"
    expect(feed([7724, 7725, 7724]).hits).toEqual([null, "up 7725", null]);
    // 下行碰到 7725.00 报下破;从 7725.00 回升不是"上穿"
    expect(feed([7726, 7725, 7726]).hits).toEqual([null, "down 7725", null]);
  });

  it("没到关口不报:离得再近也不算", () => {
    expect(feed([7720, 7724.99, 7720, 7724.99]).hits).toEqual([null, null, null, null]);
  });

  it("在关口上来回蹭只报一次", () => {
    const { hits } = feed([7724, 7726, 7724, 7726, 7723, 7727, 7720, 7730, 7725, 7735]);
    expect(hits).toEqual([null, "up 7725", null, null, null, null, null, null, null, null]);
  });

  it("离开半个步长(12.5 点)再回来,才是又到了", () => {
    // 上去 12.4 点还不够
    expect(feed([7724, 7726, 7737.4, 7724]).hits).toEqual([null, "up 7725", null, null]);
    // 够了 12.5 点:回来时报下破
    expect(feed([7724, 7726, 7737.5, 7724]).hits).toEqual([null, "up 7725", null, "down 7725"]);
    // 往下离开再回来:报上穿
    expect(feed([7726, 7724, 7712, 7725.5]).hits).toEqual([null, "down 7725", null, "up 7725"]);
  });

  it("别的关口不受静音影响:一路走上去每个都报", () => {
    expect(feed([7724, 7726, 7749, 7751, 7774, 7776]).hits).toEqual([null, "up 7725", null, "up 7750", null, "up 7775"]);
  });

  it("一笔跳过两个关口:只报最后一个,正文里说越过了几个", () => {
    let state = mod.stepLevelWatch(mod.EMPTY_WATCH, { price: 7720, source: "quote", at: T0 }).state;
    const out = mod.stepLevelWatch(state, { price: 7752, source: "quote", at: T0 + 2000 });
    expect(out.hit).toEqual({ level: 7750, direction: "up", price: 7752, source: "quote", at: T0 + 2000, skipped: 1 });
    expect(mod.levelHitBody(out.hit!)).toBe("现价 7752.00 · 这一步越过了 2 个关口");
    state = out.state;
    const down = mod.stepLevelWatch(state, { price: 7699, source: "quote", at: T0 + 4000 });
    expect(down.hit).toMatchObject({ level: 7700, direction: "down", skipped: 2 });
  });
});

describe("不该比的两笔不比", () => {
  it("隔了 30 秒以上(电脑睡过、断线重连):后一笔只登记", () => {
    const first = mod.stepLevelWatch(mod.EMPTY_WATCH, { price: 7720, source: "quote", at: T0 }).state;
    expect(mod.stepLevelWatch(first, { price: 7730, source: "quote", at: T0 + mod.GAP_MS }).hit).toMatchObject({ level: 7725 });
    const late = mod.stepLevelWatch(first, { price: 7730, source: "quote", at: T0 + mod.GAP_MS + 1 });
    expect(late.hit).toBeNull();
    // 登记的是新的这一笔:之后照常比
    expect(mod.stepLevelWatch(late.state, { price: 7751, source: "quote", at: T0 + mod.GAP_MS + 2001 }).hit).toMatchObject({ level: 7750 });
  });

  it("时钟倒着走的一笔:只登记", () => {
    const first = mod.stepLevelWatch(mod.EMPTY_WATCH, { price: 7720, source: "quote", at: T0 }).state;
    expect(mod.stepLevelWatch(first, { price: 7730, source: "quote", at: T0 - 1 }).hit).toBeNull();
  });

  it("换了来源(09:30 从期货推算换回官方指数):两种量法之间的差不是行情,不报", () => {
    expect(feed([[7723, "futures"], [7726, "quote"], [7727, "quote"]]).hits).toEqual([null, null, null]);
    // 同一种来源里照常报,正文标出是推算的
    const { hits, state } = feed([[7723, "futures"], [7726, "futures"]]);
    expect(hits).toEqual([null, "up 7725"]);
    const hit: Hit = { level: 7725, direction: "up", price: state.last!.price, source: "futures", at: T0, skipped: 0 };
    expect(mod.levelHitBody(hit)).toBe("现价 7726.00(按期货推算)");
  });

  it("不会动的价、没有价:不拿来判断,状态原样留着", () => {
    // 中间夹着昨收 / 断线 / 空值的那几笔被跳过,前后两笔可用的价照常比
    expect(feed([7724, [7700, "stale"], [null, "none"], null, 7726]).hits).toEqual([null, null, null, null, "up 7725"]);
    for (const bad of [NaN, 0, -1, Infinity]) {
      const out = mod.stepLevelWatch(mod.EMPTY_WATCH, { price: bad, source: "quote", at: T0 });
      expect(out).toEqual({ state: mod.EMPTY_WATCH, hit: null });
    }
  });

  it("价没变:不报,也不解除静音", () => {
    const { hits, state } = feed([7724, 7726, 7726, 7726]);
    expect(hits).toEqual([null, "up 7725", null, null]);
    expect(state.muted).toBe(7725);
  });
});

describe("提醒的文案", () => {
  it("标题和价位提醒用同一对词", () => {
    const hit: Hit = { level: 7725, direction: "up", price: 7725.31, source: "quote", at: T0, skipped: 0 };
    expect(mod.levelHitTitle("SPX", hit)).toBe("SPX 上穿 7725");
    expect(mod.levelHitTitle("SPX", { ...hit, direction: "down" })).toBe("SPX 下破 7725");
    expect(mod.levelHitBody(hit)).toBe("现价 7725.31");
  });
});
