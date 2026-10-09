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
  DailyLossReplay, EquityPoint, LedgerTrade, PerfDays, PerfDrawdown, PerfGroup, PerfInterval, PerfRCoverage, PerfRStats, PerfStats,
  PerformanceFinding, PerformanceKind, PerformanceScope, ProtectionAdvice, ReviewPerformanceResult, RiskBasis, RMissingReason,
} from "./contract/performance.js";
import type { ProtectionsConfig } from "./contract/settings.js";
import { executionCost } from "./execQuality.js";
import type { CloseTrace } from "./execQuality.js";
import type { ImportedOptionTrade, OptionPosition } from "./importedTrades.js";
import {
  clusteredDiffInterval, clusteredMeanInterval, clusteredWilsonInterval, CONFIDENCE, mannWhitneyZ, proportionDiffInterval, Z95,
} from "./inference.js";
import type { Clustered, Interval } from "./inference.js";
import { pyRound } from "./py.js";
import { etIso } from "./tradeOutcomes.js";
import type { ButterflyRecord, SettleClose, StockTrip } from "./tradeOutcomes.js";
import { slotOf } from "./tradeSimilar.js";
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
/**
 * 开仓后多少分钟之内设的追踪止损才认作初始风险(股票 R 的分母)。
 * 追踪只能建在已有的持仓上,止损一定晚于成交;这段时间只留给"成交 → 打开持仓追踪 → 填好止损"。
 * 再晚设的止损已经看过行情:涨上去之后把止损挪到成本下面一点,分母就小得不像话,R 跟着虚高。
 */
export const INITIAL_STOP_MINUTES = 15;

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

/** 账本里 R 那四栏。`why` 是风险算不出(null)时的原因;算出来却不是正数的,记成成本不明。 */
function riskFields(
  pnl: number, risk: number | null, basis: RiskBasis, why: RMissingReason,
): Pick<LedgerTrade, "risk" | "r" | "risk_basis" | "r_missing"> {
  if (risk !== null && risk > 0) return { risk: pyRound(risk, 2), r: pyRound(pnl / risk, 2), risk_basis: basis, r_missing: null };
  return { risk: null, r: null, risk_basis: null, r_missing: risk === null ? why : "no_cost" };
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
      ...riskFields(pnl, risk, "max_loss", "undefined_risk"),
      exposure: pyRound((risk ?? debit * mult * qty), 2),
      hold_minutes: minutesBetween(openedAt, closedAt),
      paper: Boolean(record.account?.is_paper),
    });
  }
  return out;
}

/** 这段持仓的初始止损:同标的(有账户的痕还要同账户)、在持仓期间建的追踪里**最早**那条,而且要建在开仓后
 * INITIAL_STOP_MINUTES 分钟之内——再晚的记成 `late`,不当分母。
 * 止损要在保护一侧(做多低于进场均价、做空高于),否则不是止损,不算。
 * 要的是初始风险(Van Tharp 的 R):之后改过、上移过的止损不算,所以只看建追踪那一刻填的。 */
