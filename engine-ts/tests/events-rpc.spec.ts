/** 重要事件的 RPC 层(events.*)。全部离线:日历源换成假的取数函数。
 *
 * 钉住:
 *  1. events.list:内置 + 日历源 + 自定义合成一份,从昨天到两周后;日历源从没拉到过时同步等它,之后旧值先给、后台刷;
 *     拉失败不炸,原因在 feed.error 里,内置的照给。
 *  2. 关了日历源一个包都不发;关了整个功能清单里只剩空。
 *  3. 自定义事件:加、删、校验(坏日期、空名字);重启(新 server 同一个库)还在。
 *  4. events.set_config 在当前那份上合并,越界拒;中等影响的开关一变,日历源那份当场按新口径重解。
 *  5. 跨市场跟跌(P0):美股盘中的时刻,标普与 ETF 的当日涨跌从公开源取(没连券商),差够了就在 cross 里给一条;一分钟内不重取;窗口外不取。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { clearMacroCache } from "../src/macro.js";
import { RpcServer } from "../src/rpc.js";
import { EventsService } from "../src/services/events.js";

type Rec = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 2026-10-13(周二)美东 10:00 */
const NOW = Date.parse("2026-10-13T10:00:00-04:00");

const FEED = [
  { title: "Core CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.2%", previous: "0.3%" },
  { title: "CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" },
  { title: "Unemployment Claims", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "Medium", forecast: "199K", previous: "197K" },
  { title: "Fed Chairman Warsh Speaks", country: "USD", date: "2026-10-15T23:30:00-04:00", impact: "High", forecast: "", previous: "" },
  { title: "Bank Holiday", country: "USD", date: "2026-10-12T07:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
];

const dirs: string[] = [];

function makeServer(dir?: string): { s: RpcServer; dir: string } {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dafri-events-"));
  if (!dir) dirs.push(root);
  const settingsPath = path.join(root, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(root, "t.db") } }));
  }
  const s = new RpcServer(settingsPath, () => {});
  return { s, dir: root };
}

