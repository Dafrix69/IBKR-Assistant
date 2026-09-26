/** 利润回撤的三道闸(纯函数):此刻让多少、开始追了没有、回吐够不够。
 *
 * 从 tracker.ts 拆出来:它们只认 Targets 和几个数,不认识持仓、券商、引擎。preset "fly" 的
 * 档位、激活线、最少回吐全部来自 flyexit(唯一事实源),这里只按 Targets 读出来判断——
 * 实盘与复盘的回放必须是同一套闸,见 docs/features/tracker.md「利润回撤」。
 */
import type { Targets } from "./contract/tracker.js";
import { finiteOrNull, pyRound } from "./py.js";

function minutesOfClock(hhmm: unknown): number | null {
  const parts = String(hhmm ?? "").split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]), m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.trunc(h) * 60 + Math.trunc(m);
}

/**
 * 此刻该用的利润回撤阈值(百分点)。没配分档就是那个固定值。
 *
 * 分档按浮盈倍数 `profitPeak / |basis|` 选:取所有 above ≤ 当前倍数 里最高的一档。
 * 用绝对值是为了让贷方组合(记为空头、basis 为负)也说得通——那时倍数的含义是
 * "赚到的 / 当初收的权利金"。
 */
export function drawdownThreshold(
  targets: Targets, profitPeak: number | null, basis: number | null, minute: number | null = null,
): number | null {
  let pct = finiteOrNull(targets.profit_drawdown_pct);
  const tiers = targets.profit_drawdown_tiers ?? [];
  const peak = finiteOrNull(profitPeak);
  const base = finiteOrNull(basis);
  if (tiers.length && peak !== null && base) {
    const ratio = peak / Math.abs(base);
    let bestAbove: number | null = null;
    for (const tier of tiers) {
      const above = finiteOrNull(tier?.above);
      const tierPct = finiteOrNull(tier?.pct);
      if (above === null || tierPct === null || ratio < above) continue;
      if (bestAbove === null || above >= bestAbove) {
        bestAbove = above;
        pct = tierPct;
      }
    }
  }
  if (pct === null) return null;
  const late = targets.profit_drawdown_late;
  const after = late?.after ? minutesOfClock(late.after) : null;
  const factor = finiteOrNull(late?.factor);
  if (after !== null && factor !== null && minute !== null && minute >= after) pct *= factor;
  return pyRound(pct, 6);
}

/**
 * 激活线:峰值浮盈 / |成本| 到过 profit_drawdown_arm 才开始按回撤平。
 *
 * 峰值价格持久化、只朝有利方向走,所以"此刻的峰值倍数 ≥ 激活线"就是"到过"。
 * 蝶式 0.3 = 蝶价到过 1.3×D:浮盈只有几毛的时候,组合中间价随便晃一下就是 40% 的回撤。
 * 没设激活线、或成本为 0(倍数算不出来)时视为已激活——就是加这道闸之前的行为。
 */
export function drawdownArmed(targets: Targets, profitPeak: number | null, basis: number | null): boolean {
  const arm = finiteOrNull(targets.profit_drawdown_arm);
  const base = finiteOrNull(basis);
  if (arm === null || !base) return true;
  const peak = finiteOrNull(profitPeak);
  return peak !== null && peak / Math.abs(base) >= arm;
}

/**
 * 最少回吐:现价离峰值价够不够 profit_drawdown_floor(每份的价格点)。
 *
 * 比价格不比钱:钱要乘数量与乘数(又一处"乘数只乘一次"的坑),价格点和蝶价、回放的
 * trail_floor 是同一个单位。留 1e-9 的余量:4.70 − 4.50 在二进制里可能是 0.1999…,
 * 正好卡在线上时算够。
 */
export function drawdownFloorMet(targets: Targets, peakPrice: number | null, price: number | null): boolean {
  const floor = finiteOrNull(targets.profit_drawdown_floor);
  if (floor === null) return true;
  const pk = finiteOrNull(peakPrice), p = finiteOrNull(price);
  return pk !== null && p !== null && Math.abs(pk - p) >= floor - 1e-9;
}
