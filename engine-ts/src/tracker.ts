/** 持仓追踪(对应 Python tracker.py):只算不发单,全部纯函数。
 *
 * 三件事定死:方向决定上下;乘数只乘一次(IBKR 的 avgCost 对期权含乘数,
 * 成本侧不再乘、市值侧要乘);跟踪止损跟"最有利价"且峰值必须持久化。
 */
import { finiteOrNull, fmtF, pyFloat, pyG, pyRound } from "./py.js";

export const STATE_HOLDING = "holding";
export const STATE_TAKE_PROFIT = "take_profit";
export const STATE_STOP_LOSS = "stop_loss";
export const STATE_PROFIT_TRAIL = "profit_trail"; // 利润从峰值回撤达到阈值

export class TrackerError extends Error {}

export interface Position {
  account: string; // 别名,不是账号
  symbol: string;
  sec_type: string;
  quantity: number;
  avg_cost: number; // IBKR 口径:期权含乘数
  multiplier: number;
  currency: string;
  market_price: number | null;
  market_value: number | null;
  unrealized_pnl: number | null;
  leg: string; // 期权腿身份(到期|行权价|方向),正股为空
}

export function makePosition(raw: Partial<Position> & { account: string; symbol: string }): Position {
  return {
    account: raw.account,
    symbol: raw.symbol,
    sec_type: raw.sec_type ?? "STK",
    quantity: raw.quantity ?? 0.0,
    avg_cost: raw.avg_cost ?? 0.0,
    multiplier: raw.multiplier ?? 1.0,
    currency: raw.currency ?? "USD",
    market_price: raw.market_price ?? null,
    market_value: raw.market_value ?? null,
    unrealized_pnl: raw.unrealized_pnl ?? null,
    leg: raw.leg ?? "",
  };
}

export function isLong(position: Position): boolean {
  return position.quantity > 0;
}

/** 持仓/追踪的身份(对应 Python position_key)。
 * 正股:账户|代码|类型;期权再带腿身份——一只蝴蝶三条腿都是 SPX 的 OPT,
 * 不带腿身份会在聚合时互相覆盖,追踪与自动平仓也会认错腿。 */
export function makeKey(account: string, symbol: string, secType: string, leg = ""): string {
  const base = `${account}|${symbol}|${secType}`;
  return leg ? `${base}|${leg}` : base;
}

export function positionKey(position: Position): string {
  return makeKey(position.account, position.symbol, position.sec_type, position.leg ?? "");
}

function fmtStrike(strike: unknown): string {
  const value = Number(strike);
  if (strike === null || strike === undefined || strike === "" || Number.isNaN(value)) return "";
  return fmtF(value, 4).replace(/0+$/, "").replace(/\.$/, "");
}

