/** 蝴蝶测算(纯函数):按此刻的现价与各腿 IV,估「标的在某个时刻走到某个点位」时这只蝶值多少、赚多少。
 *
 * 和持仓追踪的「标的目标价」(tracker.spotTarget)是同一套定价——点数制 Bachelier,IV 按
 * σ_点 = 现价 × IV × √剩余年数 换算(ivPricing.ibkrLegSigmas)——只多了一维:时间。追踪问的是「标的现在就到」,
 * 这里问的是「标的在 t 时刻到」;目标时刻 = 此刻时,两边给出同一个数。
 *
 * 三件事要知道:
 *
 * 1. **IV 的来源分三档,整只蝶用同一档,不混。** 手动给的 → IBKR 的模型 IV(三条腿都有)→ 各腿盘口中间价反解。
 *    缺一条腿就整档不用:拿别的腿的 IV 去填,偏斜就是编的。
 * 2. **锚定。** IBKR 的模型价和盘口中间价常差一截,所以 ibkr 档只让模型管"变多少",水平锚在盘口中间价上。
 *    这截差是时间价值上的差,随剩余时间按 √ 收敛、到期归零——到期那一刻蝶只值内在价值,锚不动它。
 * 3. **IV 不是常数**(用户 2026-09-28:「如果急跌急涨,iv 会实时变化」「不要用经验公式,用历史数据校准」)。
 *    到目标时刻 IV 乘多少,拆成两份,**参数都是拿历史数据估出来的**(flyCalibration.ts 估,flyIvModel.ts 存):
 *    * **时段**(seasonalFactor):一天的波动不是匀速走完的。当日到期的蝶,剩余波动按校准出来的日内方差分布掉。
 *    * **走势**(ivResponse):ln(乘数) = a + b·u + c·u²,u = 走了全天标准差的几倍(跌为负)。跌则 IV 升,涨则 IV 降,
 *      走得越远越不对称。
 *    模型解释得了 IV 变化的三成左右,剩下的是噪声——所以结果里除了主结果,还有按历史残差给的"半数情况下"的区间
 *    (target_range)、IV 不变时的数(target_flat)和几档 IV 下的数(scenarios)。
 *
 * 不计佣金。只算不下单。
 */
import type {
  FlyPlanIv, FlyPlanIvMode, FlyPlanLeg, FlyPlanMove, FlyPlanPoint, FlyPlanResult, FlyPlanScenario,
  FlyPlanTime, FlyPlanValue,
} from "./contract/options.js";
import { impliedSigmaLeg, legValue } from "./flyexit.js";
import { ownDriftAt, QUARTILE, remainingShare, residualSd, U_MAX } from "./flyCalibration.js";
import type { FlyIvModel, Response } from "./flyCalibration.js";
import { FLY_IV_MODEL } from "./flyIvModel.js";
import { expiryEpochMs, ibkrLegSigmas } from "./ivPricing.js";
import { pyG, pyRound } from "./py.js";
import { dateOrdinal, dateStrAt, ET, isValidYmd, ordinalToDate, stampAt, wallParts, wallToEpoch } from "./tz.js";

export class FlyPlanError extends Error {}

const YEAR_MS = 365 * 24 * 3600 * 1000;
const OPEN_MINUTE = 9 * 60 + 30;

// ---------------------------------------------------------------- 哪一天、几点、哪个到期日
/** 日历由上一层给(配置里的休市日 + 内置日历),这里不认识配置 */
export interface PlanCalendar {
  isTradingDay(date: string): boolean;
  isEarlyClose(date: string): boolean;
}

export interface PlanSchedule {
  /** 美东 YYYY-MM-DD */
  targetDate: string;
  targetMs: number;
  /** YYYYMMDD */
  expiry: string;
  expiryMs: number;
  /** 目标那一天常规时段里的每个半点,给时间线用 */
  timelineMs: number[];
  warnings: string[];
}

function etEpoch(date: string, minuteOfDay: number): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return wallToEpoch(
    { year: y, month: m, day: d, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60, second: 0 }, ET,
  );
}

function closeMinute(date: string, calendar: PlanCalendar): number {
  return calendar.isEarlyClose(date) ? 13 * 60 : 16 * 60;
}

function nextTradingDay(date: string, calendar: PlanCalendar): string {
  let day = date;
  for (let i = 0; i < 14; i += 1) {
    day = ordinalToDate(dateOrdinal(day) + 1);
    if (calendar.isTradingDay(day)) return day;
  }
  throw new FlyPlanError("往后两周都找不到交易日,请检查休市日历。");
}

