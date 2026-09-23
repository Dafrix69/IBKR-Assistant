/** 下单页「历史相似交易」(tradeSimilar.ts + ideas.similar_trades):规则打分,不调模型。夹具是造的,全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { IdeasSimilarTradesParams } from "../src/contract/ideas.js";
import { BrokerRouter } from "../src/broker.js";
import { groupButterflies } from "../src/ibtrades.js";
import { parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import { RpcServer } from "../src/rpc.js";
import { groupStockTrips } from "../src/stockreview.js";
import { butterflyFacts, optionFacts, stockFacts } from "../src/tradeOutcomes.js";
import {
  butterflyEntries, dteBucket, findSimilar, optionEntries, priceAt, rangeBucket, rangePosition, slotOf, stockEntries,
} from "../src/tradeSimilar.js";

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

// 2026-09-10(美东夏令时,UTC−4):10:27 开的 25 宽看跌蝶 5.4 → 4.55 平掉;12:00 开的 20 宽看涨蝶 3.55 拿到期(收 7682 → 赚)
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

const NOW = Date.parse("2026-09-23T14:40:00Z"); // 美东 10:40,上午
const SETTLE = (s: string, d: string): number | null => (s === "SPX" && d === "2026-09-10" ? 7682 : null);

function history(): ReturnType<typeof butterflyEntries> {
  const flies = groupButterflies(FLY_FILLS, ACCOUNTS);
  const flyF = butterflyFacts(flies, SETTLE, NOW);
  const optRows = parseOptionTradesCsv(OPT_CSV, ACCT, "t.csv").rows;
  const optF = optionFacts(optRows, () => false);
  const stkF = stockFacts(groupStockTrips(STOCK_FILLS, ACCOUNTS, null));
  return [...butterflyEntries(flies, flyF), ...optionEntries(optRows, optF), ...stockEntries(stkF)];
}

const FLY_TICKET: IdeasSimilarTradesParams = {
  sec_type: "BAG", symbol: "SPX", action: "BUY", limit_price: 5.0, expiry: "20260923", right: null, combo_strategy: "BUTTERFLY",
  legs: [
    { action: "BUY", ratio: 1, strike: 7700, right: "P" },
    { action: "SELL", ratio: 2, strike: 7725, right: "P" },
    { action: "BUY", ratio: 1, strike: 7750, right: "P" },
  ],
};

describe("口径", () => {
  it("美东时段与到期桶", () => {
    expect(slotOf(Date.parse("2026-09-23T13:45:00Z"))).toBe("开盘半小时");
    expect(slotOf(Date.parse("2026-09-23T14:40:00Z"))).toBe("上午");
    expect(slotOf(Date.parse("2026-09-23T19:30:00Z"))).toBe("尾盘一小时");
    expect(slotOf(Date.parse("2026-09-23T21:00:00Z"))).toBe("盘外");
    expect(dteBucket("20260923", "2026-09-23")).toBe("当日到期");
    expect(dteBucket("2026-09-26", "2026-09-23")).toBe("一周内到期");
    expect(dteBucket("20261016", "2026-09-23")).toBe("一周以上到期");
  });
});

describe("findSimilar:蝴蝶", () => {
  const got = findSimilar(FLY_TICKET, history(), NOW);

  it("按票据说清楚比的是什么", () => {
    expect(got.kind).toBe("butterfly");
    expect(got.basis).toEqual(["SPX 看跌蝴蝶", "翼宽 25", "当日到期", "上午", "权利金 / 翼宽 0.20"]);
  });

  it("有行权价的蝴蝶逐项比;导入的只能粗配;垂直价差、股票不算", () => {
    const rows = got.matches.map((m) => [m.fact.id, m.score, m.reasons]);
    expect(rows[0]).toEqual(["ib:101", 7, [
      "同标的同结构", "同为看跌", "翼宽相近(25 / 25)", "同为当日到期", "同在上午开仓", "权利金 / 翼宽相近(0.22)",
    ]]);
    // 看涨、午后开的,只有翼宽、到期、权利金 / 翼宽(3.55 / 20 = 0.18)相近
    expect(rows[1]).toEqual(["ib:103", 5, ["同标的同结构", "翼宽相近(20 / 25)", "同为当日到期", "权利金 / 翼宽相近(0.18)"]]);
    expect(rows.slice(2).map((r) => r[1])).toEqual([1, 1, 1]);
    expect(got.matches.some((m) => m.fact.label.includes("垂直价差"))).toBe(false);
    expect(got.matches.find((m) => m.fact.label.includes("多个仓位"))?.reasons[0]).toBe("同标的、多只同时到期(大概率是蝴蝶)");
  });

  it("胜负与出场方式:同一批,只数 primary", () => {
    expect([got.count, got.win, got.loss]).toEqual([5, 2, 3]);
    expect(got.exits).toEqual([
      { exit: "提前平仓", win: 1, loss: 1, flat: 0, open: 0, unknown: 0 },
      { exit: "持有到期", win: 1, loss: 1, flat: 0, open: 0, unknown: 0 },
      { exit: "拆腿", win: 0, loss: 1, flat: 0, open: 0, unknown: 0 },
    ]);
  });
});

describe("findSimilar:股票", () => {
  it("同标的算胜负;同板块的只列出来", () => {
    const ticket: IdeasSimilarTradesParams = { sec_type: "STK", symbol: "RKLB", action: "BUY" };
    const got = findSimilar(ticket, history(), NOW, new Set(["SPCX"]));
    expect(got.matches.map((m) => [m.fact.symbol, m.primary, m.score, m.reasons])).toEqual([
      ["RKLB", true, 3, ["同标的", "同为做多"]],
      ["SPCX", false, 2, ["同板块(SPCX)", "同为做多"]],
    ]);
    expect([got.count, got.win, got.loss]).toEqual([1, 1, 0]);
  });

  it("历史里没有:空结果,不报错", () => {
    const got = findSimilar({ sec_type: "STK", symbol: "ZZZZ", action: "BUY" }, history(), NOW);
    expect([got.count, got.matches.length, got.exits.length]).toEqual([0, 0, 0]);
  });
});

/** 日线:从 2026-08-01 起每天一根,高 60 低 40(区间固定,位置好算) */
function dailyBars(days = 40): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    out.push({ date: d, open: 50, high: 60, low: 40, close: 50 });
  }
  return out;
}

