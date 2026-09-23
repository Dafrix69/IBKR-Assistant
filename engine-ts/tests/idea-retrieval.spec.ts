/** 想法检索(docs/features/idea-retrieval.md 第一期):结构化过滤 + 关键词 + 按时间分层抽样。
 *
 * 分三层钉:
 *  · 纯函数(ideaRetrieval.ts):给定候选,**哪几条被选中**是确定的;
 *  · 库(store.searchIdeas):固定语料夹具,命中哪几条 id;老库迁移时全文索引把已有想法补进来;
 *  · RPC:ideas.search 的回包形状与原话;ideas.digest 带焦点时喂给模型的是哪几条、不带焦点时一字不变。
 * 全部离线:模型是假的,不连券商。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Idea } from "../src/contract/ideas.js";
import {
  dayBound, normalizeFocus, parseSymbols, pickForDigest, splitTerms, stratify,
} from "../src/ideaRetrieval.js";
import type { RetrievalCandidate } from "../src/ideaRetrieval.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const dirs: string[] = [];
const stores: TradeStore[] = [];
const servers: RpcServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  stores.splice(0);
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-idea-retrieval-"));
  dirs.push(dir);
  return dir;
}

function idea(id: string, day: string, extra: Partial<Idea> = {}): Idea {
  return {
    id, created_at: `${day}T15:00:00+00:00`, updated_at: `${day}T15:00:00+00:00`,
    text: id, symbols: [], status: "archived", analysis: null, ...extra,
  };
}

function cand(id: string, day: string, sym = false, txt = true): RetrievalCandidate {
  return { idea: idea(id, day), symbol_hit: sym, text_hit: txt };
}

/** 把想法的写作时间改成夹具里的日子(库没有这个 API——想法的时点本来就不可改,只有测试这样做)。 */
function backdate(dbPath: string, ideaId: string, day: string): void {
  const db = new Database(dbPath);
  db.prepare("UPDATE ideas SET created_at=?, updated_at=? WHERE id=?")
    .run(`${day}T15:00:00+00:00`, `${day}T15:00:00+00:00`, ideaId);
  db.close();
}

// ---------------------------------------------------------------- 纯函数

describe("ideaRetrieval:按时间分层抽", () => {
  it("远 / 中 / 近三段均分配额;某段不够,余量匀给还有货的段", () => {
    // 远期 6 条、中期 1 条、近期 6 条;预算 7 → 中期只有 1 条,余下 6 条由远近两段平分
    const far = ["f1", "f2", "f3", "f4", "f5", "f6"].map((id, i) => cand(id, `2026-01-0${i + 1}`));
    const mid = [cand("m1", "2026-05-01")];
    const near = ["n1", "n2", "n3", "n4", "n5", "n6"].map((id, i) => cand(id, `2026-09-0${i + 1}`));
    const got = stratify([...far, ...mid, ...near], 7, 3).map((c) => c.idea.id);
    expect(got.filter((id) => id.startsWith("m"))).toEqual(["m1"]);
    expect(got.filter((id) => id.startsWith("f"))).toHaveLength(3);
    expect(got.filter((id) => id.startsWith("n"))).toHaveLength(3);
    // 段内同分时新的先进
    expect(got.filter((id) => id.startsWith("n"))).toEqual(["n6", "n5", "n4"]);
  });

  it("段内按分数:标的命中(2)> 原文命中(1),不管新旧", () => {
    const got = stratify([
      cand("old-sym", "2026-09-01", true, false),
      cand("new-txt", "2026-09-05", false, true),
      cand("mid-txt", "2026-09-03", false, true),
    ], 1, 1).map((c) => c.idea.id);
    expect(got).toEqual(["old-sym"]);
  });

  it("候选不超过预算就全要;预算为 0 什么都不要", () => {
    const all = [cand("a", "2026-01-01"), cand("b", "2026-02-01")];
    expect(stratify(all, 5, 3)).toHaveLength(2);
    expect(stratify(all, 0, 3)).toEqual([]);
  });

  it("pickForDigest:最近一批无条件进(命中了也带上标签),总数封顶,结果按时间从早到晚", () => {
    const recent = [idea("r3", "2026-09-20"), idea("r2", "2026-09-19"), idea("r1", "2026-09-18")];
    const matches = [
      cand("r2", "2026-09-19", true, false), // 既是最近的,也命中了标的
      ...["a", "b", "c", "d"].map((id, i) => cand(id, `2026-0${i + 1}-15`)),
    ];
    const got = pickForDigest(matches, recent, { total: 5, recent: 2, buckets: 3 });
    expect(got).toHaveLength(5);
    const tags = Object.fromEntries(got.map((p) => [p.idea.id, p.matched_by]));
    expect(tags["r3"]).toEqual(["recent"]);
    expect(tags["r2"]).toEqual(["symbol", "recent"]);
    expect(tags["r1"]).toBeUndefined(); // 最近配额只有 2
    const days = got.map((p) => p.idea.created_at);
    expect([...days].sort()).toEqual(days);
  });
});

