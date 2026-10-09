/** 回测的成交口径、统计、期权估价、成交成本与参数扫描(backtest.ts、backtestLab.ts):纯计算,离线。
 *  golden-backtest 的那段日线没有跳空(开盘 = 前收),分不出"收盘成交"和"次日开盘成交";这里用带跳空的手算例子钉。 */
import { describe, expect, it } from "vitest";

import {
  BacktestError, MIN_OPTION_TICK, VOL_WINDOW, bsPrice, evaluateSegment, heldAfterOpen, runBacktest, signalPositions, strikeStep,
  trailingSessionShare, trailingVol,
} from "../src/backtest.js";
import type { Bar } from "../src/backtest.js";
import { alignSeries, checkGrid, gridCombos, runSweep, spearman, spearmanP } from "../src/backtestLab.js";
import type { SweepInput } from "../src/backtestLab.js";
import type { CustomRules } from "../src/contract/backtest.js";
import { loadGolden } from "./util.js";

/** 缓慢上行叠一个正弦:均线会来回交叉。`phase` 让几只标的不完全一样。 */
function bars(count = 400, phase = 0, drift = 0.05): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse("2024-01-02T00:00:00Z");
  for (; out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const n = out.length;
    const close = Math.round((100 + 12 * Math.sin((n + phase) / 9) + n * drift) * 100) / 100;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: close - 0.3, high: close + 1.2, low: close - 1.1, close });
  }
  return out;
}

