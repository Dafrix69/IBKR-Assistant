/** 蝶式出场参数的离线扫描(纯计算):拿软件自己记下来的盘口,问"换一组出场参数,过去这些天会怎样"。
 *
 * 只认记下来的腿盘口(ivSamples 那种样本,5 分钟一笔;换算在 flyExitSweepSpec.ts):
 *  · 入场那一笔缺报价的情景不要;之后某一笔缺报价 = 那一笔不判断。两样都数出来。
 *  · 判断只发生在记下来的那几笔上。两笔之间的走法不知道——所以每个情景另跑一遍"隔一笔才判一次",
 *    结论要是经不起这样放粗,就不算结论(flyExitSweepStats.verdictOf)。
 *
 * 出场规则不是另写的一份:
 *  · 实盘的蝶式预设 → tracker.evaluate + trackerExits.withTimeExit。tracker.ts 归在编排层,分析层不许 import 它,
 *    所以那几个纯函数由调用方递进来(TrackerRules;脚本与测试递的都是 tracker 模块本身)。
 *  · 交易分析的回放策略 → flyexit.simulate,喂给它的蝶价全部是记下来的中间价。
 *
 * 这个文件只出"每组参数、每一天"的结果;怎么比、信不信,在 flyExitSweepStats.ts。口径见 docs/features/fly-exit-sweep.md。
 */
import { paramsFrom, simulate } from "./flyexit.js";
import {
  CONTRACTS_PER_FLY, SweepError, bookOf, entryDebit, flyIntrinsic, flyLegs, legKey, liveLabel, liveReference, liveRow,
  liveTargets, quoteFrom, replayLabel, unitCost,
} from "./flyExitSweepSpec.js";
import type {
  Book, FamilyResult, FillModel, FlySpec, LiveParams, Matrix, ParamRow, Population, QuoteSample, RealEntry, ReplayOverride,
  Right, SweepConfig, SweepResult, TrackerRules,
} from "./flyExitSweepSpec.js";
import { builtinCalendar } from "./marketCalendar.js";
import { atmStrike, legMid, makeBand } from "./playbook.js";
import { pyG, pyRound } from "./py.js";
import { sessionSigmaOf } from "./sessionEm.js";
import { clockMinutes, withTimeExit } from "./trackerExits.js";
import { ET, dateStrAt, stampAt, wallParts, wallToEpoch } from "./tz.js";

// ---------------------------------------------------------------- 一天、一只蝶的价路径
interface Day {
  date: string;
  samples: QuoteSample[];
  books: Book[];
  lastSpot: number;
  /** 最后一笔离收盘够近:拿到最后的可以按内在价值结算 */
  reachesClose: boolean;
  early: boolean;
}

interface FlyPath<S> {
  fly: FlySpec;
  structure: S;
  t: number[];
  minute: number[];
  stamp: string[];
  spot: number[];
  mid: Array<number | null>;
  open: Array<number | null>;
  /** tracker.naturalClosePrice:挂上去不用等的平仓价;拿不到或不是正数是 null */
  close: Array<number | null>;
  closeRaw: Array<number | null>;
}

function sessionCloseMs(date: string, early: boolean): number {
  const [y, m, d] = date.split("-").map(Number);
  return wallToEpoch({ year: y ?? 0, month: m ?? 0, day: d ?? 0, hour: early ? 13 : 16, minute: 0, second: 0 }, ET);
}

function dayOf(date: string, all: QuoteSample[], cfg: SweepConfig): Day {
  const samples = all
    .filter((s) => cfg.population.by === "all" || (s.by ?? "loop") === cfg.population.by)
    .sort((a, b) => a.t - b.t);
  const early = builtinCalendar().earlyCloses.includes(date);
  const last = samples[samples.length - 1];
  return {
    date, samples, books: samples.map(bookOf), lastSpot: last?.spot ?? NaN, early,
    reachesClose: last !== undefined && sessionCloseMs(date, early) - last.t <= cfg.fill.settle_within_min * 60_000,
  };
}

