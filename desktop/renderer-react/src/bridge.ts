/**
 * preload.js 暴露的 window.dafri 的类型。这是渲染层能碰到的全部能力,
 * 迁移只换界面,不动这份契约——每个方法名与 preload.js 一一对应。
 *
 * 返回值大多先写成 unknown 承载的宽类型:引擎返回结构以 engine-ts 为准,
 * 迁到哪一页就把那一页用到的结构收紧成具体接口(见 Status / Settings)。
 */

export interface BreakerState {
  engaged: boolean;
  reason?: string | null;
}

export interface Account {
  alias: string;
  account_masked?: string;
  is_paper: boolean;
  connection?: string;
  broker?: string;
  default?: boolean;
}

export interface Status {
  accounts?: Account[];
  broker_connected: boolean;
  broker_upstream_ok?: boolean;
  broker_provider?: 'ibkr' | 'futu' | string;
  breaker: BreakerState;
  auto_execute: boolean;
  allow_live_trading: boolean;
  pending_count: number;
  market_status: string;
  now_et: string;
  model?: string;
  limits: { max_order_notional: number; max_option_contracts: number; [key: string]: number };
  [key: string]: unknown;
}

export interface SettingsPolicies {
  auto_execute: boolean;
  allow_live_trading: boolean;
  require_trigger_price_verification: boolean;
}

export interface SettingsLimits {
  max_order_notional: number;
  max_option_contracts: number;
  max_mkt_shares: number;
  max_spread_slippage: number;
  duplicate_window_minutes: number;
}

export interface Settings {
  policies: Partial<SettingsPolicies>;
  limits: Partial<SettingsLimits>;
  [key: string]: unknown;
}

export interface SettingsPatch {
  policies?: Partial<SettingsPolicies>;
  limits?: Partial<SettingsLimits>;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  configPath: string;
  /** 滚动日志文件(主进程 + 引擎 stderr + 渲染层报错);出问题时把它发过来就有现场 */
  logPath?: string;
  [key: string]: unknown;
}

export interface Selftest {
  prompt_version: string;
  prompt_fingerprint: string;
  system_prompt_chars: number;
  fewshot_pairs: number;
  accounts: Array<{ alias: string; account_masked: string; is_paper: boolean }>;
  [key: string]: unknown;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
}

// ---- 优质股追踪(形状以 engine-ts/src/anomaly.ts 与 rpc.ts 的 quality.* 为准)----------------

export type AnomalyKind = 'rvol' | 'burst' | 'spike' | 'day_move';

/** 异动阈值。引擎 normalizeAnomalyConfig 校验并合并,界面只管给数。 */
export interface QualityConfig {
  rvol_tiers: number[];
  burst_ratio: number;
  window_min: number;
  spike_sigma: number;
  spike_min_pct: number;
  spike_fixed_pct: number;
  day_sigma_tiers: number[];
  day_fixed_tiers: number[];
  cooldown_min: number;
}

/** 引擎每轮算出来的指标;不在时段内也有(只是不报)。 */
export interface QualityMetrics {
  last: number | null;
  change_pct: number | null;
  rvol: number | null;
  burst: number | null;
  /** 窗口里最大一步占窗口量的比例(只有样本窗口才有,否则 null):接近 1 就是一笔大宗补报,不是持续放量。
   *  引擎判不判"放量"看的是去掉这一步之后还剩几倍(anomaly.ts 的 sustained),表里的着色要跟它同一道口径。 */
  block_share: number | null;
  ret_window_pct: number | null;
  sigma_window_pct: number | null;
  sigma_day_pct: number | null;
  basis_volume: 'avg_volume' | 'session_pace' | null;
  basis_sigma: 'hist_vol' | 'fixed';
  window_ready: boolean;
  delayed: boolean;
}

export interface AnomalyEvent {
  id: string;
  /** 秒 */
  at: number;
  symbol: string;
  kind: AnomalyKind;
  direction: 'up' | 'down' | null;
  value: number;
  threshold: number;
  tier: number | null;
  sigma: number | null;
  price: number | null;
  change_pct: number | null;
  basis: string;
  title: string;
  text: string;
}

export interface QualityStock {
  id: string;
  created_at: string;
  updated_at: string;
  symbol: string;
  note: string;
  /** 库里是 0 / 1 */
  enabled: number | boolean;
  states?: unknown;
  events: AnomalyEvent[];
  metrics: QualityMetrics | null;
  metrics_at: string | null;
  /** 这一轮取不到这只的行情时的原因("未知标的" 之类);取到了是 null */
  quote_error?: string | null;
  /**
   * 价位(期权墙 / 均线 / 关口)算到哪一步了:'ok' = 有价位、当天的;'pending' = 排着等算(界面显示「正在算价位…」);
   * 'error:<原因>' = 上一次没算成,退避中。引擎在异动循环里捎带算(每轮最多一只),形状见 A3。
   * 老引擎不带这个字段(undefined):界面退回"有没有 levels"来判断。
   */
  levels_status?: string | null;
}

