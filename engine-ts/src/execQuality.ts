/**
 * 执行损耗(docs/features/performance.md「执行损耗」):自动平仓触发那一刻的持仓现价 vs 实际成交均价。
 *
 * 追价平仓每轮都知道模型价、自然价、挂的价,但以前一样都没落下,「按中间价触发、实际卖在哪」这件事没有数。
 * 引擎在两条平仓痕里记下触发时的现价(audit_log 的 auto_close / hosted_sweep 的 `mark`),成交均价在那张单的记录上;
 * 这里把两头对上,算每笔让出去多少钱。中位数给回测当成本假设用(backtestLab 的 `cost_pct`)。
 *
 * 纯函数,不碰券商、不碰存储。老的痕(2026-09-26 之前)没有 mark,数成 `missing`,不猜。
 */
import type { ExecutionCost, ExecutionGroup, ExecutionRow, PerformanceKind, PerformanceScope } from "./contract/performance.js";
import { pyRound } from "./py.js";

/** 一张平仓单的记录里这里要读的几项(store.getRecord 折过事件的那份)。 */
export interface TraceRecord {
  contract?: { secType?: unknown; multiplier?: unknown } | null;
  order?: { action?: unknown; quantity?: unknown; totalQuantity?: unknown } | null;
  account?: { is_paper?: unknown } | null;
  ibkr?: { avg_fill_price?: unknown; fills?: Array<{ qty?: unknown; sec_type?: unknown }> | null } | null;
}

/** 一条平仓痕:审计里的一行 + 它指向的那张单。 */
export interface CloseTrace {
  at: string;
  path: "auto_close" | "hosted_sweep";
  symbol: string;
  state: string;
  /** 触发时的持仓现价;老痕没有是 null */
  mark: number | null;
  /** 找不到那张单(老痕没记、记录被清)是 null */
  record: TraceRecord | null;
}

export interface ExecutionOptions {
  scope: PerformanceScope;
  kind: PerformanceKind;
  days: number | null;
  now: number;
}

/** 最多交出去几行明细。 */
export const MAX_EXECUTION_ROWS = 50;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 绩效体检的「品种」怎么对到合约类型:组合记成蝴蝶(本仓库的组合几乎全是蝶),单腿期权记成期权。 */
function kindOf(secType: string): PerformanceKind {
  if (secType === "STK") return "stock";
  if (secType === "BAG") return "butterfly";
  return "option";
}

/** 成交了多少份:组合只数 BAG 行(腿行是份数的好几倍,同 store.foldEvents 折均价的口径);没有成交行退回单上的数量。 */
function filledQty(record: TraceRecord, combo: boolean): number | null {
  const fills = record.ibkr?.fills ?? [];
  const rows = combo ? fills.filter((f) => f.sec_type === "BAG") : fills;
  const qty = rows.reduce((acc, f) => acc + (num(f.qty) ?? 0), 0);
  if (qty > 0) return qty;
  return num(record.order?.quantity) ?? num(record.order?.totalQuantity);
}

/** 一条痕 → 一行;算不出回 null。 */
export function executionRow(trace: CloseTrace): ExecutionRow | null {
  const record = trace.record;
  const mark = trace.mark;
  if (record === null || mark === null || !(mark > 0)) return null;
  const fill = num(record.ibkr?.avg_fill_price);
  if (fill === null || !(fill > 0)) return null;
  const secType = String(record.contract?.secType ?? "");
  const side = String(record.order?.action ?? "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return null;
  const qty = filledQty(record, secType === "BAG");
  if (qty === null || !(qty > 0)) return null;
  const mult = num(record.contract?.multiplier) ?? (secType === "STK" ? 1 : 100);
  // 平多头(SELL)卖得比触发价低是让出去;平空头(BUY)买得比触发价高是让出去
  const perUnit = side === "SELL" ? mark - fill : fill - mark;
  return {
    at: trace.at,
    symbol: trace.symbol,
    path: trace.path,
    state: trace.state,
    sec_type: secType,
    side,
    mark: pyRound(mark, 4),
    fill: pyRound(fill, 4),
    qty,
    cost_usd: pyRound(perUnit * qty * mult, 2),
    cost_pct: pyRound((perUnit / mark) * 100, 2),
    paper: Boolean(record.account?.is_paper),
  };
}

/** 全部痕 → 汇总。`missing` 只数落在范围里、却算不出的那些。 */
export function executionCost(traces: readonly CloseTrace[], opts: ExecutionOptions): ExecutionCost {
  const since = opts.days !== null ? opts.now - opts.days * 86_400_000 : null;
  const inWindow = traces.filter((t) => since === null || Date.parse(t.at) >= since);
  const rows: ExecutionRow[] = [];
  let missing = 0;
  for (const trace of inWindow) {
    const paper = Boolean(trace.record?.account?.is_paper);
    const secType = String(trace.record?.contract?.secType ?? "");
    if (trace.record !== null) {
      if (opts.scope !== "all" && (opts.scope === "paper") !== paper) continue;
      if (opts.kind !== "all" && kindOf(secType) !== opts.kind) continue;
    }
    const row = executionRow(trace);
    if (row === null) missing += 1;
    else rows.push(row);
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const costs = rows.map((r) => r.cost_usd);
  const pcts = rows.map((r) => r.cost_pct);
  const groups = new Map<string, ExecutionRow[]>();
  for (const r of rows) groups.set(r.sec_type, [...(groups.get(r.sec_type) ?? []), r]);
  const bySec: ExecutionGroup[] = [...groups.entries()]
    .map(([sec, g]) => {
      const m = median(g.map((r) => r.cost_pct));
      const a = mean(g.map((r) => r.cost_usd));
      return { sec_type: sec, samples: g.length, median_pct: m === null ? null : pyRound(m, 2), avg_usd: a === null ? null : pyRound(a, 2) };
    })
    .sort((a, b) => b.samples - a.samples || a.sec_type.localeCompare(b.sec_type));
  const total = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const avgUsd = mean(costs);
  const med = median(pcts);
  const avgPct = mean(pcts);
  return {
    samples: rows.length,
    missing,
    total_usd: total === null ? null : pyRound(total, 2),
    avg_usd: avgUsd === null ? null : pyRound(avgUsd, 2),
    median_pct: med === null ? null : pyRound(med, 2),
    avg_pct: avgPct === null ? null : pyRound(avgPct, 2),
    by_sec_type: bySec,
    rows: rows.slice(0, MAX_EXECUTION_ROWS),
  };
}
