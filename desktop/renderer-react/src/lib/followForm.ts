/**
 * 「接入 → Discord 跟单」表单的纯逻辑:配置 ↔ 表单、保存前的检查、拼出要存的那一份。不 import 任何运行时的东西(只有类型),
 * 引擎那边的测试直接跑它(tests/desktop-follow-form.spec.ts)。
 *
 * 和「设置」页同一条教训:输入框清空是 null,`Number(null)` 是 0——上限那几格空着就存,等于把上限写成 0 或者被引擎拒掉。
 * 所以空着的格子不让存,而且一律写明是哪一格。
 */
import type { FollowConfig, FollowOutcome } from '../bridge';

export interface FollowForm {
  enabled: boolean;
  channelId: string;
  authorIds: string[];
  accounts: string[];
  maxAge: number | null;
  perDay: number | null;
  maxRisk: number | null;
}

/** Discord 的 ID(频道、用户、webhook 都是):一串 15–21 位数字。和引擎的 config.ts 同一个口径。 */
export const DISCORD_ID = /^\d{15,21}$/;

export function toForm(cfg: FollowConfig): FollowForm {
  return {
    enabled: Boolean(cfg.enabled),
    channelId: cfg.channel_id ?? '',
    authorIds: [...(cfg.author_ids ?? [])],
    accounts: [...(cfg.accounts ?? [])],
    maxAge: cfg.max_age_seconds ?? null,
    perDay: cfg.max_orders_per_day ?? null,
    maxRisk: cfg.max_risk_usd ?? null,
  };
}

/** 保存之前要改的地方;空 = 可以存。 */
export function formProblems(form: FollowForm): string[] {
  const out: string[] = [];
  const channel = form.channelId.trim();
  if (channel && !DISCORD_ID.test(channel)) out.push('频道 ID 是一串 15–21 位数字(Discord 里右键频道 →「复制频道 ID」)');
  if (form.authorIds.some((id) => !DISCORD_ID.test(id))) out.push('信任名单里有不是 Discord ID 的条目');
  if (form.enabled && !channel) out.push('打开自动跟单之前要先填频道 ID');
  if (form.enabled && !form.authorIds.length) out.push('打开自动跟单之前至少要信任一个发送者');
  const range = (value: number | null, label: string, min: number, max: number | null, whole: boolean): void => {
    if (value === null || !Number.isFinite(value)) out.push(`${label}不能空着`);
    else if (value < min || (max !== null && value > max)) out.push(`${label}要在 ${min}${max !== null ? `–${max}` : ' 以上'}`);
    else if (whole && !Number.isInteger(value)) out.push(`${label}要填整数`);
  };
  range(form.maxAge, '「消息多旧就不跟」', 1, 600, true);
  range(form.perDay, '「每天最多跟几单」', 1, 100, true);
  range(form.maxRisk, '「每单最坏亏损上限」', 1, null, false);
  return out;
}

/** 表单 → 要存的那一份(也是确认框绑的那一份)。只在 formProblems 为空时调。 */
export function toConfig(form: FollowForm): FollowConfig {
  return {
    enabled: form.enabled,
    channel_id: form.channelId.trim(),
    author_ids: [...new Set(form.authorIds)],
    accounts: [...new Set(form.accounts)],
    max_age_seconds: Number(form.maxAge),
    max_orders_per_day: Number(form.perDay),
    max_risk_usd: Number(form.maxRisk),
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** 和已保存的那一份比,表单改过没有。 */
export function isDirty(form: FollowForm, saved: FollowConfig | null): boolean {
  if (saved === null) return false;
  return form.enabled !== saved.enabled || form.channelId.trim() !== saved.channel_id ||
    !same(form.authorIds, saved.author_ids) || !same(form.accounts, saved.accounts) ||
    form.maxAge !== saved.max_age_seconds || form.perDay !== saved.max_orders_per_day || form.maxRisk !== saved.max_risk_usd;
}

/** 往信任名单里加一个 ID;形状不对、已经在里面,原样返回。 */
export function addAuthor(form: FollowForm, id: string): FollowForm {
  const clean = id.trim();
  if (!DISCORD_ID.test(clean) || form.authorIds.includes(clean)) return form;
  return { ...form, authorIds: [...form.authorIds, clean] };
}

export const OUTCOME_LABEL: Record<FollowOutcome, string> = {
  sent: '已跟单',
  held: '没有发出',
  observed: '只观察',
  stale: '太旧',
  unparsed: '没接住',
  capped: '超上限',
  blocked: '闸门关着',
  rejected: '被拒',
};

/** 下场 → 标签的颜色:发出去了是绿,只观察是灰,其余都是"没跟",要让人看见。 */
export function outcomeTone(outcome: FollowOutcome): 'success' | 'default' | 'warning' | 'error' {
  if (outcome === 'sent') return 'success';
  if (outcome === 'observed') return 'default';
  return outcome === 'rejected' ? 'error' : 'warning';
}
