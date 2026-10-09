/** 期权墙(对应 Python optionwall.py):持仓量墙 / 成交量墙 / GEX / 最大痛点。
 *
 * 三个口径含义完全不同,界面上分开摆;GEX 的符号约定是假设不是事实。
 * 纯计算,离线可对拍。
 *
 * gamma:现价处的数(净 GEX、每档的净 GEX)优先用券商的模型 gamma,没给才用 BS;标的挪到别处券商不给,只能靠 BS 重算,
 * 翻转位那条曲线因此是 BS 的。两套在现价处的正负对不上时,翻转位「在现价哪一侧」就和净 GEX 的正负矛盾——那时不给翻转位
 * (gexSignConflict),而不是给一个自相矛盾的数。两样都没有的行不猜。
 * 「知道」的标准是**称出了分量**(总量 > 0),不是「有行带着 gamma」:有 gamma 但未平仓量全是 0 或没等到,
 * 净额算出来也是 0,那是什么都没称,不是「看涨看跌正好抵消」。
 */
import type { GexRegime, MaxPain, OptionWallCore, OptionWallStrike, WallSide } from "./contract/options.js";
import { expiryEpochMs } from "./ivPricing.js";
import { ET, wallToEpoch } from "./tz.js";
import { fmtF, fmtSF, pyFloat, pyRound } from "./py.js";

export const MULTIPLIER = 100.0;
export const MIN_STRIKES = 5;
const MIN_T = 1.0 / (365.0 * 24.0); // 1 小时下限,否则 0DTE 的 gamma 会炸

export class OptionWallError extends Error {}

export interface OptionRow {
  strike: number;
  right: string; // 'C' | 'P'
  /** 未平仓量;没等到(oiMissing)时是 0,不进任何一样的分量 */
  oi: number;
  /** 券商在等待时间里没推未平仓量那一笔:是不知道,不是 0 张 */
  oiMissing: boolean;
  volume: number;
  gamma: number | null;
  iv: number | null;
}

export function toRows(raw: Array<Record<string, unknown>>): OptionRow[] {
  const out: OptionRow[] = [];
  for (const item of raw) {
    const right = String(item["right"] ?? "").toUpperCase().slice(0, 1);
    if (right !== "C" && right !== "P") continue;
    const strike = Number(item["strike"]);
    if (!Number.isFinite(strike) || item["strike"] === undefined || item["strike"] === null) continue;
    if (strike <= 0) continue;
    const oiRaw = item["oi"];
    const oiMissing = oiRaw === null || oiRaw === undefined || Number.isNaN(Number(oiRaw));
    out.push({
      strike,
      right,
      oi: oiMissing ? 0.0 : Math.max(Number(oiRaw) || 0.0, 0.0),
      oiMissing,
      volume: Math.max(Number(item["volume"] ?? 0.0) || 0.0, 0.0),
      gamma: optFloat(item["gamma"]),
      iv: optFloat(item["iv"]),
    });
  }
  return out;
}

function optFloat(value: unknown): number | null {
  const v = Number(value);
  if (value === null || value === undefined || Number.isNaN(v)) return null;
  return v > 0 ? v : null; // 排除 NaN 与非正值
}

// ---------------------------------------------------------------- Gamma
/** Black-Scholes gamma(r=0,无股息)。T 有下限。 */
export function bsGamma(spot: number, strike: number, t: number, sigma: number): number {
  t = Math.max(t, MIN_T);
  if (spot <= 0 || strike <= 0 || sigma <= 0) return 0.0;
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2.0 * Math.PI);
  return pdf / (spot * sigma * Math.sqrt(t));
}

/** 'YYYYMMDD' → 距到期的年数(一年 365 天)。到期时刻的规则只有一份,在 ivPricing.expiryEpochMs:
 * 一般是到期日美东 16:00;按开盘价结算的月度 SPX / NDX / RUT(交易类别和代码相同)在合约日期之后那个工作日的 09:30 到期。
 * 这几个指数没给交易类别时它认不出是哪一种,这里按 16:00(日到期的那一种)。 */