/** 这一天的网格上摆得出的全部等翼同向蝶 */
function fliesOf(day: Day, pop: Population): FlySpec[] {
  const strikes: Record<Right, Set<number>> = { C: new Set(), P: new Set() };
  for (const s of day.samples) {
    for (const leg of s.legs) {
      const right = String(leg.right).slice(0, 1).toUpperCase();
      if (right === "C" || right === "P") strikes[right].add(leg.strike);
    }
  }
  const out: FlySpec[] = [];
  for (const right of ["C", "P"] as const) {
    if (pop.rights !== null && !pop.rights.includes(right)) continue;
    const sorted = [...strikes[right]].sort((a, b) => a - b);
    for (const center of sorted) {
      for (const lower of sorted) {
        const wing = pyRound(center - lower, 4);
        if (!(wing > 0) || !strikes[right].has(center + wing)) continue;
        if (pop.wings !== null && !pop.wings.includes(wing)) continue;
        out.push({ center, wing, right });
      }
    }
  }
  return out;
}

function pathOf<P, S>(day: Day, fly: FlySpec, rules: TrackerRules<P, S>, probe: P): FlyPath<S> | null {
  const legs = flyLegs(fly);
  const structure = rules.structureOf("BAG", { secType: "BAG", legs });
  if (structure === null) return null;
  const path: FlyPath<S> = { fly, structure, t: [], minute: [], stamp: [], spot: [], mid: [], open: [], close: [], closeRaw: [] };
  for (const [i, sample] of day.samples.entries()) {
    const book = day.books[i];
    if (book === undefined) continue;
    const q = quoteFrom(book, fly);
    if (!q.listed) continue;
    const wall = wallParts(sample.t, ET);
    const forTracker: Record<string, { bid: number | null; ask: number | null }> = {};
    for (const leg of legs) {
      const raw = book.get(legKey(leg.strike, leg.right));
      forTracker[rules.legPriceKey(leg)] = { bid: raw?.bid ?? null, ask: raw?.ask ?? null };
    }
    path.t.push(sample.t);
    path.minute.push(wall.hour * 60 + wall.minute);
    path.stamp.push(stampAt(sample.t, ET));
    path.spot.push(sample.spot);
    path.mid.push(q.mid);
    path.open.push(q.open);
    path.closeRaw.push(q.close_raw);
    path.close.push(rules.naturalClosePrice(probe, structure, forTracker));
  }
  return path.t.length ? path : null;
}

// ---------------------------------------------------------------- 一个情景怎么收场
interface Scenario<S> { path: FlyPath<S>; k0: number; debit: number; qty: number }
interface Cell { n: number; r: number; usd: number }
const emptyCell = (): Cell => ({ n: 0, r: 0, usd: 0 });
/** 一次出手:平掉几组、什么价、是不是真的成交(结算与归零不收佣金)、怎么出的 */
interface Leg { qty: number; price: number; traded: boolean; kind: string }

/** 触发之后在哪一笔成交:从触发那一笔起、第一笔拿得到立刻成交价的。没有 = 到收盘都没卖掉 */
function fillAt<S>(path: FlyPath<S>, from: number, stride: number): number {
  for (let k = from; k < path.t.length; k += stride) if ((path.close[k] ?? null) !== null) return k;
  return -1;
}

/** 一直没出场(或触发了却一直卖不掉)的:两种了结口径各是多少。natural 取当天最后一笔拿得到盘口的,净价不是正数按 0(留着作废,不倒贴) */
function terminalOf<S>(path: FlyPath<S>, k0: number, day: Day): { natural: Leg; settle: Leg } {
  let value = 0;
  for (let k = path.t.length - 1; k >= k0; k -= 1) {
    if ((path.closeRaw[k] ?? null) === null) continue;
    value = path.close[k] ?? 0;
    break;
  }
  const natural: Leg = { qty: 1, price: value, traded: value > 0, kind: "day_end" };
  const settle: Leg = day.reachesClose
    ? { qty: 1, price: flyIntrinsic(path.fly, day.lastSpot), traded: false, kind: "settle" } : natural;
  return { natural, settle };
}

function pnlOf(legs: Leg[], sc: { debit: number; qty: number }, fill: FillModel): { r: number; usd: number } {
  const fee = fill.commission ?? 0;
  let usd = -fee * CONTRACTS_PER_FLY * sc.qty;
  for (const leg of legs) usd += leg.qty * ((leg.price - sc.debit) * fill.multiplier - (leg.traded ? fee * CONTRACTS_PER_FLY : 0));
  usd /= sc.qty;
  return { r: usd / (sc.debit * fill.multiplier), usd };
}

