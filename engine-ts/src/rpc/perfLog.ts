/** RPC 的耗时分两段记:在道上排了多久、执行了多久;每 FLUSH_MS 写一行分位数汇总。
 *
 * 以前只有「慢请求」一行,数字是开始执行之后的时长:排在读道 / 交易道后面等了多久看不见,
 * 一条慢请求是自己慢还是被前面的挡住,只能从日志里猜(docs/journal/sleep-read-as-stall.md)。
 *
 *  · 慢请求那一行格式照旧,数字仍是执行时长(以前的分析照读);排队超过 QUEUE_NOTE_MS 时在后面补「排队 N ms」。
 *    排队或执行任一段超过 SLOW_MS 都记。
 *  · 每 FLUSH_MS 一行 `[perf] {json}`:每个方法这一窗口的次数、执行与排队的 p50 / p90 / p99 / 最大,以及调用方递进来的计数。
 *    窗口里一个请求都没有就不写。原始样本不落盘,只落分位数;只有方法名与毫秒数,没有入参。
 *
 * 纯计算,不认识 RPC 服务器:server.ts 收到请求时记时刻,答完时调 record。
 */

export type Lane = "local" | "read" | "trade";

/** 多久写一行汇总。十分钟:一天 144 行,够看出哪一段变慢,又不刷屏 */
export const FLUSH_MS = 10 * 60_000;
/** 排队超过这么久才在慢请求那一行里写出来 */
export const QUEUE_NOTE_MS = 100;
/** 每个方法每个窗口最多留的样本数,再多按蓄水池抽样(最大值另记,不丢) */
export const MAX_SAMPLES = 5_000;

interface Bucket {
  lane: Lane;
  n: number;
  wait: number[];
  run: number[];
  waitMax: number;
  runMax: number;
}

export interface MethodSummary {
  lane: Lane;
  n: number;
  run: { p50: number; p90: number; p99: number; max: number };
  wait: { p50: number; p90: number; p99: number; max: number };
}

/** 最近秩分位数:排好序的样本里第 ⌈q·n⌉ 个。没有样本是 0 */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/** 慢请求那一行;两段都不慢回 null */
export function slowLine(method: string, waitMs: number, runMs: number, slowMs: number): string | null {
  if (runMs < slowMs && waitMs < slowMs) return null;
  const queued = waitMs >= QUEUE_NOTE_MS ? `,排队 ${Math.round(waitMs)} ms` : "";
  return `[rpc] 慢请求 ${method} ${Math.round(runMs)} ms${queued}`;
}

const spread = (xs: number[], max: number): MethodSummary["run"] => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: Math.round(quantile(s, 0.5)), p90: Math.round(quantile(s, 0.9)), p99: Math.round(quantile(s, 0.99)), max: Math.round(max) };
};

export class RpcTimings {
  private buckets = new Map<string, Bucket>();
  private since: number;

  constructor(now: number = Date.now(), private readonly random: () => number = Math.random) {
    this.since = now;
  }

  record(method: string, lane: Lane, waitMs: number, runMs: number): void {
    const b = this.buckets.get(method) ?? { lane, n: 0, wait: [], run: [], waitMax: 0, runMax: 0 };
    this.buckets.set(method, b);
    b.n += 1;
    b.waitMax = Math.max(b.waitMax, waitMs);
    b.runMax = Math.max(b.runMax, runMs);
    if (b.run.length < MAX_SAMPLES) {
      b.wait.push(waitMs);
      b.run.push(runMs);
      return;
    }
    const slot = Math.floor(this.random() * b.n);
    if (slot < MAX_SAMPLES) {
      b.wait[slot] = waitMs;
      b.run[slot] = runMs;
    }
  }

  summary(): Record<string, MethodSummary> {
    const out: Record<string, MethodSummary> = {};
    for (const [method, b] of [...this.buckets].sort(([a], [z]) => a.localeCompare(z))) {
      out[method] = { lane: b.lane, n: b.n, run: spread(b.run, b.runMax), wait: spread(b.wait, b.waitMax) };
    }
    return out;
  }

  /** 这一窗口的汇总行,写完清零;一个请求都没有回 null */
  flush(now: number = Date.now(), extra: Record<string, unknown> = {}): string | null {
    const methods = this.summary();
    const from = this.since;
    this.buckets = new Map();
    this.since = now;
    if (!Object.keys(methods).length) return null;
    const window = { from: new Date(from).toISOString(), to: new Date(now).toISOString() };
    return `[perf] ${JSON.stringify({ window, methods, ...extra })}`;
  }
}
