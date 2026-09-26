/** review.* 在 RPC 这一层的特征测试:走完整的 handle() 路径(过入参校验),不是直接调域对象。
 *
 * 算法那几半各有各的钉子:蝴蝶复盘在 golden-tradereview,股票复盘在 stockreview.spec(那一份调的是 domains.review.*,
 * 绕过了入参这一段)。这里补的是从 RPC 进来这一段:候选行的完整键集、没连券商时的降级、几句报错的原话与错误码,
 * 以及 limit / include_local / timeframe 这几个入参怎么认。
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商是假的,K 线是假的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const ACCT = "U1234567";
let execSeq = 0;

/** 一条券商成交行。time 写美东 "HH:MM",换成成交行里那种 UTC ISO(2026-09-17 是夏令时,ET = UTC−4)。 */
function fill(symbol: string, side: "BOT" | "SLD", shares: number, price: number, et: string, perm: number): Rec {
  const [h, m] = et.split(":");
  execSeq += 1;
  return {
    account_id: ACCT, exec_id: `e${execSeq}`, perm_id: perm, order_id: null, side, shares, price,
    time: `2026-09-17T${String(Number(h) + 4).padStart(2, "0")}:${m}:00+00:00`, commission: 0,
    contract: { secType: "STK", symbol, currency: "USD", exchange: "SMART", conId: 1 },
  };
}

