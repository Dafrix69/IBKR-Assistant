/** 从界面配置账户(desktop/accounts-setup.js)。
 *
 * 账户原来只能手改 settings.json:防的是界面被人利用、悄悄把实盘账号标成纸面或把别名指到别的账号上。
 * 现在多了一条由主进程自己走的路。这里钉的是它守住了同一条底线:
 *  · 最危险的那种填错(实盘账号标成纸面)存不进去;
 *  · 确认框上的话是对着"将要写进去的内容"写的,账号完整、类别写明;
 *  · 连接不能从这里改;写出来的配置引擎读得进去;改动前那一份留成 .bak;
 *  · 主进程一定先弹确认框、用户点了保存才写盘。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";

const ROOT = path.resolve(__dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);

type Rec = Record<string, any>;
interface Plan { before: string; config: Rec; headline: string; lines: string[] }
interface Setup {
  applyChange(config: unknown, change: unknown): { config: Rec; headline: string; lines: string[] };
  planChange(configPath: string, change: unknown): Plan;
  commitChange(configPath: string, plan: Plan): void;
  placeholderAliases(config: unknown): string[];
  connectionChoices(config: unknown): { name: string; broker: string; port: number | null }[];
}
const setup = require(path.join(DESKTOP, "accounts-setup.js")) as Setup;

const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, "config", "settings.example.json"), "utf-8")) as Rec;
const fresh = (): Rec => structuredClone(EXAMPLE);
const upsert = (over: Rec = {}): Rec => ({ action: "upsert", alias: "模拟", account_id: "DU1234567", is_paper: true, connection: "paper", ...over });

describe("新用户:把示例里的占位账号换成自己的", () => {
  it("示例配置里的三个账户都是占位", () => {
    expect(setup.placeholderAliases(EXAMPLE)).toEqual(["模拟", "主账户", "富途模拟"]);
    expect(setup.connectionChoices(EXAMPLE)).toEqual([
      { name: "paper", broker: "ibkr", port: 7497 },
      { name: "live", broker: "ibkr", port: 7496 },
      { name: "futu", broker: "futu", port: 11111 },
    ]);
  });

  it("改「模拟」的账号:别的账户原样,默认账户还是它,占位清单里少了它", () => {
    const out = setup.applyChange(fresh(), upsert());
    expect(out.headline).toBe("修改账户");
    expect(out.config.accounts).toHaveLength(3);
    expect(out.config.accounts[0]).toEqual({ alias: "模拟", account_id: "DU1234567", is_paper: true, connection: "paper", default: true });
    expect(out.config.accounts[1]).toEqual(EXAMPLE.accounts[1]);
    expect(setup.placeholderAliases(out.config)).toEqual(["主账户", "富途模拟"]);
  });

  it("确认框上写着将要写进去的每一项:账号完整、类别、连接与端口、是不是默认", () => {
    const text = setup.applyChange(fresh(), upsert({ alias: "主账户", account_id: "U7654321", is_paper: false, connection: "live" })).lines.join("\n");
    expect(text).toContain("别名:主账户");
    expect(text).toContain("账号:U7654321");
    expect(text).toMatch(/类别:实盘账户.*会用真钱成交/);
    expect(text).toContain("连接:live(IBKR,端口 7496)");
    expect(text).toContain("默认账户:否");
    expect(text).toContain("原来是:U0000000,实盘,连接 live");
  });

  it("新加一个别名", () => {
    const out = setup.applyChange(fresh(), upsert({ alias: "第二个模拟", account_id: "DU2223334" }));
    expect(out.headline).toBe("添加账户");
    expect(out.config.accounts.map((a: Rec) => a.alias)).toEqual(["模拟", "主账户", "富途模拟", "第二个模拟"]);
    expect(out.config.accounts.filter((a: Rec) => a.default)).toHaveLength(1);
  });

  it("设成默认账户:原来的默认让位,永远只有一个默认", () => {
    const out = setup.applyChange(fresh(), upsert({ alias: "主账户", account_id: "U7654321", is_paper: false, connection: "live", make_default: true }));
    expect(out.config.accounts.filter((a: Rec) => a.default).map((a: Rec) => a.alias)).toEqual(["主账户"]);
  });
});

describe("存不进去的", () => {
  const rejected = (change: Rec, config: Rec = fresh()): string => {
    try {
      setup.applyChange(config, change);
    } catch (exc) {
      return (exc as Error).message;
    }
    throw new Error("本该被拒");
  };

  it("实盘账号标成纸面(最危险的一种填错:实盘闸门对它失效)", () => {
    expect(rejected(upsert({ account_id: "U1234567", is_paper: true }))).toMatch(/不是 IBKR 模拟账号的样子.*不能标成纸面/);
    expect(rejected(upsert({ account_id: "F1234567", is_paper: true }))).toMatch(/不能标成纸面/);
    // 反过来(模拟账号标成实盘)只是多过一道闸,允许
    expect(setup.applyChange(fresh(), upsert({ is_paper: false })).config.accounts[0].is_paper).toBe(false);
    // 富途的账号是纯数字,分不出来,不套这一条
    expect(setup.applyChange(fresh(), upsert({ alias: "富途模拟", account_id: "28190044", connection: "futu" })).config.accounts[2].is_paper).toBe(true);
  });

  it("类别没选清楚(不是布尔值)", () => {
    expect(rejected(upsert({ is_paper: "true" }))).toMatch(/纸面账户还是实盘账户/);
    expect(rejected(upsert({ is_paper: undefined }))).toMatch(/纸面账户还是实盘账户/);
  });

  it("账号格式不对、别名不合规", () => {
    for (const id of ["", "abc", "DU12", "U1234567; rm -rf", "../etc", "U 1234567", "1234567890123"]) {
      expect(rejected(upsert({ account_id: id })), id).toMatch(/账号的格式不对/);
    }
    expect(rejected(upsert({ alias: "  " }))).toMatch(/别名不能空着/);
    expect(rejected(upsert({ alias: "default" }))).toMatch(/保留字/);
    expect(rejected(upsert({ alias: "长".repeat(25) }))).toMatch(/别名太长/);
    expect(rejected(upsert({ alias: '模"拟' }))).toMatch(/不能有引号/);
    expect(rejected(upsert({ alias: "模\n拟" }))).toMatch(/控制字符/);
  });

  it("挂到配置里没有的连接上;同一个账号配给两个别名", () => {
    expect(rejected(upsert({ connection: "remote" }))).toMatch(/没有叫「remote」的连接/);
    expect(rejected(upsert({ connection: "__proto__" }))).toMatch(/没有叫/);
    const once = setup.applyChange(fresh(), upsert()).config;
    expect(rejected(upsert({ alias: "另一个", account_id: "DU1234567" }), once)).toMatch(/已经配给了别名「模拟」/);
  });

  it("不认识的操作、删一个不存在的别名、配置本身坏了", () => {
    expect(rejected({ action: "replace_all", alias: "模拟" })).toMatch(/不认识的操作/);
    expect(rejected({ action: "remove", alias: "没有这个" })).toMatch(/没有叫「没有这个」的账户/);
    expect(rejected(upsert(), null as never)).toMatch(/配置文件读不出来/);
  });

  it("界面多带的键不会被写进配置(连接、限额、闸门都改不了)", () => {
    const out = setup.applyChange(fresh(), upsert({ policies: { allow_live_trading: true }, connections: { paper: { host: "10.0.0.1" } }, host: "10.0.0.1", extra: 1 }));
    expect(out.config.policies).toEqual(EXAMPLE.policies);
    expect(out.config.connections).toEqual(EXAMPLE.connections);
    expect(Object.keys(out.config.accounts[0]).sort()).toEqual(["account_id", "alias", "connection", "default", "is_paper"]);
  });
});

describe("删除", () => {
  it("删掉默认账户:默认让给剩下的第一个,确认框里说清楚", () => {
    const out = setup.applyChange(fresh(), { action: "remove", alias: "模拟" });
    expect(out.headline).toBe("删除账户");
    expect(out.config.accounts.map((a: Rec) => a.alias)).toEqual(["主账户", "富途模拟"]);
    expect(out.config.accounts[0].default).toBe(true);
    expect(out.lines.join("\n")).toMatch(/默认账户改成「主账户」/);
  });
});

describe("落盘", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dafri-accounts-"));
    file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ ...EXAMPLE, storage: { db_path: path.join(dir, "t.db") } }, null, 2));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
    }
  });

  it("planChange 不写盘;commitChange 写下去,引擎读得进去,改动前那一份在 .bak 里", () => {
    const before = readFileSync(file, "utf-8");
    const plan = setup.planChange(file, upsert());
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["settings.json"]);

    setup.commitChange(file, plan);
    const settings = loadSettings(file);
    expect(settings.accountByAlias("模拟")).toMatchObject({ account_id: "DU1234567", is_paper: true, connection: "paper", default: true });
    expect(settings.config_warnings).toEqual([]);
    expect(readFileSync(`${file}.bak`, "utf-8")).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["settings.json", "settings.json.bak"]);
    // 别的段一字没动
    const after = JSON.parse(readFileSync(file, "utf-8")) as Rec;
    expect(after.limits).toEqual(EXAMPLE.limits);
    expect(after.policies).toEqual(EXAMPLE.policies);
  });

  it("配置文件是坏的:不去改它", () => {
    writeFileSync(file, "{ 坏的");
    expect(() => setup.planChange(file, upsert())).toThrow(/不是合法的 JSON/);
    expect(readFileSync(file, "utf-8")).toBe("{ 坏的");
  });
});

describe("主进程与界面的接线", () => {
  const ipc = readFileSync(path.join(DESKTOP, "support-ipc.js"), "utf-8");
  const handler = ipc.slice(ipc.indexOf("ipcMain.handle('accounts-change'"), ipc.indexOf("ipcMain.handle('quit-app'"));

  it("先校验、再弹确认框、用户点了保存才写盘、写完重启引擎", () => {
    const order = ["guard(event)", "accountsSetup.planChange(", "ctx.showBox(", "if (response !== 1) return", "accountsSetup.commitChange(", "engine.restart()"];
    const at = order.map((needle) => handler.indexOf(needle));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(handler).toMatch(/defaultId: 0,\s*cancelId: 0/);
  });

  it("引擎那条路照旧不许改账户与连接(settings.patch)", () => {
    const settings = readFileSync(path.join(ROOT, "engine-ts", "src", "rpc", "handlers", "settings.ts"), "utf-8");
    expect(settings).toMatch(/\["accounts", "connections"\]\.filter\(\(k\) => k in patch\)/);
  });

  it("界面列表里显示的是打了码的账号;表单不回填账号", () => {
    const panel = readFileSync(path.join(DESKTOP, "renderer-react", "src", "lib", "AccountsPanel.tsx"), "utf-8");
    expect(panel).toContain("a.account_masked");
    expect(panel).toMatch(/accountId: '',/);
    expect(panel).not.toMatch(/account_id\b(?!:)/); // 只在提交的载荷里出现(account_id: …)
  });
});
