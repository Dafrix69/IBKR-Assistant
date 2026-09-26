/**
 * 绩效体检(docs/features/performance.md):已了结的交易 → 一本美元账 → 冠军交易员天天盯的那几个数 → 行为上的毛病。
 *
 * 输入与交易分析、知识总结是同一批事实(`ibtrades.groupButterflies` 合成的蝴蝶、`stockreview` 切出的股票持仓段、
 * Flex 期权仓位、按结构整理的期权出场事件),去重规则由调用方(services/tradeHistory)按同一套办好再传进来。
 * 和 tradeOutcomes 的区别:那边只出比例、要发给模型;这边出**金额**,只在本机算、只给界面看,不调模型。
 *
 * 纯函数,不碰券商、不碰存储。到期结算要的收盘价由调用方查好了传进来,查不到就是「结果不明」,**不猜**。
 */
import type {
  EquityPoint, LedgerTrade, PerfDays, PerfDrawdown, PerfGroup, PerfRStats, PerfStats, PerformanceFinding,
  PerformanceKind, PerformanceScope, ProtectionAdvice, ReviewPerformanceResult,
} from "./contract/performance.js";
import type { ProtectionsConfig } from "./contract/settings.js";
import { executionCost } from "./execQuality.js";
import type { CloseTrace } from "./execQuality.js";
import type { ImportedOptionTrade, OptionPosition } from "./importedTrades.js";
import { pyRound } from "./py.js";
import { etIso } from "./tradeOutcomes.js";
import type { ButterflyRecord, SettleClose, StockTrip } from "./tradeOutcomes.js";
import { butterflyProfile, etKey, expiryClose, pairButterflies, parseWhen, payoffPerUnit } from "./tradereview.js";
import { ET, utcIso, wallParts } from "./tz.js";

/** 股票持仓段里这里多读的两项:峰值股数(算占用)与佣金(扣进盈亏)。 */
export type LedgerStockTrip = StockTrip & { qty?: unknown; commission?: unknown };

/** 蝴蝶记录里这里多读的:券商回报里的合计佣金。 */
type FlyRecord = ButterflyRecord & { ibkr?: { avg_fill_price?: unknown; total_commission?: unknown } | null };

/** 建追踪时计划的止损(store.plannedStops):股票没有「风险」这个成交字段,R 的分母只能从这里来。 */
export interface PlannedStop {
  /** 建追踪的时刻(ISO) */
  at: string;
  /** 账户别名;老的痕里没有,是 null(只按标的配) */
  account: string | null;
  symbol: string;
  /** 老的痕里没有,是 null;有的话只认 STK */
  sec_type: string | null;
  stop: number;
}

export interface LedgerInputs {
  butterflies: FlyRecord[];
  trips: LedgerStockTrip[];
  /** 没有就是空:股票一笔也没有 R,和以前一样 */
  stops?: readonly PlannedStop[];
  positions: readonly OptionPosition[];
  /** 已经按「库里有完整成交 / Flex 仓位覆盖」去过重的导入期权事件 */
  options: readonly ImportedOptionTrade[];
  settleClose: SettleClose;
  isPaper: (accountId: string) => boolean;
  now: number;
}

export interface Ledger {
  trades: LedgerTrade[];
  excluded: { open: number; unknown: number; no_cost: number };
}

/** 持平的门槛(美元):一次来回的佣金量级,不该读成赢或输。 */
export const FLAT_USD = 1.0;
/** 一个分组至少几笔才下结论(时段、星期、行为规则)。 */
export const MIN_GROUP = 8;
/** 全部样本少于这个数,所有结论都只当提示(Kevin Davey:几十笔之前看不出优势)。 */
export const MIN_SAMPLE = 30;
/** 「最近」取几笔和全部比。 */
export const RECENT_WINDOW = 10;
/** 亏完多少分钟之内再开仓算「马上又进」。 */
export const REVENGE_MINUTES = 30;
/** 账本最多交出去几笔。 */
export const MAX_LEDGER_ROWS = 300;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function isoOf(value: unknown): string | null {
  const when = parseWhen(value);
  return when === null ? null : utcIso(when);
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return pyRound((b - a) / 60_000, 1);
}

function rOf(pnl: number, risk: number | null): number | null {
  return risk !== null && risk > 0 ? pyRound(pnl / risk, 2) : null;
}

// ---------------------------------------------------------------- 账本

/** 蝴蝶:开仓那条一笔,平仓单并进来;没平仓、过了到期日的按收盘结算。持仓中与结算价不明的不进账。 */
export function butterflyLedger(records: FlyRecord[], settleClose: SettleClose, now: number, excluded: Ledger["excluded"]): LedgerTrade[] {
  const pairs = pairButterflies(records);
  const out: LedgerTrade[] = [];
  for (const record of records) {
    const id = String(record.id ?? "");
    const link = pairs[id];
    if (link && link["role"] === "exit") continue;
    const profile = butterflyProfile(record);
    if (profile === null) continue;
    const debit = num(profile["debit"]);
    const mult = num(profile["multiplier"]) ?? 100;
    const qty = num(profile["qty"]) ?? 1;
    const buy = profile["action"] === "BUY";
    let exitPrice: number | null = null;
    let closedAt: string | null = null;
    let exitComm: number | null = null;
    if (link) {
      const peer = records.find((r) => r.id === link["peer"]);
      exitPrice = num(peer?.ibkr?.avg_fill_price);
      closedAt = isoOf(peer?.created_at);
      exitComm = num(peer?.ibkr?.total_commission);
    } else if (now >= expiryClose(profile)) {
      closedAt = utcIso(expiryClose(profile));
      const close = settleClose(String(profile["symbol"]), String(profile["expiry"]));
      if (close !== null) exitPrice = payoffPerUnit(profile, close);
      exitComm = 0; // 到期结算没有平仓佣金
    } else {
      excluded.open += 1;
      continue;
    }
    if (debit === null || exitPrice === null || closedAt === null) {
      excluded.unknown += 1;
      continue;
    }
    const openComm = num(record.ibkr?.total_commission);
    const gross = (buy ? 1 : -1) * (exitPrice - debit) * mult * qty;
    const pnl = pyRound(gross - (openComm ?? 0) - (exitComm ?? 0), 2);
    const width = num(profile["width"]);
    const risk = buy
      ? debit * mult * qty
      : profile["symmetric"] && width !== null && width > debit ? (width - debit) * mult * qty : null;
    const openedAt = isoOf(record.created_at);
    out.push({
      id,
      kind: "butterfly",
      symbol: String(profile["symbol"]),
      label: `${profile["symbol"]} ${profile["lower"]}/${profile["center"]}/${profile["upper"]} ` +
        `${profile["right_label"]}蝴蝶 ${buy ? "买入" : "卖出"}`,
      opened_at: openedAt,
      closed_at: closedAt,
      pnl,
      net_of_commission: openComm !== null && exitComm !== null,
      risk: risk === null ? null : pyRound(risk, 2),
      r: rOf(pnl, risk),
      exposure: pyRound((risk ?? debit * mult * qty), 2),
      hold_minutes: minutesBetween(openedAt, closedAt),
      paper: Boolean(record.account?.is_paper),
    });
  }
  return out;
}

