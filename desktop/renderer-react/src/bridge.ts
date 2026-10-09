/**
 * preload.js 暴露的 window.dafri 的类型。这是渲染层能碰到的全部能力,
 * 迁移只换界面,不动这份契约——每个方法名与 preload.js 一一对应。
 *
 * 返回值大多先写成 unknown 承载的宽类型:引擎返回结构以 engine-ts 为准,
 * 迁到哪一页就把那一页用到的结构收紧成具体接口(见 Status / Settings)。
 */

// 账户、限额、策略开关、保护规则的配置:形状在引擎契约里(engine-ts/src/contract/settings.ts),下面「引擎契约」一节统一转出。
// 以前这里手抄过一份,只抄了一半:引擎的 Policies 有 9 个字段、这里 3 个,Limits 8 个、这里 5 个。

// Status / Selftest / BreakerState / ProtectionsStatus 以前在这里手抄了一份(还抄漏过字段)。
// 现在这五个方法都在引擎契约里(engine-ts/src/contract/system.ts),下面「引擎契约」一节统一转出。

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

/** 新版本检查的结果(desktop/update-check.js 的 summarizeRelease)。链接只会是本仓库 releases 下的地址。 */
export interface UpdateInfo {
  current: string;
  /** 最新正式版的版本号;GitHub 上的 tag 认不出时为 null */
  latest: string | null;
  newer: boolean;
  /** 这一版的发布页 */
  url: string;
  /** 这台机器对应的安装包;没有对应平台的包(如 Intel Mac)时为 null,只给发布页 */
  download: { name: string; url: string; size: number | null } | null;
  publishedAt: string | null;
  /** 发布说明,纯文本、已截断 */
  notes: string;
  checkedAt: number;
}

/** 要确认凭据的那几种用途(desktop/confirm-grants.js 的 PURPOSES)。 */
export type ConfirmPurpose =
  | 'instruction.submit' | 'tracker.close_now' | 'tracker.add' | 'broker.select'
  | 'gate.auto_execute' | 'gate.allow_live_trading' | 'limits.loosen' | 'gate.follow';

export interface ConfirmOptions {
  /** 带 purpose 时对话框最显眼的那一行由主进程按用途写,这里给的 title 不显示 */
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  /**
   * 会发单 / 授权发单 / 打开闸门的确认要带上它:用户点了确认,主进程才给接下来那一次调用发凭据。
   * 不带的是普通确认(删除一条追踪这类),不发凭据。
   */
  purpose?: ConfirmPurpose;
  /** 接下来那一次调用的内容(发单:{ text, accounts };建追踪:整个 spec;平仓:{ id })。对不上不放行 */
  binding?: object;
}

/** 账户设置(desktop/accounts-setup.js)。账号只在这一次提交里出现:界面之后读到的仍是打了码的。 */
export type AccountChange =
  | { action: 'upsert'; alias: string; account_id: string; is_paper: boolean; connection: string; make_default?: boolean }
  | { action: 'remove'; alias: string };

export interface AccountsInfo {
  placeholders: string[];
  connections: { name: string; broker: string; port: number | null }[];
}

/** 条款同意的状态(desktop/consent.js)。version 是现行条款的版本号。 */
export interface ConsentState {
  version: string;
  accepted: boolean;
  acceptedAt: string | null;
}

