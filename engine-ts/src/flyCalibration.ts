/** 蝴蝶测算的 IV 模型怎么从历史数据里估出来(纯函数)。跑它的是 scripts/calibrate-fly-iv.mjs,结果落在 flyIvModel.ts。
 *
 * 用户 2026-09-28:「不要用经验公式,用历史数据校准」。第一版的两个公式(时段用止盈策略那份日内分布、
 * 走势用 √[1 + w(z² − 1)])拿历史数据一验:走势那一个在样本外比"IV 不变"还差——上涨时它让 IV 升,实际是降。
 *
 * 估三样:
 *
 * 1. **日内方差分布**(时段):常规时段里每半小时占全天方差的份额。每天的平方收益先除以当天开盘时的隐含水平
 *    (短期 IV 指数的平方),再求和取比——不归一的话几个暴跌日说了算。小时份额来自长样本(小时线),
 *    小时之内前后半小时怎么分来自短样本(5 分钟线):公开的分钟线只给最近 60 天。
 * 2. **IV 对走势的反应**:ln(IV 乘数) = a + b·u + c·u²。u = 这一段走了「全天标准差」的几倍,跌为负。
 *    解释变量是走了多远,不是走得多急——两样都试过,同样的距离一小时走完和四小时走完,IV 的变化差不多。
 *    IV 用的是短期 IV 指数(VIX1D),先减掉它自己的日内平均走法。前七成的交易日拟合,后三成检验。
 * 3. **残差有多宽**:sd ≈ k × √(这一段占全天方差的份额) × (g0 + g1·|u|)——走得越久越宽,走得越远也越宽。
 *    测算拿它给出"半数情况下"的区间;这个区间在样本里实际盖住了几成,一并记下来(fit.coverage_half)。
 *
 * 局限写在 docs/features/fly-plan.md:IV 指数是恒定 1 天期的,不是当日到期期权本身的 IV。
 * 所以还有第二条路(fitFromSamples):软件自己记下来的当日到期期权 IV(services/ivRecorder.ts)攒够了,
 * 拿它估同样的两样——IV 自己的日内走法、对走势的反应——估出来在留出的那一段上比指数那一份强,才换上去。
 */
import { ET, wallParts } from "./tz.js";

export interface Bar {
  /** K 线开始的时刻(秒) */
  sec: number;
  open: number;
  close: number;
}

export const OPEN_MINUTE = 9 * 60 + 30;
export const CLOSE_MINUTE = 16 * 60;
export const HOURS = 7; // 09:30 起每小时一根,最后一根是 15:30–16:00 的半小时
export const HALF_HOURS = 13;
/** u 夹在多少以内:再远的样本太少(两年里 |u| > 4 的不到十天),二次项在那儿说了不算 */
export const U_MAX = 4;

export interface Response { a: number; b: number; c: number }

export interface FlyIvModel {
  /** 校准是哪一天做的 */
  version: string;
  source: string;
  /** IV 用的是哪个指数 */
  proxy: string;
  period: { from: string; to: string };
  days: number;
  /** 13 个半小时桶(09:30 起)占常规时段方差的份额,和为 1 */
  variance_weights: number[];
  /** 实际的常规时段方差 ÷ (开盘时 IV 指数² / 252) */
  realized_to_implied: number;
  /** ln(IV 乘数) = a + b·u + c·u²,1 天期 */
  response: Response;
  /** 同一个式子,长一档期限的(VIX9D);非当日到期的蝶在两者之间按 ln(期限) 插值 */
  response_long: Response & { days: number } | null;
  /** 残差的标准差 = resid_k × √(这一段占全天方差的份额) × (resid_move.base + resid_move.slope × |u|) */
  resid_k: number;
  /** 走得越远残差越宽:上式里的那个一次式 */
  resid_move: { base: number; slope: number };
  /** 拿自己攒的当日到期期权 IV 估的那一份;没攒够、或者估出来不比指数那一份强,就是 null */
  own: OwnFit | null;
  fit: {
    /** 拟合用的观测数(每天 28 个窗口) */
    rows: number;
    r2_in: number;
    /** 前七成拟合、后三成检验 */
    r2_out: number;
    /** 同一段检验样本上,"IV 不变"的 R² */
    r2_out_flat: number;
    /** "半数情况下"的区间在样本里实际盖住了几成(该是 0.5 上下) */
    coverage_half: number;
    train: { from: string; to: string; days: number };
    test: { from: string; to: string; days: number };
  };
}

