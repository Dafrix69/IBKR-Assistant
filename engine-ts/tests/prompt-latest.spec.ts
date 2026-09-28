/** prompt_version: "latest"(config.ts)。
 *
 * 配置文件是首次启动时从示例拷出来的,之后不会再被软件改写。示例里钉死某一版的话,软件升级带来的新提示词
 * 老用户永远用不上。"latest" 让配置跟着软件带的最新一版走;写成具体版本号就是钉住(回滚用)。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPT_DIR, fromDict, latestPromptVersion } from "../src/config.js";
import { loadPromptBundle } from "../src/prompts.js";

const ROOT = path.resolve(__dirname, "..", "..");
const base = { accounts: [], connections: {} };

describe("latestPromptVersion", () => {
  it("按数值比,不按字符串比;不认别的文件", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-prompts-"));
    try {
      for (const name of ["system_v1.2.0.md", "system_v1.10.0.md", "system_v1.9.9.md", "system_v0.99.0.md", "fewshot_v2.0.0.json", "system_v3.md", "system_vx.y.z.md", "README.md"]) {
        writeFileSync(path.join(dir, name), "x");
      }
      expect(latestPromptVersion(dir)).toBe("v1.10.0");
      writeFileSync(path.join(dir, "system_v2.0.0.md"), "x");
      expect(latestPromptVersion(dir)).toBe("v2.0.0");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
      }
    }
  });

  it("目录不在、目录里一版都没有:null", () => {
    expect(latestPromptVersion(path.join(os.tmpdir(), "dafri-没有这个目录"))).toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-prompts-"));
    try {
      mkdirSync(path.join(dir, "sub"));
      expect(latestPromptVersion(dir)).toBeNull();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上文件可能还被占着(SQLite、刚退出的子进程):临时目录留给系统清 */
      }
    }
  });
});

describe("配置里的 prompt_version", () => {
  const shipped = readdirSync(DEFAULT_PROMPT_DIR)
    .map((n) => /^system_(v\d+\.\d+\.\d+)\.md$/.exec(n)?.[1])
    .filter((v): v is string => Boolean(v));

  it("latest → 仓库里带的最新一版,而且那一版的三样文件齐全、渲染得出来", () => {
    const s = fromDict({ ...base, prompt_version: "latest" });
    expect(s.prompt_follows_latest).toBe(true);
    expect(shipped).toContain(s.prompt_version);
    for (const other of shipped) {
      const [a, b] = [s.prompt_version, other].map((v) => v.slice(1).split(".").map(Number));
      const cmp = a![0]! - b![0]! || a![1]! - b![1]! || a![2]! - b![2]!;
      expect(cmp, `${other} 比 ${s.prompt_version} 新`).toBeGreaterThanOrEqual(0);
    }
    const bundle = loadPromptBundle(s);
    expect(bundle.version).toBe(s.prompt_version);
    expect(bundle.system_text.length).toBeGreaterThan(1000);
    expect(bundle.fewshot.length).toBeGreaterThan(0);
  });

  it("写成具体版本号就是钉住", () => {
    const s = fromDict({ ...base, prompt_version: "v1.6.0" });
    expect(s.prompt_version).toBe("v1.6.0");
    expect(s.prompt_follows_latest).toBe(false);
  });

  it("latest 但目录里没有提示词:当场报,不是拿一个不存在的版本往下走", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-prompts-"));
    try {
      expect(() => fromDict({ ...base, prompt_version: "latest", prompt_dir: dir })).toThrow(/一版都没有/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("示例配置(新用户首次启动拷走的那一份)跟着最新版走,并且引擎读得进去", () => {
    const example = JSON.parse(readFileSync(path.join(ROOT, "config", "settings.example.json"), "utf-8"));
    expect(example.prompt_version).toBe("latest");
    const s = fromDict(example);
    expect(shipped).toContain(s.prompt_version);
    expect(s.policies.auto_execute).toBe(false);
    expect(s.policies.allow_live_trading).toBe(false);
  });
});