/** 这段持仓建仓时计划的止损:同标的(有账户的痕还要同账户)、在持仓期间建的追踪里**最早**那条。
 * 止损要在保护一侧(做多低于进场均价、做空高于),否则不是止损,不算。
 * 要的是初始风险(Van Tharp 的 R):之后改过、上移过的止损不算,所以只看建追踪那一刻填的。 */
export function plannedStopFor(trip: LedgerStockTrip, stops: readonly PlannedStop[]): number | null {
  const from = parseWhen(trip.created_at);
  const to = parseWhen(trip.closed_at);
  const entry = num(trip.avg_entry);
  if (from === null || to === null || entry === null) return null;
  const symbol = String(trip.symbol ?? "").toUpperCase();
  const alias = String(trip.account?.alias ?? "");
  const short = trip.side === "SHORT";
  for (const s of stops) {
    if (s.symbol !== symbol || (s.sec_type !== null && s.sec_type !== "STK")) continue;
    if (s.account !== null && alias && s.account !== alias) continue;
    const at = Date.parse(s.at);
    if (Number.isNaN(at) || at < from || at > to) continue;
    if (short ? s.stop > entry : s.stop < entry) return s.stop;
  }
  return null;
}

/** 股票:平完的一段持仓一笔。建仓早于已同步成交的(成本不明)不进账。 */
export function stockLedger(trips: LedgerStockTrip[], excluded: Ledger["excluded"], stops: readonly PlannedStop[] = []): LedgerTrade[] {
  const out: LedgerTrade[] = [];
  for (const trip of trips) {
    if (trip.status !== "closed") {
      excluded.open += 1;
      continue;
    }
    const realized = num(trip.realized_pnl);
    if (trip.carried || realized === null) {
      excluded.no_cost += 1;
      continue;
    }
    const comm = num(trip.commission);
    const entry = num(trip.avg_entry);
    const qty = num(trip.qty);
    const openedAt = isoOf(trip.created_at);
    const closedAt = isoOf(trip.closed_at);
    if (closedAt === null) {
      excluded.unknown += 1;
      continue;
    }
    // R 的分母 = |进场均价 − 计划止损| × 峰值股数。加过仓的按峰值算,偏保守(分母偏大、R 偏小)
    const stop = plannedStopFor(trip, stops);
    const risk = stop !== null && entry !== null && qty !== null && qty > 0 ? Math.abs(entry - stop) * qty : null;
    const pnl = pyRound(realized - (comm ?? 0), 2);
    out.push({
      id: String(trip.id ?? ""),
      kind: "stock",
      symbol: String(trip.symbol ?? ""),
      label: `${trip.symbol} ${trip.side === "SHORT" ? "做空" : "做多"}`,
      opened_at: openedAt,
      closed_at: closedAt,
      pnl,
      net_of_commission: comm !== null,
      risk: risk === null ? null : pyRound(risk, 2),
      r: rOf(pnl, risk),
      exposure: entry !== null && qty !== null ? pyRound(entry * qty, 2) : null,
      hold_minutes: minutesBetween(openedAt, closedAt),
      paper: Boolean(trip.account?.is_paper),
    });
  }
  return out;
}

/** 借方开仓、最大亏损就是付出去的权利金的结构:这些才有 R。贷方结构、比例蝶、日历的风险不止权利金。 */
const DEBIT_RISK_STRUCTURES = new Set(["蝴蝶", "垂直价差", "单腿"]);

/** Flex 期权仓位:了结的一个仓位一笔,盈亏已扣佣金。 */
export function positionLedger(
  rows: readonly OptionPosition[], isPaper: (accountId: string) => boolean, excluded: Ledger["excluded"],
): LedgerTrade[] {
  const out: LedgerTrade[] = [];
  for (const p of rows) {
    if (p.status === "持仓中" || p.exit === "持仓中" || !p.closed_et) {
      excluded.open += 1;
      continue;
    }
    const qty = p.qty !== null && p.qty > 0 ? p.qty : null;
    const debit = qty !== null && p.net_price !== null && p.net_price > 0 ? p.net_price * 100 * qty : null;
    const risk = debit !== null && DEBIT_RISK_STRUCTURES.has(p.structure) && !p.direction.includes("贷方") ? debit : null;
    const pnl = pyRound(p.realized_pnl, 2);
    const openedAt = etIso(p.open_et);
    const closedAt = etIso(p.closed_et);
    out.push({
      id: p.id,
      kind: "option",
      symbol: p.symbol,
      label: [p.symbol, p.strikes, p.structure, p.direction].filter(Boolean).join(" "),
      opened_at: openedAt,
      closed_at: closedAt,
      pnl,
      net_of_commission: true,
      risk: risk === null ? null : pyRound(risk, 2),
      r: rOf(pnl, risk),
      exposure: debit === null ? null : pyRound(debit, 2),
      hold_minutes: p.hold_min ?? minutesBetween(openedAt, closedAt),
      paper: isPaper(p.account_id),
    });
  }
  return out;
}

