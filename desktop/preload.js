'use strict';
/**
 * 预加载脚本(设计文档 §10.2)。
 *
 * renderer 能碰到的全部能力就是下面这几个函数——没有 require、没有 fs、
 * 没有 ipcRenderer 原始对象。下单、改限额、连券商这类敏感调用统一带上
 * __confirmed 标记,主进程会核对;界面代码绕不过去。
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = ['engine-event', 'engine-log', 'engine-exit', 'bootstrap', 'menu'];

contextBridge.exposeInMainWorld('dafri', {
  // 平台标识:界面据此决定要不要退回实底(没有 vibrancy 底材的平台)
  platform: process.platform,

  // ---- 只读查询 -------------------------------------------------------
  status: () => ipcRenderer.invoke('rpc', { method: 'system.status', params: {} }),
  selftest: () => ipcRenderer.invoke('rpc', { method: 'system.selftest', params: {} }),
  listRecords: (limit) => ipcRenderer.invoke('rpc', { method: 'records.list', params: { limit } }),
  getRecord: (id) => ipcRenderer.invoke('rpc', { method: 'records.get', params: { id } }),
  listPending: () => ipcRenderer.invoke('rpc', { method: 'pending.list', params: {} }),
  pollPending: () => ipcRenderer.invoke('rpc', { method: 'pending.poll', params: {} }),
  getSettings: () => ipcRenderer.invoke('rpc', { method: 'settings.get', params: {} }),
  breakerState: () => ipcRenderer.invoke('rpc', { method: 'breaker.state', params: {} }),
  appInfo: () => ipcRenderer.invoke('app-info'),

  // ---- 大模型接入 ------------------------------------------------------
  llmCatalog: () => ipcRenderer.invoke('rpc', { method: 'llm.catalog', params: {} }),
  llmPatch: (llm) =>
    ipcRenderer.invoke('rpc', { method: 'llm.patch', params: { llm, __confirmed: true } }),
  llmTest: (llm, apiKey) =>
    ipcRenderer.invoke('rpc', { method: 'llm.test', params: { llm, api_key: apiKey } }),
  setApiKeyFor: (secret, provider) =>
    ipcRenderer.invoke('rpc', {
      method: 'keychain.set',
      params: { secret, provider, __confirmed: true },
    }),

  // ---- TWS 检测(只读探测,不涉及任何凭证)------------------------------
  scanTws: () => ipcRenderer.invoke('rpc', { method: 'tws.scan', params: {} }),
  diagnoseTws: (connections) =>
    ipcRenderer.invoke('rpc', { method: 'tws.diagnose', params: { connections } }),
  launchTws: (app) =>
    ipcRenderer.invoke('rpc', { method: 'tws.launch', params: { app, __confirmed: true } }),

  // ---- 会产生后果的操作(主进程会校验 __confirmed)----------------------
  submit: (text, execute) =>
    ipcRenderer.invoke('rpc', {
      method: 'instruction.submit',
      params: { text, execute: Boolean(execute), __confirmed: true },
    }),
  patchSettings: (patch) =>
    ipcRenderer.invoke('rpc', { method: 'settings.patch', params: { patch, __confirmed: true } }),
  setApiKey: (secret) =>
    ipcRenderer.invoke('rpc', { method: 'keychain.set', params: { secret, __confirmed: true } }),
  connectBroker: (connections) =>
    ipcRenderer.invoke('rpc', {
      method: 'broker.connect',
      params: { connections, __confirmed: true },
    }),
  disconnectBroker: () => ipcRenderer.invoke('rpc', { method: 'broker.disconnect', params: {} }),
  halt: (reason) => ipcRenderer.invoke('rpc', { method: 'breaker.halt', params: { reason } }),
  resume: () => ipcRenderer.invoke('rpc', { method: 'breaker.resume', params: {} }),
  exportData: (path) => ipcRenderer.invoke('rpc', { method: 'data.export', params: { path } }),
  restartEngine: () => ipcRenderer.invoke('engine-restart'),

  // ---- 系统对话框 ------------------------------------------------------
  pickExportPath: () => ipcRenderer.invoke('pick-export-path'),
  confirm: (options) => ipcRenderer.invoke('confirm', options || {}),

  // ---- 事件订阅 --------------------------------------------------------
  on: (channel, handler) => {
    if (!EVENT_CHANNELS.includes(channel) || typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