describe("ideaRetrieval:入参整理", () => {
  it("关键词按空白与中英文标点切,去重", () => {
    expect(splitTerms(" 蝴蝶  持有到结算,止损、蝴蝶 ")).toEqual(["蝴蝶", "持有到结算", "止损"]);
    expect(splitTerms(undefined)).toEqual([]);
  });

  it("标的:数组或串都认,大写去重", () => {
    expect(parseSymbols("spx, aapl SPX")).toEqual(["SPX", "AAPL"]);
    expect(parseSymbols(["rklb", " "])).toEqual(["RKLB"]);
  });

  it("焦点两项都空 = 没有焦点(走老口径)", () => {
    expect(normalizeFocus({ q: "  ", symbols: [] })).toBeNull();
    expect(normalizeFocus(undefined)).toBeNull();
    expect(normalizeFocus({ q: "蝴蝶 结算", symbols: ["spx"] })).toEqual({ q: "蝴蝶 结算", symbols: ["SPX"] });
  });

  it("日期:含当天;格式不对、不是真日子都报原话", () => {
    expect(dayBound("2026-09-16", "since")).toBe("2026-09-16T00:00:00");
    expect(dayBound("2026-09-16", "until")).toBe("2026-09-17T00:00:00");
    expect(dayBound("", "since")).toBeNull();
    expect(() => dayBound("2026-02-30", "until")).toThrowError("until 应为 YYYY-MM-DD 的日期,收到:2026-02-30");
    expect(() => dayBound("9/16", "since")).toThrowError("since 应为 YYYY-MM-DD 的日期,收到:9/16");
  });
});

// ---------------------------------------------------------------- 库

