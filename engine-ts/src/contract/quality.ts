/** quality.*:优质股追踪与异动监控——引擎与界面共用的形状。
 *
 * **这个目录里的类型文件不 import 任何东西**(同目录的类型文件除外):界面的 tsc 会顺着 bridge.ts 的
 * `import type` 走进来,而 CI 里界面那一路不装引擎的依赖,也没有 node 的类型。入参的 zod schema 在
 * 同名的 `.schema.ts` 里,只有引擎 import。
 */

export type AnomalyKind = "rvol" | "burst" | "spike" | "day_move";

// ---------------------------------------------------------------- 触发条件
/** 异动阈值。引擎 normalizeAnomalyConfig 校验并合并,界面只管给数。 */
export interface AnomalyConfig {
  /** 全天量比(对同时段常态)达到这些倍数各报一次/天 */
  rvol_tiers: number[];
  /** 近 window_min 分钟量比 */
  burst_ratio: number;
  /** 3 / 5 / 10:流里正好有对应的近 3/5/10 分钟量,样本不够时拿来兜底 */
  window_min: number;
  /** 窗口内涨跌幅 ≥ spike_sigma × 窗口 σ 算急涨急跌 */
  spike_sigma: number;
  /** 急涨急跌的最低幅度(%):σ 很小的股不因 0.3% 就报 */
  spike_min_pct: number;
  /** 没有历史波动率时的固定阈值(%) */
  spike_fixed_pct: number;
  /** 较昨收涨跌幅达到 k × 日 σ 各报一次/天/方向 */
  day_sigma_tiers: number[];
  /** 没有历史波动率时的固定档(%) */
  day_fixed_tiers: number[];
  /** burst / spike 报过之后的冷却(分钟) */
  cooldown_min: number;
}

// ---------------------------------------------------------------- 指标与事件
/** 引擎每轮算出来的指标;不在时段内也有(只是不报)。 */
export interface AnomalyMetrics {
  last: number | null;
  /** 较昨收 % */
  change_pct: number | null;
  /** 全天量比 */
  rvol: number | null;
  /** 窗口量比 */
  burst: number | null;
  /** 窗口里最大一步占窗口量的比例(只有样本窗口才有,否则 null):接近 1 就是一笔大宗补报,不是持续放量。
   *  引擎判不判"放量"看的是去掉这一步之后还剩几倍(anomaly.ts 的 sustained),表里的着色要跟它同一道口径。 */
  block_share: number | null;
  /** 窗口涨跌幅 % */
  ret_window_pct: number | null;
  sigma_window_pct: number | null;
  sigma_day_pct: number | null;
  /** 窗口量比的基准 */
  basis_volume: "avg_volume" | "session_pace" | null;
  basis_sigma: "hist_vol" | "fixed";
  window_ready: boolean;
  delayed: boolean;
}

export interface AnomalyEvent {
  /** `${symbol}:${kind}:${direction ?? "-"}:${tier ?? "-"}:${Math.round(nowMs/1000)}` */
  id: string;
  /** 秒 */
  at: number;
  symbol: string;
  kind: AnomalyKind;
  direction: "up" | "down" | null;
  /** rvol / burst 的倍数;spike / day_move 的涨跌幅 %(带符号) */
  value: number;
  /** 触发时的阈值(倍数或 %,% 取幅度、不带符号) */
  threshold: number;
  /** rvol 档(倍数)或 day_move 档序号;其它 null */
  tier: number | null;
  /** spike / day_move 折成几个 σ(幅度,basis=hist_vol 时),否则 null */
  sigma: number | null;
  price: number | null;
  change_pct: number | null;
  /** "avg_volume" | "session_pace" | "hist_vol" | "fixed" */
  basis: string;
  title: string;
  text: string;
}

// ---------------------------------------------------------------- 一只股
/** quality_stocks 表的一行(store 读出来、JSON 列已解开的样子)。 */
export interface QualityStockRow {
  id: string;
  created_at: string;
  updated_at: string;
  symbol: string;
  note: string;
  /** 库里是 0 / 1,原样上线——界面按真假用,不要和 true / false 做 === */
  enabled: 0 | 1;
  /** 异动监控自己的档位 / 滞回状态(跨重启保留)。跟着整行上了线,但**界面不要读**:形状随监控的实现变。 */
  states: Record<string, unknown>;
  /** 最近 50 条 */
  events: AnomalyEvent[];
}

/** 库里的一行 + 内存里最近一轮的指标。 */
export interface QualityStock extends QualityStockRow {
  metrics: AnomalyMetrics | null;
  metrics_at: string | null;
  /** 这一轮取不到这只的行情时的原因("未知标的" 之类);取到了是 null */
  quote_error: string | null;
  /**
   * 同一只股身上的另一个开关(盯价位)算到哪一步了:'ok' = 有价位;'pending' = 排着等算(界面显示「正在算价位…」);
   * 'error:<原因>' = 上一次没算成或降级了,退避中;没开「盯价位」是 null。引擎在异动循环里捎带算,每轮最多一只。
   */
  levels_status: string | null;
}

// ---------------------------------------------------------------- 监控心跳
export interface QualityMonitor {
  running: boolean;
  interval_ms: number;
  ticks: number;
  /** 与盯盘心跳同风格:ISO 字符串;还没跑过一轮是 null */
  last_at: string | null;
  last_ms: number | null;
  last_error: string;
  session: "rth" | "pre" | "post" | "closed";
  connected: boolean;
  supported: boolean;
  /** 给人看的一句话("休市:开盘后开始检测" 之类),没有就是空串 */
  note: string;
}

// ---------------------------------------------------------------- 方法
export interface QualityList {
  stocks: QualityStock[];
  config: AnomalyConfig;
  monitor: QualityMonitor;
  /** 最多追踪几只 */
  max: number;
}

export interface QualityAddParams {
  /** 大小写、首尾空格引擎自己收拾;指数不收(量能流按正股订一定订不上) */
  symbol: string;
  note?: string;
  /** 不在任何板块时并进「自选」用的公司名 */
  company?: string;
}

export interface QualityUpdateParams {
  id: string;
  enabled?: boolean;
  note?: string;
}

export interface QualityRemoveParams {
  id: string;
}

/**
 * 触发条件的输入:键同 AnomalyConfig,**值由引擎校验**(normalizeAnomalyConfig)——数字与数字串都认
 * (表单里敲出来的就是字符串),缺的、null 的取当前生效值,越界的给中文原因。所以这里的值写成 unknown:
 * 进 handler 的时候它们确实还没验过。界面照 Partial<AnomalyConfig> 给就行。
 */
export type AnomalyConfigInput = { readonly [K in keyof AnomalyConfig]?: unknown };

export interface QualitySetConfigParams {
  /** 只给要改的那几项:引擎在当前生效的那份上合并 */
  config: AnomalyConfigInput;
}