export function plannedStopFor(trip: LedgerStockTrip, stops: readonly PlannedStop[]): { stop: number | null; late: boolean } {
  const from = parseWhen(trip.created_at);
  const to = parseWhen(trip.closed_at);
  const entry = num(trip.avg_entry);
  if (from === null || to === null || entry === null) return { stop: null, late: false };
  const symbol = String(trip.symbol ?? "").toUpperCase();
  const alias = String(trip.account?.alias ?? "");
  const short = trip.side === "SHORT";
  let first: { at: number; stop: number } | null = null;
  for (const s of stops) {
    if (s.symbol !== symbol || (s.sec_type !== null && s.sec_type !== "STK")) continue;
    if (s.account !== null && alias && s.account !== alias) continue;
    const at = Date.parse(s.at);
    if (Number.isNaN(at) || at < from || at > to) continue;
    if (!(short ? s.stop > entry : s.stop < entry)) continue;
    if (first === null || at < first.at) first = { at, stop: s.stop };
  }
  if (first === null) return { stop: null, late: false };
  return first.at - from <= INITIAL_STOP_MINUTES * 60_000 ? { stop: first.stop, late: false } : { stop: null, late: true };
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
    // R 的分母 = |进场均价 − 初始止损| × 峰值股数。加过仓的按峰值算,偏保守(分母偏大、R 偏小)
    const planned = plannedStopFor(trip, stops);
    const sized = entry !== null && qty !== null && qty > 0;
    const risk = planned.stop !== null && sized ? Math.abs(entry - planned.stop) * qty : null;
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
      ...riskFields(pnl, risk, "stop", !sized ? "no_cost" : planned.late ? "late_stop" : "no_stop"),
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
      ...riskFields(pnl, risk, "max_loss", debit === null ? "no_cost" : "undefined_risk"),
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
      risk_basis: null,
      r_missing: "no_open",
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

/** 区间按给人看的精度取整。 */
function rounded(ci: Interval | null, digits: number, scale = 1): PerfInterval | null {
  return ci === null ? null : { lo: pyRound(ci.lo * scale, digits), hi: pyRound(ci.hi * scale, digits) };
}

/** 一笔交易算在哪一簇:美东了结日。同一天了结的几笔看的是同一段行情,不当成几次独立的试验(inference.ts 的 clustered 那几个)。 */
function dayOf(t: LedgerTrade): string {
  return etKey(Date.parse(t.closed_at), true);
}

/** 分了输赢的那些笔的盈亏,带上所在的那一天:期望值、它的区间、两组之间的比较都只用这些(持平的不算,同胜率)。 */
function decidedPnl(trades: readonly LedgerTrade[]): Clustered[] {
  return trades.filter((t) => outcome(t) !== "flat").map((t) => ({ value: t.pnl, cluster: dayOf(t) }));
}

/**
 * 一组交易的基本面。`trades` 要按了结时刻从早到晚排好(连胜连亏按这个次序数)。
 * 胜率、盈亏比、保本胜率、期望值是同一个分母(分了输赢的笔数):只有这样「期望值 = 胜率 × 平均盈利 − 败率 × |平均亏损|」
 * 与「胜率高于保本线 ⇔ 期望值为正」才是恒等式。
 */
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
      flats += 1; // 持平不打断连胜连亏,也不算进胜率与期望值
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
    win_rate_ci: rounded(clusteredWilsonInterval(
      trades.flatMap((t) => (outcome(t) === "flat" ? [] : [{ hit: outcome(t) === "win", cluster: dayOf(t) }]))), 1, 100),
    net_pnl: pyRound(net, 2),
    gross_profit: pyRound(grossProfit, 2),
    gross_loss: pyRound(grossLoss, 2),
    avg_win: avgWin === null ? null : pyRound(avgWin, 2),
    avg_loss: avgLoss === null ? null : pyRound(avgLoss, 2),
    payoff_ratio: payoff === null ? null : pyRound(payoff, 2),
    profit_factor: ratio(grossProfit, grossLoss),
    expectancy: decided ? pyRound((grossProfit - grossLoss) / decided, 2) : null,
    expectancy_ci: rounded(clusteredMeanInterval(decidedPnl(trades)), 2),
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

/**
 * Van Tharp 的 SQN 档位,每一档写的是它的下界:
 * 1.6 以下 差 · 1.6–1.9 低于平均 · 2.0–2.4 平均 · 2.5–2.9 好 · 3.0–5.0 优秀 · 5.1–6.9 极好 · 7.0 起 圣杯。
 */
export function sqnLabel(sqn: number | null): string {
  if (sqn === null) return "";
  if (sqn < 1.6) return "差";
  if (sqn < 2.0) return "低于平均";
  if (sqn < 2.5) return "平均";
  if (sqn < 3.0) return "好";
  if (sqn < 5.1) return "优秀";
  if (sqn < 7.0) return "极好";
  return "圣杯";
}

/** 凯利比例 f = W − (1 − W) / 盈亏比;W 是 0–1 的胜率。输赢不到 MIN_GROUP 笔不算。 */
function kellyFrom(decided: number, winRate: number | null, payoff: number | null): number | null {
  if (decided < MIN_GROUP || winRate === null || payoff === null || payoff <= 0) return null;
  return pyRound(winRate - (1 - winRate) / payoff, 3);
}

/**
 * R 倍数的统计:只数有 R、分了输赢的那些(持平的不算,同胜率)。SQN 的 N 封顶 100(Tharp 的口径:样本再大也不该把分数无限推高)。
 * 胜率、盈亏比、凯利在这里按 R 再算一遍:R 把仓位大小除掉了,几千块的股票单不会盖过几百块的蝶。
 */
export function rStats(trades: readonly LedgerTrade[]): PerfRStats {
  const rows = trades.flatMap((t) => (t.r !== null && outcome(t) !== "flat" ? [{ r: t.r, win: outcome(t) === "win", day: dayOf(t) }] : []));
  if (!rows.length) {
    return { trades: 0, expectancy_r: null, expectancy_ci: null, std_r: null, win_rate: null, payoff_ratio: null, kelly: null, sqn: null, sqn_label: "" };
  }
  const rs = rows.map((x) => x.r);
  const m = mean(rs);
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((acc, r) => acc + (r - m) ** 2, 0) / (rs.length - 1)) : null;
  const sqn = rs.length >= 10 && sd !== null && sd > 0 ? pyRound((Math.sqrt(Math.min(rs.length, 100)) * m) / sd, 2) : null;
  const wins = rows.filter((x) => x.win).map((x) => x.r);
  const losses = rows.filter((x) => !x.win).map((x) => x.r);
  const avgLoss = losses.length ? mean(losses) : null;
  const payoff = wins.length && avgLoss !== null && avgLoss < 0 ? mean(wins) / -avgLoss : null;
  const winRate = wins.length / rows.length;
  return {
    trades: rs.length,
    expectancy_r: pyRound(m, 2),
    expectancy_ci: rounded(clusteredMeanInterval(rows.map((x) => ({ value: x.r, cluster: x.day }))), 2),
    std_r: sd === null ? null : pyRound(sd, 2),
    win_rate: pyRound(winRate * 100, 1),
    payoff_ratio: payoff === null ? null : pyRound(payoff, 2),
    kelly: kellyFrom(rows.length, winRate, payoff),
    sqn,
    sqn_label: sqnLabel(sqn),
  };
}

const R_MISSING_ORDER: RMissingReason[] = ["no_stop", "late_stop", "undefined_risk", "no_open", "no_cost"];
const R_MISSING_LABEL: Record<RMissingReason, string> = {
  no_stop: `股票,开仓后 ${INITIAL_STOP_MINUTES} 分钟内没设止损`,
  late_stop: `股票,止损是开仓 ${INITIAL_STOP_MINUTES} 分钟之后才设的`,
  undefined_risk: "期权,风险不止权利金(贷方、比例蝶、日历、不对称的卖出蝶)",
  no_open: "导入的期权出场事件,没配上开仓",
  no_cost: "开仓价或数量不明",
};

