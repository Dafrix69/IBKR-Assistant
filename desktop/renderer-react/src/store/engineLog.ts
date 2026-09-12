/** 引擎日志:从启动起就收,只留最近 200 行——「关于」页打开时才看得到,但不能打开时才开始记。 */
import { create } from 'zustand';
import { dafri } from '../bridge';

const useStore = create<{ lines: string[]; text: string }>(() => ({ lines: [], text: '' }));
let started = false;

export function startEngineLog(): void {
  if (started) return;
  started = true;
  dafri.on('engine-log', ({ line }) => {
    useStore.setState((s) => {
      const lines = [...s.lines, String(line)].slice(-200);
      return { lines, text: lines.join('\n') };
    });
  });
}

export function useEngineLog(): string {
  return useStore((s) => s.text);
}
