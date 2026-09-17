/** 持仓追踪(对应 Python tracker.py):只算不发单,全部纯函数。
 *
 * 三件事定死:方向决定上下;乘数只乘一次(IBKR 的 avgCost 对期权含乘数,
 * 成本侧不再乘、市值侧要乘);跟踪止损跟"最有利价"且峰值必须持久化。
 */
import {
  DEFAULTS as FLY_DEFAULTS, impliedSigmaFly, impliedSigmaLeg, legValue, modelPrice, sigmaRemaining,
  structureValue,
} from "./flyexit.js";
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
  // 昨收口径的每组净值:只给界面在休市时显示用(见 broker.fillOptionPrices),不参与任何判断
  const closes = legs.map((leg) => finiteOrNull(leg["close_price"] ?? null));
  const netClose =
    legs.length && closes.every((p) => p !== null)
      ? legs.reduce((acc, _leg, i) => acc + ratios[i]! * closes[i]!, 0)
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
    // 没有就不带这个键:黄金基线里的组合行逐字段比对,不该多出一个恒为 null 的字段
    ...(netClose === null ? {} : { close_price: pyRound(Math.abs(netClose), 4) }),
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
  /** **标的**的目标价。止盈价不由人填,而是每一轮按当前波动率算出「标的走到这里时
   * 这份持仓该值多少」——正股、单腿期权、蝶式/价差都走这一条,见 spotTarget()。 */
  spot_target: number | null;
}

export function makeTargets(raw: Partial<Targets> = {}): Targets {
  return {
    take_profit: raw.take_profit ?? null,
    stop_loss: raw.stop_loss ?? null,
    trail_pct: raw.trail_pct ?? null,
    profit_drawdown_pct: raw.profit_drawdown_pct ?? null,
    profit_drawdown_tiers: raw.profit_drawdown_tiers ?? null,
    profit_drawdown_late: raw.profit_drawdown_late ?? null,
    spot_target: raw.spot_target ?? null,
  };
}

export function targetsEmpty(t: Targets): boolean {
  return (
    t.take_profit === null && t.stop_loss === null && t.trail_pct === null &&
    t.profit_drawdown_pct === null && !(t.profit_drawdown_tiers ?? []).length &&
    t.spot_target === null
  );
}

// ----------------------------------------------------------------------
// 蝶式:标的目标价 → 预计止盈位
// ----------------------------------------------------------------------
// 「7720 开的 7750 25 点蝶,标的涨到 7740 该值多少」——人心里想的止盈位是**标的**的
// 位置,不是蝶价。蝶价是它的影子:同一个 7740,上午和尾盘差着一倍的钱(时间价值还剩
// 多少)。所以这个止盈位必须每一轮重算,不能设一次定死。

export interface FlyProfile {
  lower: number;
  center: number;
  upper: number;
  width: number;
  right: string;
  action: string; // 持仓方向:BUY = 借方蝶(买翼卖中心)
  [key: string]: unknown;
}

/**
 * BAG 合约 → 蝶式几何(下翼/中心/上翼/翼宽/看涨看跌)。认不出来回 null。
 *
 * 只认标准的 1/−2/1(或 −1/2/−1)、同 right、等距三腿。比例或间距对不上宁可回 null:
 * 这个 profile 会拿去算真金白银的止盈价,猜错的后果是挂一张凭空来的限价单。
 */
export function flyProfileOf(contract: Record<string, unknown> | null | undefined): FlyProfile | null {
  const c = contract ?? {};
  if (String(c["secType"] ?? "") !== "BAG") return null;
  const legs = (c["legs"] ?? []) as Array<Record<string, unknown>>;
  if (legs.length !== 3) return null;
  const strikes = legs.map((l) => finiteOrNull(l["strike"]));
  const ratios = legs.map((l) => finiteOrNull(l["ratio"]));
  const rights = legs.map((l) => String(l["right"] ?? "").slice(0, 1).toUpperCase());
  if (strikes.some((s) => s === null) || ratios.some((r) => r === null)) return null;
  if (new Set(rights).size !== 1 || (rights[0] !== "C" && rights[0] !== "P")) return null;
  const [k1, k2, k3] = strikes as [number, number, number];
  const [r1, r2, r3] = ratios as [number, number, number];
  if (!(k1 < k2 && k2 < k3) || !same(k2 - k1, k3 - k2)) return null;
  if (!same(r1, r3) || !same(r2, -2 * r1) || r1 === 0) return null;
  return {
    lower: k1, center: k2, upper: k3, width: pyRound(k2 - k1, 4),
    right: rights[0]!, action: r1 > 0 ? "BUY" : "SELL",
  };
}

