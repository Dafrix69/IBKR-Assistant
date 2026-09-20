/** book.snapshot 与 macro.board 在 RPC 这一层的特征测试。
 *
 * 两样在下面各有各的测试(盘口的形状由两家券商适配层产出;宏观行情带的双来源与降级由 unit-side.spec 直接调 macroBoard 钉着),
 * 但**从 RPC 进来这一段**没人钉过:盘口是原样转出还是加工过、错误码怎么分;行情带的 router 是被 handler 摊平了再交给
 * macroBoard 的(它那一面是同步的),摊得对不对、问的是哪几个 ticker、TNX 的 10 倍口径在这条路上还在不在。
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商是假的,**全局 fetch 被换成假的**——宏观行情带在没连券商时会去打公开
 * 数据源(那一段的双来源与降级由 unit-side.spec 用注入的 fetcher 钉着),这里不让它真出网:没登记的 URL 一律抛,
 * 谁不小心把网络打开了,测试会红在"这个 URL 没登记",而不是变成一条看天气的用例。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerError } from "../src/broker.js";
import { clearMacroCache, liveTickers } from "../src/macro.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** IBKR 适配层给的那份盘口(broker.ts 的 orderBook:一档 + 深度 + 流动性摘要)。 */
const BOOK = (over: Rec = {}): Rec => ({
  symbol: "AAPL",
  l1: { bid: 229.98, ask: 230.02, bid_size: 300, ask_size: 200, last: 230.0, spread: 0.04, spread_bps: 1.7 },
  bids: [{ price: 229.98, size: 300 }, { price: 229.95, size: 500 }],
  asks: [{ price: 230.02, size: 200 }, { price: 230.05, size: 400 }],
  note: "",
  liquidity: { spread_bps: 1.7, spread_grade: "很好", bid_depth: 800, ask_depth: 600, levels: 2, imbalance_pct: 14.3 },
  ...over,
});

class FakeRouter {
  askedBook: Array<[string, unknown]> = [];
  askedTickers: string[][] = [];
  bookFail: Error | null = null;
  book: Rec = BOOK();
  /** 行情带:7 格全给,macroBoard 就不会去打公开数据源 */
  quotes: Rec = Object.fromEntries(liveTickers().map((t, i) => [t, { last: 100 + i, change_pct: 0.5 + i }]));
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async orderBook(symbol: string, rows?: number): Promise<Rec> {
    this.askedBook.push([symbol, rows]);
    if (this.bookFail !== null) throw this.bookFail;
    return { ...this.book, symbol };
  }
  async streamQuotes(tickers: string[]): Promise<Rec> {
    this.askedTickers.push([...tickers]);
    return this.quotes;
  }
}

/** 假的公开数据源:按 URL 给 Yahoo chart 那种载荷;没登记的 URL 抛(= 测试里不许真出网)。 */
let publicQuotes: Record<string, number> = {};
const fetched: string[] = [];
beforeEach(() => {
  publicQuotes = {};
  fetched.length = 0;
  vi.stubGlobal("fetch", async (url: string): Promise<unknown> => {
    fetched.push(String(url));
    const key = decodeURIComponent(new URL(String(url)).pathname.split("/").pop() ?? "");
    const price = publicQuotes[key];
    if (price === undefined) throw new Error(`测试里不许打网络:${url}`);
    const body = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: price / 1.01 } }] } });
    return { ok: true, status: 200, statusText: "OK", text: async () => body };
  });
});

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-mkt-rpc-"));
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

