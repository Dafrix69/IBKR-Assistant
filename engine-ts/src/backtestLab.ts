/**
 * 参数扫描 + 样本外 + 滚动前推(docs/features/backtest-lab.md)。
 *
 * 单次回测给的是"这组参数在这段行情上的样子";挑一组最好看的参数再说它好,是回测里最常见的自欺。
 * 这里把区间切成样本内 / 样本外:参数只在样本内挑,成绩看样本外;再做滚动前推(anchored walk-forward),
 * 每一折只用"当时已经有的数据"选参数、跑下一段,连起来的收益是这张表里唯一不偷看未来的数。
 * 多只标的一起扫时,每组参数的得分取各只的平均——只在一只上好看的参数多半是巧合。
 *
 * 纯计算,离线可跑:日线由调用方取好传进来。信号在整段上算一次再按日期切(指标都是因果的,见 backtest.signalPositions)。
 */
import { BacktestError, STRATEGIES, evaluateSegment, signalPositions } from "./backtest.js";
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
  return {
    return_pct: r.total_return_pct,
    annualized_pct: r.annualized_pct,
    max_drawdown_pct: r.max_drawdown_pct,
    calmar: dd > 0 ? pyRound(r.annualized_pct / dd, 2) : null,
    trades: r.trades,
    win_rate_pct: r.win_rate_pct,
    bench_return_pct: r.buy_hold_return_pct,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** 几只标的同一段的成绩取平均。笔数是合计,胜率按有交易的那些平均。 */
function averageStats(list: SegmentStats[]): SegmentStats {
  const calmars = list.map((s) => s.calmar).filter((c): c is number => c !== null);
  const wins = list.map((s) => s.win_rate_pct).filter((w): w is number => w !== null);
  return {
    return_pct: pyRound(mean(list.map((s) => s.return_pct)), 2),
    annualized_pct: pyRound(mean(list.map((s) => s.annualized_pct)), 2),
    max_drawdown_pct: pyRound(mean(list.map((s) => s.max_drawdown_pct)), 2),
    calmar: calmars.length === list.length && list.length ? pyRound(mean(calmars), 2) : null,
    trades: list.reduce((a, s) => a + s.trades, 0),
    win_rate_pct: wins.length ? pyRound(mean(wins), 1) : null,
    bench_return_pct: pyRound(mean(list.map((s) => s.bench_return_pct)), 2),
  };
}

/** 得分:总收益,或 Calmar(没有回撤时退回年化——一路没回撤的段,Calmar 无穷大不能拿来比)。 */
export function scoreOf(s: SegmentStats, objective: SweepObjective): number {
  if (objective === "return") return s.return_pct;
  return s.calmar ?? s.annualized_pct;
}

/** Spearman 秩相关;样本不到 3 个或一边全是同一个数时是 null。同分取平均秩。 */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const rank = (xs: number[]): number[] => {
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
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i += 1) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  if (da === 0 || db === 0) return null;
  return pyRound(num / Math.sqrt(da * db), 2);
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
  /** 每只标的在整段上的持仓序列与实际参数 */
  runs: Array<{ bars: Bar[]; positions: number[]; used: Record<string, number> }>;
}

function segment(run: ComboRun, lo: number, hi: number, input: SweepInput): SegmentStats {
  return averageStats(run.runs.map((r) =>
    statsOf(evaluateSegment(r.bars.slice(lo, hi), r.positions.slice(lo, hi), input.strategy, r.used, input.instrument, input.costPct))));
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
    for (const run of valid) {
      const sc = scoreOf(segment(run, 0, trainEnd, input), input.objective);
      if (sc > bestScore) {
        bestScore = sc;
        best = run;
      }
    }
    if (best === null) continue;
    // 测试段从训练段最后一根起:那一根的持仓决定测试段第一天的涨跌算不算
    const test = segment(best, trainEnd - 1, testEnd, input);
    chain *= 1 + test.return_pct / 100;
    bench *= 1 + test.bench_return_pct / 100;
    folds.push({
      train_end: dates[trainEnd - 1]!, test_start: dates[trainEnd]!, test_end: dates[testEnd - 1]!,
      params: best.params, test_return_pct: test.return_pct, bench_return_pct: test.bench_return_pct,
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
  const skipped: BacktestSweepResult["skipped"] = [];
  const valid: ComboRun[] = [];
  for (const params of combos) {
    try {
      const runs = series.map((s) => {
        const { positions, usedParams } = signalPositions(s.bars, input.strategy, params, null);
        return { bars: s.bars, positions, used: usedParams };
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
  const oosOrder = [...scored].sort((a, b) => b.oosScore - a.oosScore);
  const rows: SweepRow[] = [...scored]
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ params: x.run.params, score: x.score, is: x.is, oos: x.oos, oos_rank: oosOrder.indexOf(x) + 1 }));
  const best = rows[0] ?? null;
  const rankCorr = spearman(scored.map((x) => x.score), scored.map((x) => x.oosScore));

  const notes: string[] = [];
  if (best !== null && rows.length >= 3) {
    notes.push(`样本内第一名在样本外排第 ${best.oos_rank} / ${rows.length}`);
  }
  if (rankCorr !== null && rankCorr < 0.3) {
    notes.push(`样本内外排名的相关只有 ${rankCorr}:在这段行情上挑参数基本等于挑运气`);
  }
  if (input.costPct === 0) notes.push("没扣成交成本;绩效体检「执行损耗」的中位数可以填进每边成本");
  if (input.instrument.type !== "stock") notes.push("期权按 Black-Scholes 理论价估(r=0、20 日已实现波动率),只是研究口径,真实的偏斜与买卖价差都不在里面");
  if (series.length > 1) notes.push("几只标的只用大家都有的交易日;代码是现在还在交易的,退市、被剔除的不在里面,结果偏乐观(幸存者偏差)");

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
    rows: rows.slice(0, 20),
    best,
    rank_corr: rankCorr,
    walk_forward: walkForward(valid, n, dates, input),
    notes,
  };
}
