/** ideas.* 在 RPC 这一层的特征测试:输入是界面(Ideas.tsx → preload.js)真实发出来的载荷形状。
 *
 * golden-rpc 钉了这个域的 10 条请求,但都是没连券商的:analysis.brief 恒为 null。这里补上它没走到的几段——
 * 连着券商时的行情情报与价格锚点(界面「想法」卡片上那两行数字就读这几个键)、标的自愈、范围筛选、
 * 以及喂给模型的文本里有什么、没有什么(只有想法的时间 / 状态 / 标的 / 原文)。
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商与模型都是假的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-16(周三)美东 10:30。「上周五」= 2026-09-11。 */
const WED = Date.parse("2026-09-16T10:30:00-04:00");

/** 260 根日线,收盘价从 100 起每天 +0.5;2026-09-11 那一根的收盘是整数,好认。 */
function dailyBars(): Rec[] {
  const out: Rec[] = [];
  const end = Date.parse("2026-09-15T00:00:00Z");
  let close = 100;
  for (let t = end - 380 * 86_400_000; t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    close += 0.5;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: close - 0.25, high: close + 1, low: close - 1, close, volume: 1000 });
  }
  return out;
}

class FakeRouter {
  asked: Array<[string, string, string]> = [];
  fail: string | null = null;
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async historicalBars(symbol: string, start: string, end: string): Promise<Rec[]> {
    this.asked.push([symbol, start, end]);
    if (this.fail !== null) throw new Error(this.fail);
    return dailyBars();
  }
}

class FakeParser {
  calls: Array<{ system: string; user: string; schema: Rec }> = [];
  reply: Rec | Error | null = null;
  async completeJson(system: string, user: string, schema: Rec): Promise<Rec> {
    this.calls.push({ system, user, schema });
    if (this.reply instanceof Error) throw this.reply;
    if (this.reply !== null) return structuredClone(this.reply);
    const props = Object.keys(schema["properties"] ?? {});
    if (props.includes("themes")) {
      return { summary: "偏好尾盘动量", themes: ["半导体(2 条)"], lessons: ["带价位的更可执行"], patterns: [], actions: ["写成规则"] };
    }
    return { summary: "与动能匹配度一般", thesis: "需要站回均线", checks: ["财报日期"], risks: ["波动率偏高"], suggestion: "等回调" };
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; parser: FakeParser; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-ideas-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  const parser = new FakeParser();
  if (opts.connected) s.router = router as never;
  s.parserFactory = () => parser;
  servers.push(s);
  // 过一遍 JSON:和真的 stdio 一样,undefined 的键在路上就没了(listIdeas(undefined) → params 是 {})
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, parser, call };
}

