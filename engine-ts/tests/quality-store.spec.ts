/** 优质股追踪的落库:quality_stocks(异动档位 / 滞回状态跨重启保留)与 app_prefs(异动阈值)。
 *
 * 状态不落库的后果:引擎一重启,今天已经报过的"放量 3×""大涨 2σ"全部再报一遍。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnomalyEvent } from "../src/contract/quality.js";
import { TradeStore } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "..", "baseline", "store", "fixture.db");

describe("store: 优质股追踪", () => {
  let dir: string;
  let dbPath: string;
  let store: TradeStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-quality-store-"));
    dbPath = path.join(dir, "t.db");
    store = new TradeStore(dbPath);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关 */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("老库文件直接打开就补上两张新表,原有数据不动", () => {
    store.close();
    const old = path.join(dir, "old.db");
    fs.copyFileSync(FIXTURE, old);
    store = new TradeStore(old);
    const before = store.listWatches().length;
    const row = store.addQualityStock("aapl");
    expect(store.getQualityStock(row["id"])?.["symbol"]).toBe("AAPL");
    store.setPref("quality.config", { burst_ratio: 5 });
    expect(store.getPref("quality.config")).toEqual({ burst_ratio: 5 });
    expect(store.listWatches().length).toBe(before);
  });

  it("加入:代码转大写、去空格;空代码与重复都给中文错误", () => {
    const row = store.addQualityStock("  rk lb ", "火箭");
    expect(row).toMatchObject({ symbol: "RKLB", note: "火箭", enabled: 1, states: {}, events: [] });
    expect(() => store.addQualityStock("   ")).toThrowError("标的代码为空");
    expect(() => store.addQualityStock("rklb")).toThrowError("已经在追踪 RKLB 了");
  });

  it("备注按字符截到 60 个(表情不截成半个),控制字符换成空格", () => {
    const long = "好".repeat(59) + "🚀🚀";
    const row = store.addQualityStock("NVDA", long);
    expect(Array.from(row["note"] as string)).toHaveLength(60);
    expect((row["note"] as string).endsWith("🚀")).toBe(true);
    const tab = String.fromCharCode(9);
    const nl = String.fromCharCode(10);
    const two = store.addQualityStock("AMD", `护城河${tab}深${nl}毛利高`);
    expect(two["note"]).toBe("护城河 深 毛利高");
  });

  it("列表按加入顺序(同一秒加的按插入先后);states / events 解析好,enabled 是 0/1", () => {
    for (const s of ["MSFT", "AAPL", "GOOG"]) store.addQualityStock(s);
    const list = store.listQualityStocks();
    expect(list.map((r) => r["symbol"])).toEqual(["MSFT", "AAPL", "GOOG"]);
    expect(list[0]).toMatchObject({ enabled: 1, states: {}, events: [], note: "" });
    expect(store.getQualityStock("no-such-id")).toBeNull();
  });

  it("白名单更新:note / enabled / states / events;事件只留最近 50 条;别的字段拒绝", () => {
    const row = store.addQualityStock("UBER");
    const id = String(row["id"]);
    // 夹具只带这条用例要看的两个字段;store 不看事件的形状,原样进出
    const events = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, title: `UBER 放量 ${i}` })) as unknown as AnomalyEvent[];
    expect(store.updateQualityStock(id, {
      enabled: false, note: "网约车龙头", states: { date: "2026-09-11", rvol_fired: 3 }, events,
    })).toBe(true);
    const got = store.getQualityStock(id)!;
    expect(got["enabled"]).toBe(0);
    expect(got["note"]).toBe("网约车龙头");
    expect(got["states"]).toEqual({ date: "2026-09-11", rvol_fired: 3 });
    expect((got["events"] as Array<{ id: string }>).map((e) => e.id)).toEqual(events.slice(-50).map((e) => e.id));
    // 类型已经不让这么传了;运行时那道白名单是给绕过类型的调用方留的,所以这里故意绕
    expect(() => store.updateQualityStock(id, { symbol: "LYFT" } as never)).toThrowError(/不允许修改的字段/);
    expect(store.updateQualityStock(id, {})).toBe(false);
    expect(store.updateQualityStock("no-such-id", { enabled: true })).toBe(false);
    store.updateQualityStock(id, { enabled: 1 } as never); // 同上:库按真假收,1 也认
    expect(store.getQualityStock(id)!["enabled"]).toBe(1);
  });

  it("库里的 JSON 坏了:states 当 {}、events 当 [],不抛", () => {
    const row = store.addQualityStock("TSLA");
    store.rawExec("UPDATE quality_stocks SET states=?, events=? WHERE id=?", ["{oops", "[1,", row["id"]]);
    expect(store.getQualityStock(String(row["id"]))).toMatchObject({ states: {}, events: [] });
    store.rawExec("UPDATE quality_stocks SET states=?, events=? WHERE id=?", ["[1,2]", "{}", row["id"]]);
    expect(store.getQualityStock(String(row["id"]))).toMatchObject({ states: {}, events: [] });
  });

  it("删除", () => {
    const row = store.addQualityStock("PLTR");
    expect(store.deleteQualityStock(String(row["id"]))).toBe(true);
    expect(store.deleteQualityStock(String(row["id"]))).toBe(false);
    expect(store.listQualityStocks()).toEqual([]);
    store.addQualityStock("PLTR"); // 删了可以重新加
  });

  it("状态跨重启保留(关库再开读回来一样)", () => {
    const row = store.addQualityStock("SMCI", "服务器");
    store.updateQualityStock(String(row["id"]), { states: { date: "2026-09-11", day_up_fired: 2 } });
    store.close();
    store = new TradeStore(dbPath);
    expect(store.getQualityStock(String(row["id"]))).toMatchObject({
      symbol: "SMCI", note: "服务器", states: { date: "2026-09-11", day_up_fired: 2 },
    });
  });

  // 股票池:板块成分股的并集说了算谁能有 alert_watches / quality_stocks 的行,
  // 上层(pool.set_watch 的连带清理、一次性迁移)全靠这一个查询,不能被一行坏数据顶翻。
  it("股票池 = 所有板块成分股的并集:大写、跨板块去重、空代码不算", () => {
    expect(store.symbolsInSectors()).toEqual(new Set());
    const tech = store.addSector("科技");
    const chip = store.addSector("半导体");
    store.setSectorStocks(String(tech["id"]), [
      { symbol: "nvda" }, { symbol: " amd " }, { symbol: "" }, { symbol: "AMD" },
    ]);
    store.setSectorStocks(String(chip["id"]), [{ symbol: "AMD" }, { symbol: "AVGO" }]);
    expect([...store.symbolsInSectors()].sort()).toEqual(["AMD", "AVGO", "NVDA"]);

    // 板块没了,它的成分股就不在池子里了
    store.deleteSector(String(chip["id"]));
    expect([...store.symbolsInSectors()].sort()).toEqual(["AMD", "NVDA"]);
  });

  it("库里的板块成分股坏了(不是数组 / 不是对象):当空的,不抛——一行坏数据不能挡住整个池子", () => {
    const tech = store.addSector("科技");
    store.setSectorStocks(String(tech["id"]), [{ symbol: "NVDA" }]);
    for (const bad of ["{oops", "{}", '"NVDA"', "null", "17"]) {
      store.rawExec("UPDATE sectors SET stocks=? WHERE id=?", [bad, tech["id"]]);
      expect(store.symbolsInSectors(), bad).toEqual(new Set());
      expect(store.getSector(String(tech["id"]))!["stocks"], bad).toEqual([]);
    }
    store.rawExec("UPDATE sectors SET stocks=? WHERE id=?", ['[null,3,{"symbol":"AMD"}]', tech["id"]]);
    expect([...store.symbolsInSectors()]).toEqual(["AMD"]);
  });

  it("偏好:没设过回 null;存取往返;覆盖写;存坏了回 null", () => {
    expect(store.getPref("quality.config")).toBeNull();
    store.setPref("quality.config", { rvol_tiers: [2, 3, 5], window_min: 5 });
    expect(store.getPref("quality.config")).toEqual({ rvol_tiers: [2, 3, 5], window_min: 5 });
    store.setPref("quality.config", { window_min: 10 });
    expect(store.getPref("quality.config")).toEqual({ window_min: 10 });
    store.rawExec("UPDATE app_prefs SET value=? WHERE key=?", ["{bad", "quality.config"]);
    expect(store.getPref("quality.config")).toBeNull();
  });
});
