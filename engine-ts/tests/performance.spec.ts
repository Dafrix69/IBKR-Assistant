/** 绩效体检(performance.ts + review.performance):美元账本、统计口径、行为规则。夹具是造的,全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { LedgerTrade } from "../src/contract/performance.js";
import { groupButterflies } from "../src/ibtrades.js";
import { parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import {
  buildLedger, equityCurve, kellyOf, perfStats, performanceReport, revengeSplit, rStats, sessionOf, sizeAfterLoss, sqnLabel,
} from "../src/performance.js";
import type { Ledger } from "../src/performance.js";
import { RpcServer } from "../src/rpc.js";
import { groupStockTrips } from "../src/stockreview.js";

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
    net_of_commission: true, risk: null, r: null, exposure: null, hold_minutes: hold, paper: false, ...extra,
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
  });

  it("股票:平完的一段一笔,占用 = 均价 × 股数;没有 R", () => {
    const stocks = ledger.trades.filter((x) => x.kind === "stock").map((x) => [x.symbol, x.pnl, x.exposure, x.r]);
    expect(stocks).toEqual([["RKLB", 500, 5000, null], ["SPCX", -100, 1000, null]]);
  });

  it("导入的期权:一次出场一笔,盈亏照导出(已扣佣金),没有开仓时刻", () => {
    const opts = ledger.trades.filter((x) => x.kind === "option");
    expect(opts.map((x) => x.pnl)).toEqual([-263.2, 120, -300, 50]);
    expect(opts.every((x) => x.opened_at === null && x.hold_minutes === null)).toBe(true);
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
    expect(r.trades[0]?.pnl).toBe(1445); // 新的在前
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

  it("SQN:不到 10 笔不算,N 封顶 100;档位按 Tharp", () => {
    const rs = (xs: number[]) => rStats(xs.map((x) => t(x * 100, null, "2026-01-01T00:00:00Z", { r: x, risk: 100 })));
    expect(rs([1, -1, 2]).sqn).toBeNull();
    expect(rs([2, -1, 2, -1, 2, -1, 2, -1, 2, -1])).toMatchObject({ trades: 10, expectancy_r: 0.5, sqn: 1, sqn_label: "差" });
    expect([sqnLabel(1.7), sqnLabel(2.2), sqnLabel(2.7), sqnLabel(3.5)]).toEqual(["一般", "好", "很好", "极好"]);
  });

  it("凯利:f = W − (1 − W) / 盈亏比;输赢不到 8 笔不算", () => {
    expect(kellyOf(perfStats(daily([100, -50, 100, -50, 100, -50, 100, -50])))).toBe(0.25);
    expect(kellyOf(perfStats(daily([100, -50])))).toBeNull();
  });

  it("美东开仓时段", () => {
    expect(sessionOf("2026-09-23T13:45:00Z")?.label).toBe("开盘 30 分钟");
    expect(sessionOf("2026-09-23T14:40:00Z")?.label).toBe("上午");
    expect(sessionOf("2026-09-23T17:00:00Z")?.label).toBe("午盘");
    expect(sessionOf("2026-09-23T19:45:00Z")?.label).toBe("尾盘 30 分钟");
    expect(sessionOf("2026-09-23T21:00:00Z")?.label).toBe("盘外");
    expect(sessionOf(null)).toBeNull();
  });

  it("equityCurve:没回撤过时恢复因子是 null", () => {
    expect(equityCurve(daily([10, 20])).drawdown).toMatchObject({ max: 0, recovery_factor: null });
  });
});

// ---------------------------------------------------------------- 规则

describe("行为规则", () => {
  it("样本不足先说;期望值为负说 bad", () => {
    const r = report(daily([-100, 50, -100, 50, -100, 50]));
    expect(r.findings[0]).toMatchObject({ id: "sample", tone: "info" });
    expect(r.findings.find((f) => f.id === "expectancy")).toMatchObject({ tone: "bad" });
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

  it("亏后加码:亏损之后下一笔的占用放大到中位数 1.5 倍以上", () => {
    const pnls = [50, -50, 50, -50, 50, -50, 50, -50, 50, -50, 50, -50];
    // 亏损之后的那一笔(偶数位,除第一笔)占用 3000,其余 1000
    const trades = daily(pnls, () => 60, (i) => ({ exposure: i > 0 && i % 2 === 0 ? 3000 : 1000 }));
    expect(sizeAfterLoss(trades)).toEqual({ afterLoss: 5, upAfterLoss: 5, afterWin: 6, upAfterWin: 0 });
    expect(ids(report(trades))).toContain("size_after_loss");
    expect(ids(report(daily(pnls, () => 60, () => ({ exposure: 1000 }))))).not.toContain("size_after_loss");
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
    expect(f?.title).toBe("时段差异:开盘 30 分钟赚、午盘亏");
  });

  it("最近 10 笔走弱:全部为正、最近为负 → 提醒缩仓(渐进式仓位)", () => {
    const r = report(daily([...Array(10).fill(200), ...Array(10).fill(-30)]));
    expect(r.recent?.stats.expectancy).toBe(-30);
    expect(r.findings.find((f) => f.id === "recent")).toMatchObject({ tone: "warn" });
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
      "days", "drawdown", "equity", "excluded", "findings", "groups", "hold", "kelly", "kind", "notes", "per_day",
      "r_stats", "recent", "scope", "stats", "streak", "trades",
    ]);
  });

  it("入参:范围与品种认枚举,天数是 1–3650 的整数", async () => {
    const call = makeServer();
    expect((await call("review.performance", { kind: "stock", scope: "live" }))["result"]["stats"]["net_pnl"]).toBe(400);
    expect((await call("review.performance", { scope: "demo" }))["error"]["code"]).toBe(-32602);
    expect((await call("review.performance", { days: 0 }))["error"]["message"]).toContain("1 到 3650");
    expect((await call("review.performance", { days: 1.5 }))["error"]["code"]).toBe(-32602);
  });
});