/** 导入的期权出场事件:一次出场一笔,盈亏已扣佣金;开仓没配对,没有开仓时刻、风险与占用。 */
export function optionLedger(rows: readonly ImportedOptionTrade[], isPaper: (accountId: string) => boolean): LedgerTrade[] {
  return rows
    .filter((r) => r.action !== "开仓")
    .map((r): LedgerTrade => ({
      id: r.id,
      kind: "option",
      symbol: r.symbol,
      label: `${r.symbol} ${r.structure}${r.direction ? `(${r.direction})` : ""} · ${r.action}`,
      opened_at: null,
      closed_at: etIso(r.time_et),
      pnl: pyRound(r.realized_pnl, 2),
      net_of_commission: true,
      risk: null,
      r: null,
      exposure: null,
      hold_minutes: null,
      paper: isPaper(r.account_id),
    }));
}

/** 四类合成一本账,按了结时刻从早到晚。 */
export function buildLedger(inp: LedgerInputs): Ledger {
  const excluded = { open: 0, unknown: 0, no_cost: 0 };
  const trades = [
    ...butterflyLedger(inp.butterflies, inp.settleClose, inp.now, excluded),
    ...stockLedger(inp.trips, excluded, inp.stops ?? []),
    ...positionLedger(inp.positions, inp.isPaper, excluded),
    ...optionLedger(inp.options, inp.isPaper),
  ];
  trades.sort((a, b) => (a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1));
  return { trades, excluded };
}

// ---------------------------------------------------------------- 统计

function outcome(t: LedgerTrade): "win" | "loss" | "flat" {
  return Math.abs(t.pnl) < FLAT_USD ? "flat" : t.pnl > 0 ? "win" : "loss";
}

function ratio(a: number, b: number): number | null {
  return b > 0 ? pyRound(a / b, 2) : null;
}

/** 一组交易的基本面。`trades` 要按了结时刻从早到晚排好(连胜连亏按这个次序数)。 */
export function perfStats(trades: readonly LedgerTrade[]): PerfStats {
  let wins = 0, losses = 0, flats = 0, grossProfit = 0, grossLoss = 0;
  let largestWin: number | null = null, largestLoss: number | null = null;
  let runW = 0, runL = 0, maxW = 0, maxL = 0;
  for (const t of trades) {
    const o = outcome(t);
    if (o === "win") {
      wins += 1; grossProfit += t.pnl; runW += 1; runL = 0;
      largestWin = largestWin === null ? t.pnl : Math.max(largestWin, t.pnl);
    } else if (o === "loss") {
      losses += 1; grossLoss += -t.pnl; runL += 1; runW = 0;
      largestLoss = largestLoss === null ? t.pnl : Math.min(largestLoss, t.pnl);
    } else {
      flats += 1; // 持平不打断连胜连亏,也不算进胜率
    }
    maxW = Math.max(maxW, runW);
    maxL = Math.max(maxL, runL);
  }
  const net = trades.reduce((acc, t) => acc + t.pnl, 0);
  const decided = wins + losses;
  const avgWin = wins ? grossProfit / wins : null;
  const avgLoss = losses ? -grossLoss / losses : null;
  const payoff = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null;
  return {
    trades: trades.length,
    wins, losses, flats,
    win_rate: decided ? pyRound((wins / decided) * 100, 1) : null,
    net_pnl: pyRound(net, 2),
    gross_profit: pyRound(grossProfit, 2),
    gross_loss: pyRound(grossLoss, 2),
    avg_win: avgWin === null ? null : pyRound(avgWin, 2),
    avg_loss: avgLoss === null ? null : pyRound(avgLoss, 2),
    payoff_ratio: payoff === null ? null : pyRound(payoff, 2),
    profit_factor: ratio(grossProfit, grossLoss),
    expectancy: trades.length ? pyRound(net / trades.length, 2) : null,
    breakeven_win_rate: payoff === null ? null : pyRound(100 / (1 + payoff), 1),
    largest_win: largestWin === null ? null : pyRound(largestWin, 2),
    largest_loss: largestLoss === null ? null : pyRound(largestLoss, 2),
    max_consecutive_wins: maxW,
    max_consecutive_losses: maxL,
  };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] ?? null : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Van Tharp 的 SQN 档位。 */
export function sqnLabel(sqn: number | null): string {
  if (sqn === null) return "";
  if (sqn < 1.6) return "差";
  if (sqn < 2.0) return "一般";
  if (sqn < 2.5) return "好";
  if (sqn < 3.0) return "很好";
  return "极好";
}

/** R 倍数的统计:只数风险固定的那些。SQN 的 N 封顶 100(Tharp 的口径:样本再大也不该把分数无限推高)。 */
export function rStats(trades: readonly LedgerTrade[]): PerfRStats {
  const rs = trades.map((t) => t.r).filter((r): r is number => r !== null);
  if (!rs.length) return { trades: 0, expectancy_r: null, std_r: null, sqn: null, sqn_label: "" };
  const m = mean(rs);
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((acc, r) => acc + (r - m) ** 2, 0) / (rs.length - 1)) : null;
  const sqn = rs.length >= 10 && sd !== null && sd > 0 ? pyRound((Math.sqrt(Math.min(rs.length, 100)) * m) / sd, 2) : null;
  return {
    trades: rs.length,
    expectancy_r: pyRound(m, 2),
    std_r: sd === null ? null : pyRound(sd, 2),
    sqn,
    sqn_label: sqnLabel(sqn),
  };
}

