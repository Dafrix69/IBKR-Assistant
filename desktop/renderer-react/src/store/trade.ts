/**
 * 交易指令页的编辑器状态与提交动作。
 *
 * 为什么放在 store 而不是页面里:壳一次只挂载一页,状态留在组件里的话,切去看一眼订单看板
 * 再回来,输入框就空了、解析结果也没了——而这恰恰是发单前后最想回头核对的两样东西。
 * 提交也在这里跑,页面中途卸载不影响结果落地。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type Account, type InstructionSubmitResult } from '../bridge';
import { showBanner } from './banner';
import { loadPending } from './pending';
import { loadRecords } from './records';
import { brokerShortName, refreshStatus } from './status';

/** 引擎那份回执,外加这里自己量的耗时。`__elapsedMs` **不是引擎给的**,所以不在契约里:
 *  它是从点下按钮到回执到手的墙钟时间(含界面这一侧),给用户看"这次等了多久"。 */
export type SubmitPayload = InstructionSubmitResult & { __elapsedMs?: number };

export interface ComposerState {
  text: string;
  /** 正在跑的是哪一个按钮;null = 空闲 */
  busy: 'parse' | 'execute' | null;
  working: string | null;
  payload: SubmitPayload | null;
  failure: string | null;
}

const useStore = create<{ composer: ComposerState }>(() => ({
  composer: { text: '', busy: null, working: null, payload: null, failure: null },
}));

function set(part: Partial<ComposerState>) {
  useStore.setState((s) => ({ composer: { ...s.composer, ...part } }));
}

export function useComposer(): ComposerState {
  return useStore((s) => s.composer);
}

export function setInstruction(text: string): void {
  set({ text });
}

export function clearResult(): void {
  set({ payload: null, failure: null });
}

/** 想法页「发到解析」:把文本直接写进输入框(不是"待取的草稿",所以回到本页不会再灌一次)。 */
export function setTradeDraft(text: string): void {
  set({ text, payload: null, failure: null });
}

export async function submitInstruction(execute: boolean, accounts: string[]): Promise<void> {
  const composer = useStore.getState().composer;
  const body = composer.text.trim();
  if (!body || composer.busy) return;
  if (!accounts.length) {
    showBanner('请至少勾选一个发单账户', false);
    return;
  }
  if (execute) {
    // 这一步是在授权直接发单,值得一次明确的确认;勾了几个账户就在这里说清楚会发几份
    const fanout = accounts.length > 1 ? `同时发到 ${accounts.length} 个账户,每笔订单各一份:` : '目标账户:';
    const ok = await dafri.confirm({
      title: '发送真实订单',
      message: `这条指令解析后会直接发送到${brokerShortName()},没有二次确认环节。${fanout}${accounts.join('、')}。`,
      detail: body,
      confirmLabel: '我确认,发送',
    });
    if (!ok) return;
  }
  set({ busy: execute ? 'execute' : 'parse', working: execute ? '正在解析并发送…' : '正在解析…(最长约 1 分钟)', failure: null });
  const t0 = performance.now();
  try {
    const result: SubmitPayload = await dafri.submit(body, execute, accounts);
    result.__elapsedMs = Math.round(performance.now() - t0);
    set({ payload: result });
    await Promise.all([refreshStatus(), loadRecords(), loadPending()]);
  } catch (err) {
    set({ payload: null, failure: errorMessage(err) });
  } finally {
    set({ busy: null, working: null });
  }
}

// ---- 发单账户勾选:勾一个发一个,勾两个每笔各发一份(引擎按账户扇出)------------------
// 勾选状态存本地;没存过时默认只勾默认账户,行为与没有这个控件时一致。
const ACCOUNT_PICK_KEY = 'dafri-submit-accounts';

function readPicked(): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNT_PICK_KEY) || 'null');
    if (Array.isArray(raw)) return raw.map(String);
  } catch {
    /* 存坏了就当没存 */
  }
  return null;
}

// 只在启动时读一次盘:之后以内存里这一份为准,勾选立刻生效,不受写盘失败影响
// (null = 还没勾过,按默认账户来)
const usePicked = create<{ picked: string[] | null }>(() => ({ picked: readPicked() }));

export function savePickedAccounts(aliases: string[]): void {
  usePicked.setState({ picked: aliases });
  try {
    localStorage.setItem(ACCOUNT_PICK_KEY, JSON.stringify(aliases));
  } catch {
    /* 记不住就算了,本次会话仍然按用户勾的来 */
  }
}

export function selectedAccounts(usable: Account[]): string[] {
  if (!usable.length) return [];
  const aliases = usable.map((a) => a.alias);
  const picked = usePicked.getState().picked;
  if (picked === null) {
    const def = usable.find((a) => a.default) || usable[0];
    return [def.alias];
  }
  return picked.filter((alias) => aliases.includes(alias));
}

/** 勾选变化的订阅口:页面据此重算 selectedAccounts,不必自己维护计数器。 */
export function usePickedRevision(): string {
  return usePicked((s) => (s.picked === null ? '' : s.picked.join(' ')));
}

