/** 策略回测(对应 Python backtest.py):纯计算,离线可对拍。
 *
 * 刻意保持朴素与透明:日线、收盘出信号、当日收盘价成交、全仓进出、无杠杆。
 * 期权模拟用 Black-Scholes 理论价(r=0,无偏度),erf 用 Cody 有理逼近实现到
 * double 精度——黄金对拍的净值曲线容差是 1e-9,教科书级的 1e-7 近似过不了。
 */
import type { BacktestCurvePoint, BacktestReport, BacktestTrade, CustomRules } from "./contract/backtest.js";
import { dateOrdinal, ordinalToDate } from "./tz.js";
import { pyFloat, pyRepr, pyRound } from "./py.js";

export class BacktestError extends Error {}

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

export const STRATEGIES: Record<string, {
  label: string;
  desc: string;
  params: Record<string, number>;
  param_labels: Record<string, string>;
}> = {
  buy_hold: {
    label: "买入持有",
    desc: "第一天买入,一直持有到区间结束。是所有策略的基准。",
    params: {},
    param_labels: {},
  },
  sma_cross: {
    label: "均线交叉",
    desc: "快线上穿慢线持有,下穿空仓。",
    params: { fast: 10, slow: 50 },
    param_labels: { fast: "快线周期(日)", slow: "慢线周期(日)" },
  },
  rsi: {
    label: "RSI 超卖买入",
    desc: "RSI 跌破买入线建仓,升破卖出线离场。",
    params: { period: 14, buy_below: 30, sell_above: 70 },
    param_labels: {
      period: "RSI 周期(日)",
      buy_below: "跌破这个值买入",
      sell_above: "升破这个值卖出",
    },
  },
  breakout: {
    label: "N 日突破",
    desc: "收盘创 N 日新高买入,跌破 M 日低点离场(唐奇安通道)。",
    params: { entry: 20, exit: 10 },
    param_labels: { entry: "入场:创 N 日新高", exit: "出场:跌破 M 日低点" },
  },
  custom: {
    label: "自定义(多条件)",
    desc: "自己搭条件:全部入场条件同时满足时买入,全部出场条件同时满足时卖出。",
    params: {},
    param_labels: {},
  },
};

const MAX_PARAM = 250;
const INT_PARAM_KEYS = new Set(["fast", "slow", "period", "entry", "exit"]);

type Rules = Record<string, any>;
type Instrument = Record<string, any>;

/** 每边成交成本的上限(%):再高就不是成本假设,是填错了。 */
export const MAX_COST_PCT = 10;

/**
 * `costPct` 是**每一边**(开、平各一次)的成交成本占成交额的百分比:佣金 + 滑点。默认 0 = 老口径,数值一位不差
 * (golden-backtest 钉着)。执行损耗(execQuality)的中位数就是给它填的。
 */
export function runBacktest(
  bars: Bar[],
  strategy: string,
  params?: Record<string, unknown> | null,
  rules?: CustomRules | null,
  instrument?: Instrument | null,
  costPct = 0,
): BacktestReport {
  const { positions, usedParams } = signalPositions(bars, strategy, params, rules);
  const inst: Instrument = { ...(instrument ?? {}) };
  if (inst["type"] === undefined || inst["type"] === null) inst["type"] = "stock";
  const result = evaluateSegment(bars, positions, strategy, usedParams, inst, costPct);
  if (rules) result["rules"] = rules;
  result["instrument"] = inst;
  return result;
}

/** 拿一段日线与对齐好的持仓序列结算(参数扫描按段切,见 backtestLab.ts)。`inst.type` 要已经补齐。 */
export function evaluateSegment(
  bars: Bar[], positions: number[], strategy: string, usedParams: Record<string, number>,
  inst: Instrument, costPct = 0,
): BacktestReport {
  if (!(costPct >= 0 && costPct <= MAX_COST_PCT)) {
    throw new BacktestError(`每边成交成本要在 0~${MAX_COST_PCT}% 之间`);
  }
  const cost = costPct / 100;
  const report = inst["type"] === "stock"
    ? evaluateStock(bars, positions, strategy, usedParams, cost)
    : evaluateOptions(bars, positions, strategy, usedParams, inst, cost);
  if (cost > 0) report["cost_pct"] = costPct;
  return report;
}

