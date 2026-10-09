/** 持仓追踪的几条出场规则(纯函数):到点平仓、分批止盈、止损类的追价节奏、标的止损价的确认。
 *
 * 从 tracker.ts 分出来(那个文件贴着体积预算),和 trackerDrawdown / trackerSpotStop 同一层:只认 Targets、AutoClose
 * 和几个数,不认识持仓、券商、引擎。这里**没有一个经验参数**:钟点、档位、秒数、让几跳都是用户填的;
 * 没填的一律回到加这些规则之前的行为。口径见 docs/features/tracker.md。
 */
import type { AutoClose, SpotStop, TakeProfitTier, Targets } from "./contract/tracker.js";
import { finiteOrNull, fmtF, pyG } from "./py.js";
import { ET, wallParts, wallToEpoch } from "./tz.js";

/** 到点平仓。保护规则的止损护栏不数它(和人点的「立即平仓」一样:到点走不是"今天不顺"),同一标的冷却照常。 */
export const STATE_TIME_EXIT = "time_exit";

// ---------------------------------------------------------------- 到点平仓
/** "HH:MM" → 当天的第几分钟;写得不对回 null。 */
export function clockMinutes(hhmm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (m === null) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/**
 * 下一次到美东这个钟点的时刻(毫秒)。此刻正好是这个钟点或已经过了,就是明天的;夏令时由 tz 换算。
 *
 * 存时刻而不是每轮比"现在几点":SPX 期权有 20:15–次日 09:25 的夜盘,21:00 设一个"03:00 走",
 * 按钟点比会因为 21:00 晚于 03:00 当场触发。
 */
export function nextOccurrenceMs(hhmm: unknown, nowMs: number): number | null {
  const minutes = clockMinutes(hhmm);
  if (minutes === null || !Number.isFinite(nowMs)) return null;
  const now = wallParts(nowMs, ET);
  for (const offset of [0, 1]) {
    const day = new Date(Date.UTC(now.year, now.month - 1, now.day + offset));
    const at = wallToEpoch({
      year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(),
      hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0,
    }, ET);
    if (at > nowMs) return at;
  }
  return null;
}

const etDay = (ms: number): string => {
  const w = wallParts(ms, ET);
  return `${w.year}-${w.month}-${w.day}`;
};

/**
 * 到点了没有。没设回 false。**只在到点的那个美东日历日里算数**:那一天过完还没平掉(软件没开着、休市、被闸门挡着),
 * 这一次就作废(timeExitLapsed)——周五收盘后设的 15:45 落在周六,不能拖到周日晚上夜盘一开就平;
 * 手动熔断挂了一夜,第二天解开也不该把昨天那一次补发出去。
 */
export function timeExitDue(targets: Targets, nowMs: number): boolean {
  const at = finiteOrNull(targets.exit_at_ms);
  return at !== null && nowMs >= at && etDay(nowMs) === etDay(at);
}

/** 过了点、而且已经不是到点的那一天:这一次作废。 */
export function timeExitLapsed(targets: Targets, nowMs: number): boolean {
  const at = finiteOrNull(targets.exit_at_ms);
  return at !== null && nowMs >= at && etDay(nowMs) !== etDay(at);
}

/**
 * 把"到点了"并进这一轮的结论:只在这一轮没有别的触发时生效——止损、利润回撤、止盈都比它具体,同一轮里听它们的。
 * 持仓这一轮拿不到现价也算:到点就是到点,平仓那一步自己取各腿买卖价(和标的止损价同一条规矩)。
 */
export function withTimeExit<T extends { state: string; reason: string }>(
  result: T, targets: Targets, nowMs: number, holding = "holding",
): T {
  if (result.state !== holding || !timeExitDue(targets, nowMs)) return result;
  return { ...result, state: STATE_TIME_EXIT, reason: `到点平仓:已到美东 ${String(targets.exit_at ?? "")}` };
}

// ---------------------------------------------------------------- 分批止盈
/** 最多几档。再多就不是分批止盈,是网格——那是另一件事。 */
export const MAX_TP_TIERS = 4;

/** 分批止盈不能和托管到券商一起用。 */
export const TIERS_HOSTED_ISSUE =
  "分批止盈只支持软件盯盘:托管到券商的单是一组 OCA,一张成交券商就撤掉其余的,分不了批。关掉托管,或改用一个止盈价。";

const tierOpen = (t: TakeProfitTier): boolean => !t.done && !t.pending;

/** 设置时的校验:说得通回 null,说不通回一句人话。price 是持仓现价(拿不到给 null,那时不核对方向)。 */
export function tiersIssue(
  tiers: readonly TakeProfitTier[] | null | undefined, long: boolean, price: number | null,
): string | null {
  const list = tiers ?? [];
  if (!list.length) return null;
  if (list.length > MAX_TP_TIERS) return `分批止盈最多 ${MAX_TP_TIERS} 档。`;
  let prev: number | null = null;
  for (const [i, tier] of list.entries()) {
    const p = finiteOrNull(tier.price), f = finiteOrNull(tier.fraction_pct);
    if (p === null || !(p > 0)) return `分批止盈第 ${i + 1} 档的价要是正数。`;
    if (f === null || !(f > 0 && f <= 100)) return `分批止盈第 ${i + 1} 档的比例要在 0(不含)到 100 之间。`;
    if (prev !== null && (long ? p <= prev : p >= prev)) {
      return `分批止盈各档的价要一档比一档${long ? "高" : "低"}(第 ${i + 1} 档 ${pyG(p)} 不在第 ${i} 档 ${pyG(prev)} 的更有利一侧)。`;
    }
    prev = p;
  }
  // 方向只核对还没做的头一档:做完的档本来就在现价的另一侧
  const open = list.findIndex((t) => !t.done);
  const now = finiteOrNull(price), first = finiteOrNull(list[open]?.price ?? null);
  if (open >= 0 && now !== null && first !== null && (long ? first <= now : first >= now)) {
    return `分批止盈第 ${open + 1} 档要${long ? "高" : "低"}于现价(现价 ${fmtF(now, 4)},你填了 ${pyG(first)})——填在${long ? "下" : "上"}方会立刻触发。`;
  }
  return null;
}

/** 这一轮该触发哪一档:还没做、也没在等成交的档里,到了价的最靠前那一档;没有回 -1。
 * 有一档的平仓单还没确认成交时不触发下一档:两张平仓单同时挂着,数量各按"此刻持仓"算,加起来会超。 */
export function dueTier(
  tiers: readonly TakeProfitTier[] | null | undefined, long: boolean, price: number | null,
): number {
  const list = tiers ?? [];
  const p = finiteOrNull(price);
  if (p === null || list.some((t) => t.pending)) return -1;
  return list.findIndex((t) => tierOpen(t) && (long ? p >= t.price : p <= t.price));
}

/**
 * 改目标时把各档已经做过的记号带过去:档位(价与比例)一档没变的,`done` 原样留着——只改了止损价,不该让做完的第一档
 * 在回落之后再触发一次。档位本身改了(哪怕只动了一档),就是重新定的计划,从头来。
 */
export function carryTierMarks(
  next: readonly TakeProfitTier[] | null, prev: readonly TakeProfitTier[] | null | undefined,
): TakeProfitTier[] | null {
  if (next === null) return null;
  const old = prev ?? [];
  const same = old.length === next.length && next.every((t, i) => t.price === old[i]?.price && t.fraction_pct === old[i]?.fraction_pct);
  return next.map((t, i) => (same && old[i]?.done ? { price: t.price, fraction_pct: t.fraction_pct, done: true } : { price: t.price, fraction_pct: t.fraction_pct }));
}

/** 在等成交的那一档;没有回 -1。 */
export function pendingTier(tiers: readonly TakeProfitTier[] | null | undefined): number {
  return (tiers ?? []).findIndex((t) => Boolean(t.pending));
}

/** 改一档的状态,回一份新的(不改传进来的)。 */
export function markTier(
  tiers: readonly TakeProfitTier[], index: number, patch: Pick<TakeProfitTier, "pending" | "done" | "pending_qty">,
): TakeProfitTier[] {
  return tiers.map((t, i) => (i === index ? { price: t.price, fraction_pct: t.fraction_pct, ...patch } : { ...t }));
}

/** 把"到了某一档"并进这一轮的结论;只在这一轮没有别的触发时生效。带上是第几档,引擎按它定平多少。 */
export function withTier<T extends { state: string; reason: string; price: number | null }>(
  result: T, targets: Targets, long: boolean, holding = "holding", takeProfit = "take_profit",
): T & { tier?: number } {
  if (result.state !== holding) return result;
  const index = dueTier(targets.take_profit_tiers, long, result.price);
  const tier = index < 0 ? undefined : (targets.take_profit_tiers ?? [])[index];
  if (tier === undefined) return result;
  return {
    ...result, state: takeProfit, tier: index,
    reason: `分批止盈第 ${index + 1} 档:现价 ${fmtF(Number(result.price), 4)} ${long ? "涨到" : "跌到"} ${pyG(tier.price)},平 ${pyG(tier.fraction_pct)}%`,
  };
}

// ---------------------------------------------------------------- 追价节奏
/** 追价平仓的默认节奏(轮 = 引擎节拍,一秒一轮):先在立刻成交价上等 2 轮,之后每轮让 1 跳。 */
export const CHASE_GRACE_ROUNDS = 2;
export const CHASE_STEP_TICKS = 1;

export interface ChaseProfile {
  /** 先在立刻成交价上等几轮 */
  grace: number;
  /** 之后每轮让几跳 */
  step: number;
  /** 最多让到立刻成交价的百分之几 */
  maxPct: number;
}

/** 止损类的触发原因:止损(含跟踪止损、标的止损价)与利润回撤。带 sweep: 前缀的按后面那一段认。 */
export function isStopReason(reason: string | null | undefined): boolean {
  const text = String(reason ?? "");
  const bare = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
  return bare === "stop_loss" || bare === "profit_trail";
}

/**
 * 这一次追价用哪套节奏。止盈、到点、手动:默认那一套。止损类:用户给止损单另填了的那几项各自生效,没填的仍用默认——
 * 止损要的是"出去",止盈可以慢慢磨,两样共用一套节奏时只能迁就一头。
 */
export function chaseProfile(auto: AutoClose, reason?: string | null): ChaseProfile {
  const base: ChaseProfile = {
    grace: CHASE_GRACE_ROUNDS, step: CHASE_STEP_TICKS, maxPct: Math.max(0, finiteOrNull(auto.chase_max_pct) ?? 0),
  };
  if (!isStopReason(reason)) return base;
  const grace = finiteOrNull(auto.stop_chase_grace), step = finiteOrNull(auto.stop_chase_step);
  const maxPct = finiteOrNull(auto.stop_chase_max_pct);
  return {
    grace: grace !== null && grace >= 0 ? Math.trunc(grace) : base.grace,
    step: step !== null && step >= 1 ? Math.trunc(step) : base.step,
    maxPct: maxPct !== null && maxPct >= 0 ? maxPct : base.maxPct,
  };
}

// ---------------------------------------------------------------- 标的止损价的确认
/** 标的在线外待了多久的计时(只在内存里)。 */
export interface BreachClock {
  side: "below" | "above";
  sinceMs: number;
}

/**
 * 设了确认秒数时,把"这一轮越线了"换成"越线并且连续待够了"。回 [这一轮给界面与判定的那一份, 新的计时]。
 *
 *  · 没设(null / 0):原样返回,不计时——触线即算。
 *  · 这一轮拿不到标的现价:判不了,计时原样留着(没看见不等于回去了)。
 *  · 回到线内:计时清掉,下次越线从头数。
 *  · 换了一侧(从跌破变成涨破):从头数。
 */
export function confirmSpotStop(
  row: SpotStop, confirmS: number | null | undefined, clock: BreachClock | null, nowMs: number,
): [SpotStop, BreachClock | null] {
  const need = finiteOrNull(confirmS);
  if (need === null || !(need > 0)) return [row, null];
  if (row.spot === null) return [row, clock];
  if (row.hit === null) return [row, null];
  const next: BreachClock = clock !== null && clock.side === row.hit ? clock : { side: row.hit, sinceMs: nowMs };
  const held = Math.max(0, (nowMs - next.sinceMs) / 1000);
  if (held >= need) return [row, next];
  const line = row.hit === "below" ? row.below : row.above;
  return [{
    ...row, hit: null,
    pending: { side: row.hit, held_s: Math.floor(held), need_s: need },
    reason: `标的已${row.hit === "below" ? "跌破" : "涨破"} ${pyG(Number(line))},持续 ${Math.floor(held)} 秒,满 ${pyG(need)} 秒才平`,
  }, next];
}
