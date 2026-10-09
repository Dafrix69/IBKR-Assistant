/**
 * 持仓追踪的「出场细则」那一组表单:到点平仓、分批止盈、标的止损的确认秒数、止损按哪个价判、止损类的追价节奏。
 *
 * 和 spotStopFormat.ts 一样是**不碰 DOM 的纯模块**(只从 bridge import 类型,编译后一行 import 都不剩),引擎那套 vitest 直接跑它
 * (desktop-track-exit-form.spec)。判定都在引擎(trackerExits.ts、engine/exits.ts),这里只管:表单里的值怎么变成
 * tracker.add 的载荷、确认框里怎么说、卡片上怎么摆。口径见 docs/features/tracker.md「出场细则」。
 */
import type { AutoClose, TakeProfitTier, Targets, TrackerAddParams } from '../bridge';

export interface TierField {
  price: number | null;
  fraction: number | null;
}

export interface ExitFields {
  /** 美东 "HH:MM";空串 = 不设 */
  exitAt: string;
  /** 标的止损价的确认秒数;空 = 触线即算 */
  stopConfirm: number | null;
  /** 止损类拿哪个价判 */
  stopBasis: 'mid' | 'natural';
  /** 止损类的追价节奏;空 = 和止盈同一套 */
  chaseGrace: number | null;
  chaseStep: number | null;
  chaseMax: number | null;
  /** 峰值要连续两秒都见到才往有利方向推(期权与组合);默认不勾 */
  peakConfirm: boolean;
  tiers: TierField[];
}

export const emptyExitFields: ExitFields = {
  exitAt: '', stopConfirm: null, stopBasis: 'mid', chaseGrace: null, chaseStep: null, chaseMax: null, peakConfirm: false, tiers: [],
};

/** 最多几档(引擎 trackerExits.MAX_TP_TIERS) */
export const MAX_TIERS = 4;

const str = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
const clockOk = (text: string): boolean => /^([01]?\d|2[0-3]):[0-5]\d$/.test(text.trim());

/** 填了一半的那几档(只填了价或只填了比例)不算数;两样都填了的才进载荷 */
function filledTiers(tiers: TierField[]): Array<{ price: string; fraction_pct: string }> {
  return tiers
    .filter((t) => t.price !== null && t.fraction !== null)
    .map((t) => ({ price: str(t.price), fraction_pct: str(t.fraction) }));
}

type ExitSpec = Pick<TrackerAddParams,
  'exit_at' | 'spot_stop_confirm_s' | 'take_profit_tiers' | 'stop_basis' | 'stop_chase_grace' | 'stop_chase_step' | 'stop_chase_max_pct' | 'peak_confirm'>;

/**
 * 表单 → tracker.add 载荷里的那几个键。数值照界面的老规矩给字符串,'' = 不设。
 * 正股没有「可成交价」与追价(引擎会拒),所以不是期权 / 组合时这几项一律不带。
 */
export function exitSpec(f: ExitFields, derivative: boolean): ExitSpec {
  const tiers = filledTiers(f.tiers);
  return {
    exit_at: f.exitAt.trim(),
    spot_stop_confirm_s: derivative ? str(f.stopConfirm) : '',
    take_profit_tiers: tiers.length ? tiers : '',
    stop_basis: derivative ? f.stopBasis : undefined,
    stop_chase_grace: derivative ? str(f.chaseGrace) || undefined : undefined,
    stop_chase_step: derivative ? str(f.chaseStep) || undefined : undefined,
    stop_chase_max_pct: derivative ? str(f.chaseMax) || undefined : undefined,
    peak_confirm: derivative && f.peakConfirm ? true : undefined,
  };
}

/** 提交之前在界面这头就能看出来的毛病(引擎会再查一遍,话以引擎为准);没有回空数组 */
export function exitProblems(f: ExitFields, opts: { hosted: boolean; hasSpotStop: boolean }): string[] {
  const out: string[] = [];
  if (f.exitAt.trim() && !clockOk(f.exitAt)) out.push('到点平仓的时刻要写成美东时间的 HH:MM,如 15:45。');
  if (f.tiers.some((t) => (t.price === null) !== (t.fraction === null))) out.push('分批止盈的每一档要把价和比例都填上。');
  if (filledTiers(f.tiers).length && opts.hosted) out.push('分批止盈只支持软件盯盘:托管到券商时不能设。');
  if (f.stopConfirm !== null && f.stopConfirm > 0 && !opts.hasSpotStop) out.push('确认秒数是给标的止损价用的:先填「标的跌到」或「标的涨到」。');
  return out;
}

