/** 期权墙(optionwall.analyze 的结果)。价位提醒把整份存在盯单上,所以先于 options.wall 进了契约。类型文件,不 import 任何东西。 */

/** 某一侧最大的那堵墙:现价上方的 call / 下方的 put。正好在现价上的那一档两边都不算;一样大取离现价近的。 */
export interface WallSide {
  strike: number;
  /** 未平仓量或成交量(张) */
  size: number;
  /** 距现价 %;现价为 0 时算不出,null */
  distance_pct: number | null;
}

export interface OptionWallStrike {
  strike: number;
  call_oi: number;
  put_oi: number;
  call_vol: number;
  put_vol: number;
  /** 这个行权价上的净 gamma 敞口(美元 / 每 1% 波动);这一档既没有模型 gamma 也没有隐含波动率就是 0 */
  net_gex: number;
}

/**
 * gamma 环境。符号建立在「做市商持有看涨、卖出看跌」这个假设上。
 * positive / negative = 净 GEX 的正负;neutral = 有分量而且正好抵消;
 * unknown = 什么都没称出来(总量为 0:没有隐含波动率与模型 gamma,或者没有未平仓量),不是 0,更不是「抵消」
 */
export type GexRegime = "positive" | "negative" | "neutral" | "unknown";

/** 所有未平仓期权内在价值之和最小的行权价。统计量,不是预言。 */
export interface MaxPain {
  strike: number;
  pain: number;
}

/** 纯计算的那一份(optionwall.analyze):不知道链是从哪家券商、用什么现价取来的。 */
export interface OptionWallCore {
  symbol: string;
  expiry: string;
  spot: number;
  multiplier: number;
  strike_count: number;
  days_to_expiry: number;
  strikes: OptionWallStrike[];
  call_wall: WallSide | null;
  put_wall: WallSide | null;
  call_vol_wall: WallSide | null;
  put_vol_wall: WallSide | null;
  /** 行权价太少(< 5 个)时不给 */
  max_pain: MaxPain | null;
  /** 净 gamma 敞口(美元 / 每 1% 波动):看涨记正、看跌记负。什么都没称出来(总量为 0)时是 null */
  net_gex: number | null;
  /** 不分正负加起来的总量;算不出是 null */
  gross_gex: number | null;
  /** 净 ÷ 总(−1 … 1):离 0 越近,看涨与看跌的 gamma 越接近抵消。「算不算中性」由看的人按这个数判,这里不设门槛 */
  net_gex_ratio: number | null;
  /** 净 GEX 变号的价位里离现价最近的那个。取到的行权价范围里不变号、或那条曲线在现价处的正负和 net_gex 对不上,都是 null */
  gamma_flip: number | null;
  regime: GexRegime;
  total_call_oi: number;
  total_put_oi: number;
  pc_ratio_oi: number | null;
  pc_ratio_volume: number | null;
  /** 链上有没有隐含波动率:没有就算不了 gamma 翻转位(净 GEX 还可以靠券商的模型 gamma) */
  has_greeks: boolean;
  /** 有几行没等到未平仓量(券商在等待时间里没推那一笔):这些行不在墙、净 GEX、最大痛点里。0 = 都到了 */
  oi_missing: number;
  warnings: string[];
  readout: string[];
}

export interface OptionsWallParams {
  symbol: string;
  /** 不给 = 最近的那个到期日 */
  expiry?: string;
  /** 现价上下各取多少个行权价,缺省 10;数字串也认 */
  width?: number | string;
}

/** 这份链取了哪一段行权价。行情线路有限,要看得宽就得抽着取:近处每档都取,越远只取越整的档 */
export interface WallCoverage {
  /** 取到的最低与最高一档 */
  lower: number;
  upper: number;
  /** 取到数的有多少档 */
  strikes: number;
  /** 这一段里链上一共有多少档。券商没给就是 null */
  grid_strikes: number | null;
  /** 是不是抽着取的:要订的档数比这一段里链上的档数少(个别档合约确认不了不算) */
  thinned: boolean;
}

