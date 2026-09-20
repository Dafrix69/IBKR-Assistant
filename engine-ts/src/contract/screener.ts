/** screener.*:RS 强度 / 拐点筛选(CD 背离)/ 极值偏离。纯代码计算,只读。类型文件,不 import 任何东西。
 *
 * 三个方法同一套骨架:按板块取成分股 → 拉 K 线 → 交给 screener.ts 算 → 原样返回,外加 sector 与 fetched_at。
 * 数值口径由 golden-screener 钉着,这里只定形状。**某一只拉不到 K 线不是整次失败**:那一行自己带 error,别的照算。
 */

// ---------------------------------------------------------------- 三个方法共用
/** 扫描哪个池子:板块 id;"all" 或不给 = 所有板块的并集(同一只以先出现的板块为准)。 */
export interface ScreenerScope {
  sector?: string;
}

// ---------------------------------------------------------------- RS 强度
/** 一个回看窗口上的相对强弱。rs = (1+自己的涨幅)/(1+基准的涨幅) - 1。 */
export interface RsWindowCell {
  ret_pct: number;
  bench_pct: number;
  rs_pct: number;
  /** 这个窗口上跑赢基准了 */
  beats: boolean;
}

export interface RsRow {
  symbol: string;
  /** 业务标签(「芯片」「电力」);没填的归到「未分类」 */
  tag: string;
  company: string;
  /** 最新收盘;一根都没拉到是 null */
  last: number | null;
  /** 拉到几根日线 */
  bars: number;
  /** 键是窗口天数的字符串("5" / "20" / …);K 线不够那个窗口就没有这一项 */
  rs: Record<string, RsWindowCell>;
  /** 各窗口 rs 的均值(%);一个窗口都算不出是 null */
  score: number | null;
  /** 按 score 排的名次;没有 score 的不排名 */
  rank: number | null;
  /** 这一只为什么没数据(拉 K 线失败的原话);正常是 null */
  error: string | null;
}

/** 按业务标签汇总:这一类整体强不强,比单只更稳。 */
export interface RsTagCell {
  median_pct: number;
  /** 这一类里有几只在这个窗口跑赢 */
  beats: number;
  total: number;
}

export interface RsTagRow {
  tag: string;
  count: number;
  rs: Record<string, RsTagCell>;
  score: number | null;
  symbols: string[];
}

export interface RsResult {
  /** SPY / QQQ */
  benchmark: string;
  /** 表头:几日 + 中文名 */
  windows: Array<{ n: number; label: string }>;
  rows: RsRow[];
  tags: RsTagRow[];
  /** 有几只算出了分数(= 排了名的) */
  counted: number;
  total: number;
  bench_bars: number;
  bench_last: number | null;
  /** 扫的是哪个池子(板块名,或「全部板块」) */
  sector: string;
  fetched_at: string;
}

export interface ScreenerRsParams extends ScreenerScope {
  /** SPY(默认)/ QQQ;不认识的报「基准只能是 SPY / QQQ」 */
  benchmark?: string;
}

// ---------------------------------------------------------------- 拐点筛选:CD 背离
/** 背离的两个摆动点之一。 */
export interface CdPivot {
  /** 在这一组 K 线里的下标 */
  index: number;
  time: string;
  price: number;
  /** 那一根上的 MACD 快线(DIF) */
  dif: number;
}

/** 给了 ma_period 才算:价格穿没穿回均线,穿回去之后还站得住吗。 */
export interface CdConfirm {
  /** 用的是几周期均线 */
  ma: number;
  /** confirmed 穿回且站住 / failed 穿回又丢了 / waiting 还没穿回 / n/a 均线算不出来 */
  status: string;
  /** 穿回去的那一根的时间;还没穿回是 null */
  at: string | null;
  /** 穿回之后过了几根 */
  age: number | null;
}

