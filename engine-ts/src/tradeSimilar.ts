/**
 * 下单页「历史相似交易」:拿一张订单票据,在历史交易里找相似的,按出场方式数胜负。
 *
 * 纯函数、规则打分,不用嵌入、不调模型(idea-retrieval.md 的边界:成交是精确数据,近似检索会给出不带「我不确定」的错答案)。
 * 历史来自 tradeOutcomes 的同一批事实:券商成交合成的蝴蝶与 Flex 期权仓位(都有行权价,能比翼宽、到期、时段、权利金、
 * 中心离现价)、股票持仓段、按结构整理的期权出场事件(没有行权价,只能按「同标的同结构」粗配,每条都写明)。
 *
 * 只读、只展示:结果不回流到任何下单决策。
 */
import type {
  IdeaTradeFact, IdeasSimilarTradesParams, IdeasSimilarTradesResult, SimilarExitStat, SimilarTrade,
} from "./contract/ideas.js";
import type { ImportedOptionTrade, OptionPosition } from "./importedTrades.js";
import type { ButterflyRecord } from "./tradeOutcomes.js";
import { butterflyProfile, entryOf, etKey, indexAt, parseWhen, ReviewError } from "./tradereview.js";
import { ET, wallParts } from "./tz.js";

/** 列出来的最多几笔 */
export const TOP_MATCHES = 8;
/** 翼宽差在这个比例以内算相近 */
export const WIDTH_TOLERANCE = 0.2;
/** 权利金 / 翼宽 差在这个以内算相近(0.05 = 翼宽的 5%) */
export const DEBIT_RATIO_TOLERANCE = 0.05;
/** 蝴蝶中心离现价(以翼宽计)差在这个以内算相近 */
export const CENTER_DIST_TOLERANCE = 0.5;
/** 股票「进场价在近期区间的位置」看进场前多少根日线 */
export const RANGE_LOOKBACK = 20;

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
  /** 蝴蝶:开仓那一刻中心离标的价几个翼宽(中心 − 标的)/ 翼宽,正 = 中心在上方。取不到开仓时的标的价就没有 */
  centerDist?: number;
  /** 股票:LONG / SHORT */
  side?: string;
  /** 股票:进场价在进场前 RANGE_LOOKBACK 根日线高低区间里的位置(0 = 最低,1 = 最高,可以出界) */
  rangePos?: number;
}

/** 上下文:要取行情的几样,由 handler 取好传进来(取不到就不给,那一项不比)。 */
export interface SimilarContext {
  /** 标的现价(蝴蝶算中心离现价用) */
  spot?: number | null;
  /** 股票:现价在近 RANGE_LOOKBACK 根日线区间里的位置 */
  rangePos?: number | null;
}

/** 近期区间的位置分三档 */
export function rangeBucket(pos: number): string {
  if (pos < 1 / 3) return "低位";
  if (pos > 2 / 3) return "高位";
  return "中间";
}

/** 进场价在 `beforeDate` 之前 lookback 根日线的高低区间里的位置;日线不够或区间为零时 null。 */
export function rangePosition(
  bars: ReadonlyArray<{ date?: unknown; high?: unknown; low?: unknown }>, beforeDate: string, price: number,
  lookback = RANGE_LOOKBACK,
): number | null {
  const prior = bars.filter((b) => String(b.date ?? "") < beforeDate).slice(-lookback);
  if (prior.length < lookback) return null;
  const hi = Math.max(...prior.map((b) => Number(b.high)));
  const lo = Math.min(...prior.map((b) => Number(b.low)));
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  return (price - lo) / (hi - lo);
}

