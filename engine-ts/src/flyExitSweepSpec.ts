/** 蝶式出场参数扫描:比的是什么、拿什么比(纯数据与换算,不跑任何规则)。
 *
 *  · 记下来的一笔盘口 → 一只蝶的中间价、立刻买得到的价、立刻卖得掉的价(flyQuote)。只用记下来的腿盘口,
 *    没有模型价,不在行权价之间、时刻之间插值。
 *  · 实盘蝶式预设的一组参数(LiveParams)怎么换成追踪上的 Targets(liveTargets),参照组从 flyexit 里读(liveReference)。
 *  · 回放策略的参数网格(replaySets)、入场人群与成交口径(SweepConfig)、结果的形状(SweepResult)。
 *
 * 跑规则在 flyExitSweep.ts,统计在 flyExitSweepStats.ts,报告在 flyExitSweepReport.ts。口径见 docs/features/fly-exit-sweep.md。
 */
import type { Targets } from "./contract/tracker.js";
import {
  CLOCK_KEYS, DEFAULTS as REPLAY_DEFAULTS, FLY_ARM_USD, FLY_TIGHTEN_USD, drawdownFloor, drawdownLate, drawdownTiers,
} from "./flyexit.js";
import { legMid } from "./playbook.js";
import { pyG, pyRound } from "./py.js";
import { clockMinutes, nextOccurrenceMs } from "./trackerExits.js";
import { ET, zonedEpoch } from "./tz.js";

export class SweepError extends Error {}

// ---------------------------------------------------------------- 样本与盘口
/** 记下来的一条腿(ivSamples.IvSampleLeg 的子集;这里不引 domain 层的文件读写,只认数据) */
export interface QuoteLeg { strike: number; right: string; bid: number | null; ask: number | null }
/** 记下来的一笔(ivSamples.IvSample 的子集) */
export interface QuoteSample {
  t: number;
  spot: number;
  /** loop = 后台按节拍记的;plan = 测算顺带记的。没有这个键的当 loop */
  by?: string;
  /** 到期日 YYYYMMDD;有就核对是不是当日到期,不是的那一笔不用 */
  expiry?: string;
  /** 标的;一次只扫一个标的(SweepConfig.symbol),别的标的的样本不用 */
  symbol?: string;
  legs: ReadonlyArray<QuoteLeg>;
}

export type Right = "C" | "P";
/** 一只多头蝶:买 中心 − 翼宽、卖两张中心、买 中心 + 翼宽,同为看涨或看跌 */
export interface FlySpec { center: number; wing: number; right: Right }
export interface SignedLeg { strike: number; right: string; ratio: number }

export function flyLegs(fly: FlySpec): SignedLeg[] {
  return [
    { strike: fly.center - fly.wing, right: fly.right, ratio: 1 },
    { strike: fly.center, right: fly.right, ratio: -2 },
    { strike: fly.center + fly.wing, right: fly.right, ratio: 1 },
  ];
}

/** 每组几张合约(佣金按张收) */
export const CONTRACTS_PER_FLY = flyLegs({ center: 0, wing: 1, right: "C" }).reduce((n, leg) => n + Math.abs(leg.ratio), 0);

export interface FlyQuote {
  /** 三条腿这一笔都在不在样本里(不在 = 这一笔和这只蝶无关,不算缺报价) */
  listed: boolean;
  /** Σ 比例 × 腿中间价,取绝对值、4 位(和持仓那一行 combos.comboRow 的现价同一个口径) */
  mid: number | null;
  /** 现在立刻买得到:两翼按卖价买、中心按买价卖 */
  open: number | null;
  /** 现在立刻卖得掉:两翼按买价卖、中心按卖价买回。不夹 0(负数 = 平掉要倒贴) */
  close_raw: number | null;
}

export const legKey = (strike: number, right: string): string => `${pyG(strike)}${String(right).slice(0, 1).toUpperCase()}`;
export type Book = ReadonlyMap<string, QuoteLeg>;
export const bookOf = (sample: QuoteSample): Book => new Map(sample.legs.map((leg) => [legKey(leg.strike, leg.right), leg]));

/** 有一条腿的买卖价不成对(缺一个、卖价不是正数、买价高过卖价),三个价都不给:半边报价拼出来的净价是凭空的。
 * 买价恰好为 0 是真盘口(远翼没人出价),照算——和 tracker.naturalClosePrice、playbook.legMid 同一条规矩。 */