export function yearsToExpiry(
  expiry: string, nowEpochMs: number | null = null, symbol = "", tradingClass = "",
): number {
  if (!expiry || expiry.length !== 8 || !/^\d{8}$/.test(expiry)) return MIN_T;
  const year = Number(expiry.slice(0, 4));
  const month = Number(expiry.slice(4, 6));
  const day = Number(expiry.slice(6, 8));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return MIN_T;
  }
  const moment = nowEpochMs ?? Date.now();
  const closeMs = expiryEpochMs(symbol, expiry, tradingClass) ?? wallToEpoch(
    { year, month, day, hour: 16, minute: 0, second: 0 }, ET,
  );
  return Math.max((closeMs - moment) / 1000.0 / (365.0 * 24 * 3600.0), MIN_T);
}

// ---------------------------------------------------------------- 汇总
interface Cell {
  call_oi: number;
  put_oi: number;
  call_vol: number;
  put_vol: number;
}

function byStrike(rows: OptionRow[]): Map<number, Cell> {
  const grid = new Map<number, Cell>();
  for (const row of rows) {
    let cell = grid.get(row.strike);
    if (!cell) {
      cell = { call_oi: 0.0, put_oi: 0.0, call_vol: 0.0, put_vol: 0.0 };
      grid.set(row.strike, cell);
    }
    if (row.right === "C") {
      cell.call_oi += row.oi;
      cell.call_vol += row.volume;
    } else {
      cell.put_oi += row.oi;
      cell.put_vol += row.volume;
    }
  }
  return grid;
}

/** 某一侧最大的那一档。「上方」「下方」都不含正好在现价上的那一档(它既不在头顶也不在脚下,算进去就是同一档两边各数一次);
 * 一样大的取离现价近的:价格先碰到的是它。不设「比旁边大多少才算墙」的门槛。 */
function wall(
  grid: Map<number, Cell>, field: keyof Cell, spot: number, side: "above" | "below",
): WallSide | null {
  let best: [number, number] | null = null;
  for (const [strike, cell] of grid) {
    const size = cell[field];
    if (!(side === "above" ? strike > spot : strike < spot) || !(size > 0)) continue;
    if (best === null || size > best[1] || (size === best[1] && Math.abs(strike - spot) < Math.abs(best[0] - spot))) {
      best = [strike, size];
    }
  }
  if (best === null) return null;
  const [strike, size] = best;
  return {
    strike,
    size: pyRound(size, 1),
    distance_pct: spot ? pyRound((strike / spot - 1.0) * 100.0, 2) : null,
  };
}

/** 所有未平仓期权内在价值之和最小的行权价。统计量,不是预言。 */
export function maxPain(
  grid: Map<number, Cell>, multiplier = MULTIPLIER,
): MaxPain | null {
  const strikes = [...grid.keys()].sort((a, b) => a - b);
  if (strikes.length < MIN_STRIKES) return null;
  let best: [number, number] | null = null;
  for (const target of strikes) {
    let pain = 0.0;
    for (const [strike, cell] of grid) {
      pain += cell.call_oi * Math.max(target - strike, 0.0);
      pain += cell.put_oi * Math.max(strike - target, 0.0);
    }
    pain *= multiplier;
    if (best === null || pain < best[1]) best = [target, pain];
  }
  return { strike: best![0], pain: pyRound(best![1], 0) };
}

export interface Gex {
  /** 看涨记正、看跌记负(假设做市商持有看涨、卖出看跌) */
  net: number;
  /** 不分正负的总量 */
  gross: number;
  /** 算进去了几行;0 = 这些行一行都算不了 */
  rows: number;
}

function sumGex(
  rows: readonly OptionRow[], at: number, multiplier: number, gammaOf: (row: OptionRow) => number | null,
): Gex {
  let net = 0.0;
  let gross = 0.0;
  let used = 0;
  for (const row of rows) {
    const gamma = gammaOf(row);
    if (gamma === null) continue; // 既没 IV 也没可用的模型 gamma,跳过,不猜
    const size = gamma * row.oi * multiplier * at * at * 0.01;
    net += row.right === "C" ? size : -size;
    gross += size;
    used += 1;
  }
  return { net, gross, rows: used };
}

