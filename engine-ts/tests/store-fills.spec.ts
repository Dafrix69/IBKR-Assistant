/** 库里攒的券商成交(broker_fills)怎么读出来。
 *
 * 成交表是一天天攒的,想法总结(新的优先)、绩效体检的账本、交易分析页都从 listFills() 拿全部历史。
 * 按时间升序读的时候要是封了顶,攒过上限之后丢的正好是**最新**的那些——最近的交易从账本里消失,界面上也不报错。
 * 这里钉:不封顶、按时间升序、最新那笔在;交易分析页显示的条数按全表算。全部离线,只碰临时目录。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { groupStockTrips } from "../src/stockreview.js";
import { TradeStore } from "../src/store.js";

type Rec = Record<string, any>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

function freshStore(): TradeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-fills-"));
  dirs.push(dir);
  return new TradeStore(path.join(dir, "trades.db"));
}

/** 一条股票成交,形状同 broker.fillRow。`minute` 从 2025-01-02 14:30Z 起算。 */
function fill(n: number, minute: number, symbol: string, side: "BOT" | "SLD", price: number): Rec {
  return {
    exec_id: `e${String(n).padStart(6, "0")}`,
    time: new Date(Date.parse("2025-01-02T14:30:00Z") + minute * 60_000).toISOString().replace(".000Z", "+00:00"),
    account_id: "U0000001", side, shares: 10, price, order_id: null, perm_id: 1000 + n, order_ref: "", commission: 1,
    contract: { secType: "STK", symbol, currency: "USD", exchange: "SMART" },
  };
}

/** 2,600 笔 OLD 的来回(5,200 条成交),最后是一笔 NEWCO 的来回。写入顺序故意打乱:读出来的次序只看成交时间。 */
function seed(store: TradeStore): Rec[] {
  const rows: Rec[] = [];
  for (let i = 0; i < 2600; i += 1) {
    rows.push(fill(2 * i, 2 * i, "OLD", "BOT", 50), fill(2 * i + 1, 2 * i + 1, "OLD", "SLD", 51));
  }
  rows.push(fill(900_001, 999_000, "NEWCO", "BOT", 20), fill(900_002, 999_060, "NEWCO", "SLD", 23));
  store.rememberFills([...rows].reverse());
  return rows;
}

describe("listFills:成交历史不封顶", () => {
  it("超过 5,000 条:全部读出来,按时间升序,最新的那两条在最后", () => {
    const store = freshStore();
    const rows = seed(store);
    const fills = store.listFills();
    expect(fills).toHaveLength(rows.length);
    expect(rows.length).toBeGreaterThan(5000);
    expect(fills.slice(-2).map((f) => f["exec_id"])).toEqual(["e900001", "e900002"]);
    expect(fills[0]!["exec_id"]).toBe("e000000");
    const times = fills.map((f) => Date.parse(String(f["time"])));
    expect(times.every((t, i) => i === 0 || t >= times[i - 1]!)).toBe(true);
  });

  it("股票持仓段(交易分析页与知识总结共用)里有最新的那一笔", () => {
    const store = freshStore();
    seed(store);
    const trips = groupStockTrips(store.listFills(), [{ alias: "主账户", account_id: "U0000001", is_paper: false }], null);
    const newest = trips.filter((t) => t["symbol"] === "NEWCO");
    expect(newest).toHaveLength(1);
    expect(newest[0]).toMatchObject({ status: "closed", qty: 10, avg_entry: 20, avg_exit: 23 });
    expect(trips.filter((t) => t["symbol"] === "OLD")).toHaveLength(2600);
  });

  it("countFills 数的是全表,和 listFills 的条数一致", () => {
    const store = freshStore();
    expect(store.countFills()).toBe(0);
    const rows = seed(store);
    expect(store.countFills()).toBe(rows.length);
    // 按 exec_id 去重:同一批再存一次,条数不变
    expect(store.rememberFills(rows)).toBe(0);
    expect(store.countFills()).toBe(rows.length);
  });
});
