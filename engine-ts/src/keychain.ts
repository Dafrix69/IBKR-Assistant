/** 凭证读写(§9.2 / §10.4)。
 *
 * S0 级数据只走这里:不落配置文件、不进环境变量、不硬编码。存取交给
 * `@napi-rs/keyring`(原生,N-API):macOS 走 Keychain、Windows 走凭据管理器。
 * 其余平台显式报错,不退化为明文。
 *
 * 为什么换掉自己写的那版:Windows 侧原来是 PowerShell 调 DPAPI,每次解密都要**同步**
 * 起一个进程(实测约 0.8 秒),期间整个引擎的事件循环被占住——盯盘节拍器晚一拍、所有 RPC
 * 和 IB 消息处理一起停(2026-09-10 真机:每次大模型解析都卡 868 ms)。为此加过进程内缓存和
 * 后台预热两层补丁,本质上是在绕开用错了的工具。原生库一次读写 3 毫秒以内,两层补丁一起删掉。
 *
 * 迁移:旧版写在 `%LOCALAPPDATA%/dafri/credentials.dpapi.json`(DPAPI 密文)与 macOS
 * `security` 命令里的凭证,第一次读到时一次性搬进系统凭证库。**旧的不删**——万一要回退到旧版本,
 * 那边还读得到(删除凭证时才会把两边一起清掉,否则删完再读又被迁回来)。
 *
 * **引擎进程不直接调这里。** 这些都是同步调用,而 macOS 钥匙串条目认的是写入它的那个程序的签名:
 * 换一个 ad-hoc 签名的包,第一次解密就弹窗问人,同步调用在弹窗前一直等,整个事件循环跟着停(盯盘也停)。
 * 引擎走 `secrets.ts`(子进程、有时限);这里的函数只在凭证子进程(`keychainChild.ts`)与一次性的 cli 里跑,
 * `.dependency-cruiser.cjs` 的 keychain-off-the-loop 钉着。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Entry } from "@napi-rs/keyring";

export class KeychainError extends Error {}

export function isSupported(): boolean {
  return os.platform() === "darwin" || os.platform() === "win32";
}

export function requireSupported(): void {
  if (!isSupported()) {
    throw new KeychainError(
      "当前平台既不是 macOS 也不是 Windows,没有可用的系统凭证存储。" +
      "任何情况下都不要退化为明文配置或环境变量。",
    );
  }
}

function entry(service: string, account: string): Entry {
  return new Entry(service, account);
}

export function getSecret(service: string, account: string): string | null {
  requireSupported();
  let secret: string | null = null;
  try {
    secret = entry(service, account).getPassword() ?? null;
  } catch (exc) {
    // 凭证库锁着 / 取不到:说清楚是哪一条,不要退化成"没配过"
    throw new KeychainError(`读取系统凭证失败(service=${service}, account=${account}):${(exc as Error).message}`);
  }
  if (secret) return secret;
  return migrateLegacy(service, account);
}

/** 有没有保存过这条凭证。会解密(macOS 上可能弹窗):引擎查"有没有"走 secrets.secretExists,那边在 macOS 上只查属性。 */
export function hasSecret(service: string, account: string): boolean {
  requireSupported();
  return getSecret(service, account) !== null;
}

export function setSecret(service: string, account: string, secret: string): void {
  requireSupported();
  if (!secret) throw new KeychainError("拒绝写入空密钥");
  try {
    entry(service, account).setPassword(secret);
  } catch (exc) {
    throw new KeychainError(`写入系统凭证失败:${(exc as Error).message}`);
  }
}

export function deleteSecret(service: string, account: string): boolean {
  requireSupported();
  let removed = false;
  try {
    removed = entry(service, account).deleteCredential();
  } catch (exc) {
    throw new KeychainError(`删除系统凭证失败:${(exc as Error).message}`);
  }
  // 旧存储里那份也要清掉,否则删完再读又被迁回来
  return dropLegacy(service, account) || removed;
}

// ---------------------------------------------------------------- 凭证子进程的一次请求
/** 引擎(secrets.ts)经管道发给凭证子进程的一次请求。密钥只经管道,不进命令行参数与环境变量。 */
export interface KeychainRequest {
  op: "get" | "has" | "set";
  service: string;
  account: string;
  secret?: string;
}

/** 子进程回的结果:get 带明文(没有是 null),has / set 只说有没有;失败带一句人话,不带调用栈。 */
export type KeychainReply =
  | { ok: true; value: string | null; exists: boolean }
  | { ok: false; error: string };