/** 取链的那一层(services/marketData 的 wallFor)再补三样。 */
export interface OptionWall extends OptionWallCore {
  /** 这个标的可选的到期日 */
  expiries: string[];
  /** 现价是怎么来的:quote = 标的的报价;parity = 拿不到报价,用期权的买卖权平价反推的(富途),界面要标出来 */
  spot_source: "quote" | "parity";
  coverage: WallCoverage;
}

// ---------------------------------------------------------------- 蝴蝶测算(options.fly_plan)
// 开仓之前问的那一句:「按现在的现价开这只蝶,标的在某个时刻走到某个点位,它值多少、赚多少」。只算不下单。
// 设计与口径见 docs/features/fly-plan.md。

/** 到目标时刻 IV 怎么变:auto = 按历史数据校准出来的时段与走势两份;flat = 不变;shift = 按 iv_shift_pct 改 */
export type FlyPlanIvMode = "auto" | "flat" | "shift";

export interface FlyPlanParams {
  /** 缺省 SPX */
  symbol?: string;
  /** 到期日 YYYYMMDD;缺省 = 目标那一天(当日到期) */
  expiry?: string;
  /** 中心行权价 */
  center: number;
  /** 翼宽(点) */
  width: number;
  /** C / P;不给 = 中心高于现价看涨、否则看跌(和本地速记同一条规则) */
  right?: string;
  /** 张数,缺省 1 */
  quantity?: number;
  /** 每份成本(净权利金,点)。不给 = 此刻的盘口中间价 */
  cost?: number;
  /** 预计标的走到哪儿 */
  target_spot: number;
  /** 预计什么时候到:美东 HH:MM */
  target_time: string;
  /** 哪一天到:YYYY-MM-DD(美东);缺省 = 今天,今天已经收盘或不是交易日就是下一个交易日 */
  target_date?: string;
  /** 手动给现价:没连券商时必填;连着也可以给,按这个现价算 */
  spot?: number;
  /** 手动给 IV(年化,百分数:18 = 18%),三条腿共用。给了就不用券商的,也不锚定盘口 */
  iv?: number;
  /** 缺省 auto */
  iv_mode?: FlyPlanIvMode;
  /** iv_mode = shift 时用:到目标时刻 IV 相对现在变多少(%,+30 = 乘 1.3) */
  iv_shift_pct?: number;
}

export interface FlyPlanLeg {
  strike: number;
  right: "C" | "P";
  action: "BUY" | "SELL";
  ratio: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** 这条腿定价用的年化 IV(小数:0.18 = 18%) */
  iv: number;
}

/** 这份持仓在某处值多少、赚多少。value 是每份的净价(点),pnl 是全部张数的美元 */
export interface FlyPlanValue {
  value: number;
  pnl: number;
  /** 相对成本的百分比 */
  pnl_pct: number;
}

/** 从现价走到目标点位这一段,相对"当前 IV 定价的正常波动"算不算急 */
export interface FlyPlanMove {
  points: number;
  pct: number;
  minutes: number;
  direction: "up" | "down" | "flat";
  /** 按当前 IV,这段时间里一个标准差是多少点 */
  one_sigma: number;
  /** 这一段是几个标准差;时间为 0(现在就到)时是 null */
  sigmas: number | null;
  /** calm ≤ 1σ < brisk < 2σ ≤ sharp。只是描述走得急不急;IV 怎么变看的是 day_sigmas(走了多远) */
  pace: "calm" | "brisk" | "sharp";
  /** 全天(常规时段)一个标准差是多少点 */
  day_sigma: number;
  /** 这一段走了全天标准差的几倍,跌为负 */
  day_sigmas: number;
}