// ---- 引擎契约(engine-ts/src/contract/):优质股追踪、股票池开关、板块、价位提醒、持仓追踪、设置、想法、回测、盘口、行情带、扫描器 ------
// 这几个域的形状**不在这里定义**:引擎的 handler 与这里用的是同一份类型,返回结构改一个字段名,
// 两头一起编译不过。只许 `import type`,只许进 contract/ 顶层的类型文件(它们不 import 任何东西,
// 界面的 tsc 不装引擎依赖也解析得了);contract/schema/ 是引擎自己的运行时校验,这里不碰。
import type {
  AppStatus, BrokerCatalog, BrokerProviderEntry, DiagnoseAccount, DiagnoseResult, FutuScanResult, GuideStep, PortStatus, TwsScanResult,
  ButterflyCandidate, ButterflyReviewResult, ExitPhases, ExitPlan, ExitSimulation, ExitTotals, ReviewAnalyzeResult, ReviewCandidate, ReviewFinding, StockCandidate,
  StockReviewResult,
  PaAnalyzeResult, PaComment, PaEvent, PaEvidence, PaLevel, PaPattern, PaSwing, PaTimeframe,
  CdSignal, CdSignalError, DeviationPoint, DeviationResult, InflectionResult, InflectionRow, RsResult, RsRow, RsTagRow,
  LeaderRow, LeadersResult, MarketRegime, TrendCheck, VcpResult,
  LLMConfig, LlmCatalog, LlmPatch, LlmProvider, LlmTestResult,
  BookL1, BookLevel, BookLiquidity, BookSnapshot, MacroBoard, MacroRow,
  BacktestCurvePoint, BacktestRunResult, BacktestRunSpec, BacktestStrategy, BacktestTrade, CustomRules, CustomRulesInput, BacktestSweepResult, BacktestSweepSpec, SegmentStats, SweepObjective, SweepRow, WalkForward,
  RuleConditionInput, RuleOperandInput,
  Idea, IdeaAnalysis, IdeaBrief, IdeaBriefMetric, IdeaDigest, IdeaDigestRow, IdeaMatch, IdeaTradeFact, IdeaTradeResult,
  IdeasSimilarTradesParams, IdeasSimilarTradesResult, SimilarExitStat, SimilarTrade,
  EquityPoint, LedgerTrade, PerfGroup, PerformanceFinding, PerformanceKind, PerformanceScope, PerfStats, ReviewPerformanceResult, ExecutionCost, ExecutionGroup, ExecutionRow, ProtectionAdvice, ReviewSignalsResult, SignalEntry, SignalGroup, SignalHorizonStats, SignalSource,
  AnomalyConfig, AnomalyEvent, AnomalyKind, AnomalyMetrics, LevelKind, OptionWall, PoolWatch, PoolWatchPatch, PositionRow,
  FlyPlanIvMode, FlyPlanLeg, FlyPlanParams, FlyPlanPoint, FlyPlanResult, FlyPlanScenario, FlyPlanTime, FlyPlanValue, IvRecorderStatus, OptionsSpot,
  PlaybookBand, PlaybookEvent, PlaybookSnapshot, PlaybookState,
  AccountView, Limits, Policies, ProtectionsConfig, QualityList, QualityMonitor, QualityStock, RpcParams, RpcResult, Sector,
  SectorStock, SettingsPatch, SettingsView, SpotTarget, StockQuote, Targets, Track, Watch, WatchEvent, WatchLevel,
  MaTouchConfig, TouchBook, TouchEpisode, TouchLine, WatchTrigger,
  BreakerBrief, BreakerState, IndexSpot, ProtectionCooldown, ProtectionsSummary, SystemSelftest, SystemStatus,
  TrackerHeartbeat,
  PendingItem, PendingPollResult, RecordAccount, RecordFill, RecordIbkr, RecordInput, RecordLlm, RecordStatusEvent,
  TradeRecord, TradeRecordSummary,
  ChaseInfo, HostedOrderRow, HostedTrack, TrackBlocked, TrackEvaluation, TrackFired, TrackPollRow,
  TrackerCloseNowResult, TrackerPollResult, TrackerReconcileResult,
  InstructionLlm, InstructionOrder, InstructionRejection, InstructionSubmitResult, OrderTicket, OrderTicketLeg,
  OrderTrigger,
  BackupInfo, DataBackupsResult,
  FollowConfig, FollowEntry, FollowLink, FollowLinkState, FollowOutcome, FollowReaderState, FollowSeen, FollowStatus,
} from '../../../engine-ts/src/contract/index';

