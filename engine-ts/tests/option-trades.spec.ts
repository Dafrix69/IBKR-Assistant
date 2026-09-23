/** 期权交易导入(optionTradesCsv.ts + cli import-option-trades)与它们进知识总结的那一段(tradeOutcomes.optionFacts)。
 * 夹具是造的,不是真实成交。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OptionTradesCsvError, parseCsv, parseOptionTradesCsv } from "../src/optionTradesCsv.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import { factLine, optionDaysCovered, optionFacts } from "../src/tradeOutcomes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const HEADER = "time_et,date_et,symbol,asset,structure,action,direction,qty,net_price,realized_pnl,commission,legs,fills,order_ids,note";
const CSV = [
  HEADER,
  "2026-05-21 11:00:21,2026-05-21,SPX,期权,蝴蝶,开仓,买方蝴蝶(多),1,2.25,0.0,5.86,\"B1@7.1, S2@3.2, B1@1.55\",3,1 2 3,",
  "2026-05-21 13:12:38,2026-05-21,SPX,期权,蝴蝶,平仓,买方蝴蝶(多),1,-3.7,132.87,6.26,\"S1@9.9, B2@4.0, S1@1.8\",3,4 5 6,",
  "2026-07-17 16:20:00,2026-07-17,SPX,期权,蝴蝶,拆腿平仓,买方蝴蝶(多),2,,-263.2,1.9,\"B2@0.45 | 结算 S1 S1\",4,7 8,\"07-17 10:23 先买回 B2@0.45(已实现 +1703.06),剩下的腿 07-17 到期(已实现 -1966.26)\"",
  "2026-07-07 16:20:00,2026-07-07,SPX,期权,多个仓位同时结算,到期结算,,,,-300.0,0.0,,6,9,",
  "2026-08-01 10:00:00,2026-08-01,QCOM,期权,单腿,平仓,卖出,1,-1.2,3.0,1.0,S1@1.2,1,10,",
  "2026-08-01 09:00:00,2026-08-01,QCOM,股票,股票,买入,,10,150.0,0.0,1.0,,1,11,",
  "2026-08-02 10:00:00,2026-08-02,QCOM,期权,单腿,平仓,卖出,1,-1.2,3.0,1.0,S1@1.2,1",
].join("\r\n");

describe("parseCsv", () => {
  it("引号里的逗号、换行、双引号都认", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
});

describe("parseOptionTradesCsv", () => {
  const parsed = parseOptionTradesCsv(CSV, "U0000001", "trades.csv");

  it("只收期权行;股票、列数不对的分别记原因;行键稳定", () => {
    expect(parsed.rows.map((r) => [r.symbol, r.structure, r.action, r.qty, r.realized_pnl])).toEqual([
      ["SPX", "蝴蝶", "开仓", 1, 0],
      ["SPX", "蝴蝶", "平仓", 1, 132.87],
      ["SPX", "蝴蝶", "拆腿平仓", 2, -263.2],
      ["SPX", "多个仓位同时结算", "到期结算", null, -300],
      ["QCOM", "单腿", "平仓", 1, 3],
    ]);
    expect(parsed.rows[0]!.id).toBe("opt:2026-05-21 11:00:21|SPX|开仓|1 2 3");
    expect(parsed.rows[2]!.net_price).toBeNull();
    expect(parsed.skipped).toEqual({ "不是期权(股票走 import-fills)": 1, "列数不对": 1 });
  });

  it("缺必需的列:整份拒", () => {
    expect(() => parseOptionTradesCsv("time_et,symbol\n2026-05-21 11:00:21,SPX", "U1", "x.csv")).toThrow(OptionTradesCsvError);
  });

  it("进库只增不改,按 (账户, 行键) 去重", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-opt-"));
    dirs.push(dir);
    const store = new TradeStore(path.join(dir, "t.db"));
    expect(store.imports.rememberOptionTrades(parsed.rows)).toBe(5);
    expect(store.imports.rememberOptionTrades(parsed.rows)).toBe(0);
    expect(store.imports.listOptionTrades().map((r) => r.id)).toEqual(parsed.rows.map((r) => r.id).sort((a, b) => {
      const ta = a.split("|")[0]!, tb = b.split("|")[0]!;
      return ta < tb ? -1 : ta > tb ? 1 : a < b ? -1 : 1;
    }));
  });
});

describe("optionFacts", () => {
  const rows = parseOptionTradesCsv(CSV, "U0000001", "trades.csv").rows;
  const facts = optionFacts(rows, () => false);

  it("一次出场一条:成败看已扣佣金的已实现盈亏,幅度是每份的点数;开仓不单列", () => {
    expect(facts.map((f) => [f.label, f.how, f.result, f.pnl_points, f.return_pct])).toEqual([
      ["SPX 蝴蝶(买方蝴蝶(多)) · 平仓", "closed", "win", 1.33, null],
      ["SPX 蝴蝶(买方蝴蝶(多)) · 拆腿平仓", "closed", "loss", -1.32, null],
      ["SPX 多个仓位同时结算 · 到期结算", "expired", "loss", null, null],
      ["QCOM 单腿(卖出) · 平仓", "closed", "flat", 0.03, null],
    ]);
    expect(facts[0]!.opened_at).toBe("2026-05-21T17:12:38+00:00"); // 美东墙钟 → UTC
    expect(facts[2]!.note).toBe("结构按同一秒成交推断、无行权价;已扣佣金;份数不明,不给点数;多只同时到期,合在一起算");
  });

  it("发给模型的一行:点数与推断说明,不带导出里 note / legs 的金额", () => {
    expect(factLine(facts[1]!)).toBe(
      "[2026-07-17 | 期权] SPX 蝴蝶(买方蝴蝶(多)) · 拆腿平仓:亏 -1.32 点/份(结构按同一秒成交推断、无行权价;已扣佣金)",
    );
    const all = facts.map(factLine).join("\n");
    for (const leak of ["1703", "1966", "263", "U0000001", "$"]) expect(all).not.toContain(leak);
  });

  it("同一账户同一天库里已有完整期权成交的,导入的那天不用", () => {
    const covered = optionDaysCovered([
      { account_id: "U0000001", time: "2026-05-21T15:00:21+00:00", contract: { secType: "BAG" } },
      { account_id: "U0000001", time: "2026-08-01T13:00:00+00:00", contract: { secType: "STK" } },
      { account_id: "U9", time: "2026-07-17T15:00:00+00:00", contract: { secType: "OPT" } },
    ]);
    expect([...covered]).toEqual(["U0000001|2026-05-21", "U9|2026-07-17"]);
    expect(optionFacts(rows, () => false, covered).map((f) => f.symbol + " " + f.opened_at.slice(0, 10))).toEqual([
      "SPX 2026-07-17", "SPX 2026-07-07", "QCOM 2026-08-01",
    ]);
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

describe("ideas.digest(trades):导入的期权", () => {
  it("出场事件跟股票、蝴蝶一起进交易结果;胜负计数把它们算上", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-opt-rpc-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      ...base,
      accounts: [{ alias: "主账户", account_id: "U0000001", is_paper: false, connection: "paper", default: true }],
      storage: { db_path: path.join(dir, "t.db") },
    }));
    const s = new RpcServer(settingsPath, () => undefined);
    servers.push(s);
    const calls: string[] = [];
    s.parserFactory = () => ({
      completeJson: async (_system: string, user: string) => {
        calls.push(user);
        return { summary: "s", themes: [], lessons: [], patterns: [], actions: [] };
      },
    }) as never;
    s.engine.store.imports.rememberOptionTrades(parseOptionTradesCsv(CSV, "U0000001", "trades.csv").rows);
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    const made = (await call("ideas.add", { text: "SPX 蝴蝶别拆腿" }))["result"]["idea"];
    await call("ideas.update", { id: made["id"], status: "archived" });

    const row = (await call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    expect(row["trades"].map((t: Rec) => [t["kind"], t["symbol"], t["result"]])).toEqual([
      ["option", "QCOM", "flat"], ["option", "SPX", "loss"], ["option", "SPX", "loss"], ["option", "SPX", "win"],
    ]);
    expect(calls.at(-1)).toContain("共 4 笔:赚 1、亏 2、持平 1、未了结 0、结果不明 0");
    const spxOnly = (await call("ideas.digest", { scope: "all", trades: true, focus: { symbols: ["QCOM"] } }))["result"]["digest"];
    expect(spxOnly["trades"].map((t: Rec) => t["symbol"])).toEqual(["QCOM"]);
  });
});
