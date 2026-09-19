/** 股票池:一只股登记一次(板块成分股 = 池子),「盯价位」/「盯异动」是它身上的两个开关。
 *
 * 用户原话:「这三个功能可以统一吗」。统一之后同一只股不再被登记三份,这里钉住引擎这一侧:
 *  1. `pool.set_watch` 在本地道;两个开关各开各的、幂等;指数只能盯价位;超上限如实进 skipped;写审计;
 *  2. 进池子的默认是两个都开(`sectors.add_stock` / `sectors.pick`),AI 一次十几只很容易吃满 30 只;
 *  3. 出了池子(而且不在别的板块里)连带把两张表的行清掉——池子说了算谁能有这两行;
 *  4. 一次性迁移只跑一次:**用户手动关掉的开关,重启之后必须还是关的**(这条一旦破,每次启动都翻开关);
 *  5. 价位自动算捎带在异动那一轮里做:一轮最多 1 只、连着券商、在时段内,失败按 symbol 退避。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";
import { AlertsService } from "../src/services/alerts.js";
import { PoolService } from "../src/services/pool.js";

type Rec = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 2026-09-11(周五,交易日)美东 11:00 = 开盘后第 90 分钟;17:00 = 收盘后第 60 分钟(时段外)。 */
const ET_1100 = Date.parse("2026-09-11T11:00:00-04:00");
const ET_POST = Date.parse("2026-09-11T17:00:00-04:00");

/** 只为「价位自动算」那一段服务的假券商:不支持量能流,异动那一段会在算完价位之后短路。 */
class FakeLevelsRouter {
  BROKER = "ibkr";
  SUPPORTS_VOLUME_QUOTES = false;
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  chainCalls: string[] = [];
  /** 这些标的的期权链取不到(现价也取不到)——模拟「算失败」。 */
  failChain = new Set<string>();
  sessions(): unknown[] {
    return [{}];
  }
  connectedNames(): string[] {
    return ["paper"];
  }
  async optionChain(symbol: string, expiry: string | null, _width: number): Promise<Rec> {
    this.chainCalls.push(symbol);
    if (this.failChain.has(symbol)) throw new Error("期权链取不到:没有行情权限");
    const rows: Rec[] = [];
    for (let strike = 90; strike <= 110; strike += 2.5) {
      rows.push({ strike, right: "C", oi: 1000, volume: 100, gamma: 0.01, iv: 0.2 });
      rows.push({ strike, right: "P", oi: 900, volume: 90, gamma: 0.01, iv: 0.2 });
    }
    return {
      rows, spot: 100, expiry: expiry ?? "20260918", multiplier: 100,
      expiries: ["20260918"], spot_source: "quote",
    };
  }
  async historicalBars(_symbol: string, _start: string, _end: string): Promise<Rec[]> {
    return []; // 日线拿不到只是少了均线那几条价位,整数关口照给
  }
  async streamQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    const out: Record<string, Rec> = {};
    for (const s of symbols) if (!this.failChain.has(s)) out[s] = { last: 100 };
    return out;
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(dir?: string): { s: RpcServer; chunks: string[]; dir: string } {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dafri-pool-"));
  if (!dir) dirs.push(root);
  const settingsPath = path.join(root, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(root, "t.db") } }));
  }
  const chunks: string[] = [];
  const s = new RpcServer(settingsPath, (line) => { chunks.push(line); });
  void s.engine; // 先建引擎(那时还没 router,不起盯盘节拍器),再挂假 router
  servers.push(s);
  return { s, chunks, dir: root };
}

async function call(s: RpcServer, method: string, params: Rec = {}): Promise<Rec> {
  return s.handle({ jsonrpc: "2.0", id: 1, method, params });
}

/** 审计表里 pool_* 那几行(detail 是 JSON 字符串,解出来好断言)。 */
function poolAudit(s: RpcServer, action: string): Rec[] {
  return (s.engine.store.exportAll()["audit_log"] as Rec[])
    .filter((row) => String(row["action"]) === action)
    .map((row) => JSON.parse(String(row["detail"] ?? "{}")) as Rec);
}

