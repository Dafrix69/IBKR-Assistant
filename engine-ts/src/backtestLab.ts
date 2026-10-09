/**
 * 参数扫描 + 样本外 + 滚动前推(docs/features/backtest-lab.md)。
 *
 * 单次回测给的是"这组参数在这段行情上的样子";挑一组最好看的参数再说它好,是回测里最常见的自欺。
 * 这里把区间切成样本内 / 样本外:参数只在样本内挑,成绩看样本外;再做滚动前推(anchored walk-forward),
 * 每一折只用"当时已经有的数据"选参数、跑下一段,连起来的收益是这张表里唯一不偷看未来的数。
 * 多只标的一起扫时,每组参数的得分取各只的平均——只在一只上好看的参数多半是巧合。
 *
 * 挑出来的那一组到底是本事还是运气,这里不下结论(那需要一条拍脑袋的线),只把能算准的摆出来:样本内第一名在样本外
 * 排第几、随手挑一组不比它差的概率、样本内外排名的秩相关和它的置换 p 值、全部组合样本外收益的中位数。
 *
 * 纯计算,离线可跑:日线由调用方取好传进来。信号、持仓、期权用的波动率都在整段上算一次,再按下标切
 * (指标都是因果的,见 backtest.signalPositions;成交在下一根开盘,见 backtest.heldAfterOpen)。
 */
import {
  BacktestError, STRATEGIES, evaluateSegment, heldAfterOpen, signalPositions, trailingSessionShare, trailingVol,
} from "./backtest.js";
import type { Bar } from "./backtest.js";
import type {
  BacktestInstrument, BacktestReport, BacktestSweepResult, SegmentStats, SweepObjective, SweepRow, WalkForward,
} from "./contract/backtest.js";
import { pyRound } from "./py.js";

export const MAX_SYMBOLS = 8;
export const MAX_COMBOS = 200;
/** 组合数 × 标的数的上限:期权品种每根日线都要按 BS 估一遍,再多界面就要等半天 */
export const MAX_RUNS = 800;
export const MAX_VALUES_PER_PARAM = 20;
/** 一段至少多少根日线才评:太短的段,一两笔交易就决定了排名 */
export const MIN_SEGMENT_BARS = 20;
/** 置换检验抽多少次。只决定 p 值的分辨率(最小 1 ÷ (次数 + 1)),不进任何判定 */
export const PERMUTATION_DRAWS = 9999;
/** 不满这么多天的段,年化是外推出来的:"年化"的单位就是一年 */
const YEAR_DAYS = 365;

export interface SweepInput {
  series: Array<{ symbol: string; bars: Bar[] }>;
  strategy: string;
  grid: Record<string, number[]>;
  instrument: BacktestInstrument;
  costPct: number;
  /** 样本内占比 50~90 */
  splitPct: number;
  /** 0 = 不做前推;2~6 */
  folds: number;
  objective: SweepObjective;
}

/** 参数网格 → 全部组合(键按网格里的次序,值按给的次序)。 */
export function gridCombos(grid: Record<string, number[]>): Array<Record<string, number>> {
  let out: Array<Record<string, number>> = [{}];
  for (const [key, values] of Object.entries(grid)) {
    const next: Array<Record<string, number>> = [];
    for (const combo of out) for (const v of values) next.push({ ...combo, [key]: v });
    out = next;
  }
  return out;
}

/** 几只标的只留大家都有的那些交易日,切出来的段才对得齐。 */
export function alignSeries(series: Array<{ symbol: string; bars: Bar[] }>): Array<{ symbol: string; bars: Bar[] }> {
  if (series.length <= 1) return series;
  const [first, ...rest] = series.map((s) => new Set(s.bars.map((b) => b.date)));
  const common = new Set([...(first ?? [])].filter((d) => rest.every((set) => set.has(d))));
  return series.map((s) => ({ symbol: s.symbol, bars: s.bars.filter((b) => common.has(b.date)) }));
}