// ---------------------------------------------------------------- 通用结构
// 蝴蝶只是「按比例加权的几条腿」里最难的那一个。正股、单腿期权、价差、铁鹰
// 走的是同一条路:标的走到 spotTarget → 这份持仓值多少 → 预估收益 → 挂那张单。

export interface StructureLeg {
  strike: number;
  right: string;
  ratio: number; // 带符号:买入为正、卖出为负,已按"每组"折算
}

export interface TargetStructure {
  /** stock = 正股(目标价就是它自己)、option = 单腿、combo = 多腿净价。 */
  kind: string;
  legs: StructureLeg[];
  /** 蝶式几何;只有认得出蝴蝶时才有,用来走更准的净价反解。 */
  fly: FlyProfile | null;
  /** 给人看的一句话,进错误信息和界面。 */
  label: string;
}

/**
 * 持仓 → 可定价的结构。认不出来回 null(那就用不了标的目标价,老老实实填价格)。
 *
 * 正股没有腿:标的目标价就是它自己的价格,不需要任何模型。
 * 期权腿的 ratio 已经按"每张/每组"折算过——BAG 行的 contract.legs 里存的就是它。
 */
export function structureOf(
  secType: string, contract: Record<string, unknown> | null | undefined,
): TargetStructure | null {
  const c = contract ?? {};
  const kind = String(secType || "STK");
  if (kind === "STK") return { kind: "stock", legs: [], fly: null, label: "正股" };

  const legOf = (raw: Record<string, unknown>, ratio: number): StructureLeg | null => {
    const strike = finiteOrNull(raw["strike"]);
    const right = String(raw["right"] ?? "").slice(0, 1).toUpperCase();
    if (strike === null || (right !== "C" && right !== "P") || !Number.isFinite(ratio)) return null;
    return { strike, right, ratio };
  };

  if (kind === "OPT" || kind === "FOP") {
    // 单腿:数量的正负由持仓自己表达(closeSide 用的是 quantity),这里一律按"一张多头"
    // 定价——报价本来就是每张的价格,追踪比的也是它。
    const leg = legOf(c, 1);
    return leg === null ? null : {
      kind: "option", legs: [leg], fly: null,
      label: `${pyG(leg.strike)}${leg.right} 单腿`,
    };
  }

  if (kind !== "BAG") return null;
  const rawLegs = (c["legs"] ?? []) as Array<Record<string, unknown>>;
  if (!rawLegs.length) return null;
  const legs: StructureLeg[] = [];
  for (const raw of rawLegs) {
    const leg = legOf(raw, finiteOrNull(raw["ratio"]) ?? NaN);
    if (leg === null || leg.ratio === 0) return null;
    legs.push(leg);
  }
  const fly = flyProfileOf(c);
  return {
    kind: "combo", legs, fly,
    label: fly ? `${pyG(fly.lower)}/${pyG(fly.center)}/${pyG(fly.upper)} 蝴蝶` : `${legs.length} 腿组合`,
  };
}

/** 按"离标的多近"排好的腿。反解退让时从最贴近平值的那条开始试——它的报价最实、
 * 受波动率微笑的扭曲最小;那条没报价就依次往外挪,而不是直接放弃退到模型默认值。 */
function legsByMoneyness(legs: StructureLeg[], spot: number): StructureLeg[] {
  return [...legs].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
}

