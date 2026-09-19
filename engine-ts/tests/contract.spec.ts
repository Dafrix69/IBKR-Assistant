/** 引擎 ↔ 界面的契约(src/contract/)。
 *
 * 类型那一半由两边的 tsc 管(返回结构改一个字段名,引擎与界面一起编译不过),这里管 tsc 管不到的三件事:
 *  1. 迁移只许往前走:还没进契约的老方法钉成一张名单,**这张表只许变短**;新方法不在契约里、也不在名单里,就红。
 *  2. 界面够得着契约、也只够得着契约:bridge.ts 跨进引擎目录的 import 只许是 `import type`,只许进
 *     contract/ 顶层的类型文件;那些文件自己不 import 任何包——CI 里界面那一路不装引擎的依赖。
 *  3. 入参的结构错和领域错分开说:结构错(缺字段、类型不对)由 schema 报,领域错(代码形状、上限)由 handler 报。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { contractMethodNames } from "../src/contract/schema/index.js";
import { RpcServer } from "../src/rpc.js";

const ENGINE_SRC = path.resolve(__dirname, "..", "src");
const BRIDGE = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src", "bridge.ts");

/** 还没迁进契约的老方法(入参与返回仍是松散的 Rec)。迁一个,从这里划掉一个;**不许往里加**。 */
const LEGACY_METHODS = [
  "backtest.parse_rules", "backtest.run", "backtest.strategies",
  "book.snapshot",
  "breaker.halt", "breaker.resume", "breaker.state",
  "broker.catalog", "broker.connect", "broker.disconnect", "broker.select",
  "data.export",
  "futu.diagnose", "futu.launch", "futu.scan", "futu.set_password", "futu.unlock",
  "ideas.add", "ideas.analyze", "ideas.digest", "ideas.digests", "ideas.list", "ideas.update",
  "instruction.submit",
  "keychain.set",
  "llm.catalog", "llm.patch", "llm.test",
  "macro.board",
  "pa.analyze", "pa.comment", "pa.timeframes",
  "pending.list", "pending.poll",
  "positions.list",
  "records.get", "records.list",
  "review.analyze", "review.candidates",
  "screener.deviation", "screener.inflection", "screener.rs",
  "settings.get", "settings.patch",
  "system.selftest", "system.status",
  "tracker.add", "tracker.close_now", "tracker.delete", "tracker.list", "tracker.poll", "tracker.reconcile",
  "tracker.target_preview", "tracker.update",
  "tws.diagnose", "tws.launch", "tws.scan",
];

