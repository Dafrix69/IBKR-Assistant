/** 想法检索第二期:本机嵌入的混合检索(embeddings.ts + ideaVectors.ts + services/ideaSemantic.ts)。
 * 嵌入器是假的(按关键字造向量,结果确定),不连 Ollama。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbedError, OllamaEmbedder, QUERY_INSTRUCTION, cosine, isLoopbackUrl } from "../src/embeddings.js";
import type { Embedder } from "../src/embeddings.js";
import { mergeSemantic } from "../src/ideaRetrieval.js";
import type { RetrievalCandidate } from "../src/ideaRetrieval.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 假嵌入:三个「概念」维——拆腿类、到期类、股票类。查询前缀照真的带,这里去掉再认 */
class FakeEmbedder implements Embedder {
  readonly model = "fake-embed";
  calls: string[][] = [];
  failing = false;
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.failing) throw new EmbedError("连不上");
    this.calls.push([...texts]);
    return texts.map((raw) => {
      const t = raw.replace(QUERY_INSTRUCTION, "");
      return [
        /拆腿|买回.*身|身买回/.test(t) ? 1 : 0,
        /到期|结算/.test(t) ? 1 : 0,
        /RKLB|股票|买入/.test(t) ? 1 : 0.05,
      ];
    });
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];
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

function makeServer(): { s: RpcServer; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-semantic-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, call };
}

async function seed(call: (m: string, p?: Rec) => Promise<Rec>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, text] of [
    ["leg", "禁止拆腿平仓,余腿裸露到期"],
    ["body", "先把身买回来,两翼留着赌"],
    ["stock", "RKLB 回调买入"],
  ]) {
    const made = (await call("ideas.add", { text }))["result"]["idea"];
    await call("ideas.update", { id: made["id"], status: "archived" });
    out[key!] = made["id"];
  }
  return out;
}

describe("embeddings", () => {
  it("只许本机地址:不是回环就当场拒", () => {
    expect(["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"].map(isLoopbackUrl)).toEqual([true, true, true]);
    expect(["http://192.168.1.5:11434", "https://api.example.com", "file:///x", "garbage"].map(isLoopbackUrl))
      .toEqual([false, false, false, false]);
    expect(() => new OllamaEmbedder("http://10.0.0.2:11434", "m")).toThrow(EmbedError);
  });

  it("请求带 keep_alive:默认 5m(空闲就卸,不一直占显存),可以换", async () => {
    const bodies: Rec[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 });
    });
    try {
      await new OllamaEmbedder("http://127.0.0.1:11434", "m").embed(["x"]);
      await new OllamaEmbedder("http://127.0.0.1:11434", "m", -1).embed(["x"]);
    } finally {
      spy.mockRestore();
    }
    expect(bodies).toEqual([
      { model: "m", input: ["x"], keep_alive: "5m" },
      { model: "m", input: ["x"], keep_alive: -1 },
    ]);
  });

  it("余弦", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("mergeSemantic", () => {
  const idea = (id: string, day: string) => ({
    id, created_at: `${day}T15:00:00+00:00`, updated_at: "", text: id, symbols: [], status: "archived" as const, analysis: null,
  });
  it("已命中的打上 semantic;没命中的从过滤后的池子里补;新的在前", () => {
    const cands: RetrievalCandidate[] = [{ idea: idea("a", "2026-09-01"), symbol_hit: false, text_hit: true }];
    const pool = [idea("a", "2026-09-01"), idea("b", "2026-09-05"), idea("c", "2026-09-03")];
    const got = mergeSemantic(cands, pool, new Map([["a", 0.7], ["b", 0.6]]), 10);
    expect(got.map((c) => [c.idea.id, c.text_hit, c.semantic_hit])).toEqual([["b", false, true], ["a", true, true]]);
  });
});

describe("ideas.search:混合检索", () => {
  it("测试环境默认不连本机嵌入(否则测试就不离线了):只有关键词命中", async () => {
    const { s, call } = makeServer();
    expect(s.ideaSemantic.embedder).toBeNull();
    const ids = await seed(call);
    const hits = (await call("ideas.search", { q: "拆腿" }))["result"]["hits"];
    expect(hits.map((h: Rec) => [h["idea"]["id"], h["matched_by"]])).toEqual([[ids["leg"], ["text"]]]);
  });

  it("关键词对不上、意思相近的补进来,标「语义相近」;关键词命中的也标上", async () => {
    const { s, call } = makeServer();
    const fake = new FakeEmbedder();
    s.ideaSemantic.embedder = fake;
    const ids = await seed(call);
    const hits = (await call("ideas.search", { q: "拆腿" }))["result"]["hits"];
    // 同一秒写入的几条,「新的在前」时按 id 定序(随机),这里只看谁被找到、为什么
    expect(Object.fromEntries(hits.map((h: Rec) => [h["idea"]["id"], h["matched_by"]]))).toEqual({
      [ids["body"]!]: ["semantic"], // 「先把身买回来」原文里没有「拆腿」两个字
      [ids["leg"]!]: ["text", "semantic"],
    });
    expect(hits.some((h: Rec) => h["idea"]["id"] === ids["stock"])).toBe(false);
  });

  it("想法的向量只算一次、存库;之后只算查询那一句;换了模型重算", async () => {
    const { s, call } = makeServer();
    const fake = new FakeEmbedder();
    s.ideaSemantic.embedder = fake;
    await seed(call);
    await call("ideas.search", { q: "拆腿" });
    await call("ideas.search", { q: "到期" });
    expect(fake.calls.map((c) => c.length)).toEqual([3, 1, 1]); // 3 条想法一批,然后两句查询
    expect(s.engine.store.vectors.count("fake-embed")).toBe(3);
    const other = Object.assign(new FakeEmbedder(), { model: "fake-embed-2" });
    s.ideaSemantic.embedder = other;
    await call("ideas.search", { q: "拆腿" });
    expect(other.calls.map((c) => c.length)).toEqual([3, 1]);
  });

  it("嵌入服务出错:退回纯关键词,不报错", async () => {
    const { s, call } = makeServer();
    const fake = new FakeEmbedder();
    fake.failing = true;
    s.ideaSemantic.embedder = fake;
    const ids = await seed(call);
    const r = await call("ideas.search", { q: "拆腿" });
    expect(r["error"]).toBeUndefined();
    expect(r["result"]["hits"].map((h: Rec) => h["idea"]["id"])).toEqual([ids["leg"]]);
  });

  it("状态先过滤:进行中的想法不进归档范围的语义池", async () => {
    const { s, call } = makeServer();
    s.ideaSemantic.embedder = new FakeEmbedder();
    await seed(call);
    const active = (await call("ideas.add", { text: "拆腿之后翼到期归零" }))["result"]["idea"];
    const hits = (await call("ideas.search", { q: "身", status: "archived" }))["result"]["hits"];
    expect(hits.some((h: Rec) => h["idea"]["id"] === active["id"])).toBe(false);
  });
});