/** 一个标的在一个周期上的 CD 背离判定。 */
export interface CdSignal {
  /** 底背离 / 顶背离;没有就是 null */
  signal: "bull" | "bear" | null;
  /** 「底背离」「顶背离」「无」 */
  label: string;
  bars: number;
  last: number | null;
  dif_last: number | null;
  /** DIF 在零轴上方 / 下方 / 正好为零 */
  dif_side: "above" | "below" | "zero" | null;
  /** 构成背离的两个摆动点;没有背离是空数组 */
  pivots: CdPivot[];
  /** 第二个摆动点距今几根 */
  age: number | null;
  price_gap_pct: number | null;
  dif_gap: number | null;
  confirm: CdConfirm | null;
  /** 没有信号时的缘由(K 线不够 / 最近没有新的摆动点);有信号是 null */
  reason: string | null;
}

/** 这一格的 K 线没拉到:整格换成一句话,不是给一份空信号。 */
export interface CdSignalError {
  error: string;
}

export interface InflectionRow {
  symbol: string;
  tag: string;
  company: string;
  /** 键是周期("1d" / "1w" / …) */
  signals: Record<string, CdSignal | CdSignalError>;
  /** 几个周期上有信号 */
  hits: number;
  /** 其中几个已被均线确认 */
  confirmed: number;
}

export interface InflectionResult {
  /** 去重、保序之后实际扫的周期 */
  timeframes: string[];
  /** 不给 = 不做确认,各行的 confirm 是 null */
  ma_period: number | null;
  rows: InflectionRow[];
  /** 每个周期上有几个底背离 / 顶背离 / 已确认(前两个的键和 CdSignal.signal 同名:计数时直接拿它当键) */
  per_timeframe: Record<string, Record<"bull" | "bear" | "confirmed", number>>;
  /** 有几只至少命中一个周期 */
  hit_count: number;
  total: number;
  sector: string;
  fetched_at: string;
}

export interface ScreenerInflectionParams extends ScreenerScope {
  /** 1w / 1d / 1h / 30m / 15m;不给 = ["1d", "1w"]。日内周期一次最多拉 40 个(标的×周期),超出的那一格记一句话 */
  timeframes?: unknown;
  /** 2~250;不给 = 不做均线确认 */
  ma_period?: number | string | null;
}

// ---------------------------------------------------------------- 极值偏离
/** 序列上的一根。界面拿它画偏离带与买卖压力。 */
export interface DeviationPoint {
  time: string;
  close: number;
  ma: number | null;
  /** 收盘相对均线偏离百分之几 */
  dev_pct: number | null;
  /** 偏离折成 z 分数(按 lookback 根历史);样本不够是 null */
  z: number | null;
  /** 偏离在历史里的分位 */
  rank_pct: number | null;
  /** 修正版买卖压力(-1~1,按成交量加权) */
  pressure: number | null;
  /** 收盘落在当根真实区间的百分之几处 */
  buy_pct: number;
  /** 成交量比 20 日均量;算不出是 null */
  volume_ratio: number | null;
}

export interface DeviationResult {
  period: number;
  lookback: number;
  smooth: number;
  z_extreme: number;
  bars: number;
  /** 最后 120 根 */
  series: DeviationPoint[];
  /** = series 的最后一根;K 线太少时没有 series,这里是 null */
  last: DeviationPoint | null;
  /** 偏离到了上方 / 下方极值;在常态区间是 null */
  extreme: "overbought" | "oversold" | null;
  extreme_label: string;
  /** 这一窗里偏离与压力各自的最大 / 最小;算不出是 null */
  window: {
    dev_max: { time: string; dev_pct: number | null };
    dev_min: { time: string; dev_pct: number | null };
    pressure_max: { time: string; pressure: number | null };
    pressure_min: { time: string; pressure: number | null };
  } | null;
  /** 给人看的几句话(中文);K 线不够时这里是那一句缘由 */
  readout: string[];
  symbol: string;
  timeframe: string;
  fetched_at: string;
}

export interface ScreenerDeviationParams {
  symbol: string;
  /** 1w / 1d(默认)/ 1h / 30m / 15m */
  timeframe?: string;
  /** 均线周期 2~250,默认 20 */
  period?: number | string | null;
  /** 折 z 分数用的历史根数 10~500,默认 120 */
  lookback?: number | string | null;
  /** 买卖压力的平滑 1~50,默认 5 */
  smooth?: number | string | null;
  /** 几个标准差算极值 0.5~5,默认 2 */
  z_extreme?: number | string | null;
}