/** 确认框里的那几行(带换行);一样都没设回空串。这些规则会让软件自己发平仓单,要写在人点「确认」的那个框里 */
export function exitConfirmLines(f: ExitFields, derivative: boolean): string {
  const lines: string[] = [];
  if (f.exitAt.trim()) lines.push(`到点平仓:下一次到美东 ${f.exitAt.trim()} 时持仓还在就平(不算止损);软件开着时才盯。`);
  const tiers = filledTiers(f.tiers);
  if (tiers.length) {
    lines.push(`分批止盈:${tiers.map((t, i) => `第 ${i + 1} 档到 ${t.price} 平 ${t.fraction_pct}%`).join(',')}。每一档成交之后接着盯剩下的仓。`);
  }
  if (derivative && f.stopConfirm !== null && f.stopConfirm > 0) lines.push(`标的止损要标的在线外连续待满 ${f.stopConfirm} 秒才平。`);
  if (derivative && f.stopBasis === 'natural') lines.push('止损、跟踪止损、利润回撤按「此刻立刻能成交的价」判(盘口变宽时会比按中间价判更早触发)。');
  if (derivative && (f.chaseGrace !== null || f.chaseStep !== null || f.chaseMax !== null)) {
    lines.push(
      `止损类触发后的追价:${f.chaseGrace !== null ? `先等 ${f.chaseGrace} 秒` : '先等 2 秒'},` +
      `之后每秒让 ${f.chaseStep ?? 1} 跳${f.chaseMax !== null ? `,最多让到立刻成交价的 ${f.chaseMax}%` : ''}。`,
    );
  }
  if (derivative && f.peakConfirm) lines.push('峰值要连续两秒都见到才往上推:跟踪止损与利润回撤的峰值晚一秒,只出现一秒的高点不算。');
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------- 卡片上怎么摆
const price = (v: number): string => String(Number(Number(v).toFixed(4)));

/** 分批止盈一档的状态:做完了 / 在等成交 / 还没到 */
export function tierLabel(tier: TakeProfitTier, index: number): string {
  const state = tier.done ? '已成交' : tier.pending ? '平仓单已发,等成交' : '未到';
  return `第 ${index + 1} 档 ${price(tier.price)} 平 ${price(tier.fraction_pct)}%(${state})`;
}

/** 到点平仓的那一刻写成「美东 月-日 时:分」:钟点今天已经过了的,存下来的是明天的,卡片上要看得出是哪一天 */
export function exitMoment(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 卡片摘要里的几项:到点平仓、分批止盈、止损的口径、止损类的追价。没设的不出现 */
export function exitSummary(targets: Partial<Targets>, auto: Partial<AutoClose>): string[] {
  const out: string[] = [];
  if (targets.exit_at) {
    // 时刻被清掉了 = 到点那天没平掉、这一次已经作废(引擎当时提醒过);点「恢复」或重新设置才有下一次
    out.push(typeof targets.exit_at_ms === 'number'
      ? `到点平仓 美东 ${exitMoment(targets.exit_at_ms)}`
      : `到点平仓 美东 ${targets.exit_at}(已过期,不会再触发)`);
  }
  const tiers = targets.take_profit_tiers ?? [];
  if (tiers.length) out.push(`分批止盈 ${tiers.filter((t) => t.done).length}/${tiers.length} 档`);
  if (targets.spot_stop_confirm_s) out.push(`标的止损确认 ${targets.spot_stop_confirm_s} 秒`);
  if (auto.stop_basis === 'natural') out.push('止损按可成交价判');
  if (auto.peak_confirm) out.push('峰值两秒确认');
  const chase = [auto.stop_chase_grace, auto.stop_chase_step, auto.stop_chase_max_pct];
  if (chase.some((v) => v !== null && v !== undefined)) {
    out.push(`止损追价 等 ${auto.stop_chase_grace ?? 2} 秒 / 每秒 ${auto.stop_chase_step ?? 1} 跳${auto.stop_chase_max_pct != null ? ` / 最多 ${auto.stop_chase_max_pct}%` : ''}`);
  }
  return out;
}