/** 现价处的 gamma 敞口(美元 / 每 1% 波动):券商给了模型 gamma 的行用它,没给的用 BS(这一行自己的 IV)。 */
export function gexAt(rows: readonly OptionRow[], spot: number, t: number, multiplier = MULTIPLIER): Gex {
  return sumGex(rows, spot, multiplier, (row) =>
    row.gamma !== null ? row.gamma : row.iv ? bsGamma(spot, row.strike, t, row.iv) : null);
}

/** 标的挪到 at 时的 gamma 敞口:券商只给现价处的 gamma,别处只能用 BS 重算,所以只算得了有 IV 的行。 */
export function bsGexAt(rows: readonly OptionRow[], at: number, t: number, multiplier = MULTIPLIER): Gex {
  return sumGex(rows, at, multiplier, (row) => (row.iv ? bsGamma(at, row.strike, t, row.iv) : null));
}

/** 扫描点数的保险丝:档距异常小的链不至于扫几十万个点 */
const FLIP_SCAN_MAX = 2000;

/**
 * 现价处两套 gamma 的正负对不对得上:净 GEX(券商的模型 gamma 优先)与 BS 重算的那条曲线。
 * 对不上 = BS 曲线上的翻转位说的「现价在翻转位的哪一侧」和净 GEX 的正负矛盾。
 */
export function gexSignConflict(rows: readonly OptionRow[], spot: number, t: number, multiplier = MULTIPLIER): boolean {
  const here = gexAt(rows, spot, t, multiplier).net;
  const model = bsGexAt(rows, spot, t, multiplier).net;
  return here !== 0 && model !== 0 && (here > 0) !== (model > 0);
}

/**
 * 净 GEX 变号的价位里离现价最近的那个(哪个方向变号都算:越过它,正负 gamma 就换边)。
 *
 * 曲线是各行按自己的 IV 用 BS 重算出来的(标的挪到别处的 gamma 券商不给)。现价处它的正负和净 GEX 对不上时不给
 * (见 gexSignConflict);没有做「把曲线校到券商的数上」这一步:逐行按比例校在远离平值的行上是两个极小数相除,
 * 会把曲线撑出假的变号;整体平移又等于假设差异处处一样。
 *
 * 只在取到的最低与最高行权价之间找,不外推:按链上最小的档距扫一遍(现价自己也是一个点),变号的那一段再二分。
 */
export function gammaFlip(
  rows: readonly OptionRow[], strikes: readonly number[], spot: number, t: number, multiplier = MULTIPLIER,
): number | null {
  return gexSignConflict(rows, spot, t, multiplier) ? null : curveFlip(rows, strikes, spot, t, multiplier);
}

/** BS 那条曲线上离现价最近的变号处(不管它和净 GEX 对不对得上;对不上时给不给由 gammaFlip / analyze 定) */
function curveFlip(
  rows: readonly OptionRow[], strikes: readonly number[], spot: number, t: number, multiplier: number,
): number | null {
  const usable = rows.filter((r) => r.iv);
  const ks = [...new Set(strikes)].filter((k) => k > 0).sort((a, b) => a - b);
  const lo = ks[0];
  const hi = ks[ks.length - 1];
  if (usable.length < MIN_STRIKES || lo === undefined || hi === undefined || !(hi > lo)) return null;

  const netAt = (x: number): number => bsGexAt(usable, x, t, multiplier).net;
  let step = hi - lo;
  for (let i = 0; i + 1 < ks.length; i++) step = Math.min(step, (ks[i + 1] ?? hi) - (ks[i] ?? lo));
  const n = Math.min(Math.ceil((hi - lo) / step), FLIP_SCAN_MAX);
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) xs.push(lo + ((hi - lo) * i) / n);
  if (spot > lo && spot < hi) xs.push(spot);
  xs.sort((a, b) => a - b);

  let best: number | null = null;
  let prev: [number, number] | null = null; // 上一个净 GEX 不是 0 的点
  for (const x of xs) {
    const g = netAt(x);
    if (g === 0) continue;
    if (prev !== null && (g > 0) !== (prev[1] > 0)) {
      let [a, ga] = prev;
      let b = x;
      while (b - a > 1e-6) {
        const mid = (a + b) / 2;
        const gm = netAt(mid);
        if (gm === 0) {
          a = mid;
          b = mid;
        } else if ((gm > 0) === (ga > 0)) {
          a = mid;
          ga = gm;
        } else {
          b = mid;
        }
      }
      const root = (a + b) / 2;
      if (best === null || Math.abs(root - spot) < Math.abs(best - spot)) best = root;
    }
    prev = [x, g];
  }
  return best === null ? null : pyRound(best, 2);
}