const STOCK = { type: "stock" as const, dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
const input = (over: Partial<SweepInput> = {}): SweepInput => ({
  series: [{ symbol: "AAA", bars: bars() }],
  strategy: "sma_cross",
  grid: { fast: [5, 10, 20], slow: [20, 40, 60] },
  instrument: STOCK,
  costPct: 0,
  splitPct: 70,
  folds: 0,
  objective: "return",
  ...over,
});

/** 五根带跳空的日线:第 0 根收盘出买入信号、第 2 根收盘出卖出信号。开盘价和前收差得很开,成交在哪一目了然。 */
const GAPPY: Bar[] = [
  { date: "2025-03-03", open: 100, high: 101, low: 99, close: 100 },
  { date: "2025-03-04", open: 102, high: 105, low: 101, close: 104 },
  { date: "2025-03-05", open: 103, high: 104, low: 100, close: 101 },
  { date: "2025-03-06", open: 99, high: 100, low: 97, close: 98 },
  { date: "2025-03-07", open: 98, high: 101, low: 97, close: 100 },
];
const STOCK_INST = { type: "stock" };
const settle = (bars: Bar[], held: number[], costPct = 0, inst: Record<string, unknown> = STOCK_INST) =>
  evaluateSegment({ bars, held, strategy: "custom", params: {}, inst, costPct });
/** 收盘恰好 = 100 时买,收盘 < 102 时卖:在 GAPPY 上的信号是 [1, 1, 0, 0, 1] */
const AT_100: CustomRules = {
  entry: [
    { left: { kind: "indicator", name: "close", period: null, value: null }, op: ">=", right: { kind: "const", name: null, period: null, value: 100 } },
    { left: { kind: "indicator", name: "close", period: null, value: null }, op: "<=", right: { kind: "const", name: null, period: null, value: 100 } },
  ],
  exit: [{ left: { kind: "indicator", name: "close", period: null, value: null }, op: "<", right: { kind: "const", name: null, period: null, value: 102 } }],
};

describe("成交口径:收盘出信号,下一根开盘成交", () => {
  it("持仓比信号晚一根;第 0 根一定空仓;最后一根的信号不成交", () => {
    expect(heldAfterOpen([1, 1, 0, 1])).toEqual([0, 1, 1, 0]);
    expect(heldAfterOpen([0, 0, 1])).toEqual([0, 0, 0]);
  });

  it("买在下一根的开盘价、卖在下一根的开盘价:跳空算在自己头上", () => {
    const r = runBacktest(GAPPY, "custom", null, AT_100);
    // 102 买进(不是信号那根的收盘 100)、99 卖出(不是 101):收盘成交会算成 +1%,实际是 −2.94%
    expect(r.trade_list).toEqual([
      { entry_date: "2025-03-04", exit_date: "2025-03-06", entry_price: 102, exit_price: 99, return_pct: -2.94, closed: true },
    ]);
    expect(r.total_return_pct).toBe(-2.94);
    expect(r.curve.map((pt) => pt.equity)).toEqual([1, 1.0196, 0.9902, 0.9706, 0.9706]);
    expect(r.exposure_pct).toBe(40);
    // 最后一根收盘又出了买入信号:没有下一根,不成交,写明
    expect(r.trades).toBe(1);
    expect(r.notes?.[0]).toBe("2025-03-07 收盘出了买入信号,要到下一个交易日开盘才成交,不在这次的结果里");
  });

  it("基准是同一个口径下的买入持有:第 1 根开盘买进;「买入持有」策略不扣成本时和它逐位相同", () => {
    const r = runBacktest(GAPPY, "buy_hold");
    expect(r.buy_hold_return_pct).toBe(-1.96); // 100 / 102 − 1,不是 100 / 100 − 1
    expect(r.total_return_pct).toBe(r.buy_hold_return_pct);
    expect(r.excess_return_pct).toBe(0);
    expect(r.curve.map((pt) => pt.equity)).toEqual(r.curve.map((pt) => pt.bench));
    const b = bars();
    const big = runBacktest(b, "buy_hold");
    expect(big.total_return_pct).toBe(big.buy_hold_return_pct);
    expect(big.buy_hold_return_pct).toBeCloseTo((b[b.length - 1]!.close / b[1]!.open - 1) * 100, 2);
    // 扣成本:买进付一次,基准不付
    const net = runBacktest(GAPPY, "buy_hold", null, null, null, 1);
    expect(net.total_return_pct).toBeCloseTo(((100 / 102) * 0.99 - 1) * 100, 2);
    expect(net.excess_return_pct).toBe(Math.round((net.total_return_pct - net.buy_hold_return_pct) * 100) / 100);
  });

  it("成本在开盘换仓时付;单笔收益买卖各扣一次", () => {
    const r = runBacktest(GAPPY, "custom", null, AT_100, null, 1);
    expect(r.total_return_pct).toBeCloseTo(((99 / 102) * 0.99 * 0.99 - 1) * 100, 2);
    expect(r.trade_list[0]!.return_pct).toBe(r.total_return_pct);
  });

  it("切出来的一截:起点那根收盘时已经持有的,按它的收盘价建仓;之后照常在开盘换仓", () => {
    // 整段上第 1 根起持有、第 3 根开盘卖:从第 1 根切,它是起点
    const r = evaluateSegment({ bars: GAPPY, held: [0, 1, 1, 0, 0], strategy: "custom", params: {}, inst: STOCK_INST, lo: 1, hi: 5 });
    expect(r.bars).toBe(4);
    expect(r.start).toBe("2025-03-04");
    expect(r.trade_list[0]).toMatchObject({ entry_date: "2025-03-04", entry_price: 104, exit_date: "2025-03-06", exit_price: 99 });
    expect(r.total_return_pct).toBeCloseTo((99 / 104 - 1) * 100, 2);
    expect(r.buy_hold_return_pct).toBeCloseTo((100 / 104 - 1) * 100, 2); // 起点不在整段开头:基准从起点的收盘价拿起
  });

  it("没有开盘价的日线当场拒,不拿收盘价顶", () => {
    const broken = GAPPY.map((b, i) => (i === 2 ? { ...b, open: 0 } : b));
    expect(() => runBacktest(broken, "buy_hold")).toThrowError("2025-03-05 这根日线没有有效的开盘价");
  });
});

describe("统计:从逐日全量净值算,交易只数已平仓的", () => {
  it("Sharpe / Sortino / 年化波动对得上手算(无风险利率 0、√252)", () => {
    const r = runBacktest(GAPPY, "custom", null, AT_100);
    const equity = [1, 104 / 102, 101 / 102, 99 / 102, 99 / 102];
    const rets = equity.slice(1).map((v, i) => v / equity[i]! - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    const down = Math.sqrt(rets.reduce((a, b) => a + (b < 0 ? b * b : 0), 0) / rets.length);
    expect(r.volatility_pct).toBeCloseTo(sd * Math.sqrt(252) * 100, 2);
    expect(r.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(252), 2);
    expect(r.sortino).toBeCloseTo((mean / down) * Math.sqrt(252), 2);
    // 在场的三天(第 1、2 根,和开盘卖出的第 3 根)单日变动的均方根
    expect(r.held_days).toBe(3);
    expect(r.held_day_move_pct).toBeCloseTo(Math.sqrt((rets[0]! ** 2 + rets[1]! ** 2 + rets[2]! ** 2) / 3) * 100, 4);
    expect(r.days).toBe(4);
    expect(r.notes?.some((n) => n.includes("区间只有 4 天,不满一年"))).toBe(true);
  });

  it("一直空仓:波动是 0,Sharpe / Sortino 没有定义", () => {
    const r = settle(GAPPY, [0, 0, 0, 0, 0]);
    expect(r).toMatchObject({ total_return_pct: 0, volatility_pct: 0, sharpe: null, sortino: null, held_days: 0, held_day_move_pct: null, trades: 0, win_rate_pct: null });
  });

  it("胜率不算还开着的那一笔:一笔亏损已平 + 一笔浮盈未平 = 胜率 0", () => {
    const r = settle(GAPPY, [0, 1, 1, 0, 1]); // 102 → 99 平掉(亏);98 再买,收在 100(浮盈)
    expect(r.trades).toBe(2);
    expect(r.closed_trades).toBe(1);
    expect(r.trade_list[1]).toMatchObject({ closed: false, exit_date: null, entry_price: 98, exit_price: 100, return_pct: 2.04 });
    expect(r.win_rate_pct).toBe(0);
    expect(r).toMatchObject({ avg_win_pct: null, avg_loss_pct: -2.94, payoff_ratio: null, profit_factor: 0, expectancy_pct: -2.94 });
    // 只有没平的:什么都不算
    expect(settle(GAPPY, [0, 1, 1, 1, 1])).toMatchObject({ trades: 1, closed_trades: 0, win_rate_pct: null, expectancy_pct: null, profit_factor: null });
  });

  it("平均盈亏、盈亏比、盈利因子、期望:三笔已平仓的手算", () => {
    const px = [[100, 100], [100, 110], [110, 108], [120, 121], [121, 119], [115, 118], [118, 117], [112, 110]];
    const b: Bar[] = px.map(([open, close], i) => ({ date: `2025-04-${String(i + 1).padStart(2, "0")}`, open: open!, high: 130, low: 90, close: close! }));
    // 100 → 110(+10%)、120 → 115(−4.1667%)、118 → 112(−5.0847%)
    const r = settle(b, [0, 1, 0, 1, 1, 0, 1, 0]);
    const rets = [110 / 100 - 1, 115 / 120 - 1, 112 / 118 - 1];
    expect(r.closed_trades).toBe(3);
    expect(r.win_rate_pct).toBe(33.3);
    expect(r.avg_win_pct).toBe(10);
    expect(r.avg_loss_pct).toBeCloseTo(((rets[1]! + rets[2]!) / 2) * 100, 2);
    expect(r.payoff_ratio).toBeCloseTo(rets[0]! / -((rets[1]! + rets[2]!) / 2), 2);
    expect(r.profit_factor).toBeCloseTo(rets[0]! / -(rets[1]! + rets[2]!), 2);
    expect(r.expectancy_pct).toBeCloseTo(((rets[0]! + rets[1]! + rets[2]!) / 3) * 100, 2);
  });
});

/** 期权用的日线:工作日、开盘和前收有个小跳空;价位在 100 上下,标准行权价间隔是 5。 */
function optionBars(count = 80): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse("2025-01-06T00:00:00Z"); // 周一
  for (; out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const n = out.length;
    const close = Math.round((103 + 6 * Math.sin(n / 5) + 0.9 * Math.sin(n * 1.7)) * 100) / 100;
    const open = Math.round((close - 0.6 * Math.cos(n * 2.3)) * 100) / 100;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close });
  }
  return out;
}
const ordinal = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
/** 建仓日 + dte 天之内的最后一根日线(到期日落在周末、假日时往前挪到的那一天) */
function lastBarWithin(b: Bar[], entryIdx: number, dte: number): number {
  let k = entryIdx;
  while (k + 1 < b.length && ordinal(b[k + 1]!.date) <= ordinal(b[entryIdx]!.date) + dte) k += 1;
  return k;
}
const CALL = { type: "call", dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
/** 到第 i 根为止的 20 根日线上,开盘到收盘那一段占一个交易日方差的多少。这里另算一遍,不从被测代码里拿 */
function sessionShareAt(b: Bar[], i: number): number {
  let session = 0;
  let whole = 0;
  for (let k = i - 19; k <= i; k += 1) {
    session += Math.log(b[k]!.close / b[k]!.open) ** 2;
    whole += Math.log(b[k]!.close / b[k - 1]!.close) ** 2;
  }
  return session / whole;
}
/** 时间口径:交易日 ÷ 252。开盘成交 = 到到期那一根还有几根 + 当天开盘到收盘那一段 */
const yearsAtOpen = (b: Bar[], i: number, expiryIdx: number): number => (expiryIdx - i + sessionShareAt(b, i - 1)) / 252;
const yearsAtClose = (i: number, expiryIdx: number): number => (expiryIdx - i) / 252;

/** 确定性的伪随机数与正态数:模拟路径用,同样的种子永远是同一条路径 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
/**
 * 已知答案的世界:价格是鞅,**每个交易日的方差一样大**(年化 sigma),其中 overnight 那一份落在前收 → 开盘;
 * 日历是工作日、每 29 个工作日放一天假。在这个世界里按"公平价"买期权持有到期,平均盈亏是 0。
 */
function martingaleBars(count: number, seed: number, sigma: number, overnight: number, s0: number): Bar[] {
  const random = seeded(seed);
  const out: Bar[] = [];
  const vNight = (sigma * sigma * overnight) / 252;
  const vDay = (sigma * sigma * (1 - overnight)) / 252;
  let prev = s0;
  let weekdays = 0;
  for (let t = Date.parse("2015-01-05T00:00:00Z"); out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    weekdays += 1;
    if (weekdays % 29 === 0) continue;
    const open = prev * Math.exp(-vNight / 2 + Math.sqrt(vNight) * gauss(random));
    const close = open * Math.exp(-vDay / 2 + Math.sqrt(vDay) * gauss(random));
    out.push({ date: new Date(t).toISOString().slice(0, 10), open, high: Math.max(open, close), low: Math.min(open, close), close });
    prev = close;
  }
  return out;
}

describe("期权估价", () => {
  it("已实现波动率:逐日、只看到当天为止;不满 20 个日收益是 null,不给默认值", () => {
    const closes = optionBars(40).map((b) => b.close);
    const vol = trailingVol(closes);
    expect(vol.slice(0, VOL_WINDOW).every((v) => v === null)).toBe(true);
    const rets = closes.slice(11, 31).map((c, k) => Math.log(c / closes[10 + k]!));
    const mean = rets.reduce((a, b) => a + b, 0) / 20;
    expect(vol[30]).toBeCloseTo(Math.sqrt((rets.reduce((a, b) => a + (b - mean) ** 2, 0) / 19) * 252), 12);
    // 后面的价格怎么变,前面的值不动
    expect(trailingVol([...closes.slice(0, 31), 500])[30]).toBe(vol[30]);
    expect(trailingVol([100, 101, 102])).toEqual([null, null, null]);
  });

  it("历史不够算出哪怕一个波动率:整次回测拒掉,写明要多少根", () => {
    expect(() => runBacktest(optionBars(VOL_WINDOW), "buy_hold", null, null, CALL))
      .toThrowError(`期权估价要用近 20 日已实现波动率,这里只有 20 根日线,一个值都算不出来(至少 21 根)。把开始日期往前挪`);
    // 正股不需要波动率
    expect(runBacktest(optionBars(VOL_WINDOW), "buy_hold").trades).toBe(1);
  });

  it("波动率还没有的那些天不开仓并写明;有了之后按开盘价、上一根收盘为止的波动率、贴档的行权价、交易日口径的时间建仓", () => {
    const b = optionBars();
    const vol = trailingVol(b.map((x) => x.close));
    const r = runBacktest(b, "buy_hold", null, null, CALL);
    // 第 1~20 根想持仓(买入持有)却没有波动率:第 21 根开盘才开得成
    expect(r.notes?.some((n) => n.includes("有 20 根日线策略要持仓却没开成") && n.includes("算不出波动率"))).toBe(true);
    const first = r.trade_list[0]!;
    expect(first.entry_date).toBe(b[21]!.date);
    const strike = Math.round(b[21]!.open / 5) * 5;
    expect(first.strikes).toEqual([strike]);
    // 到期日 = 建仓日 + 30 天,落在周末就往前挪到周五;时间按交易日数,开盘成交再加当天开盘到收盘那一段
    const expiryIdx = lastBarWithin(b, 21, 30);
    expect(first.entry_price).toBeCloseTo(bsPrice(b[21]!.open, strike, yearsAtOpen(b, 21, expiryIdx), vol[20]!, "C"), 4);
    expect(first).toMatchObject({ exit_date: b[expiryIdx]!.date, exit_reason: "expiry", closed: true });
    expect(first.exit_price).toBeCloseTo(Math.max(b[expiryIdx]!.close - strike, 0), 4);
    // 到期之后信号还在:下一根开盘按新的行权价再开
    expect(r.trade_list[1]!.entry_date).toBe(b[expiryIdx + 1]!.date);
  });

  it("到期日落在周末:往前挪到周五结算,时间只数到周五为止的交易日;不拖到周一", () => {
    const b = optionBars();
    const vol = trailingVol(b.map((x) => x.close));
    expect(b[21]!.date).toBe("2025-02-04"); // 周二;+32 天 = 3 月 8 日,周六
    const first = runBacktest(b, "buy_hold", null, null, { ...CALL, dte: 32 }).trade_list[0]!;
    expect(first).toMatchObject({ entry_date: "2025-02-04", exit_date: "2025-03-07", exit_reason: "expiry" });
    const fridayIdx = b.findIndex((x) => x.date === "2025-03-07");
    expect(fridayIdx - 21).toBe(23); // 23 个交易日,不是 31 个日历日
    expect(first.entry_price).toBeCloseTo(bsPrice(b[21]!.open, first.strikes![0]!, yearsAtOpen(b, 21, fridayIdx), vol[20]!, "C"), 4);
    const friday = b[fridayIdx]!;
    expect(first.exit_price).toBeCloseTo(Math.max(friday.close - first.strikes![0]!, 0), 4);
  });

  it("到期日在数据结束之后:中间有几个交易日无从知道,按这段日线自己「每个日历日折几个交易日」的比例折", () => {
    const b = optionBars(40);
    const vol = trailingVol(b.map((x) => x.close));
    const open = runBacktest(b, "buy_hold", null, null, { ...CALL, dte: 60 }).trade_list[0]!;
    expect(open).toMatchObject({ entry_date: b[21]!.date, closed: false, exit_reason: "open" });
    const lastDay = ordinal(b[39]!.date);
    const perDay = 39 / (lastDay - ordinal(b[0]!.date)); // 39 个交易日的间隔 ÷ 首尾的日历天数
    const beyond = (ordinal(b[21]!.date) + 60 - lastDay) * perDay;
    expect(beyond).toBeGreaterThan(20);
    // 建仓:数据里还剩 18 根,再加数据之后折出来的那些,再加当天开盘到收盘那一段
    expect(open.entry_price).toBeCloseTo(bsPrice(b[21]!.open, open.strikes![0]!, (18 + beyond + sessionShareAt(b, 20)) / 252, vol[20]!, "C"), 4);
    // 最后一根收盘的浮动价:只剩数据之后那一段
    expect(open.exit_price).toBeCloseTo(bsPrice(b[39]!.close, open.strikes![0]!, beyond / 252, vol[39]!, "C"), 4);
  });

  it("持仓每天按当天的波动率重估,不冻结在建仓那天", () => {
    const b = optionBars();
    const vol = trailingVol(b.map((x) => x.close));
    // 只看第一笔:第 21 根开盘买进,之后按"净值 = 1 + 投入比例 × (现值 ÷ 成本 − 1)"逐日对
    const r = evaluateSegment({ bars: b, held: heldAfterOpen(b.map(() => 1)), strategy: "buy_hold", params: {}, inst: CALL, hi: 30 });
    const t = r.trade_list[0]!;
    const strike = t.strikes![0]!;
    const expiryIdx = lastBarWithin(b, 21, 30);
    const cost = bsPrice(b[21]!.open, strike, yearsAtOpen(b, 21, expiryIdx), vol[20]!, "C");
    for (const i of [21, 25, 29]) {
      const today = 1 + 0.1 * (bsPrice(b[i]!.close, strike, yearsAtClose(i, expiryIdx), vol[i]!, "C") / cost - 1);
      expect(r.curve[i]!.equity).toBeCloseTo(today, 4);
    }
    // 冻结在建仓那天的波动率会得出另一个数:这段里波动率确实动过
    const frozen = 1 + 0.1 * (bsPrice(b[29]!.close, strike, yearsAtClose(29, expiryIdx), vol[20]!, "C") / cost - 1);
    expect(Math.abs(frozen - r.curve[29]!.equity)).toBeGreaterThan(0.0005);
  });

  it("开盘到收盘占一个交易日方差的多少:从日线量,逐日、只看到当天为止;不按钟点折", () => {
    // 没有跳空(开盘 = 前收):一天的波动全在盘中 → 1;开盘就是收盘:全在隔夜 → 0
    const flat = optionBars(30).map((x, i, all) => ({ ...x, open: i === 0 ? x.open : all[i - 1]!.close }));
    expect(trailingSessionShare(flat)[25]).toBeCloseTo(1, 12);
    expect(trailingSessionShare(optionBars(30).map((x) => ({ ...x, open: x.close })))[25]).toBe(0);
    const b = optionBars(40);
    const share = trailingSessionShare(b);
    expect(share.slice(0, VOL_WINDOW).every((v) => v === null)).toBe(true);
    expect(share[30]).toBeCloseTo(sessionShareAt(b, 30), 12);
    // 后面的日线怎么变,前面的值不动
    expect(trailingSessionShare([...b.slice(0, 31), { ...b[31]!, open: 1, close: 999 }])[30]).toBe(share[30]);
    // 已知答案:四分之一的方差在隔夜的世界里,量出来在 0.75 上下
    const world = trailingSessionShare(martingaleBars(4000, 11, 0.2, 0.25, 100)).filter((v): v is number => v !== null);
    expect(world.reduce((x, y) => x + y, 0) / world.length).toBeCloseTo(0.75, 1);
  });

  /**
   * 时间口径对不对,不拿实现自己的数来对,拿已知答案来对:在"每个交易日方差一样大"的鞅上,把真实波动率交给模型,
   * 每次按模型价买一手平值跨式(同一行权价的看涨 + 看跌,涨跌的偶然性互相抵掉)持有到期。价要是公平的,
   * Σ到期所得 ÷ Σ权利金 − 1 应当在抽样误差之内;同一批成交按"日历天 ÷ 365、开盘多算 6.5 小时"重新定价,偏差应当远在误差之外。
   */
  function straddleBias(dte: number, runs: number, ownVol: boolean) {
    const sigma = 0.15;
    const pnl: number[] = [];
    let premium = 0;
    let payoff = 0;
    let calendarPremium = 0;
    for (let run = 1; run <= runs; run += 1) {
      const b = martingaleBars(260, run * 104_729 + dte, sigma, 0.25, 5000);
      const open = new Map(b.map((x) => [x.date, x.open]));
      const leg = (type: string) => {
        const inst = { type, dte, offset_pct: 0, width_pct: 2, risk_pct: 1 };
        const r = ownVol
          ? runBacktest(b, "buy_hold", null, null, inst)
          : evaluateSegment({ bars: b, held: heldAfterOpen(b.map(() => 1)), strategy: "buy_hold", params: {}, inst, vol: b.map(() => sigma) });
        return r.trade_list.filter((t) => t.exit_reason === "expiry");
      };
      const puts = new Map(leg("put").map((t) => [t.entry_date, t]));
      for (const call of leg("call")) {
        const put = puts.get(call.entry_date);
        if (put === undefined) continue;
        expect(put.strikes).toEqual(call.strikes);
        premium += call.entry_price + put.entry_price;
        payoff += call.exit_price + put.exit_price;
        pnl.push(call.exit_price + put.exit_price - call.entry_price - put.entry_price);
        const calendarYears = (ordinal(call.exit_date!) - ordinal(call.entry_date) + 6.5 / 24) / 365;
        const k = call.strikes![0]!;
        const s0 = open.get(call.entry_date)!;
        calendarPremium += bsPrice(s0, k, calendarYears, sigma, "C") + bsPrice(s0, k, calendarYears, sigma, "P");
      }
    }
    const mean = pnl.reduce((x, y) => x + y, 0) / pnl.length;
    const sd = Math.sqrt(pnl.reduce((x, y) => x + (y - mean) ** 2, 0) / (pnl.length - 1));
    return {
      trades: pnl.length,
      bias: payoff / premium - 1,
      se: sd / Math.sqrt(pnl.length) / (premium / pnl.length),
      calendarBias: payoff / calendarPremium - 1,
    };
  }

  it("时间口径对得上已知答案:每个交易日方差相同的鞅上,按模型价买进持有到期,平均盈亏在抽样误差之内", () => {
    for (const dte of [1, 3]) {
      const r = straddleBias(dte, 60, false);
      expect(r.trades).toBeGreaterThan(4000);
      expect(r.se).toBeLessThan(0.015); // 样本够大:1.5% 以内的偏差才谈得上"看得见"
      expect(Math.abs(r.bias), `dte ${dte} 偏差 ${r.bias},标准误 ${r.se}`).toBeLessThan(3 * r.se);
      // 同一批成交,日历口径会把权利金算低一大截:1 天期约四成,3 天期一成多
      expect(r.calendarBias, `dte ${dte} 日历口径的偏差 ${r.calendarBias}`).toBeGreaterThan(8 * r.se);
    }
    expect(straddleBias(1, 60, false).calendarBias).toBeGreaterThan(0.3);
  });

  it("整条链路(波动率也由回测自己从日线估)同样在抽样误差之内", () => {
    const r = straddleBias(1, 60, true);
    expect(Math.abs(r.bias), `偏差 ${r.bias},标准误 ${r.se}`).toBeLessThan(3 * r.se);
  });

  it("理论价不到最小报价单位(0.01 美元)的不开仓并写明:那个价买不到,硬买只会造出天文数字的收益", () => {
    expect(MIN_OPTION_TICK).toBe(0.01);
    const b = martingaleBars(400, 3, 0.15, 0.3, 150);
    // 虚值 10%、7 天到期:理论价是一分钱的零头,一笔都不该开
    const far = runBacktest(b, "buy_hold", null, null, { ...CALL, dte: 7, offset_pct: 10 });
    expect(far.trades).toBe(0);
    expect(far.total_return_pct).toBe(0);
    expect(far.notes?.some((n) => /^有 \d+ 根日线策略要持仓却没开成:理论价不到 0\.01 美元\(期权的最小报价单位\)/.test(n))).toBe(true);
    // 虚值 5%、3 天到期:有的日子够一分钱、有的不够。开成的每一笔都不低于一分钱,收益也回到人间
    const near = runBacktest(b, "buy_hold", null, null, { ...CALL, dte: 3, offset_pct: 5 });
    expect(near.trades).toBeGreaterThan(0);
    expect(Math.min(...near.trade_list.map((t) => t.entry_price))).toBeGreaterThanOrEqual(0.01);
    expect(near.notes?.some((n) => n.includes("理论价不到 0.01 美元"))).toBe(true);
    expect(Math.max(...near.trade_list.map((t) => t.return_pct))).toBeLessThan(100_000);
  });

  it("行权价贴标准挂牌间隔:≤25 是 2.5、≤200 是 5、再往上 10;宽度不足一档按一档,结果里写明用了哪一档", () => {
    expect([8, 25, 25.01, 200, 200.01, 5800].map(strikeStep)).toEqual([2.5, 2.5, 5, 5, 10, 10]);
    const b = optionBars();
    const fly = runBacktest(b, "buy_hold", null, null, { ...CALL, type: "butterfly" });
    const mid = Math.round(b[21]!.open / 5) * 5;
    expect(fly.trade_list[0]!.strikes).toEqual([mid - 5, mid, mid + 5]); // 2% 的翼宽约 2 块,不足一档
    const spread = runBacktest(b, "buy_hold", null, null, { ...CALL, type: "put_spread", offset_pct: -4, width_pct: 9 });
    const k = Math.round((b[21]!.open * 0.96) / 5) * 5;
    expect(spread.trade_list[0]!.strikes).toEqual([k, k - 10]);
    expect(fly.notes?.some((n) => n.includes("行权价贴到标准挂牌间隔(这次用到 5 一档)"))).toBe(true);
    expect(fly.notes?.some((n) => n.includes("方差风险溢价") && n.includes("偏乐观"))).toBe(true);
    expect(fly.notes?.some((n) => n.includes("r=0"))).toBe(true);
    expect(fly.notes?.some((n) => n.includes("时间按交易日计") && n.includes("周末与假日不计"))).toBe(true);
  });

  it("信号消失:下一根开盘按模型价平掉(用上一根收盘为止的波动率)", () => {
    const b = optionBars();
    const vol = trailingVol(b.map((x) => x.close));
    const held = b.map((_, i) => (i >= 30 && i < 36 ? 1 : 0)); // 第 30 根开盘买,第 36 根开盘卖
    const r = settle(b, held, 0, CALL);
    const t = r.trade_list[0]!;
    expect(t).toMatchObject({ entry_date: b[30]!.date, exit_date: b[36]!.date, exit_reason: "signal" });
    const expiryIdx = lastBarWithin(b, 30, 30);
    expect(t.exit_price).toBeCloseTo(bsPrice(b[36]!.open, t.strikes![0]!, yearsAtOpen(b, 36, expiryIdx), vol[35]!, "C"), 4);
  });

  it("切出来的一截用的是整段的历史:起点之前的日线照样拿来算波动率", () => {
    const b = optionBars();
    const held = heldAfterOpen(b.map(() => 1));
    const whole = evaluateSegment({ bars: b, held, strategy: "buy_hold", params: {}, inst: CALL, lo: 40, hi: 80 });
    expect(whole.trade_list[0]!.entry_date).toBe(b[40]!.date); // 起点就开得成
    expect(whole.notes?.some((n) => n.includes("没开成"))).toBe(false);
    // 把前面的历史切掉再算,前 20 根就开不了仓——扫描的样本外段不能这么切
    const cut = evaluateSegment({ bars: b.slice(40), held: held.slice(40), strategy: "buy_hold", params: {}, inst: CALL });
    expect(cut.trade_list[0]!.entry_date).toBe(b[61]!.date);
  });
});

describe("成交成本", () => {
  it("不给 = 0,且回执里没有 cost_pct 这个键", () => {
    const a = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 });
    const b = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, null, 0);
    expect(b).toEqual(a);
    expect("cost_pct" in b).toBe(false);
  });

  it("正股:每次换仓付一次,交易越多扣得越多;单笔收益按买卖各一次扣", () => {
    const gross = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 });
    const net = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, null, 0.5);
    expect(net.cost_pct).toBe(0.5);
    expect(net.total_return_pct).toBeLessThan(gross.total_return_pct);
    const g = gross.trade_list[0]!;
    const n = net.trade_list[0]!;
    expect(n.return_pct).toBeCloseTo(((1 + g.return_pct / 100) * 0.995 * 0.995 - 1) * 100, 1);
  });

  it("期权:开仓多付、平仓少收;超过 10% 当场拒", () => {
    const inst = { type: "call", dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
    const gross = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, inst);
    const net = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, inst, 3);
    expect(net.total_return_pct).toBeLessThan(gross.total_return_pct);
    expect(() => runBacktest(bars(), "sma_cross", {}, null, null, 11)).toThrowError(BacktestError);
  });
});

