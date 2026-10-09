/** pa.*:实时 K 线的价格行为(Price Action)读盘。类型文件,不 import 任何东西。
 *
 * 数字与结构判定**全是代码按 K 线算的事实**(摆动结构、BOS/CHoCH、关键位、FVG、扫单、形态、ATR);
 * 模型只做解读,不许自己推算价格(见 pa.comment)。数值口径由 golden-analysis 钉着,这里只定形状。
 *
 * **判定只用已收盘的 K 线。** 最后一根还没走完时,它单独放在 `forming` 里,只作提示;除了 `forming`、画图用的
 * `bars` / `ma`、现价 `last` 与新鲜度 `last_bar` / `age_seconds`,其余每一项都只算到 `closed_bar` 那一根。
 */

/** 画图用的一根 K 线。 */
export interface PaBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 摆动点。label 是给人看的序列名(HH / HL / LH / LL)。 */
export interface PaSwing {
  /** 在这一组 K 线里的下标 */
  index: number;
  time: string;
  price: number;
  kind: "high" | "low";
  label: string;
}

/** 结构事件:收盘突破前高 / 前低。同向是 BOS(延续),反向是 CHoCH(转折)。 */
export interface PaEvent {
  kind: string;
  /** up 向上突破 / down 向下突破 */
  direction: string;
  time: string;
  index: number;
  /** 被突破的那个摆动点的价 */
  level: number;
  close: number;
  swing_time: string;
  /** 一句中文,界面与提示词直接用 */
  text: string;
}

/** 关键位:几个摆动点聚在一起的价格带(一簇里最高与最低相差不超过容差)。 */
export interface PaLevel {
  price: number;
  /** 这一簇里有几个摆动点 */
  swings: number;
  /** 有多少根 K 线的高或低碰过它 */
  touches: number;
  /** 在最后一根收盘价上方是阻力,下方是支撑 */
  side: string;
  /** 距最后一根收盘价百分之几 */
  distance_pct: number;
}

/** 未回补的失衡缺口(FVG)。走完 90% 以上的不再列。 */
export interface PaFvg {
  /** bull 向上的缺口 / bear 向下的 */
  side: string;
  time: string;
  bottom: number;
  top: number;
  filled_pct: number;
}

/** 订单块:最后一根反向 K 线。mitigated = 那次突破之后价格回来碰过它。 */
export interface PaOrderBlock {
  side: string;
  time: string;
  bottom: number;
  top: number;
  mitigated: boolean;
}

/** 扫单:影线刺穿前高 / 前低又收了回来。 */
export interface PaSweep {
  /** bear 扫上方 / bull 扫下方 */
  direction: string;
  time: string;
  index: number;
  level: number;
  /** 影线到过的极值 */
  extreme: number;
  text: string;
}

/** 等高 / 等低:两个几乎同价的摆动点,那一侧大概率堆着流动性。 */
export interface PaEqualLevel {
  kind: "high" | "low";
  price: number;
  /** 两个摆动点各自的时间 */
  times: string[];
  text: string;
}

/** 近端 K 线形态(只看最后几根:形态是即时信息)。 */
export interface PaPattern {
  name: string;
  direction: string;
  note: string;
  time: string;
  /** 距最后一根已收盘的 K 线几根(0 = 刚收盘的那一根) */
  bars_ago: number;
}

/** 环境:波动率、位置、量能。数据不够的项直接没有。全部只用已收盘的 K 线。 */
export interface PaContext {
  /** 最后一根已收盘 K 线的收盘价:本页所有判定对着它算 */
  last: number;
  atr: number;
  atr_pct: number | null;
  change_pct: number | null;
  ema20?: number;
  vs_ema20_pct?: number;
  ema50?: number;
  /** 多头排列 / 空头排列 */
  ema_stack?: string;
  range_high: number;
  range_low: number;
  /** 区间是按最近多少根算的 */
  range_bars: number;
  /** 收盘落在区间的百分之几处 */
  range_pos_pct: number | null;
  /** 最后一根已收盘 K 线的量比近 20 根均量;没有成交量数据时整项不给 */
  rel_volume?: number | null;
  /** 最后一根所在那一天的开高低(日内周期才有意义);当天不足 2 根时不给 */
  session?: { date: string; bars: number; open: number; high: number; low: number };
}