export type {
  AppStatus, BrokerCatalog, BrokerProviderEntry, DiagnoseAccount, DiagnoseResult, FutuScanResult, GuideStep, PortStatus, TwsScanResult,
  ButterflyCandidate, ButterflyReviewResult, ExitPhases, ExitPlan, ExitSimulation, ExitTotals, ReviewAnalyzeResult, ReviewCandidate, ReviewFinding, StockCandidate,
  StockReviewResult,
  PaAnalyzeResult, PaComment, PaEvent, PaEvidence, PaLevel, PaPattern, PaSwing, PaTimeframe,
  CdSignal, CdSignalError, DeviationPoint, DeviationResult, InflectionResult, InflectionRow, RsResult, RsRow, RsTagRow,
  LeaderRow, LeadersResult, MarketRegime, TrendCheck, VcpResult,
  LLMConfig, LlmCatalog, LlmPatch, LlmProvider, LlmTestResult,
  BookL1, BookLevel, BookLiquidity, BookSnapshot, MacroBoard, MacroRow,
  BacktestCurvePoint, BacktestRunResult, BacktestRunSpec, BacktestStrategy, BacktestTrade, CustomRules, CustomRulesInput, BacktestSweepResult, BacktestSweepSpec, SegmentStats, SweepObjective, SweepRow, WalkForward,
  RuleConditionInput, RuleOperandInput,
  Idea, IdeaAnalysis, IdeaBrief, IdeaBriefMetric, IdeaDigest, IdeaDigestRow, IdeaMatch, IdeaTradeFact, IdeaTradeResult,
  IdeasSimilarTradesParams, IdeasSimilarTradesResult, SimilarExitStat, SimilarTrade,
  EquityPoint, LedgerTrade, PerfGroup, PerformanceFinding, PerformanceKind, PerformanceScope, PerfStats, ReviewPerformanceResult, ExecutionCost, ExecutionGroup, ExecutionRow, ProtectionAdvice, ReviewSignalsResult, SignalEntry, SignalGroup, SignalHorizonStats, SignalSource,
  AnomalyEvent, AnomalyKind, LevelKind, OptionWall, PoolWatch, PoolWatchPatch, PositionRow, QualityList, QualityMonitor,
  FlyPlanIvMode, FlyPlanLeg, FlyPlanParams, FlyPlanPoint, FlyPlanResult, FlyPlanScenario, FlyPlanTime, FlyPlanValue, IvRecorderStatus, OptionsSpot,
  PlaybookBand, PlaybookEvent, PlaybookSnapshot, PlaybookState,
  QualityStock, Sector, SectorStock, SettingsPatch, SpotTarget, StockQuote, Targets, Track, Watch, WatchEvent, WatchLevel,
  MaTouchConfig, TouchBook, TouchEpisode, TouchLine, WatchTrigger,
  BreakerBrief, BreakerState, IndexSpot, ProtectionCooldown, SystemSelftest, SystemStatus, TrackerHeartbeat,
  PendingItem, PendingPollResult, RecordAccount, RecordFill, RecordIbkr, RecordInput, RecordLlm, RecordStatusEvent,
  TradeRecord, TradeRecordSummary,
  ChaseInfo, HostedOrderRow, HostedTrack, TrackBlocked, TrackEvaluation, TrackFired, TrackPollRow,
  TrackerCloseNowResult, TrackerPollResult, TrackerReconcileResult,
  InstructionLlm, InstructionOrder, InstructionRejection, InstructionSubmitResult, OrderTicket, OrderTicketLeg,
  OrderTrigger,
  BackupInfo, DataBackupsResult,
  FollowConfig, FollowEntry, FollowLink, FollowLinkState, FollowOutcome, FollowReaderState, FollowSeen, FollowStatus,
};
/** 界面这边一直用的名字;引擎契约里分别叫 AccountView / SettingsView / Policies / Limits / ProtectionsConfig。 */
export type Account = AccountView;
export type Settings = SettingsView;
export type SettingsPolicies = Policies;
export type SettingsLimits = Limits;
export type SettingsProtections = ProtectionsConfig;
/** 状态条与自检读的那两份;保护规则的现状引擎那边叫 ProtectionsSummary(配置叫 ProtectionsConfig,别混)。 */
export type Status = SystemStatus;
export type Selftest = SystemSelftest;
export type ProtectionsStatus = ProtectionsSummary;
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
  page?: 'quality' | 'sectors' | 'trade';
}

export type EngineEvent = { event: string; data: any };
export type EventChannel = 'engine-event' | 'engine-log' | 'engine-exit' | 'menu' | 'window';

type Rpc<T = unknown> = Promise<T>;

export interface DafriBridge {
  platform: string;