/** 平仓权益曲线与最大回撤:峰值从 0 起步(一路亏就是亏多少算回撤多少),与保护规则的回撤护栏同一个口径。 */
export function equityCurve(trades: readonly LedgerTrade[]): { points: EquityPoint[]; drawdown: PerfDrawdown } {
  let equity = 0, peak = 0, peakAt: string | null = null, maxDd = 0;
  let ddPeakAt: string | null = null, troughAt: string | null = null;
  const points: EquityPoint[] = [];
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) { peak = equity; peakAt = t.closed_at; }
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; ddPeakAt = peakAt; troughAt = t.closed_at; }
    points.push({ time: t.closed_at, equity: pyRound(equity, 2), drawdown: pyRound(dd, 2) });
  }
  return {
    points,
    drawdown: {
      max: pyRound(maxDd, 2),
      peak_at: ddPeakAt,
      trough_at: troughAt,
      current: pyRound(peak - equity, 2),
      recovery_factor: maxDd > 0 ? pyRound(equity / maxDd, 2) : null,
    },
  };
}

/** 美东开仓时段。 */
export function sessionOf(iso: string | null): { key: string; label: string } | null {
  if (iso === null) return null;
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return null;
  const p = wallParts(when, ET);
  const m = p.hour * 60 + p.minute;
  if (m < 570 || m >= 960) return { key: "off", label: "盘外" };
  if (m < 600) return { key: "open30", label: "开盘 30 分钟" };
  if (m < 720) return { key: "morning", label: "上午" };
  if (m < 840) return { key: "midday", label: "午盘" };
  if (m < 930) return { key: "afternoon", label: "下午" };
  return { key: "close30", label: "尾盘 30 分钟" };
}

const SESSION_ORDER = ["open30", "morning", "midday", "afternoon", "close30", "off"];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const KIND_LABEL: Record<LedgerTrade["kind"], string> = { butterfly: "蝴蝶", stock: "股票", option: "期权(导入)" };

function etWeekday(iso: string): number {
  const p = wallParts(Date.parse(iso), ET);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function group(trades: readonly LedgerTrade[], keyOf: (t: LedgerTrade) => { key: string; label: string } | null): PerfGroup[] {
  const buckets = new Map<string, { label: string; rows: LedgerTrade[] }>();
  for (const t of trades) {
    const k = keyOf(t);
    if (k === null) continue;
    const b = buckets.get(k.key) ?? { label: k.label, rows: [] };
    b.rows.push(t);
    buckets.set(k.key, b);
  }
  return [...buckets.entries()].map(([key, b]) => {
    const s = perfStats(b.rows);
    return { key, label: b.label, trades: s.trades, win_rate: s.win_rate, net_pnl: s.net_pnl, expectancy: s.expectancy, profit_factor: s.profit_factor };
  });
}

/** 按美东了结日汇总。 */
export function perDay(trades: readonly LedgerTrade[]): PerfDays & { counts: Map<string, number>; pnl: Map<string, number> } {
  const pnl = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const t of trades) {
    const d = etKey(Date.parse(t.closed_at), true);
    pnl.set(d, (pnl.get(d) ?? 0) + t.pnl);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: { date: string; pnl: number } | null = null;
  let worst: { date: string; pnl: number } | null = null;
  const losing: number[] = [];
  for (const [date, v] of pnl) {
    if (best === null || v > best.pnl) best = { date, pnl: pyRound(v, 2) };
    if (worst === null || v < worst.pnl) worst = { date, pnl: pyRound(v, 2) };
    if (v < 0) losing.push(v);
  }
  return {
    days: pnl.size,
    green_days: [...pnl.values()].filter((v) => v > 0).length,
    best_day: best,
    worst_day: worst,
    avg_losing_day: losing.length ? pyRound(mean(losing), 2) : null,
    counts,
    pnl,
  };
}

/** 凯利比例 f = W − (1 − W) / 盈亏比。输赢不到 MIN_GROUP 笔不算。 */
export function kellyOf(s: PerfStats): number | null {
  if (s.wins + s.losses < MIN_GROUP || s.win_rate === null || s.payoff_ratio === null || s.payoff_ratio <= 0) return null;
  const w = s.win_rate / 100;
  return pyRound(w - (1 - w) / s.payoff_ratio, 3);
}

export interface PerformanceOptions {
  scope: PerformanceScope;
  kind: PerformanceKind;
  days: number | null;
  now: number;
}

/** 按范围筛账本:实盘 / 模拟、品种、最近几天。 */
export function filterLedger(trades: readonly LedgerTrade[], opts: PerformanceOptions): LedgerTrade[] {
  const since = opts.days !== null ? opts.now - opts.days * 86_400_000 : null;
  return trades.filter((t) =>
    (opts.scope === "all" || (opts.scope === "paper") === t.paper)
    && (opts.kind === "all" || opts.kind === t.kind)
    && (since === null || Date.parse(t.closed_at) >= since));
}

/** 体检之外、账本里没有的两样:平仓痕(执行损耗)与眼下的保护规则设置(给建议时比一比)。都不给就是空的。 */
export interface PerformanceExtras {
  traces?: readonly CloseTrace[];
  protections?: ProtectionsConfig | null;
}

/** 整份体检。`ledger.trades` 要按了结时刻从早到晚(buildLedger 给的就是)。 */
export function performanceReport(ledger: Ledger, opts: PerformanceOptions, extras: PerformanceExtras = {}): ReviewPerformanceResult {
  const trades = filterLedger(ledger.trades, opts);
  const stats = perfStats(trades);
  const { points, drawdown } = equityCurve(trades);
  const days = perDay(trades);
  const decided = trades.filter((t) => outcome(t) !== "flat");
  const last = decided[decided.length - 1];
  let streakCount = 0;
  if (last !== undefined) {
    for (let i = decided.length - 1; i >= 0; i -= 1) {
      const t = decided[i];
      if (t === undefined || outcome(t) !== outcome(last)) break;
      streakCount += 1;
    }
  }
  const holdOf = (o: "win" | "loss"): number | null => {
    const m = median(trades.filter((t) => outcome(t) === o).map((t) => t.hold_minutes).filter((h): h is number => h !== null));
    return m === null ? null : pyRound(m, 1);
  };
  const recent = trades.length >= RECENT_WINDOW * 2
    ? { window: RECENT_WINDOW, stats: perfStats(trades.slice(-RECENT_WINDOW)) } : null;
  const session = group(trades, (t) => sessionOf(t.opened_at))
    .sort((a, b) => SESSION_ORDER.indexOf(a.key) - SESSION_ORDER.indexOf(b.key));
  const weekday = group(trades, (t) => {
    const d = etWeekday(t.opened_at ?? t.closed_at);
    return { key: String(d), label: WEEKDAYS[d] ?? "" };
  }).sort((a, b) => Number(a.key) - Number(b.key));
  const symbol = group(trades, (t) => ({ key: t.symbol, label: t.symbol }))
    .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key)).slice(0, 12);
  const kind = group(trades, (t) => ({ key: t.kind, label: KIND_LABEL[t.kind] }));
  const { counts, pnl, ...perDaySummary } = days;
  const report: ReviewPerformanceResult = {
    scope: opts.scope,
    kind: opts.kind,
    days: opts.days,
    stats,
    r_stats: rStats(trades),
    drawdown,
    streak: last === undefined ? { kind: "none", count: 0 } : { kind: outcome(last) === "win" ? "win" : "loss", count: streakCount },
    hold: { win_median_minutes: holdOf("win"), loss_median_minutes: holdOf("loss") },
    kelly: kellyOf(stats),
    recent,
    per_day: perDaySummary,
    equity: points,
    groups: { kind, session, weekday, symbol },
    findings: [],
    execution: executionCost(extras.traces ?? [], opts),
    protection_advice: [],
    trades: [...trades].reverse().slice(0, MAX_LEDGER_ROWS),
    excluded: { ...ledger.excluded },
    notes: ledgerNotes(trades),
  };
  report.findings = findingsOf(trades, report, counts, pnl);
  report.protection_advice = protectionAdvice(trades, report, extras.protections ?? null);
  return report;
}

