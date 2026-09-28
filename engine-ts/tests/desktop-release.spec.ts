/** 打包与发版这一路上"忘了就会出事"的几件事(desktop/package.json、desktop/tools、desktop/build)。
 *
 * 这些东西出错的方式都一样:开发时一切正常,装到用户机器上才暴露——少带了一个文件、多带了一个不该带的、
 * 发出去的包和说明对不上。所以对着源文件与配置钉住。离线,不打包、不联网。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
const read = (...p: string[]): string => readFileSync(path.join(ROOT, ...p), "utf-8");

interface Pkg {
  version: string;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  build: {
    files: string[];
    extraResources: Array<{ from: string; to: string }>;
    electronFuses: Record<string, boolean>;
    asar: boolean;
  };
}
const pkg = JSON.parse(read("desktop", "package.json")) as Pkg;
const enginePkg = JSON.parse(read("engine-ts", "package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

describe("安装包里带什么", () => {
  it("第三方许可声明、Chromium 的许可、本软件的许可、条款文本都随包", () => {
    const to = pkg.build.extraResources.map((r) => r.to);
    for (const name of ["THIRD-PARTY-NOTICES.txt", "LICENSES.chromium.html", "LICENSE.txt", "legal"]) expect(to, name).toContain(name);
  });

  it("打包之前先生成许可声明(两个平台的打包脚本都是)", () => {
    expect(pkg.scripts["dist:win"]).toMatch(/npm run notices && .*electron-builder/);
    const mac = read("desktop", "tools", "dist_mac.js");
    expect(mac.indexOf("run('npm', ['run', 'notices'])")).toBeGreaterThan(-1);
    expect(mac.indexOf("run('npm', ['run', 'notices'])")).toBeLessThan(mac.indexOf("require('electron-builder')"));
  });

  it("主进程读许可声明的位置,和打包放进去的位置是同一个", () => {
    const main = read("desktop", "main.js");
    expect(main).toMatch(/path\.join\(process\.resourcesPath, 'THIRD-PARTY-NOTICES\.txt'\)/);
  });

  it("iCloud 同步出来的冲突副本(「index 2.html」)不进包", () => {
    expect(pkg.build.files).toContain("!**/* [0-9].*");
    expect(read("desktop", "tools", "stage_engine_ts.js")).toMatch(/\/ \\d\+\(\\\.\[\^\.\]\+\)\?\$\//);
  });

  it("引擎暂存:点开头的目录不带,许可文件不管什么后缀都带", () => {
    const stage = read("desktop", "tools", "stage_engine_ts.js");
    expect(stage).toMatch(/if \(base\.startsWith\('\.'\)\) return false;/);
    expect(stage).toMatch(/if \(LICENSE_FILE\.test\(base\)\) return true;/);
    // 许可文件那一条要排在按后缀裁剪之前,不然 LICENSE.md 还是会被 .md 那条裁掉
    expect(stage.indexOf("LICENSE_FILE.test(base)")).toBeLessThan(stage.indexOf("SKIP_EXT.has(ext)"));
    const re = /^(licen[sc]e|copying|notice)([-.].*)?$/i;
    for (const name of ["LICENSE", "LICENSE.md", "license.txt", "LICENCE", "LICENSE-MIT", "NOTICE", "COPYING", "License.markdown"]) expect(re.test(name), name).toBe(true);
    for (const name of ["licenses.js", "README.md", "notice-board.js.map", "index.js"]) expect(re.test(name) && name !== "notice-board.js.map", name).toBe(false);
  });

  it("富途的接口库不随包:它只是开发依赖(适配桥没核对完之前运行时用不到)", () => {
    expect(enginePkg.dependencies["futu-api"]).toBeUndefined();
    expect(enginePkg.devDependencies["futu-api"]).toBeTruthy();
    const lock = JSON.parse(read("engine-ts", "package-lock.json")) as { packages: Record<string, { dev?: boolean }> };
    expect(lock.packages["node_modules/futu-api"]?.dev).toBe(true);
    expect(lock.packages["node_modules/protobufjs"]?.dev).toBe(true);
    // 引擎也不去 import 它:否则装好的应用里会多出一句"没装 futu-api"
    expect(read("engine-ts", "src", "futuBridge.ts")).not.toMatch(/import\(["']futu-api["']\)/);
  });
});

describe("加固", () => {
  it("熔断丝:关掉 NODE_OPTIONS 与 --inspect,只从 asar 加载;RunAsNode 必须留着(引擎靠它拉起来)", () => {
    expect(pkg.build.electronFuses).toMatchObject({
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
    });
    expect(pkg.build.asar).toBe(true);
    expect(read("desktop", "rpc-client.js")).toMatch(/ELECTRON_RUN_AS_NODE: '1'/);
  });

  it("装好的应用带着 DAFRI_DEV=1 也不开开发者工具", () => {
    expect(read("desktop", "main.js")).toMatch(/const DEV = process\.env\.DAFRI_DEV === '1' && !PACKAGED;/);
  });

  it("签名版用更严的权限文件;ad-hoc 版那份不动", () => {
    const signed = read("desktop", "build", "entitlements.mac.signed.plist");
    expect(signed).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>/);
    expect(signed).not.toMatch(/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/);
    expect(signed).not.toMatch(/<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>/);
    expect(read("desktop", "tools", "dist_mac.js")).toMatch(/entitlements: 'build\/entitlements\.mac\.signed\.plist'/);
    expect(read("desktop", "build", "entitlements.mac.plist")).toMatch(/disable-library-validation/);
  });

  it("界面只打得开白名单里的外链", () => {
    const main = read("desktop", "main.js");
    expect(main).toMatch(/const EXTERNAL_HOSTS = new Set\(\['github\.com', 'www\.tradingview\.com'\]\);/);
    expect(main).not.toMatch(/if \(\/\^https:\\\/\\\/\/\.test\(url\)\) shell\.openExternal\(url\)/);
  });

  it("Windows 安装器:先请旧版自己退出,再强制结束;新旧两个进程名都认", () => {
    const nsh = read("desktop", "build", "installer.nsh");
    for (const name of ["IBKR-Assistant.exe", "Dafri Trading.exe"]) {
      expect(nsh).toContain(`taskkill /IM "${name}" /T`);
      expect(nsh).toContain(`taskkill /F /IM "${name}" /T`);
    }
    expect(nsh.indexOf('taskkill /IM "IBKR-Assistant.exe"')).toBeLessThan(nsh.indexOf('taskkill /F /IM "IBKR-Assistant.exe"'));
  });

  it("Electron 停在 41:42 起 macOS 的系统通知要求正式签名,ad-hoc 的包发不出通知", () => {
    // 拿到 Developer ID 证书、出了签名版之后再升大版本;那时把这条和 .github/dependabot.yml 里的 ignore 一起改掉
    expect(pkg.devDependencies["electron"]).toMatch(/^\^41\./);
    expect(read(".github", "dependabot.yml")).toMatch(/dependency-name: electron/);
  });
});

