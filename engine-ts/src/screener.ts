/** 扫描器(对应 Python screener.py)—— RS 强度 / 拐点筛选 / 极值偏离,全部纯计算。
 *
 * 三个功能都是对股票池(板块页里的成分股)做批量复盘,数字由代码算,
 * 不经过大模型,也不接下单链路。口径见 Python 版模块头注释,这里逐行对拍。
 */
import { ema, sma } from "./backtest.js";
import { fmtF, fmtSF, pyRound } from "./py.js";
import { dateOrdinal, isValidYmd, weekdayOfDate } from "./tz.js";

type Rec = Record<string, any>;

export const RS_WINDOWS: readonly number[] = [5, 20, 60, 120, 250];
export const RS_WINDOW_LABELS: Record<number, string> = {
  5: "1周", 20: "1月", 60: "1季", 120: "半年", 250: "1年",
};
export const RS_BENCHMARKS: readonly string[] = ["SPY", "QQQ"];
export const UNTAGGED = "未分类";

export const DEFAULT_PIVOT_STRENGTH = 3;
export const DEFAULT_MAX_SPAN = 60;
export const DEFAULT_MAX_AGE = 12;
export const MIN_CD_BARS = 40;

export const DEFAULT_DEV_PERIOD = 20;
export const DEFAULT_DEV_LOOKBACK = 120;
export const DEFAULT_PRESSURE_SMOOTH = 5;
export const DEFAULT_Z_EXTREME = 2.0;
export const DEFAULT_KEEP = 120;
export const MIN_Z_SAMPLES = 10;
export const VOLUME_WEIGHT_CAP = 3.0;
export const SIGNAL_LABEL: Record<string, string> = { bull: "底背离", bear: "顶背离" };

export class ScreenerError extends Error {}

interface CleanBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------------------------------------------------------- 公共小工具
function barTime(bar: Rec): string {
  return String(bar["date"] || bar["time"] || "");
}

function num(bar: Rec, key: string): number | null {
  const value = bar[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 只留 OHLC 齐全且为正数的 K 线,整根跳过缺数据的。 */
function clean(bars: Rec[] | null | undefined): CleanBar[] {
  const out: CleanBar[] = [];
  for (const bar of bars ?? []) {
    const o = num(bar, "open"), h = num(bar, "high"), l = num(bar, "low"), c = num(bar, "close");
    if (o === null || h === null || l === null || c === null) continue;
    if (Math.min(o, h, l, c) <= 0) continue;
    const v = num(bar, "volume");
    out.push({
      time: barTime(bar), open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c,
      volume: v !== null && v >= 0 ? v : 0.0,
    });
  }
  return out;
}

/** 日线 → 周线(周一为一周之始)。time 取该周最后一个交易日。 */
export function resampleWeekly(bars: Rec[] | null | undefined): Rec[] {
  const weeks: CleanBar[] = [];
  let currentKey: number | null = null;
  for (const bar of clean(bars)) {
    const iso = bar.time.slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m || !isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
    const key = dateOrdinal(iso) - weekdayOfDate(iso);
    if (key !== currentKey) {
      weeks.push({ ...bar });
      currentKey = key;
      continue;
    }
    const last = weeks[weeks.length - 1]!;
    last.time = bar.time;
    last.high = Math.max(last.high, bar.high);
    last.low = Math.min(last.low, bar.low);
    last.close = bar.close;
    last.volume = last.volume + bar.volume;
  }
  return weeks;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  const mid = Math.floor(n / 2);
  if (n % 2) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2.0;
}

function byScoreThenKey(scoreOf: (r: Rec) => number | null, keyOf: (r: Rec) => string) {
  return (a: Rec, b: Rec): number => {
    const sa = scoreOf(a), sb = scoreOf(b);
    if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    return keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;
  };
}

// ================================================================ RS 强度
function closeAtOrBefore(times: string[], closes: number[], when: string): number | null {
  let hit: number | null = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i]! <= when) hit = closes[i]!;
    else break;
  }
  return hit;
}