export interface QualityMonitor {
  running: boolean;
  interval_ms: number;
  ticks: number;
  /** 与盯盘心跳同风格:ISO 字符串;防御起见也认毫秒数 */
  last_at: string | number | null;
  last_ms: number | null;
  last_error: string;
  session: 'rth' | 'pre' | 'post' | 'closed';
  connected: boolean;
  supported: boolean;
  /** 给人看的一句话("休市:开盘后开始检测" 之类),没有就是空串 */
  note: string;
}

export interface QualityList {
  stocks: QualityStock[];
  config: QualityConfig;
  monitor: QualityMonitor;
  max: number;
}

// ---- 股票池的两个开关(pool.set_watch)------------------------------------------------

/** 「价位」/「异动」开关只传要改的那个:没传的那一路原样不动。 */
export interface PoolWatchPatch {
  price?: boolean;
  anomaly?: boolean;
}

/**
 * 开关回执。`skipped` 是**没做成的那一路的原因**(如「异动已达 30 只上限」):
 * 超上限、指数不能盯异动这些情况引擎不静默丢,如实回报,界面照原话说出来。
 */
export interface PoolWatch {
  symbol: string;
  price_on: boolean;
  anomaly_on: boolean;
  skipped: string[];
}

/** 交给主进程置顶弹窗的一条。主进程会逐字段清洗,这里照契约给。 */
export interface PopupItem {
  id: string;
  kind: 'anomaly' | 'level';
  symbol: string;
  title: string;
  body?: string;
  tone?: 'up' | 'down' | 'info';
  /** epoch 毫秒 */
  at?: number;
  page?: 'quality' | 'sectors';
}

export type EngineEvent = { event: string; data: any };
export type EventChannel = 'engine-event' | 'engine-log' | 'engine-exit' | 'menu' | 'window';

type Rpc<T = unknown> = Promise<T>;

export interface DafriBridge {
  platform: string;

  status(): Rpc<Status>;
  selftest(): Rpc<Selftest>;
  listRecords(limit?: number): Rpc<any>;
  getRecord(id: string): Rpc<any>;
  listPending(): Rpc<any>;
  pollPending(): Rpc<any>;
  getSettings(): Rpc<Settings>;
  breakerState(): Rpc<BreakerState>;

  addIdea(text: string): Rpc<any>;
  listIdeas(status?: string): Rpc<any>;
  updateIdea(id: string, status: string): Rpc<any>;
  analyzeIdea(id: string): Rpc<any>;
  digestIdeas(scope?: string): Rpc<any>;
  listIdeaDigests(): Rpc<any>;

  listSectors(): Rpc<any>;
  addSector(name: string): Rpc<any>;
  deleteSector(id: string): Rpc<any>;
  pickSector(id: string): Rpc<any>;
  sectorQuotes(): Rpc<any>;
  addSectorStock(id: string, symbol: string, tag?: string): Rpc<any>;
  removeSectorStock(id: string, symbol: string): Rpc<any>;
  setSectorTag(id: string, symbol: string, tag: string): Rpc<any>;

  screenerRs(spec: unknown): Rpc<any>;
  screenerInflection(spec: unknown): Rpc<any>;
  screenerDeviation(spec: unknown): Rpc<any>;
  appInfo(): Rpc<AppInfo>;

  llmCatalog(): Rpc<any>;
  llmPatch(llm: unknown): Rpc<any>;
  llmTest(llm: unknown, apiKey?: string): Rpc<any>;
  setApiKeyFor(secret: string, provider: string): Rpc<any>;

  scanTws(): Rpc<any>;
  diagnoseTws(connections?: unknown): Rpc<any>;
  launchTws(app: string): Rpc<any>;

  brokerCatalog(): Rpc<any>;
  selectBroker(provider: string): Rpc<any>;
  scanFutu(): Rpc<any>;
  diagnoseFutu(connections?: unknown): Rpc<any>;
  launchFutu(): Rpc<any>;
  setFutuPassword(password: string, alreadyMd5?: boolean): Rpc<any>;
  unlockFutu(connection?: unknown): Rpc<any>;