/**
 * 把「哪天、几点到、哪个到期日」定下来。
 *
 * 不给目标日期 = 今天;今天不是交易日、或者已经收盘了,就是下一个交易日。不给到期日 = 目标那一天(当日到期)。
 * 提前收盘日(感恩节次日、平安夜……)13:00 就到期:追踪那边的到期时刻一律按 16:00(ivPricing.expiryEpochMs),
 * 这里按真的来——差三个小时,对当日到期的蝶是全部的时间价值。
 */
export function planSchedule(
  args: { symbol: string; tradingClass: string; targetTime: string; targetDate?: string; expiry?: string; nowMs: number },
  calendar: PlanCalendar,
): PlanSchedule {
  const warnings: string[] = [];
  const hm = /^(\d{1,2}):(\d{2})$/.exec(args.targetTime.trim());
  if (hm === null || Number(hm[1]) > 23 || Number(hm[2]) > 59) {
    throw new FlyPlanError(`目标时刻要写成美东时间的 HH:MM(如 14:30),收到「${args.targetTime}」。`);
  }
  const minute = Number(hm[1]) * 60 + Number(hm[2]);

  const today = dateStrAt(args.nowMs, ET);
  let targetDate = (args.targetDate ?? "").trim();
  if (targetDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate);
    if (m === null || !isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
      throw new FlyPlanError(`目标日期要写成 YYYY-MM-DD,收到「${args.targetDate}」。`);
    }
    if (!calendar.isTradingDay(targetDate)) throw new FlyPlanError(`${targetDate} 不是交易日。`);
  } else {
    targetDate = today;
    if (!calendar.isTradingDay(today) || args.nowMs >= etEpoch(today, closeMinute(today, calendar))) {
      targetDate = nextTradingDay(today, calendar);
      warnings.push(`今天已经收盘或不是交易日,按下一个交易日 ${targetDate} 算。`);
    }
  }
  const close = closeMinute(targetDate, calendar);
  if (minute < OPEN_MINUTE || minute > close) {
    const until = close === 16 * 60 ? "16:00" : "13:00(这一天提前收盘)";
    warnings.push(`目标时刻不在常规交易时段里(美东 09:30–${until}):那时指数不报价,期权的盘口也薄。`);
  }

  let expiry = (args.expiry ?? "").trim();
  if (!expiry) expiry = targetDate.replace(/-/g, "");
  const e = /^(\d{4})(\d{2})(\d{2})$/.exec(expiry);
  if (e === null || !isValidYmd(Number(e[1]), Number(e[2]), Number(e[3]))) {
    throw new FlyPlanError(`到期日要写成 YYYYMMDD,收到「${args.expiry}」。`);
  }
  const expiryDate = `${e[1]}-${e[2]}-${e[3]}`;
  if (!calendar.isTradingDay(expiryDate)) throw new FlyPlanError(`${expiryDate} 不是交易日,没有这一天到期的合约。`);
  let expiryMs = expiryEpochMs(args.symbol, expiry, args.tradingClass);
  if (expiryMs === null) throw new FlyPlanError(`认不出 ${args.symbol} ${expiry} 是哪一种结算方式,算不了到期时刻。`);
  if (calendar.isEarlyClose(expiryDate) && expiryMs > etEpoch(expiryDate, 13 * 60)) {
    expiryMs = etEpoch(expiryDate, 13 * 60);
    warnings.push(`${expiryDate} 提前收盘,这只蝶按美东 13:00 到期算。`);
  }

  const timelineMs: number[] = [];
  for (let at = OPEN_MINUTE; at <= close; at += 30) timelineMs.push(etEpoch(targetDate, at));
  return { targetDate, targetMs: etEpoch(targetDate, minute), expiry, expiryMs, timelineMs, warnings };
}

/** IV 的乘数夹在 [1/3, 3]:校准样本里到不了这么远,出了这个范围的数不是模型说得清的 */
export const IV_FACTOR_MAX = 3;
const DAY_MS = 24 * 3600 * 1000;
/** 情景表固定列出的几档 IV 变化(%) */
export const SCENARIO_STEPS = [-25, 0, 25, 50, 100];

/** 一条腿此刻的行情。iv 是年化小数(IBKR 的模型 IV);拿不到的给 null,不编 */
export interface LegMark { bid: number | null; ask: number | null; iv: number | null }

export interface FlyPlanInput {
  symbol: string;
  expiry: string;
  tradingClass: string;
  right: "C" | "P";
  center: number;
  width: number;
  quantity: number;
  multiplier: number;
  spot: number;
  spotSource: FlyPlanResult["spot_source"];
  spotNote: string;
  nowMs: number;
  expiryMs: number;
  targetMs: number;
  targetSpot: number;
  /** 各腿行情,按 markKey(行权价) 索引 */
  marks: Record<string, LegMark>;
  /** 每份成本(点);null = 按盘口中间价,没有盘口按模型价 */
  cost: number | null;
  /** 手动给的 IV(年化小数);null = 用行情里的 */
  ivInput: number | null;
  ivMode: FlyPlanIvMode;
  /** ivMode = shift 时的变化(%) */
  ivShiftPct: number | null;
  /** 时间线上要列的时刻;不在(此刻, 到期]里的会被丢掉,目标时刻自动补上 */
  timelineMs: number[];
  /** 上一层(取行情、定到期时刻的那一层)要带给用户的话 */
  warnings?: string[];
  /** IV 怎么变的那份校准;不给用随软件带的那一份。测试钉数字时给一份固定的,重新校准不会把它们弄红 */
  model?: FlyIvModel;
}

