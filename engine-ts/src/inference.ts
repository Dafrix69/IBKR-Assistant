/**
 * 小样本的区间与检验(docs/features/performance.md「区间与噪声」)。
 *
 * 绩效体检下结论之前先问一句"这点差别是不是噪声":比例给 Wilson 区间,平均数给 t 区间,两组比平均用 Welch,
 * 两组比时长用 Mann–Whitney 秩和,两组比比例用 Newcombe,中位数用次序统计量的精确区间。
 * 全是教科书上的闭式或精确算法,自己写、不引库。置信水平统一 95%:那是统计上的惯例,不是调出来的数。
 *
 * 带 `clustered` 的那几个不把每个观测当成一次独立的试验:同一簇(同一天)里的观测可以相关,只有簇与簇之间当独立。
 * 一天做三只蝶、三只都看同一个收盘价,那是一次半试验,不是三次;当成三次,区间就窄得不该那么窄。
 *
 * 纯函数,不 import 任何东西。
 */

/** 所有区间与检验共用的置信水平。 */
export const CONFIDENCE = 0.95;
/** 标准正态的 97.5% 分位数(双侧 95%)。 */
export const Z95 = 1.959963984540054;

export interface Interval {
  lo: number;
  hi: number;
}

// ---------------------------------------------------------------- t 分布

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x),Lanczos 近似(g = 7),x > 0。 */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let acc = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i += 1) acc += (LANCZOS[i] ?? 0) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

/** 不完全 β 函数的连分式(改进的 Lentz 法)。 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const guard = (v: number): number => (Math.abs(v) < TINY ? TINY : v);
  let c = 1;
  let d = 1 / guard(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 2000; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / guard(1 + even * d);
    c = guard(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / guard(1 + odd * d);
    c = guard(1 + odd / c);
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return h;
}

/** 正则化的不完全 β 函数 I_x(a, b)。 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // 连分式在 x 小的一侧收敛快,另一侧用对称式 I_x(a, b) = 1 − I_{1−x}(b, a)
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Student t 分布的累积概率 P(T ≤ t);自由度可以不是整数(Welch 的自由度就不是)。 */
export function tCdf(t: number, df: number): number {
  if (!(df > 0) || Number.isNaN(t)) return Number.NaN;
  if (t === 0) return 0.5;
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** t 分布的分位数:对 tCdf 二分(单调,不用导数)。 */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) return Number.NaN;
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p && hi < 1e15) hi *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- 一组

function meanOf(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本方差(除以 n − 1);不到 2 个是 0。 */
function varianceOf(xs: readonly number[], mean: number): number {
  return xs.length > 1 ? xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1) : 0;
}

/** 比例的 Wilson 区间(0–1)。样本小、比例贴着 0 或 1 时也不出界,比"p ± 1.96 × 标准误"靠得住。 */
export function wilsonInterval(successes: number, n: number): Interval | null {
  if (!(n > 0)) return null;
  const p = successes / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** 平均数的 t 区间。不到 2 个算不出。盈亏分布偏、尾巴厚时这个区间偏窄——它是下限,不是保证。 */
export function meanInterval(xs: readonly number[], level = CONFIDENCE): (Interval & { mean: number }) | null {
  if (xs.length < 2) return null;
  const mean = meanOf(xs);
  const half = tQuantile(1 - (1 - level) / 2, xs.length - 1) * Math.sqrt(varianceOf(xs, mean) / xs.length);
  return { mean, lo: mean - half, hi: mean + half };
}

/**
 * 中位数的精确区间(不假设分布):取第 k 小到第 k 大,k 是让覆盖率 ≥ level 的最大的那个。
 * 覆盖率来自二项分布 Bin(n, ½);95% 时 n < 6 连最小值到最大值都盖不够,返回 null——"几笔才够"由此而来,不是拍的。
 */
export function medianInterval(xs: readonly number[], level = CONFIDENCE): Interval | null {
  const n = xs.length;
  const tail = (1 - level) / 2;
  let cum = 0;
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    cum += Math.exp(logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1) + n * Math.log(0.5));
    if (cum > tail) break;
    k = i + 1;
  }
  if (k === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[k - 1];
  const hi = s[n - k];
  return lo === undefined || hi === undefined ? null : { lo, hi };
}