// ---------------------------------------------------------------- K 线 → 每天一行
function etOf(sec: number): { date: string; minute: number } {
  const w = wallParts(sec * 1000, ET);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, minute: w.hour * 60 + w.minute };
}

/** 常规时段里的 K 线按美东日期分开,每天按时间排好 */
export function sessions(bars: readonly Bar[]): Map<string, Array<Bar & { minute: number }>> {
  const out = new Map<string, Array<Bar & { minute: number }>>();
  for (const bar of bars) {
    if (!(bar.open > 0) || !(bar.close > 0)) continue;
    const { date, minute } = etOf(bar.sec);
    if (minute < OPEN_MINUTE || minute >= CLOSE_MINUTE) continue;
    const day = out.get(date) ?? [];
    day.push({ ...bar, minute });
    out.set(date, day);
  }
  for (const day of out.values()) day.sort((a, b) => a.minute - b.minute);
  return out;
}

/**
 * 一天在网格上的价:[开盘, 每根的收盘…]。根数不齐、不是从 09:30 起的那几天不要(半日市、数据缺口)。
 * **只用收盘价**:公开数据源的小时线里,IV 指数除第一根以外的开盘价对不上 5 分钟线(核对过,七成对不上),收盘价都对得上。
 */
export function gridOf(day: ReadonlyArray<Bar & { minute: number }> | undefined, stepMinutes: number): number[] | null {
  if (!day || !day.length || day[0]!.minute !== OPEN_MINUTE) return null;
  const expected = Math.ceil((CLOSE_MINUTE - OPEN_MINUTE) / stepMinutes);
  // 5 分钟线偶尔多一根或少一根(收盘那一笔),差两根以内照用;小时线必须正好
  if (stepMinutes >= 60 ? day.length !== expected : day.length < expected - 2) return null;
  return [day[0]!.open, ...day.map((b) => b.close)];
}

// ---------------------------------------------------------------- 日内方差分布
export interface ScaledDay {
  date: string;
  /** 每根 K 线的开始分钟 */
  minutes: number[];
  /** [开盘, 每根的收盘…] */
  grid: number[];
  /** 当天开盘时的隐含水平(IV 指数,百分数) */
  level: number;
}

/** 每个桶占全天方差的份额:平方对数收益除以当天的隐含方差之后求和,再取比 */
export function varianceShares(days: readonly ScaledDay[], buckets: number, bucketMinutes: number): number[] {
  const sum = new Array<number>(buckets).fill(0);
  for (const day of days) {
    const scale = (day.level / 100) ** 2 / 252;
    for (let i = 1; i < day.grid.length; i += 1) {
      const r = Math.log(day.grid[i]! / day.grid[i - 1]!);
      const bucket = Math.min(buckets - 1, Math.floor((day.minutes[i - 1]! - OPEN_MINUTE) / bucketMinutes));
      sum[bucket] = sum[bucket]! + (r * r) / scale;
    }
  }
  const total = sum.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("方差分布估不出来:没有可用的交易日");
  return sum.map((v) => v / total);
}

/** 小时份额(长样本)× 小时之内前后半小时的比例(短样本)。最后一小时桶本来就是半小时 */
export function halfHourWeights(hourly: readonly number[], fine: readonly number[]): number[] {
  if (hourly.length !== HOURS || fine.length !== HALF_HOURS) throw new Error("份额的个数不对");
  const out: number[] = [];
  for (let h = 0; h < HOURS - 1; h += 1) {
    const first = fine[2 * h]!, second = fine[2 * h + 1]!;
    const total = first + second;
    out.push(total > 0 ? (hourly[h]! * first) / total : hourly[h]! / 2, total > 0 ? (hourly[h]! * second) / total : hourly[h]! / 2);
  }
  out.push(hourly[HOURS - 1]!);
  return out;
}

/** 到这一分钟为止还剩全天方差的几成。桶内按匀速走 */
export function remainingShare(weights: readonly number[], minute: number): number {
  if (minute <= OPEN_MINUTE) return 1;
  if (minute >= CLOSE_MINUTE) return 0;
  const width = (CLOSE_MINUTE - OPEN_MINUTE) / weights.length;
  const elapsed = minute - OPEN_MINUTE;
  const bucket = Math.floor(elapsed / width);
  let used = 0;
  for (let i = 0; i < bucket; i += 1) used += weights[i]!;
  used += weights[bucket]! * ((elapsed - bucket * width) / width);
  return Math.max(0, Math.min(1, 1 - used));
}