  submit(text: string, execute: boolean, accounts: string[]): Rpc<any>;
  patchSettings(patch: SettingsPatch): Rpc<any>;
  setApiKey(secret: string): Rpc<any>;
  connectBroker(connections?: unknown): Rpc<{ connected: string[]; failed?: Record<string, string> }>;
  disconnectBroker(): Rpc<any>;
  halt(reason: string): Rpc<{ cancelled?: number }>;
  resume(): Rpc<any>;
  exportData(path: string): Rpc<{ records: number; path: string }>;
  restartEngine(): Rpc<any>;

  backtestStrategies(): Rpc<any>;
  runBacktest(spec: unknown): Rpc<any>;
  parseBacktestRules(text: string): Rpc<any>;
  orderBook(symbol: string): Rpc<any>;

  optionWall(spec: unknown): Rpc<any>;
  listAlerts(): Rpc<any>;
  createAlert(symbol: string, step: number): Rpc<any>;
  deleteAlert(id: string): Rpc<any>;
  refreshAlert(id: string, expiry?: string): Rpc<any>;
  pollAlerts(): Rpc<any>;

  paTimeframes(): Rpc<any>;
  paAnalyze(spec: unknown): Rpc<any>;
  paComment(spec: unknown): Rpc<any>;
  reviewCandidates(limit?: number, includeLocal?: boolean): Rpc<any>;
  reviewAnalyze(spec: unknown): Rpc<any>;
  macroBoard(force?: boolean): Rpc<any>;

  listPositions(): Rpc<any>;
  listTrackers(): Rpc<any>;
  addTracker(spec: unknown): Rpc<any>;
  updateTracker(spec: unknown): Rpc<any>;
  deleteTracker(id: string): Rpc<any>;
  pollTrackers(): Rpc<any>;
  previewSpotTarget(key: string, spotTarget: number): Rpc<any>;
  reconcileTrackers(): Rpc<any>;
  closePositionNow(id: string): Rpc<any>;

  /**
   * 股票池的两个开关:板块成分股身上的「盯价位」/「盯异动」。开 = 建对应的行,关 = 删掉它。
   * 受各自 30 只上限约束,没开成的那一路在回执的 skipped 里说原因。
   */
  setPoolWatch(symbol: string, patch: PoolWatchPatch): Rpc<PoolWatch>;

  // 异动监控(全在引擎的本地道:同步 SQLite + 读内存)
  listQuality(): Rpc<QualityList>;
  addQuality(symbol: string, note?: string): Rpc<{ stock: QualityStock }>;
  updateQuality(spec: { id: string; enabled?: boolean; note?: string }): Rpc<{ stock: QualityStock }>;
  removeQuality(id: string): Rpc<{ deleted: unknown }>;
  setQualityConfig(config: QualityConfig): Rpc<{ config: QualityConfig }>;
  /** 置顶弹窗(主进程 popup-window.js):不抢焦点,列表式 */
  showPopup(items: PopupItem[], updown: 'red-up' | 'green-up'): Promise<{ shown: number; dropped?: number }>;

  setTheme(mode: 'system' | 'light' | 'dark'): Rpc<{ mode: string; dark: boolean }>;

  pickExportPath(): Rpc<string | null>;
  confirm(options: ConfirmOptions): Rpc<boolean>;
  notify(title: string, body?: string): Rpc<void>;

  on(channel: 'engine-event', handler: (payload: EngineEvent) => void): () => void;
  on(channel: 'engine-log', handler: (payload: { line: string }) => void): () => void;
  on(channel: 'engine-exit', handler: (payload: { detail: string }) => void): () => void;
  /** 菜单与弹窗的「查看」:navigate 带着要去的页和标的 */
  on(channel: 'menu', handler: (payload: { action: string; page?: string; symbol?: string }) => void): () => void;
  on(channel: 'window', handler: (payload: { focused: boolean }) => void): () => void;
}

declare global {
  interface Window {
    dafri: DafriBridge;
    /** 截图脚本(tools/capture_pages.js)用它切页 */
    __dafriNavigate?: (key: string) => void;
    /** React 已接管的叶子页清单,截图脚本据此逐页拍 */
    __dafriLeafTabs?: string[];
    /** renderer/pa-chart.js 的 canvas 图表引擎(经典脚本,挂在 window 上) */
    DafriChart?: { mount(container: HTMLElement, spec: unknown): void };
    /** 同一引擎的 K线 PA 入口:把引擎的 pa.analyze 结果翻成 spec 再画 */
    DafriPaChart?: { mount(container: HTMLElement, result: unknown): void };
  }
}

export const dafri: DafriBridge = window.dafri;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