function statsOf(r: BacktestReport): SegmentStats {
  const dd = Math.abs(r.max_drawdown_pct);
  const day = r.held_day_move_pct ?? 0;
  // 回撤下限:在场时的单日波动 × √在场天数,也就是在场那些天单日变动的平方和开根号——和最大回撤量的是同一段时间里的起落。
  // 只拿"一天的波动"当下限,是拿一天去比多天的回撤:进场一两次、运气好的组会排到有真实回撤记录的组前面
  const floor = day * Math.sqrt(r.held_days);
  const risk = Math.max(dd, floor);
  return {
    days: r.days,
    return_pct: r.total_return_pct,
    annualized_pct: r.annualized_pct,
    max_drawdown_pct: r.max_drawdown_pct,
    calmar: dd > 0 ? pyRound(r.annualized_pct / dd, 2) : null,
    // 一直空仓:收益 0、回撤 0、没有持仓日 → 0(不交易比亏钱强,比赚钱差)
    return_over_dd: risk > 0 ? pyRound(r.total_return_pct / risk, 4) : 0,
    dd_floored: floor > dd,
    dd_under_one_day: day > dd,
    sharpe: r.sharpe,
    trades: r.trades,
    win_rate_pct: r.win_rate_pct,
    bench_return_pct: r.buy_hold_return_pct,
    excess_return_pct: r.excess_return_pct,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 几只标的同一段的成绩取平均。笔数是合计,胜率按有已平仓交易的那些平均。 */
function averageStats(list: SegmentStats[]): SegmentStats {
  const calmars = list.map((s) => s.calmar).filter((c): c is number => c !== null);
  const sharpes = list.map((s) => s.sharpe).filter((c): c is number => c !== null);
  const wins = list.map((s) => s.win_rate_pct).filter((w): w is number => w !== null);
  const ret = pyRound(mean(list.map((s) => s.return_pct)), 2);
  const bench = pyRound(mean(list.map((s) => s.bench_return_pct)), 2);
  return {
    days: list[0]?.days ?? 0,
    return_pct: ret,
    annualized_pct: pyRound(mean(list.map((s) => s.annualized_pct)), 2),
    max_drawdown_pct: pyRound(mean(list.map((s) => s.max_drawdown_pct)), 2),
    calmar: calmars.length === list.length && list.length ? pyRound(mean(calmars), 2) : null,
    return_over_dd: pyRound(mean(list.map((s) => s.return_over_dd)), 4),
    dd_floored: list.some((s) => s.dd_floored),
    dd_under_one_day: list.some((s) => s.dd_under_one_day),
    sharpe: sharpes.length === list.length && list.length ? pyRound(mean(sharpes), 2) : null,
    trades: list.reduce((a, s) => a + s.trades, 0),
    win_rate_pct: wins.length ? pyRound(mean(wins), 1) : null,
    bench_return_pct: bench,
    excess_return_pct: pyRound(ret - bench, 2),
  };
}

/**
 * 得分:总收益,或收益回撤比(return_over_dd)。后者是 Calmar 的不年化版本:同一段里各组的天数相同,年化只是同一个
 * 换算,而二十几根日线外推成一年会把高收益的组放大得不成比例;回撤设了下限(在场时的单日波动 × √在场天数),
 * 所以没有"回撤为 0、比不了"的情况,排名里只有一种量纲。
 */
export function scoreOf(s: SegmentStats, objective: SweepObjective): number {
  return objective === "return" ? s.return_pct : s.return_over_dd;
}

/** 秩,同分取平均秩。 */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const out = new Array<number>(xs.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[k]!.v) j += 1;
    const r = (k + j) / 2 + 1;
    for (let t = k; t <= j; t += 1) out[idx[t]!.i] = r;
    k = j + 1;
  }
  return out;
}