/** R 盖住了多少、没盖住的为什么。R 的统计只代表有 R 的那一部分——这部分是自己选出来的,不是随机抽的。 */
export function rCoverage(trades: readonly LedgerTrade[]): PerfRCoverage {
  const count = (reason: RMissingReason): number => trades.filter((t) => t.r_missing === reason).length;
  return {
    trades: trades.length,
    with_r: trades.filter((t) => t.r !== null).length,
    flats: trades.filter((t) => t.r !== null && outcome(t) === "flat").length,
    max_loss: trades.filter((t) => t.r !== null && t.risk_basis === "max_loss").length,
    stop: trades.filter((t) => t.r !== null && t.risk_basis === "stop").length,
    stop_window_minutes: INITIAL_STOP_MINUTES,
    missing: R_MISSING_ORDER.flatMap((reason) => (count(reason) ? [{ reason, label: R_MISSING_LABEL[reason], trades: count(reason) }] : [])),
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

/** 每一档时段的稳定键。档怎么分只有一处:tradeSimilar.slotOf(下单页「历史相似交易」用的同一张表),这里不另起一套。 */
const SESSION_KEYS: Record<string, string> = {
  "开盘半小时": "open30", "上午": "morning", "午后": "afternoon", "尾盘一小时": "close60", "盘外": "off",
};
const SESSION_ORDER = ["open30", "morning", "afternoon", "close60", "off"];

/** 美东开仓时段。 */
export function sessionOf(iso: string | null): { key: string; label: string } | null {
  if (iso === null) return null;
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return null;
  const label = slotOf(when);
  return { key: SESSION_KEYS[label] ?? label, label };
}

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
    const r = rStats(b.rows);
    return {
      key, label: b.label, trades: s.trades, win_rate: s.win_rate, net_pnl: s.net_pnl,
      expectancy: s.expectancy, expectancy_ci: s.expectancy_ci, profit_factor: s.profit_factor,
      payoff_ratio: s.payoff_ratio, kelly: kellyOf(s),
      r_trades: r.trades, expectancy_r: r.expectancy_r, payoff_r: r.payoff_ratio, kelly_r: r.kelly, sqn: r.sqn,
    };
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

/** 按美元盈亏的凯利比例。品种混着时由单笔金额大的那一类主导;按 R 的那个在 rStats 里。 */
export function kellyOf(s: PerfStats): number | null {
  return kellyFrom(s.wins + s.losses, s.win_rate === null ? null : s.win_rate / 100, s.payoff_ratio);
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
  const { counts, pnl: _pnl, ...perDaySummary } = days;
  const paper = trades.filter((t) => t.paper).length;
  const report: ReviewPerformanceResult = {
    scope: opts.scope,
    kind: opts.kind,
    days: opts.days,
    stats,
    r_stats: rStats(trades),
    r_coverage: rCoverage(trades),
    mix: { live: trades.length - paper, paper },
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
  report.findings = findingsOf(trades, report, counts);
  report.protection_advice = protectionAdvice(trades, report, extras.protections ?? null);
  return report;
}

function ledgerNotes(trades: readonly LedgerTrade[]): string[] {
  const notes: string[] = [];
  const gross = trades.filter((t) => !t.net_of_commission).length;
  if (gross) notes.push(`${gross} 笔的成交回报里没有佣金,盈亏未扣佣金`);
  const noOpen = trades.filter((t) => t.opened_at === null).length;
  if (noOpen) notes.push(`${noOpen} 笔导入的期权出场事件没有配上开仓,不进时段、持有时长,也当不了行为规则里按开仓时刻考察的那一笔`);
  notes.push("券商成交里认得出的是股票与三腿蝴蝶;别的期权结构要靠 Flex 导入才进得了账本");
  return notes;
}

// ---------------------------------------------------------------- 规则

function money(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return v < 0 ? `-$${s}` : `$${s}`;
}

/**
 * a 组每笔是不是比 b 组差到噪声之外:两组平均每笔之差(a − b)的区间整个落在 0 以下。
 * 区间按天成簇(同一天了结的几笔不当成几次独立的试验);每天一笔时就是 Welch 区间。
 * 比两组的规则都过这一关——几笔对几笔,平均数差一截是常事,区间跨着 0 就不该开口。
 */
function clearlyWorse(a: readonly LedgerTrade[], b: readonly LedgerTrade[], level = CONFIDENCE): boolean {
  const ci = clusteredDiffInterval(decidedPnl(a), decidedPnl(b), level);
  return ci !== null && ci.hi < 0;
}

/** 亏完 REVENGE_MINUTES 分钟之内开的仓 vs 其余。只看开仓时刻已知的;一笔自己的了结不算它"之前的亏损"(开平同一刻的那种)。 */
export function revengeSplit(trades: readonly LedgerTrade[]): { quick: LedgerTrade[]; rest: LedgerTrade[] } {
  const losses = trades.filter((t) => outcome(t) === "loss").map((t) => ({ t, at: Date.parse(t.closed_at) }));
  const quick: LedgerTrade[] = [];
  const rest: LedgerTrade[] = [];
  for (const t of trades) {
    if (t.opened_at === null) continue;
    const open = Date.parse(t.opened_at);
    const after = losses.some((c) => c.t !== t && open >= c.at && open - c.at <= REVENGE_MINUTES * 60_000);
    (after ? quick : rest).push(t);
  }
  return { quick, rest };
}

/** 「亏完马上再进」那一组成立不成立:两边各 ≥ 5 笔,前者每笔为负,且比其余差到噪声之外。成立时给两边的每笔期望。 */
function reentryVerdict(split: { quick: LedgerTrade[]; rest: LedgerTrade[] }): { quick: number; rest: number } | null {
  if (split.quick.length < 5 || split.rest.length < 5) return null;
  const q = perfStats(split.quick).expectancy;
  const r = perfStats(split.rest).expectancy;
  return q !== null && r !== null && q < 0 && clearlyWorse(split.quick, split.rest) ? { quick: q, rest: r } : null;
}

/**
 * 一次了结之后开的**头一笔**:了结的是亏损时,这一笔的占用比**同品种**的中位数大 1.5 倍以上的有几次;了结的是盈利作对照。
 * "上一笔"按了结时刻认,不按开仓次序:按开仓次序排,前一笔可能还没平,那时并不知道它会亏,拿它的结果来比就是偷看了后来的事。
 * 一次了结只认它后面的头一笔:亏一笔之后接连开五只蝶,是一次亏损之后的事,不是五次——数成五次,一笔亏损就能凑够门槛。
 * 同一时刻了结的有好几笔时(几只蝶一起到期结算),看它们合起来是赚是亏:挑其中哪一笔当"上一笔"都是任意的。
 * 中位数按品种各算各的:股票的占用是几千上万的名义金额,蝶是几百的权利金,混在一个中位数里,股票笔笔都"放大"。
 */
export function sizeAfterLoss(trades: readonly LedgerTrade[]): { afterLoss: number; upAfterLoss: number; afterWin: number; upAfterWin: number } {
  const rows = trades
    .flatMap((t) => (t.exposure !== null && t.opened_at !== null ? [{ t, exposure: t.exposure, opened: Date.parse(t.opened_at) }] : []))
    .sort((a, b) => a.opened - b.opened);
  const medians = new Map<string, number>();
  for (const kind of new Set(rows.map((r) => r.t.kind))) {
    medians.set(kind, median(rows.filter((r) => r.t.kind === kind).map((r) => r.exposure)) ?? 0);
  }
  // 账本里所有的了结(没有开仓时刻、没有占用的也算:那一笔亏了,人是知道的),从早到晚
  const closes = trades.map((t) => ({ t, at: Date.parse(t.closed_at) })).sort((a, b) => a.at - b.at);
  const out = { afterLoss: 0, upAfterLoss: 0, afterWin: 0, upAfterWin: 0 };
  const answered = new Set<number>(); // 已经有"后面的头一笔"的了结时刻
  for (const cur of rows) {
    let lastAt: number | null = null;
    let net = 0;
    for (const c of closes) {
      if (c.at > cur.opened) break;
      if (c.t === cur.t) continue;
      if (c.at !== lastAt) { lastAt = c.at; net = 0; }
      net += c.t.pnl;
    }
    if (lastAt === null || answered.has(lastAt)) continue;
    answered.add(lastAt);
    const med = medians.get(cur.t.kind) ?? 0;
    const up = med > 0 && cur.exposure > med * 1.5;
    if (net <= -FLAT_USD) { out.afterLoss += 1; if (up) out.upAfterLoss += 1; }
    if (net >= FLAT_USD) { out.afterWin += 1; if (up) out.upAfterWin += 1; }
  }
  return out;
}

/**
 * 规则挑毛病。每条都写明借鉴自谁;阈值写死,样本不够就不说,两组之间的差别没出噪声也不说。先说最要紧的(期望值),再说行为。
 * 只描述已经发生的事与一条可以对照的规矩,不给仓位、不给买卖建议。
 */
export function findingsOf(
  trades: readonly LedgerTrade[], report: ReviewPerformanceResult, counts: Map<string, number>,
): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const s = report.stats;
  if (!s.trades) return out;
  if (s.trades < MIN_SAMPLE) {
    out.push({ id: "sample", tone: "info", title: `样本只有 ${s.trades} 笔`,
      text: `不到 ${MIN_SAMPLE} 笔时,胜率与期望值会被一两笔大单左右,下面的结论只当提示。`,
      source: "Kevin Davey(World Cup 期货冠军)· 样本够多才谈得上优势" });
  }
  out.push(...edgeFindings(trades, report));
  out.push(...riskFindings(trades, report, counts));
  out.push(...behaviourFindings(trades, report));
  return out;
}

const EXPECTANCY_SOURCE = "Van Tharp · 期望值 = 胜率 × 平均盈利 − 败率 × 平均亏损";

/** 区间定不出来时的那句话:几笔都在同一天了结,同一天的几笔不是几次独立的试验。 */
const ONE_DAY = "这些交易都在同一天了结,一天的行情定不出区间";

/** 期望值那一条:区间整个在 0 的一边才说正或负,跨着 0(或定不出区间)就说还没分清。品种混着时写明这是按美元算的。 */
function expectancyFinding(report: ReviewPerformanceResult): PerformanceFinding | null {
  const s = report.stats;
  const ci = s.expectancy_ci;
  if (s.expectancy === null || s.wins + s.losses < 5) return null;
  const range = ci === null ? "" : `95% 区间 ${money(ci.lo)} ~ ${money(ci.hi)}。`;
  const kinds = report.groups.kind.map((g) => g.label);
  const tail = (s.win_rate !== null && s.payoff_ratio !== null
    ? `胜率 ${s.win_rate}%、盈亏比 ${s.payoff_ratio},按这个盈亏比胜率至少要 ${s.breakeven_win_rate}% 才不亏。` : "")
    + (kinds.length > 1 ? `这是按美元算的:${kinds.join("、")}混着时,单笔金额大的那一类说了算,分开的数在「品种」表。` : "");
  if (ci !== null && ci.lo > 0) {
    return { id: "expectancy", tone: "good", title: `期望值为正:平均每笔 ${money(s.expectancy)}`,
      text: `${range}${tail}利润因子 ${s.profit_factor ?? "—"}。`, source: EXPECTANCY_SOURCE };
  }
  if (ci !== null && ci.hi < 0) {
    return { id: "expectancy", tone: "bad", title: `期望值为负:平均每笔 ${money(s.expectancy)}`,
      text: `${range}${tail}在期望值转正之前,多做只会多亏。`, source: EXPECTANCY_SOURCE };
  }
  const why = ci === null ? ONE_DAY : "区间跨着 0";
  return { id: "expectancy", tone: "info", title: `平均每笔 ${money(s.expectancy)},正负还没分清`,
    text: `${range}${why}:照这 ${s.wins + s.losses} 笔,说它赚钱还是亏钱都早。${tail}`, source: EXPECTANCY_SOURCE };
}

/** 凯利那一条:有 R 用按 R 的(它才对得上"单笔冒多大的险"),没有才用按美元的;期望值的正负没分清时不给人拿去用。 */
function kellyFinding(report: ReviewPerformanceResult): PerformanceFinding | null {
  const byR = report.r_stats.kelly !== null;
  const kelly = report.r_stats.kelly ?? report.kelly;
  const ci = byR ? report.r_stats.expectancy_ci : report.stats.expectancy_ci;
  if (kelly === null) return null;
  const basis = byR
    ? `按 ${report.r_stats.trades} 笔有 R 的交易算`
    : `按美元盈亏算${report.groups.kind.length > 1 ? "(品种混着时,单笔金额大的那一类说了算)" : ""}`;
  if (ci !== null && ci.hi < 0) {
    return { id: "kelly", tone: "warn", title: "按统计没有下注优势(凯利比例 ≤ 0)",
      text: `${basis}。照现在的胜率与盈亏比,凯利公式给的是不下注。没有优势时,单笔风险应该压到最小,先把期望值做正。`,
      source: "Larry Williams(1987 World Cup 冠军)· 资金管理决定能不能活下来" };
  }
  const pct = pyRound(kelly * 100, 1);
  if (ci === null || ci.lo <= 0) {
    const unsure = ci === null ? ONE_DAY : "期望值的 95% 区间跨着 0";
    return { id: "kelly", tone: "info", title: `凯利比例 ${pct}%,现在还不能当真`,
      text: `${basis}。${unsure},有没有优势还没分清;凯利公式把眼下的胜率与盈亏比当成确定的,`
        + (kelly > 0 ? "这点样本撑不起它给的这个数。" : "眼下的数看不出优势,也还说不上一定没有。"),
      source: "Larry Williams · 凯利 / optimal f 只当上限参照" };
  }
  return { id: "kelly", tone: "info", title: `凯利比例 ${pct}%`,
    text: `${basis}。这是理论上让长期增长最快的单笔风险(平均亏一笔亏掉账户的百分之几),波动极大。1/4 凯利约 ${pyRound(kelly * 25, 1)}%;冠军们实际的单笔风险多在账户的 0.5%–2%。`,
    source: "Larry Williams · 凯利 / optimal f 只当上限参照" };
}

function edgeFindings(trades: readonly LedgerTrade[], report: ReviewPerformanceResult): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const s = report.stats;
  const expectancy = expectancyFinding(report);
  if (expectancy !== null) out.push(expectancy);
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
    const cov = report.r_coverage;
    const part = (cov.with_r < cov.trades ? `有 R 的只是 ${cov.trades} 笔里的 ${cov.with_r} 笔。` : "")
      + (cov.flats ? `其中 ${cov.flats} 笔持平,不进统计。` : "");
    const mixed = cov.max_loss && cov.stop
      ? `其中 ${cov.max_loss} 笔的 R 按最大可亏、${cov.stop} 笔按初始止损,两种分母混着,分品种的在「品种」表。` : "";
    out.push({ id: "sqn", tone: r.sqn >= 2.5 ? "good" : r.sqn >= 1.6 ? "info" : "warn",
      title: `SQN ${r.sqn}(${r.sqn_label})`,
      text: `${r.trades} 笔有 R、分了输赢的交易,平均每笔 ${r.expectancy_r}R,标准差 ${r.std_r}R。${part}${mixed}SQN 量的是期望值相对波动有多稳;1.6 以下时,这点期望值和运气还分不开。`,
      source: "Van Tharp · R 倍数与系统质量分 SQN" });
  }
  const kelly = kellyFinding(report);
  if (kelly !== null) out.push(kelly);
  if (report.recent !== null && report.stats.expectancy !== null && report.recent.stats.expectancy !== null) {
    const rec = report.recent.stats.expectancy;
    const all = report.stats.expectancy;
    // 最近几笔和它之前的比(两组不重叠);差别没出噪声就不说"在走弱 / 在变好"
    const latest = trades.slice(-report.recent.window);
    const earlier = trades.slice(0, -report.recent.window);
    const before = `之前的 ${earlier.length} 笔平均每笔 ${money(perfStats(earlier).expectancy ?? 0)},全部样本 ${money(all)}。`;
    if (rec < 0 && all > 0 && clearlyWorse(latest, earlier)) {
      out.push({ id: "recent", tone: "warn", title: `最近 ${report.recent.window} 笔在走弱:平均每笔 ${money(rec)}`,
        text: `${before}手感变差的时候先缩小仓位,等重新赚起来再一步步放回去。`,
        source: "Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减" });
    } else if (rec > all && rec > 0 && clearlyWorse(earlier, latest)) {
      out.push({ id: "recent", tone: "good", title: `最近 ${report.recent.window} 笔好于平均:每笔 ${money(rec)}`,
        text: before, source: "Mark Minervini · 渐进式仓位:赚钱时加、亏钱时减" });
    }
  }
  return out;
}