describe("参数扫描", () => {
  it("网格展开成全部组合;不合法的组合(快线 ≥ 慢线)跳过并写明原因", () => {
    expect(gridCombos({ fast: [5, 10], slow: [20, 40] })).toEqual([
      { fast: 5, slow: 20 }, { fast: 5, slow: 40 }, { fast: 10, slow: 20 }, { fast: 10, slow: 40 },
    ]);
    const r = runSweep(input());
    expect(r.combos).toBe(9);
    expect(r.skipped.map((x) => x.params)).toEqual([{ fast: 20, slow: 20 }]);
    expect(r.skipped[0]!.reason).toContain("快线周期必须小于慢线周期");
    expect(r.rows).toHaveLength(8);
  });

  it("样本内挑、样本外看:按样本内得分排,带样本外名次;切分日在 70% 处", () => {
    const r = runSweep(input());
    const scores = r.rows.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.best).toEqual(r.rows[0]);
    expect(r.split_date).toBe(bars()[280]!.date);
    expect(new Set(r.rows.map((x) => x.oos_rank))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.rank_corr).not.toBeNull();
    expect(r.notes.some((n) => n.includes("没扣成交成本"))).toBe(true);
    // 执行损耗的中位数是 0DTE 组合平仓那一段、占权利金的比例,不再劝人填进正股的成本
    expect(r.notes.some((n) => n.includes("执行损耗"))).toBe(false);
  });

  it("挑出来的那组在样本外的位置:名次、随手挑一组不比它差的概率、全部组合的样本外中位数", () => {
    const r = runSweep(input());
    expect(r.ranked).toBe(r.combos - r.skipped.length);
    expect(r.rows).toHaveLength(r.ranked); // 不到 20 组,全在
    const best = r.best!;
    const oos = r.rows.map((x) => x.oos.return_pct);
    expect(best.oos_rank).toBe(1 + oos.filter((v) => v > best.oos.return_pct).length);
    expect(r.pick_p).toBeCloseTo(oos.filter((v) => v >= best.oos.return_pct).length / r.ranked, 4);
    const sorted = [...oos].sort((a, b) => a - b);
    expect(r.oos_median_return_pct).toBeCloseTo((sorted[3]! + sorted[4]!) / 2, 2);
    expect(r.notes[0]).toBe(`样本内第一名在样本外排第 ${best.oos_rank} / 8:随手挑一组,样本外不比它差的机会是 ${Math.round(r.pick_p! * 1000) / 10}%`);
    for (const row of r.rows) expect(row.oos.excess_return_pct).toBeCloseTo(row.oos.return_pct - row.oos.bench_return_pct, 2);
  });

  it("秩相关带置换 p 值,说明里只摆数、不下「挑运气」的结论;只扫一只也写幸存者偏差", () => {
    const r = runSweep(input());
    expect(r.rank_corr_p).toBeGreaterThan(0);
    expect(r.rank_corr_p).toBeLessThanOrEqual(1);
    expect(runSweep(input()).rank_corr_p).toBe(r.rank_corr_p); // 确定性的:同样的输入同样的 p
    // 四组、排名全对:p 的真值是 1/24
    const four = runSweep(input({ grid: { fast: [5, 10], slow: [20, 40] } }));
    expect(four.rank_corr).toBe(1);
    expect(four.rank_corr_p).toBeCloseTo(1 / 24, 2);
    expect(four.notes).toContain(
      `样本内外排名的秩相关 1:两边的排名要是毫无关系,碰巧得到这么高(或更高)的机会是 ${Math.round(four.rank_corr_p! * 1000) / 10}%`);
    // 八组全对:置换里一次都碰不上,p 落在下限 1/10000。说明里不能把它印成"0%"
    expect(r.rank_corr).toBe(1);
    expect(r.rank_corr_p).toBe(0.0001);
    expect(r.notes).toContain("样本内外排名的秩相关 1:两边的排名要是毫无关系,碰巧得到这么高(或更高)的机会是 不到 0.1%");
    expect(r.notes.some((n) => /机会是 0%/.test(n))).toBe(false);
    expect(r.notes.some((n) => n.includes("挑运气"))).toBe(false);
    // 相关不为正(黄金基线那段日线上就是):不报"碰巧这么高",直说排名没延续;p 值照给
    const golden: Bar[] = loadGolden("backtest").bars;
    const flipped = runSweep(input({ series: [{ symbol: "AAA", bars: golden }], grid: { fast: [5, 10, 15], slow: [25, 50, 75] } }));
    expect(flipped.rank_corr).toBeLessThan(0);
    expect(flipped.notes).toContain(`样本内外排名的秩相关 ${flipped.rank_corr},不为正:样本内排得靠前的,样本外并不靠前`);
    expect(flipped.rank_corr_p).toBeGreaterThan(0.5);
    expect(r.notes.some((n) => n.includes("幸存者偏差"))).toBe(true);
    // 样本内外都不满一年:年化是外推的,写明天数
    expect(r.notes.some((n) => n.includes(`样本内 ${r.best!.is.days} 天、样本外 ${r.best!.oos.days} 天`) && n.includes("外推"))).toBe(true);
  });

  it("多只标的:只用共同的交易日,得分取平均;notes 写明幸存者偏差", () => {
    const b = bars(400, 5).slice(10); // 少了前 10 天
    const r = runSweep(input({ series: [{ symbol: "AAA", bars: bars() }, { symbol: "BBB", bars: b }] }));
    expect(r.start).toBe(b[0]!.date);
    expect(r.symbols).toEqual(["AAA", "BBB"]);
    expect(r.notes.some((n) => n.includes("幸存者偏差"))).toBe(true);
    expect(alignSeries([{ symbol: "A", bars: bars(30) }, { symbol: "B", bars: bars(30).slice(5) }])[0]!.bars).toHaveLength(25);
  });

  it("滚动前推:每折只用之前的数据挑参数,测试段收益连乘", () => {
    const r = runSweep(input({ folds: 3 }));
    const wf = r.walk_forward!;
    expect(wf.folds).toHaveLength(3);
    for (const f of wf.folds) expect(f.train_end < f.test_start).toBe(true);
    const chained = wf.folds.reduce((acc, f) => acc * (1 + f.test_return_pct / 100), 1);
    expect(wf.total_return_pct).toBeCloseTo((chained - 1) * 100, 1);
  });

  it("收益回撤比当标准:总收益 ÷ max(最大回撤, 在场时的单日波动 × √在场天数),不年化;排名里只有这一种量纲", () => {
    const golden: Bar[] = loadGolden("backtest").bars;
    for (const b of [bars(), golden]) {
      const r = runSweep(input({ series: [{ symbol: "AAA", bars: b }], grid: { fast: [5, 10, 15], slow: [25, 50, 75] }, objective: "calmar" }));
      const split = Math.floor(b.length * 0.7);
      for (const row of r.rows) {
        // 样本内那一截另算一遍,拿回执里的在场天数与单日波动自己拼出下限
        const { positions, usedParams } = signalPositions(b, "sma_cross", row.params, null);
        const is = evaluateSegment({ bars: b, held: heldAfterOpen(positions), strategy: "sma_cross", params: usedParams, inst: STOCK, hi: split });
        const dd = Math.abs(is.max_drawdown_pct);
        const floor = (is.held_day_move_pct ?? 0) * Math.sqrt(is.held_days);
        expect(row.score).toBe(row.is.return_over_dd);
        expect(row.is.return_over_dd).toBeCloseTo(is.total_return_pct / Math.max(dd, floor), 4);
        expect(row.is.dd_floored).toBe(floor > dd);
        expect(row.is.dd_under_one_day).toBe((is.held_day_move_pct ?? 0) > dd);
      }
      expect(r.notes.some((n) => n.startsWith("排名用的是 总收益 ÷ max(最大回撤, 回撤下限),不年化。回撤下限 = 在场时的单日波动 × √在场天数"))).toBe(true);
    }
    // 两种情形都要有:黄金基线那段行情真跌过,回撤都比下限大;正弦那段有的组回撤比下限小
    const real = runSweep(input({ series: [{ symbol: "AAA", bars: golden }], grid: { fast: [5, 10, 15], slow: [25, 50, 75] }, objective: "calmar" }));
    expect(real.rows.every((x) => !x.is.dd_floored)).toBe(true);
    expect(runSweep(input({ objective: "calmar" })).rows.some((x) => x.is.dd_floored)).toBe(true);
  });

  it("没有回撤的段:回撤按下限算,不换成年化、也不是无穷大;在场越久下限越大;一直空仓的是 0", () => {
    // 每天涨 1%、没有跳空:谁持有都不会回撤,在场的每一天都是 +1%
    const rising: Bar[] = bars(120).map((b, i) => {
      const close = 100 * 1.01 ** i;
      return { date: b.date, open: i === 0 ? 100 : 100 * 1.01 ** (i - 1), high: close, low: close / 1.01, close };
    });
    const sweep = (over: Partial<SweepInput> = {}) =>
      runSweep(input({ series: [{ symbol: "UP", bars: rising }], grid: { fast: [2, 5], slow: [10, 200] }, objective: "calmar", ...over }));
    const r = sweep();
    for (const row of r.rows) {
      const { is } = row;
      expect(is.max_drawdown_pct).toBe(0);
      expect(is.calmar).toBeNull();
      if (is.trades === 0) {
        expect(row.score).toBe(0); // 慢线 200:样本内一直空仓
        expect(is.dd_floored).toBe(false);
        expect(is.dd_under_one_day).toBe(false);
      } else {
        const days = Math.round(Math.log(1 + is.return_pct / 100) / Math.log(1.01)); // 在场几天,就涨了几个 1%
        expect(days).toBeGreaterThan(50);
        expect(is.dd_floored).toBe(true);
        expect(is.dd_under_one_day).toBe(true);
        expect(row.score).toBeCloseTo(is.return_pct / Math.sqrt(days), 2); // 单日波动 1% × √在场天数
        expect(row.score).not.toBe(is.annualized_pct);
      }
    }
    expect(r.rows.some((x) => x.is.trades === 0)).toBe(true);
    expect(r.notes.some((n) => n.includes("样本内第一名就是按它算的"))).toBe(true);
    expect(r.notes).toContain("样本内第一名在样本内的回撤还不到它在场时一天的典型波动:基本没经历过回撤(多半只进过一两次场),这个名次不可靠");
  });

  it("滚动前推的每一折带上:挑出来的那组是不是靠回撤下限、是不是几乎没经历过回撤;说明里数出来。按总收益挑时不谈这两件事", () => {
    const rising: Bar[] = bars(160).map((b, i) => {
      const close = 100 * 1.01 ** i;
      return { date: b.date, open: i === 0 ? 100 : 100 * 1.01 ** (i - 1), high: close, low: close / 1.01, close };
    });
    const base = { series: [{ symbol: "UP", bars: rising }], grid: { fast: [2, 5], slow: [10, 20] }, folds: 2 };
    const r = runSweep(input({ ...base, objective: "calmar" }));
    expect(r.walk_forward!.folds.map((f) => [f.dd_floored, f.dd_under_one_day])).toEqual([[true, true], [true, true]]);
    expect(r.notes).toContain(
      "滚动前推 2 折里有 2 折,挑出来的那组在训练段的回撤是按下限算的;其中 2 折那组的回撤还不到在场时一天的典型波动(基本没经历过回撤,那一折的参数不可靠)");
    const byReturn = runSweep(input({ ...base, objective: "return" }));
    expect(byReturn.walk_forward!.folds.every((f) => !f.dd_floored && !f.dd_under_one_day)).toBe(true);
    expect(byReturn.notes.some((n) => n.includes("下限"))).toBe(false);
    // 真跌过的行情:挑出来的组回撤是实打实的,不提
    const golden: Bar[] = loadGolden("backtest").bars;
    const real = runSweep(input({ series: [{ symbol: "AAA", bars: golden }], grid: { fast: [5, 10, 15], slow: [25, 50, 75] }, folds: 3, objective: "calmar" }));
    expect(real.walk_forward!.folds.map((f) => f.dd_under_one_day)).toEqual([false, false, false]);
    expect(real.notes.some((n) => n.includes("回撤还不到在场时一天的典型波动"))).toBe(false);
  });

  it("每一折的两个标记说的是被挑中的那一组在训练段的样子:另算一遍对得上;同一次扫描里各折可以不一样", () => {
    const grid = { period: [7, 14, 21], buy_below: [15, 30, 45], sell_above: [35, 70] };
    const seen = new Set<string>();
    for (const seed of [1, 2, 12]) {
      const b = martingaleBars(500, seed, 0.3, 0.3, 100);
      const r = runSweep(input({ series: [{ symbol: "A", bars: b }], strategy: "rsi", grid, costPct: 0.05, folds: 3, objective: "calmar" }));
      for (const fold of r.walk_forward!.folds) {
        const hi = b.findIndex((x) => x.date === fold.train_end) + 1;
        const { positions, usedParams } = signalPositions(b, "rsi", fold.params, null);
        const train = evaluateSegment({ bars: b, held: heldAfterOpen(positions), strategy: "rsi", params: usedParams, inst: STOCK, costPct: 0.05, hi });
        const dd = Math.abs(train.max_drawdown_pct);
        const day = train.held_day_move_pct ?? 0;
        expect(fold.dd_floored).toBe(day * Math.sqrt(train.held_days) > dd);
        expect(fold.dd_under_one_day).toBe(day > dd);
        seen.add(`${fold.dd_floored}/${fold.dd_under_one_day}`);
      }
      const thin = r.walk_forward!.folds.filter((f) => f.dd_under_one_day).length;
      expect(r.notes.some((n) => n.includes(`其中 ${thin} 折那组的回撤还不到在场时一天的典型波动`))).toBe(thin > 0);
    }
    // 三种情形都出现过:实打实的回撤、按下限算但经历过回撤、几乎没经历过回撤
    expect([...seen].sort()).toEqual(["false/false", "true/false", "true/true"]);
  });

  it("期权品种的扫描:波动率在整段上算,样本外一开始就能开仓;说明里写估价口径", () => {
    const r = runSweep(input({ instrument: { ...STOCK, type: "call" }, grid: { fast: [5, 10], slow: [20, 40] } }));
    expect(r.rows.every((x) => x.oos.trades > 0)).toBe(true);
    expect(r.notes.some((n) => n.includes("方差风险溢价") && n.includes("时间按交易日计") && n.includes("前 20 根日线只用来算波动率"))).toBe(true);
  });

  it("入参报人话:没参数的策略、不认识的参数、组合太多、比例与折数越界、数据太短", () => {
    expect(() => checkGrid("buy_hold", { x: [1] }, 1)).toThrowError("没有参数可扫");
    expect(() => checkGrid("sma_cross", { fastt: [1, 2] }, 1)).toThrowError("没有参数 fastt");
    expect(() => checkGrid("rsi", { period: [...Array(15).keys()].map((i) => i + 2), buy_below: [...Array(15).keys()].map((i) => i + 5) }, 1))
      .toThrowError("组合太多");
    expect(() => runSweep(input({ splitPct: 95 }))).toThrowError("50%~90%");
    expect(() => runSweep(input({ folds: 1 }))).toThrowError("2~6");
    expect(() => runSweep(input({ series: [{ symbol: "AAA", bars: bars(30) }] }))).toThrowError("切不出样本内外");
  });

  it("秩相关:完全一致 1、完全相反 -1、同分取平均秩、太少不算", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(spearman([1, 1, 2], [1, 1, 2])).toBe(1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("秩相关的置换 p 值:三组全对也有 1/6 是碰巧;十组全对几乎不可能;全反 = 1;没有相关时也没有 p", () => {
    // 3! = 6 种排法里只有 1 种全对:p 的真值是 1/6
    expect(spearmanP([1, 2, 3], [1, 2, 3])).toBeCloseTo(1 / 6, 2);
    // 4 组全对:1/24
    expect(spearmanP([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1 / 24, 2);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(spearmanP(ten, ten)).toBeLessThan(0.001);
    expect(spearmanP(ten, [...ten].reverse())).toBe(1);
    // 5 组、相关 0.9(只有一对相邻的换了位置):不低于它的排法有 5 种(全对 1 种 + 换一对相邻的 4 种),p = 5/120
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 3, 5, 4])).toBe(0.9);
    expect(spearmanP([1, 2, 3, 4, 5], [1, 2, 3, 5, 4])).toBeCloseTo(5 / 120, 2);
    expect(spearmanP([1, 2], [1, 2])).toBeNull();
    expect(spearmanP([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});