/** 09:30 起的 1 分钟线。 */
function bars(count: number, at: (i: number) => number): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < count; i += 1) {
    const minutes = 9 * 60 + 30 + i;
    const close = at(i);
    out.push({
      time: `2026-09-17 ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
      open: close, high: Math.round((close + 0.1) * 100) / 100, low: Math.round((close - 0.1) * 100) / 100, close, volume: 1000,
    });
  }
  return out;
}

const BARS = bars(120, (i) => 64 + i * 0.03);
const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-review-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base,
    accounts: [{ alias: "主账户", account_id: ACCT, is_paper: false, connection: "paper", default: true }],
    storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  s.engine.store.rememberFills([
    fill("RKLB", "SLD", 100, 67.94, "09:35", 1), // 卖的是更早买的货(期初仓位)
    fill("RKLB", "BOT", 100, 64.51, "10:40", 2),
    fill("NVO", "BOT", 50, 65.0, "10:05", 3),
    fill("NVO", "SLD", 50, 66.5, "11:00", 4),
  ]);
  if (opts.connected ?? true) {
    s.router = {
      sessions: () => [{}],
      connectedNames: () => ["paper"],
      executions: async () => [],
      positions: async () => [{ account: "主账户", symbol: "RKLB", sec_type: "STK", quantity: 100 }],
    } as never;
    (s.market as unknown as Rec)["paBars"] = async (): Promise<[Rec[], boolean]> => [BARS, false];
  }
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, call };
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

/** 股票那一类候选行的键(蝴蝶那一类另有 expiry / strikes 等,见契约)。 */
const STOCK_ROW_KEYS = [
  "account", "avg_entry", "avg_exit", "carried", "closed_at", "created_at", "entry_qty", "exit_qty", "filled",
  "final_status", "id", "intent_summary", "kind", "open_qty", "opening_assumed", "pnl", "qty", "side", "source",
  "status", "symbol",
];

describe("review.candidates", () => {
  it("回执:候选行 + 这次同步了几笔 + 库里一共几笔 + 券商那一路能不能用;一段持仓一行,新的在前", async () => {
    const { call } = makeServer();
    const r = (await call("review.candidates"))["result"];
    expect(Object.keys(r).sort()).toEqual(["candidates", "fills_stored", "ibkr_available", "synced"]);
    // ibkr_available:券商连着且支持成交查询(富途不支持,那时是 false)
    expect(r["ibkr_available"]).toBe(true);
    expect(r["synced"]).toBe(0); // 假券商的 executions 回空:这一轮没有新成交
    expect(r["fills_stored"]).toBe(4); // 库里一共攒了几笔(不是这次新增的)

    const rows = r["candidates"];
    expect(rows.every((c: Rec) => c["kind"] === "stock")).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(STOCK_ROW_KEYS);
    expect(rows.map((c: Rec) => [c["symbol"], c["side"], c["status"], c["pnl"], c["carried"]])).toEqual([
      ["RKLB", "LONG", "open", null, false],
      ["NVO", "LONG", "closed", 75, false],
      // 第一笔是卖:这一段接的是期初仓位(carried),成本不知道,所以盈亏不编
      ["RKLB", "LONG", "closed", null, true],
    ]);
    // 股票那一行的 id 认得出来:分析时按它分流
    expect(rows.every((c: Rec) => String(c["id"]).startsWith("stk:"))).toBe(true);
    expect(rows.every((c: Rec) => c["source"] === "ibkr" && c["account"] === "主账户" && c["filled"] === true)).toBe(true);
  });

  it("没连券商:照样从库里攒的成交列出来,但 ibkr_available 是 false、synced 是 null、期初未核对", async () => {
    const { call } = makeServer({ connected: false });
    const r = (await call("review.candidates"))["result"];
    expect(r["ibkr_available"]).toBe(false);
    expect(r["synced"]).toBeNull(); // 没去同步,不是同步了 0 笔
    expect(r["fills_stored"]).toBe(4); // 库里那几笔还在
    expect(r["candidates"]).toHaveLength(3);
    expect(r["candidates"].every((c: Rec) => c["opening_assumed"] === true)).toBe(true);
  });

  it("limit 截断:数字串照收,0 回落到默认;include_local 给真值也不改股票那几行", async () => {
    const { call } = makeServer();
    expect((await call("review.candidates", { limit: 2 }))["result"]["candidates"]).toHaveLength(2);
    expect((await call("review.candidates", { limit: "1" }))["result"]["candidates"]).toHaveLength(1);
    expect((await call("review.candidates", { limit: 0 }))["result"]["candidates"]).toHaveLength(3); // 0 → 默认 200
    const withLocal = (await call("review.candidates", { include_local: 1 }))["result"];
    // 库里没有本地蝴蝶记录,所以行数不变;这一条钉的是"给了真值也不报错、不改股票那几行"
    expect(withLocal["candidates"]).toHaveLength(3);
  });
});

describe("review.analyze", () => {
  it("股票复盘:走 stk: 那一路;回执带记录出处、周期名、结果与画图用的序列", async () => {
    const { call } = makeServer();
    const rows = (await call("review.candidates"))["result"]["candidates"];
    const nvo = rows.find((c: Rec) => c["symbol"] === "NVO");
    const r = (await call("review.analyze", { id: nvo["id"], timeframe: "1m" }))["result"];
    expect(r).toMatchObject({ kind: "stock", record_id: nvo["id"], source: "ibkr", account: "主账户", timeframe_label: "1 分钟" });
    expect(r["outcome"]).toMatchObject({ kind: "closed", realized_pnl: 75 });
    expect(r["series"]["markers"]).toHaveLength(2); // 买一次、卖一次
    expect("exit_plan" in r).toBe(false); // 止盈策略回放是蝴蝶的事
  });

  it("id 不存在 / 周期不认识 / 没连券商:各自那句原话(记录不存在是 -32005,golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    expect((await call("review.analyze", { id: "nope" }))["error"]).toEqual({ code: -32005, message: "记录不存在" });
    const rows = (await call("review.candidates"))["result"]["candidates"];
    const id = rows[1]["id"];
    expect((await call("review.analyze", { id, timeframe: "7m" }))["error"]["message"]).toContain("未知 K 线周期");
    expect((await call("review.analyze", { id: "stk:p999" }))["error"]["message"]).toContain("不在已同步的成交里");
    // exit 老 handler 是"不是对象就当没给":schema 不能比它严,给个字符串也要走到领域层
    expect((await call("review.analyze", { id: "nope", exit: "不是对象" }))["error"]).toEqual({ code: -32005, message: "记录不存在" });
    // 分析要 K 线:没连券商就先连
    const off = makeServer({ connected: false });
    const offRows = (await off.call("review.candidates"))["result"]["candidates"];
    const err = (await off.call("review.analyze", { id: offRows[1]["id"] }))["error"];
    expect(err["code"]).toBeLessThan(0);
    expect(typeof err["message"]).toBe("string");
  });

  it("timeframe 不给 = auto:自己按开仓离现在多远挑一个,回执里用中文名说清挑了哪个", async () => {
    const { call } = makeServer();
    const rows = (await call("review.candidates"))["result"]["candidates"];
    const auto = (await call("review.analyze", { id: rows[1]["id"] }))["result"];
    expect(typeof auto["timeframe_label"]).toBe("string");
    expect(auto["timeframe_label"]).not.toBe("");
    // 显式指定时,回执里的中文名跟着它走
    const fixed = (await call("review.analyze", { id: rows[1]["id"], timeframe: "1m" }))["result"];
    expect(fixed["timeframe_label"]).toBe("1 分钟");
  });
});

describe("review.analyze:蝴蝶 + 组合分钟线", () => {
  // 2026-09-25 真机那一张:SPX 7700/7720/7740 看跌蝶,12:16:55 以 3.15 买入,12:34:40 以 4.05 卖出(+90)
  const EXP = "20260925";
  function flyFills(perm: number, side: "BOT" | "SLD", price: number, legs: [number, number][], utc: string): Rec[] {
    const leg = (strike: number, legPrice: number, i: number, shares: number, legSide: string): Rec => ({
      account_id: ACCT, exec_id: `fly${perm}.${i}`, perm_id: perm, order_id: null, order_ref: "", side: legSide, shares,
      price: legPrice, time: utc, commission: 0,
      contract: { conId: 900 + strike, currency: "USD", exchange: "CBOE", expiry: EXP, multiplier: "100", right: "P",
        secType: "OPT", strike, symbol: "SPX", tradingClass: "SPXW" },
    });
    const flip = (s: string): string => (s === "BOT" ? "SLD" : "BOT");
    return [
      { account_id: ACCT, exec_id: `fly${perm}.0`, perm_id: perm, order_id: null, order_ref: "", side, shares: 1, price,
        time: utc, commission: 0,
        contract: { conId: 28812380, currency: "USD", exchange: "CBOE", expiry: "", multiplier: "0", right: "P",
          secType: "BAG", strike: null, symbol: "SPX", tradingClass: "" } },
      leg(7740, legs[0]![1], 1, 1, side), leg(7720, legs[1]![1], 2, 2, flip(side)), leg(7700, legs[2]![1], 3, 1, side),
    ];
  }
  const minute = (m: number): string => `2026-09-25 ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  // 标的:11:30 起,从 7760 一路走到 12:23 的 7732.74 附近再回去——只要把开仓 / 平仓时刻盖住
  const SPX: Rec[] = [];
  for (let m = 11 * 60 + 30; m <= 13 * 60; m += 1) {
    const close = m <= 12 * 60 + 23 ? 7760 - (m - (11 * 60 + 30)) * 0.515 : 7732.74 + (m - (12 * 60 + 23)) * 0.3;
    SPX.push({ time: minute(m), open: close, high: close + 0.5, low: close - 0.5, close: Math.round(close * 100) / 100, volume: 1 });
  }
  const TAPE: [number, number][] = [
    [736, 3.05], [737, 3.75], [738, 4.25], [739, 4.1], [740, 4.65], [741, 4.45], [742, 4.7], [743, 4.65], [744, 4.7],
    [745, 4.5], [746, 3.55], [753, 3.0], [754, 4.35], [755, 4.0],
  ];
  const FLY = TAPE.map(([m, close]) => ({ time: minute(m), open: close, high: close, low: close, close }));

  it("拿到组合分钟线:「曾有的机会」以持有期间的最高中间价开头(+155),不再说内在价值是下界", async () => {
    const { s, call } = makeServer();
    s.engine.store.rememberFills([
      ...flyFills(501, "BOT", 3.15, [[7740, 7.98], [7720, 3.05], [7700, 1.27]], "2026-09-25T16:16:55+00:00"),
      ...flyFills(502, "SLD", 4.05, [[7740, 12.99], [7720, 5.49], [7700, 2.04]], "2026-09-25T16:34:40+00:00"),
    ]);
    (s.market as unknown as Rec)["paBars"] = async (): Promise<[Rec[], boolean]> => [SPX, false];
    (s.router as unknown as Rec)["comboBars"] = async (): Promise<Rec[]> => FLY;
    const r = (await call("review.analyze", { id: "ib:501", timeframe: "1m" }))["result"];
    expect(r["outcome"]).toMatchObject({ kind: "closed", pnl: 90 });
    expect(r["stats"]["best_market"]).toEqual({ time: "2026-09-25 12:22", mid: 4.7, pnl: 155 });
    const f = r["findings"].find((x: Rec) => x["title"] === "曾有的机会");
    expect(f["text"].startsWith("持有期间组合中间价最高 4.7(2026-09-25 12:22),按它平仓 +155.00;最终结果 +90.00。")).toBe(true);
    expect(f["text"]).not.toContain("下界");
    expect(r["fly_series"]["source"]).toBe("ibkr");
  });
});
