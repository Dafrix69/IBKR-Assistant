/** 时间线上的一条是怎么从各处的记录折出来的(docs/features/intel.md)。纯函数:消息、信号、事件、单子、想法各一个折法,再合成一条线。
 *
 * 口径只有三条:时刻一律换成 epoch 毫秒;"和持仓有关"= 提到的标的里有自己此刻持仓的;消息提到时的价和此刻的价都有才算得出涨跌。
 * 这里不取行情、不读库——谁调它谁把数据递进来,离线测试直接喂。
 */
import type { EconEvent } from "./contract/events.js";
import type { FollowOutcome } from "./contract/follow.js";
import type { Idea } from "./contract/ideas.js";
import type { IntelItem, IntelKind, IntelMove } from "./contract/intel.js";
import type { SignalEntry, SignalSource } from "./contract/signals.js";
import type { MessageRow } from "./messageLog.js";

const SIGNAL_LABEL: Record<SignalSource, string> = {
  cross: "价位穿越", touch: "反复碰均线", spike: "急涨急跌", day_move: "大涨大跌", rvol: "全天放量", burst: "窗口放量",
  leaders: "强势股新入选", pa: "K线 PA",
};

const STATUS_LABEL: Record<string, string> = {
  filled: "已成交", partially_filled: "部分成交", cancelled: "已撤单", expired_untriggered: "未触发过期", rejected_by_validator: "校验拒绝",
  rejected_by_llm: "模型拒绝", ibkr_error: "券商报错", halted_by_breaker: "熔断拦下",
};

const OUTCOME_LABEL: Record<FollowOutcome, string> = {
  sent: "已跟单", held: "没有发出", observed: "只观察", stale: "太旧,没跟", unparsed: "没接住,没跟", capped: "超上限,没跟",
  blocked: "闸门关着,没跟", rejected: "被拒",
};

export function outcomeLabel(outcome: FollowOutcome): string {
  return OUTCOME_LABEL[outcome];
}

export function signalLabel(source: SignalSource): string {
  return SIGNAL_LABEL[source];
}

const epoch = (iso: string | null | undefined): number => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : 0;
};

const heldOf = (symbols: readonly string[], held: ReadonlySet<string>): string[] => symbols.filter((s) => held.has(s));

/** 跟单日志里这条消息的下场(像单子的才有)。 */
export interface FollowVerdict {
  outcome: FollowOutcome;
  detail: string;
  summary: string;
}

export function messageItem(
  row: MessageRow, verdict: FollowVerdict | null, held: ReadonlySet<string>, now: ReadonlyMap<string, number | null>,
  instruction: string | null,
): IntelItem {
  const first = row.symbols[0];
  let move: IntelMove | undefined;
  if (first !== undefined && typeof row.prices[first] === "number" && row.prices[first] > 0) {
    const then = row.prices[first];
    const cur = now.get(first) ?? null;
    move = { symbol: first, then, now: cur, pct: cur !== null && cur > 0 ? Math.round(((cur - then) / then) * 10000) / 100 : null };
  }
  const item: IntelItem = {
    id: `message:${row.message_id}`, kind: "message", at: epoch(row.at), symbols: [...row.symbols], guesses: [...row.guesses],
    held: heldOf(row.symbols, held), title: row.text, body: verdict ? `${OUTCOME_LABEL[verdict.outcome]}:${verdict.detail}` : "",
    tone: verdict ? (verdict.outcome === "sent" ? "up" : ["rejected", "blocked", "capped", "unparsed"].includes(verdict.outcome) ? "warn" : "info") : "info",
    source: row.author_name || row.author_id, trusted: row.trusted, ref: row.message_id,
  };
  if (move) item.move = move;
  if (verdict) item.outcome = verdict.outcome;
  if (instruction) item.instruction = instruction;
  return item;
}

export function signalItem(entry: SignalEntry & { seq?: number }, held: ReadonlySet<string>): IntelItem {
  const label = SIGNAL_LABEL[entry.source];
  const dir = entry.expect === "up" ? "押涨" : entry.expect === "down" ? "押跌" : "不带方向";
  return {
    id: `signal:${entry.seq ?? `${entry.at}:${entry.source}:${entry.symbol}`}`, kind: "signal", at: epoch(entry.at), symbols: [entry.symbol],
    guesses: [], held: heldOf([entry.symbol], held), title: `${entry.symbol} ${entry.label || label}`,
    body: `${label}${entry.variant ? ` ${entry.variant}` : ""} · ${dir}${entry.price !== null ? ` · 当时 ${entry.price}` : ""}`,
    tone: entry.expect === "up" ? "up" : entry.expect === "down" ? "down" : "info", source: entry.source, ref: String(entry.seq ?? entry.at),
  };
}