interface SignedLeg { strike: number; right: "C" | "P"; ratio: number }
type Direction = FlyPlanMove["direction"];

export function markKey(strike: number): string {
  return pyG(strike);
}

const keyOf = (leg: { strike: number }): string => markKey(leg.strike);

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 买价恰好为 0 是"没人出价"(远翼常见),照实给 0;−1 / NaN 才是真没有。和持仓估值同一条规矩 */
function bidOf(mark: LegMark | undefined): number | null {
  if (!mark) return null;
  return mark.bid === 0 ? 0 : positive(mark.bid);
}

function midOf(mark: LegMark | undefined): number | null {
  const bid = bidOf(mark), ask = positive(mark?.ask);
  if (ask === null || bid === null || ask < bid) return null;
  return (bid + ask) / 2;
}

const clampFactor = (f: number): number => Math.min(IV_FACTOR_MAX, Math.max(1 / IV_FACTOR_MAX, f));

function minuteOfDay(ms: number): number {
  const w = wallParts(ms, ET);
  return w.hour * 60 + w.minute + w.second / 60;
}

/** 当日到期、正常 16:00 收盘:日内方差分布只对这一种成立。隔日到期的夜里怎么分不知道,提前收盘日的分布对不上 */
export function sameSession(nowMs: number, expiryMs: number): boolean {
  const end = wallParts(expiryMs, ET);
  return dateStrAt(nowMs, ET) === dateStrAt(expiryMs, ET) && end.hour === 16 && end.minute === 0;
}

/**
 * 时段:当日到期的蝶,到 atMs 那一刻 IV(按日历时间年化的那个数)相对现在乘多少。
 *
 * 剩余波动按校准出来的日内方差分布走,再除以"IV 不变"隐含的那条匀速线:乘数 = √[(剩余方差比) ÷ (剩余时间比)]。
 * 不是当日到期、或者那一天提前收盘:回 1。
 */
export function seasonalFactor(model: FlyIvModel, nowMs: number, atMs: number, expiryMs: number): number {
  if (!(atMs > nowMs) || !(expiryMs > atMs) || !sameSession(nowMs, expiryMs)) return 1;
  // 攒够了自己的期权 IV:直接用量出来的那条日内走法,不再借实际波动的分布去推
  if (model.own) return clampFactor(Math.exp(ownDriftAt(model.own, minuteOfDay(atMs)) - ownDriftAt(model.own, minuteOfDay(nowMs))));
  const rv0 = remainingShare(model.variance_weights, minuteOfDay(nowMs));
  const rv = remainingShare(model.variance_weights, minuteOfDay(atMs));
  if (!(rv0 > 0) || !(rv > 0)) return 1;
  return clampFactor(Math.sqrt((rv / rv0) / ((expiryMs - atMs) / (expiryMs - nowMs))));
}

/**
 * 这个期限用哪组系数:1 天以内用 1 天期的(不往更短外推),长一档以外用长一档的,之间按 ln(期限) 插值。
 * 当日到期(sameDay)而且攒够了自己的期权 IV:用自己那一份。
 */
function responseFor(model: FlyIvModel, daysToExpiry: number, sameDay: boolean): Response {
  if (sameDay && model.own) return model.own.response;
  const long = model.response_long;
  if (long === null || !(daysToExpiry > 1)) return model.response;
  const w = Math.min(1, Math.log(daysToExpiry) / Math.log(long.days));
  const mix = (a: number, b: number): number => a + (b - a) * w;
  return { a: mix(model.response.a, long.a), b: mix(model.response.b, long.b), c: mix(model.response.c, long.c) };
}

/**
 * 走势:标的走了全天标准差的 u 倍(跌为负)之后,IV 乘多少。ln(乘数) = a + b·u + c·u²,系数是校准出来的。
 * u = 0(原地不动)时不是正好 1:拟合的截距略小于 0——没动的那些时段,IV 平均是微降的。
 */
export function ivResponse(model: FlyIvModel, u: number, daysToExpiry: number, sameDay = false): number {
  if (!Number.isFinite(u)) return 1;
  const beta = responseFor(model, daysToExpiry, sameDay);
  const x = Math.max(-U_MAX, Math.min(U_MAX, u));
  return clampFactor(Math.exp(beta.a + beta.b * x + beta.c * x * x));
}

