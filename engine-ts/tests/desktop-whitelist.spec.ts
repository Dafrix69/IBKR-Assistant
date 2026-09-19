/** 桌面端的 RPC 白名单:preload 调到的每个方法都必须在主进程的 ALLOWED_RPC 里。
 *
 * 漏登记的后果不是编译错误,而是在真应用里一调就报「方法不在白名单中」——mock 桥的截图台
 * 测不出来(2026-09-10:tracker.target_preview 就是这样漏的,界面上的试算和"同意价格"
 * 那一步在真机上整个不工作)。所以放在引擎的测试里,每次跑测试都对一遍。
 *
 * 另一头同样要对:引擎的方法表 ↔ ALLOWED_RPC。方法表拆到 rpc/handlers/ 各域之后,漏接一张表
 * 和漏登记白名单是同一种事故——编译不报,真应用里一调才知道。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");

function setBlock(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) throw new Error(`main.js 里找不到 ${name}`);
  const end = source.indexOf("]);", start);
  return new Set([...source.slice(start, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!));
}

describe("桌面端 RPC 白名单", () => {
  const preload = readFileSync(path.join(DESKTOP, "preload.js"), "utf-8");
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");
  const used = [...new Set([...preload.matchAll(/method:\s*'([a-z_.]+)'/g)].map((m) => m[1]!))];
  const allowed = setBlock(main, "ALLOWED_RPC");
  const sensitive = setBlock(main, "SENSITIVE_RPC");

  it("preload 调到的方法都登记在 ALLOWED_RPC 里", () => {
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((m) => !allowed.has(m))).toEqual([]);
  });

  it("会发单的方法都在 SENSITIVE_RPC 里(要求界面确认过)", () => {
    for (const m of ["instruction.submit", "tracker.add", "tracker.update", "tracker.close_now"]) {
      expect(sensitive.has(m), m).toBe(true);
    }
  });

  it("只读试算不该要求确认——它就是确认之前给人看的那个价", () => {
    expect(allowed.has("tracker.target_preview")).toBe(true);
    expect(sensitive.has("tracker.target_preview")).toBe(false);
  });

  it("SENSITIVE_RPC 是 ALLOWED_RPC 的子集(要求确认的方法得先是允许调的)", () => {
    expect([...sensitive].filter((m) => !allowed.has(m))).toEqual([]);
  });
});

describe("引擎方法表 ↔ 桌面端白名单", () => {
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");
  const allowed = setBlock(main, "ALLOWED_RPC");
  // 只建 server 不碰引擎:方法表在构造时合成,库是懒建的,这里不会落一个 .db
  const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-methods-"));
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const names = new RpcServer(settingsPath, () => {}).methodNames();
  rmSync(dir, { recursive: true, force: true });

  it("白名单里的每个方法引擎都接得住(各域的表都接进了 server)", () => {
    expect(names.length).toBeGreaterThan(70);
    expect([...allowed].filter((m) => !names.includes(m))).toEqual([]);
  });

  it("引擎的每个方法都登记在白名单里(不留界面够不着、也没人测的死方法)", () => {
    expect(names.filter((m) => !allowed.has(m))).toEqual([]);
  });

  it("三条道的方法名都是真方法(改名 / 删方法时别把道表落下)", () => {
    for (const lane of [RpcServer.LOCAL_METHODS, RpcServer.READ_METHODS, RpcServer.LOW_PRIORITY_METHODS]) {
      expect([...lane].filter((m) => !names.includes(m))).toEqual([]);
    }
  });
});