describe("要行情的两项", () => {
  it("近期区间:只看那天之前的 20 根;不够 20 根不算;可以出界", () => {
    expect(rangePosition(dailyBars(), "2026-09-01", 50)).toBe(0.5);
    expect(rangePosition(dailyBars(), "2026-08-10", 50)).toBeNull(); // 之前只有 9 根
    expect(rangePosition(dailyBars(), "2026-09-01", 65)).toBe(1.25);
    expect([rangeBucket(0.2), rangeBucket(0.5), rangeBucket(1.25)]).toEqual(["低位", "中间", "高位"]);
  });

  it("开仓那一刻的标的价:该分钟或之前最后一根的收盘;没覆盖到是 null", () => {
    const bars = [
      { time: "2026-09-10 10:26", close: 7690 },
      { time: "2026-09-10 10:27", close: 7700 },
      { time: "2026-09-10 10:28", close: 7710 },
    ];
    expect(priceAt(bars, Date.parse("2026-09-10T14:27:29Z"))).toBe(7700);
    expect(priceAt(bars, Date.parse("2026-09-10T13:00:00Z"))).toBeNull();
  });

  it("蝴蝶:有开仓时标的价与现价时,比中心离现价几个翼宽", () => {
    const flies = groupButterflies(FLY_FILLS, ACCOUNTS);
    const facts = butterflyFacts(flies, SETTLE, NOW);
    // ib:101 中心 7650、开仓时标的 7700 → −2.0 个翼宽;这张单中心 7725、现价 7775 → 也是 −2.0
    const entries = butterflyEntries(flies, facts, new Map([["ib:101", 7700]]));
    const got = findSimilar(FLY_TICKET, entries, NOW, new Set(), { spot: 7775 });
    expect(got.basis).toContain("中心离现价 -2.0 个翼宽");
    const top = got.matches[0]!;
    expect([top.fact.id, top.score, top.reasons.at(-1)]).toEqual(["ib:101", 8, "中心离现价相近(-2.0 / -2.0 个翼宽)"]);
    // 没有开仓时标的价的那只不比这一项,也不扣分
    expect(got.matches[1]!.reasons.some((r) => r.startsWith("中心离现价"))).toBe(false);
  });

  it("股票:同在近 20 日区间的同一档进场 +1", () => {
    const facts = stockFacts(groupStockTrips(STOCK_FILLS, ACCOUNTS, null));
    const rklb = facts.find((f) => f.symbol === "RKLB")!;
    const pos = rangePosition(dailyBars(), "2026-09-01", rklb.entry_price!)!;
    const got = findSimilar(
      { sec_type: "STK", symbol: "RKLB", action: "BUY" }, stockEntries(facts, new Map([[rklb.id, pos]])), NOW, new Set(),
      { rangePos: 0.55 },
    );
    expect(got.basis).toEqual(["RKLB 股票", "买入", "现价在近 20 日区间的中间(0.55)"]);
    expect(got.matches[0]!.reasons).toEqual(["同标的", "同为做多", "同在近 20 日区间的中间进场(0.50 / 0.55)"]);
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

describe("ideas.similar_trades:RPC", () => {
  function makeServer(): (m: string, p?: Rec) => Promise<Rec> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-similar-"));
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
    s.engine.store.rememberOptionTrades(parseOptionTradesCsv(OPT_CSV, ACCT, "t.csv").rows);
    return async (method, params = {}) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  }

  it("回执:比的口径、胜负、出场方式、最像的几笔、提到这个标的的复盘想法", async () => {
    const call = makeServer();
    const lesson = (await call("ideas.add", { text: "SPX 蝴蝶不持有到期" }))["result"]["idea"];
    await call("ideas.update", { id: lesson["id"], status: "archived" });
    await call("ideas.add", { text: "SPX 进行中的想法不算复盘" });
    const r = (await call("ideas.similar_trades", FLY_TICKET))["result"];
    expect(Object.keys(r).sort()).toEqual([
      "basis", "count", "exits", "flat", "kind", "lessons", "loss", "matches", "open", "symbol", "unknown", "win",
    ]);
    expect(r["kind"]).toBe("butterfly");
    expect(r["count"]).toBe(5); // 没连券商:过期那只看涨蝶结算价取不到,是结果不明
    expect(r["unknown"]).toBe(1);
    expect(r["lessons"].map((i: Rec) => i["text"])).toEqual(["SPX 蝴蝶不持有到期"]);
  });

  it("蝴蝶:连着 IBKR 时按开仓日取分钟线补开仓标的价,存库,下次不再取", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-similar-ctx-"));
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
    s.engine.store.rememberFills(FLY_FILLS);
    const asked: string[] = [];
    const router = Object.create(BrokerRouter.prototype) as Rec;
    router["sessions"] = () => [{}];
    router["connectedNames"] = () => ["paper"];
    router["positions"] = async () => [];
    router["intradayBars"] = async (_sym: string, tf: string, rth: boolean, day: string) => {
      asked.push(`${tf}|${rth}|${day}`);
      return [
        { time: `${day} 10:27`, close: 7700 },
        { time: `${day} 11:59`, close: 7690 },
      ];
    };
    s.router = router as never;
    (s.market as unknown as Rec)["spotOf"] = async () => 7775;
    (s.market as unknown as Rec)["dailyHistory"] = async () => [];
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));

    const r = (await call("ideas.similar_trades", FLY_TICKET))["result"];
    expect(asked).toEqual(["1m|true|2026-09-10"]); // 两只同一天开的:一天一次请求
    expect(r["basis"]).toContain("中心离现价 -2.0 个翼宽");
    expect(r["matches"][0]["reasons"]).toContain("中心离现价相近(-2.0 / -2.0 个翼宽)");
    expect([...s.engine.store.entryUnderlyings(["ib:101", "ib:103"]).entries()]).toEqual([["ib:101", 7700], ["ib:103", 7690]]);

    await call("ideas.similar_trades", FLY_TICKET);
    expect(asked).toHaveLength(1); // 存过了
  });

  it("一次最多补 3 个交易日,新的优先;剩下的下次再补", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-similar-cap-"));
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
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
    s.engine.store.rememberFills(days.flatMap((d, i) =>
      flyFills(300 + i, "BUY", [7625, 7650, 7675], "P", d.replace(/-/g, ""), 2.0, `${d}T14:30:00+00:00`)));
    const asked: string[] = [];
    const router = Object.create(BrokerRouter.prototype) as Rec;
    router["sessions"] = () => [{}];
    router["connectedNames"] = () => ["paper"];
    router["positions"] = async () => [];
    router["intradayBars"] = async (_sym: string, _tf: string, _rth: boolean, day: string) => {
      asked.push(day);
      return [{ time: `${day} 10:30`, close: 7700 }];
    };
    s.router = router as never;
    (s.market as unknown as Rec)["spotOf"] = async () => 7775;
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    await call("ideas.similar_trades", FLY_TICKET);
    expect(asked).toEqual(["2026-09-04", "2026-09-03", "2026-09-02"]);
    await call("ideas.similar_trades", FLY_TICKET);
    expect(asked.slice(3)).toEqual(["2026-09-01"]);
  });

  it("结构错归 schema;缺标的是 handler 那句", async () => {
    const call = makeServer();
    expect((await call("ideas.similar_trades", { sec_type: "STK", action: "BUY" }))["error"]["code"]).toBe(-32602);
    expect((await call("ideas.similar_trades", { sec_type: "STK", symbol: " ", action: "BUY" }))["error"])
      .toEqual({ code: -32602, message: "缺少标的" });
  });
});
