/**
 * 通知流(订单看板下方那条)。引擎的 notification 事件、连接 / 熔断 / 启动券商的动作都往这里写;
 * 旧脚本里的全局 pushNotification 被接管成这一份。
 */
import { create } from 'zustand';
import { dafri } from '../bridge';

export interface FeedItem {
  at: string;
  text: string;
}

const useStore = create<{ feed: FeedItem[] }>(() => ({ feed: [] }));
let started = false;

export function pushNotification(title: string, body?: string): void {
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  useStore.setState((s) => ({
    feed: [{ at, text: body ? `${title} · ${body}` : title }, ...s.feed].slice(0, 60),
  }));
}

/** 订阅引擎的通知事件。 */
export function startNotifyFeed(): void {
  if (started) return;
  started = true;
  dafri.on('engine-event', ({ event, data }) => {
    if (event === 'notification') pushNotification(String(data?.title ?? ''), data?.body == null ? undefined : String(data.body));
  });
}

export function useFeed(): FeedItem[] {
  return useStore((s) => s.feed);
}
