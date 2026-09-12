/** 凭证存储:系统凭证库往返 + 从旧存储一次性迁移。
 *
 * 迁移这条最要紧:老用户机器上已经存着 API Key 与富途解锁密码,换实现不能让它们"消失"——
 * 界面只会显示"未配置",用户不会知道是被吃掉了。这里造一份旧版格式的 DPAPI 密文(存到临时
 * LOCALAPPDATA,不碰真实文件),再走一遍读取,核对它被搬进系统凭证库、旧文件删除后仍读得到。
 * 只在 Windows 上跑(macOS 那条靠 security 命令,CI 与本机都不具备)。 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteSecret, getSecret, hasSecret, isSupported, setSecret } from "../src/keychain.js";

const win = process.platform === "win32";
const SERVICE = "dafri-ts-test";
const MIGRATE_SERVICE = "dafri-ts-test-migrate";

let tmpLocalAppData = "";
let savedLocalAppData: string | undefined;

beforeAll(() => {
  if (!win) return;
  // 旧密文文件的位置由 LOCALAPPDATA 决定:指到临时目录,绝不碰用户真实的 credentials.dpapi.json
  savedLocalAppData = process.env["LOCALAPPDATA"];
  tmpLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-keychain-"));
  process.env["LOCALAPPDATA"] = tmpLocalAppData;
});

afterAll(() => {
  if (!win) return;
  if (savedLocalAppData === undefined) delete process.env["LOCALAPPDATA"];
  else process.env["LOCALAPPDATA"] = savedLocalAppData;
  fs.rmSync(tmpLocalAppData, { recursive: true, force: true });
  try {
    deleteSecret(MIGRATE_SERVICE, "legacy");
  } catch {
    /* 清理失败不影响结论 */
  }
});

/** 用旧版一模一样的口径造一份 DPAPI 密文(仅测试用;生产代码只解不加)。 */
function writeLegacyBlob(service: string, account: string, secret: string): void {
  const entropy = Buffer.from(`dafri\x00${service}\x00${account}`, "utf-8").toString("base64");
  const data = Buffer.from(secret, "utf-8").toString("base64");
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    `$d=[Convert]::FromBase64String('${data}');` +
    `$e=[Convert]::FromBase64String('${entropy}');` +
    "$o=[System.Security.Cryptography.ProtectedData]::Protect($d,$e," +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($o)";
  const proc = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(`造密文失败:${proc.stderr}`);
  const file = path.join(tmpLocalAppData, "dafri", "credentials.dpapi.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
  store[`${service}\x00${account}`] = (proc.stdout ?? "").trim();
  fs.writeFileSync(file, JSON.stringify(store, null, 1), "utf-8");
}

function legacyFile(): string {
  return path.join(tmpLocalAppData, "dafri", "credentials.dpapi.json");
}

describe("keychain", () => {
  it.runIf(win)("系统凭证库往返:set → get → has → delete", () => {
    expect(isSupported()).toBe(true);
    setSecret(SERVICE, "roundtrip", "s3cret-值");
    expect(getSecret(SERVICE, "roundtrip")).toBe("s3cret-值");
    expect(hasSecret(SERVICE, "roundtrip")).toBe(true);
    expect(deleteSecret(SERVICE, "roundtrip")).toBe(true);
    expect(getSecret(SERVICE, "roundtrip")).toBeNull();
    expect(hasSecret(SERVICE, "roundtrip")).toBe(false);
    expect(deleteSecret(SERVICE, "roundtrip")).toBe(false);
    expect(() => setSecret(SERVICE, "roundtrip", "")).toThrowError("拒绝写入空密钥");
  });

  it.runIf(win)("旧版 DPAPI 密文第一次读到就搬进系统凭证库,旧文件没了也还在", () => {
    try {
      deleteSecret(MIGRATE_SERVICE, "legacy");
    } catch {
      /* 本来就没有 */
    }
    writeLegacyBlob(MIGRATE_SERVICE, "legacy", "旧钥匙-sk-ant-123");

    // 第一次读:凭证库里没有 → 解旧密文、搬进去、把值交出来
    expect(getSecret(MIGRATE_SERVICE, "legacy")).toBe("旧钥匙-sk-ant-123");

    // 旧文件整个删掉:值已经在系统凭证库里,照样读得到
    fs.rmSync(legacyFile(), { force: true });
    expect(getSecret(MIGRATE_SERVICE, "legacy")).toBe("旧钥匙-sk-ant-123");
  });

  it.runIf(win)("删除会把旧存储里那份一起清掉(否则删完再读又被迁回来)", () => {
    writeLegacyBlob(MIGRATE_SERVICE, "legacy", "旧钥匙-sk-ant-123");
    setSecret(MIGRATE_SERVICE, "legacy", "旧钥匙-sk-ant-123");

    expect(deleteSecret(MIGRATE_SERVICE, "legacy")).toBe(true);
    expect(getSecret(MIGRATE_SERVICE, "legacy")).toBeNull();
    const store = JSON.parse(fs.readFileSync(legacyFile(), "utf-8"));
    expect(`${MIGRATE_SERVICE}\x00legacy` in store).toBe(false);
  });

  it.runIf(!isSupported())("不支持的平台显式报错,不退化为明文", () => {
    expect(() => getSecret("x", "y")).toThrowError(/没有可用的系统凭证存储/);
  });
});