function ledgerNotes(trades: readonly LedgerTrade[]): string[] {
  const notes: string[] = [];
  const gross = trades.filter((t) => !t.net_of_commission).length;
  if (gross) notes.push(`${gross} 笔的成交回报里没有佣金,盈亏未扣佣金`);
  const noOpen = trades.filter((t) => t.opened_at === null).length;
  if (noOpen) notes.push(`${noOpen} 笔导入的期权出场事件没有配上开仓,不进时段、持有时长与行为规则`);
  notes.push("券商成交里认得出的是股票与三腿蝴蝶;别的期权结构要靠 Flex 导入才进得了账本");
  return notes;
}

// ---------------------------------------------------------------- 规则

function money(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return v < 0 ? `-$${s}` : `$${s}`;
}

/** 亏完 REVENGE_MINUTES 分钟之内开的仓 vs 其余。只看开仓时刻已知的。 */
export function revengeSplit(trades: readonly LedgerTrade[]): { quick: LedgerTrade[]; rest: LedgerTrade[] } {
  const losses = trades.filter((t) => outcome(t) === "loss").map((t) => Date.parse(t.closed_at));
  const quick: LedgerTrade[] = [];
  const rest: LedgerTrade[] = [];
  for (const t of trades) {
    if (t.opened_at === null) continue;
    const open = Date.parse(t.opened_at);
    const after = losses.some((c) => open >= c && open - c <= REVENGE_MINUTES * 60_000);
    (after ? quick : rest).push(t);
  }
  return { quick, rest };
}

/**
 * 亏损之后的下一笔,占用比**同品种**的中位数大 1.5 倍以上的有几次;赢了之后的对照。按开仓时刻排。
 * 中位数按品种各算各的:股票的占用是几千上万的名义金额,蝶是几百的权利金,混在一个中位数里,股票笔笔都"放大"。
 */
export function sizeAfterLoss(trades: readonly LedgerTrade[]): { afterLoss: number; upAfterLoss: number; afterWin: number; upAfterWin: number } {
  const rows = trades
    .flatMap((t) => (t.exposure !== null && t.opened_at !== null ? [{ t, exposure: t.exposure, opened: t.opened_at }] : []))
    .sort((a, b) => (a.opened < b.opened ? -1 : 1));
  const medians = new Map<string, number>();
  for (const kind of new Set(rows.map((r) => r.t.kind))) {
    medians.set(kind, median(rows.filter((r) => r.t.kind === kind).map((r) => r.exposure)) ?? 0);
  }
  const out = { afterLoss: 0, upAfterLoss: 0, afterWin: 0, upAfterWin: 0 };
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1], cur = rows[i];
    if (prev === undefined || cur === undefined) continue;
    const med = medians.get(cur.t.kind) ?? 0;
    const up = med > 0 && cur.exposure > med * 1.5;
    const o = outcome(prev.t);
    if (o === "loss") { out.afterLoss += 1; if (up) out.upAfterLoss += 1; }
    if (o === "win") { out.afterWin += 1; if (up) out.upAfterWin += 1; }
  }
  return out;
}

/**
 * 规则挑毛病。每条都写明借鉴自谁;阈值写死,样本不够就不说。先说最要紧的(期望值),再说行为。
 * 只描述已经发生的事与一条可以对照的规矩,不给仓位、不给买卖建议。
 */
export function findingsOf(
  trades: readonly LedgerTrade[], report: ReviewPerformanceResult, counts: Map<string, number>, pnl: Map<string, number>,
): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const s = report.stats;
  if (!s.trades) return out;
  if (s.trades < MIN_SAMPLE) {
    out.push({ id: "sample", tone: "info", title: `样本只有 ${s.trades} 笔`,
      text: `不到 ${MIN_SAMPLE} 笔时,胜率与期望值会被一两笔大单左右,下面的结论只当提示。`,
      source: "Kevin Davey(World Cup 期货冠军)· 样本够多才谈得上优势" });
  }
  out.push(...edgeFindings(report));
  out.push(...riskFindings(trades, report, counts, pnl));
  out.push(...behaviourFindings(trades, report));
  return out;
}