export interface FlyPlanIv {
  /** ibkr = IBKR 的模型 IV;quote = 各腿盘口中间价反解;input = 手动给的 */
  source: "ibkr" | "quote" | "input";
  mode: FlyPlanIvMode;
  /** 离现价最近那条腿此刻的 IV(小数) */
  now: number;
  /** 到目标时刻按多少算(小数) */
  at_target: number;
  /** at_target 相对 now 的变化(%) */
  change_pct: number;
  /** auto 档里时段那一份(%):一天的波动不是匀速走完的。别的档是 0 */
  seasonal_pct: number;
  /** auto 档里走势那一份(%):跌则升、涨则降。别的档是 0 */
  move_pct: number;
  /** auto 档:历史上同样的走势之后,半数情况下到时的 IV 落在这个区间(小数)。别的档、或「现在就到」是 null */
  range: { low: number; high: number } | null;
  /** auto 档用的那份校准;别的档是 null */
  model: FlyPlanIvModel | null;
}

/** IV 怎么变的那份校准是拿什么数据估的(engine-ts/src/flyIvModel.ts 的摘要) */
export interface FlyPlanIvModel {
  /** 校准是哪一天做的 */
  version: string;
  /** 样本的起止 */
  period: string;
  /** 样本里的交易日数 */
  days: number;
  /** IV 用的是什么:指数的名字(那就不是期权自己的 IV),或者"自己攒的当日到期期权 IV" */
  proxy: string;
  /** 样本外的 R²:模型解释得了 IV 变化的几成 */
  r2_out: number;
  /** 是不是拿软件自己攒的期权 IV 估的 */
  own: boolean;
}

export interface FlyPlanTarget extends FlyPlanValue {
  spot: number;
  /** 美东 YYYY-MM-DD HH:MM */
  at: string;
  epoch_ms: number;
  /** 到那时离到期还有几小时 */
  hours_left: number;
}

/** 同一个目标点位与时刻,IV 变成别的样子时的结果 */
export interface FlyPlanScenario extends FlyPlanValue {
  iv_change_pct: number;
  /** 到时的 IV(小数,离现价最近那条腿) */
  iv: number;
  /** 主结果用的就是这一档 */
  current: boolean;
}

/** 盈亏曲线上的一点:标的在 spot 时,三个时刻各值多少(每份净价,点) */
export interface FlyPlanPoint {
  spot: number;
  /** 现在就到 */
  now: number;
  /** 目标时刻到(IV 按 iv.mode) */
  target: number;
  /** 到期时停在这儿 */
  expiry: number;
}

/** 标的在不同时刻走到目标点位 */
export interface FlyPlanTime extends FlyPlanValue {
  /** 美东 HH:MM(跨日时带日期) */
  at: string;
  epoch_ms: number;
  /** 这一行按多少 IV 算的(小数) */
  iv: number;
  is_target: boolean;
}

export interface FlyPlanResult {
  symbol: string;
  expiry: string;
  trading_class: string;
  right: "C" | "P";
  lower: number;
  center: number;
  upper: number;
  width: number;
  quantity: number;
  multiplier: number;
  legs: FlyPlanLeg[];

  spot: number;
  /** quote = 券商的现价;futures = 夜盘按期货推算;input = 手动给的。拿到的是昨收时不算,报错请用户手动给 */
  spot_source: "quote" | "futures" | "input";
  spot_note: string;
  /** 美东 YYYY-MM-DD HH:MM */
  now_at: string;
  now_ms: number;
  expiry_at: string;
  expiry_ms: number;

  /** 组合此刻的盘口:bid = 现在卖得出的价,ask = 现在买得到的价;缺腿报价时是 null */
  market: { bid: number | null; mid: number | null; ask: number | null };
  /** 同一组 IV 在现价、此刻算出来的模型价 */
  model_now: number;
  /** 结果是不是锚在盘口中间价上(模型只管"变多少") */
  anchored: boolean;
  cost: number;
  /** input = 你填的;mid = 盘口中间价;model = 没有盘口,用的模型价 */
  cost_source: "input" | "mid" | "model";

