/** Flex 期权仓位(optionPositionsCsv.ts + importedTrades.option_positions)进知识总结与下单页的历史相似交易。
 * 夹具是造的,不是真实成交。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { IdeasSimilarTradesParams } from "../src/contract/ideas.js";
import { OptionPositionsCsvError, POSITION_COLUMNS, parseOptionPositionsCsv } from "../src/optionPositionsCsv.js";
import { parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import { RpcServer } from "../src/rpc.js";
import { factLine, positionDays, positionFacts } from "../src/tradeOutcomes.js";
import { findSimilar, positionEntries } from "../src/tradeSimilar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;
const ACCT = "U0000001";

/** 表头照导出的原样(含那两列待补的与了结明细),列序与导出一致 */
const HEADER = [
  "仓位编号", POSITION_COLUMNS.open, POSITION_COLUMNS.symbol, POSITION_COLUMNS.structure, POSITION_COLUMNS.direction,
  POSITION_COLUMNS.qty, POSITION_COLUMNS.expiry, POSITION_COLUMNS.dte, POSITION_COLUMNS.right, POSITION_COLUMNS.strikes,
  POSITION_COLUMNS.center, POSITION_COLUMNS.width, POSITION_COLUMNS.ratio, `"${POSITION_COLUMNS.netPrice}"`, POSITION_COLUMNS.legs,
  POSITION_COLUMNS.exit, POSITION_COLUMNS.status, POSITION_COLUMNS.closed, POSITION_COLUMNS.holdMin, POSITION_COLUMNS.pnl,
  POSITION_COLUMNS.commission, "了结明细", "开仓时现价(待补)", "中心-现价(待补)",
].join(",");
const CSV = [
  HEADER,
  // 上午开的 25 宽看跌蝶 3.0,一小时后整体平掉,+150(已扣佣金)
  `1,2026-07-21 10:30:00,SPX,蝴蝶,买方,1,20260721,0,P,7600/7625/7650,7625.0,25.0,1:2:1,3.0,"B1 P7600,S2 P7625,B1 P7650",整体平仓,已了结,2026-07-21 11:30:00,60,150.0,6.0,"07-21 11:30 S1 P7650@1,B2 P7625@2,S1 P7600@3",,`,
  // 20 宽看涨蝶 2.0,拿到期全亏
  `2,2026-07-22 13:00:00,SPX,蝴蝶,买方,1,20260722,0,C,7700/7720/7740,7720.0,20.0,1:2:1,2.0,"B1 C7700,S2 C7720,B1 C7740",持有到期,已了结,2026-07-22 16:20:00,200,-206.0,6.0,,,`,
  // 拆腿:先买回身,两翼到期
  `3,2026-07-17 10:05:00,SPX,蝴蝶,买方,1,20260717,0,P,7575/7600/7625,7600.0,25.0,1:2:1,4.0,"B1 P7575,S2 P7600,B1 P7625",拆腿后到期,已了结,2026-07-17 16:20:00,375,-263.2,7.8,"07-17 10:23 B2 P7600@0.45 | 结算 S1 P7575,S1 P7625",,`,
  // 贷方垂直:收 10 点,平仓赚 3 点——「成本」不是付出去的钱,只给点数
  `4,2026-07-23 11:00:00,SPX,垂直价差,贷方看空,1,20260724,1,C,7800/7850,,50.0,,-10.0,"S1 C7800,B1 C7850",整体平仓,已了结,2026-07-24 10:00:00,1380,300.0,4.0,,,`,
  `5,2026-09-18 10:00:00,QQQ,单腿,买入,2,20261016,28,P,500,,,,1.2,B2 P500,持仓中,持仓中,,,0.0,2.0,,,`,
  `6,bad,SPX,蝴蝶,买方,1,20260721,0,P,1/2/3,2.0,1.0,1:2:1,1.0,x,整体平仓,已了结,,,1.0,1.0,,,`,
].join("\r\n");

describe("parseOptionPositionsCsv", () => {
  const parsed = parseOptionPositionsCsv(`\uFEFF${CSV}`, ACCT, "option_positions.csv");

  it("中文表头照原样认;行键稳定;坏行记原因", () => {
    expect(parsed.rows.map((r) => [r.symbol, r.structure, r.exit, r.width, r.net_price])).toEqual([
      ["SPX", "蝴蝶", "整体平仓", 25, 3],
      ["SPX", "蝴蝶", "持有到期", 20, 2],
      ["SPX", "蝴蝶", "拆腿后到期", 25, 4],
      ["SPX", "垂直价差", "整体平仓", 50, -10],
      ["QQQ", "单腿", "持仓中", null, 1.2],
    ]);
    expect(parsed.rows[0]!.id).toBe("pos:2026-07-21 10:30:00|SPX|B1 P7600,S2 P7625,B1 P7650");
    expect(parsed.rows[4]!.closed_et).toBe("");
    expect(parsed.skipped).toEqual({ "字段不全或不合法": 1 });
  });

  it("缺必需的列:整份拒", () => {
    expect(() => parseOptionPositionsCsv("标的,结构\nSPX,蝴蝶", ACCT, "x.csv")).toThrow(OptionPositionsCsvError);
  });
});