/**
 * 实盘预设:每一笔样本过一遍 tracker.evaluate(峰值跟着走),再并上到点平仓。回 [配置口径, 另一种了结口径] 的出手。
 * 止损价不低于入场那一刻的中间价时,实盘建追踪会被 tracker.validate 当场拒(一建就触发);这里照样问它,
 * 被拒的情景按不设止损算,refused 记一笔。
 */
function runLive<P, S>(
  sc: Scenario<S>, day: Day, p: LiveParams, fill: FillModel, rules: TrackerRules<P, S>, stride: number, refused: () => void = () => undefined,
): [Leg[], Leg[]] {
  const { path, k0, debit, qty } = sc;
  const cost = unitCost(debit, fill); // 追踪的成本:给了佣金就含佣金,和实盘组合行的 avg_cost 同一个口径
  const position = rules.makePosition({ account: "sweep", symbol: "SPX", sec_type: "BAG", quantity: qty, avg_cost: cost, multiplier: fill.multiplier });
  let targets = rules.makeTargets(liveTargets(p, cost, debit, path.t[k0] ?? 0));
  if (targets.stop_loss !== null) {
    // 按立刻成交价判止损的,建追踪时还多一道:止损价不低于此刻立刻能成交的价也拒(rpc/handlers/tracker.ts 的同一句)
    const natural = fill.stop_basis === "natural" ? path.close[k0] ?? null : null;
    let ok = natural === null || targets.stop_loss < natural;
    try {
      rules.validate(position, targets, path.mid[k0] ?? null);
    } catch {
      ok = false;
    }
    if (!ok) {
      targets = { ...targets, stop_loss: null };
      refused();
    }
  }
  let peak: number | null = null;
  for (let k = k0; k < path.t.length; k += stride) {
    const opts = fill.stop_basis === "natural" ? { stopPrice: path.close[k] ?? null } : {};
    const res: { state: string; peak: number | null } = withTimeExit(
      rules.evaluate(position, targets, path.mid[k] ?? null, peak, path.minute[k] ?? null, opts),
      targets, path.t[k] ?? 0, rules.STATE_HOLDING,
    );
    peak = res.peak;
    if (res.state === rules.STATE_HOLDING) continue;
    const at = fillAt(path, k, stride);
    if (at >= 0) {
      const leg: Leg = { qty, price: path.close[at] ?? 0, traded: true, kind: res.state };
      return [[leg], [leg]];
    }
    const end = terminalOf(path, k0, day);
    return [[{ ...end.natural, qty, kind: "unfilled" }], [{ ...end.settle, qty, kind: "unfilled" }]];
  }
  const end = terminalOf(path, k0, day);
  return [[{ ...end.natural, qty }], [{ ...end.settle, qty }]];
}

/**
 * 回放策略:把记下来的现价与蝶的中间价当成 K 线喂给 flyexit.simulate,再把它的每一次出手换成立刻成交价。
 * 入场那一笔的中间价已经不高于止损线(入场价是立刻买得到的价,比中间价高出半个价差)时,simulate 会在入场那一笔就止损——
 * 那是入场价差造出来的,不是行情。和实盘预设同一个办法:这种情景按不设价格止损算(止损线挪到碰不到的地方),refused 记一笔。
 */