  move: FlyPlanMove;
  iv: FlyPlanIv;
  /** 主结果:目标时刻到目标点位 */
  target: FlyPlanTarget;
  /** auto 档:IV 落在 iv.range 两头时各值多少——半数情况下的区间。别的档是 null */
  target_range: { low: FlyPlanValue; high: FlyPlanValue } | null;
  /** 同一处,IV 按不变算(iv.mode 不是 flat 时拿来对照) */
  target_flat: FlyPlanValue;
  /** 标的现在就到目标点位 */
  instant: FlyPlanValue;
  /** 到期时停在目标点位 */
  at_expiry: FlyPlanValue;
  /** 目标时刻最赚的位置 */
  peak: FlyPlanValue & { spot: number };
  /** 目标时刻的盈亏平衡点;这一侧在图的范围里找不到就是 null */
  breakeven: { low: number | null; high: number | null };
  expiry_breakeven: { low: number; high: number };
  /** 到期时停在中心 */
  max_profit: number;
  max_loss: number;

  scenarios: FlyPlanScenario[];
  curve: FlyPlanPoint[];
  timeline: FlyPlanTime[];
  warnings: string[];
}

// ---------------------------------------------------------------- 自己攒当日到期期权的 IV(options.iv_recorder*)
// 蝴蝶测算里"IV 怎么变"是拿 IV 指数校准的;要拿真的期权 IV 校准,只能从现在起自己记。只读行情,不下单。

export interface IvRecorderStatus {
  /** 开关(存在库的偏好表里)。默认开 */
  enabled: boolean;
  /** 后台循环在不在跑 */
  running: boolean;
  symbol: string;
  /** 多久记一笔 */
  interval_seconds: number;
  /** 样本存在哪个目录(交易库旁边的 fly-iv/) */
  dir: string;
  /** 已经攒了多少天、多少笔 */
  days: number;
  samples: number;
  first_date: string | null;
  last_date: string | null;
  /** 这次运行里最近一笔是什么时候记的(ISO);还没记过是 null */
  last_at: string | null;
  /** 上一轮为什么没记(没连券商、不在常规交易时段、已关闭……);记了就是空串 */
  idle_reason: string;
  last_error: string;
}

export interface IvRecorderSetParams {
  enabled: boolean;
}

// ---------------------------------------------------------------- 测算面板上的实时现价(options.spot)
// 和测算用的是同一路现价(夜盘按期货推算),界面两秒问一次:显示在面板顶上,走到关口时提醒。取不到不是 RPC 报错。

export interface OptionsSpotParams {
  /** 缺省 SPX。只认配置里的指数 */
  symbol?: string;
}

export interface OptionsSpot {
  symbol: string;
  /** 取不到是 null,原因在 note */
  price: number | null;
  /**
   * quote = 券商的指数现价(常规时段);futures = 常规时段之外按期货推算;
   * stale = 这个价没在动(夜盘推算失败时的上一个收盘价、或 TWS 与 IBKR 服务器断开时的最后一笔),只给人看,不当现价用;
   * none = 没有价
   */
  source: "quote" | "futures" | "stale" | "none";
  /** futures 时写明怎么推算的;stale / none 时写明为什么 */
  note: string;
  /** 引擎读到这个价的时刻(epoch 毫秒) */
  at: number;
}

// ---------------------------------------------------------------- SPX 日内剧本(options.playbook*)
// 预期波动区间(昨日 / 盘初 / 当前剩余,以及由后两条拼出来的今日区间)、区间推出来的剧本状态、期权墙上的加速档。只读,不下单。
// 设计与口径见 docs/features/playbook.md。

/** 一条预期波动区间:平值跨式(看涨 + 看跌的中间价)× √(π/2),围着锚上下各一份 */
export interface PlaybookBand {
  /** 取价的时刻(epoch 毫秒) */
  at: number;
  /** 锚:昨日口径是上一个收盘价;盘初与当前剩余是取价那一刻的现价;今日区间是盘初定价的那个锚 */
  anchor: number;
  /** 取跨式的行权价(离锚最近的那一档) */
  strike: number;
  /** 到期日 YYYYMMDD */
  expiry: string;
  call: number;
  put: number;
  /** 预期波动(点) */
  em: number;
  lower: number;
  upper: number;
  /** live = 当场读的盘口;backfill = 软件当时没开着,事后拿分钟线的中间价补的 */
  source: "live" | "backfill";
}

