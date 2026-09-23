/**
 * 固定风险比例的仓位算法(绩效页的仓位计算器)。纯函数,不碰引擎:几个乘除法,放界面里即时响应。
 *
 * 口径是冠军们共同的那一条:**先定这一笔最多亏账户的百分之几,再倒推做几份**——不是先定做几份。
 * 每份最大亏损:买蝴蝶 / 借方价差 = 权利金 × 乘数;股票 = (进场价 − 止损价)× 1 股。
 */

export interface SizingInput {
  /** 账户权益(美元) */
  equity: number | null;
  /** 单笔风险占权益的百分比 */
  riskPct: number | null;
  /** 每份(一张 / 一股)最大亏损(美元) */
  unitRisk: number | null;
  /** 历史最大连亏笔数:用来算"照这个风险连亏那么多笔会回撤多少" */
  losingStreak?: number | null;
}

export interface SizingResult {
  /** 这一笔的风险预算 = 权益 × 比例 */
  budget: number;
  /** 做几份(向下取整;预算连一份都不够就是 0) */
  units: number;
  /** 按份数取整后实际承担的风险 */
  actualRisk: number;
  actualPct: number;
  /** 每笔都按同一比例、连亏 losingStreak 笔后的累计回撤(复利口径);没给连亏数是 null */
  streakDrawdownPct: number | null;
}

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function sizePosition(input: SizingInput): SizingResult | null {
  const { equity, riskPct, unitRisk, losingStreak } = input;
  if (!ok(equity) || !ok(riskPct) || !ok(unitRisk) || riskPct >= 100) return null;
  const budget = (equity * riskPct) / 100;
  const units = Math.floor(budget / unitRisk + 1e-9);
  const actualRisk = units * unitRisk;
  const streak = ok(losingStreak) ? Math.floor(losingStreak) : null;
  return {
    budget,
    units,
    actualRisk,
    actualPct: (actualRisk / equity) * 100,
    streakDrawdownPct: streak === null ? null : (1 - (1 - riskPct / 100) ** streak) * 100,
  };
}