/**
 * 信号 → 每根日线收盘后的持仓(1 / 0)与实际用的参数。指标全是因果的(只看当根及以前),
 * 所以在整段上算一次、再按日期切成样本内 / 样本外,和只在那一段上算相比只多了指标的预热,不多看未来。
 */
export function signalPositions(
  bars: Bar[], strategy: string, params?: Record<string, unknown> | null, rules?: CustomRules | null,
): { positions: number[]; usedParams: Record<string, number> } {
  if (!(strategy in STRATEGIES)) {
    throw new BacktestError(`未知策略:${strategy}(可选:${Object.keys(STRATEGIES).join("、")})`);
  }
  if (bars.length < 5) {
    throw new BacktestError(`区间内只有 ${bars.length} 根日线,数据太少无法回测`);
  }

  let positions: number[];
  let usedParams: Record<string, number> = {};
  if (strategy === "custom") {
    if (!rules || !(rules["entry"] && rules["entry"].length)) {
      throw new BacktestError("自定义策略至少需要一条入场条件");
    }
    positions = customPositions(bars, rules);
  } else {
    const merged: Record<string, number> = { ...STRATEGIES[strategy]!.params };
    for (const [key, rawValue] of Object.entries(params ?? {})) {
      if (!(key in merged)) throw new BacktestError(`策略 ${strategy} 没有参数 ${key}`);
      const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (typeof rawValue === "boolean" || rawValue === null || Number.isNaN(value)) {
        throw new BacktestError(`参数 ${key} 必须是数字`);
      }
      const inRange =
        key === "buy_below" || key === "sell_above"
          ? value > 0 && value < 100
          : value > 0 && value <= MAX_PARAM;
      if (!inRange) throw new BacktestError(`参数 ${key} 超出合理范围:${pyFloat(value)}`);
      merged[key] = INT_PARAM_KEYS.has(key) ? Math.trunc(value) : value;
    }
    positions = strategyPositions(bars, strategy, merged);
    usedParams = merged;
  }
  return { positions, usedParams };
}

// ---------------------------------------------------------------- 信号
function strategyPositions(bars: Bar[], strategy: string, p: Record<string, number>): number[] {
  const closes = bars.map((b) => b.close);
  const n = bars.length;

  if (strategy === "buy_hold") return Array(n).fill(1);

  if (strategy === "sma_cross") {
    const fast = p["fast"]!;
    const slow = p["slow"]!;
    if (fast >= slow) {
      throw new BacktestError(`快线周期必须小于慢线周期(当前 ${fast}/${slow})`);
    }
    const smaF = sma(closes, fast);
    const smaS = sma(closes, slow);
    return closes.map((_, i) =>
      smaF[i] !== null && smaS[i] !== null && smaF[i]! > smaS[i]! ? 1 : 0,
    );
  }

  if (strategy === "rsi") {
    const rsiSeries = rsi(closes, p["period"]!);
    const buyBelow = p["buy_below"]!;
    const sellAbove = p["sell_above"]!;
    if (buyBelow >= sellAbove) throw new BacktestError("RSI 买入线必须低于卖出线");
    const out: number[] = [];
    let holding = false;
    for (const value of rsiSeries) {
      if (value === null) {
        out.push(0);
        continue;
      }
      if (!holding && value < buyBelow) holding = true;
      else if (holding && value > sellAbove) holding = false;
      out.push(holding ? 1 : 0);
    }
    return out;
  }

  // breakout
  const entryN = p["entry"]!;
  const exitN = p["exit"]!;
  const out: number[] = [];
  let holding = false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (i < entryN) {
      out.push(0);
      continue;
    }
    if (!holding) {
      let hi = -Infinity;
      for (let j = i - entryN; j < i; j++) hi = Math.max(hi, bars[j]!.high);
      if (bar.close > hi) holding = true;
    } else {
      const start = Math.max(0, i - exitN);
      if (start < i) {
        let lo = Infinity;
        for (let j = start; j < i; j++) lo = Math.min(lo, bars[j]!.low);
        if (bar.close < lo) holding = false;
      }
    }
    out.push(holding ? 1 : 0);
  }
  return out;
}

// ---------------------------------------------------------------- 自定义条件
function customPositions(bars: Bar[], rules: Rules): number[] {
  const entry = (rules["entry"] as Rules[]).map((c) => condSeries(bars, c));
  const exit = ((rules["exit"] as Rules[]) ?? []).map((c) => condSeries(bars, c));
  const out: number[] = [];
  let holding = false;
  for (let i = 0; i < bars.length; i++) {
    if (!holding && entry.every((c) => c[i])) holding = true;
    else if (holding && exit.length && exit.every((c) => c[i])) holding = false;
    out.push(holding ? 1 : 0);
  }
  return out;
}

