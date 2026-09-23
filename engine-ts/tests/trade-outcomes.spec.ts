/** 交易结果进知识总结(docs/features/idea-retrieval.md「边界」:盈亏由代码算,当事实传给模型,不进检索)。
 *
 * 两层钉:
 *  · 纯函数(tradeOutcomes.ts):给定交易分析页那批记录,每笔的结局、收益率是确定的;发给模型的那一行没有数量、金额、账户;
 *  · RPC:ideas.digest 带 trades 时喂的是哪几笔、换了哪段系统提示词、落库带 trades 键;不带时一字不变。
 * 全部离线:模型是假的,日线是假的,不连券商。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { groupButterflies } from "../src/ibtrades.js";
import { RpcServer } from "../src/rpc.js";
import { groupStockTrips } from "../src/stockreview.js";
import {
  butterflyFacts, collectFacts, factLine, settlementsNeeded, stockFacts, tallyLine,
} from "../src/tradeOutcomes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const ACCT = "U1234567";
const ACCOUNTS = [{ alias: "主账户", account_id: ACCT, is_paper: false }];
let execSeq = 0;

/** 一张蝴蝶的成交:BAG 行 + 三条腿(1:2:1)。BUY = 两翼买、中间卖;SELL 反过来。 */
function flyFills(
  perm: number, action: "BUY" | "SELL", strikes: [number, number, number], right: "C" | "P",
  expiry: string, price: number, time: string,
): Rec[] {
  const legSide = (i: number): string => ((i === 1) === (action === "BUY") ? "SLD" : "BOT");
  const base = { account_id: ACCT, perm_id: perm, order_id: null, time, commission: 0 };
  const rows: Rec[] = [{
    ...base, exec_id: `e${(execSeq += 1)}`, side: action === "BUY" ? "BOT" : "SLD", shares: 1, price,
    contract: { secType: "BAG", symbol: "SPX", currency: "USD" },
  }];
  strikes.forEach((strike, i) => {
    rows.push({
      ...base, exec_id: `e${(execSeq += 1)}`, side: legSide(i), shares: i === 1 ? 2 : 1, price: 1,
      contract: {
        secType: "OPT", symbol: "SPX", strike, right, expiry, multiplier: "100", tradingClass: "SPXW", currency: "USD",
      },
    });
  });
  return rows;
}

function stockFill(symbol: string, side: "BOT" | "SLD", shares: number, price: number, time: string, perm: number): Rec {
  return {
    account_id: ACCT, exec_id: `e${(execSeq += 1)}`, perm_id: perm, order_id: null, side, shares, price, time, commission: 0,
    contract: { secType: "STK", symbol, currency: "USD", exchange: "SMART", conId: 1 },
  };
}

// 9/10 买 7625/7650/7675 看跌蝶 5.4,同日 4.55 平掉;9/10 另买一张 7660/7680/7700 看涨蝶 3.55 拿到到期;
// 9/4 的一张 7800/7820/7840 看涨蝶没平、结算价取不到;12/18 到期的一张还没到期
const FLY_FILLS: Rec[] = [
  ...flyFills(101, "BUY", [7625, 7650, 7675], "P", "20260910", 5.4, "2026-09-10T13:27:29+00:00"),
  ...flyFills(102, "SELL", [7625, 7650, 7675], "P", "20260910", 4.55, "2026-09-10T15:04:15+00:00"),
  ...flyFills(103, "BUY", [7660, 7680, 7700], "C", "20260910", 3.55, "2026-09-10T16:00:01+00:00"),
  ...flyFills(104, "BUY", [7800, 7820, 7840], "C", "20260904", 0.95, "2026-09-04T13:52:56+00:00"),
  ...flyFills(105, "BUY", [7700, 7720, 7740], "C", "20261218", 2.0, "2026-09-21T14:00:00+00:00"),
];
// NVO 买 65 卖 66.5(+2.3%);AMD 买 100 卖 90(-10%);RKLB 先卖(期初仓位,成本不明)后买(持仓中)
const STOCK_FILLS: Rec[] = [
  stockFill("NVO", "BOT", 50, 65.0, "2026-09-17T14:05:00+00:00", 201),
  stockFill("NVO", "SLD", 50, 66.5, "2026-09-17T15:00:00+00:00", 202),
  stockFill("AMD", "BOT", 10, 100.0, "2026-09-15T14:00:00+00:00", 203),
  stockFill("AMD", "SLD", 10, 90.0, "2026-09-16T14:00:00+00:00", 204),
  stockFill("RKLB", "SLD", 100, 67.94, "2026-09-17T13:35:00+00:00", 205),
  stockFill("RKLB", "BOT", 100, 64.51, "2026-09-18T14:40:00+00:00", 206),
];
const NOW = Date.parse("2026-09-23T16:00:00Z");
const SETTLE: Record<string, number> = { "SPX|2026-09-10": 7682 };
const settle = (s: string, d: string): number | null => SETTLE[`${s}|${d}`] ?? null;