export interface SpotTarget {
  /** 标的的目标价(照抄输入,方便界面一处取齐)。 */
  spot_target: number;
  /** 标的现价。 */
  spot: number | null;
  /** 现价是怎么来的(夜盘按期货推算时写明期货与基差);常规时段的官方价为空串。 */
  spot_note: string;
  /** 预计价位:标的走到 spot_target 时这份持仓的模型价(每股 / 每张 / 每组净价)。 */
  price: number | null;
  /** 预估收益(总额,已乘数量与乘数)。算不出成本或价格时为 null。 */
  pnl: number | null;
  /** 预估收益相对成本的百分比。 */
  pnl_pct: number | null;
  /** 算这个价用的 σ_剩余(点);正股没有 σ。smile 档报最贴近目标价那条腿的。 */
  sigma: number | null;
  /** σ 从哪来:none = 正股不需要、smile = 每条腿各自反解、net = 净价反解、leg = 最近腿反解、
   * clock = EM×√剩余方差。 */
  sigma_source: string;
  /** smile 档每条腿各自的 σ(按 legPriceKey 索引);别的档没有这一项。 */
  leg_sigmas?: Record<string, number>;
  /** 这份持仓是什么结构,给错误信息和界面用。 */
  structure: string;
  /** 算不出来的时候说清楚为什么——静默回 null 会让界面显示成"还没到价"。 */
  reason: string;
  /** 引擎这一轮**只守不挂**:没有市场价可用,也没有上一次的市场价可沿用。
   * 这时不挂新单、也不撤已经挂着的单(见 engine.applySpotTarget)。 */
  held?: boolean;
  /** 试算时:算得出价,但这个价不比现价更有利(挂上去会立刻成交)。设置时同一句话会当场拒。 */
  warning?: string;
  /** 标的**此刻**已经到了(或越过)目标价:同一组 σ 下,持仓在现价处的价值不低于目标价处的价值。
   * 单腿、价差是"越过目标价";蝶是"进了目标价与它关于中心的镜像之间"——那段里蝶只会更值钱。
   * 拿不到标的现价时没有这一项。 */
  reached?: boolean;
  /** 试算时:此刻立刻平掉能拿到(空头:要付)的价,按各腿买卖价合成;拿不到报价时没有这一项。 */
  natural?: number;
  /** 追价平仓最多让到的价(自然价按 chase_max_pct 让满),以及那个百分比 */
  chase_floor?: number;
  chase_max_pct?: number;
}

/** σ 来源里哪些算"市场价":只有这几种算出来的数才能拿去挂单或改单。
 * clock 是写死的 EM 算出来的模型默认值——给人看可以,拿去发单不行。 */
export const MARKET_SIGMA_SOURCES = new Set(["none", "smile", "net", "leg"]);

export const SIGMA_SOURCE_LABEL: Record<string, string> = {
  none: "正股按目标价本身,不用波动率",
  smile: "每条腿按各自的报价反解,各用各的波动率",
  net: "按这份持仓当前的净价反解",
  leg: "按最贴近平值那条腿的报价反解",
  clock: "模型默认波动率(EM×√剩余方差),不是市场价",
};

/**
 * 预计价位与预估收益:标的走到 spotTarget 时,这份持仓按当前波动率该值多少。
 *
 * 正股不需要模型——目标价就是价格。期权要 σ,四个来源按可信度依次退让,
 * 并把用了哪个如实报出来:
 *
 * | 来源 | 什么时候用 | 为什么 |
 * |---|---|---|
 * | `smile` | 组合,每条腿都有报价且解得出 | 每条腿用**自己的**报价反解、再各自重估(粘着行权价)。各腿报价加起来就是组合现价,所以在当前标的处正好还原现价;单腿 vega 恒正、根唯一,**翼内翼外一样能解**;标的穿过翼时来源不换,挂单价不跳 |
 * | `net` | 单腿任何位置;蝴蝶在两翼之间(腿报价不全时) | 反解回去正好还原当前报价,目标价在标的逼近 spotTarget 时平滑收敛到实际报价,不跳 |
 * | `leg` | 上面都解不动 | 组合净价对 σ 常常不单调(蝶在翼外是双根,见 impliedSigmaFly),解不得;拿最贴近平值那条腿的 σ 给所有腿用 |
 * | `clock` | 都拿不到 | EM×√剩余方差。这是**模型默认值**不是市场价,界面必须标出来 |
 *
 * 蝶的目标价**可以在翼外**。"翼外一文不值"只在到期那一刻成立;离到期还有时间,翼外的蝶照样有
 * 时间价值,而且标的往翼靠一步它就涨一截——蝶开在翼外、赌标的冲到翼边上,吃的正是这一段
 * (7700 开 7720/7740/7760 的蝶,看 7715 的看涨墙会插针)。说不通的目标价由 validateSpotTarget
 * 的"不比现价更有利"那条拦下,不需要另立翼外规则。
 *
 * σ 只取"此刻"的:问的是「现在这个波动率下,标的到了那儿值多少」,所以不预支时间衰减。
 * 时间过去,σ 自己会缩,这个数自己会往上走——这正是它必须每轮重算的原因。
 *
 * 注意 `leg` 档的系统性偏差:远离平值的腿受波动率微笑影响最大,拿它反解出来的
 * Bachelier σ 会偏(偏哪一边取决于当天的偏斜),所以界面上要把来源标出来,别让人
 * 以为那是个和市场对得上的数。
 */
