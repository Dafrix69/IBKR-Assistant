/** 重要事件的 RPC 层(events.*)。全部离线:日历源换成假的取数函数。
 *
 * 钉住:
 *  1. events.list:内置 + 日历源 + 自定义合成一份,从昨天到两周后;日历源从没拉到过时同步等它,之后旧值先给、后台刷;
 *     拉失败不炸,原因在 feed.error 里,内置的照给。
 *  2. 关了日历源一个包都不发;关了整个功能清单里只剩空。
 *  3. 自定义事件:加、删、校验(坏日期、空名字);重启(新 server 同一个库)还在。
 *  4. events.set_config 在当前那份上合并,越界拒;中等影响的开关一变,日历源那份当场按新口径重解。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

/** 换上假的日历源与假的钟:fetcher 记下被叫了几次 */
function fakeFeed(s: RpcServer, payload: unknown | (() => unknown), now = NOW): { calls: number[] } {
  const calls: number[] = [];
  const svc = new EventsService(s, async () => {
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