function runReplay<S>(
  sc: Scenario<S>, day: Day, override: ReplayOverride, em: number, fill: FillModel, stride: number, refused: () => void = () => undefined,
): [Leg[], Leg[]] | null {
  const { path, k0, debit, qty } = sc;
  const spx: Array<{ time: string; close: number }> = [];
  const flyBars: Array<{ time: string; close: number }> = [];
  const index = new Map<string, number>();
  for (let k = k0; k < path.t.length; k += stride) {
    const mid = path.mid[k] ?? null, time = path.stamp[k] ?? "";
    if (mid === null || index.has(time)) continue; // 缺报价的那一笔不给它:给了它会拿模型价补
    index.set(time, k);
    spx.push({ time, close: path.spot[k] ?? NaN });
    flyBars.push({ time, close: mid });
  }
  const profile = {
    lower: path.fly.center - path.fly.wing, center: path.fly.center, upper: path.fly.center + path.fly.wing,
    width: path.fly.wing, right: path.fly.right, action: "BUY", debit, qty, multiplier: fill.multiplier,
  };
  const params: Record<string, number | string | null> = paramsFrom({ ...override, em });
  if ((path.mid[k0] ?? Infinity) <= Number(params["stop"]) * debit) {
    params["stop"] = -1; // 蝶价不会是负数:这条线永远碰不到
    refused();
  }
  const sim = simulate(profile, path.stamp[k0] ?? "", spx, flyBars, params);
  if (!sim.applicable) return null;
  if (sim.totals.model_minutes !== 0) throw new SweepError("回放用到了模型价:喂进去的每一笔都该带着记下来的蝶价");
  const end = terminalOf(path, k0, day);
  const main: Leg[] = [], alt: Leg[] = [];
  for (const e of sim.events) {
    const n = Number(e["qty"]);
    const k = String(e["source"]) === "real" ? index.get(String(e["time"])) : undefined;
    const at = k === undefined ? -1 : fillAt(path, k, stride);
    if (at >= 0) {
      // 规则那句话里全角冒号之前的是它的名字("止损"、"回撤追踪"、"阶段 B"、"进入 14:00 过渡"……)
      const leg: Leg = { qty: n, price: path.close[at] ?? 0, traded: true, kind: String(e["rule"]).split(":")[0] ?? "" };
      main.push(leg);
      alt.push(leg);
    } else {
      const kind = k === undefined ? undefined : "unfilled";
      main.push({ ...end.natural, qty: n, ...(kind ? { kind } : {}) });
      alt.push({ ...end.settle, qty: n, ...(kind ? { kind } : {}) });
    }
  }
  return [main, alt];
}

// ---------------------------------------------------------------- 情景
/** 这一天最早一笔取得到平值跨式的样本 → 常规时段全天的 1σ(和交易分析回放从剧本底账取的是同一个式子),以及它是哪一刻取到的 */
function emOf(day: Day): { em: number; t: number } | null {
  if (day.early) return null; // flyexit 的日内分布是照 16:00 收盘估的
  for (const [i, s] of day.samples.entries()) {
    const strike = atmStrike(s.spot), book = day.books[i];
    const call = book?.get(legKey(strike, "C")), put = book?.get(legKey(strike, "P"));
    const c = call ? legMid(call) : null, p = put ? legMid(put) : null;
    if (c === null || p === null) continue;
    const band = makeBand({ at: s.t, anchor: s.spot, strike, expiry: day.date.replace(/-/g, ""), call: c, put: p, source: "live" });
    const em = band === null ? null : sessionSigmaOf(band);
    if (em !== null) return { em, t: s.t };
  }
  return null;
}

interface Tally { skipped: Record<string, number>; filtered: Record<string, number>; missing: number; total: number; debits: number[]; wings: Record<string, number> }
const bump = (bag: Record<string, number>, key: string): void => { bag[key] = (bag[key] ?? 0) + 1; };

function gridScenarios<P, S>(day: Day, cfg: SweepConfig, rules: TrackerRules<P, S>, probe: P, tally: Tally): Scenario<S>[] {
  const pop = cfg.population, tick = rules.closeTick(probe);
  const from = pop.entry_from === null ? null : clockMinutes(pop.entry_from), to = pop.entry_to === null ? null : clockMinutes(pop.entry_to);
  const out: Scenario<S>[] = [];
  for (const fly of fliesOf(day, pop)) {
    const path = pathOf(day, fly, rules, probe);
    if (path === null) continue;
    tally.total += path.t.length;
    tally.missing += path.mid.filter((m) => m === null).length;
    let used = false;
    for (let k = 0; k < path.t.length; k += 1) {
      const minute = path.minute[k] ?? 0;
      if ((from !== null && minute < from) || (to !== null && minute > to)) { bump(tally.filtered, "入场时刻不在窗口里"); continue; }
      if (k === path.t.length - 1) { bump(tally.skipped, "入场之后当天没有样本了"); continue; }
      const mid = path.mid[k] ?? null, open = path.open[k] ?? null;
      if (mid === null || open === null) { bump(tally.skipped, "入场那一笔缺报价"); continue; }
      const debit = entryDebit(mid, open, cfg.fill.entry_spread_share, tick);
      if (!(debit > 0)) { bump(tally.skipped, "入场价不是正数"); continue; }
      if ((pop.debit_min !== null && debit < pop.debit_min) || (pop.debit_max !== null && debit > pop.debit_max)) { bump(tally.filtered, "入场价不在范围里"); continue; }
      const dist = fly.right === "C" ? fly.center - (path.spot[k] ?? NaN) : (path.spot[k] ?? NaN) - fly.center;
      if ((pop.dist_min !== null && dist < pop.dist_min) || (pop.dist_max !== null && dist > pop.dist_max)) { bump(tally.filtered, "中心离现价不在范围里"); continue; }
      out.push({ path, k0: k, debit, qty: cfg.fill.qty });
      tally.debits.push(debit);
      used = true;
    }
    if (used) bump(tally.wings, pyG(fly.wing));
  }
  return out;
}

