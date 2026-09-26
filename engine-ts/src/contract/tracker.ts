/** tracker.*:持仓追踪的设置(目标、自动平仓)、追踪行、标的目标价试算。类型文件,不 import 任何东西。
 *
 * tracker.add / tracker.update 是在**授权软件自动发单**,所以这个域的入参 schema 是 strict 的(见 schema/tracker.ts):
 * 不认识的键当场拒,不像别的域那样静默丢掉——丢一个键 = 追踪建成了,那道保护却没设上。
 * tracker.poll / reconcile / close_now 的返回还没进契约:那三样是 engine.ts 在下单路径里拼出来的,等它拆开再标类型。
 */

// ---------------------------------------------------------------- 目标
/** 分档利润回撤的一档:浮盈达到成本的 above 倍之后,回撤阈值换成 pct(%)。 */
export interface DrawdownTier {
  above: number;
  pct: number;
}

/** 尾盘收紧:美东 after("15:00")之后,回撤阈值乘 factor。 */
export interface DrawdownLate {
  after: string;
  factor: number;
}

export interface Targets {
  take_profit: number | null;
  stop_loss: number | null;
  trail_pct: number | null;
  /** 利润回撤:当前利润比历史峰值利润低这么多个百分点时触发。
   * 峰值利润不用单独存:利润对价格单调,由已持久化的峰值价格换算,重启不丢。 */
  profit_drawdown_pct: number | null;
  /** 分档回撤:按**浮盈相对成本的倍数**换档位。`profit_peak / |costBasis|` 对期权组合
   * 恰好就是 flyexit 的"浮盈 / D"——两边同乘 数量×乘数 就约掉了,不必另传 D。
   * 形如 [{above: 0, pct: 40}, {above: 1, pct: 30}, {above: 3, pct: 20}]:
   * 取所有 above ≤ 当前倍数 里最高的那一档。不填就全程用 profit_drawdown_pct。 */
  profit_drawdown_tiers: DrawdownTier[] | null;
  /** 尾盘收紧:{after: "15:00", factor: 0.5}。 */
  profit_drawdown_late: DrawdownLate | null;
  /** 激活线:峰值浮盈 / |成本| 没到这个倍数之前,利润回撤不触发。蝶式 0.3(= 蝶价到过 1.3×D)。
   * 只有 preset "fly" 会设;老记录没有这个键,读出来是 null,行为不变。 */
  profit_drawdown_arm: number | null;
  /** 最少回吐(每份的价格点):现价离峰值不到这么多不触发,免得被组合中间价的噪声扫出去。蝶式 0.20。 */
  profit_drawdown_floor: number | null;
  /** **标的**的目标价。止盈价不由人填,而是每一轮按当前波动率算出「标的走到这里时
   * 这份持仓该值多少」——正股、单腿期权、蝶式/价差都走这一条,见 spotTarget()。 */
  spot_target: number | null;
}

export interface AutoClose {
  enabled: boolean;
  order_type: string; // MKT 一定成交;LMT 控价但可能不成交
  slippage_pct: number;
  /** 触发后平掉持仓的百分之多少。默认全平;设 50 即卖出一半锁利。 */
  close_fraction_pct: number;
  /** 把止盈/止损挂到券商服务器(GTC + OCA):软件关掉也生效。软件开着时,
   * 利润回撤等动态目标由引擎按秒调整托管单价格;关掉则停在最后一次。 */
  host_at_broker: boolean;
  /** 追价平仓最多让到自然价的百分之几(见 chaseLimit)。只管期权与组合;正股不追价。 */
  chase_max_pct: number;
}

// ---------------------------------------------------------------- 追踪行
/** position_tracks 表的一行(JSON 三列已解开)。 */
export interface Track {
  id: string;
  created_at: string;
  updated_at: string;
  account: string;
  symbol: string;
  sec_type: string;
  /** 期权腿 / 组合的身份;正股是空串 */
  leg: string;
  contract: Record<string, unknown>;
  /** 库里存的是当时写进去的那份 JSON:老行没有后来才加的键,所以是 Partial——读的时候过一遍 makeTargets 补默认值 */
  targets: Partial<Targets>;
  /** 同上,读的时候过 makeAutoClose 补默认值。tracker.update 传 auto_close 是合并(2026-09-20 之前是整份替换,没带的键就没了) */
  auto_close: Partial<AutoClose>;
  /** 回执与列表一个口径(2026-09-20 之前 tracker.add 的回执里是数字 1,和 alerts.create 同一个毛病,一起改掉的)。 */
  enabled: boolean;
  /** 跟踪止损跟的"最有利价",只朝有利方向走;落库是为了重启不丢 */
  peak: number | null;
  fired_at: string | null;
  /** 触发状态:空串 = 没触发;take_profit / stop_loss / …;blocked = 到价了但被闸门拦下;`sweep:` 开头 = 正在追价平仓 */
  fired_state: string;
  fired_record: string;
  note: string;
}