/** 两列数各自的秩减去均值;样本不到 3 个、长度不等或一边全是同一个数时是 null。 */
function centredRanks(a: number[], b: number[]): { ra: number[]; rb: number[]; da: number; db: number } | null {
  if (a.length !== b.length || a.length < 3) return null;
  const centre = (xs: number[]): number[] => {
    const r = ranks(xs);
    const m = mean(r);
    return r.map((v) => v - m);
  };
  const ra = centre(a);
  const rb = centre(b);
  const da = ra.reduce((acc, v) => acc + v * v, 0);
  const db = rb.reduce((acc, v) => acc + v * v, 0);
  return da === 0 || db === 0 ? null : { ra, rb, da, db };
}

function dot(a: number[], b: number[]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += a[i]! * b[i]!;
  return acc;
}

/** Spearman 秩相关;样本不到 3 个或一边全是同一个数时是 null。同分取平均秩。 */
export function spearman(a: number[], b: number[]): number | null {
  const c = centredRanks(a, b);
  return c === null ? null : pyRound(dot(c.ra, c.rb) / Math.sqrt(c.da * c.db), 2);
}

/** mulberry32:置换检验用的确定性伪随机数,同样的输入永远给同样的 p 值。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spearman 秩相关的单侧 p 值(置换检验):把 b 的次序随机打乱 draws 次,相关不低于实际值的占多少,
 * p = (1 + 次数) ÷ (1 + draws)。问的是"两列的排名毫无关系时,碰巧这么高的概率";不靠正态近似,同分、组数少都成立。
 * spearman 是 null 时也是 null。
 */
export function spearmanP(a: number[], b: number[], draws = PERMUTATION_DRAWS): number | null {
  const c = centredRanks(a, b);
  if (c === null) return null;
  const observed = dot(c.ra, c.rb);
  const tolerance = 1e-9 * Math.sqrt(c.da * c.db);
  // 种子只跟组数有关:同一次扫描重跑,p 值一位不变
  const random = seededRandom(a.length);
  const shuffled = [...c.rb];
  let atLeast = 0;
  for (let d = 0; d < draws; d += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    if (dot(c.ra, shuffled) >= observed - tolerance) atLeast += 1;
  }
  return pyRound((1 + atLeast) / (1 + draws), 4);
}

/** 校验网格:参数名要是这个策略的、取值是正数、每个参数最多 20 个值、组合总数封顶。报人话。 */
export function checkGrid(strategy: string, grid: Record<string, number[]>, symbols: number): void {
  const meta = STRATEGIES[strategy];
  if (meta === undefined) throw new BacktestError(`未知策略:${strategy}`);
  if (strategy === "custom" || strategy === "buy_hold") {
    throw new BacktestError(`「${meta.label}」没有参数可扫,选一个带参数的策略`);
  }
  const keys = Object.keys(grid);
  if (!keys.length) throw new BacktestError("参数网格是空的:至少给一个参数、两个以上的取值");
  for (const key of keys) {
    if (!(key in meta.params)) {
      throw new BacktestError(`策略 ${strategy} 没有参数 ${key}(可扫:${Object.keys(meta.params).join("、")})`);
    }
    const values = grid[key]!;
    if (!values.length) throw new BacktestError(`参数 ${key} 没有给取值`);
    if (values.length > MAX_VALUES_PER_PARAM) throw new BacktestError(`参数 ${key} 最多试 ${MAX_VALUES_PER_PARAM} 个取值`);
  }
  const combos = keys.reduce((n, k) => n * grid[k]!.length, 1);
  if (combos > MAX_COMBOS) throw new BacktestError(`组合太多:${combos} 组,最多 ${MAX_COMBOS} 组。少给几个取值`);
  if (combos * symbols > MAX_RUNS) {
    throw new BacktestError(`组合 × 标的 = ${combos * symbols},最多 ${MAX_RUNS}。少扫几只或少给几个取值`);
  }
}

