/** 电源与睡眠(desktop/power-watch.js)。
 *
 * 钉的是:用电池又有追踪在本机盯着时提醒一次——一段电池期间只一次,接回电源再拔掉算新的一段,
 * 没有追踪在盯、接着电源都不提醒;睡下、醒来、换电源各一行日志,醒来那行带上睡了多久。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Action { log: string | null; notify: { title: string; body: string } | null }
interface Watch {
  observe(o?: { onBattery?: boolean; live?: number }): Action;
  suspend(now: number): Action;
  resume(now: number): Action;
}
const { PowerWatch, minutesText } = require(path.join(DESKTOP, "power-watch.js")) as {
  PowerWatch: new () => Watch;
  minutesText(ms: number): string;
};

describe("用电池时的提醒", () => {
  it("有追踪在盯、拔掉电源:提醒一次,写明条数与出路", () => {
    const w = new PowerWatch();
    expect(w.observe({ onBattery: false, live: 2 })).toEqual({ log: "[power] 现在接着电源", notify: null });
    const a = w.observe({ onBattery: true });
    expect(a.log).toBe("[power] 改用电池");
    expect(a.notify?.title).toBe("正在用电池:合上盖子,本机盯盘就停了");
    expect(a.notify?.body).toContain("有 2 条追踪在本机盯着");
    expect(a.notify?.body).toContain("托管到券商");
    // 同一段电池期间:心跳每 10 秒来一次,条数变了也不再提醒
    for (const live of [2, 3, 0, 1]) expect(w.observe({ onBattery: true, live }).notify).toBeNull();
  });

  it("合盖睡眠已关掉(lid-guard):用电池时说的是电会耗光,不再说合盖就停", () => {
    const w = new PowerWatch();
    const a = (w.observe as (o: { onBattery?: boolean; live?: number; lidAwake?: boolean }) => Action)({ onBattery: true, live: 1, lidAwake: true });
    expect(a.notify?.title).toBe("正在用电池:电耗光,本机盯盘就停了");
    expect(a.notify?.body).toContain("合盖不会睡");
  });

  it("接回电源再拔掉:算新的一段,再提醒一次", () => {
    const w = new PowerWatch();
    w.observe({ onBattery: true, live: 1 });
    expect(w.observe({ onBattery: false }).log).toBe("[power] 接上了电源");
    expect(w.observe({ onBattery: true }).notify).not.toBeNull();
  });

  it("用着电池、后来才有追踪在盯(建了追踪、连上了券商):那一刻提醒", () => {
    const w = new PowerWatch();
    expect(w.observe({ onBattery: true, live: 0 }).notify).toBeNull();
    expect(w.observe({ live: 0 }).notify).toBeNull();
    expect(w.observe({ live: 1 }).notify?.body).toContain("有 1 条追踪");
  });

  it("接着电源、没有追踪、还不知道电源状态:都不提醒", () => {
    const w = new PowerWatch();
    expect(w.observe({ live: 5 }).notify).toBeNull(); // 电源状态还没读到
    expect(w.observe({ onBattery: false, live: 5 }).notify).toBeNull();
    expect(new PowerWatch().observe({ onBattery: true, live: 0 }).notify).toBeNull();
  });

  it("状态没变不记日志(心跳每 10 秒一问,不能每问一行)", () => {
    const w = new PowerWatch();
    w.observe({ onBattery: true, live: 0 });
    for (let i = 0; i < 5; i += 1) expect(w.observe({ onBattery: true, live: 0 })).toEqual({ log: null, notify: null });
  });
});

describe("睡下与醒来的日志", () => {
  it("睡下时写电源与在盯的条数,醒来写睡了多久", () => {
    const w = new PowerWatch();
    w.observe({ onBattery: true, live: 1 });
    const t0 = Date.parse("2026-09-29T12:58:25-04:00");
    expect(w.suspend(t0)).toEqual({ log: "[power] 系统睡眠,用电池;在盯的追踪 1 条", notify: null });
    expect(w.resume(t0 + 10 * 60_000 + 11_000).log).toBe("[power] 系统醒来,睡了 10 分钟");
    // 没见过 suspend 的 resume(维护唤醒、或者应用是在睡眠里启动的):不编时长
    expect(w.resume(t0 + 20 * 60_000).log).toBe("[power] 系统醒来");
  });

  it("时长", () => {
    expect(minutesText(21_000)).toBe("21 秒");
    expect(minutesText(15 * 60_000)).toBe("15 分钟");
    expect(minutesText(222 * 60_000)).toBe("3 小时 42 分");
  });
});