export function spotTarget(args: {
  structure: TargetStructure;
  position: Position;
  spotTarget: number;
  spot: number | null;
  markPrice: number | null;
  legPrices?: Record<string, number | null> | null;
  minute: number | null;
  em?: number | null;
  spotNote?: string;
}): SpotTarget {
  const { structure, position } = args;
  const target = args.spotTarget;
  const spot = finiteOrNull(args.spot);
  const out: SpotTarget = {
    spot_target: target, spot, spot_note: args.spotNote ?? "", price: null, pnl: null, pnl_pct: null,
    sigma: null, sigma_source: "", structure: structure.label, reason: "",
  };
  if (!(target > 0)) {
    out.reason = "标的目标价要是正数。";
    return out;
  }

  // ---- 正股:目标价就是价格,不需要任何模型 ----
  if (structure.kind === "stock") {
    out.sigma_source = "none";
    out.price = pyRound(target, 4);
    if (spot !== null) out.reached = reachedTarget(position, spot, out.price);
    return withPnl(out, position);
  }

  // ---- 蝶式:只支持买入的蝶。目标价在不在翼内都照样算(见上面的说明) ----
  const fly = structure.fly;
  if (fly !== null && fly.action !== "BUY") {
    out.reason = "预计止盈位只支持买入的蝶(借方);卖出的蝶盈利在中心之外,标的目标价说不清方向。";
    return out;
  }

  let sigma: number | null = null;
  let source = "";
  let legSigmas: Record<string, number> | null = null;
  const mark = finiteOrNull(args.markPrice);
  // 组合先走 smile:每条腿按各自报价反解。缺一条就整档不用——缺腿的"微笑"还原不了现价
  if (spot !== null && structure.kind === "combo") {
    legSigmas = smileSigmas(structure.legs, spot, args.legPrices ?? {});
    if (legSigmas !== null) source = "smile";
  }
  if (source === "" && spot !== null && mark !== null) {
    // 净价反解:蝶只在翼内可解(翼外双根);单腿 vega 恒正,恒可解。
    if (fly !== null) sigma = impliedSigmaFly(fly, spot, mark);
    else if (structure.legs.length === 1) {
      const leg = structure.legs[0]!;
      sigma = impliedSigmaLeg(spot, leg.strike, mark, leg.right);
    }
    if (sigma !== null) source = "net";
  }
  if (source === "" && spot !== null) {
    for (const leg of legsByMoneyness(structure.legs, spot)) {
      const legPrice = finiteOrNull((args.legPrices ?? {})[legPriceKey(leg)]);
      if (legPrice === null) continue;
      sigma = impliedSigmaLeg(spot, leg.strike, legPrice, leg.right);
      if (sigma !== null) {
        source = "leg";
        break;
      }
    }
  }
  if (source === "") {
    const em = finiteOrNull(args.em ?? null) ?? Number(FLY_DEFAULTS["em"]);
    if (args.minute === null) {
      out.reason = "拿不到市场波动率,也没有当前时刻,算不出预计价位。";
      return out;
    }
    sigma = sigmaRemaining(em, args.minute); // 收盘后是 0:那时模型价就是内在价值,仍然是对的
    source = "clock";
  }

  out.sigma_source = source;
  /** 同一组 σ 下,标的在 s 时这份持仓值多少。目标价与"标的到了没有"用的是同一个它。 */
  const valueAt = (s: number): number => {
    let v: number;
    if (legSigmas !== null) {
      v = 0;
      for (const leg of structure.legs) v += leg.ratio * legValue(leg.right, s, leg.strike, legSigmas[legPriceKey(leg)]!);
      if (fly !== null) v = Math.max(v, 0); // 买入的蝶不可能倒贴钱,和 modelPrice 同一个下限
    } else {
      // 蝶用 modelPrice(与黄金基线同一个写法),其余走通用的按比例加权
      v = fly !== null ? modelPrice(fly, s, sigma!) : structureValue(structure.legs, s, sigma!);
    }
    // 组合行的现价按"每组净值的绝对值"记,方向在数量的正负上(见 comboRow)。腿比例带的是持仓自己的
    // 符号,贷方组合按比例加权出来是负数;不翻过来,止盈价和现价就不在一个口径上(负的止盈价永远到不了)
    return structure.kind === "combo" && fly === null && !isLong(position) ? -v : v;
  };
  if (legSigmas !== null) {
    const nearest = legsByMoneyness(structure.legs, target)[0]!;
    out.sigma = pyRound(legSigmas[legPriceKey(nearest)]!, 4);
    out.leg_sigmas = Object.fromEntries(Object.entries(legSigmas).map(([k, v2]) => [k, pyRound(v2, 4)]));
  } else {
    out.sigma = pyRound(sigma!, 4);
  }
  out.price = pyRound(valueAt(target), 4);
  if (spot !== null) out.reached = reachedTarget(position, pyRound(valueAt(spot), 4), out.price);
  return withPnl(out, position);
}

