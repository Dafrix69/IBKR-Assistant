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
  protections?: ProtectionsStatus;
  auto_execute: boolean;
  allow_live_trading: boolean;
  pending_count: number;
  market_status: string;
  now_et: string;
  model?: string;
  limits: { max_order_notional: number; max_option_contracts: number; [key: string]: number };
  [key: string]: unknown;
}

/** 保护规则的当前状态(engine.protectionState → system.status)。到点自己解除,所以带解除时刻。 */
export interface ProtectionsStatus {
  paused: boolean;
  rule: string;
  reason: string;
  until_ms: number | null;
  cooldowns: { symbol: string; until_ms: number; reason: string }[];
}

export interface SettingsProtections {
  stoploss_guard: { enabled: boolean; lookback_minutes: number; trigger_count: number; pause_minutes: number };
  max_drawdown: { enabled: boolean; lookback_minutes: number; max_drawdown_usd: number; pause_minutes: number };
  cooldown: { enabled: boolean; minutes: number };
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
  protections?: Partial<SettingsProtections>;
  [key: string]: unknown;
}

export interface SettingsPatch {
  policies?: Partial<SettingsPolicies>;
  limits?: Partial<SettingsLimits>;
  protections?: Partial<SettingsProtections>;
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

// ---- 引擎契约(engine-ts/src/contract/):优质股追踪、股票池开关、板块、价位提醒、持仓追踪的设置 ------
// 这几个域的形状**不在这里定义**:引擎的 handler 与这里用的是同一份类型,返回结构改一个字段名,
// 两头一起编译不过。只许 `import type`,只许进 contract/ 顶层的类型文件(它们不 import 任何东西,
// 界面的 tsc 不装引擎依赖也解析得了);contract/schema/ 是引擎自己的运行时校验,这里不碰。
import type {
  AnomalyConfig, AnomalyEvent, AnomalyKind, AnomalyMetrics, LevelKind, OptionWall, PoolWatch, PoolWatchPatch, PositionRow,
  QualityList, QualityMonitor, QualityStock, RpcParams, RpcResult, Sector, SectorStock, SpotTarget, StockQuote,
  Targets, Track, Watch, WatchEvent, WatchLevel,
} from '../../../engine-ts/src/contract/index';

export type {
  AnomalyEvent, AnomalyKind, LevelKind, OptionWall, PoolWatch, PoolWatchPatch, PositionRow, QualityList, QualityMonitor,
  QualityStock, Sector, SectorStock, SpotTarget, StockQuote, Targets, Track, Watch, WatchEvent, WatchLevel,
};
/**
 * tracker.add 的载荷。**拼载荷的那个对象字面量要直接标成这个类型**(`const spec: TrackerAddSpec = {…}`):
 * TypeScript 只对"直接标了类型的字面量"查多余的键;先拼成一个没标类型的变量再传给 addTracker,写错的键名是查不出来的
 * (运行时引擎的 strict schema 会当场拒,但那已经是用户点了按钮之后的事)。
 */
export type TrackerAddSpec = RpcParams<'tracker.add'>;
/** 界面这边一直叫 QualityConfig / QualityMetrics;引擎叫 AnomalyConfig / AnomalyMetrics,是同一个东西。 */
export type QualityConfig = AnomalyConfig;
export type QualityMetrics = AnomalyMetrics;

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

  listSectors(): Rpc<RpcResult<'sectors.list'>>;
  addSector(name: string): Rpc<RpcResult<'sectors.add'>>;
  deleteSector(id: string): Rpc<RpcResult<'sectors.delete'>>;
  pickSector(id: string): Rpc<RpcResult<'sectors.pick'>>;
  sectorQuotes(): Rpc<RpcResult<'sectors.quotes'>>;
  addSectorStock(id: string, symbol: string, tag?: string): Rpc<RpcResult<'sectors.add_stock'>>;
  removeSectorStock(id: string, symbol: string): Rpc<RpcResult<'sectors.remove_stock'>>;
  setSectorTag(id: string, symbol: string, tag: string): Rpc<RpcResult<'sectors.set_tag'>>;

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

  optionWall(spec: RpcParams<'options.wall'>): Rpc<RpcResult<'options.wall'>>;
  listAlerts(): Rpc<RpcResult<'alerts.list'>>;
  createAlert(symbol: string, step: number): Rpc<RpcResult<'alerts.create'>>;
  deleteAlert(id: string): Rpc<RpcResult<'alerts.delete'>>;
  refreshAlert(id: string, expiry?: string): Rpc<RpcResult<'alerts.refresh'>>;
  pollAlerts(): Rpc<RpcResult<'alerts.poll'>>;

  paTimeframes(): Rpc<any>;
  paAnalyze(spec: unknown): Rpc<any>;
  paComment(spec: unknown): Rpc<any>;
  reviewCandidates(limit?: number, includeLocal?: boolean): Rpc<any>;
  reviewAnalyze(spec: unknown): Rpc<any>;
  macroBoard(force?: boolean): Rpc<any>;

  listPositions(): Rpc<RpcResult<'positions.list'>>;
  listTrackers(): Rpc<RpcResult<'tracker.list'>>;
  /** 授权软件自动发单。载荷的键名要靠 TrackerAddSpec 在拼的地方查(见它的注释),这里的参数类型查不了多余的键。 */
  addTracker(spec: TrackerAddSpec): Rpc<RpcResult<'tracker.add'>>;
  updateTracker(spec: RpcParams<'tracker.update'>): Rpc<RpcResult<'tracker.update'>>;
  deleteTracker(id: string): Rpc<RpcResult<'tracker.delete'>>;
  pollTrackers(): Rpc<any>;
  previewSpotTarget(key: string, spotTarget: number, chaseMaxPct?: number | null): Rpc<RpcResult<'tracker.target_preview'>>;
  reconcileTrackers(): Rpc<any>;
  closePositionNow(id: string): Rpc<any>;

  /**
   * 股票池的两个开关:板块成分股身上的「盯价位」/「盯异动」。开 = 建对应的行,关 = 删掉它。
   * 受各自 30 只上限约束,没开成的那一路在回执的 skipped 里说原因。
   */
  setPoolWatch(symbol: string, patch: PoolWatchPatch): Rpc<RpcResult<'pool.set_watch'>>;

  // 异动监控(全在引擎的本地道:同步 SQLite + 读内存)
  listQuality(): Rpc<RpcResult<'quality.list'>>;
  addQuality(symbol: string, note?: string): Rpc<RpcResult<'quality.add'>>;
  updateQuality(spec: RpcParams<'quality.update'>): Rpc<RpcResult<'quality.update'>>;
  removeQuality(id: string): Rpc<RpcResult<'quality.remove'>>;
  setQualityConfig(config: Partial<QualityConfig>): Rpc<RpcResult<'quality.set_config'>>;
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
  }
}

export const dafri: DafriBridge = window.dafri;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