// ---------------------------------------------------------------- IV 对走势的反应
export interface ResponseRow {
  date: string;
  /** 走了全天标准差的几倍,跌为负 */
  u: number;
  /** IV 指数的对数变化,已减掉它自己的日内平均走法 */
  y: number;
  /** 这一段占全天方差的份额 */
  share: number;
}

const clip = (u: number): number => Math.max(-U_MAX, Math.min(U_MAX, u));

export function predict(beta: Response, u: number): number {
  const x = clip(u);
  return beta.a + beta.b * x + beta.c * x * x;
}

/** 最小二乘:y = a + b·u + c·u² */
export function fitResponse(rows: readonly ResponseRow[]): Response {
  if (rows.length < 30) throw new Error(`样本太少(${rows.length} 个窗口),拟合不了 IV 的反应`);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const row of rows) {
    const u = clip(row.u), x = [1, u, u * u];
    for (let i = 0; i < 3; i += 1) {
      b[i] = b[i]! + x[i]! * row.y;
      for (let j = 0; j < 3; j += 1) A[i]![j] = A[i]![j]! + x[i]! * x[j]!;
    }
  }
  // 三元一次方程组:列主元消去
  for (let i = 0; i < 3; i += 1) {
    let p = i;
    for (let r = i + 1; r < 3; r += 1) if (Math.abs(A[r]![i]!) > Math.abs(A[p]![i]!)) p = r;
    [A[i], A[p]] = [A[p]!, A[i]!];
    [b[i], b[p]] = [b[p]!, b[i]!];
    if (Math.abs(A[i]![i]!) < 1e-12) throw new Error("拟合不了 IV 的反应:样本里的走势没有变化");
    for (let r = i + 1; r < 3; r += 1) {
      const f = A[r]![i]! / A[i]![i]!;
      for (let c = i; c < 3; c += 1) A[r]![c] = A[r]![c]! - f * A[i]![c]!;
      b[r] = b[r]! - f * b[i]!;
    }
  }
  const beta = [0, 0, 0];
  for (let i = 2; i >= 0; i -= 1) {
    let s = b[i]!;
    for (let c = i + 1; c < 3; c += 1) s -= A[i]![c]! * beta[c]!;
    beta[i] = s / A[i]![i]!;
  }
  return { a: beta[0]!, b: beta[1]!, c: beta[2]! };
}

/** 正态分布的上四分位:残差的标准差乘它,就是"半数情况下"那个区间的半宽 */
export const QUARTILE = 0.6745;

/** 残差的标准差:走得越久越宽,走得越远也越宽 */
export function residualSd(model: Pick<FlyIvModel, "resid_k" | "resid_move">, share: number, u: number): number {
  const x = Math.min(U_MAX, Math.abs(u));
  return model.resid_k * Math.sqrt(Math.max(0, share)) * Math.max(0.1, model.resid_move.base + model.resid_move.slope * x);
}

/**
 * 残差的宽度怎么随 |u| 变:标准化残差(÷ k√份额)的绝对值对 |u| 做一元回归。
 * 正态分布下 E|x| = sd × √(2/π),所以回归出来的一次式除以它就是 sd 的倍数。
 */
function residualByMove(rows: readonly ResponseRow[], beta: Response, k: number): { base: number; slope: number } {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const row of rows) {
    const x = Math.min(U_MAX, Math.abs(row.u));
    const y = Math.abs(row.y - predict(beta, row.u)) / (k * Math.sqrt(row.share));
    n += 1; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const scale = Math.sqrt(2 / Math.PI);
  return { base: (sy - slope * sx) / n / scale, slope: slope / scale };
}

/** 决定系数。beta 给 null = 预测恒为 0("IV 不变") */
export function rSquared(rows: readonly ResponseRow[], beta: Response | null): number {
  const mean = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  let sse = 0, sst = 0;
  for (const row of rows) {
    sse += (row.y - (beta === null ? 0 : predict(beta, row.u))) ** 2;
    sst += (row.y - mean) ** 2;
  }
  return 1 - sse / sst;
}

interface PairedDay { date: string; price: number[]; iv: number[]; level: number[] }

