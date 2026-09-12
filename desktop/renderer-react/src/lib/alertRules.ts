/**
 * 提醒的判断口径:表里哪个数算"真放量"、一批异动该响什么音、弹窗到底收下了几条。
 *
 * 单独放成一个**不 import 任何东西、不碰 DOM 的纯模块**,是为了能被引擎那套 vitest 直接跑:
 * 界面这一侧最容易悄悄跑偏的就是这三件事——判定口径和引擎不一致(表里橙着却从来不弹窗)、
 * 文案说中性音实际响升调、一批里被弹窗丢掉的那几条谁也不管。编译期都发现不了,所以要有测试。
 */

// ---- 窗口量比 ----------------------------------------------------------------------
// 引擎(anomaly.ts)报不报窗口放量,看的不是窗口总量的倍数,而是"去掉窗口里最大的一步之后还有几倍":
// IB 会把大宗 / 暗池成交整笔补报进当日量,一笔就能顶出 5 倍,价格却一动没动。
//   sustained = (窗口量 − 最大一步) / 常态 = burst × (1 − block_share)
// 界面按同一道口径着色。注意引擎还要求窗口里至少有 MIN_BURST_STEPS 步,那个数不在 metrics 里——
// 步数不够时 block_share 仍可能有值,所以这里只会"多着色一点点",不会把引擎会报的那格判成不报。

/** 最大一步占到窗口量的这个比例,就当这格是一笔大单撑起来的,数字不作准 */
export const BLOCK_SHARE_HEAVY = 0.5;

export interface BurstMetrics {
  burst: number | null;
  block_share: number | null;
  basis_volume: 'avg_volume' | 'session_pace' | null;
}

/** none = 没有数;hot = 引擎这一轮真会报;muted = 被一笔大单撑起来的;reference = 窗口不是样本算的,只作参考 */
export type BurstLevel = 'none' | 'hot' | 'muted' | 'reference' | 'plain';

export interface BurstVerdict {
  level: BurstLevel;
  /** 悬停提示;没有可说的就是空串 */
  note: string;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 去掉尾零的倍数,4× 不写成 4.0× */
function times(v: number): string {
  return `${Math.round(v * 10) / 10}`;
}

/**
 * 窗口量比这一格怎么显示。threshold 是当前的窗口量比阈值(引擎的 burst_ratio)。
 * 只有"引擎这一轮真的会报"才给橙色——否则表里天天橙着、弹窗一次不来,人就不再信这一列了。
 */
export function burstVerdict(metrics: BurstMetrics | null | undefined, threshold: number): BurstVerdict {
  const v = finite(metrics?.burst);
  if (v === null) return { level: 'none', note: '' };
  const thr = finite(threshold);
  const notes: string[] = [];
  if (metrics!.basis_volume === 'session_pace') notes.push('这只没有日均量,按今天到目前的成交节奏估算常态。');
  const share = finite(metrics!.block_share);

  // block_share 只有样本窗口才有(见 anomaly.ts):没有就说明引擎这一轮判不出"是不是一笔大单",也就不会报
  if (share === null) {
    notes.push('窗口还不是按样本差算的(刚加入追踪、或样本断过),判不出是不是一笔大单补报——这个数只作参考,这一轮不会报。');
    return { level: 'reference', note: notes.join('') };
  }

  const sustained = v * (1 - share);
  const over = thr !== null && v >= thr;
  const hot = over && sustained >= thr!;
  const pct = Math.round(share * 100);
  // 大单占比高、或者够了倍数却是被一笔撑起来的,都要把话说清楚
  if (share >= BLOCK_SHARE_HEAVY || (over && !hot)) {
    const tail = over && !hot && thr !== null ? `,不到 ${times(thr)}× 的阈值,不算放量` : '';
    notes.push(`一笔大单占了窗口的 ${pct}%,去掉它只有 ${sustained.toFixed(1)}×${tail}。`);
  }
  // 引擎这一轮真会报(去掉最大一笔还够倍数):哪怕大单占比不低,也得是橙的——弹窗马上就来了
  if (hot) return { level: 'hot', note: notes.join('') };
  if (share >= BLOCK_SHARE_HEAVY || over) return { level: 'muted', note: notes.join('') };
  return { level: 'plain', note: notes.join('') };
}

// ---- 提示音 ------------------------------------------------------------------------

/** 提示音只认价格方向的那几类;放量(rvol / burst)一律中性——「提醒方式」里写的就是"放量是同一个音响两下" */
const VOLUME_KINDS = new Set(['rvol', 'burst']);

export interface TonedEvent {
  kind?: string;
  direction?: 'up' | 'down' | null;
}

/**
 * 一批提醒响一声,方向怎么定:只看价格类(急涨急跌 / 大涨大跌 / 上穿下破)。
 * 放量事件的 direction 是引擎顺手带上的涨跌方向,给圆点和色块用;拿它选音就会把"放量"报成升降调,
 * 和「提醒方式」里写的对不上。方向不一致(有涨有跌)或一条价格类都没有,都是中性的两声。
 */
export function toneDirection(events: readonly TonedEvent[] | null | undefined): 'up' | 'down' | null {
  const dirs = new Set<'up' | 'down'>();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || (typeof e.kind === 'string' && VOLUME_KINDS.has(e.kind))) continue;
    if (e.direction === 'up' || e.direction === 'down') dirs.add(e.direction);
  }
  return dirs.size === 1 ? [...dirs][0]! : null;
}

// ---- 弹窗回执 ----------------------------------------------------------------------

export interface PopupCounts {
  /** 弹窗真的收下的条数 */
  accepted: number;
  /** 超出弹窗单次上限、被丢掉的条数——调用方要把这几条退回系统通知,不能让它们悄无声息地没了 */
  dropped: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/**
 * 把主进程的回执读成"收了几条、丢了几条"。
 * 老的主进程只回 { shown },更老的什么都不回:都当成"全收下了",宁可少发一条系统通知,
 * 也不要每次都重复弹一遍。shown 为 0 是弹窗页坏了,这一批全部要退回系统通知。
 */
export function popupCounts(sent: number, res: unknown): PopupCounts {
  const n = Math.max(0, Math.floor(finite(sent) ?? 0));
  if (n === 0) return { accepted: 0, dropped: 0 };
  const r = res as { shown?: unknown; dropped?: unknown } | null | undefined;
  const shown = finite(r?.shown);
  const accepted = shown === null ? n : clamp(shown, 0, n);
  const reported = finite(r?.dropped);
  const dropped = reported === null ? n - accepted : clamp(reported, 0, n - accepted);
  return { accepted, dropped };
}
