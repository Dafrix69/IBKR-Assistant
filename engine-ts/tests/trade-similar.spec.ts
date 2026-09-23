/** 下单页「历史相似交易」(tradeSimilar.ts + ideas.similar_trades):规则打分,不调模型。夹具是造的,全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { IdeasSimilarTradesParams } from "../src/contract/ideas.js";
import { groupButterflies } from "../src/ibtrades.js";
import { parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import { RpcServer } from "../src/rpc.js";
import { groupStockTrips } from "../src/stockreview.js";
import { butterflyFacts, optionFacts, stockFacts } from "../src/tradeOutcomes.js";
import {
  butterflyEntries, dteBucket, findSimilar, optionEntries, slotOf, stockEntries,
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

  it("结构错归 schema;缺标的是 handler 那句", async () => {
    const call = makeServer();
    expect((await call("ideas.similar_trades", { sec_type: "STK", action: "BUY" }))["error"]["code"]).toBe(-32602);
    expect((await call("ideas.similar_trades", { sec_type: "STK", symbol: " ", action: "BUY" }))["error"])
      .toEqual({ code: -32602, message: "缺少标的" });
  });
});