  status(): Rpc<RpcResult<'system.status'>>;
  selftest(): Rpc<RpcResult<'system.selftest'>>;
  listRecords(limit?: number): Rpc<RpcResult<'records.list'>>;
  getRecord(id: string): Rpc<RpcResult<'records.get'>>;
  listPending(): Rpc<RpcResult<'pending.list'>>;
  pollPending(): Rpc<RpcResult<'pending.poll'>>;
  getSettings(): Rpc<RpcResult<'settings.get'>>;
  breakerState(): Rpc<RpcResult<'breaker.state'>>;

  addIdea(text: string): Rpc<RpcResult<'ideas.add'>>;
  listIdeas(status?: string): Rpc<RpcResult<'ideas.list'>>;
  updateIdea(id: string, status: string): Rpc<RpcResult<'ideas.update'>>;
  analyzeIdea(id: string): Rpc<RpcResult<'ideas.analyze'>>;
  digestIdeas(
    scope?: string, focus?: RpcParams<'ideas.digest'>['focus'], trades?: boolean,
  ): Rpc<RpcResult<'ideas.digest'>>;
  listIdeaDigests(): Rpc<RpcResult<'ideas.digests'>>;
  searchIdeas(filter: RpcParams<'ideas.search'>): Rpc<RpcResult<'ideas.search'>>;
  similarTrades(ticket: RpcParams<'ideas.similar_trades'>): Rpc<RpcResult<'ideas.similar_trades'>>;

  listSectors(): Rpc<RpcResult<'sectors.list'>>;
  addSector(name: string): Rpc<RpcResult<'sectors.add'>>;
  deleteSector(id: string): Rpc<RpcResult<'sectors.delete'>>;
  pickSector(id: string): Rpc<RpcResult<'sectors.pick'>>;
  sectorQuotes(): Rpc<RpcResult<'sectors.quotes'>>;
  addSectorStock(id: string, symbol: string, tag?: string): Rpc<RpcResult<'sectors.add_stock'>>;
  removeSectorStock(id: string, symbol: string): Rpc<RpcResult<'sectors.remove_stock'>>;
  setSectorTag(id: string, symbol: string, tag: string): Rpc<RpcResult<'sectors.set_tag'>>;

  screenerRs(spec: RpcParams<'screener.rs'>): Rpc<RpcResult<'screener.rs'>>;
  screenerInflection(spec: RpcParams<'screener.inflection'>): Rpc<RpcResult<'screener.inflection'>>;
  screenerDeviation(spec: RpcParams<'screener.deviation'>): Rpc<RpcResult<'screener.deviation'>>;
  screenerLeaders(spec: RpcParams<'screener.leaders'>): Rpc<RpcResult<'screener.leaders'>>;
  appInfo(): Rpc<AppInfo>;
  /** force:跳过主进程 10 分钟的缓存(「检查更新」按钮用) */
  checkUpdate(force?: boolean): Rpc<UpdateInfo>;
  /** 分享卡片:PNG 拷进剪贴板 / 另存(路径由主进程的对话框定;用户取消回 canceled) */
  exportImage(action: 'copy' | 'save', dataUrl: string, name?: string): Rpc<{ ok: boolean; canceled?: boolean; path?: string }>;

  llmCatalog(): Rpc<RpcResult<'llm.catalog'>>;
  /** llm 的对象字面量要直接标成 LlmPatch(同 TrackerAddSpec):写错的键名编译期就查得出来 */
  llmPatch(llm: LlmPatch): Rpc<RpcResult<'llm.patch'>>;
  llmTest(llm: LlmPatch, apiKey?: string): Rpc<RpcResult<'llm.test'>>;
  setApiKeyFor(secret: string, provider: string): Rpc<any>;

  scanTws(): Rpc<RpcResult<'tws.scan'>>;
  diagnoseTws(connections?: string[]): Rpc<RpcResult<'tws.diagnose'>>;
  launchTws(app: string): Rpc<RpcResult<'tws.launch'>>;

  brokerCatalog(): Rpc<RpcResult<'broker.catalog'>>;
  selectBroker(provider: string): Rpc<RpcResult<'broker.select'>>;
  scanFutu(): Rpc<RpcResult<'futu.scan'>>;
  diagnoseFutu(connections?: string[]): Rpc<RpcResult<'futu.diagnose'>>;
  launchFutu(): Rpc<RpcResult<'futu.launch'>>;
  setFutuPassword(password: string, alreadyMd5?: boolean): Rpc<RpcResult<'futu.set_password'>>;
  unlockFutu(connection?: string): Rpc<RpcResult<'futu.unlock'>>;

