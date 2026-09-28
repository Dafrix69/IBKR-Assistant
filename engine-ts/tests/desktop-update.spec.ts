/** 桌面端的新版本检查(desktop/update-check.js)与打包清单。
 *
 * 新版本检查只读 GitHub 的公开发布信息。它出错的后果不是"报错",而是更隐蔽的两种:
 * 把人带到不是我们发布页的地址(响应被篡改、或仓库改名后 API 回了别处的链接),
 * 或者拿一个比不出来的版本号去催人"升级"到旧版。这两条都钉在这里。
 *
 * 另一条是打包清单:主进程 require 的本地模块必须出现在 package.json 的 build.files 里,
 * 漏了的话开发时一切正常,装好的应用一启动就 "Cannot find module"——只在用户机器上暴露。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Asset { name: string; browser_download_url: string; size?: number }
interface Summary {
  current: string;
  latest: string | null;
  newer: boolean;
  url: string;
  download: { name: string; url: string; size: number | null } | null;
  publishedAt: string | null;
  notes: string;
  checkedAt: number;
}
interface UpdateModule {
  RELEASES_PAGE: string;
  LATEST_API: string;
  compareVersions(a: string, b: string): -1 | 0 | 1 | null;
  assetFor(assets: unknown, platform: string, arch: string): Summary["download"];
  plainNotes(body: unknown): string;
  summarizeRelease(release: unknown, opts: { current: string; platform: string; arch: string; now?: number }): Summary;
  checkForUpdate(opts: {
    current: string; platform: string; arch: string;
    fetchImpl?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<unknown>;
    timeoutMs?: number; now?: number;
  }): Promise<Summary>;
}

const mod = require(path.join(DESKTOP, "update-check.js")) as UpdateModule;
const REPO = "https://github.com/Dafrix69/IBKR-Assistant/releases/";

function asset(version: string, tail: string, size = 1000): Asset {
  const name = `IBKR-Assistant-${version}-${tail}`;
  return { name, browser_download_url: `${REPO}download/v${version}/${name}`, size };
}

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    html_url: `${REPO}tag/v${version}`,
    published_at: "2026-09-28T02:00:00Z",
    body: "## 修复\r\n- **追价平仓**:部分成交后不缩量\r\n- 详见 [文档](https://example.com/x)\r\n<!-- 内部备注 -->",
    assets: [
      asset(version, "mac-arm64.dmg", 118_000_000),
      asset(version, "win-x64.exe", 96_000_000),
      asset(version, "win-x64.exe.blockmap", 100),
      { name: "latest.yml", browser_download_url: `${REPO}download/v${version}/latest.yml` },
    ],
    ...extra,
  };
}

describe("版本号比较", () => {
  it("按数值比,不按字符串比", () => {
    expect(mod.compareVersions("0.5.1", "0.5.2")).toBe(-1);
    expect(mod.compareVersions("0.5.10", "0.5.9")).toBe(1);
    expect(mod.compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(mod.compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(mod.compareVersions("v0.5.1", "0.5.1")).toBe(0);
  });

  it("正式版比同号的预发布版新;预发布段逐段比", () => {
    expect(mod.compareVersions("0.6.0-beta.2", "0.6.0")).toBe(-1);
    expect(mod.compareVersions("0.6.0", "0.6.0-beta.2")).toBe(1);
    expect(mod.compareVersions("0.6.0-beta.2", "0.6.0-beta.10")).toBe(-1);
    expect(mod.compareVersions("0.6.0-alpha.9", "0.6.0-beta.1")).toBe(-1);
    expect(mod.compareVersions("0.6.0-beta", "0.6.0-beta.1")).toBe(-1);
    expect(mod.compareVersions("0.6.0-1", "0.6.0-alpha")).toBe(-1);
  });

  it("认不出的版本号不参与比较(返回 null),更不会被当成新版", () => {
    expect(mod.compareVersions("0.5.1", "nightly")).toBeNull();
    expect(mod.compareVersions("0.5", "0.5.1")).toBeNull();
    expect(mod.compareVersions("", "0.5.1")).toBeNull();
    const s = mod.summarizeRelease(release("0.6.0", { tag_name: "latest-build" }), { current: "0.5.1", platform: "darwin", arch: "arm64" });
    expect(s.newer).toBe(false);
  });
});

describe("挑安装包", () => {
  const assets = release("0.6.0").assets;

  it("mac arm64 → dmg;win x64 → exe;不挑 blockmap / latest.yml", () => {
    expect(mod.assetFor(assets, "darwin", "arm64")?.name).toBe("IBKR-Assistant-0.6.0-mac-arm64.dmg");
    expect(mod.assetFor(assets, "win32", "x64")?.name).toBe("IBKR-Assistant-0.6.0-win-x64.exe");
    expect(mod.assetFor(assets, "win32", "x64")?.size).toBe(96_000_000);
  });

  it("没有对应平台的包(Intel Mac、Linux)就不给直链", () => {
    expect(mod.assetFor(assets, "darwin", "x64")).toBeNull();
    expect(mod.assetFor(assets, "linux", "x64")).toBeNull();
    expect(mod.assetFor(null, "darwin", "arm64")).toBeNull();
  });

  it("下载地址不在本仓库 releases/download 下的,一律不认", () => {
    const evil = [{ name: "IBKR-Assistant-0.6.0-mac-arm64.dmg", browser_download_url: "https://evil.example/IBKR-Assistant-0.6.0-mac-arm64.dmg" }];
    expect(mod.assetFor(evil, "darwin", "arm64")).toBeNull();
    const lookalike = [{ name: "IBKR-Assistant-0.6.0-mac-arm64.dmg", browser_download_url: "https://github.com/Dafrix69/IBKR-Assistant-evil/releases/download/x.dmg" }];
    expect(mod.assetFor(lookalike, "darwin", "arm64")).toBeNull();
  });
});

describe("整理一条 release", () => {
  it("有新版:给版本、发布页、这台机器的安装包、纯文本说明", () => {
    const s = mod.summarizeRelease(release("0.6.0"), { current: "0.5.1", platform: "darwin", arch: "arm64", now: 42 });
    expect(s).toMatchObject({
      current: "0.5.1",
      latest: "0.6.0",
      newer: true,
      url: `${REPO}tag/v0.6.0`,
      publishedAt: "2026-09-28T02:00:00Z",
      checkedAt: 42,
    });
    expect(s.download?.name).toBe("IBKR-Assistant-0.6.0-mac-arm64.dmg");
    expect(s.notes).toBe("修复\n- 追价平仓:部分成交后不缩量\n- 详见 文档");
  });

  it("已是最新、或本机比 GitHub 上还新(开发版):不提示", () => {
    expect(mod.summarizeRelease(release("0.5.1"), { current: "0.5.1", platform: "darwin", arch: "arm64" }).newer).toBe(false);
    expect(mod.summarizeRelease(release("0.5.1"), { current: "0.6.0-dev", platform: "darwin", arch: "arm64" }).newer).toBe(false);
  });

  it("发布页链接不在本仓库 releases 下时,换成固定的 latest 页", () => {
    const s = mod.summarizeRelease(release("0.6.0", { html_url: "https://evil.example/phish" }), { current: "0.5.1", platform: "win32", arch: "x64" });
    expect(s.url).toBe(`${REPO}latest`);
    const js = mod.summarizeRelease(release("0.6.0", { html_url: "javascript:alert(1)" }), { current: "0.5.1", platform: "win32", arch: "x64" });
    expect(js.url).toBe(`${REPO}latest`);
  });

  it("发布说明截断,且不是字符串也不炸", () => {
    expect(mod.plainNotes("x".repeat(5000)).length).toBeLessThanOrEqual(1201);
    expect(mod.plainNotes(undefined)).toBe("");
    expect(typeof mod.plainNotes({ a: 1 })).toBe("string");
  });
});

describe("checkForUpdate:只发一个请求,失败给人话", () => {
  function fakeResponse(status: number, body: unknown) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  }

  it("请求 /releases/latest,带 User-Agent,不带任何别的东西", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const s = await mod.checkForUpdate({
      current: "0.5.1", platform: "darwin", arch: "arm64",
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return fakeResponse(200, release("0.6.0"));
      },
    });
    expect(s.newer).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(mod.LATEST_API);
    expect(calls[0]?.url.startsWith("https://api.github.com/repos/Dafrix69/IBKR-Assistant/")).toBe(true);
    expect(calls[0]?.headers).toEqual({ Accept: "application/vnd.github+json", "User-Agent": "IBKR-Assistant/0.5.1" });
  });

  it("404 / 403 / 500 / 网络错误 / 超时 / 坏 JSON 各有一句人话", async () => {
    const base = { current: "0.5.1", platform: "darwin", arch: "arm64" };
    await expect(mod.checkForUpdate({ ...base, fetchImpl: async () => fakeResponse(404, {}) })).rejects.toThrow("还没有发布过正式版本");
    await expect(mod.checkForUpdate({ ...base, fetchImpl: async () => fakeResponse(403, {}) })).rejects.toThrow("限制了查询频率");
    await expect(mod.checkForUpdate({ ...base, fetchImpl: async () => fakeResponse(502, {}) })).rejects.toThrow("HTTP 502");
    await expect(mod.checkForUpdate({ ...base, fetchImpl: async () => { throw new TypeError("fetch failed"); } })).rejects.toThrow("连不上 GitHub");
    await expect(mod.checkForUpdate({
      ...base,
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); } }),
    })).rejects.toThrow("读不懂");
    await expect(mod.checkForUpdate({
      ...base,
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    })).rejects.toThrow("超时");
    await expect(mod.checkForUpdate({ ...base })).rejects.toThrow("不可用");
  });
});

describe("打包清单:主进程 require 的本地模块都进了安装包", () => {
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf-8")) as {
    build: { files: string[] };
    dependencies?: Record<string, string>;
  };

  /** 从 main.js 起,顺着 require('./x') 把主进程会加载的本地 .js 都找出来。 */
  function localRequires(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const src = readFileSync(path.join(DESKTOP, entry), "utf-8");
    for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
      const rel = m[1] ?? "";
      localRequires(rel.endsWith(".js") ? rel : `${rel}.js`, seen);
    }
    return seen;
  }

  it("main.js 及其本地依赖都在 build.files 里", () => {
    const files = localRequires("main.js");
    expect(files.has("update-check.js")).toBe(true);
    for (const f of files) expect(pkg.build.files, `${f} 没进 build.files:装好的应用会 Cannot find module`).toContain(f);
  });

  it("主进程 require 的第三方包是生产依赖(devDependencies 不会被打进 asar)", () => {
    const external = new Set<string>();
    for (const f of localRequires("main.js")) {
      const src = readFileSync(path.join(DESKTOP, f), "utf-8");
      for (const m of src.matchAll(/require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g)) {
        const name = m[1] ?? "";
        if (name === "electron" || name.startsWith("node:")) continue;
        external.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name));
      }
    }
    expect(external.size).toBeGreaterThan(0);
    for (const name of external) expect(Object.keys(pkg.dependencies ?? {}), `${name} 要放 dependencies`).toContain(name);
  });
});