const symbolsOf = (rows: Rec[]): string[] => rows.map((r) => String(r["symbol"])).sort();
const watched = (s: RpcServer): string[] => symbolsOf(s.engine.store.listWatches());
const anomalied = (s: RpcServer): string[] => symbolsOf(s.engine.store.listQualityStocks());

/** 建一个板块,把这几只股按默认(两个开关都开)加进去。回板块 id。 */
async function sectorWith(s: RpcServer, name: string, symbols: string[]): Promise<string> {
  const sector = (await call(s, "sectors.add", { name }))["result"]["sector"];
  for (const symbol of symbols) {
    const out = await call(s, "sectors.add_stock", { id: sector["id"], symbol });
    expect(out["error"], `${name}/${symbol}`).toBeUndefined();
  }
  return String(sector["id"]);
}

/** 30 只占满上限用的代码:QAA、QAB……(SYMBOL_RE 认的形状)。 */
const capSymbol = (i: number): string =>
  `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;

afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engine.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

// ---------------------------------------------------------------- 两个开关
describe("pool.set_watch:一只股身上的两个开关", () => {
  it("在本地道:建 / 删两张表里的一行,没道理排在等网络的行情请求后面", () => {
    expect(RpcServer.LOCAL_METHODS.has("pool.set_watch")).toBe(true);
  });

  it("两个开关各开各的、各关各的;设成已经是的那个状态不出错也不重复建行(幂等)", async () => {
    const { s } = makeServer();
    await sectorWith(s, "科技", ["NVDA"]);
    expect(watched(s)).toEqual(["NVDA"]);
    expect(anomalied(s)).toEqual(["NVDA"]);
    const watchId = s.engine.store.listWatches()[0]!["id"];

    // 只关价位:异动那个不受影响
    let out = (await call(s, "pool.set_watch", { symbol: "nvda", price: false }))["result"];
    expect(out).toEqual({ symbol: "NVDA", price_on: false, anomaly_on: true, skipped: [] });
    expect(watched(s)).toEqual([]);
    expect(anomalied(s)).toEqual(["NVDA"]);

    // 再关一次:幂等
    out = (await call(s, "pool.set_watch", { symbol: "NVDA", price: false }))["result"];
    expect(out).toEqual({ symbol: "NVDA", price_on: false, anomaly_on: true, skipped: [] });

    // 只关异动
    out = (await call(s, "pool.set_watch", { symbol: "NVDA", anomaly: false }))["result"];
    expect(out).toEqual({ symbol: "NVDA", price_on: false, anomaly_on: false, skipped: [] });
    expect(anomalied(s)).toEqual([]);

    // 一次把两个都打开;重复打开不会建出第二行
    out = (await call(s, "pool.set_watch", { symbol: "NVDA", price: true, anomaly: true }))["result"];
    expect(out).toEqual({ symbol: "NVDA", price_on: true, anomaly_on: true, skipped: [] });
    await call(s, "pool.set_watch", { symbol: "NVDA", price: true, anomaly: true });
    expect(s.engine.store.listWatches()).toHaveLength(1);
    expect(s.engine.store.listQualityStocks()).toHaveLength(1);
    expect(s.engine.store.listWatches()[0]!["id"]).not.toBe(watchId); // 关掉那次是真删了行
  });

  it("代码不合法、两个开关一个都没传:-32602", async () => {
    const { s } = makeServer();
    expect((await call(s, "pool.set_watch", { symbol: "1ABC", price: true }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "pool.set_watch", { symbol: "", price: true }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "pool.set_watch", { symbol: "NVDA" }))["error"]).toMatchObject({
      code: -32602, message: "price / anomaly 至少要传一个",
    });
    expect(s.engine.store.listWatches()).toEqual([]);
  });

  it("指数(SPX)可以盯价位,但盯不了异动:量能流按正股订一定订不上", async () => {
    const { s } = makeServer();
    const out = (await call(s, "pool.set_watch", { symbol: "SPX", price: true, anomaly: true }))["result"];
    expect(out).toMatchObject({ symbol: "SPX", price_on: true, anomaly_on: false });
    expect(out["skipped"]).toEqual(["SPX 是指数,异动监控只支持个股 / ETF"]);
    expect(watched(s)).toEqual(["SPX"]);
    expect(anomalied(s)).toEqual([]);
    // quality.add 拒的是同一件事,措辞一致
    expect((await call(s, "quality.add", { symbol: "SPX" }))["error"]["message"]).toMatch(/是指数/);
  });

  it("上限 30 只:超了如实进 skipped(不静默丢);另一个开关有位子就照常开", async () => {
    const { s } = makeServer();
    await sectorWith(s, "满仓", Array.from({ length: 30 }, (_, i) => capSymbol(i)));
    expect(s.engine.store.listWatches()).toHaveLength(30);
    expect(s.engine.store.listQualityStocks()).toHaveLength(30);

    // 两个都满:一个都开不了,两条原因都说出来
    let out = (await call(s, "pool.set_watch", { symbol: "ZZZA", price: true, anomaly: true }))["result"];
    expect(out).toMatchObject({ symbol: "ZZZA", price_on: false, anomaly_on: false });
    expect(out["skipped"]).toEqual([
      "价位已达 30 只上限,ZZZA 没打开",
      "异动已达 30 只上限,ZZZA 没打开",
    ]);
    expect(s.engine.store.listWatches()).toHaveLength(30);

    // 腾出一个异动位子:异动开得上,价位仍然满——只报没开上的那个
    await call(s, "pool.set_watch", { symbol: capSymbol(0), anomaly: false });
    out = (await call(s, "pool.set_watch", { symbol: "ZZZA", price: true, anomaly: true }))["result"];
    expect(out).toMatchObject({ symbol: "ZZZA", price_on: false, anomaly_on: true });
    expect(out["skipped"]).toEqual(["价位已达 30 只上限,ZZZA 没打开"]);
    expect(s.engine.store.listQualityStocks()).toHaveLength(30);
    expect(PoolService.MAX_WATCH).toBe(30);
  });

  it("开关的每一次变化都写审计:pool_watch_on / pool_watch_off", async () => {
    const { s } = makeServer();
    await sectorWith(s, "科技", ["NVDA"]);
    await call(s, "pool.set_watch", { symbol: "NVDA", price: false });
    await call(s, "pool.set_watch", { symbol: "NVDA", price: false }); // 幂等的那次不留痕
    await call(s, "pool.set_watch", { symbol: "NVDA", price: true });

    expect(poolAudit(s, "pool_watch_on")).toEqual([
      { symbol: "NVDA", which: "price" },
      { symbol: "NVDA", which: "anomaly" },
      { symbol: "NVDA", which: "price" },
    ]);
    expect(poolAudit(s, "pool_watch_off")).toEqual([{ symbol: "NVDA", which: "price" }]);
  });
});

// ---------------------------------------------------------------- 进池子的默认
describe("进池子的默认:两个开关都开", () => {
  it("sectors.add_stock:加完就按默认开两个开关,回执里带 watch", async () => {
    const { s } = makeServer();
    const sector = (await call(s, "sectors.add", { name: "科技" }))["result"]["sector"];
    const out = (await call(s, "sectors.add_stock", { id: sector["id"], symbol: " nvda ", company: "英伟达" }))["result"];
    expect(out["watch"]).toEqual({ symbol: "NVDA", price_on: true, anomaly_on: true, skipped: [] });
    expect((out["sector"]["stocks"] as Rec[]).map((x) => x["symbol"])).toEqual(["NVDA"]);
    expect(watched(s)).toEqual(["NVDA"]);
    expect(anomalied(s)).toEqual(["NVDA"]);
  });

  it("sectors.pick(AI 选股):新出现的成分股逐只套默认;吃满上限的如实进 skipped", async () => {
    const { s } = makeServer();
    // 先把 30 只上限占满(另一个板块),再让 AI 选一批新的:两个上限都满了
    await sectorWith(s, "满仓", Array.from({ length: 30 }, (_, i) => capSymbol(i)));
    const sector = (await call(s, "sectors.add", { name: "AI 算力" }))["result"]["sector"];
    const picks = ["AAA", "BBB", "CCC"].map((symbol) => ({ symbol, company: symbol, reason: "龙头", tag: "芯片" }));
    s.parserFactory = () => ({ completeJson: async () => ({ stocks: picks }) }) as any;

    const out = (await call(s, "sectors.pick", { id: sector["id"] }))["result"];
    expect((out["sector"]["stocks"] as Rec[]).map((x) => x["symbol"])).toEqual(["AAA", "BBB", "CCC"]);
    // 池子里 33 只,开关还是各 30 只:6 条"没给你开"的原因一条不少
    expect(s.engine.store.symbolsInSectors().size).toBe(33);
    expect(out["skipped"]).toEqual([
      "价位已达 30 只上限,AAA 没打开", "异动已达 30 只上限,AAA 没打开",
      "价位已达 30 只上限,BBB 没打开", "异动已达 30 只上限,BBB 没打开",
      "价位已达 30 只上限,CCC 没打开", "异动已达 30 只上限,CCC 没打开",
    ]);
    expect(s.engine.store.listWatches()).toHaveLength(30);
    expect(s.engine.store.listQualityStocks()).toHaveLength(30);

    // 有位子的时候就该真开上:腾出两个位子再选一次
    await call(s, "pool.set_watch", { symbol: capSymbol(0), price: false, anomaly: false });
    s.parserFactory = () => ({
      completeJson: async () => ({ stocks: [...picks, { symbol: "DDD", company: "D", reason: "新", tag: "芯片" }] }),
    }) as any;
    const again = (await call(s, "sectors.pick", { id: sector["id"] }))["result"];
    // AAA/BBB/CCC 上一轮就在池子里了,这一轮只给新出现的 DDD 套默认
    expect(again["skipped"]).toEqual([]);
    expect(watched(s)).toContain("DDD");
    expect(anomalied(s)).toContain("DDD");
  });
});

// ---------------------------------------------------------------- 出池子的连带清理
describe("出了池子:两张表的行跟着收掉", () => {
  it("sectors.remove_stock:不在任何板块了才清;还在别的板块里的一行不动", async () => {
    const { s } = makeServer();
    const tech = await sectorWith(s, "科技", ["NVDA", "AMD"]);
    await sectorWith(s, "半导体", ["AMD"]); // AMD 同时在两个板块里

    // NVDA 只在科技里:移出去就该连两张表一起清
    let out = (await call(s, "sectors.remove_stock", { id: tech, symbol: "NVDA" }))["result"];
    expect(out["dropped"]).toEqual(["NVDA"]);
    expect(watched(s)).toEqual(["AMD"]);
    expect(anomalied(s)).toEqual(["AMD"]);

    // AMD 还在半导体里:开关照旧
    out = (await call(s, "sectors.remove_stock", { id: tech, symbol: "AMD" }))["result"];
    expect(out["dropped"]).toEqual([]);
    expect(watched(s)).toEqual(["AMD"]);
    expect(anomalied(s)).toEqual(["AMD"]);
  });

  it("sectors.delete:板块没了,只收掉不在别的板块里的那几只", async () => {
    const { s } = makeServer();
    const tech = await sectorWith(s, "科技", ["NVDA", "AMD"]);
    await sectorWith(s, "半导体", ["AMD"]);

    const out = (await call(s, "sectors.delete", { id: tech }))["result"];
    expect(out).toMatchObject({ deleted: tech, dropped: ["NVDA"] });
    expect(watched(s)).toEqual(["AMD"]);
    expect(anomalied(s)).toEqual(["AMD"]);
    // 连带清理也是走同一段开关逻辑:留痕
    expect(poolAudit(s, "pool_watch_off")).toEqual([
      { symbol: "NVDA", which: "price" }, { symbol: "NVDA", which: "anomaly" },
    ]);
  });

});

// 升级后还没迁移过的旧库,界面一进来就直接改池子(没先读任何一页)。
// 迁移必须排在改池子之前跑完:否则刚被移出去的那只股在迁移眼里正好是"有开关却不在任何板块"
// 的孤儿,会被并回「自选」——用户看到的是"删掉的股跑到自选板块里去了,开关还开着"。
describe("旧库第一条请求就是改池子:迁移要排在前面", () => {
  /** 造一个"还没迁移过"的旧库:板块成分股一份、alert_watches / quality_stocks 各记一份。 */
  function oldStyle(symbols: string[]): { s: RpcServer; sectorId: string } {
    const { s } = makeServer();
    const store = s.engine.store;
    const sector = store.addSector("科技");
    store.setSectorStocks(String(sector["id"]), symbols.map((symbol) => ({ symbol, company: "", reason: "", tag: "" })));
    for (const symbol of symbols) {
      store.addWatch(symbol, 5);
      store.addQualityStock(symbol);
    }
    expect(store.getPref(PoolService.POOL_MIGRATED_PREF)).toBeNull();
    return { s, sectorId: String(sector["id"]) };
  }

  it("sectors.remove_stock:移出去的那只不许被迁移当成孤儿并回「自选」", async () => {
    const { s, sectorId } = oldStyle(["NVDA", "AMD"]);
    const out = (await call(s, "sectors.remove_stock", { id: sectorId, symbol: "NVDA" }))["result"];
    expect(out["dropped"]).toEqual(["NVDA"]);
    expect([...s.engine.store.symbolsInSectors()]).toEqual(["AMD"]);
    expect(watched(s)).toEqual(["AMD"]);
    expect(anomalied(s)).toEqual(["AMD"]);
  });

  it("sectors.delete:板块没了,成分股不许被迁移并回「自选」", async () => {
    const { s, sectorId } = oldStyle(["NVDA"]);
    const out = (await call(s, "sectors.delete", { id: sectorId }))["result"];
    expect(out["dropped"]).toEqual(["NVDA"]);
    expect(watched(s)).toEqual([]);
    expect(anomalied(s)).toEqual([]);
    expect((await call(s, "sectors.list"))["result"]["sectors"]).toEqual([]);
  });

  it("sectors.pick:重选换下去的老成分股不许被迁移并回「自选」", async () => {
    const { s, sectorId } = oldStyle(["NVDA"]);
    s.parserFactory = () => ({
      completeJson: async () => ({ stocks: [{ symbol: "AVGO", company: "博通", reason: "光模块", tag: "芯片" }] }),
    }) as any;
    const out = (await call(s, "sectors.pick", { id: sectorId }))["result"];
    expect(out["dropped"]).toEqual(["NVDA"]);
    expect([...s.engine.store.symbolsInSectors()]).toEqual(["AVGO"]);
    expect(watched(s)).toEqual(["AVGO"]);
    expect(anomalied(s)).toEqual(["AVGO"]);
  });
});

// ---------------------------------------------------------------- 一次性迁移
describe("一次性迁移:三张表各记一份的旧库并成一个池子", () => {
  it("孤儿的盯价位 / 盯异动并进「自选」;池子里的每只股按默认补齐两个开关", async () => {
    const { s } = makeServer();
    const store = s.engine.store;
    store.addWatch("AAPL", 5); // 旧库:只有盯价位,不在任何板块里
    store.addQualityStock("MSFT"); // 旧库:只有盯异动,不在任何板块里
    const sector = store.addSector("科技");
    store.setSectorStocks(String(sector["id"]), [{ symbol: "NVDA", company: "", reason: "", tag: "" }]);

    const sectors = (await call(s, "sectors.list"))["result"]["sectors"] as Rec[];
    const mine = sectors.find((x) => x["name"] === "自选")!;
    expect((mine["stocks"] as Rec[]).map((x) => x["symbol"]).sort()).toEqual(["AAPL", "MSFT"]);
    expect((mine["stocks"] as Rec[])[0]!["reason"]).toBe("迁移并入");
    // 三只都在池子里了 → 两个开关都补齐
    expect(watched(s)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(anomalied(s)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(poolAudit(s, "pool_migrate_v1")).toHaveLength(1);
    expect(store.getPref(PoolService.POOL_MIGRATED_PREF)).not.toBeNull();
  });

  it("只跑一次:用户手动关掉的开关,重启(新 RpcServer 开同一个库)之后仍然是关的", async () => {
    const { s, dir } = makeServer();
    const store = s.engine.store;
    const sector = store.addSector("科技");
    store.setSectorStocks(String(sector["id"]), [
      { symbol: "NVDA", company: "", reason: "", tag: "" },
      { symbol: "AMD", company: "", reason: "", tag: "" },
    ]);
    await call(s, "quality.list"); // 第一次读:跑迁移
    expect(anomalied(s)).toEqual(["AMD", "NVDA"]);

    // 用户把 NVDA 的异动关掉(价位留着)
    await call(s, "pool.set_watch", { symbol: "NVDA", anomaly: false });
    expect(anomalied(s)).toEqual(["AMD"]);
    // 同一个进程里再读几次:迁移不重跑,关掉的仍然是关的
    await call(s, "sectors.list");
    await call(s, "alerts.list");
    expect(anomalied(s)).toEqual(["AMD"]);

    // 重启:新引擎开同一个库
    const second = makeServer(dir);
    const listed = (await call(second.s, "quality.list"))["result"]["stocks"] as Rec[];
    expect(listed.map((r) => String(r["symbol"]))).toEqual(["AMD"]);
    expect(watched(second.s)).toEqual(["AMD", "NVDA"]);
    expect(poolAudit(second.s, "pool_migrate_v1")).toHaveLength(1); // 还是第一次那一条
  });
});

// ---------------------------------------------------------------- 价位自动算
describe("价位自动算:盯上了就该有价位", () => {
  it("一轮最多挑 1 只去算;都算完了就不再算", async () => {
    const { s } = makeServer();
    const router = new FakeLevelsRouter();
    (s as any).router = router;
    await sectorWith(s, "科技", ["NVDA", "AMD"]);

    const first = await s.anomaly.tickOnce(ET_1100);
    const second = await s.anomaly.tickOnce(ET_1100 + 5000);
    expect([String(first["levels"]), String(second["levels"])].sort()).toEqual(["AMD", "NVDA"]);
    expect(router.chainCalls).toHaveLength(2); // 一轮一只,没有一轮连算两只
    const third = await s.anomaly.tickOnce(ET_1100 + 10_000);
    expect(third["levels"]).toBeNull();
    expect(router.chainCalls).toHaveLength(2);
    for (const watch of s.engine.store.listWatches()) {
      expect((watch["levels"] as Rec[]).length, String(watch["symbol"])).toBeGreaterThan(0);
    }
  });

  it("隔夜变旧的价位(上一个交易日算的)第二天开盘后重算:均线、52 周位会隔夜变", async () => {
    const { s } = makeServer();
    const router = new FakeLevelsRouter();
    (s as any).router = router;
    await sectorWith(s, "科技", ["NVDA"]);
    await s.anomaly.tickOnce(ET_1100);
    expect(router.chainCalls).toEqual(["NVDA"]);
    const id = s.engine.store.listWatches()[0]!["id"];

    // 把这一行改成"上一个交易日收盘时算的"(updateWatch 自己会盖 updated_at,只能直接改库)
    s.engine.store.rawExec("UPDATE alert_watches SET updated_at=? WHERE id=?", ["2026-09-10T20:00:00+00:00", id]);
    const next = await s.anomaly.tickOnce(ET_1100 + AlertsService.LEVELS_BACKOFF_MS + 1000);
    expect(next["levels"]).toBe("NVDA");
    expect(router.chainCalls).toEqual(["NVDA", "NVDA"]);
    // 重算完就是今天的了,再往后几轮不再打期权链
    expect((await s.anomaly.tickOnce(ET_1100 + 2 * AlertsService.LEVELS_BACKOFF_MS + 2000))["levels"]).toBeNull();
    expect(router.chainCalls).toHaveLength(2);
  });

  it("没连券商 / 不在时段内:一只也不算(期权链太贵,不整夜打)", async () => {
    const { s } = makeServer();
    await sectorWith(s, "科技", ["NVDA"]);

    // 没连券商
    expect((await s.anomaly.tickOnce(ET_1100))["levels"]).toBeNull();

    const router = new FakeLevelsRouter();
    (s as any).router = router;
    // 连上了,但是收盘一小时之后
    expect((await s.anomaly.tickOnce(ET_POST))["levels"]).toBeNull();
    expect(router.chainCalls).toEqual([]);
    // 盘中就算
    expect((await s.anomaly.tickOnce(ET_1100))["levels"]).toBe("NVDA");
    expect(router.chainCalls).toEqual(["NVDA"]);
  });

  it("算失败:按 symbol 退避 10 分钟再试,不每 5 秒去打一次期权链", async () => {
    const { s } = makeServer();
    const router = new FakeLevelsRouter();
    router.failChain.add("NVDA");
    (s as any).router = router;
    await sectorWith(s, "科技", ["NVDA"]);

    expect((await s.anomaly.tickOnce(ET_1100))["levels"]).toBe("NVDA");
    expect(router.chainCalls).toEqual(["NVDA"]);
    // 退避期内一轮都不再打
    for (const dt of [5_000, 60_000, AlertsService.LEVELS_BACKOFF_MS - 1000]) {
      expect((await s.anomaly.tickOnce(ET_1100 + dt))["levels"], String(dt)).toBeNull();
    }
    expect(router.chainCalls).toEqual(["NVDA"]);
    // 退避过了再试一次
    router.failChain.clear();
    expect((await s.anomaly.tickOnce(ET_1100 + AlertsService.LEVELS_BACKOFF_MS + 1000))["levels"]).toBe("NVDA");
    expect(router.chainCalls).toEqual(["NVDA", "NVDA"]);
  });

  it("quality.list 的 levels_status:算之前 pending、算完 ok、失败是 error:<原因>;没盯价位回 null", async () => {
    const { s } = makeServer();
    const router = new FakeLevelsRouter();
    router.failChain.add("NVDA");
    (s as any).router = router;
    await sectorWith(s, "科技", ["NVDA"]);
    setClock(ET_1100);

    const statusOf = async (): Promise<string | null> =>
      ((await call(s, "quality.list"))["result"]["stocks"] as Rec[])[0]!["levels_status"];

    expect(await statusOf()).toBe("pending"); // 还没算:界面显示「正在算价位…」
    await s.anomaly.tickOnce(ET_1100);
    expect(await statusOf()).toMatch(/^error:.*期权链取不到/);

    router.failChain.clear();
    await s.anomaly.tickOnce(ET_1100 + AlertsService.LEVELS_BACKOFF_MS + 1000);
    expect(await statusOf()).toBe("ok");

    // 把「盯价位」关掉:这只股没有价位这一说
    await call(s, "pool.set_watch", { symbol: "NVDA", price: false });
    expect(await statusOf()).toBeNull();
  });
});