  /** Discord 跟单此刻的样子:配置、连接、今天跟了几单、最近的信号、频道里最近看到的消息 */
  followStatus(): Rpc<RpcResult<'follow.status'>>;
  /** 存 bot token(系统凭证库)并用它重新连接 */
  setFollowToken(token: string): Rpc<RpcResult<'follow.set_token'>>;
  reconnectFollow(): Rpc<RpcResult<'follow.reconnect'>>;

  /** 一句话 → 解析 → 校验 →(execute 为真时)发单。主进程要求界面已经确认过一次(SENSITIVE_RPC) */
  submit(text: string, execute: boolean, accounts: string[]): Rpc<RpcResult<'instruction.submit'>>;
  /** 回执就是改完之后的那份设置。键名写错引擎会当场拒、不写盘(config 对每一段都查未知键)。 */
  patchSettings(patch: SettingsPatch): Rpc<RpcResult<'settings.patch'>>;
  setApiKey(secret: string): Rpc<RpcResult<'keychain.set'>>;
  connectBroker(connections?: string[]): Rpc<RpcResult<'broker.connect'>>;
  disconnectBroker(): Rpc<RpcResult<'broker.disconnect'>>;
  halt(reason: string): Rpc<RpcResult<'breaker.halt'>>;
  resume(): Rpc<RpcResult<'breaker.resume'>>;
  exportData(path: string): Rpc<RpcResult<'data.export'>>;
  restartEngine(): Rpc<any>;

  /** 交易库的备份清单(库旁边的 backups/ 目录),新的在前 */
  listBackups(): Rpc<RpcResult<'data.backups'>>;
  backupNow(): Rpc<RpcResult<'data.backup'>>;
  /** 从备份恢复:主进程弹确认框、停引擎、换库、再拉起。用户取消回 canceled */
  restoreBackup(name: string): Rpc<{ ok: boolean; canceled?: boolean; restored?: string }>;

  /** 导出一份能发给支持的诊断信息(已脱敏);保存到哪由主进程的对话框定 */
  exportDiagnostics(): Rpc<{ ok: boolean; canceled?: boolean; path?: string }>;
  /** 把几行概要拷进剪贴板(不带日志) */
  copyDiagnostics(): Rpc<{ ok: boolean }>;
  /** 在文件管理器里打开:日志 / 配置文件 / 备份目录 / 第三方许可声明 */
  reveal(kind: 'logs' | 'config' | 'backups' | 'notices'): Rpc<{ ok: boolean }>;

  consentState(): Rpc<ConsentState>;
  acceptConsent(version: string): Rpc<ConsentState>;
  /** 退出应用(不同意条款时用)。和 ⌘Q 走同一条路:引擎停稳了才真的退出 */
  quit(): Rpc<void>;

  /** 还是示例占位的账户别名,与配置里可选的连接 */
  accountsInfo(): Rpc<AccountsInfo>;
  /** 加 / 改 / 删一个账户别名。主进程校验、弹原生确认框、写配置、重启引擎;用户取消回 canceled */
  changeAccount(change: AccountChange): Rpc<{ ok: boolean; canceled?: boolean }>;

  backtestStrategies(): Rpc<RpcResult<'backtest.strategies'>>;
  /** spec 的对象字面量要直接标成 BacktestRunSpec(同 TrackerAddSpec):这样写错的键名编译期就查得出来 */
  runBacktest(spec: BacktestRunSpec): Rpc<RpcResult<'backtest.run'>>;
  sweepBacktest(spec: BacktestSweepSpec): Rpc<RpcResult<'backtest.sweep'>>;
  parseBacktestRules(text: string): Rpc<RpcResult<'backtest.parse_rules'>>;
  orderBook(symbol: string): Rpc<RpcResult<'book.snapshot'>>;

