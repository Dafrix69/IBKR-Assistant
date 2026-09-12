/**
 * 顶部横幅:提示类 6 秒自己走,错误类留着等人看,两者都点得掉。
 *
 * 迁移期间把旧脚本的全局 showBanner / hideBanner 换成这里的实现——旧页面报错时
 * 横幅才会出现在 React 壳里,而不是写进池里那个看不见的节点。
 */
import { create } from 'zustand';

export interface BannerState {
  message: string;
  info: boolean;
}

const useStore = create<{ current: BannerState | null }>(() => ({ current: null }));
let timer: ReturnType<typeof setTimeout> | null = null;

export function showBanner(message: string, info = false): void {
  const current = useStore.getState().current;
  // 同一条反复来(熔断时每轮状态都会喊一次)不重建对象,免得横幅闪
  if (!current || current.message !== message || current.info !== info) {
    useStore.setState({ current: { message, info } });
  }
  if (timer) clearTimeout(timer);
  timer = info ? setTimeout(hideBanner, 6000) : null;
}

export function hideBanner(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (useStore.getState().current) useStore.setState({ current: null });
}

export function useBanner(): BannerState | null {
  return useStore((s) => s.current);
}