export function quoteFrom(book: Book, fly: FlySpec): FlyQuote {
  const legs = flyLegs(fly);
  const quotes = legs.map((leg) => book.get(legKey(leg.strike, leg.right)));
  if (quotes.some((q) => q === undefined)) return { listed: false, mid: null, open: null, close_raw: null };
  let mid = 0, open = 0, close = 0;
  for (const [i, leg] of legs.entries()) {
    const q = quotes[i];
    const m = q === undefined ? null : legMid({ bid: q.bid, ask: q.ask });
    if (q === undefined || m === null || q.bid === null || q.ask === null) return { listed: true, mid: null, open: null, close_raw: null };
    mid += leg.ratio * m;
    open += leg.ratio * (leg.ratio > 0 ? q.ask : q.bid);
    close += leg.ratio * (leg.ratio > 0 ? q.bid : q.ask);
  }
  return { listed: true, mid: pyRound(Math.abs(mid), 4), open: pyRound(open, 4), close_raw: pyRound(close, 4) };
}

export function flyQuote(sample: QuoteSample, fly: FlySpec): FlyQuote {
  return quoteFrom(bookOf(sample), fly);
}

/** 到期时这只蝶值多少(合约条款,不是模型):标的在两翼之间是一顶帐篷,之外是 0 */
export function flyIntrinsic(fly: FlySpec, spot: number): number {
  const sign = fly.right === "P" ? -1 : 1;
  return pyRound(flyLegs(fly).reduce((acc, leg) => acc + leg.ratio * Math.max(sign * (spot - leg.strike), 0), 0), 4);
}

/** 入场价:中间价 + 这一份 ×(立刻买得到的价 − 中间价),朝多付的一侧取到组合的跳动上。share = 1 就是立刻买得到的价 */
export function entryDebit(mid: number, open: number, share: number, tick: number): number {
  const raw = mid + share * (open - mid);
  return tick > 0 ? pyRound(Math.ceil(raw / tick - 1e-9) * tick, 4) : pyRound(raw, 4);
}

// ---------------------------------------------------------------- 实盘预设的参数
/** 实盘蝶式预设的一组参数。金额线是每组的美元,换算成 Targets 的倍数在 liveTargets。 */
export interface LiveParams {
  /** 每组浮盈到过这么多美元才开始追回撤 */
  arm_usd: number;
  /** 到过这么多美元换第二档 */
  tighten_usd: number;
  /** 三档各让百分之几 */
  loose_pct: number;
  mid_pct: number;
  tight_pct: number;
  /** 第三档从浮盈 / 成本的几倍起(只在它高过 tighten_usd 那条线时才有) */
  tight_at: number;
  /** 尾盘收紧:美东这个钟点之后,阈值乘 late_factor */
  late_after: string;
  late_factor: number;
  /** 最少回吐(每份的价格点) */
  floor: number;
  /** 止损 = 这个倍数 × 入场价;null = 不设 */
  stop_mult: number | null;
  /** 到点平仓,美东 "HH:MM";null = 不设 */
  exit_at: string | null;
}

/** 现在实盘用的那一组:全部从 flyexit 读出来。止损与到点是每条追踪上人填的,预设里没有,所以是 null。 */
export function liveReference(): LiveParams {
  const tiers = drawdownTiers(null), late = drawdownLate(null);
  return {
    arm_usd: FLY_ARM_USD, tighten_usd: FLY_TIGHTEN_USD,
    loose_pct: tiers[0]?.pct ?? NaN, mid_pct: tiers[1]?.pct ?? NaN, tight_pct: tiers[2]?.pct ?? NaN, tight_at: tiers[2]?.above ?? NaN,
    late_after: late.after, late_factor: late.factor, floor: drawdownFloor(null), stop_mult: null, exit_at: null,
  };
}

/**
 * 一组参数 + 这只蝶每组的开仓成本(美元,含乘数;实盘是组合行的 avg_cost,IBKR 的口径里含佣金,见 unitCost)→ Targets 上那几项。
 *
 * 和 flyexit.drawdownUsdPreset(金额线换成倍数、第三档只在高过收紧线时才有)加 rpc/params 的 drawdownTiersOf
 * 是同一个换算,只是金额线能换:那两个函数把 $100 / $200 写在里面,要扫别的数只能在这里再写一遍。
 * 测试钉着:参照组经过这里出来的,和实盘建追踪时存进库的那一份逐字段相同。
 */