function condSeries(bars: Bar[], cond: Rules): boolean[] {
  const left = operandSeries(bars, (cond["left"] as Rules) ?? {});
  const right = operandSeries(bars, (cond["right"] as Rules) ?? {});
  const op = cond["op"];
  const out: boolean[] = [];
  for (let i = 0; i < bars.length; i++) {
    const l = left[i]!;
    const r = right[i]!;
    if (l === null || r === null) {
      out.push(false);
      continue;
    }
    if (op === ">") out.push(l > r);
    else if (op === "<") out.push(l < r);
    else if (op === ">=") out.push(l >= r);
    else if (op === "<=") out.push(l <= r);
    else if (op === "cross_up" || op === "cross_down") {
      const pl = i > 0 ? left[i - 1]! : null;
      const pr = i > 0 ? right[i - 1]! : null;
      if (pl === null || pr === null) out.push(false);
      else if (op === "cross_up") out.push(pl <= pr && l > r);
      else out.push(pl >= pr && l < r);
    } else {
      throw new BacktestError(`未知比较符:${pyRepr(op)}`);
    }
  }
  return out;
}

function operandSeries(bars: Bar[], operand: Rules): Array<number | null> {
  const n = bars.length;
  if (operand["kind"] === "const") {
    const value = Number(operand["value"]);
    if (operand["value"] === null || operand["value"] === undefined || Number.isNaN(value)) {
      throw new BacktestError("常数操作数缺少数值");
    }
    return Array(n).fill(value);
  }

  const name = operand["name"];
  const period = Math.trunc(Number(operand["period"] ?? 0)) || 0;
  if (["sma", "ema", "rsi", "highest", "lowest", "change_pct"].includes(name)) {
    if (!(period > 0 && period <= MAX_PARAM)) {
      throw new BacktestError(`指标 ${name} 的 period 超出范围:${period}`);
    }
  }

  const closes = bars.map((b) => b.close);
  if (name === "close") return [...closes];
  if (name === "open") return bars.map((b) => b.open);
  if (name === "high") return bars.map((b) => b.high);
  if (name === "low") return bars.map((b) => b.low);
  if (name === "sma") return sma(closes, period);
  if (name === "ema") return ema(closes, period);
  if (name === "rsi") return rsi(closes, period);
  if (name === "highest") {
    // 前 N 日最高(不含当日,突破判断的惯例)
    return closes.map((_, i) => {
      if (i < period) return null;
      let hi = -Infinity;
      for (let j = i - period; j < i; j++) hi = Math.max(hi, bars[j]!.high);
      return hi;
    });
  }
  if (name === "lowest") {
    return closes.map((_, i) => {
      if (i < period) return null;
      let lo = Infinity;
      for (let j = i - period; j < i; j++) lo = Math.min(lo, bars[j]!.low);
      return lo;
    });
  }
  if (name === "change_pct") {
    return closes.map((c, i) => (i >= period ? (c / closes[i - period]! - 1.0) * 100.0 : null));
  }
  if (name === "macd_hist") return macdHist(closes);
  throw new BacktestError(`未知指标:${pyRepr(name)}`);
}

/** MACD 柱(12/26/9)。 */
export function macdHist(closes: number[]): Array<number | null> {
  const n = closes.length;
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = e12.map((a, i) => {
    const b = e26[i]!;
    return a !== null && b !== null ? a - b : null;
  });
  const first = line.findIndex((v) => v !== null);
  const out: Array<number | null> = Array(n).fill(null);
  if (first < 0) return out;
  const sub = line.slice(first).filter((v): v is number => v !== null);
  const signal = ema(sub, 9);
  signal.forEach((sig, j) => {
    if (sig !== null) out[first + j] = sub[j]! - sig;
  });
  return out;
}

export function ema(values: number[], window: number): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < window) return out;
  const alpha = 2.0 / (window + 1.0);
  let acc = 0.0;
  for (let i = 0; i < window; i++) acc += values[i]!;
  let e = acc / window;
  out[window - 1] = e;
  for (let i = window; i < values.length; i++) {
    e = values[i]! * alpha + e * (1.0 - alpha);
    out[i] = e;
  }
  return out;
}

