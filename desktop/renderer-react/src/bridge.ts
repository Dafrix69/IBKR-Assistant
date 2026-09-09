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
  reconcileTrackers(): Rpc<any>;
  closePositionNow(id: string): Rpc<any>;

  setTheme(mode: 'system' | 'light' | 'dark'): Rpc<{ mode: string; dark: boolean }>;

  pickExportPath(): Rpc<string | null>;
  confirm(options: ConfirmOptions): Rpc<boolean>;
  notify(title: string, body?: string): Rpc<void>;

  on(channel: 'engine-event', handler: (payload: EngineEvent) => void): () => void;
  on(channel: 'engine-log', handler: (payload: { line: string }) => void): () => void;
  on(channel: 'engine-exit', handler: (payload: { detail: string }) => void): () => void;
  on(channel: 'menu', handler: (payload: { action: string }) => void): () => void;
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
