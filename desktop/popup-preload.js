'use strict';
/**
 * 提醒弹窗的预加载脚本(设计:优质股追踪 §C3)。
 *
 * 弹窗页能做的只有这几件事:收列表、说"我好了"、报高度、关一条 / 全部关、「查看」。
 * 没有 rpc、没有通知、没有任何能碰到引擎或下单的通道——弹窗页就算被塞进了奇怪的内容,
 * 最多也只能把自己关掉。主进程那头还会再核对一次来源(只认这扇窗自己的主 frame)。
 */
const { contextBridge, ipcRenderer } = require('electron');

const action = (msg) => ipcRenderer.send('popup-action', msg);

contextBridge.exposeInMainWorld('dafriPopup', {
  /** 订阅列表更新;cb 只拿到 { items, updown },拿不到 IPC 事件对象。返回取消订阅的函数。 */
  onItems: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('popup-items', listener);
    return () => ipcRenderer.removeListener('popup-items', listener);
  },
  ready: () => action({ type: 'ready' }),
  size: (height) => action({ type: 'size', height: Number(height) }),
  dismiss: (id) => action({ type: 'dismiss', id: String(id) }),
  clear: () => action({ type: 'clear' }),
  open: (id) => action({ type: 'open', id: String(id) }),
});
