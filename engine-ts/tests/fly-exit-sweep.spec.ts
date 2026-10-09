/** 蝶式出场参数的离线扫描(flyExitSweep*.ts)。全部离线,记下来的"天"都是测试里现造的——真的样本不进仓库,也不进测试。
 *
 * 这个工具的产出是一句"某组参数比现行的好 / 数据分不开",说错了就是拿真钱去换参数,所以每一环各钉一条:
 *  1. 盘口 → 价:蝶的中间价、立刻买得到的价、立刻卖得掉的价,对着手算的数;再对着持仓那一行(combos / tracker)的口径。
 *  2. 参照组就是实盘那一份:换出来的 Targets 与建追踪时存进库的逐字段相同;同一条价路径上,工具给的出场
 *     与直接一笔一笔问 tracker.evaluate 的一样——工具漂不离实盘的规则。
 *  3. 一份按构造就有一组更好的数据:找得出来——但只有天数够了、不靠分布假设的下界转正才说"更好";16 天时是"下不了结论"。
 *  4. 一份按构造参数不起作用的数据:结论是"分不开"。"更好"这句话的误报:在"多数天小赢、偶尔大亏、均值为零"的差值上
 *     (5 天到 30 天),三千个种子里不超过名义水平;见过的这些天上的区间在同样的数据上有多不可靠,摆在旁边。
 *  5. 同样的输入、同样的种子,结果一位不变。
 *  6. 缺报价:入场那一笔缺 → 情景不要;之后缺 → 那一笔不判断。
 *  7. 成交口径、佣金、两种了结口径、到点与止损;回放策略喂的是记下来的价,一分钟模型价都不用。
 */
import { describe, expect, it } from "vitest";

import * as fx from "../src/flyexit.js";
import { runSweep } from "../src/flyExitSweep.js";
import { formatReport } from "../src/flyExitSweepReport.js";
import {
  SweepError, entriesFrom, entryDebit, flyIntrinsic, flyQuote, gridFileFrom, liveLabel, liveReference, liveSets, liveTargets,
  parseEntryTime, replaySets, unitCost,
} from "../src/flyExitSweepSpec.js";
import type { FillModel, FlySpec, LiveParams, Population, SweepConfig } from "../src/flyExitSweepSpec.js";
import { CHECK_COARSE, CHECK_HALVES, analyse, degenerateProb, exactLower, seededRandom, summarise, verdictOf } from "../src/flyExitSweepStats.js";
import type { IvSample, IvSampleLeg } from "../src/ivSamples.js";
import { builtinCalendar } from "../src/marketCalendar.js";
import { makeBand } from "../src/playbook.js";
import { drawdownTiersOf } from "../src/rpc/params.js";
import { IvRecorderService } from "../src/services/ivRecorder.js";
import { sessionSigmaOf } from "../src/sessionEm.js";
import * as tk from "../src/tracker.js";
import { ET, wallToEpoch } from "../src/tz.js";

// ---------------------------------------------------------------- 造"记下来的一天"
const FLY: FlySpec = { center: 7025, wing: 25, right: "C" };
/** 合成的买卖价各离蝶的中间价这么远(见 tick) */
const HALF = 0.2;
const r2 = (v: number): number => Math.round(v * 100) / 100;

const at = (date: string, hhmm: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return wallToEpoch({ year: y, month: m, day: d, hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3)), second: 0 }, ET);
};
const hhmm = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/** 09:35 起每 5 分钟一笔,到 15:55:一共 77 笔 */
const CLOCK: string[] = Array.from({ length: 77 }, (_v, i) => hhmm(9 * 60 + 35 + 5 * i));

const leg = (strike: number, right: "C" | "P", bid: number | null, ask: number | null): IvSampleLeg => ({ strike, right, bid, ask, iv: null });

/**
 * 一笔样本:7000 / 7025 / 7050 三条看涨腿,盘口摆成"蝶的中间价正好是 mid":
 *   7050C 1.00 / 1.10、7025C 5.00 / 5.10、7000C (mid + 9.00) / (mid + 9.10)
 *   中间价 = (mid + 9.05) − 2 × 5.05 + 1.05 = mid;立刻买得到 = mid + 0.20;立刻卖得掉 = mid − 0.20。
 * 另带一对 7010 的平值看涨看跌(跨式 28.1),回放策略取 EM 用。
 */
function tick(date: string, clock: string, mid: number, spot = 6995, legs: IvSampleLeg[] | null = null): IvSample {
  return {
    t: at(date, clock), symbol: "SPX", expiry: date.replace(/-/g, ""), trading_class: "SPXW", spot, spot_source: "quote", by: "loop", anchor: 7000,
    legs: legs ?? [
      leg(7000, "C", r2(mid + 9.0), r2(mid + 9.1)), leg(7025, "C", 5.0, 5.1), leg(7050, "C", 1.0, 1.1),
      leg(7010, "C", 14.0, 14.2), leg(7010, "P", 13.9, 14.1),
    ],
  };
}

/** 一条价路径 → 一天的样本(从 09:35 起一笔一个价) */
const dayOf = (date: string, mids: number[], spot = 6995): IvSample[] => mids.map((m, i) => tick(date, CLOCK[i] ?? "15:55", m, spot));

/** 从 2026-03-02(周一)起的 n 个交易日 */
function tradingDays(n: number): string[] {
  const closed = new Set(builtinCalendar().holidays);
  const out: string[] = [];
  for (let d = Date.UTC(2026, 2, 2); out.length < n; d += 86_400_000) {
    const date = new Date(d).toISOString().slice(0, 10), dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6 && !closed.has(date)) out.push(date);
  }
  return out;
}

const POP: Population = {
  by: "loop", entry_from: null, entry_to: null, wings: null, rights: null, debit_min: null, debit_max: null, dist_min: null, dist_max: null,
};
const FILL: FillModel = {
  entry_spread_share: 1, commission: null, terminal: "natural", settle_within_min: 6, stop_basis: "mid", qty: 1, multiplier: 100,
};
const REF = liveReference();
const config = (over: Partial<SweepConfig> = {}): SweepConfig => ({
  symbol: "SPX", population: POP, entries: null, fill: FILL, live: liveSets(REF, null), replay: null, stride: 1, ...over,
});
/** 只在这一刻入场:每天每只蝶一个情景 */
const onlyAt = (clock: string): Population => ({ ...POP, entry_from: clock, entry_to: clock });
const BOOT = { level: 0.95, draws: 1000, seed: 7 };

function rng(seed: number): () => number {
  return seededRandom(seed);
}
const normal = (next: () => number): number => Math.sqrt(-2 * Math.log(next() + 1e-300)) * Math.cos(2 * Math.PI * next());