/** 事件关谁的事:宏观数据是指数的;自定义的看标题与备注里认出了谁(调用方认好递进来)。 */
export function eventItem(event: EconEvent, symbols: readonly string[], held: ReadonlySet<string>, nowMs: number): IntelItem {
  const fact = (event.items ?? []).find((i) => i.forecast || i.previous);
  const parts = [`美东 ${event.date_et} ${event.time_et}`];
  if (fact) parts.push(`预期 ${fact.forecast || "—"} · 前值 ${fact.previous || "—"}`);
  if (event.note) parts.push(event.note);
  const upcoming = event.at > nowMs;
  return {
    id: `event:${event.id}`, kind: "event", at: event.at, symbols: [...symbols], guesses: [], held: heldOf(symbols, held),
    title: `${upcoming ? "将公布" : "已公布"}:${event.title}`, body: parts.join(" · "),
    tone: upcoming && event.impact === "high" && event.at - nowMs < 24 * 3600_000 ? "warn" : "info", source: event.kind, ref: event.id,
  };
}

/** 一条交易记录(store.getRecord 折好事件之后的样子);只认这里列出的几个字段。 */
export interface RecordFacts {
  id: string;
  created_at: string;
  symbol: string;
  action: string;
  quantity: number | null;
  account: string;
  intent_summary: string;
  raw_instruction: string;
  final_status: string | null;
  last_status: string | null;
  fills: number;
  avg_fill_price: number | null;
  channel: string;
}

export function recordItem(r: RecordFacts, held: ReadonlySet<string>): IntelItem {
  const status = r.final_status ? STATUS_LABEL[r.final_status] ?? r.final_status : r.last_status ? `在途:${r.last_status}` : "仅校验";
  const fill = r.fills > 0 && r.avg_fill_price !== null ? ` · 均价 ${r.avg_fill_price}` : "";
  const via = r.channel === "discord" ? " · 跟单" : "";
  const bad = r.final_status !== null && r.final_status !== "filled" && r.final_status !== "partially_filled";
  return {
    id: `order:${r.id}`, kind: "order", at: epoch(r.created_at), symbols: [r.symbol], guesses: [], held: heldOf([r.symbol], held),
    title: r.intent_summary || r.raw_instruction || `${r.action} ${r.symbol}`, body: `${status}${fill}${via}`,
    tone: bad ? "warn" : r.action === "SELL" ? "down" : "up", source: r.account, ref: r.id,
  };
}

export function ideaItem(idea: Idea, symbols: readonly string[], held: ReadonlySet<string>): IntelItem {
  const status = idea.status === "done" ? "已完成" : idea.status === "archived" ? "已归档" : "进行中";
  const all = [...new Set([...idea.symbols.map((s) => s.toUpperCase()), ...symbols])];
  return {
    id: `idea:${idea.id}`, kind: "idea", at: epoch(idea.created_at), symbols: all, guesses: [], held: heldOf(all, held),
    title: idea.text.slice(0, 160), body: status, tone: "info", source: idea.status, ref: idea.id,
  };
}

export interface FeedFilter {
  symbol?: string | null;
  kinds?: readonly IntelKind[] | null;
  heldOnly?: boolean;
  since?: number | null;
  limit: number;
}

/** 合成一条线:筛、按时刻从新到旧排、截。同一条(同 id)只留一次。 */
export function mergeItems(groups: readonly (readonly IntelItem[])[], filter: FeedFilter): IntelItem[] {
  const symbol = filter.symbol ? filter.symbol.toUpperCase() : null;
  const kinds = filter.kinds && filter.kinds.length ? new Set(filter.kinds) : null;
  const seen = new Set<string>();
  const out: IntelItem[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) continue;
      if (kinds && !kinds.has(item.kind)) continue;
      if (symbol && !item.symbols.includes(symbol)) continue;
      if (filter.heldOnly && item.held.length === 0) continue;
      if (filter.since !== null && filter.since !== undefined && item.at < filter.since) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return out.slice(0, Math.max(1, filter.limit));
}
