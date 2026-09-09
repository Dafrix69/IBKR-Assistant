/** 大模型目录与当前配置。启动就读一次:交易指令页的就绪清单要知道 Key 配没配。 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage } from '../bridge';
import { showBanner } from './banner';

export interface LlmProvider {
  key: string;
  label: string;
  default_model?: string;
  models?: string[];
  needs_base_url?: boolean;
  default_base_url?: string;
  supports_effort?: boolean;
  supports_temperature?: boolean;
  docs?: string;
}

export interface LlmCurrent {
  provider: string;
  model?: string;
  base_url?: string;
  effort?: string;
  temperature?: number | null;
  max_tokens?: number;
  timeout_s?: number;
}

export interface LlmCatalog {
  providers: LlmProvider[];
  current: LlmCurrent;
  key_configured?: Record<string, boolean>;
}

type Listener = () => void;
let catalog: LlmCatalog | null = null;
let started = false;
const listeners = new Set<Listener>();

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export async function loadLlmCatalog(): Promise<LlmCatalog | null> {
  try {
    catalog = await dafri.llmCatalog();
    listeners.forEach((l) => l());
  } catch (err) {
    showBanner(`读取模型配置失败:${errorMessage(err)}`, false);
  }
  return catalog;
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
  return useSyncExternalStore(subscribe, () => catalog);
}
