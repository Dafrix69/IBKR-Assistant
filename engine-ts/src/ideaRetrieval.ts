/** 想法检索:打分、按时间分层抽样、入参的纯文本整理。纯计算,不认识库、模型、RPC(设计与口径见 docs/features/idea-retrieval.md)。
 *
 * 为什么不纯按相关度取 top-k:交易日志是有偏样本——大赚大亏写得多写得细,平淡的中间态懒得写。
 * 纯按相关度召回会系统性多喂戏剧性案例,那正是写日志想纠正的偏差。所以命中的想法按时间切成几段,
 * 每段配额相同(某段不够,余量匀给别的段);最近一批无条件进,让模型看得见认知的演化。
 */
import type { Idea, IdeaFocus, IdeaMatch } from "./contract/ideas.js";

/** 一条候选:想法 + 命中了哪一路(形状同 store.searchIdeas 的回行,这里不 import 库)。 */
export interface RetrievalCandidate {
  idea: Idea;
  symbol_hit: boolean;
  text_hit: boolean;
}

export interface PickedIdea {
  idea: Idea;
  matched_by: IdeaMatch[];
}

export interface PickOptions {
  /** 一共最多喂几条(同老口径的 100) */
  total: number;
  /** 最近几条无条件进 */
  recent: number;
  /** 命中的想法按时间切成几段 */
  buckets: number;
}

/** ideas.digest 带焦点时的配额:总数同老口径 100 条,其中最近 20 条无条件进,余下远 / 中 / 近三段均分。 */
export const DIGEST_PICK: PickOptions = { total: 100, recent: 20, buckets: 3 };

/** 标的命中比原文命中重:标的是抽出来的结构化标签,词可能只是顺嘴提到。 */
export function scoreCandidate(c: RetrievalCandidate): number {
  return (c.symbol_hit ? 2 : 0) + (c.text_hit ? 1 : 0);
}

export function matchTags(c: RetrievalCandidate): IdeaMatch[] {
  const out: IdeaMatch[] = [];
  if (c.symbol_hit) out.push("symbol");
  if (c.text_hit) out.push("text");
  return out;
}

function createdMs(idea: Idea): number {
  const t = Date.parse(String(idea.created_at ?? ""));
  return Number.isFinite(t) ? t : 0;
}

/** 同分时新的在前,再按 id 定序——结果必须确定,测试才钉得住「哪几条被召回」。 */
function byScoreThenNewest(a: RetrievalCandidate, b: RetrievalCandidate): number {
  return scoreCandidate(b) - scoreCandidate(a)
    || createdMs(b.idea) - createdMs(a.idea)
    || (a.idea.id < b.idea.id ? -1 : a.idea.id > b.idea.id ? 1 : 0);
}

/**
 * 从候选里按时间分层取 budget 条。时间跨度 [最早, 最晚] 等分成 buckets 段;
 * 配额按「注水」分:从最近的一段起一轮一条地给,某段取空了就跳过——余量自然匀给还有货的段。
 * 段内按分数高、再按新取。候选本来就不超过 budget 时全要。
 */
export function stratify(
  candidates: readonly RetrievalCandidate[], budget: number, buckets: number,
): RetrievalCandidate[] {
  if (budget <= 0 || !candidates.length) return [];
  if (candidates.length <= budget) return [...candidates];
  const n = Math.max(1, Math.trunc(buckets));
  const times = candidates.map((c) => createdMs(c.idea));
  const lo = Math.min(...times);
  const span = Math.max(...times) - lo;
  const groups: RetrievalCandidate[][] = Array.from({ length: n }, () => []);
  candidates.forEach((c, i) => {
    const t = times[i] ?? lo;
    const idx = span > 0 ? Math.min(n - 1, Math.floor(((t - lo) / span) * n)) : n - 1;
    groups[idx]?.push(c);
  });
  for (const g of groups) g.sort(byScoreThenNewest);

  const quota = groups.map(() => 0);
  let left = budget;
  while (left > 0) {
    let gave = false;
    for (let b = n - 1; b >= 0 && left > 0; b--) {
      if ((quota[b] ?? 0) < (groups[b]?.length ?? 0)) {
        quota[b] = (quota[b] ?? 0) + 1;
        left -= 1;
        gave = true;
      }
    }
    if (!gave) break;
  }
  return groups.flatMap((g, b) => g.slice(0, quota[b] ?? 0));
}

/**
 * 知识总结的取数:最近 opts.recent 条无条件进(它们若也命中了焦点,标签一并带上),
 * 其余命中的按时间分层补到 opts.total 条。返回**按时间从早到晚**(同老口径的喂法)。
 * recentPool 是范围内最近的想法、新的在前;matches 是检索命中,顺序不限。
 */
export function pickForDigest(
  matches: readonly RetrievalCandidate[], recentPool: readonly Idea[], opts: PickOptions = DIGEST_PICK,
): PickedIdea[] {
  const hitById = new Map(matches.map((c) => [c.idea.id, c] as const));
  const chosen = new Map<string, PickedIdea>();
  for (const idea of recentPool.slice(0, Math.max(0, Math.min(opts.recent, opts.total)))) {
    const hit = hitById.get(idea.id);
    chosen.set(idea.id, { idea, matched_by: [...(hit ? matchTags(hit) : []), "recent"] });
  }
  const rest = matches.filter((c) => !chosen.has(c.idea.id));
  for (const c of stratify(rest, opts.total - chosen.size, opts.buckets)) {
    chosen.set(c.idea.id, { idea: c.idea, matched_by: matchTags(c) });
  }
  return [...chosen.values()].sort(
    (a, b) => createdMs(a.idea) - createdMs(b.idea) || (a.idea.id < b.idea.id ? -1 : a.idea.id > b.idea.id ? 1 : 0),
  );
}

// ---------------------------------------------------------------- 入参整理(纯文本)

/** 关键词:按空白与中英文标点切开,去重,丢掉空的。 */
export function splitTerms(q: string | null | undefined): string[] {
  return [...new Set(String(q ?? "").split(/[\s,，、;；]+/u).map((t) => t.trim()).filter(Boolean))];
}

/** 标的:数组或「SPX, AAPL」这样的串都认;大写、去重。 */
export function parseSymbols(raw: readonly string[] | string | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,，、;；]+/u);
  return [...new Set(parts.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
}

/** 焦点整理成规范形状;关键词与标的都空 = 没有焦点(null),调用方走老口径。 */
export function normalizeFocus(raw: IdeaFocus | null | undefined): IdeaFocus | null {
  if (!raw) return null;
  const q = splitTerms(raw.q).join(" ");
  const symbols = parseSymbols(raw.symbols);
  if (!q && !symbols.length) return null;
  const out: IdeaFocus = {};
  if (q) out.q = q;
  if (symbols.length) out.symbols = symbols;
  return out;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 「YYYY-MM-DD」换成和 created_at 可比的串:起点是当天 00:00,终点给次日 00:00(含当天)。
 * 不给是 null;格式不对或不是真日子(2026-02-30)抛错,原话给 handler。
 */
export function dayBound(raw: string | null | undefined, name: "since" | "until"): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = DAY.exec(s);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new Error(`${name} 应为 YYYY-MM-DD 的日期,收到:${s}`);
  }
  const at = name === "until" ? t + 86_400_000 : t;
  return new Date(at).toISOString().slice(0, 19);
}