function riskFindings(trades: readonly LedgerTrade[], report: ReviewPerformanceResult, counts: Map<string, number>): PerformanceFinding[] {
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
  const med = median([...counts.values()]) ?? 0;
  const busyCut = Math.max(4, med * 2);
  const busyDays = new Set([...counts.entries()].filter(([, c]) => c >= busyCut).map(([d]) => d));
  if (busyDays.size >= 3) {
    const onBusy = (t: LedgerTrade): boolean => busyDays.has(etKey(Date.parse(t.closed_at), true));
    const busy = trades.filter(onBusy);
    const other = trades.filter((t) => !onBusy(t));
    const perBusy = perfStats(busy).expectancy;
    const perOther = perfStats(other).expectancy;
    if (perBusy !== null && perOther !== null && perBusy < 0 && clearlyWorse(busy, other)) {
      out.push({ id: "overtrading", tone: "warn", title: `做得多的日子反而亏:${busyDays.size} 天单日 ≥ ${busyCut} 笔`,
        text: `那几天平均每笔 ${money(perBusy)},其余日子 ${money(perOther)}。一天里出手越来越多,往往是在追回亏损。`,
        source: "Brett Steenbarger · 过度交易是情绪在下单" });
    }
  }
  return out;
}

/** 时段那一条:各 ≥ MIN_GROUP 笔的时段里,最好的赚、最差的亏,而且两者的差别出了噪声。 */
function sessionFinding(trades: readonly LedgerTrade[], report: ReviewPerformanceResult): PerformanceFinding | null {
  const rowsOf = (key: string): LedgerTrade[] => trades.filter((t) => sessionOf(t.opened_at)?.key === key);
  const sessions = report.groups.session
    .flatMap((g) => (g.trades >= MIN_GROUP && g.expectancy !== null && g.key !== "off" ? [{ g, e: g.expectancy }] : []));
  const first = sessions[0];
  if (first === undefined || sessions.length < 2) return null;
  const best = sessions.reduce((a, b) => (b.e > a.e ? b : a), first);
  const worst = sessions.reduce((a, b) => (b.e < a.e ? b : a), first);
  // 从 k 个时段里挑最好与最差来比,等于把 k(k−1)/2 对都比了一遍:置信水平按对数收紧(Bonferroni),不然挑出来的那一对总"显著"
  const pairs = (sessions.length * (sessions.length - 1)) / 2;
  if (!(worst.e < 0 && best.e > 0) || !clearlyWorse(rowsOf(worst.g.key), rowsOf(best.g.key), 1 - (1 - CONFIDENCE) / pairs)) return null;
  return { id: "session", tone: "info", title: `时段差异:${best.g.label}赚、${worst.g.label}亏`,
    text: `${best.g.label} ${best.g.trades} 笔平均每笔 ${money(best.e)};${worst.g.label} ${worst.g.trades} 笔平均每笔 ${money(worst.e)}。优势只在某些时段时,其余时段少做或不做。`,
    source: "Andrea Unger(四届 World Cup 期货冠军)· 用时间过滤器只做有优势的时段" };
}