/** 换上假的日历源与假的钟:fetcher 记下日历源被叫了几次;别的(跨市场要的行情)一律当取不到 */
function fakeFeed(s: RpcServer, payload: unknown | (() => unknown), now = NOW): { calls: number[] } {
  const calls: number[] = [];
  clearMacroCache();
  const svc = new EventsService(s, async (url) => {
    if (!url.includes("ff_calendar")) throw new Error("数据源返回 HTTP 404");
    calls.push(1);
    const p = typeof payload === "function" ? (payload as () => unknown)() : payload;
    if (p instanceof Error) throw p;
    return p;
  }, () => now);
  (s as unknown as { events: EventsService }).events = svc;
  return { calls };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("events.list", () => {
  it("内置 + 日历源合成一份:从昨天到两周后;第一次同步等日历源,第二次吃缓存", async () => {
    const { s } = makeServer();
    const { calls } = fakeFeed(s, FEED);
    const res = (await s.call("events.list", {})) as Rec;
    expect(calls.length).toBe(1);
    expect(res["feed"]).toMatchObject({ error: null, count: 2 });
    expect(res["feed"]["at"]).toBe(NOW);
    expect((res["events"] as Rec[]).map((e) => `${e["date_et"]} ${e["time_et"]} ${e["title"]} [${e["source"]}]`)).toEqual([
      "2026-10-14 08:30 CPI(9月) [feed]",
      "2026-10-15 08:30 PPI(9月) [builtin]",
      "2026-10-15 23:30 美联储讲话(Warsh) [feed]",
    ]);
    expect((res["events"] as Rec[])[0]!["items"]).toHaveLength(2);
    await s.call("events.list", {});
    expect(calls.length).toBe(1);
    // 用户点了刷新:再拉一次
    await s.call("events.list", { force: true });
    expect(calls.length).toBe(2);
  });

  it("日历源拉失败不炸:内置的照给,原因在 feed.error 里;半小时内不再试", async () => {
    const { s } = makeServer();
    const { calls } = fakeFeed(s, () => new Error("日历源返回 HTTP 503"));
    const res = (await s.call("events.list", {})) as Rec;
    expect(res["feed"]).toEqual({ at: null, error: "日历源返回 HTTP 503", count: 0 });
    expect((res["events"] as Rec[]).map((e) => e["title"])).toEqual(["CPI(9月)", "PPI(9月)"]);
    await s.call("events.list", {});
    expect(calls.length).toBe(1);
  });

  it("日历源返回的不是清单也算失败", async () => {
    const { s } = makeServer();
    fakeFeed(s, { oops: true });
    const res = (await s.call("events.list", {})) as Rec;
    expect(res["feed"]["error"]).toMatch(/不是清单/);
  });

  it("关了日历源一个包都不发;关了整个功能清单是空的", async () => {
    const { s } = makeServer();
    const { calls } = fakeFeed(s, FEED);
    await s.call("events.set_config", { config: { feed: false } });
    let res = (await s.call("events.list", {})) as Rec;
    expect(calls.length).toBe(0);
    expect((res["events"] as Rec[]).every((e) => e["source"] === "builtin")).toBe(true);
    await s.call("events.set_config", { config: { enabled: false } });
    res = (await s.call("events.list", {})) as Rec;
    expect(res["events"]).toEqual([]);
    expect(res["config"]).toMatchObject({ enabled: false, feed: false });
  });
});

describe("自定义事件", () => {
  it("加一条、删一条;重启还在;坏日期与空名字当场拒", async () => {
    const { s, dir } = makeServer();
    fakeFeed(s, []);
    const added = (await s.call("events.add", { title: " CRWV 发债 ", date_et: "2026-10-14", time_et: "7:00", note: "数据中心板块" })) as Rec;
    expect(added["event"]).toMatchObject({
      kind: "custom", title: "CRWV 发债", date_et: "2026-10-14", time_et: "7:00", source: "custom", linger_min: 90, note: "数据中心板块",
    });
    expect(added["event"]["at"]).toBe(Date.parse("2026-10-14T07:00:00-04:00"));
    const id = String(added["event"]["id"]);
    expect(id).toMatch(/^custom:/);

    let list = (await s.call("events.list", {})) as Rec;
    expect((list["events"] as Rec[]).map((e) => e["title"])).toEqual(["CRWV 发债", "CPI(9月)", "PPI(9月)"]);

    const again = makeServer(dir);
    fakeFeed(again.s, []);
    list = (await again.s.call("events.list", {})) as Rec;
    expect((list["events"] as Rec[]).some((e) => e["id"] === id)).toBe(true);

    expect(await again.s.call("events.remove", { id })).toEqual({ deleted: id });
    await expect(again.s.call("events.remove", { id })).rejects.toThrow("没有这条自定义事件");
    await expect(again.s.call("events.add", { title: "", date_et: "2026-10-14", time_et: "07:00" })).rejects.toThrow("名字");
    await expect(again.s.call("events.add", { title: "x", date_et: "2026-13-01", time_et: "07:00" })).rejects.toThrow("日期要写成");
    await expect(again.s.call("events.add", { title: "x", date_et: "2026-10-14", time_et: "07:00", linger_min: 1 })).rejects.toThrow("5 ~ 1440");
  });
});

describe("events.set_config", () => {
  it("在当前那份上合并;越界拒;中等影响的开关一变,日历源那份按新口径重解", async () => {
    const { s } = makeServer();
    fakeFeed(s, FEED);
    let res = (await s.call("events.list", {})) as Rec;
    expect((res["events"] as Rec[]).some((e) => e["title"] === "初请失业金")).toBe(false);
    const cfg = (await s.call("events.set_config", { config: { medium: true, lead_minutes: ["30"] } })) as Rec;
    expect(cfg["config"]).toMatchObject({ enabled: true, feed: true, medium: true, lead_minutes: [30], sector_move_pct: 3 });
    res = (await s.call("events.list", {})) as Rec;
    expect((res["events"] as Rec[]).some((e) => e["title"] === "初请失业金")).toBe(true);
    await expect(s.call("events.set_config", { config: { sector_share: 2 } })).rejects.toThrow("0.3 ~ 1");
    // 拒了的那一次什么都没改
    expect(((await s.call("events.list", {})) as Rec)["config"]["sector_share"]).toBe(0.6);
  });
});

describe("跨市场跟跌套利", () => {
  /** 2026-10-14(周三)美东 11:30,美股盘中 */
  const MIDDAY = Date.parse("2026-10-14T11:30:00-04:00");
  const chart = (last: number, prev: number): unknown => ({ chart: { result: [{ meta: { regularMarketPrice: last, chartPreviousClose: prev } }] } });

  /** 公开源的假数据:标普 −2.5%,EWY 只跌 0.4%,ASHR 跌 2.6%;别的格子随便给一个 */
  function fakeQuotes(s: RpcServer, now: number, over: Record<string, [number, number]> = {}): { urls: string[] } {
    const urls: string[] = [];
    clearMacroCache(); // 行情带的缓存是模块级的,别把一个用例的格子留给下一个
    const table: Record<string, [number, number]> = {
      "%5EGSPC": [7500, 7692.3], EWY: [60.1, 60.34], KORU: [28.6, 28.98], ASHR: [29.0, 29.77], FXI: [37.5, 38.42], KWEB: [33.1, 34.16], YINN: [40.0, 43.2],
      ...over,
    };
    const svc = new EventsService(s, async (url) => {
      urls.push(url);
      if (url.includes("ff_calendar")) return [];
      const m = /\/chart\/([^?]+)/.exec(url);
      const hit = m && table[m[1] ?? ""];
      if (hit) return chart(hit[0], hit[1]);
      throw new Error("数据源返回 HTTP 404");
    }, () => now);
    (s as unknown as { events: EventsService }).events = svc;
    return { urls };
  }

  it("盘中就报:标普 −2.5% 而 EWY 只跌 0.4%,cross 里是韩股那条;一分钟内不重取;不在 events 里", async () => {
    const { s } = makeServer();
    const { urls } = fakeQuotes(s, MIDDAY);
    const res = (await s.call("events.list", {})) as Rec;
    expect(res["cross_status"]).toEqual({ in_window: true, at: MIDDAY, error: null });
    expect(res["cross"]).toMatchObject({ kind: "cross", id: "cross:2026-10-14:down", title: "美股 −2.5%,韩股 ETF 没跟跌:开盘可能补跌" });
    expect(res["cross"]["cross"]["markets"].map((m: Rec) => `${m["key"]}:${m["gap"]}`)).toEqual(["kr:2.1"]);
    expect((res["events"] as Rec[]).some((e) => e["kind"] === "cross")).toBe(false);
    const fetched = urls.filter((u) => u.includes("/chart/EWY")).length;
    await s.call("events.list", {});
    expect(urls.filter((u) => u.includes("/chart/EWY")).length).toBe(fetched);
  });

  it("ETF 跟上了就没有;窗口外(美股开盘前)一个报价都不取;关了跨市场也不取", async () => {
    const { s } = makeServer();
    fakeQuotes(s, MIDDAY, { EWY: [58.6, 60.34] });
    expect(((await s.call("events.list", {})) as Rec)["cross"]).toBeNull();

    const early = makeServer();
    const { urls } = fakeQuotes(early.s, Date.parse("2026-10-14T08:00:00-04:00"));
    const res = (await early.s.call("events.list", {})) as Rec;
    expect(res["cross"]).toBeNull();
    expect(res["cross_status"]["in_window"]).toBe(false);
    expect(urls.filter((u) => u.includes("/chart/")).length).toBe(0);

    const off = makeServer();
    const got = fakeQuotes(off.s, MIDDAY);
    await off.s.call("events.set_config", { config: { cross_market: false } });
    expect(((await off.s.call("events.list", {})) as Rec)["cross"]).toBeNull();
    expect(got.urls.filter((u) => u.includes("/chart/")).length).toBe(0);
  });

  it("报价取不到不炸:原因在 cross_status.error 里,清单照给", async () => {
    const { s } = makeServer();
    clearMacroCache();
    const svc = new EventsService(s, async (url) => {
      if (url.includes("ff_calendar")) return [];
      throw new Error("数据源返回 HTTP 503");
    }, () => MIDDAY);
    (s as unknown as { events: EventsService }).events = svc;
    const res = (await s.call("events.list", {})) as Rec;
    expect(res["cross"]).toBeNull();
    expect(res["cross_status"]["in_window"]).toBe(true);
    expect(res["cross_status"]["error"]).toMatch(/标普 500 的涨跌取不到/);
    expect((res["events"] as Rec[]).length).toBeGreaterThan(0);
  });
});
