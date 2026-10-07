/**
 * 本地收件(docs/features/follow.md「本地收件」):对方的私密频道拉不进 bot 时,本机脚本(desktop/tools/discord-window-follow.swift)
 * 从屏幕上的 Discord 窗口把新消息抄下来,一行一个 JSON 追加到 `<交易库目录>/follow-inbox.jsonl`;引擎只读这个文件。
 *
 * 这里只管文件:从哪儿读起、一行怎么变成一条消息。判定、信任、发单在 services/follow.ts,和 bot 读来的消息走同一条路。
 *
 * - **从文件此刻的末尾读起。** 引擎没在跑时追加的行不补:它们早就过了新鲜期,补进来只会刷一串「太旧」。
 * - 文件变短(被清空、换了一个)就从头读:脚本每天换文件也不会漏。
 * - 认不出的行记下原因、跳过,后面的行照读;脚本写坏一行不该让跟单停下。
 * - 发送者是屏幕上的显示名,不是用户 ID:`local:名字`。频道里别人改昵称冒充得了它,所以只适合私密小群,文档里写明。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { DiscordMessage } from "./discordGateway.js";

/** 收件文件名;放在交易库旁边,路径由 db_path 定,界面上显示给人看、脚本照着写。 */
export const INBOX_FILE = "follow-inbox.jsonl";
/** 本地收件的消息在判定里当成这个"频道"。 */
export const LOCAL_CHANNEL = "local";
/** 显示名最长留多少字(和 config.ts 的 LOCAL_AUTHOR 一致)。 */
export const LOCAL_NAME_MAX = 80;

export function inboxPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), INBOX_FILE);
}

/** 显示名 → 信任名单里的那一项。换行压成空格、掐头去尾、截到 80 字。 */
export function localAuthorId(name: string): string {
  return `local:${name.replace(/[\r\n]+/g, " ").trim().slice(0, LOCAL_NAME_MAX)}`;
}

/** 脚本写的一行。v 之外的字段都是字符串;key 是脚本给这条消息算的唯一标识(同一条不重复)。 */
export interface InboxLine {
  v: number;
  key: string;
  seen_at: string;
  channel: string;
  author: string;
  time_label: string;
  content: string;
}

export type ParsedLine = { ok: true; message: DiscordMessage } | { ok: false; error: string };

/** 一行 → 一条消息。消息 ID 是 `local:` 加脚本的 key;时刻是脚本看见它的时刻(屏幕上只有"几点几分",没有秒)。 */
export function parseInboxLine(line: string): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "不是 JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "不是对象" };
  const obj = raw as Record<string, unknown>;
  if (obj["v"] !== 1) return { ok: false, error: `不认识的版本 v=${String(obj["v"])}` };
  const str = (k: string): string | null => (typeof obj[k] === "string" ? (obj[k] as string) : null);
  const key = str("key")?.trim() ?? "";
  if (!key || key.length > 120) return { ok: false, error: "key 缺了或太长" };
  const author = str("author")?.replace(/[\r\n]+/g, " ").trim() ?? "";
  if (!author) return { ok: false, error: "author 缺了" };
  const content = str("content");
  if (content === null) return { ok: false, error: "content 缺了" };
  const sentAtMs = Date.parse(str("seen_at") ?? "");
  if (!Number.isFinite(sentAtMs)) return { ok: false, error: "seen_at 不是时刻" };
  return {
    ok: true,
    message: {
      id: `local:${key}`,
      channel_id: LOCAL_CHANNEL,
      author_id: localAuthorId(author),
      author_name: author.slice(0, LOCAL_NAME_MAX),
      content,
      sentAtMs,
    },
  };
}

export interface InboxHooks {
  onMessage(message: DiscordMessage): void;
  /** 一行认不出、文件读不了:人话。读得好了之后不会再调 */
  onError(error: string): void;
}

export interface InboxOptions {
  /** 多久看一次文件;默认 1 秒 */
  intervalMs?: number;
}

/** 盯着收件文件,新追加的行变成消息。 */
export class FollowInbox {
  private offset = 0;
  private partial = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  received = 0;
  lastAt: string | null = null;

  constructor(readonly path: string, private readonly hooks: InboxHooks, private readonly options: InboxOptions = {}) {}

  get error(): string | null {
    return this.lastError;
  }

  get watching(): boolean {
    return this.timer !== null;
  }

  /** 从文件此刻的末尾读起,之后每隔一会儿读一次新追加的内容。 */
  start(): void {
    if (this.timer !== null) return;
    this.offset = this.sizeNow();
    this.partial = "";
    const timer = setInterval(() => this.poll(), this.options.intervalMs ?? 1000);
    // 界面关了、stdin 断了,引擎进程该退就退,不能被它吊着
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private sizeNow(): number {
    try {
      return fs.statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** 读一次新内容。测试和「重新读一遍」直接调。 */
  poll(): void {
    let size: number;
    try {
      size = fs.statSync(this.path).size;
    } catch (exc) {
      // 文件还没建:脚本没起过。不算错,等它出现
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
        this.offset = 0;
        return;
      }
      this.fail(`读不了收件文件:${(exc as Error).message}`);
      return;
    }
    if (size < this.offset) {
      // 变短了:被清空或换了一个文件,从头读
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return;
    let chunk: string;
    try {
      const fd = fs.openSync(this.path, "r");
      try {
        const buf = Buffer.alloc(size - this.offset);
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        chunk = buf.subarray(0, n).toString("utf-8");
        this.offset += n;
      } finally {
        fs.closeSync(fd);
      }
    } catch (exc) {
      this.fail(`读不了收件文件:${(exc as Error).message}`);
      return;
    }
    const text = this.partial + chunk;
    const lines = text.split("\n");
    // 最后一段没换行:脚本可能正写到一半,留到下一次
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseInboxLine(trimmed);
      if (!parsed.ok) {
        this.fail(`收件文件里有一行认不出(${parsed.error}),跳过:${trimmed.slice(0, 80)}`);
        continue;
      }
      this.received += 1;
      this.lastAt = new Date().toISOString();
      this.lastError = null;
      this.hooks.onMessage(parsed.message);
    }
  }

  private fail(error: string): void {
    if (this.lastError === error) return;
    this.lastError = error;
    this.hooks.onError(error);
  }
}
