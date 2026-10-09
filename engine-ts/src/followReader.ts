/**
 * 本地收件的读窗口程序(docs/features/follow.md「本地收件」):填了频道名,引擎就自己把它拉起来、看着它、跟着自己一起退。
 *
 * 程序是 desktop/tools/discord-window-follow.swift 编译出来的那一份,带 `--supervised`:标准输出一行一个 JSON 状态,
 * 标准输入一断它就退。它在哪儿由宿主(桌面端主进程)用环境变量 `DAFRI_INBOX_READER` 告诉引擎;
 * 没给、不是 macOS、文件不在,就不自动启动,用户照旧可以自己运行脚本。
 *
 * 这里只管这个子进程:怎么起、状态行怎么读、退了之后隔多久再起。消息不经过这里——它直接追加进收件文件,由 followInbox.ts 读。
 *
 * - 退出码 77 = 没有辅助功能权限:隔 5 秒再拉起来看一眼(授权之后不用重启软件);系统的授权提示只让头一次拉起的那个弹。
 * - 别的退出:1 秒起步、翻倍、封顶一分钟;读上过就从头算。
 * - 标准输出里状态行之外的东西一律不认、不记:消息原文不进引擎日志。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 宿主用它告诉引擎读窗口程序的绝对路径。 */
export const READER_ENV = "DAFRI_INBOX_READER";
/** 读窗口程序说"没有辅助功能权限"的退出码(和 swift 那边对着)。 */
export const EXIT_UNTRUSTED = 77;
/** 频道名最长多少字(和 config.ts 的校验一致)。 */
export const CHANNEL_NAME_MAX = 100;

const UNTRUSTED_RETRY_MS = 5_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * starting    刚拉起,还没报状态
 * reading     窗口停在这个频道,正在读
 * waiting     Discord 开着,但没有窗口停在这个频道
 * no_list     窗口在这个频道,消息列表读不到(Discord 多半没带 --force-renderer-accessibility 启动)
 * no_discord  Discord 没在运行
 * untrusted   软件没有辅助功能权限
 * failed      程序起不来、或者自己退了,正在等下一次重启
 */
export type ReaderPhase = "starting" | "reading" | "waiting" | "no_list" | "no_discord" | "untrusted" | "failed";

const REPORTED: ReadonlySet<string> = new Set(["reading", "waiting", "no_list", "no_discord", "untrusted"]);

export interface ReaderStatus {
  state: ReaderPhase;
  /** 正在读的(或读不到列表的)那个窗口的标题 */
  title: string | null;
  /** failed 时的原因,人话 */
  error: string | null;
}

/** 这台机器上读窗口程序在哪;不能自动启动回 null。 */
export function readerProgram(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (platform !== "darwin") return null;
  const program = (env[READER_ENV] ?? "").trim();
  if (!program || !path.isAbsolute(program)) return null;
  try {
    return fs.statSync(program).isFile() ? program : null;
  } catch {
    return null;
  }
}

/** 拉起它的参数。askPermission:没有权限时让系统弹一次授权提示。 */
export function readerArgs(channel: string, out: string, askPermission: boolean): string[] {
  return ["--channel", channel, "--out", out, "--supervised", ...(askPermission ? ["--ask-permission"] : [])];
}

/** 一行标准输出 → 状态;不是状态行回 null。 */
export function parseReaderLine(line: string): { state: ReaderPhase; title: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const state = obj["state"];
  if (typeof state !== "string" || !REPORTED.has(state)) return null;
  const title = typeof obj["title"] === "string" && obj["title"] ? obj["title"].replace(/[\r\n]+/g, " ").slice(0, 200) : null;
  return { state: state as ReaderPhase, title };
}

/** 子进程里这里用得到的那几样(测试塞一个假的进来)。 */
export interface ReaderChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): boolean;
}

export interface ReaderOptions {
  /** 怎么起子进程(测试注入) */
  spawn?: (program: string, args: string[]) => ReaderChild;
}

export interface ReaderHooks {
  /** 状态变了 */
  onStatus(status: ReaderStatus): void;
}

function spawnReader(program: string, args: string[]): ReaderChild {
  // 标准输入留一根管道不写:引擎一没(正常退、崩了、被杀),管道就断,它读到头自己退
  return spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
}

/** 看管一个读窗口程序:起、读状态、退了再起,直到 stop。 */
export class FollowReader {
  private child: ReaderChild | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** 系统的授权提示让它弹过了 */
  private asked = false;
  private delayMs = RETRY_MIN_MS;
  private status: ReaderStatus = { state: "starting", title: null, error: null };

  constructor(
    readonly program: string,
    readonly channel: string,
    readonly out: string,
    private readonly hooks: ReaderHooks,
    private readonly options: ReaderOptions = {},
  ) {}

  get view(): ReaderStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.launch();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const old = this.child;
    this.child = null;
    old?.kill();
  }

  private launch(): void {
    this.timer = null;
    if (!this.running) return;
    let child: ReaderChild;
    try {
      child = (this.options.spawn ?? spawnReader)(this.program, readerArgs(this.channel, this.out, !this.asked));
    } catch (exc) {
      this.gone(null, null, (exc as Error).message);
      return;
    }
    this.asked = true;
    this.child = child;
    let buffered = "";
    child.stdout?.on("data", (chunk) => {
      if (this.child !== child) return;
      buffered += String(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseReaderLine(line.trim());
        if (parsed === null) continue;
        if (parsed.state === "reading") this.delayMs = RETRY_MIN_MS;
        this.set({ ...parsed, error: null });
      }
    });
    // 它往 stderr 写的只有固定的几句(写不进收件文件、参数不对),没有消息原文
    child.stderr?.on("data", (chunk) => {
      if (this.child === child) process.stderr.write(`[follow] 读窗口:${String(chunk).trim().slice(0, 300)}\n`);
    });
    child.on("error", (err) => this.gone(child, null, err.message));
    child.on("exit", (code) => this.gone(child, code, null));
  }

  /** 子进程没了(或者根本没起来)。同一个进程的 error 与 exit 可能都来,只认头一个。 */
  private gone(child: ReaderChild | null, code: number | null, error: string | null): void {
    if (child !== null) {
      if (this.child !== child) return;
      this.child = null;
    }
    if (!this.running) return;
    if (code === EXIT_UNTRUSTED) {
      this.set({ state: "untrusted", title: null, error: null });
      this.retryIn(UNTRUSTED_RETRY_MS);
      return;
    }
    const delay = this.delayMs;
    this.delayMs = Math.min(delay * 2, RETRY_MAX_MS);
    const why = error !== null ? `起不来(${error})` : `退出了(退出码 ${code ?? "无"})`;
    this.set({ state: "failed", title: null, error: `读窗口的程序${why},${Math.round(delay / 1000)} 秒后重新启动` });
    this.retryIn(delay);
  }

  private retryIn(ms: number): void {
    const timer = setTimeout(() => this.launch(), ms);
    // 引擎该退就退,不能被一次重启吊着
    timer.unref?.();
    this.timer = timer;
  }

  private set(next: ReaderStatus): void {
    const now = this.status;
    if (now.state === next.state && now.title === next.title && now.error === next.error) return;
    this.status = next;
    this.hooks.onStatus({ ...next });
  }
}
