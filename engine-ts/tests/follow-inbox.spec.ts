/** 本地收件(src/followInbox.ts):一行怎么变成一条消息、从哪儿读起、坏行怎么处理。全部离线,用临时文件。 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { DiscordMessage } from "../src/discordGateway.js";
import { FollowInbox, LOCAL_CHANNEL, inboxPath, localAuthorId, parseInboxLine } from "../src/followInbox.js";

const LINE = { v: 1, key: "k1", seen_at: "2026-10-07T07:50:21.123Z", channel: "charlie的策略", author: "Charlie", time_label: "15:50", content: "1.8 挂15蝴蝶 15CM" };
const json = (patch: Record<string, unknown> = {}): string => JSON.stringify({ ...LINE, ...patch });

describe("followInbox: 一行 → 一条消息", () => {
  it("合法的一行:ID 带 local: 前缀,频道是 local,发送者是显示名,时刻是脚本看见它的时刻", () => {
    const parsed = parseInboxLine(json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message).toEqual({
      id: "local:k1", channel_id: LOCAL_CHANNEL, author_id: "local:Charlie", author_name: "Charlie",
      content: "1.8 挂15蝴蝶 15CM", sentAtMs: Date.parse("2026-10-07T07:50:21.123Z"),
    });
  });

  it("显示名里的换行压成空格、截到 80 字", () => {
    expect(localAuthorId(" A\nB ")).toBe("local:A B");
    expect(localAuthorId("x".repeat(100))).toBe(`local:${"x".repeat(80)}`);
  });

  it("不是 JSON、版本不对、缺字段、时刻不对:各说各的原因", () => {
    const bad = (line: string): string => { const p = parseInboxLine(line); return p.ok ? "ok" : p.error; };
    expect(bad("{nope")).toBe("不是 JSON");
    expect(bad("[1]")).toBe("不是对象");
    expect(bad(json({ v: 2 }))).toContain("版本");
    expect(bad(json({ key: "" }))).toContain("key");
    expect(bad(json({ author: "  " }))).toContain("author");
    expect(bad(json({ content: 5 }))).toContain("content");
    expect(bad(json({ seen_at: "昨天" }))).toContain("seen_at");
  });

  it("收件文件放在交易库旁边", () => {
    expect(inboxPath("/x/y/trades.db")).toBe("/x/y/follow-inbox.jsonl");
  });
});

function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-inbox-"));
  const file = path.join(dir, "follow-inbox.jsonl");
  const got: DiscordMessage[] = [];
  const errors: string[] = [];
  const inbox = new FollowInbox(file, { onMessage: (m) => got.push(m), onError: (e) => errors.push(e) }, { intervalMs: 60_000 });
  return { file, got, errors, inbox };
}

describe("followInbox: 盯文件", () => {
  it("从启动时的末尾读起:引擎没在跑时追加的旧行不补;之后追加的每一行都到", () => {
    const { file, got, inbox } = harness();
    writeFileSync(file, json({ key: "old" }) + "\n");
    inbox.start();
    inbox.poll();
    expect(got).toEqual([]);
    appendFileSync(file, json({ key: "a" }) + "\n" + json({ key: "b" }) + "\n");
    inbox.poll();
    expect(got.map((m) => m.id)).toEqual(["local:a", "local:b"]);
    expect(inbox.received).toBe(2);
    expect(inbox.lastAt).not.toBeNull();
    inbox.stop();
    expect(inbox.watching).toBe(false);
  });

  it("文件还没建:不算错,建了之后从头读", () => {
    const { file, got, errors, inbox } = harness();
    inbox.start();
    inbox.poll();
    expect(errors).toEqual([]);
    writeFileSync(file, json({ key: "first" }) + "\n");
    inbox.poll();
    expect(got.map((m) => m.id)).toEqual(["local:first"]);
  });

  it("写到一半的行留到下一次;坏行记原因、跳过,后面的照读;文件变短就从头读", () => {
    const { file, got, errors, inbox } = harness();
    writeFileSync(file, "");
    inbox.start();
    appendFileSync(file, json({ key: "a" }) + "\n" + '{"v":1,"key":"half"');
    inbox.poll();
    expect(got.map((m) => m.id)).toEqual(["local:a"]);
    appendFileSync(file, ',"seen_at":"2026-10-07T07:50:21Z","author":"C","content":"x"}\n' + "garbage\n" + json({ key: "c" }) + "\n");
    inbox.poll();
    expect(got.map((m) => m.id)).toEqual(["local:a", "local:half", "local:c"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不是 JSON");
    expect(inbox.error).toBeNull(); // 后来读好了,错就清了
    // 换了一个文件(变短):从头读
    writeFileSync(file, json({ key: "fresh" }) + "\n");
    inbox.poll();
    expect(got.map((m) => m.id)).toEqual(["local:a", "local:half", "local:c", "local:fresh"]);
  });
});
