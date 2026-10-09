/** 入参的小工具:各域 handler 共用的取数与校验。 */
import type { AutoClose, DrawdownLate, DrawdownTier, TakeProfitTier, Targets } from "../contract/tracker.js";
import {
  drawdownArm as fxDrawdownArm, drawdownFloor as fxDrawdownFloor, drawdownLate as fxDrawdownLate,
  drawdownUsdPreset as fxDrawdownUsdPreset,
  drawdownTiers as fxDrawdownTiers,
} from "../flyexit.js";
import { pyG } from "../py.js";
import { RpcError } from "../rpcError.js";
import { MAX_TP_TIERS, nextOccurrenceMs } from "../trackerExits.js";
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

/** 分档利润回撤那一组设置,键名就是 Targets 上的键,handler 直接摊进 makeTargets。 */
export type DrawdownSettings = Pick<
  Targets, "profit_drawdown_tiers" | "profit_drawdown_late" | "profit_drawdown_arm" | "profit_drawdown_floor"
>;

/**
 * 利润回撤的起算门槛:界面填百分比(峰值浮盈 / |成本| × 100),存成倍数,和蝶式的激活线同一个口径、同一道闸
 * (trackerDrawdown.drawdownArmed)。刚开仓时浮盈只有几分钱,不设门槛的话 30% 的回撤就是一分钱的波动。
 * 上限 1000%(十倍)只是挡手误;0 与负数等于没设,当场拒,别让人以为设上了。
 */
export function drawdownArmOf(params: Rec): number | null {
  const pct = optFloat(params["profit_drawdown_arm_pct"]);
  if (pct === null) return null;
  if (!(pct > 0 && pct <= 1000)) {
    throw new RpcError(-32602, `利润回撤的起算门槛要在 0(不含)到 1000% 之间,当前 ${pyG(pct)}`);
  }
  return pct / 100;
}

/**
 * 分档利润回撤:要么给 preset="fly"(直接用蝶式那套 40/30/20 + 激活线 + 最少回吐),要么自己列档位。
 *
 * 自列的档位只收 {above, pct} 两个数,pct 必须落在 (0, 100]——0 等于一有回撤就平,
 * 100 等于永不触发,两个都不是用户想要的,当场拒比事后困惑好。自列档位不带激活线与最少回吐
 * (两个都是 null):改成自列时要把 preset 留下的那两道一起清掉,不能残留。
 */
export function drawdownTiersOf(params: Rec, flyUnitCostUsd: number | null = null): DrawdownSettings {
  if (String(params["profit_drawdown_preset"] ?? "").toLowerCase() === "fly") {
    // 组合持仓按金额起算($100 起追、$200 收紧,flyexit.drawdownUsdPreset);别的持仓、或成本算不出来,退回按比例的预设
    const usd = fxDrawdownUsdPreset(flyUnitCostUsd);
    return {
      profit_drawdown_tiers: usd?.tiers ?? fxDrawdownTiers(null), profit_drawdown_late: fxDrawdownLate(null),
      profit_drawdown_arm: usd?.arm ?? fxDrawdownArm(null), profit_drawdown_floor: fxDrawdownFloor(null),
    };
  }
  // 自列档位 / 固定百分比:激活线用用户填的起算门槛(不填就是 null),最少回吐只有蝶式那套才有
  const none = { profit_drawdown_arm: drawdownArmOf(params), profit_drawdown_floor: null };
  const raw = params["profit_drawdown_tiers"];
  if (raw === null || raw === undefined || raw === "") {
    return { profit_drawdown_tiers: null, profit_drawdown_late: null, ...none };
  }
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
  return { profit_drawdown_tiers: tiers, profit_drawdown_late: late, ...none };
}

// ---------------------------------------------------------------------- 出场细则(tracker.add / update 共用)
/** 到点平仓、标的止损的确认、分批止盈:键名就是 Targets 上的键,handler 直接摊进 makeTargets。 */
export type ExitSettings = Pick<Targets, "exit_at" | "exit_at_ms" | "spot_stop_confirm_s" | "take_profit_tiers">;