describe("store.searchIdeas:固定语料", () => {
  function corpus(): { store: TradeStore; dbPath: string; ids: Record<string, string> } {
    const dbPath = path.join(tmpDir(), "t.db");
    const store = new TradeStore(dbPath);
    stores.push(store);
    const ids: Record<string, string> = {};
    const put = (key: string, text: string, symbols: string[], status: string, day: string): void => {
      const made = store.addIdea(text, symbols);
      if (status !== "active") store.setIdeaStatus(made.id, status);
      backdate(dbPath, made.id, day);
      ids[key] = made.id;
    };
    put("flyHold", "SPX 蝴蝶持有到结算又亏了,下次尾盘前平掉", ["SPX"], "archived", "2026-07-17");
    put("flyEarly", "蝴蝶提前止盈,落袋 40%", ["SPX"], "done", "2026-08-10");
    put("rklb", "RKLB 回调到 64 附近分批买,止损放 60", ["RKLB"], "archived", "2026-09-18");
    put("mood", "今天情绪不好,少动", [], "active", "2026-09-20");
    return { store, dbPath, ids };
  }

  it("3 个字以上的词走全文索引;两个字的词走子串;任一命中即算", () => {
    const { store, ids } = corpus();
    const byLong = store.searchIdeas({ terms: ["持有到结算"] }).map((c) => c.idea.id);
    expect(byLong).toEqual([ids["flyHold"]]);
    const byShort = store.searchIdeas({ terms: ["止损"] }).map((c) => c.idea.id);
    expect(byShort).toEqual([ids["rklb"]]);
    const byEither = store.searchIdeas({ terms: ["止损", "蝴蝶"] }).map((c) => c.idea.id);
    expect(byEither).toEqual([ids["rklb"], ids["flyEarly"], ids["flyHold"]]); // 新的在前
  });

  it("标的与关键词是「或」;每行带着命中了哪一路", () => {
    const { store, ids } = corpus();
    const got = store.searchIdeas({ symbols: ["rklb"], terms: ["提前止盈"] });
    expect(got.map((c) => [c.idea.id, c.symbol_hit, c.text_hit])).toEqual([
      [ids["rklb"], true, false],
      [ids["flyEarly"], false, true],
    ]);
  });

  it("状态与时间窗先过滤;都不给检索条件时就是一个列表", () => {
    const { store, ids } = corpus();
    const doneOrArchived = store.searchIdeas({ statuses: ["archived", "done"], symbols: ["SPX"] });
    expect(doneOrArchived.map((c) => c.idea.id)).toEqual([ids["flyEarly"], ids["flyHold"]]);
    const inAug = store.searchIdeas({ since: "2026-08-01T00:00:00", until: "2026-09-01T00:00:00" });
    expect(inAug.map((c) => c.idea.id)).toEqual([ids["flyEarly"]]);
    expect(inAug[0]).toMatchObject({ symbol_hit: false, text_hit: false });
    expect(() => store.searchIdeas({ statuses: ["nope"] })).toThrowError("未知想法状态:nope");
  });

  it("老库升级:全文索引把已有的想法补进来,之后新记的也进", () => {
    const dbPath = path.join(tmpDir(), "old.db");
    const first = new TradeStore(dbPath);
    const kept = first.addIdea("旧库里就有的想法:蝴蝶翼宽放到五十点", ["SPX"]);
    // 模拟升级前的库:拆掉索引与触发器
    const raw = new Database(dbPath);
    raw.exec("DROP TRIGGER ideas_fts_ai; DROP TRIGGER ideas_fts_ad; DROP TRIGGER ideas_fts_au; DROP TABLE ideas_fts;");
    raw.close();
    const reopened = new TradeStore(dbPath);
    stores.push(reopened);
    expect(reopened.searchIdeas({ terms: ["翼宽放到"] }).map((c) => c.idea.id)).toEqual([kept.id]);
    const fresh = reopened.addIdea("新记一条:翼宽放到二十五点试试", []);
    expect(reopened.searchIdeas({ terms: ["翼宽放到"] }).map((c) => c.idea.id)).toEqual([fresh.id, kept.id]);
  });

  it("总结的焦点:只有带焦点的那一行有 focus 键", () => {
    const { store, ids } = corpus();
    const digest = { summary: "s", themes: [], lessons: [], patterns: [], actions: [], model: "m" };
    store.addIdeaDigest("all", [ids["flyHold"]!], digest);
    store.addIdeaDigest("all", [ids["flyHold"]!], digest, { q: "蝴蝶", symbols: ["SPX"] });
    const rows = store.listIdeaDigests();
    expect(rows[0]).toMatchObject({ focus: { q: "蝴蝶", symbols: ["SPX"] } });
    expect(rows[1]).not.toHaveProperty("focus");
  });
});

// ---------------------------------------------------------------- RPC

class FakeParser {
  calls: Array<{ system: string; user: string }> = [];
  async completeJson(system: string, user: string): Promise<Rec> {
    this.calls.push({ system, user });
    return { summary: "s", themes: [], lessons: ["l"], patterns: [], actions: [] };
  }
}

function makeServer(): { dbPath: string; parser: FakeParser; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = tmpDir();
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const dbPath = path.join(dir, "t.db");
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: dbPath } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const parser = new FakeParser();
  s.parserFactory = () => parser as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { dbPath, parser, call };
}

