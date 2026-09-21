/** 非黄金的单元测试:killswitch(文件状态机)/ macro(双来源与降级)。
 * 行为规格来自 Python 版对应测试的要点。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandHome, loadSettings } from "../src/config.js";
import { KillSwitch } from "../src/killswitch.js";
import { MACRO_SYMBOLS, clearMacroCache, liveTickers, macroBoard } from "../src/macro.js";
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

  it("每一格都取标的本身,不用会失真的 ETF 替身", () => {
    // 原来这条只钉 "^VIX / ^TNX 的 live 必须是 null",守的是字面而不是道理,
    // 结果黄金挂着 GLD(403 对黄金 4412)、布油挂着 BNO(58 对布伦特 99.9)一路没人管。
    // 改成守原则:这些替身一个都不许出现在流式清单里。
    const live = liveTickers();
    for (const bad of ["VIXY", "TLT", "IBIT", "GLD", "BNO", "USO", "SLV"]) {
      expect(live, `${bad} 是会失真的替身`).not.toContain(bad);
    }
    for (const bad of ["SPY", "QQQ"]) {
      expect(live, `${bad} 与指数差一个量级`).not.toContain(bad);
    }
    const bySymbol = (key: string) => MACRO_SYMBOLS.find((s) => s["key"] === key)!;
    // 指数格看指数本身
    expect(bySymbol("^GSPC")["live"]).toBe("IND:SPX@CBOE");
    expect(bySymbol("^NDX")["live"]).toBe("IND:NDX@NASDAQ");
    // 商品看期货本身;比特币看 PAXOS 现货;收益率看 Cboe 的 TNX 指数
    expect(bySymbol("GC=F")["live"]).toBe("CONTFUT:GC@COMEX");
    expect(bySymbol("GC=F")["label"]).toBe("纽约金");
    expect(bySymbol("BZ=F")["live"]).toBe("CONTFUT:BZ@NYMEX"); // 布伦特,不是 WTI
    expect(bySymbol("BTC-USD")["live"]).toBe("CRYPTO:BTC");
    // TNX 是 10 倍口径:48.06 → 4.806%。少了这个 scale 界面上会写 48% 的十年期
    expect(bySymbol("^TNX")["live"]).toBe("IND:TNX@CBOE");
    expect(bySymbol("^TNX")["scale"]).toBe(0.1);
    // VIX 取 Cboe 的指数本身,不是 VIXY
    expect(bySymbol("^VIX")["live"]).toBe("IND:VIX@CBOE");
    expect(MACRO_SYMBOLS.some((s) => s["key"] === "DX-Y.NYB")).toBe(false);
  });

  it("TNX 的 10 倍口径两条路都要折算,涨跌幅不跟着缩放", async () => {
    // TWS 那路
    const router = { streamQuotes: () => ({ "IND:TNX@CBOE": { last: 48.06, change_pct: 0.42 } }) };
    const board = await macroBoard({ router, fetcher: async () => { throw new Error("x"); }, now: () => 7000 });
    const tnx = board["rows"].find((r: any) => r["key"] === "^TNX")!;
    expect(tnx["last"]).toBe(4.806);
    expect(tnx["change_pct"]).toBe(0.42); // 比值不缩放
    expect(tnx["instrument"]).toBe("TNX");

    // 公开源那路
    clearMacroCache();
    const cboe = async (url: string) => {
      if (url.includes("_TNX")) return { data: { current_price: 48.06, close: 48.06, price_change: 0 } };
      throw new Error("数据源返回 HTTP 403 Forbidden");
    };
    const board2 = await macroBoard({ fetcher: cboe, now: () => 8000 });
    expect(board2["rows"].find((r: any) => r["key"] === "^TNX")!["last"]).toBe(4.806);
  });

  it("TWS 流有数的格走 tws,其余走公开源;失败只丢一格", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("%5EVIX") || url.includes("^VIX")) throw new Error("boom");
      return {
        chart: { result: [{ meta: { regularMarketPrice: 100.0, chartPreviousClose: 99.0 } }] },
      };
    };
    const router = {
      streamQuotes: () => ({
        "IND:SPX@CBOE": { last: 7673.52, change_pct: 0.5 },
        "CRYPTO:BTC": { last: 78609.25, change_pct: -0.94 },
      }),
    };
    const board = await macroBoard({ router, fetcher, now: () => 1000 });
    const spy = board["rows"].find((r) => r["key"] === "^GSPC");
    expect(spy!["source"]).toBe("tws");
    expect(spy!["instrument"]).toBe("SPX");
    expect(spy!["last"]).toBe(7673.52);
    // 比特币格:流里的键是加密标记,界面上标的是 PAXOS,数值是币价本身
    const btc = board["rows"].find((r) => r["key"] === "BTC-USD");
    expect(btc!["source"]).toBe("tws");
    expect(btc!["instrument"]).toBe("PAXOS");
    expect(btc!["last"]).toBe(78609.25);
    const vix = board["rows"].find((r) => r["key"] === "^VIX");
    expect(vix!["source"]).toBe("public");
    expect(vix!["last"]).toBeNull();
    expect(vix!["error"]).toBeDefined();
    const gold = board["rows"].find((r) => r["key"] === "GC=F");
    expect(gold!["last"]).toBe(100.0);
    expect(gold!["change_pct"]).toBeCloseTo(1.01, 6);
    expect(board["live_count"]).toBe(2);
  });

  it("公开源被挡时报的是原因,不是 SyntaxError", async () => {
    // 2026-09-09 实测:Yahoo 的 chart 端点回 403 + HTML 错误页,原来直接 .json() 抛
    // SyntaxError,再取 .name 记进 error —— 界面上七格全写着 "SyntaxError",
    // 看不出是被限流、被地区封禁,还是端点改了。
    const { defaultFetcherForTest } = await import("../src/macro.js");
    const html = "<!DOCTYPE html>\n<html lang=\"zh\"><head><title>Yahoo</title>";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, { status: 403, statusText: "Forbidden" })) as typeof fetch;
    try {
      await expect(defaultFetcherForTest("https://example.invalid/x", 1000)).rejects.toThrow(
        /HTTP 403/,
      );
      globalThis.fetch = (async () => new Response(html, { status: 200 })) as typeof fetch;
      await expect(defaultFetcherForTest("https://example.invalid/x", 1000)).rejects.toThrow(
        /不是 JSON/,
      );
    } finally {
      globalThis.fetch = original;
    }

    // 走到整块看板上:主源全挂时,能走 Cboe 的那三格要救回来,其余格子如实报原因
    const fetcher = async (url: string) => {
      if (url.includes("cboe.com")) {
        if (url.includes("_VIX")) return { data: { current_price: 15.69, close: 15.72, price_change: -0.03 } };
        if (url.includes("_SPX")) return { data: { current_price: 7673.52, close: 7718.6, price_change: -45.08 } };
        if (url.includes("_NDX")) return { data: { current_price: 29507.7, close: 29600.0, price_change: -92.3 } };
        throw new Error("数据源返回 HTTP 404 Not Found");
      }
      throw new Error("数据源返回 HTTP 403 Forbidden");
    };
    const board = await macroBoard({ fetcher, now: () => 5000 });
    const row = (key: string) => board["rows"].find((r: any) => r["key"] === key)!;
    expect(row("^VIX")["last"]).toBe(15.69);
    expect(row("^VIX")["instrument"]).toBe("Cboe");
    expect(row("^VIX")["error"]).toBeUndefined();
    expect(row("^GSPC")["last"]).toBe(7673.52);
    expect(row("^GSPC")["change_pct"]).toBeCloseTo(-0.58, 6);
    // 美债10Y 的 Cboe 报价量纲对不上,刻意不接:宁可空着也不能显示错的收益率
    expect(row("^TNX")["last"]).toBeNull();
    expect(row("^TNX")["error"]).toBe("数据源返回 HTTP 403 Forbidden");
    expect(row("GC=F")["error"]).toBe("数据源返回 HTTP 403 Forbidden");
  });

  it("公开源失败时保留上一次的值并标 stale", async () => {
    let fail = false;
    const fetcher = async () => {
      if (fail) throw new Error("net");
      return { chart: { result: [{ meta: { regularMarketPrice: 42.0, chartPreviousClose: 41.0 } }] } };
    };
    let t = 1000;
    const first = await macroBoard({ fetcher, now: () => t });
    expect(first["rows"][0]!["last"]).toBe(42.0);
    fail = true;
    t += 120; // 超过 TTL;force 才同步重取(对应 Python 测试的 force=True)
    const second = await macroBoard({ fetcher, now: () => t, force: true });
    expect(second["rows"][0]!["last"]).toBe(42.0);
    expect(second["rows"][0]!["stale"]).toBe(true);
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
    expect(second["rows"][0]!["last"]).toBe(42.0); // 旧值立刻返回
    expect(second["rows"][0]!["refreshing"]).toBe(true);
    // 单飞:再打一次不会再起第二批后台请求
    await macroBoard({ fetcher, now: () => t });
    expect(calls).toBe(n * 2);
    for (const release of waiters) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await macroBoard({ fetcher, now: () => t + 1 });
    expect(third["rows"][0]!["last"]).toBe(43.0); // 后台取回的新值落到缓存
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
    // system.status 与 records.list 现在都走本地道(即来即答),pending.poll 走交易道:
    // 用户亲手发的 records.list 必须先于排在它前面的 pending.poll 得到响应
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(2));
    expect(order).toContain(1);
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
