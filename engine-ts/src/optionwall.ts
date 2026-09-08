/** 期权墙(对应 Python optionwall.py):持仓量墙 / 成交量墙 / GEX / 最大痛点。
 *
 * 三个口径含义完全不同,界面上分开摆;GEX 的符号约定是假设不是事实。
 * 纯计算,离线可对拍。
 */
import { ET, wallToEpoch } from "./tz.js";
import { fmtF, fmtSF, pyFloat, pyRound } from "./py.js";

export const MULTIPLIER = 100.0;
export const MIN_STRIKES = 5;
const MIN_T = 1.0 / (365.0 * 24.0); // 1 小时下限,否则 0DTE 的 gamma 会炸

export class OptionWallError extends Error {}

export interface OptionRow {
  strike: number;
  right: string; // 'C' | 'P'
  oi: number;
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
    out.push({
      strike,
      right,
      oi: Math.max(Number(item["oi"] ?? 0.0) || 0.0, 0.0),
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

/** 'YYYYMMDD' → 距到期的年数。当日到期按当天收盘(美东 16:00)估。
 * nowEpochMs 为当前时刻;到期收盘按美东墙钟换算。 */
export function yearsToExpiry(expiry: string, nowEpochMs: number | null = null): number {
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
  const closeMs = wallToEpoch(
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

function wall(
  grid: Map<number, Cell>, field: keyof Cell, spot: number, side: "above" | "below",
): Record<string, unknown> | null {
  const candidates: Array<[number, number]> = [];
  for (const [strike, cell] of grid) {
    if ((side === "above" ? strike >= spot : strike <= spot) && cell[field] > 0) {
      candidates.push([strike, cell[field]]);
    }
  }
  if (!candidates.length) return null;
  let best = candidates[0]!;
  for (const kv of candidates) if (kv[1] > best[1]) best = kv;
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
): Record<string, unknown> | null {
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

/** 标的在 spot 时的净 gamma 敞口(美元 / 每 1% 波动)。 */
export function netGexAt(
  rows: OptionRow[], spot: number, t: number, multiplier = MULTIPLIER, atCurrentSpot = false,
): number {
  let total = 0.0;
  for (const row of rows) {
    let gamma: number;
    if (atCurrentSpot && row.gamma !== null) gamma = row.gamma;
    else if (row.iv) gamma = bsGamma(spot, row.strike, t, row.iv);
    else continue; // 既没 IV 也没可用的模型 gamma,跳过,不猜
    const sign = row.right === "C" ? 1.0 : -1.0;
    total += sign * gamma * row.oi * multiplier * spot * spot * 0.01;
  }
  return total;
}

/** 净 GEX 由负转正的价位。跨不过零就返回 null —— 不外推。 */
export function gammaFlip(
  rows: OptionRow[], strikes: number[], t: number, multiplier = MULTIPLIER,
): number | null {
  const usable = rows.filter((r) => r.iv);
  if (usable.length < MIN_STRIKES || strikes.length < 2) return null;

  const profile: Array<[number, number]> = [...strikes]
    .sort((a, b) => a - b)
    .filter((k) => k > 0)
    .map((k) => [k, netGexAt(usable, k, t, multiplier)]);
  for (let i = 0; i + 1 < profile.length; i++) {
    const [k0, g0] = profile[i]!;
    const [k1, g1] = profile[i + 1]!;
    if ((g0 <= 0 && 0 <= g1) || (g0 >= 0 && 0 >= g1)) {
      if (g1 === g0) return pyRound(k0, 2);
      // 两点之间线性插值
      return pyRound(k0 + ((k1 - k0) * (0.0 - g0)) / (g1 - g0), 2);
    }
  }
  return null;
}

// ---------------------------------------------------------------- 总装
export function analyze(
  raw: Array<Record<string, unknown>>,
  spot: number,
  expiry = "",
  symbol = "",
  multiplier = MULTIPLIER,
  nowEpochMs: number | null = null,
): Record<string, any> {
  const rows = toRows(raw);
  if (spot <= 0) throw new OptionWallError("缺少标的现价,无法判断墙在现价上方还是下方。");
  const grid = byStrike(rows);
  if (grid.size < MIN_STRIKES) {
    throw new OptionWallError(
      `只有 ${grid.size} 个行权价的数据(至少需要 ${MIN_STRIKES} 个),画不出分布。` +
      "可能是行权价范围取得太窄,或该到期日的链没有报价。",
    );
  }

  const t = yearsToExpiry(expiry, nowEpochMs);
  const strikes = [...grid.keys()].sort((a, b) => a - b);

  const perStrike: Array<Record<string, unknown>> = strikes.map((strike) => {
    const cell = grid.get(strike)!;
    const atStrike = rows.filter((r) => r.strike === strike);
    return {
      strike,
      call_oi: pyRound(cell.call_oi, 1),
      put_oi: pyRound(cell.put_oi, 1),
      call_vol: pyRound(cell.call_vol, 1),
      put_vol: pyRound(cell.put_vol, 1),
      net_gex: pyRound(netGexAt(atStrike, spot, t, multiplier, true), 0),
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
  const netGex = netGexAt(rows, spot, t, multiplier, true);

  const result: Record<string, any> = {
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
    net_gex: pyRound(netGex, 0),
    gamma_flip: gammaFlip(rows, strikes, t, multiplier),
    regime: netGex >= 0 ? "positive" : "negative",
    total_call_oi: pyRound(totalCallOi, 1),
    total_put_oi: pyRound(totalPutOi, 1),
    pc_ratio_oi: totalCallOi ? pyRound(totalPutOi / totalCallOi, 3) : null,
    pc_ratio_volume: totalCallVol ? pyRound(totalPutVol / totalCallVol, 3) : null,
    has_greeks: rows.some((r) => r.iv),
  };
  result["warnings"] = makeWarnings(result);
  result["readout"] = makeReadout(result);
  return result;
}

function makeWarnings(result: Record<string, any>): string[] {
  const out: string[] = [
    "OI 是隔夜存量:OCC 每天开盘前公布一次,盘中看到的不含当天的流。",
    "GEX 的符号建立在「做市商多头 call、空头 put」这个假设上——真实持仓没人看得到," +
    "换个假设结论可能反过来。它适合判断波动会被压住还是放大,不适合判断方向。",
  ];
  if (result["days_to_expiry"] <= 1.0) {
    out.push(
      "当日/次日到期:0DTE 合约绝大多数当天开当天平,**OI 墙基本没有参考价值**," +
      "请以成交量墙为准。",
    );
  }
  if (!result["has_greeks"]) {
    out.push("没拿到隐含波动率,gamma 只能用券商给的模型值或直接缺失,gamma 翻转位不可用。");
  }
  if (result["max_pain"]) {
    out.push("最大痛点只是个统计量;「到期会被拉到那儿」这个因果没有可靠证据。");
  }
  const totalOi = result["total_call_oi"] + result["total_put_oi"];
  if (totalOi <= 0) {
    out.push("整条链的持仓量都是 0——多半是没有行情权限,或这个到期日还没开始交易。");
  }
  return out;
}

function makeReadout(result: Record<string, any>): string[] {
  const spot = result["spot"] as number;
  const zeroDay = result["days_to_expiry"] <= 1.0;
  const lines = [
    `${result["symbol"] || "标的"} ${result["expiry"] || "(未指定到期)"}:现价 ${pyFloat(spot)},` +
    `链上 ${result["strike_count"]} 个行权价,距到期 ${fmtF(result["days_to_expiry"], 2)} 天。`,
  ];

  const describe = (w: Record<string, unknown> | null, label: string): string | null => {
    if (!w) return null;
    return (
      `${label} ${pyFloat(w["strike"] as number)}(${pyFloat(w["size"] as number)} 张,` +
      `距现价 ${fmtSF(w["distance_pct"] as number, 2)}%)`
    );
  };

  const oiParts = [
    describe(result["call_wall"], "上方 Call 墙"),
    describe(result["put_wall"], "下方 Put 墙"),
  ].filter((p): p is string => p !== null);
  if (oiParts.length) {
    lines.push(`持仓量墙:${oiParts.join(";")}。${zeroDay ? "(0DTE 下参考价值有限)" : ""}`);
  }

  const volParts = [
    describe(result["call_vol_wall"], "上方成交墙"),
    describe(result["put_vol_wall"], "下方成交墙"),
  ].filter((p): p is string => p !== null);
  if (volParts.length) {
    lines.push(`成交量墙(今日真实流向):${volParts.join(";")}。`);
  }

  const gex = result["net_gex"] as number;
  const positive = result["regime"] === "positive";
  lines.push(
    `净 GEX ${money(gex)}(${positive ? "正" : "负"}):做市商${positive ? "多头" : "空头"} gamma,` +
    `倾向于${positive ? "涨了卖、跌了买,压住波动" : "涨了追、跌了砍,放大波动"}。`,
  );
  if (result["gamma_flip"] !== null) {
    const side = result["gamma_flip"] > spot ? "上方" : "下方";
    lines.push(
      `Gamma 翻转位 ${pyFloat(result["gamma_flip"])}(现价${side}):` +
      "越过它,压波动与放大波动的性质会掉个个儿。",
    );
  }
  if (result["max_pain"]) {
    const pain = result["max_pain"]["strike"] as number;
    lines.push(
      `最大痛点 ${pyFloat(pain)}(距现价 ${fmtSF(spot ? (pain / spot - 1.0) * 100.0 : 0.0, 2)}%)` +
      "——参考位,不是预言。",
    );
  }
  if (result["pc_ratio_oi"] !== null) {
    lines.push(
      `Put/Call 比:持仓 ${fmtF(result["pc_ratio_oi"], 2)}` +
      `${result["pc_ratio_volume"] !== null ? `,成交 ${fmtF(result["pc_ratio_volume"], 2)}` : ""}。`,
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
