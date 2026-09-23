/** 历史成交导入(fillsCsv.ts + cli import-fills):IBKR 账户成交导出 → broker_fills。
 * 夹具是造的,不是真实成交。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FillsCsvError, parseFillsCsv } from "../src/fillsCsv.js";
import { groupStockTrips } from "../src/stockreview.js";
import { TradeStore } from "../src/store.js";

const HEADER = "trade_time_utc,trade_time_et,trade_date_et,symbol,sec_type,currency,side,size,price,order_type,exchange," +
  "commission,net_amount,realized_pnl,is_settlement,order_id,trade_id";
const CSV = [
  HEADER,
  "2025-11-03T14:31:00Z,2025-11-03 09:31:00,2025-11-03,ABC,STK,USD,BUY,10.0,50.0,LIMIT,NASDAQ,1.0,500.0,0.0,False,111,0000aaaa.00000001.01.01",
  "2025-11-05T15:00:00Z,2025-11-05 10:00:00,2025-11-05,ABC,STK,USD,SELL,10.0,55.0,LIMIT,DARK,1.0,550.0,48.0,False,112,0000aaaa.00000002.01.01",
  "2026-05-21T15:00:21Z,2026-05-21 11:00:21,2026-05-21,SPX,OPT,USD,BUY,1.0,10.5,LIMIT,CBOE,1.5,1050.0,0.0,False,113,0000aaaa.00000003.01.01",
  "2026-05-22T08:00:00Z,2026-05-22 04:00:00,2026-05-22,USD.HKD,CASH,HKD,SELL,100.0,7.8,MARKET,IDEALFX,2.0,780.0,0.0,False,114,0000aaaa.00000004.01.01",
  "2026-05-23T14:00:00Z,2026-05-23 10:00:00,2026-05-23,XYZ,STK,USD,BUY,5.0,20.0,LIMIT,ARCA,0.5,100.0,0.0,False,115",
  "2026-05-24T14:00:00Z,2026-05-24 10:00:00,2026-05-24,XYZ,STK,USD,BUY,0,20.0,LIMIT,ARCA,0.5,0.0,0.0,False,116,0000aaaa.00000006.01.01",
  "2025-11-05T15:00:00Z,2025-11-05 10:00:00,2025-11-05,ABC,STK,USD,SELL,10.0,55.0,LIMIT,DARK,1.0,550.0,48.0,False,112,0000aaaa.00000002.01.01",
].join("\r\n");

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

describe("parseFillsCsv", () => {
  it("股票行换成 broker.fillRow 的形状;期权、换汇、残缺、重复的不收,各记原因", () => {
    const out = parseFillsCsv(`\uFEFF${CSV}`, "U0000001");
    expect(out.fills.map((f) => f.exec_id)).toEqual(["0000aaaa.00000001.01.01", "0000aaaa.00000002.01.01"]);
    expect(out.fills[0]).toEqual({
      exec_id: "0000aaaa.00000001.01.01", time: "2025-11-03T14:31:00+00:00", account_id: "U0000001",
      side: "BOT", shares: 10, price: 50, order_id: null, perm_id: 111, order_ref: "", commission: 1,
      contract: {
        secType: "STK", symbol: "ABC", expiry: "", strike: null, right: "", tradingClass: "", multiplier: "",
        conId: null, currency: "USD", exchange: "NASDAQ",
      },
    });
    expect(out.fills[1]!.side).toBe("SLD");
    expect(out.skipped).toEqual({
      "期权(没有合约描述,等 Flex 导出)": 1, "不是股票(CASH)": 1, "列数不对": 1, "字段不全或不合法": 1, "文件内重复": 1,
    });
    expect([out.first, out.last]).toEqual(["2025-11-03T14:31:00+00:00", "2025-11-05T15:00:00+00:00"]);
  });

  it("缺必需的列:整份拒,不半对半错地进库", () => {
    expect(() => parseFillsCsv("symbol,side\nABC,BUY", "U0000001")).toThrow(FillsCsvError);
    expect(() => parseFillsCsv("symbol,side\nABC,BUY", "U0000001")).toThrow("fills.csv 缺少列:trade_time_utc");
  });

  it("进库按 exec_id 去重(已有的行不动);进库之后股票复盘能从空仓到空仓切出一笔,成本已知", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-fills-csv-"));
    dirs.push(dir);
    const store = new TradeStore(path.join(dir, "t.db"));
    const { fills } = parseFillsCsv(CSV, "U0000001");
    // 库里已经有 TWS 当天同步来的那一笔卖出(佣金记成 0):导入不覆盖它
    store.rememberFills([{ ...fills[1]!, commission: 0 }]);
    expect(store.rememberFills(fills)).toBe(1);
    expect(store.rememberFills(fills)).toBe(0);
    const stored = store.listFills();
    expect(stored.find((f) => f["exec_id"] === "0000aaaa.00000002.01.01")?.["commission"]).toBe(0);

    const trips = groupStockTrips(stored, [{ alias: "主账户", account_id: "U0000001", is_paper: false }], null);
    expect(trips.map((t) => [t["symbol"], t["status"], t["carried"], t["avg_entry"], t["realized_pnl"]]))
      .toEqual([["ABC", "closed", false, 50, 50]]);
  });
});
