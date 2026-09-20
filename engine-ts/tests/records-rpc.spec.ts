/** records.list / records.get 与 pending.list / pending.poll 在 RPC 这一层的特征测试。
 *
 * 记录页和订单看板读的是 records.*,条件单队列读的是 pending.*。四样都还钉在 contract.spec 的
 * LEGACY 名单上,而其中两处的行为很容易在迁移里改坏:
 *   · records.list 给的是**摘要**(20 项),records.get 给的是**整条记录**,两者不是一个形状;
 *   · 两条路都要把真账号打码——`account_id` 必须换成 `account_masked`,原字段删掉。
 *   · pending.poll 是界面驱动的那口气:不发它,条件单永远不触发、当日不过期、成交也不回写。
 *
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商是假的,不连端口、不发单。
 * 时钟钉在一个交易日的盘中:`expirePending` 只在休市时干活,不钉住的话这一套在周末跑和在周三跑不是一个结果。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 真账号长这样。断言里要确认它一个字都没漏出去。 */
const REAL_ACCOUNT = "U1234567";

class FakeRouter {
  upstreamOk = true;
  syncCalls = 0;
  prices: Record<string, number | null> = {};
  askedPrices: string[] = [];
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async indexPrice(symbol: string): Promise<number | null> {
    this.askedPrices.push(symbol);
    return this.prices[symbol] ?? null;
  }
  /** syncBrokerOrders 认的就是这只手(富途没有事件流,靠每轮拉一次) */
  async pollOrderUpdates(): Promise<Array<[string, Rec, Rec]>> { this.syncCalls += 1; return []; }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): {
  s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-rec-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

/** 一条排队中的条件单。approved.order 是一份 ParsedOrder:它自己还套着 contract 与 order
 *  (expirePending 读 order.order.tif、firePending 读 order.contract.symbol)。 */
function pendingItem(recordId: string, symbol: string, over: Rec = {}): unknown {
  // recordId 必须是库里真有的一条:过期那一步要写 final_status,库上有外键
  return {
    record_id: recordId,
    approved: {
      order: {
        intent_summary: `${symbol} 到价买入`,
        contract: { secType: "STK", symbol },
        order: { action: "BUY", totalQuantity: 100, tif: "DAY" },
      },
      account: { alias: "模拟", account_id: REAL_ACCOUNT, is_paper: true },
    },
    trigger: { symbol, operator: "<=", value: 1 }, // 价再低也不触发
    created_at: "2026-09-20T13:30:00+00:00",
    ...over,
  };
}

/** 一条落了库的记录:界面要显示的那几样都填上。 */
function makeRecord(s: RpcServer, over: Rec = {}): string {
  const id = s.engine.store.createRecord({
    created_at: "2026-09-20T13:30:00+00:00",
    input: { raw_instruction: "买 100 股苹果", reason: "财报后回踩", input_channel: "manual" },
    llm: { intent_summary: "买入 AAPL 100 股", confidence: 0.82, prompt_version: "v1.8.0" },
    contract: { secType: "STK", symbol: "AAPL" },
    order: { action: "BUY", totalQuantity: 100, orderType: "LMT", lmtPrice: 230 },
    account: { alias: "模拟", account_id: REAL_ACCOUNT, is_paper: true },
    execution_type: "immediate",
    notional_estimate: 23000,
    ...over,
  });
  return id;
}

/** 2026-09-16 是周三,15:00Z = ET 11:00,盘中。 */
const TRADING_NOON = new Date("2026-09-16T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TRADING_NOON);
});