/** 每天 28 个窗口(小时网格上所有 i < j) */
function responseRows(
  days: readonly PairedDay[], drift: readonly number[], levelDrift: readonly number[], hourly: readonly number[], k2: number,
): ResponseRow[] {
  const rows: ResponseRow[] = [];
  for (const day of days) {
    for (let i = 0; i < HOURS; i += 1) {
      // 全天标准差:拿这一刻的隐含水平,去掉它自己的日内走法——测算那边用的是期权自己的 IV 折回全天,没有这一层走法
      const daySigma = Math.sqrt(k2 / 252) * (day.level[i]! * Math.exp(-levelDrift[i]!)) / 100;
      for (let j = i + 1; j <= HOURS; j += 1) {
        let share = 0;
        for (let h = i; h < j; h += 1) share += hourly[h]!;
        rows.push({
          date: day.date, share,
          u: Math.log(day.price[j]! / day.price[i]!) / daySigma,
          y: Math.log(day.iv[j]! / day.iv[i]!) - (drift[j]! - drift[i]!),
        });
      }
    }
  }
  return rows;
}

function driftOf(days: readonly PairedDay[], pick: (d: PairedDay) => number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i <= HOURS; i += 1) {
    out.push(days.reduce((a, d) => a + Math.log(pick(d)[i]! / pick(d)[0]!), 0) / days.length);
  }
  return out;
}

/** 5 分钟线上的半小时份额。当天的隐含水平取 IV 指数 09:30 那一根的开盘价 */
function fineShares(priceFine: readonly Bar[], iv: ReturnType<typeof sessions>): number[] {
  const days: ScaledDay[] = [];
  for (const [date, bars] of sessions(priceFine)) {
    const grid = gridOf(bars, 5), level = iv.get(date)?.[0]?.open;
    if (grid === null || !level) continue;
    days.push({ date, minutes: bars.map((b) => b.minute), grid, level });
  }
  if (days.length < 20) throw new Error(`5 分钟线只有 ${days.length} 天可用,不够分半小时(至少 20 天)`);
  return varianceShares(days, HALF_HOURS, 30);
}

export interface CalibrationInput {
  /** 标的的小时线(长样本)。用 ETF 而不是指数:指数 09:30 那一笔还是拿昨收拼的,隔夜的缺口会算进第一根里 */
  priceHourly: readonly Bar[];
  /** 标的的 5 分钟线(短样本),只用来把小时份额分成前后半小时 */
  priceFine: readonly Bar[];
  /** 已经有半小时份额时直接给(分段核对时用:5 分钟线只覆盖最近 60 天),给了就不看 priceFine */
  fineShares?: readonly number[];
  /** 短期 IV 指数的小时线(1 天期) */
  ivHourly: readonly Bar[];
  /** 长一档期限的 IV 指数的小时线;不给就不估期限上的衰减 */
  ivLongHourly?: readonly Bar[];
  ivLongDays?: number;
  source: string;
  proxy: string;
  version: string;
  /** 前多少比例的交易日用来拟合,其余检验 */
  trainShare?: number;
}