interface ComboRun {
  params: Record<string, number>;
  /** 每只标的在整段上的日线、每根收盘时的持仓、实际参数,以及(期权品种才有的)逐日波动率 */
  runs: Array<{ bars: Bar[]; held: number[]; used: Record<string, number>; option: OptionSeries | undefined }>;
}

/** 期权品种估价要的两条逐日序列:只跟日线有关,和参数无关,一只标的算一次。 */
interface OptionSeries {
  vol: Array<number | null>;
  sessionShare: Array<number | null>;
}

/** 结算 [lo, hi) 这一截:lo 那一根是起点,它收盘时的持仓决定下一根的涨跌算不算。 */
function segment(run: ComboRun, lo: number, hi: number, input: SweepInput): SegmentStats {
  return averageStats(run.runs.map((r) => statsOf(evaluateSegment({
    bars: r.bars, held: r.held, strategy: input.strategy, params: r.used, inst: input.instrument,
    costPct: input.costPct, lo, hi, vol: r.option?.vol, sessionShare: r.option?.sessionShare,
  }))));
}

function walkForward(valid: ComboRun[], n: number, dates: string[], input: SweepInput): WalkForward | null {
  const k = input.folds;
  if (!(k >= 2) || !valid.length) return null;
  const cuts: number[] = [];
  for (let j = 1; j <= k + 1; j += 1) cuts.push(Math.floor((n * j) / (k + 1)));
  const folds: WalkForward["folds"] = [];
  let chain = 1;
  let bench = 1;
  for (let j = 0; j < k; j += 1) {
    const trainEnd = cuts[j]!;
    const testEnd = j + 1 < cuts.length ? cuts[j + 1]! : n;
    if (trainEnd < MIN_SEGMENT_BARS || testEnd - trainEnd < MIN_SEGMENT_BARS) continue;
    let best: ComboRun | null = null;
    let bestScore = -Infinity;
    let bestTrain: SegmentStats | null = null;
    for (const run of valid) {
      const train = segment(run, 0, trainEnd, input);
      const sc = scoreOf(train, input.objective);
      if (sc > bestScore) {
        bestScore = sc;
        best = run;
        bestTrain = train;
      }
    }
    if (best === null || bestTrain === null) continue;
    // 按总收益挑的时候得分里没有回撤,这两个标记无从谈起
    const byDrawdown = input.objective === "calmar";
    // 测试段从训练段最后一根起:那一根收盘时的持仓决定测试段第一天的涨跌算不算
    const test = segment(best, trainEnd - 1, testEnd, input);
    chain *= 1 + test.return_pct / 100;
    bench *= 1 + test.bench_return_pct / 100;
    folds.push({
      train_end: dates[trainEnd - 1]!, test_start: dates[trainEnd]!, test_end: dates[testEnd - 1]!,
      params: best.params,
      dd_floored: byDrawdown && bestTrain.dd_floored, dd_under_one_day: byDrawdown && bestTrain.dd_under_one_day,
      test_return_pct: test.return_pct, bench_return_pct: test.bench_return_pct,
    });
  }
  if (!folds.length) return null;
  return { folds, total_return_pct: pyRound((chain - 1) * 100, 2), bench_return_pct: pyRound((bench - 1) * 100, 2) };
}