function entryScenarios<P, S>(day: Day, entries: ReadonlyArray<RealEntry>, cfg: SweepConfig, rules: TrackerRules<P, S>, probe: P, tally: Tally): Scenario<S>[] {
  const out: Scenario<S>[] = [];
  for (const e of entries) {
    const fly: FlySpec = { center: e.center, wing: e.wing, right: e.right };
    const path = pathOf(day, fly, rules, probe);
    if (path === null) { bump(tally.skipped, "记下来的行权价里摆不出这只蝶"); continue; }
    const k = path.t.findIndex((t) => t >= e.t);
    if (k < 0 || k === path.t.length - 1) { bump(tally.skipped, "入场之后当天没有样本了"); continue; }
    const mid = path.mid[k] ?? null, open = path.open[k] ?? null;
    if (mid === null || open === null) { bump(tally.skipped, "入场那一笔缺报价"); continue; }
    const debit = e.debit ?? entryDebit(mid, open, cfg.fill.entry_spread_share, rules.closeTick(probe));
    if (!(debit > 0)) { bump(tally.skipped, "入场价不是正数"); continue; }
    tally.total += path.t.length - k;
    tally.missing += path.mid.slice(k).filter((m) => m === null).length;
    out.push({ path, k0: k, debit, qty: e.quantity ?? cfg.fill.qty });
    tally.debits.push(debit);
    bump(tally.wings, pyG(fly.wing));
  }
  return out;
}

// ---------------------------------------------------------------- 扫描
function checkConfig(cfg: SweepConfig): void {
  const f = cfg.fill, pop = cfg.population;
  if (!(f.entry_spread_share >= 0 && f.entry_spread_share <= 1)) throw new SweepError("入场让出价差的份额要在 0 到 1 之间");
  if (f.commission !== null && !(f.commission >= 0)) throw new SweepError("佣金不能为负");
  if (!(f.qty >= 1) || !Number.isInteger(f.qty)) throw new SweepError("每个情景的组数要是正整数");
  if (!(f.multiplier > 0) || !(f.settle_within_min >= 0)) throw new SweepError("乘数要是正数,离收盘的分钟数不能为负");
  if (!Number.isInteger(cfg.stride) || cfg.stride < 1) throw new SweepError("判断间隔(隔几笔样本判一次)要是正整数");
  for (const clock of [pop.entry_from, pop.entry_to]) {
    if (clock !== null && clockMinutes(clock) === null) throw new SweepError(`入场时刻要写成 "HH:MM",收到 ${clock}`);
  }
  if (!cfg.live.length) throw new SweepError("至少要有参照组");
}

const spread = (xs: number[]): { min: number; median: number; max: number } | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return { min: s[0] ?? NaN, median: s.length % 2 ? s[mid] ?? NaN : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2, max: s[s.length - 1] ?? NaN };
};

class Family {
  readonly days: string[] = [];
  readonly scenarios: number[] = [];
  private readonly mats: Matrix[];
  readonly kinds: Array<Record<string, number>>;
  readonly stopRefused: number[];
  private cells: Cell[][] = [];

  constructor(private readonly sets: number) {
    this.mats = [0, 1, 2].map(() => ({ r: Array.from({ length: sets }, () => []), usd: Array.from({ length: sets }, () => []) }));
    this.kinds = Array.from({ length: sets }, () => ({}));
    this.stopRefused = Array.from({ length: sets }, () => 0);
  }

  open(): void {
    this.cells = [0, 1, 2].map(() => Array.from({ length: this.sets }, emptyCell));
  }

  /** which:0 = 配置口径,1 = 另一种了结口径,2 = 放粗一倍 */
  add(which: number, set: number, legs: Leg[], sc: { debit: number; qty: number }, fill: FillModel): void {
    const cell = this.cells[which]?.[set];
    if (cell === undefined) return;
    const { r, usd } = pnlOf(legs, sc, fill);
    cell.n += 1;
    cell.r += r;
    cell.usd += usd;
    const last = legs[legs.length - 1], bag = this.kinds[set];
    if (which === 0 && last !== undefined && bag !== undefined) bump(bag, last.kind);
  }

