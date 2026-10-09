/** 绩效体检(performance.ts + review.performance):美元账本、统计口径、行为规则。夹具是造的,全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { LedgerTrade } from "../src/contract/performance.js";
import { groupButterflies } from "../src/ibtrades.js";
import { parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import {
  buildLedger, dailyLossReplay, equityCurve, INITIAL_STOP_MINUTES, kellyOf, lossBursts, perfStats, performanceReport, rCoverage, revengeSplit,
  rStats, sessionOf, sizeAfterLoss, sqnLabel,
} from "../src/performance.js";
import type { Ledger } from "../src/performance.js";
import { RpcServer } from "../src/rpc.js";
import { groupStockTrips } from "../src/stockreview.js";
import { slotOf } from "../src/tradeSimilar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;
const ACCT = "U0000001";
const ACCOUNTS = [{ alias: "主账户", account_id: ACCT, is_paper: false }];
let execSeq = 0;

function flyFills(
  perm: number, action: "BUY" | "SELL", strikes: [number, number, number], right: "C" | "P",
  expiry: string, price: number, time: string,
): Rec[] {
  const legSide = (i: number): string => ((i === 1) === (action === "BUY") ? "SLD" : "BOT");
  const base = { account_id: ACCT, perm_id: perm, order_id: null, time, commission: 0 };
  return [
    { ...base, exec_id: `e${(execSeq += 1)}`, side: action === "BUY" ? "BOT" : "SLD", shares: 1, price, contract: { secType: "BAG", symbol: "SPX" } },
    ...strikes.map((strike, i) => ({
      ...base, exec_id: `e${(execSeq += 1)}`, side: legSide(i), shares: i === 1 ? 2 : 1, price: 1,
      contract: { secType: "OPT", symbol: "SPX", strike, right, expiry, multiplier: "100", tradingClass: "SPXW", currency: "USD" },
    })),
  ];
}

function stockFill(symbol: string, side: "BOT" | "SLD", shares: number, price: number, time: string, perm: number): Rec {
  return {
    account_id: ACCT, exec_id: `e${(execSeq += 1)}`, perm_id: perm, order_id: null, side, shares, price, time, commission: 0,
    contract: { secType: "STK", symbol, currency: "USD", exchange: "SMART", conId: 1 },
  };
}

// 2026-09-10:10:27 开的看跌蝶 5.4 → 4.55 平掉(-85);12:00 开的看涨蝶 3.55 拿到期,收 7682 → 值 18(+1445)
const FLY_FILLS = [
  ...flyFills(101, "BUY", [7625, 7650, 7675], "P", "20260910", 5.4, "2026-09-10T14:27:29+00:00"),
  ...flyFills(102, "SELL", [7625, 7650, 7675], "P", "20260910", 4.55, "2026-09-10T15:04:15+00:00"),
  ...flyFills(103, "BUY", [7660, 7680, 7700], "C", "20260910", 3.55, "2026-09-10T16:00:01+00:00"),
];
const STOCK_FILLS = [
  stockFill("RKLB", "BOT", 100, 50, "2026-09-01T14:00:00+00:00", 201),
  stockFill("RKLB", "SLD", 100, 55, "2026-09-03T14:00:00+00:00", 202),
  stockFill("SPCX", "BOT", 10, 100, "2026-09-02T14:00:00+00:00", 203),
  stockFill("SPCX", "SLD", 10, 90, "2026-09-04T14:00:00+00:00", 204),
];
const OPT_CSV = [
  "time_et,date_et,symbol,asset,structure,action,direction,qty,net_price,realized_pnl,commission,legs,fills,order_ids,note",
  "2026-07-17 16:20:00,2026-07-17,SPX,期权,蝴蝶,拆腿平仓,买方蝴蝶(多),1,,-263.2,1.9,,4,7 8,",
  "2026-07-20 11:00:00,2026-07-20,SPX,期权,蝴蝶,平仓,买方蝴蝶(多),1,-3.0,120.0,6.0,,3,9,",
  "2026-07-21 16:20:00,2026-07-21,SPX,期权,多个仓位同时结算,到期结算,,,,-300.0,0.0,,6,10,",
  "2026-07-22 11:00:00,2026-07-22,SPX,期权,垂直价差,平仓,借方,1,-1.0,50.0,2.0,,2,11,",
].join("\n");

const NOW = Date.parse("2026-09-23T14:40:00Z");
const SETTLE = (s: string, d: string): number | null => (s === "SPX" && d === "2026-09-10" ? 7682 : null);

function fixtureLedger(settle = SETTLE): Ledger {
  return buildLedger({
    butterflies: groupButterflies(FLY_FILLS, ACCOUNTS),
    trips: groupStockTrips(STOCK_FILLS, ACCOUNTS, null),
    positions: [],
    options: parseOptionTradesCsv(OPT_CSV, ACCT, "t.csv").rows,
    settleClose: settle,
    isPaper: () => false,
    now: NOW,
  });
}

let seq = 0;
/** 造一笔:开仓 / 了结时刻是 UTC ISO。 */
function t(pnl: number, opened: string | null, closed: string, extra: Partial<LedgerTrade> = {}): LedgerTrade {
  const hold = opened === null ? null : (Date.parse(closed) - Date.parse(opened)) / 60_000;
  return {
    id: `t${(seq += 1)}`, kind: "stock", symbol: "AAA", label: "AAA 做多", opened_at: opened, closed_at: closed, pnl,
    net_of_commission: true, risk: null, r: null, risk_basis: null, r_missing: null, exposure: null, hold_minutes: hold, paper: false, ...extra,
  };
}

/** 一串交易:第 i 笔在 2026-01-05 起第 i 天美东 10:00(冬令时)开、开 holdMin 分钟后平。 */
function daily(pnls: number[], holdMin: (pnl: number) => number = () => 60, extra: (i: number) => Partial<LedgerTrade> = () => ({})): LedgerTrade[] {
  return pnls.map((p, i) => {
    const open = Date.parse("2026-01-05T15:00:00Z") + i * 86_400_000;
    return t(p, new Date(open).toISOString(), new Date(open + holdMin(p) * 60_000).toISOString(), extra(i));
  });
}

const ids = (r: ReturnType<typeof performanceReport>): string[] => r.findings.map((f) => f.id);
const report = (trades: LedgerTrade[]): ReturnType<typeof performanceReport> =>
  performanceReport({ trades, excluded: { open: 0, unknown: 0, no_cost: 0 } }, { scope: "all", kind: "all", days: null, now: NOW });

// ---------------------------------------------------------------- 账本