/** 今日区间的锚:09:35 的指数价。live = 09:35 那一刻当场读的;backfill = 没赶上那一刻,取的是 09:35 那根分钟线的开盘价 */
export interface PlaybookAnchor {
  at: number;
  price: number;
  source: "live" | "backfill";
}

/**
 * B2 = 站上今日区间上沿(上沿扩展;每取到新一格判一次);B3 = 跌破昨日区间下沿(失守续探;每一笔现价都判,压过 B2);
 * R = 两条线之间;none = 线还不全,判不了
 */
export type PlaybookState = "B2" | "B3" | "R" | "none";

export interface PlaybookEvent {
  at: number;
  /** enter = 进入 B2 / B3;invalid = 剧本失效(回到触发线另一侧);accel = 穿过加速档 */
  kind: "enter" | "invalid" | "accel";
  state: PlaybookState;
  /** 被穿过的那条线 */
  level: number;
  price: number;
}

/** 负 gamma 最大的那个行权价:做市商在这里顺着行情对冲,穿过它时走势容易加速 */
export interface PlaybookAccel {
  strike: number;
  net_gex: number;
}

export interface PlaybookWall {
  /** 这份期权链是什么时候取的(epoch 毫秒) */
  at: number;
  expiry: string;
  call_wall: WallSide | null;
  put_wall: WallSide | null;
  gamma_flip: number | null;
  net_gex: number | null;
  net_gex_ratio: number | null;
  regime: GexRegime;
  strikes: OptionWallStrike[];
  coverage: WallCoverage;
  oi_missing: number;
  warnings: string[];
}

export interface PlaybookSnapshot {
  symbol: string;
  /** 这份剧本属于哪个美东交易日;今天不是交易日也给今天的日期 */
  date: string;
  enabled: boolean;
  running: boolean;
  /** 最近一次读到的现价;不在常规时段、没连券商时是 null */
  price: number | null;
  price_at: number | null;
  /**
   * current = 当前剩余:围着取价那一刻的现价;day = 今日区间:09:35 的锚 ± 当前剩余的预期波动(B2 判的是它的上沿)。
   * day 是由那个锚与 current 拼出来的,缺一样就是 null;它不要 open(盘初的跨式补不到的日子照样有)
   */
  bands: { prior: PlaybookBand | null; open: PlaybookBand | null; current: PlaybookBand | null; day: PlaybookBand | null };
  state: PlaybookState;
  /** 现在这个状态是哪条线触发的(R / none 时是 null) */
  trigger: number | null;
  since: number | null;
  /** 此刻的两条触发线:b2 = 今日区间上沿,b3 = 昨日区间下沿 */
  lines: { b2: number | null; b3: number | null };
  /**
   * B2 失效时丢掉的那条线;不是 null = 还没重新上膛:回到今日区间里再站上去、或重新站回这条线之上,才算新的一次
   * (区间随时间收窄,失效那一格现价多半还在新的上沿之上)
   */
  b2_lost: number | null;
  t1: number | null;
  t2: number | null;
  accel: PlaybookAccel | null;
  wall: PlaybookWall | null;
  /** 今天的事件,从早到晚 */
  events: PlaybookEvent[];
  /** 哪条区间为什么还没有(没赶上 16:10、补不到分钟线……) */
  notes: string[];
  /** 上一轮为什么没动(没连券商、不在常规交易时段、已关闭……);在跑就是空串 */
  idle_reason: string;
  last_error: string;
  /** 当前区间多久重取一次(秒) */
  frame_seconds: number;
}

export interface PlaybookSetParams {
  enabled: boolean;
}