describe("positionFacts", () => {
  const rows = parseOptionPositionsCsv(CSV, ACCT, "p.csv").rows;
  const facts = positionFacts(rows, () => false);

  it("一个仓位一条:借方给收益率与点数,贷方只给点数;拆腿写进 note;持仓中不给结局", () => {
    expect(facts.map((f) => [f.label, f.how, f.result, f.return_pct, f.pnl_points])).toEqual([
      ["SPX 7600/7625/7650 看跌蝴蝶 买方", "closed", "win", 50, 1.5],
      ["SPX 7700/7720/7740 看涨蝴蝶 买方", "expired", "loss", -103, -2.06],
      ["SPX 7575/7600/7625 看跌蝴蝶 买方", "expired", "loss", -65.8, -2.63],
      ["SPX 7800/7850 看涨垂直价差 贷方看空", "closed", "win", null, 3],
      ["QQQ 500 看跌单腿 买入", "open", "open", null, null],
    ]);
    expect(facts[2]!.note).toBe("拆腿后到期;已扣佣金");
    expect(facts[0]!.opened_at).toBe("2026-07-21T14:30:00+00:00"); // 美东墙钟 → UTC
  });

  it("发给模型的那一行:行权价、净价、结局与幅度,没有金额与账户", () => {
    expect(factLine(facts[0]!)).toBe(
      "[2026-07-21 | 期权] SPX 7600/7625/7650 看跌蝴蝶 买方 @3:赚 +50% +1.5 点/份(整体平仓;已扣佣金)",
    );
    const all = facts.map(factLine).join("\n");
    for (const leak of ["150", "263.2", "206", ACCT, "$"]) expect(all).not.toContain(leak);
  });

  it("覆盖的日子:开仓日与了结日", () => {
    expect([...positionDays(rows.slice(3, 4))]).toEqual([`${ACCT}|2026-07-23`, `${ACCT}|2026-07-24`]);
  });
});

describe("positionEntries:历史相似交易逐项比", () => {
  const rows = parseOptionPositionsCsv(CSV, ACCT, "p.csv").rows;
  const facts = positionFacts(rows, () => false);
  const ticket: IdeasSimilarTradesParams = {
    sec_type: "BAG", symbol: "SPX", action: "BUY", limit_price: 3.0, expiry: "20260923", right: null, combo_strategy: "BUTTERFLY",
    legs: [
      { action: "BUY", ratio: 1, strike: 7700, right: "P" },
      { action: "SELL", ratio: 2, strike: 7725, right: "P" },
      { action: "BUY", ratio: 1, strike: 7750, right: "P" },
    ],
  };
  const now = Date.parse("2026-09-23T14:40:00Z"); // 美东上午

  it("仓位有行权价:看跌 / 翼宽 / 当日到期 / 上午 / 权利金占翼宽都能比;有开仓时标的价就比中心离现价", () => {
    const entries = positionEntries(rows, facts, new Map([[rows[0]!.id, 7675]])); // 中心 7625,开仓时 7675 → −2.0 翼宽
    const got = findSimilar(ticket, entries, now, new Set(), { spot: 7775 }); // 中心 7725,现价 7775 → −2.0 翼宽
    expect(got.matches[0]!.reasons).toEqual([
      "同标的同结构", "同为看跌", "翼宽相近(25 / 25)", "同为当日到期", "同在上午开仓", "权利金 / 翼宽相近(0.12)",
      "中心离现价相近(-2.0 / -2.0 个翼宽)",
    ]);
    expect(got.matches.every((m) => !m.reasons.includes("导入数据没有行权价,只能粗配"))).toBe(true);
  });

  it("出场方式分档:提前平仓 / 持有到期 / 拆腿;垂直价差、单腿不进蝴蝶的比较", () => {
    const got = findSimilar(ticket, positionEntries(rows, facts), now);
    expect(got.exits).toEqual([
      { exit: "提前平仓", win: 1, loss: 0, flat: 0, open: 0, unknown: 0 },
      { exit: "持有到期", win: 0, loss: 1, flat: 0, open: 0, unknown: 0 },
      { exit: "拆腿", win: 0, loss: 1, flat: 0, open: 0, unknown: 0 },
    ]);
  });
});

// ---------------------------------------------------------------- 以仓位为准

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

describe("同一段时间两份期权数据:以 Flex 仓位为准", () => {
  it("仓位覆盖的日子,按结构整理的事件不再算;没覆盖的日子照旧", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-positions-"));
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
    s.parserFactory = () => ({
      completeJson: async () => ({ summary: "s", themes: [], lessons: [], patterns: [], actions: [] }),
    }) as never;
    const coarse = [
      "time_et,date_et,symbol,asset,structure,action,direction,qty,net_price,realized_pnl,commission,legs,fills,order_ids,note",
      "2026-07-21 11:30:00,2026-07-21,SPX,期权,蝴蝶,平仓,买方蝴蝶(多),1,-4.5,150.0,6.0,,3,1,", // 仓位 1 的同一笔
      "2026-08-05 11:00:00,2026-08-05,SPX,期权,蝴蝶,平仓,买方蝴蝶(多),1,-3.0,80.0,6.0,,3,2,", // 仓位没覆盖的一天
    ].join("\n");
    s.engine.store.imports.rememberOptionTrades(parseOptionTradesCsv(coarse, ACCT, "t.csv").rows);
    expect(s.engine.store.imports.rememberOptionPositions(parseOptionPositionsCsv(CSV, ACCT, "p.csv").rows)).toBe(5);
    expect(s.engine.store.imports.rememberOptionPositions(parseOptionPositionsCsv(CSV, ACCT, "p.csv").rows)).toBe(0);
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    const made = (await call("ideas.add", { text: "SPX 蝴蝶不持有到期" }))["result"]["idea"];
    await call("ideas.update", { id: made["id"], status: "archived" });
    const row = (await call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    const ids: string[] = row["trades"].map((t: Rec) => t["id"]);
    expect(ids.filter((id) => id.startsWith("pos:"))).toHaveLength(5);
    expect(ids.filter((id) => id.startsWith("opt:"))).toEqual(["opt:2026-08-05 11:00:00|SPX|平仓|2"]);
  });
});
