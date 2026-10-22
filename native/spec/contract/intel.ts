/** intel.*:信息链路——消息、信号、事件、成交、想法按标的串起来(docs/features/intel.md)。类型文件,不 import 任何东西。
 *
 * 两个方法都只读:`intel.feed` 是一条时间线(全站的或某只标的的),`intel.dossier` 是一只标的的档案
 * (现价、持仓、追踪、在途单、价位、异动、板块、想法、接下来的事件、时间线)。自己不发单、不建追踪;
 * 「写指令」只是把一句话写进指令框。
 */
import type { AnomalyEvent } from "./quality.js";
import type { EconEvent } from "./events.js";
import type { FollowOutcome } from "./follow.js";
import type { Idea } from "./ideas.js";
import type { PositionRow } from "./positions.js";
import type { SignalSource } from "./signals.js";
import type { Track } from "./tracker.js";
import type { WatchEvent, WatchLevel } from "./alerts.js";

/** 一句话里认出一个标的是怎么认出来的:cashtag `$NVDA`;known 名单里有(持仓、股票池、板块、提醒、指数);alias 中文别名;
 *  guess 像代码的大写词但名单里没有(只作参考);implied 没写标的但按行话推断(「7700 7725 bear call」是 SPX)。 */
export type MentionHow = "cashtag" | "known" | "alias" | "guess" | "implied";

export interface Mention {
  symbol: string;
  how: MentionHow;
  /** 原文里的那个词 */
  term: string;
}

/** 时间线上一条的来源。 */
export type IntelKind = "message" | "signal" | "event" | "order" | "idea";

export interface IntelMove {
  symbol: string;
  /** 提到那一刻的价 */
  then: number;
  /** 此刻的价;没连券商是 null */
  now: number | null;
  /** (now − then) / then × 100,两位小数;now 为 null 时是 null */
  pct: number | null;
}

/** 时间线上的一条:谁、什么时候、说了什么、提到了哪几只、和自己的持仓有没有关系。 */
export interface IntelItem {
  /** `<kind>:<ref>` */
  id: string;
  kind: IntelKind;
  /** epoch 毫秒 */
  at: number;
  /** 提到的标的(消息里认出来的、信号 / 成交 / 想法自带的);不含 guess */
  symbols: string[];
  /** 消息里像代码但名单里没有的词 */
  guesses: string[];
  /** 这些标的里自己持仓的 */
  held: string[];
  title: string;
  body: string;
  tone: "up" | "down" | "info" | "warn";
  /** 消息:发送者显示名;信号:来源(cross / spike…);事件:家族;单子:账户别名;想法:状态 */
  source: string;
  /** 消息:发送者是不是信任名单里的 */
  trusted?: boolean;
  /** 消息提到时第一只标的的价与此刻的价 */
  move?: IntelMove;
  /** 消息在跟单那条路上的下场(像单子的才有) */
  outcome?: FollowOutcome;
  /** 这句话摘掉提及之后像一张单子:可以直接写进指令框 */
  instruction?: string;
  /** 来源记录的 id:消息 id / 信号序号 / 事件 id / 记录 id / 想法 id */
  ref: string;
}

export interface IntelFeedParams {
  /** 只看提到这只标的的 */
  symbol?: string;
  /** 只看这几种;不带 = 全部 */
  kinds?: IntelKind[];
  /** 只看和自己持仓有关的 */
  held_only?: boolean;
  /** 最多几条(1 ~ 500,默认 150) */
  limit?: number;
  /** 只看这一刻(epoch 毫秒)之后的 */
  since?: number;
}

export interface IntelFeed {
  items: IntelItem[];
  /** 此刻持仓的标的 */
  held: string[];
  /** 库里一共记了多少条消息 */
  total_messages: number;
  /** 生成时刻(毫秒) */
  at: number;
  /** 现价取自哪里:没连券商时消息上的「此刻」都是 null */
  connected: boolean;
}

export interface IntelQuote {
  price: number;
  /** 较昨收 %,拿不到昨收是 null */
  change_pct: number | null;
  /** index / futures / quote… */
  source: string;
}

/** 在途的一张单(还没有终态)。 */
export interface IntelWorkingOrder {
  id: string;
  at: string;
  status: string;
  summary: string;
  account: string;
}

export interface IntelSignalCount {
  source: SignalSource;
  n: number;
  /** 最近一条的时刻(ISO) */
  last_at: string;
}

/** 一只标的的档案:此刻的一切,外加它的时间线。 */
export interface IntelDossier {
  symbol: string;
  quote: IntelQuote | null;
  held: boolean;
  /** 这只标的的持仓行(含 withCombos 折出来的组合行);没连券商是空 */
  positions: PositionRow[];
  tracks: Track[];
  working: IntelWorkingOrder[];
  /** 在哪几个板块里 */
  sectors: string[];
  /** 盯价位的那一行:价位与最近的穿越;没盯是 null */
  watch: { enabled: boolean; levels: WatchLevel[]; last_price: number | null; events: WatchEvent[] } | null;
  /** 盯异动的那一行:最近的异动;没盯是 null */
  quality: { enabled: boolean; events: AnomalyEvent[]; change_pct: number | null } | null;
  ideas: Idea[];
  /** 接下来两周里和它有关的事:指数是全部宏观事件,别的是标题或备注里提到它的自定义事件 */
  events: EconEvent[];
  /** 最近 90 天各来源的信号条数 */
  signals: IntelSignalCount[];
  /** 最近 7 天被消息提到几次 */
  mentions_7d: number;
  /** 这只标的的时间线(同 intel.feed 带 symbol) */
  timeline: IntelItem[];
  at: number;
  connected: boolean;
}

export interface IntelDossierParams {
  symbol: string;
  /** 时间线最多几条(1 ~ 500,默认 80) */
  limit?: number;
}