afterEach(() => {
  setClock(null);
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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("ideas.add / list / update:界面的载荷", () => {
  it("记一条:回执就是库里那一行,标的现场抽,没提标的就是空(不兜底 SPX)", async () => {
    const { call } = makeServer();
    const made = (await call("ideas.add", { text: "  上周五尾盘买入的 AAPL,考虑加仓  " }))["result"]["idea"];
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), created_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO),
      text: "上周五尾盘买入的 AAPL,考虑加仓", symbols: ["AAPL"], status: "active", analysis: null,
    });
    const bare = (await call("ideas.add", { text: "今天情绪不好,少动" }))["result"]["idea"];
    expect(bare["symbols"]).toEqual([]);
    // 列表:新的在上;界面「全部」发的是 listIdeas(undefined) → {}
    const all = (await call("ideas.list", { status: undefined }))["result"]["ideas"];
    expect(all.map((i: Rec) => i["id"])).toEqual([bare["id"], made["id"]]);
    expect(all[1]).toEqual(made);
  });

  it("空的、太长的:原话", async () => {
    const { call } = makeServer();
    expect((await call("ideas.add", { text: "   " }))["error"]).toEqual({ code: -32602, message: "想法内容为空" });
    expect((await call("ideas.add", { text: "长".repeat(2001) }))["error"]).toEqual({ code: -32602, message: "想法太长(超过 2000 字),请精简" });
    expect((await call("ideas.add", { text: "长".repeat(2000) }))["error"]).toBeUndefined();
  });

  it("完成 / 归档 / 恢复:回执只有 id 与 status;「进行中」的筛选跟着变", async () => {
    const { call } = makeServer();
    const a = (await call("ideas.add", { text: "NVDA 回调到 50 日线再看" }))["result"]["idea"];
    const b = (await call("ideas.add", { text: "TSLA 财报前不碰" }))["result"]["idea"];
    expect((await call("ideas.update", { id: a["id"], status: "done" }))["result"]).toEqual({ id: a["id"], status: "done" });
    expect((await call("ideas.update", { id: b["id"], status: "archived" }))["result"]).toEqual({ id: b["id"], status: "archived" });
    expect((await call("ideas.list", { status: "active" }))["result"]["ideas"]).toEqual([]);
    expect((await call("ideas.list", { status: "done" }))["result"]["ideas"].map((i: Rec) => i["id"])).toEqual([a["id"]]);
    await call("ideas.update", { id: a["id"], status: "active" });
    const active = (await call("ideas.list", { status: "active" }))["result"]["ideas"];
    expect(active.map((i: Rec) => [i["id"], i["status"]])).toEqual([[a["id"], "active"]]);
  });

  it("不认识的状态、不存在的想法、没给 id:原话", async () => {
    const { call } = makeServer();
    const a = (await call("ideas.add", { text: "随便记一条" }))["result"]["idea"];
    expect((await call("ideas.update", { id: a["id"], status: "nope" }))["error"]).toEqual({ code: -32602, message: "未知想法状态:nope" });
    expect((await call("ideas.update", { id: "nope", status: "done" }))["error"]).toEqual({ code: -32602, message: "想法不存在:nope" });
    expect((await call("ideas.update", { status: "done" }))["error"]).toEqual({ code: -32602, message: "缺少想法 id" });
    expect((await call("ideas.list", { status: "nope" }))["error"]).toEqual({ code: -32602, message: "未知想法状态:nope" });
  });

  it("limit:数字和数字串都认,封顶 500", async () => {
    const { call } = makeServer();
    for (const t of ["一", "二", "三"]) await call("ideas.add", { text: `第${t}条` });
    expect((await call("ideas.list", { limit: 2 }))["result"]["ideas"]).toHaveLength(2);
    expect((await call("ideas.list", { limit: "1" }))["result"]["ideas"]).toHaveLength(1);
    expect((await call("ideas.list", { limit: 9999 }))["result"]["ideas"]).toHaveLength(3);
  });
});