  close(date: string): void {
    const n = this.cells[0]?.[0]?.n ?? 0;
    if (!n) return;
    this.days.push(date);
    this.scenarios.push(n);
    for (const [which, mat] of this.mats.entries()) {
      for (let set = 0; set < this.sets; set += 1) {
        const cell = this.cells[which]?.[set] ?? emptyCell();
        mat.r[set]?.push(cell.n ? cell.r / cell.n : NaN);
        mat.usd[set]?.push(cell.n ? cell.usd / cell.n : NaN);
      }
    }
  }

  result(family: "live" | "replay", labels: string[], params: ParamRow[]): FamilyResult {
    const [main, alt, coarse] = this.mats;
    const empty: Matrix = { r: [], usd: [] };
    return {
      family, labels, params, days: this.days, scenarios: this.scenarios,
      main: main ?? empty, alt_terminal: alt ?? empty, coarse: coarse ?? empty, kinds: this.kinds, stop_refused: this.stopRefused,
    };
  }
}

/**
 * 把样本按美东日期分开。带着到期日、却不是当日到期的那几笔不用;别的标的的也不用(都数出来)。
 * 没指定标的、样本里却有两个以上:拒——它们会被当成同一天的同一批盘口,共用最后一笔现价与 EM。
 */
function byDate(samples: ReadonlyArray<QuoteSample>, symbol: string | null): { days: Map<string, QuoteSample[]>; notSameDay: number; otherSymbol: number } {
  const days = new Map<string, QuoteSample[]>();
  const seen = new Set(samples.flatMap((s) => (s.symbol === undefined ? [] : [s.symbol])));
  if (symbol === null && seen.size > 1) throw new SweepError(`样本里有 ${[...seen].sort().join("、")} 几个标的:一次只扫一个,用 symbol 选一个`);
  let notSameDay = 0, otherSymbol = 0;
  for (const s of samples) {
    if (symbol !== null && s.symbol !== undefined && s.symbol !== symbol) { otherSymbol += 1; continue; }
    const date = dateStrAt(s.t, ET);
    if (s.expiry !== undefined && s.expiry !== date.replace(/-/g, "")) { notSameDay += 1; continue; }
    const list = days.get(date) ?? [];
    list.push(s);
    days.set(date, list);
  }
  return { days, notSameDay, otherSymbol };
}

