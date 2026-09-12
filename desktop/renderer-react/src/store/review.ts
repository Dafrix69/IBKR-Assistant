/** 交易分析页的跨页入口:记录详情里点「分析这笔交易」→ 切到交易分析页并直接分析那一张。 */
import { create } from 'zustand';
import { navigate } from './nav';

// seq 是"又点了一次"的信号(页面按它起效果);待办的 id 不进 store——
// 消费它不该触发一次渲染,页面正在那次渲染里。
const useStore = create<{ seq: number }>(() => ({ seq: 0 }));
let pendingId: string | null = null;

export function openReviewFor(recordId: string): void {
  try {
    localStorage.setItem('dafri-review-record', recordId);
  } catch {
    /* 同上 */
  }
  pendingId = recordId;
  useStore.setState((s) => ({ seq: s.seq + 1 }));
  navigate('review');
}

/** 页面消费一次请求后清掉,免得下次进页又跑一遍 */
export function takeReviewRequest(): string | null {
  const id = pendingId;
  pendingId = null;
  return id;
}

export function useReviewRequest(): number {
  return useStore((s) => s.seq);
}
