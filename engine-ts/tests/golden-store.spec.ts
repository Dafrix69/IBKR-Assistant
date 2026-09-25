/** 阶段 3 验收:store。
 *
 * 兼容性对拍:打开 **Python 版 TradeStore 生成的数据库文件**(baseline/store/
 * fixture.db),TS 侧的折叠读取 / recent_orders / 各列表必须与 Python 侧的
 * 期望输出(expected.json)一致——"旧库文件直接打开"。
 * 行为测试:append-only 触发器、白名单更新、重复约束、purge 口令。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TradeStore, redactAccount } from "../src/store.js";
import { expectSame } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(HERE, "..", "baseline", "store");
const FIXTURE = path.join(STORE_DIR, "fixture.db");
const expected = JSON.parse(
  fs.readFileSync(path.join(STORE_DIR, "expected.json"), "utf-8"),
);

describe("store: 兼容性对拍(Python 生成的库文件)", () => {
  let store: TradeStore;
  let workDb: string;
  let dir: string;

  beforeEach(() => {
    // 在副本上打开:WAL/触发器测试都不许碰原始夹具
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-store-"));
    workDb = path.join(dir, "fixture.db");
    fs.copyFileSync(FIXTURE, workDb);
    store = new TradeStore(workDb);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("get_record:事件折叠与 Python 逐字段一致", () => {
    for (const rid of expected.record_ids) {
      expectSame(store.getRecord(rid), expected.get_record[rid], `get_record(${rid})`);
    }
    expect(store.getRecord("no-such-id")).toBeNull();
  });

  it("list_records(limit=2) 与 Python 一致", () => {
    expectSame(store.listRecords(2), expected.list_records_limit_2, "list_records");
  });

  it("recent_orders:ValidatedOnly 与无签名记录不进候选集", () => {
    const nowMs = Date.parse(expected.recent_now);
    const out = store.recentOrders(10, nowMs);
    expect(out.length).toBe(expected.recent_orders.length);
    for (const [i, r] of out.entries()) {
      const e = expected.recent_orders[i];
      expect(r.signature).toBe(e.signature);
      expect(r.quantity).toBe(e.quantity);
      expect(r.createdAtMs).toBe(Date.parse(e.created_at));
    }
  });

  it("watches / tracks / sectors / ideas 列表一致", () => {
    // 2026-09-25 起 alert_watches 多一列 touch(碰均线的底账):Python 那一代的库里没有,打开时 migrate 补上,
    // 读回是 null。这是唯一一处刻意的不同——期望值不改文件,在这里写明
    const withTouch = (expected.watches as Array<Record<string, unknown>>).map((w) => ({ ...w, touch: null }));
    expectSame(store.listWatches(), withTouch, "watches");
    expectSame(store.listTracks(), expected.tracks, "tracks");
    expectSame(store.listSectors(), expected.sectors, "sectors");
    expectSame(store.listIdeas(), expected.ideas_all, "ideas_all");
    expectSame(store.listIdeas("done"), expected.ideas_done, "ideas_done");
  });

  it("audit_log 原样读回", () => {
    const rows = (store as any).exportAll().audit_log;
    expectSame(rows, expected.audit_rows, "audit_rows");
  });

  it("redact_account", () => {
    for (const [input, out] of Object.entries(expected.redact)) {
      expect(redactAccount(input)).toBe(out);
    }
  });

  it("append-only:UPDATE / DELETE 被触发器拒绝", () => {
    const rid = expected.record_ids[0];
    expect(() =>
      store.rawExec("UPDATE trade_records SET quantity=999 WHERE id=?", [rid]),
    ).toThrowError(/append-only/);
    expect(() => store.rawExec("DELETE FROM trade_records WHERE id=?", [rid])).toThrowError(
      /append-only/,
    );
    expect(() => store.rawExec("UPDATE record_events SET kind='x' WHERE seq=1")).toThrowError(
      /append-only/,
    );
    expect(() => store.rawExec("DELETE FROM record_events WHERE seq=1")).toThrowError(/append-only/);
    expect(() => store.rawExec("UPDATE audit_log SET actor='x' WHERE seq=1")).toThrowError(
      /append-only/,
    );
    expect(() => store.rawExec("DELETE FROM audit_log WHERE seq=1")).toThrowError(/append-only/);
  });
});

describe("store: TS 写入路径行为", () => {
  let dir: string;
  let store: TradeStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-store-w-"));
    store = new TradeStore(path.join(dir, "trades.db"));
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("create → events → fold 往返", () => {
    const rid = store.createRecord({
      instruction: "买入 AAPL",
      signature: "DEFAULT|BUY|STK|AAPL",
      contract: { secType: "STK", symbol: "AAPL" },
      order: { action: "BUY", orderType: "LMT", totalQuantity: 100, lmtPrice: 230.0 },
      account: { alias: "模拟", account_id: "DU7654321" },
      llm: { prompt_version: "v1.8.0" },
    });
    store.appendEvent(rid, "status", { status: "Submitted", order_id: 7 });
    store.appendEvent(rid, "fill", { qty: 100, price: 229.9, commission: 1.0 });
    store.setFinalStatus(rid, "filled");
    const rec = store.getRecord(rid)!;
    expect(rec["final_status"]).toBe("filled");
    expect(rec["ibkr"]["order_id"]).toBe(7);
    expect(rec["ibkr"]["avg_fill_price"]).toBeCloseTo(229.9, 9);
    expect(rec["ibkr"]["total_commission"]).toBeCloseTo(1.0, 9);
    expect(rec["ibkr"]["status_timeline"].map((s: any) => s.status)).toEqual(["Submitted"]);
    // 未知终态拒绝
    expect(() => store.setFinalStatus(rid, "whatever")).toThrowError("未知终态:whatever");
  });

  it("重复约束:watch / track / sector", () => {
    store.addWatch("IREN");
    expect(() => store.addWatch("iren")).toThrowError("已经在盯 IREN 了");
    store.addTrack({ account: "模拟", symbol: "AAPL" });
    expect(() => store.addTrack({ account: "模拟", symbol: "AAPL" })).toThrowError(
      "已经在追踪 模拟 的 AAPL 了",
    );
    store.addSector("AI 算力");
    expect(() => store.addSector("AI 算力")).toThrowError("板块已存在:AI 算力");
  });

  it("白名单更新:未知字段拒绝、合法字段生效", () => {
    const w = store.addWatch("SPY");
    // 类型已经不让这么传了;运行时那道白名单是给绕过类型的调用方留的,所以这里故意绕
    expect(() => store.updateWatch(w["id"], { symbol: "QQQ" } as never)).toThrowError(
      "不允许修改的字段:symbol",
    );
    expect(store.updateWatch(w["id"], { last_price: 450.1, enabled: false })).toBe(true);
    const back = store.getWatch(w["id"])!;
    expect(back["last_price"]).toBe(450.1);
    expect(back["enabled"]).toBe(false);

    const t = store.addTrack({ account: "模拟", symbol: "NVDA" });
    expect(() => store.updateTrack(t["id"], { account: "别的" } as never)).toThrowError( // 同上:故意绕过类型
      "不允许修改的字段:account",
    );
    expect(store.updateTrack(t["id"], { peak: 181.5, fired_at: "2026-08-14T10:00:00+00:00" })).toBe(
      true,
    );
    const tb = store.getTrack(t["id"])!;
    expect(tb["peak"]).toBe(181.5);
    expect(tb["fired_at"]).toBe("2026-08-14T10:00:00+00:00");
  });

  it("想法状态机与参数校验", () => {
    expect(() => store.addIdea("  ")).toThrowError("想法内容为空");
    const idea = store.addIdea("想法", ["AAPL"]);
    expect(() => store.setIdeaStatus(idea["id"], "nope")).toThrowError("未知想法状态:nope");
    expect(store.setIdeaStatus(idea["id"], "archived")).toBe(true);
    expect(() => store.listIdeas("nope")).toThrowError("未知想法状态:nope");
    expect(() => store.addWatch("")).toThrowError("标的代码为空");
    expect(() => store.addWatch("SPY", 0)).toThrowError("整数关口步长必须在 0~1000 之间");
    expect(() => store.addSector("x".repeat(51))).toThrowError("板块名称太长(超过 50 字)");
  });

  it("purge:口令不对中止,口令正确删库", () => {
    const dbPath = store.dbPath;
    expect(() => store.purgeEverything("delete")).toThrowError("确认口令不正确,已中止。");
    expect(fs.existsSync(dbPath)).toBe(true);
    store.purgeEverything("DELETE ALL MY TRADING DATA");
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