function checkInput(input: FlyPlanInput): void {
  const { center, width, quantity, spot, nowMs, expiryMs, targetMs, targetSpot } = input;
  if (!(width > 0)) throw new FlyPlanError("翼宽要是正数。");
  if (!(center > width)) throw new FlyPlanError("中心行权价要大于翼宽。");
  if (!(spot > 0)) throw new FlyPlanError("现价要是正数。");
  if (!(targetSpot > 0)) throw new FlyPlanError("目标点位要是正数。");
  if (!(Number.isInteger(quantity) && quantity >= 1)) throw new FlyPlanError("张数要是不小于 1 的整数。");
  if (!(expiryMs > nowMs)) throw new FlyPlanError(`${input.expiry} 这个到期日已经到期了,换一个到期日。`);
  if (targetMs < nowMs) throw new FlyPlanError("目标时刻已经过去了。");
  if (targetMs > expiryMs) {
    throw new FlyPlanError(`目标时刻在到期(美东 ${stampAt(expiryMs, ET)})之后:那时这只蝶已经结算了。`);
  }
  if (input.cost !== null && !(input.cost > 0)) throw new FlyPlanError("成本要是正数(买入的蝶是付权利金)。");
  if (input.ivInput !== null && !(input.ivInput > 0 && input.ivInput <= 5)) {
    throw new FlyPlanError("IV 要在 0 到 500% 之间。");
  }
  if (input.ivMode === "shift" && !((input.ivShiftPct ?? 0) > -100)) {
    throw new FlyPlanError("IV 的变化不能小于 −100%。");
  }
}

/** 各腿的年化 IV 与它的来源。三档依次退让,整只蝶用同一档 */
function resolveIvs(
  input: FlyPlanInput, legs: SignedLeg[], mids: Array<number | null>, years0: number,
): { source: FlyPlanIv["source"]; ivs: Record<string, number> } {
  const ivs: Record<string, number> = {};
  if (input.ivInput !== null) {
    for (const leg of legs) ivs[keyOf(leg)] = input.ivInput;
    return { source: "input", ivs };
  }
  if (legs.every((leg) => positive(input.marks[keyOf(leg)]?.iv) !== null)) {
    for (const leg of legs) ivs[keyOf(leg)] = input.marks[keyOf(leg)]!.iv!;
    return { source: "ibkr", ivs };
  }
  if (mids.every((m) => m !== null)) {
    const solved = legs.map((leg, i) => impliedSigmaLeg(input.spot, leg.strike, mids[i]!, leg.right));
    if (solved.every((s) => s !== null)) {
      legs.forEach((leg, i) => { ivs[keyOf(leg)] = solved[i]! / (input.spot * Math.sqrt(years0)); });
      return { source: "quote", ivs };
    }
  }
  throw new FlyPlanError(
    "拿不到这三条腿的 IV:券商没有推模型 IV,盘口也不全(休市、行权价太远、或行情被别处占用时会这样)。" +
    "可以在「IV」里手动填一个再算。",
  );
}

/** 组合此刻的盘口(不夹、不取整)。ask = 两翼按卖价买、中心按买价卖,就是现在立刻买得到的价 */
function comboQuotes(
  input: FlyPlanInput, legs: SignedLeg[], mids: Array<number | null>,
): { bid: number | null; mid: number | null; ask: number | null } {
  const quote = (i: number, side: "bid" | "ask"): number | null => {
    const mark = input.marks[keyOf(legs[i]!)];
    return side === "ask" ? positive(mark?.ask) : bidOf(mark);
  };
  const net = (wing: "bid" | "ask", body: "bid" | "ask"): number | null => {
    const a = quote(0, wing), b = quote(1, body), c = quote(2, wing);
    return a === null || b === null || c === null ? null : a - 2 * b + c;
  };
  const mid = mids.every((m) => m !== null) ? mids[0]! - 2 * mids[1]! + mids[2]! : null;
  return { bid: net("bid", "ask"), mid, ask: net("ask", "bid") };
}

/** 盈亏曲线的步长:点数尽量密,但整条线不超过 80 个点 */
function gridStep(span: number): number {
  for (const step of [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
    if (span / step <= 80) return step;
  }
  return Math.ceil(span / 80 / 100) * 100;
}

/** 目标时刻那条线穿过成本的位置(线性插值):最赚的位置左边第一处是下沿,右边最后一处是上沿 */
function breakevenOf(
  curve: FlyPlanPoint[], cost: number, best: FlyPlanPoint,
): { low: number | null; high: number | null } {
  if (!(best.target > cost)) return { low: null, high: null };
  const crossings: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1]!, b = curve[i]!;
    const da = a.target - cost, db = b.target - cost;
    if (da === 0) crossings.push(a.spot);
    else if (da * db < 0) crossings.push(pyRound(a.spot + ((b.spot - a.spot) * da) / (da - db), 1));
  }
  const first = crossings[0], last = crossings[crossings.length - 1];
  return {
    low: first !== undefined && first < best.spot ? first : null,
    high: last !== undefined && last > best.spot ? last : null,
  };
}