export function calibrate(input: CalibrationInput): FlyIvModel {
  const price = sessions(input.priceHourly), iv = sessions(input.ivHourly);
  const days: PairedDay[] = [];
  for (const [date, bars] of price) {
    const p = gridOf(bars, 60), v = gridOf(iv.get(date), 60);
    if (p === null || v === null) continue;
    days.push({ date, price: p, iv: v, level: v });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 60) throw new Error(`标的与 IV 指数都齐的交易日只有 ${days.length} 天,不够校准(至少 60 天)`);

  // ---- 日内方差分布 ----
  const hourMinutes = Array.from({ length: HOURS }, (_, i) => OPEN_MINUTE + i * 60);
  const hourly = varianceShares(
    days.map((d) => ({ date: d.date, minutes: hourMinutes, grid: d.price, level: d.iv[0]! })), HOURS, 60,
  );
  const weights = halfHourWeights(hourly, input.fineShares ?? fineShares(input.priceFine, iv));

  let k2 = 0;
  for (const d of days) {
    let rv = 0;
    for (let i = 1; i < d.price.length; i += 1) rv += Math.log(d.price[i]! / d.price[i - 1]!) ** 2;
    k2 += rv / ((d.iv[0]! / 100) ** 2 / 252);
  }
  k2 /= days.length;

  // ---- IV 的反应:前一段拟合,后一段检验;定稿的系数用全部样本 ----
  const cut = Math.floor(days.length * (input.trainShare ?? 0.7));
  const train = days.slice(0, cut), test = days.slice(cut);
  const trainDrift = driftOf(train, (d) => d.iv);
  const trainRows = responseRows(train, trainDrift, trainDrift, hourly, k2);
  const testRows = responseRows(test, trainDrift, trainDrift, hourly, k2);
  const trainBeta = fitResponse(trainRows);

  const drift = driftOf(days, (d) => d.iv);
  const rows = responseRows(days, drift, drift, hourly, k2);
  const response = fitResponse(rows);
  let scaled = 0;
  for (const row of rows) scaled += (row.y - predict(response, row.u)) ** 2 / row.share;
  const residK = Math.sqrt(scaled / rows.length);
  const residMove = residualByMove(rows, response, residK);
  let covered = 0;
  for (const row of rows) {
    const sd = residualSd({ resid_k: residK, resid_move: residMove }, row.share, row.u);
    if (Math.abs(row.y - predict(response, row.u)) <= QUARTILE * sd) covered += 1;
  }

  let long: FlyIvModel["response_long"] = null;
  if (input.ivLongHourly) {
    const longIv = sessions(input.ivLongHourly);
    const paired: PairedDay[] = [];
    for (const d of days) {
      const v = gridOf(longIv.get(d.date), 60);
      if (v !== null) paired.push({ ...d, iv: v });
    }
    if (paired.length >= 60) {
      const beta = fitResponse(responseRows(paired, driftOf(paired, (d) => d.iv), driftOf(paired, (d) => d.level), hourly, k2));
      long = { ...beta, days: input.ivLongDays ?? 9 };
    }
  }

  const span = (list: readonly PairedDay[]): { from: string; to: string; days: number } =>
    ({ from: list[0]!.date, to: list[list.length - 1]!.date, days: list.length });
  const round = (v: number, nd: number): number => Number(v.toFixed(nd));
  const beta4 = (r: Response): Response => ({ a: round(r.a, 4), b: round(r.b, 4), c: round(r.c, 4) });
  // 份额取四位小数之后和不一定正好是 1:差的那一点补在最大的那一桶上
  const rounded = weights.map((w) => round(w, 4));
  const top = rounded.indexOf(Math.max(...rounded));
  rounded[top] = round(rounded[top]! + 1 - rounded.reduce((a, b) => a + b, 0), 4);

  return {
    version: input.version, source: input.source, proxy: input.proxy,
    period: { from: days[0]!.date, to: days[days.length - 1]!.date }, days: days.length,
    variance_weights: rounded,
    realized_to_implied: round(k2, 3),
    response: beta4(response),
    response_long: long === null ? null : { ...beta4(long), days: long.days },
    resid_k: round(residK, 3),
    resid_move: { base: round(residMove.base, 3), slope: round(residMove.slope, 3) },
    own: null,
    fit: {
      rows: rows.length,
      r2_in: round(rSquared(rows, response), 3),
      r2_out: round(rSquared(testRows, trainBeta), 3),
      r2_out_flat: round(rSquared(testRows, null), 3),
      coverage_half: round(covered / rows.length, 3),
      train: span(train), test: span(test),
    },
  };
}

// ---------------------------------------------------------------- 自己攒的当日到期期权 IV
/** 记下来的一笔(ivSamples.IvSample 的子集;这里不引 domain 层的文件读写,只认数据) */
export interface OwnSample {
  t: number;
  spot: number;
  /** YYYYMMDD */
  expiry: string;
  legs: ReadonlyArray<{ strike: number; right: string; iv: number | null }>;
}

export interface OwnFit {
  period: { from: string; to: string };
  days: number;
  rows: number;
  response: Response;
  /** IV 自己的日内平均走法:10:00 起每半小时一个点、到 15:30,值是 ln(IV ÷ 10:00 的 IV) */
  drift: number[];
  resid_k: number;
  resid_move: { base: number; slope: number };
  fit: {
    r2_in: number;
    r2_out: number;
    /** 同一段留出的样本上,指数那一份系数的 R²——自己这一份要比它强才用 */
    r2_out_index: number;
    coverage_half: number;
  };
}

