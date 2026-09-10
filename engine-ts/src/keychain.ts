/** 凭证读写(对应 Python keychain.py,§9.2 / §10.4)。
 *
 * S0 级数据只走这里:不落配置文件、不进环境变量、不硬编码。
 * macOS 走系统 Keychain(security 命令);Windows 走 DPAPI——密文文件、
 * 键名(service\x00account)、附加熵(dafri\x00service\x00account)与 Python 版
 * **完全相同**,两个实现读写同一份 credentials.dpapi.json,迁移期可交替使用。
 * DPAPI 通过 PowerShell 的 System.Security.Cryptography.ProtectedData 调用,
 * 不引入原生依赖。其余平台显式报错,不退化为明文。
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class KeychainError extends Error {}

export function isSupported(): boolean {
  return os.platform() === "darwin" || os.platform() === "win32";
}

function requireSupported(): void {
  if (!isSupported()) {
    throw new KeychainError(
      "当前平台既不是 macOS 也不是 Windows,没有可用的系统凭证存储。" +
      "任何情况下都不要退化为明文配置或环境变量。",
    );
  }
}

/**
 * 解密结果的进程内缓存。Windows 上每次解密都要**同步**起一个 PowerShell(约 0.8 秒),期间整个
 * 引擎进程的事件循环被占住——盯盘节拍器、所有 RPC、IB 的消息处理全停(2026-09-10 真机:每次大模型
 * 解析都让节拍器晚一拍,事件循环被占 868 ms)。同一进程里只解一次;写入 / 删除时同步更新。
 */
const secretCache = new Map<string, string | null>();
const cacheKey = (service: string, account: string): string => `${service}\x00${account}`;

export function getSecret(service: string, account: string): string | null {
  requireSupported();
  const key = cacheKey(service, account);
  if (secretCache.has(key)) return secretCache.get(key)!;
  const value = getSecretUncached(service, account);
  secretCache.set(key, value);
  return value;
}

/** 有没有保存过这条凭证——**不解密**。界面上的"已保存"只需要 true/false,不该为它起一次 PowerShell。 */
export function hasSecret(service: string, account: string): boolean {
  requireSupported();
  const key = cacheKey(service, account);
  if (secretCache.has(key)) return secretCache.get(key) !== null;
  if (os.platform() === "win32") return dpapiKey(service, account) in dpapiLoad();
  return getSecret(service, account) !== null;
}

/**
 * 在后台(异步子进程)先把凭证解出来放进缓存,之后的 getSecret 直接命中、一次也不卡事件循环。
 * 引擎启动时对当前大模型的 Key 调一次;失败就算了,真用到时同步路径照样能解。
 */
export async function primeSecret(service: string, account: string): Promise<void> {
  if (!isSupported()) return;
  const key = cacheKey(service, account);
  if (secretCache.has(key)) return;
  if (os.platform() !== "win32") return; // macOS 的 security 命令够快,不必预热
  const blob = dpapiLoad()[dpapiKey(service, account)];
  if (blob === undefined) {
    secretCache.set(key, null);
    return;
  }
  const script = dpapiScript(Buffer.from(blob, "base64"), entropy(service, account), true);
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf-8", windowsHide: true, timeout: 15_000 },
      (err, stdout) => resolve(err ? null : String(stdout ?? "").trim()),
    );
  });
  if (out === null || secretCache.has(key)) return; // 失败,或同步路径抢先解完了
  const secret = Buffer.from(out, "base64").toString("utf-8");
  secretCache.set(key, secret || null);
}

function getSecretUncached(service: string, account: string): string | null {
  if (os.platform() === "win32") return dpapiGet(service, account);
  const proc = spawnSync(
    "security", ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf-8" },
  );
  if (proc.status !== 0) return null;
  const secret = (proc.stdout ?? "").trim();
  return secret || null;
}

export function setSecret(service: string, account: string, secret: string): void {
  requireSupported();
  if (!secret) throw new KeychainError("拒绝写入空密钥");
  secretCache.delete(cacheKey(service, account));
  if (os.platform() === "win32") {
    dpapiSet(service, account, secret);
    secretCache.set(cacheKey(service, account), secret);
    return;
  }
  const proc = spawnSync(
    "security",
    [
      "add-generic-password", "-s", service, "-a", account, "-w", secret,
      "-U", "-D", "dafri trading agent secret",
    ],
    { encoding: "utf-8" },
  );
  if (proc.status !== 0) {
    throw new KeychainError(`写入 Keychain 失败:${(proc.stderr ?? "").trim()}`);
  }
}

export function deleteSecret(service: string, account: string): boolean {
  requireSupported();
  secretCache.delete(cacheKey(service, account));
  if (os.platform() === "win32") return dpapiDelete(service, account);
  const proc = spawnSync(
    "security", ["delete-generic-password", "-s", service, "-a", account],
    { encoding: "utf-8" },
  );
  return proc.status === 0;
}

// ---------------------------------------------------------------- Windows DPAPI
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

/** DPAPI 加解密走 PowerShell 的 ProtectedData(按当前用户,禁 UI)。 */
function dpapiCrypt(data: Buffer, ent: Buffer, decrypt: boolean): Buffer {
  const script = dpapiScript(data, ent, decrypt);
  const proc = spawnSync(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf-8", windowsHide: true },
  );
  if (proc.status !== 0) {
    throw new KeychainError(
      `DPAPI ${decrypt ? "解密" : "加密"}失败:${(proc.stderr ?? "").trim().slice(0, 300)}`,
    );
  }
  return Buffer.from((proc.stdout ?? "").trim(), "base64");
}

function dpapiScript(data: Buffer, ent: Buffer, decrypt: boolean): string {
  const method = decrypt ? "Unprotect" : "Protect";
  return (
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    `$d=[Convert]::FromBase64String('${data.toString("base64")}');` +
    `$e=[Convert]::FromBase64String('${ent.toString("base64")}');` +
    `$o=[System.Security.Cryptography.ProtectedData]::${method}($d,$e,` +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($o)"
  );
}

function dpapiLoad(): Record<string, string> {
  const p = dpapiStorePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (exc) {
    throw new KeychainError(`凭证文件损坏或不可读:${p}(${(exc as Error).message})`);
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
  const entry = dpapiLoad()[dpapiKey(service, account)];
  if (!entry) return null;
  const raw = dpapiCrypt(Buffer.from(entry, "base64"), entropy(service, account), true);
  const secret = raw.toString("utf-8");
  return secret || null;
}

function dpapiSet(service: string, account: string, secret: string): void {
  const entries = dpapiLoad();
  const blob = dpapiCrypt(Buffer.from(secret, "utf-8"), entropy(service, account), false);
  entries[dpapiKey(service, account)] = blob.toString("base64");
  dpapiSave(entries);
}

function dpapiDelete(service: string, account: string): boolean {
  const entries = dpapiLoad();
  const key = dpapiKey(service, account);
  if (!(key in entries)) return false;
  delete entries[key];
  dpapiSave(entries);
  return true;
}