export function sma(values: number[], window: number): Array<number | null> {
  const out: Array<number | null> = [];
  let acc = 0.0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i]!;
    if (i >= window) acc -= values[i - window]!;
    out.push(i >= window - 1 ? acc / window : null);
  }
  return out;
}

/** Wilder 平滑 RSI。前 period 根无值。 */
export function rsi(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0.0;
  let losses = 0.0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    gains += Math.max(change, 0.0);
    losses += Math.max(-change, 0.0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0.0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0.0)) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100.0;
  return 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
}

// ---------------------------------------------------------------- 期权模拟
export const OPTION_TYPES: Record<string, string> = {
  call: "买入看涨",
  put: "买入看跌",
  call_spread: "看涨借方价差",
  put_spread: "看跌借方价差",
  butterfly: "买入蝴蝶",
};

type LegSpec = [number, string, number]; // ratio, right, strike

function evaluateOptions(
  bars: Bar[], positions: number[], strategy: string,
  params: Record<string, number>, inst: Instrument, cost = 0,
): BacktestReport {
  if (!(inst["type"] in OPTION_TYPES)) {
    throw new BacktestError(`未知交易品种:${inst["type"]}`);
  }
  // 用 is-null 判缺省:0 是非法值,不能被 `?? 默认值` 之外的写法吞掉
  const dte = inst["dte"] !== null && inst["dte"] !== undefined ? Math.trunc(Number(inst["dte"])) : 30;
  const offsetPct =
    inst["offset_pct"] !== null && inst["offset_pct"] !== undefined ? Number(inst["offset_pct"]) : 0.0;
  const widthPct =
    inst["width_pct"] !== null && inst["width_pct"] !== undefined ? Number(inst["width_pct"]) : 2.0;
  const risk =
    (inst["risk_pct"] !== null && inst["risk_pct"] !== undefined ? Number(inst["risk_pct"]) : 10.0) / 100.0;
  if (!(dte >= 1 && dte <= 365)) throw new BacktestError("到期天数 dte 必须在 1~365");
  if (!(risk > 0 && risk <= 1)) throw new BacktestError("单笔投入占比必须在 0~100%");
  if (!(widthPct > 0 && widthPct <= 20) || Math.abs(offsetPct) > 30) {
    throw new BacktestError("行权价偏移/宽度超出合理范围");
  }

  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const dates = bars.map((b) => dateOrdinal(b.date));

  let cash = 1.0;
  const equity: number[] = [];
  const bench: number[] = [1.0];
  interface Holding {
    entry_i: number;
    legs: LegSpec[];
    cost: number;
    sigma: number;
    expiry: number;
  }
  // 用容器对象而不是裸 let:闭包里的赋值会让 TS 的流分析把裸变量窄化成 never
  const pos: { h: Holding | null } = { h: null };
  const trades: BacktestTrade[] = [];
  let heldBars = 0;

  // 成交成本:开仓多付、平仓少收各 cost(按权利金算)。cost = 0 时原样返回,数值一位不差
  const paid = (c: number): number => (cost > 0 ? c * (1 + cost) : c);
  const got = (v: number): number => (cost > 0 ? v * (1 - cost) : v);
  const closePosition = (i: number, proceeds: number, why: "expiry" | "signal"): void => {
    const h = pos.h!;
    const ret = got(proceeds) / paid(h.cost) - 1.0;
    cash *= 1.0 + risk * ret;
    trades.push({
      entry_date: bars[h.entry_i]!.date,
      exit_date: bars[i]!.date,
      entry_price: pyRound(h.cost, 4),
      exit_price: pyRound(proceeds, 4),
      return_pct: pyRound(ret * 100, 2),
      closed: true,
      exit_reason: why,
    });
    pos.h = null;
  };

  const openPosition = (i: number): void => {
    const s0 = closes[i]!;
    const sigma = realizedVol(closes.slice(0, i + 1));
    const legs = optionLegs(inst["type"], s0, offsetPct, widthPct);
    const cost = structureValue(legs, s0, dte / 365.0, sigma);
    if (cost <= 0) return; // 理论上借方结构恒为正,防御除零
    pos.h = { entry_i: i, legs, cost, sigma, expiry: dates[i]! + dte };
  };

  for (let i = 0; i < n; i++) {
    if (i > 0) bench.push(bench[bench.length - 1]! * (closes[i]! / closes[i - 1]!));

    const held = pos.h;
    if (held !== null) {
      const expired = dates[i]! >= held.expiry;
      const tLeft = Math.max(held.expiry - dates[i]!, 0) / 365.0;
      if (expired) {
        closePosition(i, structureValue(held.legs, closes[i]!, 0.0, held.sigma), "expiry");
        if (positions[i] === 1) openPosition(i); // 信号仍在 → 以新行权价续仓
      } else if (positions[i] === 0) {
        closePosition(i, structureValue(held.legs, closes[i]!, tLeft, held.sigma), "signal");
      }
    }
    if (pos.h === null && positions[i] === 1) openPosition(i);

    const h = pos.h;
    if (h !== null) {
      heldBars += 1;
      const tLeft = Math.max(h.expiry - dates[i]!, 0) / 365.0;
      const value = structureValue(h.legs, closes[i]!, tLeft, h.sigma);
      equity.push(cash * (1.0 + risk * (got(value) / paid(h.cost) - 1.0)));
    } else {
      equity.push(cash);
    }
  }

  if (pos.h !== null) {
    const h = pos.h;
    const tLeft = Math.max(h.expiry - dates[n - 1]!, 0) / 365.0;
    const value = structureValue(h.legs, closes[n - 1]!, tLeft, h.sigma);
    trades.push({
      entry_date: bars[h.entry_i]!.date,
      exit_date: null,
      entry_price: pyRound(h.cost, 4),
      exit_price: pyRound(value, 4),
      return_pct: pyRound((got(value) / paid(h.cost) - 1.0) * 100, 2),
      closed: false,
      exit_reason: "open",
    });
  }

  const closed = trades.filter((t) => t["closed"]);
  const wins = trades.filter((t) => (t["return_pct"] as number) > 0);
  const days = Math.max(dates[n - 1]! - dates[0]!, 1);
  const final = equity[equity.length - 1]!;

  return {
    strategy,
    params,
    bars: n,
    start: bars[0]!.date,
    end: bars[n - 1]!.date,
    total_return_pct: pyRound((final - 1.0) * 100, 2),
    buy_hold_return_pct: pyRound((bench[bench.length - 1]! - 1.0) * 100, 2),
    annualized_pct: final > 0 ? pyRound((Math.pow(final, 365.0 / days) - 1.0) * 100, 2) : -100.0,
    max_drawdown_pct: pyRound(maxDrawdown(equity) * 100, 2),
    trades: trades.length,
    closed_trades: closed.length,
    win_rate_pct: trades.length ? pyRound((wins.length / trades.length) * 100, 1) : null,
    exposure_pct: pyRound((heldBars / n) * 100, 1),
    trade_list: trades.slice(-100),
    curve: sampleCurve(bars, equity, bench),
  };
}