afterEach(() => {
  vi.useRealTimers();
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

describe("records.list", () => {
  it("空库回一个空数组,不是 null", async () => {
    const { call } = makeServer();
    expect((await call("records.list"))["result"]).toEqual({ records: [] });
  });

  it("给的是摘要,20 项按名字定死(记录页与订单看板读的就是这些)", async () => {
    const { s, call } = makeServer();
    makeRecord(s);
    const out = (await call("records.list"))["result"];
    expect(out["records"]).toHaveLength(1);
    expect(Object.keys(out["records"][0]).sort()).toEqual([
      "account", "account_masked", "action", "avg_fill_price", "confidence", "created_at", "execution_type",
      "final_status", "id", "intent_summary", "is_paper", "notional_estimate", "quantity", "raw_instruction",
      "reason", "rejection", "secType", "status", "symbol", "total_commission",
    ]);
  });

  it("摘要里的值是从嵌套结构里摘出来的,不是整块转出", async () => {
    const { s, call } = makeServer();
    makeRecord(s);
    const r = (await call("records.list"))["result"]["records"][0];
    expect(r["symbol"]).toBe("AAPL");
    expect(r["secType"]).toBe("STK");
    expect(r["action"]).toBe("BUY");
    expect(r["quantity"]).toBe(100);
    expect(r["intent_summary"]).toBe("买入 AAPL 100 股");
    expect(r["raw_instruction"]).toBe("买 100 股苹果");
    expect(r["reason"]).toBe("财报后回踩");
    expect(r["confidence"]).toBe(0.82);
    expect(r["account"]).toBe("模拟");
    expect(r["is_paper"]).toBe(true);
    expect(r["notional_estimate"]).toBe(23000);
    expect(r["execution_type"]).toBe("immediate");
  });

  it("真账号不出现在摘要里:只给打码的,原字段不在", async () => {
    const { s, call } = makeServer();
    makeRecord(s);
    const r = (await call("records.list"))["result"]["records"][0];
    expect(r["account_masked"]).toBe("U1***567"); // 前二后三,中间三颗星
    expect("account_id" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain(REAL_ACCOUNT);
  });

  it("status 取时间线上最后一条;还没有回报时是 null", async () => {
    const { s, call } = makeServer();
    const id = makeRecord(s);
    expect((await call("records.list"))["result"]["records"][0]["status"]).toBeNull();
    s.engine.store.appendEvent(id, "status", { status: "Submitted" });
    s.engine.store.appendEvent(id, "status", { status: "Filled" });
    expect((await call("records.list"))["result"]["records"][0]["status"]).toBe("Filled");
  });

  it("按 created_at 倒序;limit 给了按给的来", async () => {
    const { s, call } = makeServer();
    for (let i = 0; i < 3; i += 1) {
      makeRecord(s, { created_at: `2026-09-2${i}T13:30:00+00:00`, contract: { secType: "STK", symbol: `S${i}` } });
    }
    const all = (await call("records.list"))["result"]["records"];
    expect(all.map((r: Rec) => r["symbol"])).toEqual(["S2", "S1", "S0"]);
    const two = (await call("records.list", { limit: 2 }))["result"]["records"];
    expect(two.map((r: Rec) => r["symbol"])).toEqual(["S2", "S1"]);
  });

  it("不给 limit 就是 30 条——库里放 31 条才分得出这个默认值", async () => {
    const { s, call } = makeServer();
    for (let i = 0; i < 31; i += 1) {
      makeRecord(s, { created_at: `2026-09-20T13:${String(i).padStart(2, "0")}:00+00:00` });
    }
    expect((await call("records.list"))["result"]["records"]).toHaveLength(30);
    expect((await call("records.list", { limit: 31 }))["result"]["records"]).toHaveLength(31);
  });

  it("limit 给数字串照收(界面上是从输入框来的)", async () => {
    const { s, call } = makeServer();
    makeRecord(s);
    makeRecord(s);
    expect((await call("records.list", { limit: "1" }))["result"]["records"]).toHaveLength(1);
  });
});

describe("records.get", () => {
  it("给的是整条记录,不是摘要:嵌套结构原样在", async () => {
    const { s, call } = makeServer();
    const id = makeRecord(s);
    const rec = (await call("records.get", { id }))["result"]["record"];
    expect(rec["id"]).toBe(id);
    expect(rec["contract"]).toEqual({ secType: "STK", symbol: "AAPL" });
    expect(rec["order"]["lmtPrice"]).toBe(230);
    expect(rec["input"]["raw_instruction"]).toBe("买 100 股苹果");
    // 库那边补出来的两个空数组也在
    expect(rec["ibkr"]["status_timeline"]).toEqual([]);
    expect(rec["ibkr"]["fills"]).toEqual([]);
  });

  it("账户块:account_id 换成 account_masked,原字段删掉,别的字段留着", async () => {
    const { s, call } = makeServer();
    const id = makeRecord(s);
    const rec = (await call("records.get", { id }))["result"]["record"];
    expect("account_id" in rec["account"]).toBe(false);
    expect(rec["account"]["account_masked"]).toBe("U1***567");
    expect(rec["account"]["alias"]).toBe("模拟");
    expect(rec["account"]["is_paper"]).toBe(true);
    expect(JSON.stringify(rec)).not.toContain(REAL_ACCOUNT);
  });

  it("打码不回写库:再查一次,库里那条还是带着真账号", async () => {
    const { s, call } = makeServer();
    const id = makeRecord(s);
    await call("records.get", { id });
    expect(s.engine.store.getRecord(id)!["account"]["account_id"]).toBe(REAL_ACCOUNT);
    // 真正拦住回写的是**库每次现解析一份**(getRecord 读 record_json 再 JSON.parse),
    // 不是 handler 里那个展开。把展开去掉这一条也不会红——如实记在这儿,别把它当成护栏。
  });

  it("id 不存在 → -32005 记录不存在", async () => {
    const { call } = makeServer();
    const res = await call("records.get", { id: "没有这一条" });
    expect(res["error"]["code"]).toBe(-32005);
    expect(res["error"]["message"]).toBe("记录不存在");
  });

  it("不给 id 也是同一句(缺 id 和 id 对不上不分开说)", async () => {
    const { call } = makeServer();
    expect((await call("records.get"))["error"]["message"]).toBe("记录不存在");
  });
});

describe("pending.list", () => {
  it("队列空的时候回空数组", async () => {
    const { call } = makeServer();
    expect((await call("pending.list"))["result"]).toEqual({ pending: [] });
  });

  it("每条给七项,值从 approved / trigger 两边摘出来", async () => {
    const { s, call } = makeServer();
    const rid = makeRecord(s);
    s.engine.pendingTriggers.push(pendingItem(rid, "AAPL", {
      trigger: { symbol: "AAPL", operator: "<=", value: 220 },
    }) as never);
    const out = (await call("pending.list"))["result"]["pending"];
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]).sort()).toEqual([
      "account", "created_at", "intent_summary", "operator", "record_id", "symbol", "value",
    ]);
    expect(out[0]).toEqual({
      record_id: rid,
      intent_summary: "AAPL 到价买入",
      symbol: "AAPL",
      operator: "<=",
      value: 220,
      account: "模拟",
      created_at: "2026-09-20T13:30:00+00:00",
    });
    // 队列里给的是别名,真账号不在里面
    expect(JSON.stringify(out)).not.toContain(REAL_ACCOUNT);
  });
});