// ---------------------------------------------------------------- 总装
export function analyze(
  raw: Array<Record<string, unknown>>,
  spot: number,
  expiry = "",
  symbol = "",
  multiplier = MULTIPLIER,
  nowEpochMs: number | null = null,
  tradingClass = "",
): OptionWallCore {
  const rows = toRows(raw);
  if (spot <= 0) throw new OptionWallError("缺少标的现价,无法判断墙在现价上方还是下方。");
  const grid = byStrike(rows);
  if (grid.size < MIN_STRIKES) {
    throw new OptionWallError(
      `只有 ${grid.size} 个行权价的数据(至少需要 ${MIN_STRIKES} 个),画不出分布。` +
      "可能是行权价范围取得太窄,或该到期日的链没有报价。",
    );
  }

  const t = yearsToExpiry(expiry, nowEpochMs, symbol, tradingClass);
  const strikes = [...grid.keys()].sort((a, b) => a - b);

  const perStrike: OptionWallStrike[] = strikes.map((strike) => {
    const cell = grid.get(strike)!;
    const atStrike = rows.filter((r) => r.strike === strike);
    return {
      strike,
      call_oi: pyRound(cell.call_oi, 1),
      put_oi: pyRound(cell.put_oi, 1),
      call_vol: pyRound(cell.call_vol, 1),
      put_vol: pyRound(cell.put_vol, 1),
      net_gex: pyRound(gexAt(atStrike, spot, t, multiplier).net, 0),
    };
  });

  let totalCallOi = 0.0;
  let totalPutOi = 0.0;
  let totalCallVol = 0.0;
  let totalPutVol = 0.0;
  for (const c of grid.values()) {
    totalCallOi += c.call_oi;
    totalPutOi += c.put_oi;
    totalCallVol += c.call_vol;
    totalPutVol += c.put_vol;
  }
  const gex = gexAt(rows, spot, t, multiplier);
  // 称出了分量才算知道:一行都算不了(没有 IV 也没有模型 gamma)、或者有 gamma 却没有未平仓量可称,都是不知道——不是 0,也不是抵消
  const known = gex.gross > 0;
  const regime: GexRegime = !known ? "unknown" : gex.net > 0 ? "positive" : gex.net < 0 ? "negative" : "neutral";
  // 曲线上有变号处、却和净 GEX 的正负对不上:不给,并说明(本来就没有变号处的不算「对不上所以不给」)
  const flip = curveFlip(rows, strikes, spot, t, multiplier);
  const conflict = flip !== null && gexSignConflict(rows, spot, t, multiplier);

  const result: Omit<OptionWallCore, "warnings" | "readout"> = {
    symbol,
    expiry,
    spot: pyRound(spot, 4),
    multiplier,
    strike_count: grid.size,
    days_to_expiry: pyRound(t * 365.0, 3),
    strikes: perStrike,
    call_wall: wall(grid, "call_oi", spot, "above"),
    put_wall: wall(grid, "put_oi", spot, "below"),
    call_vol_wall: wall(grid, "call_vol", spot, "above"),
    put_vol_wall: wall(grid, "put_vol", spot, "below"),
    max_pain: maxPain(grid, multiplier),
    net_gex: known ? pyRound(gex.net, 0) : null,
    gross_gex: known ? pyRound(gex.gross, 0) : null,
    net_gex_ratio: known && gex.gross > 0 ? pyRound(gex.net / gex.gross, 4) : null,
    gamma_flip: conflict ? null : flip,
    regime,
    total_call_oi: pyRound(totalCallOi, 1),
    total_put_oi: pyRound(totalPutOi, 1),
    pc_ratio_oi: totalCallOi ? pyRound(totalPutOi / totalCallOi, 3) : null,
    pc_ratio_volume: totalCallVol ? pyRound(totalPutVol / totalCallVol, 3) : null,
    has_greeks: rows.some((r) => r.iv),
    oi_missing: rows.filter((r) => r.oiMissing).length,
  };
  const warnings = makeWarnings(result, gex.rows > 0);
  if (conflict) {
    warnings.push(
      "gamma 翻转位不给:标的挪到别处的 gamma 只能用 BS 重算,而它在现价处的正负和净 GEX(券商的模型 gamma)对不上——" +
      "多半是净额本来就接近 0,翻转位就在现价附近。",
    );
  }
  return { ...result, warnings, readout: makeReadout(result) };
}

