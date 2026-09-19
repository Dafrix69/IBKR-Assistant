/**
 * 弹窗提醒:价位提醒(板块页)与异动提醒(优质股页)共用的那扇置顶小窗,以及它的开关。
 *
 * 窗口本身在主进程(popup-window.js):置顶、不抢焦点、列表式。这里只管"开没开"和"发什么"——
 * 用户正在 TWS 里敲数量时被抢走焦点,按键会打进别处,所以弹窗只 showInactive,这边不做任何聚焦的事。
 * 偏好记在本地(dafri-alert-popup),默认开:用户原话就是"声音太小了,换成弹窗"。
 */
import { useSyncExternalStore } from 'react';
import { dafri, type PopupItem } from '../bridge';
import { popupCounts, type PopupCounts } from '../lib/alertRules';
import { getUpDown } from './appearance';

const KEY = 'dafri-alert-popup';

type Listener = () => void;
const listeners = new Set<Listener>();
let popupOn = ((): boolean => {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
})();

export function isPopupEnabled(): boolean {
  return popupOn;
}

export function setPopupEnabled(on: boolean): void {
  popupOn = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* 预览台的 data: 页面没有 localStorage */
  }
  listeners.forEach((l) => l());
  if (on) testPopup();   // 打开时弹一条示例,确认窗口真的出得来(和提示音打开时响一声同理)
}

export function usePopupEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => popupOn,
  );
}

/**
 * 真的交给主进程发出去。回的是"收下几条、丢了几条":没有这条通道(老主进程 / 预览台)、
 * 通道报错、或者弹窗页坏了,都算一条没收下——调用方要把没收下的退回系统通知。
 * 主进程单次收条数有上限(popup-window.js 的 MAX_INCOMING),超出的那几条它会如实报成 dropped。
 */
async function send(items: PopupItem[]): Promise<PopupCounts> {
  if (!items.length) return { accepted: 0, dropped: 0 };
  if (typeof dafri.showPopup !== 'function') return { accepted: 0, dropped: items.length };
  try {
    const res = await dafri.showPopup(items, getUpDown());
    return popupCounts(items.length, res);
  } catch (err) {
    console.warn('弹窗提醒失败', err);
    return { accepted: 0, dropped: items.length };
  }
}

/**
 * 开着才弹。返回收下了几条、丢了几条——调用方据此决定哪几条要退回系统通知:
 * 弹窗关着、通道坏了、一批太大超了上限,都不能让提醒悄无声息地没了。绝不抛异常。
 */
export async function showAlertPopup(items: PopupItem[]): Promise<PopupCounts> {
  if (!popupOn) return { accepted: 0, dropped: items.length };
  return send(items);
}

/** 「试弹」:用户点了就弹,不看开关——试的就是这扇窗本身。 */
export function testPopup(): void {
  const now = Date.now();
  void send([
    {
      id: `test:${now}`,
      kind: 'anomaly',
      symbol: 'DEMO',
      title: 'DEMO 5分钟放量 6.3×',
      body: '这是一条示例:近 5 分钟成交量是同时段常态的 6.3×,5 分钟 +1.20%。真提醒长这样,不会抢走键盘焦点。',
      tone: 'up',
      at: now,
      page: 'quality',
    },
  ]);
}
