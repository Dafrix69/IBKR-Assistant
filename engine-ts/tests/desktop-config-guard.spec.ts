/** 桌面端的配置体检与恢复(desktop/config-guard.js)。
 *
 * 钉的是恢复的口径:只恢复语法上读得进来的备份;坏的那一份留着不删;恢复出来的配置里三个执行闸门一律是关的——
 * 备份比现状旧,不能替用户保留一个他也许已经关掉的授权。离线,只碰临时目录。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_CONFIG, configBackupPath, loadSettings, patchConfigFile } from "../src/config.js";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Guard {
  EXIT_CONFIG: number;
  GATES: string[];
  backupPath(p: string): string;
  inspectConfig(p: string): {
    exists: boolean; syntaxOk: boolean; syntaxError: string | null;
    backup: { usable: boolean; at: number | null; sameAsCurrent: boolean };
  };
  fatalLine(detail: string): { kind: string; message: string } | null;
  restoreBackup(p: string, opts?: { now?: number }): { brokenCopy: string | null; closedGates: string[] };
}
const guard = require(path.join(DESKTOP, "config-guard.js")) as Guard;

const BASE = readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8");

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dafri-guard-"));
  file = path.join(dir, "settings.json");
  writeFileSync(file, BASE);
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
  }
});

describe("两头说的是同一回事", () => {
  it("退出码与备份文件名:引擎和桌面端一致", () => {
    expect(guard.EXIT_CONFIG).toBe(EXIT_CONFIG);
    expect(guard.backupPath(file)).toBe(configBackupPath(file));
  });

  it("引擎 rpc 入口打的那一行,桌面端认得出来", () => {
    const tail = ["[engine] 启动引擎(node):/x/dist", "[fatal:config:syntax] 配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected end of JSON input"].join("\n");
    expect(guard.fatalLine(tail)).toEqual({
      kind: "syntax",
      message: "配置文件不是合法的 JSON(多半是手改时少了逗号或引号):Unexpected end of JSON input",
    });
    expect(guard.fatalLine("[fatal:config:invalid] 连接 paper 的 host 必须是本机地址")).toMatchObject({ kind: "invalid" });
    expect(guard.fatalLine("TypeError: x is not a function\n    at foo (bar.js:1:1)")).toBeNull();
    expect(guard.fatalLine("")).toBeNull();
  });
});

describe("inspectConfig", () => {
  it("好配置、还没有备份", () => {
    const s = guard.inspectConfig(file);
    expect(s).toMatchObject({ exists: true, syntaxOk: true, syntaxError: null });
    expect(s.backup).toEqual({ usable: false, at: null, sameAsCurrent: false });
  });

  it("配置坏了、备份可用", () => {
    patchConfigFile(file, { limits: { max_order_notional: 1000 } });
    writeFileSync(file, "{ 半截");
    const s = guard.inspectConfig(file);
    expect(s.syntaxOk).toBe(false);
    expect(s.syntaxError).toBeTruthy();
    expect(s.backup.usable).toBe(true);
    expect(s.backup.sameAsCurrent).toBe(false);
    expect(s.backup.at).toBeGreaterThan(0);
  });

  it("备份和现在这份一模一样:恢复它没有用", () => {
    writeFileSync(guard.backupPath(file), BASE);
    expect(guard.inspectConfig(file).backup).toMatchObject({ usable: true, sameAsCurrent: true });
  });

  it("备份自己也是坏的:不可用", () => {
    writeFileSync(guard.backupPath(file), "[]");
    expect(guard.inspectConfig(file).backup.usable).toBe(false);
  });

  it("配置不见了", () => {
    rmSync(file);
    expect(guard.inspectConfig(file)).toMatchObject({ exists: false, syntaxOk: false });
  });
});

describe("restoreBackup", () => {
  it("恢复出来的配置引擎读得进去;坏的那份改名留着;三个闸门是关的", () => {
    // 备份里闸门是开的(用户开过自动执行与实盘),之后又改了一次设置,然后文件坏了
    patchConfigFile(file, { policies: { auto_execute: true, allow_live_trading: true } });
    patchConfigFile(file, { limits: { max_order_notional: 4321 } }); // .bak = 闸门开着的那一份
    expect(JSON.parse(readFileSync(guard.backupPath(file), "utf-8")).policies.auto_execute).toBe(true);
    writeFileSync(file, "{ \"accounts\": [ 手改到一半");

    const done = guard.restoreBackup(file, { now: Date.parse("2026-09-28T01:02:03") });
    expect(done.closedGates).toEqual(["允许自动执行", "允许实盘账户下单"]);
    expect(done.brokenCopy).toBe(`${file}.broken-20260928-010203`);
    expect(readFileSync(String(done.brokenCopy), "utf-8")).toBe("{ \"accounts\": [ 手改到一半");

    const settings = loadSettings(file);
    expect(settings.policies.auto_execute).toBe(false);
    expect(settings.policies.allow_live_trading).toBe(false);
    expect(settings.policies.allow_combo_live).toBe(false);
    // 备份本身不动:再坏一次还能再恢复
    expect(existsSync(guard.backupPath(file))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("闸门本来就关着:不报关了什么,别的字段原样回来", () => {
    patchConfigFile(file, { limits: { max_order_notional: 777 } });
    patchConfigFile(file, { limits: { max_order_notional: 888 } });
    writeFileSync(file, "");
    const done = guard.restoreBackup(file);
    expect(done.closedGates).toEqual([]);
    expect(loadSettings(file).limits.max_order_notional).toBe(777);
  });

  it("配置文件不见了也能恢复(没有坏文件可留)", () => {
    patchConfigFile(file, { limits: { max_order_notional: 777 } });
    rmSync(file);
    const done = guard.restoreBackup(file);
    expect(done.brokenCopy).toBeNull();
    expect(loadSettings(file)).toBeTruthy();
  });

  it("没有可用的备份:报出来,什么都不动", () => {
    writeFileSync(file, "坏的");
    expect(() => guard.restoreBackup(file)).toThrow(/没有可用的备份/);
    expect(readFileSync(file, "utf-8")).toBe("坏的");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });
});
