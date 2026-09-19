/** 股票交易复盘:成交 → 一段段持仓(groupStockTrips),再加 K 线 → 复盘(reviewStock)。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RpcError, RpcServer } from "../src/rpc.js";
import * as sr from "../src/stockreview.js";
import { ReviewError } from "../src/tradereview.js";

type Rec = Record<string, any>;

const ACCT = "U1234567";
const ACCOUNTS = [{ alias: "主账户", account_id: ACCT, is_paper: false }];

let execSeq = 0;
/** time 写美东 "HH:MM[:SS]",这里换成成交行里那种 UTC ISO(2026-09-17 是夏令时,ET = UTC−4)。 */
function fill(symbol: string, side: "BOT" | "SLD", shares: number, price: number, et: string, perm: number, extra: Rec = {}): Rec {
  const [h, m, s = "00"] = et.split(":");
  const utc = `2026-09-17T${String(Number(h) + 4).padStart(2, "0")}:${m}:${s}+00:00`;
  execSeq += 1;
  return {
    account_id: ACCT, exec_id: `e${execSeq}`, perm_id: perm, order_id: null, side, shares, price, time: utc, commission: 0,
    contract: { secType: "STK", symbol, currency: "USD", exchange: "SMART", conId: 1 },
    ...extra,
  };
}