/** onDay:每算完一天叫一次(脚本拿它报进度;整段是同步的,数据多时要跑几分钟) */
export function runSweep<P, S>(
  samples: ReadonlyArray<QuoteSample>, cfg: SweepConfig, rules: TrackerRules<P, S>,
  onDay: (date: string, done: number, total: number) => void = () => undefined,
): SweepResult {
  checkConfig(cfg);
  const { days, notSameDay, otherSymbol } = byDate(samples, cfg.symbol ?? null);
  const dates = [...days.keys()].sort();
  const probe = rules.makePosition({ account: "sweep", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 0, multiplier: cfg.fill.multiplier });
  const tally: Tally = { skipped: {}, filtered: {}, missing: 0, total: 0, debits: [], wings: {} };
  const live = new Family(cfg.live.length);
  const replay = cfg.replay === null ? null : new Family(cfg.replay.sets.length);
  const ems: number[] = [];
  let used = 0, total = 0, shortDays = 0, withoutEm = 0;
  const altOf = (pair: [Leg[], Leg[]]): [Leg[], Leg[]] => (cfg.fill.terminal === "natural" ? pair : [pair[1], pair[0]]);

  for (const e of cfg.entries ?? []) if (!days.has(dateStrAt(e.t, ET))) bump(tally.skipped, "那一天没有记下样本");
  for (const date of dates) {
    const day = dayOf(date, days.get(date) ?? [], cfg);
    const mine = cfg.entries === null ? null : cfg.entries.filter((e) => dateStrAt(e.t, ET) === date);
    if (!day.samples.length) {
      for (let i = 0; i < (mine?.length ?? 0); i += 1) bump(tally.skipped, "那一天没有记下样本");
      continue;
    }
    used += day.samples.length;
    if (mine !== null && !mine.length) continue;
    const scenarios = mine === null ? gridScenarios(day, cfg, rules, probe, tally) : entryScenarios(day, mine, cfg, rules, probe, tally);
    if (!scenarios.length) continue;
    total += scenarios.length;
    if (!day.reachesClose) shortDays += 1;
    const em = cfg.replay === null ? null : cfg.replay.em === "auto" ? emOf(day) : day.early ? null : { em: cfg.replay.em, t: -Infinity };
    if (cfg.replay !== null && em === null) withoutEm += 1;
    if (em !== null) ems.push(em.em);

    live.open();
    replay?.open();
    for (const sc of scenarios) {
      for (const [i, p] of cfg.live.entries()) {
        const [main, alt] = altOf(runLive(sc, day, p, cfg.fill, rules, cfg.stride, () => { live.stopRefused[i] = (live.stopRefused[i] ?? 0) + 1; }));
        live.add(0, i, main, sc, cfg.fill);
        live.add(1, i, alt, sc, cfg.fill);
        live.add(2, i, altOf(runLive(sc, day, p, cfg.fill, rules, cfg.stride * 2))[0], sc, cfg.fill);
      }
      if (cfg.replay === null || replay === null || em === null) continue;
      // EM 是当天晚些时候才取到的:拿它去回放更早的入场,等于用了入场时还不知道的东西
      if ((sc.path.t[sc.k0] ?? 0) < em.t) { bump(tally.skipped, "回放:入场早于当天取到 EM 的那一笔"); continue; }
      // 回放不适用的情景(simulate 说 applicable = false)对每一组都不适用:要么全算、要么全不算
      const runs = cfg.replay.sets.map((o, i) => [
        runReplay(sc, day, o, em.em, cfg.fill, cfg.stride, () => { replay.stopRefused[i] = (replay.stopRefused[i] ?? 0) + 1; }),
        runReplay(sc, day, o, em.em, cfg.fill, cfg.stride * 2),
      ] as const);
      if (runs.some(([fine, coarse]) => fine === null || coarse === null)) { bump(tally.skipped, "回放策略不适用"); continue; }
      for (const [i, [fine, coarse]] of runs.entries()) {
        if (fine === null || coarse === null) continue;
        const [main, alt] = altOf(fine);
        replay.add(0, i, main, sc, cfg.fill);
        replay.add(1, i, alt, sc, cfg.fill);
        replay.add(2, i, altOf(coarse)[0], sc, cfg.fill);
      }
    }
    live.close(date);
    replay?.close(date);
    onDay(date, dates.indexOf(date) + 1, dates.length);
  }

  const reference = cfg.live[0] ?? liveReference();
  // 合约条款给的上限:一边卖在翼宽、另一边归零。入场价的下限是人群限定里给的,没给(或是真实入场)就是组合的一跳
  const wing = Math.max(0, ...Object.keys(tally.wings).map(Number));
  const tick = rules.closeTick(probe);
  const debitFloor = cfg.entries === null ? Math.max(cfg.population.debit_min ?? 0, tick) : tick;
  const capUsd = wing * cfg.fill.multiplier + CONTRACTS_PER_FLY * (cfg.fill.commission ?? 0);
  const lossCap = wing > 0 ? { usd: capUsd, r: capUsd / (debitFloor * cfg.fill.multiplier), wing, debit_floor: debitFloor } : null;
  const replayResult = cfg.replay === null || replay === null ? null : {
    ...replay.result("replay", cfg.replay.sets.map(replayLabel), cfg.replay.sets.map((o) => ({ ...o }))),
    em: spread(ems), days_without_em: withoutEm,
  };
  return {
    data: {
      days: dates.length, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null, samples: samples.length, used,
      not_same_day: notSameDay, other_symbol: otherSymbol,
    },
    symbol: cfg.symbol ?? null, population: cfg.population, fill: cfg.fill, stride: cfg.stride, from_entries: cfg.entries !== null,
    scenarios: total, skipped: tally.skipped, filtered: tally.filtered,
    no_decision: { missing: tally.missing, total: tally.total },
    debit: spread(tally.debits), wings: tally.wings, short_days: shortDays, loss_cap: lossCap,
    live: live.result("live", cfg.live.map((p) => liveLabel(p, reference)), cfg.live.map(liveRow)),
    replay: replayResult,
  };
}