describe("账本:四类交易摊成美元", () => {
  const ledger = fixtureLedger();
  const byId = new Map(ledger.trades.map((x) => [x.id, x]));

  it("蝴蝶:平掉的按两边成交价,到期的按收盘结算;风险 = 权利金,R = 盈亏 / 风险", () => {
    const closed = ledger.trades.find((x) => x.kind === "butterfly" && x.pnl < 0);
    expect(closed).toMatchObject({ pnl: -85, risk: 540, r: -0.16, exposure: 540, hold_minutes: 36.8, net_of_commission: true });
    const expired = ledger.trades.find((x) => x.kind === "butterfly" && x.pnl > 0);
    expect(expired).toMatchObject({ pnl: 1445, risk: 355, r: 4.07, closed_at: "2026-09-10T20:00:00+00:00" });
    // 分母是最大可亏(付出去的权利金),写在每一笔上
    expect([closed?.risk_basis, closed?.r_missing]).toEqual(["max_loss", null]);
  });

  it("股票:平完的一段一笔,占用 = 均价 × 股数;没设过止损就没有 R,原因写明", () => {
    const stocks = ledger.trades.filter((x) => x.kind === "stock").map((x) => [x.symbol, x.pnl, x.exposure, x.r, x.r_missing]);
    expect(stocks).toEqual([["RKLB", 500, 5000, null, "no_stop"], ["SPCX", -100, 1000, null, "no_stop"]]);
  });

  /** RKLB 09-01 14:00(UTC)开仓、SPCX 09-02 14:00 开仓;`stops` 是 tracker_add 留下的痕。 */
  const stockR = (stops: Parameters<typeof buildLedger>[0]["stops"]) => buildLedger({
    butterflies: [], positions: [], options: [], settleClose: SETTLE, isPaper: () => false, now: NOW,
    trips: groupStockTrips(STOCK_FILLS, ACCOUNTS, null), stops,
  }).trades.map((x) => [x.symbol, x.risk, x.r, x.risk_basis, x.r_missing]);

  it("股票:开仓后不久设的那条止损当初始风险;改过的、保护反侧的、别的账户的不算", () => {
    const rows = stockR([
      { at: "2026-08-30T14:00:00Z", account: "主账户", symbol: "RKLB", sec_type: "STK", stop: 30 }, // 建仓之前,不算
      { at: "2026-09-01T14:02:00Z", account: "别的账户", symbol: "RKLB", sec_type: "STK", stop: 49 }, // 别的账户
      { at: "2026-09-01T14:05:00Z", account: "主账户", symbol: "RKLB", sec_type: "STK", stop: 48 }, // ← 这条
      { at: "2026-09-02T16:00:00Z", account: "主账户", symbol: "RKLB", sec_type: "STK", stop: 52 }, // 上移过的,不是初始风险
      { at: "2026-09-02T14:03:00Z", account: null, symbol: "SPCX", sec_type: null, stop: 105 }, // 做多的止损在上方:不是止损
    ]);
    // RKLB:|50 − 48| × 100 = 200,+500 → 2.5R
    expect(rows).toEqual([["RKLB", 200, 2.5, "stop", null], ["SPCX", null, null, null, "no_stop"]]);
  });

  it("股票:止损设晚了不当分母——涨上去之后才把止损挪到成本下面一点,R 会虚高到不像话", () => {
    // RKLB 第二天才设 49.9 的止损:按它算是 |50 − 49.9| × 100 = 10 美元的"风险",+500 成了 50R
    const late = stockR([{ at: "2026-09-02T14:00:00Z", account: "主账户", symbol: "RKLB", sec_type: "STK", stop: 49.9 }]);
    expect(late[0]).toEqual(["RKLB", null, null, null, "late_stop"]);
    // 时限的两边:正好 15 分钟算,多一秒不算
    const edge = (at: string) => stockR([{ at, account: "主账户", symbol: "RKLB", sec_type: "STK", stop: 48 }])[0]?.[4];
    expect(INITIAL_STOP_MINUTES).toBe(15);
    expect([edge("2026-09-01T14:15:00Z"), edge("2026-09-01T14:15:01Z")]).toEqual([null, "late_stop"]);
  });

  it("导入的期权:一次出场一笔,盈亏照导出(已扣佣金),没有开仓时刻", () => {
    const opts = ledger.trades.filter((x) => x.kind === "option");
    expect(opts.map((x) => x.pnl)).toEqual([-263.2, 120, -300, 50]);
    expect(opts.every((x) => x.opened_at === null && x.hold_minutes === null && x.r_missing === "no_open")).toBe(true);
  });

  it("R 盖住了多少、没盖住的为什么", () => {
    expect(rCoverage(ledger.trades)).toEqual({
      trades: 8, with_r: 2, flats: 0, max_loss: 2, stop: 0, stop_window_minutes: 15,
      missing: [
        { reason: "no_stop", label: "股票,开仓后 15 分钟内没设止损", trades: 2 },
        { reason: "no_open", label: "导入的期权出场事件,没配上开仓", trades: 4 },
      ],
    });
  });

  it("按了结时刻从早到晚;结算价取不到的到期蝶不进账、记成结果不明", () => {
    expect(ledger.trades.map((x) => x.closed_at)).toEqual([...ledger.trades.map((x) => x.closed_at)].sort());
    const blind = fixtureLedger(() => null);
    expect(blind.trades.length).toBe(ledger.trades.length - 1);
    expect(blind.excluded).toEqual({ open: 0, unknown: 1, no_cost: 0 });
    expect(byId.size).toBe(8);
  });
});

// ---------------------------------------------------------------- 统计