export const OWN_GRID_START = 10 * 60;
export const OWN_GRID_POINTS = 12;
export const OWN_MIN_DAYS = 40;
const OWN_MIN_ROWS = 1000;
/** 网格点前后几分钟之内的样本算这个点的(后台是五分钟一笔) */
const OWN_SNAP_MINUTES = 4;

const validIv = (iv: number | null | undefined): iv is number => typeof iv === "number" && iv > 0.01 && iv < 3;

interface OwnPoint { spot: number; minute: number; ivs: Map<string, number>; atm: number }

/** 一天的样本落到半小时网格上:每个点取最近的那一笔。平值 IV 取离现价最近的行权价(看涨看跌都有就取平均) */
function ownGrid(samples: readonly OwnSample[]): Array<OwnPoint | null> {
  const out: Array<OwnPoint | null> = [];
  for (let g = 0; g < OWN_GRID_POINTS; g += 1) {
    const minute = OWN_GRID_START + g * 30;
    let best: OwnSample | null = null, gap = OWN_SNAP_MINUTES + 1;
    for (const sample of samples) {
      const at = etOf(sample.t / 1000).minute + (sample.t % 60_000) / 60_000;
      if (Math.abs(at - minute) < gap) [best, gap] = [sample, Math.abs(at - minute)];
    }
    if (best === null || !(best.spot > 0)) { out.push(null); continue; }
    const ivs = new Map<string, number>();
    let near = Infinity;
    for (const leg of best.legs) {
      if (!validIv(leg.iv)) continue;
      ivs.set(`${leg.strike}${leg.right}`, leg.iv);
      near = Math.min(near, Math.abs(leg.strike - best.spot));
    }
    const atms = best.legs.filter((leg) => validIv(leg.iv) && Math.abs(leg.strike - best!.spot) === near).map((leg) => leg.iv as number);
    if (!atms.length) { out.push(null); continue; }
    out.push({ spot: best.spot, minute, ivs, atm: atms.reduce((a, b) => a + b, 0) / atms.length });
  }
  return out;
}

/** 两个网格点之间,同一条腿(同一个行权价)的 IV 对数变化,各腿取平均。没有两头都有的腿就是 null */
function legChange(a: OwnPoint, b: OwnPoint, within: number): number | null {
  let sum = 0, n = 0;
  for (const [key, iv] of a.ivs) {
    const later = b.ivs.get(key);
    // 只看起点附近的腿:离现价太远的虚值期权报价稀,IV 跳得厉害
    if (later === undefined || Math.abs(Number.parseFloat(key) - a.spot) > within) continue;
    sum += Math.log(later / iv);
    n += 1;
  }
  return n ? sum / n : null;
}

/**
 * 拿自己记下来的当日到期期权 IV 估:IV 自己的日内走法、对走势的反应、残差的宽度。
 *
 * 和指数那一路同一个式子、同一种检验(前七成的交易日拟合,后三成留出),差别在 y 与 u 的量法:
 * * y = 同一条腿(同一个行权价)的 IV 对数变化——测算里乘数就是乘在固定行权价的 IV 上的;
 * * u 的分母 = 期权自己的剩余波动折回全天(平值 IV × √剩余年数 ÷ √还剩几成),和测算里量 u 的办法一字不差。
 * 样本不够直接抛错,不给一份靠不住的系数。
 */