describe("tradeOutcomes:蝴蝶", () => {
  const flies = groupButterflies(FLY_FILLS, ACCOUNTS);
  const byId = Object.fromEntries(butterflyFacts(flies, settle, NOW).map((f) => [f.id, f]));

  it("平仓单并进开仓那一笔:5.4 买、4.55 卖 → 亏 15.7%", () => {
    expect(byId["ib:102"]).toBeUndefined();
    expect(byId["ib:101"]).toMatchObject({
      how: "closed", result: "loss", return_pct: -15.7, entry_price: 5.4, exit_price: 4.55,
      label: "SPX 7625/7650/7675 看跌蝴蝶 买入", closed_at: "2026-09-10T15:04:15+00:00", note: "",
    });
  });

  it("没平的到期按到期日收盘结算:收 7682 → 帐篷值 18,3.55 买的赚 407%", () => {
    expect(byId["ib:103"]).toMatchObject({ how: "expired", result: "win", exit_price: 18, return_pct: 407 });
  });

  it("结算价取不到:结果不明,原因写明,不猜", () => {
    expect(byId["ib:104"]).toMatchObject({
      how: "expired", result: "unknown", exit_price: null, return_pct: null,
      note: "取不到 SPX 2026-09-04 的收盘价,结算结果不明",
    });
  });

  it("没到期、没平:持仓中,不给收益率", () => {
    expect(byId["ib:105"]).toMatchObject({ how: "open", result: "open", return_pct: null, closed_at: null });
  });

  it("要查结算价的只有没平仓、已过到期日的", () => {
    expect(settlementsNeeded(flies, NOW)).toEqual([
      { symbol: "SPX", date: "2026-09-04" },
      { symbol: "SPX", date: "2026-09-10" },
    ]);
  });
});

describe("tradeOutcomes:股票", () => {
  const facts = stockFacts(groupStockTrips(STOCK_FILLS, ACCOUNTS, null));

  it("平掉的按已实现盈亏对成本算;成本不明的不编;持仓中的不给收益率", () => {
    expect(facts.map((f) => [f.symbol, f.how, f.result, f.return_pct])).toEqual([
      ["AMD", "closed", "loss", -10],
      ["RKLB", "closed", "unknown", null],
      ["NVO", "closed", "win", 2.3],
      ["RKLB", "open", "open", null],
    ]);
    expect(facts[1]!.note).toContain("成本不明");
    expect(facts.every((f) => f.note.includes("期初持仓未核对"))).toBe(true);
  });

  it("收益率在 ±0.5% 以内算持平", () => {
    const flat = stockFacts(groupStockTrips([
      stockFill("MU", "BOT", 10, 100.0, "2026-09-15T14:00:00+00:00", 301),
      stockFill("MU", "SLD", 10, 100.3, "2026-09-15T15:00:00+00:00", 302),
    ], ACCOUNTS, null));
    expect(flat[0]).toMatchObject({ result: "flat", return_pct: 0.3 });
  });
});

