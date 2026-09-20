/** 休市时的昨收:只给界面看。
 *
 * 2026-09-17 真机(美东 03:24,主账户):USO 1016 115P / 120P 的行情流没有买卖价、没有最新成交,只有昨收
 * 0.40 / 0.56——个股期权没有夜盘。组合现价与盈亏整晚显示「—」。
 * 盯的是:昨收单独放一个字段、按它另算一份盈亏给界面;market_price / unrealized_pnl 仍然是空的,
 * 追踪的触发判断照旧"拿不到现价,本轮不判断"。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";
import * as tk from "../src/tracker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

function leg(strike: number, qty: number, avgCost: number, extra: Rec): Rec {
  const contract = { secType: "OPT", symbol: "USO", lastTradeDateOrContractMonth: "20261016", strike, right: "P", multiplier: "100" };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey("主账户", "USO", "OPT", ident), account: "主账户", symbol: "USO", sec_type: "OPT", leg: ident,
    quantity: qty, avg_cost: avgCost, multiplier: 100.0, currency: "USD",
    market_price: null, market_value: null, unrealized_pnl: null, contract, ...extra,
  };
}

/** 截图里那只:买 120P、卖 115P 各 5 张,净付 0.2638 */
const closed = (): Rec[] => [leg(115, -5, 39.3056, { close_price: 0.4 }), leg(120, 5, 65.69028, { close_price: 0.56 })];

describe("comboRow:昨收口径的每组净值", () => {
  it("各腿都有昨收 → close_price = 0.16;market_price 仍是 null", () => {
    const combo = tk.withCombos(closed()).find((r) => r["sec_type"] === "BAG")!;
    expect(combo["quantity"]).toBe(5);
    expect(combo["net_side"]).toBe("debit");
    expect(combo["market_price"]).toBeNull();
    expect(combo["close_price"]).toBe(0.16);
  });

  it("缺一条腿的昨收 → 不带这个键(不拿半边凑数,也不给基线多一个恒空字段)", () => {
    const rows = closed();
    delete rows[0]!["close_price"];
    const combo = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!;
    expect("close_price" in combo).toBe(false);
  });

  it("追踪的判断不用昨收:没有现价就是「本轮不判断」,止损不会被昨收打掉", () => {
    const combo = tk.withCombos(closed()).find((r) => r["sec_type"] === "BAG")!;
    const position = tk.makePosition({
      account: "主账户", symbol: "USO", sec_type: "BAG", quantity: combo["quantity"], avg_cost: combo["avg_cost"],
      multiplier: 100, market_price: combo["market_price"],
    });
    // 止损 0.20 高于昨收 0.16:要是拿昨收去判,这里就触发了
    const result = tk.evaluate(position, tk.makeTargets({ stop_loss: 0.2 }), combo["market_price"], null, 200);
    expect(result.state).toBe(tk.STATE_HOLDING);
  });
});

describe("tracker.positions:按昨收另算一份盈亏给界面", () => {
  function server(rows: Rec[]): RpcServer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-close-"));
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    (s as any).router = { sessions: () => [{}], positions: async () => rows };
    return s;
  }

  it("休市:close_pnl ≈ (0.16 − 0.2638) × 5 × 100,unrealized_pnl 仍为空", async () => {
    const out = await server(closed()).domains.tracker.positionsList();
    const combo = (out["positions"] as Rec[]).find((r) => r["sec_type"] === "BAG")!;
    expect(combo["unrealized_pnl"] ?? null).toBeNull();
    expect(combo["market_price"]).toBeNull();
    expect(combo["close_pnl"]).toBeCloseTo((0.16 - 0.263848) * 500, 1);
    expect(combo["close_pct"]).toBeLessThan(0);
    // 腿也各有一份
    const short = (out["positions"] as Rec[]).find((r) => r["sec_type"] === "OPT" && r["quantity"] < 0)!;
    expect(short["close_pnl"]).toBeCloseTo((0.393056 - 0.4) * 500, 1);
  });

  it("有现价时照旧按现价算,不出 close_pnl", async () => {
    const rows = closed();
    rows[0]!["market_price"] = 0.45;
    rows[1]!["market_price"] = 0.7;
    const out = await server(rows).domains.tracker.positionsList();
    const combo = (out["positions"] as Rec[]).find((r) => r["sec_type"] === "BAG")!;
    expect(combo["market_price"]).toBe(0.25);
    expect(combo["pnl_source"]).toBe("computed");
    expect("close_pnl" in combo).toBe(false);
  });
});