describe("统计口径", () => {
  const r = performanceReport(fixtureLedger(), { scope: "all", kind: "all", days: null, now: NOW });

  it("胜率、盈亏比、利润因子、期望值、保本胜率", () => {
    expect(r.stats).toMatchObject({
      trades: 8, wins: 4, losses: 4, flats: 0, win_rate: 50, net_pnl: 1366.8,
      gross_profit: 2115, gross_loss: 748.2, avg_win: 528.75, avg_loss: -187.05,
      payoff_ratio: 2.83, profit_factor: 2.83, expectancy: 170.85, breakeven_win_rate: 26.1,
      largest_win: 1445, largest_loss: -300, max_consecutive_wins: 2, max_consecutive_losses: 2,
    });
  });

  it("平仓权益曲线:峰值从 0 起步,回撤到 -443.2;恢复因子 = 净盈亏 / 最大回撤", () => {
    expect(r.equity.map((p) => p.equity)).toEqual([-263.2, -143.2, -443.2, -393.2, 106.8, 6.8, -78.2, 1366.8]);
    expect(r.drawdown).toMatchObject({ max: 443.2, peak_at: null, current: 0, recovery_factor: 3.08 });
  });

  it("眼下的连胜、按品种分组、R 只数风险固定的两笔", () => {
    expect(r.streak).toEqual({ kind: "win", count: 1 });
    expect(r.groups.kind.map((g) => [g.key, g.trades, g.net_pnl])).toEqual([
      ["option", 4, -393.2], ["stock", 2, 400], ["butterfly", 2, 1360],
    ]);
    expect(r.r_stats).toMatchObject({ trades: 2, expectancy_r: 1.96, sqn: null });
    expect(r.r_coverage).toMatchObject({ trades: 8, with_r: 2 });
    expect(r.trades[0]?.pnl).toBe(1445); // 新的在前
  });

  it("分品种:盈亏比、凯利各算各的,旁边是按 R 的;整体的 mix 写明实盘、模拟各几笔", () => {
    const fly = r.groups.kind.find((g) => g.key === "butterfly");
    // 蝶两笔:+1445 / −85 → 盈亏比 17;不到 8 笔没有凯利;R 是 4.07 与 −0.16 的平均
    expect(fly).toMatchObject({ payoff_ratio: 17, kelly: null, r_trades: 2, expectancy_r: 1.96, payoff_r: 25.44, kelly_r: null, sqn: null });
    expect(r.groups.kind.find((g) => g.key === "stock")).toMatchObject({ payoff_ratio: 5, r_trades: 0, expectancy_r: null });
    expect(r.mix).toEqual({ live: 8, paper: 0 });
    const mixed = report([t(10, null, "2026-01-01T00:00:00Z"), t(-5, null, "2026-01-02T00:00:00Z", { paper: true })]);
    expect(mixed.mix).toEqual({ live: 1, paper: 1 });
  });

  it("区间:胜率给 Wilson、期望值给 t;样本不够是 null", () => {
    // 5 笔全赢:10…50,平均 30,标准误 √(250/5) = 7.071,t(4) = 2.7764 → ±19.63
    const s = perfStats(daily([10, 20, 30, 40, 50]));
    expect(s).toMatchObject({ win_rate: 100, expectancy: 30, win_rate_ci: { lo: 56.6, hi: 100 }, expectancy_ci: { lo: 10.37, hi: 49.63 } });
    expect(perfStats(daily([10]))).toMatchObject({ expectancy: 10, expectancy_ci: null, win_rate_ci: { lo: 20.7, hi: 100 } });
    expect(perfStats([])).toMatchObject({ expectancy: null, expectancy_ci: null, win_rate_ci: null });
    // 分组里也带:两笔的区间宽到跨 0,界面不给它上色
    const stock = r.groups.kind.find((g) => g.key === "stock");
    expect(stock?.expectancy).toBe(200);
    expect((stock?.expectancy_ci?.lo ?? 0) < 0 && (stock?.expectancy_ci?.hi ?? 0) > 0).toBe(true);
  });

  it("范围:只看模拟 → 空;只看股票;最近 15 天", () => {
    const ledger = fixtureLedger();
    const opt = (o: Partial<Parameters<typeof performanceReport>[1]>) =>
      performanceReport(ledger, { scope: "all", kind: "all", days: null, now: NOW, ...o });
    expect(opt({ scope: "paper" }).stats.trades).toBe(0);
    expect(opt({ scope: "paper" }).findings).toEqual([]);
    expect(opt({ kind: "stock" }).stats.net_pnl).toBe(400);
    expect(opt({ days: 15 }).stats.trades).toBe(2); // 09-10 的两只蝶;09-03、09-04 的股票在 15 天之外
  });

  it("持平(|盈亏| < 1 美元)不算胜率、不打断连胜连亏", () => {
    const s = perfStats([t(10, null, "2026-01-01T00:00:00Z"), t(0.5, null, "2026-01-02T00:00:00Z"), t(20, null, "2026-01-03T00:00:00Z")]);
    expect(s).toMatchObject({ wins: 2, flats: 1, win_rate: 100, max_consecutive_wins: 2, avg_loss: null, payoff_ratio: null });
  });

  it("持平的也不进期望值:它和胜率是同一个分母,期望值 = 胜率 × 平均盈利 − 败率 × |平均亏损| 才成立", () => {
    const s = perfStats([
      t(10, null, "2026-01-01T00:00:00Z"), t(0.5, null, "2026-01-02T00:00:00Z"), t(20, null, "2026-01-03T00:00:00Z"), t(-6, null, "2026-01-04T00:00:00Z"),
    ]);
    // 输赢 3 笔:(10 + 20 − 6) / 3 = 8;净盈亏照样把持平那 0.5 算进去
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 1, flats: 1, win_rate: 66.7, expectancy: 8, net_pnl: 24.5 });
    // 区间也只用那 3 笔:10、20、−6 → 标准差 13.115,t(2) = 4.3027 → 8 ± 32.58(把持平那笔算进去是另一个数)
    expect(s.expectancy_ci).toEqual({ lo: -24.58, hi: 40.58 });
    const w = (s.win_rate ?? 0) / 100;
    expect(w * (s.avg_win ?? 0) + (1 - w) * (s.avg_loss ?? 0)).toBeCloseTo(8, 1);
    // R 那一组同一个口径:持平的那笔有 R 也不数
    const withFlat = [t(100, null, "2026-01-01T00:00:00Z", { r: 1, risk: 100 }), t(0.5, null, "2026-01-02T00:00:00Z", { r: 0.01, risk: 100 })];
    expect(rStats(withFlat)).toMatchObject({ trades: 1, expectancy_r: 1 });
    // 覆盖那一头把它单独数出来:有 R 的 2 笔里 1 笔持平,所以 R 的统计只有 1 笔
    expect(rCoverage(withFlat)).toMatchObject({ with_r: 2, flats: 1 });
  });

  it("SQN:不到 10 笔不算,N 封顶 100;档位按 Tharp 的表", () => {
    const rs = (xs: number[]) => rStats(xs.map((x) => t(x * 100, null, "2026-01-01T00:00:00Z", { r: x, risk: 100 })));
    expect(rs([1, -1, 2]).sqn).toBeNull();
    expect(rs([2, -1, 2, -1, 2, -1, 2, -1, 2, -1])).toMatchObject({ trades: 10, expectancy_r: 0.5, sqn: 1, sqn_label: "差" });
    // 1.6 以下 差 · 1.6–1.9 低于平均 · 2.0–2.4 平均 · 2.5–2.9 好 · 3.0–5.0 优秀 · 5.1–6.9 极好 · 7.0 起 圣杯
    expect([1.59, 1.6, 1.99, 2.0, 2.49, 2.5, 2.99, 3.0, 5.0, 5.1, 6.99, 7.0].map(sqnLabel)).toEqual(
      ["差", "低于平均", "低于平均", "平均", "平均", "好", "好", "优秀", "优秀", "极好", "极好", "圣杯"]);
    expect(sqnLabel(null)).toBe("");
  });

  it("按 R 的胜率、盈亏比、凯利:仓位大小已经除掉,区间给 R 期望", () => {
    const rs = rStats(daily([2, -1, 2, -1, 2, -1, 2, -1, 2, -1].map((x) => x * 100), () => 60, (i) => ({ r: i % 2 ? -1 : 2, risk: 100 })));
    // W = 0.5、盈亏比 2 → 凯利 0.5 − 0.5 / 2 = 0.25;平均 0.5R,标准差 1.58,t(9) = 2.262 → ±1.13
    expect(rs).toMatchObject({ win_rate: 50, payoff_ratio: 2, kelly: 0.25, expectancy_ci: { lo: -0.63, hi: 1.63 } });
    // 一笔 10 万的股票单和九笔几百的蝶:按美元全看那一笔,按 R 每笔一样重
    const mixed = [
      t(-20000, null, "2026-01-01T00:00:00Z", { r: -1, risk: 20000 }),
      ...Array.from({ length: 9 }, (_, i) => t(300, null, `2026-01-${String(i + 2).padStart(2, "0")}T00:00:00Z`, { r: 1, risk: 300 })),
    ];
    expect(perfStats(mixed).expectancy).toBe(-1730);
    expect(rStats(mixed)).toMatchObject({ expectancy_r: 0.8, win_rate: 90, payoff_ratio: 1 });
  });

  it("凯利:f = W − (1 − W) / 盈亏比;输赢不到 8 笔不算", () => {
    expect(kellyOf(perfStats(daily([100, -50, 100, -50, 100, -50, 100, -50])))).toBe(0.25);
    expect(kellyOf(perfStats(daily([100, -50])))).toBeNull();
  });

  it("美东开仓时段:和下单页「历史相似交易」是同一张表,这里只多一个稳定的键", () => {
    expect(sessionOf("2026-09-23T13:45:00Z")).toEqual({ key: "open30", label: "开盘半小时" });
    expect(sessionOf("2026-09-23T14:40:00Z")).toEqual({ key: "morning", label: "上午" });
    expect(sessionOf("2026-09-23T17:00:00Z")).toEqual({ key: "afternoon", label: "午后" });
    expect(sessionOf("2026-09-23T19:45:00Z")).toEqual({ key: "close60", label: "尾盘一小时" });
    expect(sessionOf("2026-09-23T21:00:00Z")).toEqual({ key: "off", label: "盘外" });
    expect(sessionOf(null)).toBeNull();
    // 一天里每 5 分钟走一遍:那张表吐出来的每一档,这里都认得、都有键(那边改了档名,这条会红)
    const day = Date.parse("2026-09-23T04:00:00Z");
    for (let m = 0; m < 1440; m += 5) {
      const at = day + m * 60_000;
      const got = sessionOf(new Date(at).toISOString());
      expect(got?.label).toBe(slotOf(at));
      expect(["open30", "morning", "afternoon", "close60", "off"]).toContain(got?.key);
    }
  });

  it("equityCurve:没回撤过时恢复因子是 null", () => {
    expect(equityCurve(daily([10, 20])).drawdown).toMatchObject({ max: 0, recovery_factor: null });
  });
});

// ---------------------------------------------------------------- 规则

