/** Discord 跟单的判定规则(docs/features/follow.md):一条频道消息,跟还是不跟、为什么。纯函数,不连 Discord、不碰引擎。
 *
 * 红线和本地速记同一条:**绝不猜**。跟单只认本地速记完整接住的两种单子——写明价格的买入蝴蝶、写明方向与价格的贷方价差。
 * 别人写的一句话没有人在旁边确认,交给大模型"理解一下"再直接发单,错一次就是真钱。接不住的只提醒,不发。
 *
 * 三步,前两步在这里:
 *   triage  不取行情:是不是那个频道、是不是信任的人、像不像单子、新不新鲜;
 *   decide  拿到解析结果之后:结构对不对、超没超跟单的上限、闸门开没开;
 *   outcome 引擎走完之后:四个桶 → 这条信号的下场。
 */
import type { FollowConfig, FollowOutcome } from "./contract/follow.js";
import type { InstructionSubmitResult } from "./contract/instruction.js";
import { LOCAL_CHANNEL } from "./followInbox.js";
import { pyG } from "./py.js";
import { looksLikeOrder, spreadWithoutType } from "./shorthand.js";

/** 判定一条消息只用到这几样(discordGateway 的 DiscordMessage 即符合)。 */
export interface FollowMessage {
  channel_id: string;
  author_id: string;
  content: string;
  sentAtMs: number;
}

export type Triage =
  /** 不是配置的频道 */
  | { kind: "other_channel" }
  /** 不是信任的人:只进「最近看到的消息」,不落日志 */
  | { kind: "untrusted" }
  /** 信任的人,但这句不像蝴蝶单(闲聊) */
  | { kind: "chatter" }
  /** 像单子,但太旧 */
  | { kind: "stale"; detail: string }
  /** 往下走:去解析 */
  | { kind: "parse" };

/**
 * 消息正文里拿去判断、解析的那一部分:摘掉提及(`@everyone` / `@here` / `<@用户>` / `<@&身份组>` / `<#频道>`)。
 * 对方几乎每条单子都带 `@everyone`;不摘的话 every 会被当成标的代码,一条都解析不出来。日志里记的仍是原文。
 */
