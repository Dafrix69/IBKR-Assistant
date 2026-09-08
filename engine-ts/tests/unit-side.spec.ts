/** 非黄金的单元测试:killswitch(文件状态机)/ macro(双来源与降级)/ schema 清洗。
 * 行为规格来自 Python 版对应测试的要点。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandHome, loadSettings } from "../src/config.js";
import { KillSwitch } from "../src/killswitch.js";
import { MACRO_SYMBOLS, clearMacroCache, liveTickers, macroBoard } from "../src/macro.js";
import { stripUnsupported } from "../src/schemaOut.js";
import { loadGolden } from "./util.js";

describe("killswitch", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-ks-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (threshold = 3) => new KillSwitch(path.join(dir, "breaker.json"), threshold);

  it("默认未熔断;engage/release 往返", () => {
    const ks = make();
    expect(ks.isEngaged()).toBe(false);
    ks.engage("先停一下");
    expect(ks.isEngaged()).toBe(true);
    expect(ks.state().reason).toBe("先停一下");
    ks.release("测试");
    expect(ks.isEngaged()).toBe(false);
    expect(ks.state().reason).toBe("由 测试 手动解除");
  });

  it("连续失败达到阈值自动熔断", () => {
    const ks = make(3);
    expect(ks.recordFailure("一")).toBeNull();
    expect(ks.recordFailure("二")).toBeNull();
    const tripped = ks.recordFailure("三");
    expect(tripped).not.toBeNull();
    expect(tripped!.engaged).toBe(true);
    expect(tripped!.reason).toBe("连续 3 次失败后自动熔断(最近一次:三)");
  });

  it("解析成功不清券商计数(两类失败不能互相掩护)", () => {
    const ks = make(3);
    ks.recordFailure("下单挂了", "broker");
    ks.recordFailure("下单又挂了", "broker");
    ks.recordSuccess("parse"); // 解析成功
    expect(ks.state().consecutive_failures).toBe(2); // 券商计数原封不动
    const tripped = ks.recordFailure("第三次", "broker");
    expect(tripped).not.toBeNull();
  });

  it("解析失败与券商失败分开计数", () => {
    const ks = make(3);
    ks.recordFailure("p1", "parse");
    ks.recordFailure("b1", "broker");
    ks.recordFailure("p2", "parse");
    const s = ks.state();
    expect(s.consecutive_parse_failures).toBe(2);
    expect(s.consecutive_failures).toBe(1);
    expect(s.engaged).toBe(false);
  });

  it("状态文件损坏 → 按已熔断处理(安全侧)", () => {
    const ks = make();
    fs.writeFileSync(ks.path, "{half json", "utf-8");
    expect(ks.isEngaged()).toBe(true);
    expect(ks.state().reason).toContain("损坏");
  });
});

describe("macro", () => {
  beforeEach(() => clearMacroCache());

  it("VIX 与美债10Y 永远不给 ETF 替身(test_vix_and_10y_never_get_an_etf_stand_in)", () => {
    const vix = MACRO_SYMBOLS.find((s) => s["key"] === "^VIX")!;
    const tnx = MACRO_SYMBOLS.find((s) => s["key"] === "^TNX")!;
    expect(vix["live"]).toBeNull();
    expect(tnx["live"]).toBeNull();
    expect(liveTickers()).not.toContain("VIXY");
    expect(liveTickers()).not.toContain("TLT");
  });

  it("TWS 流有数的格走 tws,其余走公开源;失败只丢一格", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("%5EVIX") || url.includes("^VIX")) throw new Error("boom");
      return {
        chart: { result: [{ meta: { regularMarketPrice: 100.0, chartPreviousClose: 99.0 } }] },
      };
    };
    const router = {
      streamQuotes: () => ({ SPY: { last: 450.1, change_pct: 0.5 } }),
    };
    const board = await macroBoard({ router, fetcher, now: () => 1000 });
    const spy = board["rows"].find((r: any) => r["key"] === "^GSPC");
    expect(spy["source"]).toBe("tws");
    expect(spy["instrument"]).toBe("SPY");
    expect(spy["last"]).toBe(450.1);
    const vix = board["rows"].find((r: any) => r["key"] === "^VIX");
    expect(vix["source"]).toBe("public");
    expect(vix["last"]).toBeNull();
    expect(vix["error"]).toBeDefined();
    const gold = board["rows"].find((r: any) => r["key"] === "GC=F");
    expect(gold["last"]).toBe(100.0);
    expect(gold["change_pct"]).toBeCloseTo(1.01, 6);
    expect(board["live_count"]).toBe(1);
  });

  it("公开源失败时保留上一次的值并标 stale", async () => {
    let fail = false;
    const fetcher = async () => {
      if (fail) throw new Error("net");
      return { chart: { result: [{ meta: { regularMarketPrice: 42.0, chartPreviousClose: 41.0 } }] } };
    };
    let t = 1000;
    const first = await macroBoard({ fetcher, now: () => t });
    expect(first["rows"][0]["last"]).toBe(42.0);
    fail = true;
    t += 120; // 超过 TTL;force 才同步重取(对应 Python 测试的 force=True)
    const second = await macroBoard({ fetcher, now: () => t, force: true });
    expect(second["rows"][0]["last"]).toBe(42.0);
    expect(second["rows"][0]["stale"]).toBe(true);
  });

  it("周期轮询过期时旧值先给、后台刷新,不挡主循环(stale-while-revalidate)", async () => {
    const n = MACRO_SYMBOLS.length;
    let calls = 0;
    const waiters: Array<() => void> = [];
    const fetcher = async () => {
      calls += 1;
      if (calls <= n) {
        return { chart: { result: [{ meta: { regularMarketPrice: 42.0, chartPreviousClose: 41.0 } }] } };
      }
      // 第二轮请求故意挂住:如果主循环等它,这个测试就会卡住
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
      return { chart: { result: [{ meta: { regularMarketPrice: 43.0, chartPreviousClose: 41.0 } }] } };
    };
    let t = 1000;
    await macroBoard({ fetcher, now: () => t });
    t += 120; // 超过 TTL,但没超过 MAX_STALE
    const second = await macroBoard({ fetcher, now: () => t });
    expect(second["rows"][0]["last"]).toBe(42.0); // 旧值立刻返回
    expect(second["rows"][0]["refreshing"]).toBe(true);
    // 单飞:再打一次不会再起第二批后台请求
    await macroBoard({ fetcher, now: () => t });
    expect(calls).toBe(n * 2);
    for (const release of waiters) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await macroBoard({ fetcher, now: () => t + 1 });
    expect(third["rows"][0]["last"]).toBe(43.0); // 后台取回的新值落到缓存
  });
});

describe("schema strip", () => {
  it("剥掉数值/长度约束并补 additionalProperties:false", () => {
    const schema = {
      type: "object",
      properties: {
        qty: { type: "integer", minimum: 1, maximum: 10 },
        name: { type: "string", minLength: 1, pattern: "^a" },
        legs: {
          type: "array", minItems: 2, maxItems: 4,
          items: { type: "object", properties: { strike: { type: "number", exclusiveMinimum: 0 } } },
        },
      },
      required: ["qty"],
    };
    const out = stripUnsupported(schema) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.qty.minimum).toBeUndefined();
    expect(out.properties.name.pattern).toBeUndefined();
    expect(out.properties.legs.minItems).toBeUndefined();
    expect(out.properties.legs.items.additionalProperties).toBe(false);
    expect(out.properties.legs.items.properties.strike.exclusiveMinimum).toBeUndefined();
    expect(out.required).toEqual(["qty"]);
    // 原对象不被改动
    expect(schema.properties.qty.minimum).toBe(1);
  });
});

// ---------------------------------------------------------------- rpc serve 优先级
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { RpcServer } from "../src/rpc.js";

describe("rpc serve: 用户请求插队到周期轮询前面", () => {
  it("records.list 先于排在前面的 system.status / pending.poll 得到响应,坏 JSON 也有回应", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-serve-"));
    const base = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const config = { ...base, storage: { db_path: path.join(dir, "trades.db") } };
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify(config));

    const input = new PassThrough();
    const chunks: string[] = [];
    const server = new RpcServer(settingsPath, (line) => { chunks.push(line); });
    const done = server.serve(input);
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "system.status", params: {} },
      { jsonrpc: "2.0", id: 2, method: "pending.poll", params: {} },
      { jsonrpc: "2.0", id: 3, method: "records.list", params: { limit: 1 } },
    ];
    input.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    input.end();
    await done;

    // out 回调每次收到一整行(不带换行)
    const order = chunks
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((m) => m["method"] !== "event")
      .map((m) => m["id"]);
    expect(order[0]).toBe(3);
    expect(order.filter((i) => i === 1 || i === 2)).toEqual([1, 2]);
    expect(order).toContain(null);
  });
});

// ---------------------------------------------------------------- store 迁移:追踪表加腿身份
import Database from "better-sqlite3";
import { TradeStore } from "../src/store.js";

describe("store 迁移:position_tracks 加 leg 列并重建唯一约束", () => {
  it("老库打开后老记录保留、同一标的的两条期权腿都能追踪、正股重复仍被拒", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-mig-"));
    const dbPath = path.join(dir, "old.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE position_tracks (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        account TEXT NOT NULL, symbol TEXT NOT NULL, sec_type TEXT NOT NULL DEFAULT 'STK',
        contract TEXT NOT NULL DEFAULT '{}', targets TEXT NOT NULL DEFAULT '{}',
        auto_close TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        peak REAL, fired_at TEXT, fired_state TEXT NOT NULL DEFAULT '',
        fired_record TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        UNIQUE(account, symbol, sec_type)
      );
      INSERT INTO position_tracks (id, created_at, updated_at, account, symbol, peak, note)
      VALUES ('t1', '2026-08-01T00:00:00+00:00', '2026-08-01T00:00:00+00:00', '模拟', 'AAPL', 245.5, '老记录');
    `);
    raw.close();

    const store = new TradeStore(dbPath);
    const rows = store.listTracks();
    expect(rows.map((r) => r["id"])).toEqual(["t1"]);
    expect(rows[0]!["leg"]).toBe("");
    expect(rows[0]!["peak"]).toBe(245.5);
    const a = store.addTrack({ account: "模拟", symbol: "SPX", sec_type: "OPT", leg: "20260901|7600|P" });
    const b = store.addTrack({ account: "模拟", symbol: "SPX", sec_type: "OPT", leg: "20260901|7615|P" });
    expect(a["id"]).not.toBe(b["id"]);
    expect(() => store.addTrack({ account: "模拟", symbol: "SPX", sec_type: "OPT", leg: "20260901|7615|P" }))
      .toThrowError("已经在追踪 模拟 的 SPX 20260901|7615|P 了");
    expect(() => store.addTrack({ account: "模拟", symbol: "AAPL" })).toThrowError("已经在追踪 模拟 的 AAPL 了");
    store.close();
    const again = new TradeStore(dbPath); // 再开一次不重复迁移
    expect(again.listTracks().length).toBe(3);
    again.close();
  });
});

// ---------------------------------------------------------------- 配置里的 ~
describe("配置:db_path 的家目录展开", () => {
  it("`~/…` 展开成家目录,不是一个叫 ~ 的普通目录", () => {
    // 不展开的后果不是报错,是**静悄悄写到别的地方**:Node 会把 ~ 当字面目录名,
    // 相对 cwd 建出来。同一份配置、两个引擎、两个库,切换时记录全部"消失"。
    // (2026-09-04 实测:项目根目录下真的多出了一个 ~ 文件夹,WAL 有 1.5MB。)
    const home = os.homedir();
    expect(expandHome("~/Library/Application Support/dafri/trades.db"))
      .toBe(path.join(home, "Library/Application Support/dafri/trades.db"));
    expect(expandHome("~")).toBe(home);
    expect(expandHome("~" + path.sep + "Library" + path.sep + "x.db"))
      .toBe(path.join(home, "Library" + path.sep + "x.db"));
    // 只有开头的 ~ 才展开;绝对路径、相对路径、路径中间的 ~ 都原样保留
    expect(expandHome("/abs/x.db")).toBe("/abs/x.db");
    expect(expandHome("data/b.db")).toBe("data/b.db");
    expect(expandHome("/a/~/b.db")).toBe("/a/~/b.db");
    expect(expandHome("~user/x.db")).toBe("~user/x.db");
  });

  it("loadSettings 落到和 Python 同一个绝对路径", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-tilde-"));
    const cfgPath = path.join(dir, "settings.json");
    const raw = JSON.parse(JSON.stringify(loadGolden("config").base_config));
    raw.storage = { db_path: "~/Library/Application Support/dafri/trades.db" };
    fs.writeFileSync(cfgPath, JSON.stringify(raw), "utf-8");

    const settings = loadSettings(cfgPath);
    expect(settings.db_path).not.toContain("~");
    expect(path.isAbsolute(settings.db_path)).toBe(true);
    expect(settings.db_path)
      .toBe(path.join(os.homedir(), "Library/Application Support/dafri/trades.db"));
  });
});