function optionLegs(instType: string, s0: number, offsetPct: number, widthPct: number): LegSpec[] {
  const k = s0 * (1.0 + offsetPct / 100.0);
  const w = (s0 * widthPct) / 100.0;
  if (instType === "call") return [[1, "C", k]];
  if (instType === "put") return [[1, "P", k]];
  if (instType === "call_spread") return [[1, "C", k], [-1, "C", k + w]];
  if (instType === "put_spread") return [[1, "P", k], [-1, "P", k - w]];
  return [[1, "C", k - w], [-2, "C", k], [1, "C", k + w]]; // butterfly
}

function structureValue(legs: LegSpec[], s: number, t: number, sigma: number): number {
  let total = 0.0;
  for (const [ratio, right, strike] of legs) total += ratio * bsPrice(s, strike, t, sigma, right);
  return total;
}

/** Black-Scholes(r=0,无股息)。t<=0 时退化为内在价值。 */
export function bsPrice(s: number, k: number, t: number, sigma: number, right: string): number {
  if (t <= 0 || sigma <= 0) {
    return right === "C" ? Math.max(s - k, 0.0) : Math.max(k - s, 0.0);
  }
  const d1 = (Math.log(s / k) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  const cdf = (x: number) => 0.5 * (1.0 + erf(x / Math.SQRT2));
  if (right === "C") return s * cdf(d1) - k * cdf(d2);
  return k * cdf(-d2) - s * cdf(-d1);
}

/** 近 window 日已实现波动率(年化),数据不足给保守默认值。 */
export function realizedVol(closes: number[], window = 20): number {
  const tail = closes.slice(-(window + 1));
  if (tail.length < 6) return 0.25;
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1]! > 0) rets.push(Math.log(tail[i]! / tail[i - 1]!));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let variance = 0.0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance /= Math.max(rets.length - 1, 1);
  return Math.min(Math.max(Math.sqrt(variance * 252.0), 0.05), 2.0);
}

