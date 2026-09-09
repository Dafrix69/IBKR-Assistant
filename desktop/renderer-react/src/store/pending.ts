/**
 * 排队等待触发的条件单(方式 B)。
 *
 * 这里有一件不能省的事:**盯盘是界面驱动的**。引擎侧没有自己的定时器,
 * `pending.poll` 是 firePending / expirePending / syncBrokerOrders 的唯一入口——
 * 不发这条 RPC,条件单永远不会触发、当日不会过期,已提交的单也不会回写成交状态。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage } from '../bridge';
import { getStatus } from './status';

export interface PendingItem {
  record_id: string;
  intent_summary?: string;
  symbol?: string;
  operator?: string;
  value?: number | string;
  account?: string;
  created_at?: string;
  [key: string]: unknown;
}

type Listener = () => void;
let pending: PendingItem[] = [];
let error: string | null = null;
let inFlight = false;
let polling = false;
let started = false;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export async function loadPending(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await dafri.listPending();
    pending = Array.isArray(res?.pending) ? res.pending : [];
    error = null;
  } catch (err) {
    error = errorMessage(err);
  } finally {
    inFlight = false;
    emit();
  }
}

/**
 * 驱动引擎盯一轮排队中的条件单。连着券商、且真有排队订单时才发,避免空转。
 * 触发结果由引擎的 pending 事件带回来,这里不必自己解析。
 */
async function pollPending(): Promise<void> {
  if (polling) return;
  const status = getStatus();
  if (!status?.broker_connected || !status.pending_count) return;
  polling = true;
  try {
    await dafri.pollPending();
  } catch {
    /* 单次轮询失败不打断界面;下一轮再来 */
  } finally {
    polling = false;
  }
}

export function startPendingFeed(): void {
  if (started) return;
  started = true;
  void loadPending();
  dafri.on('engine-event', ({ event }) => {
    if (event === 'pending') void loadPending();
  });
  dafri.on('menu', ({ action }) => {
    if (action === 'refresh') void loadPending();
  });
  // 方式 B 盯盘:**不看当前在哪一页**。条件单到价要发单,切走了还得盯——和持仓追踪同一个道理。
  setInterval(pollPending, 10_000);
}

export function usePending(): PendingItem[] {
  return useSyncExternalStore(subscribe, () => pending);
}

export function usePendingError(): string | null {
  return useSyncExternalStore(subscribe, () => error);
}