function behaviourFindings(trades: readonly LedgerTrade[], report: ReviewPerformanceResult): PerformanceFinding[] {
  const out: PerformanceFinding[] = [];
  const { win_median_minutes: holdWin, loss_median_minutes: holdLoss } = report.hold;
  const holds = (o: "win" | "loss"): Array<{ day: string; hold: number }> =>
    trades.flatMap((t) => (outcome(t) === o && t.hold_minutes !== null ? [{ day: dayOf(t), hold: t.hold_minutes }] : []));
  /** 每天一个数(当天这一类的中位数):同一天的几笔常常一起拿到收盘,不当成几次独立的观测。 */
  const perDayMedian = (rows: Array<{ day: string; hold: number }>): number[] =>
    [...new Set(rows.map((r) => r.day))].map((day) => median(rows.filter((r) => r.day === day).map((r) => r.hold)) ?? 0);
  const winHolds = holds("win");
  const lossHolds = holds("loss");
  if (holdWin !== null && holdLoss !== null && winHolds.length >= 5 && lossHolds.length >= 5) {
    // 时长一头很长,比的是秩不是平均数;正 = 亏的那组拿得久。|z| 不到 Z95 的,中位数差 1.5 倍也可能只是这几笔凑巧
    const z = mannWhitneyZ(perDayMedian(lossHolds), perDayMedian(winHolds)) ?? 0;
    if (holdLoss > holdWin * 1.5 && z >= Z95) {
      out.push({ id: "disposition", tone: "bad", title: "亏损单拿得比赚钱单久",
        text: `亏的单持有中位数 ${holdLoss} 分钟,赚的单 ${holdWin} 分钟。赚一点就跑、亏了死扛,正好把"截断亏损、让利润奔跑"做反了。`,
        source: "Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑" });
    } else if (holdWin >= holdLoss * 1.5 && z <= -Z95) {
      out.push({ id: "disposition", tone: "good", title: "亏损单走得比赚钱单快",
        text: `赚的单持有中位数 ${holdWin} 分钟,亏的单 ${holdLoss} 分钟:该走的走得干脆。`,
        source: "Jesse Livermore / William O'Neil · 截断亏损,让利润奔跑" });
    }
  }
  const revenge = revengeSplit(trades);
  const verdict = reentryVerdict(revenge);
  if (verdict !== null) {
    out.push({ id: "revenge", tone: "bad", title: `亏完 ${REVENGE_MINUTES} 分钟内再开仓的 ${revenge.quick.length} 笔,平均每笔 ${money(verdict.quick)}`,
      text: `其余的平均每笔 ${money(verdict.rest)}。刚亏完的那半小时最容易想"马上赚回来"。「保护规则」里的止损护栏与同标的冷却就是为这个设的。`,
      source: "Mark Douglas / Brett Steenbarger · 报复性交易" });
  }
  const size = sizeAfterLoss(trades);
  const lossRate = size.afterLoss ? size.upAfterLoss / size.afterLoss : 0;
  const winRate = size.afterWin ? size.upAfterWin / size.afterWin : 0;
  // 亏后放大的比例本身要够高,还要明显高于赢后(差 10 个百分点以上,且两个比例之差的区间不跨 0):两边差不多只是仓位本来就忽大忽小。
  // 对照的那一边也要有 5 次(和亏后那边同一个门槛):赢后只有一两次时,"比它高"说明不了什么
  const gap = proportionDiffInterval(size.upAfterLoss, size.afterLoss, size.upAfterWin, size.afterWin);
  if (size.afterLoss >= 5 && size.afterWin >= 5 && lossRate >= 0.3 && lossRate - winRate >= 0.1 && gap !== null && gap.lo > 0) {
    out.push({ id: "size_after_loss", tone: "bad",
      title: `亏损之后加码:${size.afterLoss} 次亏损后有 ${size.upAfterLoss} 次下一笔仓位放大到 1.5 倍以上`,
      text: `赢了之后放大的是 ${size.upAfterWin} / ${size.afterWin} 次。冠军的做法正相反:亏的时候缩,赚的时候才放。`,
      source: "Mark Minervini · 渐进式仓位;Paul Tudor Jones · 不向亏损加码" });
  }
  const session = sessionFinding(trades, report);
  if (session !== null) out.push(session);
  return out;
}