describe("行为规则", () => {
  it("样本不足先说;期望值的区间整个在 0 以下才说 bad", () => {
    const r = report(daily([-100, -80, -120, 20, -100, -90]));
    expect(r.findings[0]).toMatchObject({ id: "sample", tone: "info" });
    expect(r.findings.find((f) => f.id === "expectancy")).toMatchObject({ tone: "bad", title: "期望值为负:平均每笔 -$78.33" });
  });

  it("期望值的区间跨着 0:不说正也不说负,说还没分清", () => {
    // 平均 −25,标准差 82.16,t(5) = 2.571 → ±86.22:6 笔的 95% 区间是 −111 ~ +61
    const r = report(daily([-100, 50, -100, 50, -100, 50]));
    const f = r.findings.find((x) => x.id === "expectancy");
    expect(f).toMatchObject({ tone: "info", title: "平均每笔 -$25.00,正负还没分清" });
    expect(f?.text).toContain("95% 区间 -$111.22 ~ $61.22");
    expect(report(daily([100, 120, 80, 90, 110, -20])).findings.find((x) => x.id === "expectancy")).toMatchObject({ tone: "good" });
  });

  it("凯利:有 R 用按 R 的;期望值的正负没分清时不给人当真;区间在 0 以下才说没有优势", () => {
    const kelly = (trades: LedgerTrade[]) => report(trades).findings.find((f) => f.id === "kelly");
    // 没有 R:按美元,而且写明
    const usd = kelly(daily([100, 120, 80, 90, 110, -20, 100, 95]));
    expect(usd?.title).toMatch(/^凯利比例 [\d.]+%$/);
    expect(usd?.text).toContain("按美元盈亏算");
    // 输赢交替:平均为正但区间跨 0
    expect(kelly(daily([100, -50, 100, -50, 100, -50, 100, -50]))).toMatchObject({ tone: "info", title: "凯利比例 25%,现在还不能当真" });
    expect(kelly(daily([-100, -80, -120, 20, -100, -90, -70, -60]))).toMatchObject({ tone: "warn", title: "按统计没有下注优势(凯利比例 ≤ 0)" });
    // 有 R:说的是按 R 的那个
    const byR = kelly(daily([100, 120, 80, 90, 110, -20, 100, 95], () => 60, (i) => ({ risk: 100, r: [1, 1.2, 0.8, 0.9, 1.1, -0.2, 1, 0.95][i] ?? 0 })));
    expect(byR?.text).toContain("按 8 笔有 R 的交易算");
    // 按 R 的数就配按 R 的区间:九笔 +1R 的蝶和一笔 −1R 的大股票单,按美元区间跨 0、按 R 清清楚楚是正的
    const mixed = kelly(daily([-20000, ...Array(9).fill(300)], () => 60, (i) => (i ? { r: 1, risk: 300 } : { r: -1, risk: 20000 })));
    expect(mixed).toMatchObject({ tone: "info", title: "凯利比例 80%" });
    // 凯利是负的、区间又跨 0:不说"它给的数偏大"
    const neg = kelly(daily([-100, 50, -100, 50, -100, 50, -100, 50]));
    expect(neg?.title).toBe("凯利比例 -50%,现在还不能当真");
    expect(neg?.text).toContain("眼下的数看不出优势,也还说不上一定没有");
  });

  it("同一天了结的几笔不当成几次独立的试验:区间按天成簇,全在一天的定不出区间", () => {
    const sameDay = (pnls: number[], day: string): LedgerTrade[] =>
      pnls.map((p, i) => t(p, `${day}T15:${String(i).padStart(2, "0")}:00Z`, `${day}T16:${String(i).padStart(2, "0")}:00Z`));
    // 三天各两笔,同一天的两笔同涨同跌:(10,20) (30,40) (50,60),平均 35。
    // 按天成簇:三天的离差和 −40 / 0 / +40 → 方差 3/2 × 3200 / 36 = 133.3,t(2) = 4.3027 → ±49.68;当成 6 笔独立只有 ±19.6
    const s = perfStats([...sameDay([10, 20], "2026-03-02"), ...sameDay([30, 40], "2026-03-03"), ...sameDay([50, 60], "2026-03-04")]);
    expect(s.expectancy).toBe(35);
    expect(s.expectancy_ci).toEqual({ lo: -14.68, hi: 84.68 });
    // 六笔全在一天:区间定不出来;结论照实说,不说正也不说负
    const oneDay = report(sameDay([100, 120, 80, 90, 110, 95], "2026-03-02"));
    expect(oneDay.stats).toMatchObject({ expectancy: 99.17, expectancy_ci: null, win_rate_ci: null });
    const f = oneDay.findings.find((x) => x.id === "expectancy");
    expect(f).toMatchObject({ tone: "info" });
    expect(f?.text).toContain("这些交易都在同一天了结,一天的行情定不出区间");
  });

  it("处置效应按天比:一天里五笔一起拿到收盘,只算那一天的一个数", () => {
    // 赚的 5 笔全在一天、各拿 20 分钟;亏的 5 笔全在另一天、各拿 120 分钟:中位数差 6 倍,但只是"一天对一天"
    const mk = (pnl: number, day: string, hold: number, i: number): LedgerTrade => {
      const open = Date.parse(`${day}T15:00:00Z`) + i * 60_000;
      return t(pnl, new Date(open).toISOString(), new Date(open + hold * 60_000).toISOString());
    };
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => mk(50, "2026-03-02", 20, i)),
      ...Array.from({ length: 5 }, (_, i) => mk(-40, "2026-03-03", 120, i)),
    ];
    const r = report(trades);
    expect(r.hold).toEqual({ win_median_minutes: 20, loss_median_minutes: 120 });
    expect(ids(r)).not.toContain("disposition");
  });

  it("赚小亏大:盈亏比 < 1 且胜率离保本线不到 5 个百分点", () => {
    const r = report(daily([40, 40, 40, 40, 40, 40, -100, -100, -100, -100]));
    expect(r.stats.win_rate).toBe(60);
    expect(r.findings.find((f) => f.id === "payoff")?.title).toBe("赚小亏大:平均亏损是平均盈利的 2.5 倍");
  });

  it("几笔大亏:至少 10 笔亏损里最大 3 笔占一半以上;或有一笔超过平均亏损 3 倍", () => {
    const r = report(daily([100, 100, 100, 100, ...Array(8).fill(-20), -300, -300, -300]));
    expect(r.findings.find((f) => f.id === "tail_loss")?.title).toBe("几笔大亏吃掉了大半:最大 3 笔占总亏损 85%");
    // 大头只占三成、但有一笔是平均亏损的 3 倍以上:说的是那一笔,不说"大半"
    const one = report(daily([300, 300, 300, ...Array(20).fill(-50), -500]));
    expect(one.findings.find((f) => f.id === "tail_loss")?.title).toBe("有一笔亏得太多:-$500.00,是平均亏损的 7 倍");
    expect(ids(report(daily([100, 100, -50, -50, -50, -50, -50])))).not.toContain("tail_loss");
  });

  it("处置效应:亏损单持有中位数 > 赚钱单 × 1.5 → bad;反过来 → good", () => {
    const pnls = [50, 50, 50, 50, 50, -40, -40, -40, -40, -40];
    expect(report(daily(pnls, (p) => (p > 0 ? 20 : 120))).findings.find((f) => f.id === "disposition")?.tone).toBe("bad");
    expect(report(daily(pnls, (p) => (p > 0 ? 120 : 20))).findings.find((f) => f.id === "disposition")?.tone).toBe("good");
    expect(ids(report(daily(pnls, () => 60)))).not.toContain("disposition");
  });

  it("处置效应:中位数差了 2 倍、但两组的时长搅在一起(秩和检验没过)→ 不说", () => {
    const winHolds = [10, 200, 30, 400, 50];
    const lossHolds = [300, 20, 100, 15, 500];
    const trades = [...winHolds.map((h, i) => ({ p: 50, h, i })), ...lossHolds.map((h, i) => ({ p: -40, h, i: i + 5 }))].map(({ p, h, i }) => {
      const open = Date.parse("2026-01-05T15:00:00Z") + i * 86_400_000;
      return t(p, new Date(open).toISOString(), new Date(open + h * 60_000).toISOString());
    });
    const r = report(trades);
    expect(r.hold).toEqual({ win_median_minutes: 50, loss_median_minutes: 100 });
    expect(ids(r)).not.toContain("disposition");
  });

  it("报复性交易:亏完 30 分钟内开的仓单独算,更差就报", () => {
    const trades: LedgerTrade[] = [];
    for (let i = 0; i < 6; i += 1) {
      const day = Date.parse("2026-02-02T15:00:00Z") + i * 86_400_000;
      const iso = (ms: number): string => new Date(ms).toISOString();
      trades.push(t(80, iso(day), iso(day + 30 * 60_000)));
      trades.push(t(-50, iso(day + 60 * 60_000), iso(day + 90 * 60_000)));
      trades.push(t(-70, iso(day + 100 * 60_000), iso(day + 130 * 60_000))); // 亏完 10 分钟就又进
    }
    const { quick, rest } = revengeSplit(trades);
    expect([quick.length, rest.length]).toEqual([6, 12]);
    expect(report(trades).findings.find((f) => f.id === "revenge")).toMatchObject({ tone: "bad" });
  });

  it("报复性交易:开平在同一刻的亏损,不把自己的了结当成「之前的那笔亏损」", () => {
    const zero = t(-50, "2026-02-02T15:00:00Z", "2026-02-02T15:00:00Z");
    const later = t(20, "2026-02-02T15:10:00Z", "2026-02-02T15:40:00Z");
    const split = revengeSplit([zero, later]);
    expect([split.quick, split.rest]).toEqual([[later], [zero]]);
  });

  it("报复性交易:那几笔平均是负的、比其余差,但差别还在噪声里 → 不说,也不拿它去建议止损护栏", () => {
    const trades: LedgerTrade[] = [];
    const quickPnl = [-300, 250, -280, 260, -310, 200]; // 平均 −30,自己就上下翻
    for (let i = 0; i < 6; i += 1) {
      const day = Date.parse("2026-02-02T15:00:00Z") + i * 86_400_000;
      const iso = (ms: number): string => new Date(ms).toISOString();
      trades.push(t(80, iso(day), iso(day + 30 * 60_000)));
      trades.push(t(-50, iso(day + 60 * 60_000), iso(day + 90 * 60_000)));
      trades.push(t(quickPnl[i] ?? 0, iso(day + 100 * 60_000), iso(day + 130 * 60_000)));
    }
    const r = report(trades);
    expect(revengeSplit(trades).quick.length).toBe(6);
    expect(ids(r)).not.toContain("revenge");
    expect(r.protection_advice.map((a) => a.rule)).not.toContain("stoploss_guard");
  });

  it("保护规则建议:报复性交易 → 止损护栏;同标的亏完又进 → 冷却;已经开着且更严的不劝", () => {
    const trades: LedgerTrade[] = [];
    for (let i = 0; i < 6; i += 1) {
      const day = Date.parse("2026-02-02T15:00:00Z") + i * 86_400_000;
      const iso = (ms: number): string => new Date(ms).toISOString();
      trades.push(t(80, iso(day), iso(day + 30 * 60_000)));
      trades.push(t(-50, iso(day + 60 * 60_000), iso(day + 90 * 60_000)));
      trades.push(t(-70, iso(day + 100 * 60_000), iso(day + 130 * 60_000)));
    }
    const off = (rule: string): Record<string, unknown> => ({ enabled: false, rule });
    const cfg = {
      stoploss_guard: { ...off("s"), lookback_minutes: 60, trigger_count: 3, pause_minutes: 30 },
      max_drawdown: { ...off("m"), lookback_minutes: 60, max_drawdown_usd: 0, pause_minutes: 30 },
      cooldown: { ...off("c"), minutes: 0 },
      daily_loss: { ...off("d"), max_loss_usd: 0 },
    } as never;
    const advice = performanceReport({ trades, excluded: { open: 0, unknown: 0, no_cost: 0 } },
      { scope: "all", kind: "all", days: null, now: NOW }, { protections: cfg }).protection_advice;
    expect(advice.map((a) => a.rule)).toEqual(["stoploss_guard", "cooldown"]);
    expect(advice[1]).toMatchObject({ suggested: { enabled: true, minutes: 30 } });
    // 每天净亏 40、最差也是 40:线(80)一天都切不到,不建议日亏上限
    const on = { ...cfg as Record<string, Record<string, unknown>>, cooldown: { enabled: true, minutes: 60 }, stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: 2, pause_minutes: 60 } };
    expect(performanceReport({ trades, excluded: { open: 0, unknown: 0, no_cost: 0 } },
      { scope: "all", kind: "all", days: null, now: NOW }, { protections: on as never }).protection_advice).toEqual([]);
  });

  it("止损护栏的建议带一个旁证:这组参数(两小时 3 次)放在这本账上会动几回", () => {
    const at = (hhmm: string, day = 2): string => `2026-03-${String(day).padStart(2, "0")}T${hhmm}:00Z`;
    const trades = [
      t(-10, at("15:00"), at("15:10")), t(-10, at("15:20"), at("15:30")), t(20, at("15:35"), at("15:40")),
      t(-10, at("16:00"), at("16:10")), // 第 3 笔亏损,距第一笔 60 分钟 → 一回
      t(-10, at("16:20"), at("16:30")), // 还在同一回里
      t(-10, at("15:00", 3), at("15:10", 3)), t(-10, at("15:20", 3), at("17:15", 3)), // 第二天只有两笔亏损,不够
    ];
    expect(lossBursts(trades, 120, 3, 60)).toBe(1);
    expect(lossBursts([], 120, 3, 60)).toBe(0);
    // 窗口左开右闭(同真规则):三笔亏损正好隔 60、120 分钟,最早那笔已经出了窗口,凑不够 3 笔
    const edge = (gap: number): LedgerTrade[] => [0, 60, gap].map((m) => {
      const close = Date.parse("2026-03-04T15:00:00Z") + m * 60_000;
      return t(-10, new Date(close - 60_000).toISOString(), new Date(close).toISOString());
    });
    expect([lossBursts(edge(120), 120, 3, 60), lossBursts(edge(119), 120, 3, 60)]).toEqual([0, 1]);
    // 一回 = 一次暂停:0 / 10 / 20 分钟凑够(停到 80 分),125 分那笔又凑够 3 笔(10、20、125)且已过了暂停 → 第二回;
    // 换成 70 分那笔还在暂停里,只是把暂停往后延,不算新的一回
    const seq = (mins: number[]): LedgerTrade[] => mins.map((m) => {
      const close = Date.parse("2026-03-05T15:00:00Z") + m * 60_000;
      return t(-10, new Date(close - 60_000).toISOString(), new Date(close).toISOString());
    });
    expect([lossBursts(seq([0, 10, 20, 125]), 120, 3, 60), lossBursts(seq([0, 10, 20, 70]), 120, 3, 60)]).toEqual([2, 1]);
    // 连亏 4 笔但散在四天:建议照给(连亏 ≥ 4 的门槛没动),同时照实说按亏损了结来数一次也凑不够
    const spread = report(daily([-50, -50, -50, -50, 100, 100]));
    const guard = spread.protection_advice.find((a) => a.rule === "stoploss_guard");
    expect(guard?.reason).toContain("出现过 0 回:按亏损了结来数,这组参数一次也凑不够");
  });

  it("保护规则建议:日亏上限 = 亏钱日平均的 2 倍,取整到 10;要有越过它的日子才建议", () => {
    const trades = daily([-50, 100, -50, 100, -50, 100, -50, -300, 100]);
    const advice = report(trades).protection_advice.find((a) => a.rule === "daily_loss");
    expect(advice).toMatchObject({ suggested: { enabled: true, max_loss_usd: 200 } });
    // 那一天只有那一笔:到线之后没再开仓,线一笔也没拦到——照实说,不说"剩下的亏损就不会发生"
    expect(advice).toMatchObject({ replay: { days_hit: 1, skipped: 0, skipped_pnl: 0 } });
    expect(advice?.reason).toContain("1 天净亏碰到过线,到线之后当天没有再开过新仓,这条线在这本账上一笔也没拦到");
    expect(advice?.reason).not.toContain("不会发生");
    expect(report(daily([-50, 100, -50, 100, -50, 100, -50, -60, 100])).protection_advice.find((a) => a.rule === "daily_loss")).toBeUndefined();
  });

  it("日亏上限的回放:到线之后开的仓才算拦下,赚的也一起拦掉;到线之前开着的照常走完", () => {
    const at = (hhmm: string): string => `2026-03-02T${hhmm}:00Z`; // 美东冬令时,15:00Z = 10:00
    const trades = [
      t(-150, at("15:00"), at("15:30")),
      t(-80, at("15:10"), at("16:30")), // 到线之前就开着:15:40 平成 −230 之后它还在,照常走完
      t(-80, at("15:35"), at("15:40")), // 15:40 当天已实现 −230,到线(200)
      t(120, at("15:50"), at("16:00")), // ← 拦下:它其实是赚的
      t(-60, at("16:10"), at("16:20")), // ← 拦下
      t(-40, null, at("16:40")), // 开仓时刻不明
      t(500, "2026-03-03T15:00:00Z", "2026-03-03T15:30:00Z"), // 第二天:重新算
    ];
    expect(dailyLossReplay(trades, 200)).toEqual({ days_hit: 1, skipped: 2, skipped_wins: 1, skipped_losses: 1, skipped_pnl: 60, unknown_open: 1 });
    // 线放到 400:这一天最深只到 −290,一笔不拦
    expect(dailyLossReplay(trades, 400)).toMatchObject({ days_hit: 0, skipped: 0 });
  });

  it("日亏上限的回放:日子按美东切(冬令时、夏令时各一遍),正好在开仓那一刻了结的亏损算已实现", () => {
    // 冬令时(美东 = UTC−5):3 月 2 日 18:30 亏到线。19:30、23:30 还是美东 3 月 2 日(UTC 已经是 3 日),拦;00:30 是美东 3 日,不拦
    const winter = [
      t(-300, "2026-03-02T23:00:00Z", "2026-03-02T23:30:00Z"),
      t(10, "2026-03-02T23:30:00Z", "2026-03-02T23:40:00Z"), // 开仓正好在那笔亏损了结的一刻:拦
      t(10, "2026-03-03T00:30:00Z", "2026-03-03T00:40:00Z"),
      t(10, "2026-03-03T04:30:00Z", "2026-03-03T04:40:00Z"),
      t(10, "2026-03-03T05:30:00Z", "2026-03-03T05:40:00Z"),
    ];
    expect(dailyLossReplay(winter, 200)).toMatchObject({ days_hit: 1, skipped: 3, skipped_pnl: 30 });
    // 夏令时(3 月 8 日起,美东 = UTC−4):03:30Z 是美东前一天 23:30,拦;04:30Z 已经是第二天 00:30,不拦
    const summer = [
      t(-300, "2026-03-09T20:00:00Z", "2026-03-09T20:30:00Z"),
      t(10, "2026-03-10T03:30:00Z", "2026-03-10T03:40:00Z"),
      t(10, "2026-03-10T04:30:00Z", "2026-03-10T04:40:00Z"),
    ];
    expect(dailyLossReplay(summer, 200)).toMatchObject({ days_hit: 1, skipped: 1, skipped_pnl: 10 });
  });

  it("日亏上限的回放:和真规则一样现算——开着的仓平回来、净亏回到线以内,后面的单就不拦", () => {
    const at = (hhmm: string): string => `2026-03-02T${hhmm}:00Z`;
    const trades = [
      t(-250, at("15:00"), at("15:30")), // 到线
      t(300, at("15:05"), at("15:45")), // 早就开着的,平回来 → 当天净 +50
      t(-70, at("15:40"), at("15:50")), // 15:40 开:那一刻净 −250,拦下
      t(-90, at("16:00"), at("16:10")), // 16:00 开:那一刻净 +50,不拦
    ];
    expect(dailyLossReplay(trades, 200)).toMatchObject({ days_hit: 1, skipped: 1, skipped_losses: 1, skipped_pnl: -70 });
  });

  it("日亏上限的建议里写回放出来的数:拦下的那些合计是赚是亏都照实说", () => {
    // 5 个亏钱日,其中一天:先亏 400(到线),之后又开两笔 −100、+30
    const quiet = daily([-50, -50, -50, -50, 100, 100]);
    const day = "2026-02-20";
    const bad = [
      t(-400, `${day}T15:00:00Z`, `${day}T15:30:00Z`),
      t(-100, `${day}T16:00:00Z`, `${day}T16:30:00Z`),
      t(30, `${day}T17:00:00Z`, `${day}T17:30:00Z`),
    ];
    const advice = report([...quiet, ...bad]).protection_advice.find((a) => a.rule === "daily_loss");
    // 亏钱日:−50 × 4、−470 → 平均 −134 → 线 270
    expect(advice).toMatchObject({ suggested: { max_loss_usd: 270 }, replay: { days_hit: 1, skipped: 2, skipped_wins: 1, skipped_losses: 1, skipped_pnl: -70 } });
    expect(advice?.reason).toContain("到线之后当天又开的 2 笔(赚 1、亏 1)合计 -$70.00,拦下它们少亏 $70.00");
    expect(advice?.reason).toContain("线是拿这同一段历史定的");
  });

  it("亏后加码:亏损之后下一笔的占用放大到中位数 1.5 倍以上", () => {
    const pnls = [50, -50, 50, -50, 50, -50, 50, -50, 50, -50, 50, -50];
    // 亏损之后的那一笔(偶数位,除第一笔)占用 3000,其余 1000
    const trades = daily(pnls, () => 60, (i) => ({ exposure: i > 0 && i % 2 === 0 ? 3000 : 1000 }));
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 5, upAfterLoss: 5, afterWin: 6, upAfterWin: 0 });
    expect(ids(report(trades))).toContain("size_after_loss");
    expect(ids(report(daily(pnls, () => 60, () => ({ exposure: 1000 }))))).not.toContain("size_after_loss");
  });

  it("亏后加码不偷看后来的事:开仓时上一笔还没平,就不知道它会亏——比的是那一刻已经平掉的最后一笔", () => {
    const iso = (day: number, hhmm: string): string => `2026-03-${String(day).padStart(2, "0")}T${hhmm}:00Z`;
    const trades = [
      t(40, iso(2, "15:00"), iso(2, "16:00"), { exposure: 1000 }), // A 赢,3 月 2 日平
      t(-500, iso(3, "15:00"), iso(5, "16:00"), { exposure: 1000 }), // B 拿了三天才亏着平
      t(30, iso(4, "15:00"), iso(4, "16:00"), { exposure: 3000 }), // C 在 B 还开着的时候放大:那时最后平掉的是 A(赢)
      t(20, iso(6, "15:00"), iso(6, "16:00"), { exposure: 1000 }), // D:B 平掉之后开的,没放大
    ];
    // 按开仓次序比的话,C 会被算成"B 亏了之后加码"。A 之后的头一笔是 B(没放大),C 不是谁的"头一笔";B 之后的头一笔是 D
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 1, upAfterLoss: 0, afterWin: 1, upAfterWin: 0 });
  });

  it("亏后加码:一次亏损只认它后面的头一笔——亏一笔之后接连开五只蝶是一次,不是五次", () => {
    const day = (d: number, hhmm: string): string => `2026-03-${String(d).padStart(2, "0")}T${hhmm}:00Z`;
    const trades = [
      ...Array.from({ length: 7 }, (_, i) => t(40, day(2 + i, "15:00"), day(2 + i, "16:00"), { kind: "butterfly", exposure: 300 })),
      t(-200, day(10, "15:00"), day(10, "16:00"), { kind: "butterfly", exposure: 300 }),
      // 亏完之后 5 分钟内连开 5 只、每只都是平常的 3 倍,拿到第二天
      ...Array.from({ length: 5 }, (_, i) => t(30, day(10, `16:0${i + 1}`), day(11, "20:00"), { kind: "butterfly", exposure: 900 })),
    ];
    const got = sizeAfterLoss(trades);
    expect([got.afterLoss, got.upAfterLoss]).toEqual([1, 1]);
    expect(ids(report(trades))).not.toContain("size_after_loss"); // 一笔亏损凑不够"≥ 5 次"
  });

  it("亏后加码:上一笔正好在这一笔开仓的那一刻了结,算已经知道", () => {
    const trades = [
      t(-80, "2026-03-02T15:00:00Z", "2026-03-02T16:00:00Z", { exposure: 1000 }),
      t(10, "2026-03-02T16:00:00Z", "2026-03-02T17:00:00Z", { exposure: 3000 }),
      t(10, "2026-03-03T16:00:00Z", "2026-03-03T17:00:00Z", { exposure: 1000 }),
    ];
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 1, upAfterLoss: 1, afterWin: 1, upAfterWin: 0 });
  });

  it("亏后加码:对照的那一边(赢后)不到 5 次时不说", () => {
    const iso = (d: number, hhmm: string): string => `2026-04-${String(d).padStart(2, "0")}T${hhmm}:00Z`;
    const trades = [
      // 六笔平常大小的垫底(同时开、同时持平了结):只为把占用的中位数定在 1000,自己不是谁的"上一笔"
      ...Array.from({ length: 6 }, () => t(0.1, iso(1, "14:00"), iso(1, "14:30"), { exposure: 1000 })),
      t(-50, iso(2, "15:00"), iso(2, "16:00"), { exposure: 1000 }),
      ...Array.from({ length: 4 }, (_, i) => t(-50, iso(3 + i, "15:00"), iso(3 + i, "16:00"), { exposure: 3000 })),
      t(60, iso(7, "15:00"), iso(7, "16:00"), { exposure: 3000 }),
      t(60, iso(8, "15:00"), iso(8, "16:00"), { exposure: 1000 }),
    ];
    // 5 次亏后全放大;赢后只有 1 次。两个比例之差的区间下界是正的(0.095),只是对照组太小
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 5, upAfterLoss: 5, afterWin: 1, upAfterWin: 0 });
    expect(ids(report(trades))).not.toContain("size_after_loss");
  });

  it("亏后加码:没有开仓时刻的亏损(导入的出场事件)也算上一笔——那一笔亏了,人是知道的", () => {
    const trades = [
      t(-80, null, "2026-03-02T16:00:00Z"),
      t(10, "2026-03-02T17:00:00Z", "2026-03-02T18:00:00Z", { exposure: 3000 }),
      t(10, "2026-03-03T17:00:00Z", "2026-03-03T18:00:00Z", { exposure: 1000 }),
      t(10, "2026-03-04T17:00:00Z", "2026-03-04T18:00:00Z", { exposure: 1000 }),
    ];
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 1, upAfterLoss: 1, afterWin: 2, upAfterWin: 0 });
  });

  it("亏后加码:同一刻了结的几笔(几只蝶一起到期结算)合起来看是赚是亏,不任意挑一笔", () => {
    const settle = "2026-03-02T21:00:00Z";
    const next = (pnls: [number, number]) => sizeAfterLoss([
      t(pnls[0], "2026-03-02T15:00:00Z", settle, { exposure: 1000 }),
      t(pnls[1], "2026-03-02T16:00:00Z", settle, { exposure: 1000 }),
      t(10, "2026-03-03T15:00:00Z", "2026-03-03T16:00:00Z", { exposure: 3000 }),
      t(10, "2026-03-04T15:00:00Z", "2026-03-04T16:00:00Z", { exposure: 1000 }),
    ]);
    // −300 与 +40 一起结算:那一刻净亏,第二天放大的那笔算"亏后";两笔换个次序结果一样
    expect(next([-300, 40])).toEqual({ afterLoss: 1, upAfterLoss: 1, afterWin: 1, upAfterWin: 0 });
    expect(next([40, -300])).toEqual({ afterLoss: 1, upAfterLoss: 1, afterWin: 1, upAfterWin: 0 });
    expect(next([300, -40])).toEqual({ afterLoss: 0, upAfterLoss: 0, afterWin: 2, upAfterWin: 1 });
  });

  it("亏后加码:亏后放大的比例比赢后高,但次数太少、两个比例之差的区间跨 0 → 不说", () => {
    // 亏后 5 次里放大 2 次(40%),赢后 6 次里放大 1 次(17%):差 23 个百分点,够了老门槛,但 5 次对 6 次说明不了什么
    const pnls = [50, -50, 50, -50, 50, -50, 50, -50, 50, -50, 50, -50];
    const big = new Set([2, 4, 3]); // 第 2、4 位在亏损之后,第 3 位在盈利之后
    const trades = daily(pnls, () => 60, (i) => ({ exposure: big.has(i) ? 3000 : 1000 }));
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 5, upAfterLoss: 2, afterWin: 6, upAfterWin: 1 });
    expect(ids(report(trades))).not.toContain("size_after_loss");
  });

  it("亏后加码按同品种的中位数比:股票的名义金额不和蝶的权利金混在一起", () => {
    // 股票与蝴蝶穿插、输赢交替;每类自己的占用都一样大——混成一个中位数时股票笔笔都像"放大"
    const pnls = [50, -50, 50, -50, 50, -50, 50, -50, 50, -50, 50, -50];
    const mixed = daily(pnls, () => 60, (i) => (i % 3 === 0 ? { kind: "stock", exposure: 10000 } : { kind: "butterfly", exposure: 300 }));
    expect(sizeAfterLoss(mixed).upAfterLoss).toBe(0);
    expect(ids(report(mixed))).not.toContain("size_after_loss");
  });

  it("赚小亏大:胜率低于保本线时说低多少,不说「高 -5 个百分点」", () => {
    const r = report(daily([40, 40, 40, 40, -100, -100, -100, -100, -100, -100]));
    expect(r.findings.find((f) => f.id === "payoff")?.text).toContain("胜率比保本线(71.4%)还低 31.4 个百分点");
  });

  it("时段:有优势的时段赚、别的时段亏(每组至少 8 笔)", () => {
    const at = (h: string, i: number, pnl: number): LedgerTrade => {
      const day = `2026-06-${String(i + 2).padStart(2, "0")}`;
      return t(pnl, `${day}T${h}:00Z`, `${day}T${h}:30Z`);
    };
    const trades = [
      ...Array.from({ length: 8 }, (_, i) => at("13:35", i, 60)), // 开盘 30 分钟(美东夏令时 09:35)
      ...Array.from({ length: 8 }, (_, i) => at("17:00", i, -40)), // 午盘
    ].sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
    const f = report(trades).findings.find((x) => x.id === "session");
    expect(f?.title).toBe("时段差异:开盘半小时赚、午后亏");
  });

  it("时段:一个时段平均赚、一个平均亏,但各自上下翻得厉害(差别在噪声里)→ 不说", () => {
    const at = (h: string, i: number, pnl: number): LedgerTrade => {
      const day = `2026-06-${String(i + 2).padStart(2, "0")}`;
      return t(pnl, `${day}T${h}:00Z`, `${day}T${h}:30Z`);
    };
    const open = [300, -250, 280, -260, 310, -240, 290, -200]; // 平均 +28.75
    const noon = [-300, 250, -280, 260, -310, 240, -290, 200]; // 平均 −28.75
    const trades = [...open.map((p, i) => at("13:35", i, p)), ...noon.map((p, i) => at("17:00", i, p))]
      .sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
    const r = report(trades);
    expect(r.groups.session.map((g) => [g.label, g.trades, g.expectancy])).toEqual([["开盘半小时", 8, 28.75], ["午后", 8, -28.75]]);
    expect(ids(r)).not.toContain("session");
  });

  it("时段:从三个时段里挑最好与最差,置信水平按 3 对收紧——只有两个时段时过得去的差别,这时过不去", () => {
    const at = (h: string, i: number, pnl: number): LedgerTrade => {
      const day = `2026-06-${String(i + 2).padStart(2, "0")}`;
      return t(pnl, `${day}T${h}:00Z`, `${day}T${h}:30Z`);
    };
    // 每组 8 笔、标准差都是 50:平均 ±30 的两组之差 60,标准误 25。t(14) 的 97.5% 分位 2.145(→ ±53.6,不跨 0),
    // 三个时段 3 对、水平收紧到 98.33% 时分位 2.72(→ ±68,跨 0)
    const spread = (mean: number): number[] => [1, -1, 1, -1, 1, -1, 1, -1].map((z) => Math.round((mean + z * 46.77) * 100) / 100);
    const open = spread(30).map((p, i) => at("13:35", i, p)); // 开盘半小时
    const noon = spread(-30).map((p, i) => at("17:00", i, p)); // 午后
    const late = spread(1).map((p, i) => at("19:30", i, p)); // 尾盘一小时,不好不坏
    const byClose = (xs: LedgerTrade[]): LedgerTrade[] => [...xs].sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
    expect(ids(report(byClose([...open, ...noon])))).toContain("session");
    expect(ids(report(byClose([...open, ...noon, ...late])))).not.toContain("session");
  });

  it("过度交易:做得多的那几天每笔明显更差才说;只是平均低一点、差别在噪声里不说", () => {
    const mk = (busyPnl: number[]): LedgerTrade[] => {
      const out: LedgerTrade[] = [];
      for (let d = 0; d < 9; d += 1) {
        const day = `2026-04-${String(d + 1).padStart(2, "0")}`;
        const busy = d < 3;
        const n = busy ? 5 : 1;
        for (let k = 0; k < n; k += 1) {
          const hh = String(14 + k).padStart(2, "0");
          out.push(t(busy ? busyPnl[(d * 5 + k) % busyPnl.length] ?? 0 : 60, `${day}T${hh}:00:00Z`, `${day}T${hh}:30:00Z`));
        }
      }
      return out;
    };
    expect(ids(report(mk([-40, -50, -45, -55, -35])))).toContain("overtrading");
    // 忙的日子平均 −10、其余 +60,但忙的那 15 笔在 ±500 之间翻:区间跨 0
    expect(ids(report(mk([-500, 480, -520, 500, -10])))).not.toContain("overtrading");
  });

  it("最近 10 笔走弱:全部为正、最近为负 → 提醒缩仓(渐进式仓位)", () => {
    const r = report(daily([...Array(10).fill(200), ...Array(10).fill(-30)]));
    expect(r.recent?.stats.expectancy).toBe(-30);
    expect(r.findings.find((f) => f.id === "recent")).toMatchObject({ tone: "warn" });
  });

  it("最近 10 笔明显好于之前 → good;只是高一点、差别在噪声里 → 不说", () => {
    const better = report(daily([...Array(10).fill(-30), ...Array(10).fill(200)]));
    expect(better.findings.find((f) => f.id === "recent")).toMatchObject({ tone: "good", title: "最近 10 笔好于平均:每笔 $200.00" });
    const swing = [400, -350, 420, -300, 380, -340, 410, -330, 390, -310];
    const noisy = report(daily([...swing, ...swing.map((x) => x + 30)])); // 最近 10 笔每笔多 30,淹在 ±400 里
    expect((noisy.recent?.stats.expectancy ?? 0) > (noisy.stats.expectancy ?? 0)).toBe(true);
    expect(ids(noisy)).not.toContain("recent");
  });

  it("最近 10 笔比的是它之前的那些(两组不重叠),文案里说的也是那一组", () => {
    // 之前 10 笔 380 / 20 交替(平均 200),最近 10 笔 150 / −210 交替(平均 −30):和之前比差 230、出了噪声;
    // 和"全部"(把最近这 10 笔自己也掺进去)比只差 115、还在噪声里——比错了对象这条就不会说
    const r = report(daily([...Array.from({ length: 10 }, (_, i) => (i % 2 ? 20 : 380)), ...Array.from({ length: 10 }, (_, i) => (i % 2 ? -210 : 150))]));
    const f = r.findings.find((x) => x.id === "recent");
    expect(f).toMatchObject({ tone: "warn", title: "最近 10 笔在走弱:平均每笔 -$30.00" });
    expect(f?.text).toContain("之前的 10 笔平均每笔 $200.00,全部样本 $85.00。");
  });

  it("最近 10 笔:平均是负的,但和之前那些比差别在噪声里 → 不说在走弱", () => {
    const swing = [400, -350, 420, -300, 380, -340, 410, -330, 390, -310]; // 平均 +37
    const r = report(daily([...swing, ...swing.map((x) => -x * 0.2 - 20)])); // 最近 10 笔平均 −27.4
    expect(r.recent?.stats.expectancy).toBe(-27.4);
    expect((r.stats.expectancy ?? 0) > 0).toBe(true);
    expect(ids(r)).not.toContain("recent");
  });

  it("每条都写明借鉴自谁", () => {
    const r = report(daily([40, 40, 40, 40, 40, 40, -100, -100, -100, -600], (p) => (p > 0 ? 10 : 90)));
    expect(r.findings.length).toBeGreaterThan(3);
    expect(r.findings.every((f) => f.source.length > 0 && f.text.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- RPC

const servers: RpcServer[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("review.performance:RPC", () => {
  function makeServer(): (m: string, p?: Rec) => Promise<Rec> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-perf-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      ...base,
      accounts: [{ alias: "主账户", account_id: ACCT, is_paper: false, connection: "paper", default: true }],
      storage: { db_path: path.join(dir, "t.db") },
    }));
    const s = new RpcServer(settingsPath, () => undefined);
    servers.push(s);
    s.engine.store.rememberFills([...FLY_FILLS, ...STOCK_FILLS]);
    s.engine.store.imports.rememberOptionTrades(parseOptionTradesCsv(OPT_CSV, ACCT, "t.csv").rows);
    return async (method, params = {}) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  }

  it("没连券商:到期那只蝶的结算价取不到,不进账、记成结果不明;其余照算", async () => {
    const call = makeServer();
    const r = (await call("review.performance", {}))["result"];
    expect(r["stats"]["trades"]).toBe(7);
    expect(r["stats"]["net_pnl"]).toBe(-78.2);
    expect(r["excluded"]).toEqual({ open: 0, unknown: 1, no_cost: 0 });
    expect(r["scope"]).toBe("all");
    expect(Object.keys(r).sort()).toEqual([
      "days", "drawdown", "equity", "excluded", "execution", "findings", "groups", "hold", "kelly", "kind", "mix", "notes", "per_day",
      "protection_advice", "r_coverage", "r_stats", "recent", "scope", "stats", "streak", "trades",
    ]);
    expect(r["mix"]).toEqual({ live: 7, paper: 0 });
    expect(r["r_coverage"]).toMatchObject({ trades: 7, with_r: 1, max_loss: 1, stop: 0 });
    // 没有自动平仓的痕:执行损耗全空,不编
    expect(r["execution"]).toMatchObject({ samples: 0, missing: 0, median_pct: null, commission_usd: null });
  });

  it("股票的 R:取 tracker_add 审计里开仓后不久设的止损(追踪行删了也还在)", async () => {
    const call = makeServer();
    const s = servers[servers.length - 1]!;
    // 审计表只增不改(触发器),所以直接插带时刻的痕:SPCX 开仓 5 分钟后设的止损;RKLB 的止损是两小时后才设的
    const raw = new Database(s.engine.store.dbPath);
    const add = raw.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)");
    add.run("2026-09-02T14:05:00+00:00", "ui", "tracker_add",
      JSON.stringify({ symbol: "SPCX", account: "主账户", sec_type: "STK", targets: { stop_loss: 95 } }));
    add.run("2026-09-01T16:00:00+00:00", "ui", "tracker_add",
      JSON.stringify({ symbol: "RKLB", account: "主账户", sec_type: "STK", targets: { stop_loss: 48 } }));
    raw.close();
    const r = (await call("review.performance", { kind: "stock" }))["result"];
    const bySymbol = (sym: string): Rec | undefined => (r["trades"] as Rec[]).find((x) => x["symbol"] === sym);
    expect(bySymbol("SPCX")).toMatchObject({ risk: 50, r: -2, risk_basis: "stop", r_missing: null });
    expect(bySymbol("RKLB")).toMatchObject({ risk: null, r: null, r_missing: "late_stop" });
    expect(r["r_coverage"]).toMatchObject({ trades: 2, with_r: 1, stop: 1, missing: [{ reason: "late_stop", trades: 1 }] });
  });

  it("入参:范围与品种认枚举,天数是 1–3650 的整数", async () => {
    const call = makeServer();
    expect((await call("review.performance", { kind: "stock", scope: "live" }))["result"]["stats"]["net_pnl"]).toBe(400);
    expect((await call("review.performance", { scope: "demo" }))["error"]["code"]).toBe(-32602);
    expect((await call("review.performance", { days: 0 }))["error"]["message"]).toContain("1 到 3650");
    expect((await call("review.performance", { days: 1.5 }))["error"]["code"]).toBe(-32602);
  });
});