export function fitFromSamples(
  samples: readonly OwnSample[], model: Pick<FlyIvModel, "variance_weights" | "response">,
): OwnFit {
  const byDay = new Map<string, OwnSample[]>();
  for (const sample of samples) {
    const { date, minute } = etOf(sample.t / 1000);
    if (minute < OPEN_MINUTE || minute >= CLOSE_MINUTE) continue;
    if (sample.expiry !== date.replace(/-/g, "")) continue; // 只要当日到期的
    const day = byDay.get(date) ?? [];
    day.push(sample);
    byDay.set(date, day);
  }
  const days = [...byDay.entries()]
    .map(([date, list]) => ({ date, grid: ownGrid(list) }))
    .filter((d) => d.grid.filter((p) => p !== null).length >= 6)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < OWN_MIN_DAYS) {
    throw new Error(`自己攒的样本里,一天有六个半小时点以上的只有 ${days.length} 天,不够(至少 ${OWN_MIN_DAYS} 天)`);
  }

  const YEAR_MINUTES = 365 * 24 * 60;
  const daySigmaOf = (p: OwnPoint): number =>
    (p.atm * Math.sqrt((CLOSE_MINUTE - p.minute) / YEAR_MINUTES)) / Math.sqrt(remainingShare(model.variance_weights, p.minute));
  /** 半小时一步的平均变化累加起来,就是 IV 自己的日内走法 */
  const driftOver = (list: typeof days): number[] => {
    const drift = [0];
    for (let g = 1; g < OWN_GRID_POINTS; g += 1) {
      let sum = 0, n = 0;
      for (const day of list) {
        const a = day.grid[g - 1], b = day.grid[g];
        if (!a || !b) continue;
        const change = legChange(a, b, daySigmaOf(a) * a.spot);
        if (change !== null) { sum += change; n += 1; }
      }
      drift.push(drift[g - 1]! + (n ? sum / n : 0));
    }
    return drift;
  };
  const rowsOver = (list: typeof days, drift: readonly number[]): ResponseRow[] => {
    const rows: ResponseRow[] = [];
    for (const day of list) {
      for (let i = 0; i < OWN_GRID_POINTS; i += 1) {
        const a = day.grid[i];
        if (!a) continue;
        const sigma = daySigmaOf(a);
        for (let j = i + 1; j < OWN_GRID_POINTS; j += 1) {
          const b = day.grid[j];
          if (!b) continue;
          const change = legChange(a, b, sigma * a.spot);
          const share = remainingShare(model.variance_weights, a.minute) - remainingShare(model.variance_weights, b.minute);
          if (change === null || !(share > 0) || !(sigma > 0)) continue;
          rows.push({ date: day.date, share, u: Math.log(b.spot / a.spot) / sigma, y: change - (drift[j]! - drift[i]!) });
        }
      }
    }
    return rows;
  };

  const cut = Math.floor(days.length * 0.7);
  const train = days.slice(0, cut), test = days.slice(cut);
  const trainDrift = driftOver(train);
  const trainBeta = fitResponse(rowsOver(train, trainDrift));
  const testRows = rowsOver(test, trainDrift);
  const drift = driftOver(days);
  const rows = rowsOver(days, drift);
  if (rows.length < OWN_MIN_ROWS || testRows.length < 30) {
    throw new Error(`自己攒的样本只凑得出 ${rows.length} 个窗口,不够(至少 ${OWN_MIN_ROWS} 个)`);
  }
  const response = fitResponse(rows);
  let scaled = 0;
  for (const row of rows) scaled += (row.y - predict(response, row.u)) ** 2 / row.share;
  const residK = Math.sqrt(scaled / rows.length);
  const residMove = residualByMove(rows, response, residK);
  let covered = 0;
  for (const row of rows) {
    if (Math.abs(row.y - predict(response, row.u)) <= QUARTILE * residualSd({ resid_k: residK, resid_move: residMove }, row.share, row.u)) covered += 1;
  }
  const round = (v: number, nd: number): number => Number(v.toFixed(nd));
  return {
    period: { from: days[0]!.date, to: days[days.length - 1]!.date }, days: days.length, rows: rows.length,
    response: { a: round(response.a, 4), b: round(response.b, 4), c: round(response.c, 4) },
    drift: drift.map((v) => round(v, 4)),
    resid_k: round(residK, 3),
    resid_move: { base: round(residMove.base, 3), slope: round(residMove.slope, 3) },
    fit: {
      r2_in: round(rSquared(rows, response), 3),
      r2_out: round(rSquared(testRows, trainBeta), 3),
      r2_out_index: round(rSquared(testRows, model.response), 3),
      coverage_half: round(covered / rows.length, 3),
    },
  };
}

/** 自己那一份是不是该换上去:留出的那一段上明显是正的,而且不输指数那一份 */
export function ownIsBetter(own: OwnFit): boolean {
  return own.fit.r2_out > 0.1 && own.fit.r2_out >= own.fit.r2_out_index;
}

/** IV 自己的日内走法在某一分钟的值(网格之间线性插值,两头之外取端点) */
export function ownDriftAt(own: Pick<OwnFit, "drift">, minute: number): number {
  const x = (minute - OWN_GRID_START) / 30;
  if (x <= 0) return own.drift[0] ?? 0;
  const last = own.drift.length - 1;
  if (x >= last) return own.drift[last] ?? 0;
  const i = Math.floor(x);
  return own.drift[i]! + (own.drift[i + 1]! - own.drift[i]!) * (x - i);
}
