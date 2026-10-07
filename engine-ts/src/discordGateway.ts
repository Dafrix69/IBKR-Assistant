/** Discord Gateway 的最小客户端(docs/features/follow.md):连上、保持住、把频道里的新消息递出来。只读,不往 Discord 发任何消息。
 *
 * 用的是官方的 bot 通道:bot token、Gateway v10、JSON 编码、不压缩。不用任何人的用户 token——那是 Discord 条款禁止的
 * 自动化用户账号(self-bot),会封号。
 *
 * 断线之后的两种接法:手里有会话(session_id + resume_gateway_url)就续连(RESUME),Discord 会把断开期间漏掉的事件补发过来;
 * 没有就重新认证(IDENTIFY),漏掉的不补。补发来的消息可能已经是几分钟前的——新不新鲜由用的一方按消息时刻判,这里照递。
 * 重试没有意义的错(token 不对、没开 Message Content Intent)停下来报给上面,不反复去撞。
 *
 * 自带 WebSocket(Node 22 起全局就有),不引依赖;测试换一个假的 socket(`open`)。不走代理:系统层面连不上 discord.com 时这里也连不上。
 */

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILDS(知道 bot 在哪些服务器、有哪些频道)| GUILD_MESSAGES | MESSAGE_CONTENT(特权 intent:要在 Developer Portal 里手动打开) */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
/** Discord 纪元(2015-01-01T00:00:00Z):消息 ID 的高位是距它的毫秒数 */
const DISCORD_EPOCH_MS = 1420070400000n;
const MAX_BACKOFF_MS = 60_000;

/** 重试没用的关闭码 → 给人看的话。 */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord 不认这个 bot token。到 Developer Portal 的 Bot 页重置 token,再回来重新保存。",
  4010: "Discord 拒绝了连接(分片参数无效,4010)。",
  4011: "这个 bot 加入的服务器太多,需要分片(4011),这里不支持。",
  4012: "Discord 拒绝了连接(Gateway 版本无效,4012),需要更新软件。",
  4013: "Discord 拒绝了连接(intent 无效,4013),需要更新软件。",
  4014: "bot 没有开 Message Content Intent。到 Developer Portal → Bot → Privileged Gateway Intents 打开它,再回来重新保存 token。",
};
/** 这些关闭码之后会话作废,只能重新认证。 */
const SESSION_GONE = new Set([1000, 1001, 4007, 4009]);

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  content: string;
  /** Discord 给这条消息盖的时刻(从消息 ID 里解出来,不是本机收到的时刻),毫秒 */
  sentAtMs: number;
}

/** connecting = 正在连 / 等着重连;ready = 已认证;failed = 重试没用,停了;stopped = 被 stop() 停掉 */
export type GatewayPhase = "connecting" | "ready" | "failed" | "stopped";

export interface GatewayHooks {
  onMessage(message: DiscordMessage): void;
  onPhase(phase: GatewayPhase, error: string | null): void;
}

/** 这个客户端用到的 socket 那一面。 */
export interface SocketLike {
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface GatewayOptions {
  url?: string;
  /** 开一条 socket(测试注入假的) */
  open?: (url: string) => SocketLike;
  /** [0, 1) 的随机数(心跳抖动、重连抖动;测试注入定值) */
  random?: () => number;
}

/** 消息 ID(snowflake)里的时刻;不是合法 ID 回 null。 */
export function snowflakeMs(id: string): number | null {
  if (!/^\d{15,21}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** MESSAGE_CREATE 的 d → 一条消息。只认普通消息(type 0)与回复(type 19);系统消息、形状不对的回 null。 */
export function parseMessage(d: unknown): DiscordMessage | null {
  if (!isObj(d)) return null;
  const type = d["type"] ?? 0;
  if (type !== 0 && type !== 19) return null;
  const author = d["author"];
  if (!isObj(author)) return null;
  const id = str(d["id"]);
  const sentAtMs = snowflakeMs(id);
  const channel = str(d["channel_id"]);
  const authorId = str(author["id"]);
  if (sentAtMs === null || !channel || !authorId) return null;
  return {
    id,
    channel_id: channel,
    author_id: authorId,
    author_name: str(author["global_name"]) || str(author["username"]),
    content: str(d["content"]),
    sentAtMs,
  };
}

function nativeSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    onmessage: null,
    onclose: null,
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
  };
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") socket.onmessage?.(ev.data);
  });
  ws.addEventListener("close", (ev) => socket.onclose?.(ev.code));
  // 出错之后一定跟着 close(连不上时码是 1006),重连在那里做
  ws.addEventListener("error", () => undefined);
  return socket;
}

export class DiscordGateway {
  /** bot 的名字(认证之后才有) */
  bot: string | null = null;
  /** bot 所在服务器里的全部频道 ID(连上后由 GUILD_CREATE 给);判断"配置的那个频道 bot 够不够得着"用 */
  readonly channels = new Set<string>();
  /** 至少收到过一个服务器的频道表 */
  guildsSeen = false;