/** 持仓在现价处的价值已经不比目标价处差(多头不低于、空头不高于)。 */
function reachedTarget(position: Position, valueNow: number, valueAtTarget: number): boolean {
  return isLong(position) ? valueNow >= valueAtTarget - 1e-6 : valueNow <= valueAtTarget + 1e-6;
}

/** 一条腿此刻的买卖价。 */
export interface LegBook { bid: number | null; ask: number | null }

/**
 * 平掉这份持仓**立刻能成交**的价(组合行口径:每组净值的绝对值;单腿就是那一张的价)。
 *
 * 平仓要把每条腿反着做一遍:持有的买入腿按**买价**卖出、卖出腿按**卖价**买回——组合的"自然价",
 * 挂在这个价上的平仓单不用等谁来接。止盈单挂的是模型价(中间价口径),夜盘蝶的买卖价差能有一块多:
 * 标的真到了目标价,那张单也可能一直挂着不成交(2026-09-10 真机:组合 3.10 / 4.25,中间价 3.70)。
 * 要"到了就走",就得改到这个价。
 *
 * 任何一条腿没有有效的买卖价就回 null——拿半边报价算出来的"立刻成交价"是凭空的。
 * 唯一的例外是**买价为 0**:0DTE 蝶的远翼临近收盘常常没人出价,买价就是 0。那条腿是要卖掉的,
 * 按 0 卖等于送掉,组合净价里它就贡献 0——这是 IBKR 自己显示组合买价的算法,也是这只蝶此刻
 * 真能成交的价。以前把它当"没报价"整轮不动,远翼归零的蝶就永远追不了价。卖价仍必须为正:
 * 要买回的腿没有卖价,就真的没法立刻买回。算出来不是正数(平掉反而要付钱)也回 null。
 */
export function naturalClosePrice(
  position: Position, structure: TargetStructure, book: Record<string, LegBook>,
): number | null {
  if (structure.kind === "stock" || !structure.legs.length) return null;
  const quote = (leg: StructureLeg): { bid: number; ask: number } | null => {
    const q = book[legPriceKey(leg)];
    const bid = finiteOrNull(q?.bid ?? null);
    const ask = finiteOrNull(q?.ask ?? null);
    if (bid === null || ask === null || !(bid >= 0) || !(ask > 0) || ask < bid) return null;
    return { bid, ask };
  };
  if (structure.kind === "option") {
    // 单腿的结构一律按"一张多头"记,方向看持仓数量:多头卖在买价,空头买回在卖价。
    // 单腿多头买价为 0 就是没人要,不算"能成交"
    const q = quote(structure.legs[0]!);
    if (q === null) return null;
    const price = isLong(position) ? q.bid : q.ask;
    return price > 0 ? price : null;
  }
  let net = 0;
  for (const leg of structure.legs) {
    const q = quote(leg);
    if (q === null) return null;
    net += leg.ratio * (leg.ratio > 0 ? q.bid : q.ask);
  }
  const out = pyRound(isLong(position) ? net : -net, 4);
  return out > 0 ? out : null;
}

/** 追价平仓的让价节奏(见 chaseLimit)。轮 = 引擎节拍,一秒一轮。 */
export const CHASE_GRACE_ROUNDS = 2; // 先在自然价上等这么多轮
export const CHASE_STEP_TICKS = 1;   // 之后每轮再让一跳
export const CHASE_WARN_ROUNDS = 30; // 追了这么多轮还没成交,提醒一次

/** 追价最多让到哪(相对自然价的最大让价,已按跳动取整为整数跳)。
 * 上限取 chase_max_pct 与「至少两跳」中的大者:很便宜的组合按百分比算连一跳都不到,等于不追。 */
export function chaseMaxSteps(position: Position, natural: number, auto: AutoClose): number {
  const tick = closeTick(position, natural);
  const pct = Math.max(0, finiteOrNull(auto.chase_max_pct) ?? 0) / 100;
  const cap = Math.max(2 * tick, natural * pct);
  return Math.floor(cap / tick + 1e-9);
}

