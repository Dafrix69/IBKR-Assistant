/**
 * 通知流(订单看板下方那条)。引擎的 notification 事件、连接 / 熔断 / 启动券商的动作都往这里写;
 * 旧脚本里的全局 pushNotification 被接管成这一份。
 */
import { useSyncExternalStore } from 'react';
import { dafri } from '../bridge';

export interface FeedItem {
  at: string;
  text: string;
}

type Listener = () => void;
let feed: FeedItem[] = [];
let started = false;
const listeners = new Set<Listener>();

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function pushNotification(title: string, body?: string): void {
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  feed = [{ at, text: body ? `${title} · ${body}` : title }, ...feed].slice(0, 60);
  listeners.forEach((l) => l());
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
  return useSyncExternalStore(subscribe, () => feed);
}
