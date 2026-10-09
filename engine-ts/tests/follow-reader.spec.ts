/** 本地收件的读窗口程序怎么被看管(src/followReader.ts)。
 *
 * 全部离线:子进程是假的(一个能发 stdout / exit 的对象),时间用假时钟推,不等真的秒数。
 * 钉的是"它没在读的时候,软件知不知道、会不会再把它拉起来":状态行怎么认、退出之后隔多久重启、停了之后不再碰。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_UNTRUSTED, FollowReader, READER_ENV, parseReaderLine, readerArgs, readerProgram } from "../src/followReader.js";
import type { ReaderChild, ReaderStatus } from "../src/followReader.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  constructor(readonly args: string[]) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  say(obj: unknown): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }
  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

function build(failSpawn: () => boolean = () => false) {
  const children: FakeChild[] = [];
  const seen: ReaderStatus[] = [];
  const reader = new FollowReader("/opt/reader", "charlie的策略", "/data/follow-inbox.jsonl", { onStatus: (s) => seen.push(s) }, {
    spawn: (_program, args) => {
      if (failSpawn()) throw new Error("spawn EACCES");
      const child = new FakeChild(args);
      children.push(child);
      return child as unknown as ReaderChild;
    },
  });
  const last = (): FakeChild => children[children.length - 1]!;
  return { reader, children, seen, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("读窗口程序:在哪、怎么拉起", () => {
  it("只在 macOS 上、宿主给了绝对路径、文件真的在,才算有", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-reader-"));
    const program = path.join(dir, "discord-window-follow");
    writeFileSync(program, "");
    expect(readerProgram({ [READER_ENV]: program }, "darwin")).toBe(program);
    expect(readerProgram({ [READER_ENV]: program }, "win32")).toBeNull();
    expect(readerProgram({ [READER_ENV]: program }, "linux")).toBeNull();
    expect(readerProgram({}, "darwin")).toBeNull();
    expect(readerProgram({ [READER_ENV]: "  " }, "darwin")).toBeNull();
    expect(readerProgram({ [READER_ENV]: "discord-window-follow" }, "darwin")).toBeNull();
    expect(readerProgram({ [READER_ENV]: path.join(dir, "没有这个文件") }, "darwin")).toBeNull();
    expect(readerProgram({ [READER_ENV]: dir }, "darwin")).toBeNull();
  });

  it("参数:频道名与收件文件原样各占一个参数(不过 shell);要不要弹授权提示是单独的一个开关", () => {
    expect(readerArgs("charlie的策略", "/a b/follow-inbox.jsonl", false)).toEqual(["--channel", "charlie的策略", "--out", "/a b/follow-inbox.jsonl", "--supervised"]);
    expect(readerArgs("--out", "/x", true)).toEqual(["--channel", "--out", "--out", "/x", "--supervised", "--ask-permission"]);
  });
});

describe("读窗口程序:状态行", () => {
  it("认五种状态,窗口标题带出来;别的一律不认", () => {
    expect(parseReaderLine('{"count":33,"state":"reading","title":"#charlie的策略 | 某服务器 - Discord"}')).toEqual({ state: "reading", title: "#charlie的策略 | 某服务器 - Discord" });
    expect(parseReaderLine('{"state":"waiting"}')).toEqual({ state: "waiting", title: null });
    expect(parseReaderLine('{"state":"no_list","title":"a\\nb"}')).toEqual({ state: "no_list", title: "a b" });
    expect(parseReaderLine('{"state":"no_discord"}')?.state).toBe("no_discord");
    expect(parseReaderLine('{"state":"untrusted"}')?.state).toBe("untrusted");
    // starting / failed 是这边自己的状态,程序报了也不认;人话、消息原文、坏 JSON 都不认
    for (const junk of ['{"state":"failed"}', '{"state":"starting"}', '{"state":7}', "[1]", "null", "已就位:窗口…", '{"v":1,"content":"1.8 挂15蝴蝶"}', ""]) {
      expect(parseReaderLine(junk), junk).toBeNull();
    }
  });
});

describe("读窗口程序:看管", () => {
  it("拉起来:头一次带上授权提示的开关;状态行跨两次送达也认,状态没变不重复报", () => {
    const { reader, children, seen, last } = build();
    reader.start();
    reader.start();
    expect(children).toHaveLength(1);
    expect(last().args).toEqual(["--channel", "charlie的策略", "--out", "/data/follow-inbox.jsonl", "--supervised", "--ask-permission"]);
    expect(reader.view).toEqual({ state: "starting", title: null, error: null });
    last().stdout.emit("data", Buffer.from('{"state":"rea'));
    expect(seen).toEqual([]);
    last().stdout.emit("data", Buffer.from('ding","title":"#charlie的策略"}\n一句人话\n{"state":"reading","title":"#charlie的策略"}\n'));
    expect(seen).toEqual([{ state: "reading", title: "#charlie的策略", error: null }]);
    last().say({ state: "waiting" });
    expect(reader.view.state).toBe("waiting");
    expect(seen).toHaveLength(2);
    reader.stop();
  });

  it("没有辅助功能权限(退出码 77):每 5 秒再拉起来看一眼,授权提示不再弹;授权之后自己接上", () => {
    const { reader, children, seen, last } = build();
    reader.start();
    last().say({ state: "untrusted" });
    last().exit(EXIT_UNTRUSTED);
    expect(reader.view.state).toBe("untrusted");
    vi.advanceTimersByTime(4999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    expect(last().args).not.toContain("--ask-permission");
    last().say({ state: "untrusted" });
    last().exit(EXIT_UNTRUSTED);
    // 一直没权限:界面上那一行不闪,也不一遍遍推事件
    expect(seen.map((s) => s.state)).toEqual(["untrusted"]);
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(3);
    last().say({ state: "reading", title: "#charlie的策略" });
    expect(reader.view.state).toBe("reading");
    reader.stop();
  });

  it("自己退了:说明原因,1 秒、2 秒、4 秒……封顶一分钟地重启;读上过就从头算", () => {
    const { reader, children, last } = build();
    reader.start();
    last().exit(1);
    expect(reader.view).toEqual({ state: "failed", title: null, error: "读窗口的程序退出了(退出码 1),1 秒后重新启动" });
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
    last().exit(null);
    expect(reader.view.error).toBe("读窗口的程序退出了(退出码 无),2 秒后重新启动");
    vi.advanceTimersByTime(1999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
    for (let i = 0; i < 8; i += 1) {
      last().exit(1);
      vi.advanceTimersByTime(60_000);
    }
    expect(reader.view.error).toBe("读窗口的程序退出了(退出码 1),60 秒后重新启动");
    // 读上了:下一次退出从 1 秒重新算
    last().say({ state: "reading", title: "t" });
    last().exit(0);
    expect(reader.view.error).toBe("读窗口的程序退出了(退出码 0),1 秒后重新启动");
    reader.stop();
  });

  it("起不来(程序不能执行、系统不让起):同一套重启;同一个进程的 error 与 exit 只算一次", () => {
    let broken = true;
    const { reader, children, last } = build(() => broken);
    reader.start();
    expect(children).toHaveLength(0);
    expect(reader.view).toEqual({ state: "failed", title: null, error: "读窗口的程序起不来(spawn EACCES),1 秒后重新启动" });
    broken = false;
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(1);
    last().emit("error", new Error("spawn ENOENT"));
    last().exit(-2);
    expect(reader.view.error).toBe("读窗口的程序起不来(spawn ENOENT),2 秒后重新启动");
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(2);
    reader.stop();
  });

  it("停:杀掉子进程,等着的重启取消,它之后再说什么、再退出都不理", () => {
    const { reader, children, seen, last } = build();
    reader.start();
    const first = last();
    first.say({ state: "reading", title: "t" });
    reader.stop();
    expect(first.killed).toBe(true);
    first.say({ state: "waiting" });
    first.exit(0);
    vi.advanceTimersByTime(120_000);
    expect(children).toHaveLength(1);
    expect(seen.map((s) => s.state)).toEqual(["reading"]);
    // 等重启的那一会儿里停:不再拉起
    const again = build();
    again.reader.start();
    again.last().exit(1);
    again.reader.stop();
    vi.advanceTimersByTime(120_000);
    expect(again.children).toHaveLength(1);
  });
});