export function liveTargets(p: LiveParams, unitCostUsd: number, debit: number, entryMs: number): Partial<Targets> {
  const cost = Math.abs(unitCostUsd);
  const tighten = pyRound(p.tighten_usd / cost, 6);
  const tiers = [{ above: 0.0, pct: p.loose_pct }, { above: tighten, pct: p.mid_pct }];
  if (p.tight_at > tighten) tiers.push({ above: p.tight_at, pct: p.tight_pct });
  return {
    profit_drawdown_tiers: tiers,
    profit_drawdown_late: { after: p.late_after, factor: p.late_factor },
    profit_drawdown_arm: pyRound(p.arm_usd / cost, 6),
    profit_drawdown_floor: p.floor,
    stop_loss: p.stop_mult === null ? null : pyRound(p.stop_mult * debit, 4),
    exit_at: p.exit_at,
    // 和界面设"到点平仓"同一个函数:入场时已经过了这个钟点的,是明天的——当天不会触发
    exit_at_ms: p.exit_at === null ? null : nextOccurrenceMs(p.exit_at, entryMs),
  };
}

/**
 * 每组的开仓成本(美元),实盘追踪拿它当成本:金额线换算成倍数、浮盈都是对着它算的。
 * IBKR 的 avgCost 含佣金(买入的腿加、卖出的腿减),合成一组就是 入场价 × 乘数 + 每组张数 × 每张佣金。
 * 没给佣金时只有 入场价 × 乘数:比实盘的成本低一点,$100 / $200 那两条线在这里到得略早——报告里写明。
 */
export function unitCost(debit: number, fill: { multiplier: number; commission: number | null }): number {
  return debit * fill.multiplier + CONTRACTS_PER_FLY * (fill.commission ?? 0);
}

/** 网格:每一项给几个取值,没给的用参照组的。tiers 三个数一起给(让多少 % 的三档),不各自交叉。 */
export interface LiveGrid {
  arm_usd?: ReadonlyArray<number>;
  tighten_usd?: ReadonlyArray<number>;
  tiers?: ReadonlyArray<readonly [number, number, number]>;
  tight_at?: ReadonlyArray<number>;
  late_after?: ReadonlyArray<string>;
  late_factor?: ReadonlyArray<number>;
  floor?: ReadonlyArray<number>;
  stop_mult?: ReadonlyArray<number | null>;
  exit_at?: ReadonlyArray<string | null>;
}

function checkLive(p: LiveParams): void {
  const pct = (v: number): boolean => v > 0 && v <= 100;
  // 从 JSON 来的值可能是字符串:"50" 在比较里会被悄悄当成数,进了名字与去重就不是同一个东西了
  const numbers = [p.arm_usd, p.tighten_usd, p.loose_pct, p.mid_pct, p.tight_pct, p.tight_at, p.late_factor, p.floor];
  if (numbers.some((v) => typeof v !== "number" || !Number.isFinite(v)) || typeof p.late_after !== "string"
    || (p.stop_mult !== null && typeof p.stop_mult !== "number") || (p.exit_at !== null && typeof p.exit_at !== "string")) {
    throw new SweepError("参数的取值类型不对:金额、百分比、倍数要是数,钟点要是 \"HH:MM\" 的字符串,不设写 null");
  }
  if (!(p.arm_usd >= 0) || !(p.tighten_usd > 0)) throw new SweepError(`起算线不能为负、收紧线要是正数(起算 ${p.arm_usd}、收紧 ${p.tighten_usd})`);
  if (!pct(p.loose_pct) || !pct(p.mid_pct) || !pct(p.tight_pct)) throw new SweepError("三档让的百分比都要在 0(不含)到 100 之间");
  if (!(p.tight_at > 0)) throw new SweepError("第三档的起点(浮盈 / 成本的倍数)要是正数");
  if (clockMinutes(p.late_after) === null || !(p.late_factor > 0)) throw new SweepError(`尾盘收紧要写成 "HH:MM" 与一个正的系数(${p.late_after}、${p.late_factor})`);
  if (!(p.floor >= 0)) throw new SweepError("最少回吐不能为负");
  if (p.stop_mult !== null && !(p.stop_mult > 0 && p.stop_mult < 1)) throw new SweepError(`止损倍数要在 0 到 1 之间(入场价的几成),收到 ${p.stop_mult}`);
  if (p.exit_at !== null && clockMinutes(p.exit_at) === null) throw new SweepError(`到点平仓要写成 "HH:MM",收到 ${p.exit_at}`);
}

