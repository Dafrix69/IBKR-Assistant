/** 期权墙(optionwall.analyze 的结果)。价位提醒把整份存在盯单上,所以先于 options.wall 进了契约。类型文件,不 import 任何东西。 */

/** 某一侧最大的那堵墙:现价上方的 call / 下方的 put。 */
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
  /** 这个行权价上的净 gamma 敞口(美元 / 每 1% 波动) */
  net_gex: number;
}

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
  net_gex: number;
  /** 净 GEX 由负转正的价位;跨不过零就是 null,不外推 */
  gamma_flip: number | null;
  regime: "positive" | "negative";
  total_call_oi: number;
  total_put_oi: number;
  pc_ratio_oi: number | null;
  pc_ratio_volume: number | null;
  /** 链上有没有隐含波动率:没有就算不了 gamma 那几样 */
  has_greeks: boolean;
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

/** 取链的那一层(services/marketData 的 wallFor)再补两样。 */
export interface OptionWall extends OptionWallCore {
  /** 这个标的可选的到期日 */
  expiries: string[];
  /** 现价是怎么来的:quote = 标的的报价;parity = 拿不到报价,用期权的买卖权平价反推的(富途),界面要标出来 */
  spot_source: "quote" | "parity";
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