/** 打分表上的一条。weight 为正是看涨方向,为负是看跌。 */
export interface PaEvidence {
  /** 归哪一个子分:structure 结构 / location 位置 / confirm 确认 */
  group: "structure" | "location" | "confirm";
  label: string;
  detail: string;
  weight: number;
}

/** 子分:同一类依据的权重之和。三个子分并排看,互相不抵消;总分 score 仍是全部依据相加、再夹在 ±100 之内(子分自己不夹)。 */
export interface PaSubScore {
  key: "structure" | "location" | "confirm";
  /** 结构 / 位置 / 确认 */
  label: string;
  /** 这一组依据的权重之和,正 = 看涨 */
  score: number;
  /** 这一组全部同向时能到的上限(绝对值) */
  max: number;
  /** 这一组里同时有看涨与看跌的依据 */
  mixed: boolean;
}

/** 正在形成的那一根:最后一根 K 线还没走完时才有。只作提示,不确认突破、扫单与形态,不进打分。 */
export interface PaForming {
  time: string;
  /** 这一根按钟点几点走完(美东 'YYYY-MM-DD HH:MM');算不出是 null */
  closes_at: string | null;
  /** 钟点上已经走完、却仍不让它进判定的原因:delayed 行情是延迟的(晚 15–20 分钟),它的数据可能还没到齐;
   *  unknown 还说不准这个标的的行情是不是延迟的,先按延迟对待。钟点没到(真的还在走)是 null */
  waiting: "delayed" | "unknown" | null;
  open: number;
  high: number;
  low: number;
  /** 这一根此刻的价 */
  close: number;
  volume: number;
  /** 这一根若此刻收盘会成立的突破 / 扫单,每条一句中文;收盘之前都不算数 */
  hints: string[];
}

/** 怎么算确认、什么情况下这个判断就错了。 */
export interface PaPlan {
  /** 最近的上方阻力 / 下方支撑;这段样本里没有就是 null */
  resistance: PaLevel | null;
  support: PaLevel | null;
  /** 值得盯的几处,每条是一句中文(未回补的 FVG、没被回踩的订单块、最近的关键位) */
  watch: string[];
  /** 确认条件,一句中文 */
  confirm?: string;
  /** 失效条件:价位 + 为什么。震荡里没有单一失效位时 price 是 null */
  invalidation?: { price: number | null; why: string };
  /** ATR 相关的一句话(这个周期一根大概走多少) */
  atr_note?: string;
}

/** 高周期背景的摘要:只给判断,不给全量(它只是背景)。 */
export interface PaHtfSummary {
  timeframe: string;
  timeframe_label: string;
  bias: string;
  bias_label: string;
  score: number;
  trend_label: string;
  /** 最近一次结构事件的那句话;没有是 null */
  last_event: string | null;
  resistance: number | null;
  support: number | null;
  /** 高周期的判断算到哪一根收盘为止 */
  closed_bar: string;
}

/** 低周期与高周期合不合。 */
export interface PaAgreement {
  /** aligned 顺势 / conflict 逆势 / unclear 两个周期里有一个方向不明,谈不上顺逆(哪一个见 text)/ unknown 没有高周期数据可对照 */
  state: string;
  text: string;
}