/**
 * 追价平仓第 `rounds` 轮(从 0 起)该挂的限价。
 *
 * 自然价(各腿买卖价合成)是"此刻立刻能成交"的价,可挂上去未必立刻成交:组合单在 COB 上要等
 * 做市商整包接、腿的报价可能只有一张的量、夜盘的报价又常是挂着不动的。要"到了就走",光跟着
 * 自然价改还不够,得越等越让:
 *
 *  · 头 CHASE_GRACE_ROUNDS 轮挂在自然价上——多数时候这就成交了,没必要一上来就多让;
 *  · 之后每轮再让 CHASE_STEP_TICKS 跳,让到 chaseMaxSteps 为止——上限是用户设的 chase_max_pct,
 *    再往下就不是"及时成交"而是"贱卖";
 *  · **只朝成交方向动,绝不退回来**(prev 是上一轮挂的价):买价抬上去了,挂在下面的卖单本来
 *    就会按买价成交,改回去只是多一次改单、多一段在交易所排队的空档;买价掉下去了,新的自然价
 *    减去同样的让价一定更低,顺着追。
 *  · 按跳动朝成交方向取整,至少一跳。
 */
export function chaseLimit(
  position: Position, natural: number, prev: number | null, rounds: number, auto: AutoClose,
): number {
  const tick = closeTick(position, natural);
  const steps = Math.min(
    Math.max(0, rounds - CHASE_GRACE_ROUNDS) * CHASE_STEP_TICKS,
    chaseMaxSteps(position, natural, auto),
  );
  const long = isLong(position);
  const raw = long ? natural - steps * tick : natural + steps * tick;
  const aligned = long ? Math.floor(raw / tick + 1e-9) : Math.ceil(raw / tick - 1e-9);
  let out = Math.max(aligned * tick, tick);
  const p = finiteOrNull(prev);
  if (p !== null) out = long ? Math.min(out, p) : Math.max(out, p);
  return pyRound(out, 4);
}

/** 追价最多会让到的价(自然价让满上限):试算时摆出来,人才知道"最坏卖到哪"。 */
export function chaseFloor(position: Position, natural: number, auto: AutoClose): number {
  return chaseLimit(position, natural, null, Number.MAX_SAFE_INTEGER, auto);
}

/**
 * 「追价平仓」:追踪触发后,把托管单改到立刻成交的价、没成交就每秒再追一次,直到持仓没了。
 * fired_state 记成 `sweep:<触发原因>`,成交后再换回原因本身(止盈 / 止损 / 利润回撤)。
 */
export const SWEEP_PREFIX = "sweep:";

/** 这条追踪正在追价平仓的话,回触发原因;否则 null。 */
export function sweepReason(track: Record<string, unknown>): string | null {
  const state = String(track["fired_state"] ?? "");
  return state.startsWith(SWEEP_PREFIX) ? state.slice(SWEEP_PREFIX.length) : null;
}

/**
 * 组合每条腿按自己的报价反解 σ(smile 档)。任何一条腿没报价或解不动就回 null——
 * 缺了一条腿的"微笑"还原不了组合现价,那时退到下一档,而不是拿别的腿的 σ 去填。
 */
export function smileSigmas(
  legs: StructureLeg[], spot: number, legPrices: Record<string, number | null>,
): Record<string, number> | null {
  if (!legs.length) return null;
  const out: Record<string, number> = {};
  for (const leg of legs) {
    const key = legPriceKey(leg);
    const price = finiteOrNull(legPrices[key]);
    if (price === null) return null;
    const sigma = impliedSigmaLeg(spot, leg.strike, price, leg.right);
    if (sigma === null) return null;
    out[key] = sigma;
  }
  return out;
}

/** 腿报价的索引键:行权价 + C/P。组合里同一个行权价可能同时有看涨看跌(铁鹰)。 */
export function legPriceKey(leg: { strike: number; right: string }): string {
  return `${pyG(leg.strike)}${leg.right}`;
}