describe("ideas.analyze", () => {
  it("连着券商:情报是代码按日线算的,「上周五」解析成价格锚点;整份存进 analysis,回执是更新后的那一行", async () => {
    setClock(WED);
    const { s, call, router, parser } = makeServer({ connected: true });
    const idea = (await call("ideas.add", { text: "上周五尾盘买入的 AAPL,考虑加仓" }))["result"]["idea"];
    const out = (await call("ideas.analyze", { id: idea["id"] }))["result"]["idea"];

    // 要了 380 天的日线,到今天(美东日历日)为止
    expect(router.asked).toEqual([["AAPL", "2025-09-01", "2026-09-16"]]);
    const bars = dailyBars();
    const last = bars[bars.length - 1]!["close"];
    const friday = bars.find((b) => b["date"] === "2026-09-11")!["close"];
    expect(out["analysis"]).toEqual({
      summary: "与动能匹配度一般", thesis: "需要站回均线", checks: ["财报日期"], risks: ["波动率偏高"], suggestion: "等回调",
      analyzed_at: new Date(WED).toISOString(), model: s.settings.llm.model, symbol: "AAPL",
      brief: {
        last, bars: bars.length,
        chg_1d_pct: expect.any(Number), chg_5d_pct: expect.any(Number), chg_20d_pct: expect.any(Number), chg_60d_pct: expect.any(Number),
        vol20_annual_pct: expect.any(Number), rsi14: expect.any(Number), vs_sma50_pct: expect.any(Number), vs_sma200_pct: expect.any(Number),
        macd_hist: expect.any(Number), from_52w_high_pct: expect.any(Number), from_52w_low_pct: expect.any(Number),
        anchor: { label: "上周五(2026-09-11)收盘价", date: "2026-09-11", price: friday, chg_from_anchor_pct: Math.round((last / friday - 1) * 10000) / 100 },
      },
    });
    expect(out).toEqual({ ...idea, updated_at: expect.stringMatching(ISO), analysis: out["analysis"] });
    // 列表里读到的是同一份
    expect((await call("ideas.list", {}))["result"]["ideas"][0]).toEqual(out);

    // 喂给模型的:此刻的美东时间、情报、想法原文——没有账户、没有持仓
    expect(parser.calls).toHaveLength(1);
    const user = parser.calls[0]!.user;
    expect(user.startsWith("当前美东时间:2026-09-16 10:30(周三)\n标的行情情报(AAPL,")).toBe(true);
    expect(user).toContain("价格锚点");
    expect(user.endsWith("\n\n交易想法:上周五尾盘买入的 AAPL,考虑加仓")).toBe(true);
    expect(Object.keys(parser.calls[0]!.schema["properties"]).sort()).toEqual(["checks", "risks", "suggestion", "summary", "thesis"]);
  });

  it("没连券商:brief 是 null,symbol 照给;没提标的:symbol 也是 null", async () => {
    const { call, parser } = makeServer();
    const a = (await call("ideas.add", { text: "AAPL 回调再看" }))["result"]["idea"];
    const b = (await call("ideas.add", { text: "今天少动" }))["result"]["idea"];
    expect((await call("ideas.analyze", { id: a["id"] }))["result"]["idea"]["analysis"]).toMatchObject({ symbol: "AAPL", brief: null });
    expect((await call("ideas.analyze", { id: b["id"] }))["result"]["idea"]["analysis"]).toMatchObject({ symbol: null, brief: null });
    expect(parser.calls[0]!.user).toContain("未连接券商网关或无法获取 AAPL 的行情数据");
    expect(parser.calls[1]!.user).toContain("想法中未识别出标的,无行情数据");
  });

  it("行情取不到:不算失败,brief 里只有一句 error(截到 120 字),界面照它显示「行情获取失败」", async () => {
    const { call, router } = makeServer({ connected: true });
    router.fail = "HMDS 查询超时".repeat(30);
    const a = (await call("ideas.add", { text: "AAPL 回调再看" }))["result"]["idea"];
    const analysis = (await call("ideas.analyze", { id: a["id"] }))["result"]["idea"]["analysis"];
    expect(analysis["brief"]).toEqual({ error: router.fail.slice(0, 120) });
    expect(analysis["summary"]).toBe("与动能匹配度一般");
  });

  it("模型回的不合 schema、模型报错:-32011,原因带出来;库里的 analysis 不动", async () => {
    const { call, parser } = makeServer();
    const a = (await call("ideas.add", { text: "AAPL 回调再看" }))["result"]["idea"];
    parser.reply = { summary: "", thesis: "x" };
    const bad = (await call("ideas.analyze", { id: a["id"] }))["error"];
    expect(bad["code"]).toBe(-32011);
    expect(bad["message"]).toMatch(/^AI 分析失败:/);
    parser.reply = new Error("429 限流");
    expect((await call("ideas.analyze", { id: a["id"] }))["error"]).toEqual({ code: -32011, message: "AI 分析失败:429 限流" });
    expect((await call("ideas.list", {}))["result"]["ideas"][0]["analysis"]).toBeNull();
  });

  it("标的自愈:库里的老标签和原文现抽的不一样,以现抽的为准并写回", async () => {
    const { s, call, router } = makeServer({ connected: true });
    const a = (await call("ideas.add", { text: "AAPL 回调再看" }))["result"]["idea"];
    s.engine.store.setIdeaSymbols(a["id"], ["SPX"]); // 老版本兜底写进去的那种
    const out = (await call("ideas.analyze", { id: a["id"] }))["result"]["idea"];
    expect(out["symbols"]).toEqual(["AAPL"]);
    expect(out["analysis"]["symbol"]).toBe("AAPL");
    expect(router.asked.map((q) => q[0])).toEqual(["AAPL"]);
  });

  it("不存在的想法:原话", async () => {
    const { call } = makeServer();
    expect((await call("ideas.analyze", { id: "nope" }))["error"]).toEqual({ code: -32602, message: "想法不存在:nope" });
  });
});

