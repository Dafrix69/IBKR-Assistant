/** backtest.* 在 RPC 这一层的特征测试:输入是界面(Backtest.tsx 的 run())真实拼出来的载荷形状。
 *
 * 回测的数值由 golden-backtest 钉着(直接调 runBacktest);golden-rpc 钉了这个域的入参报错,但 backtest.run 跑成功的那条路
 * 要连券商取日线,基线里走不到——回执的完整形状(界面结果卡、交易表、净值曲线读的每一个键)、instrument / rules 被
 * models.ts 的 schema 补齐默认值之后的样子、几种失败各报哪个码,都只有这里钉。先于契约迁移写成,迁的时候不改断言。
 * 全部离线:券商与模型都是假的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerError } from "../src/broker.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 日线(默认 300 根):缓慢上行叠一个正弦,均线会来回交叉,RSI 会进出超卖。 */
function dailyBars(count = 300): Rec[] {
  const out: Rec[] = [];
  let t = Date.parse("2025-01-02T00:00:00Z");
  for (; out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const n = out.length;
    const close = Math.round((100 + 12 * Math.sin(n / 9) + n * 0.05) * 100) / 100;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: close - 0.3, high: close + 1.2, low: close - 1.1, close, volume: 1000 });
  }
  return out;
}

class FakeRouter {
  asked: Array<[string, string, string]> = [];
  fail: Error | null = null;
  bars: Rec[] = dailyBars();
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async historicalBars(symbol: string, start: string, end: string): Promise<Rec[]> {
    this.asked.push([symbol, start, end]);
    if (this.fail !== null) throw this.fail;
    return this.bars;
  }
}

class FakeParser {
  calls: Array<{ system: string; user: string; schema: Rec }> = [];
  reply: Rec | Error = { entry: [{ left: { kind: "indicator", name: "macd_hist" }, op: "cross_up", right: { kind: "const", value: 0 } }] };
  async completeJson(system: string, user: string, schema: Rec): Promise<Rec> {
    this.calls.push({ system, user, schema });
    if (this.reply instanceof Error) throw this.reply;
    return structuredClone(this.reply);
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; parser: FakeParser; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-bt-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  const parser = new FakeParser();
  if (opts.connected ?? true) s.router = router as never;
  s.parserFactory = () => parser;
  servers.push(s);
  // 过一遍 JSON:和真的 stdio 一样,undefined 的键在路上就没了
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, parser, call };
}

