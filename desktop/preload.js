'use strict';
/**
 * 预加载脚本(设计文档 §10.2)。
 *
 * renderer 能碰到的全部能力就是下面这几个函数——没有 require、没有 fs、
 * 没有 ipcRenderer 原始对象。下单、改限额、连券商这类敏感调用统一带上
 * __confirmed 标记,主进程会核对;界面代码绕不过去。
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = ['engine-event', 'engine-log', 'engine-exit', 'menu', 'window'];

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

  // ---- 想法备忘(纯本地记录,不解析、不下单)------------------------------
  addIdea: (text) => ipcRenderer.invoke('rpc', { method: 'ideas.add', params: { text } }),
  listIdeas: (status) => ipcRenderer.invoke('rpc', { method: 'ideas.list', params: { status } }),
  updateIdea: (id, status) =>
    ipcRenderer.invoke('rpc', { method: 'ideas.update', params: { id, status } }),
  analyzeIdea: (id) => ipcRenderer.invoke('rpc', { method: 'ideas.analyze', params: { id } }),
  digestIdeas: (scope, focus, trades) =>
    ipcRenderer.invoke('rpc', { method: 'ideas.digest', params: { scope, focus, trades } }),
  listIdeaDigests: () => ipcRenderer.invoke('rpc', { method: 'ideas.digests', params: {} }),
  searchIdeas: (filter) => ipcRenderer.invoke('rpc', { method: 'ideas.search', params: { ...filter } }),
  similarTrades: (ticket) => ipcRenderer.invoke('rpc', { method: 'ideas.similar_trades', params: { ...ticket } }),

  // ---- 自定义板块 + AI 选股(展示用数据,不进下单链路)--------------------
  listSectors: () => ipcRenderer.invoke('rpc', { method: 'sectors.list', params: {} }),
  addSector: (name) => ipcRenderer.invoke('rpc', { method: 'sectors.add', params: { name } }),
  deleteSector: (id) => ipcRenderer.invoke('rpc', { method: 'sectors.delete', params: { id } }),
  pickSector: (id) => ipcRenderer.invoke('rpc', { method: 'sectors.pick', params: { id } }),
  sectorQuotes: () => ipcRenderer.invoke('rpc', { method: 'sectors.quotes', params: {} }),
  addSectorStock: (id, symbol, tag) =>
    ipcRenderer.invoke('rpc', { method: 'sectors.add_stock', params: { id, symbol, tag: tag || '' } }),
  removeSectorStock: (id, symbol) =>
    ipcRenderer.invoke('rpc', { method: 'sectors.remove_stock', params: { id, symbol } }),
  setSectorTag: (id, symbol, tag) =>
    ipcRenderer.invoke('rpc', { method: 'sectors.set_tag', params: { id, symbol, tag } }),
  // 股票池的两个开关:「盯价位」/「盯异动」。patch 只带要改的那个(price / anomaly),
  // 开不开由引擎按上限说了算(回执里带 skipped),所以这里原样转发、不做本地判断
  setPoolWatch: (symbol, patch) =>
    ipcRenderer.invoke('rpc', { method: 'pool.set_watch', params: { symbol, ...patch } }),

  // ---- 扫描器:RS 强度 / 拐点筛选 / 极值偏离(纯计算,只读)-------------------
  screenerRs: (spec) => ipcRenderer.invoke('rpc', { method: 'screener.rs', params: spec }),
  screenerInflection: (spec) => ipcRenderer.invoke('rpc', { method: 'screener.inflection', params: spec }),
  screenerDeviation: (spec) => ipcRenderer.invoke('rpc', { method: 'screener.deviation', params: spec }),
  screenerLeaders: (spec) => ipcRenderer.invoke('rpc', { method: 'screener.leaders', params: spec }),
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

  // ---- 富途 OpenD 检测(同样只读探测,不涉及任何富途凭证)-----------------
  brokerCatalog: () => ipcRenderer.invoke('rpc', { method: 'broker.catalog', params: {} }),
  selectBroker: (provider) =>
    ipcRenderer.invoke('rpc', {
      method: 'broker.select',
      params: { provider, __confirmed: true },
    }),
  scanFutu: () => ipcRenderer.invoke('rpc', { method: 'futu.scan', params: {} }),
  diagnoseFutu: (connections) =>
    ipcRenderer.invoke('rpc', { method: 'futu.diagnose', params: { connections } }),
  launchFutu: () =>
    ipcRenderer.invoke('rpc', {
      method: 'futu.launch',
      params: { app: 'opend', __confirmed: true },
    }),
  // 明文密码只在这一次调用里存在:引擎算完 md5 就丢,不落配置、不进日志
  setFutuPassword: (password, alreadyMd5) =>
    ipcRenderer.invoke('rpc', {
      method: 'futu.set_password',
      params: { password, already_md5: Boolean(alreadyMd5), __confirmed: true },
    }),
  unlockFutu: (connection) =>
    ipcRenderer.invoke('rpc', {
      method: 'futu.unlock',
      params: { connection, __confirmed: true },
    }),

  // ---- 会产生后果的操作(主进程会校验 __confirmed)----------------------
  // accounts:界面勾选的目标账户别名;勾两个就同时向两个账户发单(引擎按账户扇出)
  submit: (text, execute, accounts) =>
    ipcRenderer.invoke('rpc', {
      method: 'instruction.submit',
      params: {
        text,
        execute: Boolean(execute),
        accounts: Array.isArray(accounts) ? accounts.map(String) : [],
        __confirmed: true,
      },
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

  // ---- 策略回测(纯计算,不下单)----------------------------------------
  backtestStrategies: () => ipcRenderer.invoke('rpc', { method: 'backtest.strategies', params: {} }),
  runBacktest: (spec) => ipcRenderer.invoke('rpc', { method: 'backtest.run', params: spec }),
  sweepBacktest: (spec) => ipcRenderer.invoke('rpc', { method: 'backtest.sweep', params: spec }),
  parseBacktestRules: (text) =>
    ipcRenderer.invoke('rpc', { method: 'backtest.parse_rules', params: { text } }),
  orderBook: (symbol) => ipcRenderer.invoke('rpc', { method: 'book.snapshot', params: { symbol } }),

  // ---- 实时 K 线 + 价格行为分析(只读:不下单、不定价、不写配置)----------
  // ---- 期权墙 + 价位警告(只读:只算、只通知,不下单)--------------------
  optionWall: (spec) => ipcRenderer.invoke('rpc', { method: 'options.wall', params: spec }),
  listAlerts: () => ipcRenderer.invoke('rpc', { method: 'alerts.list', params: {} }),
  createAlert: (symbol, step) =>
    ipcRenderer.invoke('rpc', { method: 'alerts.create', params: { symbol, step } }),
  deleteAlert: (id) => ipcRenderer.invoke('rpc', { method: 'alerts.delete', params: { id } }),
  refreshAlert: (id, expiry) =>
    ipcRenderer.invoke('rpc', { method: 'alerts.refresh', params: { id, expiry } }),
  pollAlerts: () => ipcRenderer.invoke('rpc', { method: 'alerts.poll', params: {} }),
  setTouchConfig: (config) =>
    ipcRenderer.invoke('rpc', { method: 'alerts.set_touch_config', params: { config } }),

  paTimeframes: () => ipcRenderer.invoke('rpc', { method: 'pa.timeframes', params: {} }),
  paAnalyze: (spec) => ipcRenderer.invoke('rpc', { method: 'pa.analyze', params: spec }),
  paComment: (spec) => ipcRenderer.invoke('rpc', { method: 'pa.comment', params: spec }),
  reviewCandidates: (limit, includeLocal) => ipcRenderer.invoke('rpc', { method: 'review.candidates', params: { limit, include_local: Boolean(includeLocal) } }),
  reviewAnalyze: (spec) => ipcRenderer.invoke('rpc', { method: 'review.analyze', params: spec }),
  reviewPerformance: (spec) => ipcRenderer.invoke('rpc', { method: 'review.performance', params: { ...spec } }),
  reviewSignals: (spec) => ipcRenderer.invoke('rpc', { method: 'review.signals', params: { ...spec } }),
  macroBoard: (force) => ipcRenderer.invoke('rpc', { method: 'macro.board', params: { force } }),

  // ---- 持仓追踪(tracker.add / update / close_now 会真的发单)--------------
  listPositions: () => ipcRenderer.invoke('rpc', { method: 'positions.list', params: {} }),
  listTrackers: () => ipcRenderer.invoke('rpc', { method: 'tracker.list', params: {} }),
  addTracker: (spec) =>
    ipcRenderer.invoke('rpc', { method: 'tracker.add', params: { ...spec, __confirmed: true } }),
  updateTracker: (spec) =>
    ipcRenderer.invoke('rpc', { method: 'tracker.update', params: { ...spec, __confirmed: true } }),
  deleteTracker: (id) => ipcRenderer.invoke('rpc', { method: 'tracker.delete', params: { id } }),
  pollTrackers: () => ipcRenderer.invoke('rpc', { method: 'tracker.poll', params: {} }),
  // 只读试算:标的走到目标价时这份持仓值多少、赚多少。不建追踪、不发单
  previewSpotTarget: (key, spotTarget, chaseMaxPct) =>
    ipcRenderer.invoke('rpc', {
      method: 'tracker.target_preview',
      params: { key, spot_target: spotTarget, ...(chaseMaxPct != null ? { chase_max_pct: chaseMaxPct } : {}) },
    }),
  // 券商托管对账:界面按秒驱动,动态停损价的秒级调整走这条路
  reconcileTrackers: () => ipcRenderer.invoke('rpc', { method: 'tracker.reconcile', params: {} }),
  closePositionNow: (id) =>
    ipcRenderer.invoke('rpc', { method: 'tracker.close_now', params: { id, __confirmed: true } }),

  // ---- 优质股追踪(读行情、存本地清单与阈值:只提醒,不下单)------------------
  listQuality: () => ipcRenderer.invoke('rpc', { method: 'quality.list', params: {} }),
  addQuality: (symbol, note) =>
    ipcRenderer.invoke('rpc', { method: 'quality.add', params: { symbol, note: note || '' } }),
  // spec:{ id, enabled?, note? }
  updateQuality: (spec) => ipcRenderer.invoke('rpc', { method: 'quality.update', params: spec }),
  removeQuality: (id) => ipcRenderer.invoke('rpc', { method: 'quality.remove', params: { id } }),
  setQualityConfig: (config) =>
    ipcRenderer.invoke('rpc', { method: 'quality.set_config', params: { config } }),
  // 置顶弹窗(不抢焦点),异动与价位提醒共用;内容由主进程逐字段清洗
  showPopup: (items, updown) => ipcRenderer.invoke('popup-show', { items, updown }),

  // ---- 外观 ------------------------------------------------------------
  setTheme: (mode) => ipcRenderer.invoke('set-theme', mode),

  // ---- 系统对话框 ------------------------------------------------------
  pickExportPath: () => ipcRenderer.invoke('pick-export-path'),
  confirm: (options) => ipcRenderer.invoke('confirm', options || {}),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),

  // ---- 事件订阅 --------------------------------------------------------
  on: (channel, handler) => {
    if (!EVENT_CHANNELS.includes(channel) || typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