afterEach(() => {
  vi.unstubAllGlobals();
  clearMacroCache(); // 行情带的缓存是模块级的,别把一个用例的格子留给下一个
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

describe("book.snapshot", () => {
  it("适配层那份盘口原样转出;代码规整过,档数用适配层自己的默认值", async () => {
    const { call, router } = makeServer();
    const out = (await call("book.snapshot", { symbol: " aapl " }))["result"];
    expect(router.askedBook).toEqual([["AAPL", undefined]]);
    expect(out).toEqual(BOOK());
    // 界面读的每一个键都在
    expect(Object.keys(out).sort()).toEqual(["asks", "bids", "l1", "liquidity", "note", "symbol"]);
    expect(Object.keys(out["l1"]).sort()).toEqual(["ask", "ask_size", "bid", "bid_size", "last", "spread", "spread_bps"]);
    expect(out["bids"][0]).toEqual({ price: 229.98, size: 300 });
  });

  it("只有一档时:l1 里没有 spread,liquidity 只给失衡并标 l1_only", async () => {
    const { call, router } = makeServer();
    router.book = BOOK({
      l1: { bid: 10, ask: null, bid_size: 100, ask_size: 0, last: 10 },
      bids: [], asks: [], note: "未收到深度数据:Level 2 行情需要单独订阅(如 NASDAQ TotalView)。上方为一档盘口。",
      liquidity: { imbalance_pct: 100, l1_only: true },
    });
    const out = (await call("book.snapshot", { symbol: "AAPL" }))["result"];
    expect(out["liquidity"]).toEqual({ imbalance_pct: 100, l1_only: true });
    expect(out["l1"]["spread"]).toBeUndefined();
    expect(out["note"]).toMatch(/^未收到深度数据/);
  });

  it("代码不合法、没连券商、券商报错:-32602 / -32014 / -32014(都是 golden-rpc 钉着的那两句)", async () => {
    const off = makeServer({ connected: false });
    expect((await off.call("book.snapshot", { symbol: "AAPL" }))["error"]).toEqual({
      code: -32014, message: "读取盘口需要TWS / IB Gateway:请先在「TWS 连接」面板连接引擎。",
    });
    const { call, router } = makeServer();
    expect((await call("book.snapshot", { symbol: "bad$" }))["error"]).toEqual({ code: -32602, message: "股票代码不合法:'bad$'" });
    // 迁移前这一句是 handler 的「股票代码不合法:'undefined'」;golden-rpc 没钉它,按"缺必填字段归 schema 报"的规矩改了
    // (界面的 preload 永远带 symbol,走不到这条)。这是本批唯一一处刻意改掉的文案。
    expect((await call("book.snapshot", {}))["error"]).toEqual({ code: -32602, message: "book.snapshot 的参数不对:缺少 symbol" });
    router.bookFail = new BrokerError("指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。");
    expect((await call("book.snapshot", { symbol: "SPX" }))["error"]).toEqual({
      code: -32014, message: "指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。",
    });
  });
});

describe("macro.board", () => {
  it("连着券商:7 格全走 TWS;handler 把异步的 streamQuotes 摊平交给 macroBoard(它那一面是同步的)", async () => {
    const { call, router } = makeServer();
    const board = (await call("macro.board"))["result"];
    // 问的是固定清单,一次;macroBoard 内部再要一次时 handler 给的是同一份快照,不会再打券商
    expect(router.askedTickers).toEqual([liveTickers()]);
    expect(board["live_count"]).toBe(7);
    expect(board["rows"]).toHaveLength(7);
    expect(typeof board["at"]).toBe("number");
    expect(board["rows"].map((r: Rec) => r["key"])).toEqual(["^GSPC", "^NDX", "^VIX", "^TNX", "GC=F", "BZ=F", "BTC-USD"]);
    for (const row of board["rows"]) {
      expect(row["source"]).toBe("tws");
      expect(Object.keys(row).sort()).toEqual(["change_pct", "fmt", "instrument", "key", "label", "last", "source"]);
    }
    // 界面按 instrument 标出"这一格实际读的是哪个标的"
    expect(board["rows"][0]).toMatchObject({ label: "标普500", fmt: "price", instrument: "SPX" });
    expect(board["rows"][6]).toMatchObject({ label: "比特币", instrument: "PAXOS" });
  });

  it("美债 10Y 的 10 倍口径在这条路上还在:TWS 报 48.06,行情带给 4.806", async () => {
    const { call, router } = makeServer();
    router.quotes = { ...router.quotes, "IND:TNX@CBOE": { last: 48.06, change_pct: -0.4 } };
    const row = (await call("macro.board"))["result"]["rows"].find((r: Rec) => r["key"] === "^TNX");
    expect(row).toEqual({ key: "^TNX", label: "美债10Y", fmt: "pct", last: 4.806, change_pct: -0.4, source: "tws", instrument: "TNX" });
  });

  /**
   * 2026-09-20 之前这里钉的是另一个结果:整条 macro.board 报 -32000。macroBoard 自己防住了 router 抛异常,但 handler 为了
   * 把异步的 streamQuotes 摊平,在它外面先 await 了一次,那一次没有护栏——界面上的表现是行情带不再更新。
   * 迁契约时照出来、先钉住现状,用户定了之后才改:现在这一轮当成"没有流式报价",七格降级到公开源。
   */
  it("券商的流式报价抛异常:这一轮降级到公开源,不是整条 RPC 报错", async () => {
    const { call, router } = makeServer();
    router.streamQuotes = async () => { throw new Error("行情线路满了"); };
    publicQuotes = { "^GSPC": 7673, "^NDX": 29507, "^VIX": 15.2, "^TNX": 4.806, "GC=F": 4412, "BZ=F": 99.93, "BTC-USD": 64000 };
    const out = await call("macro.board");
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["live_count"]).toBe(0);
    expect(out["result"]["rows"]).toHaveLength(7);
    for (const row of out["result"]["rows"]) expect(row).toMatchObject({ source: "public", instrument: null });
    expect(out["result"]["rows"][0]["last"]).toBe(7673);
  });

  it("没连券商:不问券商,直接走公开源;公开源那一路的 instrument 是 null(界面据此不标绿点)", async () => {
    const { call, router } = makeServer({ connected: false });
    publicQuotes = { "^GSPC": 7673, "^NDX": 29507, "^VIX": 15.2, "^TNX": 4.806, "GC=F": 4412, "BZ=F": 99.93, "BTC-USD": 64000 };
    const board = (await call("macro.board"))["result"];
    expect(router.askedTickers).toEqual([]);
    expect(board["live_count"]).toBe(0);
    expect(board["rows"]).toHaveLength(7);
    for (const row of board["rows"]) {
      expect(row["source"]).toBe("public");
      expect(row["instrument"]).toBeNull();
      expect(typeof row["last"]).toBe("number");
    }
    expect(fetched).toHaveLength(7);
  });

  it("force:界面点强制刷新才重取;老 handler 是 Boolean(force),给个真值字符串照收(schema 不比它严)", async () => {
    const { call } = makeServer({ connected: false });
    publicQuotes = { "^GSPC": 7673, "^NDX": 29507, "^VIX": 15.2, "^TNX": 4.806, "GC=F": 4412, "BZ=F": 99.93, "BTC-USD": 64000 };
    await call("macro.board");
    expect(fetched).toHaveLength(7);
    await call("macro.board"); // 没过 TTL:吃缓存,一次都不重取
    expect(fetched).toHaveLength(7);
    await call("macro.board", { force: "yes" }); // 界面发的是布尔,这里故意给个真值字符串
    expect(fetched).toHaveLength(14);
  });
  it("一格取不到:这一格 last 是 null、带一句 error,别的格子照常(行情带永远不整条崩)", async () => {
    const { call } = makeServer({ connected: false });
    // ^GSPC 不登记 → 假 fetch 抛;Cboe 备用源也不登记 → 这一格没救回来
    publicQuotes = { "^NDX": 29507, "^VIX": 15.2, "^TNX": 4.806, "GC=F": 4412, "BZ=F": 99.93, "BTC-USD": 64000 };
    const board = (await call("macro.board"))["result"];
    const spx = board["rows"].find((r: Rec) => r["key"] === "^GSPC");
    expect(spx).toMatchObject({ key: "^GSPC", last: null, change_pct: null, source: "public" });
    expect(spx["error"]).toMatch(/测试里不许打网络/);
    expect(board["rows"].filter((r: Rec) => r["last"] !== null)).toHaveLength(6);
  });
});
