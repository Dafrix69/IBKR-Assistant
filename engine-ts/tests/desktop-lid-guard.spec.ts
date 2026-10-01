/** 盯盘时合盖不睡(desktop/lid-guard.js)。
 *
 * 钉的是:有追踪在盯、合盖睡眠还开着才去关;只恢复自己关的那一次;没追踪在盯满 10 分钟、菜单里关掉、退出时恢复;
 * 授权框被取消之后这一段不再问;有一次在等回应时不重复弹;owned 落盘,崩了重开还认得。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Action { set: boolean | null; log: string | null; notify: { title: string; body: string } | null }
interface Guard {
  enabled: boolean;
  owned: boolean;
  wantsReading(live: number): boolean;
  observe(o: { live?: number; sleepDisabled?: boolean | null; now: number }): Action;
  quitAction(): Action;
  setEnabled(v: boolean): void;
  done(on: boolean, outcome: "ok" | "cancelled" | "failed", detail?: string): Action;
  state(): { enabled: boolean; owned: boolean };
}
const lib = require(path.join(DESKTOP, "lid-guard.js")) as {
  LidGuard: new (s?: { enabled?: boolean; owned?: boolean }) => Guard;
  OFF_DELAY_MS: number;
  parseSleepDisabled(text: string): boolean | null;
  pmsetScript(on: boolean): string;
  isCancelled(err: unknown): boolean;
  loadState(file: string): { enabled: boolean; owned: boolean };
  saveState(file: string, s: { enabled: boolean; owned: boolean }): void;
};

const MIN = 60_000;

describe("读 pmset 与拼授权命令", () => {
  it("pmset -g 的 SleepDisabled:0 / 1,读不出来是 null", () => {
    expect(lib.parseSleepDisabled("System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:\n")).toBe(false);
    expect(lib.parseSleepDisabled(" SleepDisabled\t\t1\n")).toBe(true);
    expect(lib.parseSleepDisabled("Currently in use:\n standby 1\n")).toBeNull();
    expect(lib.parseSleepDisabled("")).toBeNull();
  });

  it("授权命令走系统的管理员授权框,写死 /usr/bin/pmset", () => {
    expect(lib.pmsetScript(true)).toContain('do shell script "/usr/bin/pmset -a disablesleep 1" with administrator privileges');
    expect(lib.pmsetScript(false)).toContain('"/usr/bin/pmset -a disablesleep 0"');
  });

  it("认得出点了取消(-128)", () => {
    expect(lib.isCancelled({ stderr: "0:94: execution error: User canceled. (-128)" })).toBe(true);
    expect(lib.isCancelled({ stderr: "execution error: 用户已取消。 (-128)" })).toBe(true);
    expect(lib.isCancelled({ message: "Command failed", stderr: "pmset: permission denied" })).toBe(false);
  });
});

describe("什么时候关掉合盖睡眠", () => {
  it("有追踪在盯、合盖睡眠开着:请求关掉一次;成功后记成自己关的", () => {
    const g = new lib.LidGuard();
    expect(g.wantsReading(0)).toBe(false);
    expect(g.wantsReading(1)).toBe(true);
    const a = g.observe({ live: 1, sleepDisabled: false, now: 0 });
    expect(a.set).toBe(true);
    // 在等授权框的回应:心跳再来不重复弹
    expect(g.observe({ live: 1, sleepDisabled: false, now: 10_000 }).set).toBeNull();
    const done = g.done(true, "ok");
    expect(done.notify?.title).toBe("盯盘期间合盖不睡");
    expect(done.notify?.body).toContain("别放进包里");
    expect(g.owned).toBe(true);
    expect(g.observe({ live: 2, sleepDisabled: true, now: 20_000 }).set).toBeNull();
  });

  it("没追踪在盯、菜单里关着、状态还没读到:都不动", () => {
    expect(new lib.LidGuard().observe({ live: 0, sleepDisabled: false, now: 0 }).set).toBeNull();
    expect(new lib.LidGuard({ enabled: false }).observe({ live: 3, sleepDisabled: false, now: 0 }).set).toBeNull();
    expect(new lib.LidGuard().observe({ live: 3, now: 0 }).set).toBeNull();
  });

  it("用户自己在终端里关的:不当成自己的,之后也不去恢复", () => {
    const g = new lib.LidGuard();
    expect(g.observe({ live: 1, sleepDisabled: true, now: 0 }).set).toBeNull();
    expect(g.owned).toBe(false);
    expect(g.observe({ live: 0, sleepDisabled: true, now: 60 * MIN }).set).toBeNull();
    expect(g.quitAction().set).toBeNull();
  });

  it("授权框被取消:提醒一次,这一段不再问;盯的条数回到 0 再起来算新的一段", () => {
    const g = new lib.LidGuard();
    g.observe({ live: 1, sleepDisabled: false, now: 0 });
    const done = g.done(true, "cancelled");
    expect(done.notify?.title).toBe("合上盖子,本机盯盘仍会停");
    expect(done.notify?.body).toContain("盯盘时合盖不睡");
    for (const live of [1, 2, 1]) expect(g.observe({ live, sleepDisabled: false, now: 1 }).set).toBeNull();
    g.observe({ live: 0, sleepDisabled: false, now: 2 });
    expect(g.observe({ live: 1, sleepDisabled: false, now: 3 }).set).toBe(true);
  });
});

describe("什么时候恢复", () => {
  function owned(): Guard {
    const g = new lib.LidGuard();
    g.observe({ live: 1, sleepDisabled: false, now: 0 });
    g.done(true, "ok");
    return g;
  }

  it("没追踪在盯满 10 分钟才恢复;中间又有了就重新计时", () => {
    const g = owned();
    expect(g.observe({ live: 0, sleepDisabled: true, now: 1 * MIN }).set).toBeNull();
    expect(g.observe({ live: 0, sleepDisabled: true, now: 9 * MIN }).set).toBeNull();
    expect(g.observe({ live: 1, sleepDisabled: true, now: 10 * MIN }).set).toBeNull(); // 平完马上开下一只
    expect(g.observe({ live: 0, sleepDisabled: true, now: 12 * MIN }).set).toBeNull();
    expect(g.observe({ live: 0, sleepDisabled: true, now: 12 * MIN + lib.OFF_DELAY_MS }).set).toBe(false);
    expect(g.done(false, "ok").log).toBe("[power] 已恢复合盖睡眠");
    expect(g.owned).toBe(false);
  });

  it("菜单里关掉:不等 10 分钟,当场恢复", () => {
    const g = owned();
    g.setEnabled(false);
    expect(g.observe({ live: 2, sleepDisabled: true, now: 1 * MIN }).set).toBe(false);
  });

  it("退出应用:自己关的要恢复,只请求一次", () => {
    const g = owned();
    expect(g.quitAction().set).toBe(false);
    expect(g.quitAction().set).toBeNull(); // 授权框还在等
  });

  it("恢复被取消:说怎么手动恢复,退出之前不再问", () => {
    const g = owned();
    g.setEnabled(false);
    g.observe({ live: 0, sleepDisabled: true, now: 1 * MIN });
    const done = g.done(false, "cancelled");
    expect(done.notify?.body).toContain("sudo pmset -a disablesleep 0");
    expect(g.owned).toBe(true);
    expect(g.observe({ live: 0, sleepDisabled: true, now: 30 * MIN }).set).toBeNull();
    expect(g.quitAction().set).toBe(false);
  });

  it("盯盘期间被人在终端里恢复了:当成人的意思,这一段不再去关,退出时也不弹", () => {
    const g = owned();
    expect(g.observe({ live: 1, sleepDisabled: false, now: 1 * MIN }).set).toBeNull();
    expect(g.owned).toBe(false);
    expect(g.quitAction().set).toBeNull();
    g.observe({ live: 0, sleepDisabled: false, now: 2 * MIN });
    expect(g.observe({ live: 1, sleepDisabled: false, now: 3 * MIN }).set).toBe(true); // 下一段重新问
  });
});

describe("落盘", () => {
  it("enabled / owned 存得下读得回;没有文件、文件坏了按默认(打开、不是自己关的)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lid-guard-"));
    const file = path.join(dir, "lid-guard.json");
    expect(lib.loadState(file)).toEqual({ enabled: true, owned: false });
    lib.saveState(file, { enabled: false, owned: true });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ enabled: false, owned: true });
    expect(lib.loadState(file)).toEqual({ enabled: false, owned: true });
    writeFileSync(file, "{ 坏了");
    expect(lib.loadState(file)).toEqual({ enabled: true, owned: false });
  });

  it("崩了重开:还认得是自己关的,没追踪在盯满 10 分钟照样恢复", () => {
    const g = new lib.LidGuard({ enabled: true, owned: true });
    expect(g.observe({ live: 0, sleepDisabled: true, now: 0 }).set).toBeNull();
    expect(g.observe({ live: 0, sleepDisabled: true, now: lib.OFF_DELAY_MS }).set).toBe(false);
  });
});