describe("依赖升级(.github/dependabot.yml)", () => {
  const bot = read(".github", "dependabot.yml");

  it("Node 的类型跟着运行时走:@types/node 的大版本 = 工作流里装的 Node", () => {
    const major = /^\^(\d+)\./.exec(enginePkg.devDependencies["@types/node"] ?? "")?.[1];
    expect(major).toBeTruthy();
    for (const file of ["ci.yml", "package.yml"]) {
      const versions = [...read(".github", "workflows", file).matchAll(/node-version: (\d+)/g)].map((m) => m[1]);
      expect(versions.length, file).toBeGreaterThan(0);
      expect(new Set(versions), file).toEqual(new Set([major]));
    }
    expect(bot).toMatch(/dependency-name: '@types\/node'\n\s+update-types: \['version-update:semver-major'\]/);
  });

  it("合成一个 PR 的只有小版本与补丁:大版本混在组里,一个装不上整组都红", () => {
    expect(bot.match(/dev-tools:\n\s+dependency-type: development\n\s+update-types: \[minor, patch\]/g)?.length).toBe(2);
  });

  it("引擎的依赖清单变了也要打一次包:生产依赖是整包进安装包的", () => {
    const yml = read(".github", "workflows", "package.yml");
    for (const p of ["engine-ts/package.json", "engine-ts/package-lock.json", "desktop/package.json", "desktop/package-lock.json"]) {
      expect(yml, p).toContain(`- '${p}'`);
    }
  });
});

describe("发版闸门(tools/check_release.js)", () => {
  const { changelogSection } = require(path.join(DESKTOP, "tools", "check_release.js")) as {
    changelogSection(text: string, version: string): { date: string; body: string } | null;
  };
  const sample = "# 更新记录\n\n## [未发布]\n\n- 在做的事\n\n## [0.6.0] - 2026-10-08\n\n### 修复\n\n- 追价平仓\n- 对账\n\n## [0.5.10] - 2026-10-01\n\n- 旧的\n";

  it("取得出某一版的那一节,不串到上一版下一版", () => {
    expect(changelogSection(sample, "0.6.0")).toEqual({ date: "2026-10-08", body: "### 修复\n\n- 追价平仓\n- 对账" });
    expect(changelogSection(sample, "0.5.10")).toEqual({ date: "2026-10-01", body: "- 旧的" });
  });

  it("版本号里的点不当通配符;没有这一版就是 null", () => {
    expect(changelogSection(sample, "0.5.1")).toBeNull();
    expect(changelogSection(sample, "0x6y0")).toBeNull();
    expect(changelogSection("## [0.6.0]\n\n内容", "0.6.0")).toEqual({ date: "", body: "内容" });
  });

  it("仓库里的 CHANGELOG 有「未发布」一节,当前版本也有一节", () => {
    const text = read("CHANGELOG.md");
    expect(text).toMatch(/^## \[未发布\]$/m);
    expect(changelogSection(text, pkg.version)).not.toBeNull();
  });

  it("发布任务:先过闸门,更新说明取自 CHANGELOG,带校验和,已有的 Release 不覆盖", () => {
    const yml = read(".github", "workflows", "package.yml");
    expect(yml).toMatch(/check_release\.js --tag "\$GITHUB_REF_NAME" --notes/);
    expect(yml).toMatch(/sha256sum -- \* > SHA256SUMS\.txt/);
    expect(yml).not.toMatch(/--clobber/);
    expect(yml.indexOf("check_release.js")).toBeLessThan(yml.indexOf("gh release create"));
  });
});

describe("仓库里不该出现的东西", () => {
  it("配置的备份与残留和 settings.json 一样不进仓库(里面是真实账号)", () => {
    const ignore = read(".gitignore");
    for (const line of ["config/settings.json", "config/settings.json.bak", "config/settings.json.broken-*", "config/settings.json.tmp-*", "desktop/build/THIRD-PARTY-NOTICES.txt"]) {
      expect(ignore.split(/\r?\n/), line).toContain(line);
    }
  });
});
