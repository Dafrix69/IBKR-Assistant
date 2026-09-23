/**
 * 下单页「历史相似交易」:拿一张订单票据,在历史交易里找相似的,按出场方式数胜负。
 *
 * 纯函数、规则打分,不用嵌入、不调模型(idea-retrieval.md 的边界:成交是精确数据,近似检索会给出不带「我不确定」的错答案)。
 * 历史来自 tradeOutcomes 的同一批事实:券商成交合成的蝴蝶(有行权价,能比翼宽、到期、时段、权利金)、股票持仓段、
 * 导入的期权出场事件(没有行权价,只能按「同标的同结构」粗配,每条都写明)。
 *
 * 只读、只展示:结果不回流到任何下单决策。
 */
import type {
  IdeaTradeFact, IdeasSimilarTradesParams, IdeasSimilarTradesResult, SimilarExitStat, SimilarTrade,
} from "./contract/ideas.js";
import type { ImportedOptionTrade } from "./store.js";
import type { ButterflyRecord } from "./tradeOutcomes.js";
import { butterflyProfile, entryOf, etKey, parseWhen, ReviewError } from "./tradereview.js";
import { ET, wallParts } from "./tz.js";

/** 列出来的最多几笔 */
export const TOP_MATCHES = 8;
/** 翼宽差在这个比例以内算相近 */
export const WIDTH_TOLERANCE = 0.2;
/** 权利金 / 翼宽 差在这个以内算相近(0.05 = 翼宽的 5%) */
export const DEBIT_RATIO_TOLERANCE = 0.05;

/** 一笔历史交易的可比要素(全是从成交算出来的;拿不到的项就没有,不补)。 */
export interface HistoryEntry {
  fact: IdeaTradeFact;
  exit: string;
  /** 蝴蝶 / 垂直价差 / 单腿 / 股票 / 导入里的原结构名 */
  structure: string;
  /** true = 导入的期权:没有行权价,只能粗配 */
  coarse: boolean;
  right?: string;
  width?: number;
  dte?: string;
  slot?: string;
  debitRatio?: number;
  /** 股票:LONG / SHORT */
  side?: string;
}

// ---------------------------------------------------------------- 口径

/** 美东时段:开盘半小时最容易出极值(spx-pivot 研究),尾盘一小时是 0DTE 的另一个关口 */
export function slotOf(epochMs: number): string {
  const p = wallParts(epochMs, ET);
  const m = p.hour * 60 + p.minute;
  if (m < 9 * 60 + 30 || m >= 16 * 60) return "盘外";
  if (m < 10 * 60) return "开盘半小时";
  if (m < 12 * 60) return "上午";
  if (m < 15 * 60) return "午后";
  return "尾盘一小时";
}

