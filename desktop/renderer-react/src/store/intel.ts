/**
 * 信息链路(docs/features/intel.md):时间线、标的档案、⌘K 查标的、"持仓的票被提到"的提醒。循环在这里,不挂在页面上。
 *
 *  · 时间线 60 秒拉一次;引擎推来新消息(intel 事件)时 2 秒后再拉(连着来的几条合成一次)。
 *  · 信任的人提到自己持仓的票:弹窗 + 提示音 + 通知流,侧栏「情报」上记一条未读;人正在情报页、窗口在前台就算看过了。
 *  · 档案(抽屉)全站共用一个:任何页面调 openDossier(代码) 就开;开着时 15 秒刷新一次。
 */
import { create } from 'zustand';
import { dafri, errorMessage, type IntelDossier, type IntelFeed, type IntelKind } from '../bridge';
import { heldMentionPopup, isHeldMention } from '../lib/intelRules';
import { playAlertTone } from './alerts';
import { getTab } from './nav';
import { pushNotification } from './notify';
import { showAlertPopup } from './popup';

export const FEED_REFRESH_MS = 60_000;
export const DOSSIER_REFRESH_MS = 15_000;
const RECENT_KEY = 'dafri-intel-recent';

export interface IntelState {
  feed: IntelFeed | null;
  feedError: string | null;
  loading: boolean;
  /** 引擎那一侧的筛选(种类、只看持仓);关键字在页面里筛 */
  kinds: IntelKind[];
  heldOnly: boolean;
  unread: number;
  dossier: { symbol: string; data: IntelDossier | null; error: string | null; loading: boolean } | null;
  lookupOpen: boolean;
  /** 最近查过的标的,新的在前 */
  recent: string[];
}

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

const useStore = create<{ intel: IntelState }>(() => ({
  intel: { feed: null, feedError: null, loading: false, kinds: [], heldOnly: false, unread: 0, dossier: null, lookupOpen: false, recent: readRecent() },
}));

function set(part: Partial<IntelState>): void {
  useStore.setState((s) => ({ intel: { ...s.intel, ...part } }));
}

const get = (): IntelState => useStore.getState().intel;

export function useIntel(): IntelState {
  return useStore((s) => s.intel);
}

export function useIntelUnread(): number {
  return useStore((s) => s.intel.unread);
}

/**
 * 没连上券商时拉到的时间线没有持仓、也没有此刻的价。启动时引擎往往比 TWS 先好,第一次拉总是落在这里:
 * 5 秒后再拉,最多两分钟(连上之后清零),不然 ⌘K 的持仓一栏、"和持仓有关"要等满一轮 60 秒才出来。
 */
const UNCONNECTED_RETRY_MS = 5_000;
const UNCONNECTED_RETRIES = 24;

let feedBusy = false;
let started = false;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let unconnectedRetries = 0;

export async function loadIntelFeed(): Promise<void> {
  if (feedBusy) return;
  feedBusy = true;
  set({ loading: true });
  const { kinds, heldOnly } = get();
  try {
    const feed = await dafri.intelFeed({ kinds: kinds.length ? kinds : undefined, held_only: heldOnly || undefined, limit: 300 });
    set({ feed, feedError: null });
    if (feed.connected) unconnectedRetries = 0;
    else if (unconnectedRetries < UNCONNECTED_RETRIES) {
      unconnectedRetries += 1;
      setTimeout(() => void loadIntelFeed(), UNCONNECTED_RETRY_MS);
    }
  } catch (err) {
    set({ feedError: errorMessage(err) });
  } finally {
    feedBusy = false;
    set({ loading: false });
  }
}

export function setIntelKinds(kinds: IntelKind[]): void {
  set({ kinds });
  void loadIntelFeed();
}

export function setIntelHeldOnly(on: boolean): void {
  set({ heldOnly: on });
  void loadIntelFeed();
}

export function markIntelSeen(): void {
  if (get().unread) set({ unread: 0 });
}

// ---- 档案 ----------------------------------------------------------------------
let dossierSeq = 0;

async function fetchDossier(symbol: string): Promise<void> {
  const seq = ++dossierSeq;
  const cur = get().dossier;
  if (!cur || cur.symbol !== symbol) return;
  set({ dossier: { ...cur, loading: true } });
  try {
    const data = await dafri.intelDossier(symbol);
    if (seq !== dossierSeq || get().dossier?.symbol !== symbol) return;
    set({ dossier: { symbol, data, error: null, loading: false } });
  } catch (err) {
    if (seq !== dossierSeq || get().dossier?.symbol !== symbol) return;
    set({ dossier: { symbol, data: get().dossier?.data ?? null, error: errorMessage(err), loading: false } });
  }
}

export function openDossier(raw: string): void {
  const symbol = String(raw || '').trim().replace(/^\$/, '').toUpperCase();
  if (!symbol) return;
  const recent = [symbol, ...get().recent.filter((s) => s !== symbol)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
  set({ dossier: { symbol, data: null, error: null, loading: true }, lookupOpen: false, recent });
  void fetchDossier(symbol);
}

export function refreshDossier(): void {
  const d = get().dossier;
  if (d) void fetchDossier(d.symbol);
}

export function closeDossier(): void {
  dossierSeq += 1;
  set({ dossier: null });
}

export function setLookupOpen(open: boolean): void {
  set({ lookupOpen: open });
}

// ---- 持仓的票被提到 --------------------------------------------------------------
async function onHeldMention(data: unknown): Promise<void> {
  if (!isHeldMention(data)) return;
  const item = heldMentionPopup(data);
  const seeing = getTab() === 'intel' && document.hasFocus();
  if (!seeing) set({ unread: get().unread + 1 });
  pushNotification(item.title, item.body);
  playAlertTone(null);
  const { dropped } = await showAlertPopup([item]);
  if (dropped > 0) {
    try {
      await dafri.notify(item.title, item.body ?? '');
    } catch (err) {
      console.warn('系统通知失败', err);
    }
  }
}

function scheduleRefetch(): void {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void loadIntelFeed();
    const d = get().dossier;
    if (d) void fetchDossier(d.symbol);
  }, 2_000);
}

/** 启动时调一次(main.tsx)。 */
export function startIntelFeed(): void {
  if (started) return;
  started = true;
  void loadIntelFeed();
  setInterval(() => void loadIntelFeed(), FEED_REFRESH_MS);
  setInterval(() => {
    const d = get().dossier;
    if (d && !d.loading) void fetchDossier(d.symbol);
  }, DOSSIER_REFRESH_MS);
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'intel') {
      if ((data as { kind?: string } | null)?.kind === 'held_mention') void onHeldMention(data);
      scheduleRefetch();
    } else if (event === 'alerts' || event === 'anomaly' || event === 'tracker' || event === 'ready' || event === 'broker_link') {
      scheduleRefetch(); // broker_link:断线重连之后持仓与此刻的价跟着换
    }
  });
}