// ---------------------------------------------------------------- 1. 盘口 → 价
describe("盘口 → 蝶的三个价", () => {
  const quotes = (a: [number | null, number | null], b: [number | null, number | null], c: [number | null, number | null]): IvSample =>
    tick("2026-03-02", "10:00", 0, 7010, [leg(7000, "C", ...a), leg(7025, "C", ...b), leg(7050, "C", ...c)]);

  it("手算:12.40/12.60、5.00/5.20、1.05/1.15 → 中间价 3.40、买得到 3.75、卖得掉 3.05", () => {
    const q = flyQuote(quotes([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), FLY);
    // 中间价 12.5 − 2×5.1 + 1.1;买:两翼卖价、中心买价 12.6 − 2×5.0 + 1.15;卖:两翼买价、中心卖价 12.4 − 2×5.2 + 1.05
    expect(q).toEqual({ listed: true, mid: 3.4, open: 3.75, close_raw: 3.05 });
  });

  it("和持仓那一行同一个口径:中间价 = combos 的组合现价,卖得掉的价 = tracker.naturalClosePrice", () => {
    const sample = quotes([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]);
    const rows = sample.legs.map((l, i) => {
      const contract = { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20260302", strike: l.strike, right: l.right, multiplier: "100" };
      const ident = tk.legOf(contract);
      return {
        key: tk.makeKey("主账户", "SPX", "OPT", ident), account: "主账户", symbol: "SPX", sec_type: "OPT", leg: ident,
        quantity: i === 1 ? -2 : 1, avg_cost: 100, multiplier: 100, currency: "USD",
        market_price: ((l.bid ?? 0) + (l.ask ?? 0)) / 2, market_value: null, unrealized_pnl: null, contract,
      };
    });
    const combo = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!;
    const q = flyQuote(sample, FLY);
    expect(q.mid).toBe(combo["market_price"]);
    const position = tk.makePosition({ account: "主账户", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 375, multiplier: 100 });
    const book = Object.fromEntries(sample.legs.map((l) => [tk.legPriceKey(l), { bid: l.bid, ask: l.ask }]));
    expect(tk.naturalClosePrice(position, tk.structureOf("BAG", combo["contract"])!, book)).toBe(q.close_raw);
  });

  it("远翼买价为 0 是真盘口,照算;卖得掉的价可以是负数(不夹)", () => {
    expect(flyQuote(quotes([0.3, 0.4], [0.05, 0.1], [0, 0.05]), FLY)).toEqual({ listed: true, mid: 0.225, open: 0.35, close_raw: 0.1 });
    expect(flyQuote(quotes([0.1, 0.2], [0.05, 0.15], [0, 0.05]), FLY).close_raw).toBe(-0.2);
  });

  it("有一条腿的盘口不成对(缺一边、倒挂、卖价为 0):三个价都不给;腿不在样本里:这一笔和这只蝶无关", () => {
    const none = { listed: true, mid: null, open: null, close_raw: null };
    expect(flyQuote(quotes([12.4, 12.6], [5.0, null], [1.05, 1.15]), FLY)).toEqual(none);
    expect(flyQuote(quotes([12.4, 12.6], [null, 5.2], [1.05, 1.15]), FLY)).toEqual(none);
    expect(flyQuote(quotes([12.6, 12.4], [5.0, 5.2], [1.05, 1.15]), FLY)).toEqual(none);
    expect(flyQuote(quotes([12.4, 12.6], [5.0, 5.2], [0, 0]), FLY)).toEqual(none);
    expect(flyQuote(quotes([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), { ...FLY, right: "P" }).listed).toBe(false);
    expect(flyQuote(quotes([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), { ...FLY, wing: 50 }).listed).toBe(false);
  });

  it("到期值多少:一顶帐篷,看涨看跌一样", () => {
    for (const right of ["C", "P"] as const) {
      const fly: FlySpec = { ...FLY, right };
      expect([6990, 7000, 7010, 7025, 7040, 7050, 7060].map((s) => flyIntrinsic(fly, s))).toEqual([0, 0, 10, 25, 10, 0, 0]);
    }
  });

  it("入场价:让出半个价差的几成,朝多付的一侧取到跳动上", () => {
    expect(entryDebit(3.4, 3.75, 1, 0.05)).toBe(3.75);
    expect(entryDebit(3.4, 3.75, 0, 0.05)).toBe(3.4);
    expect(entryDebit(3.4, 3.75, 0.5, 0.05)).toBe(3.6); // 3.575 → 3.60
  });
});

// ---------------------------------------------------------------- 2. 参照组就是实盘那一份
describe("参照组 = 实盘的蝶式预设", () => {
  it("数从 flyexit 读:$100 / $200、40 / 30 / 20、15:00 后 ×0.5、最少回吐 0.20;止损与到点预设里没有", () => {
    expect(REF).toEqual({
      arm_usd: fx.FLY_ARM_USD, tighten_usd: fx.FLY_TIGHTEN_USD,
      loose_pct: fx.DEFAULTS["trail_loose"] * 100, mid_pct: fx.DEFAULTS["trail"] * 100, tight_pct: fx.DEFAULTS["trail_tight"] * 100,
      tight_at: fx.DEFAULTS["trail_tight_at"], late_after: fx.DEFAULTS["trail_late"], late_factor: fx.DEFAULTS["trail_late_factor"],
      floor: fx.DEFAULTS["trail_floor"], stop_mult: null, exit_at: null,
    });
  });

  it("换出来的 Targets 与建追踪时存进库的那一份逐字段相同(便宜的蝶第三档会被去掉,也一样)", () => {
    for (const cost of [30, 55, 66.5, 100, 199.99, 225, 400, 660, 1250]) {
      const mine = liveTargets(REF, cost, cost / 100, at("2026-03-02", "10:00"));
      const stored = drawdownTiersOf({ profit_drawdown_preset: "fly" }, cost);
      expect({
        profit_drawdown_tiers: mine.profit_drawdown_tiers, profit_drawdown_late: mine.profit_drawdown_late,
        profit_drawdown_arm: mine.profit_drawdown_arm, profit_drawdown_floor: mine.profit_drawdown_floor,
      }, `成本 ${cost}`).toEqual(stored);
      expect([mine.stop_loss, mine.exit_at, mine.exit_at_ms]).toEqual([null, null, null]);
    }
  });

  /** 不经过工具:拿建追踪时存的那份 Targets,一笔一笔问 tracker.evaluate,第一笔不是"持有"的就出场 */
  function byTracker(mids: number[], debit: number): { index: number; state: string } {
    const cost = debit * 100;
    const position = tk.makePosition({ account: "主账户", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: cost, multiplier: 100 });
    const targets = tk.makeTargets(drawdownTiersOf({ profit_drawdown_preset: "fly" }, cost));
    let peak: number | null = null;
    for (const [i, mid] of mids.entries()) {
      const res = tk.evaluate(position, targets, mid, peak, 9 * 60 + 35 + 5 * i);
      peak = res.peak;
      if (res.state !== tk.STATE_HOLDING) return { index: i, state: res.state };
    }
    return { index: -1, state: "" };
  }

  it("手造的一条路径:$225 的蝶,到过 +$145,回吐过四成那一笔出场,按立刻卖得掉的价成交", () => {
    // 入场那一笔中间价 2.05 → 立刻买得到 2.25。3.70 是峰值(浮盈 1.45);3.10 时浮盈 0.85 ≤ 1.45 × 0.6 = 0.87 → 触发
    const mids = [2.05, 2.4, 3.0, 3.6, 3.7, 3.5, 3.2, 3.1, 3.0, 2.9];
    expect(byTracker(mids, 2.25)).toEqual({ index: 7, state: tk.STATE_PROFIT_TRAIL });
    const result = runSweep(dayOf("2026-03-02", mids), config({ population: onlyAt("09:35") }), tk);
    expect(result.scenarios).toBe(1);
    expect(result.live.kinds[0]).toEqual({ profit_trail: 1 });
    expect(result.live.main.usd[0]).toEqual([expect.closeTo((3.1 - HALF - 2.25) * 100, 9)]); // +65
    expect(result.live.main.r[0]).toEqual([expect.closeTo(65 / 225, 9)]);
  });

  it("四十条随机路径:工具给的每一条都与直接问 tracker.evaluate 的一样(含 15:00 之后的收紧、没到起算线、收紧档)", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = rng(seed);
      const mids: number[] = [r2(Math.round((1 + 2 * next()) * 20) / 20)]; // 入场那一笔落在 0.05 的跳动上,入场价不用再取整
      // 双数种子前 62 笔不动、之后才走:触发落在 15:00 之后,尾盘收紧那一支才走得到
      for (let i = 1; i < CLOCK.length; i += 1) {
        const step = seed % 2 === 0 && i < 62 ? 0 : 0.45 * normal(next) + 0.03;
        mids.push(r2(Math.min(20, Math.max(0.6, (mids[i - 1] ?? 1) + step))));
      }
      const debit = r2((mids[0] ?? 0) + HALF);
      const expected = byTracker(mids, debit);
      const exit = expected.index >= 0 ? mids[expected.index] ?? NaN : mids[mids.length - 1] ?? NaN;
      const result = runSweep(dayOf("2026-03-02", mids), config({ population: onlyAt("09:35") }), tk);
      expect(result.live.main.usd[0]?.[0], `种子 ${seed}`).toBeCloseTo((r2(exit - HALF) - debit) * 100, 9);
      expect(result.live.kinds[0]).toEqual({ [expected.index >= 0 ? expected.state : "day_end"]: 1 });
      seen.add(expected.index < 0 ? "到收盘" : expected.index >= 65 ? "尾盘触发" : "盘中触发");
    }
    expect([...seen].sort()).toEqual(["到收盘", "尾盘触发", "盘中触发"]); // 三种收场都碰到过,这条才算钉住了
  });
});

// ---------------------------------------------------------------- 3. 按构造就有一组更好
/**
 * 一天一座"小山":入场价 2.00(每组 $200),蝶价在前四分之一多的时间里涨到 peak、再一路落到 end。peak 在 2.60–2.95 之间:
 * 浮盈最多 $95,**到不了现行的 $100 起算线**——现行参数一路拿到最后,亏掉大半;起算线放在 $50 的那一组,
 * 浮盈过 $50 就开始追,回吐四成出场,小赚。所以「起算 $50」每一天都比现行的好,好多少随 peak / end 变。
 */
function hill(date: string, peak: number, end: number, clock: string[] = CLOCK): IvSample[] {
  const last = clock.length - 1, top = Math.round(last * 0.27);
  return clock.map((c, i) => tick(date, c, r2(i <= top ? 1.8 + ((peak - 1.8) * i) / top : peak - ((peak - end) * (i - top)) / (last - top))));
}
function hills(days: number, seed: number, clock: string[] = CLOCK): IvSample[] {
  const next = rng(seed);
  return tradingDays(days).flatMap((date) => hill(date, 2.6 + 0.35 * next(), 0.6 + 0.6 * next(), clock));
}
/** 一刻钟一笔(外加收盘前最后那一笔):天数多的用例用它,省时间 */
const QUARTERS = CLOCK.filter((_c, i) => i % 3 === 0 || i === CLOCK.length - 1);
// 起算 $150:现行的都到不了,它更到不了——逐日与参照组相同。止损 0.5×D、15:00 平:也比拿到最后强一点,但不如早早锁住
const HILL_SETS = liveSets(REF, { arm_usd: [50, 150] }, [{ stop_mult: 0.5 }, { exit_at: "15:00" }]);

describe("一份按构造「起算 $50」更好的数据,只有 16 天", () => {
  const cfg = config({ population: onlyAt("09:35"), live: HILL_SETS });
  const result = runSweep(hills(16, 11), cfg, tk);
  const summary = summarise(result, "usd", BOOT);
  const labels = result.live.labels;
  const text = formatReport(result, summary).join("\n");

  it("每天一个情景,入场价 2.00;五组参数,第一组是参照组", () => {
    expect(result.scenarios).toBe(16);
    expect(result.debit).toEqual({ min: 2, median: 2, max: 2 });
    expect(labels).toEqual(["参照组(现行)", "起算 $50", "起算 $150", "止损 0.5×D", "15:00 平"]);
    expect(result.live.kinds[0]).toEqual({ day_end: 16 });
    expect(result.live.kinds[1]).toEqual({ profit_trail: 16 });
  });

  it("见过的这些天上它每天都赢、区间整个在 0 之上;算上挑选的区间比单看的宽", () => {
    const stat = summary.live.primary.sets[1]!;
    expect([stat.wins, summary.live.primary.ahead[0]]).toEqual([16, 1]);
    expect(stat.band?.[0]).toBeGreaterThan(0);
    expect(stat.ci?.[0]).toBeGreaterThan(stat.band?.[0] ?? Infinity);
    expect(summary.live.coarse[1]).toBeGreaterThan(0);
    expect(summary.live.alt_terminal[1]).toBeGreaterThan(0);
  });

  it("但 16 天说不了「更好」:排除不了的那种天还占三成,合约上限 $2,500 → 下不了结论,并说清还差什么", () => {
    const a = summary.live.primary, stat = a.sets[1]!;
    expect(result.loss_cap).toEqual({ usd: 2500, r: 500, wing: 25, debit_floor: 0.05 });
    expect([a.cap, a.better, summary.live.verdict]).toEqual([2500, [], { state: "unproven", set: 1, failed: [] }]);
    // 四组平分一头的 2.5%,再对半:α = 0.003125;π = 1 − α^(1/16)
    expect(a.alpha_tail).toBeCloseTo(0.025 / 4 / 2, 12);
    expect(stat.unseen).toBeCloseTo(1 - Math.pow(0.003125, 1 / 16), 12);
    expect(stat.seen).toBeGreaterThan(100); // 见过的这部分自己站得住:每天都好一百多美元
    expect(stat.exact?.[0]).toBeLessThan(0);
    expect(stat.breakeven).toBeCloseTo((stat.seen! * (1 - stat.unseen!)) / stat.unseen!, 9);
    expect(stat.days_needed).toBeGreaterThan(16);
    expect(text).toContain("**下不了结论**(16 天)。在见过的这些天上「起算 $50」领先");
    expect(text).toContain("合约条款允许它在那种天里一天平均比现行的多亏 $2500.0");
    expect(text).toContain(`要约 ${stat.days_needed} 天才排除得了`);
    expect(text).toContain("见过的这些天上同样领先的还有(按差值从大到小):「15:00 平」、「止损 0.5×D」");
    expect(text).not.toContain("比现行参数好");
  });

  it("报告写明试了几组、没扣佣金、人群怎么限的;逐日与参照组相同的那一组没有区间", () => {
    const same = summary.live.primary.sets[2]!;
    expect([same.ties, same.eligible, same.band]).toEqual([16, false, null]);
    expect(text).toContain("一共试了 4 组");
    expect(text).toContain("扣佣金之前");
    expect(text).toContain("--entry-from 09:35 --entry-to 09:35");
    expect(text).toContain("每天都与参照组相同");
    expect(text).toContain("合约条款给的上限:一个情景里一组参数最多比另一组多亏 翼宽 25 × 乘数 100 = $2500");
  });

  it("对半检验两边挑中的都是它,另一半上照样为正(给人看的那几行)", () => {
    for (const half of summary.live.primary.split) {
      expect(labels[half.picked ?? -1]).toBe("起算 $50");
      expect(half.held_out).toBeGreaterThan(0);
      expect([half.held_out_days, half.wins, half.losses]).toEqual([8, 8, 0]);
    }
  });

  it("三天、四天:重抽都估不稳,更谈不上结论;少于 9 天这几组无论如何下不了结论(从 π < 1/2 推出来的,不是定的)", () => {
    for (const days of [3, 4]) {
      const few = runSweep(hills(days, 11), cfg, tk);
      const s = summarise(few, "usd", BOOT);
      expect(s.live.primary.sets[1]!.wins).toBe(days);
      expect(s.live.primary.better).toEqual([]);
      expect(["unproven", "not_separated"]).toContain(s.live.verdict.state);
      expect(s.live.primary.min_days).toBe(9); // floor(log₂(1 ÷ 0.003125)) + 1
      const words = formatReport(few, s).join("\n");
      expect(words).toContain("少于 9 天数据再好也下不了结论");
      expect(words).not.toContain("比现行参数好");
    }
    expect(summarise(runSweep(hills(3, 11), cfg, tk), "usd", BOOT).live.primary.eligible).toBe(0);
  });

  it("按 R 算、又没给入场价的下限:上限是 500R,等于永远下不了结论,报告让人给 --debit-min 或改用美元", () => {
    const words = formatReport(result, summarise(result, "r", BOOT)).join("\n");
    expect(words).toContain("= 500.0R");
    expect(words).toContain("给 --debit-min 或改用 --objective usd");
    // 给了入场价的下限 1.5:上限 = 2500 ÷ 150 ≈ 16.7R
    const floored = runSweep(hills(16, 11), config({ population: { ...onlyAt("09:35"), debit_min: 1.5 }, live: HILL_SETS }), tk);
    expect(floored.loss_cap).toMatchObject({ debit_floor: 1.5, r: expect.closeTo(2500 / 150, 9) });
    const flooredWords = formatReport(floored, summarise(floored, "r", BOOT)).join("\n");
    expect(flooredWords).toContain("= 16.7R。入场价的下限 1.5(--debit-min)");
    expect(flooredWords).not.toContain("给 --debit-min 或改用");
  });
});

describe("同样的造法,150 天", () => {
  const cfg = config({ population: onlyAt("09:35"), live: HILL_SETS });
  const result = runSweep(hills(150, 11, QUARTERS), cfg, tk);
  const summary = summarise(result, "usd", BOOT);
  const text = formatReport(result, summary).join("\n");

  it("找得出来:「起算 $50」不靠分布假设的下界也在 0 之上,三样检查都还领先 → better", () => {
    const a = summary.live.primary, stat = a.sets[1]!;
    expect(summary.live.verdict).toEqual({ state: "better", set: 1, failed: [] });
    expect(stat.wins).toBe(150);
    expect(stat.exact?.[0]).toBeGreaterThan(0);
    expect(stat.exact?.[0]).toBeLessThan(stat.band?.[0] ?? -Infinity); // 比见过的这些天上的区间保守得多
    expect(stat.unseen).toBeCloseTo(1 - Math.pow(0.003125, 1 / 150), 12);
    expect(stat.halves.every((h) => (h ?? 0) > 0)).toBe(true);
    expect(text).toContain("「起算 $50」比现行参数好");
    expect(text).toContain("不靠分布假设的下界 +");
    expect(text).not.toContain("下不了结论**");
  }, 60_000);

  it("只在 5 分钟这一档上成立的差别不算数:放粗一倍方向反了 → fragile,报告明说不要据此改参数", () => {
    const primary = summary.live.primary;
    const flipped = primary.sets.map((_s, i) => (i === 1 ? -0.01 : 0));
    const v = verdictOf(primary, [{ name: CHECK_COARSE, diffs: flipped }]);
    expect(v).toEqual({ state: "fragile", set: 1, failed: [CHECK_COARSE] });
    const words = formatReport(result, { ...summary, live: { ...summary.live, verdict: v } }).join("\n");
    expect(words).toContain("不要据此改参数");
    expect(words).not.toContain("比现行参数好");
  });
});

// ---------------------------------------------------------------- 4. 按构造参数不起作用
describe("一份按构造参数不起作用的数据", () => {
  // 同样的小山,浮盈到不了 $100:起算线之后的那几样(收紧线、档位、第三档、尾盘系数、最少回吐)怎么改都碰不到
  const sets = liveSets(REF, { tighten_usd: [200, 150, 300], tiers: [[40, 30, 20], [50, 35, 20]], late_factor: [0.5, 1], floor: [0.2, 0.5] });
  const result = runSweep(hills(16, 11), config({ population: onlyAt("09:35"), live: sets }), tk);
  const summary = summarise(result, "usd", BOOT);

  it("每一组每一天都与参照组相同 → 分不开,报告里没有「比现行参数好」", () => {
    expect(sets.length).toBe(3 * 2 * 2 * 2); // 网格的全部组合;其中与参照组相同的那一个不重复算
    for (const s of summary.live.primary.sets) expect([s.diff, s.wins, s.losses]).toEqual([0, 0, 0]);
    expect(summary.live.primary.eligible).toBe(0);
    expect(summary.live.verdict.state).toBe("not_separated");
    const text = formatReport(result, summary).join("\n");
    expect(text).toContain("数据分不开这几组与现行参数(16 天)");
    expect(text).not.toContain("比现行参数好");
  });
});

// ---------------------------------------------------------------- 4b. "更好"这句话的误报
type Gen = (next: () => number) => number;
const expo: Gen = (next) => -Math.log(next() + 1e-300);

describe("「更好」的误报:均值为零、多数天小赢、偶尔大亏", () => {
  /** 赢 1 的机会 1 − q,亏 (1 − q) ÷ q 的机会 q,均值为零;每天再乘 0.8–1.2 的抖动。亏得最多的一天是 1.2 × (1 − q) ÷ q */
  const lottery = (q: number): Gen => (next) => (next() < 1 - q ? 1 : -(1 - q) / q) * (0.8 + 0.4 * next());
  const capOf = (q: number): number => (1.2 * (1 - q)) / q;
  /** 一组:参照组 + 这种差值 */
  const single = (gen: Gen) => (next: () => number, days: number): number[][] => {
    const base = Array.from({ length: days }, () => normal(next));
    return [base, base.map((b) => b + gen(next))];
  };
  /** 同一个主意的五个变体:同一天同一个方向,幅度是 0.75–1.75 倍再抖一成 */
  const nested = (gen: Gen) => (next: () => number, days: number): number[][] => {
    const base = Array.from({ length: days }, () => normal(next));
    const common = base.map(() => gen(next));
    return [base, ...[1, 2, 3, 4, 5].map((p) => base.map((b, j) => b + (0.5 + 0.25 * p) * common[j]! * (0.9 + 0.2 * next())))];
  };
  const RUNS = 3000;
  /** [不靠假设的下界在 0 之上的次数, 见过的这些天上的区间在 0 之上的次数] */
  function count(make: (next: () => number, days: number) => number[][], days: number, cap: number, draws: number, runs = RUNS): [number, number] {
    let proven = 0, ahead = 0;
    for (let seed = 1; seed <= runs; seed += 1) {
      const a = analyse(make(rng(seed * 104729 + days), days), 0, { level: 0.95, draws, seed, cap });
      if (a.sets.some((x) => (x.exact?.[0] ?? -1) > 0)) proven += 1;
      if (a.ahead.length) ahead += 1;
      expect(a.better.every((p) => (a.sets[p]?.exact?.[0] ?? -1) > 0 && a.ahead.includes(p))).toBe(true);
    }
    return [proven, ahead];
  }

  // 名义水平 95%(双侧);"更好"一侧是 2.5%:3000 次里不许超过 75 次。上限给的是这种差值真正的最坏一天(再大只会更保守)。
  // 写这几条用例时数出来的都是 0 次——这个下界很保守,这正是它在天数少时该有的样子
  it("一组、大亏占一成(赢 1 / 亏 9),5、9、15、30 天:不靠假设的下界每格都不超过 75 / 3000", () => {
    for (const days of [5, 9, 15, 30]) {
      const [proven] = count(single(lottery(0.1)), days, capOf(0.1), 1);
      expect(proven, `${days} 天`).toBeLessThanOrEqual(75);
    }
  }, 120_000);

  it("大亏占两成(赢 1 / 亏 4)9 天、占百分之一(赢 1 / 亏 99)30 天与 200 天、五个变体 9 天与 30 天:同样守得住", () => {
    expect(count(single(lottery(0.2)), 9, capOf(0.2), 1)[0]).toBeLessThanOrEqual(75);
    expect(count(single(lottery(0.01)), 30, capOf(0.01), 1)[0]).toBeLessThanOrEqual(75);
    expect(count(single(lottery(0.01)), 200, capOf(0.01), 1)[0]).toBeLessThanOrEqual(75);
    for (const days of [9, 30]) expect(count(nested(lottery(0.1)), days, capOf(0.1) * 1.75 * 1.1, 1)[0], `五个变体 ${days} 天`).toBeLessThanOrEqual(75);
  }, 120_000);

  it("差值又稀又整齐(12 天里 6 天是 ±1、其余与参照组相同,五组)且对称:两个方向都守得住", () => {
    let better = 0, worse = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const next = rng(seed * 15485863 + 12);
      const rows = [Array.from({ length: 12 }, () => 0)];
      for (let p = 0; p < 5; p += 1) {
        const order = rows[0]!.map((_v, i) => [next(), i] as const).sort((x, y) => x[0] - y[0]).slice(0, 6).map((x) => x[1]);
        rows.push(rows[0]!.map((_v, i) => (order.includes(i) ? (next() < 0.5 ? -1 : 1) * (1 + 0.1 * next()) : 0)));
      }
      const a = analyse(rows, 0, { level: 0.95, draws: 1, seed, cap: 1.1 });
      if (a.sets.some((x) => (x.exact?.[0] ?? -1) > 0)) better += 1;
      if (a.sets.some((x) => (x.exact?.[1] ?? 1) < 0)) worse += 1;
    }
    expect([better <= 75, worse <= 75]).toEqual([true, true]);
  }, 120_000);

  it("为什么不拿见过的这些天上的区间下结论:赢 1 / 亏 9、9 天,它有三成多的机会整个在 0 之上;下界一次都没有", () => {
    const [proven, ahead] = count(single(lottery(0.1)), 9, capOf(0.1), 300, 600);
    expect(ahead).toBeGreaterThan(150); // 0.9⁹ ≈ 39%:九天里一次大亏都没碰上的机会(写这条用例时 600 次里 246 次)
    expect(proven).toBe(0);
  }, 120_000);

  it("下界不是摆设:每天都好 1 上下、最多能差 1.1 → 16 天就转正;上限放到 30 → 转不了,天数涨上去才行", () => {
    const steady = (days: number): number[] => { const next = rng(days); return Array.from({ length: days }, () => 1 + 0.2 * normal(next)); };
    expect(exactLower(steady(16), 1.1, 0.00625, 0.00625)!.lower).toBeGreaterThan(0);
    expect(exactLower(steady(16), 30, 0.00625, 0.00625)!.lower).toBeLessThan(0);
    expect(exactLower(steady(400), 30, 0.00625, 0.00625)!.lower).toBeGreaterThan(0);
    // 文档「统计」里"要攒多久"的那几个数:25 宽的蝶上限 $2,500、四组一起比(α = 0.003125)
    const usd = (mu: number, sd: number, days: number): number => {
      const next = rng(days * 7 + mu);
      return exactLower(Array.from({ length: days }, () => mu + sd * normal(next)), 2500, 0.003125, 0.003125)!.lower;
    };
    expect([usd(155, 15, 80) < 0, usd(155, 15, 120) > 0]).toEqual([true, true]); // 每天稳定好 $150 上下:一百来天
    expect([usd(50, 60, 250) < 0, usd(50, 60, 1000) > 0]).toEqual([true, true]); // 平均好 $50、日间波动 $60:五百到一千天
    expect(usd(20, 60, 1000)).toBeLessThan(0); // 好 $20 的:一千天里证不了
    // 手算一遍:四天 [1, 2, 3, 4]、上限 10、两样各 α = 0.1。π = 1 − 0.1^(1/4);ε = √(ln 10 ÷ 6);
    // 见过的这部分 = ε × 1 + 余下 1 − ε 的质量从 2 起每个 1/3 地分
    const pi = 1 - Math.pow(0.1, 0.25), eps = Math.sqrt(Math.log(10) / 6);
    const seen = eps * 1 + (1 / 3) * 2 + (1 - eps - 1 / 3) * 3;
    expect(exactLower([3, 1, 4, 2], 10, 0.1, 0.1)).toEqual({ lower: expect.closeTo((1 - pi) * seen - pi * 10, 12), unseen: expect.closeTo(pi, 12), seen: expect.closeTo(seen, 12) });
    expect(exactLower([5], 10, 0.1, 0.1)).toBeNull();
  });
});

// ---------------------------------------------------------------- 4c. 见过的这些天上的区间(近似)
describe("见过的这些天上的区间:近似,不拿它下结论,但也得有个样子", () => {
  /** 左偏:多数天小赢、少数天大亏(1 − 指数分布,均值为零) */
  const skewLeft: Gen = (next) => 1 - expo(next);
  /** 又稀又左偏:八成的天没有差别;有差别的天里八成小赢(0.25 × 指数)、两成大亏(−1 × 指数),均值为零 */
  const sparseLeft: Gen = (next) => (next() < 0.8 ? 0 : (next() < 0.8 ? 0.25 : -1) * expo(next));

  /** 没有真差别的差值:各组 = 参照组 + 零均值的噪声(一半来自各组共有的"那一天",各组的尺度差 30 倍);shift 只加给第 1 组 */
  function noise(seed: number, days: number, sets: number, gen: Gen = normal, shift = 0): number[][] {
    const next = rng(seed);
    const base = Array.from({ length: days }, () => normal(next));
    const common = Array.from({ length: days }, () => gen(next));
    const rows = [base];
    for (let p = 1; p < sets; p += 1) {
      const scale = Math.pow(30, (p - 1) / Math.max(1, sets - 2));
      rows.push(base.map((b, j) => b + scale * (0.7 * (common[j] ?? 0) + 0.7 * gen(next)) + (p === 1 ? shift : 0)));
    }
    return rows;
  }

  // 置信水平 95%;每一格 200 个固定的种子,区间整个在 0 之上("领先")的不超过 10 次,两个方向合起来也不超过 10 次。组数含参照组。
  // 写这条用例时数出来的"领先"次数(12 天 8 组 / 40 天 5 组):对称 0 / 4、左偏 3 / 5、又稀又左偏 0 / 6。
  // 这只是温和的偏与稀;偏得厉害、天又少时它守不住(上面"赢 1 / 亏 9"那一条),所以结论不看它
  for (const [name, gen] of [["对称的噪声", normal], ["左偏的噪声", skewLeft], ["又稀又左偏的噪声", sparseLeft]] as const) {
    it(`${name},200 个种子 ×(12 天 8 组、40 天 5 组):区间整个在 0 之上的每格不超过 10 次`, () => {
      for (const [days, sets] of [[12, 8], [40, 5]] as const) {
        let ahead = 0, behind = 0;
        for (let seed = 1; seed <= 200; seed += 1) {
          const a = analyse(noise(seed, days, sets, gen), 0, { level: 0.95, draws: 300, seed });
          if (a.ahead.length) ahead += 1;
          if (a.behind.length) behind += 1;
        }
        expect(ahead, `${days} 天 ${sets} 组`).toBeLessThanOrEqual(10);
        expect(ahead + behind, `${days} 天 ${sets} 组,两个方向`).toBeLessThanOrEqual(10);
      }
    }, 120_000);
  }

  // 另外两种做法,只在这里摆出来对照(不随软件走):直接取均值差的最大值;用各组原样本的标准误去除、不逐次重估
  function rivals(rows: number[][], seed: number, draws: number, level: number): { plain: number[]; fixed: number[] } {
    const base = rows[0]!, n = base.length;
    const d = rows.slice(1).map((row) => row.map((v, j) => v - base[j]!));
    const mean = d.map((x) => x.reduce((a, b) => a + b, 0) / n);
    const se = d.map((x, p) => Math.sqrt(x.reduce((a, v) => a + (v - mean[p]!) ** 2, 0) / (n - 1) / n));
    const next = rng(seed);
    const maxPlain: number[] = [], maxFixed: number[] = [];
    for (let b = 0; b < draws; b += 1) {
      const pick = Array.from({ length: n }, () => Math.floor(next() * n));
      let a = 0, f = 0;
      for (const [p, x] of d.entries()) {
        const dev = Math.abs(pick.reduce((acc, j) => acc + x[j]!, 0) / n - mean[p]!);
        a = Math.max(a, dev);
        f = Math.max(f, dev / se[p]!);
      }
      maxPlain.push(a);
      maxFixed.push(f);
    }
    const q = (xs: number[]): number => xs.sort((x, y) => x - y)[Math.ceil(level * xs.length) - 1]!;
    const qa = q(maxPlain), qf = q(maxFixed);
    const hit = (ok: (p: number) => boolean): number[] => mean.map((_m, p) => p).filter(ok).map((p) => p + 1);
    return { plain: hit((p) => mean[p]! - qa > 0), fixed: hit((p) => mean[p]! - qf * se[p]! > 0) };
  }

  it("为什么是逐次重估标准误的 max-t:6 天 21 组(含参照组)没有真差别,「原样本标准误」那种多出好几倍", () => {
    let mine = 0, fixed = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const rows = noise(seed, 6, 21);
      if (analyse(rows, 0, { level: 0.95, draws: 300, seed }).ahead.length) mine += 1;
      if (rivals(rows, seed, 300, 0.95).fixed.length) fixed += 1;
    }
    expect(fixed).toBeGreaterThan(30); // 名义 5% = 10 次,实际是它的好几倍(写这条用例时:55 次对 1 次)
    expect(mine).toBeLessThanOrEqual(10);
  }, 120_000);

  it("……而「直接取均值差」那种分不出安静的组:第 1 组真的好(差值的尺度最小),20 天 5 组(含参照组),它看得见、那种看不见", () => {
    let mine = 0, plain = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const rows = noise(seed, 20, 5, normal, 0.9);
      if (analyse(rows, 0, { level: 0.95, draws: 300, seed }).ahead.includes(1)) mine += 1;
      if (rivals(rows, seed, 300, 0.95).plain.includes(1)) plain += 1;
    }
    expect(mine).toBeGreaterThan(50); // 写这条用例时:100 次里 89 次对 0 次
    expect(plain).toBeLessThan(10);
  }, 120_000);

  it("几组只在很少几天上与参照组不同,不连累别的组:每天都赢的那一组照样有区间", () => {
    const next = rng(5);
    const base = Array.from({ length: 30 }, () => normal(next));
    const good = base.map((b) => b + 1 + 0.2 * normal(next));
    // 三组各只在 4 天上比参照组差(各是不同的 4 天):每组重抽到全是 0 的机会 (26/30)^30 ≈ 1.4%,刚好给得出区间;
    // 那几次它们的 t 是 +∞。三组合起来超过了 2.5% 的尾巴——要是算进大家共用的临界值,所有组的下界都没了
    const sparse = (from: number): number[] => base.map((b, j) => (j >= from && j < from + 4 ? b - 1 - 0.1 * (j - from) : b));
    const a = analyse([base, good, sparse(0), sparse(4), sparse(8)], 0, BOOT);
    expect(a.sets.slice(2).map((x) => x.eligible)).toEqual([true, true, true]);
    expect(a.critical?.every((v) => v !== null)).toBe(true);
    expect(a.sets[1]!.band?.[0]).toBeGreaterThan(0.5);
    expect(a.ahead).toEqual([1]);
  });
});