// ---------------------------------------------------------------- 成簇的观测

/** 一个观测与它所在的簇(绩效体检里簇 = 美东了结日)。 */
export interface Clustered {
  value: number;
  cluster: string;
}

/** 每一簇里各观测对平均数的离差之和。 */
function clusterDeviations(obs: readonly Clustered[], mean: number): Map<string, number> {
  const sums = new Map<string, number>();
  for (const o of obs) sums.set(o.cluster, (sums.get(o.cluster) ?? 0) + (o.value - mean));
  return sums;
}

/**
 * 平均数这个估计量的方差,两种算法里取大的:
 * 按簇的(簇合计的离差平方和 × G/(G−1) / N²,簇内相关时它才对)与当每个观测独立的(s²/N;簇太少时按簇的那个自己就不稳,拿它兜底)。
 * 每簇只有一个观测时两者相等。不到 2 簇时簇间的波动无从估起,返回 null。
 */
function clusteredVariance(obs: readonly Clustered[], mean: number): { variance: number; independent: number; clusters: number } | null {
  const deviations = clusterDeviations(obs, mean);
  const g = deviations.size;
  if (g < 2) return null;
  let acc = 0;
  for (const e of deviations.values()) acc += e * e;
  const byCluster = ((g / (g - 1)) * acc) / (obs.length * obs.length);
  const independent = varianceOf(obs.map((o) => o.value), mean) / obs.length;
  return { variance: Math.max(byCluster, independent), independent, clusters: g };
}

/** 平均数的 t 区间,同一簇里的观测可以相关;自由度是簇数 − 1。每簇一个观测时就是 `meanInterval`。不到 2 簇算不出。 */
export function clusteredMeanInterval(obs: readonly Clustered[], level = CONFIDENCE): (Interval & { mean: number }) | null {
  if (obs.length < 2) return null;
  const mean = meanOf(obs.map((o) => o.value));
  const v = clusteredVariance(obs, mean);
  if (v === null) return null;
  const half = tQuantile(1 - (1 - level) / 2, v.clusters - 1) * Math.sqrt(v.variance);
  return { mean, lo: mean - half, hi: mean + half };
}

/**
 * 两组平均数之差(a − b)的区间,同一簇里的观测可以相关。每组的方差同 `clusteredMeanInterval`,自由度按 Welch–Satterthwaite 拿簇数算;
 * 每簇一个观测、两组不共簇时就是 `welchInterval`。
 * 两组在同一簇里都有观测时:同涨同跌会让差别更确定,这里**不**靠它缩窄区间;此消彼长会让差别更不确定,这一头照实计入。
 * 哪一组不到 2 簇都算不出。
 */
export function clusteredDiffInterval(
  a: readonly Clustered[], b: readonly Clustered[], level = CONFIDENCE,
): (Interval & { diff: number }) | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = meanOf(a.map((o) => o.value));
  const mb = meanOf(b.map((o) => o.value));
  const va = clusteredVariance(a, ma);
  const vb = clusteredVariance(b, mb);
  if (va === null || vb === null) return null;
  const diff = ma - mb;
  const db = clusterDeviations(b, mb);
  let cross = 0;
  for (const [cluster, e] of clusterDeviations(a, ma)) cross += (e / a.length) * ((db.get(cluster) ?? 0) / b.length);
  const variance = va.variance + vb.variance - 2 * Math.min(cross, 0);
  if (!(variance > 0)) return { diff, lo: diff, hi: diff };
  const spread = va.variance ** 2 / (va.clusters - 1) + vb.variance ** 2 / (vb.clusters - 1);
  const df = spread > 0 ? (va.variance + vb.variance) ** 2 / spread : va.clusters + vb.clusters - 2;
  const half = tQuantile(1 - (1 - level) / 2, df) * Math.sqrt(variance);
  return { diff, lo: diff - half, hi: diff + half };
}