// ---------------------------------------------------------------- 保护规则建议

/** 取整到 10 美元,向上:线宁可松一点点,也不要比数据说的更紧。 */
function ceil10(v: number): number {
  return Math.ceil(v / 10) * 10;
}

/** 平掉一笔亏损之后 REVENGE_MINUTES 分钟内,**同一只标的**又开的仓 vs 其余。同标的冷却只管这一种。 */
export function sameSymbolReentry(trades: readonly LedgerTrade[]): { quick: LedgerTrade[]; rest: LedgerTrade[] } {
  const lossesBySymbol = new Map<string, Array<{ t: LedgerTrade; at: number }>>();
  for (const t of trades) {
    if (outcome(t) !== "loss") continue;
    lossesBySymbol.set(t.symbol, [...(lossesBySymbol.get(t.symbol) ?? []), { t, at: Date.parse(t.closed_at) }]);
  }
  const quick: LedgerTrade[] = [];
  const rest: LedgerTrade[] = [];
  for (const t of trades) {
    if (t.opened_at === null) continue;
    const open = Date.parse(t.opened_at);
    const after = (lossesBySymbol.get(t.symbol) ?? []).some((c) => c.t !== t && open >= c.at && open - c.at <= REVENGE_MINUTES * 60_000);
    (after ? quick : rest).push(t);
  }
  return { quick, rest };
}