  private readonly url: string;
  private readonly open: (url: string) => SocketLike;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** 上一次心跳有没有被应答:没应答就是僵尸连接,断开重连 */
  private acked = true;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly token: string,
    private readonly hooks: GatewayHooks,
    options: GatewayOptions = {},
  ) {
    this.url = options.url ?? GATEWAY_URL;
    this.open = options.open ?? nativeSocket;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close(1000);
      } catch {
        /* 已经关了 */
      }
    }
    this.hooks.onPhase("stopped", null);
  }

  // ---- 连接 -----------------------------------------------------------
  private connect(): void {
    if (this.stopped) return;
    this.hooks.onPhase("connecting", null);
    const resuming = this.sessionId !== null && this.resumeUrl !== null;
    let socket: SocketLike;
    try {
      socket = this.open(resuming ? `${this.resumeUrl!.replace(/\/+$/, "")}/?v=10&encoding=json` : this.url);
    } catch (exc) {
      this.scheduleRetry(`连不上 Discord:${(exc as Error).message}`);
      return;
    }
    this.socket = socket;
    this.acked = true;
    // 只听当前这条 socket:被换下来的那条迟到的帧与关闭不作数
    socket.onmessage = (data) => {
      if (this.socket === socket) this.onFrame(data);
    };
    socket.onclose = (code) => {
      if (this.socket === socket) this.onClose(code);
    };
  }

  /** 主动断开当前连接再连;keepSession = 留着会话去续连。 */
  private reconnect(keepSession: boolean, note: string): void {
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (!keepSession) this.dropSession();
    if (socket !== null) {
      try {
        // 4000:不是 1000 / 1001,Discord 那头会话还留着,续得上
        socket.close(keepSession ? 4000 : 1000);
      } catch {
        /* 已经关了 */
      }
    }
    this.scheduleRetry(note);
  }

  private onClose(code: number): void {
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal !== undefined) {
      this.stopped = true;
      this.dropSession();
      this.hooks.onPhase("failed", fatal);
      return;
    }
    if (SESSION_GONE.has(code)) this.dropSession();
    this.scheduleRetry(`和 Discord 的连接断了(${code})`);
  }

  private scheduleRetry(note: string): void {
    if (this.stopped) return;
    this.attempts += 1;
    // 第一次 1–2 秒(会话失效之后 Discord 要求至少等 1 秒再认证),之后翻倍,封顶一分钟
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempts, 6));
    const delay = Math.round(base * (0.5 + this.random() / 2));
    this.hooks.onPhase("connecting", `${note},${Math.max(1, Math.round(delay / 1000))} 秒后重连`);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
    this.retry.unref?.();
  }

  private dropSession(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) clearTimeout(this.heartbeat);
    if (this.retry !== null) clearTimeout(this.retry);
    this.heartbeat = null;
    this.retry = null;
  }

  // ---- 协议 -----------------------------------------------------------
  private send(payload: Obj): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      /* socket 正在关:close 事件会带着重连来 */
    }
  }

  private onFrame(data: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(frame)) return;
    const op = frame["op"];
    const d = frame["d"];
    if (typeof frame["s"] === "number") this.seq = frame["s"];
    if (op === 10) return this.onHello(d);
    if (op === 11) {
      this.acked = true;
      return;
    }
    if (op === 1) return this.beat();
    if (op === 7) return this.reconnect(true, "Discord 要求重连");
    if (op === 9) return this.reconnect(d === true, "Discord 的会话失效了");
    if (op === 0) this.onDispatch(str(frame["t"]), d);
  }

  private onHello(d: unknown): void {
    const interval = isObj(d) && typeof d["heartbeat_interval"] === "number" ? d["heartbeat_interval"] : 41_250;
    // 第一拍按协议要求随机错开,之后按间隔
    this.scheduleBeat(interval * this.random(), interval);
    if (this.sessionId !== null) {
      this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
    } else {
      this.send({
        op: 2,
        d: {
          token: this.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: "ibkr-assistant", device: "ibkr-assistant" },
        },
      });
    }
  }

  private scheduleBeat(delay: number, interval: number): void {
    this.heartbeat = setTimeout(() => {
      if (!this.acked) {
        this.reconnect(true, "Discord 没有应答心跳");
        return;
      }
      this.acked = false;
      this.beat();
      this.scheduleBeat(interval, interval);
    }, delay);
    this.heartbeat.unref?.();
  }

  private beat(): void {
    this.send({ op: 1, d: this.seq });
  }

  private onDispatch(type: string, d: unknown): void {
    if (type === "READY" && isObj(d)) {
      this.sessionId = str(d["session_id"]) || null;
      this.resumeUrl = str(d["resume_gateway_url"]) || null;
      const user = d["user"];
      this.bot = isObj(user) ? str(user["username"]) || null : null;
      this.channels.clear();
      this.guildsSeen = false;
      this.attempts = 0;
      this.hooks.onPhase("ready", null);
      return;
    }
    if (type === "RESUMED") {
      this.attempts = 0;
      this.hooks.onPhase("ready", null);
      return;
    }
    if (type === "GUILD_CREATE" && isObj(d)) {
      this.guildsSeen = true;
      for (const key of ["channels", "threads"]) {
        const list = d[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) if (isObj(item) && str(item["id"])) this.channels.add(str(item["id"]));
      }
      return;
    }
    if ((type === "CHANNEL_CREATE" || type === "THREAD_CREATE") && isObj(d) && str(d["id"])) {
      this.channels.add(str(d["id"]));
      return;
    }
    if (type === "MESSAGE_CREATE") {
      const message = parseMessage(d);
      if (message !== null) this.hooks.onMessage(message);
    }
  }
}
