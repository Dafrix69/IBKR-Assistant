/**
 * 外观:深浅色走主进程 nativeTheme(渲染层的 prefers-color-scheme 随之切换),
 * 涨跌配色是显示偏好,只改 :root 的 data-updown,token 映射随之翻转。
 * localStorage 的键与旧界面相同,迁移不丢用户的选择。
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { dafri } from '../bridge';
import { showBanner } from '../store/banner';

export type ThemeMode = 'system' | 'light' | 'dark';
export type UpDown = 'green-up' | 'red-up';

export const isMac = navigator.platform.toUpperCase().includes('MAC');
export const MOD_KEY = isMac ? '⌘' : 'Ctrl+';
export const SHIFT_KEY = isMac ? '⇧' : 'Shift+';
export const ENTER_KEY = isMac ? '↩' : 'Enter';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
}

// ---- 深浅色 / 涨跌配色 ------------------------------------------------------
const useStore = create<{ themeMode: ThemeMode; updown: UpDown }>(() => ({
  themeMode: ((): ThemeMode => {
    const v = read('dafri-theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  })(),
  updown: read('dafri-updown') === 'red-up' ? 'red-up' : 'green-up',
}));

export function getThemeMode(): ThemeMode {
  return useStore.getState().themeMode;
}

export async function applyTheme(mode: ThemeMode): Promise<void> {
  try {
    await dafri.setTheme(mode);
  } catch (err) {
    showBanner(`切换外观失败:${err instanceof Error ? err.message : String(err)}`, false);
    return;
  }
  write('dafri-theme', mode);
  useStore.setState({ themeMode: mode });
}

export function useThemeMode(): ThemeMode {
  return useStore((s) => s.themeMode);
}

/** 当前实际是否深色:由系统 / nativeTheme 决定,AntD 的算法和图表取色都看它。 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
export function useDark(): boolean {
  return useSyncExternalStore(
    (l) => {
      darkQuery.addEventListener('change', l);
      return () => darkQuery.removeEventListener('change', l);
    },
    () => darkQuery.matches,
  );
}

// ---- 涨跌配色 --------------------------------------------------------------
export function applyUpDown(mode: UpDown): void {
  const updown: UpDown = mode === 'red-up' ? 'red-up' : 'green-up';
  document.documentElement.dataset.updown = updown;
  write('dafri-updown', updown);
  useStore.setState({ updown });
  // 已经画在屏幕上的图不用管:图表(lib/chart/engine.ts)自己盯着 :root 的 data-updown,变了就换色、视口不动
}

/** 当前涨跌配色。弹窗是主进程里另一个窗口,读不到这里的 :root,只能随每批条目带过去。 */
export function getUpDown(): UpDown {
  return useStore.getState().updown;
}

export function useUpDown(): UpDown {
  return useStore((s) => s.updown);
}

/** 启动时把记住的偏好落到 DOM 上。 */
export function initAppearance(): void {
  document.documentElement.dataset.updown = useStore.getState().updown;
  document.documentElement.dataset.platform = dafri.platform;
  // macOS 之外没有 vibrancy 底材,半透明面板背后是空的——换成实底
  document.documentElement.dataset.vibrancy = dafri.platform === 'darwin' ? 'on' : 'off';
  void dafri.setTheme(getThemeMode()).catch(() => {});
  // 窗口失焦时侧栏选中项退成灰(AppKit 的源列表就是这样)
  dafri.on('window', ({ focused }) => document.documentElement.toggleAttribute('data-window-blur', !focused));
}