describe("ideas.digest / digests", () => {
  it("界面发的是 scope: 'all':已归档 + 已完成一起,进行中的不进;按时间从早到晚喂,带上当时的分析摘要", async () => {
    const { s, call, parser } = makeServer();
    const a = (await call("ideas.add", { text: "NVDA 尾盘突破买入" }))["result"]["idea"];
    await call("ideas.analyze", { id: a["id"] });
    const b = (await call("ideas.add", { text: "AMD 财报前减半" }))["result"]["idea"];
    const c = (await call("ideas.add", { text: "还在想的一条" }))["result"]["idea"];
    await call("ideas.update", { id: a["id"], status: "done" });
    await call("ideas.update", { id: b["id"], status: "archived" });

    const row = (await call("ideas.digest", { scope: "all" }))["result"]["digest"];
    expect(row).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), created_at: expect.stringMatching(ISO), scope: "all", idea_count: 2,
      idea_ids: [b["id"], a["id"]],
      digest: { summary: "偏好尾盘动量", themes: ["半导体(2 条)"], lessons: ["带价位的更可执行"], patterns: [], actions: ["写成规则"], model: s.settings.llm.model },
    });
    expect(row["idea_ids"]).not.toContain(c["id"]);

    const user = parser.calls[parser.calls.length - 1]!.user;
    const day = String(a["created_at"]).slice(0, 10);
    expect(user).toBe(
      `共 2 条想法,按时间从早到晚:\n\n[${day} | 已完成 | NVDA] NVDA 尾盘突破买入\n  当时的 AI 分析:与动能匹配度一般\n\n[${day} | 已归档 | AMD] AMD 财报前减半`,
    );

    // 历史:新的在上,读出来和回执同一份
    const again = (await call("ideas.digest", {}))["result"]["digest"]; // 不给 scope = archived
    expect(again).toMatchObject({ scope: "archived", idea_count: 1, idea_ids: [b["id"]] });
    expect((await call("ideas.digests", {}))["result"]["digests"]).toEqual([again, row]);
    expect((await call("ideas.digests", { limit: "1" }))["result"]["digests"]).toEqual([again]);
  });

  it("没有可总结的、不认识的范围、模型失败:原话;失败不留历史", async () => {
    const { call, parser } = makeServer();
    expect((await call("ideas.digest", { scope: "all" }))["error"]).toEqual({ code: -32602, message: "没有可总结的想法。先把几条想法归档或标记完成,再来总结。" });
    expect((await call("ideas.digest", { scope: "nope" }))["error"]).toEqual({ code: -32602, message: "未知总结范围:nope(可选:archived、done、all)" });
    const a = (await call("ideas.add", { text: "NVDA 尾盘突破买入" }))["result"]["idea"];
    await call("ideas.update", { id: a["id"], status: "done" });
    parser.reply = new Error("超时");
    expect((await call("ideas.digest", { scope: "done" }))["error"]).toEqual({ code: -32011, message: "知识总结失败:超时" });
    expect((await call("ideas.digests", {}))["result"]["digests"]).toEqual([]);
  });
});