/** 股票池成员对基准的相对强度,并按业务标签汇总。基准按日期对齐取值。 */
export function rsStrength(
  members: Rec[], benchBars: Rec[] | null | undefined, benchmark = "SPY",
  windows: readonly number[] = RS_WINDOWS,
): Rec {
  const bench = clean(benchBars);
  const benchTimes = bench.map((b) => b.time.slice(0, 10));
  const benchCloses = bench.map((b) => b.close);

  const rows: Rec[] = [];
  for (const member of members) {
    const symbol = String(member["symbol"] ?? "").toUpperCase();
    const tag = String(member["tag"] ?? "").trim() || UNTAGGED;
    const bars = clean(member["bars"]);
    const closes = bars.map((b) => b.close);
    const times = bars.map((b) => b.time.slice(0, 10));
    const row: Rec = {
      symbol, tag, company: String(member["company"] ?? ""),
      last: closes.length ? pyRound(closes[closes.length - 1]!, 2) : null,
      bars: closes.length, rs: {}, score: null, rank: null,
      error: member["error"] || null,
    };
    const values: number[] = [];
    for (const n of windows) {
      if (closes.length <= n || !bench.length) continue;
      const b0 = closeAtOrBefore(benchTimes, benchCloses, times[times.length - 1 - n]!);
      const b1 = closeAtOrBefore(benchTimes, benchCloses, times[times.length - 1]!);
      const c0 = closes[closes.length - 1 - n]!;
      if (!b0 || !b1 || c0 <= 0) continue;
      const ret = closes[closes.length - 1]! / c0 - 1.0;
      const benchRet = b1 / b0 - 1.0;
      const rs = (1.0 + ret) / (1.0 + benchRet) - 1.0;
      row["rs"][String(n)] = {
        ret_pct: pyRound(ret * 100.0, 2),
        bench_pct: pyRound(benchRet * 100.0, 2),
        rs_pct: pyRound(rs * 100.0, 2),
        beats: rs > 0,
      };
      values.push(rs);
    }
    if (values.length) {
      row["score"] = pyRound((values.reduce((a, b) => a + b, 0) / values.length) * 100.0, 2);
    }
    rows.push(row);
  }

  rows.sort(byScoreThenKey((r) => r["score"], (r) => r["symbol"]));
  let rank = 0;
  for (const row of rows) {
    if (row["score"] !== null) {
      rank += 1;
      row["rank"] = rank;
    }
  }

  return {
    benchmark,
    windows: windows.map((n) => ({ n, label: RS_WINDOW_LABELS[n] ?? `${n}日` })),
    rows,
    tags: rsByTag(rows, windows),
    counted: rank,
    total: rows.length,
    bench_bars: bench.length,
    bench_last: benchCloses.length ? pyRound(benchCloses[benchCloses.length - 1]!, 2) : null,
  };
}

function rsByTag(rows: Rec[], windows: readonly number[]): Rec[] {
  const groups = new Map<string, Rec[]>();
  for (const row of rows) {
    if (!groups.has(row["tag"])) groups.set(row["tag"], []);
    groups.get(row["tag"])!.push(row);
  }
  const out: Rec[] = [];
  for (const [tag, members] of groups) {
    const entry: Rec = {
      tag, count: members.length, rs: {}, score: null, symbols: members.map((m) => m["symbol"]),
    };
    for (const n of windows) {
      const key = String(n);
      const vals = members.filter((m) => key in m["rs"]).map((m) => m["rs"][key]["rs_pct"] as number);
      if (!vals.length) continue;
      entry["rs"][key] = {
        median_pct: pyRound(median(vals)!, 2),
        beats: vals.filter((v) => v > 0).length,
        total: vals.length,
      };
    }
    const scores = members.filter((m) => m["score"] !== null).map((m) => m["score"] as number);
    if (scores.length) entry["score"] = pyRound(median(scores)!, 2);
    out.push(entry);
  }
  out.sort(byScoreThenKey((e) => e["score"], (e) => e["tag"]));
  return out;
}