/** 到期日距交易日的自然日 → 桶 */
export function dteBucket(expiry: string, tradeDate: string): string | undefined {
  const e = expiry.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const a = Date.parse(`${e}T00:00:00Z`), b = Date.parse(`${tradeDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  const days = Math.round((a - b) / 86_400_000);
  if (days <= 0) return "当日到期";
  if (days <= 7) return "一周内到期";
  return "一周以上到期";
}

// ---------------------------------------------------------------- 历史 → 可比要素

/** 券商成交合成的蝴蝶:行权价齐全,各项都能比。facts 是 tradeOutcomes 算好的同一批(按 id 对上)。 */
export function butterflyEntries(records: readonly ButterflyRecord[], facts: readonly IdeaTradeFact[]): HistoryEntry[] {
  const byId = new Map(facts.filter((f) => f.kind === "butterfly").map((f) => [f.id, f]));
  const out: HistoryEntry[] = [];
  for (const record of records) {
    const fact = byId.get(String(record.id ?? ""));
    const profile = butterflyProfile(record);
    if (fact === undefined || profile === null) continue;
    let when: number;
    try {
      when = entryOf(record).time;
    } catch (exc) {
      if (exc instanceof ReviewError) continue;
      throw exc;
    }
    const width = Number(profile["width"]) || undefined;
    const debit = Number(profile["debit"]);
    out.push({
      fact,
      exit: fact.how === "closed" ? "提前平仓" : fact.how === "expired" ? "持有到期" : "持仓中",
      structure: "蝴蝶",
      coarse: false,
      right: String(profile["right"]),
      width,
      dte: dteBucket(String(profile["expiry"]), etKey(when, true)),
      slot: slotOf(when),
      debitRatio: width && Number.isFinite(debit) ? debit / width : undefined,
    });
  }
  return out;
}

/** 导入的期权出场事件:只有标的与推断的结构。 */
export function optionEntries(rows: readonly ImportedOptionTrade[], facts: readonly IdeaTradeFact[]): HistoryEntry[] {
  const byId = new Map(facts.filter((f) => f.kind === "option").map((f) => [f.id, f]));
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const fact = byId.get(r.id);
    if (fact === undefined) continue;
    const exit = r.action === "拆腿平仓" ? "拆腿" : r.action.includes("到期") ? "持有到期" : "提前平仓";
    out.push({ fact, exit, structure: r.structure, coarse: true });
  }
  return out;
}

/** 股票持仓段。 */
export function stockEntries(facts: readonly IdeaTradeFact[]): HistoryEntry[] {
  return facts.filter((f) => f.kind === "stock").map((fact) => ({
    fact,
    exit: fact.how === "open" ? "持仓中" : "已平仓",
    structure: "股票",
    coarse: false,
    side: fact.label.endsWith("做空") ? "SHORT" : "LONG",
  }));
}

// ---------------------------------------------------------------- 票据 → 口径

interface Query {
  kind: "butterfly" | "vertical" | "single" | "stock" | "other";
  symbol: string;
  structure: string;
  right?: string;
  width?: number;
  dte?: string;
  slot: string;
  debitRatio?: number;
  side?: string;
  basis: string[];
}

function describe(t: IdeasSimilarTradesParams, nowMs: number): Query {
  const symbol = t.symbol.trim().toUpperCase();
  const legs = [...(t.legs ?? [])].filter((l) => l.strike !== null).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
  const slot = slotOf(nowMs);
  const today = etKey(nowMs, true);
  const dte = t.expiry ? dteBucket(t.expiry, today) : undefined;
  const combo = String(t.combo_strategy ?? "").toUpperCase();
  const secType = t.sec_type.toUpperCase();
  const flyShape = legs.length === 3 && legs[0]!.ratio === 1 && legs[1]!.ratio === 2 && legs[2]!.ratio === 1;
  if (combo === "BUTTERFLY" || (secType === "BAG" && flyShape)) {
    const width = legs.length === 3 ? (legs[1]!.strike ?? 0) - (legs[0]!.strike ?? 0) : undefined;
    const right = String(legs[0]?.right ?? t.right ?? "").toUpperCase() || undefined;
    const debitRatio = width && t.limit_price ? Math.abs(t.limit_price) / width : undefined;
    const basis = [`${symbol} ${right === "P" ? "看跌" : right === "C" ? "看涨" : ""}蝴蝶`];
    if (width) basis.push(`翼宽 ${width}`);
    if (dte) basis.push(dte);
    basis.push(slot);
    if (debitRatio !== undefined) basis.push(`权利金 / 翼宽 ${debitRatio.toFixed(2)}`);
    return { kind: "butterfly", symbol, structure: "蝴蝶", right, width, dte, slot, debitRatio, basis };
  }
  if (combo === "VERTICAL" || (secType === "BAG" && legs.length === 2)) {
    return { kind: "vertical", symbol, structure: "垂直价差", dte, slot, basis: [`${symbol} 垂直价差`, ...(dte ? [dte] : []), slot] };
  }
  if (secType === "OPT") {
    return { kind: "single", symbol, structure: "单腿", dte, slot, basis: [`${symbol} 单腿期权`, ...(dte ? [dte] : []), slot] };
  }
  if (secType === "STK") {
    const side = t.action.toUpperCase() === "SELL" ? "SHORT" : "LONG";
    return { kind: "stock", symbol, structure: "股票", slot, side, basis: [`${symbol} 股票`, t.action.toUpperCase() === "SELL" ? "卖出" : "买入"] };
  }
  return { kind: "other", symbol, structure: "", slot, basis: [symbol] };
}

// ---------------------------------------------------------------- 打分

function scoreOf(q: Query, e: HistoryEntry, peers: ReadonlySet<string>): { score: number; reasons: string[]; primary: boolean } | null {
  const same = e.fact.symbol.toUpperCase() === q.symbol;
  if (q.kind === "stock") {
    if (e.structure !== "股票") return null;
    if (!same && !peers.has(e.fact.symbol.toUpperCase())) return null;
    const reasons = [same ? "同标的" : `同板块(${e.fact.symbol})`];
    let score = same ? 2 : 1;
    if (e.side === q.side) { score += 1; reasons.push(q.side === "SHORT" ? "同为做空" : "同为做多"); }
    return { score, reasons, primary: same };
  }
  if (!same) return null;
  if (q.kind === "other") return { score: 1, reasons: ["同标的"], primary: true };
  if (e.coarse) {
    // 导入的期权:结构名对得上才算;「多个仓位同时结算」按导出的说法大概率是蝴蝶,蝴蝶单才带上
    const settledTogether = e.structure === "多个仓位同时结算" && q.kind === "butterfly";
    if (e.structure !== q.structure && !settledTogether) return null;
    return {
      score: 1,
      reasons: [settledTogether ? "同标的、多只同时到期(大概率是蝴蝶)" : "同标的同结构", "导入数据没有行权价,只能粗配"],
      primary: true,
    };
  }
  if (e.structure !== q.structure) return null;
  const reasons = ["同标的同结构"];
  let score = 2;
  if (q.right && e.right === q.right) { score += 1; reasons.push(q.right === "P" ? "同为看跌" : "同为看涨"); }
  if (q.width && e.width && Math.abs(e.width - q.width) <= q.width * WIDTH_TOLERANCE) {
    score += 1; reasons.push(`翼宽相近(${e.width} / ${q.width})`);
  }
  if (q.dte && e.dte === q.dte) { score += 1; reasons.push(`同为${q.dte}`); }
  if (e.slot === q.slot) { score += 1; reasons.push(`同在${q.slot}开仓`); }
  if (q.debitRatio !== undefined && e.debitRatio !== undefined
    && Math.abs(e.debitRatio - q.debitRatio) <= DEBIT_RATIO_TOLERANCE) {
    score += 1; reasons.push(`权利金 / 翼宽相近(${e.debitRatio.toFixed(2)})`);
  }
  return { score, reasons, primary: true };
}

const EXIT_ORDER = ["提前平仓", "持有到期", "拆腿", "已平仓", "持仓中"];

/** 票据 + 历史 → 相似交易(不含 lessons,那是库里的想法,handler 去取)。`peers` 是同板块的别的股票。 */
export function findSimilar(
  ticket: IdeasSimilarTradesParams, history: readonly HistoryEntry[], nowMs: number, peers: ReadonlySet<string> = new Set(),
): Omit<IdeasSimilarTradesResult, "lessons"> {
  const q = describe(ticket, nowMs);
  const matched: SimilarTrade[] = [];
  for (const e of history) {
    const s = scoreOf(q, e, peers);
    if (s !== null) matched.push({ fact: e.fact, score: s.score, reasons: s.reasons, exit: e.exit, primary: s.primary });
  }
  const primary = matched.filter((m) => m.primary);
  const count = (r: string, of: readonly SimilarTrade[] = primary): number => of.filter((m) => m.fact.result === r).length;
  const exits: SimilarExitStat[] = [];
  for (const exit of EXIT_ORDER) {
    const of = primary.filter((m) => m.exit === exit);
    if (!of.length) continue;
    exits.push({
      exit, win: count("win", of), loss: count("loss", of), flat: count("flat", of),
      open: count("open", of), unknown: count("unknown", of),
    });
  }
  const when = (m: SimilarTrade): number => parseWhen(m.fact.opened_at) ?? 0;
  const top = [...matched].sort((a, b) =>
    Number(b.primary) - Number(a.primary) || b.score - a.score || when(b) - when(a)).slice(0, TOP_MATCHES);
  return {
    kind: q.kind,
    symbol: q.symbol,
    basis: q.basis,
    count: primary.length,
    win: count("win"),
    loss: count("loss"),
    flat: count("flat"),
    open: count("open"),
    unknown: count("unknown"),
    exits,
    matches: top,
  };
}