// ---------------------------------------------------------------- 5. 可复现
describe("同样的输入、同样的种子", () => {
  const sets = liveSets(REF, { arm_usd: [50, 150] }, [{ stop_mult: 0.5 }]);
  const run = (seed: number): string => {
    const result = runSweep(hills(12, 5), config({ population: onlyAt("09:35"), live: sets }), tk);
    const summary = summarise(result, "r", { level: 0.95, draws: 300, seed });
    return JSON.stringify({ result, summary, text: formatReport(result, summary) });
  };

  it("结果一位不变;换个种子,区间会动、结论不动", () => {
    expect(run(7)).toBe(run(7));
    const a = JSON.parse(run(7)), b = JSON.parse(run(8));
    expect(a.summary.live.primary.sets[1].band).not.toEqual(b.summary.live.primary.sets[1].band);
    expect(a.summary.live.primary.sets[1].diff).toBe(b.summary.live.primary.sets[1].diff);
    expect([a.summary.live.verdict, b.summary.live.verdict]).toEqual([a.summary.live.verdict, a.summary.live.verdict]);
  });
});

// ---------------------------------------------------------------- 6. 缺报价
describe("缺报价", () => {
  const MIDS = [2.05, 3.6, 3.7, 3.1, 3.0, 2.9, 2.8];
  const broken = (date: string, clock: string): IvSample =>
    tick(date, clock, 0, 6995, [leg(7000, "C", 12.0, 12.1), leg(7025, "C", 5.0, null), leg(7050, "C", 1.0, 1.1)]);

  it("之后某一笔缺:那一笔不判断(本该在 3.10 触发,挪到下一笔 3.00),并数出来", () => {
    const whole = dayOf("2026-03-02", MIDS);
    const holed = whole.map((s, i) => (i === 3 ? broken("2026-03-02", CLOCK[3]!) : s));
    const a = runSweep(whole, config({ population: onlyAt("09:35") }), tk);
    const b = runSweep(holed, config({ population: onlyAt("09:35") }), tk);
    expect(a.live.main.usd[0]?.[0]).toBeCloseTo((3.1 - HALF - 2.25) * 100, 9);
    expect(b.live.main.usd[0]?.[0]).toBeCloseTo((3.0 - HALF - 2.25) * 100, 9);
    expect(a.no_decision).toEqual({ missing: 0, total: 7 });
    expect(b.no_decision).toEqual({ missing: 1, total: 7 });
    expect(formatReport(b, summarise(b, "r", BOOT)).join("\n")).toContain("缺报价、那一笔没判断的:1 / 7 笔");
  });

  it("入场那一笔缺:情景不要,数出来;最后一笔之后没有样本,也不要", () => {
    const holed = dayOf("2026-03-02", MIDS).map((s, i) => (i === 1 ? broken("2026-03-02", CLOCK[1]!) : s));
    const result = runSweep(holed, config(), tk);
    expect(result.skipped).toEqual({ "入场那一笔缺报价": 1, "入场之后当天没有样本了": 1 });
    expect(result.scenarios).toBe(MIDS.length - 2);
  });

  it("触发那一笔拿不到立刻成交价(各腿都有报价,只是净价不是正数):等到下一笔有价的再成交", () => {
    // 止损 0.5×D:D = 2.25,中间价 1.00 触发。那一笔 7000C 的盘口拉得很宽,卖得掉的价是负数;下一笔恢复
    const wide = tick("2026-03-02", CLOCK[2]!, 0, 6995, [leg(7000, "C", 9.0, 11.1), leg(7025, "C", 5.0, 5.1), leg(7050, "C", 1.0, 1.1)]);
    expect(flyQuote(wide, FLY)).toMatchObject({ mid: 1, close_raw: -0.2 });
    const samples = dayOf("2026-03-02", [2.05, 1.8, 1.0, 0.9, 0.8]).map((s, i) => (i === 2 ? wide : s));
    const cfg = config({ population: onlyAt("09:35"), live: liveSets(REF, { stop_mult: [0.5] }) });
    const result = runSweep(samples, cfg, tk);
    expect(result.live.kinds[1]).toEqual({ stop_loss: 1 });
    expect(result.live.main.usd[1]?.[0]).toBeCloseTo((0.9 - HALF - 2.25) * 100, 9);
  });

  it("触发了、到最后都卖不掉:按最后一笔了结,净价不是正数按 0(留着作废,不倒贴)", () => {
    const dead = (clock: string): IvSample =>
      tick("2026-03-02", clock, 0, 6995, [leg(7000, "C", 0.1, 0.2), leg(7025, "C", 0.05, 0.15), leg(7050, "C", 0, 0.05)]);
    const samples = [tick("2026-03-02", CLOCK[0]!, 2.05), dead(CLOCK[1]!), dead(CLOCK[2]!)];
    const cfg = config({ population: onlyAt("09:35"), live: liveSets(REF, { stop_mult: [0.5] }) });
    const result = runSweep(samples, cfg, tk);
    expect(result.live.kinds).toEqual([{ day_end: 1 }, { unfilled: 1 }]);
    expect(result.live.main.usd.map((row) => row[0])).toEqual([-225, -225]);
  });

  it("带着到期日却不是当日到期的样本不用;--by 只用选中的那一路", () => {
    const samples = dayOf("2026-03-02", MIDS);
    const stray: IvSample = { ...tick("2026-03-02", "10:02", 9), expiry: "20260303" };
    const plan: IvSample = { ...tick("2026-03-02", "10:03", 9), by: "plan" };
    const loop = runSweep([...samples, stray, plan], config({ population: onlyAt("09:35") }), tk);
    expect(loop.data).toMatchObject({ samples: 9, used: 7, not_same_day: 1 });
    const all = runSweep([...samples, stray, plan], config({ population: { ...onlyAt("09:35"), by: "all" } }), tk);
    expect(all.data.used).toBe(8);
  });
});

