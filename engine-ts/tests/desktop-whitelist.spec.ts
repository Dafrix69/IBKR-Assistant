/** 桌面端的 RPC 白名单:preload 调到的每个方法都必须在主进程的 ALLOWED_RPC 里。
 *
 * 漏登记的后果不是编译错误,而是在真应用里一调就报「方法不在白名单中」——mock 桥的截图台
 * 测不出来(2026-09-10:tracker.target_preview 就是这样漏的,界面上的试算和"同意价格"
 * 那一步在真机上整个不工作)。所以放在引擎的测试里,每次跑测试都对一遍。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
