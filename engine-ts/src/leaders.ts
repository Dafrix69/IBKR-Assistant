/**
 * 强势股筛选(docs/features/leaders.md):把实盘比赛优胜者公开过的选股规则逐条变成代码检查。
 *
 *  · Mark Minervini(美国投资锦标赛 1997、2021 冠军)的**趋势模板**:第二阶段上升趋势的 8 条,一条不过就淘汰;
 *    以及 **VCP 波动收缩形态**:基底里一次比一次浅的回撤、最后一次缩量,放量越过枢轴才是买点。
 *  · William O'Neil / David Ryan(美国投资锦标赛三连冠)的 CAN SLIM 里**日线算得出**的部分:
 *    RS 评级(L,领涨股)、放量新高(N、S)、大盘方向(M:派发日)。C / A / I 要财报与机构持仓,券商日线给不了,不假装算。
 *
 * 纯函数,不碰券商;只陈述数字与规则,不给买卖建议。均线自己算(CLAUDE.md:不引技术指标库)。
 */
import type { LeaderRow, LeadersResult, MarketRegime, TrendCheck, VcpResult } from "./contract/screener.js";
import { pyRound } from "./py.js";

/** 日线的一根:券商给的形状(date / time、OHLCV),字段都可能缺。 */
export interface DailyBarIn {
  date?: unknown;
  time?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

export interface LeaderMember {
  symbol: string;
  tag?: string;
  company?: string;
  bars: readonly DailyBarIn[];
  error?: string | null;
}

interface Bar {
  time: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 一个月按 22 个交易日算(Minervini:200 日线至少上行 1 个月)。 */
export const MONTH_BARS = 22;
/** 52 周 = 252 个交易日。 */
export const YEAR_BARS = 252;
/** 趋势模板第 6 条:至少比 52 周低点高 30%(《股票魔法师》的口径;新书放宽到 25%)。 */
export const ABOVE_LOW_PCT = 30;
/** 第 7 条:离 52 周高点不超过 25%。 */
export const NEAR_HIGH_PCT = 25;
/** 第 8 条:RS 评级至少 70。 */
export const MIN_RS_RATING = 70;
/** RS 评级至少要在几只里排才有意义;不够就只看跑赢基准没有。 */
export const MIN_RATING_UNIVERSE = 10;
/** VCP:找基底最多往回看多少根(约半年)。 */
export const VCP_LOOKBACK = 130;
/** 摆动高点的左右各几根。 */
export const SWING_STRENGTH = 3;
/** 比这个浅的回撤当噪音并掉(%)。 */
export const MIN_LEG_PCT = 1.5;
/** 放量:量 ≥ 50 日均量的倍数。枢轴突破 1.4 倍、52 周新高 1.5 倍。 */
export const BREAKOUT_VOLUME = 1.4;
export const NEW_HIGH_VOLUME = 1.5;
/** 派发日:跌至少 0.2%、量比前一天大;25 个交易日后过期,之后收盘涨回 5% 也作废(IBD 的口径)。 */
export const DIST_DROP = 0.002;
export const DIST_WINDOW = 25;
export const DIST_RECOVERY = 0.05;

function numOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 只留收盘为正、高低齐全的;量缺了算 0。 */
export function cleanDaily(bars: readonly DailyBarIn[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const c = numOf(b.close);
    if (c === null || c <= 0) continue;
    const h = numOf(b.high) ?? c;
    const l = numOf(b.low) ?? c;
    const v = numOf(b.volume);
    out.push({ time: String(b.date ?? b.time ?? ""), high: Math.max(h, c), low: Math.min(l, c), close: c, volume: v !== null && v > 0 ? v : 0 });
  }
  return out;
}

/** 截止第 end 根(含)的 n 日简单均线;不够 n 根是 null。 */
export function smaAt(values: readonly number[], n: number, end = values.length - 1): number | null {
  if (end < n - 1 || end >= values.length) return null;
  let acc = 0;
  for (let i = end - n + 1; i <= end; i += 1) acc += values[i] ?? 0;
  return acc / n;
}

function pct(a: number, b: number): number {
  return pyRound((a / b - 1) * 100, 2);
}

function r2(v: number | null): number | null {
  return v === null ? null : pyRound(v, 2);
}

// ---------------------------------------------------------------- RS 评级

/** IBD 式加权涨幅(%):0.4 × 近 63 日 + 0.2 × 近 126 / 189 / 252 日。不够 253 根是 null。 */
export function rsScore(closes: readonly number[]): number | null {
  const n = closes.length;
  const last = closes[n - 1];
  if (last === undefined || n <= YEAR_BARS) return null;
  const ret = (k: number): number => last / (closes[n - 1 - k] ?? last) - 1;
  return pyRound((0.4 * ret(63) + 0.2 * ret(126) + 0.2 * ret(189) + 0.2 * ret(252)) * 100, 2);
}

/** 百分位 1–99:比它低的有几只,按池子大小折。只有一只时是 null。 */
export function ratings(scores: ReadonlyArray<number | null>): Array<number | null> {
  const valid = scores.filter((s): s is number => s !== null);
  if (valid.length < 2) return scores.map(() => null);
  return scores.map((s) => (s === null ? null : Math.round((valid.filter((x) => x < s).length / (valid.length - 1)) * 98) + 1));
}

// ---------------------------------------------------------------- 趋势模板

/** 200 日线已经连续上行了几个月(每 22 根比一次,最多数 5 个月)。 */
function monthsRising(closes: readonly number[]): number {
  let months = 0;
  for (let m = 0; m < 5; m += 1) {
    const now = smaAt(closes, 200, closes.length - 1 - m * MONTH_BARS);
    const before = smaAt(closes, 200, closes.length - 1 - (m + 1) * MONTH_BARS);
    if (now === null || before === null || now <= before) break;
    months += 1;
  }
  return months;
}

export interface TrendInputs {
  close: number;
  ma50: number | null;
  ma150: number | null;
  ma200: number | null;
  ma200Months: number | null;
  high52: number;
  low52: number;
  fullYear: boolean;
  rsRating: number | null;
  rsVsBench: number | null;
  universe: number;
}

/** Minervini 趋势模板的 8 条。数据不够的那条是 null(判断不了),不算不及格,但也不算过。 */
export function trendTemplate(t: TrendInputs): TrendCheck[] {
  const { close, ma50, ma150, ma200 } = t;
  const f = (v: number | null): string => (v === null ? "—" : String(pyRound(v, 2)));
  const both = (a: number | null, b: number | null, test: (x: number, y: number) => boolean): boolean | null =>
    a === null || b === null ? null : test(a, b);
  const aboveLow = pct(close, t.low52);
  const fromHigh = pct(close, t.high52);
  const useRating = t.universe >= MIN_RATING_UNIVERSE;
  const rsOk = t.rsVsBench === null ? null
    : useRating ? (t.rsRating === null ? null : t.rsRating >= MIN_RS_RATING && t.rsVsBench > 0) : t.rsVsBench > 0;
  return [
    { key: "above_150_200", label: "价在 150 / 200 日线上", ok: ma150 === null || ma200 === null ? null : close > ma150 && close > ma200,
      detail: `收 ${f(close)} · 150 日 ${f(ma150)} · 200 日 ${f(ma200)}` },
    { key: "ma150_over_200", label: "150 日线在 200 日线上", ok: both(ma150, ma200, (a, b) => a > b), detail: `${f(ma150)} vs ${f(ma200)}` },
    { key: "ma200_rising", label: "200 日线上行至少 1 个月", ok: t.ma200Months === null ? null : t.ma200Months >= 1,
      detail: t.ma200Months === null ? "日线不够 222 根" : t.ma200Months >= 5 ? "已上行 5 个月以上" : `已上行约 ${t.ma200Months} 个月(最好 4–5 个月)` },
    { key: "ma50_over", label: "50 日线在 150 / 200 日线上", ok: ma50 === null || ma150 === null || ma200 === null ? null : ma50 > ma150 && ma50 > ma200,
      detail: `50 日 ${f(ma50)}` },
    { key: "above_50", label: "价在 50 日线上", ok: both(close, ma50, (a, b) => a > b), detail: `收 ${f(close)} vs ${f(ma50)}` },
    { key: "above_low", label: `比 52 周低点高 ${ABOVE_LOW_PCT}% 以上`, ok: aboveLow >= ABOVE_LOW_PCT,
      detail: `高出 ${aboveLow}%${t.fullYear ? "" : "(不足一年,按已有的算)"}` },
    { key: "near_high", label: `离 52 周高点 ${NEAR_HIGH_PCT}% 以内`, ok: fromHigh >= -NEAR_HIGH_PCT, detail: `离高点 ${fromHigh}%` },
    { key: "rs_rating", label: useRating ? `RS 评级 ≥ ${MIN_RS_RATING} 且跑赢基准` : "加权涨幅跑赢基准", ok: rsOk,
      detail: t.rsVsBench === null ? "日线不够一年,算不出 RS"
        : `${useRating ? `池内 RS ${t.rsRating ?? "—"} · ` : `池子只有 ${t.universe} 只,不排百分位 · `}比基准 ${t.rsVsBench > 0 ? "+" : ""}${t.rsVsBench} 个百分点` },
  ];
}

// ---------------------------------------------------------------- VCP

function swingHighs(bars: readonly Bar[], from: number, k: number): number[] {
  const out: number[] = [];
  for (let i = from + 1; i < bars.length - k; i += 1) {
    const h = bars[i]?.high ?? 0;
    let top = true;
    for (let j = i - k; j <= i + k && top; j += 1) {
      if (j !== i && (bars[j]?.high ?? 0) > h) top = false;
    }
    if (top) out.push(i);
  }
  return out;
}

function lowBetween(bars: readonly Bar[], from: number, to: number): number {
  let low = Infinity;
  for (let i = from; i <= to; i += 1) low = Math.min(low, bars[i]?.low ?? Infinity);
  return low;
}

/** 从基底的最高点起,把每两个摆动高点之间的最低点当一次回撤;后一个高点更高的并掉,太浅的并掉。 */
export function contractions(bars: readonly Bar[], start: number): { peaks: number[]; depths: number[] } {
  let peaks = [start, ...swingHighs(bars, start, SWING_STRENGTH)];
  for (let changed = true; changed;) {
    changed = false;
    // 后一个高点不低于前一个:前一次"收缩"只是基底里的一段,并掉
    for (let i = 1; i < peaks.length - 1; i += 1) {
      if ((bars[peaks[i + 1] ?? 0]?.high ?? 0) >= (bars[peaks[i] ?? 0]?.high ?? 0)) {
        peaks = peaks.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (let i = 1; i < peaks.length; i += 1) {
      const p = peaks[i] ?? 0;
      const next = peaks[i + 1] ?? bars.length;
      const high = bars[p]?.high ?? 0;
      if (high > 0 && ((high - lowBetween(bars, p + 1, next - 1)) / high) * 100 < MIN_LEG_PCT) {
        peaks = peaks.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  const depths: number[] = [];
  for (let i = 0; i < peaks.length; i += 1) {
    const p = peaks[i] ?? 0;
    const next = peaks[i + 1] ?? bars.length;
    const high = bars[p]?.high ?? 0;
    if (next - 1 < p + 1 || high <= 0) continue;
    depths.push(pyRound(((high - lowBetween(bars, p + 1, next - 1)) / high) * 100, 1));
  }
  return { peaks, depths };
}

const NO_VCP = (reason: string): VcpResult => ({
  found: false, depths: [], pivot: null, status: "none", distance_pct: null, volume_dryup: null, base_bars: null, reason,
});

/** VCP:至少两次收缩、一次比一次浅、第一次 ≤ 50%、最后一次 ≤ 15%;看最后一次收缩有没有缩量、收盘离枢轴多远。 */
export function detectVcp(bars: readonly Bar[]): VcpResult {
  const n = bars.length;
  if (n < 60) return NO_VCP("日线不够 60 根");
  const from = Math.max(0, n - VCP_LOOKBACK);
  let start = from;
  for (let i = from; i < n; i += 1) if ((bars[i]?.high ?? 0) > (bars[start]?.high ?? 0)) start = i;
  if (start > n - 1 - 2 * SWING_STRENGTH) return NO_VCP("还贴着新高,没有形成基底");
  const { peaks, depths } = contractions(bars, start);
  const pivotIdx = peaks[peaks.length - 1] ?? start;
  const pivot = bars[pivotIdx]?.high ?? null;
  const last = bars[n - 1];
  if (pivot === null || last === undefined) return NO_VCP("算不出枢轴");
  const vol50 = smaAt(bars.map((b) => b.volume), 50, n - 2);
  const legVols = bars.slice(pivotIdx + 1, n - 1).map((b) => b.volume);
  const dryup = vol50 === null || vol50 <= 0 || !legVols.length ? null : legVols.reduce((a, b) => a + b, 0) / legVols.length < vol50 * 0.8;
  const volRatio = vol50 !== null && vol50 > 0 ? last.volume / vol50 : null;
  const distance = pct(last.close, pivot);
  const shrinking = depths.length >= 2 && depths.every((d, i) => i === 0 || d < (depths[i - 1] ?? 0));
  const first = depths[0] ?? 0;
  const final = depths[depths.length - 1] ?? 0;
  const found = shrinking && first <= 50 && final <= 15;
  let status: VcpResult["status"];
  if (!found) status = "none";
  else if (last.close > pivot) status = volRatio !== null && volRatio >= BREAKOUT_VOLUME ? "breakout" : "weak_breakout";
  else if (distance >= -5) status = "near_pivot";
  else status = "forming";
  let reason = "";
  if (depths.length < 2) reason = "基底里只有一次回撤,还谈不上收缩";
  else if (!shrinking) reason = `回撤没有一次比一次浅(${depths.join(" → ")}%)`;
  else if (first > 50) reason = `第一次回撤 ${first}% 太深`;
  else if (final > 15) reason = `最后一次回撤 ${final}% 还不够紧`;
  else if (status === "weak_breakout") reason = `站上枢轴但量只有 50 日均量的 ${pyRound(volRatio ?? 0, 2)} 倍`;
  return {
    found, depths, pivot: pyRound(pivot, 2), status, distance_pct: distance, volume_dryup: dryup, base_bars: n - start, reason,
  };
}

// ---------------------------------------------------------------- 大盘方向

/** 派发日:近 25 根里跌 ≥ 0.2% 且量比前一天大的日子;之后收盘涨回 5% 的作废。 */
export function distributionDays(bars: readonly Bar[]): string[] {
  const out: string[] = [];
  const n = bars.length;
  for (let i = Math.max(1, n - DIST_WINDOW); i < n; i += 1) {
    const cur = bars[i], prev = bars[i - 1];
    if (cur === undefined || prev === undefined || cur.volume <= 0 || prev.volume <= 0) continue;
    if (cur.close > prev.close * (1 - DIST_DROP) || cur.volume <= prev.volume) continue;
    const recovered = bars.slice(i + 1).some((b) => b.close >= cur.close * (1 + DIST_RECOVERY));
    if (!recovered) out.push(cur.time.slice(0, 10));
  }
  return out;
}

export function marketRegime(symbol: string, raw: readonly DailyBarIn[]): MarketRegime {
  const bars = cleanDaily(raw);
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const close = closes[n - 1] ?? null;
  const ma50 = smaAt(closes, 50);
  const ma200 = smaAt(closes, 200);
  const ma200Prev = smaAt(closes, 200, n - 1 - MONTH_BARS);
  const rising = ma200 === null || ma200Prev === null ? null : ma200 > ma200Prev;
  const dist = distributionDays(bars);
  const high = closes.slice(-YEAR_BARS).reduce((a, b) => Math.max(a, b), 0);
  const off = close === null || high <= 0 ? null : pct(close, high);
  const base = { symbol, close: r2(close), ma50: r2(ma50), ma200: r2(ma200), ma200_rising: rising, off_high_pct: off,
    distribution_days: dist.length, distribution_dates: dist };
  if (close === null || ma50 === null || ma200 === null) {
    return { ...base, state: "unknown", label: "数据不够", text: `${symbol} 日线不够 200 根,判断不了大盘方向。` };
  }
  const side = (ma: number, n: number): string => (close > ma ? `在 ${n} 日线上` : `跌破 ${n} 日线`);
  const where = `${symbol} ${side(ma50, 50)}、${side(ma200, 200)},200 日线${rising ? "上行" : "走平或下行"};` +
    `近 ${DIST_WINDOW} 个交易日派发日 ${dist.length} 个,离一年高点 ${off ?? "—"}%。`;
  if (close < ma200 || (dist.length >= 6 && (off ?? 0) <= -6)) {
    return { ...base, state: "correction", label: "调整中",
      text: `${where}O'Neil:四只股票里有三只跟着大盘走,大盘调整时新突破多半失败;Minervini 这时把仓位降到很低甚至空仓。` };
  }
  if (dist.length >= 4 || close < ma50) {
    return { ...base, state: "pressure", label: "承压",
      text: `${where}派发日在累积或跌破了 50 日线:新仓位宜小、止损宜紧,先看领涨股能不能扛住。` };
  }
  return { ...base, state: "uptrend", label: "上升趋势", text: `${where}大盘站在冠军们愿意进攻的那一边。` };
}

// ---------------------------------------------------------------- 一只 / 一池

interface Computed {
  row: LeaderRow;
  closes: number[];
}

function verdictOf(row: LeaderRow): string {
  if (row.error) return "拉不到日线";
  if (row.close === null) return "没有日线";
  const tt = `趋势模板 ${row.passed}/8`;
  const v = row.vcp;
  const vcpText = v.status === "breakout" ? `VCP 放量突破枢轴 ${v.pivot}`
    : v.status === "weak_breakout" ? `站上 VCP 枢轴 ${v.pivot},但量不够`
      : v.status === "near_pivot" ? `VCP 离枢轴 ${v.pivot} 还有 ${Math.abs(v.distance_pct ?? 0)}%`
        : v.status === "forming" ? `VCP 收缩中(${v.depths.join(" → ")}%)` : "";
  // Minervini 的 VCP 要最后一次收缩缩量;没缩量的照样列出来,但结论里当场说,不藏在悬停里
  const dry = v.found && v.volume_dryup === false ? "(最后一次收缩没缩量)" : "";
  if (row.stage2) return [`${tt} · 第二阶段`, vcpText + dry, row.new_high_volume ? "放量新高" : ""].filter(Boolean).join(" · ");
  const failed = row.checks.filter((c) => c.ok === false).map((c) => c.label);
  return `${tt}${failed.length ? ` · 没过:${failed.slice(0, 2).join("、")}${failed.length > 2 ? " 等" : ""}` : ""}`;
}

function computeRow(m: LeaderMember): Computed {
  const bars = cleanDaily(m.bars);
  const closes = bars.map((b) => b.close);
  const n = bars.length;
  const last = bars[n - 1];
  const vols = bars.map((b) => b.volume);
  const vol50 = smaAt(vols, 50, n - 2);
  const year = bars.slice(-YEAR_BARS);
  const high52 = year.reduce((a, b) => Math.max(a, b.high), 0);
  const low52 = year.reduce((a, b) => Math.min(a, b.low), Infinity);
  const priorHigh = bars.slice(-YEAR_BARS, -1).reduce((a, b) => Math.max(a, b.close), 0);
  const volRatio = last !== undefined && vol50 !== null && vol50 > 0 ? pyRound(last.volume / vol50, 2) : null;
  const row: LeaderRow = {
    symbol: m.symbol, tag: m.tag ?? "", company: m.company ?? "", bars: n,
    close: last ? r2(last.close) : null,
    ma50: r2(smaAt(closes, 50)), ma150: r2(smaAt(closes, 150)), ma200: r2(smaAt(closes, 200)),
    high52: last ? r2(high52) : null, low52: last ? r2(low52) : null,
    pct_from_high: last ? pct(last.close, high52) : null, pct_above_low: last ? pct(last.close, low52) : null,
    rs_score: rsScore(closes), rs_rating: null, rs_vs_bench: null,
    checks: [], passed: 0, stage2: false,
    vcp: last ? detectVcp(bars) : NO_VCP("没有日线"),
    new_high_volume: last !== undefined && priorHigh > 0 && last.close >= priorHigh && volRatio !== null && volRatio >= NEW_HIGH_VOLUME,
    volume_ratio: volRatio,
    verdict: "",
    error: m.error ?? null,
  };
  return { row, closes };
}

const STATUS_RANK: Record<VcpResult["status"], number> = { breakout: 4, near_pivot: 3, weak_breakout: 2, forming: 1, none: 0 };

/** 一池成分股 + 基准日线 → 强势股筛选表。RS 评级在池内排百分位;排序:过的条数 → VCP 状态 → RS 评级。 */
export function screenLeaders(members: readonly LeaderMember[], benchBars: readonly DailyBarIn[], benchmark: string): Omit<LeadersResult, "sector" | "fetched_at"> {
  const computed = members.map(computeRow);
  const benchScore = rsScore(cleanDaily(benchBars).map((b) => b.close));
  const scores = computed.map((c) => c.row.rs_score);
  const rated = ratings(scores);
  const universe = scores.filter((s) => s !== null).length;
  for (const [i, c] of computed.entries()) {
    const row = c.row;
    row.rs_rating = rated[i] ?? null;
    row.rs_vs_bench = row.rs_score !== null && benchScore !== null ? pyRound(row.rs_score - benchScore, 2) : null;
    if (row.close !== null && row.high52 !== null && row.low52 !== null) {
      row.checks = trendTemplate({
        close: row.close, ma50: row.ma50, ma150: row.ma150, ma200: row.ma200,
        ma200Months: c.closes.length >= 200 + MONTH_BARS ? monthsRising(c.closes) : null,
        high52: row.high52, low52: row.low52, fullYear: c.closes.length >= YEAR_BARS,
        rsRating: row.rs_rating, rsVsBench: row.rs_vs_bench, universe,
      });
      row.passed = row.checks.filter((k) => k.ok === true).length;
      row.stage2 = row.passed === row.checks.length;
    }
    row.verdict = verdictOf(row);
  }
  const rows = computed.map((c) => c.row).sort((a, b) =>
    b.passed - a.passed || STATUS_RANK[b.vcp.status] - STATUS_RANK[a.vcp.status]
    || (b.rs_rating ?? -1) - (a.rs_rating ?? -1) || a.symbol.localeCompare(b.symbol));
  const notes = [
    `RS 评级是在这次扫的 ${universe} 只里排的百分位(IBD 的公式:近 3 个月 40%、前三个季度各 20%),不是全市场排名`,
    "CAN SLIM 里的当季 / 年度盈利增长(C、A)与机构持仓(I)要财报数据,券商日线给不了,这里没算",
    `大盘方向用 ${benchmark} 的日线与成交量近似;IBD 看的是指数本身`,
  ];
  if (universe < MIN_RATING_UNIVERSE) notes.push(`池子不到 ${MIN_RATING_UNIVERSE} 只,第 8 条只看加权涨幅有没有跑赢基准`);
  return {
    benchmark,
    market: marketRegime(benchmark, benchBars),
    rows,
    total: rows.length,
    stage2_count: rows.filter((r) => r.stage2).length,
    vcp_count: rows.filter((r) => r.vcp.found).length,
    rating_universe: universe,
    notes,
  };
}