describe("ideas.search / ideas.digest(focus):RPC", () => {
  async function seed(call: (m: string, p?: Rec) => Promise<Rec>, dbPath: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const rows: Array<[string, string, string, string]> = [
      ["hold", "SPX 蝴蝶持有到结算亏了", "archived", "2026-07-17"],
      ["early", "SPX 蝴蝶提前平仓赚了一半", "done", "2026-08-10"],
      ["rklb", "RKLB 回调买入", "archived", "2026-09-18"],
      ["open", "SPX 下周想做空", "active", "2026-09-22"],
    ];
    for (const [key, text, status, day] of rows) {
      const made = (await call("ideas.add", { text }))["result"]["idea"];
      if (status !== "active") await call("ideas.update", { id: made["id"], status });
      backdate(dbPath, made["id"], day);
      out[key] = made["id"];
    }
    return out;
  }

  it("search:命中带原因,新的在前;状态与时间窗照常过滤", async () => {
    const { dbPath, call } = makeServer();
    const ids = await seed(call, dbPath);
    const hits = (await call("ideas.search", { q: "持有到结算", symbols: "rklb" }))["result"]["hits"];
    expect(hits.map((h: Rec) => [h["idea"]["id"], h["matched_by"]])).toEqual([
      [ids["rklb"], ["symbol"]],
      [ids["hold"], ["text"]],
    ]);
    const julyOnly = (await call("ideas.search", { symbols: ["SPX"], since: "2026-07-01", until: "2026-07-31" }))["result"];
    expect(julyOnly["hits"].map((h: Rec) => h["idea"]["id"])).toEqual([ids["hold"]]);
    const active = (await call("ideas.search", { status: "active" }))["result"]["hits"];
    expect(active.map((h: Rec) => [h["idea"]["id"], h["matched_by"]])).toEqual([[ids["open"], []]]);
  });

  it("search:原话", async () => {
    const { call } = makeServer();
    expect((await call("ideas.search", { since: "2026/09/01" }))["error"])
      .toEqual({ code: -32602, message: "since 应为 YYYY-MM-DD 的日期,收到:2026/09/01" });
    expect((await call("ideas.search", { status: "nope" }))["error"])
      .toEqual({ code: -32602, message: "未知想法状态:nope" });
    expect((await call("ideas.search", { symbols: 7 }))["error"]["code"]).toBe(-32602); // 结构错归 schema
  });

  it("digest 带焦点:只喂命中的与最近的,进行中的不进;焦点落库,喂给模型的开头写明取数方式", async () => {
    const { dbPath, parser, call } = makeServer();
    const ids = await seed(call, dbPath);
    const row = (await call("ideas.digest", { scope: "all", focus: { q: "蝴蝶", symbols: [] } }))["result"]["digest"];
    expect(row["focus"]).toEqual({ q: "蝴蝶" });
    // 范围内只有 3 条(进行中的不算),最近 20 条的配额把它们全带进来了
    expect(new Set(row["idea_ids"])).toEqual(new Set([ids["hold"], ids["early"], ids["rklb"]]));
    expect(row["idea_ids"]).toEqual([ids["rklb"], ids["early"], ids["hold"]]); // 最近的在前,同老口径
    const user = parser.calls.at(-1)?.user ?? "";
    expect(user.startsWith("检索焦点:关键词「蝴蝶」。")).toBe(true);
    expect(user).not.toContain("下周想做空");
    // 喂的次序:按时间从早到晚
    expect(user.indexOf("持有到结算")).toBeLessThan(user.indexOf("RKLB 回调买入"));
  });

  it("digest 不带焦点(或焦点是空的):老口径一字不变,库里的行也没有 focus 键", async () => {
    const { dbPath, parser, call } = makeServer();
    await seed(call, dbPath);
    const plain = (await call("ideas.digest", { scope: "all" }))["result"]["digest"];
    expect(plain).not.toHaveProperty("focus");
    expect(parser.calls.at(-1)?.user.startsWith("共 3 条想法,按时间从早到晚:")).toBe(true);
    const empty = (await call("ideas.digest", { scope: "all", focus: { q: "  ", symbols: [] } }))["result"]["digest"];
    expect(empty).not.toHaveProperty("focus");
    const listed = (await call("ideas.digests"))["result"]["digests"];
    expect(listed.every((d: Rec) => !("focus" in d))).toBe(true);
  });
});