/** 从合约里抽出腿身份:期权为 '到期|行权价|C/P',其余为空串。 */
export function legOf(contract: Record<string, any> | null | undefined): string {
  const c = contract ?? {};
  const secType = String(c["secType"] ?? "STK") || "STK";
  if (secType !== "OPT" && secType !== "FOP") return "";
  const expiry = String(c["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
  const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
  return `${expiry}|${fmtStrike(c["strike"])}|${right}`;
}

/** 给人看的一行名字:正股就是代码;期权 'SPX 7615P 2026-09-01'。 */
export function positionLabel(
  symbol: string, secType: string, contract: Record<string, any> | null | undefined,
): string {
  const c = contract ?? {};
  if (secType !== "OPT" && secType !== "FOP") return symbol;
  let expiry = String(c["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
  if (expiry.length === 8) expiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`;
  const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
  return [symbol, fmtStrike(c["strike"]) + right, expiry].filter((p) => p.trim()).join(" ");
}

/** 追踪记录 → 它盯的那条持仓的 key(老记录没有 leg 列时按正股处理)。 */
export function trackKey(track: Record<string, any>): string {
  return makeKey(
    String(track["account"]), String(track["symbol"]),
    String(track["sec_type"] || "STK"), String(track["leg"] || ""),
  );
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1.0, Math.abs(a), Math.abs(b));
}

const COMBO_STRATEGY: Record<string, string> = {
  butterfly: "BUTTERFLY", vertical: "VERTICAL", iron_condor: "IRON_CONDOR",
};

/** 把一个组合折成一条可追踪的虚拟持仓(对应 Python combo_row):
 * 数量 N 组,借方=多头 +N、贷方=空头 -N;成本/现价取每组净值的绝对值;
 * 任何一条腿没现价就是 null。sec_type=BAG,只提醒、不自动平仓。 */
export function comboRow(
  combo: Record<string, any>, rows: Array<Record<string, any>>,
): Record<string, any> {
  const byKey = new Map(rows.map((r) => [r["key"] as string, r]));
  const legs = (combo["legs"] as string[]).map((k) => byKey.get(k)).filter(Boolean) as Array<Record<string, any>>;
  const qtys = legs.map((r) => Number(r["quantity"] ?? 0) || 0);
  let units = Number(combo["quantity"] ?? 0);
  if (!units) units = 1.0; // 认不出形状的组合:按 1 组算,腿比例就是各腿数量
  const ratios = qtys.map((q) => q / units);
  const netCost = legs.reduce((acc, leg, i) => acc + ratios[i]! * (Number(leg["avg_cost"] ?? 0) || 0), 0);
  const prices = legs.map((leg) => leg["market_price"] as number | null | undefined);
  const netPrice =
    legs.length && prices.every((p) => p !== null && p !== undefined)
      ? legs.reduce((acc, _leg, i) => acc + ratios[i]! * Number(prices[i]), 0)
      : null;
  const long = netCost >= 0;
  const contract = (legs[0]?.["contract"] ?? {}) as Record<string, any>;
  const multiplier = legs.length ? Number(legs[0]!["multiplier"] ?? 100) || 100 : 100;
  const sig = legs
    .map((leg, i) => {
      const c = leg["contract"] ?? {};
      return `${ratios[i]! >= 0 ? "+" : ""}${pyG(ratios[i]!)}x${fmtStrike(c["strike"])}${String(c["right"] ?? "").slice(0, 1).toUpperCase()}`;
    })
    .join(",");
  const legId = `${combo["expiry"]}|${sig}`;
  return {
    key: makeKey(combo["account"], combo["symbol"], "BAG", legId),
    account: combo["account"],
    symbol: combo["symbol"],
    sec_type: "BAG",
    leg: legId,
    label: combo["label"],
    kind: combo["kind"],
    quantity: long ? units : -units,
    multiplier,
    currency: legs.length ? legs[0]!["currency"] : "USD",
    avg_cost: pyRound(Math.abs(netCost), 4),
    market_price: netPrice === null ? null : pyRound(Math.abs(netPrice), 4),
    net_side: long ? "debit" : "credit",
    market_value: combo["market_value"] ?? null,
    unrealized_pnl: combo["unrealized_pnl"] ?? null,
    legs: [...(combo["legs"] as string[])],
    ratios,
    contract: {
      secType: "BAG",
      symbol: combo["symbol"],
      exchange: contract["exchange"] || "SMART",
      currency: contract["currency"] || "USD",
      multiplier: String(Math.trunc(multiplier)),
      combo_strategy: COMBO_STRATEGY[combo["kind"]] ?? null,
      label: combo["label"],
      legs: legs.map((leg, i) => {
        const c = leg["contract"] ?? {};
        return {
          lastTradeDateOrContractMonth: c["lastTradeDateOrContractMonth"] ?? null,
          strike: c["strike"] ?? null,
          right: c["right"] ?? null,
          ratio: ratios[i],
        };
      }),
    },
  };
}

/** 券商持仓行 + 组合虚拟行。所有按 key 找持仓的地方都该用这个,组合才追踪得到。 */
export function withCombos(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  const list = [...rows];
  return list.concat(groupLegs(list).map((c) => comboRow(c, list)));
}

/** 把同一账户、同一标的、同一到期日的期权腿认成组合(蝴蝶/价差/铁鹰)。
 * 只做识别与展示;认不出来的叫"组合(N 腿)",绝不猜。对应 Python group_legs。 */
const strikeOfLeg = (r: Record<string, any>): number => Number((r["contract"] ?? {})["strike"] ?? 0) || 0;
const rightOfLeg = (r: Record<string, any>): string => String((r["contract"] ?? {})["right"] ?? "");

function legFields(legs: Array<Record<string, any>>): [number[], string[], number[]] {
  return [
    legs.map(strikeOfLeg),
    legs.map((r) => rightOfLeg(r).slice(0, 1).toUpperCase()),
    legs.map((r) => Number(r["quantity"] ?? 0) || 0),
  ];
}

/** 这几条腿(已按行权价排好序)构成什么标准结构?认不出回 null。
 * 规则刻意保守——猜错的后果是净价、成本、盈亏全算在一个根本不存在的结构上。 */
export function shapeOf(legs: Array<Record<string, any>>): [string, number] | null {
  const [strikes, rights, qtys] = legFields(legs);
  const sameRight = new Set(rights).size === 1;
  if (legs.length === 2 && sameRight && qtys[0]! * qtys[1]! < 0 &&
      same(Math.abs(qtys[0]!), Math.abs(qtys[1]!))) {
    return ["vertical", Math.abs(qtys[0]!)];
  }
  if (legs.length === 3 && sameRight && same(strikes[1]! - strikes[0]!, strikes[2]! - strikes[1]!) &&
      same(qtys[0]!, qtys[2]!) && same(qtys[1]!, -2.0 * qtys[0]!) && qtys[0] !== 0) {
    return ["butterfly", Math.abs(qtys[0]!)];
  }
  if (legs.length === 4 && rights.join(",") === "P,P,C,C" && qtys[0]! * qtys[1]! < 0 &&
      qtys[2]! * qtys[3]! < 0 && same(Math.abs(qtys[0]!), Math.abs(qtys[1]!)) &&
      same(Math.abs(qtys[2]!), Math.abs(qtys[3]!))) {
    return [same(strikes[1]!, strikes[2]!) ? "iron_butterfly" : "iron_condor", Math.abs(qtys[0]!)];
  }
  return null;
}

/**
 * 把同一到期日的腿按结构切成若干**独立**组合。
 *
 * 为什么必须切:IBKR 的持仓只给每条腿的净数量,不告诉你哪些腿属于同一张组合。
 * 同一天到期的两张蝶(哪怕一张看涨一张看跌)会挤在同一个桶里,不切开就成了
 * "组合(6 腿)"——净价、成本、盈亏全混在一起,平仓单更是拼不出来
 * (2026-09-04 实测:7595/7620/7645 看跌蝶 + 7800/7820/7840 看涨蝶被认成一个)。
 *
 * 贪心:从行权价最低的腿开始,依次试 4 腿(铁鹰/铁蝶)、3 腿(蝶)、2 腿(价差),匹配上就
 * 消费掉再往后走。先试长的,免得把铁鹰的前两条腿当成一个价差。当前位置一个都匹配不上,
 * 就把**剩下的整块**交出去按"组合(N 腿)"处理——认不出可以接受,拆错不行。
 */
export function splitStructures(legs: Array<Record<string, any>>): Array<Array<Record<string, any>>> {
  const out: Array<Array<Record<string, any>>> = [];
  let rest = [...legs];
  while (rest.length >= 2) {
    let matched = false;
    for (const size of [4, 3, 2]) {
      if (rest.length >= size && shapeOf(rest.slice(0, size)) !== null) {
        out.push(rest.slice(0, size));
        rest = rest.slice(size);
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  if (rest.length) out.push(rest);
  return out.length ? out : [[...legs]];
}

export function groupLegs(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  const buckets = new Map<string, { account: string; symbol: string; expiry: string; legs: Array<Record<string, any>> }>();
  for (const row of rows) {
    const secType = String(row["sec_type"] ?? "STK") || "STK";
    if (secType !== "OPT" && secType !== "FOP") continue;
    const contract = row["contract"] ?? {};
    const expiry = String(contract["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
    const account = String(row["account"]);
    const symbol = String(row["symbol"]);
    const id = `${account}|${symbol}|${expiry}`;
    if (!buckets.has(id)) buckets.set(id, { account, symbol, expiry, legs: [] });
    buckets.get(id)!.legs.push(row);
  }

  const combos: Array<Record<string, any>> = [];
  const ordered = [...buckets.values()].sort((a, b) =>
    a.account < b.account ? -1 : a.account > b.account ? 1 :
    a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 :
    a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0);
  for (const { account, symbol, expiry, legs: raw } of ordered) {
    if (raw.length < 2) continue;
    const bucket = [...raw].sort((a, b) =>
      strikeOfLeg(a) - strikeOfLeg(b) ||
      (rightOfLeg(a) < rightOfLeg(b) ? -1 : rightOfLeg(a) > rightOfLeg(b) ? 1 : 0));
    for (const legs of splitStructures(bucket)) {
      if (legs.length < 2) continue;
      const [strikes, rights, qtys] = legFields(legs);
      const sameRight = new Set(rights).size === 1;
      const rightName = sameRight ? ({ C: "看涨", P: "看跌" } as Record<string, string>)[rights[0]!] ?? "" : "";
      const strikeText = strikes.map((s) => fmtStrike(s)).join("/");

      const shape = shapeOf(legs);
      let kind = "custom";
      let label = `组合(${legs.length} 腿) ${strikeText}`;
      let quantity: number | null = null;
      if (shape !== null) {
        [kind, quantity] = shape;
        if (kind === "vertical") label = `${rightName}价差 ${strikeText}`;
        else if (kind === "butterfly") {
          label = `${qtys[0]! > 0 ? "买入" : "卖出"}${rightName}蝴蝶 ${strikeText}`;
        } else label = `${kind === "iron_butterfly" ? "铁蝶" : "铁鹰"} ${strikeText}`;
      }

      const values = legs.map((r) => r["market_value"] as number | null | undefined);
      const pnls = legs.map((r) => r["unrealized_pnl"] as number | null | undefined);
      const sumOf = (xs: Array<number | null | undefined>): number | null =>
        xs.every((v) => v !== null && v !== undefined) ? pyRound(xs.reduce((a, b) => a + (b as number), 0), 2) : null;
      combos.push({
        account, symbol, expiry,
        right: sameRight ? rights[0] : "",
        kind, label, quantity,
        net_cost: pyRound(legs.reduce((acc, r, i) => acc + qtys[i]! * (Number(r["avg_cost"] ?? 0) || 0), 0), 2),
        market_value: sumOf(values),
        unrealized_pnl: sumOf(pnls),
        legs: legs.map((r) => r["key"]),
      });
    }
  }
  return combos;
}

export interface Targets {
  take_profit: number | null;
  stop_loss: number | null;
  trail_pct: number | null;
  /** 利润回撤:当前利润比历史峰值利润低这么多个百分点时触发。
   * 峰值利润不用单独存:利润对价格单调,由已持久化的峰值价格换算,重启不丢。 */
  profit_drawdown_pct: number | null;
  /** 分档回撤:按**浮盈相对成本的倍数**换档位。`profit_peak / |costBasis|` 对期权组合
   * 恰好就是 flyexit 的"浮盈 / D"——两边同乘 数量×乘数 就约掉了,不必另传 D。
   * 形如 [{above: 0, pct: 40}, {above: 1, pct: 30}, {above: 3, pct: 20}]:
   * 取所有 above ≤ 当前倍数 里最高的那一档。不填就全程用 profit_drawdown_pct。 */
  profit_drawdown_tiers: Array<Record<string, any>> | null;
  /** 尾盘收紧:{after: "15:00", factor: 0.5}。 */
  profit_drawdown_late: Record<string, any> | null;
}

export function makeTargets(raw: Partial<Targets> = {}): Targets {
  return {
    take_profit: raw.take_profit ?? null,
    stop_loss: raw.stop_loss ?? null,
    trail_pct: raw.trail_pct ?? null,
    profit_drawdown_pct: raw.profit_drawdown_pct ?? null,
    profit_drawdown_tiers: raw.profit_drawdown_tiers ?? null,
    profit_drawdown_late: raw.profit_drawdown_late ?? null,
  };
}

export function targetsEmpty(t: Targets): boolean {
  return (
    t.take_profit === null && t.stop_loss === null && t.trail_pct === null &&
    t.profit_drawdown_pct === null && !(t.profit_drawdown_tiers ?? []).length
  );
}

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
      const above = finiteOrNull((tier ?? {})["above"]);
      const tierPct = finiteOrNull((tier ?? {})["pct"]);
      if (above === null || tierPct === null || ratio < above) continue;
      if (bestAbove === null || above >= bestAbove) {
        bestAbove = above;
        pct = tierPct;
      }
    }
  }
  if (pct === null) return null;
  const late = targets.profit_drawdown_late ?? {};
  const after = late["after"] ? minutesOfClock(late["after"]) : null;
  const factor = finiteOrNull(late["factor"]);
  if (after !== null && factor !== null && minute !== null && minute >= after) pct *= factor;
  return pyRound(pct, 6);
}

// ----------------------------------------------------------------------
// 盈亏
// ----------------------------------------------------------------------
/** 建仓总成本。不乘乘数:avgCost 对期权已是含乘数的整张成本。 */
export function costBasis(position: Position): number {
  return position.avg_cost * position.quantity;
}

/** 当前市值。这一侧要乘乘数——报价是每股/每份的价格。 */
export function marketValue(position: Position, price: number | null): number | null {
  const p = finiteOrNull(price);
  if (p === null) return null;
  return p * (position.multiplier || 1.0) * position.quantity;
}

export interface UnrealizedResult {
  cost_basis: number;
  market_value: number | null;
  unrealized_pnl: number | null;
  unrealized_pct: number | null;
  pnl_source: string;
  [key: string]: unknown;
}

/** 未实现盈亏。券商自己报了就用券商的;算不出来老实回 null。 */
export function unrealized(position: Position, price: number | null): UnrealizedResult {
  const basis = costBasis(position);
  let pnl: number | null;
  let source: string;
  let value: number | null;
  if (position.unrealized_pnl !== null && finiteOrNull(position.unrealized_pnl) !== null) {
    pnl = position.unrealized_pnl;
    source = "broker";
    value = finiteOrNull(position.market_value);
    if (value === null) value = marketValue(position, price);
  } else {
    value = marketValue(position, price);
    pnl = value === null ? null : value - basis;
    source = "computed";
  }

  let pct: number | null = null;
  if (pnl !== null && basis) {
    // 空头的成本是负数:用绝对值做分母,百分比的符号跟着盈亏走
    pct = (pnl / Math.abs(basis)) * 100.0;
  }

  return {
    cost_basis: pyRound(basis, 4),
    market_value: value === null ? null : pyRound(value, 4),
    unrealized_pnl: pnl === null ? null : pyRound(pnl, 4),
    unrealized_pct: pct === null ? null : pyRound(pct, 3),
    pnl_source: source,
  };
}

// ----------------------------------------------------------------------
// 设置校验
// ----------------------------------------------------------------------
/** 设置时就把方向搞反的情况拦下来。 */
export function validate(position: Position, targets: Targets, price: number | null): void {
  if (targetsEmpty(targets)) {
    throw new TrackerError("至少要设一个:止盈价、止损价,或跟踪止损百分比。");
  }
  if (!position.quantity) {
    throw new TrackerError("这个持仓的数量是 0,没有可追踪的头寸。");
  }

  for (const [name, value] of [["止盈价", targets.take_profit], ["止损价", targets.stop_loss]] as const) {
    if (value !== null && (finiteOrNull(value) === null || value <= 0)) {
      throw new TrackerError(`${name}必须是正数。`);
    }
  }
  if (targets.trail_pct !== null) {
    if (finiteOrNull(targets.trail_pct) === null || !(targets.trail_pct > 0 && targets.trail_pct < 100)) {
      throw new TrackerError("跟踪止损的回撤百分比要在 0 到 100 之间。");
    }
  }
  if (targets.profit_drawdown_pct !== null) {
    if (
      finiteOrNull(targets.profit_drawdown_pct) === null ||
      !(targets.profit_drawdown_pct > 0 && targets.profit_drawdown_pct < 100)
    ) {
      throw new TrackerError("利润回撤的百分比要在 0 到 100 之间。");
    }
  }

  const long = isLong(position);
  const tp = targets.take_profit;
  const sl = targets.stop_loss;

  // 排序检查放在取现价之前:行情断掉时恰恰最需要它兜底
  if (tp !== null && sl !== null) {
    if (long && sl >= tp) throw new TrackerError("多头的止损价必须低于止盈价。");
    if (!long && sl <= tp) throw new TrackerError("空头的止损价必须高于止盈价。");
  }

  const p = finiteOrNull(price);
  if (p === null) return; // 拿不到现价就不做方向校验,但也不假装校验过了

  if (tp !== null) {
    if (long && tp <= p) {
      throw new TrackerError(
        `多头的止盈价要高于现价(现价 ${fmtF(p, 4)},你填了 ${fmtF(tp, 4)})——填在下方会立刻触发。`,
      );
    }
    if (!long && tp >= p) {
      throw new TrackerError(
        `空头的止盈价要低于现价(现价 ${fmtF(p, 4)},你填了 ${fmtF(tp, 4)})——空头是跌了才赚。`,
      );
    }
  }
  if (sl !== null) {
    if (long && sl >= p) {
      throw new TrackerError(
        `多头的止损价要低于现价(现价 ${fmtF(p, 4)},你填了 ${fmtF(sl, 4)})——填在上方会立刻触发。`,
      );
    }
    if (!long && sl <= p) {
      throw new TrackerError(`空头的止损价要高于现价(现价 ${fmtF(p, 4)},你填了 ${fmtF(sl, 4)})。`);
    }
  }
}

// ----------------------------------------------------------------------
// 跟踪止损
// ----------------------------------------------------------------------
/** 把"最有利价"往前推。只朝有利方向走,不回头。 */
export function advancePeak(
  position: Position, price: number | null, peak: number | null,
): number | null {
  const p = finiteOrNull(price);
  if (p === null) return peak;
  if (peak === null) return p;
  return isLong(position) ? Math.max(peak, p) : Math.min(peak, p);
}

/** 跟踪止损当前落在哪个价位。 */
export function trailStopPrice(
  position: Position, peak: number | null, trailPct: number | null,
): number | null {
  const pk = finiteOrNull(peak);
  const pct = finiteOrNull(trailPct);
  if (pk === null || pct === null) return null;
  const ratio = pct / 100.0;
  return isLong(position) ? pk * (1 - ratio) : pk * (1 + ratio);
}

// ----------------------------------------------------------------------
// 触发判断
// ----------------------------------------------------------------------
export interface EvaluateResult extends UnrealizedResult {
  state: string;
  price: number | null;
  peak: number | null;
  trail_stop: number | null;
  reason: string;
  profit_peak?: number | null;
  profit_drawdown_pct?: number | null;
  profit_drawdown_threshold?: number | null;
  profit_trail_stop?: number | null;
  stop_effective?: number | null;
  to_take_profit_pct?: number | null;
  to_stop_pct?: number | null;
}

/** 现价 + 设置 + 峰值 → 当前状态。止损优先于止盈(跳空按最坏的那一边算)。 */
export function evaluate(
  position: Position, targets: Targets, price: number | null, peak: number | null = null,
  minute: number | null = null,
): EvaluateResult {
  const p = finiteOrNull(price);
  const newPeak = advancePeak(position, p, peak);
  const trail = trailStopPrice(position, newPeak, targets.trail_pct);

  const out: EvaluateResult = {
    state: STATE_HOLDING,
    price: p,
    peak: newPeak,
    trail_stop: trail === null ? null : pyRound(trail, 4),
    reason: "",
    ...unrealized(position, p),
  } as EvaluateResult;
  if (p === null) {
    out.state = STATE_HOLDING;
    out.reason = "拿不到现价,本轮不判断";
    return out;
  }

  const long = isLong(position);
  // 有效止损 = 固定止损和跟踪止损里更靠近现价的那一个
  const stops = [targets.stop_loss, trail].filter((s): s is number => s !== null);
  const stop = stops.length ? (long ? Math.max(...stops) : Math.min(...stops)) : null;

  const hitStop = stop !== null && (long ? p <= stop : p >= stop);
  const hitTake =
    targets.take_profit !== null && (long ? p >= targets.take_profit : p <= targets.take_profit);

  // 利润回撤:与当前利润同一口径(都按价格换算),峰值利润由峰值价格换算——
  // 利润对价格单调,所以这就是历史最高利润。
  let profitNow: number | null = null;
  let profitPeak: number | null = null;
  let profitDd: number | null = null;
  let hitProfitTrail = false;
  let threshold: number | null = null;
  if ((targets.profit_drawdown_pct !== null || (targets.profit_drawdown_tiers ?? []).length)
      && newPeak !== null) {
    const basis = costBasis(position);
    const valueNow = marketValue(position, p);
    const valuePeak = marketValue(position, newPeak);
    if (valueNow !== null && valuePeak !== null) {
      profitNow = valueNow - basis;
      profitPeak = valuePeak - basis;
      if (profitPeak > 0) {
        profitDd = (1.0 - profitNow / profitPeak) * 100.0;
        threshold = drawdownThreshold(targets, profitPeak, basis, minute);
        if (threshold !== null) hitProfitTrail = profitNow <= profitPeak * (1.0 - threshold / 100.0);
      }
    }
  }
  out.profit_peak = profitPeak === null ? null : pyRound(profitPeak, 4);
  out.profit_drawdown_pct = profitDd === null ? null : pyRound(profitDd, 2);
  // 当前生效的档位:分档时每一轮都可能不一样,界面要能说清"现在让多少"
  out.profit_drawdown_threshold = threshold === null ? null : pyRound(threshold, 4);
  // 这一档对应的**价格**。百分比看不出紧迫感,"跌到 0.14 就平"才看得懂;
  // 分档时它会随档位跳变,所以每轮都要重算,不能在界面上按配置算一次了事。
  out.profit_trail_stop = threshold === null ? null : profitTrailStopPrice(position, newPeak, threshold);

  if (hitStop) {
    out.state = STATE_STOP_LOSS;
    const which = trail !== null && stop === trail ? "跟踪止损" : "止损";
    out.reason = `${which}触发:现价 ${fmtF(p, 4)} ${long ? "跌破" : "涨破"} ${fmtF(stop!, 4)}`;
  } else if (hitProfitTrail) {
    out.state = STATE_PROFIT_TRAIL;
    out.reason =
      `利润回撤触发:峰值利润 ${fmtF(profitPeak!, 2)},当前 ${fmtF(profitNow!, 2)},` +
      `回撤 ${fmtF(profitDd!, 1)}%(阈值 ${fmtF(threshold!, 0)}%)`;
  } else if (hitTake) {
    out.state = STATE_TAKE_PROFIT;
    out.reason =
      `止盈触发:现价 ${fmtF(p, 4)} ${long ? "涨到" : "跌到"} ${fmtF(targets.take_profit!, 4)}`;
  }

  out.stop_effective = stop === null ? null : pyRound(stop, 4);
  out.to_take_profit_pct = gapPct(p, targets.take_profit);
  out.to_stop_pct = gapPct(p, stop);
  return out;
}

function gapPct(price: number | null, target: number | null): number | null {
  const p = finiteOrNull(price);
  const t = finiteOrNull(target);
  if (p === null || t === null || p === 0) return null;
  return pyRound((t / p - 1) * 100.0, 3);
}

/** 平掉这个持仓要下的方向。多头平仓是卖,空头平仓是买。 */
export function closeSide(position: Position): string {
  return isLong(position) ? "SELL" : "BUY";
}

// ----------------------------------------------------------------------
// 到价自动平仓
// ----------------------------------------------------------------------
export interface AutoClose {
  enabled: boolean;
  order_type: string; // MKT 一定成交;LMT 控价但可能不成交
  slippage_pct: number;
  /** 触发后平掉持仓的百分之多少。默认全平;设 50 即卖出一半锁利。 */
  close_fraction_pct: number;
  /** 把止盈/止损挂到券商服务器(GTC + OCA):软件关掉也生效。软件开着时,
   * 利润回撤等动态目标由引擎按秒调整托管单价格;关掉则停在最后一次。 */
  host_at_broker: boolean;
}

export function makeAutoClose(raw: Partial<AutoClose> = {}): AutoClose {
  return {
    enabled: raw.enabled ?? false,
    order_type: raw.order_type ?? "MKT",
    slippage_pct: raw.slippage_pct ?? 0.3,
    close_fraction_pct: raw.close_fraction_pct ?? 100.0,
    host_at_broker: raw.host_at_broker ?? false,
  };
}

export const BLOCK_DISABLED = "该持仓没有开启自动平仓";
export const BLOCK_AUTO_EXECUTE = "全局 auto_execute 未打开";
export const BLOCK_LIVE = "实盘账户需要先打开 allow_live_trading";
export const BLOCK_BREAKER = "已熔断,不再发出任何新单";
export const BLOCK_MARKET = "当前时段不能交易";
export const BLOCK_ALREADY = "这个追踪已经触发过一次,不重复发单";
export const BLOCK_QTY = "持仓数量为 0,没有可平的头寸";
export const BLOCK_COMBO_LIVE = "组合平仓单还没在实盘核对过,实盘账户需要先打开 allow_combo_live";

/** 自动平仓前要过的闸门。刻意不走 validator 那一套(平仓是减少风险)。 */
export function closeBlockers(args: {
  auto: AutoClose;
  position: Position;
  accountIsPaper: boolean;
  autoExecute: boolean;
  allowLiveTrading: boolean;
  breakerEngaged: boolean;
  marketStatus: string;
  outsideRth?: boolean;
  alreadyFired?: boolean;
  comboLiveOk?: boolean;
}): string[] {
  const blocked: string[] = [];
  if (!args.auto.enabled) blocked.push(BLOCK_DISABLED);
  if (args.alreadyFired) blocked.push(BLOCK_ALREADY);
  if (!args.position.quantity) blocked.push(BLOCK_QTY);
  if (!args.autoExecute) blocked.push(BLOCK_AUTO_EXECUTE);
  if (!args.accountIsPaper && !args.allowLiveTrading) blocked.push(BLOCK_LIVE);
  // 组合平仓要发 BAG 单,腿方向反转一步错就是反向建仓。纸面账户随便跑,实盘要另开
  // 一道闸——allowLiveTrading 是"我允许这个软件碰实盘",不等于"我信任这条还没在
  // 真机上核对过的新路径"。核对通过之前,这两件事必须分开授权。
  if (args.position.sec_type === "BAG" && !args.accountIsPaper && !args.comboLiveOk) {
    blocked.push(BLOCK_COMBO_LIVE);
  }
  if (args.breakerEngaged) blocked.push(BLOCK_BREAKER);
  const tradable = new Set(["盘中"]);
  if (args.outsideRth) for (const s of EXTENDED_SESSIONS) tradable.add(s);
  if (!tradable.has(args.marketStatus)) {
    blocked.push(`${BLOCK_MARKET}(当前:${args.marketStatus})`);
  }
  return blocked;
}

/** 一次触发要平的数量。向下取整、至少 1 股/张、绝不超过持仓。 */
export function closeQty(position: Position, auto: AutoClose): number {
  const qtyFull = Math.trunc(Math.abs(position.quantity));
  if (qtyFull <= 0) throw new TrackerError("持仓数量为 0,没有可平的头寸。");
  const fraction = finiteOrNull(auto.close_fraction_pct);
  if (fraction === null || !(fraction > 0 && fraction <= 100)) {
    throw new TrackerError("平仓比例要在 0(不含)到 100 之间。");
  }
  if (fraction >= 100) return qtyFull;
  return Math.max(1, Math.min(qtyFull, Math.trunc((qtyFull * fraction) / 100.0)));
}

/** 限价平仓的价格:朝成交方向让价。让反了就是挂一张永远不会成交的单。 */
export function closeLimitPrice(
  position: Position, price: number | null, slippagePct: number,
): number | null {
  const p = finiteOrNull(price);
  const pct = finiteOrNull(slippagePct);
  if (p === null || pct === null) return null;
  const ratio = Math.abs(pct) / 100.0;
  let out = isLong(position) ? p * (1 - ratio) : p * (1 + ratio);
  // 对齐最小跳动:TWS 对不合跳动的限价直接拒单(错误 110),这张单就白发了。
  // 取整仍朝让价方向(卖向下、买向上),取整后只会更容易成交,不会更难。
  const tick = closeTick(position);
  const steps = isLong(position) ? Math.floor(out / tick + 1e-9) : Math.ceil(out / tick - 1e-9);
  out = steps * tick;
  return pyRound(Math.max(out, tick), 4);
}

/**
 * 平仓单用的合约:股票只留四要素,走 SMART。持仓行里的合约是 TWS 报回来的样子
 * (exchange=NASDAQ、tradingClass=NMS、multiplier="1"),原样拿去下单 TWS 会回 200
 * 「未找到证券定义」——模拟盘实测(2026-09-03)。期权腿保留识别合约必需的字段,去掉 null。
 */
export function closeContract(contract: Record<string, unknown>): Record<string, unknown> {
  const secType = String(contract["secType"] ?? "");
  if (secType === "STK") {
    return {
      secType: "STK", symbol: contract["symbol"],
      exchange: "SMART", currency: contract["currency"] ?? "USD",
    };
  }
  if (secType === "BAG") return closeBagContract(contract);
  return Object.fromEntries(Object.entries(contract).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * 平组合的 BAG 合约:**每条腿的方向全部反转**,比例取绝对值。
 *
 * comboRow 存的 legs 里 ratio 是带符号的持仓比例(蝴蝶 +1/−2/+1)。平掉它要反着来:
 * 买入的腿卖掉、卖出的腿买回。腿的 action 才是真实方向——BAG 本身一律以 BUY 提交
 * (见 broker.bagSignedLimit:IBKR 对 BAG 的 SELL 会把每条腿再反转一次)。
 *
 * 比例只接受 1 或 2。认不出的比例宁可报错也不猜:猜错的那张单会在券商侧变成一个
 * 谁也没打算持有的结构。
 */
export function closeBagContract(contract: Record<string, unknown>): Record<string, unknown> {
  const legsIn = (contract["legs"] ?? []) as Array<Record<string, unknown>>;
  if (!legsIn.length) throw new TrackerError("组合持仓没有腿信息,拼不出平仓的 BAG 合约。");
  const legs = legsIn.map((leg) => {
    const ratio = finiteOrNull(leg["ratio"]);
    if (ratio === null || ratio === 0) {
      throw new TrackerError(`组合的某条腿比例是 ${JSON.stringify(leg["ratio"])},认不出方向,拒绝拼平仓单。`);
    }
    const steps = Math.round(Math.abs(ratio));
    if (Math.abs(Math.abs(ratio) - steps) > 1e-6 || (steps !== 1 && steps !== 2)) {
      throw new TrackerError(
        `组合的腿比例 ${pyG(ratio)} 不是 1 或 2(只支持垂直价差/蝴蝶/铁鹰的标准比例),拒绝拼平仓单。`,
      );
    }
    for (const field of ["lastTradeDateOrContractMonth", "strike", "right"]) {
      if (leg[field] === null || leg[field] === undefined || leg[field] === "") {
        throw new TrackerError(`组合的某条腿缺少 ${field},拼不出平仓的 BAG 合约。`);
      }
    }
    return {
      action: ratio > 0 ? "SELL" : "BUY", // 反转:持有买入腿 → 平仓卖出
      ratio: steps,
      lastTradeDateOrContractMonth: leg["lastTradeDateOrContractMonth"],
      strike: Number(leg["strike"]),
      right: String(leg["right"]).slice(0, 1).toUpperCase(),
      multiplier: String(contract["multiplier"] ?? "100"),
    };
  });
  const out: Record<string, unknown> = {
    secType: "BAG",
    symbol: contract["symbol"],
    exchange: "SMART",
    currency: contract["currency"] ?? "USD",
    legs,
  };
  if (contract["combo_strategy"]) out["combo_strategy"] = contract["combo_strategy"];
  return out;
}

/** 平仓限价的最小跳动:股票 0.01;期权/组合保守取 0.05(对所有美股期权都合法)。 */
export function closeTick(position: Position): number {
  return position.sec_type === "STK" ? 0.01 : 0.05;
}

/** 构造平仓单载荷。数量取持仓绝对值,一股不多。 */
/** 盘外时段:追踪照样盯、照样平,但交易所盘外只收限价单,平仓单在这两个时段自动转限价并开盘外标志 */
/** 盘外时段:平仓单在这些时段自动转限价并打 outsideRth。
 * "盘外"来自**合约自己的**交易时段(见 config.hoursStatus):SPX 期权有
 * 20:15–次日 09:25 这一整段隔夜可交易时间,它既不是正股口径的"盘前"也不是"盘后"。 */
export const EXTENDED_SESSIONS = ["盘前", "盘后", "盘外"];

/**
 * 构造平仓单载荷。盘前/盘后(marketStatus 在 EXTENDED_SESSIONS 里)追踪止盈同样要能平:
 * 交易所盘外不收市价单,所以市价平仓在这两个时段自动转成限价单(按 slippage_pct 朝成交
 * 方向让价)并打上 outsideRth;拿不到现价算不出限价就拒绝。
 */
export function buildCloseOrder(
  position: Position,
  auto: AutoClose,
  price: number | null,
  state: string,
  contract: Record<string, unknown>,
  marketStatus = "盘中",
): Record<string, unknown> {
  const qty = closeQty(position, auto);
  const qtyFull = Math.trunc(Math.abs(position.quantity));
  const side = closeSide(position);
  const why =
    state === STATE_TAKE_PROFIT ? "止盈" : state === STATE_PROFIT_TRAIL ? "利润回撤" : "止损";
  const extended = EXTENDED_SESSIONS.includes(marketStatus);
  // 组合一律不发市价单:BAG 的 MKT 会让每条腿各吃一次价差,0DTE 蝶的三条腿加起来
  // 能吃掉大半个净价。宁可挂一张让了滑点的限价单,也不把"成交价随缘"当成平仓。
  const isBag = position.sec_type === "BAG";
  const orderType = (extended || isBag) && auto.order_type === "MKT" ? "LMT" : auto.order_type;
  const order: Record<string, unknown> = {
    action: side,
    orderType,
    totalQuantity: qty,
    price_mode: "EXPLICIT",
    tif: "DAY",
    outsideRth: extended,
  };
  let priceLabel = "市价";
  if (orderType === "LMT") {
    const limit = closeLimitPrice(position, price, auto.slippage_pct);
    if (limit === null) {
      throw new TrackerError(
        isBag ? "组合只能限价平仓,但拿不到组合现价算不出限价——拒绝下单。"
          : extended ? "盘外只能限价平仓,但拿不到现价算不出限价——拒绝下单。"
            : "拿不到现价,限价平仓算不出限价——拒绝下单。",
      );
    }
    order["lmtPrice"] = limit;
    priceLabel = `${extended ? "盘外限价" : "限价"} ${pyFloat(limit)}`;
  }

  const partial = qty >= qtyFull ? "" : `,平 ${qty}/${qtyFull}`;
  return {
    intent_summary:
      `${why}平仓:${side === "SELL" ? "卖出" : "买入"} ${qty} ${position.symbol}(${priceLabel}${partial})`,
    contract: closeContract(contract),
    execution_type: "IMMEDIATE",
    trigger: null,
    account: position.account,
    order,
    reason: `持仓追踪${why}触发,自动平仓`,
    confidence: 1.0, // 不是模型解析出来的,是规则算出来的
    warnings: [],
  };
}

// ----------------------------------------------------------------------
// 券商托管:把止盈/止损挂到券商服务器上
// ----------------------------------------------------------------------
// 软件盯盘的三个天生短板——轮询间隙漏插针、软件必须开着、我们这头的行情可能
// 是延迟的——托管单全部没有:触发发生在券商服务器的实时行情上。代价是动态
// 目标(利润回撤)券商表达不了,只能由引擎把它化成"随峰值棘轮移动的停损价",
// 按秒改托管单;软件关掉,调整停在最后一次,单子本身仍站岗。

export const HOSTED_KIND_TP = "tp"; // 止盈:GTC 限价单
export const HOSTED_KIND_SL = "sl"; // 止损:GTC 停损单
export const HOSTED_KIND_TRAIL = "trail"; // 价格跟踪止损:IBKR 原生 TRAIL 单
export const HOSTED_KIND_PTRAIL = "ptrail"; // 利润回撤:引擎按秒调整停损价的 STP 单

export const HOSTED_LABELS: Record<string, string> = {
  [HOSTED_KIND_TP]: "托管止盈",
  [HOSTED_KIND_SL]: "托管止损",
  [HOSTED_KIND_TRAIL]: "托管跟踪止损",
  [HOSTED_KIND_PTRAIL]: "利润回撤动态停损",
};

export interface HostedOrderPlan {
  kind: string;
  action: string;
  order_type: string;
  quantity: number;
  lmt_price: number | null;
  aux_price: number | null;
  trailing_percent: number | null;
  trail_stop_seed: number | null;
  label: string;
  [key: string]: unknown;
}

/** 托管单的价格统一收敛到 2 位小数(美股最小报价单位),且不小于 0.01。
 * 4 位小数的停损价会被 IBKR 以 110(价格档位不合法)拒掉。 */
function hostedPrice(value: number | null | undefined): number | null {
  const v = finiteOrNull(value ?? null);
  if (v === null) return null;
  return pyRound(Math.max(v, 0.01), 2);
}

/** 把"利润回撤 N%"换算成一个停损价。
 *
 * 利润对价格是线性的:profit(p) = qty·mult·(p − c),c 为每股成本。
 * 多头触发条件 profit ≤ peak_profit·(1−d) 等价于 p ≤ c + (峰值−c)·(1−d);
 * 空头对称。峰值利润必须为正(峰值越过成本)才挂——和 evaluate() 的
 * "从未盈利不触发"同一条规则,两条路径必须给出同一个触发价。 */
export function profitTrailStopPrice(
  position: Position, peak: number | null, drawdownPct: number | null,
): number | null {
  const p = finiteOrNull(peak);
  const dd = finiteOrNull(drawdownPct);
  if (p === null || dd === null || !(dd > 0 && dd < 100)) return null;
  const mult = position.multiplier || 1.0;
  const cost = position.avg_cost / mult; // 每股成本(avg_cost 含乘数)
  const keep = 1.0 - dd / 100.0;
  if (isLong(position)) {
    if (p <= cost) return null; // 从未盈利,没有可回撤的利润
    return cost + (p - cost) * keep;
  }
  if (p >= cost) return null;
  return cost - (cost - p) * keep;
}

/** 要挂在券商侧的订单清单(纯函数,顺序固定:tp、sl、trail、ptrail)。
 *
 * 同一追踪的所有托管单共用一个 OCA 组:一张成交,券商自动撤掉其余——
 * 与软件盯盘"触发一次就落闩"的语义一致。TRAIL 用持久化峰值播种初始停损,
 * 重启不把已锁住的利润放开。 */
export function hostedPlan(
  position: Position, targets: Targets, auto: AutoClose, peak: number | null,
): HostedOrderPlan[] {
  if (!auto.host_at_broker) return [];
  const qty = closeQty(position, auto);
  const side = closeSide(position);
  const plan: HostedOrderPlan[] = [];

  const tp = hostedPrice(targets.take_profit);
  if (tp !== null) {
    plan.push({
      kind: HOSTED_KIND_TP, action: side, order_type: "LMT",
      quantity: qty, lmt_price: tp, aux_price: null,
      trailing_percent: null, trail_stop_seed: null,
      label: `${HOSTED_LABELS[HOSTED_KIND_TP]} ${pyFloat(tp)}`,
    });
  }
  const sl = hostedPrice(targets.stop_loss);
  if (sl !== null) {
    plan.push({
      kind: HOSTED_KIND_SL, action: side, order_type: "STP",
      quantity: qty, lmt_price: null, aux_price: sl,
      trailing_percent: null, trail_stop_seed: null,
      label: `${HOSTED_LABELS[HOSTED_KIND_SL]} ${pyFloat(sl)}`,
    });
  }
  const trail = finiteOrNull(targets.trail_pct);
  if (trail !== null && trail > 0 && trail < 100) {
    const seed = hostedPrice(trailStopPrice(position, peak, trail));
    plan.push({
      kind: HOSTED_KIND_TRAIL, action: side, order_type: "TRAIL",
      quantity: qty, lmt_price: null, aux_price: null,
      trailing_percent: trail, trail_stop_seed: seed,
      label: `${HOSTED_LABELS[HOSTED_KIND_TRAIL]} ${pyG(trail)}%`,
    });
  }
  const pstop = hostedPrice(
    profitTrailStopPrice(position, peak, targets.profit_drawdown_pct),
  );
  if (pstop !== null) {
    plan.push({
      kind: HOSTED_KIND_PTRAIL, action: side, order_type: "STP",
      quantity: qty, lmt_price: null, aux_price: pstop,
      trailing_percent: null, trail_stop_seed: null,
      label: `${HOSTED_LABELS[HOSTED_KIND_PTRAIL]} ${pyFloat(pstop)}`,
    });
  }
  return plan;
}

/** 托管单要不要改。只看会变的字段;价格按"分"比较,不做浮点减法——
 * 0.01 的差在二进制里是 0.00999…,拿它和 0.01 比大小恰好在阈值上抖。
 * TRAIL 的 seed 只在挂单时用一次,券商侧自己棘轮,不参与比较。 */
export function hostedNeedsUpdate(
  current: Record<string, unknown>, desired: Record<string, unknown>,
): boolean {
  if (Math.trunc(Number(current.quantity ?? 0)) !== Math.trunc(Number(desired.quantity ?? 0))) {
    return true;
  }
  for (const key of ["lmt_price", "aux_price", "trailing_percent"]) {
    const a = finiteOrNull((current[key] ?? null) as number | null);
    const b = finiteOrNull((desired[key] ?? null) as number | null);
    if ((a === null) !== (b === null)) return true;
    if (a !== null && b !== null && Math.round(a * 100) !== Math.round(b * 100)) return true;
  }
  return false;
}
