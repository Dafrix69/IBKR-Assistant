/** 大模型目录与当前配置。启动就读一次:交易指令页的就绪清单要知道 Key 配没配。 */
import { create } from 'zustand';
import { dafri, errorMessage } from '../bridge';
import type { LLMConfig, LlmCatalog, LlmProvider } from '../bridge';
import { showBanner } from './banner';

// 形状在引擎契约里(engine-ts/src/contract/llm.ts),从 bridge 拿;以前这里手抄过一份(字段全标成了可选,还少了 key_hint 与 keychain_*)
export type { LlmCatalog, LlmProvider };
export type LlmCurrent = LLMConfig;

const useStore = create<{ catalog: LlmCatalog | null }>(() => ({ catalog: null }));
let started = false;

export async function loadLlmCatalog(): Promise<LlmCatalog | null> {
  try {
    useStore.setState({ catalog: await dafri.llmCatalog() });
  } catch (err) {
    showBanner(`读取模型配置失败:${errorMessage(err)}`, false);
  }
  return useStore.getState().catalog;
}

export function startLlmFeed(): void {
  if (started) return;
  started = true;
  void loadLlmCatalog();
  dafri.on('engine-event', ({ event }) => {
    if (event === 'llm') void loadLlmCatalog();
  });
}

export function useLlmCatalog(): LlmCatalog | null {
  return useStore((s) => s.catalog);
}