  optionWall(spec: RpcParams<'options.wall'>): Rpc<RpcResult<'options.wall'>>;
  flyPlan(spec: RpcParams<'options.fly_plan'>): Rpc<RpcResult<'options.fly_plan'>>;
  ivRecorder(): Rpc<RpcResult<'options.iv_recorder'>>;
  setIvRecorder(enabled: boolean): Rpc<RpcResult<'options.iv_recorder_set'>>;
  indexSpot(symbol: string): Rpc<RpcResult<'options.spot'>>;
  playbook(): Rpc<RpcResult<'options.playbook'>>;
  setPlaybook(enabled: boolean): Rpc<RpcResult<'options.playbook_set'>>;
  listAlerts(): Rpc<RpcResult<'alerts.list'>>;
  createAlert(symbol: string, step: number): Rpc<RpcResult<'alerts.create'>>;
  deleteAlert(id: string): Rpc<RpcResult<'alerts.delete'>>;
  refreshAlert(id: string, expiry?: string): Rpc<RpcResult<'alerts.refresh'>>;
  pollAlerts(): Rpc<RpcResult<'alerts.poll'>>;
  /** 短期内反复碰均线的口径(本地道,存 app_prefs)。一次只给要改的那几项。 */
  setTouchConfig(config: Partial<MaTouchConfig>): Rpc<RpcResult<'alerts.set_touch_config'>>;

  paTimeframes(): Rpc<RpcResult<'pa.timeframes'>>;
  paAnalyze(spec: RpcParams<'pa.analyze'>): Rpc<RpcResult<'pa.analyze'>>;
  paComment(spec: RpcParams<'pa.comment'>): Rpc<RpcResult<'pa.comment'>>;
  reviewCandidates(limit?: number, includeLocal?: boolean): Rpc<RpcResult<'review.candidates'>>;
  reviewAnalyze(spec: RpcParams<'review.analyze'>): Rpc<RpcResult<'review.analyze'>>;
  reviewPerformance(spec: RpcParams<'review.performance'>): Rpc<RpcResult<'review.performance'>>;
  reviewSignals(spec: RpcParams<'review.signals'>): Rpc<RpcResult<'review.signals'>>;
  macroBoard(force?: boolean): Rpc<RpcResult<'macro.board'>>;

  listPositions(): Rpc<RpcResult<'positions.list'>>;
  listTrackers(): Rpc<RpcResult<'tracker.list'>>;
  /** 授权软件自动发单。载荷的键名要靠 TrackerAddSpec 在拼的地方查(见它的注释),这里的参数类型查不了多余的键。 */
  addTracker(spec: TrackerAddSpec): Rpc<RpcResult<'tracker.add'>>;
  updateTracker(spec: RpcParams<'tracker.update'>): Rpc<RpcResult<'tracker.update'>>;
  deleteTracker(id: string): Rpc<RpcResult<'tracker.delete'>>;
  pollTrackers(): Rpc<RpcResult<'tracker.poll'>>;
  previewSpotTarget(key: string, spotTarget: number, chaseMaxPct?: number | null): Rpc<RpcResult<'tracker.target_preview'>>;
  reconcileTrackers(): Rpc<RpcResult<'tracker.reconcile'>>;
  /** 直接发一张平仓单:主进程要求界面已经确认过一次(SENSITIVE_RPC) */
  closePositionNow(id: string): Rpc<RpcResult<'tracker.close_now'>>;

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
  /** fatal:配置读不进来 / 交易库打不开,引擎不会自动重启(主进程会弹对话框);其余情况主进程自己会拉起 */
  on(channel: 'engine-exit', handler: (payload: { detail: string; fatal?: 'config' | 'store' }) => void): () => void;
  /** 菜单与弹窗的「查看」:navigate 带着要去的页和标的 */
  on(channel: 'menu', handler: (payload: { action: string; page?: string; symbol?: string }) => void): () => void;
  /** 主窗口的焦点与全屏状态;每次都是完整的一份,不是增量 */
  on(channel: 'window', handler: (payload: { focused: boolean; fullscreen?: boolean }) => void): () => void;
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

/** Electron 给主进程抛回来的错加的前缀:「Error invoking remote method 'rpc': Error: 」。那不是给用户看的话。 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(IPC_PREFIX, '');
}

/**
 * 「AI 解读失败:<原因>」这类横幅,前缀只出现一次。前缀归界面:引擎没起来、入参校验这些报错不经过 handler,只有界面每条路都看得见。
 * 有几处引擎的报错自己已经带着同一个前缀(引擎测试钉着原话),这里不再叠一层。
 */
export function errorWithPrefix(prefix: string, err: unknown): string {
  const text = errorMessage(err);
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}
