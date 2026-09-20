/** positions.list:账户里的一份持仓。类型文件,不 import 任何东西。
 *
 * 一行从三处攒起来:券商适配层(broker.ts / futuBroker.ts 的 positions())给基础字段;tracker.withCombos 把同一账户、
 * 同一标的、同一到期日的期权腿另外折成一条 BAG 虚拟行(用户盯的是"这只蝴蝶值多少");positions.list 最后补上
 * tracked 与盈亏口径。所以后两段加的字段都是可选的——这个类型在每个阶段都说的是真话。
 */
export interface PositionRow {
  /** 持仓的身份:账户别名|标的|品种[|腿]。tracker.add 的 key 就是它 */
  key: string;
  /** 账户**别名**,不是账号 */
  account: string;
  symbol: string;
  /** STK / OPT / FOP / …;withCombos 合成的组合行是 BAG */
  sec_type: string;
  /** 期权腿 / 组合的身份;正股是空串 */
  leg: string;
  /** 给人看的名字:正股就是代码;期权是「SPX 7720C 2026-09-10」;组合是「买入看涨蝴蝶 7700/7720/7740」这一类 */
  label: string;
  /** 带符号:多头为正、空头为负。组合行是"几组",方向看净成本(借方为正) */
  quantity: number;
  multiplier: number;
  currency: string;
  /** 期权是**含乘数**的整张成本(IBKR 的 avgCost 口径);组合行是每组净成本的绝对值 */
  avg_cost: number;
  /** 此刻的价;拿不到是 null(休市、没有行情权限)。**昨收绝不填进这里**,见 close_price */
  market_price: number | null;
  market_value: number | null;
  unrealized_pnl: number | null;
  /** 合约的原样字段(secType / symbol / strike / right / …;组合行还带 legs 与 combo_strategy),发平仓单时用 */
  contract: Record<string, unknown>;

  // ---- 适配层视情况给的 ----
  /** 休市没有现价时的昨收(IBKR 的期权腿才有;组合行按腿比例合成,缺一条腿就不给)。只给界面显示,引擎不拿它做任何判断 */
  close_price?: number;
  /** 现价是另外向行情接口要来的时候标 "quote"(portfolio 推送里没有价) */
  price_source?: string;

  // ---- 只有 withCombos 合成的组合行才有 ----
  /** vertical / butterfly / iron_butterfly / iron_condor;认不出形状的是 custom(只认、不猜) */
  kind?: string;
  /** 借方(付权利金建的)还是贷方 */
  net_side?: "debit" | "credit";
  /** 各腿那一行的 key */
  legs?: string[];
  /** 各腿带符号的持仓比例(蝴蝶 +1 / −2 / +1),和 legs 一一对应 */
  ratios?: number[];

  // ---- positions.list 补上的 ----
  /** 这份持仓有没有在追踪 */
  tracked?: boolean;
  /** 盈亏是券商报的、还是券商没报由本地按同一套口径算的;没有现价算不了是 null */
  pnl_source?: "broker" | "computed" | null;
  unrealized_pct?: number | null;
  /** 休市没有现价时,按昨收另算的一份盈亏——只给界面看,不冒充此刻的盈亏 */
  close_pnl?: number | null;
  close_pct?: number | null;
}