/** 分钟线里开仓那一刻(该时刻或之前最后一根)的收盘价;K 线没覆盖到返回 null。 */
export function priceAt(bars: ReadonlyArray<{ time?: unknown; close?: unknown }>, whenMs: number): number | null {
  const idx = indexAt(bars as Array<Record<string, unknown>>, whenMs, false);
  if (idx === null) return null;
  const close = Number(bars[idx]?.close);
  return Number.isFinite(close) ? close : null;
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

/** 离到期几个自然日 → 桶 */
export function bucketOfDays(days: number): string {
  if (days <= 0) return "当日到期";
  if (days <= 7) return "一周内到期";
  return "一周以上到期";
}

/** 到期日距交易日的自然日 → 桶 */
export function dteBucket(expiry: string, tradeDate: string): string | undefined {
  const e = expiry.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const a = Date.parse(`${e}T00:00:00Z`), b = Date.parse(`${tradeDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return bucketOfDays(Math.round((a - b) / 86_400_000));
}

/** Flex 仓位的了结方式 → 相似交易里按出场方式分的那一档 */
export function positionExit(p: OptionPosition): string {
  if (p.status === "持仓中" || p.exit === "持仓中") return "持仓中";
  if (p.exit === "持有到期") return "持有到期";
  if (p.exit === "拆腿后到期") return "拆腿";
  if (p.exit.includes("逐腿")) return "逐腿平仓";
  return "提前平仓";
}

// ---------------------------------------------------------------- 历史 → 可比要素

/** 券商成交合成的蝴蝶:行权价齐全,各项都能比。facts 是 tradeOutcomes 算好的同一批(按 id 对上);
 *  `entryUnderlying` 是开仓那一刻的标的价(id → 价,存在 trade_entry_context 里),有才比中心离现价。 */
export function butterflyEntries(
  records: readonly ButterflyRecord[], facts: readonly IdeaTradeFact[],
  entryUnderlying: ReadonlyMap<string, number> = new Map(),
): HistoryEntry[] {
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
    const under = entryUnderlying.get(fact.id);
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
      centerDist: width && under !== undefined ? (Number(profile["center"]) - under) / width : undefined,
    });
  }
  return out;
}

/** Flex 期权仓位:行权价齐全,和券商成交合成的蝴蝶一样逐项比。`entryUnderlying`:仓位 id → 开仓那一刻的标的价。 */
export function positionEntries(
  rows: readonly OptionPosition[], facts: readonly IdeaTradeFact[],
  entryUnderlying: ReadonlyMap<string, number> = new Map(),
): HistoryEntry[] {
  const byId = new Map(facts.filter((f) => f.kind === "option").map((f) => [f.id, f]));
  const out: HistoryEntry[] = [];
  for (const p of rows) {
    const fact = byId.get(p.id);
    const when = parseWhen(p.open_et);
    if (fact === undefined || when === null) continue;
    const width = p.width !== null && p.width > 0 ? p.width : undefined;
    const under = entryUnderlying.get(p.id);
    out.push({
      fact,
      exit: positionExit(p),
      structure: p.structure,
      coarse: false,
      right: p.right === "C" || p.right === "P" ? p.right : undefined,
      width,
      dte: p.dte === null ? dteBucket(p.expiry, p.open_et.slice(0, 10)) : bucketOfDays(p.dte),
      slot: slotOf(when),
      debitRatio: width && p.net_price !== null && p.net_price > 0 ? p.net_price / width : undefined,
      centerDist: width && p.center !== null && under !== undefined ? (p.center - under) / width : undefined,
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

/** 股票持仓段。`rangePos`:id → 进场价在进场前近期区间里的位置(handler 按日线算好,只算同标的的)。 */
export function stockEntries(facts: readonly IdeaTradeFact[], rangePos: ReadonlyMap<string, number> = new Map()): HistoryEntry[] {
  return facts.filter((f) => f.kind === "stock").map((fact) => ({
    fact,
    exit: fact.how === "open" ? "持仓中" : "已平仓",
    structure: "股票",
    coarse: false,
    side: fact.label.endsWith("做空") ? "SHORT" : "LONG",
    rangePos: rangePos.get(fact.id),
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
  centerDist?: number;
  side?: string;
  rangePos?: number;
  basis: string[];
}

/** 票据是哪一类(handler 据此决定要取哪些行情)。 */
export function ticketKind(t: IdeasSimilarTradesParams): Query["kind"] {
  return describe(t, 0, {}).kind;
}

function describe(t: IdeasSimilarTradesParams, nowMs: number, ctx: SimilarContext): Query {
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
    const center = legs.length === 3 ? legs[1]!.strike : null;
    const centerDist = width && center !== null && ctx.spot ? (center - ctx.spot) / width : undefined;
    const basis = [`${symbol} ${right === "P" ? "看跌" : right === "C" ? "看涨" : ""}蝴蝶`];
    if (width) basis.push(`翼宽 ${width}`);
    if (dte) basis.push(dte);
    basis.push(slot);
    if (debitRatio !== undefined) basis.push(`权利金 / 翼宽 ${debitRatio.toFixed(2)}`);
    if (centerDist !== undefined) basis.push(`中心离现价 ${centerDist.toFixed(1)} 个翼宽`);
    return { kind: "butterfly", symbol, structure: "蝴蝶", right, width, dte, slot, debitRatio, centerDist, basis };
  }
  if (combo === "VERTICAL" || (secType === "BAG" && legs.length === 2)) {
    return { kind: "vertical", symbol, structure: "垂直价差", dte, slot, basis: [`${symbol} 垂直价差`, ...(dte ? [dte] : []), slot] };
  }
  if (secType === "OPT") {
    return { kind: "single", symbol, structure: "单腿", dte, slot, basis: [`${symbol} 单腿期权`, ...(dte ? [dte] : []), slot] };
  }
  if (secType === "STK") {
    const side = t.action.toUpperCase() === "SELL" ? "SHORT" : "LONG";
    const rangePos = ctx.rangePos ?? undefined;
    const basis = [`${symbol} 股票`, t.action.toUpperCase() === "SELL" ? "卖出" : "买入"];
    if (rangePos !== undefined) basis.push(`现价在近 ${RANGE_LOOKBACK} 日区间的${rangeBucket(rangePos)}(${rangePos.toFixed(2)})`);
    return { kind: "stock", symbol, structure: "股票", slot, side, rangePos, basis };
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
    if (q.rangePos !== undefined && e.rangePos !== undefined && rangeBucket(q.rangePos) === rangeBucket(e.rangePos)) {
      score += 1;
      reasons.push(`同在近 ${RANGE_LOOKBACK} 日区间的${rangeBucket(e.rangePos)}进场(${e.rangePos.toFixed(2)} / ${q.rangePos.toFixed(2)})`);
    }
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
  if (q.centerDist !== undefined && e.centerDist !== undefined
    && Math.abs(e.centerDist - q.centerDist) <= CENTER_DIST_TOLERANCE) {
    score += 1; reasons.push(`中心离现价相近(${e.centerDist.toFixed(1)} / ${q.centerDist.toFixed(1)} 个翼宽)`);
  }
  return { score, reasons, primary: true };
}

const EXIT_ORDER = ["提前平仓", "逐腿平仓", "持有到期", "拆腿", "已平仓", "持仓中"];

/** 票据 + 历史 → 相似交易(不含 lessons,那是库里的想法,handler 去取)。`peers` 是同板块的别的股票。 */
export function findSimilar(
  ticket: IdeasSimilarTradesParams, history: readonly HistoryEntry[], nowMs: number, peers: ReadonlySet<string> = new Set(),
  ctx: SimilarContext = {},
): Omit<IdeasSimilarTradesResult, "lessons"> {
  const q = describe(ticket, nowMs, ctx);
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