type WallFacts = Omit<OptionWallCore, "warnings" | "readout">;

function makeWarnings(result: WallFacts, hasGamma: boolean): string[] {
  const out: string[] = [
    "OI 是隔夜存量:OCC 每天开盘前公布一次,盘中看到的不含当天的流。",
    "GEX 的符号建立在「做市商多头 call、空头 put」这个假设上——真实持仓没人看得到," +
    "换个假设结论可能反过来。它适合判断波动会被压住还是放大,不适合判断方向。",
  ];
  if (result.days_to_expiry <= 1.0) {
    out.push(
      "当日/次日到期:0DTE 合约绝大多数当天开当天平,**OI 墙基本没有参考价值**," +
      "请以成交量墙为准。",
    );
  }
  if (result.regime === "unknown") {
    out.push(hasGamma
      ? "有 gamma,但没有未平仓量可称(全是 0 或没等到):净 GEX、正负 gamma、gamma 翻转位都算不出——是不知道,不是看涨看跌正好抵消。"
      : "没拿到隐含波动率,也没有券商的模型 gamma:净 GEX、正负 gamma、gamma 翻转位都算不出——是不知道,不是 0。");
  } else if (!result.has_greeks) {
    out.push("没拿到隐含波动率:gamma 用的是券商给的模型值,gamma 翻转位算不出(标的挪到别处的 gamma 要靠它重算)。");
  }
  if (result.max_pain) {
    out.push("最大痛点只是个统计量;「到期会被拉到那儿」这个因果没有可靠证据。");
  }
  if (result.oi_missing > 0) {
    out.push(
      `有 ${result.oi_missing} 行没等到未平仓量(券商在等待的几秒里没推那一笔):墙、净 GEX、最大痛点只算了有数的那些,不是把它们当成 0 张。`,
    );
  }
  const totalOi = result.total_call_oi + result.total_put_oi;
  if (totalOi <= 0) {
    out.push("整条链的持仓量都是 0——多半是没有行情权限,或这个到期日还没开始交易。");
  }
  return out;
}

