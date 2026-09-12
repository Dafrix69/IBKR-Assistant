/**
 * 壳层路由:当前侧栏项 + 合并页(行情 / 扫描 / 接入)里上次看的子页。
 * localStorage 的键沿用旧界面(dafri-subtab-<parent>),迁移期间两边记的是同一份。
 */
import { create } from 'zustand';
import { dafri } from '../bridge';
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

const useStore = create<{ tab: string; subs: Record<string, string>; focus: NavFocus | null }>(() => ({
  tab: ((): string => {
    const saved = read(TAB_KEY);
    return saved && NAV_ITEMS.some((i) => i.key === saved) ? saved : 'trade';
  })(),
  subs: {},
  focus: null,
}));

/** 切页。传子页名(pa / rs / tws…)会切到它的父页并记住子页。 */
export function navigate(key: string): void {
  const parent = navKeyFor(key);
  if (key !== parent) setSubtab(parent, key);
  if (parent !== useStore.getState().tab) {
    write(TAB_KEY, parent);
    useStore.setState({ tab: parent });
  }
}

export function getTab(): string {
  return useStore.getState().tab;
}

export function useTab(): string {
  return useStore((s) => s.tab);
}

export function getSubtab(parent: string, fallback: string): string {
  return useStore.getState().subs[parent] || read(`dafri-subtab-${parent}`) || fallback;
}

export function setSubtab(parent: string, key: string): void {
  if (useStore.getState().subs[parent] === key) return;
  write(`dafri-subtab-${parent}`, key);
  useStore.setState((s) => ({ subs: { ...s.subs, [parent]: key } }));
}

export function useSubtab(parent: string, fallback: string): string {
  return useStore((s) => s.subs[parent] || read(`dafri-subtab-${parent}`) || fallback);
}

// ---- 带着标的跳页(弹窗的「查看」)--------------------------------------------------
// 光切到页还不够:30 只股的表里,得把刚报异动的那一行指给人看。页面读到焦点后自己滚过去、闪一下,再清掉。

export interface NavFocus {
  page: string;
  symbol: string;
  seq: number;
  /** 记下来的时刻(epoch 毫秒),用来判过期 */
  at: number;
}

/**
 * 焦点的保质期:页面读到它、滚过去、闪一下,2.2 秒后自己清掉。但那个定时器挂在页面上——
 * 人在闪完之前就切走了,定时器随卸载一起清了,焦点却留在这个模块里:下次再进这一页,
 * 一条早就过去的旧异动又被指认一遍。所以除了页面自己清,再给一个过期时间兜底。
 */
const FOCUS_TTL_MS = 15_000;

let focusSeq = 0;

const liveFocus = (focus: NavFocus | null, page: string): NavFocus | null =>
  focus && focus.page === page && Date.now() - focus.at <= FOCUS_TTL_MS ? focus : null;

export function navigateTo(page: string, symbol?: string): void {
  const s = String(symbol || '').trim().toUpperCase();
  if (s) {
    focusSeq += 1;
    useStore.setState({ focus: { page: navKeyFor(page), symbol: s, seq: focusSeq, at: Date.now() } });
  }
  navigate(page);
}

/** 这一页的待指认标的;别的页的焦点、以及过了期的焦点,对这一页都是 null。 */
export function useNavFocus(page: string): NavFocus | null {
  return useStore((st) => liveFocus(st.focus, page));
}

export function clearNavFocus(seq: number): void {
  const { focus } = useStore.getState();
  if (focus && focus.seq === seq) useStore.setState({ focus: null });
}

/** 离开这一页时把它的焦点丢掉:没闪完就切走的那一次,不该在下次进来时补闪。 */
export function clearNavFocusFor(page: string): void {
  const { focus } = useStore.getState();
  if (focus && focus.page === page) useStore.setState({ focus: null });
}

/** 刚跳过去、还没被页面消化掉的焦点(壳层据此决定要不要把内容区滚回顶部)。 */
export function pendingNavFocus(page: string): boolean {
  return liveFocus(useStore.getState().focus, page) !== null;
}

let menuStarted = false;

/**
 * 主进程发来的跳页(弹窗「查看」、菜单):只认侧栏里真有的页,别的一律不理——
 * 这条通道的内容来自主进程,但页名最终拼进界面状态,不该由它随便指。
 */
export function startMenuNavigation(): void {
  if (menuStarted) return;
  menuStarted = true;
  dafri.on('menu', (payload) => {
    const action = payload?.action;
    const page = typeof payload?.page === 'string' ? payload.page : '';
    if (action !== 'navigate' || !page) return;
    if (!NAV_ITEMS.some((i) => i.key === navKeyFor(page))) return;
    navigateTo(page, typeof payload?.symbol === 'string' ? payload.symbol : undefined);
  });
}