/**
 * 把日亏上限放回这本账上走一遍,判法和真规则(protections.ts)一样:每笔开仓的那一刻,数美东当天到这一刻为止已实现的净额,
 * 净亏到线,这一笔就算被拦下——它后来是赚是亏都从账上拿掉,所以拦掉的盈利也算在里面。
 * 不预知之后的事:到线之前已经开着的仓照常走完;被拦下的那些笔不再计入当天的已实现盈亏。
 */
export function dailyLossReplay(trades: readonly LedgerTrade[], line: number): DailyLossReplay {
  const dayOf = (ms: number): string => etKey(ms, true);
  const closes = trades.map((t) => ({ t, at: Date.parse(t.closed_at) })).sort((a, b) => a.at - b.at);
  const closesByDay = new Map<string, typeof closes>();
  for (const c of closes) closesByDay.set(dayOf(c.at), [...(closesByDay.get(dayOf(c.at)) ?? []), c]);
  // 按开仓时刻从早到晚定夺:一笔拦不拦只取决于它开仓之前了结的那些,而那些更早开仓,已经定过了
  const opens = trades
    .flatMap((t) => (t.opened_at === null ? [] : [{ t, at: Date.parse(t.opened_at) }]))
    .sort((a, b) => a.at - b.at || Date.parse(a.t.closed_at) - Date.parse(b.t.closed_at));
  const skipped = new Set<LedgerTrade>();
  for (const o of opens) {
    let realized = 0;
    for (const c of closesByDay.get(dayOf(o.at)) ?? []) {
      if (c.at > o.at) break;
      if (c.t !== o.t && !skipped.has(c.t)) realized += c.t.pnl;
    }
    if (-realized >= line) skipped.add(o.t);
  }
  let daysHit = 0;
  let unknownOpen = 0;
  for (const dayCloses of closesByDay.values()) {
    let realized = 0;
    let hit = false;
    for (const c of dayCloses) {
      if (skipped.has(c.t)) continue;
      if (hit && c.t.opened_at === null) unknownOpen += 1;
      realized += c.t.pnl;
      if (-realized >= line) hit = true;
    }
    if (hit) daysHit += 1;
  }
  const gone = [...skipped];
  return {
    days_hit: daysHit,
    skipped: gone.length,
    skipped_wins: gone.filter((t) => outcome(t) === "win").length,
    skipped_losses: gone.filter((t) => outcome(t) === "loss").length,
    skipped_pnl: pyRound(gone.reduce((acc, t) => acc + t.pnl, 0), 2),
    unknown_open: unknownOpen,
  };
}

