/** 交易分析页的跨页入口:记录详情里点「分析这笔交易」→ 切到交易分析页并直接分析那一张。 */
import { useSyncExternalStore } from 'react';
import { navigate } from './nav';

type Listener = () => void;
let request: { id: string; seq: number } | null = null;
let seq = 0;
const listeners = new Set<Listener>();

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function openReviewFor(recordId: string): void {
  try {
    localStorage.setItem('dafri-review-record', recordId);
  } catch {
    /* 同上 */
  }
  request = { id: recordId, seq: ++seq };
  listeners.forEach((l) => l());
  navigate('review');
}

/** 页面消费一次请求后清掉,免得下次进页又跑一遍 */
export function takeReviewRequest(): string | null {
  const id = request?.id ?? null;
  request = null;
  return id;
}

export function useReviewRequest(): number {
  return useSyncExternalStore(subscribe, () => request?.seq ?? 0);
}
