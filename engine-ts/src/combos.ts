/** 期权腿 → 组合(蝴蝶 / 价差 / 铁鹰 / 铁蝶)的识别,与组合的虚拟持仓行(对应 Python group_legs / combo_row)。
 *
 * 2026-09-27 从 tracker.ts 拆出:它回答的是"哪几条腿是同一份持仓、这份持仓每组值多少",属于持仓身份,
 * 不属于触发判断——和 positions.ts 同一层。纯函数,只认持仓行;tracker.ts 转出,老的 import 路径不变。
 */
import type { PositionRow } from "./contract/positions.js";
import { fmtStrike, makeKey } from "./positions.js";
import { finiteOrNull, pyG, pyRound } from "./py.js";

/** 两个数在相对 1e-6 内算相等(行权价间距、腿比例比较用;tracker 的蝶式几何也用它)。 */
export function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1.0, Math.abs(a), Math.abs(b));
}

/** 结构 → 下单 schema 的 combo_strategy。认不出的(custom)没有,平仓单就拼不出来(见 tracker.closeContractIssue)。
 * 铁蝶是内侧两条腿同一行权价的铁鹰:schema 按腿数(4)认 IRON_CONDOR,平仓单只过 schema、不过开仓那道
 * 铁鹰检查(那一条要求四个不同行权价),所以记成 IRON_CONDOR——以前没有这一项,认出来的铁蝶也平不掉。 */
const COMBO_STRATEGY: Record<string, string> = {
  butterfly: "BUTTERFLY", vertical: "VERTICAL", iron_condor: "IRON_CONDOR", iron_butterfly: "IRON_CONDOR",
};

/** 把一个组合折成一条可追踪的虚拟持仓(对应 Python combo_row):
 * 数量 N 组,借方=多头 +N、贷方=空头 -N;成本取每组净值的绝对值;现价见下面 mark 的说明;
 * 任何一条腿没现价就是 null。sec_type=BAG。 */
export function comboRow(
  combo: Record<string, any>, rows: Array<Record<string, any>>,
): PositionRow {
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
  // 现价按"每组净值"记、方向在数量的正负上:借方取净值本身,贷方取它的相反数(平掉要付多少)。标准结构(价差、等距蝶、
  // 铁鹰 / 铁蝶)的净值不会穿过 0,取绝对值和带符号是一回事,照旧取绝对值(报价噪声算出来的 −0.02 仍记 0.02)。
  // 认不出的组合(断翼蝶、比例价差、风险逆转)会穿过 0:借方断翼蝶冲过远翼,真值是 −25,取绝对值读成 +25——
  // 盈亏记成大赚,止损永远不触发、止盈反而触发(2026-09-27 审计)。这类组合带符号记
  const signed = combo["kind"] === "custom";
  const mark = (v: number): number => pyRound(signed ? (long ? v : 0 - v) : Math.abs(v), 4);
  const contract = (legs[0]?.["contract"] ?? {}) as Record<string, any>;
  const multiplier = legs.length ? Number(legs[0]!["multiplier"] ?? 100) || 100 : 100;
  const parts = legs
    .map((leg, i) => {
      const c = leg["contract"] ?? {};
      return `${ratios[i]! >= 0 ? "+" : ""}${pyG(ratios[i]!)}x${fmtStrike(c["strike"])}${String(c["right"] ?? "").slice(0, 1).toUpperCase()}`;
    });
  // 腿身份仍按"行权价、再按看涨看跌字母序"拼(2026-09-27 之前的顺序):组合的 key 由它而来,追踪按 key 认持仓。
  // groupLegs 为认出铁蝶把同一行权价的看跌挪到了前面,key 若跟着变,已有的追踪会被读成「持仓已不存在」停掉
  const byKeyOrder = (a: number, b: number): number => {
    const la = legs[a] ?? {}, lb = legs[b] ?? {};
    return strikeOfLeg(la) - strikeOfLeg(lb) || (rightOfLeg(la) < rightOfLeg(lb) ? -1 : rightOfLeg(la) > rightOfLeg(lb) ? 1 : 0);
  };
  const sig = parts.map((_p, i) => i).sort(byKeyOrder).map((i) => parts[i] ?? "").join(",");
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
    market_price: netPrice === null ? null : mark(netPrice),
    // 没有就不带这个键:黄金基线里的组合行逐字段比对,不该多出一个恒为 null 的字段
    ...(netClose === null ? {} : { close_price: mark(netClose) }),
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
export function withCombos<T extends Record<string, any>>(rows: T[]): Array<T | PositionRow> {
  const list: Array<T | PositionRow> = [...rows];
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
    // 同一行权价看跌排在看涨前面:铁蝶内侧两条腿行权价相同,按字母序(C < P)会读成 P,C,P,C,
    // shapeOf 要的 P,P,C,C 永远对不上,铁蝶全落进「组合(4 腿)」(2026-09-27 审计)
    const putFirst = (r: Record<string, unknown>): number => (rightOfLeg(r).slice(0, 1).toUpperCase() === "P" ? 0 : 1);
    const bucket = [...raw].sort((a, b) =>
      strikeOfLeg(a) - strikeOfLeg(b) || putFirst(a) - putFirst(b) ||
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