/** 到时的 IV 是怎么来的,说成一句话。autoPct = 自动档会给的变化(%),选了别的档时拿来对照 */
function ivWarning(iv: FlyPlanIv, autoPct: number): string | null {
  if (iv.mode !== "auto") {
    // 自己选了不变 / 自己填:和历史上的通常情况差得多才提醒
    if (Math.abs(autoPct - iv.change_pct) < 10) return null;
    const mine = iv.mode === "flat" ? "你选的是 IV 不变" : `IV 按你填的 ${signed(iv.change_pct)}% 算`;
    return `${mine};按历史数据,这样的走势之后 IV 通常是 ${signed(autoPct)}%。`;
  }
  if (Math.abs(iv.change_pct) < 0.05 || iv.range === null) return null;
  const parts: string[] = [];
  if (Math.abs(iv.seasonal_pct) >= 0.05) parts.push(`时段 ${signed(iv.seasonal_pct)}%`);
  if (Math.abs(iv.move_pct) >= 0.05) parts.push(`走势 ${signed(iv.move_pct)}%`);
  const lo = pyRound((iv.range.low / iv.now - 1) * 100, 0), hi = pyRound((iv.range.high / iv.now - 1) * 100, 0);
  return `到时的 IV 按 ${signed(iv.change_pct)}% 算(${parts.join(",")});历史上同样的走势之后,半数情况落在 ${signed(lo)}% ~ ${signed(hi)}% 之间。`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${pyG(Math.abs(value))}`;
}

// ---------------------------------------------------------------- 定价、成本、IV 的走法
interface Pricer {
  market: { bid: number | null; mid: number | null; ask: number | null };
  /** 同一组 IV 在现价、此刻的模型价(没锚定的) */
  modelNow: number;
  anchored: boolean;
  /** 这份持仓在 (s, atMs) 值多少,各腿 IV 同乘 factor */
  valueAt(s: number, atMs: number, factor: number): number;
}

function pricerOf(
  input: FlyPlanInput, legs: SignedLeg[], ivs: Record<string, number>, source: FlyPlanIv["source"],
  mids: Array<number | null>, warnings: string[],
): Pricer {
  const { spot, nowMs, expiryMs, width } = input;
  const years0 = (expiryMs - nowMs) / YEAR_MS;
  /** IV → 点数 σ 和追踪的 ibkr 档是同一个换算 */
  const modelAt = (s: number, atMs: number, factor: number): number => {
    const scaled: Record<string, number> = {};
    for (const leg of legs) scaled[keyOf(leg)] = ivs[keyOf(leg)]! * factor;
    const sig = ibkrLegSigmas(legs, spot, scaled, expiryMs, atMs, keyOf);
    if (sig === null) throw new FlyPlanError("IV 换算不出来:IV 或时刻不是有效数字。");
    let out = 0;
    for (const leg of legs) out += leg.ratio * legValue(leg.right, s, leg.strike, sig[keyOf(leg)]!);
    return out;
  };
  const market = comboQuotes(input, legs, mids);
  const modelNow = modelAt(spot, nowMs, 1);
  const anchored = source === "ibkr" && market.mid !== null && market.mid > 0;
  const gap = anchored ? market.mid! - modelNow : 0;
  if (anchored && Math.abs(gap) > Math.max(0.3, 0.25 * market.mid!)) {
    warnings.push(
      `IBKR 的 IV 算出来的模型价 ${pyG(pyRound(modelNow, 2))} 和盘口中间价 ${pyG(pyRound(market.mid!, 2))} 差得不小。` +
      "结果已经锚在盘口上,但差这么多时模型对「变多少」的估计也要打折扣。",
    );
  }
  return {
    market, modelNow, anchored,
    // 锚定的那截差随剩余时间按 √ 收敛;蝶的净价出不了 [0, 翼宽]
    valueAt: (s, atMs, factor) => {
      const left = Math.max(0, expiryMs - atMs) / YEAR_MS;
      return Math.min(width, Math.max(0, modelAt(s, atMs, factor) + gap * Math.sqrt(left / years0)));
    },
  };
}

function resolveCost(
  input: FlyPlanInput, pricer: Pricer, warnings: string[],
): { cost: number; costSource: FlyPlanResult["cost_source"] } {
  const { market } = pricer;
  let cost: number, costSource: FlyPlanResult["cost_source"];
  if (input.cost !== null) {
    [cost, costSource] = [input.cost, "input"];
  } else if (market.mid !== null && market.mid > 0) {
    [cost, costSource] = [pyRound(market.mid, 2), "mid"];
    const ask = market.ask !== null ? `,现在立刻买得到的价是 ${pyG(pyRound(market.ask, 2))}` : "";
    warnings.push(`成本按盘口中间价 ${pyG(cost)} 算${ask}。实际成交价以你挂的价为准,填上它再算更准。`);
  } else {
    [cost, costSource] = [pyRound(pricer.valueAt(input.spot, input.nowMs, 1), 2), "model"];
    warnings.push(`没有盘口,成本用的是模型价 ${pyG(cost)}——它不是市场价,请填上你打算付的权利金。`);
  }
  if (!(cost > 0)) throw new FlyPlanError("这只蝶此刻的价值算出来是 0,没法当成本:请填上你打算付的权利金。");
  if (cost >= input.width) {
    throw new FlyPlanError(
      `成本 ${pyG(cost)} 不小于翼宽 ${pyG(input.width)}:这只蝶到期最多值 ${pyG(input.width)},怎么走都不赚。`,
    );
  }
  return { cost, costSource };
}

interface IvPath {
  /** 离现价最近那条腿此刻的 IV:说"现在 IV 多少"、量"这一段走了多远"都用它 */
  refIv: number;
  /** 全天(常规时段)一个标准差是多少点 */
  daySigma: number;
  moveTo(s: number, atMs: number): { sigmas: number | null; direction: Direction; oneSigma: number; u: number; share: number };
  /** 自动档在 (s, atMs) 给的乘数:[合计, 时段, 走势] */
  autoFactors(s: number, atMs: number): [number, number, number];
  /** 标的在 atMs 走到 s 时 IV 乘多少,按用户选的方式:[合计, 时段, 走势] */
  factorsFor(s: number, atMs: number): [number, number, number];
}

function ivPathOf(input: FlyPlanInput, legs: SignedLeg[], ivs: Record<string, number>): IvPath {
  const { spot, nowMs, expiryMs } = input;
  const model = input.model ?? FLY_IV_MODEL;
  const years0 = (expiryMs - nowMs) / YEAR_MS;
  const refLeg = legs.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a), legs[1]!);
  const refIv = ivs[keyOf(refLeg)]!;
  const session = sameSession(nowMs, expiryMs);
  const share0 = session ? remainingShare(model.variance_weights, minuteOfDay(nowMs)) : 0;
  // 当日到期:期权自己的剩余波动折回全天(剩余波动 ÷ √还剩几成);别的期限:年化 IV 折成一个常规时段,
  // 折算系数是校准时量出来的(实际的常规时段方差 ÷ 隐含的一天方差)
  const daySigma = session && share0 > 0
    ? (spot * refIv * Math.sqrt(years0)) / Math.sqrt(share0)
    : spot * refIv * Math.sqrt(model.realized_to_implied / 252);
  const moveTo: IvPath["moveTo"] = (s, atMs) => {
    const ahead = Math.max(0, atMs - nowMs);
    // 这一段占全天方差的份额。当日到期按分布算;别的期限按钟点算(一天算一份)
    const share = session
      ? Math.max(0, share0 - remainingShare(model.variance_weights, minuteOfDay(Math.min(atMs, expiryMs))))
      : ahead / DAY_MS;
    const oneSigma = session ? daySigma * Math.sqrt(share) : spot * refIv * Math.sqrt(ahead / YEAR_MS);
    const direction: Direction = s > spot ? "up" : s < spot ? "down" : "flat";
    return { sigmas: oneSigma > 0 ? Math.abs(s - spot) / oneSigma : null, direction, oneSigma, u: (s - spot) / daySigma, share };
  };
  // 「现在就到」没有时间可言,自动档也是 1——和追踪的试算一致
  const autoFactors: IvPath["autoFactors"] = (s, atMs) => {
    if (!(atMs > nowMs)) return [1, 1, 1];
    const seasonal = seasonalFactor(model, nowMs, atMs, expiryMs);
    const response = ivResponse(model, moveTo(s, atMs).u, years0 * 365, session);
    return [clampFactor(seasonal * response), seasonal, response];
  };
  return {
    refIv, daySigma, moveTo, autoFactors,
    factorsFor: (s, atMs) => {
      if (input.ivMode === "flat") return [1, 1, 1];
      if (input.ivMode === "shift") return [1 + (input.ivShiftPct ?? 0) / 100, 1, 1];
      return autoFactors(s, atMs);
    },
  };
}

function curveOf(input: FlyPlanInput, pricer: Pricer, path: IvPath): FlyPlanPoint[] {
  const { center, width, spot, nowMs, expiryMs, targetMs, targetSpot } = input;
  const lo = Math.min(center - width, spot, targetSpot) - width / 2;
  const hi = Math.max(center + width, spot, targetSpot) + width / 2;
  const step = gridStep(hi - lo);
  const curve: FlyPlanPoint[] = [];
  for (let i = Math.floor(lo / step); i <= Math.ceil(hi / step); i += 1) {
    const at = pyRound(i * step, 2);
    curve.push({
      spot: at,
      now: pyRound(pricer.valueAt(at, nowMs, 1), 2),
      target: pyRound(pricer.valueAt(at, targetMs, path.factorsFor(at, targetMs)[0]), 2),
      expiry: pyRound(pricer.valueAt(at, expiryMs, 1), 2),
    });
  }
  return curve;
}

export function planFly(input: FlyPlanInput): FlyPlanResult {
  checkInput(input);
  const { right, center, width, quantity, multiplier, spot, nowMs, expiryMs, targetMs, targetSpot } = input;
  const warnings = [...(input.warnings ?? [])];

  const lower = center - width, upper = center + width;
  const legs: SignedLeg[] = [
    { strike: lower, right, ratio: 1 }, { strike: center, right, ratio: -2 }, { strike: upper, right, ratio: 1 },
  ];
  const mids = legs.map((leg) => midOf(input.marks[keyOf(leg)]));
  const { source, ivs } = resolveIvs(input, legs, mids, (expiryMs - nowMs) / YEAR_MS);
  if (source === "input") warnings.push("IV 是手动给的,三条腿共用一个数:没有偏斜,也没有锚到盘口上。");

  const pricer = pricerOf(input, legs, ivs, source, mids, warnings);
  const { cost, costSource } = resolveCost(input, pricer, warnings);
  /** 盈亏按取整之后的净价算:界面上摆着「值 11.88、成本 2」,旁边的盈亏就得是 988,不能是 988.38 */
  const priced = (raw: number): FlyPlanValue => {
    const value = pyRound(raw, 2);
    return {
      value,
      pnl: pyRound((value - cost) * multiplier * quantity, 2),
      pnl_pct: pyRound(((value - cost) / cost) * 100, 1),
    };
  };

  // ---- 这一段走了多远,IV 跟着变多少 ----
  const model = input.model ?? FLY_IV_MODEL;
  const path = ivPathOf(input, legs, ivs);
  const tm = path.moveTo(targetSpot, targetMs);
  const move: FlyPlanMove = {
    points: pyRound(targetSpot - spot, 2),
    pct: pyRound(((targetSpot - spot) / spot) * 100, 2),
    minutes: Math.round((targetMs - nowMs) / 60_000),
    direction: tm.direction,
    one_sigma: pyRound(tm.oneSigma, 2),
    sigmas: tm.sigmas === null ? null : pyRound(tm.sigmas, 2),
    pace: tm.sigmas === null || tm.sigmas <= 1 ? "calm" : tm.sigmas < 2 ? "brisk" : "sharp",
    day_sigma: pyRound(path.daySigma, 2),
    day_sigmas: pyRound(tm.u, 2),
  };
  const [factor, seasonal, response] = path.factorsFor(targetSpot, targetMs);
  const auto = input.ivMode === "auto" && targetMs > nowMs;
  // 半数情况下的区间:走得越久越宽,走得越远也越宽(flyCalibration.residualSd)
  const own = sameSession(nowMs, expiryMs) ? model.own : null;
  const spread = auto ? Math.exp(QUARTILE * residualSd(own ?? model, tm.share, tm.u)) : 1;
  const band: [number, number] = [clampFactor(factor / spread), clampFactor(factor * spread)];
  const iv: FlyPlanIv = {
    source, mode: input.ivMode,
    now: pyRound(path.refIv, 4), at_target: pyRound(path.refIv * factor, 4), change_pct: pyRound((factor - 1) * 100, 1),
    seasonal_pct: pyRound((seasonal - 1) * 100, 1), move_pct: pyRound((response - 1) * 100, 1),
    range: auto ? { low: pyRound(path.refIv * band[0], 4), high: pyRound(path.refIv * band[1], 4) } : null,
    model: input.ivMode === "auto"
      ? own
        ? { version: model.version, period: `${own.period.from} → ${own.period.to}`, days: own.days, proxy: "自己攒的当日到期期权 IV", r2_out: own.fit.r2_out, own: true }
        : { version: model.version, period: `${model.period.from} → ${model.period.to}`, days: model.days, proxy: model.proxy, r2_out: model.fit.r2_out, own: false }
      : null,
  };
  const about = ivWarning(iv, pyRound((path.autoFactors(targetSpot, targetMs)[0] - 1) * 100, 1));
  if (about !== null) warnings.push(about);
  const overnight = dateStrAt(nowMs, ET) !== dateStrAt(expiryMs, ET);
  if (auto && !sameSession(nowMs, expiryMs)) {
    warnings.push("这只蝶不是当日到期(或那一天提前收盘):日内的时段分布不适用,IV 只按走势调;走势的反应按期限打了折。");
  }
  if (Math.abs(targetSpot - center) >= width) {
    warnings.push("目标点位在两翼之外:到期时停在那儿这只蝶归零,此刻算出来的只是时间价值,越接近到期越少。");
  }
  // 蝶价对 IV 不一定单调(翼内翼外方向相反):区间的两头各算一遍,和主结果一起取最小最大
  const spreadValues = [band[0], factor, band[1]].map((f) => pricer.valueAt(targetSpot, targetMs, f));

  // ---- 各档 IV、盈亏曲线、早到晚到 ----
  // 主结果用的那一档按它自己的乘数算(不是取整后的百分比),这一行和上面的主结果才是同一个数;
  // 固定档里离它不到半个百分点的那一档让位,免得两行几乎一样
  const rows = SCENARIO_STEPS.filter((s) => Math.abs(s - iv.change_pct) >= 0.5).map((s) => ({ pct: s, factor: 1 + s / 100, current: false }));
  rows.push({ pct: iv.change_pct, factor, current: true });
  const scenarios: FlyPlanScenario[] = rows.sort((a, b) => a.pct - b.pct).map((row) => ({
    ...priced(pricer.valueAt(targetSpot, targetMs, row.factor)),
    iv_change_pct: row.pct, iv: pyRound(path.refIv * row.factor, 4), current: row.current,
  }));
  const curve = curveOf(input, pricer, path);
  const best = curve.reduce((a, b) => (b.target > a.target ? b : a), curve[0]!);
  const times = [...new Set([...input.timelineMs.filter((t) => t > nowMs && t <= expiryMs), targetMs])].sort((a, b) => a - b);
  const timeline: FlyPlanTime[] = times.map((t) => {
    const f = path.factorsFor(targetSpot, t)[0];
    const stamp = stampAt(t, ET);
    return {
      ...priced(pricer.valueAt(targetSpot, t, f)),
      at: overnight ? stamp.slice(5) : stamp.slice(11), epoch_ms: t, iv: pyRound(path.refIv * f, 4), is_target: t === targetMs,
    };
  });

  const outLegs: FlyPlanLeg[] = legs.map((leg, i) => {
    const mark = input.marks[keyOf(leg)];
    return {
      strike: leg.strike, right, action: leg.ratio > 0 ? "BUY" : "SELL", ratio: Math.abs(leg.ratio),
      bid: bidOf(mark), ask: positive(mark?.ask),
      mid: mids[i] === null ? null : pyRound(mids[i]!, 4), iv: pyRound(ivs[keyOf(leg)]!, 4),
    };
  });
  const round2 = (v: number | null): number | null => (v === null ? null : pyRound(v, 2));
  const { market } = pricer;

  return {
    symbol: input.symbol, expiry: input.expiry, trading_class: input.tradingClass, right,
    lower, center, upper, width, quantity, multiplier, legs: outLegs,
    spot, spot_source: input.spotSource, spot_note: input.spotNote,
    now_at: stampAt(nowMs, ET), now_ms: nowMs, expiry_at: stampAt(expiryMs, ET), expiry_ms: expiryMs,
    market: { bid: market.bid === null ? null : pyRound(Math.max(0, market.bid), 2), mid: round2(market.mid), ask: round2(market.ask) },
    model_now: pyRound(pricer.modelNow, 2), anchored: pricer.anchored, cost, cost_source: costSource,
    move, iv,
    target: {
      ...priced(pricer.valueAt(targetSpot, targetMs, factor)),
      spot: targetSpot, at: stampAt(targetMs, ET), epoch_ms: targetMs,
      hours_left: pyRound((expiryMs - targetMs) / 3_600_000, 2),
    },
    target_range: auto ? { low: priced(Math.min(...spreadValues)), high: priced(Math.max(...spreadValues)) } : null,
    target_flat: priced(pricer.valueAt(targetSpot, targetMs, 1)),
    instant: priced(pricer.valueAt(targetSpot, nowMs, 1)),
    at_expiry: priced(pricer.valueAt(targetSpot, expiryMs, 1)),
    peak: { ...priced(best.target), spot: best.spot },
    breakeven: breakevenOf(curve, cost, best),
    expiry_breakeven: { low: pyRound(lower + cost, 2), high: pyRound(upper - cost, 2) },
    max_profit: pyRound((width - cost) * multiplier * quantity, 2),
    max_loss: pyRound(cost * multiplier * quantity, 2),
    scenarios, curve, timeline, warnings,
  };
}