/** 把预计价位换成钱:与 unrealized() 同一套口径(成本含乘数,市值一侧乘乘数)。 */
function withPnl(out: SpotTarget, position: Position): SpotTarget {
  if (out.price === null) return out;
  const basis = costBasis(position);
  const value = marketValue(position, out.price);
  if (value === null) return out;
  out.pnl = pyRound(value - basis, 2);
  if (basis) out.pnl_pct = pyRound(((value - basis) / Math.abs(basis)) * 100.0, 3);
  return out;
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
    throw new TrackerError("至少要设一个:止盈价、止损价、跟踪止损百分比,或标的目标价。");
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

/**
 * 设置「标的目标价」时的校验。和 validate() 分开是因为它要多两样东西:
 * 合约(拿结构)和标的现价(拿波动率)。
 *
 * 算不出预计价位就当场拒绝,不建这条追踪:一条永远算不出目标价的追踪在界面上
 * 和"还没到价"长得一模一样,用户会以为它在保护自己。
 */
export function validateSpotTarget(args: {
  position: Position;
  contract: Record<string, unknown> | null | undefined;
  spotTarget: number;
  spot: number | null;
  markPrice: number | null;
  legPrices?: Record<string, number | null> | null;
  minute: number | null;
  em?: number | null;
}): SpotTarget {
  const structure = structureOf(args.position.sec_type, args.contract);
  if (structure === null) {
    throw new TrackerError(
      "这份持仓认不出结构,用不了标的目标价:正股、单腿期权,以及每条腿都带行权价与看涨/看跌的组合才行。",
    );
  }
  const st = spotTarget({ ...args, structure });
  if (st.reason) throw new TrackerError(st.reason);
  if (st.price === null) {
    throw new TrackerError("拿不到标的现价或持仓报价,这一刻算不出预计价位——等行情来了再设。");
  }
  const fillsNow = fillsNowMessage(args.position, structure, st, args.markPrice);
  if (fillsNow) throw new TrackerError(fillsNow);
  return st;
}

/**
 * 算出来的预计价位不比现价更有利 → 挂上去会立刻成交。返回那句拒绝的话;没问题回空串。
 * 设置时(validateSpotTarget)拿它拒,试算时(tracker.target_preview)拿它当场提醒——
 * 同一句话两处用,别让人在预览里看着一个数、点确认才被拒。
 */
export function fillsNowMessage(
  position: Position, structure: TargetStructure, st: SpotTarget, markPrice: number | null,
): string {
  const now = finiteOrNull(markPrice);
  if (st.price === null || now === null) return "";
  const long = isLong(position);
  if (long ? st.price > now : st.price < now) return "";
  return (
    `标的到 ${pyG(st.spot_target)} 时这份持仓约值 ${fmtF(st.price, 2)},` +
    `${long ? "不高于" : "不低于"}现价 ${fmtF(now, 2)}——挂上去会立刻成交。` +
    (structure.fly ? `想止盈就把目标价再往中心 ${pyG(structure.fly.center)} 靠。` : "换个方向对的目标价。")
  );
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
  /** 追价平仓最多让到自然价的百分之几(见 chaseLimit)。只管期权与组合;正股不追价。 */
  chase_max_pct: number;
}

export function makeAutoClose(raw: Partial<AutoClose> = {}): AutoClose {
  return {
    enabled: raw.enabled ?? false,
    order_type: raw.order_type ?? "MKT",
    slippage_pct: raw.slippage_pct ?? 0.3,
    close_fraction_pct: raw.close_fraction_pct ?? 100.0,
    host_at_broker: raw.host_at_broker ?? false,
    chase_max_pct: raw.chase_max_pct ?? 10.0,
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
  const tick = closeTick(position, out);
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

/**
 * 平仓限价的最小跳动:股票 0.01;组合 0.05;单腿期权 3 元以下 0.05、3 元及以上 0.10。
 *
 * 单腿以前一律取 0.05,可 SPX 期权 3 元以上的跳动是 0.10——12.35 这种价会被 IBKR 以 110 退单。
 * 0.10 的整数倍对一分钱档的个股期权同样合法,所以这条规矩对所有美股期权都不会被拒。
 */
export function closeTick(position: Position, price: number | null = null): number {
  if (position.sec_type === "STK") return 0.01;
  if (position.sec_type === "BAG") return 0.05;
  const p = finiteOrNull(price);
  return p !== null && p >= 3 ? 0.1 : 0.05;
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

/** 正股托管单的价格收敛到 2 位小数(美股最小报价单位),且不小于 0.01。
 * 4 位小数的停损价会被 IBKR 以 110(价格档位不合法)拒掉。期权按期权跳动,见下面两个。 */
function hostedPrice(value: number | null | undefined): number | null {
  const v = finiteOrNull(value ?? null);
  if (v === null) return null;
  return pyRound(Math.max(v, 0.01), 2);
}

/** 组合 / 单腿期权的托管限价:按合约最小跳动对齐,且**朝成交方向**取整(平多头向下、平空头向上)。
 * 这张单挂着就是为了让插针那一下能扫到,取整只该让它更容易成交,不该更难。 */
function hostedComboPrice(position: Position, value: number | null | undefined): number | null {
  const v = finiteOrNull(value ?? null);
  if (v === null) return null;
  const tick = closeTick(position, v);
  const steps = isLong(position)
    ? Math.floor(v / tick + 1e-9)
    : Math.ceil(v / tick - 1e-9);
  return pyRound(Math.max(steps * tick, tick), 4);
}

/**
 * 托管停损的触发价(STP 的 aux、利润回撤 STP 的 aux、TRAIL 的初始停损)。正股仍是 2 位小数;
 * 单腿期权按期权跳动对齐(3 元以上 0.10)——6.75、9.88 这种停损价会被 IBKR 以 110 退单,
 * 而单腿开了托管,止损类目标就只有券商侧这张停损单站岗,退了单就等于没有止损。
 *
 * 取整方向:**朝离开市场的一侧**——多头的卖出停损向下、空头的买入停损向上,绝不把停损往现价推。
 * 只要引擎口径的触发价还在保护一侧(多头低于现价、空头高于现价),取整后一定也还在。
 * 反过来朝"更早触发"取整是错的(审查时真机口径复现过):持仓刚转盈利时利润回撤停损离现价不到一跳,
 * 向上取一跳就压在现价上或越过现价,IBKR 当场触发,把引擎认为该拿着的仓平掉;夜盘 SPX 期权
 * 买卖价差大,中间价与买价之间那一截也会被一起跨过去。这里的代价是比引擎口径最多晚触发一跳。
 * TRAIL 的初始停损价(trailStopPrice)IBKR 校不校跳动没核对过;对齐了一定合法,所以一起对齐。
 * 组合不走这里:组合只托管止盈(见 hostedPlan)。
 */
function hostedStopPrice(position: Position, value: number | null | undefined): number | null {
  if (position.sec_type === "STK") return hostedPrice(value);
  const v = finiteOrNull(value ?? null);
  if (v === null) return null;
  const tick = closeTick(position, v);
  const steps = isLong(position)
    ? Math.floor(v / tick + 1e-9)
    : Math.ceil(v / tick - 1e-9);
  return pyRound(Math.max(steps * tick, tick), 4);
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

  // 组合只托管**一张限价止盈单**。STP / TRAIL 对 BAG 在 IBKR 侧支持不明、更没核对过
  // (docs/features/tracker.md);限价单是自动平仓那条路已经在纸面账户上跑通过的同一种单,
  // 差别只是它挂着等成交而不是到价才发。所以只放开这一种,其余仍走引擎盯盘。
  if (position.sec_type === "BAG") {
    const flyTp = hostedComboPrice(position, targets.take_profit);
    if (flyTp !== null) {
      plan.push({
        kind: HOSTED_KIND_TP, action: side, order_type: "LMT",
        quantity: qty, lmt_price: flyTp, aux_price: null,
        trailing_percent: null, trail_stop_seed: null,
        label: `${HOSTED_LABELS[HOSTED_KIND_TP]} ${pyFloat(flyTp)}`,
      });
    }
    return plan;
  }

  // 单腿期权的止盈限价按期权跳动对齐(3 元以上 0.10),2 位小数的价会被 IBKR 以 110 退单
  const tp = position.sec_type === "STK"
    ? hostedPrice(targets.take_profit)
    : hostedComboPrice(position, targets.take_profit);
  if (tp !== null) {
    plan.push({
      kind: HOSTED_KIND_TP, action: side, order_type: "LMT",
      quantity: qty, lmt_price: tp, aux_price: null,
      trailing_percent: null, trail_stop_seed: null,
      label: `${HOSTED_LABELS[HOSTED_KIND_TP]} ${pyFloat(tp)}`,
    });
  }
  // 停损类的触发价按期权跳动对齐,朝离开市场的一侧取整(见 hostedStopPrice)
  const sl = hostedStopPrice(position, targets.stop_loss);
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
    const seed = hostedStopPrice(position, trailStopPrice(position, peak, trail));
    plan.push({
      kind: HOSTED_KIND_TRAIL, action: side, order_type: "TRAIL",
      quantity: qty, lmt_price: null, aux_price: null,
      trailing_percent: trail, trail_stop_seed: seed,
      label: `${HOSTED_LABELS[HOSTED_KIND_TRAIL]} ${pyG(trail)}%`,
    });
  }
  const pstop = hostedStopPrice(
    position, profitTrailStopPrice(position, peak, targets.profit_drawdown_pct),
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
