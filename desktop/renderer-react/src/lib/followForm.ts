/**
 * 「接入 → Discord 跟单」表单的纯逻辑:配置 ↔ 表单、保存前的检查、拼出要存的那一份。不 import 任何运行时的东西(只有类型),
 * 引擎那边的测试直接跑它(tests/desktop-follow-form.spec.ts)。
 *
 * 和「设置」页同一条教训:输入框清空是 null,`Number(null)` 是 0——上限那几格空着就存,等于把上限写成 0 或者被引擎拒掉。
 * 所以空着的格子不让存,而且一律写明是哪一格。
 */
import type { FollowConfig, FollowOutcome, FollowReaderState } from '../bridge';

export interface FollowForm {
  enabled: boolean;
  channelId: string;
  authorIds: string[];
  accounts: string[];
  maxAge: number | null;
  perDay: number | null;
  maxRisk: number | null;
  localInbox: boolean;
  localChannel: string;
}

/** Discord 的 ID(频道、用户、webhook 都是):一串 15–21 位数字。和引擎的 config.ts 同一个口径。 */
export const DISCORD_ID = /^\d{15,21}$/;
/** 本地收件的发送者:`local:` 加屏幕上的显示名。和引擎的 config.ts 同一个口径。 */
export const LOCAL_AUTHOR = /^local:[^\r\n]{1,80}$/;
/** 本地收件的频道名最长多少字。和引擎的 config.ts 同一个口径。 */
export const LOCAL_CHANNEL_MAX = 100;
/** 信任名单里的一项长得对不对。 */
export const isAuthorId = (id: string): boolean => DISCORD_ID.test(id) || LOCAL_AUTHOR.test(id);

export function toForm(cfg: FollowConfig): FollowForm {
  return {
    enabled: Boolean(cfg.enabled),
    channelId: cfg.channel_id ?? '',
    authorIds: [...(cfg.author_ids ?? [])],
    accounts: [...(cfg.accounts ?? [])],
    maxAge: cfg.max_age_seconds ?? null,
    perDay: cfg.max_orders_per_day ?? null,
    maxRisk: cfg.max_risk_usd ?? null,
    localInbox: Boolean(cfg.local_inbox),
    localChannel: cfg.local_channel ?? '',
  };
}

/** 保存之前要改的地方;空 = 可以存。 */
export function formProblems(form: FollowForm): string[] {
  const out: string[] = [];
  const channel = form.channelId.trim();
  if (channel && !DISCORD_ID.test(channel)) out.push('频道 ID 是一串 15–21 位数字(Discord 里右键频道 →「复制频道 ID」)');
  if (form.authorIds.some((id) => !isAuthorId(id))) out.push('信任名单里有不是 Discord ID、也不是本地收件显示名的条目');
  const localChannel = form.localChannel.trim();
  if (localChannel.length > LOCAL_CHANNEL_MAX || /[\r\n]/.test(form.localChannel)) out.push(`本地收件的频道名最多 ${LOCAL_CHANNEL_MAX} 字,不能换行`);
  if (form.enabled && !channel && !form.localInbox) out.push('打开自动跟单之前要先填频道 ID,或者打开本地收件');
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
    local_inbox: form.localInbox,
    local_channel: form.localChannel.trim(),
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** 和已保存的那一份比,表单改过没有。 */
export function isDirty(form: FollowForm, saved: FollowConfig | null): boolean {
  if (saved === null) return false;
  return form.enabled !== saved.enabled || form.channelId.trim() !== saved.channel_id ||
    !same(form.authorIds, saved.author_ids) || !same(form.accounts, saved.accounts) ||
    form.maxAge !== saved.max_age_seconds || form.perDay !== saved.max_orders_per_day || form.maxRisk !== saved.max_risk_usd ||
    form.localInbox !== Boolean(saved.local_inbox) || form.localChannel.trim() !== (saved.local_channel ?? '');
}

/** 往信任名单里加一个 ID;形状不对、已经在里面,原样返回。 */
export function addAuthor(form: FollowForm, id: string): FollowForm {
  const clean = id.trim();
  if (!isAuthorId(clean) || form.authorIds.includes(clean)) return form;
  return { ...form, authorIds: [...form.authorIds, clean] };
}

/**
 * 读窗口的程序此刻的样子 → 界面上那一行字。channel 是已保存的频道名。
 * 「在读」之外的每一种都要说清人该做什么:这一行是"它到底有没有在读"唯一看得见的地方。
 */
export function readerText(reader: FollowReaderState, channel: string): { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  switch (reader.state) {
    case 'off': return { tone: 'info', text: '关着' };
    case 'no_channel': return { tone: 'info', text: '没有填频道名:软件不自己读窗口,要自己运行脚本(见下面的步骤)。' };
    case 'unavailable': return { tone: 'warn', text: '这台电脑上的这一份软件没带读窗口的程序(只有 macOS 的安装包带着):要自己运行脚本。' };
    case 'starting': return { tone: 'info', text: '正在启动…' };
    case 'reading': return { tone: 'ok', text: `正在读「${reader.title ?? channel}」。Discord 要一直停在这个频道;锁屏、合盖、睡眠时读不到,期间的消息不补。` };
    case 'waiting': return { tone: 'warn', text: `没在读:Discord 没有窗口停在「${channel}」。切回那个频道就继续;离开期间的消息不补。` };
    case 'no_list': return { tone: 'bad', text: '没在读:窗口在这个频道,但消息读不到。退出 Discord,用 open -a Discord --args --force-renderer-accessibility 重新打开。' };
    case 'no_discord': return { tone: 'warn', text: '没在读:Discord 没在运行。打开它(要带 --force-renderer-accessibility)并停在这个频道。' };
    case 'untrusted': return { tone: 'bad', text: '没在读:软件没有辅助功能权限。系统设置 → 隐私与安全性 → 辅助功能,打开 IBKR-Assistant(换了新版本之后已经开着也读不到的话,先删掉再加一次);授权之后几秒内自己接上。' };
    case 'failed': return { tone: 'bad', text: reader.error ?? '读窗口的程序没有起来。' };
  }
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
