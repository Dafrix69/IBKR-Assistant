/**
 * 壳层路由:当前侧栏项 + 合并页(行情 / 扫描 / 接入)里上次看的子页。
 * localStorage 的键沿用旧界面(dafri-subtab-<parent>),迁移期间两边记的是同一份。
 */
import { useSyncExternalStore } from 'react';
import { NAV_ITEMS, navKeyFor } from '../shell/nav';

const TAB_KEY = 'dafri-shell-tab';

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

type Listener = () => void;
const listeners = new Set<Listener>();
let tab: string = ((): string => {
  const saved = read(TAB_KEY);
  return saved && NAV_ITEMS.some((i) => i.key === saved) ? saved : 'trade';
})();
const subs: Record<string, string> = {};

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 切页。传子页名(pa / rs / tws…)会切到它的父页并记住子页。 */
export function navigate(key: string): void {
  const parent = navKeyFor(key);
  if (key !== parent) setSubtab(parent, key);
  if (parent !== tab) {
    tab = parent;
    write(TAB_KEY, parent);
    emit();
  }
}

export function getTab(): string {
  return tab;
}

export function useTab(): string {
  return useSyncExternalStore(subscribe, () => tab);
}

export function getSubtab(parent: string, fallback: string): string {
  return subs[parent] || read(`dafri-subtab-${parent}`) || fallback;
}

export function setSubtab(parent: string, key: string): void {
  if (subs[parent] === key) return;
  subs[parent] = key;
  write(`dafri-subtab-${parent}`, key);
  emit();
}

export function useSubtab(parent: string, fallback: string): string {
  return useSyncExternalStore(subscribe, () => getSubtab(parent, fallback));
}