// ---------------------------------------------------------------- 7. 成交口径、了结、到点与止损
describe("成交口径", () => {
  const MIDS = [2.05, 2.4, 3.0, 3.6, 3.7, 3.5, 3.2, 3.1, 3.0, 2.9];
  const one = (over: Partial<FillModel>, live: LiveParams[] = liveSets(REF, null), samples = dayOf("2026-03-02", MIDS)): ReturnType<typeof runSweep> =>
    runSweep(samples, config({ population: onlyAt("09:35"), fill: { ...FILL, ...over }, live }), tk);

  it("入场让出半个价差的几成:1 → 2.25,0 → 2.05;入场价变了,起算线换算出来的倍数跟着变", () => {
    expect(one({}).debit?.min).toBe(2.25);
    expect(one({ entry_spread_share: 0 }).debit?.min).toBe(2.05);
    expect(one({ entry_spread_share: 0.5 }).debit?.min).toBe(2.15);
  });

  it("佣金:每张每边;一组 4 张,成交的出场再收一次,归零作废不收;没给就是 0 并在报告里明说", () => {
    const free = one({}).live.main.usd[0]![0]!, paid = one({ commission: 0.65 }).live.main.usd[0]![0]!;
    expect(free - paid).toBeCloseTo(8 * 0.65, 9);
    const text = (r: ReturnType<typeof runSweep>): string => formatReport(r, summarise(r, "r", BOOT)).join("\n");
    expect(text(one({}))).toContain("扣佣金之前");
    expect(text(one({ commission: 0.65 }))).toContain("每张每边 $0.65");
    // 一路拿到最后、最后一文不值:只有入场那 4 张
    const dead = tick("2026-03-02", CLOCK[1]!, 0, 6995, [leg(7000, "C", 0.1, 0.2), leg(7025, "C", 0.05, 0.15), leg(7050, "C", 0, 0.05)]);
    const worthless = one({ commission: 0.65 }, liveSets(REF, null), [tick("2026-03-02", CLOCK[0]!, 2.05), dead]);
    expect(worthless.live.main.usd[0]![0]).toBeCloseTo(-225 - 4 * 0.65, 9);
  });

  it("一直没出场的:natural 按最后一笔的立刻成交价;settle 按最后一笔现价的内在价值(记到了收盘才算),另一种口径同时算出来", () => {
    // 浮盈到不了起算线,拿到最后。最后一笔 15:55、现价 7015 → 内在价值 15;最后一笔的中间价 2.40 → 卖得掉 2.20
    const flat = CLOCK.map(() => 2.4);
    flat[0] = 2.05;
    const samples = dayOf("2026-03-02", flat, 7015);
    const natural = one({}, liveSets(REF, null), samples), settle = one({ terminal: "settle" }, liveSets(REF, null), samples);
    expect(natural.live.main.usd[0]![0]).toBeCloseTo((2.2 - 2.25) * 100, 9);
    expect(natural.live.alt_terminal.usd[0]![0]).toBeCloseTo((15 - 2.25) * 100, 9);
    expect(settle.live.main.usd[0]![0]).toBeCloseTo((15 - 2.25) * 100, 9);
    expect(settle.live.alt_terminal.usd[0]![0]).toBeCloseTo((2.2 - 2.25) * 100, 9);
    expect([natural.live.kinds[0], settle.live.kinds[0]]).toEqual([{ day_end: 1 }, { settle: 1 }]);
    // 结算不是成交:不收出场那一次佣金
    expect(one({ terminal: "settle", commission: 1 }, liveSets(REF, null), samples).live.main.usd[0]![0]).toBeCloseTo((15 - 2.25) * 100 - 4, 9);
    // 这一天只记到 14:00:谈不上结算,两种口径都是最后一笔的立刻成交价,并数出这样的天数
    const short = one({ terminal: "settle" }, liveSets(REF, null), samples.slice(0, 54));
    expect(short.live.main.usd[0]![0]).toBeCloseTo((2.2 - 2.25) * 100, 9);
    expect([short.short_days, natural.short_days]).toEqual([1, 0]);
  });

  it("提前收盘日(2026-11-27)13:00 收盘:12:55 的最后一笔算记到了收盘", () => {
    const flat = Array.from({ length: 41 }, () => 2.4); // 09:35 … 12:55
    flat[0] = 2.05;
    const result = runSweep(dayOf("2026-11-27", flat, 7015), config({ population: onlyAt("09:35"), fill: { ...FILL, terminal: "settle" } }), tk);
    expect(result.short_days).toBe(0);
    expect(result.live.kinds[0]).toEqual({ settle: 1 });
  });

  it("到点平仓与止损走的是追踪上的同一套:到点 = 第一笔不早于那个钟点的样本;入场时已过钟点的当天不触发", () => {
    const sets = liveSets(REF, { stop_mult: [null, 0.9], exit_at: ["09:50", "09:30"] }, [{ stop_mult: 0.9 }]);
    const result = one({}, sets, dayOf("2026-03-02", [2.05, 2.1, 2.2, 2.3, 2.2, 2.1, 2.0]));
    expect(result.live.labels).toEqual(["参照组(现行)", "09:50 平", "09:30 平", "止损 0.9×D · 09:50 平", "止损 0.9×D · 09:30 平", "止损 0.9×D"]);
    // 09:50 是第 4 笔(2.30)→ 卖在 2.10;09:30 在入场之前 → 当天不触发;止损 0.9 × 2.25 = 2.025:入场那一笔 2.05 没破,最后一笔 2.00 破
    expect(result.live.kinds).toEqual([
      { day_end: 1 }, { time_exit: 1 }, { day_end: 1 }, { time_exit: 1 }, { stop_loss: 1 }, { stop_loss: 1 },
    ]);
    expect(result.live.main.usd[1]![0]).toBeCloseTo((2.1 - 2.25) * 100, 9);
    expect(result.live.main.usd[5]![0]).toBeCloseTo((1.8 - 2.25) * 100, 9);
  });

  it("追踪的成本含入场的佣金(和实盘组合行的 avg_cost 同一个口径):$100 那条线跟着晚到,没给佣金时在报告里说明", () => {
    // 入场价 2.25,峰值 3.30:不含佣金时浮盈 $105 过了 $100 起算线,回落到 2.60 那一笔回撤出场;
    // 每张 $5 时成本是 225 + 4 × 5 = 245,浮盈只有 $85,没起算,一路拿到最后
    expect([unitCost(2.25, { multiplier: 100, commission: 5 }), unitCost(2.25, { multiplier: 100, commission: null })]).toEqual([245, 225]);
    const samples = dayOf("2026-03-02", [2.05, 3.3, 2.6, 2.5]);
    const free = one({}, liveSets(REF, null), samples), paid = one({ commission: 5 }, liveSets(REF, null), samples);
    expect([free.live.kinds[0], paid.live.kinds[0]]).toEqual([{ profit_trail: 1 }, { day_end: 1 }]);
    expect(free.live.main.usd[0]![0]).toBeCloseTo((2.4 - 2.25) * 100, 9);
    expect(paid.live.main.usd[0]![0]).toBeCloseTo((2.3 - 2.25) * 100 - 8 * 5, 9);
    expect(paid.live.main.r[0]![0]).toBeCloseTo(((2.3 - 2.25) * 100 - 8 * 5) / 225, 9); // R 的分母仍是付出的权利金
    const words = (r: ReturnType<typeof runSweep>): string => formatReport(r, summarise(r, "usd", BOOT)).join("\n");
    expect(words(free)).toContain("追踪的成本也按不含佣金算");
    expect(words(paid)).toContain("追踪的成本里含入场的那 4 张");
    // 合约上限里也带上那一次出场的佣金
    expect(paid.loss_cap?.usd).toBe(2500 + 4 * 5);
  });

  it("一次只扫一个标的:别的标的的样本不用并数出来;没指定标的、样本里却有两个,当场拒", () => {
    const samples = dayOf("2026-03-02", MIDS);
    const other: IvSample = { ...tick("2026-03-02", "10:02", 9), symbol: "NDX" };
    const result = runSweep([...samples, other], config({ population: onlyAt("09:35") }), tk);
    expect([result.symbol, result.data.other_symbol, result.data.used]).toEqual(["SPX", 1, 10]);
    expect(() => runSweep([...samples, other], config({ symbol: null }), tk)).toThrow(/NDX、SPX/);
    expect(runSweep(samples, config({ symbol: null, population: onlyAt("09:35") }), tk).scenarios).toBe(1);
  });

  it("止损价不低于入场那一刻的中间价:实盘建追踪时会被拒(一建就触发),这里照样问 tracker.validate,按不设止损算并数出来", () => {
    // 入场价 2.25、中间价 2.05:0.95 × 2.25 = 2.1375 ≥ 2.05 → 设不上;0.9 × 2.25 = 2.025 < 2.05 → 设得上
    const sets = liveSets(REF, { stop_mult: [0.95, 0.9] });
    const result = one({}, sets, dayOf("2026-03-02", [2.05, 2.1, 2.0, 1.9]));
    expect(result.live.stop_refused).toEqual([0, 1, 0]);
    expect(result.live.kinds).toEqual([{ day_end: 1 }, { day_end: 1 }, { stop_loss: 1 }]);
    expect(result.live.main.usd[1]).toEqual(result.live.main.usd[0]);
    expect(formatReport(result, summarise(result, "r", BOOT)).join("\n")).toContain("止损设不上的情景(组 → 个):1 → 1");
  });

  it("止损类按立刻成交价判(--stop-basis natural):中间价没破、卖得掉的价破了,就触发", () => {
    // 止损 0.8 × 2.25 = 1.80。第二笔中间价 1.95(没破),卖得掉 1.75(破了)
    const sets = liveSets(REF, { stop_mult: [0.8] });
    const samples = dayOf("2026-03-02", [2.05, 1.95, 1.9, 1.85]);
    expect(one({}, sets, samples).live.kinds[1]).toEqual({ day_end: 1 });
    const natural = one({ stop_basis: "natural" }, sets, samples);
    expect(natural.live.kinds[1]).toEqual({ stop_loss: 1 });
    expect(natural.live.main.usd[1]![0]).toBeCloseTo((1.75 - 2.25) * 100, 9);
  });

  it("放粗一倍:只在单数笔上判断。尖峰落在跳过的那一笔上,峰值就看不到——这正是两笔之间看不见的东西", () => {
    // 第 2 笔(下标 1)冲到 4.00 再回落:每笔都判时 3.00 那一笔回吐过四成出场;隔一笔判时峰值只看到 3.00,一路拿到最后
    const result = one({}, liveSets(REF, null), dayOf("2026-03-02", [2.05, 4.0, 3.0, 2.9, 2.9, 2.9, 2.9]));
    expect(result.live.main.usd[0]![0]).toBeCloseTo((3.0 - HALF - 2.25) * 100, 9);
    expect(result.live.coarse.usd[0]![0]).toBeCloseTo((2.9 - HALF - 2.25) * 100, 9);
  });

  it("入场人群的限定:入场价范围、中心离现价多远、翼宽、看涨看跌——筛掉多少都数出来", () => {
    const samples = dayOf("2026-03-02", MIDS, 7010);
    const pick = (pop: Partial<Population>): ReturnType<typeof runSweep> => runSweep(samples, config({ population: { ...POP, ...pop } }), tk);
    expect(pick({}).scenarios).toBe(9);
    expect(pick({ debit_max: 3 }).filtered).toEqual({ "入场价不在范围里": 7 }); // 九个入场价里只有 2.25、2.60 不超过 3
    expect(pick({ dist_min: 20 }).scenarios).toBe(0); // 看涨蝶中心 7025、现价 7010:在虚值一侧 15 点
    expect(pick({ dist_min: 10, dist_max: 15 }).scenarios).toBe(9);
    expect(pick({ wings: [50] }).scenarios).toBe(0);
    expect(pick({ rights: ["P"] }).scenarios).toBe(0);
    expect(pick({}).wings).toEqual({ "25": 1 });
  });

  it("给了真实入场就只算那几笔:用入场时刻或之后的第一笔样本;给了实付净价就用它", () => {
    const samples = dayOf("2026-03-02", MIDS);
    const entries = [
      { t: at("2026-03-02", "09:37"), center: 7025, wing: 25, right: "C" as const, debit: 2.5 }, // → 09:40 那一笔
      { t: at("2026-03-02", "09:35"), center: 7025, wing: 25, right: "C" as const },
      { t: at("2026-03-02", "09:35"), center: 7100, wing: 25, right: "C" as const },
      { t: at("2026-03-03", "09:35"), center: 7025, wing: 25, right: "C" as const },
      { t: at("2026-03-02", "15:00"), center: 7025, wing: 25, right: "C" as const },
    ];
    const result = runSweep(samples, config({ entries }), tk);
    expect(result.from_entries).toBe(true);
    expect(result.scenarios).toBe(2);
    expect(result.debit).toEqual({ min: 2.25, median: 2.375, max: 2.5 });
    expect(result.skipped).toEqual({ "那一天没有记下样本": 1, "记下来的行权价里摆不出这只蝶": 1, "入场之后当天没有样本了": 1 });
  });
});