/** 在子进程里做一次请求。任何失败都折成 `{ ok: false }`,不抛:子进程只管把结果交回去。 */
export function runKeychainRequest(raw: unknown): KeychainReply {
  const req = (raw ?? {}) as Partial<KeychainRequest>;
  if (typeof req.service !== "string" || typeof req.account !== "string") {
    return { ok: false, error: "凭证请求缺 service / account" };
  }
  try {
    switch (req.op) {
      case "get": {
        const value = getSecret(req.service, req.account);
        return { ok: true, value, exists: value !== null };
      }
      case "has":
        return { ok: true, value: null, exists: hasSecret(req.service, req.account) };
      case "set":
        setSecret(req.service, req.account, String(req.secret ?? ""));
        return { ok: true, value: null, exists: true };
      default:
        return { ok: false, error: `不认识的凭证操作:${String(req.op)}` };
    }
  } catch (exc) {
    return { ok: false, error: (exc as Error).message };
  }
}

// ---------------------------------------------------------------- 旧存储迁移
/** 旧版存的凭证:读出来搬进系统凭证库,搬不动就当没有(界面显示"未配置",用户重填一次)。 */
function migrateLegacy(service: string, account: string): string | null {
  let legacy: string | null = null;
  try {
    legacy = os.platform() === "win32" ? dpapiGet(service, account) : securityGet(service, account);
  } catch (exc) {
    process.stderr.write(`[keychain] 旧凭证读取失败(${service}/${account}):${(exc as Error).message}\n`);
    return null;
  }
  if (!legacy) return null;
  try {
    entry(service, account).setPassword(legacy);
    process.stderr.write(`[keychain] 已把旧版凭证迁入系统凭证库(${service}/${account})\n`);
  } catch (exc) {
    // 迁不进去也要把这次读到的值交出来,否则用户会以为 Key 丢了
    process.stderr.write(`[keychain] 旧凭证迁移失败,本次仍用旧存储:${(exc as Error).message}\n`);
  }
  return legacy;
}

/**
 * `security` 是同步起的子进程:它等着的时候整个引擎(含盯盘节拍)都停着。旧凭证的访问控制对不上时
 * macOS 会弹窗问人,没人点就一直挂——给它一个上限,到点当"读不到"处理,界面显示未配置、用户重填一次。
 */
const SECURITY_TIMEOUT_MS = 20_000;

/** 删除时同步清掉旧存储里的那份。返回是否真的删掉了什么。 */
function dropLegacy(service: string, account: string): boolean {
  if (os.platform() === "win32") {
    const entries = dpapiLoad();
    const key = dpapiKey(service, account);
    if (!(key in entries)) return false;
    delete entries[key];
    dpapiSave(entries);
    return true;
  }
  const proc = spawnSync(
    "security", ["delete-generic-password", "-s", service, "-a", account],
    { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS },
  );
  return proc.status === 0;
}

/** macOS 旧路径:security 命令。 */
function securityGet(service: string, account: string): string | null {
  const proc = spawnSync(
    "security", ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS },
  );
  if (proc.error) {
    process.stderr.write(`[keychain] security 命令没有按时返回(${service}/${account}),按读不到处理:${proc.error.message}\n`);
    return null;
  }
  if (proc.status !== 0) return null;
  return (proc.stdout ?? "").trim() || null;
}

// ---------------------------------------------------------------- 旧 Windows DPAPI
// 只在迁移时用到:密文文件、键名(service\x00account)、附加熵(dafri\x00service\x00account)
// 与旧版完全相同,所以旧版写的那份读得出来。
function dpapiStorePath(): string {
  const base = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "dafri", "credentials.dpapi.json");
}

function entropy(service: string, account: string): Buffer {
  return Buffer.from(`dafri\x00${service}\x00${account}`, "utf-8");
}

function dpapiKey(service: string, account: string): string {
  return `${service}\x00${account}`;
}

function dpapiLoad(): Record<string, string> {
  const p = dpapiStorePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (exc) {
    throw new KeychainError(`旧凭证文件损坏或不可读:${p}(${(exc as Error).message})`);
  }
}

function dpapiSave(entries: Record<string, string>): void {
  const p = dpapiStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 原子替换:半写状态不会留下可被误读的文件
  const tmp = p + `.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 1), "utf-8");
    fs.renameSync(tmp, p);
  } catch (exc) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw exc;
  }
}

function dpapiGet(service: string, account: string): string | null {
  const blob = dpapiLoad()[dpapiKey(service, account)];
  if (!blob) return null;
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    `$d=[Convert]::FromBase64String('${blob}');` +
    `$e=[Convert]::FromBase64String('${entropy(service, account).toString("base64")}');` +
    "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($d,$e," +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($o)";
  const proc = spawnSync(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf-8", windowsHide: true, timeout: 20_000 },
  );
  if (proc.status !== 0) {
    throw new KeychainError(`DPAPI 解密失败:${(proc.stderr ?? "").trim().slice(0, 300)}`);
  }
  return Buffer.from((proc.stdout ?? "").trim(), "base64").toString("utf-8") || null;
}