/** 09:30 起的 1 分钟线;path(i) 给第 i 根的收盘,高低各外扩 0.1。 */
function bars(count: number, path: (i: number) => number): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < count; i += 1) {
    const minutes = 9 * 60 + 30 + i;
    const close = path(i);
    out.push({
      time: `2026-09-17 ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
      open: close, high: Math.round((close + 0.1) * 100) / 100, low: Math.round((close - 0.1) * 100) / 100, close, volume: 1000,
    });
  }
  return out;
}

const NOW = Date.parse("2026-09-17T20:30:00+00:00");

describe("groupStockTrips:成交 → 一段段持仓", () => {
  it("一买一卖 = 一笔;同一订单的几笔成交并成一次出手,价格按数量加权", () => {
    const trips = sr.groupStockTrips([
      fill("RKLB", "BOT", 7, 64.0, "10:00", 1001),
      fill("RKLB", "BOT", 93, 65.0, "10:00", 1001),
      fill("RKLB", "SLD", 100, 67.0, "11:00", 1002),
    ], ACCOUNTS, {});
    expect(trips).toHaveLength(1);
    const t = trips[0]!;
    expect(t).toMatchObject({
      id: "stk:p1001", kind: "stock", symbol: "RKLB", side: "LONG", status: "closed", carried: false, opening_assumed: false,
      qty: 100, entry_qty: 100, exit_qty: 100, open_qty: 0, avg_entry: 64.93, avg_exit: 67, realized_pnl: 207,
    });
    expect(t["entries"]).toHaveLength(1);
    expect(t["entries"][0]).toMatchObject({ qty: 100, price: 64.93, action: "BUY" });
    expect(t["entries"][0]["exec_ids"]).toHaveLength(2);
    expect(t["account"]).toEqual({ alias: "主账户", account_id: ACCT, is_paper: false });
    expect(t["closed_at"]).toBe(t["exits"][0]["time"]);
    expect(t).not.toHaveProperty("started_at_ms");
  });

  it("加仓摊均价、减仓不动均价;没平完的算持仓中", () => {
    const [t] = sr.groupStockTrips([
      fill("NVO", "BOT", 100, 40.0, "10:00", 1),
      fill("NVO", "BOT", 100, 44.0, "10:30", 2), // 均价 42
      fill("NVO", "SLD", 50, 46.0, "11:00", 3), // +200
      fill("NVO", "SLD", 50, 41.0, "11:30", 4), // −50
    ], ACCOUNTS, { [sr.holdingKey(ACCT, "NVO")]: 100 });
    expect(t).toMatchObject({
      side: "LONG", status: "open", qty: 200, entry_qty: 200, exit_qty: 100, open_qty: 100,
      avg_entry: 42, avg_exit: 43.5, realized_pnl: 150, realized_qty: 100, closed_at: null,
    });
    expect(t!["entries"]).toHaveLength(2);
    expect(t!["exits"]).toHaveLength(2);
  });

  it("做空:先卖后买,盈亏反号", () => {
    const [t] = sr.groupStockTrips([
      fill("UBER", "SLD", 50, 71.0, "10:00", 1),
      fill("UBER", "BOT", 50, 69.0, "11:00", 2),
    ], ACCOUNTS, {});
    expect(t).toMatchObject({ side: "SHORT", status: "closed", avg_entry: 71, avg_exit: 69, realized_pnl: 100 });
    expect(t!["summary"]).toContain("做空 UBER 50 股");
  });

  it("一笔成交把仓位打穿:拆成平掉旧的一笔 + 反向另起一笔(id 带 :r)", () => {
    const trips = sr.groupStockTrips([
      fill("TSLA", "BOT", 100, 400.0, "10:00", 1),
      fill("TSLA", "SLD", 150, 410.0, "11:00", 2),
    ], ACCOUNTS, { [sr.holdingKey(ACCT, "TSLA")]: -50 });
    expect(trips.map((t) => [t["id"], t["side"], t["status"], t["qty"]])).toEqual([
      ["stk:p1", "LONG", "closed", 100],
      ["stk:p2:r", "SHORT", "open", 50],
    ]);
    expect(trips[0]!["realized_pnl"]).toBe(1000);
    expect(trips[1]!["avg_entry"]).toBe(410);
  });

  it("期初仓位靠当前持仓反推:卖的是更早买的货 → carried,只有出场、没有成本与盈亏", () => {
    const rows = [
      fill("RKLB", "SLD", 100, 67.94, "12:35", 1),
      fill("RKLB", "BOT", 100, 64.51, "15:40", 2),
    ];
    // 现在还拿着 100 股 → 期初 = 100 − (−100 + 100) = 100:那笔卖出平的是老仓位,后面的买入是新开的一笔
    const held = sr.groupStockTrips(rows, ACCOUNTS, { [sr.holdingKey(ACCT, "RKLB")]: 100 });
    expect(held.map((t) => [t["side"], t["status"], t["carried"], t["avg_entry"], t["realized_pnl"]])).toEqual([
      ["LONG", "closed", true, null, null],
      ["LONG", "open", false, 64.51, 0],
    ]);
    expect(held[0]!["summary"]).toContain("建仓早于已同步的成交");
    expect(held[0]!["entries"]).toEqual([]);

    // 现在空仓 → 期初 0:同样两笔成交就是一次做空再买回
    const flat = sr.groupStockTrips(rows, ACCOUNTS, {});
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ side: "SHORT", status: "closed", carried: false, realized_pnl: 343 });
  });

  it("拿不到当前持仓(没连券商):每一笔都标 opening_assumed,先卖的按卖出老仓位算——卖出不等于卖空", () => {
    // 真机上见过:没连 TWS 时这一笔被读成「卖空 200 股 · 持仓中 200 股」,其实是把手里的货卖了
    const [msty, ...rest] = sr.groupStockTrips([fill("MSTY", "SLD", 200, 14.565, "12:35", 1)], ACCOUNTS, null);
    expect(rest).toEqual([]);
    expect(msty).toMatchObject({
      side: "LONG", status: "closed", opening_assumed: true, carried: true, carried_qty: 200,
      open_qty: 0, avg_entry: null, avg_exit: 14.565, realized_pnl: null,
    });
    expect(msty!["summary"]).toContain("卖出 MSTY 200 股");
    expect(msty!["summary"]).toContain("期初持仓未核对");
    expect(msty!["summary"]).not.toContain("做空");

    // 先卖后买:不是"做空再买回赚 343",是卖掉老仓位、再新开一笔;那笔盈亏不编
    const trips = sr.groupStockTrips([
      fill("RKLB", "SLD", 100, 67.94, "12:35", 1),
      fill("RKLB", "BOT", 100, 64.51, "15:40", 2),
    ], ACCOUNTS, null);
    expect(trips.map((t) => [t["side"], t["status"], t["carried"], t["avg_entry"], t["realized_pnl"], t["opening_assumed"]])).toEqual([
      ["LONG", "closed", true, null, null, true],
      ["LONG", "open", false, 64.51, 0, true],
    ]);

    // 卖得比买得多:多出来的那部分才是老仓位,只补"刚好够卖"的数量
    const [mixed] = sr.groupStockTrips([
      fill("AAPL", "BOT", 50, 230.0, "10:00", 1),
      fill("AAPL", "SLD", 150, 235.0, "11:00", 2),
    ], ACCOUNTS, null);
    expect(mixed).toMatchObject({ side: "LONG", carried: true, carried_qty: 100, qty: 150, status: "closed", realized_pnl: null });
  });

  it("老仓位上加仓:carried 且均价未知;先平掉的部分算在这一段里", () => {
    const [t] = sr.groupStockTrips([
      fill("AAPL", "BOT", 50, 230.0, "10:00", 1),
      fill("AAPL", "SLD", 150, 235.0, "11:00", 2),
    ], ACCOUNTS, {}); // 期初 = 0 − (50 − 150) = 100
    expect(t).toMatchObject({ carried: true, carried_qty: 100, qty: 150, status: "closed", avg_entry: null, realized_pnl: null });
  });

  it("只认股票;数量 / 价格 / 时间不对的行跳过;不同账户、不同股票各算各的,按开始时间升序", () => {
    const trips = sr.groupStockTrips([
      fill("SPX", "BOT", 1, 3.5, "09:40", 9, { contract: { secType: "BAG", symbol: "SPX" } }),
      fill("NVO", "BOT", 0, 43.0, "09:45", 8),
      fill("NVO", "BOT", 10, 43.0, "09:50", 7, { time: "不是时间" }),
      fill("NVO", "BOT", 100, 43.27, "14:05", 3),
      fill("RKLB", "BOT", 100, 64.51, "10:40", 4),
      fill("RKLB", "BOT", 10, 64.0, "10:45", 5, { account_id: "DU999" }),
    ], ACCOUNTS, null);
    expect(trips.map((t) => [t["symbol"], t["account"]["alias"], t["qty"]])).toEqual([
      ["RKLB", "主账户", 100],
      ["RKLB", "未配置账户 DU999", 10],
      ["NVO", "主账户", 100],
    ]);
    expect(trips[1]!["account"]["is_paper"]).toBe(true);
  });
});

describe("reviewStock:一段持仓 + K 线 → 复盘", () => {
  // 09:30 起 120 根:先从 100 跌到 98(第 20 根),涨到 106(第 70 根),再回落到 103
  const path = (i: number): number => {
    if (i <= 20) return 100 - i * 0.1;
    if (i <= 70) return 98 + (i - 20) * 0.16;
    return Math.round((106 - (i - 70) * 0.06) * 100) / 100;
  };
  const BARS = bars(120, path);

  it("做多一进一出:进出位置、最大浮盈浮亏、兑现率、卖出之后,数字都能对上", () => {
    const [trip] = sr.groupStockTrips([
      fill("RKLB", "BOT", 100, 98.5, "09:55", 1), // 第 25 根附近,低位
      fill("RKLB", "SLD", 100, 104.0, "10:30", 2), // 第 60 根,还没到顶
    ], ACCOUNTS, {});
    const r = sr.reviewStock(trip!, BARS, "1m", NOW);
    expect(r["kind"]).toBe("stock");
    expect(r["profile"]).toMatchObject({ symbol: "RKLB", side: "LONG", side_label: "做多", qty: 100, avg_entry: 98.5, avg_exit: 104, cost: 9850 });
    expect(r["outcome"]).toMatchObject({ kind: "closed", price: 104, realized_pnl: 550, pnl: 550, pnl_pct: 5.58, time_et: "2026-09-17 10:30" });
    expect(r["entry"]).toMatchObject({ time_et: "2026-09-17 09:55", known: true, bar_time: "2026-09-17 09:55" });

    const s = r["stats"];
    expect(s["hold_bars"]).toBe(36);
    expect(s["mfe"]["price"]).toBeCloseTo(104.5, 6); // 第 60 根的最高
    expect(s["mfe"]["amount"]).toBeCloseTo(600, 6);
    expect(s["mae"]["per_share"]).toBe(0); // 买入之后最低 98.7,没跌破成本
    expect(s["capture_ratio"]).toBeCloseTo(0.917, 3);
    expect(s["capture_pct"]).toBe(92); // 文字和界面共用的整数
    expect(r["profile"]["entries"][0]["time_et"]).toBe("2026-09-17 09:55");
    expect(r["findings"].find((f: Rec) => f["title"] === "出场位置")["text"]).toContain("兑现了最大浮盈的 92%");
    expect(s["entry_position"]).toBe(1);
    expect(s["exit_position"]).toBeGreaterThan(0.9);
    expect(s["pre_entry_move"]).toBeLessThan(0); // 买之前在跌:逆势接回调
    expect(s["post_entry_move"]).toBeGreaterThan(0);
    expect(s["post_exit"]["bars"]).toBe(20);
    expect(s["post_exit"]["missed"]["price"]).toBeCloseTo(106.1, 6); // 卖出后还涨到了顶
    expect(s["post_exit"]["avoided"]["per_share"]).toBe(0);

    const titles = r["findings"].map((f: Rec) => f["title"]);
    expect(titles).toEqual(["结构", "开仓前走势", "进场位置", "开仓后走势", "持有期", "出场位置", "卖出之后", "平仓"]);
    const tone = (title: string) => r["findings"].find((f: Rec) => f["title"] === title)["tone"];
    expect(tone("进场位置")).toBe("good");
    expect(tone("出场位置")).toBe("good");
    expect(tone("卖出之后")).toBe("warn"); // 卖早了
    expect(tone("平仓")).toBe("good");
    expect(r["findings"].find((f: Rec) => f["title"] === "开仓前走势")["text"]).toContain("逆着走势接回调");

    // 图:每次出手一个标记(价格是成交价,不是 K 线收盘)+ 两条均价线
    expect(r["series"]["markers"]).toEqual([
      { kind: "entry", action: "BUY", time: "2026-09-17 09:55", price: 98.5, qty: 100 },
      { kind: "exit", action: "SELL", time: "2026-09-17 10:30", price: 104, qty: 100 },
    ]);
    expect(r["series"]["levels"]).toEqual([{ kind: "avg_entry", price: 98.5 }, { kind: "avg_exit", price: 104 }]);
    expect(r["series"]["bars"][0]["time"]).toBe("2026-09-17 09:30"); // 开仓前最多回看 40 根,这里只有 25 根
    expect(r["series"]["bars"].at(-1)["time"]).toBe("2026-09-17 10:50"); // 平仓后再看 20 根
    expect(r["notes"]).toEqual([]);
  });

  it("做空亏损:方向全部反过来,扛的浮亏比拿到的浮盈大两倍以上要点名", () => {
    const [trip] = sr.groupStockTrips([
      fill("RKLB", "SLD", 100, 98.2, "09:48", 1), // 卖在低位附近,两根之后见底 97.9
      fill("RKLB", "BOT", 100, 105.0, "10:35", 2),
    ], ACCOUNTS, {});
    const r = sr.reviewStock(trip!, BARS, "1m", NOW);
    expect(r["outcome"]).toMatchObject({ kind: "closed", realized_pnl: -680 });
    expect(r["stats"]["mfe"]["per_share"]).toBeCloseTo(0.3, 6); // 最低到过 97.9
    expect(r["stats"]["mae"]["price"]).toBeGreaterThan(105);
    expect(r["stats"]["entry_position"]).toBeLessThan(0.1); // 空在区间最低处
    const by = Object.fromEntries(r["findings"].map((f: Rec) => [f["title"], f]));
    expect(by["进场位置"]["tone"]).toBe("warn");
    expect(by["持有期"]["tone"]).toBe("warn");
    expect(by["持有期"]["text"]).toContain("两倍以上");
    expect(by["出场位置"]["text"]).toContain("亏着出来");
    expect(by["平仓"]["tone"]).toBe("bad");
    expect(by["结构"]["text"]).toContain("做空 RKLB 100 股,卖空均价 98.2");
  });

  it("持仓中:按最后一根 K 线算浮动盈亏;已减仓的部分算已实现", () => {
    const [trip] = sr.groupStockTrips([
      fill("NVO", "BOT", 100, 99.0, "09:40", 1),
      fill("NVO", "SLD", 40, 105.0, "10:35", 2),
    ], ACCOUNTS, { [sr.holdingKey(ACCT, "NVO")]: 60 });
    const r = sr.reviewStock(trip!, BARS, "1m", NOW);
    const last = BARS.at(-1)!["close"];
    expect(r["outcome"]).toMatchObject({ kind: "open", time: null, open_qty: 60, realized_pnl: 240 });
    expect(r["outcome"]["unrealized_pnl"]).toBeCloseTo((last - 99) * 60, 6);
    expect(r["outcome"]["pnl"]).toBeCloseTo(240 + (last - 99) * 60, 6);
    expect(r["stats"]["hold_bars"]).toBe(110); // 一直算到最后一根
    expect(r["findings"].at(-1)).toMatchObject({ title: "持仓中", tone: "info" });
    expect(r["findings"].at(-1)["text"]).toContain("还持有 60 股");
  });

  it("只有出场(carried):不编成本,只看出场前后的走势", () => {
    const [trip] = sr.groupStockTrips([fill("UBER", "SLD", 50, 105.5, "10:38", 1)], ACCOUNTS, {});
    expect(trip!["carried"]).toBe(true);
    const r = sr.reviewStock(trip!, BARS, "1m", NOW);
    expect(r["entry"]["known"]).toBe(false);
    expect(r["outcome"]).toMatchObject({ kind: "closed", pnl: null, realized_pnl: null, price: 105.5 });
    expect(r["stats"]["mfe"]).toBeNull();
    expect(r["stats"]["hold_bars"]).toBeNull();
    expect(r["stats"]["pre_exit_move"]).toBeGreaterThan(0); // 趁涨卖的
    expect(r["findings"].map((f: Rec) => f["title"])).toEqual(["只有出场", "出场前走势", "卖出之后", "平仓"]);
    expect(r["findings"][1]["tone"]).toBe("good");
    expect(r["findings"][3]["text"]).toContain("盈亏未知");
    expect(r["notes"][0]).toContain("建仓早于已同步的成交");
    expect(r["series"]["levels"]).toEqual([{ kind: "avg_exit", price: 105.5 }]);
  });

  it("期初仓位没核对过、加过仓:notes 里都要说", () => {
    const [trip] = sr.groupStockTrips([
      fill("NVO", "BOT", 50, 99.0, "09:40", 1),
      fill("NVO", "BOT", 50, 101.0, "10:00", 2),
    ], ACCOUNTS, null);
    const r = sr.reviewStock(trip!, BARS, "1m", NOW);
    expect(r["notes"].some((n: string) => n.includes("方向可能认反"))).toBe(true);
    expect(r["notes"].some((n: string) => n.includes("中途加过仓"))).toBe(true);
    expect(r["series"]["markers"]).toHaveLength(2);
  });

  it("横盘里进出:涨跌不到万分之五不硬分顺势逆势(真机上见过「下跌 0,是逆着走势接回调的」)", () => {
    const flatBars = bars(120, (i) => (i < 60 ? 50 : 50 + (i - 60) * 0.05));
    const [trip] = sr.groupStockTrips([fill("NVO", "BOT", 100, 50.0, "10:00", 1)], ACCOUNTS, { [sr.holdingKey(ACCT, "NVO")]: 100 });
    const by = Object.fromEntries(sr.reviewStock(trip!, flatBars, "1m", NOW)["findings"].map((f: Rec) => [f["title"], f]));
    expect(by["开仓前走势"]).toMatchObject({ tone: "info" });
    expect(by["开仓前走势"]["text"]).toContain("基本没动");
    expect(by["开仓前走势"]["text"]).not.toContain("接回调");
    expect(by["开仓后走势"]["text"]).toContain("基本没动");
  });

  it("K 线没覆盖到这笔交易、记录不是股票:报 ReviewError", () => {
    const [trip] = sr.groupStockTrips([fill("RKLB", "BOT", 100, 98.5, "15:00", 1)], ACCOUNTS, {});
    expect(() => sr.reviewStock(trip!, BARS, "1m", NOW)).toThrowError(ReviewError);
    expect(() => sr.reviewStock(trip!, [], "1m", NOW)).toThrowError("没有 K 线");
    expect(() => sr.reviewStock({ kind: "butterfly" }, BARS, "1m", NOW)).toThrowError("不是股票交易");
  });

  it("窗口太长要抽稀时,每次出手所在的那根 K 线一定留着", () => {
    const long = bars(389, (i) => 100 + Math.sin(i / 15) * 3);
    const [trip] = sr.groupStockTrips([
      fill("RKLB", "BOT", 100, 100.0, "09:41", 1),
      fill("RKLB", "BOT", 50, 101.0, "11:13", 2),
      fill("RKLB", "SLD", 150, 102.0, "15:37", 3),
    ], ACCOUNTS, {});
    const r = sr.reviewStock(trip!, long, "1m", NOW);
    const times = new Set(r["series"]["bars"].map((b: Rec) => b["time"]));
    expect(r["series"]["bars"].length).toBeLessThan(300);
    for (const m of r["series"]["markers"]) expect(times.has(m["time"]), m["time"]).toBe(true);
  });
});

describe("review.candidates / review.analyze:股票和蝴蝶走同一对接口", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const BARS = bars(120, (i) => 64 + i * 0.03);

  function server(positions: Rec[] | null): RpcServer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-stkreview-"));
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    (s as any).engine.store.rememberFills([
      fill("RKLB", "SLD", 100, 67.94, "09:35", 1), // 卖的是更早买的货
      fill("RKLB", "BOT", 100, 64.51, "10:40", 2),
      fill("NVO", "BOT", 50, 65.0, "10:05", 3),
      fill("NVO", "SLD", 50, 66.5, "11:00", 4),
    ]);
    if (positions !== null) {
      (s as any).router = { sessions: () => [{}], executions: async () => [], positions: async () => positions };
      (s.market as any).paBars = async () => [BARS];
    }
    return s;
  }
  const held = [{ account: "主账户", symbol: "RKLB", sec_type: "STK", quantity: 100 }, { account: "主账户", symbol: "RKLB", sec_type: "OPT", quantity: 3 }];

  it("候选列表:一段持仓一行,新的在前;期初仓位按当前持仓反推(期权持仓不算数)", async () => {
    const out = await server(held).domains.review.reviewCandidates({});
    const rows = (out["candidates"] as Rec[]).filter((c) => c["kind"] === "stock");
    expect(rows.map((c) => [c["symbol"], c["side"], c["status"], c["carried"], c["opening_assumed"], c["pnl"]])).toEqual([
      ["RKLB", "LONG", "open", false, false, null],
      ["NVO", "LONG", "closed", false, false, 75],
      ["RKLB", "LONG", "closed", true, false, null],
    ]);
    expect(rows.every((c) => String(c["id"]).startsWith("stk:") && c["source"] === "ibkr" && c["account"] === "主账户")).toBe(true);
    expect(out["fills_stored"]).toBe(4);
  });

  it("没连券商:照样列(库里攒的成交),但每一笔都标期初持仓未核对;分析要 K 线,得先连", async () => {
    const s = server(null);
    const out = await s.domains.review.reviewCandidates({});
    const rows = out["candidates"] as Rec[];
    expect(rows.map((c) => [c["symbol"], c["side"], c["status"], c["carried"], c["opening_assumed"], c["pnl"]])).toEqual([
      ["RKLB", "LONG", "open", false, true, null],
      ["NVO", "LONG", "closed", false, true, 75],
      ["RKLB", "LONG", "closed", true, true, null], // 不知道手里有多少,但先卖的不读成卖空:按卖出老仓位算,盈亏不编
    ]);
    await expect(s.domains.review.reviewAnalyze({ id: rows[0]!["id"] })).rejects.toBeInstanceOf(RpcError);
  });

  it("读不到持仓(券商报错)≠ 空仓:退到期初未核对,不拿空表去反推", async () => {
    const s = server(held);
    const { BrokerError } = await import("../src/broker.js");
    (s as any).router.positions = async () => { throw new BrokerError("读不到持仓:超时"); };
    const rows = (await s.domains.review.reviewCandidates({}))["candidates"] as Rec[];
    expect(rows.every((c) => c["opening_assumed"] === true)).toBe(true);
  });

  it("分析:stk: 开头的 id 走股票复盘;id 对不上给明白话", async () => {
    const s = server(held);
    const rows = (await s.domains.review.reviewCandidates({}))["candidates"] as Rec[];
    const nvo = rows.find((c) => c["symbol"] === "NVO")!;
    const r = await s.domains.review.reviewAnalyze({ id: nvo["id"], timeframe: "1m" });
    expect(r).toMatchObject({ kind: "stock", record_id: nvo["id"], source: "ibkr", account: "主账户", timeframe_label: "1 分钟" });
    expect(r["outcome"]).toMatchObject({ kind: "closed", realized_pnl: 75 });
    expect(r["series"]["markers"]).toHaveLength(2);
    expect("exit_plan" in r).toBe(false); // 止盈策略回放是蝴蝶的事
    await expect(s.domains.review.reviewAnalyze({ id: "stk:p999" })).rejects.toThrowError("不在已同步的成交里");
    await expect(s.domains.review.reviewAnalyze({ id: nvo["id"], timeframe: "7m" })).rejects.toThrowError("未知 K 线周期");
  });
});
