/** review.*:交易分析(复盘)。类型文件,不 import 任何东西。
 *
 * 看的是**真实成交**:券商的成交明细同步进本地库(只增),再合成一笔笔可复盘的交易。库里没有就是没有,
 * 不拿本地记录(只是"下过的单")冒充成交。两类交易走同一对接口,靠 `kind` 分:
 * 股票是一段持仓(买进到卖光),蝴蝶是一张组合单。数值口径由 golden-tradereview 与 stockreview.spec 钉着。
 */

// ---------------------------------------------------------------- 候选列表
/** 候选行的公共部分。 */
export interface ReviewCandidateBase {
  /** 股票那一类是 "stk:" 开头(分析时按它分流);蝴蝶是记录 id */
  id: string;
  /** ibkr = 从券商成交合成的;local = 本地记录里还没成交的那些(要 include_local 才列) */
  source: string;
  created_at: string | null;
  /** 给人看的一句话:股票是自动拼的,蝴蝶是当初那条指令的意图 */
  intent_summary: string;
  /** 账户**别名** */
  account: string;
  final_status: string | null;
  status: string | null;
  filled: boolean;
  symbol: string;
}

/** 一段股票持仓:买进到卖光算一段,没卖光就是 open。 */
export interface StockCandidate extends ReviewCandidateBase {
  kind: "stock";
  closed_at: string | null;
  /** LONG / SHORT */
  side: string;
  qty: number;
  /** 还没平掉的数量 */
  open_qty: number;
  entry_qty: number;
  exit_qty: number;
  avg_entry: number | null;
  avg_exit: number | null;
  /** 平完了才给;没平完、或卖的是期初的货(成本不知道)是 null——不编盈亏 */
  pnl: number | null;
  /** 这一段是从期初仓位接过来的(第一笔是卖) */
  carried: boolean;
  /** 期初持仓没核对过(没连券商,或读不到持仓):那就不反推、只标出来 */
  opening_assumed: boolean;
}

/** 一张蝴蝶。 */
export interface ButterflyCandidate extends ReviewCandidateBase {
  kind: "butterfly";
  expiry: string;
  /** 看涨 / 看跌 */
  right: string;
  /** [下翼, 中心, 上翼] */
  strikes: Array<number | null>;
  width: number | null;
  /** BUY / SELL */
  action: string;
  qty: number;
  /** 每组净价(借方为正);没有成交均价时按限价估 */
  price: number | null;
  price_estimated: boolean;
  /** 配上的平仓单(有就一起显示,不单独列一行) */
  exit?: { id: string; time: string | null; price: number | null; pnl: number | null };
}

export type ReviewCandidate = StockCandidate | ButterflyCandidate;

export interface ReviewCandidatesResult {
  /** 新的在前;股票与蝴蝶按时间混排 */
  candidates: ReviewCandidate[];
  /** 这一轮从券商同步进来几笔新成交;没去同步(没连券商 / 富途不支持)是 null */
  synced: number | null;
  /** 券商那一路能不能查成交:连着 IBKR 才是 true(富途没有这个接口) */
  ibkr_available: boolean;
  /** 本地库里一共攒了多少笔成交(不是这次新增的) */
  fills_stored: number;
}

export interface ReviewCandidatesParams {
  /** 最多列几行,默认 200 */
  limit?: number | string;
  /** 连本地记录里还没成交的蝴蝶一起列 */
  include_local?: unknown;
}

// ---------------------------------------------------------------- 复盘:两类各自的细分结构
/** 一次出手(买或卖)。time 是 UTC,time_et 是给人看的美东。 */
export interface ReviewExecution {
  time: string;
  time_et: string | null;
  action: string;
  qty: number;
  price: number;
  [field: string]: unknown;
}

