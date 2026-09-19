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

/** 取链的那一层(services/marketData 的 wallFor)再补两样。 */
export interface OptionWall extends OptionWallCore {
  /** 这个标的可选的到期日 */
  expiries: string[];
  /** 现价是怎么来的:quote = 标的的报价;parity = 拿不到报价,用期权的买卖权平价反推的(富途),界面要标出来 */
  spot_source: "quote" | "parity";
}