// ---------------------------------------------------------------- 标的目标价
export interface SpotTarget {
  /** 标的的目标价(照抄输入,方便界面一处取齐)。 */
  spot_target: number;
  /** 标的现价。 */
  spot: number | null;
  /** 现价是怎么来的(夜盘按期货推算时写明期货与基差);常规时段的官方价为空串。 */
  spot_note: string;
  /** 预计价位:标的走到 spot_target 时这份持仓的模型价(每股 / 每张 / 每组净价)。 */
  price: number | null;
  /** 预估收益(总额,已乘数量与乘数)。算不出成本或价格时为 null。 */
  pnl: number | null;
  /** 预估收益相对成本的百分比。 */
  pnl_pct: number | null;
  /** 算这个价用的 σ_剩余(点);正股没有 σ。smile 档报最贴近目标价那条腿的。 */
  sigma: number | null;
  /** σ 从哪来:none = 正股不需要、smile = 每条腿各自反解、net = 净价反解、leg = 最近腿反解、
   * clock = EM×√剩余方差。 */
  sigma_source: string;
  /** smile 档每条腿各自的 σ(按 legPriceKey 索引);别的档没有这一项。 */
  leg_sigmas?: Record<string, number>;
  /** 这份持仓是什么结构,给错误信息和界面用。 */
  structure: string;
  /** 算不出来的时候说清楚为什么——静默回 null 会让界面显示成"还没到价"。 */
  reason: string;
  /** 引擎这一轮**只守不挂**:没有市场价可用,也没有上一次的市场价可沿用。
   * 这时不挂新单、也不撤已经挂着的单(见 engine.applySpotTarget)。 */
  held?: boolean;
  /** 试算时:算得出价,但这个价不比现价更有利(挂上去会立刻成交)。设置时同一句话会当场拒。 */
  warning?: string;
  /** 标的**此刻**已经到了(或越过)目标价:同一组 σ 下,持仓在现价处的价值不低于目标价处的价值。
   * 单腿、价差是"越过目标价";蝶是"进了目标价与它关于中心的镜像之间"——那段里蝶只会更值钱。
   * 拿不到标的现价时没有这一项。 */
  reached?: boolean;
  /** 试算时:此刻立刻平掉能拿到(空头:要付)的价,按各腿买卖价合成;拿不到报价时没有这一项。 */
  natural?: number;
  /** 追价平仓最多让到的价(自然价按 chase_max_pct 让满),以及那个百分比 */
  chase_floor?: number;
  chase_max_pct?: number;
}

// ---------------------------------------------------------------- 入参
/**
 * 表单里的一个数。界面发过来的是**字符串**(Tracker.tsx 用 str(tp) 取表单值),'' 表示不设;数字也认;
 * null / 不给 = 不设。**'' 不是 0**——这一条 tracker-rpc.spec 钉着。不是数的字符串由 handler 报「不是有效数字」。
 */
export type NumberField = number | string | null;

/** 自己列的一档:above 与 pct 都不能空,pct 要在 (0, 100] */
export interface DrawdownTierInput {
  above: NumberField;
  pct: NumberField;
}

/** 五个目标字段 + 分档那一组。新建与修改共用。 */
export interface TargetsInput {
  take_profit?: NumberField;
  stop_loss?: NumberField;
  trail_pct?: NumberField;
  profit_drawdown_pct?: NumberField;
  /** "fly" = 直接用蝶式那套 40 / 30 / 20 + 15:00 收紧 + 激活线 + 最少回吐;给了它就不看下面两项 */
  profit_drawdown_preset?: string;
  /** '' / 不给 = 不分档 */
  profit_drawdown_tiers?: DrawdownTierInput[] | "";
  profit_drawdown_late?: { after: string; factor?: NumberField };
  /** 利润回撤的起算门槛(%):峰值浮盈到过成本的这么多才开始按回撤平,存成 Targets.profit_drawdown_arm = 它 / 100。
   *  '' / 不给 = 不设(浮盈一 > 0 就算,加门槛之前的行为)。preset "fly" 用蝶式自己那道激活线,不看它 */
  profit_drawdown_arm_pct?: NumberField;
  /** 和 take_profit 只能选一个 */
  spot_target?: NumberField;
}

export interface TrackerAddParams extends TargetsInput {
  /** positions.list 给的那个 key */
  key: string;
  /** 到价自动平仓:打开它就是授权软件发单 */
  auto_close?: boolean;
  /** 只认 "LMT",别的一律当市价 */
  order_type?: string;
  slippage_pct?: NumberField;
  close_fraction_pct?: NumberField;
  /** 托管到券商服务器(只有 IBKR 账户能开) */
  host_at_broker?: boolean;
  /** 0 是合法值(至少让两跳),所以不能拿 0 当"没填" */
  chase_max_pct?: NumberField;
  /** 截到 200 字 */
  note?: string;
}

/**
 * 三种改法,可以一起给:enabled(重新启用会把上一次触发的闩解开)、auto_close(**合并**:只给要改的键,没带的保持原样)、
 * 目标字段(给了任何一个,就按"五个一起给"算——没给的那几个等于被清掉)。
 */
export interface TrackerUpdateParams extends TargetsInput {
  id: string;
  enabled?: boolean;
  auto_close?: Partial<AutoClose>;
}

export interface TrackerDeleteParams {
  id: string;
}

export interface TrackerTargetPreviewParams {
  key: string;
  /** 必填,但"没填"由 handler 报那句人话(「要给一个标的目标价」),所以类型上允许空 */
  spot_target?: NumberField;
  chase_max_pct?: NumberField;
}

export interface TrackerTargetPreviewResult {
  spot_target: SpotTarget;
  /** stock = 正股、option = 单腿、combo = 多腿净价;label 是给人看的一句话 */
  structure: { kind: string; label: string };
}