/** 股票那一段持仓的画像。 */
export interface StockProfile {
  symbol: string;
  side: string;
  /** 做多 / 做空 */
  side_label: string;
  qty: number;
  entry_qty: number;
  exit_qty: number;
  open_qty: number;
  avg_entry: number | null;
  avg_exit: number | null;
  /** 第一笔是卖:这一段接的是期初仓位 */
  carried: boolean;
  carried_qty: number;
  currency: string;
  /** 建仓花了多少;不知道成本时是 null */
  cost: number | null;
  entries: ReviewExecution[];
  exits: ReviewExecution[];
}

/** 蝴蝶那张单的画像(1:2:1 三腿、同到期、同方向)。 */
export interface ButterflyProfile {
  symbol: string;
  /** C / P */
  right: string;
  /** 看涨 / 看跌 */
  right_label: string;
  expiry: string;
  expiry_raw: string;
  lower: number;
  center: number;
  upper: number;
  width: number;
  width_upper: number;
  /** 两翼等宽 */
  symmetric: boolean;
  /** BUY / SELL */
  action: string;
  qty: number;
  multiplier: number;
  /** 每组净价;没有成交均价时是按限价估的(见 price_estimated) */
  debit: number | null;
  price_estimated: boolean;
  trading_class: string;
}

/** 蝴蝶的盈亏区间。debit 不知道时 known 是 false、其余都是 null。 */
export interface ButterflyZone {
  lower_be: number | null;
  upper_be: number | null;
  max_profit: number | null;
  max_loss: number | null;
  known: boolean;
}

/** 进场。 */
export interface ReviewEntry {
  time: string;
  time_et: string | null;
  price: number | null;
  /** 当时标的在哪 */
  underlying: number | null;
  /** 落在哪一根 K 线上 */
  bar_time?: string;
  /** 股票:成本知不知道 */
  known?: boolean;
  /** 蝴蝶:进场时刻是估的(成交里没有明确时间) */
  estimated?: boolean;
  price_estimated?: boolean;
}

/** 结果。kind:closed 平完了 / open 还拿着 / expired 到期了。 */
export interface ReviewOutcome {
  kind: string;
  time: string | null;
  time_et: string | null;
  price: number | null;
  underlying: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  /** 股票:已实现 / 未实现分开算 */
  realized_pnl?: number | null;
  unrealized_pnl?: number | null;
  open_qty?: number;
  commission?: number | null;
  /** 蝴蝶:现在就到期的话是多少 */
  pnl_if_expired_now?: number | null;
  /** 平仓那条记录的 id */
  record_id?: string | null;
}

/** 最大有利 / 不利偏移的那一刻:每股多少、占成本几个点、一共多少钱、当时的价与时刻。 */
export interface ReviewExcursion {
  per_share: number;
  pct: number | null;
  amount: number;
  price: number;
  time: string;
}

/** 过程中的统计。两类各有各的项,所以都写成可选——这个类型在两支上都说真话。 */
export interface ReviewStats {
  hold_bars?: number | null;
  hold_high?: number | null;
  hold_low?: number | null;
  // ---- 股票 ----
/** 持有期间走到过的最有利 / 最不利的那一刻。 */
  mfe?: ReviewExcursion | null;
  mae?: ReviewExcursion | null;
  /** 吃到了这段行情的百分之几 */
  capture_pct?: number | null;
  capture_ratio?: number | null;
  entry_position?: number | null;
  exit_position?: number | null;
  start_underlying?: number | null;
  end_underlying?: number | null;
  pre_exit_bars?: number;
  pre_exit_move?: number | null;
  pre_exit_pct?: number | null;
  /** 平完之后又走了多少(看有没有卖早) */
  post_exit?: { bars: number; close: number; move: number; move_pct: number | null; [k: string]: unknown } | null;
  // ---- 蝴蝶 ----
  entry_underlying?: number | null;
  exit_underlying?: number | null;
  move_points?: number | null;
  /** 进 / 出场时标的离蝴蝶中心多远(点数与"几个翼宽") */
  dist_entry?: number | null;
  dist_entry_widths?: number | null;
  dist_exit?: number | null;
  dist_exit_widths?: number | null;
  moved_toward_center?: boolean;
  closest?: { price: number; distance: number; time: string } | null;
  farthest?: { distance: number; time: string } | null;
  in_zone_bars?: number | null;
  in_zone_ratio?: number | null;
  touched_zone_bars?: number | null;
  best_theoretical?: { pnl: number; time: string; underlying: number | null } | null;
  settle_value?: number | null;
  // ---- 两类都有 ----
  pre_entry_move?: number | null;
  pre_entry_bars?: number | null;
  post_entry_move?: number | null;
  post_entry_bars?: number | null;
  post_entry_pct?: number | null;
  pre_entry_pct?: number | null;
}

