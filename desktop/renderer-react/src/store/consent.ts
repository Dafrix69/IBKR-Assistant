/**
 * 条款同意的状态。记录在主进程那边(desktop/consent.js:userData/consent.json),这里只是它的一份镜像,
 * 外加"现在要不要把条款摆出来"。
 *
 * 没同意现行条款之前,壳把整个界面挡在同意页后面(shell/ConsentGate.tsx);钱路径主进程另外挡着一道,
 * 界面被绕过也过不去。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type ConsentState } from '../bridge';

interface State {
  /** null = 还没问到 */
  consent: ConsentState | null;
  /** 从「关于」里点开重看(已经同意过) */
  viewing: boolean;
  error: string | null;
}

const useStore = create<State>(() => ({ consent: null, viewing: false, error: null }));
let started = false;

export async function loadConsent(): Promise<void> {
  try {
    useStore.setState({ consent: await dafri.consentState(), error: null });
  } catch (err) {
    // 问不到就按没同意处理:宁可多看一遍条款
    useStore.setState({ consent: { version: '', accepted: false, acceptedAt: null }, error: errorMessage(err) });
  }
}

export function startConsent(): void {
  if (started) return;
  started = true;
  void loadConsent();
}

/** version:界面上摆出来的那一版(lib/legalText.ts 从文本里读的)。 */
export async function acceptTerms(version: string): Promise<boolean> {
  try {
    useStore.setState({ consent: await dafri.acceptConsent(version), error: null, viewing: false });
    return true;
  } catch (err) {
    useStore.setState({ error: errorMessage(err) });
    return false;
  }
}

/** 不同意条款:退出应用(和 ⌘Q 走同一条路)。 */
export function quitApp(): void {
  void dafri.quit().catch(() => window.close());
}

export function showTerms(): void {
  useStore.setState({ viewing: true });
}

export function hideTerms(): void {
  useStore.setState({ viewing: false });
}

export function useConsent(): State {
  return useStore();
}