function edgeFindings(report: ReviewPerformanceResult): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const s = report.stats;
  if (s.expectancy !== null && s.wins + s.losses >= 5) {
    const tail = s.win_rate !== null && s.payoff_ratio !== null
      ? `胜率 ${s.win_rate}%、盈亏比 ${s.payoff_ratio},按这个盈亏比胜率至少要 ${s.breakeven_win_rate}% 才不亏。` : "";
    out.push(s.expectancy > 0
      ? { id: "expectancy", tone: "good", title: `期望值为正:平均每笔 ${money(s.expectancy)}`,
        text: `${tail}利润因子 ${s.profit_factor ?? "—"}。`, source: "Van Tharp · 期望值 = 胜率 × 平均盈利 − 败率 × 平均亏损" }
      : { id: "expectancy", tone: "bad", title: `期望值为负:平均每笔 ${money(s.expectancy)}`,
        text: `${tail}在期望值转正之前,多做只会多亏。`, source: "Van Tharp · 期望值 = 胜率 × 平均盈利 − 败率 × 平均亏损" });
  }
  if (s.payoff_ratio !== null && s.payoff_ratio < 1 && s.win_rate !== null && s.breakeven_win_rate !== null
      && s.win_rate < s.breakeven_win_rate + 5) {
    const gap = pyRound(s.win_rate - s.breakeven_win_rate, 1);
    out.push({ id: "payoff", tone: "warn", title: `赚小亏大:平均亏损是平均盈利的 ${pyRound(1 / s.payoff_ratio, 1)} 倍`,
      text: `平均盈利 ${money(s.avg_win ?? 0)}、平均亏损 ${money(s.avg_loss ?? 0)}。` + (gap >= 0
        ? `胜率只比保本线高 ${gap} 个百分点,几笔不顺就翻成负的。`
        : `胜率比保本线(${s.breakeven_win_rate}%)还低 ${-gap} 个百分点:要么把亏损砍小,要么把盈利拿长。`),
      source: "Mark Minervini(1997 / 2021 美国投资锦标赛冠军)· 平均亏损要远小于平均盈利" });
  }
  const r = report.r_stats;
  if (r.sqn !== null) {
    out.push({ id: "sqn", tone: r.sqn >= 2 ? "good" : r.sqn >= 1.6 ? "info" : "warn",
      title: `SQN ${r.sqn}(${r.sqn_label})`,
      text: `${r.trades} 笔风险固定的交易,平均每笔 ${r.expectancy_r}R,标准差 ${r.std_r}R。SQN 衡量"期望值相对波动有多稳",1.6 以下说明结果主要靠运气。`,
      source: "Van Tharp · R 倍数与系统质量分 SQN" });
  }
  if (report.kelly !== null) {
    out.push(report.kelly <= 0
      ? { id: "kelly", tone: "warn", title: "按统计没有下注优势(凯利比例 ≤ 0)",
        text: "照现在的胜率与盈亏比,凯利公式给的是不下注。没有优势时,单笔风险应该压到最小,先把期望值做正。",
        source: "Larry Williams(1987 World Cup 冠军)· 资金管理决定能不能活下来" }
      : { id: "kelly", tone: "info", title: `凯利比例 ${pyRound(report.kelly * 100, 1)}%`,
        text: `这是理论上让长期增长最快的单笔风险,波动极大。1/4 凯利约 ${pyRound(report.kelly * 25, 1)}%;冠军们实际的单笔风险多在账户的 0.5%–2%。`,
        source: "Larry Williams · 凯利 / optimal f 只当上限参照" });
  }
  if (report.recent !== null && report.stats.expectancy !== null && report.recent.stats.expectancy !== null) {
    const rec = report.recent.stats.expectancy;
    const all = report.stats.expectancy;
    if (rec < 0 && all > 0) {
      out.push({ id: "recent", tone: "warn", title: `最近 ${report.recent.window} 笔在走弱:平均每笔 ${money(rec)}`,
        text: `全部样本平均每笔 ${money(all)}。手感变差的时候先缩小仓位,等重新赚起来再一步步放回去。`,
        source: "Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减" });
    } else if (rec > all && rec > 0) {
      out.push({ id: "recent", tone: "good", title: `最近 ${report.recent.window} 笔好于平均:每笔 ${money(rec)}`,
        text: `全部样本平均每笔 ${money(all)}。`, source: "Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减" });
    }
  }
  return out;
}