// ---------------------------------------------------------------- 记下来的网格摆得出哪些蝶
describe("后台那一路记下来的行权价", () => {
  it("锚 ±75 / 50 / 25 / 10 / 0、锚以下看跌、以上看涨:一天只摆得出四只蝶,都是 25 宽", () => {
    // 行权价的摆法照 services/ivRecorder.ts 的 legsFor;这条用例在它换网格时会红,提醒这里能扫的人群跟着变了
    const anchor = 7000;
    const legs = IvRecorderService.OFFSETS.flatMap((off) => [
      ...(off <= 0 ? [leg(anchor + off, "P", 1.0, 1.1)] : []), ...(off >= 0 ? [leg(anchor + off, "C", 1.0, 1.1)] : []),
    ]);
    const samples = CLOCK.slice(0, 3).map((clock) => tick("2026-03-02", clock, 0, anchor, legs));
    const listed = (center: number, wing: number, right: "C" | "P"): boolean => flyQuote(samples[0]!, { center, wing, right }).listed;
    expect([listed(6950, 25, "P"), listed(6975, 25, "P"), listed(7025, 25, "C"), listed(7050, 25, "C")]).toEqual([true, true, true, true]);
    expect([listed(7000, 25, "C"), listed(7000, 25, "P"), listed(7025, 50, "C"), listed(6950, 50, "P")]).toEqual([false, false, false, false]);
    const result = runSweep(samples, config(), tk);
    expect(result.wings).toEqual({ "25": 4 });
    expect(result.scenarios).toBe(4 * 2); // 四只蝶 × 前两笔(最后一笔之后没有样本)
  });

  it("真实入场的时刻:美东墙钟或带时区的 ISO;别的写法不猜", () => {
    expect(parseEntryTime("2026-03-02 10:32")).toBe(at("2026-03-02", "10:32"));
    expect(parseEntryTime("2026-03-02T10:32:30")).toBe(at("2026-03-02", "10:32") + 30_000);
    expect(parseEntryTime("2026-03-02T15:32:00Z")).toBe(at("2026-03-02", "10:32"));
    expect(parseEntryTime("2026-03-02T10:32:00-05:00")).toBe(at("2026-03-02", "10:32"));
    expect([parseEntryTime("10:32"), parseEntryTime("2026-02-30 10:00"), parseEntryTime("March 2, 2026 10:32")]).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------- 回放策略
describe("回放策略(flyexit.simulate)喂的是记下来的价", () => {
  const DATE = "2026-03-02";
  const stamp = (i: number): string => `${DATE} ${CLOCK[i] ?? ""}`;
  /** 入场那一笔的平值跨式:7010 的看涨 14.1、看跌 14.0(见 tick)→ 折回全天的 1σ */
  const EM = sessionSigmaOf(makeBand({ at: at(DATE, CLOCK[0]!), anchor: 7010, strike: 7010, expiry: "20260302", call: 14.1, put: 14.0, source: "live" })!)!;

  /** 不经过工具:直接调 simulate,再把它的每一次出手换成立刻卖得掉的价(中间价 − 0.20);没出完的按最后一笔 */
  function bySimulate(mids: number[], spots: number[], debit: number, qty: number, override: Record<string, number> = {}): number {
    const profile = { lower: 7000, center: 7025, upper: 7050, width: 25, right: "C", action: "BUY", debit, qty, multiplier: 100 };
    const spx = spots.map((close, i) => ({ time: stamp(i), close }));
    const sim = fx.simulate(profile, stamp(0), spx, mids.map((close, i) => ({ time: stamp(i), close })), fx.paramsFrom({ ...override, em: EM }));
    if (!sim.applicable) throw new Error(sim.reason);
    expect(sim.totals.model_minutes).toBe(0);
    let usd = 0;
    for (const e of sim.events) {
      const price = e["source"] === "real" ? Number(e["price"]) : mids[mids.length - 1]!;
      usd += Number(e["qty"]) * (r2(price - HALF) - debit) * 100;
    }
    return usd / qty;
  }

  it("手造的一条:到过 1.3×D 开始记高水位,回吐四成那一笔清仓,按立刻卖得掉的价 → +$55;EM 取自当天记下来的平值跨式", () => {
    const mids = [2.05, 2.6, 3.2, 3.6, 3.0, 2.9];
    const samples = mids.map((m, i) => tick(DATE, CLOCK[i]!, m, 7010));
    const result = runSweep(samples, config({ population: onlyAt("09:35"), replay: { em: "auto", sets: replaySets(null) } }), tk);
    expect(result.replay?.em).toEqual({ min: EM, median: EM, max: EM });
    expect(result.replay?.labels).toEqual(["参照组(现行)"]);
    expect(result.replay?.kinds[0]).toEqual({ "回撤追踪": 1 });
    expect(result.replay?.main.usd[0]?.[0]).toBeCloseTo((3.0 - HALF - 2.25) * 100, 9);
    expect(bySimulate(mids, mids.map(() => 7010), 2.25, 1)).toBeCloseTo(55, 9);
  });

  it("三十条随机路径、每个情景 3 组(分批规则都走得到):工具给的与直接调 simulate 再换价的一样", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const next = rng(100 + seed);
      const mids: number[] = [r2(Math.round((1 + 2 * next()) * 20) / 20)], spots: number[] = [7010];
      for (let i = 1; i < CLOCK.length; i += 1) {
        mids.push(r2(Math.min(20, Math.max(0.6, mids[i - 1]! + 0.3 * normal(next) + 0.02))));
        spots.push(r2(spots[i - 1]! + 1.5 * normal(next)));
      }
      const samples = mids.map((m, i) => tick(DATE, CLOCK[i]!, m, spots[i]!));
      const override: Record<string, number> = seed % 2 ? {} : { stop: 0.4, zone_hold: 0.6 };
      const cfg = config({ population: onlyAt("09:35"), fill: { ...FILL, qty: 3 }, replay: { em: "auto", sets: replaySets(seed % 2 ? null : { stop: [0.4], zone_hold: [0.6] }) } });
      const result = runSweep(samples, cfg, tk);
      const debit = r2(mids[0]! + HALF), last = result.replay!.labels.length - 1;
      expect(result.replay!.main.usd[last]?.[0], `种子 ${seed}`).toBeCloseTo(bySimulate(mids, spots, debit, 3, override), 9);
      for (const k of Object.keys(result.replay!.kinds[last]!)) kinds.add(k);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3); // 止损、回撤追踪、区间规则、拿到最后——至少碰到过三种
  });

  it("入场价差很宽、入场那一笔的中间价已经在止损线上:不让回放在入场那一笔就止损(那是价差造的),和实盘预设同一个办法", () => {
    // 入场那一笔 7000C 9.50 / 11.00、7050C 0.70 / 1.30:中间价 1.15,立刻买得到 2.30(= D)。0.5 × D = 1.15 → 设不上;0.4 × D = 0.92 → 设得上。
    // 之后蝶价 1.4 → 3.0,从没低过入场时的中间价:两组都该拿到同一个结果
    const wide = tick(DATE, CLOCK[0]!, 0, 7010, [
      leg(7000, "C", 9.5, 11.0), leg(7025, "C", 5.0, 5.1), leg(7050, "C", 0.7, 1.3), leg(7010, "C", 14.0, 14.2), leg(7010, "P", 13.9, 14.1),
    ]);
    expect(flyQuote(wide, FLY)).toMatchObject({ mid: 1.15, open: 2.3 });
    const samples = [wide, ...[1.4, 1.8, 2.4, 3.0, 3.0, 3.0].map((m, i) => tick(DATE, CLOCK[i + 1]!, m, 7010))];
    const cfg = config({
      population: onlyAt("09:35"), replay: { em: 36, sets: replaySets({ stop: [0.4] }) }, live: liveSets(REF, { stop_mult: [0.5, 0.4] }),
    });
    const result = runSweep(samples, cfg, tk);
    expect(result.replay?.labels).toEqual(["参照组(现行)", "stop=0.4"]);
    expect(result.replay?.stop_refused).toEqual([1, 0]);
    expect(result.replay?.main.usd).toEqual([[expect.closeTo(50, 9)], [expect.closeTo(50, 9)]]); // (3.00 − 0.20 − 2.30) × 100
    expect(Object.keys(result.replay?.kinds[0] ?? {})).not.toContain("止损");
    expect(result.live.stop_refused).toEqual([0, 1, 0]); // 实盘预设:0.5×D 那一组同样设不上
    const words = formatReport(result, summarise(result, "usd", BOOT)).join("\n");
    expect(words).toContain("回放会在入场那一笔就止损(那是入场价差造出来的);这些情景按不设止损算");
  });

  it("EM 是当天晚些时候才取到的:更早的入场不做回放(那是入场时还不知道的东西),数出来", () => {
    const mids = [2.05, 2.6, 3.2, 3.6, 3.0, 2.9];
    const bare = (i: number): IvSample =>
      tick(DATE, CLOCK[i]!, mids[i]!, 7010, [leg(7000, "C", r2(mids[i]! + 9.0), r2(mids[i]! + 9.1)), leg(7025, "C", 5.0, 5.1), leg(7050, "C", 1.0, 1.1)]);
    // 前两笔没有平值的那一对,第三笔起才有
    const samples = mids.map((m, i) => (i < 2 ? bare(i) : tick(DATE, CLOCK[i]!, m, 7010)));
    const result = runSweep(samples, config({ replay: { em: "auto", sets: replaySets(null) } }), tk);
    expect(result.skipped).toMatchObject({ "回放:入场早于当天取到 EM 的那一笔": 2 });
    expect([result.live.scenarios, result.replay?.scenarios]).toEqual([[5], [3]]);
  });

  it("缺报价的那一笔不喂给它(喂了它会拿模型价补);提前收盘日不做;也可以给一个固定的 EM", () => {
    const mids = [2.05, 2.6, 3.2, 3.6, 3.0, 2.9];
    const samples = mids.map((m, i) => tick(DATE, CLOCK[i]!, m, 7010));
    const broken = tick(DATE, CLOCK[4]!, 0, 7010, [leg(7000, "C", 12, 12.1), leg(7025, "C", 5, null), leg(7050, "C", 1, 1.1)]);
    const holed = samples.map((s, i) => (i === 4 ? broken : s));
    const cfg = config({ population: onlyAt("09:35"), replay: { em: 36, sets: replaySets(null) } });
    // 3.00 那一笔没有了:到 2.90 才看到回吐
    expect(runSweep(holed, cfg, tk).replay?.main.usd[0]?.[0]).toBeCloseTo((2.9 - HALF - 2.25) * 100, 9);
    expect(runSweep(samples, cfg, tk).replay?.em).toEqual({ min: 36, median: 36, max: 36 });
    const early = runSweep(mids.map((m, i) => tick("2026-11-27", CLOCK[i]!, m, 7010)), cfg, tk);
    expect([early.replay?.days, early.replay?.days_without_em, early.live.days]).toEqual([[], 1, ["2026-11-27"]]);
  });

  it("网格:flyexit.DEFAULTS 上的键;与默认值相同的组合不重复;不认识的键、em、不对的取值当场拒", () => {
    expect(replaySets({ stop: [0.4, 0.5], trail_arm: [1.3, 1.5] })).toEqual([{}, { stop: 0.4, trail_arm: 1.3 }, { stop: 0.4, trail_arm: 1.5 }, { stop: 0.5, trail_arm: 1.5 }]);
    expect(() => replaySets({ stopp: [0.4] })).toThrow(SweepError);
    expect(() => replaySets({ em: [30] })).toThrow(/em/);
    expect(() => replaySets({ stop: [-1] })).toThrow(SweepError);
    expect(() => replaySets({ cutoff_a: ["25:00"] })).toThrow(SweepError);
    expect(replaySets({ cutoff_a: ["13:30"] })).toEqual([{}, { cutoff_a: "13:30" }]);
  });
});

// ---------------------------------------------------------------- 网格与统计的零件
describe("参数网格", () => {
  it("给了取值的几项做全部组合,没给的用参照组的;第一组永远是参照组;重复的只算一次", () => {
    const sets = liveSets(REF, { arm_usd: [50, 100], tighten_usd: [200, 300] }, [{ arm_usd: 50 }, { floor: 0.3 }]);
    expect(sets.map((p) => liveLabel(p, REF))).toEqual(["参照组(现行)", "起算 $50", "起算 $50 · 收紧 $300", "收紧 $300", "最少回吐 0.3"]);
    expect(liveSets(REF, null)).toEqual([REF]);
    expect(liveLabel({ ...REF, loose_pct: 50, late_factor: 1, tight_at: 4 }, REF)).toBe("档位 50/30/20 · 第三档 4×成本起 · 15:00 后 ×1");
  });

  it("说不通的取值当场拒:止损倍数不在 0–1、钟点写错、百分比出界", () => {
    expect(() => liveSets(REF, { stop_mult: [1.2] })).toThrow(/止损倍数/);
    expect(() => liveSets(REF, { exit_at: ["3pm"] })).toThrow(/到点平仓/);
    expect(() => liveSets(REF, { tiers: [[40, 30, 0]] })).toThrow(SweepError);
    expect(() => liveSets(REF, { late_after: ["15"] })).toThrow(SweepError);
    // 从命令行、JSON 来的键名写错了:当场拒,不悄悄忽略
    expect(() => liveSets(REF, { arm: [50] } as object)).toThrow(/没有「arm」/);
    expect(() => liveSets(REF, null, [{ stop: 0.5 } as object])).toThrow(/没有「stop」/);
    expect(() => liveSets({ ...REF, stop_multiple: 0.5 } as LiveParams, null)).toThrow(/参照组里没有「stop_multiple」/);
    expect(() => runSweep([], config({ stride: 0 }), tk)).toThrow(SweepError);
    expect(() => runSweep([], config({ fill: { ...FILL, entry_spread_share: 1.5 } }), tk)).toThrow(SweepError);
  });

  it("文件里写错的键名、看不懂的值当场拒:网格文件的顶层、真实入场的每一项、字符串冒充的数", () => {
    expect(gridFileFrom({ live: { arm_usd: [50] }, sets: [{ floor: 0.3 }], replay: { stop: [0.4] } })).toEqual({
      live: { arm_usd: [50] }, sets: [{ floor: 0.3 }], replay: { stop: [0.4] },
    });
    expect(gridFileFrom({})).toEqual({ live: {}, sets: [], replay: {} });
    expect(() => gridFileFrom({ lives: { arm_usd: [50] } })).toThrow(/网格文件里没有「lives」/);
    expect(() => gridFileFrom({ set: [{}] })).toThrow(/没有「set」/);
    expect(() => gridFileFrom({ live: { arm_usd: 50 } })).toThrow(/arm_usd 的取值要写成数组/);
    expect(() => gridFileFrom([1])).toThrow(SweepError);
    expect(() => liveSets(REF, { arm_usd: ["50"] } as object)).toThrow(/取值类型不对/);
    expect(entriesFrom([{ time: "2026-03-02 10:32", center: 7025, wing: 25, right: "c", quantity: 2, debit: 2.1 }])).toEqual([
      { t: at("2026-03-02", "10:32"), center: 7025, wing: 25, right: "C", quantity: 2, debit: 2.1 },
    ]);
    expect(() => entriesFrom([{ time: "2026-03-02 10:32", center: 7025, wing: 25, right: "C", qty: 2 }])).toThrow(/第 1 笔里没有「qty」/);
    expect(() => entriesFrom([{ time: "2026-03-02 10:32", center: 7025, wing: 25, right: "C", price: 2.1 }])).toThrow(/没有「price」/);
    expect(() => entriesFrom([{ time: "上午十点", center: 7025, wing: 25, right: "C" }])).toThrow(/time 看不懂/);
    expect(() => entriesFrom([{ time: "2026-03-02 10:32", center: 7025, wing: 25, right: "X" }])).toThrow(/right/);
    expect(() => entriesFrom([{ time: "2026-03-02 10:32", center: 7025, wing: 25, right: "C", quantity: 1.5 }])).toThrow(/quantity/);
    expect(() => entriesFrom({ time: "2026-03-02 10:32" })).toThrow(/数组/);
  });

  it("金额线换成倍数:$50 / $300 对 $225 的蝶 → 起算 0.222222、收紧 1.333333;便宜的蝶第三档排不到收紧线之后就去掉", () => {
    const t = liveTargets({ ...REF, arm_usd: 50, tighten_usd: 300, stop_mult: 0.5, exit_at: "15:30" }, 225, 2.25, at("2026-03-02", "10:00"));
    expect(t.profit_drawdown_arm).toBe(0.222222);
    expect(t.profit_drawdown_tiers).toEqual([{ above: 0, pct: 40 }, { above: 1.333333, pct: 30 }, { above: 3, pct: 20 }]);
    expect([t.stop_loss, t.exit_at, t.exit_at_ms]).toEqual([1.125, "15:30", at("2026-03-02", "15:30")]);
    expect(liveTargets(REF, 50, 0.5, 0).profit_drawdown_tiers).toEqual([{ above: 0, pct: 40 }, { above: 4, pct: 30 }]);
  });
});

describe("统计的零件", () => {
  it("重抽到的全是同一个值的概率:四天里三天是 0 → (3/4)^4 + (1/4)^4;四天各不相同 → 4 × (1/4)^4", () => {
    expect(degenerateProb([0, 0, 0, 1])).toBeCloseTo(0.75 ** 4 + 0.25 ** 4, 12);
    expect(degenerateProb([1, 2, 3, 4])).toBeCloseTo(4 * 0.25 ** 4, 12);
    expect(degenerateProb([5])).toBe(1);
  });

  it("每天都好 1 上下的一组:见过的这些天上领先;最多能差 1.5 时下界也转正,能差 30 时转不了;只有一天的数据什么都给不出", () => {
    const next = rng(3);
    const base = Array.from({ length: 15 }, () => normal(next));
    const rows = [base, base.map((b) => b + 1 + 0.2 * normal(next)), base.map((b) => b - 1 + 0.2 * normal(next))];
    const a = analyse(rows, 0, { ...BOOT, cap: 1.5 });
    expect(a.sets[0]).toMatchObject({ diff: 0, eligible: false, band: null, exact: null });
    expect(a.sets[1]!.diff).toBeCloseTo(1, 0);
    expect([a.sets[1]!.wins, a.sets[2]!.losses, a.top, a.ahead, a.behind, a.better, a.worse]).toEqual([15, 15, 1, [1], [2], [1], [2]]);
    expect(a.sets[1]!.band![0]!).toBeLessThan(a.sets[1]!.ci![0]!);
    expect(a.sets[1]!.exact![0]!).toBeLessThan(a.sets[1]!.band![0]!);
    expect(a.alpha_tail).toBeCloseTo(0.025 / 2 / 2, 12); // 两组平分一头的 2.5% 再对半
    expect(a.min_days).toBe(8); // floor(log₂ 160) + 1
    const far = analyse(rows, 0, { ...BOOT, cap: 30 });
    expect([far.ahead, far.better, far.worse]).toEqual([[1], [], []]);
    expect(verdictOf(far, []).state).toBe("unproven");
    const blind = analyse(rows, 0, BOOT); // 不知道一天最多能差多少:下界给不出,也就没有结论
    expect([blind.cap, blind.sets[1]!.exact, blind.better, verdictOf(blind, []).state]).toEqual([null, null, [], "unproven"]);
    const one = analyse([[1], [2]], 0, { ...BOOT, cap: 5 });
    expect([one.eligible, one.critical, one.ahead, one.better, one.split, one.sets[1]!.exact]).toEqual([0, null, [], [], [], null]);
    expect(verdictOf(one, []).state).toBe("not_separated");
    expect(verdictOf(analyse([[1, 2, 3]], 0, BOOT), []).state).toBe("nothing_to_compare");
  });

  it("四天、每天都赢一点(审查时举的例子):见过的这些天上的区间在 0 之上,但说不了更好", () => {
    const a = analyse([[0, 0, 0, 0], [0.21, 0.25, 0.28, 0.22]], 0, { level: 0.95, draws: 2000, seed: 1, cap: 25 });
    expect(a.ahead).toEqual([1]);
    expect(a.better).toEqual([]);
    expect(a.sets[1]!.unseen).toBeCloseTo(1 - Math.pow(0.0125, 0.25), 12); // 四天排除不了的那种天:六成多
    expect([a.min_days, verdictOf(a, []).state]).toEqual([7, "unproven"]);
  });

  it("只有一半的天撑着的领先不算:单数天大赢、双数天小输,下界在 0 之上也只是 fragile", () => {
    const base = Array.from({ length: 40 }, () => 0);
    const a = analyse([base, base.map((_b, j) => (j % 2 === 0 ? 2 : -0.1))], 0, { ...BOOT, cap: 0.2 });
    expect(a.better).toEqual([1]);
    expect(a.sets[1]!.halves).toEqual([2, expect.closeTo(-0.1, 12)]);
    expect(verdictOf(a, [{ name: CHECK_COARSE, diffs: [0, 1] }])).toEqual({ state: "fragile", set: 1, failed: [CHECK_HALVES] });
  });

  it("没有界的那一头写成 null(进得了 JSON),不写无穷大", () => {
    // 五天里三天是 0:重抽到全 0 的机会 (3/5)^5 ≈ 7.8% 超过 5% → 不给区间;换成 90% 的水平就给,但下界那一头没有界
    const rows = [[0, 0, 0, 0, 0], [0, 0, 0, 1, 2]];
    expect(analyse(rows, 0, BOOT).sets[1]).toMatchObject({ eligible: false, ci: null, band: null });
    const loose = analyse(rows, 0, { ...BOOT, level: 0.8 });
    expect(loose.sets[1]!.eligible).toBe(true);
    expect(JSON.stringify(loose)).not.toContain("Infinity");
    expect(JSON.parse(JSON.stringify(loose))).toEqual(loose);
  });
});