const GRID_KEYS = ["arm_usd", "tighten_usd", "tiers", "tight_at", "late_after", "late_factor", "floor", "stop_mult", "exit_at"];

/** 网格与点名的组多半是从命令行、JSON 文件来的:写错的键名当场拒,不悄悄忽略(忽略了,比的就不是你以为的那几组) */
function checkKeys(raw: object, allowed: ReadonlyArray<string>, what: string): void {
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new SweepError(`${what}里没有「${unknown.join("、")}」这一项(可用:${allowed.join("、")})`);
}

/** 参照组 + 网格的全部组合 + 另外点名的几组,去掉重复的。回的第一组永远是参照组。 */
export function liveSets(reference: LiveParams, grid: LiveGrid | null, extra: ReadonlyArray<Partial<LiveParams>> = []): LiveParams[] {
  const paramKeys = Object.keys(liveRow(liveReference()));
  checkKeys(reference, paramKeys, "参照组");
  checkKeys(grid ?? {}, GRID_KEYS, "实盘预设的网格");
  for (const e of extra) checkKeys(e, paramKeys, "点名的参数组");
  let combos: LiveParams[] = [{ ...reference }];
  const cross = <V>(values: ReadonlyArray<V> | undefined, apply: (p: LiveParams, v: V) => LiveParams): void => {
    if (values === undefined || !values.length) return;
    combos = combos.flatMap((p) => values.map((v) => apply(p, v)));
  };
  const g = grid ?? {};
  cross(g.arm_usd, (p, v) => ({ ...p, arm_usd: v }));
  cross(g.tighten_usd, (p, v) => ({ ...p, tighten_usd: v }));
  cross(g.tiers, (p, v) => ({ ...p, loose_pct: v[0], mid_pct: v[1], tight_pct: v[2] }));
  cross(g.tight_at, (p, v) => ({ ...p, tight_at: v }));
  cross(g.late_after, (p, v) => ({ ...p, late_after: v }));
  cross(g.late_factor, (p, v) => ({ ...p, late_factor: v }));
  cross(g.floor, (p, v) => ({ ...p, floor: v }));
  cross(g.stop_mult, (p, v) => ({ ...p, stop_mult: v }));
  cross(g.exit_at, (p, v) => ({ ...p, exit_at: v }));
  const seen = new Set<string>();
  const out: LiveParams[] = [];
  for (const p of [{ ...reference }, ...combos, ...extra.map((e) => ({ ...reference, ...e }))]) {
    checkLive(p);
    const key = JSON.stringify(liveRow(p));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export type ParamRow = Record<string, number | string | null>;
export const liveRow = (p: LiveParams): ParamRow => ({
  arm_usd: p.arm_usd, tighten_usd: p.tighten_usd, loose_pct: p.loose_pct, mid_pct: p.mid_pct, tight_pct: p.tight_pct,
  tight_at: p.tight_at, late_after: p.late_after, late_factor: p.late_factor, floor: p.floor, stop_mult: p.stop_mult, exit_at: p.exit_at,
});

/** 一组参数的名字:只说它和参照组不一样的地方 */
export function liveLabel(p: LiveParams, reference: LiveParams): string {
  const parts: string[] = [];
  if (p.arm_usd !== reference.arm_usd) parts.push(`起算 $${pyG(p.arm_usd)}`);
  if (p.tighten_usd !== reference.tighten_usd) parts.push(`收紧 $${pyG(p.tighten_usd)}`);
  if (p.loose_pct !== reference.loose_pct || p.mid_pct !== reference.mid_pct || p.tight_pct !== reference.tight_pct) {
    parts.push(`档位 ${pyG(p.loose_pct)}/${pyG(p.mid_pct)}/${pyG(p.tight_pct)}`);
  }
  if (p.tight_at !== reference.tight_at) parts.push(`第三档 ${pyG(p.tight_at)}×成本起`);
  if (p.late_after !== reference.late_after || p.late_factor !== reference.late_factor) parts.push(`${p.late_after} 后 ×${pyG(p.late_factor)}`);
  if (p.floor !== reference.floor) parts.push(`最少回吐 ${pyG(p.floor)}`);
  if (p.stop_mult !== reference.stop_mult) parts.push(p.stop_mult === null ? "不设止损" : `止损 ${pyG(p.stop_mult)}×D`);
  if (p.exit_at !== reference.exit_at) parts.push(p.exit_at === null ? "不设到点" : `${p.exit_at} 平`);
  return parts.length ? parts.join(" · ") : "参照组(现行)";
}

// ---------------------------------------------------------------- 回放策略的参数
export type ReplayOverride = Record<string, number | string>;

/** flyexit.DEFAULTS 上的键各给几个取值 → 全部组合。第一组是空的(= 现在的默认值)。em 不在这里给(见 SweepConfig.replay.em)。 */
export function replaySets(grid: Readonly<Record<string, ReadonlyArray<number | string>>> | null): ReplayOverride[] {
  let combos: ReplayOverride[] = [{}];
  for (const [key, values] of Object.entries(grid ?? {})) {
    if (!(key in REPLAY_DEFAULTS) || key === "em") {
      throw new SweepError(`回放策略没有参数 ${key}(可扫:${Object.keys(REPLAY_DEFAULTS).filter((k) => k !== "em").join("、")})`);
    }
    for (const v of values) {
      const ok = CLOCK_KEYS.includes(key) ? typeof v === "string" && clockMinutes(v) !== null : typeof v === "number" && v > 0;
      if (!ok) throw new SweepError(`回放参数 ${key} 的取值 ${String(v)} 不对(${CLOCK_KEYS.includes(key) ? '"HH:MM"' : "正数"})`);
    }
    if (values.length) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  const seen = new Set<string>();
  return [{}, ...combos].filter((c) => {
    const key = JSON.stringify(Object.entries(c).filter(([k, v]) => REPLAY_DEFAULTS[k] !== v).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const replayLabel = (o: ReplayOverride): string => {
  const parts = Object.entries(o).filter(([k, v]) => REPLAY_DEFAULTS[k] !== v).map(([k, v]) => `${k}=${typeof v === "number" ? pyG(v) : v}`);
  return parts.length ? parts.join(" ") : "参照组(现行)";
};

// ---------------------------------------------------------------- 配置
/** 入场人群的限定。每一项都由调用方给,null = 不限;这里不替人定"你做的是哪一种蝶"。 */
export interface Population {
  /** 用哪一路记的样本 */
  by: "loop" | "plan" | "all";
  /** 入场时刻的窗口,美东 "HH:MM",两头都含 */
  entry_from: string | null;
  entry_to: string | null;
  wings: ReadonlyArray<number> | null;
  rights: ReadonlyArray<Right> | null;
  /** 入场价 D(点)的范围 */
  debit_min: number | null;
  debit_max: number | null;
  /** 中心在现价的虚值一侧多少点:看涨 = 中心 − 现价,看跌 = 现价 − 中心(负数 = 中心在实值一侧) */
  dist_min: number | null;
  dist_max: number | null;
}

/** 真实的入场:给了就只算这几笔,不枚举 */
export interface RealEntry {
  /** 入场时刻(毫秒);用它当时或之后的第一笔样本 */
  t: number;
  center: number;
  wing: number;
  right: Right;
  quantity?: number;
  /** 实际付的净价(点);给了就用它,不按下面的成交口径估 */
  debit?: number;
}

/** 入场时刻的两种写法 → 毫秒:美东墙钟 "YYYY-MM-DD HH:MM[:SS]",或带时区的 ISO("…Z" / "…-04:00")。认不出回 null */
export function parseEntryTime(text: string): number | null {
  const wall = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (wall !== null) {
    return zonedEpoch({
      year: Number(wall[1]), month: Number(wall[2]), day: Number(wall[3]),
      hour: Number(wall[4]), minute: Number(wall[5]), second: Number(wall[6] ?? 0),
    }, ET);
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text.trim())) return null; // 不带时区的别的写法:不猜
  const ms = Date.parse(text.trim());
  return Number.isFinite(ms) ? ms : null;
}

const isRecord = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === "object" && !Array.isArray(raw);

/** --entries 文件的内容 → 真实入场。键名写错(qty、price……)、缺项、认不出的时刻当场拒,不悄悄按默认算 */
export function entriesFrom(raw: unknown): RealEntry[] {
  if (!Array.isArray(raw)) throw new SweepError("真实入场的清单要是一个数组");
  return raw.map((item: unknown, i): RealEntry => {
    const where = `真实入场第 ${i + 1} 笔`;
    if (!isRecord(item)) throw new SweepError(`${where}要是一个对象`);
    checkKeys(item, ["time", "center", "wing", "right", "quantity", "debit"], where);
    const t = parseEntryTime(String(item["time"] ?? ""));
    if (t === null) throw new SweepError(`${where}的 time 看不懂:「${String(item["time"])}」(写成美东 "YYYY-MM-DD HH:MM" 或带时区的 ISO)`);
    const center = Number(item["center"]), wing = Number(item["wing"]);
    const right = String(item["right"] ?? "").slice(0, 1).toUpperCase();
    if (!(center > 0) || !(wing > 0) || (right !== "C" && right !== "P")) throw new SweepError(`${where}要有 center、wing(正数)与 right(C / P)`);
    const entry: RealEntry = { t, center, wing, right };
    if (item["quantity"] !== undefined) {
      const quantity = Number(item["quantity"]);
      if (!Number.isInteger(quantity) || quantity < 1) throw new SweepError(`${where}的 quantity 要是正整数`);
      entry.quantity = quantity;
    }
    if (item["debit"] !== undefined) {
      const debit = Number(item["debit"]);
      if (!(debit > 0)) throw new SweepError(`${where}的 debit 要是正数`);
      entry.debit = debit;
    }
    return entry;
  });
}

/** --grid 文件的内容。顶层只认 live / sets / replay;里面的键由 liveSets / replaySets 再查 */
export function gridFileFrom(raw: unknown): { live: LiveGrid; sets: Array<Partial<LiveParams>>; replay: Record<string, Array<number | string>> } {
  if (!isRecord(raw)) throw new SweepError("网格文件要是一个对象:{\"live\":{…},\"sets\":[…],\"replay\":{…}}");
  checkKeys(raw, ["live", "sets", "replay"], "网格文件");
  const live = raw["live"] ?? {}, sets = raw["sets"] ?? [], replay = raw["replay"] ?? {};
  if (!isRecord(live) || !isRecord(replay) || !Array.isArray(sets) || !sets.every(isRecord)) {
    throw new SweepError("网格文件里 live 与 replay 要是对象,sets 要是对象的数组");
  }
  for (const [key, values] of [...Object.entries(live), ...Object.entries(replay)]) {
    if (!Array.isArray(values)) throw new SweepError(`网格文件里 ${key} 的取值要写成数组`);
  }
  return { live: live as LiveGrid, sets: sets as Array<Partial<LiveParams>>, replay: replay as Record<string, Array<number | string>> };
}

export interface FillModel {
  /** 入场价在中间价之上让出半个价差的几成:1 = 立刻买得到的价(两翼卖价、中心买价),0 = 中间价 */
  entry_spread_share: number;
  /** 每张合约每一边的佣金(美元);null = 没给,结果是佣金之前的,追踪的成本里也不含它(见 unitCost) */
  commission: number | null;
  /** 一直没出场的怎么了结:natural = 当天最后一笔的立刻成交价;settle = 记到了收盘的那些天按最后一笔现价的内在价值结算 */
  terminal: "natural" | "settle";
  /** settle 口径下,最后一笔离收盘不超过这么多分钟才算"记到了收盘" */
  settle_within_min: number;
  /** 止损类拿哪个价判(和追踪上的 stop_basis 同一个意思) */
  stop_basis: "mid" | "natural";
  /** 每个情景几组(只影响回放策略里的分批;实盘预设是全平) */
  qty: number;
  multiplier: number;
}

export interface SweepConfig {
  /** 只用这个标的的样本;null = 不挑,但样本里出现两个以上的标的就拒(它们会共用一天的现价与 EM) */
  symbol: string | null;
  population: Population;
  entries: ReadonlyArray<RealEntry> | null;
  fill: FillModel;
  /** 实盘预设要比的各组,第一组是参照组(liveSets 的返回) */
  live: ReadonlyArray<LiveParams>;
  /** 回放策略:不做就是 null。em = auto 时每天从记下来的平值跨式取;给数字就一律用它 */
  replay: { em: number | "auto"; sets: ReadonlyArray<ReplayOverride> } | null;
  /** 隔几笔样本判断一次(1 = 每一笔) */
  stride: number;
}

/**
 * tracker.ts 里要用的那几个纯函数。它归在编排层(depcruise 的 analysis-is-pure 不许分析层 import),所以由调用方递进来;
 * `import * as tracker` 那个模块本身就满足这个形状,脚本与测试递的都是它——判定用的就是实盘那一份。
 */
export interface TrackerRules<P, S> {
  STATE_HOLDING: string;
  makePosition(raw: { account: string; symbol: string; sec_type: string; quantity: number; avg_cost: number; multiplier: number }): P;
  makeTargets(raw: Partial<Targets>): Targets;
  structureOf(secType: string, contract: Record<string, unknown>): S | null;
  legPriceKey(leg: { strike: number; right: string }): string;
  naturalClosePrice(position: P, structure: S, book: Record<string, { bid: number | null; ask: number | null }>): number | null;
  closeTick(position: P): number;
  /** 建追踪时的那道校验:说不通就抛(多头的止损价不低于现价 = 一建就触发,实盘当场拒) */
  validate(position: P, targets: Targets, price: number | null): void;
  evaluate(
    position: P, targets: Targets, price: number | null, peak: number | null, minute: number | null,
    opts?: { stopPrice?: number | null; peakPrice?: number | null },
  ): { state: string; peak: number | null; reason: string };
}

// ---------------------------------------------------------------- 结果
export interface Matrix { r: number[][]; usd: number[][] }

export interface FamilyResult {
  family: "live" | "replay";
  /** 第 0 组是参照组 */
  labels: string[];
  params: ParamRow[];
  days: string[];
  /** 每天多少个情景 */
  scenarios: number[];
  /** [组][天]:那一天全部情景的平均 R(盈亏 ÷ 付出的权利金)与平均每组盈亏(美元) */
  main: Matrix;
  /** 同样的情景,"一直没出场的怎么了结"换成另一种口径 */
  alt_terminal: Matrix;
  /** 同样的情景,隔一笔才判断一次 */
  coarse: Matrix;
  /** 每组各种出场方式的情景数 */
  kinds: Array<Record<string, number>>;
  /** 每组有多少个情景的止损设不上(入场那一刻中间价已经不高于止损价:实盘建追踪时会被拒,回放会在入场那一笔就止损);这些情景按不设止损算 */
  stop_refused: number[];
}

export interface SweepResult {
  data: { days: number; first: string | null; last: string | null; samples: number; used: number; not_same_day: number; other_symbol: number };
  symbol: string | null;
  population: Population;
  fill: FillModel;
  stride: number;
  from_entries: boolean;
  scenarios: number;
  /** 不要的情景,按原因 */
  skipped: Record<string, number>;
  /** 被人群限定筛掉的(不是坏数据) */
  filtered: Record<string, number>;
  /** 这只蝶的三条腿都在样本里、却有一条没报价的笔数 / 总笔数 */
  no_decision: { missing: number; total: number };
  /** 入场价 D 的分布(点) */
  debit: { min: number; median: number; max: number } | null;
  /** 用到的蝶:翼宽 → 几只 */
  wings: Record<string, number>;
  /** 最后一笔离收盘太远的天数(那些天"拿到最后"的情景只能按最后一笔的价了结) */
  short_days: number;
  /**
   * 一个情景里,一组参数最多能比另一组多亏多少——合约条款给的上限,统计拿它当"没见过的那种天"的最坏情形:
   * usd = 最宽的翼宽 × 乘数 + 一次出场的佣金(一边卖在翼宽、另一边归零);r = usd ÷ (入场价的下限 × 乘数),
   * 入场价的下限 = --debit-min,没给就是组合的一跳。一个情景都没有是 null。
   */
  loss_cap: { usd: number; r: number; wing: number; debit_floor: number } | null;
  live: FamilyResult;
  replay: (FamilyResult & { em: { min: number; median: number; max: number } | null; days_without_em: number }) | null;
}