function riskFindings(
  trades: readonly LedgerTrade[], report: ReviewPerformanceResult, counts: Map<string, number>, pnl: Map<string, number>,
): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const s = report.stats;
  const losses = trades.filter((t) => outcome(t) === "loss").map((t) => t.pnl).sort((a, b) => a - b);
  if (losses.length >= 5 && s.gross_loss > 0 && s.avg_loss !== null) {
    const top3 = -losses.slice(0, 3).reduce((a, b) => a + b, 0);
    const share = top3 / s.gross_loss;
    const worst = losses[0] ?? 0;
    // 亏损笔数少时"最大 3 笔占一半"是必然的(5 笔一样大的亏损,3 笔就占 60%):集中度至少要 10 笔亏损才看
    const concentrated = losses.length >= 10 && share >= 0.5;
    if (concentrated || worst <= s.avg_loss * 3) {
      const title = concentrated
        ? `几笔大亏吃掉了大半:最大 3 笔占总亏损 ${pyRound(share * 100, 0)}%`
        : `有一笔亏得太多:${money(worst)},是平均亏损的 ${pyRound(worst / s.avg_loss, 1)} 倍`;
      out.push({ id: "tail_loss", tone: "bad", title,
        text: `最大单笔亏损 ${money(worst)},平均亏损 ${money(s.avg_loss)};最大 3 笔占总亏损 ${pyRound(share * 100, 0)}%。止损要在开仓前定好、到了就走,别让一笔单子变成一周的利润。`,
        source: "Mark Minervini / William O'Neil · 小亏就走,绝不让亏损扩大" });
    }
  }
  const dd = report.drawdown;
  if (dd.max > 0 && trades.length >= 10) {
    out.push(dd.recovery_factor !== null && dd.recovery_factor >= 2
      ? { id: "drawdown", tone: "good", title: `最大回撤 ${money(dd.max)},净盈利是它的 ${dd.recovery_factor} 倍`,
        text: "收益能盖过回撤,曲线是往上走的。", source: "期货实盘大赛的综合排名 · 收益与回撤一起看" }
      : { id: "drawdown", tone: "warn", title: `最大回撤 ${money(dd.max)},比净盈利还大`,
        text: `净盈亏 ${money(s.net_pnl)},恢复因子 ${dd.recovery_factor ?? "—"}。赚的钱不够填一次回撤,仓位与止损要先管住回撤。`,
        source: "期货实盘大赛的综合排名 · 收益与回撤一起看" });
  }
  const worstDay = report.per_day.worst_day;
  const avgLosingDay = report.per_day.avg_losing_day;
  if (worstDay !== null && avgLosingDay !== null && report.per_day.days >= 5 && worstDay.pnl < 0
      && worstDay.pnl <= avgLosingDay * 3) {
    out.push({ id: "worst_day", tone: "warn", title: `${worstDay.date} 一天亏了 ${money(worstDay.pnl)}`,
      text: `是亏钱日平均(${money(avgLosingDay)})的 ${pyRound(worstDay.pnl / avgLosingDay, 1)} 倍。「设置 → 保护规则」里的日内亏损上限可以在亏到线时停掉当天的新单。`,
      source: "职业交易员与自营公司的日亏上限 · 坏日子不许变成灾难日" });
  }
  // 过度交易:单日笔数远多于平常的那些天,平均每笔是不是更差
  const dayCounts = [...counts.values()];
  const med = median(dayCounts) ?? 0;
  const busyCut = Math.max(4, med * 2);
  const busy = [...counts.entries()].filter(([, c]) => c >= busyCut).map(([d]) => d);
  if (busy.length >= 3) {
    const busyTrades = busy.reduce((acc, d) => acc + (counts.get(d) ?? 0), 0);
    const busyPnl = busy.reduce((acc, d) => acc + (pnl.get(d) ?? 0), 0);
    const perBusy = busyPnl / busyTrades;
    const otherTrades = s.trades - busyTrades;
    const perOther = otherTrades ? (s.net_pnl - busyPnl) / otherTrades : null;
    if (perBusy < 0 && perOther !== null && perBusy < perOther) {
      out.push({ id: "overtrading", tone: "warn", title: `做得多的日子反而亏:${busy.length} 天单日 ≥ ${busyCut} 笔`,
        text: `那几天平均每笔 ${money(perBusy)},其余日子 ${money(perOther)}。一天里出手越来越多,往往是在追回亏损。`,
        source: "Brett Steenbarger · 过度交易是情绪在下单" });
    }
  }
  return out;
}

