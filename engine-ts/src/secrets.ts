/** 引擎进程里的凭证读写:一律异步、有时限,一个系统弹窗只耽误要用这把钥匙的那一件事。
 *
 * macOS 钥匙串条目的访问控制认的是写入它的那个程序的签名。没有正式签名的包每重打一次就是一个新身份,
 * 第一次解密会弹窗问人。原生库是同步调用,在弹窗前一直等;要是在引擎进程里调,整个事件循环跟着停:
 * 盯盘节拍、托管单对账、所有 RPC 一起停。所以:
 *
 *  · 有没有存过(`secretExists`,界面一打开就要问):macOS 用 `security find-generic-password` 不带 `-w`,
 *    只读属性、不解密,访问控制对不上也不弹窗;Windows 读凭据管理器不弹窗,放进子进程读。答案记在进程里,
 *    自己写过、读过就更新,不再重复问。
 *  · 真要用这把钥匙(`readSecret`)与写入(`writeSecret`):交给凭证子进程(`keychainChild.ts`)。子进程就是引擎自己的
 *    可执行文件(打包版是应用本体 + ELECTRON_RUN_AS_NODE),钥匙串认的程序身份和以前一样,访问控制的语义不变。
 *    调用方最多等 `SECRET_TIMEOUT_MS`,到点拿到一句说清楚怎么办的错。子进程留着:弹窗还在屏幕上,
 *    用户点了「始终允许」下一次就不再问;同一条凭证同时只起一个读的子进程,后来的调用接着等它。
 *    `CHILD_HARD_CAP_MS` 之后才杀掉,弹窗随之消失。
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { KeychainError, isSupported, requireSupported } from "./keychain.js";
import type { KeychainReply, KeychainRequest } from "./keychain.js";

export { KeychainError };

/** 等凭证库等到了点。调用方据此说"去处理系统弹窗",而不是"没配置"。 */
export class KeychainTimeoutError extends KeychainError {}

/** 解密一次、写入一次最多等多久。要留出输登录密码的时间;又不能太长:下单解析在交易道上等它,后面排着的请求一起等。 */
export const SECRET_TIMEOUT_MS = 20_000;
/** 只查有没有最多等多久。正常几十毫秒,只有钥匙串被锁、要人解锁时才会等。 */
export const EXISTS_TIMEOUT_MS = 8_000;
/** 调用方放弃之后子进程还留多久。留着是为了让用户还来得及在弹窗里点「始终允许」。 */
export const CHILD_HARD_CAP_MS = 180_000;

/** 凭证库的三件事。真的那个是 `childBackend()`;测试换成假的(`useSecretBackend`)。 */
export interface SecretBackend {
  /** 有没有存过。不解密,不因访问控制弹窗。 */
  exists(service: string, account: string): Promise<boolean>;
  /** 取出明文(没有是 null)。可能弹系统对话框问人,可能很久不返回。 */
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, secret: string): Promise<void>;
}

/** 读一条凭证的函数(富途解锁拿它读密码,测试注入假的)。 */
export type SecretReader = (service: string, account: string) => Promise<string | null>;

interface Limits {
  timeoutMs: number;
  existsTimeoutMs: number;
}

const DEFAULT_LIMITS: Limits = { timeoutMs: SECRET_TIMEOUT_MS, existsTimeoutMs: EXISTS_TIMEOUT_MS };

let backend: SecretBackend | null = null;
let limits: Limits = DEFAULT_LIMITS;
/** 记下的"有没有存过":界面每次打开都要问,不必每次都去查 */
const known = new Map<string, boolean>();
/** 每条凭证被写过几次:查询发出之后又写过,那次查询的答案就旧了,不记 */
const writes = new Map<string, number>();
/** 在途的解密读:同一条凭证同时只起一个子进程(同时只弹一个窗) */
const pendingReads = new Map<string, Promise<string | null>>();

const keyOf = (service: string, account: string): string => `${service}\u0000${account}`;
const writesOf = (key: string): number => writes.get(key) ?? 0;
const current = (): SecretBackend => (backend ??= childBackend());

/** 换掉凭证后端(测试用;传 null 回到真的),时限也可以一起改短。记下的答案与在途的读一并清掉。 */
export function useSecretBackend(next: SecretBackend | null, opts: Partial<Limits> = {}): void {
  backend = next;
  limits = { ...DEFAULT_LIMITS, ...opts };
  known.clear();
  writes.clear();
  pendingReads.clear();
}

/** 有没有存过这条凭证。不解密;查不出来(超时、出错)按没存过答,不记,下次再查。 */
export async function secretExists(service: string, account: string): Promise<boolean> {
  const key = keyOf(service, account);
  const cached = known.get(key);
  if (cached !== undefined) return cached;
  const before = writesOf(key);
  try {
    const exists = await withDeadline(
      current().exists(service, account), limits.existsTimeoutMs,
      () => new KeychainTimeoutError(`查询系统凭证库超时(service=${service}, account=${account})`),
    );
    if (writesOf(key) === before) known.set(key, exists);
    return exists;
  } catch (exc) {
    process.stderr.write(`[keychain] 查不出 ${service}/${account} 有没有存过,先按没存过显示:${(exc as Error).message}\n`);
    return false;
  }
}