/**
 * 比例的 Wilson 区间,同一簇里的结果可以相关:先算设计效应(按簇的方差 / 当独立的方差,不小于 1),把样本数除以它再进 Wilson。
 * 每簇一个观测时设计效应是 1,就是 `wilsonInterval`。有好几个观测却都在同一簇里,相关多大无从估起,返回 null。
 */
export function clusteredWilsonInterval(obs: ReadonlyArray<{ hit: boolean; cluster: string }>): Interval | null {
  const n = obs.length;
  if (!n) return null;
  const hits = obs.filter((o) => o.hit).length;
  if (n === 1) return wilsonInterval(hits, n);
  const v = clusteredVariance(obs.map((o) => ({ value: o.hit ? 1 : 0, cluster: o.cluster })), hits / n);
  if (v === null) return null;
  const effect = v.independent > 0 ? Math.max(1, v.variance / v.independent) : 1;
  return wilsonInterval(hits / effect, n / effect);
}

// ---------------------------------------------------------------- 两组

/** 两组平均数之差(a − b)的 Welch 区间:两组方差不必相等。各不到 2 个算不出。 */
export function welchInterval(a: readonly number[], b: readonly number[], level = CONFIDENCE): (Interval & { diff: number }) | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = meanOf(a);
  const mb = meanOf(b);
  const va = varianceOf(a, ma) / a.length;
  const vb = varianceOf(b, mb) / b.length;
  const diff = ma - mb;
  const se2 = va + vb;
  if (!(se2 > 0)) return { diff, lo: diff, hi: diff };
  const df = (se2 * se2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const half = tQuantile(1 - (1 - level) / 2, df) * Math.sqrt(se2);
  return { diff, lo: diff - half, hi: diff + half };
}

/**
 * Mann–Whitney 秩和检验的 z(正 = a 那组偏大):并列取平均秩、方差做并列修正、带连续性修正的正态近似。
 * 比时长这类一头很长的量用它,不用平均数。|z| ≥ Z95 才算两组不一样。有一组是空的返回 null。
 */
export function mannWhitneyZ(a: readonly number[], b: readonly number[]): number | null {
  // 混进 NaN 时排不出秩(NaN 和谁都不相等,数并列的那一圈也走不出去):不算
  if (!a.length || !b.length || ![...a, ...b].every((v) => Number.isFinite(v))) return null;
  const all = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))].sort((x, y) => x.v - y.v);
  const total = all.length;
  let rankSum = 0;
  let ties = 0;
  for (let i = 0; i < total;) {
    let j = i;
    while (j < total && all[j]?.v === all[i]?.v) j += 1;
    const rank = (i + 1 + j) / 2; // 第 i+1 … j 名的平均
    const size = j - i;
    ties += size ** 3 - size;
    for (let k = i; k < j; k += 1) if (all[k]?.first) rankSum += rank;
    i = j;
  }
  const u = rankSum - (a.length * (a.length + 1)) / 2;
  const variance = ((a.length * b.length) / 12) * (total + 1 - ties / (total * (total - 1)));
  if (!(variance > 0)) return 0;
  const d = u - (a.length * b.length) / 2;
  return (Math.abs(d) <= 0.5 ? 0 : d - Math.sign(d) * 0.5) / Math.sqrt(variance);
}

/** 两个比例之差(x1/n1 − x2/n2)的 Newcombe 区间:由两边各自的 Wilson 区间拼出来。 */
export function proportionDiffInterval(x1: number, n1: number, x2: number, n2: number): (Interval & { diff: number }) | null {
  const w1 = wilsonInterval(x1, n1);
  const w2 = wilsonInterval(x2, n2);
  if (w1 === null || w2 === null) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const diff = p1 - p2;
  return {
    diff,
    lo: diff - Math.sqrt((p1 - w1.lo) ** 2 + (w2.hi - p2) ** 2),
    hi: diff + Math.sqrt((w1.hi - p1) ** 2 + (p2 - w2.lo) ** 2),
  };
}