const dirs: string[] = [];
function makeServer(): RpcServer {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-contract-"));
  dirs.push(dir);
  const base = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  return new RpcServer(settingsPath, () => {});
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("契约:迁移只许往前走", () => {
  const names = makeServer().methodNames();
  const contract: string[] = contractMethodNames();

  it("引擎的每个方法,要么在契约里,要么在老方法名单里——新方法只能从契约加", () => {
    expect(names.filter((m) => !contract.includes(m) && !LEGACY_METHODS.includes(m))).toEqual([]);
  });

  it("契约里登记的方法引擎都实现了(配了 schema 却没人接,是漏接了一张表)", () => {
    expect(contract.filter((m) => !names.includes(m))).toEqual([]);
  });

  it("名单里没有已经迁走的、也没有已经删掉的:迁一个划一个", () => {
    expect(LEGACY_METHODS.filter((m) => contract.includes(m)), "迁进契约了,从名单里划掉").toEqual([]);
    expect(LEGACY_METHODS.filter((m) => !names.includes(m)), "引擎里已经没有这个方法了").toEqual([]);
  });

  it("名单只许变短:现在是 57 个,改这个数的时候只能往小里改", () => {
    expect(LEGACY_METHODS.length).toBeLessThanOrEqual(57);
    expect(new Set(LEGACY_METHODS).size).toBe(LEGACY_METHODS.length);
  });
});

describe("契约:界面够得着,也只够得着类型文件", () => {
  const typeFiles = readdirSync(path.join(ENGINE_SRC, "contract")).filter((f) => f.endsWith(".ts"));
  const importsOf = (src: string): string[] =>
    [...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gms)].map((m) => m[1]!);

  it("contract/ 顶层的类型文件不 import 任何包,只互相引用", () => {
    expect(typeFiles.length).toBeGreaterThan(2);
    for (const file of typeFiles) {
      const src = readFileSync(path.join(ENGINE_SRC, "contract", file), "utf-8");
      const outside = importsOf(src).filter((spec) => !/^\.\/[a-zA-Z]+\.js$/.test(spec));
      expect(outside, `${file} 引了 contract/ 顶层之外的东西`).toEqual([]);
      expect(/^\s*import\s+(?!type\b)/m.test(src), `${file} 里有不带 type 的 import`).toBe(false);
    }
  });

  it("bridge.ts 跨进引擎目录的 import 只许是 import type,只许进 contract/ 顶层", () => {
    const src = readFileSync(BRIDGE, "utf-8");
    const crossing = [...src.matchAll(/^\s*(import(?:\s+type)?)\s[^;]*?\sfrom\s+['"]([^'"]*engine-ts[^'"]*)['"]/gms)];
    expect(crossing.length, "bridge.ts 没有从契约引类型?").toBeGreaterThan(0);
    for (const [, keyword, spec] of crossing) {
      expect(keyword, spec).toBe("import type");
      expect(spec, "只许进 contract/ 顶层的类型文件").toMatch(/engine-ts\/src\/contract\/[a-zA-Z]+$/);
    }
  });

  it("界面其它文件不直接碰引擎目录:要用契约类型,从 bridge.ts 拿", () => {
    const root = path.dirname(BRIDGE);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name) && p !== BRIDGE && /from\s+['"][^'"]*engine-ts/.test(readFileSync(p, "utf-8"))) {
          offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("契约:结构错由 schema 报,领域错由 handler 报", () => {
  const s = makeServer();
  afterAll(() => {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  });
  const errorOf = async (method: string, params: unknown): Promise<{ code: number; message: string }> =>
    (await s.handle({ jsonrpc: "2.0", id: 1, method, params }))["error"];

  it("缺字段 / 类型不对:-32602,说清是哪个方法的哪个字段", async () => {
    expect(await errorOf("quality.add", {})).toEqual({ code: -32602, message: "quality.add 的参数不对:缺少 symbol" });
    expect(await errorOf("quality.add", { symbol: 123 })).toEqual({
      code: -32602, message: "quality.add 的参数不对:symbol 应为 string,收到 number",
    });
    expect(await errorOf("quality.update", { id: "x", enabled: "yes" })).toEqual({
      code: -32602, message: "quality.update 的参数不对:enabled 应为 boolean,收到 string",
    });
    expect(await errorOf("quality.set_config", { config: [1] })).toEqual({
      code: -32602, message: "quality.set_config 的参数不对:config 应为 object,收到 array",
    });
    expect((await errorOf("pool.set_watch", "NVDA")).code).toBe(-32602);
  });

  it("结构对、领域不对:还是 handler 自己那句人话(这几句界面原样给用户看)", async () => {
    expect((await errorOf("quality.add", { symbol: "1ABC" })).message).toBe("标的代码不合法:'1ABC'");
    expect((await errorOf("pool.set_watch", { symbol: "NVDA" })).message).toBe("price / anomaly 至少要传一个");
    expect((await errorOf("quality.set_config", { config: { window_min: 7 } })).message).toMatch(/窗口只能是/);
  });

  it("可选字段带 null 和不带是一回事(JSON 里没有 undefined,老 handler 两种都认)", async () => {
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "pool.set_watch", params: { symbol: "NVDA", price: null } });
    expect(out["error"]).toEqual({ code: -32602, message: "price / anomaly 至少要传一个" });
  });

  it("alerts / sectors:结构错归 schema,领域错还是原话", async () => {
    expect(await errorOf("sectors.add", {})).toEqual({ code: -32602, message: "sectors.add 的参数不对:缺少 name" });
    expect(await errorOf("sectors.add_stock", { id: 7, symbol: "NVDA" })).toEqual({
      code: -32602, message: "sectors.add_stock 的参数不对:id 应为 string,收到 number",
    });
    expect(await errorOf("alerts.refresh", {})).toEqual({ code: -32602, message: "alerts.refresh 的参数不对:缺少 id" });
    // 领域错:handler / store 自己那句
    expect((await errorOf("sectors.add", { name: "" })).message).toBe("板块名称为空");
    expect((await errorOf("sectors.delete", { id: "nope" })).message).toBe("板块不存在:nope");
    expect((await errorOf("alerts.create", { symbol: "bad$" })).message).toBe("标的代码不合法:'bad$'");
    expect((await errorOf("alerts.create", { symbol: "SPY", step: 5000 })).message).toBe("整数关口步长必须在 0~1000 之间");
    expect((await errorOf("alerts.delete", { id: "nope" })).message).toBe("没有这个警告:nope");
    expect((await errorOf("alerts.refresh", { id: "nope" })).message).toBe("没有这个警告");
  });

  it("schema 不比老 handler 严:步长给数字串照收;改标签不带 tag = 清掉", async () => {
    const call = async (method: string, params: unknown): Promise<Record<string, any>> =>
      s.handle({ jsonrpc: "2.0", id: 1, method, params });
    const made = await call("alerts.create", { symbol: "iren", step: "2.5" });
    expect(made["error"]).toBeUndefined();
    expect(made["result"]["watch"]).toMatchObject({ symbol: "IREN", step: 2.5 });

    const sector = (await call("sectors.add", { name: "契约测试" }))["result"]["sector"];
    await call("sectors.add_stock", { id: sector["id"], symbol: "vrt", tag: " 电力 " });
    const cleared = await call("sectors.set_tag", { id: sector["id"], symbol: "VRT" });
    expect(cleared["error"]).toBeUndefined();
    expect(cleared["result"]["sector"]["stocks"]).toEqual([{ symbol: "VRT", company: "", reason: "手动添加", tag: "" }]);
  });

  it("不带参数的方法给什么都收;多余的键不看", async () => {
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "quality.list", params: { whatever: 1 } });
    expect(out["error"]).toBeUndefined();
    // 这个 describe 共用一个 server,上面的用例可能已经往池子里加过股,所以不断言列表是空的
    expect(out["result"]["max"]).toBe(30);
    expect(Array.isArray(out["result"]["stocks"])).toBe(true);
  });
});
