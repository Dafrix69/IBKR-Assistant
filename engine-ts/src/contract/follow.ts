/** follow.*:Discord 跟单(docs/features/follow.md)。类型文件,不 import 任何东西。
 *
 * 一个 Discord bot 读一个频道,信任的发送者发的速记(买入蝴蝶、贷方价差)不经确认直接走发单链路。
 * 配置在 settings 的 `follow` 段(settings.get / settings.patch 读写),bot token 在系统凭证库。
 */

// ---------------------------------------------------------------- 配置
export interface FollowConfig {
  /** 关 = 只观察:照样读频道、照样解析、照样记账,但一张单都不发。默认关。 */
  enabled: boolean;
  /** 读哪个频道(Discord 的频道 ID,一串数字);空 = 不连 Discord。 */
  channel_id: string;
  /** 信任谁:发送者的用户 ID。关注过来的公告频道消息,发送者是那条关注的 webhook ID。 */
  author_ids: string[];
  /** 发到哪些账户(别名);空 = 默认账户。 */
  accounts: string[];
  /** 消息发出超过多少秒就不跟:断线重连后补到的旧消息不追。 */
  max_age_seconds: number;
  /** 一天(美东)最多跟几单。 */
  max_orders_per_day: number;
  /** 一单最坏亏多少美元。蝴蝶:张数 × 100 × 净权利金上限;贷方价差:张数 × 100 ×(宽度 − 收到的权利金)。没写价格的不跟。 */
  max_risk_usd: number;
  /**
   * 本地收件:除了 bot 读频道,还读本机脚本从屏幕上的 Discord 窗口抄下来、追加到收件文件里的消息。
   * 对方的私密频道拉不进 bot 时用它。发送者是显示名(`local:名字`),不是用户 ID。默认关。
   */
  local_inbox: boolean;
}

/** 本地收件文件此刻的样子。 */
export interface FollowInboxState {
  /** 开关(= 配置里的 local_inbox) */
  enabled: boolean;
  /** 收件文件在哪:脚本往这里追加 JSON 行 */
  path: string;
  /** 正在读 */
  watching: boolean;
  /** 最近一条收到的时刻,ISO 8601(UTC);还没收到过是 null */
  last_at: string | null;
  /** 这次启动以来读到的消息条数 */
  received: number;
  /** 最近一次读文件的问题,人话;没有是 null */
  error: string | null;
}

// ---------------------------------------------------------------- 一条信号的下场
/**
 * sent      发出去了(或进了软件盯盘队列)
 * held      过了校验但没发:保护规则拦下
 * observed  只观察:能发,但跟单开关关着
 * stale     消息太旧
 * unparsed  有单子的骨架,但本地速记没接住、没写价格、或没写方向——跟单不猜,也不交给大模型
 * capped    超了跟单自己的上限(单笔风险 / 每日单数)
 * blocked   闸门关着:熔断、自动执行没开、没连券商
 * rejected  校验或券商拒了
 */
export type FollowOutcome = "sent" | "held" | "observed" | "stale" | "unparsed" | "capped" | "blocked" | "rejected";

export interface FollowEntry {
  /** 处理这条消息的时刻,ISO 8601(UTC) */
  at: string;
  message_id: string;
  author_id: string;
  author_name: string;
  /** 消息原文(截到 200 字) */
  text: string;
  outcome: FollowOutcome;
  /** 为什么是这个下场,一句人话 */
  detail: string;
  /** 解析出来的订单摘要;没解析出来是空串 */
  summary: string;
  /** 落了哪几条交易记录 */
  record_ids: string[];
}

/** 频道里最近看到的消息(只在内存里):挑「信任谁」时照着它填发送者 ID。 */
export interface FollowSeen {
  at: string;
  /** 从哪儿来:bot 读的频道,还是本地收件 */
  source: "discord" | "local";
  author_id: string;
  author_name: string;
  text: string;
  trusted: boolean;
}

/**
 * off        没配频道,不连
 * no_token   配了频道但凭证库里没有 bot token
 * connecting 正在连 / 正在重连
 * ready      连上了
 * failed     连不上而且重试没用(token 不对、没开 Message Content Intent):改好之后重存 token
 */
export type FollowLinkState = "off" | "no_token" | "connecting" | "ready" | "failed";

export interface FollowLink {
  state: FollowLinkState;
  /** 连上之后 bot 的名字 */
  bot: string | null;
  /** 最近一次连接问题,人话;没有是 null */
  error: string | null;
  /** bot 所在的服务器里有没有配置的那个频道;还不知道是 null */
  channel_known: boolean | null;
}

export interface FollowStatus {
  config: FollowConfig;
  token_configured: boolean;
  link: FollowLink;
  /** 今天(美东)已经跟了几单 / 上限 */
  today: { sent: number; max: number };
  /** 最近的信号,新的在前 */
  recent: FollowEntry[];
  /** 频道里最近看到的消息,新的在前 */
  seen: FollowSeen[];
  /** 本地收件 */
  inbox: FollowInboxState;
}

export interface FollowSetTokenParams {
  /** bot token 明文:只经过这一跳写进系统凭证库,不落盘、不回显、不进日志 */
  token: string;
}