export function orderText(content: string): string {
  return (content ?? "").normalize("NFKC")
    .replace(/<[@#][!&]?\d+>/g, " ")
    .replace(/@(?:everyone|here)(?![A-Za-z])/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 没接住的时候,能说得更具体就说:长得像贷方价差却没写方向的,告诉人差的是哪一样(他可以自己去下)。
 * 说不出更具体的回 null,用判定那一步的通用说法。`text` 是 orderText 摘过提及的正文。
 */
export function whyUnparsed(text: string): string | null {
  if (spreadWithoutType(text)) {
    return "像一张贷方价差,但没写 bull put 还是 bear call:行权价贴着现价时方向猜不得,没有发单";
  }
  return null;
}

export function triage(cfg: FollowConfig, message: FollowMessage, nowMs: number): Triage {
  // 本地收件的消息"频道"是 local:开着本地收件才看;bot 读来的只看配置的那个频道
  const wanted = message.channel_id === LOCAL_CHANNEL ? cfg.local_inbox : Boolean(cfg.channel_id) && message.channel_id === cfg.channel_id;
  if (!wanted) return { kind: "other_channel" };
  if (!cfg.author_ids.includes(message.author_id)) return { kind: "untrusted" };
  // 有单子的骨架才往下走:蝴蝶要有翼宽,价差要有类型词。光提到「蝴蝶」两个字的是评论
  if (!looksLikeOrder(orderText(message.content))) return { kind: "chatter" };
  // 按 Discord 盖的时刻算,不按本机收到的时刻:断线续连后补发来的消息"刚收到",其实是几分钟前的
  const ageSeconds = Math.floor((nowMs - message.sentAtMs) / 1000);
  if (ageSeconds > cfg.max_age_seconds) {
    return {
      kind: "stale",
      detail: `消息已经发出 ${ageSeconds} 秒,超过 ${cfg.max_age_seconds} 秒不跟(断线后补到的旧消息,或者本机时钟偏快)`,
    };
  }
  return { kind: "parse" };
}

/** 闸门此刻的样子:和手动发单过的是同一套。 */
export interface FollowGates {
  /** 熔断的原因;没熔断是 null */
  breaker: string | null;
  autoExecute: boolean;
  connected: boolean;
}

export interface Decision {
  /** send = 交给引擎发单;其余就是这条信号的下场 */
  outcome: FollowOutcome | "send";
  detail: string;
  /** 解析出来的订单摘要;没解析出来是空串 */
  summary: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

interface FlyOrder {
  summary: string;
  /** 中间那条腿(卖两张的那条)的行权价 */
  center: number;
  quantity: number;
  /** 净权利金上限;没写(AUTO_MID)是 null */
  premium: number | null;
  wing: number;
}

/** 速记产出的 payload 里那一张买入蝴蝶;不是"恰好一张买入蝴蝶"回 null。 */
function readFly(payload: Obj): FlyOrder | null {
  const orders = payload["orders"];
  if (!Array.isArray(orders) || orders.length !== 1 || !isObj(orders[0])) return null;
  const item = orders[0];
  const contract = item["contract"];
  const order = item["order"];
  if (!isObj(contract) || !isObj(order)) return null;
  if (contract["combo_strategy"] !== "BUTTERFLY" || order["action"] !== "BUY") return null;
  const legs = contract["legs"];
  if (!Array.isArray(legs) || legs.length !== 3) return null;
  const strikes = legs.map((leg) => (isObj(leg) ? Number(leg["strike"]) : Number.NaN));
  const wing = (strikes[1] ?? Number.NaN) - (strikes[0] ?? Number.NaN);
  const quantity = Number(order["totalQuantity"]);
  const rawPremium = order["lmtPrice"];
  const premium = rawPremium === null || rawPremium === undefined ? null : Number(rawPremium);
  if (!(wing > 0) || !(quantity >= 1) || (premium !== null && !(premium > 0))) return null;
  return { summary: String(item["intent_summary"] ?? ""), center: strikes[1] ?? Number.NaN, quantity, premium, wing };
}

interface CreditOrder {
  summary: string;
  quantity: number;
  /** 收到的净权利金(限价) */
  credit: number;
  /** 两个行权价之间的宽度 */
  width: number;
}

/** 速记产出的 payload 里那一张贷方垂直价差(卖出、两条腿、写明了收多少);不是回 null。 */
function readCredit(payload: Obj): CreditOrder | null {
  const orders = payload["orders"];
  if (!Array.isArray(orders) || orders.length !== 1 || !isObj(orders[0])) return null;
  const item = orders[0];
  const contract = item["contract"];
  const order = item["order"];
  if (!isObj(contract) || !isObj(order)) return null;
  if (contract["combo_strategy"] !== "VERTICAL" || order["action"] !== "SELL") return null;
  const legs = contract["legs"];
  if (!Array.isArray(legs) || legs.length !== 2) return null;
  const strikes = legs.map((leg) => (isObj(leg) ? Number(leg["strike"]) : Number.NaN));
  const width = Math.abs((strikes[1] ?? Number.NaN) - (strikes[0] ?? Number.NaN));
  const quantity = Number(order["totalQuantity"]);
  const rawCredit = order["lmtPrice"];
  if (rawCredit === null || rawCredit === undefined) return null;
  const credit = Number(rawCredit);
  if (!(width > 0) || !(quantity >= 1) || !(credit > 0 && credit < width)) return null;
  return { summary: String(item["intent_summary"] ?? ""), quantity, credit, width };
}

/** 「N蝴蝶」是相对写法(中心 = 现价的百位 + N)。算出来的中心离现价这么多点或更远,就说明现价在两个百位之间、
 *  说的可能是另一个百位:现价 7690 时「00蝴蝶」是 7700 还是 7600,软件没法确定。 */
export const RELATIVE_CENTER_MAX_POINTS = 50;

/**
 * 相对写法在百位边上说不清时的说明;没问题回 null。只给跟单用:手动下单有人看摘要,这里没有人,宁可不跟。
 * `payload` 是本地速记的产出,`spot` 是解析时用的现价。写明完整中心(「7700蝴蝶」)的不走这一步。
 */
export function relativeCenterProblem(payload: unknown, spot: number): { detail: string; summary: string } | null {
  if (!isObj(payload) || !Number.isFinite(spot)) return null;
  const fly = readFly(payload);
  if (fly === null || !Number.isFinite(fly.center)) return null;
  const distance = Math.abs(fly.center - spot);
  if (distance < RELATIVE_CENTER_MAX_POINTS) return null;
  // 另一个更可能的百位:往现价那一边挪一百点
  const other = fly.center + (spot > fly.center ? 100 : -100);
  return {
    summary: fly.summary,
    detail: `「N蝴蝶」按现价的百位算成中心 ${pyG(fly.center)},离现价 ${pyG(Math.round(spot * 100) / 100)} 有 ${pyG(Math.round(distance))} 点;` +
      `现价在两个百位之间时,说的可能是 ${pyG(other)},没法确定,没有发单(写明完整中心,如 ${pyG(other)}蝴蝶,就能跟)`,
  };
}

/** 买入蝴蝶最坏亏多少美元:张数 × 100 × 净权利金上限;没写权利金的按翼宽(和校验层给 AUTO_MID 组合定敞口同一个口径——
 *  跟单不收没写价格的单,这个分支留给别处用)。 */
export function worstCaseUsd(order: { quantity: number; premium: number | null; wing: number }): number {
  // 取到分:0.3 × 10 张 × 100 在浮点里是 300.00000000000006,不该因此算"超过 300"
  return Math.round(order.quantity * 100 * (order.premium ?? order.wing) * 100) / 100;
}

/** 贷方价差最坏亏多少美元:张数 × 100 × (宽度 − 收到的权利金),和校验层给贷方组合定敞口同一个口径。 */
export function creditWorstCaseUsd(order: { quantity: number; credit: number; width: number }): number {
  return Math.round(order.quantity * 100 * Math.max(order.width - order.credit, 0) * 100) / 100;
}

/**
 * 解析完之后:跟不跟。`payload` 是本地速记的产出(没接住是 null)。
 * 先看单子本身(结构、单笔风险),再看开关与闸门,最后看今天的额度——只观察时照样告诉人"这一单超了上限"。
 */
export function decide(cfg: FollowConfig, payload: unknown, gates: FollowGates, sentToday: number): Decision {
  if (!isObj(payload)) {
    return { outcome: "unparsed", detail: "看着像一张单子,但本地速记没有完整接住;跟单不交给大模型猜,没有发单", summary: "" };
  }
  const rejections = payload["rejections"];
  if (Array.isArray(rejections) && isObj(rejections[0])) {
    return { outcome: "rejected", detail: String(rejections[0]["message"] ?? "本地速记拒绝了这一条"), summary: "" };
  }
  const fly = readFly(payload);
  const spread = fly === null ? readCredit(payload) : null;
  if (fly === null && spread === null) {
    return { outcome: "unparsed", detail: "解析出来的不是恰好一张买入蝴蝶或一张贷方价差,没有发单", summary: "" };
  }
  const summary = fly?.summary ?? spread?.summary ?? "";
  // 没写价格的不跟:对方常把价格放在下一条消息里(「20蝴蝶 20CM」,再一条「3.6」),软件不把两条拼起来,
  // 也不替人按盘口中间价定价——手动下单有人看着,这里没有
  if (fly !== null && fly.premium === null) {
    return { outcome: "unparsed", summary, detail: "这条消息没写权利金上限(对方可能把价格放在了下一条里),软件不替人定价,没有发单" };
  }
  const risk = fly !== null ? worstCaseUsd(fly) : spread !== null ? creditWorstCaseUsd(spread) : 0;
  if (risk > cfg.max_risk_usd) {
    const how = spread !== null ? `(宽 ${pyG(spread.width)} 点 − 收 ${pyG(spread.credit)})` : "";
    return {
      outcome: "capped", summary,
      detail: `这一单最坏亏 $${pyG(risk)}${how},超过跟单的单笔上限 $${pyG(cfg.max_risk_usd)}`,
    };
  }
  if (!cfg.enabled) return { outcome: "observed", summary, detail: `只观察,没有发单(这一单最坏亏 $${pyG(risk)})` };
  if (gates.breaker !== null) return { outcome: "blocked", summary, detail: `熔断中(${gates.breaker}),没有发单` };
  if (!gates.autoExecute) return { outcome: "blocked", summary, detail: "「允许自动执行」没有打开,没有发单" };
  if (!gates.connected) return { outcome: "blocked", summary, detail: "没有连接券商,没有发单" };
  if (sentToday >= cfg.max_orders_per_day) {
    return { outcome: "capped", summary, detail: `今天已经跟了 ${sentToday} 单,到了每天 ${cfg.max_orders_per_day} 单的上限` };
  }
  return { outcome: "send", summary, detail: "" };
}

/** 引擎走完之后,四个桶 → 这条信号的下场。扇出到几个账户时,有一笔发出去就算 sent,其余的写进说明。 */
export function outcomeOf(
  result: Pick<InstructionSubmitResult, "submitted" | "queued" | "validated_only" | "rejections" | "warnings">,
): { outcome: FollowOutcome; detail: string; record_ids: string[] } {
  const sent = [...result.submitted, ...result.queued];
  const rejected = result.rejections.map((r) => r.message);
  if (sent.length) {
    const parts = [`已发出 ${sent.length} 笔(${sent.map((o) => o.account).join("、")})`];
    if (result.validated_only.length) parts.push(`${result.validated_only.length} 笔过了校验但没发`);
    if (rejected.length) parts.push(`${rejected.length} 笔被拒:${rejected[0]}`);
    return { outcome: "sent", detail: parts.join(";"), record_ids: sent.map((o) => o.record_id) };
  }
  if (result.validated_only.length) {
    // 走到发单那一步才停下的只有两种:保护规则暂停中,或者解析那一下「允许自动执行」被关掉了。原因写在那条记录里
    return {
      outcome: "held", detail: "过了校验但没有发出(保护规则暂停中,或自动执行刚被关掉),详见这条记录",
      record_ids: result.validated_only.map((o) => o.record_id),
    };
  }
  return {
    outcome: "rejected",
    detail: rejected[0] ?? result.warnings[0] ?? "没有产生订单",
    record_ids: result.rejections.flatMap((r) => (typeof r.record_id === "string" ? [r.record_id] : [])),
  };
}
