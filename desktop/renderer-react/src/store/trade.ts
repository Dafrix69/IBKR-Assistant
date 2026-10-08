/**
 * 交易指令页的编辑器状态与提交动作。
 *
 * 为什么放在 store 而不是页面里:壳一次只挂载一页,状态留在组件里的话,切去看一眼订单看板
 * 再回来,输入框就空了、解析结果也没了——而这恰恰是发单前后最想回头核对的两样东西。
 * 提交也在这里跑,页面中途卸载不影响结果落地。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type Account, type InstructionSubmitResult } from '../bridge';
import { pickAccounts } from '../lib/accountPick';
import { showBanner } from './banner';
import { loadPending } from './pending';
import { loadRecords } from './records';
import { brokerShortName, refreshStatus } from './status';

/** 引擎那份回执,外加这里自己量的耗时。`__elapsedMs` **不是引擎给的**,所以不在契约里:
 *  它是从点下按钮到回执到手的墙钟时间(含界面这一侧),给用户看"这次等了多久"。 */
export type SubmitPayload = InstructionSubmitResult & { __elapsedMs?: number };

/** 右栏摆的是哪一样:解析结果、蝴蝶测算,还是 SPX 日内剧本 */
export type TradePane = 'result' | 'fly' | 'playbook';

export interface ComposerState {
  text: string;
  pane: TradePane;
  /** 正在跑的是哪一个按钮;null = 空闲 */
  busy: 'parse' | 'execute' | null;
  working: string | null;
  payload: SubmitPayload | null;
  failure: string | null;
}

const useStore = create<{ composer: ComposerState }>(() => ({
  composer: { text: '', pane: 'result', busy: null, working: null, payload: null, failure: null },
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

export function setTradePane(pane: TradePane): void {
  set({ pane });
}

/** 蝴蝶测算的「写进指令」:输入框空着就填进去,有字就另起一行接在后面——不覆盖用户已经写的 */
export function appendInstruction(line: string): void {
  const text = useStore.getState().composer.text;
  set({ text: text.trim() ? `${text.replace(/\s+$/, '')}\n${line}` : line });
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
    // 这一步是在授权直接发单,值得一次明确的确认。指令原文、发到哪些账户、各是纸面还是实盘,由主进程自己写在
    // 确认框上(账户类别它去问引擎);这里绑的内容(binding)要和下面 submit 的入参是同一份,对不上主进程不放行
    const ok = await dafri.confirm({
      purpose: 'instruction.submit',
      binding: { text: body, accounts },
      title: '发送真实订单',
      message: `这条指令解析后会直接发送到${brokerShortName()},没有二次确认环节。`,
      confirmLabel: '我确认,发送',
    });
    if (!ok) return;
  }
  // 右栏要是正摆着蝴蝶测算,切回解析结果:点了按钮却看不到结果,会以为没反应
  set({ pane: 'result', busy: execute ? 'execute' : 'parse', working: execute ? '正在解析并发送…' : '正在解析…(最长约 1 分钟)', failure: null });
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
// 勾选状态存本地;没存过时默认只勾默认账户,行为与没有这个控件时一致(规则见 lib/accountPick.ts)。
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

/** 这一次发到哪几个账户。规则(只有一个账户、存的勾选已经对不上时回到默认账户)在 lib/accountPick.ts。 */
export function selectedAccounts(usable: Account[]): string[] {
  return pickAccounts(usable, usePicked.getState().picked);
}

/** 勾选变化的订阅口:页面据此重算 selectedAccounts,不必自己维护计数器。 */
export function usePickedRevision(): string {
  return usePicked((s) => (s.picked === null ? '' : s.picked.join(' ')));
}