function behaviourFindings(trades: readonly LedgerTrade[], report: ReviewPerformanceResult): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const { win_median_minutes: holdWin, loss_median_minutes: holdLoss } = report.hold;
  const known = (o: "win" | "loss"): number => trades.filter((t) => outcome(t) === o && t.hold_minutes !== null).length;
  if (holdWin !== null && holdLoss !== null && known("win") >= 5 && known("loss") >= 5) {
    if (holdLoss > holdWin * 1.5) {
      out.push({ id: "disposition", tone: "bad", title: "亏损单拿得比赚钱单久",
        text: `亏的单持有中位数 ${holdLoss} 分钟,赚的单 ${holdWin} 分钟。赚一点就跑、亏了死扛,正好把"截断亏损、让利润奔跑"做反了。`,
        source: "Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑" });
    } else if (holdWin >= holdLoss * 1.5) {
      out.push({ id: "disposition", tone: "good", title: "亏损单走得比赚钱单快",
        text: `赚的单持有中位数 ${holdWin} 分钟,亏的单 ${holdLoss} 分钟:该走的走得干脆。`,
        source: "Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑" });
    }
  }
  const { quick, rest } = revengeSplit(trades);
  if (quick.length >= 5 && rest.length >= 5) {
    const q = perfStats(quick);
    const r = perfStats(rest);
    if (q.expectancy !== null && r.expectancy !== null && q.expectancy < 0 && q.expectancy < r.expectancy) {
      out.push({ id: "revenge", tone: "bad", title: `亏完 ${REVENGE_MINUTES} 分钟内再开仓的 ${quick.length} 笔,平均每笔 ${money(q.expectancy)}`,
        text: `其余的平均每笔 ${money(r.expectancy)}。刚亏完的那半小时最容易想"马上赚回来"。「保护规则」里的止损护栏与同标的冷却就是为这个设的。`,
        source: "Mark Douglas / Brett Steenbarger · 报复性交易" });
    }
  }
  const size = sizeAfterLoss(trades);
  const lossRate = size.afterLoss ? size.upAfterLoss / size.afterLoss : 0;
  const winRate = size.afterWin ? size.upAfterWin / size.afterWin : 0;
  // 亏后放大的比例本身要够高,还要明显高于赢后(差 10 个百分点以上):两边差不多只是仓位本来就忽大忽小
  if (size.afterLoss >= 5 && lossRate >= 0.3 && lossRate - winRate >= 0.1) {
    out.push({ id: "size_after_loss", tone: "bad",
      title: `亏损之后加码:${size.afterLoss} 次亏损后有 ${size.upAfterLoss} 次下一笔仓位放大到 1.5 倍以上`,
      text: `赢了之后放大的是 ${size.upAfterWin} / ${size.afterWin} 次。冠军的做法正相反:亏的时候缩,赚的时候才放。`,
      source: "Mark Minervini · 渐进式仓位;Paul Tudor Jones · 不向亏损加码" });
  }
  const sessions = report.groups.session
    .flatMap((g) => (g.trades >= MIN_GROUP && g.expectancy !== null && g.key !== "off" ? [{ g, e: g.expectancy }] : []));
  const first = sessions[0];
  if (first !== undefined && sessions.length >= 2) {
    const best = sessions.reduce((a, b) => (b.e > a.e ? b : a), first);
    const worst = sessions.reduce((a, b) => (b.e < a.e ? b : a), first);
    if (worst.e < 0 && best.e > 0) {
      out.push({ id: "session", tone: "info", title: `时段差异:${best.g.label}赚、${worst.g.label}亏`,
        text: `${best.g.label} ${best.g.trades} 笔平均每笔 ${money(best.e)};${worst.g.label} ${worst.g.trades} 笔平均每笔 ${money(worst.e)}。优势只在某些时段时,其余时段少做或不做。`,
        source: "Andrea Unger(四届 World Cup 期货冠军)· 用时间过滤器只做有优势的时段" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 保护规则建议

/** 取整到 10 美元,向上:线宁可松一点点,也不要比数据说的更紧。 */
function ceil10(v: number): number {
  return Math.ceil(v / 10) * 10;
}

/** 平掉一笔亏损之后 REVENGE_MINUTES 分钟内,**同一只标的**又开的仓 vs 其余。同标的冷却只管这一种。 */
export function sameSymbolReentry(trades: readonly LedgerTrade[]): { quick: LedgerTrade[]; rest: LedgerTrade[] } {
  const lossesBySymbol = new Map<string, number[]>();
  for (const t of trades) {
    if (outcome(t) !== "loss") continue;
    lossesBySymbol.set(t.symbol, [...(lossesBySymbol.get(t.symbol) ?? []), Date.parse(t.closed_at)]);
  }
  const quick: LedgerTrade[] = [];
  const rest: LedgerTrade[] = [];
  for (const t of trades) {
    if (t.opened_at === null) continue;
    const open = Date.parse(t.opened_at);
    const after = (lossesBySymbol.get(t.symbol) ?? []).some((c) => open >= c && open - c <= REVENGE_MINUTES * 60_000);
    (after ? quick : rest).push(t);
  }
  return { quick, rest };
}

/**
 * 按这本账给保护规则填什么(docs/features/protections.md「按体检建议填」)。**只建议**:不改设置,界面点「按建议填入」才发 settings.patch。
 * 每条都要数据撑得住才给,且只在那条规则关着、或开着但比建议松的时候给——已经比建议严的不劝人放松。
 * 回撤护栏不给:它和日亏上限切的是同一类坏日子,两条一起按数据填会互相打架,人自己挑一条更清楚。
 */
export function protectionAdvice(
  trades: readonly LedgerTrade[], report: ReviewPerformanceResult, current: ProtectionsConfig | null,
): ProtectionAdvice[] {
  const out: ProtectionAdvice[] = [];
  const avgLosingDay = report.per_day.avg_losing_day;
  const worstDay = report.per_day.worst_day;
  const pnlByDay = perDay(trades).pnl;
  const losingDays = [...pnlByDay.values()].filter((v) => v < 0);
  if (avgLosingDay !== null && worstDay !== null && losingDays.length >= 5) {
    const line = ceil10(Math.abs(avgLosingDay) * 2);
    const crossed = losingDays.filter((v) => v <= -line).length;
    const cur = current?.daily_loss;
    const looser = !cur || !cur.enabled || cur.max_loss_usd > line;
    if (crossed > 0 && looser) {
      out.push({
        rule: "daily_loss",
        suggested: { enabled: true, max_loss_usd: line },
        reason: `${losingDays.length} 个亏钱日平均 ${money(avgLosingDay)},最差一天 ${money(worstDay.pnl)}。线设在亏钱日平均的 2 倍(${money(-line)}),`
          + `历史上有 ${crossed} 天越过它——那几天到线就停,剩下的亏损就不会发生。`,
        source: "职业交易员与自营公司的日亏上限 · 坏日子不许变成灾难日",
      });
    }
  }
  const streak = report.stats.max_consecutive_losses;
  const { quick, rest } = revengeSplit(trades);
  const q = quick.length >= 5 && rest.length >= 5 ? perfStats(quick).expectancy : null;
  const r = quick.length >= 5 && rest.length >= 5 ? perfStats(rest).expectancy : null;
  const revenge = q !== null && r !== null && q < 0 && q < r;
  if ((streak >= 4 || revenge) && !current?.stoploss_guard.enabled) {
    const why = [
      streak >= 4 ? `最长连亏 ${streak} 笔` : "",
      revenge ? `亏完 ${REVENGE_MINUTES} 分钟内再开的 ${quick.length} 笔平均每笔 ${money(q ?? 0)}(其余 ${money(r ?? 0)})` : "",
    ].filter(Boolean).join(";");
    out.push({
      rule: "stoploss_guard",
      suggested: { enabled: true, lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 },
      reason: `${why}。两小时内止损 3 次就歇一小时,先把"马上赚回来"那一段挡掉。它只数持仓追踪发出的止损类平仓,手动平的不算。`,
      source: "Mark Douglas / Brett Steenbarger · 报复性交易;freqtrade Protections",
    });
  }
  const same = sameSymbolReentry(trades);
  if (same.quick.length >= 5 && same.rest.length >= 5) {
    const sq = perfStats(same.quick).expectancy;
    const sr = perfStats(same.rest).expectancy;
    const cur = current?.cooldown;
    if (sq !== null && sr !== null && sq < 0 && sq < sr && (!cur || !cur.enabled || cur.minutes < REVENGE_MINUTES)) {
      out.push({
        rule: "cooldown",
        suggested: { enabled: true, minutes: REVENGE_MINUTES },
        reason: `同一只标的亏完 ${REVENGE_MINUTES} 分钟内又开的 ${same.quick.length} 笔,平均每笔 ${money(sq)};其余 ${money(sr)}。刚亏过的标的冷却半小时再说。`,
        source: "Mark Douglas · 报复性交易;freqtrade Protections 的 CooldownPeriod",
      });
    }
  }
  return out;
}
