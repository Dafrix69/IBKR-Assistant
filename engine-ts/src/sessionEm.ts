/** 从日内剧本的底账里取「这一天常规时段一个标准差是多少点」(纯函数)。
 *
 * 止盈策略的回放(flyexit)与持仓追踪的 clock 档都要一个 EM:常规时段全天的 1σ(点)。它以前是写死的 36——
 * 那是某一天的数,VIX 从 12 到 20,这个数能差一倍,阶段 C 的起点跟着差一个多小时。日内剧本每天都在记期权市场给的定价
 * (平值跨式 × √(π/2),见 playbook.ts),这里把它折回全天:
 *
 *   全天 σ = 那一刻的剩余预期波动 ÷ √(那一刻还剩全天方差的几成)
 *
 * 分母用的是校准出来的日内方差分布(flyIvModel.ts),和 flyexit.sigmaRemaining 反过来是同一个式子,所以拿它算回去
 * 正好还原记下来的那个数。没有任何经验系数。
 *
 * 只用**当天取的、当天到期**的区间:盘初(09:35)那一条优先,没有就用当天最早的一条当前区间。昨日口径不用——
 * 它是前一天收盘后取的,里面含着隔夜那一段,不是常规时段的波动。提前收盘日不给:那张分布表是照 16:00 收盘估的。
 */
import type { PlaybookBand } from "./contract/options.js";
import { remainingShare } from "./flyCalibration.js";
import { FLY_IV_MODEL } from "./flyIvModel.js";
import { pyRound } from "./py.js";
import { ET, dateStrAt, wallParts } from "./tz.js";

export interface SessionEm {
  /** 常规时段全天一个标准差(点) */
  em: number;
  /** 取自哪一条:open = 盘初定价,frame = 当天最早的一条当前区间 */
  kind: "open" | "frame";
  /** 那一条是几点取的(美东 HH:MM) */
  at: string;
}

/** 一条区间折回全天的 1σ。不是当天到期、取价时刻不在常规时段里、已经没剩什么方差:null。 */
export function sessionSigmaOf(band: PlaybookBand, weights: readonly number[] = FLY_IV_MODEL.variance_weights): number | null {
  if (!(band.em > 0) || dateStrAt(band.at, ET).replace(/-/g, "") !== band.expiry) return null;
  const wall = wallParts(band.at, ET);
  const share = remainingShare(weights, wall.hour * 60 + wall.minute + wall.second / 60);
  return share > 0 ? pyRound(band.em / Math.sqrt(share), 2) : null;
}

/** 从一天的底账里挑。`earlyClose` 由调用方按日历给。 */
export function sessionEmOf(
  records: ReadonlyArray<{ kind: string; band?: PlaybookBand }>, earlyClose = false,
): SessionEm | null {
  if (earlyClose) return null;
  const bands = (kind: "open" | "frame"): PlaybookBand[] =>
    records.flatMap((r) => (r.kind === kind && r.band !== undefined ? [r.band] : [])).sort((a, b) => a.at - b.at);
  for (const kind of ["open", "frame"] as const) {
    for (const band of bands(kind)) {
      const em = sessionSigmaOf(band);
      if (em === null) continue;
      const wall = wallParts(band.at, ET);
      return { em, kind, at: `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}` };
    }
  }
  return null;
}
