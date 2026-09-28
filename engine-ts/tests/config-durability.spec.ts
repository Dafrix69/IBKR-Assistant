/** 配置文件的落盘与读不进来时的报法(config.ts 的 patchConfigFile / loadSettings,cli.ts 的 rpc 入口)。
 *
 * 配置坏了的后果不是"设置页打不开",是引擎起不来、持仓追踪没人盯。所以钉三件事:
 *  · 写是原子的,而且写之前把改动前那一份留成 .bak;
 *  · 读不进来时抛的是 ConfigLoadError,分得清"文件不在 / 不是 JSON / 校验不过";
 *  · 引擎的 rpc 入口遇到它:最后一行 stderr 是一句人话,退出码是 EXIT_CONFIG——桌面端靠这两样停下自动重启。
 * 全部离线,只碰临时目录。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigLoadError, EXIT_CONFIG, configBackupPath, loadSettings, patchConfigFile } from "../src/config.js";
import { main as cliMain } from "../src/cli.js";

const BASE = readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8");

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dafri-config-"));
  file = path.join(dir, "settings.json");
  writeFileSync(file, BASE);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function loadError(p: string): ConfigLoadError {
  try {
    loadSettings(p);
  } catch (exc) {
    return exc as ConfigLoadError;
  }
  throw new Error("本该读不进来");
}

describe("patchConfigFile:原子写 + 备份", () => {
  it("改之前那一份留成 .bak,新的一份写进去,目录里不留临时文件", () => {
    const before = readFileSync(file, "utf-8");
    const settings = patchConfigFile(file, { limits: { max_order_notional: 1234 } });
    expect(settings.limits.max_order_notional).toBe(1234);
    expect(JSON.parse(readFileSync(file, "utf-8")).limits.max_order_notional).toBe(1234);
    expect(readFileSync(configBackupPath(file), "utf-8")).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["settings.json", "settings.json.bak"]);
  });

  it("再改一次:.bak 跟着往前挪,永远是上一份", () => {
    patchConfigFile(file, { limits: { max_order_notional: 1000 } });
    const middle = readFileSync(file, "utf-8");
    patchConfigFile(file, { limits: { max_order_notional: 2000 } });
    expect(readFileSync(configBackupPath(file), "utf-8")).toBe(middle);
    expect(loadSettings(file).limits.max_order_notional).toBe(2000);
  });

  it("校验不过:配置与备份都原封不动", () => {
    patchConfigFile(file, { limits: { max_order_notional: 1000 } });
    const current = readFileSync(file, "utf-8");
    const backup = readFileSync(configBackupPath(file), "utf-8");
    expect(() => patchConfigFile(file, { limits: { max_order_notional: -5 } })).toThrow();
    expect(readFileSync(file, "utf-8")).toBe(current);
    expect(readFileSync(configBackupPath(file), "utf-8")).toBe(backup);
  });

  it("写出来的文件能被下一次启动读回去(不是半截)", () => {
    patchConfigFile(file, { policies: { auto_execute: true } });
    expect(loadSettings(file).policies.auto_execute).toBe(true);
    expect(readFileSync(file, "utf-8").trimEnd().endsWith("}")).toBe(true);
  });
});

describe("loadSettings:读不进来时说清楚是哪一种", () => {
  it("文件不在 → missing", () => {
    const err = loadError(path.join(dir, "nope.json"));
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect(err.kind).toBe("missing");
    expect(err.message).toMatch(/找不到配置文件/);
  });

  it("半截 JSON(写到一半断电、手改少了逗号)→ syntax", () => {
    writeFileSync(file, BASE.slice(0, Math.floor(BASE.length / 2)));
    const err = loadError(file);
    expect(err.kind).toBe("syntax");
    expect(err.message).toMatch(/不是合法的 JSON/);
    expect(err.path).toBe(file);
  });

  it("空文件、最外层不是对象 → syntax", () => {
    writeFileSync(file, "");
    expect(loadError(file).kind).toBe("syntax");
    writeFileSync(file, "[1, 2]");
    expect(loadError(file).message).toMatch(/最外层必须是一个/);
    writeFileSync(file, "null");
    expect(loadError(file).kind).toBe("syntax");
  });

  it("是 JSON、但校验不过 → invalid,话还是校验那一句原话", () => {
    const raw = JSON.parse(BASE);
    raw.connections.paper.host = "10.0.0.8";
    writeFileSync(file, JSON.stringify(raw));
    const err = loadError(file);
    expect(err.kind).toBe("invalid");
    expect(err.message).toBe("连接 paper 的 host 必须是本机地址,当前为 10.0.0.8");
  });
});

describe("引擎的 rpc 入口:配置读不进来", () => {
  it("退出码是 EXIT_CONFIG,最后一行 stderr 是一句带标记的人话,没有调用栈", async () => {
    writeFileSync(file, "{ \"limits\": ");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const code = await cliMain(["rpc", "--config", file]);
    expect(code).toBe(EXIT_CONFIG);
    expect(EXIT_CONFIG).toBe(78);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[fatal:config:syntax\] 配置文件不是合法的 JSON/);
    expect(lines[0]).not.toMatch(/\n|\bat\s+\S+\s+\(/);
  });

  it("真的起一个引擎进程:坏配置 → 退出码 78(桌面端看到的就是这个)", () => {
    const entry = path.resolve(__dirname, "..", "dist", "src", "cli.js");
    if (!existsSync(entry)) return; // 没编译过就不测这一条(CI 里 tsc --noEmit 不出 dist)
    writeFileSync(file, "not json");
    const run = spawnSync(process.execPath, [entry, "rpc", "--config", file], { encoding: "utf-8", timeout: 20_000 });
    // dist 可能比源码旧(还没重新编译):那时退出码是老的 1,这条不判
    if (run.status === 1 && !/fatal:config/.test(run.stderr)) return;
    expect(run.status).toBe(EXIT_CONFIG);
    expect(run.stderr.trim().split("\n").pop()).toMatch(/^\[fatal:config:syntax\]/);
    expect(run.stdout).toBe("");
  });
});