export function runSweep(input: SweepInput): BacktestSweepResult {
  if (!input.series.length) throw new BacktestError("没有标的");
  if (input.series.length > MAX_SYMBOLS) throw new BacktestError(`一次最多扫 ${MAX_SYMBOLS} 只`);
  if (!(input.splitPct >= 50 && input.splitPct <= 90)) throw new BacktestError("样本内占比要在 50%~90% 之间");
  if (!(input.folds === 0 || (Number.isInteger(input.folds) && input.folds >= 2 && input.folds <= 6))) {
    throw new BacktestError("滚动前推的折数要是 2~6(不做填 0)");
  }
  checkGrid(input.strategy, input.grid, input.series.length);
  const series = alignSeries(input.series);
  const n = series[0]!.bars.length;
  if (n < MIN_SEGMENT_BARS * 2) {
    throw new BacktestError(`几只标的共同的交易日只有 ${n} 天,切不出样本内外(至少 ${MIN_SEGMENT_BARS * 2} 天)`);
  }
  const split = Math.floor((n * input.splitPct) / 100);
  if (split < MIN_SEGMENT_BARS || n - split < MIN_SEGMENT_BARS) {
    throw new BacktestError(`样本内 ${split} 天、样本外 ${n - split} 天,每段至少 ${MIN_SEGMENT_BARS} 天`);
  }
  const dates = series[0]!.bars.map((b) => b.date);

  const combos = gridCombos(input.grid);
  const options: Array<OptionSeries | undefined> = series.map((s) => (input.instrument.type === "stock"
    ? undefined
    : { vol: trailingVol(s.bars.map((b) => b.close)), sessionShare: trailingSessionShare(s.bars) }));
  const skipped: BacktestSweepResult["skipped"] = [];
  const valid: ComboRun[] = [];
  for (const params of combos) {
    try {
      const runs = series.map((s, k) => {
        const { positions, usedParams } = signalPositions(s.bars, input.strategy, params, null);
        return { bars: s.bars, held: heldAfterOpen(positions), used: usedParams, option: options[k] };
      });
      valid.push({ params, runs });
    } catch (exc) {
      if (!(exc instanceof BacktestError)) throw exc;
      skipped.push({ params, reason: exc.message });
    }
  }

  const scored = valid.map((run) => {
    const is = segment(run, 0, split, input);
    const oos = segment(run, split - 1, n, input);
    return { run, is, oos, score: pyRound(scoreOf(is, input.objective), 4), oosScore: scoreOf(oos, input.objective) };
  });
  const ordered = [...scored].sort((a, b) => b.score - a.score);
  const rows: SweepRow[] = ordered.map((x) => ({
    params: x.run.params, score: x.score, is: x.is, oos: x.oos,
    oos_rank: 1 + scored.filter((y) => y.oosScore > x.oosScore).length,
  }));
  const top = ordered[0] ?? null;
  const best = rows[0] ?? null;
  const isScores = scored.map((x) => x.score);
  const oosScores = scored.map((x) => x.oosScore);
  const rankCorr = spearman(isScores, oosScores);
  const rankCorrP = rankCorr === null ? null : spearmanP(isScores, oosScores);
  const pickP = top === null ? null : pyRound(scored.filter((y) => y.oosScore >= top.oosScore).length / scored.length, 4);
  const oosMedian = median(scored.map((x) => x.oos.return_pct));
  const wf = walkForward(valid, n, dates, input);

  return {
    strategy: input.strategy,
    symbols: series.map((s) => s.symbol),
    objective: input.objective,
    cost_pct: input.costPct,
    instrument: input.instrument,
    start: dates[0]!,
    end: dates[n - 1]!,
    split_date: dates[split]!,
    combos: combos.length,
    skipped,
    ranked: scored.length,
    rows: rows.slice(0, 20),
    best,
    rank_corr: rankCorr,
    rank_corr_p: rankCorrP,
    pick_p: pickP,
    oos_median_return_pct: oosMedian === null ? null : pyRound(oosMedian, 2),
    walk_forward: wf,
    notes: sweepNotes(input, { best, ranked: scored.length, rankCorr, rankCorrP, pickP, symbols: series.length, wf }),
  };
}

const pctText = (p: number): string => `${pyRound(p * 100, 1)}%`;
/** 置换 p 值最小是 1 ÷ (次数 + 1):舍到一位小数会印成"0%",那不是它的意思 */
const smallPctText = (p: number): string => (p < 0.001 ? "不到 0.1%" : pctText(p));