// ---------------------------------------------------------------- 复盘
/** 画图用的一根 K 线。 */
export interface ReviewBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

/** 图上的一个标记:entry 进场 / exit 出场 / expiry 到期。 */
export interface ReviewMarker {
  kind: string;
  time: string;
  price: number | null;
  [field: string]: unknown;
}

/** 图上的一条横线:蝴蝶的三个行权价(lower / center / upper)、两个盈亏平衡点,股票的均价这一类。 */
export interface ReviewLevel {
  kind: string;
  price: number | null;
  [field: string]: unknown;
}

/** 画图用的一段:窗口内的 K 线 + 进出场标记 + 关键位。 */
export interface ReviewSeries {
  timeframe: string;
  /** 这组 K 线是不是日线 */
  daily: boolean;
  bars: ReviewBar[];
  markers: ReviewMarker[];
  levels: ReviewLevel[];
}

/** 蝴蝶**自己那条价**的分钟线(不是标的的):开仓那天的走势。 */
export interface FlySeries {
  bars: ReviewBar[];
  /** ibkr = 券商给的组合历史;model = 按模型估的 */
  source: string;
  markers: ReviewMarker[];
}

/** 复盘结论里的一条。tone 给界面上色。 */
export interface ReviewFinding {
  title: string;
  text: string;
  tone: string;
}

/** 两类复盘都有的部分。 */
export interface ReviewBase {
  /** 进场:时刻、价、当时标的在哪 */
  entry: ReviewEntry;
  /** 结果:平了没有、平在哪、赚亏多少 */
  outcome: ReviewOutcome;
  /** 过程中的统计(最大浮盈浮亏、持有多少根、进出场位置分位这一类) */
  stats: ReviewStats;
  findings: ReviewFinding[];
  series: ReviewSeries;
  /** 这次复盘要说明的前提(价是估的、K 线不全这一类) */
  notes: string[];
  reviewed_at: string;
  /** 复盘的是哪条记录 */
  record_id: string | null;
  source: string;
  intent_summary: string;
  /** 实际用的周期的中文名 */
  timeframe_label: string;
}

// ---------------------------------------------------------------- 止盈策略回放(蝴蝶)
/** 一条临界带:标的落在 K ± half_width 之内 / 之外,对应不同的处置。 */
export interface ExitZone {
  /** hold 持有 / half 清半 / stop 止损 */
  kind: string;
  half_width: number;
  low: number;
  high: number;
  /** 这一带的规则,一句中文 */
  label: string;
}

/** 回放里的一分钟。 */
export interface ExitSimPoint {
  time: string;
  /** 这一刻的蝶价 */
  price: number;
  /** real = 券商给的真实蝶价;model = Bachelier 模型价(图上以虚线区分) */
  source: string;
  /** 开仓后的阶段 A / B / C */
  phase: string;
  /** 剩余波动(σ) */
  sigma_rem: number | null;
  /** 标的离蝶心多远 */
  dist: number;
  /** 还剩几组没平 */
  remaining: number;
  /** 回撤追踪的止损线;没激活是 null */
  trail_stop: number | null;
}

/** 按策略走一遍的结果。**按 `applicable` 判别的联合**:
 *  不适用那一支只有 reason(卖出的蝶、没有入场净权利金、开仓当天没有 K 线);
 *  适用那一支 totals / series / events 一定都在。这样 `if (sim.applicable)` 之后就能直接取,
 *  不用每处再兜一次底。 */