// ---------------------------------------------------------------- 结算
function evaluateStock(
  bars: Bar[], positions: number[], strategy: string, params: Record<string, number>, cost = 0,
): BacktestReport {
  const n = bars.length;
  const equity = [1.0];
  const bench = [1.0];
  // 第 0 根收盘就持有 = 那一刻买进,也要付一次
  if (cost > 0 && positions[0] === 1) equity[0] = 1.0 - cost;
  for (let i = 1; i < n; i++) {
    const ret = bars[i]!.close / bars[i - 1]!.close;
    let next = equity[i - 1]! * (positions[i - 1] === 1 ? ret : 1.0);
    // 收盘成交:这一根的持仓和上一根不一样就付一次(买进或卖出)
    if (cost > 0 && (positions[i] ?? 0) !== (positions[i - 1] ?? 0)) next *= 1.0 - cost;
    equity.push(next);
    bench.push(bench[i - 1]! * ret);
  }

  const trades: BacktestTrade[] = [];
  let entryIdx: number | null = null;
  for (let i = 0; i < n; i++) {
    if (positions[i] === 1 && entryIdx === null) {
      entryIdx = i;
    } else if (positions[i] === 0 && entryIdx !== null) {
      trades.push(makeTrade(bars, entryIdx, i, true, cost));
      entryIdx = null;
    }
  }
  if (entryIdx !== null) trades.push(makeTrade(bars, entryIdx, n - 1, false, cost));

  const closed = trades.filter((t) => t["closed"]);
  const wins = trades.filter((t) => (t["return_pct"] as number) > 0);

  const days = Math.max(dateOrdinal(bars[n - 1]!.date) - dateOrdinal(bars[0]!.date), 1);
  const total = equity[n - 1]! - 1.0;
  const annualized = equity[n - 1]! > 0 ? Math.pow(equity[n - 1]!, 365.0 / days) - 1.0 : -1.0;

  return {
    strategy,
    params,
    bars: n,
    start: bars[0]!.date,
    end: bars[n - 1]!.date,
    total_return_pct: pyRound(total * 100, 2),
    buy_hold_return_pct: pyRound((bench[n - 1]! - 1.0) * 100, 2),
    annualized_pct: pyRound(annualized * 100, 2),
    max_drawdown_pct: pyRound(maxDrawdown(equity) * 100, 2),
    trades: trades.length,
    closed_trades: closed.length,
    win_rate_pct: trades.length ? pyRound((wins.length / trades.length) * 100, 1) : null,
    exposure_pct: pyRound((positions.reduce((a, b) => a + b, 0) / n) * 100, 1),
    trade_list: trades.slice(-100),
    curve: sampleCurve(bars, equity, bench),
  };
}

function makeTrade(bars: Bar[], entry: number, exit: number, closed: boolean, cost = 0): BacktestTrade {
  const entryPx = bars[entry]!.close;
  const exitPx = bars[exit]!.close;
  // 扣成本的口径和净值一致:买进付一次,平掉再付一次;还开着的那笔只扣进场那一次
  const gross = exitPx / entryPx;
  const net = cost > 0 ? gross * (1.0 - cost) * (closed ? 1.0 - cost : 1.0) : gross;
  return {
    entry_date: bars[entry]!.date,
    exit_date: closed ? bars[exit]!.date : null,
    entry_price: entryPx,
    exit_price: exitPx,
    return_pct: pyRound((net - 1.0) * 100, 2),
    closed,
  };
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0]!;
  let worst = 0.0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1.0);
  }
  return worst;
}

function sampleCurve(
  bars: Bar[], equity: number[], bench: number[], maxPoints = 300,
): BacktestCurvePoint[] {
  const n = bars.length;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx.map((i) => ({
    date: bars[i]!.date,
    equity: pyRound(equity[i]!, 4),
    bench: pyRound(bench[i]!, 4),
  }));
}

export { ordinalToDate };

// ---------------------------------------------------------------- erf
// 误差函数直接用 @stdlib 的实现(Cody 算法,double 精度)——不自己造数值轮子。
import erfStdlib from "@stdlib/math-base-special-erf";

export function erf(x: number): number {
  return erfStdlib(x);
}