// ================================================================ 拐点筛选:CD 背离
function dif(closes: number[]): Array<number | null> {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  return e12.map((a, i) => {
    const b = e26[i]!;
    return a !== null && b !== null ? a - b : null;
  });
}

/** 摆动点下标:左右各 strength 根里没有更极端的价格(左侧允许打平,右侧要求严格)。 */
function pivots(values: number[], strength: number, low: boolean): number[] {
  const out: number[] = [];
  const n = values.length;
  for (let i = strength; i < n - strength; i++) {
    const v = values[i]!;
    let ok = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      const other = values[j]!;
      if (low) {
        if (other < v || (j > i && other === v)) { ok = false; break; }
      } else if (other > v || (j > i && other === v)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function divergence(
  prices: number[], difs: Array<number | null>, piv: number[], bull: boolean,
  maxSpan: number, maxAge: number,
): { p1: number; p2: number } | null {
  if (piv.length < 2) return null;
  const last = prices.length - 1;
  const p2 = piv[piv.length - 1]!;
  if (last - p2 > maxAge || difs[p2] === null) return null;
  for (let k = piv.length - 2; k >= 0; k--) {
    const p1 = piv[k]!;
    if (p2 - p1 > maxSpan) break;
    const d1 = difs[p1] ?? null, d2 = difs[p2]!;
    if (d1 === null) continue;
    const hit = bull
      ? prices[p2]! < prices[p1]! && d2 > d1 && d1 < 0 && d2 < 0
      : prices[p2]! > prices[p1]! && d2 < d1 && d1 > 0 && d2 > 0;
    if (hit) return { p1, p2 };
  }
  return null;
}

function confirmation(
  closes: number[], ma: Array<number | null>, p2: number, bull: boolean, period: number,
): Rec {
  const lastMa = ma[ma.length - 1];
  if (lastMa === null || lastMa === undefined) return { ma: period, status: "n/a", at: null, age: null };
  let crossed: number | null = null;
  for (let i = p2 + 1; i < closes.length; i++) {
    const prevMa = ma[i - 1], curMa = ma[i];
    if (prevMa === null || prevMa === undefined || curMa === null || curMa === undefined) continue;
    if (bull && closes[i - 1]! <= prevMa && closes[i]! > curMa) crossed = i;
    else if (!bull && closes[i - 1]! >= prevMa && closes[i]! < curMa) crossed = i;
  }
  const lastClose = closes[closes.length - 1]!;
  const holding = bull ? lastClose > lastMa : lastClose < lastMa;
  let status: string;
  if (crossed !== null && holding) status = "confirmed";
  else if (crossed !== null) status = "failed";
  else status = "waiting";
  return { ma: period, status, at: crossed, age: crossed !== null ? closes.length - 1 - crossed : null };
}

/** 单个序列上的左侧 CD 背离。底背离看最低价的摆动低点,顶背离看最高价的摆动高点。 */
export function cdDivergence(
  bars: Rec[] | null | undefined, maPeriod: number | null = null,
  strength = DEFAULT_PIVOT_STRENGTH, maxSpan = DEFAULT_MAX_SPAN, maxAge = DEFAULT_MAX_AGE,
): Rec {
  const rows = clean(bars);
  const closes = rows.map((b) => b.close);
  const out: Rec = {
    signal: null, label: "无", bars: rows.length,
    last: closes.length ? pyRound(closes[closes.length - 1]!, 4) : null,
    dif_last: null, dif_side: null, pivots: [], age: null,
    price_gap_pct: null, dif_gap: null, confirm: null, reason: null,
  };
  if (rows.length < MIN_CD_BARS) {
    out["reason"] = `K 线不足 ${MIN_CD_BARS} 根,算不出 DIF 摆动点`;
    return out;
  }
  const difs = dif(closes);
  const difLast = difs[difs.length - 1]!;
  out["dif_last"] = difLast !== null ? pyRound(difLast, 4) : null;
  if (difLast !== null) out["dif_side"] = difLast > 0 ? "above" : difLast < 0 ? "below" : "zero";

  const lows = rows.map((b) => b.low);
  const highs = rows.map((b) => b.high);
  const bull = divergence(lows, difs, pivots(lows, strength, true), true, maxSpan, maxAge);
  const bear = divergence(highs, difs, pivots(highs, strength, false), false, maxSpan, maxAge);
  const last = rows.length - 1;
  let pick: { p1: number; p2: number } | null = null;
  let isBull = false;
  if (bull && bear) {
    isBull = last - bull.p2 <= last - bear.p2;
    pick = isBull ? bull : bear;
  } else if (bull) {
    pick = bull; isBull = true;
  } else if (bear) {
    pick = bear; isBull = false;
  }
  if (pick === null) {
    out["reason"] = `最近 ${maxAge} 根内没有新的背离摆动点`;
    return out;
  }

  const prices = isBull ? lows : highs;
  const { p1, p2 } = pick;
  out["signal"] = isBull ? "bull" : "bear";
  out["label"] = SIGNAL_LABEL[out["signal"]];
  out["pivots"] = [p1, p2].map((p) => ({
    index: p, time: rows[p]!.time, price: pyRound(prices[p]!, 4), dif: pyRound(difs[p]!, 4),
  }));
  out["age"] = last - p2;
  out["price_gap_pct"] = pyRound((prices[p2]! / prices[p1]! - 1.0) * 100.0, 2);
  out["dif_gap"] = pyRound(difs[p2]! - difs[p1]!, 4);
  if (maPeriod) {
    const period = Math.trunc(maPeriod);
    const ma = sma(closes, period);
    const confirm = confirmation(closes, ma, p2, isBull, period);
    if (confirm["at"] !== null) confirm["at"] = rows[confirm["at"] as number]!.time;
    out["confirm"] = confirm;
  }
  return out;
}

/** 整个股票池 × 多个周期。members 每项 {symbol, tag, frames: {tf: bars}, errors: {tf: msg}}。 */
export function screenInflections(
  members: Rec[], timeframes: string[], maPeriod: number | null = null,
  strength = DEFAULT_PIVOT_STRENGTH,
): Rec {
  const rows: Rec[] = [];
  const perTf: Record<string, Rec> = {};
  for (const tf of timeframes) perTf[tf] = { bull: 0, bear: 0, confirmed: 0 };
  for (const member of members) {
    const frames: Rec = member["frames"] ?? {};
    const errors: Rec = member["errors"] ?? {};
    const row: Rec = {
      symbol: String(member["symbol"] ?? "").toUpperCase(),
      tag: String(member["tag"] ?? "").trim() || UNTAGGED,
      company: String(member["company"] ?? ""),
      signals: {}, hits: 0, confirmed: 0,
    };
    for (const tf of timeframes) {
      if (tf in errors && errors[tf]) {
        row["signals"][tf] = { error: String(errors[tf]) };
        continue;
      }
      const result = cdDivergence(frames[tf], maPeriod, strength);
      row["signals"][tf] = result;
      if (result["signal"]) {
        row["hits"] += 1;
        perTf[tf]![result["signal"]] += 1;
        const confirm = result["confirm"];
        if (confirm && confirm["status"] === "confirmed") {
          row["confirmed"] += 1;
          perTf[tf]!["confirmed"] += 1;
        }
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => {
    if (a["hits"] !== b["hits"]) return b["hits"] - a["hits"];
    if (a["confirmed"] !== b["confirmed"]) return b["confirmed"] - a["confirmed"];
    return a["symbol"] < b["symbol"] ? -1 : a["symbol"] > b["symbol"] ? 1 : 0;
  });
  return {
    timeframes: [...timeframes],
    ma_period: maPeriod ? Math.trunc(maPeriod) : null,
    rows,
    per_timeframe: perTf,
    hit_count: rows.filter((r) => r["hits"]).length,
    total: rows.length,
  };
}

// ================================================================ 极值偏离
function stdev(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return Math.sqrt(acc / (n - 1));
}

/** 逐根算修正版买卖压力与偏离程度,返回最后 keep 根给界面画图。 */
export function deviationReview(
  bars: Rec[] | null | undefined, period = DEFAULT_DEV_PERIOD, lookback = DEFAULT_DEV_LOOKBACK,
  smooth = DEFAULT_PRESSURE_SMOOTH, zExtreme = DEFAULT_Z_EXTREME, keep = DEFAULT_KEEP,
): Rec {
  const rows = clean(bars);
  const n = rows.length;
  period = Math.max(2, Math.trunc(period));
  lookback = Math.max(MIN_Z_SAMPLES, Math.trunc(lookback));
  smooth = Math.max(1, Math.trunc(smooth));
  const out: Rec = {
    period, lookback, smooth, z_extreme: zExtreme,
    bars: n, series: [], last: null, extreme: null, extreme_label: "—",
    window: null, readout: [],
  };
  if (n < period + 2) {
    out["readout"] = [`K 线不足 ${period + 2} 根,算不出 ${period} 周期均线`];
    return out;
  }

  const closes = rows.map((b) => b.close);
  const volumes = rows.map((b) => b.volume);
  const raw: number[] = [];
  const ratios: Array<number | null> = [];
  const volMa = sma(volumes, 20);
  for (let i = 0; i < rows.length; i++) {
    const bar = rows[i]!;
    const prevClose = i > 0 ? closes[i - 1]! : bar.open;
    const hi = Math.max(bar.high, prevClose);
    const lo = Math.min(bar.low, prevClose);
    const rng = hi - lo;
    const position = rng > 0 ? ((bar.close - lo) / rng) * 2.0 - 1.0 : 0.0;
    const base = i > 0 ? volMa[i - 1]! : null;
    const ratio = base !== null && base > 0 ? bar.volume / base : null;
    const weight = ratio !== null ? Math.min(ratio, VOLUME_WEIGHT_CAP) : 1.0;
    raw.push(position * weight);
    ratios.push(ratio);
  }
  const pressure: Array<number | null> = smooth > 1 ? ema(raw, smooth) : [...raw];

  const ma = sma(closes, period);
  const dev: Array<number | null> = closes.map((c, i) => {
    const m = ma[i]!;
    return m !== null && m > 0 ? (c / m - 1.0) * 100.0 : null;
  });

  const start = Math.max(0, n - Math.trunc(keep));
  const series: Rec[] = [];
  for (let i = start; i < n; i++) {
    let z: number | null = null;
    let rank: number | null = null;
    const d = dev[i]!;
    if (d !== null) {
      const hist = dev.slice(Math.max(0, i - lookback + 1), i + 1).filter((v): v is number => v !== null);
      if (hist.length >= MIN_Z_SAMPLES) {
        const sd = stdev(hist);
        const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
        if (sd && sd > 0) z = (d - mean) / sd;
        rank = (hist.filter((v) => v <= d).length / hist.length) * 100.0;
      }
    }
    const bar = rows[i]!;
    const prevClose = i > 0 ? closes[i - 1]! : bar.open;
    const hi = Math.max(bar.high, prevClose), lo = Math.min(bar.low, prevClose);
    const buyPct = hi > lo ? ((bar.close - lo) / (hi - lo)) * 100.0 : 50.0;
    series.push({
      time: bar.time,
      close: pyRound(bar.close, 4),
      ma: ma[i] !== null ? pyRound(ma[i]!, 4) : null,
      dev_pct: d !== null ? pyRound(d, 2) : null,
      z: z !== null ? pyRound(z, 2) : null,
      rank_pct: rank !== null ? pyRound(rank, 1) : null,
      pressure: pressure[i] !== null ? pyRound(pressure[i]!, 3) : null,
      buy_pct: pyRound(buyPct, 1),
      volume_ratio: ratios[i] !== null ? pyRound(ratios[i]!, 2) : null,
    });
  }
  out["series"] = series;
  const last = series[series.length - 1]!;
  out["last"] = last;

  if (last["z"] !== null) {
    if (last["z"] >= zExtreme) { out["extreme"] = "overbought"; out["extreme_label"] = "上方极值(超买)"; }
    else if (last["z"] <= -zExtreme) { out["extreme"] = "oversold"; out["extreme_label"] = "下方极值(超卖)"; }
    else out["extreme_label"] = "偏离在常态区间";
  } else {
    out["extreme_label"] = "历史不足,未折 z 分数";
  }

  const withDev = series.filter((s) => s["dev_pct"] !== null);
  const withPressure = series.filter((s) => s["pressure"] !== null);
  if (withDev.length && withPressure.length) {
    const pickBy = (list: Rec[], key: string, wantMax: boolean): Rec => {
      let best = list[0]!;
      for (const s of list) {
        if (wantMax ? s[key] > best[key] : s[key] < best[key]) best = s;
      }
      return best;
    };
    const devMax = pickBy(withDev, "dev_pct", true), devMin = pickBy(withDev, "dev_pct", false);
    const prMax = pickBy(withPressure, "pressure", true), prMin = pickBy(withPressure, "pressure", false);
    out["window"] = {
      dev_max: { time: devMax["time"], dev_pct: devMax["dev_pct"] },
      dev_min: { time: devMin["time"], dev_pct: devMin["dev_pct"] },
      pressure_max: { time: prMax["time"], pressure: prMax["pressure"] },
      pressure_min: { time: prMin["time"], pressure: prMin["pressure"] },
    };
  }
  out["readout"] = devReadout(out, series, zExtreme);
  return out;
}

function devReadout(result: Rec, series: Rec[], zExtreme: number): string[] {
  const last = result["last"];
  const lines: string[] = [];
  if (last["dev_pct"] !== null) {
    const side = last["dev_pct"] >= 0 ? "上方" : "下方";
    let line = `收盘在 ${result["period"]} 周期均线${side} ${fmtF(Math.abs(last["dev_pct"]), 2)}%`;
    if (last["z"] !== null) {
      line += `,折近 ${result["lookback"]} 根历史 z = ${fmtSF(last["z"], 2)}(分位 ${fmtF(last["rank_pct"], 0)}%)`;
    }
    lines.push(line + "。");
  }
  if (last["pressure"] !== null) {
    const tone = last["pressure"] > 0.3 ? "买压占优" : last["pressure"] < -0.3 ? "卖压占优" : "买卖压力接近均衡";
    lines.push(
      `修正版买卖压力 ${fmtSF(last["pressure"], 3)}(${tone}),最近一根收盘位于真实区间 ${fmtF(last["buy_pct"], 0)}% 处。`,
    );
  }
  if (result["extreme"] === "overbought") {
    lines.push(`偏离已到上方极值:z ≥ ${fmtF(zExtreme, 1)},历史上这种拉伸幅度很少见。`);
    if (last["pressure"] !== null && last["pressure"] < 0) {
      lines.push("拉得很高但买压转负——推升的力量在减弱,注意衰竭。");
    }
  } else if (result["extreme"] === "oversold") {
    lines.push(`偏离已到下方极值:z ≤ -${fmtF(zExtreme, 1)},历史上这种下杀幅度很少见。`);
    if (last["pressure"] !== null && last["pressure"] > 0) {
      lines.push("跌得很深但买压转正——抛压在衰竭,拐点常在这种位置出现。");
    }
  }
  const window = result["window"];
  if (window) {
    lines.push(
      `本段(${series.length} 根)偏离最大 ${fmtSF(window["dev_max"]["dev_pct"], 2)}%(${window["dev_max"]["time"]}),` +
      `最小 ${fmtSF(window["dev_min"]["dev_pct"], 2)}%(${window["dev_min"]["time"]})。`,
    );
  }
  return lines;
}
