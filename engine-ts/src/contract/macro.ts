/** macro.board:顶栏宏观行情带(公开数据 + TWS 流式,只读展示,不参与定价)。类型文件,不 import 任何东西。
 *
 * 口径见 docs/features/macro-board.md。一格一行,固定 7 格;每格可能来自两个来源之一,界面要让人分得清是哪个
 * ——**显示的数必须就是标的本身的价**,不拿"跟着走"的替身糊弄(差一个量级的替身比空着还糟)。
 */

/**
 * 取数阶段的一格:`source` 还没有——取数的人不知道自己是被哪条路调用的,那一项由 macroBoard 最后填。
 * 同 PositionRow / BacktestReport:一路攒起来的东西,每个阶段的类型都说当时的真话。
 */
export interface MacroRowData {
  /** 公开源那一路的符号,同时也是这一格的身份:^GSPC / ^NDX / ^VIX / ^TNX / GC=F / BZ=F / BTC-USD */
  key: string;
  /** 给人看的名字:标普500 / 纳指100 / VIX / 美债10Y / 纽约金 / 布油 / 比特币 */
  label: string;
  /** 界面怎么格式化:price 价格 / pct 百分数 / plain 光秃秃一个数 */
  fmt: string;
  /** 取不到是 null(两个来源都没给) */
  last: number | null;
  change_pct: number | null;
  /**
   * 这一格**实际读的是哪个标的**:走 TWS 时是 SPX / NDX / VIX / TNX / COMEX GC / 布伦特 BZ / PAXOS,
   * 主源挂掉由 Cboe 兜回来时是 "Cboe",公开源那一路是 null。界面照它标小字,免得有人把 ETF 的价当成指数的价。
   */
  instrument?: string | null;
  /** 这个值是缓存里的旧值 */
  cached?: boolean;
  /** 旧值先给,新值正在后台取 */
  refreshing?: boolean;
  /** 这一轮没取到,给的是上一次的值 */
  stale?: boolean;
  /** 这一格为什么取不到(截到 120 字);备用源救回来了就没有 */
  error?: string;
}

/** 行情带上的一格:macroBoard 交出去的样子。 */
export interface MacroRow extends MacroRowData {
  /** tws 流式(界面标绿点)/ public 公开源 */
  source: string;
}

export interface MacroBoard {
  rows: MacroRow[];
  /** 生成时刻(**秒**,不是毫秒) */
  at: number;
  /** 有几格走的是 TWS 流式 */
  live_count: number;
}

export interface MacroBoardParams {
  /** 用户点了强制刷新:这一轮同步等新值,不吃缓存 */
  force?: boolean;
}
