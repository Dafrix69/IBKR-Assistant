/** 标的止损价(纯函数):标的跌到 / 涨到某个价位就平,记作止损。
 *
 * 和标的目标价(tracker.spotTarget)是一对,但不走模型:目标价要把"标的到那儿"换算成一张挂着的限价单,
 * 所以要波动率;止损只问"到了没有",到了就按各腿此刻的买卖价追着平(和别的止损同一条路),一个 σ 都不用。
 * 这里没有任何经验参数——两条线都是人填的。只认 Targets 和几个数,不认识持仓、券商、引擎。
 * 口径见 docs/features/tracker.md「标的止损价」。
 */
import type { SpotStop, Targets } from "./contract/tracker.js";
import { finiteOrNull, fmtF, pyG } from "./py.js";

/** 设了标的止损价没有(两条线设了任何一条)。 */
export function hasSpotStop(targets: Targets): boolean {
  return finiteOrNull(targets.spot_stop_below) !== null || finiteOrNull(targets.spot_stop_above) !== null;
}

/**
 * 这一轮的判定;没设回 null。
 *
 * 触线即算(≤ / ≥),和固定止损同一口径。标的现价拿不到就不判并说明原因——调用方负责把
 * "夜盘推算失败退回的昨收"当成拿不到(那个价不会动,拿它判等于这条线永远不触发或当场触发)。
 */
export function spotStop(
  targets: Targets, symbol: string, spot: number | null, spotNote = "",
): SpotStop | null {
  if (!hasSpotStop(targets)) return null;
  const below = finiteOrNull(targets.spot_stop_below);
  const above = finiteOrNull(targets.spot_stop_above);
  const s = finiteOrNull(spot);
  const out: SpotStop = { below, above, spot: s !== null && s > 0 ? s : null, spot_note: spotNote, hit: null, reason: "" };
  if (out.spot === null) {
    out.reason = `拿不到 ${symbol} 的现价,标的止损这一轮不判断`;
    return out;
  }
  if (below !== null && out.spot <= below) out.hit = "below";
  else if (above !== null && out.spot >= above) out.hit = "above";
  if (out.hit !== null) {
    const line = out.hit === "below" ? below : above;
    out.reason =
      `标的止损触发:${symbol} 现价 ${fmtF(out.spot, 2)} ${out.hit === "below" ? "跌破" : "涨破"} ${pyG(Number(line))}`;
  }
  return out;
}

/**
 * 设置时的校验:说得通回 null,说不通回一句人话(调用方当场拒)。
 *
 * 填在现价的另一侧会在建好的下一秒触发,所以必须拿得到标的现价才给设——
 * 核对不了方向的止损宁可不建,也不留一条可能当场把仓平掉的线。
 */
export function spotStopIssue(
  targets: Targets, secType: string, symbol: string, spot: number | null,
): string | null {
  const lines = [targets.spot_stop_below, targets.spot_stop_above];
  if (lines.every((v) => v === null || v === undefined)) return null;
  if (lines.some((v) => v !== null && v !== undefined && !(Number.isFinite(v) && v > 0))) {
    return "标的止损价必须是正数。";
  }
  if (secType === "STK") {
    return "标的止损价只给期权与组合用:正股的标的就是它自己,直接填止损价。";
  }
  const below = finiteOrNull(targets.spot_stop_below);
  const above = finiteOrNull(targets.spot_stop_above);
  if (below !== null && above !== null && below >= above) {
    return `标的止损价的两条线填反了:「跌到」(${pyG(below)})要低于「涨到」(${pyG(above)})。`;
  }
  const s = finiteOrNull(spot);
  if (s === null || !(s > 0)) {
    return `拿不到 ${symbol} 的现价,核对不了标的止损价在现价的哪一侧——等行情来了再设。`;
  }
  if (below !== null && below >= s) {
    return `「标的跌到」的止损价要低于 ${symbol} 现价(现价 ${fmtF(s, 2)},你填了 ${pyG(below)})——填在上方会立刻触发。`;
  }
  if (above !== null && above <= s) {
    return `「标的涨到」的止损价要高于 ${symbol} 现价(现价 ${fmtF(s, 2)},你填了 ${pyG(above)})——填在下方会立刻触发。`;
  }
  return null;
}