/** 一次价格行为分析。pa.analyze 的回执 = 这一份 + 四项由 handler 补上的。 */
export interface PaAnalysis {
  symbol: string;
  timeframe: string;
  timeframe_label: string;
  /** 进判定的 K 线根数(已收盘的) */
  bar_count: number;
  first_bar: string;
  /** 拿到的最新一根的时间(可能还没收盘);新鲜度看它 */
  last_bar: string;
  /** 判定算到哪一根为止:最后一根已收盘的 K 线。没有正在形成的那一根时等于 last_bar */
  closed_bar: string;
  /** 正在形成的那一根;最后一根已经收盘时是 null */
  forming: PaForming | null;
  /** 最新一根 K 线距今多少秒;算不出是 null */
  age_seconds: number | null;
  /** 现价:最新一根的收盘价(那一根还在形成时就是此刻的价)。判定用的收盘价在 context.last */
  last: number;
  atr: number;
  swing_strength: number;
  /** -100 ~ 100:全部依据的权重相加。只由已收盘的 K 线决定,同一根 K 线走完之前不变 */
  score: number;
  /** bullish / lean_bull / neutral / lean_bear / bearish */
  bias: string;
  bias_label: string;
  /** |score| / 70,封顶 1 */
  confidence: number;
  trend: string;
  trend_label: string;
  /** 最近 10 个摆动点 */
  swings: PaSwing[];
  /** 最近 6 次结构事件 */
  events: PaEvent[];
  levels: PaLevel[];
  fvgs: PaFvg[];
  order_block: PaOrderBlock | null;
  sweeps: PaSweep[];
  equal_levels: PaEqualLevel[];
  patterns: PaPattern[];
  context: PaContext;
  /** 打分的依据:每条是"哪一项、什么情况、加减多少分" */
  evidence: PaEvidence[];
  /** 结构 / 位置 / 确认三个子分,顺序固定 */
  sub_scores: PaSubScore[];
  plan: PaPlan;
  /** 画图用的最近若干根;正在形成的那一根也在里面(最后一个) */
  bars: PaBar[];
  /** 均线序列,键是周期;每条和 bars 一样长,不足周期的位置是 null */
  ma: Record<string, Array<number | null>>;
  /** 这次取的是不是全时段(含盘前盘后) */
  extended_hours: boolean;
  /** 读这份分析之前要知道的事(盘前盘后成交稀薄、K 线太旧之类) */
  warnings: string[];
  /** 给人看的几句话 */
  readout: string[];
}

/** pa.analyze 的回执:分析本身 + handler 补的四项。 */
export interface PaAnalyzeResult extends PaAnalysis {
  /** 高周期背景;那一路拿不到(或本来就没有高周期)是 null——背景缺了不毁掉整次分析 */
  htf: PaHtfSummary | null;
  agreement: PaAgreement;
  /** 这次的 K 线是从缓存里拿的 */
  cached: boolean;
  /** 这次只看盘中 */
  rth: boolean;
  fetched_at: string;
}

/** 模型对这份分析的解读。只解读,不给仓位、不给下单建议。 */
export interface PaComment {
  summary: string;
  /** 2~4 句讲清当前结构 */
  reading: string;
  /** 接下来盯哪几个价位;每条引用事实里已有的价 */
  watch: string[];
  /** 这个判断可能错在哪 */
  risks: string[];
}

export interface PaCommentResult {
  analysis: PaAnalyzeResult;
  comment: PaComment;
  /** 哪个模型解读的 */
  model: string;
}

/** pa.timeframes:界面的周期下拉照它摆。 */
export interface PaTimeframe {
  key: string;
  label: string;
  seconds: number;
  /** 对应的高周期;日线上面没有了,是 null */
  htf: string | null;
}

export interface PaTimeframesResult {
  timeframes: PaTimeframe[];
  /** 同一条 K 线最少隔多少秒才重取(IBKR 判 15 秒内的相同历史请求为超频)。连 force 也压不过它 */
  min_interval: number;
}

// ---------------------------------------------------------------- 入参
/** pa.analyze 与 pa.comment 同一份入参。 */
export interface PaAnalyzeParams {
  symbol: string;
  /** 1m / 2m / 5m(默认)/ 15m / 30m / 1h / 1d */
  timeframe?: string;
  /** 只看盘中;不给 = 全时段(收盘后只看盘中的话,K 线会停在昨天 16:00) */
  rth?: unknown;
  /** 用户点了强制刷新:把 TTL 降到最小重取间隔,但压不过它 */
  force?: unknown;
}