/** 日亏上限那条建议的说明:线是怎么来的、放回这本账上拦到了什么。只说回放出来的数,不说"亏损就不会发生"。 */
function dailyLossReason(losingDays: number, avgLosingDay: number, worst: number, line: number, replay: DailyLossReplay): string {
  const effect = replay.skipped
    ? `到线之后当天又开的 ${replay.skipped} 笔(赚 ${replay.skipped_wins}、亏 ${replay.skipped_losses})合计 ${money(replay.skipped_pnl)},`
      + (replay.skipped_pnl < 0 ? `拦下它们少亏 ${money(-replay.skipped_pnl)}`
        : replay.skipped_pnl > 0 ? `拦下它们反而少赚 ${money(replay.skipped_pnl)}` : "拦不拦一样")
    : "到线之后当天没有再开过新仓,这条线在这本账上一笔也没拦到";
  return `${losingDays} 个亏钱日平均 ${money(avgLosingDay)},最差一天 ${money(worst)}。线取亏钱日平均的 2 倍(${money(-line)})。`
    + `放回这本账上走一遍:${replay.days_hit} 天净亏碰到过线,${effect}。到线之前已经开着的仓照常走完,它们的亏损这条线管不着`
    + (replay.unknown_open ? `;另有 ${replay.unknown_open} 笔开仓时刻不明,判断不了` : "")
    + "。线是拿这同一段历史定的,往后未必还合适;回放按整本账算,真规则只数经本软件发出的单。";
}

/** 止损护栏建议的那组参数(与 protections 的默认值同一组经验值,没有拿数据估过)。 */
const GUARD_ADVICE = { lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 } as const;

/**
 * 账本上"lookbackMinutes 分钟之内了结了 count 笔亏损"会让护栏暂停几回。窗口与暂停同真规则:窗口左开右闭,
 * 凑够了就从最后那笔起停 pauseMinutes 分钟;还在暂停里又来一笔只是把暂停往后延,过了暂停再凑够才算新的一回。
 * 给止损护栏的建议当旁证:这组参数放在这本账上到底会不会动。只是旁证——真规则数的是持仓追踪触发的止损与利润回撤平仓(不看赚亏),
 * 账本里没有平仓原因,这里数的是亏损了结,两边不是同一样东西。
 */
export function lossBursts(trades: readonly LedgerTrade[], lookbackMinutes: number, count: number, pauseMinutes: number): number {
  const at = trades.filter((t) => outcome(t) === "loss").map((t) => Date.parse(t.closed_at)).sort((a, b) => a - b);
  let bursts = 0;
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let lo = 0;
  at.forEach((now, hi) => {
    while ((at[lo] ?? now) <= now - lookbackMinutes * 60_000) lo += 1;
    if (hi - lo + 1 < count) return;
    if (now >= pausedUntil) bursts += 1;
    pausedUntil = now + pauseMinutes * 60_000;
  });
  return bursts;
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
      const replay = dailyLossReplay(trades, line);
      out.push({
        rule: "daily_loss",
        suggested: { enabled: true, max_loss_usd: line },
        replay,
        reason: dailyLossReason(losingDays.length, avgLosingDay, worstDay.pnl, line, replay),
        source: "职业交易员与自营公司的日亏上限 · 坏日子不许变成灾难日",
      });
    }
  }
  const streak = report.stats.max_consecutive_losses;
  const split = revengeSplit(trades);
  const revenge = reentryVerdict(split);
  if ((streak >= 4 || revenge !== null) && !current?.stoploss_guard.enabled) {
    const why = [
      streak >= 4 ? `最长连亏 ${streak} 笔` : "",
      revenge !== null ? `亏完 ${REVENGE_MINUTES} 分钟内再开的 ${split.quick.length} 笔平均每笔 ${money(revenge.quick)}(其余 ${money(revenge.rest)})` : "",
    ].filter(Boolean).join(";");
    const bursts = lossBursts(trades, GUARD_ADVICE.lookback_minutes, GUARD_ADVICE.trigger_count, GUARD_ADVICE.pause_minutes);
    out.push({
      rule: "stoploss_guard",
      suggested: { enabled: true, ...GUARD_ADVICE },
      reason: `${why}。两小时内止损 3 次就歇一小时,先把"马上赚回来"那一段挡掉。`
        + `这本账上,两小时内接连了结 3 笔亏损、够它停一次的情形出现过 ${bursts} 回${bursts ? "" : ":按亏损了结来数,这组参数一次也凑不够"}。`
        + "它只数持仓追踪到价触发的止损类平仓;追踪上点的「立即平仓」、在 TWS 里直接下的单、指令框里手敲的平仓都不算。",
      source: "Mark Douglas / Brett Steenbarger · 报复性交易;freqtrade Protections",
    });
  }
  const same = sameSymbolReentry(trades);
  const sameVerdict = reentryVerdict(same);
  const cool = current?.cooldown;
  if (sameVerdict !== null && (!cool || !cool.enabled || cool.minutes < REVENGE_MINUTES)) {
    out.push({
      rule: "cooldown",
      suggested: { enabled: true, minutes: REVENGE_MINUTES },
      reason: `同一只标的亏完 ${REVENGE_MINUTES} 分钟内又开的 ${same.quick.length} 笔,平均每笔 ${money(sameVerdict.quick)};其余 ${money(sameVerdict.rest)}。刚亏过的标的冷却半小时再说。`,
      source: "Mark Douglas · 报复性交易;freqtrade Protections 的 CooldownPeriod",
    });
  }
  return out;
}