/**
 * 到点平仓的钟点换成下一次到这个钟点的时刻(trackerExits.nextOccurrenceMs);确认秒数与各档只查形状与范围,
 * 方向(档位在现价的哪一侧)要现价,留给 handler 的 checkTargets。范围只是挡手误,不是建议值。
 */
export function exitSettingsOf(params: Rec, nowMs: number): ExitSettings {
  const clock = String(params["exit_at"] ?? "").trim();
  let exitAtMs: number | null = null;
  if (clock) {
    exitAtMs = nextOccurrenceMs(clock, nowMs);
    if (exitAtMs === null) throw new RpcError(-32602, `到点平仓的时刻要写成美东时间的 HH:MM(如 15:45),收到「${clock}」。`);
  }
  const confirm = optFloat(params["spot_stop_confirm_s"]);
  if (confirm !== null && !(confirm >= 0 && confirm <= 600)) {
    throw new RpcError(-32602, `标的止损的确认秒数要在 0 到 600 之间,当前 ${pyG(confirm)}`);
  }
  const raw = params["take_profit_tiers"];
  let tiers: TakeProfitTier[] | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    if (!Array.isArray(raw) || !raw.length) throw new RpcError(-32602, "take_profit_tiers 要是一个非空数组");
    if (raw.length > MAX_TP_TIERS) throw new RpcError(-32602, `分批止盈最多 ${MAX_TP_TIERS} 档。`);
    tiers = raw.map((item: unknown) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new RpcError(-32602, "分批止盈的每一项要是 {price, fraction_pct} 对象");
      }
      const price = optFloat((item as Rec)["price"]), fraction = optFloat((item as Rec)["fraction_pct"]);
      if (price === null || fraction === null) throw new RpcError(-32602, "分批止盈的 price 与 fraction_pct 都不能空");
      return { price, fraction_pct: fraction };
    });
  }
  return {
    exit_at: clock || null, exit_at_ms: exitAtMs,
    spot_stop_confirm_s: confirm !== null && confirm > 0 ? confirm : null, take_profit_tiers: tiers,
  };
}

type StopSettings = Partial<Pick<AutoClose, "stop_basis" | "stop_chase_grace" | "stop_chase_step" | "stop_chase_max_pct" | "peak_confirm">>;

/** 止损类拿哪个价判、止损类的追价节奏、峰值要不要两轮确认。没给的键不出现在结果里(update 是合并,不该把库里那份盖成默认值)。 */
export function stopSettingsOf(params: Rec): StopSettings {
  const out: StopSettings = {};
  if (typeof params["peak_confirm"] === "boolean") out.peak_confirm = params["peak_confirm"];
  if (params["stop_basis"] !== undefined && params["stop_basis"] !== null && params["stop_basis"] !== "") {
    const basis = String(params["stop_basis"]);
    if (basis !== "mid" && basis !== "natural") throw new RpcError(-32602, `stop_basis 只能是 mid 或 natural,收到「${basis}」`);
    out.stop_basis = basis;
  }
  const ranges: Array<["stop_chase_grace" | "stop_chase_step" | "stop_chase_max_pct", number, number, string, boolean]> = [
    ["stop_chase_grace", 0, 60, "止损追价先等的轮数", true],
    ["stop_chase_step", 1, 20, "止损追价每轮让的跳数", true],
    ["stop_chase_max_pct", 0, 100, "止损追价的让价上限(%)", false],
  ];
  for (const [key, lo, hi, label, whole] of ranges) {
    if (!(key in params)) continue;
    const value = optFloat(params[key]);
    if (value !== null && (!(value >= lo && value <= hi) || (whole && !Number.isInteger(value)))) {
      throw new RpcError(-32602, `${label}要是 ${lo} 到 ${hi} 之间的${whole ? "整数" : "数"},当前 ${pyG(value)}`);
    }
    out[key] = value;
  }
  return out;
}