describe("tradeOutcomes:发给模型的文本", () => {
  const facts = collectFacts(
    groupButterflies(FLY_FILLS, ACCOUNTS), groupStockTrips(STOCK_FILLS, ACCOUNTS, null), settle, NOW,
  );

  it("新的在前;按标的筛", () => {
    expect(facts[0]!.id).toBe("ib:105");
    expect(facts.map((f) => f.opened_at)).toEqual([...facts.map((f) => f.opened_at)].sort().reverse());
    const only = collectFacts(
      groupButterflies(FLY_FILLS, ACCOUNTS), groupStockTrips(STOCK_FILLS, ACCOUNTS, null), settle, NOW, ["nvo"],
    );
    expect(only.map((f) => f.symbol)).toEqual(["NVO"]);
  });

  it("一行:日期、类别、结构、价格、结局、收益率;没有数量、金额、账户", () => {
    const line = factLine(facts.find((f) => f.id === "ib:101")!);
    expect(line).toBe("[2026-09-10 | 蝴蝶] SPX 7625/7650/7675 看跌蝴蝶 买入 @5.4 → 平仓 @4.55(2026-09-10):亏 -15.7%");
    const all = facts.map(factLine).join("\n");
    for (const leak of ["张", ACCT, "主账户", "$"]) expect(all).not.toContain(leak);
  });

  it("胜负由代码数好", () => {
    expect(tallyLine(facts)).toBe("共 8 笔:赚 2、亏 2、持平 0、未了结 2、结果不明 2");
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

function makeServer(opts: { connected?: boolean; fills?: Rec[]; positions?: Rec[] } = {}): {
  s: RpcServer; parser: FakeParser; call: (m: string, p?: Rec) => Promise<Rec>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-trade-outcomes-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base,
    accounts: [{ alias: "主账户", account_id: ACCT, is_paper: false, connection: "paper", default: true }],
    storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  const parser = new FakeParser();
  s.parserFactory = () => parser as never;
  s.engine.store.rememberFills(opts.fills ?? [...FLY_FILLS, ...STOCK_FILLS]);
  if (opts.connected ?? true) {
    s.router = {
      sessions: () => [{}], connectedNames: () => ["paper"],
      ...(opts.positions ? { positions: async () => opts.positions } : {}),
    } as never;
    (s.market as unknown as Rec)["dailyHistory"] = async (symbol: string): Promise<Rec[]> =>
      symbol === "SPX" ? [{ date: "2026-09-09", close: 7600 }, { date: "2026-09-10", close: 7682 }] : [];
  }
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, parser, call };
}

async function archivedIdea(call: (m: string, p?: Rec) => Promise<Rec>, text: string): Promise<string> {
  const made = (await call("ideas.add", { text }))["result"]["idea"];
  await call("ideas.update", { id: made["id"], status: "archived" });
  return made["id"];
}

describe("ideas.digest(trades):RPC", () => {
  it("附带交易结果:换提示词、胜负与逐笔结果跟在想法后面、落库带 trades", async () => {
    const { parser, call } = makeServer();
    await archivedIdea(call, "SPX 蝴蝶持有到结算");
    const row = (await call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    const { system, user } = parser.calls.at(-1)!;
    expect(system).toContain("交易结果是事实");
    expect(system).toContain("actions 最多 6 条"); // 交易一多模型会超上限,整份被复验拒掉
    expect(system).not.toContain("不要编造'赚了/亏了'");
    expect(user.startsWith("共 1 条想法,按时间从早到晚:")).toBe(true);
    expect(user).toContain("交易结果(软件从券商逐笔成交算出,是事实;共 8 笔:赚 2、亏 2、持平 0、未了结 2、结果不明 2)");
    expect(user.indexOf("7800/7820/7840")).toBeLessThan(user.indexOf("7625/7650/7675")); // 从早到晚
    expect(user).toContain("到期结算价值 @18(2026-09-10):赚 +407%");
    expect(user).not.toContain(ACCT);
    expect(row["trades"]).toHaveLength(8);
    const listed = (await call("ideas.digests"))["result"]["digests"];
    expect(listed[0]["trades"]).toEqual(row["trades"]);
  });

  it("焦点带标的:只附这些标的的交易", async () => {
    const { parser, call } = makeServer();
    await archivedIdea(call, "NVO 回调买入");
    const row = (await call("ideas.digest", { scope: "all", trades: true, focus: { symbols: ["NVO"] } }))["result"]["digest"];
    expect(row["trades"].map((t: Rec) => t["symbol"])).toEqual(["NVO"]);
    expect(parser.calls.at(-1)!.user).toContain("共 1 笔:赚 1");
  });

  it("没连券商:到期的蝴蝶取不到结算价,记成结果不明,总结照做", async () => {
    const { call } = makeServer({ connected: false });
    await archivedIdea(call, "随便一条");
    const row = (await call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    const expired = row["trades"].filter((t: Rec) => t["how"] === "expired");
    expect(expired.map((t: Rec) => t["result"])).toEqual(["unknown", "unknown"]);
  });

  it("没有想法但有交易:照样总结;两样都没有:还是原来那句", async () => {
    const withTrades = makeServer();
    const row = (await withTrades.call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    expect(row["idea_ids"]).toEqual([]);
    expect(withTrades.parser.calls.at(-1)!.user.startsWith("这个范围内没有想法,只有交易结果。")).toBe(true);

    const empty = makeServer({ fills: [] });
    expect((await empty.call("ideas.digest", { scope: "all", trades: true }))["error"]).toEqual({
      code: -32602, message: "没有可总结的想法。先把几条想法归档或标记完成,再来总结。",
    });
  });

  it("不带 trades(或 false):提示词与回包一字不变,行里没有 trades 键", async () => {
    const { parser, call } = makeServer();
    await archivedIdea(call, "SPX 蝴蝶持有到结算");
    for (const params of [{ scope: "all" }, { scope: "all", trades: false }]) {
      const row = (await call("ideas.digest", params))["result"]["digest"];
      expect(row).not.toHaveProperty("trades");
      expect(parser.calls.at(-1)!.system).toContain("不要编造'赚了/亏了'");
      expect(parser.calls.at(-1)!.user).not.toContain("交易结果");
    }
    expect((await call("ideas.digests"))["result"]["digests"].every((d: Rec) => !("trades" in d))).toBe(true);
  });

  it("股票持仓段与交易分析页同一份:连着券商、当前不持有时,先卖后买回认得出是做空", async () => {
    const shortFills = [
      stockFill("ORC", "SLD", 25, 170.9, "2026-04-15T14:04:23+00:00", 401),
      stockFill("ORC", "BOT", 25, 175.0, "2026-04-15T18:57:56+00:00", 402),
    ];
    const held = makeServer({ fills: shortFills, positions: [] });
    await archivedIdea(held.call, "随便一条");
    const row = (await held.call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    expect(row["trades"].map((t: Rec) => [t["label"], t["result"], t["return_pct"]])).toEqual([["ORC 做空", "loss", -2.4]]);

    // 读不到持仓(没有 positions):先卖的部分按卖出老仓位算,成本不明,不编
    const blind = makeServer({ fills: shortFills });
    await archivedIdea(blind.call, "随便一条");
    const guessed = (await blind.call("ideas.digest", { scope: "all", trades: true }))["result"]["digest"];
    expect(guessed["trades"].map((t: Rec) => t["result"])).toEqual(["open", "unknown"]);
  });

  it("trades 不是布尔:结构错归 schema", async () => {
    const { call } = makeServer();
    expect((await call("ideas.digest", { scope: "all", trades: "yes" }))["error"]["code"]).toBe(-32602);
  });
});
