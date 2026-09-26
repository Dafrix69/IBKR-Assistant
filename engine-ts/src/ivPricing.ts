/** 标的目标价的 `ibkr` 档:用 IBKR 推的模型隐含波动率(MODEL_OPTION_IV)给每条腿定价(纯函数)。
 *
 * 2026-09-26 用户要求「用 IBKR 自带的模型 IV 重写追踪和定价」。IV 只在「标的目标价」这条路上用得到
 * (跟踪止损、利润回撤、追价平仓看的都是市场价,没有波动率可换)。做法:
 *
 * * **不另起一套定价。** 现有定价全是点数制的 Bachelier(σ = 剩余时间里的标准差,单位是点),蝶的那条
 *   被黄金基线钉着。IB 的 IV 是年化的对数正态波动率,换算成点数:σ_点 = 标的价 × IV × √剩余年数,
 *   按腿装进和 smile 档同形的 legSigmas,定价一行不改。平值附近两者一致,离平值越远差得越多——这是近似。
 * * **每条腿用它自己的 IV**,偏斜是 IB 的模型算进去的;标的移动时各行权价的 IV 不变(粘着行权价),
 *   每秒按最新推送重算。
 * * **缺任何一条腿的 IV 就整档不用**,退回按报价反解(smile / net / leg)。个股期权夜里、行情被别处占用
 *   (10197)时 IB 都不推模型值。
 *
 * 到期时刻是 0DTE 最敏感的输入:周度 SPXW / NDXP / RUTW 按 16:00 收盘结算,**月度 SPX / NDX / RUT 按开盘价
 * 结算、开盘就到期**。认不出是哪一种(这几个指数的持仓没带交易类别)就不给 `ibkr` 档,宁可退一档。
 */
import { ET, wallToEpoch } from "./tz.js";

/** 一条腿里定价要的那两样(tracker.StructureLeg 的子集;这里不引 tracker,分析层不往上引)。 */
interface PricedLeg { strike: number; right: string }

/** 月度合约按开盘价(AM)结算的指数:交易类别和代码相同的那种是月度。 */
const AM_SETTLED_ROOTS = new Set(["SPX", "NDX", "RUT"]);
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** 这张期权最后一刻还有时间价值的时刻(毫秒)。到期日格式 YYYYMMDD;认不出回 null。 */
export function expiryEpochMs(symbol: string, expiry: string, tradingClass: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(expiry ?? "").trim());
  if (m === null) return null;
  const sym = String(symbol ?? "").toUpperCase();
  const tc = String(tradingClass ?? "").toUpperCase();
  let hour = 16, minute = 0;
  if (AM_SETTLED_ROOTS.has(sym)) {
    if (!tc) return null;
    if (tc === sym) [hour, minute] = [9, 30];
  }
  return wallToEpoch(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour, minute, second: 0 }, ET,
  );
}

/**
 * IB 的 IV → 每条腿的点数 σ(和 smileSigmas 同形,按 legPriceKey 索引)。
 * 到期了(剩余 0)σ 就是 0,Bachelier 退化成内在价值——和 clock 档收盘后同一个约定。
 */
export function ibkrLegSigmas(
  legs: PricedLeg[], spot: number, legIvs: Record<string, number | null>,
  expiryMs: number | null, nowMs: number, keyOf: (leg: PricedLeg) => string,
): Record<string, number> | null {
  if (!legs.length || !(spot > 0) || expiryMs === null || !Number.isFinite(nowMs)) return null;
  const years = Math.max(0, expiryMs - nowMs) / YEAR_MS;
  const out: Record<string, number> = {};
  for (const leg of legs) {
    const key = keyOf(leg);
    const iv = Number(legIvs[key]);
    if (!Number.isFinite(iv) || iv <= 0) return null;
    out[key] = spot * iv * Math.sqrt(years);
  }
  return out;
}

/** 一份持仓的各腿行情:报价、IB 的模型 IV、到期时刻。两处用它——盯盘(engine.applySpotTarget)与试算
 * (tracker.target_preview)——必须拼出同一份,试算与实盘不许分叉。 */
export interface LegInputs {
  legPrices: Record<string, number | null>;
  legIvs: Record<string, number | null>;
  expiryMs: number | null;
}

type Row = Record<string, unknown>;

/** 持仓行来自券商适配层(松散记录)或契约里的 PositionRow,这里只按键读,两种都收。 */
export function legInputsOf(
  rawRow: object, positionRows: Record<string, object>, keyOf: (leg: { strike: number; right: string }) => string,
): LegInputs {
  const raw = rawRow as Row;
  const positions = positionRows as Record<string, Row>;
  const out: LegInputs = { legPrices: {}, legIvs: {}, expiryMs: null };
  const secType = String(raw["sec_type"] ?? "");
  // 组合行带着各腿的持仓 key;单腿期权自己就是那条腿
  const legRows = secType === "OPT" || secType === "FOP"
    ? [raw]
    : ((raw["legs"] ?? []) as string[]).map((k) => positions[k]).filter((r): r is Row => r !== undefined);
  for (const leg of legRows) {
    const c = (leg["contract"] ?? {}) as Row;
    const strike = Number(c["strike"]);
    const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
    if (!Number.isFinite(strike) || !right) continue;
    const key = keyOf({ strike, right });
    out.legPrices[key] = (leg["market_price"] ?? null) as number | null;
    out.legIvs[key] = (leg["model_iv"] ?? null) as number | null;
    if (out.expiryMs === null) {
      out.expiryMs = expiryEpochMs(
        String(raw["symbol"] ?? c["symbol"] ?? ""), String(c["lastTradeDateOrContractMonth"] ?? ""),
        String(c["tradingClass"] ?? ""),
      );
    }
  }
  return out;
}
