/** 引擎日志:从启动起就收,只留最近 200 行——「关于」页打开时才看得到,但不能打开时才开始记。 */
import { useSyncExternalStore } from 'react';
import { dafri } from '../bridge';

type Listener = () => void;
let lines: string[] = [];
let text = '';
let started = false;
const listeners = new Set<Listener>();

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function startEngineLog(): void {
  if (started) return;
  started = true;
  dafri.on('engine-log', ({ line }) => {
    lines = [...lines, String(line)].slice(-200);
    text = lines.join('\n');
    listeners.forEach((l) => l());
  });
}

export function useEngineLog(): string {
  return useSyncExternalStore(subscribe, () => text);
}