afterEach(() => {
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

/** Backtest.tsx 的 run() 拼出来的载荷:正股、预置策略、参数是数字。 */
const ui = (over: Rec = {}): Rec => ({
  symbol: "AAPL", start: "2025-01-01", end: "2026-03-01", strategy: "sma_cross", params: { fast: 5, slow: 20 },
  instrument: { type: "stock" }, ...over,
});

const REPORT_KEYS = [
  "annualized_pct", "bars", "buy_hold_return_pct", "closed_trades", "curve", "end", "exposure_pct", "instrument", "max_drawdown_pct",
  "params", "start", "strategy", "symbol", "total_return_pct", "trade_list", "trades", "win_rate_pct",
];

describe("backtest.strategies", () => {
  it("五个策略,界面表单照它摆:默认参数与每个参数的中文名", async () => {
    const { call } = makeServer({ connected: false });
    const { strategies } = (await call("backtest.strategies"))["result"];
    expect(strategies.map((s: Rec) => s["key"])).toEqual(["buy_hold", "sma_cross", "rsi", "breakout", "custom"]);
    expect(strategies[1]).toEqual({
      key: "sma_cross", label: "均线交叉", desc: "快线上穿慢线持有,下穿空仓。", params: { fast: 10, slow: 50 },
      param_labels: { fast: "快线周期(日)", slow: "慢线周期(日)" },
    });
    for (const s of strategies) expect(Object.keys(s).sort()).toEqual(["desc", "key", "label", "param_labels", "params"]);
  });
});

describe("backtest.run:界面的载荷", () => {
  it("正股 + 预置策略:回执的完整形状;instrument 被补齐默认值;symbol 是规整过的", async () => {
    const { call, router } = makeServer();
    const r = (await call("backtest.run", ui({ symbol: " aapl " })))["result"];
    expect(router.asked).toEqual([["AAPL", "2025-01-01", "2026-03-01"]]);
    expect(Object.keys(r).sort()).toEqual(REPORT_KEYS);
    expect(r).toMatchObject({
      symbol: "AAPL", strategy: "sma_cross", params: { fast: 5, slow: 20 }, bars: 300,
      start: router.bars[0]!["date"], end: router.bars[299]!["date"],
      instrument: { type: "stock", dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 },
    });
    for (const k of ["total_return_pct", "buy_hold_return_pct", "annualized_pct", "max_drawdown_pct", "exposure_pct", "win_rate_pct"]) {
      expect(typeof r[k], k).toBe("number");
    }
    expect(r["trades"]).toBeGreaterThan(2);
    expect(r["trade_list"]).toHaveLength(r["trades"]);
    expect(r["closed_trades"]).toBe(r["trade_list"].filter((t: Rec) => t["closed"]).length);
    // 正股的一笔:没有 exit_reason;没平的那笔 exit_date 是 null
    expect(Object.keys(r["trade_list"][0]).sort()).toEqual(["closed", "entry_date", "entry_price", "exit_date", "exit_price", "return_pct"]);
    expect(r["trade_list"][0]).toMatchObject({ closed: true, entry_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), exit_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    // 曲线:首尾都在,净值从 1 起
    expect(r["curve"][0]).toEqual({ date: router.bars[0]!["date"], equity: 1, bench: 1 });
    expect(r["curve"][r["curve"].length - 1]["date"]).toBe(router.bars[299]!["date"]);
    expect(Object.keys(r["curve"][5]).sort()).toEqual(["bench", "date", "equity"]);
  });

  it("日线多于 300 根:净值曲线抽样(每 3 根取 1),首尾必在", async () => {
    const { call, router } = makeServer();
    router.bars = dailyBars(650);
    const r = (await call("backtest.run", ui()))["result"];
    expect(r["bars"]).toBe(650);
    expect(r["curve"]).toHaveLength(218); // 0, 3, …, 648 共 217 个,再补上最后一根
    expect(r["curve"][1]["date"]).toBe(router.bars[3]!["date"]);
    expect(r["curve"][217]["date"]).toBe(router.bars[649]!["date"]);
  });

  it("参数给数字串照收;没给的用默认值;多给一个不认识的参数 → 原话", async () => {
    const { call } = makeServer();
    expect((await call("backtest.run", ui({ params: { fast: "5" } })))["result"]["params"]).toEqual({ fast: 5, slow: 50 });
    expect((await call("backtest.run", ui({ params: undefined })))["result"]["params"]).toEqual({ fast: 10, slow: 50 });
    expect((await call("backtest.run", ui({ params: { fast: 5, window: 3 } })))["error"]).toEqual({ code: -32602, message: "策略 sma_cross 没有参数 window" });
    expect((await call("backtest.run", ui({ params: { fast: 30, slow: 20 } })))["error"]).toEqual({ code: -32602, message: "快线周期必须小于慢线周期(当前 30/20)" });
    expect((await call("backtest.run", ui({ strategy: "nope" })))["error"]["message"]).toBe("未知策略:nope(可选:buy_hold、sma_cross、rsi、breakout、custom)");
  });

  it("自定义条件:界面的操作数不带用不上的键;回执里的 rules 是补齐成 null 之后的", async () => {
    const { call } = makeServer();
    const rules = {
      entry: [{ left: { kind: "indicator", name: "rsi", period: 14 }, op: "<", right: { kind: "const", value: 40 } }],
      exit: [{ left: { kind: "indicator", name: "rsi", period: "14" }, op: ">", right: { kind: "const", value: "60" } }],
    };
    const r = (await call("backtest.run", ui({ strategy: "custom", params: {}, rules })))["result"];
    expect(Object.keys(r).sort()).toEqual([...REPORT_KEYS, "rules"].sort());
    expect(r["params"]).toEqual({});
    expect(r["rules"]).toEqual({
      entry: [{ left: { kind: "indicator", name: "rsi", period: 14, value: null }, op: "<", right: { kind: "const", name: null, period: null, value: 40 } }],
      exit: [{ left: { kind: "indicator", name: "rsi", period: 14, value: null }, op: ">", right: { kind: "const", name: null, period: null, value: 60 } }],
    });
    expect(r["trades"]).toBeGreaterThan(0);
    // 预置策略不看 rules,也不回 rules
    expect((await call("backtest.run", ui({ rules })))["result"]["rules"]).toBeUndefined();
  });

  it("自定义条件不合法、品种配置不合法:各自那句开头,后面带 zod 的原因", async () => {
    const { call } = makeServer();
    const noEntry = (await call("backtest.run", ui({ strategy: "custom", rules: { entry: [] } })))["error"];
    expect(noEntry["code"]).toBe(-32602);
    expect(noEntry["message"]).toMatch(/^自定义条件不合法:/);
    expect((await call("backtest.run", ui({ strategy: "custom" })))["error"]["message"]).toMatch(/^自定义条件不合法:/);
    const badInst = (await call("backtest.run", ui({ instrument: { type: "straddle" } })))["error"];
    expect(badInst["code"]).toBe(-32602);
    expect(badInst["message"]).toMatch(/^交易品种配置不合法:/);
    expect((await call("backtest.run", ui({ instrument: { type: "call", dte: 0 } })))["error"]["message"]).toMatch(/^交易品种配置不合法:/);
  });

  it("期权品种:界面给全四个数;每笔多一个 exit_reason(到期 / 信号 / 还开着)", async () => {
    const { call } = makeServer();
    const instrument = { type: "call", dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
    const r = (await call("backtest.run", ui({ instrument })))["result"];
    expect(r["instrument"]).toEqual(instrument);
    expect(Object.keys(r).sort()).toEqual(REPORT_KEYS);
    expect(Object.keys(r["trade_list"][0]).sort()).toEqual(["closed", "entry_date", "entry_price", "exit_date", "exit_price", "exit_reason", "return_pct"]);
    for (const t of r["trade_list"]) expect(["expiry", "signal", "open"]).toContain(t["exit_reason"]);
    // 不给 instrument = 正股
    expect((await call("backtest.run", ui({ instrument: undefined })))["result"]["instrument"]["type"]).toBe("stock");
  });

  it("没连券商、券商报错、日线太少:-32012 / -32012 / -32602", async () => {
    const off = makeServer({ connected: false });
    expect((await off.call("backtest.run", ui()))["error"]).toEqual({ code: -32012, message: "回测的历史行情需要TWS / IB Gateway:请先在「TWS 连接」面板连接引擎。" });
    const { call, router } = makeServer();
    router.fail = new BrokerError("HMDS 查询超时");
    expect((await call("backtest.run", ui()))["error"]).toEqual({ code: -32012, message: "HMDS 查询超时" });
    router.fail = null;
    router.bars = router.bars.slice(0, 3);
    expect((await call("backtest.run", ui()))["error"]).toEqual({ code: -32602, message: "区间内只有 3 根日线,数据太少无法回测" });
  });

  it("入参的几句原话(golden-rpc 也钉着):代码先查,再查日期;这时候别的字段给没给都不看", async () => {
    const { call } = makeServer();
    expect((await call("backtest.run", { symbol: "bad$" }))["error"]).toEqual({ code: -32602, message: "股票代码不合法:'bad$'" });
    expect((await call("backtest.run", { symbol: "AAPL" }))["error"]).toEqual({ code: -32602, message: "日期必须是 YYYY-MM-DD" });
    expect((await call("backtest.run", { symbol: "AAPL", start: "2026-02-01", end: "2026-01-01" }))["error"]["message"]).toBe("开始日期必须早于结束日期");
    expect((await call("backtest.run", { symbol: "AAPL", start: "2010-01-01", end: "2026-01-01" }))["error"]["message"]).toBe("回测区间最长 10 年");
    // 日期都对、没给 strategy:走到 runBacktest 才报
    expect((await call("backtest.run", { symbol: "AAPL", start: "2025-01-01", end: "2026-01-01" }))["error"]["message"]).toBe("未知策略:(可选:buy_hold、sma_cross、rsi、breakout、custom)");
  });
});

describe("backtest.parse_rules", () => {
  it("一句话 → 条件:模型的回答过 CustomRulesSchema 复验,补齐成界面搭建器要的形状", async () => {
    const { call, parser } = makeServer({ connected: false });
    const out = (await call("backtest.parse_rules", { text: "  MACD 金叉买入  " }))["result"];
    expect(out).toEqual({
      rules: {
        entry: [{ left: { kind: "indicator", name: "macd_hist", period: null, value: null }, op: "cross_up", right: { kind: "const", name: null, period: null, value: 0 } }],
        exit: [],
      },
    });
    expect(parser.calls).toHaveLength(1);
    expect(parser.calls[0]!.user).toBe("MACD 金叉买入");
    expect(Object.keys(parser.calls[0]!.schema["properties"]).sort()).toEqual(["entry", "exit"]);
  });

  it("空的、太长的:原话;模型报错、回答不合格:-32013", async () => {
    const { call, parser } = makeServer({ connected: false });
    expect((await call("backtest.parse_rules", {}))["error"]).toEqual({ code: -32602, message: "策略描述为空" });
    expect((await call("backtest.parse_rules", { text: "  " }))["error"]).toEqual({ code: -32602, message: "策略描述为空" });
    expect((await call("backtest.parse_rules", { text: "长".repeat(1001) }))["error"]).toEqual({ code: -32602, message: "策略描述太长(超过 1000 字)" });
    parser.reply = new Error("429 限流");
    expect((await call("backtest.parse_rules", { text: "均线金叉" }))["error"]).toEqual({ code: -32013, message: "条件生成失败:429 限流" });
    parser.reply = { entry: [] };
    const bad = (await call("backtest.parse_rules", { text: "均线金叉" }))["error"];
    expect(bad["code"]).toBe(-32013);
    expect(bad["message"]).toMatch(/^条件生成失败:/);
  });
});

describe("backtest.run:成交成本", () => {
  it("cost_pct 认数字串;给了才在回执里多一个键;超范围报人话", async () => {
    const { call } = makeServer();
    const plain = (await call("backtest.run", ui()))["result"];
    const net = (await call("backtest.run", ui({ cost_pct: "0.2" })))["result"];
    expect(Object.keys(plain).sort()).toEqual(REPORT_KEYS);
    expect(net["cost_pct"]).toBe(0.2);
    expect(net["total_return_pct"]).toBeLessThan(plain["total_return_pct"]);
    expect((await call("backtest.run", ui({ cost_pct: 12 })))["error"]["message"]).toContain("每边成交成本要在 0~10 之间");
  });
});

describe("backtest.sweep", () => {
  const sweep = (over: Rec = {}): Rec => ({
    symbols: ["aapl", "MSFT"], start: "2025-01-01", end: "2026-03-01", strategy: "sma_cross",
    grid: { fast: [5, "10"], slow: [20, 40] }, instrument: { type: "stock" }, split_pct: 70, folds: 2, ...over,
  });

  it("逐只取日线;回执带样本内外、前推与 notes", async () => {
    const { call, router } = makeServer();
    const r = (await call("backtest.sweep", sweep()))["result"];
    expect(router.asked.map((a) => a[0])).toEqual(["AAPL", "MSFT"]);
    expect(r["combos"]).toBe(4);
    expect(r["rows"]).toHaveLength(4);
    expect(r["best"]["oos"]).toHaveProperty("return_pct");
    expect(r["walk_forward"]["folds"]).toHaveLength(2);
    expect(Object.keys(r).sort()).toEqual([
      "best", "combos", "cost_pct", "end", "instrument", "notes", "objective", "rank_corr", "rows", "skipped", "split_date",
      "start", "strategy", "symbols", "walk_forward",
    ]);
  });

  it("入参:代码、日期、网格、标准、比例都报人话;没连券商报 -32012", async () => {
    const { call } = makeServer();
    expect((await call("backtest.sweep", sweep({ symbols: ["BAD CODE"] })))["error"]["message"]).toContain("股票代码不合法");
    expect((await call("backtest.sweep", sweep({ start: "2025/01/01" })))["error"]["message"]).toBe("日期必须是 YYYY-MM-DD");
    expect((await call("backtest.sweep", sweep({ grid: { fast: ["x"] } })))["error"]["message"]).toContain("参数 fast 的取值");
    expect((await call("backtest.sweep", sweep({ objective: "sharpe" })))["error"]["message"]).toContain("return / calmar");
    expect((await call("backtest.sweep", sweep({ split_pct: 40 })))["error"]["message"]).toContain("样本内占比");
    expect((await call("backtest.sweep", sweep({ strategy: "custom" })))["error"]["message"]).toContain("没有参数可扫");
    expect((await call("backtest.sweep", { ...sweep(), symbols: "AAPL" }))["error"]["code"]).toBe(-32602);
    const off = makeServer({ connected: false });
    expect((await off.call("backtest.sweep", sweep()))["error"]["code"]).toBe(-32012);
  });
});