function makeReadout(result: WallFacts): string[] {
  const spot = result.spot;
  const zeroDay = result.days_to_expiry <= 1.0;
  const lines = [
    `${result.symbol || "标的"} ${result.expiry || "(未指定到期)"}:现价 ${pyFloat(spot)},` +
    `链上 ${result.strike_count} 个行权价,距到期 ${fmtF(result.days_to_expiry, 2)} 天。`,
  ];

  const describe = (w: WallSide | null, label: string): string | null => {
    if (!w) return null;
    return (
      `${label} ${pyFloat(w.strike)}(${pyFloat(w.size)} 张,` +
      `距现价 ${fmtSF(w.distance_pct ?? 0, 2)}%)`
    );
  };

  const oiParts = [
    describe(result.call_wall, "上方 Call 墙"),
    describe(result.put_wall, "下方 Put 墙"),
  ].filter((p): p is string => p !== null);
  if (oiParts.length) {
    lines.push(`持仓量墙:${oiParts.join(";")}。${zeroDay ? "(0DTE 下参考价值有限)" : ""}`);
  }

  const volParts = [
    describe(result.call_vol_wall, "上方成交墙"),
    describe(result.put_vol_wall, "下方成交墙"),
  ].filter((p): p is string => p !== null);
  if (volParts.length) {
    lines.push(`成交量墙(今日真实流向):${volParts.join(";")}。`);
  }

  const gex = result.net_gex;
  if (result.regime === "unknown" || gex === null) {
    lines.push("净 GEX:算不出(缺隐含波动率与模型 gamma,或者没有未平仓量可称);现在是正 gamma 还是负 gamma 不知道。");
  } else if (result.regime === "neutral") {
    lines.push("净 GEX 0:看涨与看跌的 gamma 正好抵消。");
  } else {
    const positive = result.regime === "positive";
    const share = result.net_gex_ratio === null ? "" : `,净额占总 gamma 的 ${fmtF(Math.abs(result.net_gex_ratio) * 100.0, 1)}%`;
    lines.push(
      `净 GEX ${money(gex)}(${positive ? "正" : "负"}${share}):按「做市商多头 call、空头 put」的假设,` +
      `做市商${positive ? "多头" : "空头"} gamma,倾向于${positive ? "涨了卖、跌了买,压住波动" : "涨了追、跌了砍,放大波动"}。`,
    );
  }
  if (result.gamma_flip !== null) {
    const side = result.gamma_flip > spot ? "上方" : "下方";
    lines.push(
      `Gamma 翻转位 ${pyFloat(result.gamma_flip)}(现价${side}):` +
      "越过它,压波动与放大波动的性质会掉个个儿。",
    );
  }
  if (result.max_pain) {
    const pain = result.max_pain.strike;
    lines.push(
      `最大痛点 ${pyFloat(pain)}(距现价 ${fmtSF(spot ? (pain / spot - 1.0) * 100.0 : 0.0, 2)}%)` +
      "——参考位,不是预言。",
    );
  }
  if (result.pc_ratio_oi !== null) {
    lines.push(
      `Put/Call 比:持仓 ${fmtF(result.pc_ratio_oi, 2)}` +
      `${result.pc_ratio_volume !== null ? `,成交 ${fmtF(result.pc_ratio_volume, 2)}` : ""}。`,
    );
  }
  return lines;
}

function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}${fmtF(v / 1e9, 2)} B`;
  if (v >= 1e6) return `${sign}${fmtF(v / 1e6, 1)} M`;
  if (v >= 1e3) return `${sign}${fmtF(v / 1e3, 0)} K`;
  return `${sign}${fmtF(v, 0)}`;
}

/** 把墙折成一组价位,好和 PA 算出的支撑阻力对照。 */
export function levelsForPa(result: Record<string, any>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const zeroDay = (result["days_to_expiry"] ?? 99) <= 1.0;

  const add = (w: Record<string, unknown> | null | undefined, kind: string, note: string): void => {
    if (w) {
      out.push({
        price: w["strike"], kind, note, distance_pct: w["distance_pct"],
      });
    }
  };

  // 0DTE 下成交量墙才有意义,排在前面
  if (zeroDay) {
    add(result["call_vol_wall"], "resistance", "今日成交最密的上方行权价");
    add(result["put_vol_wall"], "support", "今日成交最密的下方行权价");
  }
  add(result["call_wall"], "resistance", "持仓量最大的上方行权价");
  add(result["put_wall"], "support", "持仓量最大的下方行权价");
  if (result["max_pain"]) {
    out.push({
      price: result["max_pain"]["strike"], kind: "pivot",
      note: "最大痛点(统计量,非预言)", distance_pct: null,
    });
  }
  if (result["gamma_flip"] !== null && result["gamma_flip"] !== undefined) {
    out.push({ price: result["gamma_flip"], kind: "pivot", note: "Gamma 翻转位", distance_pct: null });
  }
  return out;
}
