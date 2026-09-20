/** 入参的小工具:各域 handler 共用的取数与校验。 */
import type { DrawdownLate, DrawdownTier } from "../contract/tracker.js";
import { drawdownLate as fxDrawdownLate, drawdownTiers as fxDrawdownTiers } from "../flyexit.js";
import { pyG } from "../py.js";
import { RpcError } from "../rpcError.js";
import type { Rec } from "./context.js";

export const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,11}$/;

export function symbolOrRaise(params: Rec): string {
  const symbol = String(params["symbol"] ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    throw new RpcError(-32602, `标的代码不合法:'${params["symbol"]}'`);
  }
  return symbol;
}

// ----------------------------------------------------------------------
/** 空字符串 / null → null;其余转 float。表单里的空格子是"不设",不是 0。 */
export function optFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  if (Number.isNaN(out)) throw new RpcError(-32602, `不是有效数字:'${value}'`);
  return out;
}

/** 可选整数参数:null / 空串 / 0 → null;非法值报参数错误(对应 Python _opt_int)。 */
export function optInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RpcError(-32602, `整数参数不合法:'${value}'`);
    return Math.trunc(value);
  }
  if (!/^\s*[-+]?\d+\s*$/.test(String(value))) throw new RpcError(-32602, `整数参数不合法:'${value}'`);
  return parseInt(String(value), 10);
}

/**
 * 分档利润回撤:要么给 preset="fly"(直接用蝶式那套 40/30/20),要么自己列档位。
 *
 * 自列的档位只收 {above, pct} 两个数,pct 必须落在 (0, 100]——0 等于一有回撤就平,
 * 100 等于永不触发,两个都不是用户想要的,当场拒比事后困惑好。
 */
export function drawdownTiersOf(params: Rec): [DrawdownTier[] | null, DrawdownLate | null] {
  if (String(params["profit_drawdown_preset"] ?? "").toLowerCase() === "fly") {
    return [fxDrawdownTiers(null), fxDrawdownLate(null)];
  }
  const raw = params["profit_drawdown_tiers"];
  if (raw === null || raw === undefined || raw === "") return [null, null];
  if (!Array.isArray(raw) || !raw.length) {
    throw new RpcError(-32602, "profit_drawdown_tiers 要是一个非空数组");
  }
  const tiers: DrawdownTier[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new RpcError(-32602, "分档的每一项要是 {above, pct} 对象");
    }
    const above = optFloat((item as Rec)["above"]);
    const pct = optFloat((item as Rec)["pct"]);
    if (above === null || pct === null) throw new RpcError(-32602, "分档的 above 与 pct 都不能空");
    if (above < 0) throw new RpcError(-32602, "分档的 above(浮盈倍数)不能为负");
    if (!(pct > 0 && pct <= 100)) {
      throw new RpcError(-32602, `分档的 pct 要在 0(不含)到 100 之间,当前 ${pyG(pct)}`);
    }
    tiers.push({ above, pct });
  }
  const lateRaw = params["profit_drawdown_late"];
  let late: DrawdownLate | null = null;
  if (typeof lateRaw === "object" && lateRaw !== null && (lateRaw as Rec)["after"]) {
    const factor = optFloat((lateRaw as Rec)["factor"]);
    if (factor === null || !(factor > 0 && factor <= 1)) {
      throw new RpcError(-32602, "尾盘收紧的 factor 要在 0(不含)到 1 之间");
    }
    late = { after: String((lateRaw as Rec)["after"]), factor };
  }
  return [tiers, late];
}