describe("pending.poll", () => {
  it("没连券商:不问价、不触发,synced 是 0(没有券商可问)", async () => {
    const { call } = makeServer({ connected: false });
    const out = (await call("pending.poll"))["result"];
    expect(out["fired"]).toEqual([]);
    expect(out["prices"]).toEqual({});
    expect(out["synced"]).toBe(0);
  });

  it("连着券商但队列是空的:不问价,但**照样同步一次券商回报**——富途没有事件流,全靠这一口气", async () => {
    const { call, router } = makeServer();
    const out = (await call("pending.poll"))["result"];
    expect(out["fired"]).toEqual([]);
    expect(out["prices"]).toEqual({});
    expect(router.askedPrices).toEqual([]);
    expect(router.syncCalls).toBe(1); // 队列空也要问
  });

  it("队列里有单:每个标的只问一次价,问到的才进 prices", async () => {
    const { s, call, router } = makeServer();
    // 两条 AAPL、一条 MSFT:AAPL 只该问一次;MSFT 问不到价就不进 prices
    s.engine.pendingTriggers.push(
      pendingItem(makeRecord(s), "AAPL") as never,
      pendingItem(makeRecord(s), "AAPL") as never,
      pendingItem(makeRecord(s), "MSFT") as never,
    );
    router.prices["AAPL"] = 230.5;
    const out = (await call("pending.poll"))["result"];
    expect(router.askedPrices).toEqual(["AAPL", "MSFT"]);
    expect(out["prices"]).toEqual({ AAPL: 230.5 });
    expect(out["fired"]).toEqual([]);
  });

  it("回执带 expired(连着券商时);盯盘是界面驱动的,这条不发就没人管过期", async () => {
    const { s, call } = makeServer();
    s.engine.pendingTriggers.push(pendingItem(makeRecord(s), "AAPL") as never);
    const out = (await call("pending.poll"))["result"];
    expect("expired" in out).toBe(true);
  });
});
