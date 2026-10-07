/** Discord Gateway 的最小客户端:认证、心跳、续连、停下来的时机。全部离线:socket 是假的,时钟是假的。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscordGateway, GATEWAY_URL, INTENTS, parseMessage, snowflakeMs } from "../src/discordGateway.js";
import type { DiscordMessage, GatewayPhase, SocketLike } from "../src/discordGateway.js";

class FakeSocket implements SocketLike {
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  readonly sent: Array<Record<string, any>> = [];
  closedWith: number | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  /** Discord 发来一帧 */
  frame(payload: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(payload));
  }

  /** 连接断了 */
  drop(code: number): void {
    this.onclose?.(code);
  }

  ops(): number[] {
    return this.sent.map((p) => p["op"]);
  }
}

const HELLO = { op: 10, d: { heartbeat_interval: 40_000 } };
const READY = {
  op: 0, t: "READY", s: 1,
  d: { session_id: "sess-1", resume_gateway_url: "wss://resume.discord.gg", user: { username: "follow-bot" } },
};
const MESSAGE_ID = String(((BigInt(Date.UTC(2026, 7, 14, 14, 32, 0)) - 1420070400000n) << 22n) + 7n);

function setup() {
  const sockets: FakeSocket[] = [];
  const phases: Array<[GatewayPhase, string | null]> = [];
  const messages: DiscordMessage[] = [];
  const gateway = new DiscordGateway("bot.token.value", {
    onMessage: (m) => messages.push(m),
    onPhase: (phase, error) => phases.push([phase, error]),
  }, {
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });
  const last = (): FakeSocket => sockets[sockets.length - 1]!;
  return { gateway, sockets, phases, messages, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("discord gateway: 认证与收消息", () => {
  it("Hello 之后认证:带 token 与三个 intent;READY 之后才算连上", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe(GATEWAY_URL);
    last().frame(HELLO);
    expect(last().sent[0]).toMatchObject({ op: 2, d: { token: "bot.token.value", intents: INTENTS } });
    expect(INTENTS).toBe(1 + 512 + 32768);
    expect(phases.map((p) => p[0])).toEqual(["connecting"]);
    last().frame(READY);
    expect(phases[phases.length - 1]).toEqual(["ready", null]);
    expect(gateway.bot).toBe("follow-bot");
  });

  it("频道消息递出来;系统消息、形状不对的不递", () => {
    const { gateway, messages, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().frame(READY);
    const d = { id: MESSAGE_ID, channel_id: "1100000000000000001", type: 0, content: "1.8 挂15蝴蝶 15CM", author: { id: "220000000000000002", username: "laowang", global_name: "老王" } };
    last().frame({ op: 0, t: "MESSAGE_CREATE", s: 2, d });
    last().frame({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { ...d, type: 7 } }); // 有人加入服务器
    last().frame({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { ...d, author: null } });
    last().frame({ op: 0, t: "MESSAGE_UPDATE", s: 5, d: { ...d, content: "改过的" } }); // 编辑不当新单
    expect(messages).toEqual([{
      id: MESSAGE_ID, channel_id: "1100000000000000001", author_id: "220000000000000002", author_name: "老王",
      content: "1.8 挂15蝴蝶 15CM", sentAtMs: Date.UTC(2026, 7, 14, 14, 32, 0),
    }]);
  });

  it("服务器的频道表记下来:配置的频道 bot 够不够得着由它判断", () => {
    const { gateway, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().frame(READY);
    expect(gateway.guildsSeen).toBe(false);
    last().frame({ op: 0, t: "GUILD_CREATE", s: 2, d: { channels: [{ id: "1100000000000000001" }], threads: [{ id: "1100000000000000005" }] } });
    last().frame({ op: 0, t: "CHANNEL_CREATE", s: 3, d: { id: "1100000000000000006" } });
    expect(gateway.guildsSeen).toBe(true);
    expect([...gateway.channels].sort()).toEqual(["1100000000000000001", "1100000000000000005", "1100000000000000006"]);
  });

  it("消息 ID 里的时刻;不是 ID 的回 null", () => {
    expect(snowflakeMs(MESSAGE_ID)).toBe(Date.UTC(2026, 7, 14, 14, 32, 0));
    expect(snowflakeMs("abc")).toBeNull();
    expect(snowflakeMs("")).toBeNull();
    expect(parseMessage({ id: "abc", channel_id: "1", author: { id: "2" } })).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });
});

describe("discord gateway: 心跳与续连", () => {
  it("第一拍随机错开,之后按间隔;带着最近的序号", () => {
    const { gateway, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().frame(READY);
    vi.advanceTimersByTime(19_999);
    expect(last().ops()).toEqual([2]);
    vi.advanceTimersByTime(1);
    expect(last().sent[1]).toEqual({ op: 1, d: 1 });
    last().frame({ op: 11 });
    vi.advanceTimersByTime(40_000);
    expect(last().ops()).toEqual([2, 1, 1]);
  });

  it("心跳没人应答 = 僵尸连接:断开,带着会话去续连地址续上", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    const first = last();
    first.frame(HELLO);
    first.frame(READY);
    vi.advanceTimersByTime(20_000); // 第一拍,没应答
    vi.advanceTimersByTime(40_000); // 第二拍之前发现没应答
    expect(first.closedWith).toBe(4000);
    expect(phases[phases.length - 1]![1]).toContain("没有应答心跳");
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    expect(last().url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    last().frame(HELLO);
    expect(last().sent[0]).toEqual({ op: 6, d: { token: "bot.token.value", session_id: "sess-1", seq: 1 } });
    last().frame({ op: 0, t: "RESUMED", s: 2 });
    expect(phases[phases.length - 1]).toEqual(["ready", null]);
  });

  it("被换下来的那条连接迟到的帧与关闭不作数", () => {
    const { gateway, sockets, messages, last } = setup();
    gateway.start();
    const first = last();
    first.frame(HELLO);
    first.frame(READY);
    first.frame({ op: 7 }); // Discord 要求重连
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    first.frame({ op: 0, t: "MESSAGE_CREATE", s: 9, d: { id: MESSAGE_ID, channel_id: "1", author: { id: "2" }, content: "x" } });
    first.drop(1006);
    vi.advanceTimersByTime(120_000);
    expect(messages).toEqual([]);
    expect(sockets).toHaveLength(2);
  });

  it("会话失效且不可续:丢掉会话,重新认证", () => {
    const { gateway, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().frame(READY);
    last().frame({ op: 9, d: false });
    vi.advanceTimersByTime(2_000);
    expect(last().url).toBe(GATEWAY_URL);
    last().frame(HELLO);
    expect(last().ops()).toEqual([2]);
  });

  it("普通断线:退避重连,越连不上等得越久,封顶一分钟", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    last().drop(1006);
    expect(phases[phases.length - 1]![1]).toContain("1006");
    vi.advanceTimersByTime(1_499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().drop(1006);
    vi.advanceTimersByTime(2_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    for (let i = 0; i < 8; i++) {
      last().drop(1006);
      vi.advanceTimersByTime(45_000);
    }
    expect(sockets).toHaveLength(11); // 封顶之后每次等 60 秒 × 0.75 = 45 秒
  });
});

describe("discord gateway: 该停就停", () => {
  it("token 不对:不重试,给一句说得清怎么办的话", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().drop(4004);
    expect(phases[phases.length - 1]![0]).toBe("failed");
    expect(phases[phases.length - 1]![1]).toContain("重置 token");
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(1);
  });

  it("没开 Message Content Intent:不重试,说明去哪里开", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().drop(4014);
    expect(phases[phases.length - 1]![1]).toContain("Message Content Intent");
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(1);
  });

  it("stop 之后不再连、不再发心跳", () => {
    const { gateway, sockets, phases, last } = setup();
    gateway.start();
    last().frame(HELLO);
    last().frame(READY);
    gateway.stop();
    expect(last().closedWith).toBe(1000);
    expect(phases[phases.length - 1]).toEqual(["stopped", null]);
    last().drop(1000);
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(1);
    expect(last().ops()).toEqual([2]);
  });

  it("socket 一开就抛(本机没有网络):当成断线,照样退避重连", () => {
    const phases: Array<[GatewayPhase, string | null]> = [];
    let opened = 0;
    const gateway = new DiscordGateway("t", { onMessage: () => undefined, onPhase: (p, e) => phases.push([p, e]) }, {
      open: () => {
        opened += 1;
        throw new Error("getaddrinfo ENOTFOUND gateway.discord.gg");
      },
      random: () => 0.5,
    });
    gateway.start();
    expect(phases[phases.length - 1]![1]).toContain("ENOTFOUND");
    vi.advanceTimersByTime(1_500);
    expect(opened).toBe(2);
    gateway.stop();
  });
});