export type ExitSimulation = ExitSimulationSkipped | ExitSimulationRun;

export interface ExitSimulationSkipped {
  applicable: false;
  /** 为什么不能回放,一句中文 */
  reason: string;
}

export interface ExitSimulationRun {
  applicable: true;
  /** 开仓时标的已经在止损带之外(远端 OTM 蝶) */
  entry_outside: boolean;
  entry_dist: number;
  /** 策略触发的每一次卖出 */
  events: Array<Record<string, unknown>>;
  series: ExitSimPoint[];
  totals: ExitTotals;
}

export interface ExitTotals {
  /** 照策略走能拿到多少 */
  strategy: number;
  /** 实际拿到多少(没平仓是 null) */
  actual: number | null;
  /** 一直拿到结算是多少 */
  hold_to_settle: number | null;
  best_mid: number | null;
  best_mid_pnl: number | null;
  profit_peak: number;
  /** 有几分钟用的是模型价、几分钟是真实蝶价 */
  model_minutes: number;
  real_minutes: number;
}

/** 阶段切换的时刻与阈值(flyexit.ts 算的)。时刻是 `HH:MM` 的墙钟串,不是 ISO。 */
export interface ExitPhases {
  /** 阶段 A 到这一刻为止 */
  a_until: string;
  /** 阶段 C 从这一刻起 */
  c_from: string;
  /** 切换那一刻的剩余波动率 */
  sigma_at_switch: number;
  /** 切换阈值 = 翼宽 / switch_k */
  threshold: number;
  em_at_open: number;
  /** 翼宽相当于几个 EM;EM 为 0 时是 null */
  wing_in_sigma: number | null;
}

/** 止盈策略回放:当初按这套规则走会是什么结果。 */
export interface ExitPlan {
  /** 这次回放用的参数(EM、几档临界比例这一类) */
  params: Record<string, unknown>;
  /** 图上要画的几条横线(两档止盈、回撤追踪激活线、止损) */
  levels: ReviewLevel[];
  zones: ExitZone[];
  /** 阶段切换的时刻与阈值 */
  phases: ExitPhases;
  simulation: ExitSimulation;
  /** 这次回放的前提与保留(EM 是默认值、哪几分钟用的模型价这一类) */
  notes: string[];
  /** 实际平掉的那一笔相当于入场净价的几倍。**只在真的平了仓、且入场净价不为 0 时才有**
   *  (见 flyexit.ts:实际 kind 必须是 closed);没平仓 / 到期结算的那一路没有这一项。 */
  actual_exit_mult?: number | null;
}

export interface StockReviewResult extends ReviewBase {
  kind: "stock";
  profile: StockProfile;
  account: string;
}

export interface ButterflyReviewResult extends ReviewBase {
  /** 蝴蝶那一支没有 kind 这一项(股票那支才有):界面按它分流 */
  kind?: undefined;
  profile: ButterflyProfile;
  /** 蝴蝶的盈亏区间(两个盈亏平衡点、最大盈亏) */
  zone: ButterflyZone;
  /** 蝴蝶自己那条价的分钟线;拿不到时没有这一项 */
  fly_series?: FlySeries;
  /** 止盈策略回放:当初挂不同止盈会是什么结果。K 线不够或没连券商时没有这一项 */
  exit_plan?: ExitPlan;
}

/** 按 kind 分:股票那一支有 account、没有 zone / exit_plan。 */
export type ReviewAnalyzeResult = StockReviewResult | ButterflyReviewResult;

export interface ReviewAnalyzeParams {
  /** 候选行里的 id;"stk:" 开头走股票复盘 */
  id: string;
  /** 1m / 2m / 5m / 15m / 30m / 1h / 1d;不给 = auto(按开仓离现在多远挑) */
  timeframe?: string;
  /** 止盈策略回放的参数(蝴蝶才看;不是对象就当没给)。里面几项由 flyexit 自己校验 */
  exit?: unknown;
}
