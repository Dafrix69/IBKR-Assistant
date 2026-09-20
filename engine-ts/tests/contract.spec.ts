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

import { PARAMS_SCHEMAS, contractMethodNames } from "../src/contract/schema/index.js";
import { RpcServer } from "../src/rpc.js";

const ENGINE_SRC = path.resolve(__dirname, "..", "src");
const BRIDGE = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src", "bridge.ts");

/** 还没迁进契约的老方法(入参与返回仍是松散的 Rec)。迁一个,从这里划掉一个;**不许往里加**。 */
const LEGACY_METHODS = [
  "breaker.halt", "breaker.resume", "breaker.state",
  "broker.catalog", "broker.connect", "broker.disconnect", "broker.select",
  "futu.diagnose", "futu.launch", "futu.scan", "futu.set_password", "futu.unlock",
  "instruction.submit",
  "pa.analyze", "pa.comment", "pa.timeframes",
  "pending.list", "pending.poll",
  "records.get", "records.list",
  "review.analyze", "review.candidates",
  "screener.deviation", "screener.inflection", "screener.rs",
  "system.selftest", "system.status",
  // tracker 域迁了一半:这三样的返回是 engine.ts 在下单路径里拼的,等它拆开再标类型
  "tracker.close_now", "tracker.poll", "tracker.reconcile",
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

  it("名单只许变短:现在是 33 个,改这个数的时候只能往小里改", () => {
    expect(LEGACY_METHODS.length).toBeLessThanOrEqual(33);
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

  it("ideas:结构错归 schema;唯独 ideas.update 不带 id 还是 handler 那句——golden-rpc 钉着它,换一句就是改基线", async () => {
    expect(await errorOf("ideas.add", {})).toEqual({ code: -32602, message: "ideas.add 的参数不对:缺少 text" });
    expect(await errorOf("ideas.add", { text: 123 })).toEqual({ code: -32602, message: "ideas.add 的参数不对:text 应为 string,收到 number" });
    expect(await errorOf("ideas.analyze", {})).toEqual({ code: -32602, message: "ideas.analyze 的参数不对:缺少 id" });
    expect(await errorOf("ideas.list", { limit: true })).toEqual({ code: -32602, message: "ideas.list 的参数不对:limit 应为 number 或 string,收到 boolean" });
    expect(await errorOf("ideas.update", { id: "x" })).toEqual({ code: -32602, message: "ideas.update 的参数不对:缺少 status" });
    // 例外只有"没给":给了却不是字符串,照样是结构错
    expect(await errorOf("ideas.update", { status: "done" })).toEqual({ code: -32602, message: "缺少想法 id" });
    expect(await errorOf("ideas.update", { id: null, status: "done" })).toEqual({ code: -32602, message: "缺少想法 id" });
    expect(await errorOf("ideas.update", { id: 7, status: "done" })).toEqual({ code: -32602, message: "ideas.update 的参数不对:id 应为 string,收到 number" });
    // 领域错:handler / store 自己那句
    expect((await errorOf("ideas.add", { text: "  " })).message).toBe("想法内容为空");
    expect((await errorOf("ideas.list", { status: "nope" })).message).toBe("未知想法状态:nope");
    expect((await errorOf("ideas.digest", { scope: "nope" })).message).toBe("未知总结范围:nope(可选:archived、done、all)");
  });

  it("backtest:结构错归 schema;基线里没带的那几项(start / end / strategy / text)不在 schema 拒,检查的先后次序不变", async () => {
    expect(await errorOf("backtest.run", {})).toEqual({ code: -32602, message: "backtest.run 的参数不对:缺少 symbol" });
    expect(await errorOf("backtest.run", { symbol: "AAPL", start: 20250101 })).toEqual({ code: -32602, message: "backtest.run 的参数不对:start 应为 string,收到 number" });
    expect(await errorOf("backtest.run", { symbol: "AAPL", start: "2025-01-01", end: "2026-01-01", strategy: "rsi", params: [14] }))
      .toEqual({ code: -32602, message: "backtest.run 的参数不对:params 应为 object,收到 array" });
    expect(await errorOf("backtest.parse_rules", { text: 5 })).toEqual({ code: -32602, message: "backtest.parse_rules 的参数不对:text 应为 string,收到 number" });
    // 领域错:代码先查、再查日期——只给一个坏代码时报的是代码,不是"缺少 start"(golden-rpc 钉着)
    expect((await errorOf("backtest.run", { symbol: "bad$" })).message).toBe("股票代码不合法:'bad$'");
    expect((await errorOf("backtest.run", { symbol: "AAPL" })).message).toBe("日期必须是 YYYY-MM-DD");
    expect((await errorOf("backtest.parse_rules", {})).message).toBe("策略描述为空");
    // rules / instrument 的形状由 models.ts 的 schema 说,不是这一层
    expect((await errorOf("backtest.run", { symbol: "AAPL", start: "2025-01-01", end: "2026-01-01", strategy: "custom", rules: "金叉" })).message).toMatch(/^自定义条件不合法:/);
    expect((await errorOf("backtest.run", { symbol: "AAPL", start: "2025-01-01", end: "2026-01-01", strategy: "rsi", instrument: [1] })).message).toMatch(/^交易品种配置不合法:/);
  });

  it("book.snapshot / macro.board:结构错归 schema;force 给什么都收(老 handler 是 Boolean(x))", async () => {
    expect(await errorOf("book.snapshot", {})).toEqual({ code: -32602, message: "book.snapshot 的参数不对:缺少 symbol" });
    expect(await errorOf("book.snapshot", { symbol: 7 })).toEqual({ code: -32602, message: "book.snapshot 的参数不对:symbol 应为 string,收到 number" });
    // 领域错:代码形状还是 handler 那句(golden-rpc 钉着)
    expect((await errorOf("book.snapshot", { symbol: "bad$" })).message).toBe("股票代码不合法:'bad$'");
    // macro.board 不挑参数:给什么都不该把行情带挡在外面(直接看 schema——真跑一次会去打公开数据源,测试不出网)
    expect(PARAMS_SCHEMAS["macro.board"].safeParse({ force: "yes", 多余的键: 1 })).toMatchObject({ success: true, data: { force: true } });
    expect(PARAMS_SCHEMAS["macro.board"].safeParse({})).toMatchObject({ success: true, data: {} });
  });

  it("llm.patch 顶层是 strict 的(会动配置);里面哪几项能改还是 handler 的白名单说;报错不回显密钥", async () => {
    expect((await errorOf("llm.patch", { llm: {}, extra: 1 })).message).toBe("llm.patch 的参数不对:有不认识的键:extra(这个方法不收没登记的键,没有照单全收)");
    expect((await errorOf("llm.patch", { llm: {}, __confirmed: true })).message).toMatch(/有不认识的键:__confirmed/);
    expect(await errorOf("llm.patch", { llm: [1] })).toEqual({ code: -32602, message: "llm.patch 的参数不对:llm 应为 object,收到 array" });
    expect((await errorOf("llm.patch", { llm: { bogus: 1 } })).message).toBe("不允许修改的字段:bogus"); // golden-rpc 钉着
    // api_key 类型不对:说的是"哪个字段、要什么、收到什么类型",值本身不出现在报错里
    const leaked = await errorOf("llm.test", { api_key: ["sk-should-not-appear"] });
    expect(leaked).toEqual({ code: -32602, message: "llm.test 的参数不对:api_key 应为 string,收到 array" });
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

  it("tracker.*(授权自动发单的域)是 strict 的:不认识的键当场拒,不静默丢掉", async () => {
    // 键名写错一个字母:别的域会把它丢掉、照常往下走;这里不行——追踪照建、止损却没设上,比报错危险得多
    expect(await errorOf("tracker.add", { key: "k", stoploss: "95" })).toEqual({
      code: -32602, message: "tracker.add 的参数不对:有不认识的键:stoploss(这个方法不收没登记的键,没有照单全收)",
    });
    expect((await errorOf("tracker.update", { id: "x", auto_close: { enabled: true, hostAtBroker: true } })).message)
      .toBe("tracker.update 的参数不对:auto_close 里有不认识的键:hostAtBroker(这个方法不收没登记的键,没有照单全收)");
    expect((await errorOf("tracker.target_preview", { key: "k", spot_target: "130", extra: 1 })).message).toMatch(/有不认识的键:extra/);
    // 授权发单的开关只收布尔:Boolean("false") 是 true,老 handler 会把它当成"打开"
    expect(await errorOf("tracker.add", { key: "k", stop_loss: "95", auto_close: "false" })).toEqual({
      code: -32602, message: "tracker.add 的参数不对:auto_close 应为 boolean,收到 string",
    });
    // "数字或字符串"这种字段不对的时候,说清楚要什么、给了什么;数组里某一档缺了东西,指到那一档
    expect((await errorOf("tracker.add", { key: "k", stop_loss: true })).message).toBe("tracker.add 的参数不对:stop_loss 应为 number 或 string,收到 boolean");
    expect((await errorOf("tracker.add", { key: "k", profit_drawdown_tiers: "坏的" })).message).toBe("tracker.add 的参数不对:profit_drawdown_tiers 应为 array,收到 string");
    expect((await errorOf("tracker.add", { key: "k", profit_drawdown_tiers: [{ above: 0 }] })).message).toBe("tracker.add 的参数不对:缺少 profit_drawdown_tiers.0.pct");
    // 界面确认标记由桌面端主进程在转给引擎之前摘掉(main.js 的 delete clean.__confirmed,desktop-whitelist.spec 钉着);
    // 真漏过来了,这里是拒,不是悄悄收下
    expect((await errorOf("tracker.add", { key: "k", stop_loss: "95", __confirmed: true })).message).toMatch(/有不认识的键:__confirmed/);
  });

  it("settings.patch:界面「设置」页的原样载荷(三段,布尔与数字)——改完的就是回执里的,也是写进配置文件的", async () => {
    const fresh = makeServer();
    const file = (): Record<string, any> => JSON.parse(readFileSync(String(fresh.settings.source_path), "utf-8"));
    const out = await fresh.handle({ jsonrpc: "2.0", id: 1, method: "settings.patch", params: { patch: {
      policies: { auto_execute: true, allow_live_trading: false, require_trigger_price_verification: true },
      limits: { max_order_notional: 20000, max_option_contracts: 5, max_mkt_shares: 100, max_spread_slippage: 0.5, duplicate_window_minutes: 3 },
      protections: {
        stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: 3, pause_minutes: 30 },
        max_drawdown: { enabled: false, lookback_minutes: 120, max_drawdown_usd: 500, pause_minutes: 60 },
        cooldown: { enabled: true, minutes: 10 },
      },
    } } });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["policies"]).toMatchObject({ auto_execute: true, allow_live_trading: false, require_trigger_price_verification: true });
    expect(out["result"]["limits"]).toMatchObject({ max_order_notional: 20000, max_option_contracts: 5, max_mkt_shares: 100, max_spread_slippage: 0.5, duplicate_window_minutes: 3 });
    expect(out["result"]["protections"]).toEqual({
      stoploss_guard: { enabled: true, lookback_minutes: 60, trigger_count: 3, pause_minutes: 30 },
      max_drawdown: { enabled: false, lookback_minutes: 120, max_drawdown_usd: 500, pause_minutes: 60 },
      cooldown: { enabled: true, minutes: 10 },
    });
    // 引擎这头立刻生效(不是只改了文件),文件里也是这份
    expect(fresh.settings.policies.auto_execute).toBe(true);
    expect(file()["policies"]["auto_execute"]).toBe(true);
    expect((await fresh.handle({ jsonrpc: "2.0", id: 2, method: "settings.get", params: {} }))["result"]).toEqual(out["result"]);
    fresh.anomaly.stop();
    fresh.engineBuilt?.stopTrackerLoop();
  });

  it("settings.patch:段里的键名写错、类型不对——config 自己那句原话,而且一个字都不写盘", async () => {
    const fresh = makeServer();
    const before = readFileSync(String(fresh.settings.source_path), "utf-8");
    const err = async (patch: unknown): Promise<{ code: number; message: string }> =>
      (await fresh.handle({ jsonrpc: "2.0", id: 1, method: "settings.patch", params: { patch } }))["error"];
    // "我关了自动执行"悄悄没生效,是这个方法最不能出的事:键名写错必须当场报
    expect(await err({ policies: { auto_excute: false } })).toEqual({ code: -32007, message: "配置校验失败,已回滚:policies 里有未知配置项:auto_excute" });
    expect(await err({ protections: { cooldown: { enabld: false } } })).toEqual({ code: -32007, message: "配置校验失败,已回滚:protections.cooldown 里有未知配置项:enabld" });
    expect(await err({ policies: { auto_execute: "false" } })).toEqual({ code: -32007, message: "配置校验失败,已回滚:policies.auto_execute 必须是 true/false,收到 'false'" });
    expect((await err({ limits: { max_order_notional: -1 } })).message).toMatch(/^配置校验失败,已回滚:limits.max_order_notional 不能小于/);
    expect(await err({ accounts: [] })).toEqual({ code: -32006, message: "账户与连接配置不允许从界面修改:accounts" });
    // 顶层只认三段。2026-09-20 之前:不认识的段会成功并被原样写进配置文件;llm 段则绕过了 llm.patch 的字段白名单
    expect(await err({ foo: { a: 1 } })).toEqual({
      code: -32602,
      message: "settings.patch 只能改 policies / limits / protections,收到:foo(模型配置走 llm.patch,券商切换走 broker.select,其余只能手改配置文件)",
    });
    expect((await err({ llm: { keychain_service: "别人的" }, limits: { max_mkt_shares: 1 } })).message).toContain("收到:llm(");
    expect((await err({ storage: { db_path: "C:/elsewhere.db" } })).message).toContain("收到:storage(");
    expect(readFileSync(String(fresh.settings.source_path), "utf-8")).toBe(before);
    expect(fresh.settings.policies.auto_execute).toBe(false);
    fresh.anomaly.stop();
    fresh.engineBuilt?.stopTrackerLoop();
  });

  it("settings.patch / keychain.set 顶层是 strict 的(会动配置与密钥);结构错在碰到凭证库之前就拒了", async () => {
    expect((await errorOf("settings.patch", { patch: {}, extra: 1 })).message).toBe("settings.patch 的参数不对:有不认识的键:extra(这个方法不收没登记的键,没有照单全收)");
    expect((await errorOf("settings.patch", { patch: [1] })).message).toBe("settings.patch 的参数不对:patch 应为 object,收到 array");
    expect((await errorOf("settings.patch", { patch: {}, __confirmed: true })).message).toMatch(/有不认识的键:__confirmed/);
    expect(await errorOf("keychain.set", {})).toEqual({ code: -32602, message: "keychain.set 的参数不对:缺少 secret" });
    expect((await errorOf("keychain.set", { secret: "x", providr: "anthropic" })).message).toMatch(/有不认识的键:providr/);
    expect(await errorOf("data.export", {})).toEqual({ code: -32602, message: "data.export 的参数不对:缺少 path" });
  });

  it("不带参数的方法给什么都收;多余的键不看", async () => {
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "quality.list", params: { whatever: 1 } });
    expect(out["error"]).toBeUndefined();
    // 这个 describe 共用一个 server,上面的用例可能已经往池子里加过股,所以不断言列表是空的
    expect(out["result"]["max"]).toBe(30);
    expect(Array.isArray(out["result"]["stocks"])).toBe(true);
  });
});
