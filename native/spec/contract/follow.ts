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
  /**
   * 本地收件读哪个频道:Discord 窗口标题里的那个名字(不含 #)。填了,软件自己拉起读窗口的程序(只有 macOS 的安装包带着它);
   * 空 = 不自动启动,自己运行脚本。默认空。
   */
  local_channel: string;
  /**
   * 跟进来的**买入蝴蝶**成交之后,软件自己给它建一条持仓追踪:蝶式预设(分档利润回撤)+ 到价自动平仓,
   * 和在「持仓追踪」页勾「蝶式预设」「到价自动平仓」建出来的是同一条。贷方价差不建。默认关。
   * 它会自动发平仓单,所以属于打开跟单时的那一次确认(见 desktop/confirm-grants.js)。
   */
  track_fly: boolean;
  /** 自动建的那条追踪带不带到点平仓:美东 "HH:MM"(下一次到这个钟点时持仓还在就平);空 = 不带。只在 track_fly 开着时有用。默认空。 */
  track_exit_at: string;
}

/**
 * 读窗口的程序此刻的样子。
 * off          本地收件关着
 * no_channel   开着但没填频道名:不自动启动,要自己运行脚本
 * unavailable  填了频道名,但这台机器上没有可以拉起的程序(不是 macOS,或者这一份软件没带着它):要自己运行脚本
 * starting     刚拉起,还没报状态
 * reading      Discord 窗口停在这个频道,正在读
 * waiting      Discord 开着,但没有窗口停在这个频道
 * no_list      窗口在这个频道,消息列表读不到(Discord 多半没带 --force-renderer-accessibility 启动)
 * no_discord   Discord 没在运行
 * untrusted    软件没有 macOS 的辅助功能权限
 * failed       程序起不来、或者自己退了,正在等下一次重启(原因在 error)
 */
export type FollowReaderPhase =
  | "off" | "no_channel" | "unavailable"
  | "starting" | "reading" | "waiting" | "no_list" | "no_discord" | "untrusted" | "failed";

export interface FollowReaderState {
  state: FollowReaderPhase;
  /** 正在读的(或读不到列表的)那个窗口的标题;没有是 null */
  title: string | null;
  /** failed 时的原因,人话;没有是 null */
  error: string | null;
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
  /** 往收件文件里写的那个读窗口的程序(软件自己拉起的那一个;手动运行的脚本软件看不见) */
  reader: FollowReaderState;
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

/**
 * 这条信号处理完之后取的一次盘口,对着对方写的价:事后看得出"晚了这几秒"值多少钱。
 * 三个价都是正数、同一个方向:debit 是要付的净权利金,credit 是能收的净权利金。
 * 只记不判:没有阈值、没有结论,也不回流到任何决策。
 */
export interface FollowQuote {
  /** debit = 买入蝴蝶(付权利金);credit = 贷方价差(收权利金) */
  side: "debit" | "credit";
  /** 对方消息里写的价 */
  leader: number;
  /** 取报价那一刻的组合中间价 */
  mid: number;
  /** 那一刻立刻能成交的价:debit 是要付的(各腿买在卖价、卖在买价),credit 是能收的 */
  natural: number;
  /** 从消息发出到取到报价过了多少秒。本地收件的消息没有发出的时刻,按读窗口的程序看见它的那一刻算 */
  lag_s: number;
  /** 报价取自纸面账户的会话:纸面会话没有实时行情权限时给的是延迟行情 */
  paper: boolean;
}

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
  /** 处理完之后取的那一次盘口;没取到(没连券商、盘口不全、不是恰好一张写明价格的单)就没有这个键 */
  quote?: FollowQuote;
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
  /** 已经跟进去、在等成交之后自动建追踪的蝴蝶有几只(track_fly 开着时才会有) */
  tracks_pending: number;
}

export interface FollowSetTokenParams {
  /** bot token 明文:只经过这一跳写进系统凭证库,不落盘、不回显、不进日志 */
  token: string;
}