/** 取出一条凭证的明文(没有是 null)。最多等 SECRET_TIMEOUT_MS,到点抛 KeychainTimeoutError;在途的那次读不撤。 */
export async function readSecret(service: string, account: string): Promise<string | null> {
  const key = keyOf(service, account);
  let pending = pendingReads.get(key);
  if (pending === undefined) {
    const before = writesOf(key);
    const started = current().read(service, account).then((value) => {
      if (writesOf(key) === before) known.set(key, value !== null);
      return value;
    });
    const settle = (): void => {
      if (pendingReads.get(key) === started) pendingReads.delete(key);
    };
    started.then(settle, settle);
    pendingReads.set(key, started);
    pending = started;
  }
  return withDeadline(pending, limits.timeoutMs, () => new KeychainTimeoutError(timeoutMessage("交出", service, account)));
}

/** 写入一条凭证。最多等 SECRET_TIMEOUT_MS;超时的那次写不撤,用户在弹窗里点了允许它会自己写完。 */
export async function writeSecret(service: string, account: string, secret: string): Promise<void> {
  if (!secret) throw new KeychainError("拒绝写入空密钥");
  const key = keyOf(service, account);
  writes.set(key, writesOf(key) + 1);
  known.delete(key);
  pendingReads.delete(key);
  await withDeadline(
    current().write(service, account, secret), limits.timeoutMs,
    () => new KeychainTimeoutError(
      timeoutMessage("写完", service, account) + "在弹窗里点了允许之后,这次保存会自己完成;没看到弹窗就再保存一次。",
    ),
  );
  writes.set(key, writesOf(key) + 1);
  known.set(key, true);
}

function timeoutMessage(what: string, service: string, account: string): string {
  const seconds = Math.round(limits.timeoutMs / 1000);
  const hint = process.platform === "darwin"
    ? "macOS 多半正在弹窗,问是否允许本软件使用这条钥匙串项目(没有正式签名的版本,每换一个新安装包都会问一次):" +
      "请在弹窗里输入这台 Mac 的登录密码,点「始终允许」,再重试这一步。"
    : "请稍后重试这一步。";
  return `系统凭证库 ${seconds} 秒没有${what}凭证(service=${service}, account=${account})。${hint}` +
    "盯盘、托管单与其它功能照常运行。";
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (exc: unknown) => {
        clearTimeout(timer);
        reject(exc instanceof Error ? exc : new KeychainError(String(exc)));
      },
    );
  });
}

// ---------------------------------------------------------------- 真的后端
export interface ChildBackendOptions {
  /** 子进程入口,默认是编译出来的 keychainChild.js(测试指到假的) */
  entry?: string;
  /** 调用方放弃之后子进程最多再留多久 */
  hardCapMs?: number;
}

export function childBackend(opts: ChildBackendOptions = {}): SecretBackend {
  const ask = async (request: KeychainRequest): Promise<{ value: string | null; exists: boolean }> => {
    const reply = await callKeychainChild(request, opts);
    if (!reply.ok) throw new KeychainError(reply.error);
    return reply;
  };
  return {
    async exists(service, account) {
      if (!isSupported()) return false; // 没有系统凭证库就是没存过
      if (process.platform === "darwin") return securityHasItem(service, account);
      return (await ask({ op: "has", service, account })).exists;
    },
    async read(service, account) {
      requireSupported();
      return (await ask({ op: "get", service, account })).value;
    },
    async write(service, account, secret) {
      requireSupported();
      await ask({ op: "set", service, account, secret });
    },
  };
}

/** macOS:不带 `-w` / `-g` 的 `security find-generic-password` 只读属性、不解密,访问控制对不上也不弹窗。0 = 有,44 = 没有。 */
function securityHasItem(service: string, account: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security", ["find-generic-password", "-s", service, "-a", account],
      { timeout: limits.existsTimeoutMs, killSignal: "SIGKILL" },
      (err) => {
        if (err === null) resolve(true);
        else if (err.code === 44) resolve(false);
        else reject(new KeychainError(`查询钥匙串失败(service=${service}, account=${account}):${err.message}`));
      },
    );
  });
}

/** 起一个凭证子进程做一次请求。子进程的 stdin 一直开着:引擎一退出管道就断,子进程跟着结束(见 keychainChild.ts)。 */
export function callKeychainChild(request: KeychainRequest, opts: ChildBackendOptions = {}): Promise<KeychainReply> {
  const entry = opts.entry ?? fileURLToPath(new URL("./keychainChild.js", import.meta.url));
  const hardCapMs = opts.hardCapMs ?? CHILD_HARD_CAP_MS;
  if (!fs.existsSync(entry)) {
    return Promise.reject(new KeychainError(`找不到凭证子进程 ${entry}:引擎没有编译完整,请重新安装`));
  }
  return new Promise<KeychainReply>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // 同一个可执行文件:钥匙串按程序身份放行,换成别的程序就要重新问一遍
      child = spawn(process.execPath, [entry], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (exc) {
      reject(new KeychainError(`起不来凭证子进程:${(exc as Error).message}`));
      return;
    }
    let out = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      process.stderr.write(chunk);
    });
    const cap = setTimeout(() => child.kill("SIGKILL"), hardCapMs);
    cap.unref();
    child.on("error", (err) => {
      clearTimeout(cap);
      reject(new KeychainError(`凭证子进程出错:${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(cap);
      const line = out.trim().split("\n").pop() ?? "";
      try {
        const reply = JSON.parse(line) as KeychainReply;
        if (typeof reply === "object" && reply !== null && typeof reply.ok === "boolean") {
          resolve(reply);
          return;
        }
      } catch {
        /* 下面报 */
      }
      reject(new KeychainError(
        signal === null ? `凭证子进程没有给出结果(退出码 ${code})` : `凭证子进程没有给出结果就被结束了(${signal})`,
      ));
    });
    child.stdin?.on("error", () => {
      /* 子进程已经退了:结果看 close */
    });
    child.stdin?.write(JSON.stringify(request) + "\n");
  });
}