interface NoteFacts {
  best: SweepRow | null;
  ranked: number;
  rankCorr: number | null;
  rankCorrP: number | null;
  pickP: number | null;
  symbols: number;
  wf: WalkForward | null;
}

/** 按收益回撤比挑的时候要交代的:排名用的是什么、谁的得分靠的是回撤下限、谁几乎没经历过回撤。 */
function drawdownNotes(best: SweepRow | null, wf: WalkForward | null): string[] {
  const notes = [
    "排名用的是 总收益 ÷ max(最大回撤, 回撤下限),不年化。回撤下限 = 在场时的单日波动 × √在场天数:" +
      "这么大的日波动、在场这么多天,净值本来就该有这个量级的起落,回撤比它还小的按它算" +
      (best !== null && best.is.dd_floored ? ";样本内第一名就是按它算的" : ""),
  ];
  if (best !== null && best.is.dd_under_one_day) {
    notes.push("样本内第一名在样本内的回撤还不到它在场时一天的典型波动:基本没经历过回撤(多半只进过一两次场),这个名次不可靠");
  }
  const folds = wf?.folds ?? [];
  const floored = folds.filter((f) => f.dd_floored).length;
  const thin = folds.filter((f) => f.dd_under_one_day).length;
  if (floored > 0) {
    notes.push(
      `滚动前推 ${folds.length} 折里有 ${floored} 折,挑出来的那组在训练段的回撤是按下限算的` +
      (thin > 0 ? `;其中 ${thin} 折那组的回撤还不到在场时一天的典型波动(基本没经历过回撤,那一折的参数不可靠)` : ""),
    );
  }
  return notes;
}

/** 说明:只摆算得准的数和已知的偏差,不替人下"能用 / 不能用"的结论(那需要一条拍脑袋的线)。 */
function sweepNotes(input: SweepInput, r: NoteFacts): string[] {
  const notes: string[] = [];
  const { best } = r;
  if (best !== null && r.ranked >= 3 && r.pickP !== null) {
    notes.push(`样本内第一名在样本外排第 ${best.oos_rank} / ${r.ranked}:随手挑一组,样本外不比它差的机会是 ${pctText(r.pickP)}`);
  }
  if (r.rankCorr !== null && r.rankCorrP !== null) {
    notes.push(r.rankCorr > 0
      ? `样本内外排名的秩相关 ${r.rankCorr}:两边的排名要是毫无关系,碰巧得到这么高(或更高)的机会是 ${smallPctText(r.rankCorrP)}`
      : `样本内外排名的秩相关 ${r.rankCorr},不为正:样本内排得靠前的,样本外并不靠前`);
  }
  if (best !== null && (best.is.days < YEAR_DAYS || best.oos.days < YEAR_DAYS)) {
    notes.push(`样本内 ${best.is.days} 天、样本外 ${best.oos.days} 天:不满一年的那一段,年化与 Calmar 是外推出来的,只作参考`);
  }
  if (input.objective === "calmar") notes.push(...drawdownNotes(best, r.wf));
  if (input.costPct === 0) notes.push("没扣成交成本(佣金、买卖价差):换手越多,实际比这里差得越多");
  if (input.instrument.type !== "stock") {
    notes.push(
      "期权按 Black-Scholes 理论价估(r=0、近 20 日已实现波动率逐日重估、时间按交易日计、行权价贴标准挂牌间隔):没有方差风险溢价、偏斜与买卖价差," +
      "单腿买方被算便宜了;每只标的前 20 根日线只用来算波动率,不开仓;理论价不到 0.01 美元的不开仓",
    );
  }
  if (r.symbols > 1) notes.push("几只标的只用大家都有的交易日");
  notes.push("代码是现在还在交易的,退市、被剔除的不在里面,结果偏乐观(幸存者偏差);只扫一只也一样");
  return notes;
}
